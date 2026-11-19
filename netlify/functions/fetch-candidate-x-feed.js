// netlify/functions/fetch-candidate-x-feed.js
// X posts by and about a candidate, for the profile page's Intel tab.
//
// WHY THIS WAS REWRITTEN (Nov 2026): the old version called the X API v2
// recent-search endpoint with X_BEARER_TOKEN. Nothing showed on any profile
// because (a) the page only called it when someone pressed "Load X posts",
// (b) the call needed an X developer token the platform's X research does not
// use — every other X lookup (the Profiler's Grok packet, polling) goes
// through xAI's Responses API with the server-side x_search tool — and
// (c) v2 recent search only reaches back 7 days, which for a local candidate
// who posts a few times a month is usually nothing. There was no cache, so
// every open would have paid for a fresh search.
//
// Now: Grok (MODELS.GROK) + x_search finds the candidate's account (the handle
// on file, the one the profile found, or a name + office + place search) and
// returns their recent posts plus posts about them, as JSON. Every post must
// carry a real x.com/<user>/status/<id> URL, and when the response cites
// sources, a post whose status id was never cited is dropped — a post the
// model made up cannot reach the page. Results are cached per candidate in
// public.candidate_x_feed (supabase/migrations/20261119000001_candidate_x_feed.sql)
// for CACHE_TTL_MS.
//
// POST { candidate_id, handle?, refresh? }
//   refresh falsy → the cached posts (no AI call) + `stale` so the page can ask
//                   for a refresh in the background.
//   refresh true  → a fresh x_search, saved to the cache, returned.
// Returns { posts: [{ id, url, author_name, author_username, created_at, text, about }],
//           handle, fetched_at, stale, cache: bool, source }
//
// The X API v2 path is kept as a fallback for deployments that have an
// X_BEARER_TOKEN but no XAI_API_KEY.

const { MODELS } = require('./_models')
const { enforceRateLimit } = require('./_rate-limit')
const { logAiUsage } = require('./_ai-usage')

const CACHE_TTL_MS = 6 * 60 * 60 * 1000      // a cached feed is "fresh" for 6 hours
const GROK_TIMEOUT_MS = 50000                  // netlify.toml gives the function 60s
const MAX_POSTS = 20

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
}

const env = () => ({
  SUPABASE_URL: process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
  SUPABASE_ANON: process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY,
  SERVICE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  XAI_API_KEY: process.env.XAI_API_KEY,
  X_BEARER: process.env.X_BEARER_TOKEN,
})

const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) })
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const NOT_HANDLES = new Set(['search', 'home', 'i', 'intent', 'share', 'hashtag', 'explore', 'settings', 'login'])

