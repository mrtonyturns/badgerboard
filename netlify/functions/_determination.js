// netlify/functions/_determination.js
// ─── Contest status determination engine (Phase 1) ───────────────────────────
//
// SPEC: RESULTS-live-election-game-plan.md → "Determination engine".
//
// Pure, deterministic, no AI, no network, no I/O. Given a contest's candidate
// vote rows and its precinct counts, it decides which of the seven statuses
// the contest is in and returns a human-readable trace of *why*.
//
// The leading underscore keeps Netlify from publishing this as an endpoint.
//
//   determineStatus({ results, precinctsTotal, precinctsRptg, seats })
//     → { status, detail }
//
// Rules, evaluated in this order (N = seats, default 1):
//
//   1. no result rows, or every candidate at 0 votes        → 'waiting'
//   2. 100% precincts reporting (rptg >= total > 0):
//        · fewer than N+1 candidates with votes             → 'called' (unopposed)
//        · margin_pct <= 1.0                                → 'recount_possible'
//          (detail.fee_free = margin_pct <= 0.25)
//        · otherwise                                        → 'called'
//   3. reporting_pct >= 95 and margin_pct < 0.5             → 'too_close'
//   4. projection — ONLY when reporting_pct >= 60 AND rptg >= 5:
//        outstanding_ceiling = (total - rptg) * (total_votes / rptg) * 1.5
//        margin > outstanding_ceiling                       → 'projected'
//   5. otherwise                                            → 'reporting'
//
// "margin" is the Nth-place candidate's votes minus the (N+1)th-place
// candidate's votes — for a single-seat race that is simply first minus
// second. "margin_pct" is that margin as a share of ALL votes cast in the
// contest.
//
// The projection rule is deliberately conservative: these projections are
// public, and a wrong "victory likely" is far worse than a slow one. The 1.5x
// safety factor assumes every outstanding precinct is 50% larger than the
// average precinct counted so far, and that every outstanding ballot breaks
// against the leader.
//
// This function never throws. Garbage in → {status:'waiting', reason:'insufficient data'}.

const ALLOWED_STATUSES = [
  'waiting', 'reporting', 'projected', 'called',
  'too_close', 'recount_possible', 'certified',
]

// Wisconsin recount thresholds (Wis. Stat. § 9.01)
const RECOUNT_PCT   = 1.0    // margin at or under 1% → recount may be petitioned
const FEE_FREE_PCT  = 0.25   // margin at or under 0.25% → petitioner pays no fee
const TOO_CLOSE_PCT = 0.5    // <0.5% at >=95% reporting → too close to call
const TOO_CLOSE_REPORTING_PCT = 95

// Projection guards
const PROJECT_MIN_REPORTING_PCT = 60
const PROJECT_MIN_PRECINCTS     = 5
const PROJECT_SAFETY_FACTOR     = 1.5

const round = (n, places = 4) => {
  const f = Math.pow(10, places)
  return Math.round((Number(n) + Number.EPSILON) * f) / f
}

// Non-negative integer, or 0. Rejects NaN, Infinity, negatives, objects, null.
const toCount = (v) => {
  const n = typeof v === 'string' ? Number(v.trim()) : Number(v)
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.floor(n)
}

const nf = (n) => Number(n).toLocaleString('en-US')

function insufficient(reason) {
  return {
    status: 'waiting',
    detail: { reason: reason || 'insufficient data', computed_at: new Date().toISOString() },
  }
}

/**
 * @param {Object}   input
 * @param {Array}    input.results          rows like { votes } (extra fields ignored)
 * @param {number}   input.precinctsTotal
 * @param {number}   input.precinctsRptg
 * @param {number}   [input.seats=1]
 * @returns {{status: string, detail: Object}}
 */
