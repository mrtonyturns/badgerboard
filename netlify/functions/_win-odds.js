// netlify/functions/_win-odds.js
// ─── Transparent win-odds scoring model (Prospecting v2) ─────────────────────
// Prefixed with _ so Netlify does NOT deploy this as an endpoint.
//
// This is a PURE module: no network, no database, no clock, no randomness, no
// mutation of its inputs. Everything it needs arrives in one plain object and
// everything it decides comes back in one plain object. That is deliberate —
// the score is shown to paying users with a "why this number" breakdown, so it
// has to be reproducible, testable (tests/prospecting.test.mjs) and auditable.
//
//   const { computeWinOdds } = require('./_win-odds')
//   const odds = computeWinOdds({ is_incumbent: true, contested: false, ... })
//   odds.score    // 0–100, or null when nothing could be measured
//   odds.factors  // one row per factor: weight, value, points, basis, source
//
// ── Weights (PROSPECTING-redesign-gameplan.md §4a) ───────────────────────────
//   Incumbency ................ 25%
//   District / seat lean ...... 25%
//   Fundraising ratio ......... 20%   ← DISABLED, see the compliance note below
//   Primary result margin ..... 15%
//   Contested vs uncontested .. 10%
//   Seat "flip" history ....... 5%
//
// ── Why fundraising is disabled ──────────────────────────────────────────────
// The game plan sources the fundraising ratio from CFIS/WEC (and FEC for
// federal races). Per the owner's compliance directive, Badger Board does NOT
// ingest or store CFIS campaign-finance data pending a legal read of
// Wis. Stat. §11.1304(12) ("No information copied from such reports and
// statements may be sold or utilized by any person for any commercial
// purpose."). The factor is therefore defined here — with its game-plan weight
// intact — but flagged `enabled: false`, so it never contributes to a score and
// never appears in the UI breakdown as if it had been measured. Turning it on
// after legal sign-off is a one-line change (`enabled: true`) plus a caller
// that supplies `fundraising_ratio`; nothing else in the model moves.
//
// ── How a missing factor is handled ──────────────────────────────────────────
// Down-ballot Wisconsin races have thin data. Rather than invent a neutral
// value for a factor we could not measure (which quietly drags every score
// toward 50 and lies about what we know), an unmeasured factor is dropped and
// the remaining weights are RENORMALIZED over what was actually available. The
// share of total weight that WAS available is reported as `confidence`, so the
// UI can say "computed from 65% of the model" instead of pretending.

/** Clamp n into [lo, hi]. Non-finite input returns lo. */
function clamp(n, lo = 0, hi = 1) {
  const v = Number(n)
  if (!Number.isFinite(v)) return lo
  return v < lo ? lo : v > hi ? hi : v
}

const MODEL_VERSION = 'win-odds-v1 (gameplan §4a weights; fundraising withheld pending §11.1304(12) legal read)'

/**
 * Factor table. `weight` is the game plan's weight; `enabled: false` means the
 * factor is defined but excluded from the model (see the compliance note).
 */
const FACTORS = [
  { key: 'incumbency',     weight: 0.25, enabled: true,  label: 'Incumbency',
    source: 'candidates.status / is_incumbent' },
  { key: 'district_lean',  weight: 0.25, enabled: true,  label: 'District lean',
    source: 'election_results history for the seat' },
  { key: 'fundraising',    weight: 0.20, enabled: false, label: 'Fundraising ratio',
    source: 'CFIS / FEC — withheld pending legal review of Wis. Stat. §11.1304(12)' },
  { key: 'primary_margin', weight: 0.15, enabled: true,  label: 'Primary margin',
    source: 'election_results (our own primary pipeline)' },
  { key: 'contested',      weight: 0.10, enabled: true,  label: 'Contested status',
    source: 'election_results field size / candidates DB' },
  { key: 'seat_history',   weight: 0.05, enabled: true,  label: 'Seat history',
    source: 'prior-cycle election_results for the seat' },
]

const FACTOR_BY_KEY = FACTORS.reduce((m, f) => { m[f.key] = f; return m }, {})

/** Total weight of the factors the model is allowed to use right now. */
const ENABLED_WEIGHT = FACTORS.filter(f => f.enabled).reduce((s, f) => s + f.weight, 0)

// ── Individual factor scorers ────────────────────────────────────────────────
// Each returns { value: 0..1, basis: string } or null when it cannot be
// measured. 0.5 is genuinely neutral; the extremes are reserved for facts.

