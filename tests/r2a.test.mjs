#!/usr/bin/env node
// Badger Board — R2a UI-audit regression tests.
// Zero-config: node tests/r2a.test.mjs
//
// Two kinds of assertion, deliberately:
//   • REAL arithmetic, imported and run — the countdown, the overdue label, the
//     meter fraction and the pluralised monitoring copy. Those are pure
//     functions in src/pages/**/[dueMath|planMath].js precisely so they can be
//     executed here rather than pattern-matched.
//   • Static-source checks for the fixes that are pure markup (a removed badge,
//     a z-index, an aria attribute), in the same house style as r1a/r1b/r1c.

import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { differenceInDays, parseISO } from 'date-fns'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')

const {
  daysUntil, calendarDaysUntil, isUpcoming, countdownLabel, dueChipLabel, fmtDueDate,
} = await import(`file://${join(root, 'src/pages/dashboard/dueMath.js')}`)
const {
  meterFraction, meterTicks, monitoringRowValue, UNLIMITED_ACCOUNT, planSpecLabel,
} = await import(`file://${join(root, 'src/pages/settings/planMath.js')}`)

let pass = 0, fail = 0
const t = (name, cond) => { cond ? pass++ : fail++; console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${name}`) }
const eq = (name, actual, expected) => {
  const ok = Object.is(actual, expected)
  t(`${name} → ${JSON.stringify(actual) ?? String(actual)}${ok ? '' : `  (expected ${JSON.stringify(expected) ?? String(expected)})`}`, ok)
}

// The audit was run on 2026-08-16. Every fixture is anchored to that instant so
// these tests do not rot: 10:30 local, i.e. safely past midnight, which is the
// only condition under which the two formulas ever disagreed.
const NOW = new Date(2026, 7, 16, 10, 30)

// ─── D1: election countdown parity with the calendar ─────────────────────────
console.log('D1 — dashboard countdown matches Elections.jsx / GamePlan.jsx')

// The four elections the audit compared side by side. The dashboard read
// 79/184/233/359; the calendar read 78/183/232/358.
const ELECTIONS = [
  ['2026-11-03', 78],
  ['2027-02-16', 183],
  ['2027-04-06', 232],
  ['2027-08-10', 358],
]
for (const [date, expected] of ELECTIONS) {
  eq(`daysUntil(${date})`, daysUntil(date, NOW), expected)
  // …and it is the calendar's own expression, not a hand-tuned constant.
  t(`${date} equals the calendar's differenceInDays`,
    daysUntil(date, NOW) === differenceInDays(parseISO(date), NOW))
}
t('every dashboard count is now one lower than the old calendar-day count',
  ELECTIONS.every(([d]) => calendarDaysUntil(d, NOW) - daysUntil(d, NOW) === 1))

// Election day itself is 0 — the convention, applied consistently.
eq('daysUntil(today)', daysUntil('2026-08-16', NOW), 0)
eq('daysUntil(tomorrow)', daysUntil('2026-08-17', NOW), 0)   // whole 24h periods
eq('daysUntil(yesterday)', daysUntil('2026-08-15', NOW), -1)
eq('daysUntil(no date)', daysUntil(null, NOW), null)
eq('daysUntil(garbage)', daysUntil('not a date', NOW), null)

// isUpcoming must not be fooled by the null (null >= 0 is true in JS).
t('today is upcoming', isUpcoming('2026-08-16', NOW) === true)
t('yesterday is not upcoming', isUpcoming('2026-08-15', NOW) === false)
t('a dateless row is not upcoming', isUpcoming(null, NOW) === false)

// The count is in parity with the calendar, so the WORDS have to disambiguate
// today from tomorrow — both count 0.
eq('countdownLabel(today)', countdownLabel('2026-08-16', NOW), 'today')
eq('countdownLabel(tomorrow)', countdownLabel('2026-08-17', NOW), 'tomorrow')
eq('countdownLabel(election day + 2)', countdownLabel('2026-08-18', NOW), '1 day')
eq('countdownLabel(Nov 3)', countdownLabel('2026-11-03', NOW), '78 days')
eq('countdownLabel(Nov 3, short)', countdownLabel('2026-11-03', NOW, { short: true }), '78d')
eq('countdownLabel(past)', countdownLabel('2026-08-01', NOW), 'past')
eq('countdownLabel(no date)', countdownLabel(null, NOW), '')
t('no future election can ever render the word "today"',
  ['2026-08-17', '2026-08-18', '2026-11-03'].every(d => countdownLabel(d, NOW) !== 'today'))

