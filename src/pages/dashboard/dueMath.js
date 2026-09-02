// src/pages/dashboard/dueMath.js — the dashboards' date arithmetic, extracted
// into a plain (JSX-free) module so tests/r2a.test.mjs can import it under bare
// node. shared.jsx re-exports everything here, so nothing else changed its
// import surface.
//
// ── COUNTDOWN PARITY (UI audit round 2, item 1) ──────────────────────────────
// The dashboards counted with `differenceInCalendarDays`, the calendar pages
// count with `differenceInDays`:
//     src/pages/Elections.jsx:249   differenceInDays(safeISO(d), new Date())
//     src/pages/GamePlan.jsx:110    differenceInDays(parseISO(d), new Date())
// Those disagree by one for every date after midnight today, which is why the
// same four elections read 79/184/233/359 on the dashboard and 78/183/232/358
// on the calendar. The calendar pages are the published convention and are out
// of scope for this pass, so the dashboards adopt `differenceInDays`: both
// screens now say the same number, and election day itself is 0 on both.
//
// KNOWN COST OF THAT CONVENTION: `differenceInDays` counts whole elapsed 24h
// periods, so a date one calendar day out also returns 0. The NUMBER stays in
// parity with the calendar; `countdownLabel` below keeps the WORDS honest by
// naming today and tomorrow from the calendar day rather than from the count.

import { differenceInDays, differenceInCalendarDays, format, isPast, isToday } from 'date-fns'
import { safeISO } from '../../lib/date.js'

/**
 * Days from `now` until `d`, using the calendar pages' convention.
 * Negative = in the past. null when the date is missing/unparseable — callers
 * MUST branch on that (see isUpcoming).
 */
export const daysUntil = (d, now = new Date()) => {
  const t = safeISO(d)
  return t ? differenceInDays(t, now) : null
}

/** Whole calendar days between today and `d` — for today/tomorrow wording only. */
export const calendarDaysUntil = (d, now = new Date()) => {
  const t = safeISO(d)
  return t ? differenceInCalendarDays(t, now) : null
}

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
  const n = daysUntil(d, now)
  return short ? `${n}d` : `${n} day${n === 1 ? '' : 's'}`
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

// ── gp_tasks → milestone shape ───────────────────────────────────────────────
// The dashboards were written against the legacy game_plan_milestones table
// (title / phase / status / due_date). The Todo page replaced that with
// gp_tasks (content / section_id / completed / completed_at / due_date), and
// the legacy table is no longer written, so the dashboards read gp_tasks and
// adapt each row here. `status` is derived from `completed` — the ONLY
// completion flag the task board writes — so a completed task can never be
// counted open or overdue. `phase` is the campaign phase key when the task's
// section is one of the six migrated phase sections; `phase_label` is always
// the section name so custom sections still get a readable label.
const PHASE_KEY_BY_LABEL = {
  'planning': 'planning', 'filing': 'filing', 'voter contact': 'voter_contact',
  'fundraising': 'fundraising', 'gotv': 'gotv', 'election day': 'election_day',
}

export const taskToMilestone = (t, sectionsById = {}) => {
  const section = t.section_id ? sectionsById[t.section_id] : null
  const name = section?.name || ''
  return {
    id: t.id,
    title: t.content,
    due_date: t.due_date,
    status: t.completed ? 'complete' : (t.priority <= 2 ? 'in_progress' : 'not_started'),
    updated_at: t.completed ? (t.completed_at || t.updated_at) : t.updated_at,
    phase: PHASE_KEY_BY_LABEL[name.trim().toLowerCase()],
    phase_label: name || null,
    project_id: t.project_id,
    completed: Boolean(t.completed),
    completed_at: t.completed_at || null,
  }
}

/** Sort key for "next up": dated tasks first by due date, undated last. */
export const byDueDate = (a, b) => (a.due_date || '9999').localeCompare(b.due_date || '9999')

// Mirrors the milestone status rule in GamePlan.jsx (`autoStatus`) so the
// dashboard and the Game Plan page agree on what "overdue" means.
export const autoStatus = (m) => {
  if (m.status === 'complete' || m.status === 'skipped') return m.status
  const t = safeISO(m.due_date)
  if (m.due_date && t && isPast(t) && !isToday(t)) return 'overdue'
  return m.status
}
