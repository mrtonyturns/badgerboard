// src/lib/prospectCsv.js
// ─── Prospecting v2 CSV export ────────────────────────────────────────────────
// PURE module (no DOM, no fetch, no clock) so the export is unit-tested in
// tests/prospecting.test.mjs rather than eyeballed in a download.
//
// The export is the product: an agency pays for a list it can work. So every
// enriched field ships, each contact point carries its source and confidence,
// and the win-odds column is accompanied by the factors that produced it.
//
// COMPLIANCE: nothing derived from WEC/CFIS campaign-finance filings is
// exported, because nothing derived from them is collected — see
// netlify/functions/enrich-prospects-background.js. If a CFIS column is ever
// added after legal sign-off (Wis. Stat. §11.1304(12)), it must be added here
// deliberately, not inherited by a `for (const key of Object.keys(row))` loop.
// That is why COLUMNS below is an explicit allowlist.

/** RFC-4180 field escaping: quote when needed, double any inner quotes. */
export function csvEscape(value) {
  if (value === null || value === undefined) return ''
  const s = String(value)
  if (s === '') return ''
  // Leading =, +, -, @ are spreadsheet formula injection vectors.
  const guarded = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s
  return /[",\n\r]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded
}

const socialsOf = (row) => (row && typeof row.socials === 'object' && row.socials) || {}
const agencyOf = (row) => (row && typeof row.agency_signals === 'object' && row.agency_signals) || {}
const contactOf = (row) => (row && typeof row.contact === 'object' && row.contact) || {}
const factorsOf = (row) => {
  const f = (row && typeof row.win_odds_factors === 'object' && row.win_odds_factors) || {}
  return Array.isArray(f.factors) ? f.factors : []
}

/** True when win odds came from the v3 AI estimate rather than the weighted model. */
export const isEstimate = (row) => {
  const f = (row && typeof row.win_odds_factors === 'object' && row.win_odds_factors) || {}
  return Boolean(f.estimate) || /^ai_estimate/.test(String(f.model_version || ''))
}

/**
 * The WHY, in one cell. Deep mode: "Incumbency 25 pts · District lean 18.8 pts".
 * Brief mode (v3): the AI estimate's one-line rationale.
 */
export function factorSummary(row) {
  if (isEstimate(row)) {
    const r = row?.win_odds_factors?.rationale
    return r ? `AI estimate: ${r}` : 'AI estimate'
  }
  return factorsOf(row)
    .filter(f => f.available)
    .map(f => `${f.label} ${f.points ?? 0} pts`)
    .join(' · ')
}


/**
 * Apollo-style qualitative confidence bands (owner decision #3). One source of
 * truth for the UI pills AND the CSV, so the vocabulary round-trips:
 *   >= 85  Verified · >= 60  Likely · otherwise  Unconfirmed
 */
export const confidenceBand = (c) => {
  if (c == null || Number.isNaN(Number(c))) return ''
  const n = Number(c)
  if (n >= 85) return 'Verified'
  if (n >= 60) return 'Likely'
  return 'Unconfirmed'
}

const listContacts = (items) => (Array.isArray(items) ? items : [])
  .map(i => (i && typeof i === 'object' ? i.value : i))
  .filter(Boolean)
  .join('; ')

const listContactSources = (items) => (Array.isArray(items) ? items : [])
  .filter(i => i && typeof i === 'object' && i.value)
  .map(i => `${i.value} (${confidenceBand(i.confidence) || 'Unconfirmed'}${i.confidence != null ? ` ${i.confidence}%` : ''}, ${i.source || 'unknown'})`)
  .join('; ')

/**
 * Explicit column allowlist: [header, accessor]. Order is the export order.
 */
export const COLUMNS = [
  ['Name',                r => r.name],
  ['Office',              r => r.office_name],
  ['District',            r => r.district_name],
  ['County',              r => r.county],
  ['Level',               r => r.level],
  ['Election date',       r => r.election_date],
  ['Win odds',            r => (r.win_odds_score == null ? '' : r.win_odds_score)],
  ['Win odds band',       r => r.win_odds_band],
  ['Win odds confidence', r => {
    if (isEstimate(r)) return r.win_odds_score == null ? '' : 'AI estimate'
    const c = r.win_odds_factors?.confidence
    return c == null ? '' : `${Math.round(Number(c) * 100)}%`
  }],
  ['Win odds factors',    r => factorSummary(r)],
  ['Affiliation',         r => r.affiliation],
  ['Affiliation basis',   r => {
    const d = r.affiliation_detail || {}
    if (!d.basis && !d.confidence) return ''
    return `${d.inferred ? 'INFERRED' : 'declared'}${d.confidence != null ? ` ${d.confidence}%` : ''}${d.basis ? ` — ${d.basis}` : ''}`
  }],
  ['Website',             r => r.website_state],
  ['Website URL',         r => r.website_url],
  ['Facebook',            r => socialsOf(r).facebook],
  ['Instagram',           r => socialsOf(r).instagram],
  ['X',                   r => socialsOf(r).x],
  ['LinkedIn',            r => socialsOf(r).linkedin],
  ['TikTok',              r => socialsOf(r).tiktok],
  ['Agency detected',     r => (agencyOf(r).detected ? 'yes' : 'no')],
  ['Agency confidence',   r => (agencyOf(r).confidence == null ? '' : agencyOf(r).confidence)],
  ['Agency evidence',     r => (Array.isArray(agencyOf(r).evidence) ? agencyOf(r).evidence : [])
    .map(e => `${e.type}: ${e.detail}${e.url ? ` (${e.url})` : ''}`).join(' | ')],
  ['Emails',              r => listContacts(contactOf(r).emails)],
  ['Email confidence band', r => {
    const best = (contactOf(r).emails || []).filter(Boolean).sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))[0]
    return best ? confidenceBand(best.confidence) : ''
  }],
  ['Email sources',       r => listContactSources(contactOf(r).emails)],
  ['Phone confidence band', r => {
    const best = (contactOf(r).phones || []).filter(Boolean).sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))[0]
    return best ? confidenceBand(best.confidence) : ''
  }],
  ['Phones',              r => listContacts(contactOf(r).phones)],
  ['Phone sources',       r => listContactSources(contactOf(r).phones)],
  ['Contact source',      r => contactOf(r).source],
  ['Contact confidence',  r => (contactOf(r).confidence == null ? '' : contactOf(r).confidence)],
  ['Enrichment status',   r => r.enrichment_status],
  ['Enriched at',         r => r.enriched_at],
  ['Sources',             r => (Array.isArray(r.research_citations) ? r.research_citations : [])
    .map(c => c.url).filter(Boolean).join(' | ')],
]

/**
 * Build the CSV text for a set of enriched prospect_profiles rows.
 * @param {Array<object>} rows
 * @returns {string} CRLF-delimited CSV including the header row
 */
export function buildProspectCsv(rows) {
  const list = Array.isArray(rows) ? rows : []
  const lines = [COLUMNS.map(c => csvEscape(c[0])).join(',')]
  for (const row of list) {
    lines.push(COLUMNS.map(([, get]) => {
      let v
      try { v = get(row || {}) } catch { v = '' }
      return csvEscape(v)
    }).join(','))
  }
  return lines.join('\r\n')
}

/** Filename-safe stamp for the download, e.g. prospects_2026-08-12.csv */
export function csvFilename(prefix = 'prospects', date = new Date()) {
  const iso = date instanceof Date && !Number.isNaN(+date)
    ? date.toISOString().slice(0, 10)
    : String(date).slice(0, 10)
  return `${String(prefix).replace(/[^\w-]+/g, '_').slice(0, 60) || 'prospects'}_${iso}.csv`
}
