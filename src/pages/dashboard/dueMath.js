// src/pages/dashboard/dueMath.js — the dashboards' date arithmetic, extracted
// into a plain (JSX-free) module so tests/r2a.test.mjs can import it under bare
// node. shared.jsx re-exports everything here, so nothing else changed its
// import surface.
//
// ── COUNTDOWN PARITY (UI audit round 2, item 1) ──────────────────────────────
// The dashboards and the calendar pages (Elections.jsx, GamePlan.jsx) must say
// the same number for the same election. Round 2 aligned the dashboards on the
// calendar pages' then-convention, `differenceInDays` — but that counts whole
// elapsed 24h periods, so after midnight a date two calendar days out read
// "1 day" and tomorrow counted 0. The calendar pages have since switched to
// `differenceInCalendarDays`, so the dashboards follow: every count here is in
// calendar days from the start of today (election day 0, tomorrow 1), which
// keeps parity AND makes the words and the number agree.

import { differenceInCalendarDays, format, isPast, isToday } from 'date-fns'
import { safeISO } from '../../lib/date.js'

/**
 * Calendar days from the start of today until `d` (the calendar pages'
 * convention). Negative = in the past. null when the date is
 * missing/unparseable — callers MUST branch on that (see isUpcoming).
 */
export const daysUntil = (d, now = new Date()) => {
  const t = safeISO(d)
  return t ? differenceInCalendarDays(t, now) : null
}

/** Same count as daysUntil; kept as a named export for existing callers. */
export const calendarDaysUntil = daysUntil

// A row with a missing or unparseable date is NOT upcoming. Guarding this
// explicitly matters because `daysUntil` returns null and `null >= 0` is true
// in JS, which would otherwise slip dateless elections into "next race".
export const isUpcoming = (d, now = new Date()) => {
  const n = daysUntil(d, now)
  return n != null && n >= 0
}

/**
 * Countdown words for an election: '' | 'today' | 'tomorrow' | 'N days' | 'past'.
 * `short` gives the compact 'Nd' the election list uses.
 */
export const countdownLabel = (d, now = new Date(), { short = false } = {}) => {
  const cal = calendarDaysUntil(d, now)
  if (cal == null) return ''
  if (cal === 0) return 'today'
  if (cal === 1) return 'tomorrow'
  if (cal < 0) return 'past'
  return short ? `${cal}d` : `${cal} days`
}

// ── Milestone due dates (UI audit round 2, item 12) ──────────────────────────
// The "Needs attention" row printed `due ${fmtDate(due_date)}` with a bare
// 'MMM d' pattern next to a '348d overdue' chip: a milestone due 2025-09-02
// rendered as "due Sep 2", which reads as this year's Sep 2 (17 days out) and
// makes the — arithmetically correct — 348 look like a bug. Show the year
// whenever the date is not in the current year, and label the chip by sign so
// a future due date can never be announced as overdue.

/** 'Sep 2' inside the current year, 'Sep 2, 2025' outside it, '—' when unset. */
export const fmtDueDate = (d, now = new Date()) => {
  const t = safeISO(d)
  if (!t) return '—'
  return format(t, t.getFullYear() === now.getFullYear() ? 'MMM d' : 'MMM d, yyyy')
}

/**
 * The single due-date chip string. Overdue only ever comes from a NEGATIVE
 * count; 'overdue' appears once, here, so callers must not repeat the word.
 *   -348 → '348d overdue'   0 → 'due today'   17 → 'due in 17d'
 */
export const dueChipLabel = (d, now = new Date()) => {
  const n = daysUntil(d, now)
  if (n == null) return 'no due date'
  if (n < 0) return `${Math.abs(n)}d overdue`
  if (n === 0) return 'due today'
  return `due in ${n}d`
}

// Mirrors the milestone status rule in GamePlan.jsx (`autoStatus`) so the
// dashboard and the Game Plan page agree on what "overdue" means.
export const autoStatus = (m) => {
  if (m.status === 'complete' || m.status === 'skipped') return m.status
  const t = safeISO(m.due_date)
  if (m.due_date && t && isPast(t) && !isToday(t)) return 'overdue'
  return m.status
}