function determineStatus(input) {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return insufficient()
    const { results, precinctsTotal, precinctsRptg, seats } = input
    if (!Array.isArray(results)) return insufficient()

    const computed_at = new Date().toISOString()
    const seatCount   = Math.max(1, toCount(seats) || 1)
    const total       = toCount(precinctsTotal)
    // Reported can never exceed the total — bad feeds do this, and it would
    // otherwise push reporting_pct past 100.
    const rptg        = total > 0 ? Math.min(toCount(precinctsRptg), total) : toCount(precinctsRptg)

    const tallies    = results.map(r => toCount(r && r.votes)).sort((a, b) => b - a)
    const totalVotes = tallies.reduce((s, v) => s + v, 0)
    const reporting_pct = total > 0 ? round((rptg / total) * 100, 2) : 0

    // ── 1. Nothing to decide ────────────────────────────────────────────────
    if (!tallies.length || totalVotes <= 0) {
      return {
        status: 'waiting',
        detail: {
          margin: 0, margin_pct: 0, total_votes: 0, reporting_pct,
          reason: 'No votes reported yet.',
          computed_at,
        },
      }
    }

    // ── Margin: Nth place minus (N+1)th place ───────────────────────────────
    // Fewer than N+1 candidates means nobody can be displaced from a seat —
    // the contest is effectively uncontested for the seats available.
    const unopposed = tallies.length <= seatCount
    const nth       = tallies[Math.min(seatCount, tallies.length) - 1] || 0
    const margin    = unopposed ? nth : Math.max(0, nth - tallies[seatCount])
    const marginPctRaw = (margin / totalVotes) * 100
    const margin_pct   = round(marginPctRaw, 4)

    const base = { margin, margin_pct, total_votes: totalVotes, reporting_pct, computed_at }
    if (unopposed) base.unopposed = true

    const seatPhrase = seatCount > 1 ? `the candidate holding seat ${seatCount}` : 'the leader'
    const allIn      = total > 0 && rptg >= total

    // ── 2. All precincts in ─────────────────────────────────────────────────
    if (allIn) {
      if (unopposed) {
        return {
          status: 'called',
          detail: {
            ...base,
            reason: `All ${nf(total)} precincts reporting and no candidate can be displaced — uncontested for the ${seatCount === 1 ? 'seat' : `${seatCount} seats`} available.`,
          },
        }
      }
      if (marginPctRaw <= RECOUNT_PCT) {
        const fee_free = marginPctRaw <= FEE_FREE_PCT
        return {
          status: 'recount_possible',
          detail: {
            ...base,
            fee_free,
            reason: `All ${nf(total)} precincts reporting with a final unofficial margin of ${margin_pct}% (${nf(margin)} votes) — at or under Wisconsin's 1% recount-petition threshold${fee_free ? ', and inside the 0.25% band where the recount is fee-free' : ''}.`,
          },
        }
      }
      return {
        status: 'called',
        detail: {
          ...base,
          reason: `All ${nf(total)} precincts reporting; ${seatPhrase} is ahead by ${nf(margin)} votes (${margin_pct}%), beyond any recount threshold.`,
        },
      }
    }

    // ── 3. Too close to call ────────────────────────────────────────────────
    if (reporting_pct >= TOO_CLOSE_REPORTING_PCT && marginPctRaw < TOO_CLOSE_PCT) {
      return {
        status: 'too_close',
        detail: {
          ...base,
          reason: `${reporting_pct}% of precincts reporting and the margin is only ${margin_pct}% (${nf(margin)} votes) — too close to call.`,
        },
      }
    }

    // ── 4. Conservative projection ──────────────────────────────────────────
    if (total > 0 && rptg >= PROJECT_MIN_PRECINCTS && reporting_pct >= PROJECT_MIN_REPORTING_PCT) {
      const outstanding_ceiling = round((total - rptg) * (totalVotes / rptg) * PROJECT_SAFETY_FACTOR, 2)
      const projBase = { ...base, outstanding_ceiling }
      if (margin > outstanding_ceiling) {
        return {
          status: 'projected',
          detail: {
            ...projBase,
            reason: `With ${reporting_pct}% of precincts in, ${seatPhrase} is ahead by ${nf(margin)} votes — more than the ${nf(outstanding_ceiling)}-vote ceiling on everything still outstanding. Projected, not final.`,
          },
        }
      }
      return {
        status: 'reporting',
        detail: {
          ...projBase,
          reason: `${reporting_pct}% of precincts reporting; the ${nf(margin)}-vote margin is still inside the ${nf(outstanding_ceiling)}-vote ceiling on outstanding ballots.`,
        },
      }
    }

    // ── 5. Reporting ────────────────────────────────────────────────────────
    return {
      status: 'reporting',
      detail: {
        ...base,
        reason: total > 0
          ? `${reporting_pct}% of precincts reporting (${nf(rptg)} of ${nf(total)}); too early to decide anything.`
          : `${nf(totalVotes)} votes counted, but no precinct totals are available, so nothing can be projected.`,
      },
    }
  } catch {
    return insufficient('insufficient data')
  }
}

module.exports = {
  determineStatus,
  ALLOWED_STATUSES,
  THRESHOLDS: {
    RECOUNT_PCT, FEE_FREE_PCT, TOO_CLOSE_PCT, TOO_CLOSE_REPORTING_PCT,
    PROJECT_MIN_REPORTING_PCT, PROJECT_MIN_PRECINCTS, PROJECT_SAFETY_FACTOR,
  },
}