// ─── D2: "Needs attention" overdue math ──────────────────────────────────────
console.log('D2 — overdue label')

// The audited row: chip "348d overdue" beside a sub-line reading "due Sep 2".
// The arithmetic was right — the date was 2025-09-02 — but a year-less "Sep 2"
// made it read as a date 17 days in the FUTURE.
eq('dueChipLabel(2025-09-02)', dueChipLabel('2025-09-02', NOW), '348d overdue')
eq('fmtDueDate(2025-09-02) carries the year', fmtDueDate('2025-09-02', NOW), 'Sep 2, 2025')
eq('fmtDueDate(2026-09-02) does not', fmtDueDate('2026-09-02', NOW), 'Sep 2')
eq('fmtDueDate(no date)', fmtDueDate(null, NOW), '—')

// A due date in the future is never "overdue".
eq('dueChipLabel(2026-09-02)', dueChipLabel('2026-09-02', NOW), 'due in 16d')
eq('dueChipLabel(today)', dueChipLabel('2026-08-16', NOW), 'due today')
eq('dueChipLabel(tomorrow)', dueChipLabel('2026-08-17', NOW), 'due today')
eq('dueChipLabel(yesterday)', dueChipLabel('2026-08-15', NOW), '1d overdue')
eq('dueChipLabel(no date)', dueChipLabel(null, NOW), 'no due date')
t('a future due date never contains the word "overdue"',
  ['2026-08-16', '2026-08-17', '2026-09-02', '2027-01-01']
    .every(d => !dueChipLabel(d, NOW).includes('overdue')))
t('"overdue" appears at most once in any chip',
  ['2025-09-02', '2020-01-01', '2026-08-15']
    .every(d => dueChipLabel(d, NOW).split('overdue').length === 2))

const actionDash = read('src/pages/dashboard/ActionDashboard.jsx')
t('the attention row no longer appends "more overdue" to the title',
  !/more overdue/.test(actionDash))
