// netlify/functions/admin-manage-access.js
// ─── Admin: free trials + beta mode management (v1.18 launch build) ──────────
//
// Actions (POST, admin JWT required):
//   { action: 'grant_trial',  user_id, plan, bracket?, days }   days ∈ 30|60|90
//   { action: 'revoke_trial', user_id }
//   { action: 'set_beta',     user_id, enabled }                per-user flag
//   { action: 'get_global_beta' }
//   { action: 'set_global_beta', enabled }                      master switch
//
// Trials are INTERNAL entitlements (no card, no Stripe object): the granted
// plan is written to app_metadata as trial_* fields, the resolver overlays it,
// and the daily trial-expiry cron demotes the account when it lapses. This is
// deliberate — Stripe trials assume a subscription waiting to bill, which
// giveaway trials don't have.
//
// Beta mode: app_metadata.beta_mode = true grants the top plan while the
// global switch (app_settings.beta_mode_enabled) is on. Turning either off
// drops the user straight back to whatever they'd otherwise have (paid plan
// or free Scout) on their next token refresh.

const { ADMIN_EMAILS, corsHeaders } = require('./_config')
const { sendEmail } = require('./_email')

const SUPABASE_URL  = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const SUPABASE_ANON = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY
const SERVICE_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY

const VALID_TRIAL_DAYS  = [30, 60, 90]
const VALID_TRIAL_PLANS = ['c_monitor', 'c_active', 'c_campaign', 'a_monitor', 'a_active', 'a_campaign']
const VALID_BRACKETS    = ['b1', 'b2_5', 'b6', 'b11', 'b26', 'b51', 'ent']

const PLAN_LABEL = {
  c_monitor: 'Monitor', c_active: 'Active', c_campaign: 'Campaign',
  a_monitor: 'Action Monitor', a_active: 'Action Active', a_campaign: 'Action Campaign',
}

async function verifyAdmin(authHeader) {
  if (!authHeader?.startsWith('Bearer ')) return null
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON, Authorization: authHeader },
  })
  if (!res.ok) return null
  const user = await res.json()
  if (!user?.id) return null
  return ADMIN_EMAILS.includes(user?.email?.toLowerCase()) ? user : 'forbidden'
}

async function getUser(userId) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  })
  if (!res.ok) return null
  return res.json()
}

async function updateAppMetadata(userId, mutate) {
  const user = await getUser(userId)
  if (!user) throw new Error('User not found')
  const meta = { ...(user.app_metadata || {}) }
  mutate(meta)
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
    },
    body: JSON.stringify({ app_metadata: meta }),
  })
  if (!res.ok) throw new Error(`Supabase update failed (${res.status}): ${await res.text()}`)
  return { user, updated: await res.json() }
}

async function setGlobalBeta(enabled, adminEmail) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/app_settings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      Prefer: 'resolution=merge-duplicates',
    },
    body: JSON.stringify({
      key: 'beta_mode_enabled',
      value: enabled ? 'on' : 'off',
      updated_at: new Date().toISOString(),
      updated_by: adminEmail,
    }),
  })
  if (!res.ok) throw new Error(`app_settings update failed (${res.status}): ${await res.text()}`)
}

