// ─── Quick Add parser (Todoist-style) ─────────────────────────────────────────
// Parses a single input line into task fields:
//   "Call donors tomorrow #Campaign Plan @finance p1"
//     → { content: 'Call donors', dueDate: '2026-07-05',
//         projectName: 'campaign plan', labels: ['finance'], priority: 1 }
//
//   #Project    — project by name (matched case-insensitively by the caller;
//                 multi-word projects match greedily against known names)
//   @label      — one or more labels
//   p1…p4       — priority (1 highest)
//   date words  — today, tomorrow, tmr, next week, weekday names
//                 ("friday", "next friday", "by fri"), "in N days/weeks",
//                 "Jul 20", "July 20", "7/20", "2026-07-20"
//                 Short weekdays (sun, mon…) need a lead-in (on/due/by/next/this)
//                 so "Sun Prairie" stays text; N/N must be a real month/day.

import { addDays, addWeeks, format, nextDay, parse, isValid } from 'date-fns'
import { parseRecurrence } from './recurrence.js'

const FULL_WEEKDAYS = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
  thursday: 4, friday: 5, saturday: 6,
}
const WEEKDAYS = {
  ...FULL_WEEKDAYS,
  sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6,
}

const MONTHS = 'jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december'

const fmt = (d) => format(d, 'yyyy-MM-dd')

/** Extract a due date from free text. Returns { dueDate, cleaned } */
export function parseDatePhrase(text) {
  const today = new Date()
  let dueDate = null
  let cleaned = text

  const patterns = [
    // "today" / "tonight" ("tod"/"tom" dropped: "Call Tom" is a name, not a date)
    { re: /\b(today|tonight)\b/i, fn: () => today },
    // "tomorrow" / "tmr"
    { re: /\b(tomorrow|tmr)\b/i, fn: () => addDays(today, 1) },
    // "next week" → next Monday
    { re: /\bnext week\b/i, fn: () => nextDay(today, 1) },
    // "in N days" / "in N weeks"
    { re: /\bin (\d{1,3}) days?\b/i, fn: (m) => addDays(today, parseInt(m[1])) },
    { re: /\bin (\d{1,2}) weeks?\b/i, fn: (m) => addWeeks(today, parseInt(m[1])) },
    // "next friday"
    { re: new RegExp(`\\bnext (${Object.keys(WEEKDAYS).join('|')})\\b`, 'i'),
      fn: (m) => addWeeks(nextDay(today, WEEKDAYS[m[1].toLowerCase()]), 1) },
    // short weekday only after a lead-in: "by fri", "on sat" → the coming one
    { re: new RegExp(`\\b(?:on|due|by|this) (${Object.keys(WEEKDAYS).join('|')})\\b`, 'i'),
      fn: (m) => nextDay(today, WEEKDAYS[m[1].toLowerCase()]) },
    // bare full weekday "friday" → the coming one
    { re: new RegExp(`\\b(${Object.keys(FULL_WEEKDAYS).join('|')})\\b`, 'i'),
      fn: (m) => nextDay(today, FULL_WEEKDAYS[m[1].toLowerCase()]) },
    // ISO date 2026-07-20
    { re: /\b(\d{4}-\d{2}-\d{2})\b/, fn: (m) => {
        const d = parse(m[1], 'yyyy-MM-dd', today); return isValid(d) ? d : null } },
    // US numeric 7/20 or 7/20/2026 — not a fraction before a unit ("1/2 page")
    { re: /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b(?![-\s]*(?:pages?|sheets?|size|sized|inch(?:es)?|off)\b)/i, fn: (m) => {
        const yr = m[3] ? (m[3].length === 2 ? 2000 + parseInt(m[3]) : parseInt(m[3])) : today.getFullYear()
        const mo = parseInt(m[1]) - 1, day = parseInt(m[2])
        const d = new Date(yr, mo, day)
        // reject overflow (13/45, 2/30) instead of letting Date roll it forward
        if (!isValid(d) || d.getMonth() !== mo || d.getDate() !== day) return null
        if (!m[3] && d < addDays(today, -1)) d.setFullYear(d.getFullYear() + 1)  // "7/2" already past → next year
        return d } },
    // "Jul 20" / "July 20" / "20 July"
    { re: new RegExp(`\\b(${MONTHS}) (\\d{1,2})\\b`, 'i'), fn: (m) => {
        const d = parse(`${m[1]} ${m[2]} ${today.getFullYear()}`, m[1].length <= 4 ? 'MMM d yyyy' : 'MMMM d yyyy', today)
        if (!isValid(d)) return null
        if (d < addDays(today, -1)) d.setFullYear(d.getFullYear() + 1)
        return d } },
    { re: new RegExp(`\\b(\\d{1,2}) (${MONTHS})\\b`, 'i'), fn: (m) => {
        const d = parse(`${m[2]} ${m[1]} ${today.getFullYear()}`, m[2].length <= 4 ? 'MMM d yyyy' : 'MMMM d yyyy', today)
        if (!isValid(d)) return null
        if (d < addDays(today, -1)) d.setFullYear(d.getFullYear() + 1)
        return d } },
  ]

  for (const { re, fn } of patterns) {
    const m = cleaned.match(re)
    if (m) {
      const d = fn(m)
      if (d) {
        dueDate = fmt(d)
        cleaned = cleaned.replace(re, ' ')
        break
      }
    }
  }
  return { dueDate, cleaned }
}