/** A strict X handle (letters, digits, underscore, ≤15) or ''. Blocks search-operator injection. */
function cleanHandle(value) {
  const s = String(value || '').trim()
  const fromUrl = s.match(/(?:x|twitter)\.com\/@?([A-Za-z0-9_]{1,15})(?:[/?#]|$)/i)
  const h = fromUrl ? fromUrl[1] : (s.replace(/^@/, '').match(/^[A-Za-z0-9_]{1,15}$/) || [''])[0]
  return h && !NOT_HANDLES.has(h.toLowerCase()) ? h : ''
}

const STATUS_RE = /https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status(?:es)?\/(\d{5,25})/i

/** Who/where line for the search prompt, from the candidate row. */
function describeCandidate(c) {
  const office = c?.office
  const officeLine = office ? [office.name, office.district_name].filter(Boolean).join(', ') : ''
  const place = [office?.city, office?.county ? `${office.county} County` : ''].filter(Boolean).join(', ')
  return {
    name: String(c?.name || '').slice(0, 150),
    officeLine,
    place: place || 'Wisconsin',
    party: c?.party || '',
  }
}

/** The x_search prompt. Exported for tests. */
function buildPrompt(candidate, handle) {
  const d = describeCandidate(candidate)
  const who = [`${d.name}`, d.party ? `(${d.party})` : '', d.officeLine ? `— ${d.officeLine}` : '', `— ${d.place}, Wisconsin`].filter(Boolean).join(' ')
  const account = handle
    ? `Their X account is @${handle}. First pull their own most recent posts from @${handle} (up to 12, newest first, going back as far as needed — local candidates post rarely). Then add recent posts by OTHER accounts that mention ${d.name} by name or tag @${handle}.`
    : `Their X account is not on file. First search X for their account: match the name AND Wisconsin AND their role or town. If you find it with confidence, pull their own recent posts (up to 12). If you cannot tell which account is theirs, do not guess — set "handle" to null. Either way, add recent posts by others that clearly mention ${d.name} in a Wisconsin political or community context.`
  return `Use the x_search tool now to find X (Twitter) posts by and about this Wisconsin political figure: ${who}.

${account}

Rules:
- Only include posts you actually retrieved with x_search in this session. Never invent, merge or paraphrase a post.
- Copy each post's text verbatim (trim to 500 characters).
- Every post needs its real URL in the form https://x.com/<username>/status/<id>.
- Skip posts about a different person with the same name.
- Newest first. At most 15 posts.

Return ONLY a JSON object, no prose and no code fence:
{"handle": "their username without @, or null", "posts": [{"url": "https://x.com/<username>/status/<id>", "author_name": "display name", "author_username": "username", "created_at": "YYYY-MM-DD", "text": "verbatim post text", "about": "by_candidate" | "mentions"}]}
If nothing is found return {"handle": null, "posts": []}.`
}

/** The text and the cited URLs of an xAI Responses API reply. */
function readGrokResponse(data) {
  let text = ''
  const cited = []
  if (Array.isArray(data?.citations)) for (const u of data.citations) cited.push(typeof u === 'string' ? u : u?.url)
  for (const out of (data?.output || [])) {
    if (out?.type !== 'message') continue
    for (const c of (out.content || [])) {
      if (c?.type !== 'output_text' || !c.text) continue
      text += (text ? '\n' : '') + c.text
      for (const a of (c.annotations || [])) cited.push(a?.url || a?.url_citation?.url)
    }
  }
  return { text, cited: cited.filter(Boolean) }
}

/** First JSON object in a model reply (tolerates a code fence or a sentence around it). */
function parseJsonObject(text) {
  const s = String(text || '').replace(/```(?:json)?/gi, '')
  const a = s.indexOf('{')
  const b = s.lastIndexOf('}')
  if (a < 0 || b <= a) return null
  try { return JSON.parse(s.slice(a, b + 1)) } catch { return null }
}

function isoDate(v) {
  if (!v) return null
  const t = Date.parse(String(v))
  if (Number.isNaN(t)) return null
  const d = new Date(t)
  // A post from the future is a model slip, not a post.
  if (t > Date.now() + 36 * 3600 * 1000) return null
  return d.toISOString()
}

/**
 * Model JSON → clean posts. Drops anything without a real status URL, and —
 * when the reply cited sources — anything whose status id was never cited.
 */
function validatePosts(parsed, cited = []) {
  const list = Array.isArray(parsed?.posts) ? parsed.posts : Array.isArray(parsed) ? parsed : []
  const citedIds = new Set()
  for (const u of cited) { const m = String(u || '').match(STATUS_RE); if (m) citedIds.add(m[2]) }
  const seen = new Set()
  const out = []
  for (const p of list) {
    if (!p || typeof p !== 'object') continue
    const m = String(p.url || '').match(STATUS_RE)
    if (!m) continue
    const [, user, id] = m
    if (seen.has(id)) continue
    if (citedIds.size && !citedIds.has(id)) continue
    const text = String(p.text || '').replace(/\s+/g, ' ').trim().slice(0, 500)
    if (!text) continue
    seen.add(id)
    out.push({
      id,
      url: `https://x.com/${user}/status/${id}`,
      author_name: String(p.author_name || '').trim().slice(0, 80) || `@${user}`,
      author_username: user,
      created_at: isoDate(p.created_at),
      text,
      about: p.about === 'by_candidate' ? 'by_candidate' : 'mentions',
    })
  }
  out.sort((a, b) => (Date.parse(b.created_at || 0) || 0) - (Date.parse(a.created_at || 0) || 0))
  return out.slice(0, MAX_POSTS)
}

async function grokSearch({ apiKey, candidate, handle, fetchImpl = fetch }) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), GROK_TIMEOUT_MS)
  try {
    const res = await fetchImpl('https://api.x.ai/v1/responses', {
      method: 'POST',
      signal: ctrl.signal,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODELS.GROK,
        input: [{ role: 'user', content: buildPrompt(candidate, handle) }],
        tools: [{ type: 'x_search' }],
      }),
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      const err = new Error(`xAI ${res.status}`)
      err.status = res.status
      err.detail = detail.slice(0, 300)
      throw err
    }
    const data = await res.json()
    const { text, cited } = readGrokResponse(data)
    const parsed = parseJsonObject(text)
    const posts = validatePosts(parsed, cited)
    const found = cleanHandle(parsed?.handle)
    return { posts, handle: handle || found || '', usage: data?.usage || null }
  } finally {
    clearTimeout(timer)
  }
}

