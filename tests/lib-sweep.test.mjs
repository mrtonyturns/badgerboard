#!/usr/bin/env node
// Badger Board — lib bug-sweep regression tests.
// Zero-config: node tests/lib-sweep.test.mjs
//
// Pins the clock to Mon 2026-10-05 12:00 America/Chicago (the runner spawns
// suites without TZ, so it is set here before any date code runs) and covers:
//   1 — recurrence: weekly-on-weekday advances strictly past the anchor
//   2 — quickAdd: ordinary words are no longer eaten as dates/recurrence
//   3 — csv: a mid-field quote is literal (5'10")
//   4 — recruit: district normalisation keeps distinct ward labels apart
//   5 — prospectCsv: filename uses the local date
//   6 — Events: ongoing multi-day events stay listed
//   7 — static checks: chunk-reload guard, office paging, calendar-day countdown

process.env.TZ = 'America/Chicago'

import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = (p) => readFileSync(join(root, p), 'utf8')

// Fixed "now" for code that calls new Date() / Date.now() internally.
const RealDate = Date
const NOW_MS = new RealDate(2026, 9, 5, 12, 0, 0).getTime()
globalThis.Date = class extends RealDate {
  constructor(...args) { if (args.length === 0) super(NOW_MS); else super(...args) }
  static now() { return NOW_MS }
}

