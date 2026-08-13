// netlify/functions/admin-set-tier.js
// Admin utility: sets a user's plan in Supabase by email.
// Protected by admin JWT verification — caller must be a known admin email.
// Usage: POST /.netlify/functions/admin-set-tier
//   Headers: Authorization: Bearer <admin-jwt>
//   Body: { "email": "user@example.com", "plan": "c_active", "bracket": "b1" }
//
// Candidate plans: scout | c_monitor | c_active | c_campaign
// Action plans:    a_monitor | a_active | a_campaign
// Legacy aliases:  monitor | campaign | agency  (still accepted)

const { ADMIN_EMAILS } = require('./_config')
const { normalizePlan } = require('./_entitlements')

const CANDIDATE_PLANS = ['scout', 'c_monitor', 'c_active', 'c_campaign']
const ACTION_PLANS    = ['a_monitor', 'a_active', 'a_campaign']
const LEGACY_PLANS    = ['monitor', 'campaign', 'agency']
const VALID_PLANS     = [...CANDIDATE_PLANS, ...ACTION_PLANS, ...LEGACY_PLANS]

// Derive plan_type from plan key so metadata is always consistent
function planType(plan) {
  if (ACTION_PLANS.includes(plan) || LEGACY_PLANS.includes(plan)) return 'action'
  return 'candidate'
}
const SUPABASE_URL  = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const SUPABASE_ANON = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
}

async function verifyAdmin(authHeader) {
  if (!authHeader?.startsWith('Bearer ')) return null
  const token = authHeader.slice(7)
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${token}` },
  })
  if (!res.ok) return null
  const user = await res.json()
  if (!user?.id) return null
  return ADMIN_EMAILS.includes(user?.email?.toLowerCase()) ? user : 'forbidden'
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) }
  }

  // Verify admin JWT
  const authHeader = event.headers?.authorization || event.headers?.Authorization
  const admin = await verifyAdmin(authHeader)
  if (admin === 'forbidden') {
    return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'Forbidden — admin only' }) }
  }
  if (!admin) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Unauthorized' }) }
  }

  let body
  try { body = JSON.parse(event.body) } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }
  }

  const { email, plan: rawPlan, bracket } = body
  if (!email || !rawPlan) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'email and plan required' }) }
  }
  if (!VALID_PLANS.includes(rawPlan)) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: `Invalid plan. Must be one of: ${VALID_PLANS.join(', ')}` }) }
  }

  // Legacy keys stay accepted, but never get written. planType() below treats
  // every legacy key as 'action', so setting a user to 'monitor' used to write
  // { plan: 'monitor', plan_type: 'action' } — a candidate plan permanently
  // tagged as an org plan, with a bracket that c_monitor does not even have.
  // Same LEGACY_ALIASES mapping the resolver itself uses.
  const plan = normalizePlan(rawPlan)

  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
  const SB_URL      = process.env.SUPABASE_URL

  if (!SB_URL || !SERVICE_KEY) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Supabase env vars not set' }) }
  }

  try {
    // Look up user by email — page through all users so accounts beyond the
    // first page are still found (Supabase admin list is paginated).
    let user = null
    const target = email.toLowerCase()
    for (let page = 1; page <= 50 && !user; page++) {
      const listRes = await fetch(
        `${SB_URL}/auth/v1/admin/users?page=${page}&per_page=200`,
        { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } }
      )
      const listJson = await listRes.json()
      const users    = listJson.users || []
      user = users.find(u => u.email?.toLowerCase() === target) || null
      if (users.length < 200) break  // last page reached
    }

    if (!user) {
      return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: `No user found with email ${email}` }) }
    }

    // Build updated metadata — preserve existing fields, update plan-related keys
    const newMeta = {
      ...user.app_metadata,
      plan,
      plan_type: planType(plan),
    }
    // Only write bracket for action plans; clear it for candidate plans
    if (ACTION_PLANS.includes(plan)) {
      if (bracket) newMeta.bracket = bracket
    } else {
      delete newMeta.bracket
    }

    // Update plan in app_metadata (service-role-writable only)
    const updateRes = await fetch(
      `${SB_URL}/auth/v1/admin/users/${user.id}`,
      {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          apikey: SERVICE_KEY,
          Authorization: `Bearer ${SERVICE_KEY}`,
        },
        body: JSON.stringify({ app_metadata: newMeta }),
      }
    )

    if (!updateRes.ok) {
      const text = await updateRes.text()
      throw new Error(`Supabase update failed (${updateRes.status}): ${text}`)
    }

    const updated = await updateRes.json()
    console.log(`[admin-set-tier] ${admin.email} set ${email} → plan:${plan} plan_type:${planType(plan)}${bracket ? ` bracket:${bracket}` : ''}`)

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        success: true,
        user_id: updated.id,
        email:   updated.email,
        plan:    updated.app_metadata?.plan,
      }),
    }
  } catch (err) {
    console.error('admin-set-tier error:', err.message)
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'An internal error occurred' }) }
  }
}
