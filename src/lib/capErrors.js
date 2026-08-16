// src/lib/capErrors.js — plan-cap DB errors → copy a human can act on.
//
// Two BEFORE-triggers raise plan caps from Postgres:
//   scout_candidate_cap (migration 20260812000030) — "Scout plans track up to 2
//     candidates. Upgrade to add more."
//   monitoring_cap      (migrations 20260812000032 / …040) — "Your plan includes
//     N active monitoring slot(s). Turn monitoring off on another candidate or
//     upgrade."
//
// PostgREST hands these back as a 400 whose message is the raw RAISE text —
// sometimes wrapped, sometimes with the P0001 detail attached — so each sniffer
// matches a stable fragment rather than the whole string.
//
// These lived as private helpers inside Candidates.jsx, which is why the
// monitoring toggle on CandidateDetail.jsx had no way to say anything at all
// when the cap fired: it just snapped the switch back. Both pages import from
// here now.

const rawText = (error) => {
  if (!error) return ''
  if (typeof error === 'string') return error
  return [error.message, error.details, error.hint].filter(Boolean).join(' ')
}

// ── Scout candidate cap ──────────────────────────────────────────────────────

export const SCOUT_CAP_MESSAGE = 'Scout plans track up to 2 candidates. Upgrade to add more.'

export function scoutCapMessage(error) {
  return rawText(error).includes('Scout plans track') ? SCOUT_CAP_MESSAGE : null
}

// ── Active monitoring slot cap ───────────────────────────────────────────────

export const MONITORING_CAP_MESSAGE =
  'Every active monitoring slot on your plan is in use. Turn monitoring off on another candidate, or upgrade.'

/**
 * The trigger's own sentence names the caller's slot count, which is better
 * copy than anything we can reconstruct on the client — so lift it verbatim
 * when it survived the wrapping, and fall back to the generic sentence when it
 * didn't. Returns null when this error is about something else entirely, so the
 * caller can show the real message instead of pretending it was a cap.
 */
export function monitoringCapMessage(error) {
  const raw = rawText(error)
  if (!raw.includes('active monitoring slot')) return null
  const m = raw.match(/Your plan includes \d+ active monitoring slots?\.[^.]*\./)
  return m ? m[0] : MONITORING_CAP_MESSAGE
}

/**
 * What to show the user when a monitoring toggle fails: the friendly cap
 * sentence when it was the cap, otherwise the real error text. Never null —
 * a silently reverted switch is the one outcome that isn't allowed.
 */
export function monitoringToggleError(error) {
  return monitoringCapMessage(error)
    || rawText(error)
    || 'Could not update monitoring. Please try again.'
}
