// Netlify Function: research-district-events
// Finds upcoming community events in an area (legislative district, county or
// municipality) using Perplexity (web research) + Claude (structuring +
// political-lean classification), enriches with og:image thumbnails, and
// caches per area in the shared district_events table.
//
// Runs as a Netlify BACKGROUND function (-background suffix → 15 min budget):
// Netlify answers the browser with 202 BEFORE this handler runs, which means
// every statusCode returned below is thrown away. So the handler's real output
// contract is the pair of rows it writes:
//   district_events           — the result cache (shared; see isStaleCache)
//   district_events_progress  — the phase/status row the client polls
// Every phase boundary and every terminal outcome (done or error) writes the
// progress row; without it a failure is invisible and the client spins forever.
//
// Request body (from src/pages/Events.jsx):
//   { district_key, district_name, counties: string[], places: string[],
//     area_description?: string, district_lean?: string, force?: boolean }
// `places` is the FULL municipality list for the area (ordered by population).
// Older clients omit it; then area_description ("A, B, C (X, Y counties)") is
// parsed as before.
//
// Re-run policy: a non-admin request only searches when the cached result is
// STALE (isStaleCache). A fresh cache is a no-op that ends with
// {status:'done', stage:4, message:'fresh'} and never touches the rate limiter.
// Admins may pass force:true to always re-run.
//
// CommonJS so tests can require() the pure helpers exported at the bottom.

const COUNTY_SOURCES = require('./_county-sources.json')
const { matchPartisanSignals } = require('./_partisan-signals.js')
const { logAiUsage } = require('./_ai-usage.js')
const { ADMIN_EMAILS } = require('./_config.js')

// Most of the codebase pins Opus via the literal 'claude-opus-4-8'
// (generate-dossier*, discover-candidates, generate-campaign-intel, …); this
// function and research-district-history share the CLAUDE_RESEARCH_MODEL
// override with the same default.
const DEFAULT_CLAUDE_MODEL = 'claude-opus-4-8'

// Progress stages, mirrored by PHASE_LABELS in src/pages/Events.jsx.
const STAGE_SEARCH    = 1   // Perplexity sweep of public calendars & community sources
const STAGE_NEWS      = 2   // local-news pass
const STAGE_STRUCTURE = 3   // Claude structuring + lean classification
const STAGE_ENRICH    = 4   // registry verification, images, addresses

// ── Limits & budgets ─────────────────────────────────────────────────────────
// Keys look like 'assembly-8', 'county-St. Croix', 'city-Green Bay-Brown',
// 'city-Weston (town)-Marathon'. Spaces, periods, apostrophes and parentheses
// are legitimate; anything else (quotes, semicolons, slashes …) is not.
const DISTRICT_KEY_RE   = /^[\w :.'()-]{1,100}$/
const STALE_AFTER_DAYS  = 7
const MAX_PLACES        = 600    // page sends ≤ ~500 (largest district: 491)
const MAX_PLACE_LEN     = 60
const MAX_COUNTIES      = 40     // congressional districts span 20+ counties
const PROMPT_PLACES     = 15     // places named in prompts (population order)
const RUN_BUDGET_MS     = 12 * 60 * 1000   // well inside Netlify's 15-min cap
const HEARTBEAT_MS      = 30 * 1000
const TIMEOUT = {
  supabase:          15000,
  perplexityMain:    60000,
  perplexityNews:    21000,
  perplexityExtra:   45000,   // was 21 s — sonar-pro routinely needs longer
  perplexityVerify:  30000,
  xSearch:           12000,
  anthropicStructure: 150000, // 16k-token structuring call
  anthropicSmall:    60000,
  pageFetch:         5000,
}

// ── Pure helpers (exported for tests) ────────────────────────────────────────

/** Today's calendar date in Wisconsin (America/Chicago), as YYYY-MM-DD. */
function centralTodayIso(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now)
  const get = (t) => parts.find(p => p.type === t)?.value
  return `${get('year')}-${get('month')}-${get('day')}`
}

/** First 10 chars of a date-ish value if they form a real YYYY-MM-DD, else null. */
function isoDateOrNull(v) {
  if (v == null) return null
  const s = String(v).slice(0, 10)
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return null
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]))
  if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) return null
  return s
}

/** The last day an event is still happening (date_end || date_start), or null. */
function eventLastDay(e) {
  return isoDateOrNull(e?.date_end) || isoDateOrNull(e?.date_start)
}

/** True when the event has a parseable date and has not finished before today. */
function isUpcomingEvent(e, todayIso) {
  const last = eventLastDay(e)
  return Boolean(last) && last >= todayIso
}

/**
 * Should the cached row be re-researched?
 * Stale when: no row, no events, no event still upcoming (date_end || date_start
 * ≥ today; unparseable dates don't count), or fetched_at older than 7 days
 * (or missing/unparseable).
 */
function isStaleCache(row, todayIso, nowMs = Date.now()) {
  if (!row) return true
  const events = Array.isArray(row.events) ? row.events : []
  if (!events.length) return true
  if (!events.some(e => isUpcomingEvent(e, todayIso))) return true
  const fetchedMs = Date.parse(row.fetched_at)
  if (!Number.isFinite(fetchedMs)) return true
  return nowMs - fetchedMs > STALE_AFTER_DAYS * 86400000
}

function addDaysIso(iso, days) {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10)
}

/**
 * Past-date guard for one event. Returns the event (possibly with date_start
 * rolled forward to the next weekly/biweekly occurrence ≥ today) or null when
 * it is over or its date cannot be parsed.
 */
function upcomingOrNull(e, todayIso) {
  if (!e || typeof e !== 'object') return null
  const start = isoDateOrNull(e.date_start)
  if (!start) return null
  const end = isoDateOrNull(e.date_end)
  const step = { weekly: 7, biweekly: 14 }[String(e.recurrence || '').toLowerCase()]
  if (step && start < todayIso) {
    let next = start
    for (let i = 0; i < 60 && next < todayIso; i++) next = addDaysIso(next, step)
    if (next < todayIso || (end && next > end)) return null
    return { ...e, date_start: next }
  }
  return (end || start) >= todayIso ? e : null
}