/**
 * Parse a full Quick Add line.
 * @param {string} input
 * @param {Array<{id, name}>} knownProjects — for greedy multi-word #Project matching
 * @returns {{ content, dueDate, priority, labels, projectId }}
 */
export function parseQuickAdd(input, knownProjects = []) {
  let text = ` ${input} `

  // Priority: p1–p4 (lowercase, Todoist-style; also accept !!1 style)
  let priority = 4
  const pm = text.match(/\s(?:p|!!)([1-4])\b/i)
  if (pm) {
    priority = parseInt(pm[1])
    text = text.replace(pm[0], ' ')
  }

  // Labels: @word (letters, numbers, _, -)
  const labels = []
  text = text.replace(/(^|\s)@([\w-]+)/g, (_, sp, l) => { labels.push(l.toLowerCase()); return sp })

  // Project: greedy match against known project names first (#Campaign Plan),
  // then fall back to single-word #Name
  let projectId = null
  const hashIdx = text.indexOf('#')
  if (hashIdx !== -1) {
    const after = text.slice(hashIdx + 1)
    const sorted = [...knownProjects].sort((a, b) => b.name.length - a.name.length)
    const hit = sorted.find(p => {
      if (!after.toLowerCase().startsWith(p.name.toLowerCase())) return false
      const next = after[p.name.length]
      return next === undefined || /\s/.test(next)
    })
    if (hit) {
      projectId = hit.id
      text = text.slice(0, hashIdx) + ' ' + after.slice(hit.name.length)
    } else {
      const m = after.match(/^([\w-]+)/)
      if (m) {
        const loose = knownProjects.find(p => p.name.toLowerCase() === m[1].toLowerCase())
        if (loose) projectId = loose.id
        text = text.slice(0, hashIdx) + ' ' + after.slice(m[1].length)
      }
    }
  }

  // Recurrence phrase must be parsed BEFORE dates ("every friday" would
  // otherwise be consumed by the bare-weekday date pattern)
  const { recurrence, cleaned: afterRec, impliedDueDate } = parseRecurrence(text)

  // Date phrase
  const { dueDate, cleaned } = parseDatePhrase(afterRec)

  const content = cleaned.replace(/\s+/g, ' ').trim()
  return {
    content,
    dueDate: dueDate || impliedDueDate || null,
    priority, labels, projectId, recurrence,
  }
}