let pass = 0, fail = 0
const t = (name, cond) => { cond ? pass++ : fail++; console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${name}`) }
const eq = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  t(`${name} → ${JSON.stringify(actual)}${ok ? '' : `  (expected ${JSON.stringify(expected)})`}`, ok)
}

const { nextOccurrence, parseRecurrence } = await import('../src/lib/recurrence.js')
const { parseQuickAdd } = await import('../src/lib/quickAdd.js')
const { parseCsvRows } = await import('../src/lib/csv.js')
const { normalizeDistrictValue, districtValuesMatch } = await import('../src/lib/recruit.js')
const { csvFilename } = await import('../src/lib/prospectCsv.js')

// ═══ 1 — recurrence ══════════════════════════════════════════════════════════
console.log('1 — nextOccurrence for weekly-on-weekday rules')
{
  const fri = { freq: 'weekly', interval: 1, weekday: 5 }
  eq('every friday, due Fri 10-09 → next Friday', nextOccurrence(fri, '2026-10-09'), '2026-10-16')
  eq('every 2 weeks on monday, due Mon 10-05 → two weeks out',
    nextOccurrence({ freq: 'weekly', interval: 2, weekday: 1 }, '2026-10-05'), '2026-10-19')
  eq('overdue every friday (due 09-25) → first Friday after today', nextOccurrence(fri, '2026-09-25'), '2026-10-09')
  eq('off-weekday anchor (Wed 10-07) → the coming Friday', nextOccurrence(fri, '2026-10-07'), '2026-10-09')
  eq('no due date → the coming Friday', nextOccurrence(fri, null), '2026-10-09')
  eq('plain weekly is unchanged', nextOccurrence({ freq: 'weekly', interval: 1 }, '2026-10-05'), '2026-10-12')
  eq('daily is unchanged', nextOccurrence({ freq: 'daily', interval: 1 }, '2026-10-05'), '2026-10-06')
  eq('monthly is unchanged', nextOccurrence({ freq: 'monthly', interval: 1 }, '2026-10-05'), '2026-11-05')
}

// ═══ 2 — quickAdd ════════════════════════════════════════════════════════════
console.log('2 — quick add keeps ordinary words as text')
{
  for (const text of [
    'Call Tom about yard signs',
    'Drop literature in Sun Prairie',
    'Print 1/2 page flyers',
    'Draft weekly newsletter',
    'Lit drop 13/45',
    'Mail on 2/30',
    'Sat with Wed committee',
  ]) {
    const r = parseQuickAdd(text)
    t(`"${text}" stays intact with no date/recurrence`,
      r.content === text.replace(/\s+/g, ' ') && r.dueDate === null && r.recurrence === null)
  }
  eq('"weekly" alone is not a recurrence', parseRecurrence('Draft weekly newsletter').recurrence, null)

  // intended behaviours still work
  const r1 = parseQuickAdd('Call donors tomorrow #Campaign Plan @finance p1', [{ id: 'p1', name: 'Campaign Plan' }])
  eq('tomorrow + project + label + priority',
    [r1.content, r1.dueDate, r1.projectId, r1.labels, r1.priority], ['Call donors', '2026-10-06', 'p1', ['finance'], 1])
  eq('"tmr" still means tomorrow', parseQuickAdd('Knock doors tmr').dueDate, '2026-10-06')
  eq('"today" still works', parseQuickAdd('Knock doors today').dueDate, '2026-10-05')
  eq('bare full weekday', [parseQuickAdd('Call friday').content, parseQuickAdd('Call friday').dueDate], ['Call', '2026-10-09'])
  eq('short weekday after "by"', [parseQuickAdd('Call donors by fri').content, parseQuickAdd('Call donors by fri').dueDate], ['Call donors', '2026-10-09'])
  eq('short weekday after "on"', parseQuickAdd('Meet on sat').dueDate, '2026-10-10')
  eq('"next fri"', parseQuickAdd('Call next fri').dueDate, '2026-10-16')
  eq('valid N/N date', parseQuickAdd('Mail 10/20').dueDate, '2026-10-20')
  eq('past N/N rolls to next year', parseQuickAdd('Mail 7/20').dueDate, '2027-07-20')
  eq('N/N/YY', parseQuickAdd('Mail 3/4/27').dueDate, '2027-03-04')
  eq('ISO date', parseQuickAdd('Mail 2026-11-02').dueDate, '2026-11-02')

  const e1 = parseQuickAdd('Water signs every day')
  eq('"every day"', [e1.content, e1.recurrence], ['Water signs', { freq: 'daily', interval: 1 }])
  eq('"every week"', parseQuickAdd('Report every week').recurrence, { freq: 'weekly', interval: 1 })
  eq('"every 2 weeks"', parseQuickAdd('Report every 2 weeks').recurrence, { freq: 'weekly', interval: 2 })
  const e2 = parseQuickAdd('Staff meeting every fri')
  eq('"every fri"', [e2.content, e2.recurrence, e2.dueDate],
    ['Staff meeting', { freq: 'weekly', interval: 1, weekday: 5 }, '2026-10-09'])
}

// ═══ 3 — csv ═════════════════════════════════════════════════════════════════
console.log('3 — CSV: quotes only open a field at its start')
{
  const rows = parseCsvRows('Name,Height,City\nBob,5\'10",Wausau\nAnn,5\'4",Merrill\n')
  eq('a mid-field quote is literal and does not swallow the file', rows,
    [['Name', 'Height', 'City'], ['Bob', '5\'10"', 'Wausau'], ['Ann', '5\'4"', 'Merrill']])
  eq('quoted fields keep commas, newlines and "" escapes',
    parseCsvRows('a,"b, ""c""\nd",e\r\nf,g,h'), [['a', 'b, "c"\nd', 'e'], ['f', 'g', 'h']])
  eq('a quote at the start of the file opens a quoted field', parseCsvRows('"x,y",z'), [['x,y', 'z']])
  eq('whitespace before an opening quote is allowed', parseCsvRows('Name, "Smith, John",x'), [['Name', 'Smith, John', 'x']])
  eq('BOM is stripped', parseCsvRows('﻿a,b'), [['a', 'b']])
}

// ═══ 4 — recruit ═════════════════════════════════════════════════════════════
console.log('4 — recruit: district values')
{
  eq('"04"', normalizeDistrictValue('04'), '4')
  eq('"District 7"', normalizeDistrictValue('District 7'), '7')
  eq('"4th"', normalizeDistrictValue('4th'), '4')
  eq('"Ward 3"', normalizeDistrictValue('Ward 3'), '3')
  eq('"Supervisory District 05"', normalizeDistrictValue('Supervisory District 05'), '5')
  eq('"Ward 3A" keeps its text', normalizeDistrictValue('Ward 3A'), 'Ward 3A')
  eq('"Ward 3B" keeps its text', normalizeDistrictValue('Ward 3B'), 'Ward 3B')
  t('"Ward 3A" and "Ward 3B" do not match', !districtValuesMatch('Ward 3A', 'Ward 3B'))
  t('different municipalities\' Ward 3 do not match',
    !districtValuesMatch('Village of Weston Ward 3', 'City of Wausau Ward 3'))
  t('same label still matches case-insensitively', districtValuesMatch('city of wausau ward 3', 'City of Wausau  Ward 3'))
  eq('school district names keep their text', normalizeDistrictValue('  Wausau  School District '), 'Wausau School District')
}

// ═══ 5 — prospectCsv ═════════════════════════════════════════════════════════
console.log('5 — prospect CSV filename uses the local date')
{
  // 03:00Z on Oct 5 is still Oct 4 in Chicago — the old toISOString() said Oct 5.
  eq('late-evening local export', csvFilename('badger prospects', new Date('2026-10-05T03:00:00Z')), 'badger_prospects_2026-10-04.csv')
  eq('midday', csvFilename('p', new Date(2026, 7, 12, 12)), 'p_2026-08-12.csv')
}

// ═══ 6 — Events.filterUpcoming ═══════════════════════════════════════════════
console.log('6 — Events: an ongoing multi-day event is still upcoming')
{
  const s = src('src/pages/Events.jsx')
  const a = s.indexOf('R4 PURE HELPERS BEGIN'), b = s.indexOf('R4 PURE HELPERS END')
  const block = s.slice(s.indexOf('\n', a) + 1, s.lastIndexOf('\n', b))
  const { filterUpcoming } = await import('data:text/javascript;base64,' + Buffer.from(block, 'utf8').toString('base64'))
  const now = new RealDate(2026, 9, 5, 12)
  const names = filterUpcoming([
    { name: 'Fair',   date_start: '2026-10-02', date_end: '2026-10-07' },  // ongoing
    { name: 'Expo',   date_start: '2026-10-01', date_end: '2026-10-04' },  // ended
    { name: 'Past',   date_start: '2026-10-01' },
    { name: 'Rally',  date_start: '2026-10-10' },
    { name: 'Ends today', date_start: '2026-10-03', date_end: '2026-10-05' },
  ], now).map(e => e.name)
  eq('ongoing kept, ended dropped, sorted by start', names, ['Fair', 'Ends today', 'Rally'])
}

// ═══ 7 — static checks ═══════════════════════════════════════════════════════
console.log('7 — source checks')
{
  const app = src('src/App.jsx')
  t('ErrorBoundary no longer clears the chunk-reload guard on mount',
    !/componentDidMount\(\)\s*\{[^}]*removeItem\(RELOAD_GUARD\)/.test(app))
  t('the guard is time-windowed', /Date\.now\(\) - last < RELOAD_WINDOW_MS/.test(app))

  const supa = src('src/lib/supabase.js')
  t('fetchOffices pages with a unique id tiebreaker', /\.order\('name'\)\s*\n\s*\.order\('id'\)[^\n]*\n\s*\.range\(/.test(supa))
  t('getCandidates selects office city',
    /office:offices\(id, name, level, office_type, district_number, district_name, county, city\)/.test(supa))

  for (const f of ['src/pages/Elections.jsx', 'src/pages/GamePlan.jsx']) {
    const s = src(f)
    t(`${f}: countdown uses calendar days`, /differenceInCalendarDays\(/.test(s) && !/differenceInDays\(/.test(s))
    t(`${f}: "1 day away" is singular`, /day\$\{daysUntil === 1 \? '' : 's'\} away/.test(s))
  }
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
