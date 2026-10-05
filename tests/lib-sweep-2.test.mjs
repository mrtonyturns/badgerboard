#!/usr/bin/env node
// Badger Board — lib bug-sweep 2 regression tests.
// Zero-config: node tests/lib-sweep-2.test.mjs
//
// Pins the clock to Mon 2026-10-05 12:00 America/Chicago (set before any date
// code loads) and covers:
//   1 — recurrence: monthly/yearly anchors stop short-month drift
//   2 — countdownLabel counts calendar days ("2 days", never "1 day", two out)
//   3 — csvEscape: formula guard after whitespace, plain numbers untouched
//   4 — pgFilter: LIKE metacharacters literal, or()-tree values quoted
//   5 — useDialog: only the topmost dialog handles Escape
//   6 — static checks: stable paging, local export bounds, unique realtime
//       channels, county-scoped city offices, offline-queue comment

process.env.TZ = 'America/Chicago'

import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = (p) => readFileSync(join(root, p), 'utf8')

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

const { nextOccurrence, withAnchor } = await import('../src/lib/recurrence.js')
const { countdownLabel, daysUntil, dueChipLabel } = await import('../src/pages/dashboard/dueMath.js')
const { csvEscape } = await import('../src/lib/prospectCsv.js')
const { escapeLike, likeContains, quoteFilterValue } = await import('../src/lib/pgFilter.js')
const { dialogStack, escapeHandler } = await import('../src/lib/useDialog.js')

const chain = (rec, start, n) => {
  const out = []
  let d = start
  for (let i = 0; i < n; i++) { d = nextOccurrence(rec, d); out.push(d) }
  return out
}

