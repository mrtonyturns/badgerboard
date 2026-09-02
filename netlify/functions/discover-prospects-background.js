// Netlify Background Function: discover-prospects-background
// ─── Prospecting v3 — AI DISCOVERY (find the field → brief → export) ─────────
//
// The v2 Discover tab only filtered candidates the user had already entered.
// An agency, PAC or NGO opening Prospecting cold saw zero candidates and a dead
// end. This function is the new front door: given a county, an office level, or
// a specific race, it web-searches for EVERY candidate it can find and writes
// each one as a prospect_profiles row — siloed from the Candidates table
// (candidate_id = null) until the user presses "Add to My Candidates".
//
// ── WHY PERPLEXITY, NOT discover-candidates.js ──────────────────────────────
// The older discover-candidates function asks Claude from training knowledge
// only. For a 2026 race that means stale or invented names. sonar-pro runs a
// live web search and returns citations, so every name here comes from a
// current public page (filings, ballot listings, news, campaign sites).
//
// ── BACKGROUND FUNCTION CONTRACT ─────────────────────────────────────────────
// Netlify answers 202 before this runs; every statusCode below is discarded.
// The durable output is:
//   prospecting_enrichment_progress — one row per run_id (reused from v2 so the
//                                     page polls discovery exactly like enrichment)
//   prospect_profiles               — the discovered rows (discovery_source: 'ai_discovery')
//
// ── COMPLIANCE ───────────────────────────────────────────────────────────────
// Same boundary as enrich-prospects-background.js: no CFIS / WEC campaign-
// finance data is used as a source. Candidate lists come from ballot access
// pages, county clerk notices, news and campaign sites.

const { enforceRateLimit } = require('./_rate-limit')
const { logAiUsage } = require('./_ai-usage')
const { ADMIN_EMAILS } = require('./_config')
const { sanitize, normalizeUrl } = require('./enrich-prospects-background')

const SUPABASE_URL         = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const PERPLEXITY_API_KEY   = process.env.PERPLEXITY_API_KEY

const PPLX_MODEL           = 'sonar-pro'
const PPLX_TIMEOUT_MS      = 60 * 1000
const MAX_DISCOVERED       = 50            // hard cap of rows written per run
const ALLOWED_MODES        = ['county', 'level', 'race']
const ALLOWED_LEVELS       = ['federal', 'state', 'county', 'municipal', 'school']
const ALLOWED_PARTIES      = ['Republican', 'Democrat', 'Independent', 'Nonpartisan', 'Other']

// Progress stages — the page maps these to labels. Discovery has two.
const STAGE_SEARCH = 1
const STAGE_SAVE   = 4   // same terminal stage number as enrichment so the UI's "done" logic is shared

// ─────────────────────────────────────────────────────────────────────────────
// PURE HELPERS (exported for tests)
// ─────────────────────────────────────────────────────────────────────────────

/** Normalize a party string from the model into our DB vocabulary. */
function normalizeParty(raw) {
  const s = sanitize(raw, 40).toLowerCase()
  if (!s) return null
  if (/^(rep|gop|r$)/.test(s) || /republican/.test(s)) return 'Republican'
  if (/^(dem|d$)/.test(s) || /democrat/.test(s)) return 'Democrat'
  if (/independent|^ind/.test(s)) return 'Independent'
  if (/nonpartisan|non-partisan|^np$/.test(s)) return 'Nonpartisan'
  if (/libertarian|green|constitution|other|write-in/.test(s)) return 'Other'
  return null
}

/** Normalize a level string into our DB vocabulary. */
function normalizeLevel(raw) {
  const s = sanitize(raw, 30).toLowerCase()
  if (/federal|congress|u\.?s\.? (house|senate)/.test(s)) return 'federal'
  if (/state|assembly|senate|governor|attorney|treasurer|secretary/.test(s)) return 'state'
  if (/school/.test(s)) return 'school'
  if (/county|sheriff|clerk|district attorney|register of deeds|treasurer|surveyor|coroner/.test(s)) return 'county'
  if (/municipal|city|village|town|mayor|alder|council|trustee|supervisor/.test(s)) return 'municipal'
  return ALLOWED_LEVELS.includes(s) ? s : null
}