// X API v2 recent search — fallback only (7-day window, needs X_BEARER_TOKEN).
async function xApiSearch({ bearer, candidate, handle, fetchImpl = fetch }) {
  const name = String(candidate?.name || '').replace(/["<>`]/g, '').slice(0, 120)
  const parts = []
  if (handle) parts.push(`from:${handle}`)
  parts.push(`"${name}" Wisconsin`)
  const query = `${parts.length > 1 ? `(${parts.join(' OR ')})` : parts[0]} -is:retweet`
  const params = new URLSearchParams({
    query, max_results: '20',
    'tweet.fields': 'created_at,author_id', expansions: 'author_id', 'user.fields': 'name,username',
  })
  const res = await fetchImpl(`https://api.twitter.com/2/tweets/search/recent?${params}`, { headers: { Authorization: `Bearer ${bearer}` } })
  if (!res.ok) { const e = new Error(`X API ${res.status}`); e.status = res.status; throw e }
  const data = await res.json()
  const users = Object.fromEntries((data.includes?.users || []).map(u => [u.id, u]))
  const posts = (data.data || []).map(t => {
    const u = users[t.author_id] || {}
    return {
      url: u.username ? `https://x.com/${u.username}/status/${t.id}` : '',
      author_name: u.name, created_at: t.created_at, text: t.text,
      about: handle && u.username && u.username.toLowerCase() === handle.toLowerCase() ? 'by_candidate' : 'mentions',
    }
  })
  return { posts: validatePosts({ posts }), handle, usage: null }
}

// ── Supabase (service role, scoped to the caller) ────────────────────────────

async function verifyUser(e, authHeader, fetchImpl) {
  if (!authHeader?.startsWith('Bearer ')) return null
  const res = await fetchImpl(`${e.SUPABASE_URL}/auth/v1/user`, { headers: { apikey: e.SUPABASE_ANON || e.SERVICE_KEY, Authorization: authHeader } })
  if (!res.ok) return null
  const u = await res.json()
  return u?.id ? u : null
}

async function loadCandidate(e, candidateId, userId, fetchImpl) {
  const sel = 'id,name,party,twitter_handle,created_by,office:offices(name,district_name,county,city)'
  const res = await fetchImpl(
    `${e.SUPABASE_URL}/rest/v1/candidates?id=eq.${encodeURIComponent(candidateId)}&created_by=eq.${encodeURIComponent(userId)}&select=${encodeURIComponent(sel)}`,
    { headers: { apikey: e.SERVICE_KEY, Authorization: `Bearer ${e.SERVICE_KEY}` } },
  )
  if (!res.ok) return null
  const rows = await res.json()
  return Array.isArray(rows) && rows[0] ? rows[0] : null
}

/** { row, available } — available=false when the cache table isn't there yet. */
async function readCache(e, candidateId, fetchImpl) {
  try {
    const res = await fetchImpl(
      `${e.SUPABASE_URL}/rest/v1/candidate_x_feed?candidate_id=eq.${encodeURIComponent(candidateId)}&select=*`,
      { headers: { apikey: e.SERVICE_KEY, Authorization: `Bearer ${e.SERVICE_KEY}` } },
    )
    if (!res.ok) return { row: null, available: false }
    const rows = await res.json()
    return { row: Array.isArray(rows) && rows[0] ? rows[0] : null, available: true }
  } catch {
    return { row: null, available: false }
  }
}

async function writeCache(e, row, fetchImpl) {
  try {
    const res = await fetchImpl(`${e.SUPABASE_URL}/rest/v1/candidate_x_feed?on_conflict=candidate_id`, {
      method: 'POST',
      headers: {
        apikey: e.SERVICE_KEY, Authorization: `Bearer ${e.SERVICE_KEY}`,
        'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(row),
    })
    return res.ok
  } catch {
    return false
  }
}

const isStale = (row, now = Date.now()) => !row?.fetched_at || now - Date.parse(row.fetched_at) > CACHE_TTL_MS

async function handler(event, { fetchImpl = fetch } = {}) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' }
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' })
  const e = env()

  const user = await verifyUser(e, event.headers?.authorization || event.headers?.Authorization, fetchImpl)
  if (!user) return json(401, { error: 'Not authenticated' })

  let body
  try { body = JSON.parse(event.body || '{}') } catch { return json(400, { error: 'Invalid JSON' }) }
  const candidateId = String(body.candidate_id || '')
  if (!UUID.test(candidateId)) return json(400, { error: 'valid candidate_id required' })
  const refresh = body.refresh === true

  const limited = await enforceRateLimit(user.id, refresh ? 'fetch-candidate-x-feed-refresh' : 'fetch-candidate-x-feed', CORS)
  if (limited) return limited

  const candidate = await loadCandidate(e, candidateId, user.id, fetchImpl)
  if (!candidate) return json(404, { error: 'Candidate not found' })

  const cache = await readCache(e, candidateId, fetchImpl)
  const cachedHandle = cleanHandle(cache.row?.handle)
  const handle = cleanHandle(candidate.twitter_handle) || cleanHandle(body.handle) || cachedHandle

  if (!refresh) {
    return json(200, {
      posts: Array.isArray(cache.row?.posts) ? cache.row.posts : [],
      handle: cachedHandle || handle || null,
      fetched_at: cache.row?.fetched_at || null,
      stale: isStale(cache.row),
      cache: cache.available,
      source: cache.row?.source || null,
    })
  }

  let result
  let source
  try {
    if (e.XAI_API_KEY) {
      result = await grokSearch({ apiKey: e.XAI_API_KEY, candidate, handle, fetchImpl })
      source = 'grok'
      logAiUsage({ userId: user.id, endpoint: 'candidates', provider: 'xai', model: MODELS.GROK, inputTokens: result.usage?.input_tokens || 0, outputTokens: result.usage?.output_tokens || 0, flatUsd: 0.025, estimated: true })
    } else if (e.X_BEARER) {
      result = await xApiSearch({ bearer: e.X_BEARER, candidate, handle, fetchImpl })
      source = 'x_api'
    } else {
      return json(503, { error: 'X search is not configured on this site (XAI_API_KEY is missing).' })
    }
  } catch (err) {
    console.error('[x-feed] search failed:', err.message, err.detail || '')
    // Serve what we have rather than an error card when a refresh fails.
    if (cache.row?.posts?.length) {
      return json(200, { posts: cache.row.posts, handle: cachedHandle || handle || null, fetched_at: cache.row.fetched_at, stale: true, cache: cache.available, source: cache.row.source || null, refresh_error: 'X search is unavailable right now.' })
    }
    const status = err.name === 'AbortError' ? 504 : err.status === 429 ? 429 : 502
    return json(status, { error: status === 504 ? 'X search took too long. Try again in a minute.' : status === 429 ? 'X search is busy. Try again in a few minutes.' : 'X search is unavailable right now.' })
  }

  const fetchedAt = new Date().toISOString()
  const saved = cache.available
    ? await writeCache(e, { candidate_id: candidateId, created_by: user.id, handle: result.handle || null, posts: result.posts, source, fetched_at: fetchedAt }, fetchImpl)
    : false
  console.log(`[x-feed] ${result.posts.length} posts for ${candidateId} via ${source}${result.handle ? ` (@${result.handle})` : ''}${saved ? ', cached' : ''}`)
  return json(200, { posts: result.posts, handle: result.handle || null, fetched_at: fetchedAt, stale: false, cache: cache.available, source })
}

module.exports = {
  handler: (event) => handler(event),
  _handler: handler,
  buildPrompt, readGrokResponse, parseJsonObject, validatePosts, cleanHandle, isStale, describeCandidate,
  CACHE_TTL_MS, GROK_TIMEOUT_MS, MAX_POSTS,
}