/** Strip "(town)" / periods / extra spaces for whole-word matching. */
function normalizeForMatch(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\((?:town|village|city|township)\)/g, ' ')
    .replace(/\./g, '')
    .replace(/[^a-z0-9' -]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

/** Validated, de-duplicated place list from the request body (null if absent). */
function normalizePlaces(raw) {
  if (!Array.isArray(raw)) return null
  const seen = new Set()
  const out = []
  for (const p of raw) {
    if (typeof p !== 'string') continue
    const v = p.replace(/\s+/g, ' ').trim().slice(0, MAX_PLACE_LEN)
    const k = v.toLowerCase()
    if (!v || seen.has(k)) continue
    seen.add(k); out.push(v)
    if (out.length >= MAX_PLACES) break
  }
  return out
}

/** Legacy clients: "A, B, C (X, Y counties)" → ['A','B','C']. Never returns a
 *  district label like "Assembly District 8" as a place. */
function parseAreaDescriptionPlaces(area) {
  if (!area) return []
  return String(area).split('(')[0].split(',')
    .map(x => x.trim().slice(0, MAX_PLACE_LEN))
    .filter(x => x && !/\bdistrict\b/i.test(x) && !/^(wi|wisconsin)$/i.test(x))
}

/** County named by a county-/city- key, e.g. 'county-St. Croix' → 'St. Croix'. */
function countyFromKey(key) {
  const k = String(key || '')
  if (k.startsWith('county-')) return k.slice(7) || null
  if (k.startsWith('city-')) { const i = k.lastIndexOf('-'); return i > 5 ? k.slice(i + 1) : null }
  return null
}

function countyPhrase(counties) {
  if (!counties.length) return null
  const shown = counties.slice(0, 6)
  const more = counties.length > shown.length ? ' and neighboring' : ''
  return `${shown.join(', ')}${more} ${counties.length > 1 ? 'counties' : 'County'}`
}

/** Area text for prompts: ≤ 15 places + "and other communities in … County". */
function promptArea(places, counties) {
  const cp = countyPhrase(counties)
  if (places.length) {
    const head = places.slice(0, PROMPT_PLACES).join(', ')
    if (places.length <= PROMPT_PLACES) return head
    return `${head}, and other communities in ${cp || 'the area'}`
  }
  return cp ? `communities in ${cp}` : ''
}

/**
 * In-area filter: whole-word, case-insensitive match of the FULL place list
 * against the event's city/venue/address. County names are accepted when the
 * key is a county (or when there is no place list), matched against all of the
 * event's text. County fairs are county-wide by nature and always kept.
 */
function buildAreaMatcher({ places = [], counties = [], districtKey = '' }) {
  const placeTerms = [...new Set(places.map(normalizeForMatch).filter(t => t && t.length > 1))]
  const useCounties = String(districtKey).startsWith('county-') || !placeTerms.length
  const countyTerms = useCounties ? [...new Set(counties.map(normalizeForMatch).filter(Boolean))] : []
  if (!placeTerms.length && !countyTerms.length) return () => true
  const wordRe = (terms) => terms.length
    ? new RegExp(`(?:^|[^a-z0-9])(?:${terms.sort((a, b) => b.length - a.length).map(escapeRe).join('|')})(?=$|[^a-z0-9])`)
    : null
  const placeRe  = wordRe(placeTerms)
  const countyRe = wordRe(countyTerms)
  return (e) => {
    if (!e) return false
    if (e.category === 'fair') return true
    const loc = normalizeForMatch([e.city, e.venue, e.address].filter(Boolean).join(' '))
    if (placeRe && placeRe.test(loc)) return true
    if (countyRe) {
      const all = normalizeForMatch([e.city, e.venue, e.address, e.name, e.host, e.description].filter(Boolean).join(' '))
      if (countyRe.test(all)) return true
    }
    return false
  }
}

/**
 * Parse JSON out of model output: tolerates preamble, ``` fences and trailing
 * commentary (parses first '{'/'[' to the matching last '}'/']'). When that
 * fails (e.g. output truncated at max_tokens) it salvages every COMPLETE object
 * of the first array. Returns { value, salvaged } or null.
 */
function parseModelJson(text) {
  if (typeof text !== 'string' || !text.trim()) return null
  const s = text.replace(/^\s*```[a-zA-Z]*\s*$/gm, '')
  const iObj = s.indexOf('{')
  const iArr = s.indexOf('[')
  if (iObj < 0 && iArr < 0) return null
  const isArr = iArr >= 0 && (iObj < 0 || iArr < iObj)
  const start = isArr ? iArr : iObj
  const end = s.lastIndexOf(isArr ? ']' : '}')
  if (end > start) {
    try { return { value: JSON.parse(s.slice(start, end + 1)), salvaged: false } } catch { /* salvage below */ }
  }
  const items = salvageArrayObjects(s, start)
  return items.length ? { value: items, salvaged: true } : null
}

/** Every complete, individually-parseable {…} element of the first array at/after `from`. */
function salvageArrayObjects(s, from = 0) {
  const a = s.indexOf('[', from)
  if (a < 0) return []
  const out = []
  let depth = 0, inStr = false, esc = false, objStart = -1
  for (let i = a + 1; i < s.length; i++) {
    const ch = s[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') { inStr = true; continue }
    if (ch === '{' || ch === '[') {
      if (depth === 0 && ch === '{') objStart = i
      depth++
    } else if (ch === '}' || ch === ']') {
      if (depth === 0) break                 // end of the array itself
      depth--
      if (depth === 0 && ch === '}' && objStart >= 0) {
        try { out.push(JSON.parse(s.slice(objStart, i + 1))) } catch { /* skip malformed element */ }
        objStart = -1
      }
    }
  }
  return out
}

/** The list under `key` from a parseModelJson result (or the bare array). */
function listFromParsed(parsed, key) {
  if (!parsed) return []
  const v = parsed.value
  if (Array.isArray(v)) return v
  return Array.isArray(v?.[key]) ? v[key] : []
}

/** Rate-limit progress message by which budget tripped. */
function rateLimitMessage(limitedResponse) {
  let which = null
  try { which = JSON.parse(limitedResponse?.body || '{}').limit || null } catch { /* unknown */ }
  return which === 'day'
    ? "You've reached today's event-search limit — it resets at midnight."
    : 'Too many searches in the last minute — try again shortly.'
}

/** Pull "district_key" out of an unparseable body so the error can still be reported. */
function sniffDistrictKey(rawBody) {
  const m = String(rawBody || '').match(/"district_key"\s*:\s*"([^"\\]{1,100})"/)
  return m ? m[1] : null
}

/** Run fn(signal) under an AbortController that fires after `ms`. */
async function withTimeout(ms, fn) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(new Error(`timed out after ${Math.round(ms / 1000)} s`)), ms)
  try { return await fn(ctrl.signal) } finally { clearTimeout(timer) }
}

// ── District size ─────────────────────────────────────────────────────────────
// A municipal or county district is small enough to enumerate exhaustively: the
// campaign can plausibly attend every town, village, city, school and county
// board meeting in it. A legislative or congressional district spans dozens of
// municipalities and hundreds of boards, so an exhaustive sweep is both
// impossible to research well and useless to the user — those districts get the
// major bodies plus whatever is actually drawing attention.
function classifyDistrictSize(districtKey = '', districtName = '') {
  const type = String(districtKey).split('-')[0].toLowerCase()
  if (['city', 'county', 'municipal', 'town', 'village', 'school'].includes(type)) {
    return { size: 'small', label: type === 'county' ? 'single county' : 'single municipality' }
  }
  if (['assembly', 'senate', 'congress', 'statewide', 'state'].includes(type)) {
    return { size: 'large', label: 'multi-municipality legislative district' }
  }
  // Unknown key shape — fall back to the name, and default to LARGE so an
  // unrecognised district never triggers an exhaustive board-by-board sweep.
  if (/\b(county|city|village|town(ship)?|school district)\b/i.test(districtName)
      && !/\b(assembly|senate|congress|congressional|statewide)\b/i.test(districtName)) {
    return { size: 'small', label: 'local district' }
  }
  return { size: 'large', label: 'multi-municipality district' }
}

/** The government-meetings rule for the research + structuring prompts. */
function meetingsDirective(size, label) {
  if (size === 'small') {
    return `GOVERNMENT MEETINGS — EXHAUSTIVE (this is a ${label}, small enough to cover completely).
List EVERY upcoming public meeting of EVERY local governing body whose jurisdiction covers these communities. No "major ones only" filter, no exceptions: common council / city council, town board, village board, county board of supervisors AND its standing committees, school board (every district serving these communities), plan commission, zoning board of appeals, police and fire commission, library board, park and recreation board, utility commission, sanitary and lake districts, and any other municipal board or commission that posts a public agenda. Check each municipality's own website and agenda portal plus the statutory public meeting-notice postings. Recurring bodies get ONE entry starting at their next occurrence, with the schedule stated (e.g. "2nd Tuesday, 6:00 PM"). Never omit a board for being small, routine or sparsely attended — in a district this size those rooms are the district.`
  }
  return `GOVERNMENT MEETINGS — MAJOR OR NEWSWORTHY ONLY (this is a ${label} covering many municipalities).
Do NOT try to enumerate every town, village, school and county board in it — there are hundreds and the campaign cannot attend them. Include a government meeting ONLY if it clears one of these two bars:
 (1) MAJOR BODY — a county board of supervisors of a county in the district, or the common council or school board of one of the district's largest communities.
 (2) NOTABLE ATTENTION — the meeting is drawing real public attention or buzz: local news has previewed or covered it, its agenda carries a contested or high-stakes item (referendum, budget or levy vote, school closure or boundary change, major development, ordinance fight, controversial appointment), or organized turnout is being promoted for it.
Routine, uncontested small-board meetings are noise at this district size — skip them entirely.`
}

/** Build a per-county source brief for the research prompts. */
function countySourceBrief(counties = []) {
  const parts = []
  for (const c of counties.slice(0, 5)) {
    const src = COUNTY_SOURCES[c]
    if (!src) continue
    const lines = []
    if (src.newspapers?.length)      lines.push(`newspapers: ${src.newspapers.join('; ')}`)
    if (src.broadcast?.length)       lines.push(`TV/radio: ${src.broadcast.join('; ')}`)
    if (src.chambers_tourism?.length) lines.push(`chambers/tourism: ${src.chambers_tourism.join('; ')}`)
    if (src.gov_calendars?.length)   lines.push(`government calendars: ${src.gov_calendars.join('; ')}`)
    if (src.community?.length)       lines.push(`community orgs/pages: ${src.community.join('; ')}`)
    if (src.prompt_hint)             lines.push(`tip: ${src.prompt_hint}`)
    parts.push(`${c} County —\n  ${lines.join('\n  ')}`)
  }
  return parts.join('\n')
}


// ── HTML metadata extraction ──────────────────────────────────────────────────
const EXPIRING_CDN = /(^|\.)fbcdn\.net$|(^|\.)fbsbx\.com$/i

function absolutize(src, base) {
  try {
    const u = new URL(String(src), base)
    if (!/^https?:$/.test(u.protocol)) return null
    if (EXPIRING_CDN.test(u.hostname)) return null   // signed URLs that expire
    return u.href
  } catch { return null }
}

/** Pull image + event details from a page: JSON-LD schema.org/Event first,
 *  then og:image / twitter:image / link rel=image_src. */
function extractEventMeta(html, pageUrl) {
  const out = {}

  // 1. JSON-LD (authoritative when present)
  for (const b of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const nodes = []
      const walk = (n) => {
        if (!n) return
        if (Array.isArray(n)) return n.forEach(walk)
        if (typeof n === 'object') { nodes.push(n); if (n['@graph']) walk(n['@graph']) }
      }
      walk(JSON.parse(b[1].trim()))
      const ev = nodes.find(n => /(^|\W)Event/i.test(String(n['@type'] || '')))
      if (!ev) continue
      const rawImg = Array.isArray(ev.image) ? ev.image[0] : ev.image
      const imgUrl = typeof rawImg === 'object' ? rawImg?.url : rawImg
      if (imgUrl) out.image = absolutize(imgUrl, pageUrl)
      if (ev.startDate) {
        out.date_start = String(ev.startDate).slice(0, 10)
        const t = String(ev.startDate).match(/T(\d{2}:\d{2})/)
        if (t) out.time = t[1]
      }
      if (ev.endDate) out.date_end = String(ev.endDate).slice(0, 10)
      const loc = Array.isArray(ev.location) ? ev.location[0] : ev.location
      if (loc?.name) out.venue = String(loc.name)
      const addr = loc?.address
      if (typeof addr === 'string') out.address = addr
      else if (addr?.streetAddress) {
        out.address = [addr.streetAddress, addr.addressLocality].filter(Boolean).join(', ')
      }
      break
    } catch { /* malformed JSON-LD block — try the next one */ }
  }

  // 2. Meta-tag fallbacks for the image — try each candidate until one
  // survives absolutize() (which rejects non-http and expiring-CDN URLs)
  if (!out.image) {
    const candidates = [
      html.match(/<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]+content=["']([^"']+)["']/i),
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image(?::secure_url)?["']/i),
      html.match(/<meta[^>]+name=["']twitter:image(?::src)?["'][^>]+content=["']([^"']+)["']/i),
      html.match(/<link[^>]+rel=["']image_src["'][^>]+href=["']([^"']+)["']/i),
    ]
    for (const m of candidates) {
      const abs = m?.[1] ? absolutize(m[1], pageUrl) : null
      if (abs) { out.image = abs; break }
    }
  }
  if (out.image === null) delete out.image
  return out
}

// ── Handler ───────────────────────────────────────────────────────────────────
const handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json',
  }
  const reply = (statusCode, payload) => ({ statusCode, headers, body: JSON.stringify(payload) })
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' }
  if (event.httpMethod !== 'POST') return reply(405, { error: 'Method not allowed' })

  const runStartedMs = Date.now()
  const runDeadlineMs = runStartedMs + RUN_BUDGET_MS
  const timeLeft = () => runDeadlineMs - Date.now()

  const ANTHROPIC_API_KEY    = process.env.ANTHROPIC_API_KEY
  const CLAUDE_MODEL         = process.env.CLAUDE_RESEARCH_MODEL || DEFAULT_CLAUDE_MODEL
  const PERPLEXITY_API_KEY   = process.env.PERPLEXITY_API_KEY
  const SUPABASE_URL         = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

  // ── Body + key first: once the key is known every exit can be reported ─────
  let body = null
  try {
    const parsedBody = JSON.parse(event.body || '{}')
    if (parsedBody && typeof parsedBody === 'object' && !Array.isArray(parsedBody)) body = parsedBody
  } catch { /* reported below, once the caller is authenticated */ }
  const district_key = typeof body?.district_key === 'string' ? body.district_key : sniffDistrictKey(event.body)
  // Audit fix (#17/#18): district_key is the sole PK of a shared cache table —
  // keep its shape strict (but allow the spaces / periods / apostrophes /
  // "(town)" that real county and municipality names contain).
  if (!district_key || !DISTRICT_KEY_RE.test(district_key)) {
    return reply(400, { error: body ? 'Invalid district_key' : 'Invalid JSON' })
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    // No service key → no way to write the progress row either.
    console.error('[district-events] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing')
    return reply(500, { error: 'Server not configured' })
  }
  const keyEnc = encodeURIComponent(district_key)

  const sb = (path, opts = {}) => withTimeout(TIMEOUT.supabase, (signal) => fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    signal,
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  }))

  // The client's only window into this run. Best-effort: a failed progress write
  // must never take down a run that is otherwise working.
  let currentStage = STAGE_SEARCH
  const reportStage = async (stage, status = 'running', message = null, { start = false } = {}) => {
    if (status === 'running') currentStage = stage
    const now = new Date().toISOString()
    try {
      await sb('district_events_progress', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({
          district_key, stage, status, message,
          ...(start ? { started_at: now } : {}),
          updated_at: now,
        }),
      })
    } catch (e) { console.warn('[district-events] reportStage failed:', e.message) }
  }
  const reportError = (message, stage = currentStage) => reportStage(stage, 'error', message)

  // ── Auth ────────────────────────────────────────────────────────────────────
  // An unauthenticated caller can't be attributed, but the page still needs to
  // hear about it. Don't let such a request clobber somebody else's live run.
  // Deliberately writes NOTHING: progress rows are shared by every user, so an
  // unauthenticated request must not be able to mark any area as failed. The
  // page checks for a session before it POSTs and reports a missing one itself.
  const reportAuthError = async (message) => {
    console.warn(`[district-events] rejected unauthenticated request for ${district_key}: ${message}`)
  }
  const AUTH_MSG = 'Your sign-in has expired — refresh the page, sign in again and retry.'
  const authHeader = event.headers?.authorization || event.headers?.Authorization
  if (!authHeader?.startsWith('Bearer ')) {
    await reportAuthError(AUTH_MSG)
    return reply(401, { error: 'Not authenticated' })
  }
  let authUser = null
  try {
    authUser = await withTimeout(TIMEOUT.supabase, async (signal) => {
      const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        signal,
        headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${authHeader.slice(7)}` },
      })
      return r.ok ? r.json() : null
    })
  } catch (e) { console.warn('[district-events] auth check failed:', e.message) }
  if (!authUser?.id) {
    await reportAuthError(AUTH_MSG)
    return reply(401, { error: 'Invalid token' })
  }

  if (!body) {
    await reportError('The search request was garbled — refresh the page and try again.', STAGE_SEARCH)
    return reply(400, { error: 'Invalid JSON' })
  }
  if (!body.district_name || typeof body.district_name !== 'string') {
    await reportError('The search request was missing the area name — refresh the page and try again.', STAGE_SEARCH)
    return reply(400, { error: 'district_key, district_name required' })
  }

  // Earliest point we know WHO is asking for WHAT: tell the page we're alive.
  await reportStage(STAGE_SEARCH, 'running', null, { start: true })

  // Heartbeat: keep updated_at moving so the page never mistakes a long but
  // healthy run for a dead one. Only touches a row that is still 'running'.
  const heartbeat = setInterval(() => {
    sb(`district_events_progress?district_key=eq.${keyEnc}&status=eq.running`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ updated_at: new Date().toISOString() }),
    }).catch(e => console.warn('[district-events] heartbeat failed:', e.message))
  }, HEARTBEAT_MS)

  try {
    return await runSearch()
  } catch (err) {
    // A background invocation swallows thrown errors entirely — without this the
    // page would poll a status row that never leaves "running".
    console.error('[district-events] unhandled error:', err?.stack || err?.message || err)
    await reportError('Something went wrong while researching this area. Nothing was saved — try again.')
    return reply(500, { error: 'Event research failed' })
  } finally {
    clearInterval(heartbeat)
    console.log(`[district-events] ${district_key} finished in ${Math.round((Date.now() - runStartedMs) / 1000)} s`)
  }

  // ───────────────────────────────────────────────────────────────────────────
  async function runSearch() {
    const isAdmin = ADMIN_EMAILS.includes((authUser.email || '').toLowerCase())
    const force   = Boolean(body.force) && isAdmin
    const todayIso = centralTodayIso()

    // ── Re-run policy: only stale caches are re-researched (before the rate
    //    limiter, so a no-op never spends a user's budget) ──────────────────
    if (!force) {
      let row = null
      try {
        const cacheRes = await sb(`district_events?district_key=eq.${keyEnc}&select=events,fetched_at`)
        if (cacheRes.ok) row = (await cacheRes.json())?.[0] || null
        else console.warn('[district-events] cache read HTTP', cacheRes.status)
      } catch (e) { console.warn('[district-events] cache read failed:', e.message) }
      if (!isStaleCache(row, todayIso)) {
        await reportStage(STAGE_ENRICH, 'done', 'fresh')
        return reply(200, { cached: true, events: row.events, fetched_at: row.fetched_at })
      }
    }

    if (!ANTHROPIC_API_KEY || !PERPLEXITY_API_KEY) {
      console.error('[district-events] ANTHROPIC_API_KEY / PERPLEXITY_API_KEY missing')
      await reportError('Event search is not configured on the server right now — please let support know.')
      return reply(500, { error: 'Server not configured' })
    }

    // Audit fix (#18): this is the most expensive AI endpoint in the app (up to
    // 4 Perplexity + 3 Opus calls + 30 page fetches per run).
    const { enforceRateLimit } = require('./_rate-limit.js')
    const limited = await enforceRateLimit(authUser.id, 'research-district-events', headers)
    if (limited) {
      await reportError(rateLimitMessage(limited))
      return limited
    }

    // ── Inputs ─────────────────────────────────────────────────────────────
    const district_name    = String(body.district_name).slice(0, 120)
    const area_description = typeof body.area_description === 'string' ? body.area_description.slice(0, 600) : null
    const district_lean    = typeof body.district_lean === 'string' ? body.district_lean.slice(0, 40) : null
    let counties = (Array.isArray(body.counties) ? body.counties : [])
      .filter(c => typeof c === 'string' && c.trim())
      .slice(0, MAX_COUNTIES).map(c => c.trim().slice(0, 40))
    const keyCounty = countyFromKey(district_key)
    if (keyCounty && !counties.some(c => c.toLowerCase() === keyCounty.toLowerCase())) counties = [keyCounty, ...counties]
    const bodyPlaces = normalizePlaces(body.places)
    const places = bodyPlaces ?? parseAreaDescriptionPlaces(area_description)

    const area = promptArea(places, counties)
    if (!area) {
      await reportError('This area has no community list to search — refresh the page and try again.')
      return reply(400, { error: 'No places or counties for this area' })
    }
    const countyNames = countyPhrase(counties)
    const sourceBrief = countySourceBrief(counties)
    const searchTerms = (places.length ? places : counties).slice(0, 4)
    const inArea = buildAreaMatcher({ places, counties, districtKey: district_key })

    // District-size awareness drives how aggressively we sweep local government
    // meetings — exhaustive for a municipality/county, major-or-newsworthy only
    // for a legislative/congressional district.
    const { size: districtSize, label: districtSizeLabel } = classifyDistrictSize(district_key, district_name)
    const MEETINGS_RULE = meetingsDirective(districtSize, districtSizeLabel)

    // ── Provider helpers ───────────────────────────────────────────────────
    const callPerplexity = async ({ label, model, system, user, maxTokens, timeoutMs }) => {
      const data = await withTimeout(timeoutMs, async (signal) => {
        const r = await fetch('https://api.perplexity.ai/chat/completions', {
          method: 'POST', signal,
          headers: { Authorization: `Bearer ${PERPLEXITY_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_tokens: maxTokens }),
        })
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      console.log(`[district-events] perplexity ${label} (${model}): prompt_tokens=${data?.usage?.prompt_tokens ?? '?'} completion_tokens=${data?.usage?.completion_tokens ?? '?'}`)
      logAiUsage({ userId: authUser.id, endpoint: 'events', provider: 'perplexity', model, inputTokens: data?.usage?.prompt_tokens || 0, outputTokens: data?.usage?.completion_tokens || 0 })
      return data?.choices?.[0]?.message?.content || null
    }

    const callClaude = async ({ label, prompt, maxTokens, timeoutMs }) => {
      const data = await withTimeout(timeoutMs, async (signal) => {
        const r = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST', signal,
          headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
        })
        if (!r.ok) {
          const detail = await r.text().catch(() => '')
          throw new Error(`HTTP ${r.status} ${detail.slice(0, 200)}`)
        }
        return r.json()
      })
      const usage = data?.usage || {}
      console.log(`[district-events] anthropic ${label}: stop_reason=${data?.stop_reason} input_tokens=${usage.input_tokens ?? '?'} output_tokens=${usage.output_tokens ?? '?'} max_tokens=${maxTokens}`)
      if (data?.stop_reason === 'max_tokens') {
        console.warn(`[district-events] anthropic ${label}: OUTPUT TRUNCATED at max_tokens=${maxTokens} — salvaging complete objects`)
      }
      logAiUsage({ userId: authUser.id, endpoint: 'events', provider: 'anthropic', model: CLAUDE_MODEL, inputTokens: usage.input_tokens || 0, outputTokens: usage.output_tokens || 0 })
      return (data?.content || []).filter(b => b.type === 'text').map(b => b.text).join('')
    }

    const applyGuards = (list) => list
      .filter(e => e && typeof e === 'object' && e.name)
      .map(e => upcomingOrNull(e, todayIso))
      .filter(e => e && inArea(e))

    // ── Step 1: research — main web sweep, X and local news in parallel ────
    const mainSearch = callPerplexity({
      label: 'main', model: 'sonar-pro', maxTokens: 4000, timeoutMs: TIMEOUT.perplexityMain,
      system: 'You are a Wisconsin community events researcher helping a political campaign find public events where a candidate can meet voters. Your goal is VOLUME and COMPLETENESS: small events (church fish fries, service-club breakfasts, library talks, school fundraisers, board meetings) matter exactly as much as big festivals — never skip an event for being minor. Be specific about dates, times, venues, and organizers. Include well-known annual and recurring events (county fairs, farmers markets, festivals, parades) that fall in the window based on their usual schedule even if the current-year page is sparse — note when a date is approximate. Never invent one-off events. STRICT GEOGRAPHY: only report events physically held in the area you are given — never events elsewhere "in the region".',
      user: `Today is ${todayIso}. Find upcoming public events in the next 60 days held INSIDE this Wisconsin area (${district_name}): ${area}. An event counts ONLY if its venue is physically located in that area — exclude events outside it.

Run searches for EACH of the larger communities named (e.g. "<community> WI events calendar ${todayIso.slice(0, 4)}", "<community> community calendar"), and cover ALL of these event types:
- County fairs, 4-H and FFA events, dairy/farm breakfasts
- Farmers markets (weekly), craft fairs, flea markets
- Festivals, "fests", concerts and music-in-the-park series
- Parades and holiday celebrations
- Church festivals, picnics, fish fries and brat frys
- VFW and American Legion events; Lions, Rotary, Kiwanis, Optimist club events and pancake breakfasts
- Chamber of commerce events, ribbon cuttings, business expos
- Library programs and public talks
- School events open to the public (sports, plays, fundraisers, craft shows)
- Local government meetings — see the GOVERNMENT MEETINGS rule below
- County Republican and Democratic party meetings and events; candidate town halls
- Union and labor events
- Charity 5Ks, runs, walks and benefit dinners
- Car shows, tractor shows, gun and sportsmen's shows, fishing tournaments
- Brewery/winery events, trivia and community nights
- Senior center and community center events

${MEETINGS_RULE}

Aim for 25-40 events; if you find more, list more — do NOT stop at the big well-known ones. Include recurring weekly ones (one mention with its schedule and its NEXT date on or after ${todayIso}) and annual ones whose usual dates fall in the window — mark approximate dates. Never list an event that has already ended. ONLY include events open to the general public with no invitation, membership, or private registration required — skip private parties, members-only club events, and invite-only gatherings. For each: name, date(s), start time, venue with its STREET ADDRESS and city, organizer/host, a one-sentence description, and the event website URL if known.${sourceBrief ? ` Check these county-specific sources known to publish local events:\n${sourceBrief}` : ''}`,
    })
    // Stage 2 on the page means "web sweep done, news still going".
    const newsStageWrite = mainSearch.then(() => reportStage(STAGE_NEWS, 'running'), () => reportStage(STAGE_NEWS, 'running'))

    const xSearch = (async () => {
      if (!process.env.X_BEARER_TOKEN || !searchTerms.length) return null
      const q = `(${searchTerms.map(pl => `"${pl.replace(/"/g, '')}"`).join(' OR ')}) (event OR festival OR parade OR fair OR "farmers market" OR concert OR fundraiser OR "town hall" OR happening) -is:retweet lang:en`
      const xd = await withTimeout(TIMEOUT.xSearch, async (signal) => {
        const xr = await fetch(`https://api.x.com/2/tweets/search/recent?query=${encodeURIComponent(q)}&max_results=25&tweet.fields=created_at,author_id&expansions=author_id&user.fields=username,name`, {
          signal, headers: { Authorization: `Bearer ${process.env.X_BEARER_TOKEN}` },
        })
        if (!xr.ok) throw new Error(`HTTP ${xr.status}`)
        return xr.json()
      })
      const users = Object.fromEntries((xd.includes?.users || []).map(u => [u.id, u]))
      const rows = (xd.data || []).map(t => {
        const u = users[t.author_id] || {}
        return `@${u.username || 'unknown'} (${u.name || ''}) on ${String(t.created_at).slice(0, 10)}: ${String(t.text || '').replace(/\s+/g, ' ').slice(0, 260)}`
      })
      return rows.length ? rows.join('\n') : null
    })()

    const newsSearch = callPerplexity({
      label: 'news', model: 'sonar', maxTokens: 2500, timeoutMs: TIMEOUT.perplexityNews,
      system: 'You research LOCAL NEWS coverage of upcoming community events in Wisconsin. Prefer local TV stations, local newspapers, and city/chamber announcement pages. Name the outlet for every item. Small announcements (club breakfasts, church suppers, library programs, board meetings) are just as important as big-festival coverage. Only report events held inside the area given.',
      user: `Today is ${todayIso}. Check local news outlets and their community/event calendars covering ${area}, Wisconsin.${sourceBrief ? ` Prioritize these county-specific sources:\n${sourceBrief}` : ' Check local TV, local papers and city weeklies, chamber and city hall announcements.'}\nWhat upcoming public events in the next 60 days have they announced or covered? Include small items too — community briefs, club and church announcements, meeting notices — not just headline events. ONLY include events whose venue is inside that area.

${MEETINGS_RULE}
 For each: event name, date, time, venue with street address, city, host, one-sentence description, the OUTLET that reported it, and the article/calendar URL if available. List as many as you find (15+ is great).`,
    })

    const [mainR, xR, newsR] = await Promise.allSettled([mainSearch, xSearch, newsSearch])
    await newsStageWrite   // keep progress writes ordered (stage 2 before 3)
    if (mainR.status === 'rejected') console.warn('[district-events] Perplexity main search failed:', mainR.reason?.message)
    if (xR.status === 'rejected')    console.warn('[district-events] X search skipped:', xR.reason?.message)
    if (newsR.status === 'rejected') console.warn('[district-events] news pass skipped:', newsR.reason?.message)
    const research     = mainR.status === 'fulfilled' ? mainR.value : null
    const xPosts       = xR.status === 'fulfilled' ? xR.value : null
    const newsResearch = newsR.status === 'fulfilled' ? newsR.value : null

    if (!research && !newsResearch) {
      // Research source unavailable (e.g. Perplexity credits exhausted). Never
      // write an empty cache row (audit fix #18) — just fail; the next request
      // retries research.
      await reportError('The event research service did not respond. Nothing was saved — try again in a few minutes.', STAGE_SEARCH)
      return reply(502, { error: 'Event research unavailable' })
    }

    // ── Step 2: Claude structures + classifies lean ─────────────────────────
    await reportStage(STAGE_STRUCTURE, 'running')
    const boundaryRule = `DISTRICT BOUNDARY RULE (strict): this list is for ${district_name} ONLY. The area covers: ${area}. Include an event ONLY if its venue is inside that area${places.length > PROMPT_PLACES ? ` (any municipality in ${countyNames || 'its counties'} that may belong to it is fine — an exact municipal-list filter runs afterwards)` : ''}. The single exception: county fairs and county-wide signature events of ${countyNames || "the area's counties"} may be included even if their venue city is not named. EXCLUDE everything clearly outside — an event in a town outside the area must be dropped no matter how close or how big it is. When research says an event is "near" or "in the area of" a community without naming an in-area city, drop it.`
    let structuredText
    try {
      structuredText = await callClaude({
        label: 'structure', maxTokens: 16000, timeoutMs: TIMEOUT.anthropicStructure,
        prompt: `Today is ${todayIso} (America/Chicago). Convert this event research for ${district_name}, Wisconsin into strict JSON. The district's overall voter lean is ${district_lean || 'unknown'}.

Schema — an array "events":
{
  "events": [
    {
      "name": "Event Name",
      "date_start": "2026-07-17",
      "date_end": "2026-07-20" or null,
      "time": "9:00 AM" or null,
      "recurrence": "weekly" | "biweekly" | "monthly" | null,
      "venue": "Venue name",
      "address": "street address (e.g. 1582 Kronenwetter Dr) or null",
      "city": "City",
      "host": "Organizer" or null,
      "description": "One sentence describing the event and why a campaign would attend.",
      "category": "fair" | "market" | "festival" | "parade" | "civic" | "party" | "labor" | "church" | "other",
      "url": "https://..." or null,
      "source": "web" | "news" | "x",
      "source_note": "attribution, e.g. 'Wausau Pilot & Review' or '@WausauChamber on X'" or null,
      "lean": {
        "label": "confirmed_conservative" | "likely_conservative" | "nonpartisan" | "likely_liberal" | "confirmed_liberal",
        "certainty": 0-100,
        "score": -100 to 100,
        "basis": "short reason (host, event type, area lean)"
      }
    }
  ]
}
Dates are ISO YYYY-MM-DD. Drop any event that ends before ${todayIso}. Recurring events get ONE entry whose date_start is the NEXT occurrence on or after ${todayIso} (set "recurrence"; for a seasonal series set date_end to the season's last date).
Lean rules — use this SIGNAL HIERARCHY (strongest evidence wins; cite the tier you used in "basis"):
- TIER 1 (registered partisan entity → "confirmed_*", certainty 100): the host is a party organization (county/state Republican or Democratic party, party caucus, Young/College partisan clubs), a candidate committee, or the event is a partisan candidate's own campaign event. These orgs are registered with the FEC or the Wisconsin Ethics Commission's campaign-finance system.
- TIER 2 (documented partisan alignment → "likely_*", certainty 80-99): labor unions and labor federations (AFSCME, SEIU, WEAC, AFL-CIO, trades councils → likely_liberal — union event infrastructure like Mobilize/ActBlue is Democratic-side); ideological advocacy organizations with a known side (Americans for Prosperity, Moms for Liberty, Right to Life → likely_conservative; Indivisible, Citizen Action, Planned Parenthood advocacy, conservation voter groups → likely_liberal). If the host lobbies Wisconsin government, weigh its known issue positions.
- TIER 3 (no org-level signal → "nonpartisan", certainty below 80): fairs, farmers markets, chambers of commerce, service clubs (Lions/Rotary/Kiwanis/Optimist), VFW/Legion, churches, libraries, schools, government meetings. The League of Women Voters is legally NONPARTISAN — never mark it partisan. For Tier 3, set "score" to the AREA's voter-lean context (who will be in the crowd), not the event itself.
- "score": negative = liberal, positive = conservative, drives a marker on a lean bar. Calibrate: confirmed ±85-100, likely ±55-80, nonpartisan-in-leaning-area ±10-45, truly neutral 0.
- "basis" must name the signal used, e.g. "T1: county party host", "T2: union host (AFSCME)", "T3: civic host, R+8 area crowd". Never guess a partisan label from the event NAME alone (a "Freedom Fest" is not conservative without a partisan host).
${boundaryRule}
Include EVERY in-area event from the research that is public and has a usable date in the next ~60 days — do not drop events merely because a date is approximate (keep them, using the best-estimate date), and NEVER drop an event for being small or routine (club breakfasts, fish fries, library talks, board meetings are as valuable to a campaign as festivals). There is no maximum — 25-40+ events is the expected output when the research supports it. Keep each description to one short sentence so the whole list fits.
${MEETINGS_RULE}
PUBLIC-ONLY RULE: include only events open to the general public. EXCLUDE anything private, invite-only, members-only, or requiring approval to attend (private fundraisers with invitation lists, closed club meetings, school-family-only events). Free-and-open government meetings, fairs, markets, festivals, and ticketed-but-open events all count as public. Output ONLY the JSON object — no preamble, no code fences.

Merge events found across ALL sources below and dedupe by name, keeping the fullest details for each event. SOURCE LABELING (strict): if an event appears in LOCAL NEWS RESEARCH, set source="news" and source_note to the outlet name (e.g. "Wausau Pilot & Review") — even if it also appears in web research. If an event appears only in the X posts, set source="x" and source_note to the handle (e.g. "@WausauChamber on X"). Otherwise source="web" with source_note null. Events found ONLY on X must clearly be real public events with a date — skip vague chatter, national politics, and anything that is not a local event announcement.

WEB RESEARCH:
${research || '(none available)'}

LOCAL NEWS RESEARCH:
${newsResearch || '(none available)'}

RECENT X (TWITTER) POSTS FROM THE AREA:
${xPosts || '(none available)'}`,
      })
    } catch (e) {
      console.warn('[district-events] structuring call failed:', e.message)
      await reportError('Events were found but could not be organised. Nothing was saved — try again.')
      return reply(502, { error: 'Event structuring failed' })
    }

    const parsed = parseModelJson(structuredText)
    if (!parsed) {
      console.warn('[district-events] unparseable structuring output:', String(structuredText).slice(0, 300))
      await reportError('The event list came back unreadable. Nothing was saved — try again.')
      return reply(502, { error: 'Could not parse event output' })
    }
    if (parsed.salvaged) console.warn('[district-events] structuring output was not valid JSON — salvaged complete event objects')
    const rawEvents = listFromParsed(parsed, 'events')
    let events = applyGuards(rawEvents)
    console.log(`[district-events] ${district_key}: ${rawEvents.length} structured → ${events.length} after date/area guards`)

    // ── Optional: thin result → one supplemental research pass ──────────────
    if (events.length < 14 && timeLeft() > TIMEOUT.perplexityExtra + TIMEOUT.anthropicSmall) {
      try {
        const extra = await callPerplexity({
          label: 'extra', model: 'sonar-pro', maxTokens: 2500, timeoutMs: TIMEOUT.perplexityExtra,
          system: 'You are a Wisconsin community events researcher. Only public events. Include street addresses. Small events (fish fries, club breakfasts, library programs, board meetings) count as much as big ones. Only report events physically held inside the area given.',
          user: `Today is ${todayIso}. List public community events in the next 60 days held INSIDE this Wisconsin area and ONLY this area: ${area}. Cover the small stuff too: church fish fries and picnics, VFW/American Legion and Lions/Rotary/Kiwanis events, library programs, school events open to the public, county party (GOP/Dem) meetings, charity runs and benefit dinners, car/tractor/sportsmen shows, senior center events — plus fairs, markets, festivals, parades, concerts.

${MEETINGS_RULE}

Skip events already in this list: ${events.map(e => e.name).join('; ') || 'none'}. Find as many NEW ones as you can (15+). For each: name, date, time, venue with street address, city, host, one-sentence description, URL if known.`,
        })
        if (extra && timeLeft() > TIMEOUT.anthropicSmall) {
          const text2 = await callClaude({
            label: 'extra-structure', maxTokens: 6000, timeoutMs: TIMEOUT.anthropicSmall,
            prompt: `Today is ${todayIso}. Convert to the same strict JSON schema {"events":[...]} used before (name, date_start, date_end, time, recurrence, venue, address, city, host, description, category, url, lean{label,certainty,score,basis}). Public events only, next 60 days, nothing that ends before ${todayIso}; recurring events use their next occurrence. District lean ${district_lean || 'unknown'}. ${boundaryRule} Include every qualifying event no matter how small. Output ONLY JSON.

RESEARCH:
${extra}`,
          })
          const more = applyGuards(listFromParsed(parseModelJson(text2), 'events'))
          const seen = new Set(events.map(e => String(e.name).toLowerCase()))
          for (const e of more) {
            const k = String(e.name).toLowerCase()
            if (!seen.has(k)) { events.push(e); seen.add(k) }
          }
        }
      } catch (e) { console.warn('[district-events] supplemental pass skipped:', e.message) }
    } else if (events.length < 14) {
      console.warn('[district-events] supplemental pass skipped: past run deadline')
    }

    await reportStage(STAGE_ENRICH, 'running')

    // ── Lean hardening pass 1: deterministic partisan-signal lexicon ─────────
    // The curated Wisconsin org lexicon (_partisan-signals.js) overrides the
    // LLM's lean whenever the HOST matches a known partisan (or legally
    // nonpartisan) organization. Deterministic > generative for known entities.
    for (const e of events) {
      const sig = matchPartisanSignals(e.host) || matchPartisanSignals(e.name)
      if (!sig) continue
      if (sig.tier === 3) {
        if (e.lean?.label !== 'nonpartisan') {
          e.lean = { label: 'nonpartisan', certainty: sig.certainty, score: e.lean?.score ?? 0, basis: `T3: known nonpartisan civic org` }
        }
      } else if (e.lean?.label !== sig.label || (e.lean?.certainty ?? 0) < sig.certainty) {
        e.lean = { label: sig.label, certainty: sig.certainty, score: sig.score, basis: `T${sig.tier}: known partisan org match (${e.host || e.name})` }
      }
    }

    // ── Lean hardening pass 2 (optional): registry verification ─────────────
    // Hosts the lexicon doesn't know and the LLM wasn't sure about get one
    // batched Perplexity check against Wisconsin's campaign-finance registry,
    // Mobilize, ActBlue and Eye on Lobbying.
    const uncertain = events.filter(e =>
      e.host &&
      !matchPartisanSignals(e.host) &&
      ['party', 'labor', 'civic', 'other'].includes(e.category) &&
      (e.lean?.certainty ?? 0) < 90
    ).slice(0, 15)
    if (uncertain.length && timeLeft() > TIMEOUT.perplexityVerify + TIMEOUT.anthropicSmall) {
      try {
        const hostList = [...new Set(uncertain.map(e => e.host))]
        const verification = await callPerplexity({
          label: 'verify', model: 'sonar', maxTokens: 1500, timeoutMs: TIMEOUT.perplexityVerify,
          system: 'You verify the political affiliation of Wisconsin organizations using public records. For each organization, check: (1) is it a registered campaign-finance committee or conduit in Wisconsin (campaignfinance.wi.gov registrant search) or with the FEC; (2) does it appear on Mobilize (mobilize.us — Democratic/progressive event platform) or in ActBlue’s public directory (Democratic-side fundraising); (3) does it use WinRed (Republican-side fundraising); (4) is it a registered Wisconsin lobbying principal (lobbying.wi.gov) and what issues does it lobby on; (5) do news reports document endorsements of or by partisan candidates. Answer strictly from evidence; say "no partisan signal found" when that is the truth.',
          user: `For each of these organizations that host community events in ${countyNames || district_name}, Wisconsin, report any partisan affiliation evidence and its source, one line each. Organizations:\n${hostList.map((h, i) => `${i + 1}. ${h}`).join('\n')}`,
        })
        if (verification && timeLeft() > TIMEOUT.anthropicSmall) {
          const text3 = await callClaude({
            label: 'verify-structure', maxTokens: 2000, timeoutMs: TIMEOUT.anthropicSmall,
            prompt: `Based on this verification research about Wisconsin organizations, output STRICT JSON {"hosts":[{"host": "<exact name from list>", "label": "confirmed_conservative"|"likely_conservative"|"nonpartisan"|"likely_liberal"|"confirmed_liberal", "certainty": 0-100, "score": -100 to 100, "basis": "signal + source, e.g. 'registered WI committee' or 'on Mobilize/ActBlue' or 'no partisan signal in registries'"}]}. Rules: registered party/candidate committee = confirmed (certainty 100); Mobilize/ActBlue presence = likely_liberal (85-95); WinRed presence = likely_conservative (85-95); lobbying registration alone is NOT partisan — use its documented issue positions; explicit "no partisan signal found" = nonpartisan with certainty 75. Only include hosts where the research supports a judgment. Output ONLY JSON.\n\nHOSTS:\n${hostList.join('\n')}\n\nVERIFICATION RESEARCH:\n${verification}`,
          })
          const verdicts = listFromParsed(parseModelJson(text3), 'hosts')
          const vMap = new Map(verdicts.filter(v => v?.host).map(v => [String(v.host).toLowerCase(), v]))
          for (const e of events) {
            const v = e.host && vMap.get(String(e.host).toLowerCase())
            if (v && (v.certainty ?? 0) > (e.lean?.certainty ?? 0)) {
              e.lean = { label: v.label, certainty: v.certainty, score: v.score, basis: `Registry check: ${v.basis}` }
            }
          }
          console.log(`[district-events] registry verification updated ${verdicts.length}/${hostList.length} hosts`)
        }
      } catch (e) { console.warn('[district-events] registry verification skipped:', e.message) }
    } else if (uncertain.length) {
      console.warn('[district-events] registry verification skipped: past run deadline')
    }

    // ── Image + detail enrichment (optional) ───────────────────────────────
    // JSON-LD Event > og:image > twitter:image. Never overwrites existing values.
    if (timeLeft() > TIMEOUT.pageFetch * 2) {
      const withUrls = events.filter(e => typeof e.url === 'string' && /^https?:\/\//i.test(e.url)).slice(0, 30)
      await Promise.allSettled(withUrls.map(async (e) => {
        try {
          await withTimeout(TIMEOUT.pageFetch, async (signal) => {
            const res = await fetch(e.url, {
              signal, redirect: 'follow',
              headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BadgerBoard/1.0; +https://badgerboardwi.com)' },
            })
            if (!res.ok || !/text\/html/i.test(res.headers.get('content-type') || '')) return
            const html = (await res.text()).slice(0, 250000)
            const meta = extractEventMeta(html, res.url || e.url)
            if (meta.date_start && !e.date_start) e.date_start = meta.date_start
            if (meta.date_end   && !e.date_end)   e.date_end   = meta.date_end
            if (meta.time       && !e.time)       e.time       = meta.time
            if (meta.venue      && !e.venue)      e.venue      = meta.venue
            if (meta.address    && !e.address)    e.address    = meta.address
            if (meta.image) e.image = meta.image
          })
        } catch { /* no image — card uses category visual */ }
      }))
    } else {
      console.warn('[district-events] page enrichment skipped: past run deadline')
    }

    // Final guard (enrichment may have filled a date_end).
    events = applyGuards(events)

    if (!events.length) {
      // Nothing usable came back. Never stamp an empty cache row (audit fix
      // #18) and never overwrite a previous good result — just tell the page.
      await reportError('No public events could be confirmed for this area right now — try again later.')
      return reply(200, { cached: false, events: [], fetched_at: null })
    }

    const fetched_at = new Date().toISOString()
    const saveRes = await sb('district_events', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ district_key, name: district_name, events, fetched_at, updated_at: fetched_at }),
    })
    if (!saveRes.ok) {
      const detail = await saveRes.text().catch(() => '')
      console.error('[district-events] cache write failed:', saveRes.status, detail.slice(0, 300))
      await reportError('The events were found but could not be saved. Try again.')
      return reply(502, { error: 'Could not save events' })
    }

    await reportStage(STAGE_ENRICH, 'done')
    return reply(200, { cached: false, events, fetched_at })
  }
}

module.exports = {
  handler,
  // pure helpers (tests)
  DISTRICT_KEY_RE,
  DEFAULT_CLAUDE_MODEL,
  STALE_AFTER_DAYS,
  centralTodayIso,
  isoDateOrNull,
  isUpcomingEvent,
  isStaleCache,
  upcomingOrNull,
  normalizePlaces,
  parseAreaDescriptionPlaces,
  countyFromKey,
  promptArea,
  buildAreaMatcher,
  parseModelJson,
  salvageArrayObjects,
  listFromParsed,
  rateLimitMessage,
  sniffDistrictKey,
  classifyDistrictSize,
  meetingsDirective,
  extractEventMeta,
}
