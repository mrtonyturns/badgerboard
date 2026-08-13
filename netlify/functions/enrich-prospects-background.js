// Netlify Background Function: enrich-prospects-background
// ─── Prospecting v2 enrichment engine (discover → ENRICH → SCORE → export) ───
//
// Walks a batch of prospect_profiles rows and fills in, per prospect:
//   • win_odds_score + win_odds_factors  — the transparent weighted model in
//     _win-odds.js (PURE), fed from our own candidates DB + election_results
//   • affiliation                        — declared party when we have one,
//                                          otherwise a clearly-labelled Haiku inference
//   • has_website / website_state / website_url — existence VERIFIED by actually
//     fetching the claimed URL server-side (2s timeout, status < 400)
//   • socials                            — from the verified site's own markup first,
//                                          then cited web research
//   • agency_signals                     — web-visible evidence only (see below)
//   • contact                            — compliant sources only; every field
//                                          carries its own source + confidence
//
// ── BACKGROUND FUNCTION CONTRACT ─────────────────────────────────────────────
// The `-background` suffix means Netlify answers the browser with 202 BEFORE
// this handler runs, and every statusCode returned below is thrown away. The
// real output contract is therefore the rows written to:
//   prospecting_enrichment_progress  — one row per run_id, written at every
//                                      phase boundary AND every terminal outcome
//   prospect_profiles                — the enriched result rows
// Same discipline as generate-dossier-background.js / research-district-events-
// background.js: if a run dies without writing a terminal progress row, the page
// spins forever.
//
// ── AI DISCIPLINE ────────────────────────────────────────────────────────────
// Perplexity is used as an EXTRACTOR WITH MANDATORY CITATIONS (the election-
// results-poller pattern), never as an estimator: every field it returns must
// carry a source URL or it is dropped. Claude Haiku does the cheap structuring
// and the affiliation classification only — it is explicitly forbidden from
// adding facts the research text does not contain.
//
// ── COMPLIANCE: NO CFIS DATA ────────────────────────────────────────────────
// Wis. Stat. §11.1304(12) bars commercial use of information copied from WEC
// campaign-finance reports. Per the owner's directive this function does NOT
// query, ingest, store or display CFIS/Sunshine data — not committee emails,
// not treasurer records, not vendor disbursements. The game plan's strongest
// agency-detection signal (disbursements to known consulting vendors) is
// therefore REPLACED here with web-visible signals: "paid for by" disclaimers,
// footer vendor credits, staff/team pages, professional-platform fingerprints
// (ActBlue / WinRed / NGP VAN / EveryAction / Mobilize / NationBuilder) and
// Meta Ad Library presence reported through cited research text.
// The CFIS path is stubbed at CFIS_EXTENSION_POINT below, disabled, pending a
// written legal read.

const { enforceRateLimit } = require('./_rate-limit')
const { logAiUsage } = require('./_ai-usage')
const { computeWinOdds, primaryMarginFromResults } = require('./_win-odds')
const { ADMIN_EMAILS } = require('./_config')

const SUPABASE_URL         = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const ANTHROPIC_API_KEY    = process.env.ANTHROPIC_API_KEY
const PERPLEXITY_API_KEY   = process.env.PERPLEXITY_API_KEY

const HAIKU_MODEL = 'claude-haiku-4-5-20251001'   // cheap classification/structuring (game plan §4b)
const PPLX_MODEL  = 'sonar-pro'                   // extractor with citations

// ── Caps & budgets ───────────────────────────────────────────────────────────
const MAX_PROSPECTS_PER_RUN = 10        // hard cap per invocation (spend control)
const RUN_BUDGET_MS         = 11 * 60 * 1000  // background limit is 15 min; leave headroom to save
const PER_PROSPECT_MIN_MS   = 35 * 1000 // never START a prospect with less than this left
const SITE_TIMEOUT_MS       = 2000      // website existence check (per spec)
const PPLX_TIMEOUT_MS       = 30 * 1000
const HAIKU_TIMEOUT_MS      = 25 * 1000

// Progress stages, mirrored by PHASE_LABELS in src/pages/Prospecting.jsx.
const STAGE_SCORE  = 1   // load + win-odds scoring off our own data
const STAGE_SEARCH = 2   // cited web research
const STAGE_VERIFY = 3   // website fetch, socials, agency signals, contact
const STAGE_SAVE   = 4   // writing results

// ─────────────────────────────────────────────────────────────────────────────
// PURE HELPERS (exported for tests/prospecting.test.mjs — no I/O, no clock)
// ─────────────────────────────────────────────────────────────────────────────

/** Strip control characters and cap length. Same contract as the other functions. */
function sanitize(val, maxLen = 200) {
  if (val === null || val === undefined) return ''
  return String(val)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .slice(0, maxLen)
    .trim()
}

/**
 * Normalize a claimed URL to an absolute https(s) URL, or null.
 * Rejects anything that is not http/https (javascript:, data:, mailto:),
 * trims trailing punctuation the LLM likes to glue on, and refuses bare words.
 */
function normalizeUrl(raw) {
  let s = sanitize(raw, 500)
  if (!s) return null
  s = s.replace(/[)\]}>.,;'"]+$/, '').trim()
  if (!s || /\s/.test(s)) return null
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    if (/^(javascript|data|mailto|tel|file):/i.test(s)) return null
    if (!/^[\w-]+(\.[\w-]+)+/.test(s)) return null   // needs at least one dot
    s = `https://${s}`
  }
  try {
    const u = new URL(s)
    if (!/^https?:$/.test(u.protocol)) return null
    if (!u.hostname.includes('.')) return null
    return u.href
  } catch { return null }
}

const SOCIAL_HOSTS = [
  { key: 'facebook',  re: /(^|\.)facebook\.com$|(^|\.)fb\.com$/i },
  { key: 'instagram', re: /(^|\.)instagram\.com$/i },
  { key: 'x',         re: /(^|\.)twitter\.com$|(^|\.)x\.com$/i },
  { key: 'linkedin',  re: /(^|\.)linkedin\.com$/i },
  { key: 'tiktok',    re: /(^|\.)tiktok\.com$/i },
]