function scoreIncumbency(i) {
  if (i.is_incumbent === true) {
    if (i.contested === false) return { value: 1, basis: 'Incumbent with no opponent on the ballot' }
    if (i.contested === true)  return { value: 0.72, basis: 'Incumbent in a contested race' }
    return { value: 0.8, basis: 'Incumbent; opposition not yet confirmed' }
  }
  if (i.is_incumbent === false) {
    if (i.seat_history === 'open') return { value: 0.5, basis: 'Open seat — no incumbent to unseat' }
    return { value: 0.3, basis: 'Challenger running against a sitting officeholder' }
  }
  return null
}

/**
 * district_lean is signed points TOWARD this prospect's side (+20 = the seat ran
 * 20 points their way last time). Saturates at ±40 so one blowout cannot pin the
 * whole score.
 */
function scoreDistrictLean(i) {
  const lean = Number(i.district_lean)
  if (!Number.isFinite(lean)) return null
  const value = clamp(0.5 + clamp(lean, -40, 40) / 80, 0, 1)
  const dir = lean > 0 ? 'toward' : lean < 0 ? 'against' : 'even for'
  return {
    value,
    basis: `Seat ran ${Math.abs(Math.round(lean))} pts ${dir} this candidate's side in the last comparable contest`,
  }
}

function scorePrimaryMargin(i) {
  const m = Number(i.primary_margin)
  if (Number.isFinite(m)) {
    const value = clamp(0.5 + clamp(m, -40, 40) / 80, 0, 1)
    return m >= 0
      ? { value, basis: `Won the primary by ${Math.round(m)} pts` }
      : { value, basis: `Trailed the primary winner by ${Math.abs(Math.round(m))} pts` }
  }
  if (i.primary_won === true)  return { value: 0.65, basis: 'Advanced from the primary (margin not recorded)' }
  if (i.primary_won === false) return { value: 0.2,  basis: 'Did not advance from the primary' }
  return null
}

function scoreContested(i) {
  if (i.contested === false) return { value: 1, basis: 'Uncontested' }
  if (i.contested === true) {
    const n = Number(i.field_size)
    if (Number.isFinite(n) && n >= 3) return { value: 0.35, basis: `Contested — ${Math.round(n)}-way field` }
    return { value: 0.45, basis: 'Contested head-to-head race' }
  }
  return null
}

const SEAT_HISTORY = {
  safe_same_party:     { value: 0.85, basis: "Seat has stayed with this candidate's party across recent cycles" },
  open:                { value: 0.5,  basis: 'Open seat — no recent incumbent advantage either way' },
  recent_flip:         { value: 0.4,  basis: 'Seat changed hands recently — genuinely in play' },
  opposite_party_hold: { value: 0.25, basis: "Seat is held by the other side's party" },
}

function scoreSeatHistory(i) {
  const h = SEAT_HISTORY[String(i.seat_history || '')]
  return h ? { value: h.value, basis: h.basis } : null
}

/**
 * Fundraising ratio = this campaign's money ÷ the best-funded opponent's.
 * Log-scaled: 1× neutral, 10× ceiling, 0.1× floor. Only ever consulted if
 * FACTORS.fundraising.enabled flips to true after legal sign-off.
 */
function scoreFundraising(i) {
  const r = Number(i.fundraising_ratio)
  if (!Number.isFinite(r) || r <= 0) return null
  const value = clamp(0.5 + Math.log10(r) / 2, 0, 1)
  return {
    value,
    basis: r >= 1
      ? `Raised ${r.toFixed(1)}× the best-funded opponent`
      : `Raised ${(1 / r).toFixed(1)}× less than the best-funded opponent`,
  }
}

const SCORERS = {
  incumbency:     scoreIncumbency,
  district_lean:  scoreDistrictLean,
  fundraising:    scoreFundraising,
  primary_margin: scorePrimaryMargin,
  contested:      scoreContested,
  seat_history:   scoreSeatHistory,
}

/**
 * Compute the transparent win-odds score.
 *
 * @param {object} inputs
 *   is_incumbent      {boolean|null}
 *   contested         {boolean|null}
 *   field_size        {number|null}   candidates on the ballot for this seat
 *   district_lean     {number|null}   signed pts toward this candidate's side
 *   primary_margin    {number|null}   signed pts vs. the next-best finisher
 *   primary_won       {boolean|null}
 *   seat_history      {'safe_same_party'|'open'|'recent_flip'|'opposite_party_hold'|null}
 *   fundraising_ratio {number|null}   ignored while the factor is disabled
 * @returns {{score:number|null, band:string, confidence:number, factors:Array,
 *            unavailable:string[], model_version:string}}
 */
