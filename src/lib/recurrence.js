// ─── Recurring task helpers ───────────────────────────────────────────────────
// recurrence shape: { freq: 'daily'|'weekly'|'monthly'|'yearly', interval: N, weekday?: 0-6 }
// Completing a recurring task advances due_date to the next occurrence
// (strictly after today), Todoist-style, instead of completing it.

import { addDays, addWeeks, addMonths, addYears, format, parseISO, nextDay } from 'date-fns'

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

  const step = (date) => {
    switch (rec.freq) {
      case 'daily':   return addDays(date, n)
      case 'weekly':  return rec.weekday != null
        ? addWeeks(nextDay(addDays(date, -1), rec.weekday), n - 1)
        : addWeeks(date, n)
      case 'monthly': return addMonths(date, n)
      case 'yearly':  return addYears(date, n)
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
 * Supports: "every day"/"daily", "every week"/"weekly", "every month"/"monthly",
 * "every year"/"yearly"/"annually", "every N days/weeks/months/years",
 * "every monday" (any weekday), "every weekday-name".
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
    { re: /\b(daily|weekly|monthly|yearly|annually)\b/i, fn: (m) => ({
        freq: m[1].toLowerCase() === 'annually' ? 'yearly' : m[1].toLowerCase(),
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