/**
 * Parse the model's JSON array out of a response that may be wrapped in
 * markdown fences or prose. Returns [] on any failure — never throws.
 */
function parseCandidateJson(text) {
  if (!text) return []
  let s = String(text).trim()
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) s = fence[1].trim()
  // Find the ARRAY OF OBJECTS — a bare indexOf('[') would land on a Perplexity
  // citation marker like "[1]" in any prose the model put before the JSON.
  const m = s.match(/\[\s*\{/)
  if (!m) return []
  const start = m.index
  const end = s.lastIndexOf(']')
  if (end > start) {
    try {
      const arr = JSON.parse(s.slice(start, end + 1))
      if (Array.isArray(arr)) return arr
    } catch { /* fall through to salvage */ }
  }
  // Salvage: a truncated array (max_tokens) or a stray "]" from a citation
  // marker breaks JSON.parse — recover every COMPLETE object from `start` on.
  const objs = []
  const re = /\{[^{}]*\}/g
  const rest = s.slice(start)
  let hit
  while ((hit = re.exec(rest))) {
    try { objs.push(JSON.parse(hit[0])) } catch { /* skip malformed object */ }
  }
  return objs
}

/**
 * Resolve a source reference to a URL. Perplexity returns its sources as a
 * separate `citations` array and refers to them inline as [1], [2]… — so the
 * model often fills source_url with "[3]" or "3" instead of the URL. Map those
 * through the citations list; otherwise normalize as a URL.
 */
function resolveSource(raw, citations = []) {
  if (raw == null) return null
  const s = String(raw).trim()
  const idx = s.match(/^\[?\s*(\d{1,2})\s*\]?$/)
  if (idx) return normalizeUrl(citations[parseInt(idx[1], 10) - 1]) || null
  return normalizeUrl(s)
}

/** Strip inline citation markers the model glues onto values: "Jane Doe [1][2]". */
function stripMarkers(v) {
  return sanitize(v, 200).replace(/\s*\[\d{1,2}\]/g, '').trim()
}

/** Case/space-insensitive key for de-duplication: "name|office". */
function dedupeKey(name, office) {
  const n = sanitize(name, 150).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  const o = sanitize(office, 150).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  return `${n}|${o}`
}

/**
 * Turn raw model entries into clean prospect rows. Drops entries with no name
 * or no source URL (an uncited name is a guess, not a discovery), de-dupes,
 * and caps at MAX_DISCOVERED.
 */
function buildProspectRows(entries, { userId, query, citations = [] }) {
  const seen = new Set()
  const out = []
  for (const e of entries || []) {
    if (!e || typeof e !== 'object') continue
    const name = stripMarkers(e.name)
    const source = resolveSource(e.source_url ?? e.source ?? e.url, citations)
    if (!name || name.split(/\s+/).length < 2) continue    // need at least first + last
    if (!source) continue                                   // uncited → dropped
    const office = stripMarkers(e.office) || query.officeName || null
    const key = dedupeKey(name, office)
    if (seen.has(key)) continue
    seen.add(key)

    const party = normalizeParty(e.party)
    const level = normalizeLevel(e.level) || normalizeLevel(office) || query.level || null
    const confidence = /^(high|medium|low)$/i.test(String(e.confidence || '')) ? String(e.confidence).toLowerCase() : 'medium'

    out.push({
      created_by: userId,
      candidate_id: null,                       // siloed until "Add to My Candidates"
      name,
      office_name: office,
      district_name: stripMarkers(e.district).slice(0, 100) || query.districtName || null,
      county: stripMarkers(e.county).slice(0, 60).replace(/\s+county$/i, '') || query.county || null,
      level,
      election_date: /^\d{4}-\d{2}-\d{2}$/.test(String(e.election_date || '')) ? e.election_date : null,
      party,
      affiliation: party,
      affiliation_detail: party
        ? { inferred: false, confidence: confidence === 'high' ? 85 : confidence === 'medium' ? 65 : 45, basis: 'Reported by a cited public page during AI discovery', source: 'ai_discovery' }
        : { inferred: false, confidence: 0, basis: 'No party stated on the discovering page', source: null },
      website_url: normalizeUrl(e.website) || null,
      has_website: null,                        // brief enrichment verifies
      research_citations: [{ label: 'DISCOVERY', url: source }],
      discovery_source: 'ai_discovery',
      // No dedicated columns for discovery metadata (v2 schema, no migration):
      // it rides in win_odds_factors.discovery and brief enrichment preserves it.
      win_odds_factors: {
        discovery: {
          query,
          confidence,
          status: sanitize(e.status, 40) || null,
          note: sanitize(e.notes, 200) || null,
          source_url: source,
        },
      },
      discovered_at: new Date().toISOString(),
      enrichment_status: 'pending',
    })
    if (out.length >= MAX_DISCOVERED) break
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt
// ─────────────────────────────────────────────────────────────────────────────

const DISCOVERY_SYSTEM = [
  'You are a Wisconsin election research assistant working for a political marketing agency that is building a list of candidates to contact.',
  'Your job is to FIND EVERY candidate currently running (declared, filed, or on the ballot) that matches the query, using live web search.',
  'Use ballot access lists, county and municipal clerk notices, Wisconsin Elections Commission candidate lists, Ballotpedia, local news, and campaign websites.',
  'COMPLIANCE: do NOT use Wisconsin campaign-finance filings (CFIS, campaignfinance.wi.gov, WEC finance reports) as a source. Candidate LISTS from the WEC are fine; finance reports are not.',
  'Every candidate MUST have a source_url pointing to the actual page that names them as a candidate — write the FULL https URL in the JSON, not a citation number. If you cannot cite a page, do not include the person.',
  'Do not invent names. Do not include people who lost a primary or withdrew unless the query asks for them. Do not include incumbents who are not running.',
  'Return ONLY a JSON array. No markdown fences, no prose before or after.',
].join(' ')

function discoveryPrompt(q) {
  let scope
  if (q.mode === 'county') {
    scope = `All candidates running for ANY office in ${q.county} County, Wisconsin in the ${q.electionYear} election cycle — county board, sheriff, clerk, district attorney, treasurer, register of deeds, plus municipal (mayor, city council, village and town boards) and school board seats within the county, plus state Assembly and Senate districts covering the county.`
  } else if (q.mode === 'level') {
    scope = `All ${q.level}-level candidates running in Wisconsin in the ${q.electionYear} election cycle${q.county ? `, limited to ${q.county} County` : ''}.`
  } else {
    scope = `All candidates running for ${q.officeName}${q.districtName ? ` (${q.districtName})` : ''}${q.county ? ` in ${q.county} County` : ''}, Wisconsin in the ${q.electionYear} election cycle.`
  }
  return `${scope}

Find as many as you can — aim for the complete field, up to ${MAX_DISCOVERED} candidates. For each, return one object:
{
  "name": "First Last",
  "office": "Full office name as it appears on the ballot",
  "district": "District name/number or null",
  "county": "County name or null",
  "level": "federal|state|county|municipal|school",
  "party": "Republican|Democrat|Independent|Nonpartisan|Other|null",
  "status": "declared|filed|on_ballot|incumbent_running",
  "election_date": "YYYY-MM-DD or null",
  "website": "campaign website URL or null",
  "source_url": "the page that names this person as a candidate (REQUIRED)",
  "confidence": "high|medium|low"
}

Return the JSON array only.`
}

async function runPerplexity(prompt, userId) {
  if (!PERPLEXITY_API_KEY) return { text: null, citations: [], error: 'PERPLEXITY_API_KEY is not set' }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), PPLX_TIMEOUT_MS)
  try {
    const res = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      signal: ctrl.signal,
      headers: { Authorization: `Bearer ${PERPLEXITY_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: PPLX_MODEL,
        temperature: 0,
        max_tokens: 6000,
        messages: [
          { role: 'system', content: DISCOVERY_SYSTEM },
          { role: 'user', content: prompt },
        ],
      }),
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      return { text: null, citations: [], error: `Perplexity ${res.status}${detail ? `: ${detail.slice(0, 160)}` : ''}` }
    }
    const d = await res.json()
    logAiUsage({
      userId, endpoint: 'prospecting', provider: 'perplexity', model: PPLX_MODEL,
      inputTokens: d?.usage?.prompt_tokens || 0, outputTokens: d?.usage?.completion_tokens || 0,
    })
    const citations = Array.isArray(d?.citations) ? d.citations.map(c => (typeof c === 'string' ? c : c?.url)).filter(Boolean) : []
    return { text: d?.choices?.[0]?.message?.content || null, citations, error: null }
  } catch (e) {
    return { text: null, citations: [], error: e.name === 'AbortError' ? 'Discovery search timed out' : `Discovery search failed: ${e.message}` }
  } finally {
    clearTimeout(timer)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// I/O helpers (same shape as enrich-prospects-background.js)
// ─────────────────────────────────────────────────────────────────────────────

function sbFetch(path, opts = {}) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  })
}

async function verifyUser(authHeader) {
  if (!authHeader || typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) return null
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return null
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: authHeader },
    })
    if (!res.ok) return null
    const user = await res.json()
    return user?.id ? user : null
  } catch { return null }
}

// ─────────────────────────────────────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  }
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) }
  }

  let body
  try { body = JSON.parse(event.body || '{}') } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }
  }

  const runId = sanitize(body.run_id, 64)
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  if (!UUID_RE.test(runId)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'A valid run_id (uuid) is required' }) }
  }

  const state = { stage: STAGE_SEARCH, total: 0, completed: 0, failed: 0, current: null, userId: null }
  const reportProgress = async (stage, status = 'running', message = null) => {
    if (!state.userId) return
    state.stage = stage
    try {
      await sbFetch('prospecting_enrichment_progress', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({
          run_id: runId,
          created_by: state.userId,
          stage,
          status,
          message: message ? sanitize(message, 400) : null,
          total: state.total,
          completed: state.completed,
          failed: state.failed,
          current_name: state.current ? sanitize(state.current, 150) : null,
          updated_at: new Date().toISOString(),
        }),
      })
    } catch (e) { console.warn('[discover] progress write failed:', e.message) }
  }
  const fail = async (statusCode, message, stage = state.stage) => {
    await reportProgress(stage, 'error', message)
    return { statusCode, headers, body: JSON.stringify({ error: message }) }
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Supabase service credentials are not configured.' }) }
  }

  // ── Auth ──────────────────────────────────────────────────────────────────
  const authHeader = event.headers?.authorization || event.headers?.Authorization
    || (typeof body.auth_header === 'string' ? body.auth_header : null)
  const user = await verifyUser(authHeader)
  if (!user) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Not authenticated' }) }
  state.userId = user.id

  // ── Entitlement — same 'prospecting' feature as enrichment ────────────────
  const isAdmin = ADMIN_EMAILS.includes((user.email || '').toLowerCase())
  if (!isAdmin) {
    try {
      const { PLAN_CONFIG } = require('../../src/lib/tiers.js')
      const PROSPECTING_PLANS = Object.keys(PLAN_CONFIG).filter(k => PLAN_CONFIG[k]?.features?.prospecting)
      const { resolveEntitlement } = require('./_entitlements')
      const { plan } = await resolveEntitlement(user)
      if (!PROSPECTING_PLANS.includes(plan)) {
        return fail(403, 'AI candidate discovery is included with Action plans. Upgrade to unlock it.')
      }
    } catch (e) {
      console.error('[discover] entitlement check failed:', e.message)
      return fail(503, 'Could not verify your plan — please try again in a moment.')
    }
  }

  const limited = await enforceRateLimit(user.id, 'discover-prospects', headers)
  if (limited) {
    await reportProgress(STAGE_SEARCH, 'error', 'You have run a lot of discoveries recently — give it a few minutes and try again.')
    return limited
  }

  // ── Validate the query ────────────────────────────────────────────────────
  const mode = sanitize(body.mode, 20).toLowerCase()
  if (!ALLOWED_MODES.includes(mode)) return fail(400, `Invalid mode. Must be one of: ${ALLOWED_MODES.join(', ')}`)
  const yearNum = parseInt(sanitize(body.electionYear, 4), 10)
  const thisYear = new Date().getFullYear()
  const electionYear = Number.isFinite(yearNum) && yearNum >= thisYear - 1 && yearNum <= thisYear + 2 ? yearNum : thisYear
  const query = {
    mode,
    electionYear,
    county: sanitize(body.county, 60).replace(/\s+county$/i, '') || null,
    level: ALLOWED_LEVELS.includes(sanitize(body.level, 20).toLowerCase()) ? sanitize(body.level, 20).toLowerCase() : null,
    officeName: sanitize(body.officeName, 150) || null,
    districtName: sanitize(body.districtName, 100) || null,
  }
  if (mode === 'county' && !query.county) return fail(400, 'Pick a county to search.')
  if (mode === 'level' && !query.level) return fail(400, 'Pick an office level to search.')
  if (mode === 'race' && !query.officeName) return fail(400, 'Enter the office to search.')

  state.current = mode === 'county' ? `${query.county} County` : mode === 'level' ? `${query.level} races` : query.officeName
  await reportProgress(STAGE_SEARCH, 'running')

  try {
    // ── 1. Live web search ───────────────────────────────────────────────────
    const research = await runPerplexity(discoveryPrompt(query), user.id)
    if (research.error) return fail(502, research.error, STAGE_SEARCH)
    const entries = parseCandidateJson(research.text)
    const rows = buildProspectRows(entries, { userId: user.id, query, citations: research.citations })
    if (!rows.length) {
      // Say WHICH gate emptied the result — otherwise "nothing found" hides a
      // parser problem behind a search problem.
      const textLen = (research.text || '').length
      const why = !textLen ? 'the search returned no text'
        : !entries.length ? `the search returned text (${textLen} chars) but no parseable candidate list`
        : `${entries.length} name${entries.length === 1 ? '' : 's'} came back but none had a citable source (${research.citations.length} citation${research.citations.length === 1 ? '' : 's'} available)`
      console.warn(`[discover] empty result — ${why}. Sample: ${String(research.text || '').slice(0, 300).replace(/\s+/g, ' ')}`)
      return fail(404, `No candidates found for that search — ${why}. Try a specific race or a different year.`, STAGE_SEARCH)
    }

    // ── 2. Skip anyone this user already has as a prospect ───────────────────
    // (No unique index on siloed rows — de-dupe here by name+office.)
    await reportProgress(STAGE_SAVE, 'running')
    const existing = await (async () => {
      try {
        const res = await sbFetch(`prospect_profiles?created_by=eq.${user.id}&select=name,office_name`)
        return res.ok ? await res.json() : []
      } catch { return [] }
    })()
    const have = new Set((existing || []).map(p => dedupeKey(p.name, p.office_name)))
    const fresh = rows.filter(r => !have.has(dedupeKey(r.name, r.office_name)))
    const skipped = rows.length - fresh.length
    state.total = rows.length

    // ── 3. Insert ────────────────────────────────────────────────────────────
    if (fresh.length) {
      const res = await sbFetch('prospect_profiles', {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify(fresh),
      })
      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        throw new Error(`save failed (${res.status}) ${detail.slice(0, 160)}`)
      }
    }
    state.completed = fresh.length
    state.current = null

    const message = skipped
      ? `Found ${rows.length} candidates — ${fresh.length} new, ${skipped} already in your pipeline.`
      : `Found ${rows.length} candidate${rows.length === 1 ? '' : 's'}.`
    await reportProgress(STAGE_SAVE, 'done', message)
    return { statusCode: 200, headers, body: JSON.stringify({ run_id: runId, found: rows.length, added: fresh.length, skipped }) }
  } catch (err) {
    console.error('[discover] unhandled error:', err?.stack || err?.message || err)
    await reportProgress(state.stage, 'error', 'Something went wrong during discovery. Please try again.')
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Discovery failed' }) }
  }
}

module.exports.normalizeParty = normalizeParty
module.exports.normalizeLevel = normalizeLevel
module.exports.parseCandidateJson = parseCandidateJson
module.exports.dedupeKey = dedupeKey
module.exports.buildProspectRows = buildProspectRows
module.exports.MAX_DISCOVERED = MAX_DISCOVERED
module.exports.resolveSource = resolveSource
module.exports.stripMarkers = stripMarkers
