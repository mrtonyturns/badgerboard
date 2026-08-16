// Shared helpers for Campaign Connect (account linking between Action & Candidate accounts).
const SUPABASE_URL       = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const { ADMIN_EMAILS, corsHeaders } = require('./_config')
const { resolveEntitlement } = require('./_entitlements')

// CORS is built PER REQUEST from the caller's Origin (same pattern as
// support-chat.js), not a module-level constant. The constant this replaced
// sent 'Access-Control-Allow-Origin: *' on two authenticated, Bearer-token
// endpoints (campaign-connect, campaign-connect-delegate), which told every
// browser that any site on the internet may read their responses.
// _config.corsHeaders() echoes the origin only when it is an allowed one and
// otherwise falls back to the production origin, so a mismatched caller is
// blocked by the browser.
//
// Callers: `H.cors(event)` — pass the raw Netlify event, not a header string.
function cors(event, methods = 'POST, OPTIONS') {
  return corsHeaders(event?.headers?.origin || event?.headers?.Origin, methods)
}

// service-role REST helper
async function sb(path, method = 'GET', body = null, extraHeaders = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: method === 'POST' ? 'return=representation' : (method === 'PATCH' ? 'return=representation' : ''),
      ...extraHeaders,
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { data = text }
  return { ok: res.ok, status: res.status, data }
}

// Verify the caller's Supabase JWT → returns the auth user object (or null)
async function verifyUser(authHeader) {
  if (!authHeader?.startsWith('Bearer ')) return null
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: authHeader },
  })
  if (!res.ok) return null
  return await res.json()
}

// Find an auth user by email (paginated admin API)
async function findUserByEmail(email) {
  const target = String(email || '').trim().toLowerCase()
  if (!target) return null
  for (let page = 1; page <= 6; page++) {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?page=${page}&per_page=200`, {
      headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
    })
    if (!res.ok) return null
    const j = await res.json()
    const users = j.users || j || []
    const hit = users.find(u => u.email?.toLowerCase() === target)
    if (hit) return hit
    if (users.length < 200) break
  }
  return null
}

// Plan resolution goes through _entitlements.js — the single source of truth —
// rather than reading app_metadata.plan raw. That raw read misrouted the legacy
// keys (monitor / campaign / agency) and resolved every beta-mode and free-trial
// account to Scout, which locked them out of Campaign Connect. These helpers are
// ASYNC because the resolver may consult the global beta switch; callers await.
const planOf = async (user) => {
  if (!user) return 'scout'
  const { plan } = await resolveEntitlement(user)   // admin/beta/trial/paid/free + legacy aliases
  return plan
}
const planTypeOf = async (user) => {
  if (ADMIN_EMAILS.includes(user?.email?.toLowerCase())) return 'action'
  // An explicit app_metadata.plan_type still wins — it is how an Action org on a
  // candidate-shaped plan identifies itself.
  if (user?.app_metadata?.plan_type) return user.app_metadata.plan_type
  return (await planOf(user)).startsWith('a_') ? 'action' : 'candidate'
}
const isActionUser = async (user) =>
  ADMIN_EMAILS.includes(user?.email?.toLowerCase()) || (await planTypeOf(user)) === 'action'
// A candidate account is "paid" if it is on any plan other than free Scout.
const isPaidCandidate = async (user) => (await planOf(user)) !== 'scout'

// Relationship-type permission ceilings ("outside" orgs are warned, not blocked → same ceiling).
const DEFAULT_PERMS = { view: true, manage_tasks: true, manage_page: true, receive_profiles: true }

async function logActivity(link_id, actor_user_id, candidate_user_id, action, detail = null) {
  try { await sb('cc_activity', 'POST', { link_id, actor_user_id, candidate_user_id, action, detail }) }
  catch (e) { console.error('[cc] log fail', e.message) }
}

// Load an ACTIVE link that authorizes `actor` (an Action user) to act on `candidateUserId`.
async function activeLinkFor(actorId, candidateUserId) {
  const { data } = await sb(`account_links?action_user_id=eq.${actorId}&candidate_user_id=eq.${candidateUserId}&status=eq.active&select=*`)
  return Array.isArray(data) && data[0] ? data[0] : null
}

module.exports = {
  SUPABASE_URL, SUPABASE_SERVICE_KEY, cors, sb, verifyUser, findUserByEmail,
  planOf, planTypeOf, isActionUser, isPaidCandidate, DEFAULT_PERMS, logActivity, activeLinkFor, ADMIN_EMAILS,
}
