// src/lib/recruit.js — pure helpers for Recruit-from-voter-list.
//
// v1 is Tier A of RECRUIT-from-voterlist-gameplan.md §1: COLUMN-FIRST district
// matching. The official WEC "Badger Voters"/WisVote export already carries
// Ward, County Supervisory District, Aldermanic District and School District as
// plain strings, so a seat is matched by comparing the CSV's own column against
// the office's district — no geocoding, no point-in-polygon, no new geometry.
//
// Tier B (real ward / county-board / aldermanic polygons + geocoded
// point-in-polygon) is a DEFERRED fast-follow. Every place this file would need
// to change for it is marked `MAP-GEOMETRY INTEGRATION POINT`.
//
// Everything here is pure and side-effect free so it can be unit tested
// (tests/recruit.test.mjs) and shared by the React page and the Netlify
// background function.

// ─── CSV header normalisation ────────────────────────────────────────────────
// VoterLists.parseCSV() lowercases headers but keeps spaces/underscores, and
// third-party files (L2/i360/TargetSmart) spell these fields a dozen different
// ways. Reducing every header to [a-z0-9] makes one alias cover
// "County Supervisory District", "county_supervisory_district" and
// "CountySupervisoryDist" alike.

/** Reduce a CSV header to its comparable form: lowercase, alphanumerics only. */
export function normalizeHeader(h) {
  return String(h ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

// Values that mean "no district" in real exports — treated as blank.
const NULLISH_VALUES = new Set(['', 'n/a', 'na', 'none', 'null', 'unknown', '-', '--', 'not applicable'])

/**
 * Canonical district column → accepted source headers (already normalised).
 * Order matters: the first alias present on the row wins.
 *
 * NOTE `highschooldistrict` is deliberately absent — WEC ships it as a separate
 * data element and it is NOT the K-12 school district a school board seat runs
 * in. Exact-match lookup keeps it from being mistaken for `school_district`.
 */
export const VOTER_DISTRICT_ALIASES = {
  county_supervisory_district: [
    'countysupervisorydistrict', 'countysupervisorydist', 'countysupervisory',
    'supervisorydistrict', 'supervisordistrict', 'supervisorydist', 'supdist',
    'cosupdist', 'countysupdist', 'countyboarddistrict', 'countyboardsupervisorydistrict',
    'countyboarddist', 'cntysupdist', 'supervisory',
  ],
  aldermanic_district: [
    'aldermanicdistrict', 'aldermanicdist', 'aldermanic', 'alderdistrict',
    'alderdist', 'alddist', 'aldermandistrict', 'alderman',
    'citycouncildistrict', 'councildistrict', 'commoncouncildistrict',
  ],
  school_district: [
    'schooldistrict', 'schooldist', 'schdist', 'schooldistrictname',
    'unifiedschooldistrict', 'k12schooldistrict', 'sdname', 'schoolname',
    'elementaryschooldistrict',
  ],
  ward: [
    'ward', 'wardname', 'wardnumber', 'wardno', 'warddescription', 'precinct',
    'precinctname', 'votingward',
  ],
}

/** The `voters` columns this feature adds (migration 20260812000011). */
export const RECRUIT_VOTER_COLUMNS = ['county_supervisory_district', 'aldermanic_district', 'school_district']

/** Trim a raw cell and blank out the export world's many spellings of "none". */
export function cleanCell(v) {
  const s = String(v ?? '').trim().replace(/\s+/g, ' ')
  return NULLISH_VALUES.has(s.toLowerCase()) ? '' : s
}

/**
 * Pull the sub-municipal district columns off one parsed CSV row.
 * Unknown columns keep being ignored — this only ADDS fields, never removes.
 * @param {object} row  header→value map (headers already lowercased by parseCSV)
 * @returns {{county_supervisory_district:string, aldermanic_district:string, school_district:string, ward:string}}
 */
export function extractDistrictColumns(row) {
  const byNorm = new Map()
  for (const [k, v] of Object.entries(row || {})) {
    const n = normalizeHeader(k)
    if (n && !byNorm.has(n)) byNorm.set(n, v)
  }
  const out = {}
  for (const [canonical, aliases] of Object.entries(VOTER_DISTRICT_ALIASES)) {
    let val = ''
    for (const a of aliases) {
      const hit = cleanCell(byNorm.get(a))
      if (hit) { val = hit; break }
    }
    out[canonical] = val
  }
  return out
}

/**
 * Normalise a district value for comparison/display.
 * Numeric-ish values ("District 04", "04", "4th") collapse to "4" so the CSV's
 * own string matches offices.district_number. Everything else (school district
 * NAMES, ward labels like "Ward 3B") keeps its text, whitespace-collapsed.
 */
export function normalizeDistrictValue(v) {
  const s = cleanCell(v)
  if (!s) return ''
  const m = s.match(/^\D*?(\d+)(?:st|nd|rd|th)?\D*$/i)
  if (m) return String(parseInt(m[1], 10))
  return s
}

/** Case/space-insensitive equality for district values. */
export function districtValuesMatch(a, b) {
  const na = normalizeDistrictValue(a).toLowerCase()
  const nb = normalizeDistrictValue(b).toLowerCase()
  return Boolean(na) && na === nb
}

// ─── Office type → district column ───────────────────────────────────────────
// The recruit-eligible universe is sub-state seats only. Federal and state rows
// (which is where every statewide and state-legislative office lives) are
// excluded BY LEVEL, so there is no separate "exclude statewide" filter to keep
// in sync — see gameplan §2.

export const EXCLUDED_OFFICE_LEVELS = ['federal', 'state']

/**
 * The office types Recruit supports, in menu order.
 *   districtColumn — the `voters` column whose value identifies the seat
 *   scope          — which geography narrows the office list (county|municipal|school)
 *   atLarge        — true when the body is elected at large / by seat number, so
 *                    the district column is a coarse resident filter, not the seat.
 */
export const RECRUIT_OFFICE_TYPES = [
  {
    key: 'county_board',
    label: 'County Board',
    seatLabel: 'County Board Supervisor',
    districtColumn: 'county_supervisory_district',
    districtLabel: 'Supervisory District',
    scope: 'county',
    levels: ['county'],
    match: /county board (of )?supervisor|county supervisor/i,
    atLarge: false,
  },
  {
    key: 'city_council',
    label: 'City Council',
    seatLabel: 'Alderperson / Council Member',
    districtColumn: 'aldermanic_district',
    districtLabel: 'Aldermanic District',
    scope: 'municipal',
    levels: ['municipal'],
    match: /common council|city council|alder(man|person|woman)?\b/i,
    atLarge: false,
  },
  {
    key: 'village_board',
    label: 'Village Board',
    seatLabel: 'Village Trustee',
    districtColumn: 'ward',
    districtLabel: 'Ward',
    scope: 'municipal',
    levels: ['municipal'],
    match: /village of .*(trustee|board|president)|village (board|trustee|president)/i,
    atLarge: true,
  },
  {
    key: 'town_board',
    label: 'Town Board',
    seatLabel: 'Town Supervisor / Chair',
    districtColumn: 'ward',
    districtLabel: 'Ward',
    scope: 'municipal',
    levels: ['municipal'],
    match: /town of .*(board|supervisor|chair)|town (board|supervisor|chairperson)/i,
    atLarge: true,
  },
  {
    key: 'school_board',
    label: 'School Board',
    seatLabel: 'School Board Member',
    districtColumn: 'school_district',
    districtLabel: 'School District',
    scope: 'school',
    levels: ['municipal', 'county'],
    // Seeded as "<X> School District Board — Seat N" / "Board of Education".
    match: /school district board|school board|board of education|public schools board/i,
    atLarge: true,
  },
]

const TYPE_BY_KEY = new Map(RECRUIT_OFFICE_TYPES.map(t => [t.key, t]))

/** @returns {object|undefined} the office-type descriptor for a key. */
export function recruitOfficeType(key) {
  return TYPE_BY_KEY.get(key)
}

/** THE MAPPING (office type → voters column). Returns '' for an unknown key. */
export function districtColumnForOfficeType(key) {
  return TYPE_BY_KEY.get(key)?.districtColumn || ''
}

/** Federal / state rows never qualify — that is the statewide exclusion. */
export function isRecruitEligibleLevel(level) {
  return Boolean(level) && !EXCLUDED_OFFICE_LEVELS.includes(String(level).toLowerCase())
}

/**
 * Classify one `offices` row into a Recruit office type.
 * @returns {string|null} office-type key, or null when the seat is out of scope
 *          (federal, state, statewide, state-legislative, or a county/municipal
 *          row office like Sheriff or Register of Deeds that is not a board seat).
 */
export function classifyOffice(office) {
  if (!office) return null
  if (!isRecruitEligibleLevel(office.level)) return null
  const name = String(office.name || '')
  for (const t of RECRUIT_OFFICE_TYPES) {
    if (!t.levels.includes(String(office.level).toLowerCase())) continue
    if (t.match.test(name)) return t.key
  }
  return null
}

/**
 * Enumerate the office types actually present in the offices DB, with counts —
 * the picker is driven by data, never by a hard-coded menu.
 * @param {Array} offices  rows from the `offices` table
 */
export function availableOfficeTypes(offices = []) {
  const counts = new Map()
  for (const o of offices) {
    const key = classifyOffice(o)
    if (!key) continue
    counts.set(key, (counts.get(key) || 0) + 1)
  }
  return RECRUIT_OFFICE_TYPES
    .filter(t => counts.has(t.key))
    .map(t => ({ ...t, officeCount: counts.get(t.key) }))
}

/** Offices of one recruit type, optionally narrowed to a county/municipality. */
export function officesForType(offices = [], typeKey, { county, city } = {}) {
  return offices.filter(o => {
    if (classifyOffice(o) !== typeKey) return false
    if (county && String(o.county || '').toLowerCase() !== String(county).toLowerCase()) return false
    if (city && String(o.city || '').toLowerCase() !== String(city).toLowerCase()) return false
    return true
  })
}

// ─── District picker + resident matching (Tier A) ────────────────────────────

/**
 * Distinct district values present in the voter list for an office type.
 * This is what drives the district picker in v1.
 *
 * MAP-GEOMETRY INTEGRATION POINT (Tier B, deferred): when ward/supervisory/
 * aldermanic polygons land in public/geodata, the picker becomes a map click
 * and this function stays as the fallback for lists whose columns are populated.
 */
export function districtOptionsFromVoters(voters = [], typeKey) {
  const col = districtColumnForOfficeType(typeKey)
  if (!col) return []
  const seen = new Map()
  for (const v of voters) {
    const norm = normalizeDistrictValue(v?.[col])
    if (!norm) continue
    const k = norm.toLowerCase()
    const cur = seen.get(k)
    if (cur) cur.count++
    else seen.set(k, { value: norm, count: 1 })
  }
  return [...seen.values()].sort((a, b) => {
    const na = Number(a.value), nb = Number(b.value)
    const aNum = Number.isFinite(na), bNum = Number.isFinite(nb)
    if (aNum && bNum) return na - nb
    if (aNum) return -1
    if (bNum) return 1
    return a.value.localeCompare(b.value)
  })
}

/** Residents of the selected district — the confirmed-resident list. */
export function matchVotersToDistrict(voters = [], typeKey, districtValue) {
  const col = districtColumnForOfficeType(typeKey)
  if (!col || !districtValue) return []
  return voters.filter(v => districtValuesMatch(v?.[col], districtValue))
}

/**
 * Does this list carry the column the chosen office type needs?
 * Drives the "re-export from Badger Voters with those columns" banner (§1).
 */
export function listSupportsOfficeType(voters = [], typeKey) {
  const col = districtColumnForOfficeType(typeKey)
  if (!col) return false
  return voters.some(v => Boolean(cleanCell(v?.[col])))
}

// ─── Research output: validation + Unknown coercion ──────────────────────────

export const AFFILIATION_VALUES = ['republican', 'democrat', 'independent', 'other', 'unknown']
export const NOTORIETY_VALUES   = ['high', 'medium', 'low', 'unknown']
export const SENTIMENT_VALUES   = ['positive', 'mixed', 'negative', 'unknown']
export const RESEARCH_STATUSES  = ['pending', 'researching', 'done', 'error', 'skipped_quota']

/** Thin evidence ⇒ Unknown. Fewer than this many INDEPENDENT sources = unknown. */
export const MIN_INDEPENDENT_SOURCES = 2

/**
 * Protected attributes that must never be researched, structured or stored —
 * gameplan §4. Applied as a hard code-level filter on top of the prompt rule,
 * because a prompt rule alone is not a guarantee.
 */
export const PROTECTED_ATTRIBUTE_PATTERNS = [
  /\b(race|racial|ethnicity|ethnic|black|white|hispanic|latino|asian|african[- ]american|native american)\b/i,
  // Religion includes membership signals (congregation, parish, church), which
  // are religious affiliation by another name. Over-scrubbing here is the safe
  // direction: a dropped sentence costs nothing, a stored one is a §4 breach.
  /\b(religion|religious|christian|catholic|protestant|jewish|muslim|islam|hindu|buddhist|atheist|mormon|evangelical|church|congregation|parish|synagogue|mosque)\b/i,
  /\b(national origin|immigration status|immigrant|undocumented|green card|visa status|citizenship status)\b/i,
  /\b(disabled|disability|handicap|wheelchair)\b/i,
  /\b(gay|lesbian|bisexual|transgender|LGBTQ?\+?|sexual orientation|gender identity)\b/i,
  /\b(health|medical|illness|diagnosis|cancer|HIV|mental health|addiction|rehab|pregnan(t|cy))\b/i,
  /\b(arrest(ed)?|convict(ed|ion)|felony|misdemeanor|criminal record|jail|prison|DUI|OWI)\b/i,
]

/** True when free text mentions a protected attribute (see §4). */
export function hasProtectedAttribute(text) {
  const s = String(text || '')
  if (!s) return false
  return PROTECTED_ATTRIBUTE_PATTERNS.some(re => re.test(s))
}

/** Drop any free-text field that trips the protected-attribute filter. */
export function scrubProtectedText(text) {
  return hasProtectedAttribute(text) ? '' : String(text || '').trim()
}

function safeHost(url) {
  try {
    const u = new URL(String(url))
    if (!/^https?:$/.test(u.protocol)) return null
    return u.hostname.replace(/^www\./i, '').toLowerCase()
  } catch { return null }
}

/**
 * Keep only real, http(s), de-duplicated {title,url} evidence items.
 * No fabricated URLs: callers pass `allowedUrls` (Perplexity's citations array)
 * and anything not in it is dropped rather than trusted.
 */
export function sanitizeEvidence(list, { allowedUrls = null, cap = 12 } = {}) {
  const allow = allowedUrls
    ? new Set(allowedUrls.map(u => String(u).trim()).filter(Boolean))
    : null
  const out = []
  const seen = new Set()
  for (const raw of Array.isArray(list) ? list : []) {
    const url = String(raw?.url || '').trim()
    const host = safeHost(url)
    if (!host) continue
    if (allow && !allow.has(url)) continue
    if (seen.has(url)) continue
    const title = scrubProtectedText(raw?.title).slice(0, 200) || host
    seen.add(url)
    out.push({ title, url })
    if (out.length >= cap) break
  }
  return out
}

/** Independent sources = distinct hostnames. Three links to one paper is one. */
export function independentSourceCount(evidence = []) {
  const hosts = new Set()
  for (const e of evidence) {
    const h = safeHost(e?.url)
    if (h) hosts.add(h)
  }
  return hosts.size
}

function oneOf(value, allowed) {
  const v = String(value ?? '').trim().toLowerCase()
  return allowed.includes(v) ? v : 'unknown'
}

/**
 * Validate + coerce whatever the structuring model returned into the stored
 * schema. Two hard rules from gameplan §3.3/§4 live HERE, not in the UI:
 *   1. fewer than MIN_INDEPENDENT_SOURCES independent public sources ⇒ every
 *      field becomes "unknown";
 *   2. any free text mentioning a protected attribute is dropped.
 *
 * @param {object} raw            model output
 * @param {object} [opts]
 * @param {string[]} [opts.allowedUrls]  Perplexity citation URLs (anti-fabrication)
 * @returns {{affiliation:{value:string,confidence:number|null,basis:string},
 *            notoriety:string, sentiment:string,
 *            evidence:Array<{title:string,url:string}>,
 *            summary:string, thin:boolean, source_count:number}}
 */
export function coerceResearchOutput(raw, opts = {}) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const evidence = sanitizeEvidence(src.evidence, opts)
  const sourceCount = independentSourceCount(evidence)
  const thin = sourceCount < MIN_INDEPENDENT_SOURCES

  const affRaw = src.affiliation
  const affObj = affRaw && typeof affRaw === 'object' ? affRaw : null
  const affValue = oneOf(affObj ? affObj.value : affRaw, AFFILIATION_VALUES)
  let confidence = Number(affObj ? affObj.confidence : src.affiliation_confidence)
  confidence = Number.isFinite(confidence) ? Math.max(0, Math.min(100, Math.round(confidence))) : null
  const basis = scrubProtectedText((affObj ? affObj.basis : src.affiliation_basis) || '').slice(0, 400)

  const out = {
    affiliation: { value: affValue, confidence, basis },
    notoriety:   oneOf(src.notoriety, NOTORIETY_VALUES),
    sentiment:   oneOf(src.sentiment, SENTIMENT_VALUES),
    evidence,
    summary:     scrubProtectedText(src.summary).slice(0, 1200),
    thin,
    source_count: sourceCount,
  }

  if (thin) {
    // Thin evidence ⇒ Unknown, always. Evidence links are kept so the user can
    // still see what little was found, but no label is asserted from it.
    out.affiliation = { value: 'unknown', confidence: null, basis: '' }
    out.notoriety = 'unknown'
    out.sentiment = 'unknown'
    out.summary = ''
  }
  return out
}

/** Flatten the coerced output into `recruitment_prospects` columns. */
export function researchOutputToRow(coerced) {
  return {
    affiliation_value:      coerced.affiliation.value,
    affiliation_confidence: coerced.affiliation.confidence,
    affiliation_basis:      coerced.affiliation.basis || null,
    notoriety:              coerced.notoriety,
    sentiment:              coerced.sentiment,
    evidence:               coerced.evidence,
    research_summary:       coerced.summary || null,
  }
}

/** Stable cache key for cross-search reuse: normalize(name + city + zip). */
export function researchCacheKey({ full_name, city, zip } = {}) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '')
  const key = [norm(full_name), norm(city), norm(zip).slice(0, 5)].join('|')
  return key === '||' ? '' : key
}

/** True when every research field is unknown — powers "Exclude unknowns". */
export function isUnknownProspect(p) {
  return (p?.affiliation_value || 'unknown') === 'unknown'
    && (p?.notoriety || 'unknown') === 'unknown'
    && (p?.sentiment || 'unknown') === 'unknown'
}
