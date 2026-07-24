// Netlify Function: polling-snapshot (v1.22, BETA-ONLY)
// Sync API for the Polling section. Server-side beta enforcement: callers
// without the beta flag (or admin) get a 404 — the endpoint behaves as if the
// feature doesn't exist. All snapshot reads/writes go through here (the
// poll_snapshots table has no client RLS policies).
//
// Actions (POST { action, district }):
//   get      → { snapshot } | { snapshot: null }  (also returns generating state)
//   generate → kicks the background pipeline (fresh-window + concurrency guarded)
//
// Snapshots are shared per district across beta users; refresh window 7 days.

const { ADMIN_EMAILS } = require('./_config')
const { getGlobalBetaEnabled } = require('./_entitlements')
const { enforceRateLimit } = require('./_rate-limit')

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY
const SITE_URL     = process.env.URL || 'https://badgerboardwi.com'

const FRESH_DAYS = 7
const DISTRICT_RE = /^(congress-[1-8]|senate-([1-9]|[12][0-9]|3[0-3])|assembly-([1-9]|[1-9][0-9])|state-wi)$/
// user_id sentinel for the shared (global) per-district snapshot row
const GLOBAL_USER = '00000000-0000-0000-0000-000000000000'

async function intelCount(userId, district) {
  const r = await sb(`/poll_intel?user_id=eq.${userId}&district=eq.${encodeURIComponent(district)}&select=id&limit=1`, {
    headers: { Prefer: 'count=exact' },
  })
  return parseInt(r.headers.get('content-range')?.split('/')[1] ?? '0', 10) || 0
}

const sb = (path, opts = {}) => fetch(`${SUPABASE_URL}/rest/v1${path}`, {
  ...opts,
  headers: {
    apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`,
    'Content-Type': 'application/json', ...(opts.headers || {}),
  },
})

async function verifyUser(authHeader) {
  if (!authHeader?.startsWith('Bearer ')) return null
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SERVICE_KEY, Authorization: authHeader },
  })
  return res.ok ? res.json() : null
}

// The 404 for anyone outside the beta — never reveal the feature exists
const NOT_FOUND = { statusCode: 404, body: JSON.stringify({ error: 'Not found' }) }

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return NOT_FOUND

  const user = await verifyUser(event.headers?.authorization || event.headers?.Authorization)
  if (!user) return NOT_FOUND

  const isAdmin = ADMIN_EMAILS.includes((user.email || '').toLowerCase())
  const isBetaUser = user.app_metadata?.beta_mode === true
  if (!isAdmin) {
    if (!isBetaUser) return NOT_FOUND
    // Global beta kill-switch also hides the feature
    const globalOn = await getGlobalBetaEnabled().catch(() => true)
    if (!globalOn) return NOT_FOUND
  }

  let body
  try { body = JSON.parse(event.body || '{}') } catch { return NOT_FOUND }
  const { action, district } = body
  if (!DISTRICT_RE.test(String(district || ''))) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Valid district required' }) }
  }

  const headers = { 'Content-Type': 'application/json' }

  if (action === 'get') {
    // Personalized row (user has local intel for this district) wins over the
    // shared baseline; fall back to global when none exists.
    const nIntel = await intelCount(user.id, district)
    if (nIntel > 0) {
      const pr = await sb(`/poll_snapshots?district=eq.${encodeURIComponent(district)}&user_id=eq.${user.id}&select=*`)
      // A failed read must NOT masquerade as "no snapshot" — the client would
      // kick a full (paid) regeneration. Surface the outage instead.
      if (!pr.ok) return { statusCode: 503, headers, body: JSON.stringify({ error: 'Snapshot store unavailable — try again shortly' }) }
      const prows = await pr.json()
      if (prows?.[0]) {
        return { statusCode: 200, headers, body: JSON.stringify({ snapshot: prows[0], personalized: true, intel_count: nIntel, fresh_days: FRESH_DAYS }) }
      }
    }
    const res = await sb(`/poll_snapshots?district=eq.${encodeURIComponent(district)}&user_id=eq.${GLOBAL_USER}&select=*`)
    if (!res.ok) return { statusCode: 503, headers, body: JSON.stringify({ error: 'Snapshot store unavailable — try again shortly' }) }
    const rows = await res.json()
    const snap = rows?.[0] || null
    return { statusCode: 200, headers, body: JSON.stringify({ snapshot: snap, personalized: false, intel_count: nIntel, fresh_days: FRESH_DAYS }) }
  }

  if (action === 'generate') {
    const limited = await enforceRateLimit(user.id, 'polling-snapshot', headers)
    if (limited) return limited

    // Intel present → this generation is PERSONALIZED (its own row keyed to
    // the user); otherwise it refreshes the shared global row.
    const nIntel = await intelCount(user.id, district)
    const rowUser = nIntel > 0 ? user.id : GLOBAL_USER

    // Fresh-window + concurrency guard on the target row
    const res = await sb(`/poll_snapshots?district=eq.${encodeURIComponent(district)}&user_id=eq.${rowUser}&select=district,generated_at,status`)
    // Guard-read failure → abort rather than blow past the fresh-window check
    // and pay for a regeneration that may not be needed.
    if (!res.ok) return { statusCode: 503, headers, body: JSON.stringify({ error: 'Snapshot store unavailable — try again shortly' }) }
    const rows = await res.json()
    const existing = rows?.[0]
    if (existing) {
      const ageMs = Date.now() - new Date(existing.generated_at).getTime()
      if (existing.status === 'generating' && ageMs < 10 * 60 * 1000) {
        return { statusCode: 200, headers, body: JSON.stringify({ status: 'generating' }) }
      }
      if (existing.status === 'ready' && ageMs < FRESH_DAYS * 86400000 && !body.force) {
        return { statusCode: 200, headers, body: JSON.stringify({ status: 'fresh' }) }
      }
    }

    // Mark generating (upsert) then fire the background pipeline.
    // on_conflict must name the composite unique (district,user_id).
    await sb('/poll_snapshots?on_conflict=district,user_id', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ district, user_id: rowUser, status: 'generating', generated_at: new Date().toISOString(), requested_by: user.id }),
    })
    fetch(`${SITE_URL}/.netlify/functions/polling-snapshot-background`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ district, internal_trigger: process.env.ADMIN_TRIGGER_SECRET, requested_by: user.id, snapshot_user: nIntel > 0 ? user.id : null }),
    }).catch(e => console.error('[polling] background fire failed:', e.message))

    return { statusCode: 200, headers, body: JSON.stringify({ status: 'generating', personalized: nIntel > 0 }) }
  }

  return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown action' }) }
}
