// Netlify Function: create-dossier-share
// Creates a temporary shareable link for a dossier.
// Agency tier only. Returns a token-based public URL with chosen expiry.
//
// POST body: { dossier_id, expires_hours: 1..168, acknowledged: true }
//            (legacy: expires_in: '24h' | '7d' | '30d')
// Returns:   { token, share_url, expires_at, expires_hours, created_at, view_count, id }
//
// The responsibility acknowledgment is REQUIRED. The share dialog gates its
// "Create link" button on an explicit checkbox (SPEC-share-dialog §2); this
// function refuses to mint a link without `acknowledged: true` so the record on
// dossier_shares (ack_at / ack_by / ack_duration_hours) is always complete.
// ack_by is taken from the verified user — never from the request body.

const SUPABASE_URL     = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const SUPABASE_SVC_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const APP_URL          = process.env.APP_URL || 'https://www.badgerboardwi.com'

const { ADMIN_EMAILS, corsHeaders } = require('./_config')
// v1.19: share links are available on ALL paid plans (previously Agency-only).
// Scout stays blocked — its lite profile is the free-tier conversion gate.
const SHARE_PLANS = ['monitor', 'campaign', 'agency']

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

async function getUserPlan(user) {
  if (!user) return 'scout'
  if (ADMIN_EMAILS.includes(user.email?.toLowerCase())) return 'agency'
  // v1.18: resolve through the shared entitlement layer (beta + trials)
  const resolved = (await require('./_entitlements').resolveEntitlement(user)).plan
  user = { ...user, app_metadata: { ...(user.app_metadata || {}), plan: resolved } }
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
// v1.19: expiry is a number of HOURS, minimum 1 hour, maximum 7 days (168h).
// Legacy string presets still accepted ('30d' now clamps to the 7-day cap).
const MIN_HOURS = 1
const MAX_HOURS = 168
const LEGACY_MAP = { '24h': 24, '7d': 168, '30d': 168 }

function resolveExpiryHours(body) {
  let hours = null
  if (body.expires_hours != null) hours = Number(body.expires_hours)
  else if (typeof body.expires_in === 'string') hours = LEGACY_MAP[body.expires_in] ?? null
  if (!Number.isFinite(hours)) return null
  return Math.min(MAX_HOURS, Math.max(MIN_HOURS, Math.round(hours)))
}

// ─── Handler ──────────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  const CORS = corsHeaders(event.headers?.origin || event.headers?.Origin)
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' }
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) }

  // Auth
  const user = await verifyUser(event.headers?.authorization || event.headers?.Authorization)
  if (!user) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Unauthorized' }) }
  const plan = await getUserPlan(user)
  if (!SHARE_PLANS.includes(plan)) {
    return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'Shareable links are available on paid Badger Board plans. Upgrade to share profiles.' }) }
  }

  // Parse body
  let body
  try { body = JSON.parse(event.body) } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }
  }

  const { dossier_id } = body
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  if (!dossier_id || !UUID.test(dossier_id)) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'valid dossier_id is required' }) }
  const expiryHours = resolveExpiryHours(body)
  if (expiryHours == null) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'expires_hours must be a number between 1 (1 hour) and 168 (7 days)' }) }
  }

  // Acknowledgment gate — a link is not created without it. The checkbox in the
  // dialog is the consent record, so a missing/false flag is a hard 400 rather
  // than a silently unacknowledged row.
  if (body.acknowledged !== true) {
    return {
      statusCode: 400,
      headers: CORS,
      body: JSON.stringify({ error: 'The responsibility acknowledgment is required before a share link can be created.' }),
    }
  }

  // Verify the dossier belongs to this user
  // Ownership flows through the candidate: auto-refreshed dossiers carry
  // generated_by = null (kept off the quota), so requiring generated_by here
  // blocked owners from sharing their own weekly profiles.
  const rowsRes = await supa('dossiers', 'GET', null, `?id=eq.${encodeURIComponent(dossier_id)}&select=id,title,generated_by,created_by,candidate_id`)
  const drow = rowsRes.ok && Array.isArray(rowsRes.data) ? rowsRes.data[0] : null
  let owned = !!drow && (drow.generated_by === user.id || drow.created_by === user.id)
  if (!owned && drow?.candidate_id) {
    const candRes = await supa('candidates', 'GET', null, `?id=eq.${encodeURIComponent(drow.candidate_id)}&created_by=eq.${user.id}&select=id`)
    owned = candRes.ok && Array.isArray(candRes.data) && candRes.data.length > 0
  }
  const check = { ok: owned, status: owned ? 200 : 404, data: owned ? [drow] : [] }
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
  const expiresAt = new Date(Date.now() + expiryHours * 60 * 60 * 1000).toISOString()

  // The acknowledgment rides with the row: who accepted it, when, and the
  // duration they accepted it for. ack_by comes from the verified session.
  const insert = await supa('dossier_shares', 'POST', {
    token,
    dossier_id,
    created_by: user.id,
    expires_at: expiresAt,
    ack_at: new Date().toISOString(),
    ack_by: user.id,
    ack_duration_hours: expiryHours,
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
      id:            share.id,
      token:         share.token,
      share_url:     shareUrl,
      expires_at:    share.expires_at,
      expires_hours: expiryHours,
      // The live step shows "created …" and a view count; both come from the
      // row rather than being assumed by the client.
      created_at:    share.created_at || null,
      view_count:    share.view_count ?? 0,
      ack_at:        share.ack_at || null,
    }),
  }
}