// ═══ 1 — recurrence anchors ══════════════════════════════════════════════════
console.log('1 — monthly/yearly recurrence anchors')
{
  const monthly = withAnchor({ freq: 'monthly', interval: 1 }, '2026-10-31')
  eq('monthly rule set on the 31st stores its anchor', monthly, { freq: 'monthly', interval: 1, anchorDay: 31 })
  eq('anchored on 31: Oct 31 → Nov 30 → Dec 31 → Jan 31 → Feb 28 → Mar 31',
    chain(monthly, '2026-10-31', 5), ['2026-11-30', '2026-12-31', '2027-01-31', '2027-02-28', '2027-03-31'])

  const yearly = withAnchor({ freq: 'yearly', interval: 1 }, '2028-02-29')
  eq('yearly rule stores day AND month', yearly, { freq: 'yearly', interval: 1, anchorDay: 29, anchorMonth: 2 })
  eq('yearly Feb 29 2028 → 2029-02-28 → 2030-02-28 → 2031-02-28 → 2032-02-29',
    chain(yearly, '2028-02-29', 4), ['2029-02-28', '2030-02-28', '2031-02-28', '2032-02-29'])

  // Legacy rules (no anchor) keep the old step-from-the-due-date behaviour
  eq('unanchored monthly from Oct 31 → Nov 30', nextOccurrence({ freq: 'monthly', interval: 1 }, '2026-10-31'), '2026-11-30')
  eq('unanchored monthly from Nov 30 → Dec 30 (no migration)',
    nextOccurrence({ freq: 'monthly', interval: 1 }, '2026-11-30'), '2026-12-30')

  // Re-saving a task parked on a clamped date keeps its anchor; moving it re-anchors
  eq('re-save on clamped Nov 30 keeps anchor 31',
    withAnchor({ freq: 'monthly', interval: 1 }, '2026-11-30', monthly).anchorDay, 31)
  eq('rescheduling to the 15th re-anchors on 15',
    withAnchor({ freq: 'monthly', interval: 1 }, '2026-11-15', monthly).anchorDay, 15)
  eq('a stale anchor is ignored by nextOccurrence (due 15th, anchor 31)',
    nextOccurrence({ freq: 'monthly', interval: 1, anchorDay: 31 }, '2026-11-15'), '2026-12-15')
  eq('switching to weekly strips the anchor',
    withAnchor({ freq: 'weekly', interval: 1, anchorDay: 31 }, '2026-11-15'), { freq: 'weekly', interval: 1 })
  eq('no due date → no anchor', withAnchor({ freq: 'monthly', interval: 1 }, null), { freq: 'monthly', interval: 1 })
  eq('null rule passes through', withAnchor(null, '2026-10-31'), null)
  eq('every 2 months anchored on 31 from Dec 31 → Feb 28 → Apr 30 → Jun 30',
    chain(withAnchor({ freq: 'monthly', interval: 2 }, '2026-12-31'), '2026-12-31', 3),
    ['2027-02-28', '2027-04-30', '2027-06-30'])

  const tb = src('src/components/TaskBoard.jsx')
  t('TaskBoard anchors the modal save, quick-add and the advance',
    (tb.match(/withAnchor\(/g) || []).length >= 3)
}

// ═══ 2 — countdownLabel ══════════════════════════════════════════════════════
console.log('2 — countdownLabel uses calendar days')
{
  const NOW = new Date(2026, 9, 5, 10, 30)
  eq('today', countdownLabel('2026-10-05', NOW), 'today')
  eq('tomorrow', countdownLabel('2026-10-06', NOW), 'tomorrow')
  eq('two days out reads "2 days" (was "1 day")', countdownLabel('2026-10-07', NOW), '2 days')
  eq('short form', countdownLabel('2026-10-07', NOW, { short: true }), '2d')
  eq('late evening still counts from the start of today',
    countdownLabel('2026-10-07', new Date(2026, 9, 5, 23, 59)), '2 days')
  eq('Nov 3 from Oct 5', countdownLabel('2026-11-03', NOW), '29 days')
  eq('daysUntil(tomorrow) is 1', daysUntil('2026-10-06', NOW), 1)
  eq('a milestone due tomorrow is not "due today"', dueChipLabel('2026-10-06', NOW), 'due in 1d')
  eq('past', countdownLabel('2026-10-04', NOW), 'past')
}

// ═══ 3 — csvEscape ═══════════════════════════════════════════════════════════
console.log('3 — csvEscape formula guard')
{
  eq('=formula', csvEscape('=1+1'), "'=1+1")
  eq('formula after spaces', csvEscape('  =HYPERLINK("x")'), `"'  =HYPERLINK(""x"")"`)
  eq('formula after a newline', csvEscape('\n@SUM(A1)'), `"'\n@SUM(A1)"`)
  eq('leading tab', csvEscape('\tx'), "'\tx")
  eq('leading CR', csvEscape('\r=x'), `"'\r=x"`)
  eq('+cmd', csvEscape('+cmd'), "'+cmd")
  eq('-12.5 untouched', csvEscape('-12.5'), '-12.5')
  eq('numeric -3 untouched', csvEscape(-3), '-3')
  eq('+42 untouched', csvEscape('+42'), '+42')
  eq('1e-5 untouched', csvEscape('-1e-5'), '-1e-5')
  eq('"-" alone is guarded', csvEscape('-'), "'-")
  eq('"-2+3" is guarded', csvEscape('-2+3'), "'-2+3")
  eq('plain text untouched', csvEscape('Jane Doe'), 'Jane Doe')
}

// ═══ 4 — pgFilter ════════════════════════════════════════════════════════════
console.log('4 — PostgREST filter escaping')
{
  eq('% and _ are literal', escapeLike('50%_off'), '50\\%\\_off')
  eq('backslash is escaped first', escapeLike('a\\b'), 'a\\\\b')
  eq('likeContains wraps', likeContains('first_name'), '%first\\_name%')
  eq('null-safe', likeContains(null), '%%')
  eq('quoteFilterValue quotes commas/parens', quoteFilterValue('Doe, (Jane)'), '"Doe, (Jane)"')
  eq('quoteFilterValue escapes quotes and backslashes', quoteFilterValue('say "hi"\\'), '"say \\"hi\\"\\\\"')

  const supa = src('src/lib/supabase.js')
  t('no raw `%${…}%` ilike patterns remain in supabase.js', !/ilike\([^)]*`%\$\{/.test(supa))
  t('getOffices/getCandidates search via likeContains',
    (supa.match(/ilike\('name', likeContains\(filters\.search\)\)/g) || []).length === 2)
}

// ═══ 5 — dialog stack ════════════════════════════════════════════════════════
console.log('5 — only the topmost dialog handles Escape')
{
  const closed = []
  const outer = {}, inner = {}
  dialogStack.push(outer)
  dialogStack.push(inner)
  // Both listeners sit on document, registered outer-first: replay that order
  const handlers = [
    escapeHandler(outer, () => () => closed.push('outer')),
    escapeHandler(inner, () => () => closed.push('inner')),
  ]
  const fire = (key) => { const e = { key, stopPropagation() {} }; handlers.forEach(h => h(e)) }
  fire('Escape')
  eq('first Escape closes only the inner dialog', closed, ['inner'])
  dialogStack.remove(inner)
  fire('Escape')
  eq('second Escape closes the outer one', closed, ['inner', 'outer'])
  dialogStack.remove(outer)
  fire('Escape')
  eq('nothing open → nothing closes', closed, ['inner', 'outer'])
  fire('Enter')
  t('other keys are ignored', closed.length === 2)
  dialogStack.push(outer); dialogStack.push(inner); dialogStack.remove(outer)
  t('removing a lower dialog leaves the upper on top', dialogStack.isTop(inner) && !dialogStack.isTop(outer))
  dialogStack.remove(inner)
}

// ═══ 6 — static checks ═══════════════════════════════════════════════════════
console.log('6 — paging, export bounds, channels, county scope')
{
  const shared = src('src/pages/dashboard/shared.jsx')
  t('countVotersInDistrict orders by id before .range()',
    /function countVotersInDistrict[\s\S]*?\.order\('id'\)[^\n]*\n\s*\.range\(/.test(shared))

  const dd = src('src/components/DistrictDashboard.jsx')
  t('DistrictDashboard no longer relies on .limit(5000)', !/from\('voters'\)[^\n]*\.limit\(5000\)/.test(dd))
  t('DistrictDashboard pages voters by id', /from\('voters'\)[\s\S]{0,400}\.order\('id'\)\s*\n\s*\.range\(/.test(dd))
  t('district contests filter the chamber server-side', /baseSel\.ilike\('office', `%\$\{chamberWord\}%`\)/.test(dd))

  const supa = src('src/lib/supabase.js')
  const exp = supa.slice(supa.indexOf('export const getDoorKnocksForExport'))
  t('door-knock export pages with an id tiebreaker',
    /\.order\('knocked_at'[^\n]*\n\s*\.order\('id'\)\s*\n\s*\.range\(/.test(exp))
  t('door-knock export upper bound is exclusive', /\.lt\('knocked_at', toDate\)/.test(exp))
  const stats = supa.slice(supa.indexOf('export async function getDoorKnockStats'), supa.indexOf('export async function getDoorKnockFeed'))
  t('door-knock stats page past 1000 rows', /\.order\('id'\)\s*\n\s*\.range\(/.test(stats))
  t('task realtime channel names are unique per subscription',
    /supabase\.channel\(`gp-plan-\$\{owner\}-\$\{\+\+taskChannelSeq\}`\)/.test(supa))

  const dk = src('src/pages/DoorKnocking.jsx')
  t('export no longer sends a zoneless T23:59:59', !/\+ 'T23:59:59'/.test(dk))
  t('export bounds are local-midnight instants', /new Date\(ty, tm - 1, td \+ 1\)\.toISOString\(\)/.test(dk))
  // What those bounds are in Chicago: local midnight, not UTC midnight
  eq('Oct 5 local midnight as an instant', new Date(2026, 9, 5).toISOString(), '2026-10-05T05:00:00.000Z')

  const city = src('src/pages/CityDemographics.jsx')
  t('city offices query is scoped by county', /or\(county\.is\.null,county\.ilike\./.test(city))
  t('city offices values go through pgFilter', /quoteFilterValue\(likeContains\(term\)\)/.test(city))

  const layout = src('src/components/Layout.jsx')
  t('Layout no longer claims knock logging queues offline',
    !/door-knock logging queues via offlineQueue/.test(layout))
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