async function getGlobalBeta() {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/app_settings?key=eq.beta_mode_enabled&select=value,updated_at,updated_by`,
    { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } }
  )
  if (!res.ok) return { enabled: true, missing: true }
  const rows = await res.json()
  if (!rows?.length) return { enabled: true, missing: true }
  return { enabled: rows[0].value !== 'off', updated_at: rows[0].updated_at, updated_by: rows[0].updated_by }
}

exports.handler = async (event) => {
  const CORS = corsHeaders(event.headers?.origin)
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) }
  }

  const authHeader = event.headers?.authorization || event.headers?.Authorization
  const admin = await verifyAdmin(authHeader)
  if (admin === 'forbidden') return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'Forbidden — admin only' }) }
  if (!admin) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Unauthorized' }) }

  if (!SUPABASE_URL || !SERVICE_KEY) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Supabase env vars not set' }) }
  }

  let body
  try { body = JSON.parse(event.body || '{}') } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }
  }

  try {
    switch (body.action) {

      // ── Free trial: grant ────────────────────────────────────────────────
      case 'grant_trial': {
        const { user_id, plan, bracket, days } = body
        if (!user_id || !plan || !days) {
          return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'user_id, plan, and days are required' }) }
        }
        if (!VALID_TRIAL_PLANS.includes(plan)) {
          return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: `Invalid plan. Must be one of: ${VALID_TRIAL_PLANS.join(', ')}` }) }
        }
        if (!VALID_TRIAL_DAYS.includes(Number(days))) {
          return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'days must be 30, 60, or 90' }) }
        }
        const trialBracket = plan.startsWith('a_')
          ? (VALID_BRACKETS.includes(bracket) ? bracket : 'b1')
          : null

        const startedAt = new Date()
        const endsAt    = new Date(startedAt.getTime() + Number(days) * 86400000)

        const { user } = await updateAppMetadata(user_id, (meta) => {
          meta.trial_plan       = plan
          if (trialBracket) meta.trial_bracket = trialBracket
          else delete meta.trial_bracket
          meta.trial_started_at = startedAt.toISOString()
          meta.trial_ends_at    = endsAt.toISOString()
          meta.trial_granted_by = admin.email
          delete meta.trial_warning_sent
        })

        console.log(`[admin-manage-access] ${admin.email} granted ${days}d ${plan}${trialBracket ? `/${trialBracket}` : ''} trial to ${user.email}`)

        // Best-effort notification (Resend key optional)
        sendEmail({
          to: user.email,
          subject: `Your ${days}-day Badger Board ${PLAN_LABEL[plan] || plan} trial is live`,
          title: 'Your free trial is live',
          preheader: `Full ${PLAN_LABEL[plan] || plan} access for ${days} days — no card required.`,
          body: `<p>You've been given <strong>${days} days of free access</strong> to the <strong>${PLAN_LABEL[plan] || plan}</strong> plan on Badger Board — no credit card required.</p>
                 <p>Your trial runs through <strong>${endsAt.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</strong>. When it ends, your account moves to the free Scout plan automatically and all your data stays safe.</p>`,
          ctaText: 'Start exploring',
          ctaUrl: 'https://badgerboardwi.com/',
        }).catch(() => {})

        return { statusCode: 200, headers: CORS, body: JSON.stringify({
          success: true, email: user.email, trial_plan: plan, trial_bracket: trialBracket,
          trial_ends_at: endsAt.toISOString(),
        }) }
      }

      // ── Free trial: revoke ───────────────────────────────────────────────
      case 'revoke_trial': {
        const { user_id } = body
        if (!user_id) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'user_id required' }) }
        const { user } = await updateAppMetadata(user_id, (meta) => {
          delete meta.trial_plan
          delete meta.trial_bracket
          delete meta.trial_started_at
          delete meta.trial_ends_at
          delete meta.trial_granted_by
          delete meta.trial_warning_sent
        })
        console.log(`[admin-manage-access] ${admin.email} revoked trial for ${user.email}`)
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true, email: user.email }) }
      }

      // ── Beta: per-user flag ──────────────────────────────────────────────
      case 'set_beta': {
        const { user_id, enabled } = body
        if (!user_id || typeof enabled !== 'boolean') {
          return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'user_id and enabled (boolean) required' }) }
        }
        const { user } = await updateAppMetadata(user_id, (meta) => {
          if (enabled) meta.beta_mode = true
          else delete meta.beta_mode
        })
        console.log(`[admin-manage-access] ${admin.email} set beta_mode=${enabled} for ${user.email}`)

        if (!enabled) {
          sendEmail({
            to: user.email,
            subject: 'Your Badger Board beta access has ended',
            title: 'Beta access ended',
            body: `<p>Your beta access to Badger Board has ended. Your account is now on ${user.app_metadata?.plan && user.app_metadata.plan !== 'scout' ? 'your regular plan' : 'the free Scout plan'} — all of your data is safe.</p>
                   <p>Want to keep the full toolkit? Pick a plan any time.</p>`,
            ctaText: 'See plans',
            ctaUrl: 'https://badgerboardwi.com/plans',
          }).catch(() => {})
        }

        return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true, email: user.email, beta_mode: enabled }) }
      }

      // ── Beta: global switch ──────────────────────────────────────────────
      case 'get_global_beta': {
        const result = await getGlobalBeta()
        return { statusCode: 200, headers: CORS, body: JSON.stringify(result) }
      }

      case 'set_global_beta': {
        const { enabled } = body
        if (typeof enabled !== 'boolean') {
          return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'enabled (boolean) required' }) }
        }
        await setGlobalBeta(enabled, admin.email)
        console.log(`[admin-manage-access] ${admin.email} set GLOBAL beta_mode_enabled=${enabled}`)
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true, enabled }) }
      }

      default:
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Unknown action' }) }
    }
  } catch (err) {
    console.error('[admin-manage-access] error:', err.message)
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'An internal error occurred' }) }
  }
}
