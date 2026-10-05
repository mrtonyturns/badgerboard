// src/lib/candidateImport.js
// ─── Pure helpers for the candidate / prospect CSV imports ───────────────────
// No DOM, no Supabase — unit-tested in tests/candidate-sweep.test.mjs.

const norm = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim()

// "District 87", "87th", "AD 087" → "87"; non-numeric values compare as text.
const districtKey = (s) => {
  const t = norm(s)
  const m = t.match(/\d+/)
  return m ? String(Number(m[0])) : t
}

const cityKey = (s) => norm(s).replace(/^(city|village|town) of /, '').replace(/ (city|village|town)$/, '')

/**
 * Resolve a CSV office cell to ONE office, or null. Office names are not
 * unique ("State Assembly Representative" ×99, a "Mayor" per city), so the old
 * substring match attached rows to whichever office sorted first — and a
 * whitespace-only cell matched every office. Rules:
 *   - the name must match exactly (case/whitespace-insensitive);
 *   - a district and/or city hint drops offices that contradict it, and if
 *     more than one office is still left, keeps only offices that positively
 *     match it;
 *   - anything still ambiguous (or blank) → null. Never guess.
 */
export function matchImportOffice(offices, { office, district, city } = {}) {
  const name = norm(office)
  if (!name) return null
  const d = norm(district) ? districtKey(district) : ''
  const c = cityKey(city)
  const hasDist = (o) => Boolean(norm(o.district_number) || norm(o.district_name))
  const distEq = (o) => (norm(o.district_number) && districtKey(o.district_number) === d)
    || (norm(o.district_name) && (districtKey(o.district_name) === d || norm(o.district_name) === norm(district)))
  const cityEq = (o) => cityKey(o.city) === c

  let pool = (offices || []).filter(o => norm(o?.name) === name)
  pool = pool.filter(o => !(d && hasDist(o) && !distEq(o)) && !(c && cityKey(o.city) && !cityEq(o)))
  if (pool.length > 1 && d) pool = pool.filter(distEq)
  if (pool.length > 1 && c) pool = pool.filter(cityEq)
  return pool.length === 1 ? pool[0] : null
}

const FULL_NAME_HEADERS  = ['name', 'full name', 'fullname', 'candidate name', 'candidate', 'prospect name', 'contact name']
const FIRST_NAME_HEADERS = ['first name', 'firstname', 'first', 'given name']
const LAST_NAME_HEADERS  = ['last name', 'lastname', 'last', 'surname', 'family name']

/**
 * Pick the name column(s) from a CSV header row.
 * Returns { full: i } or { first: i, last: j }, or null when nothing fits.
 * Exact full-name headers win; then a first+last pair is joined; only then the
 * old "first header containing name/candidate" heuristic — which on its own
 * read "First Name,Last Name" as first names only, and "Office Name,Candidate
 * Name" as office names.
 */
export function pickNameColumns(headers) {
  const hs = (headers || []).map(h => norm(String(h ?? '').replace(/[_-]+/g, ' ')))
  const exact = (list) => {
    for (const n of list) { const i = hs.indexOf(n); if (i >= 0) return i }
    return -1
  }
  const full = exact(FULL_NAME_HEADERS)
  if (full >= 0) return { full }
  const first = exact(FIRST_NAME_HEADERS)
  const last  = exact(LAST_NAME_HEADERS)
  if (first >= 0 && last >= 0) return { first, last }
  const loose = hs.findIndex(h => h.includes('name') || h.includes('candidate'))
  return loose >= 0 ? { full: loose } : null
}

/** The name for one CSV row, given pickNameColumns()'s result. */
export function rowName(row, cols) {
  if (!cols) return ''
  const cell = (i) => String(row?.[i] ?? '').trim()
  if (cols.full !== undefined) return cell(cols.full)
  return [cell(cols.first), cell(cols.last)].filter(Boolean).join(' ')
}
