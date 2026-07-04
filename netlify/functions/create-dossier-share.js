// Netlify Function: create-dossier-share
// Creates a temporary shareable link for a dossier.
// Agency tier only. Returns a token-based public URL with chosen expiry.
//
// POST body: { dossier_id, expires_in: '24h' | '7d' | '30d' }
// Returns:   { token, share_url, expires_at, id }

const SUPABASE_URL     = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const SUPABASE_SVC_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const APP_URL          = process.env.APP_URL || 'https://www.badgerboardwi.com'

const { ADMIN_EMAILS, corsHeaders } = require('./_config')
const AGENCY_PLANS = ['agency']

// CORS headers are computed per-request via corsHeaders() to restrict to production origin

// ─── Auth helpers ─────────────────────────────────────────────────────────────
async function verifyUser(authHeader) {
  if (!authHeader?.startsWith('Bearer ')) return null
  const token = authHeader.slice(7)
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_SVC_KEY, Authorization: `Bearer ${token}` },
  })
  if (!res.ok) return null
  return await res.json()
}

function getUserPlan(user) {
  if (!user) return 'scout'
  if (ADMIN_EMAILS.includes(user.email?.toLowerCase())) return 'agency'
  const p = user?.app_metadata?.plan
  // Normalize v1.14 plan keys so Action-plan (a_campaign) users aren't misread as scout.
  const PLAN_MAP = {
    c_monitor: 'monitor',  a_monitor: 'monitor',
    c_active:  'campaign', a_active:  'campaign',
    c_campaign:'campaign', a_campaign:'agency',
  }
  const valid = ['scout', 'monitor', 'campaign', 'agency']
  return PLAN_MAP[p] || (valid.includes(p) ? p : 'scout')
}

// ─── Supabase REST helper ─────────────────────────────────────────────────────
async function supa(path, method = 'GET', body = null, params = '') {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}${params}`, {
    method,
    headers: {
      apikey: SUPABASE_SVC_KEY,
      Authorization: `Bearer ${SUPABASE_SVC_KEY}`,
      'Content-Type': 'application/json',
      Prefer: method === 'POST' ? 'return=representation' : 'return=minimal',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  let data = null
  try { data = JSON.parse(text) } catch {}
  return { ok: res.ok, status: res.status, data }
}

// ─── Secure random token (48-char hex = 192 bits of entropy) ─────────────────
function generateToken() {
  const bytes = new Uint8Array(24)
  crypto.getRandomValues(bytes)
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

// ─── Expiry calculator ────────────────────────────────────────────────────────
function calcExpiry(expiresIn) {
  const now = Date.now()
  const map = { '24h': 24 * 60 * 60 * 1000, '7d': 7 * 24 * 60 * 60 * 1000, '30d': 30 * 24 * 60 * 60 * 1000 }
  const ms = map[expiresIn] || map['7d']
  return new Date(now + ms).toISOString()
}

// ─── Handler ──────────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  const CORS = corsHeaders(event.headers?.origin || event.headers?.Origin)
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' }
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) }

  // Auth
  const user = await verifyUser(event.headers?.authorization || event.headers?.Authorization)
  if (!user) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Unauthorized' }) }
  const plan = getUserPlan(user)
  if (!AGENCY_PLANS.includes(plan)) {
    return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'Shareable links are available on the Agency plan only.' }) }
  }

  // Parse body
  let body
  try { body = JSON.parse(event.body) } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }
  }

  const { dossier_id, expires_in } = body
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  if (!dossier_id || !UUID.test(dossier_id)) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'valid dossier_id is required' }) }
  if (!['24h', '7d', '30d'].includes(expires_in)) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'expires_in must be 24h, 7d, or 30d' }) }
  }

  // Verify the dossier belongs to this user
  const check = await supa('dossiers', 'GET', null, `?id=eq.${encodeURIComponent(dossier_id)}&generated_by=eq.${user.id}&select=id,title`)
  if (!check.ok || !Array.isArray(check.data) || check.data.length === 0) {
    return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'Profile not found or access denied' }) }
  }

  // Enforce per-dossier active share limit (max 5 active shares per dossier)
  const existing = await supa('dossier_shares', 'GET', null, `?dossier_id=eq.${encodeURIComponent(dossier_id)}&created_by=eq.${user.id}&is_active=eq.true&select=id`)
  if (existing.ok && Array.isArray(existing.data) && existing.data.length >= 5) {
    return { statusCode: 429, headers: CORS, body: JSON.stringify({ error: 'Maximum of 5 active share links per profile. Deactivate an existing link first.' }) }
  }

  // Generate token and insert
  const token     = generateToken()
  const expiresAt = calcExpiry(expires_in)

  const insert = await supa('dossier_shares', 'POST', {
    token,
    dossier_id,
    created_by: user.id,
    expires_at: expiresAt,
  })

  if (!insert.ok || !Array.isArray(insert.data) || insert.data.length === 0) {
    console.error('[create-dossier-share] Insert failed:', insert.status, JSON.stringify(insert.data))
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Failed to create share link' }) }
  }

  const share = insert.data[0]
  const shareUrl = `${APP_URL}/temporary-dossier/${token}`

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      id:         share.id,
      token:      share.token,
      share_url:  shareUrl,
      expires_at: share.expires_at,
      expires_in,
    }),
  }
}
