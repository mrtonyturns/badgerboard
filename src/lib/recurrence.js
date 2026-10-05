// ─── Recurring task helpers ───────────────────────────────────────────────────
// recurrence shape: { freq: 'daily'|'weekly'|'monthly'|'yearly', interval: N, weekday?: 0-6,
//                     anchorDay?: 1-31, anchorMonth?: 1-12 (yearly only) }
// anchorDay/anchorMonth pin monthly/yearly rules to the day they were set on,
// so a 31st-of-the-month task comes back to the 31st after a short month
// instead of drifting (Oct 31 → Nov 30 → Dec 30 …). Rules saved before the
// anchor existed fall back to the due date's own day.
// Completing a recurring task advances due_date to the next occurrence
// (strictly after today), Todoist-style, instead of completing it.

import { addDays, addWeeks, addMonths, addYears, format, parseISO, nextDay, getDaysInMonth, setDate } from 'date-fns'

const fmt = (d) => format(d, 'yyyy-MM-dd')

/** Human label for a recurrence rule (chips / modal). */
export function recurrenceLabel(rec) {
  if (!rec?.freq) return null
  const n = rec.interval || 1
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  if (rec.freq === 'weekly' && rec.weekday != null) {
    return n === 1 ? `every ${days[rec.weekday]}` : `every ${n} weeks on ${days[rec.weekday]}`
  }
  const unit = { daily: 'day', weekly: 'week', monthly: 'month', yearly: 'year' }[rec.freq]
  return n === 1 ? `every ${unit}` : `every ${n} ${unit}s`
}

const ANCHORED = new Set(['monthly', 'yearly'])

/**
 * True when `date` is where an anchored rule would land: on its anchor day,
 * or on the last day of a month too short for it (Nov 30 for a 31st anchor).
 * A task rescheduled off its anchor no longer fits, and re-anchors on its new day.
 */
function anchorFits(rec, date) {
  if (rec?.anchorDay == null) return false
  const day = date.getDate()
  const dayOk = day === rec.anchorDay || (day === getDaysInMonth(date) && rec.anchorDay > day)
  const monthOk = rec.freq !== 'yearly' || rec.anchorMonth == null || date.getMonth() + 1 === rec.anchorMonth
  return dayOk && monthOk
}

/**
 * The rule with its monthly/yearly anchor set from the due date (call when a
 * task's recurrence or due date is saved). Keeps `prev`'s anchor while the due
 * date still fits it, so re-saving a task sitting on a clamped Nov 30 keeps its
 * 31st anchor. Non-anchored frequencies / no due date → anchor fields stripped.
 */
export function withAnchor(rec, dueDateStr, prev = rec) {
  if (!rec?.freq) return rec ?? null
  const { anchorDay: _d, anchorMonth: _m, ...base } = rec
  if (!ANCHORED.has(rec.freq) || !dueDateStr) return base
  const due = parseISO(dueDateStr)
  const keep = prev?.freq === rec.freq && anchorFits(prev, due)
  const anchorDay = keep ? prev.anchorDay : due.getDate()
  const anchorMonth = keep && prev.anchorMonth != null ? prev.anchorMonth : due.getMonth() + 1
  return { ...base, anchorDay, ...(rec.freq === 'yearly' ? { anchorMonth } : {}) }
}

/**
 * Next occurrence after completing the task today.
 * Anchored on the task's due date when it has one (keeps cadence), otherwise today.
 * Always returns a date strictly after today.
 */
export function nextOccurrence(rec, dueDateStr) {
  if (!rec?.freq) return null
  const n = Math.max(1, rec.interval || 1)
  const today = parseISO(fmt(new Date()))
  let d = dueDateStr ? parseISO(dueDateStr) : today
  // Monthly/yearly: snap each step to the anchor day, clamped to short months.
  // No (or stale) anchor → the due date's own day.
  const anchorDay = anchorFits(rec, d) ? rec.anchorDay : d.getDate()
  const snap = (date) => setDate(date, Math.min(anchorDay, getDaysInMonth(date)))

  const step = (date) => {
    switch (rec.freq) {
      case 'daily':   return addDays(date, n)
      // nextDay is strictly after `date`: already on the weekday → n weeks out;
      // off-weekday anchor → the coming weekday, then n-1 more weeks
      case 'weekly':  return rec.weekday != null
        ? addWeeks(nextDay(date, rec.weekday), n - 1)
        : addWeeks(date, n)
      case 'monthly': return snap(addMonths(date, n))
      case 'yearly':  return snap(addYears(date, n))
      default:        return null
    }
  }

  let next = step(d)
  let guard = 0
  while (next && next <= today && guard < 1000) { next = step(next); guard++ }
  return next ? fmt(next) : null
}

/**
 * Extract a recurrence phrase from quick-add text.
 * Supports: "every day", "every week", "every month", "every year",
 * "every N days/weeks/months/years", "every monday" (any weekday, short or full).
 * Bare "daily"/"weekly"/… are left as text ("Draft weekly newsletter").
 * Returns { recurrence, cleaned, impliedDueDate }.
 */
const WD = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
  sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6,
}

export function parseRecurrence(text) {
  let recurrence = null
  let impliedDueDate = null
  let cleaned = text

  const wdNames = Object.keys(WD).join('|')
  const patterns = [
    { re: new RegExp(`\\bevery (${wdNames})\\b`, 'i'), fn: (m) => {
        const weekday = WD[m[1].toLowerCase()]
        impliedDueDate = fmt(nextDay(new Date(), weekday))
        return { freq: 'weekly', interval: 1, weekday } } },
    { re: /\bevery (\d{1,2}) (day|week|month|year)s?\b/i, fn: (m) => ({
        freq: { day: 'daily', week: 'weekly', month: 'monthly', year: 'yearly' }[m[2].toLowerCase()],
        interval: parseInt(m[1]) }) },
    { re: /\bevery (day|week|month|year)\b/i, fn: (m) => ({
        freq: { day: 'daily', week: 'weekly', month: 'monthly', year: 'yearly' }[m[1].toLowerCase()],
        interval: 1 }) },
  ]

  for (const { re, fn } of patterns) {
    const m = cleaned.match(re)
    if (m) {
      recurrence = fn(m)
      cleaned = cleaned.replace(re, ' ')
      break
    }
  }
  return { recurrence, cleaned, impliedDueDate }
}