t('the attention chip comes from dueChipLabel', /chip: dueChipLabel\(/.test(actionDash))
t('the attention sub-line uses the year-aware fmtDueDate', /due \$\{fmtDueDate\(/.test(actionDash))

// ─── D3: usage meter fill fraction ───────────────────────────────────────────
console.log('D3 — Settings usage meters')

eq('0 of 6', meterFraction(0, 6), 0)
eq('1 of 6', meterFraction(1, 6), 1 / 6)
eq('3 of 4', meterFraction(3, 4), 0.75)
eq('6 of 6', meterFraction(6, 6), 1)
eq('over cap clamps to 1', meterFraction(9, 6), 1)
eq('negative usage floors at 0', meterFraction(-2, 6), 0)
eq('a zero cap has no fill', meterFraction(3, 0), 0)
// The bug: an unlimited allowance is not "100% used".
eq('unlimited (null cap) has no fraction', meterFraction(1, null), null)
eq('unlimited (Infinity cap) has no fraction', meterFraction(27, Infinity), null)

// The three meters the audit saw rendered full green on one account.
for (const [label, used] of [['Profiles generated', 1], ['Monitoring slots', 3], ['Candidates tracked', 27]])
  t(`"${label} ${used}" lights 0 of 18 ticks when uncapped`, meterTicks(used, null, 18) === 0)
eq('1 of 6 lights 3 of 18 ticks', meterTicks(1, 6, 18), 3)
eq('6 of 6 lights all 18 ticks', meterTicks(6, 6, 18), 18)

const planPane = read('src/pages/settings/PlanPane.jsx')
t('PlanPane draws its meters from meterFraction/meterTicks',
  /meterFraction\(used, cap\)/.test(planPane) && /meterTicks\(used, cap, TICKS\)/.test(planPane))
t('the unlimited meter states the usage instead of filling',
  /Unlimited — \$\{used\} used/.test(planPane))

// ─── D4: per-plan monitoring copy ────────────────────────────────────────────
console.log('D4 — plan-card "Monitoring" row')

// Candidate ladder: the plan's own activeCandidateLimit (0 / 0 / 1 / 3).
eq('scout',      monitoringRowValue('scout', 'b1'),      'Not included')
eq('c_monitor',  monitoringRowValue('c_monitor', 'b1'),  'Not included')
eq('c_active',   monitoringRowValue('c_active', 'b1'),   '1 active candidate')
eq('c_campaign', monitoringRowValue('c_campaign', 'b1'), '3 active candidates')
t('c_active is singular and c_campaign is plural',
  monitoringRowValue('c_active', 'b1').endsWith('candidate') &&
  monitoringRowValue('c_campaign', 'b1').endsWith('candidates'))

// Action ladder: the BRACKET caps monitoring, and the copy has to say so —
// this is the row that printed "1 active candidates" on all three cards.
t('a_* b1 is singular', monitoringRowValue('a_monitor', 'b1').includes('1 active candidate ·'))
t('a_* b2_5 is plural', monitoringRowValue('a_active', 'b2_5').includes('5 active candidates'))
t('a_* says where its number comes from', /set by your bracket, not the plan/.test(monitoringRowValue('a_active', 'b2_5')))
t('the enterprise bracket is not a number', /Unlimited/.test(monitoringRowValue('a_campaign', 'ent')))
t('no plan row can read "1 active candidates"',
  ['scout', 'c_monitor', 'c_active', 'c_campaign', 'a_monitor', 'a_active', 'a_campaign']
    .every(p => !/\b1 active candidates\b/.test(monitoringRowValue(p, 'b1'))))
t('PlanPane drives the row from monitoringRowValue',
  /v: monitoringRowValue\(key, bracket\)/.test(planPane))
t('PlanPane no longer prints the viewer bracket label as the plan value',
  !/v: c\.planType === 'action'\s*\n\s*\? `\$\{bracketCfg\.label\}/.test(planPane) &&
  !/\? `\$\{bracketCfg\.label\} active candidates`/.test(planPane))
t('the current-subscription header pluralises its bracket too',
  /active candidate\$\{bracketCfg\.max === 1 \? '' : 's'\}/.test(planPane))

// ─── D5: one quota phrase, everywhere ────────────────────────────────────────
console.log('D5 — unlimited-allowance copy')

eq('the shared phrase', UNLIMITED_ACCOUNT, 'Unlimited on your account')
eq('a plan number is labelled as one', planSpecLabel('a_campaign'), 'Campaign plan spec: 4/candidate/mo')

const dossiers  = read('src/pages/Dossiers.jsx')
const bulkModal = read('src/pages/profiler/BulkModal.jsx')
const candDash  = read('src/pages/dashboard/CandidateDashboard.jsx')

t('ActionDashboard drops the bare plan rate when the account is unlimited',
  !/\$\{planCfg\.profilesPerCandidate\} per candidate \/ mo/.test(actionDash) &&
  actionDash.includes(UNLIMITED_ACCOUNT))
t('CandidateDashboard uses the phrase', candDash.includes(UNLIMITED_ACCOUNT))
t('the Profiler no longer says "this plan has no monthly cap"',
  !/this plan has no monthly cap/.test(dossiers) && dossiers.includes(UNLIMITED_ACCOUNT))
t('BulkModal attributes the uncapped allowance to the account',
  !/This plan has no monthly profile cap/.test(bulkModal))
t('PlanPane meters say "on your account", not "on your plan"',
  !/Unlimited on your plan/.test(planPane) && /UNLIMITED_ACCOUNT/.test(planPane))
t('the plan cards say they describe the plan, not the account',
  /plan’s specification/.test(planPane) && /THIS MONTH above/.test(planPane))

// ─── D6: Settings chrome ─────────────────────────────────────────────────────
console.log('D6 — Settings shell')

const settings   = read('src/pages/Settings.jsx')
const stShared   = read('src/pages/settings/shared.jsx')
const notifPane  = read('src/pages/settings/NotificationsPane.jsx')
const secPane    = read('src/pages/settings/SecurityPane.jsx')
const calPane    = read('src/pages/settings/CalendarsPane.jsx')
const layoutZ    = Object.fromEntries(
  [...(read('src/components/Layout.jsx').match(/export const Z = \{([\s\S]*?)\}/)?.[1] ?? '')
    .matchAll(/(\w+):\s*(\d+)/g)].map(([, k, v]) => [k, Number(v)])
)

// item 5 — the phantom badge
t('the "2FA OFF" badge is gone', !/2FA OFF/.test(settings))
t('the Security nav item is still there', /id: 'security'/.test(settings))

// item 9 — the unsaved bar vs. the chat bubble
const barZ = Number(settings.match(/zIndex: (\d+),\n\s*display: 'flex', alignItems: 'center', gap: 14,/)?.[1])
eq('the unsaved bar sits at z 35', barZ, 35)
t('…above the support chat', barZ > layoutZ.CHAT)
t('…below the modal band', barZ < layoutZ.MODAL)
t('the bar is tagged for the breakpoint', /className="st-savebar"/.test(settings))
t('and the breakpoint clears the 52px chat FAB', /\.st-savebar \{[\s\S]*right: 84px !important/.test(stShared))

// item 7 — the stub toggle
t('Toggle exposes an unavailable state', /unavailable/.test(stShared))
t('Toggle sets aria-disabled', /aria-disabled=\{off \|\| undefined\}/.test(stShared))
t('a disabled toggle is not clickable', /onClick=\{off \? undefined : onChange\}/.test(stShared))
t('the controversy row uses it', /unavailable\n/.test(notifPane))
t('the row keeps its NOT YET AVAILABLE label', /<StubPill \/>/.test(notifPane))
t('the two locked alerts no longer share one sentence',
  !/This one can't be switched off/.test(notifPane) &&
  (notifPane.match(/lockNote:/g) || []).length === 2)

// item 8 — the third eye
t('Confirm new password has a show/hide toggle', /eyeBtn\(showConfirm, setShowConfirm\)/.test(secPane))
t('all three eyes share one labelled control',
  (secPane.match(/eyeBtn\(show/g) || []).length === 3 &&
  /aria-label=\{shown \? 'Hide password' : 'Show password'\}/.test(secPane))

// item 6 — the feed URL is a secret
t('the feed URL is masked by default', /maskedFeedUrl/.test(calPane) && /revealed \? feedUrl : maskedFeedUrl/.test(calPane))
t('only the last 4 of the token survive the mask', /slice\(-4\)/.test(calPane))
t('there is a reveal toggle', /aria-label=\{revealed \? 'Hide feed URL' : 'Show feed URL'\}/.test(calPane))
t('Copy still copies the full URL', /navigator\.clipboard\?\.writeText\(feedUrl\)/.test(calPane))
t('the field ellipsises rather than hard-truncating', /textOverflow: 'ellipsis'/.test(calPane))

// ─── D7: every dialog mounts the shared hook ─────────────────────────────────
console.log('D7 — useDialog coverage')

const DIALOGS = [
  ['src/pages/Settings.jsx',                 'Settings confirm dialogs'],
  ['src/pages/Dossiers.jsx',                 'Profiler library Modal'],
  ['src/pages/profiler/BulkModal.jsx',       'Bulk generate'],
  ['src/pages/profiler/ShareModal.jsx',      'Share'],
  ['src/pages/profiler/ReportReader.jsx',    'Verdict lightbox'],
  ['src/pages/profiler/ClaimReviewer.jsx',   'Claim review drawer'],
]
for (const [path, name] of DIALOGS) {
  const src = read(path)
  t(`${name} imports useDialog`, /import \{ useDialog \} from '.*lib\/useDialog'/.test(src))
  t(`${name} calls useDialog`, /useDialog\(/.test(src))
  t(`${name} hand-rolls no Escape listener`, !/e\.key === 'Escape'/.test(src))
}
t('Settings wraps both confirm dialogs, not one',
  (settings.match(/<DialogLayer /g) || []).length === 2 &&
  (settings.match(/<\/DialogLayer>/g) || []).length === 2)
t('BulkModal moved its open-guard above the hooks',
  /export default function BulkModal\(\{ open, \.\.\.props \}\) \{\s*\n\s*if \(!open\) return null/.test(bulkModal))

// item 10 — the drawer's backdrop
const claim = read('src/pages/profiler/ClaimReviewer.jsx')
t('the claim drawer has a backdrop', /position: 'fixed', inset: 0, zIndex: 59/.test(claim))
t('…that closes on click', /onClick=\{onClose\}\s*\n\s*aria-hidden="true"/.test(claim))
t('…and sits under the drawer', /zIndex: 60/.test(claim))
t('the drawer keeps its fixed sheet styling',
  /width: 'min\(380px, 100vw\)'/.test(claim) && /borderLeft/.test(claim))
t('the drawer keeps its close button', /aria-label="Close claim review"/.test(claim))

// ─── ─────────────────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