function computeWinOdds(inputs = {}) {
  const i = inputs || {}
  const factors = []
  const unavailable = []
  let weightAvailable = 0
  let weighted = 0

  for (const f of FACTORS) {
    if (!f.enabled) {
      factors.push({
        key: f.key, label: f.label, weight: f.weight, weight_applied: 0,
        value: null, points: 0, available: false, enabled: false,
        basis: 'Excluded from the model — see source note', source: f.source,
      })
      continue
    }
    const scored = SCORERS[f.key](i)
    if (!scored) {
      unavailable.push(f.key)
      factors.push({
        key: f.key, label: f.label, weight: f.weight, weight_applied: 0,
        value: null, points: 0, available: false, enabled: true,
        basis: 'Not enough public data to measure this factor', source: f.source,
      })
      continue
    }
    weightAvailable += f.weight
    weighted += f.weight * scored.value
    factors.push({
      key: f.key, label: f.label, weight: f.weight, weight_applied: null,
      value: Math.round(scored.value * 1000) / 1000, points: null,
      available: true, enabled: true, basis: scored.basis, source: f.source,
    })
  }

  if (weightAvailable <= 0) {
    return { score: null, band: 'unknown', confidence: 0, factors, unavailable, model_version: MODEL_VERSION }
  }

  // Renormalize over what we could actually measure, then publish each factor's
  // real contribution so the on-screen breakdown adds up to the score.
  const score = Math.round((weighted / weightAvailable) * 100)
  for (const row of factors) {
    if (!row.available) continue
    const applied = row.weight / weightAvailable
    row.weight_applied = Math.round(applied * 1000) / 1000
    row.points = Math.round(applied * row.value * 100 * 10) / 10
  }

  return {
    score,
    band: scoreBand(score),
    confidence: Math.round((weightAvailable / ENABLED_WEIGHT) * 100) / 100,
    factors,
    unavailable,
    model_version: MODEL_VERSION,
  }
}

/** Sales-facing band for a 0–100 score. */
function scoreBand(score) {
  // Number(null) is 0 and Number('') is 0 — an unscored prospect must read
  // "unknown", not "longshot".
  if (score === null || score === undefined || score === '') return 'unknown'
  const s = Number(score)
  if (!Number.isFinite(s)) return 'unknown'
  if (s >= 70) return 'strong'
  if (s >= 45) return 'competitive'
  return 'longshot'
}

/**
 * Derive primary-margin inputs from our own election_results rows for ONE
 * contest. Pure: rows in, numbers out, nothing fetched.
 *
 * @param {Array<{candidate_name:string, votes:number, vote_pct:number}>} rows
 * @param {string} name  the prospect's name as it appears on the ballot
 * @returns {{margin:number, won:boolean, pct:number, field_size:number}|null}
 */
function primaryMarginFromResults(rows, name) {
  if (!Array.isArray(rows) || rows.length < 2 || !name) return null
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim()
  const target = norm(name)
  if (!target) return null

  const totalVotes = rows.reduce((s, r) => s + (Number(r.votes) || 0), 0)
  const pctOf = (r) => {
    const p = Number(r.vote_pct)
    if (Number.isFinite(p) && p > 0) return p
    if (totalVotes > 0) return ((Number(r.votes) || 0) / totalVotes) * 100
    return null
  }

  const scored = rows
    .map(r => ({ name: norm(r.candidate_name), pct: pctOf(r) }))
    .filter(r => r.name && Number.isFinite(r.pct))
  if (scored.length < 2) return null

  // Exact match first, then a unique last-name fallback (ballot names vary).
  let mine = scored.find(r => r.name === target)
  if (!mine) {
    const last = target.split(' ').pop()
    const hits = scored.filter(r => r.name.split(' ').pop() === last)
    if (hits.length === 1) mine = hits[0]
  }
  if (!mine) return null

  const others = scored.filter(r => r !== mine)
  if (!others.length) return null
  const best = others.reduce((a, b) => (b.pct > a.pct ? b : a))
  const margin = mine.pct - best.pct
  return {
    margin: Math.round(margin * 10) / 10,
    won: margin > 0,
    pct: Math.round(mine.pct * 10) / 10,
    field_size: scored.length,
  }
}

module.exports = {
  computeWinOdds,
  primaryMarginFromResults,
  scoreBand,
  clamp,
  FACTORS,
  FACTOR_BY_KEY,
  ENABLED_WEIGHT,
  MODEL_VERSION,
}
