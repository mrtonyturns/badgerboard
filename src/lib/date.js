// src/lib/date.js — ONE crash-proof date coercion, with the contract stated.
//
// Three copies of a "safeISO" helper had grown up independently:
//   • src/pages/dashboard/shared.jsx  → returned null on bad input
//   • src/pages/Elections.jsx         → returned new Date(0) on bad input
//   • src/pages/GamePlan.jsx          → returned new Date(0) on bad input
//
// Those are OPPOSITE contracts, and both are load-bearing where they are used:
//
//   • The dashboards branch on the null (`fmtDate` prints '—', `isUpcoming`
//     refuses to call a dateless row upcoming). Handing them an epoch Date
//     would print "Jan 1, 1970" and file dateless elections under "past".
//   • Elections.jsx / GamePlan.jsx pass the result straight into date-fns
//     (`format`, `isPast`, `isFuture`, `isToday`) with no null check at all.
//     Handing them null throws — an Invalid Date crashes format(), which is the
//     bug the epoch fallback was added to stop.
//
// So the shared module exports both, named for what they return, and each call
// site imports the one it actually needs. Do not "simplify" this to one.

import { parseISO } from 'date-fns'

/**
 * Parse an ISO date string, or null if it is missing / unparseable.
 * Callers MUST handle the null. This is the contract the dashboards rely on.
 * @returns {Date|null}
 */
export const safeISO = (d) => {
  const t = parseISO(String(d ?? ''))
  return Number.isNaN(+t) ? null : t
}

/**
 * Parse an ISO date string, falling back to the epoch (1970-01-01) so the
 * result is always a valid Date that date-fns will accept. An epoch date reads
 * as "long past" to isPast/isFuture, which is the behaviour the calendar pages
 * were built around.
 *
 * Only use this where the result goes straight into date-fns with no null
 * check. If the caller can branch on "no date", use safeISO instead.
 * @returns {Date}
 */
export const safeISOOrEpoch = (d) => safeISO(d) ?? new Date(0)