// Paths that are share widgets / platform chrome, not the campaign's profile.
const SOCIAL_JUNK = /\/(sharer|share|intent|home|login|signup|privacy|policies|help|about|explore|hashtag|search)(\/|$|\?)/i

/** Map a URL to a social platform key, or null if it is not a profile link. */
function classifySocial(url) {
  const norm = normalizeUrl(url)
  if (!norm) return null
  let u
  try { u = new URL(norm) } catch { return null }
  const hit = SOCIAL_HOSTS.find(h => h.re.test(u.hostname))
  if (!hit) return null
  if (SOCIAL_JUNK.test(u.pathname)) return null
  if (u.pathname === '/' || u.pathname === '') return null   // bare platform link
  return hit.key
}

/**
 * Pull the first genuine profile link per platform out of a page's markup.
 * Pure: HTML string in, {facebook,instagram,x,linkedin,tiktok} out.
 */
function extractSocialsFromHtml(html, baseUrl = '') {
  const out = { facebook: null, instagram: null, x: null, linkedin: null, tiktok: null }
  if (!html) return out
  for (const m of String(html).matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
    let href = m[1]
    if (/^\/\//.test(href)) href = `https:${href}`
    if (/^\//.test(href) && baseUrl) {
      try { href = new URL(href, baseUrl).href } catch { continue }
    }
    const key = classifySocial(href)
    if (key && !out[key]) out[key] = normalizeUrl(href)
    if (Object.values(out).every(Boolean)) break
  }
  return out
}

// Professional campaign-infrastructure fingerprints (game plan §4e, moderate
// signal on their own — they say "someone set this up properly").
const PLATFORM_FINGERPRINTS = [
  { name: 'ActBlue',      re: /actblue\.com|secure\.actblue/i },
  { name: 'WinRed',       re: /winred\.com|secure\.winred/i },
  { name: 'NGP VAN',      re: /ngpvan\.com|van\.ngpvan|myngp\.com/i },
  { name: 'EveryAction',  re: /everyaction\.com/i },
  { name: 'Mobilize',     re: /mobilize\.us/i },
  { name: 'NationBuilder',re: /nationbuilder\.com|nbuild/i },
  { name: 'Anedot',       re: /anedot\.com/i },
  { name: 'Numero',       re: /numero\.ai/i },
]

// Firm-shaped names in a credit line. Deliberately conservative: a match must
// look like a company, not just any capitalized words.
const FIRM_SUFFIX = /\b(LLC|L\.L\.C\.|Inc\.?|Group|Agency|Media|Strategies|Strategy|Consulting|Consultants|Communications|Partners|Digital|Creative|Campaigns|Solutions|Marketing)\b/i

/**
 * Detect evidence that a campaign already has professional help, from
 * web-visible signals ONLY. Pure over the inputs it is handed.
 *
 * @param {object} o
 *   html         {string} the verified campaign site's markup (may be '')
 *   url          {string} the site URL the markup came from
 *   researchText {string} cited research text (each claim carries its own URL)
 * @returns {{detected:boolean, confidence:number, evidence:Array}}
 */
function detectAgencySignals({ html = '', url = '', researchText = '' } = {}) {
  const evidence = []
  const push = (type, detail, evUrl, source) => {
    if (!detail) return
    if (evidence.some(e => e.type === type && e.detail === detail)) return
    evidence.push({
      type,
      detail: sanitize(detail, 240),
      url: normalizeUrl(evUrl) || null,
      source: source || 'campaign_website',
    })
  }

  // Prose scans run over the script-free copy; the platform-fingerprint scan
  // runs over the RAW source, because that is exactly where an ActBlue/WinRed/
  // NGP VAN embed lives (a <script src> the tag-stripper would throw away).
  const raw = String(html || '')
  const text = raw.replace(/<script[\s\S]*?<\/script>/gi, ' ')
  const plain = text.replace(/<[^>]+>/g, ' ').replace(/&nbsp;?/gi, ' ').replace(/\s+/g, ' ')

  // 1. "Paid for by" disclaimer (FEC/WEC disclaimer rules) — the credit line
  //    often names the committee AND, when an agency built it, the vendor.
  for (const m of plain.matchAll(/paid\s+for\s+by\s+([^.|·—]{3,120})/gi)) {
    push('paid_for_by', `Paid for by ${m[1].trim()}`, url, 'campaign_website')
  }

  // 2. Footer vendor credit ("Site by X", "Built by X", "Designed by X").
  //    The credit word may be capitalized; the FIRM must be, which is what
  //    keeps this from matching ordinary sentences — so the flag stays off.
  for (const m of plain.matchAll(/\b(?:[Ss]ite|[Ww]ebsite|[Dd]esigned?|[Bb]uilt|[Dd]eveloped|[Pp]owered)\s*(?:by|:)\s*([A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*){0,4})/g)) {
    const firm = m[1].trim()
    if (FIRM_SUFFIX.test(firm) || firm.split(/\s+/).length >= 2) {
      push('vendor_credit', `Site credit: ${firm}`, url, 'campaign_website')
    }
  }

  // 3. Staff/team roles published on the site.
  for (const m of plain.matchAll(/\b(Campaign Manager|Communications Director|Digital Director|Digital Consultant|Finance Director|Political Director|General Consultant|Media Consultant)\b/gi)) {
    push('staff_page', `Site lists a ${m[1]}`, url, 'campaign_website')
  }

  // 4. Professional platform embeds in the page source (raw, scripts included).
  for (const p of PLATFORM_FINGERPRINTS) {
    if (p.re.test(raw)) push('platform_embed', `${p.name} integration present in the site source`, url, 'campaign_website')
  }

  // 5. Research-reported signals. The research prompt requires a URL per claim,
  //    so we only keep lines that actually carry one.
  for (const line of String(researchText || '').split(/\r?\n/)) {
    if (!/https?:\/\//i.test(line)) continue
    const evUrl = (line.match(/https?:\/\/\S+/) || [])[0]
    const detail = line.replace(/https?:\/\/\S+/g, '').replace(/^[-*\s]*(AGENCY_EVIDENCE|EVIDENCE)\s*[:\-]?\s*/i, '').replace(/[\s—–\-|]+$/, '').trim()
    if (!detail) continue
    if (/ad\s*library|meta ads|facebook ad library/i.test(line)) {
      push('ad_library', detail, evUrl, 'meta_ad_library')
    } else if (/paid\s+for\s+by/i.test(line)) {
      push('paid_for_by', detail, evUrl, 'web_research')
    } else if (/(consultant|consulting|agency|firm|strategist|media buyer|campaign manager)/i.test(line)) {
      push('press_mention', detail, evUrl, 'web_research')
    }
  }

  // Confidence: direct vendor/agency naming is strong; infrastructure alone is
  // moderate; a lone staff title is weak (candidates name volunteers too).
  const STRENGTH = { paid_for_by: 45, vendor_credit: 45, press_mention: 35, ad_library: 35, staff_page: 20, platform_embed: 20 }
  const confidence = Math.min(95, evidence.reduce((s, e) => s + (STRENGTH[e.type] || 10), 0))
  return { detected: confidence >= 40, confidence, evidence: evidence.slice(0, 12) }
}

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi
const PHONE_RE = /(?:\+?1[\s.-]?)?\(?\b[2-9]\d{2}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g
// Addresses that belong to the site's toolchain, not the campaign.
const EMAIL_JUNK = /(example|sentry|wixpress|squarespace|godaddy|wordpress|no-?reply|donotreply|sentry\.io|@2x|\.png|\.jpg|\.webp)/i

/**
 * Extract published contact points from a campaign page. Pure.
 * mailto:/tel: links first (explicitly published), then body text.
 */
function extractContactsFromHtml(html) {
  const emails = []
  const phones = []
  const s = String(html || '')
  const addEmail = (v) => {
    const e = sanitize(v, 254).toLowerCase()
    if (!e || EMAIL_JUNK.test(e) || emails.includes(e)) return
    if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(e)) return
    emails.push(e)
  }
  const addPhone = (v) => {
    const digits = String(v || '').replace(/\D/g, '')
    const ten = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits
    if (ten.length !== 10) return
    const fmt = `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`
    if (!phones.includes(fmt)) phones.push(fmt)
  }

  for (const m of s.matchAll(/href\s*=\s*["']mailto:([^"'?]+)/gi)) addEmail(m[1])
  for (const m of s.matchAll(/href\s*=\s*["']tel:([^"']+)/gi)) addPhone(m[1])

  const plain = s
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
  for (const m of plain.matchAll(EMAIL_RE)) addEmail(m[0])
  for (const m of plain.matchAll(PHONE_RE)) addPhone(m[0])

  return { emails: emails.slice(0, 5), phones: phones.slice(0, 5) }
}

/**
 * Tri-state website answer (game plan §4c): a Facebook-only candidate is a
 * BETTER sales lead than one with a real site, so it must not collapse to "no".
 */
function websiteState({ verified, hasFacebook }) {
  if (verified) return 'yes'
  if (hasFacebook) return 'facebook_only'
  return 'no'
}

/**
 * Merge contact points from the sources we are allowed to use, newest/strongest
 * first, stamping every entry with its own source + confidence.
 * Order of trust: the candidate's own verified site > cited web research >
 * whatever the owner already typed into their candidates row.
 */
function buildContact({ site = { emails: [], phones: [] }, siteUrl = '', research = { emails: [], phones: [] }, db = {} } = {}) {
  const emails = []
  const phones = []
  const seenE = new Set()
  const seenP = new Set()
  const addE = (value, source, source_url, confidence) => {
    const v = sanitize(value, 254).toLowerCase()
    if (!v || seenE.has(v) || !/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(v)) return
    seenE.add(v)
    emails.push({ value: v, source, source_url: normalizeUrl(source_url) || null, confidence })
  }
  const addP = (value, source, source_url, confidence) => {
    const v = sanitize(value, 40)
    if (!v || seenP.has(v)) return
    seenP.add(v)
    phones.push({ value: v, source, source_url: normalizeUrl(source_url) || null, confidence })
  }

  for (const e of site.emails || []) addE(e, 'candidate_website', siteUrl, 85)
  for (const p of site.phones || []) addP(p, 'candidate_website', siteUrl, 85)
  for (const e of research.emails || []) addE(e.value ?? e, 'web_research', e.source_url, e.confidence ?? 65)
  for (const p of research.phones || []) addP(p.value ?? p, 'web_research', p.source_url, p.confidence ?? 65)
  if (db.email) addE(db.email, 'candidates_db', null, 60)
  if (db.phone) addP(db.phone, 'candidates_db', null, 60)

  const best = Math.max(0, ...emails.map(e => e.confidence), ...phones.map(p => p.confidence))
  const primary = [...emails, ...phones].find(x => x.confidence === best)
  return {
    emails: emails.slice(0, 5),
    phones: phones.slice(0, 5),
    source: primary ? primary.source : null,
    confidence: best || 0,
    // Named so nobody has to re-derive the rule from the game plan later.
    compliance_note: 'Candidate-published and cited-press sources only. No WEC/CFIS campaign-finance data (Wis. Stat. §11.1304(12)).',
  }
}

/**
 * Parse the extractor's "FIELD: value — URL" lines. Anything without a URL is
 * dropped on the floor: an uncited claim is an invention.
 */
function parseCitedFields(text) {
  const out = {}
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/^[-*\s]+/, '').trim()
    const m = line.match(/^([A-Z_]{3,30})\s*[:\-]\s*(.+)$/)
    if (!m) continue
    const key = m[1].toUpperCase()
    const rest = m[2]
    const url = (rest.match(/https?:\/\/\S+/) || [])[0]
    if (!url) continue                                   // no citation → not a fact
    const value = rest.replace(/https?:\/\/\S+/g, '').replace(/[\s—–\-|(),]+$/, '').replace(/^[\s—–\-|]+/, '').trim()
    if (!out[key]) out[key] = []
    out[key].push({ value, source_url: normalizeUrl(url) })
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// I/O helpers
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

async function sbJson(path) {
  try {
    const res = await sbFetch(path)
    if (!res.ok) return null
    return await res.json()
  } catch (e) {
    console.warn('[enrich] query failed:', path.slice(0, 80), e.message)
    return null
  }
}

/** Verify the caller's Supabase JWT (header or forwarded body.auth_header). */
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
// Win-odds inputs — gathered from OUR OWN data only
// ─────────────────────────────────────────────────────────────────────────────

const PARTY_SIDE = (p) => {
  const s = String(p || '').toLowerCase()
  if (/republican|conservative|gop/.test(s)) return 'R'
  if (/democrat|liberal|progressive/.test(s)) return 'D'
  return null
}

/**
 * Pull incumbency / lean / primary margin / contested / seat history for one
 * candidate out of candidates + election_contests + election_results.
 * Every lookup fails soft: a missing signal becomes an unavailable FACTOR, which
 * the pure model renormalizes around — it never becomes a guess.
 */
async function gatherWinOddsInputs(candidate) {
  const inputs = {
    is_incumbent: null, contested: null, field_size: null,
    district_lean: null, primary_margin: null, primary_won: null, seat_history: null,
  }
  const notes = []
  if (!candidate) return { inputs, notes }

  inputs.is_incumbent = candidate.is_incumbent === true || candidate.status === 'elected'
    ? true
    : (candidate.is_incumbent === false ? false : null)

  const officeName = candidate.office?.name || ''
  const districtName = candidate.office?.district_name || ''
  const needle = sanitize(districtName || officeName, 60)
  const mySide = PARTY_SIDE(candidate.party)

  // How many of the owner's own candidates share this seat + election? Two or
  // more is proof of a contest; one is NOT proof of an uncontested race (our DB
  // is partial), so we never assert `false` from this signal alone.
  if (candidate.office_id && candidate.election_id) {
    const peers = await sbJson(
      `candidates?office_id=eq.${candidate.office_id}&election_id=eq.${candidate.election_id}&select=id`
    )
    if (Array.isArray(peers) && peers.length >= 2) {
      inputs.contested = true
      inputs.field_size = peers.length
      notes.push(`${peers.length} candidates on this seat in your database`)
    }
  }

  if (!needle) return { inputs, notes }

  // Contests for this seat, newest first, with their election dates.
  const contests = await sbJson(
    `election_contests?office=ilike.*${encodeURIComponent(needle)}*` +
    `&select=id,office,district,election_id,election:elections(election_date,type,year)&limit=25`
  )
  if (!Array.isArray(contests) || !contests.length) return { inputs, notes }

  const dated = contests
    .map(c => ({ ...c, date: c.election?.election_date || null }))
    .filter(c => c.date)
    .sort((a, b) => (a.date < b.date ? 1 : -1))
  if (!dated.length) return { inputs, notes }

  const rows = await sbJson(
    `election_results?contest_id=in.(${dated.map(c => c.id).join(',')})` +
    `&select=contest_id,candidate_name,party,votes,vote_pct,winner,incumbent&limit=400`
  )
  if (!Array.isArray(rows) || !rows.length) return { inputs, notes }
  const byContest = new Map()
  for (const r of rows) {
    if (!byContest.has(r.contest_id)) byContest.set(r.contest_id, [])
    byContest.get(r.contest_id).push(r)
  }

  const today = new Date().toISOString().slice(0, 10)

  // ── Primary margin: this candidate's own most recent primary result ────────
  const primaryContest = dated.find(c =>
    /primary/i.test(c.election?.type || '') && c.date <= today && byContest.has(c.id)
  )
  if (primaryContest) {
    const pr = primaryMarginFromResults(byContest.get(primaryContest.id), candidate.name)
    if (pr) {
      inputs.primary_margin = pr.margin
      inputs.primary_won = pr.won
      if (inputs.field_size == null) inputs.field_size = pr.field_size
      if (pr.field_size === 1) inputs.contested = false
      else if (pr.field_size >= 2) inputs.contested = true
      notes.push(`Primary result read from election_results (${pr.pct}% of the vote)`)
    }
  }

  // ── District lean + seat history: prior GENERAL contests for the same seat ─
  const priorGenerals = dated.filter(c =>
    !/primary/i.test(c.election?.type || '') && c.date < today && byContest.has(c.id)
  ).slice(0, 3)

  const winnerSides = []
  for (const c of priorGenerals) {
    const list = byContest.get(c.id) || []
    if (list.length < 2) { winnerSides.push(null); continue }
    const total = list.reduce((s, r) => s + (Number(r.votes) || 0), 0)
    const pct = (r) => {
      const p = Number(r.vote_pct)
      if (Number.isFinite(p) && p > 0) return p
      return total > 0 ? ((Number(r.votes) || 0) / total) * 100 : 0
    }
    const sorted = [...list].sort((a, b) => pct(b) - pct(a))
    const top = sorted[0]
    const runnerUp = sorted[1]
    winnerSides.push(PARTY_SIDE(top.party))
    if (inputs.district_lean == null && mySide && PARTY_SIDE(top.party)) {
      const margin = pct(top) - pct(runnerUp)
      inputs.district_lean = Math.round((PARTY_SIDE(top.party) === mySide ? margin : -margin) * 10) / 10
      notes.push(`District lean from the ${c.election?.year || ''} ${c.office} result`)
    }
  }

  const known = winnerSides.filter(Boolean)
  if (known.length >= 2 && known[0] !== known[1]) {
    inputs.seat_history = 'recent_flip'
  } else if (known.length >= 1 && mySide) {
    inputs.seat_history = known[0] === mySide ? 'safe_same_party' : 'opposite_party_hold'
  }
  // An open seat overrides the party read: nobody is defending it.
  if (inputs.is_incumbent === false) {
    const current = dated.find(c => c.date >= today && byContest.has(c.id))
    if (current && !(byContest.get(current.id) || []).some(r => r.incumbent === true)) {
      inputs.seat_history = 'open'
      notes.push('No incumbent on the current ballot for this seat')
    }
  }

  return { inputs, notes }
}

// ─────────────────────────────────────────────────────────────────────────────
// Research (Perplexity extractor) + structuring (Haiku)
// ─────────────────────────────────────────────────────────────────────────────

const RESEARCH_SYSTEM = [
  'You are a Wisconsin political research EXTRACTOR working for a marketing agency that is evaluating candidates as potential clients.',
  'You do not estimate, infer, guess, or reconstruct. You report only what a specific public web page states, and you give that page\'s URL on the same line.',
  'FORMAT: one fact per line, exactly `FIELD: value — https://source-url`. Nothing else. No prose, no preamble, no bullets, no summary.',
  'If you cannot confirm a field from a real page, OMIT the line entirely. Never write "unknown", "not found", "likely", or a guessed URL.',
  'Never construct a website or social URL from the candidate\'s name — only report URLs you actually found linked or cited.',
  'COMPLIANCE: do NOT use Wisconsin campaign-finance filings (CFIS, Sunshine, campaignfinance.wi.gov, WEC report data) as a source for contact information or vendor/consultant payments. Those sources are out of scope; skip them.',
].join(' ')

function researchPrompt(p) {
  const where = [p.district_name, p.county ? `${p.county} County` : '', 'Wisconsin'].filter(Boolean).join(', ')
  return `Candidate: ${p.name}. Office sought: ${p.office_name || 'unknown office'}${where ? ` (${where})` : ''}.${p.election_name ? ` Election: ${p.election_name}.` : ''}

Report ONLY these fields, one per line, each with its source URL:
CAMPAIGN_WEBSITE: the candidate's own campaign website (not a news article, not a government bio, not Ballotpedia)
FACEBOOK: campaign or candidate Facebook page URL
INSTAGRAM: campaign or candidate Instagram profile URL
X: campaign or candidate X/Twitter profile URL
LINKEDIN: the candidate's LinkedIn profile URL
TIKTOK: campaign TikTok profile URL
PARTY: the party the candidate is running under, as stated by the ballot, the campaign, or news coverage
EMAIL: a contact email address PUBLISHED ON THE CANDIDATE'S OWN CAMPAIGN WEBSITE or quoted in news coverage
PHONE: a campaign phone number published the same way
AGENCY_EVIDENCE: any evidence the campaign already works with a paid consultant, agency, or campaign manager — a "Paid for by" disclaimer naming a firm, a website footer credit naming a design/digital shop, a staff or team page listing a Campaign Manager or Communications Director, a Meta Ad Library entry naming the paid sponsor, or news coverage naming their consultant. One line per piece of evidence, each with its URL.`
}

async function runPerplexity(prompt, userId) {
  if (!PERPLEXITY_API_KEY) return { text: null, error: 'PERPLEXITY_API_KEY is not set' }
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
        max_tokens: 900,
        messages: [
          { role: 'system', content: RESEARCH_SYSTEM },
          { role: 'user', content: prompt },
        ],
      }),
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      return { text: null, error: `Perplexity ${res.status}${detail ? `: ${detail.slice(0, 160)}` : ''}` }
    }
    const d = await res.json()
    logAiUsage({
      userId, endpoint: 'prospecting', provider: 'perplexity', model: PPLX_MODEL,
      inputTokens: d?.usage?.prompt_tokens || 0, outputTokens: d?.usage?.completion_tokens || 0,
    })
    return { text: d?.choices?.[0]?.message?.content || null, error: null }
  } catch (e) {
    return { text: null, error: e.name === 'AbortError' ? 'Research call timed out' : `Research call failed: ${e.message}` }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Cheap Haiku pass — classification only (game plan §4b keeps the Haiku lean
 * classifier but relabels its output as an INFERENCE, never a filing).
 * Returns { label, confidence, basis } or null.
 */
async function classifyAffiliation({ name, officeName, researchText, dbParty }, userId) {
  if (dbParty) {
    return { label: dbParty, inferred: false, confidence: 100, basis: 'Declared party on the candidate record / ballot' }
  }
  if (!ANTHROPIC_API_KEY || !researchText) return null
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), HAIKU_TIMEOUT_MS)
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: HAIKU_MODEL,
        max_tokens: 400,
        messages: [{
          role: 'user',
          content: `Classify the political affiliation of ${name}${officeName ? `, a candidate for ${officeName} in Wisconsin` : ''}, using ONLY the sourced research below. Do not use your own knowledge of this person and do not guess from their name.

Return STRICT JSON, no prose, no markdown fences:
{"label":"Republican|Democrat|Independent|Nonpartisan|conservative|liberal|unknown","confidence":0-100,"basis":"one short sentence naming the evidence"}

Rules:
- Use a party name (Republican/Democrat/...) ONLY if the research states the party.
- Use "conservative"/"liberal" only as a LEAN inference when the research shows issue positions or endorsements but no party, and only at 70+ confidence.
- Otherwise return "unknown" with confidence 0. An unknown is a correct answer.

RESEARCH:
${String(researchText).slice(0, 6000)}`,
        }],
      }),
    })
    if (!res.ok) return null
    const d = await res.json()
    logAiUsage({
      userId, endpoint: 'prospecting', provider: 'anthropic', model: HAIKU_MODEL,
      inputTokens: d?.usage?.input_tokens || 0, outputTokens: d?.usage?.output_tokens || 0,
    })
    const raw = (d.content?.find(b => b.type === 'text')?.text || '')
      .replace(/^```json?\s*/i, '').replace(/```\s*$/, '').trim()
    const parsed = JSON.parse(raw)
    const label = sanitize(parsed?.label, 30)
    if (!label || label === 'unknown') return null
    const confidence = Math.max(0, Math.min(100, Number(parsed?.confidence) || 0))
    if (confidence < 70) return null
    return { label, inferred: true, confidence, basis: sanitize(parsed?.basis, 240) }
  } catch (e) {
    console.warn('[enrich] affiliation classification skipped:', e.message)
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Existence check: actually FETCH the claimed URL server-side. A URL an LLM
 * produced is a claim; a 200 is evidence. 2s timeout, status < 400 required.
 */
async function verifyWebsite(url) {
  const target = normalizeUrl(url)
  if (!target) return { ok: false, status: null, url: null, html: '' }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), SITE_TIMEOUT_MS)
  try {
    const res = await fetch(target, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BadgerBoard/1.0; +https://badgerboardwi.com)' },
    })
    if (!res.ok || res.status >= 400) return { ok: false, status: res.status, url: res.url || target, html: '' }
    const type = res.headers.get('content-type') || ''
    const html = /text\/html|application\/xhtml/i.test(type) ? (await res.text()).slice(0, 400000) : ''
    return { ok: true, status: res.status, url: res.url || target, html }
  } catch (e) {
    return { ok: false, status: null, url: target, html: '', error: e.name === 'AbortError' ? 'timeout' : e.message }
  } finally {
    clearTimeout(timer)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CFIS_EXTENSION_POINT — DISABLED PENDING LEGAL REVIEW
// ─────────────────────────────────────────────────────────────────────────────
// The game plan's strongest agency-detection signal is disbursements from the
// candidate's committee to known political-consulting vendors, read from the
// WEC CFIS "Expenses" search. Wis. Stat. §11.1304(12) bars commercial use of
// information copied from those reports, and Badger Board's whole use case is
// commercial, so this stays off until counsel answers §5 of the game plan.
//
// When (and only when) that answer arrives:
//   1. flip CFIS_ENABLED,
//   2. implement fetchCfisVendorSignals() to return the SAME evidence shape
//      detectAgencySignals() produces ({ type:'vendor_payment', detail, url, source }),
//   3. add the cfis_signals column from the migration's extension point,
//   4. decide separately whether those rows may leave the internal signal layer
//      (buildProspectCsv must keep excluding them unless counsel says otherwise).
const CFIS_ENABLED = false
async function fetchCfisVendorSignals(/* candidate */) {
  if (!CFIS_ENABLED) return { detected: false, evidence: [] }
  throw new Error('CFIS ingestion is not implemented and must not be enabled without a written legal read of Wis. Stat. §11.1304(12).')
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-prospect pipeline
// ─────────────────────────────────────────────────────────────────────────────

async function enrichOne({ profile, candidate, userId, runId, onStage = () => {} }) {
  const name = sanitize(profile.name || candidate?.name, 150)
  const citations = []
  const addCite = (label, url) => {
    const u = normalizeUrl(url)
    if (u && !citations.some(c => c.url === u)) citations.push({ label: sanitize(label, 60), url: u })
  }

  // ── 1. Score off our own data (no AI, no network beyond our DB) ────────────
  await onStage(STAGE_SCORE)
  const { inputs, notes } = await gatherWinOddsInputs(candidate)
  const odds = computeWinOdds(inputs)

  // ── 2. Cited web research ─────────────────────────────────────────────────
  await onStage(STAGE_SEARCH)
  const research = await runPerplexity(researchPrompt({
    name,
    office_name: profile.office_name || candidate?.office?.name,
    district_name: profile.district_name || candidate?.office?.district_name,
    county: profile.county || candidate?.office?.county,
    election_name: candidate?.election?.name,
  }), userId)
  const fields = parseCitedFields(research.text)
  for (const [k, list] of Object.entries(fields)) for (const f of list) addCite(k, f.source_url)

  // ── 3. Website: claim → verification ──────────────────────────────────────
  await onStage(STAGE_VERIFY)
  const claimedSite = normalizeUrl(fields.CAMPAIGN_WEBSITE?.[0]?.value)
    || normalizeUrl(fields.CAMPAIGN_WEBSITE?.[0]?.source_url)
    || normalizeUrl(candidate?.website)
  const site = claimedSite ? await verifyWebsite(claimedSite) : { ok: false, status: null, url: null, html: '' }

  // ── 4. Socials: the verified site's own links first, research second ───────
  const socials = extractSocialsFromHtml(site.html, site.url || claimedSite || '')
  const RESEARCH_SOCIAL = { FACEBOOK: 'facebook', INSTAGRAM: 'instagram', X: 'x', LINKEDIN: 'linkedin', TIKTOK: 'tiktok' }
  for (const [field, key] of Object.entries(RESEARCH_SOCIAL)) {
    if (socials[key]) continue
    for (const hit of fields[field] || []) {
      const candidateUrl = normalizeUrl(hit.value) || hit.source_url
      if (classifySocial(candidateUrl) === key) { socials[key] = normalizeUrl(candidateUrl); break }
    }
  }
  // Anything the owner already recorded on the candidate row still counts.
  if (!socials.facebook && candidate?.facebook_url) socials.facebook = normalizeUrl(candidate.facebook_url)
  if (!socials.linkedin && candidate?.linkedin_url) socials.linkedin = normalizeUrl(candidate.linkedin_url)
  if (!socials.x && candidate?.twitter_handle) socials.x = normalizeUrl(`https://x.com/${String(candidate.twitter_handle).replace(/^@/, '')}`)
  if (!socials.instagram && candidate?.instagram_handle) socials.instagram = normalizeUrl(`https://instagram.com/${String(candidate.instagram_handle).replace(/^@/, '')}`)

  // ── 5. Agency signals — web-visible evidence only ─────────────────────────
  const agencyText = (fields.AGENCY_EVIDENCE || []).map(f => `${f.value} ${f.source_url}`).join('\n')
  const agency = detectAgencySignals({ html: site.html, url: site.url || claimedSite || '', researchText: agencyText })
  agency.checked_at = new Date().toISOString()
  agency.cfis_checked = false   // never — see CFIS_EXTENSION_POINT

  // ── 6. Contact — compliant sources only, per-field source + confidence ────
  const siteContacts = site.ok ? extractContactsFromHtml(site.html) : { emails: [], phones: [] }
  const contact = buildContact({
    site: siteContacts,
    siteUrl: site.url || claimedSite || '',
    research: {
      emails: (fields.EMAIL || []).map(f => ({ value: f.value, source_url: f.source_url, confidence: 65 })),
      phones: (fields.PHONE || []).map(f => ({ value: f.value, source_url: f.source_url, confidence: 65 })),
    },
    db: { email: candidate?.email, phone: candidate?.phone },
  })

  // ── 7. Affiliation ────────────────────────────────────────────────────────
  const declaredParty = sanitize(candidate?.party, 40)
    || sanitize((fields.PARTY || [])[0]?.value, 40)
  const affiliation = await classifyAffiliation({
    name,
    officeName: profile.office_name || candidate?.office?.name,
    researchText: research.text,
    dbParty: declaredParty || null,
  }, userId)

  const verified = site.ok
  const state = websiteState({ verified, hasFacebook: Boolean(socials.facebook) })

  return {
    patch: {
      win_odds_score: odds.score,
      win_odds_band: odds.band,
      win_odds_factors: {
        model_version: odds.model_version,
        confidence: odds.confidence,
        unavailable: odds.unavailable,
        inputs,
        notes,
        factors: odds.factors,
      },
      affiliation: affiliation?.label || declaredParty || null,
      affiliation_detail: affiliation
        ? {
            inferred: affiliation.inferred,
            confidence: affiliation.confidence,
            basis: affiliation.basis,
            source: affiliation.inferred ? 'haiku_inference_from_cited_research' : 'candidate_record',
          }
        : { inferred: false, confidence: declaredParty ? 100 : 0, basis: declaredParty ? 'Declared party on the candidate record' : 'No party evidence found', source: declaredParty ? 'candidate_record' : null },
      has_website: verified,
      website_url: verified ? site.url : (claimedSite || null),
      website_state: state,
      website_verified_at: verified ? new Date().toISOString() : null,
      website_status: site.status ?? null,
      socials,
      agency_signals: agency,
      contact,
      research_citations: citations.slice(0, 25),
      enriched_at: new Date().toISOString(),
      enrichment_status: research.error ? 'partial' : 'enriched',
      enrichment_error: research.error ? sanitize(research.error, 300) : null,
      last_run_id: runId,
    },
    softError: research.error || null,
  }
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

  const startedAt = Date.now()
  const deadline = startedAt + RUN_BUDGET_MS

  let body
  try { body = JSON.parse(event.body || '{}') } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }
  }

  // run_id comes from the client so it can poll its own run. Validate the shape
  // BEFORE anything else — without it there is no channel to report failure on.
  const runId = sanitize(body.run_id, 64)
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  if (!UUID_RE.test(runId)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'A valid run_id (uuid) is required' }) }
  }

  // Progress writer — the run's only durable output channel. Best effort: a
  // failed progress write must never take down a run that is otherwise working.
  const state = { stage: STAGE_SCORE, total: 0, completed: 0, failed: 0, current: null, userId: null }
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
    } catch (e) { console.warn('[enrich] progress write failed:', e.message) }
  }
  /** Terminal failure: always leaves a durable error row behind. */
  const fail = async (statusCode, message, stage = state.stage) => {
    await reportProgress(stage, 'error', message)
    return { statusCode, headers, body: JSON.stringify({ error: message }) }
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Supabase service credentials are not configured.' }) }
  }

  // ── Auth ──────────────────────────────────────────────────────────────────
  // NOTE: an unauthenticated caller gets no progress row — we have no verified
  // user to attribute one to, and RLS makes an unattributed row unreadable
  // anyway. Every failure AFTER this point writes one.
  const authHeader = event.headers?.authorization || event.headers?.Authorization
    || (typeof body.auth_header === 'string' ? body.auth_header : null)
  const user = await verifyUser(authHeader)
  if (!user) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Not authenticated' }) }
  state.userId = user.id

  // ── Entitlement: 'prospecting' feature, resolved server-side ──────────────
  // tiers.js is the single source of truth for which plans carry the feature
  // (same pattern as generate-prospecting.js / classify-csv-prospects.js). It is
  // required lazily so this module can be imported by unit tests without
  // dragging an ESM file through require().
  const isAdmin = ADMIN_EMAILS.includes((user.email || '').toLowerCase())
  if (!isAdmin) {
    try {
      const { PLAN_CONFIG } = require('../../src/lib/tiers.js')
      const PROSPECTING_PLANS = Object.keys(PLAN_CONFIG).filter(k => PLAN_CONFIG[k]?.features?.prospecting)
      const { resolveEntitlement } = require('./_entitlements')
      const { plan } = await resolveEntitlement(user)
      if (!PROSPECTING_PLANS.includes(plan)) {
        return fail(403, 'Prospect enrichment is included with Action plans. Upgrade to unlock it.')
      }
    } catch (e) {
      console.error('[enrich] entitlement check failed:', e.message)
      return fail(503, 'Could not verify your plan — please try again in a moment.')
    }
  }

  // ── Durable per-user rate limit (cost control; fails open by design) ──────
  const limited = await enforceRateLimit(user.id, 'enrich-prospects', headers)
  if (limited) {
    await reportProgress(state.stage, 'error',
      'You have run a lot of enrichments recently — give it a few minutes and try again.')
    return limited
  }

  // ── Resolve the batch ─────────────────────────────────────────────────────
  const prospectIds = (Array.isArray(body.prospect_ids) ? body.prospect_ids : [])
    .map(id => sanitize(id, 64)).filter(id => UUID_RE.test(id))
  const candidateIds = (Array.isArray(body.candidate_ids) ? body.candidate_ids : [])
    .map(id => sanitize(id, 64)).filter(id => UUID_RE.test(id))
  if (!prospectIds.length && !candidateIds.length) {
    return fail(400, 'No prospects were selected for enrichment.')
  }

  let profiles = []
  if (prospectIds.length) {
    const rows = await sbJson(
      `prospect_profiles?id=in.(${prospectIds.slice(0, MAX_PROSPECTS_PER_RUN * 3).join(',')})` +
      `&created_by=eq.${user.id}&select=*`
    )
    if (Array.isArray(rows)) profiles = rows
  }
  // Candidate ids without a profile row yet get one created here, so the
  // endpoint is usable without a prior client-side insert.
  if (candidateIds.length) {
    const have = new Set(profiles.map(p => p.candidate_id).filter(Boolean))
    const missing = candidateIds.filter(id => !have.has(id)).slice(0, MAX_PROSPECTS_PER_RUN)
    if (missing.length) {
      const cands = await sbJson(
        `candidates?id=in.(${missing.join(',')})&created_by=eq.${user.id}` +
        `&select=id,name,party,election_id,office:offices(name,level,district_name,county),election:elections(election_date)`
      )
      for (const c of cands || []) {
        try {
          const res = await sbFetch('prospect_profiles', {
            method: 'POST',
            headers: { Prefer: 'return=representation' },
            body: JSON.stringify({
              created_by: user.id,
              candidate_id: c.id,
              name: sanitize(c.name, 150),
              office_name: sanitize(c.office?.name, 150) || null,
              district_name: sanitize(c.office?.district_name, 100) || null,
              county: sanitize(c.office?.county, 60) || null,
              level: sanitize(c.office?.level, 20) || null,
              election_id: c.election_id || null,
              election_date: c.election?.election_date || null,
              party: sanitize(c.party, 40) || null,
              discovery_source: 'candidates_db',
              enrichment_status: 'pending',
            }),
          })
          if (res.ok) {
            const created = await res.json()
            if (Array.isArray(created) && created[0]) profiles.push(created[0])
          }
        } catch (e) { console.warn('[enrich] profile create failed:', e.message) }
      }
    }
  }

  if (!profiles.length) {
    return fail(404, 'None of the selected prospects could be found on your account.')
  }

  // Hard cap per run — the client shows the same number, this enforces it.
  const batch = profiles.slice(0, MAX_PROSPECTS_PER_RUN)
  state.total = batch.length
  await reportProgress(STAGE_SCORE, 'running')

  try {
    // Candidate context for the whole batch in one query.
    const linked = batch.map(p => p.candidate_id).filter(Boolean)
    let candidatesById = new Map()
    if (linked.length) {
      const rows = await sbJson(
        `candidates?id=in.(${linked.join(',')})&created_by=eq.${user.id}` +
        `&select=*,office:offices(id,name,level,district_name,district_number,county),election:elections(id,name,election_date,type,year)`
      )
      candidatesById = new Map((rows || []).map(r => [r.id, r]))
    }

    let deferred = 0
    for (const profile of batch) {
      if (Date.now() > deadline - PER_PROSPECT_MIN_MS) {
        deferred = batch.length - state.completed - state.failed
        console.warn(`[enrich] run budget exhausted — ${deferred} prospect(s) deferred`)
        break
      }
      state.current = profile.name
      await reportProgress(STAGE_SCORE, 'running')

      try {
        const { patch, softError } = await enrichOne({
          profile,
          candidate: candidatesById.get(profile.candidate_id) || null,
          userId: user.id,
          runId,
          // Real phase boundaries, reported as they happen — not a fake timeline.
          onStage: (s) => reportProgress(s, 'running'),
        })
        await reportProgress(STAGE_SAVE, 'running')
        const res = await sbFetch(
          `prospect_profiles?id=eq.${profile.id}&created_by=eq.${user.id}`,
          { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(patch) }
        )
        if (!res.ok) {
          const detail = await res.text().catch(() => '')
          throw new Error(`save failed (${res.status}) ${detail.slice(0, 120)}`)
        }
        state.completed += 1
        if (softError) console.warn(`[enrich] ${profile.name}: partial — ${softError}`)
      } catch (e) {
        state.failed += 1
        console.error(`[enrich] ${profile.name} failed:`, e.message)
        // Record the failure ON the row too, so the results table can show it.
        try {
          await sbFetch(`prospect_profiles?id=eq.${profile.id}&created_by=eq.${user.id}`, {
            method: 'PATCH',
            headers: { Prefer: 'return=minimal' },
            body: JSON.stringify({
              enrichment_status: 'error',
              enrichment_error: sanitize(e.message, 300),
              last_run_id: runId,
            }),
          })
        } catch { /* best effort */ }
      }
      // Publish the new completed/failed counts before moving on.
      state.current = null
      await reportProgress(STAGE_SAVE, 'running')
    }

    const message = deferred
      ? `Enriched ${state.completed} of ${state.total}. ${deferred} ran out of time and are still queued — run them again.`
      : null
    if (state.completed === 0 && state.failed > 0) {
      return fail(502, 'Enrichment could not complete for any of the selected prospects. No enrichment data was written — they are still queued.', STAGE_SAVE)
    }
    await reportProgress(STAGE_SAVE, 'done', message)
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ run_id: runId, total: state.total, completed: state.completed, failed: state.failed, deferred }),
    }
  } catch (err) {
    // A background invocation swallows thrown errors entirely — without this the
    // page would poll a status row that never leaves "running".
    console.error('[enrich] unhandled error:', err?.stack || err?.message || err)
    await reportProgress(state.stage, 'error', 'Something went wrong during enrichment. Partial results were saved.')
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Enrichment failed' }) }
  }
}

// Pure helpers are exported for tests/prospecting.test.mjs. Requiring this
// module has no side effects beyond reading env vars.
module.exports.sanitize = sanitize
module.exports.normalizeUrl = normalizeUrl
module.exports.classifySocial = classifySocial
module.exports.extractSocialsFromHtml = extractSocialsFromHtml
module.exports.detectAgencySignals = detectAgencySignals
module.exports.extractContactsFromHtml = extractContactsFromHtml
module.exports.websiteState = websiteState
module.exports.buildContact = buildContact
module.exports.parseCitedFields = parseCitedFields
module.exports.MAX_PROSPECTS_PER_RUN = MAX_PROSPECTS_PER_RUN
module.exports.STAGES = { STAGE_SCORE, STAGE_SEARCH, STAGE_VERIFY, STAGE_SAVE }
