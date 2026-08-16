#!/usr/bin/env node
// Badger Board — R1C audit fixes (BROKEN items B3, B14, B15, B6, B8, B9, B13).
//
// The pure helpers live inside .jsx pages (no new src modules were in scope for
// this lane), so each page brackets its pure block with
//   // ─── R1C PURE HELPERS BEGIN ───  …  // ─── R1C PURE HELPERS END ───
// and this file slices that block out and imports it as a real ES module. The
// block therefore must stay free of JSX and of imports — if either creeps in,
// this test fails loudly, which is the point.
//
// Zero-config: node tests/r1c.test.mjs

import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const src  = (p) => readFileSync(join(ROOT, p), 'utf8')
// "Is this string still SHOWN to a user?" — a fix that explains itself in a
// comment must not fail its own assertion for quoting the thing it removed.
const shipped = (p) => src(p)
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')

let pass = 0, fail = 0
const t = (name, cond) => { cond ? pass++ : fail++; console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${name}`) }
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) console.log(`      got ${JSON.stringify(got)} · want ${JSON.stringify(want)}`)
  t(name, ok)
}

const BEGIN = 'R1C PURE HELPERS BEGIN'
const END   = 'R1C PURE HELPERS END'

async function loadPureBlock(file) {
  const s = src(file)
  const a = s.indexOf(BEGIN)
  const b = s.indexOf(END)
  if (a < 0 || b < 0 || b < a) throw new Error(`${file}: pure-helper sentinels missing`)
  const block = s.slice(s.indexOf('\n', a) + 1, s.lastIndexOf('\n', b))
  if (/^\s*import\s/m.test(block)) throw new Error(`${file}: pure block must not import`)
  return import('data:text/javascript;base64,' + Buffer.from(block, 'utf8').toString('base64'))
}

const intel = await loadPureBlock('src/pages/candidate/IntelViews.jsx')
const board = await loadPureBlock('src/pages/ElectionResultsBoard.jsx')

// ═══ B9 — internal QA notes never reach the public board ══════════════════════
console.log('B9 — publicNote(): internal QA fragments are stripped for readers')
const { publicNote, isInternalNoteFragment, INTERNAL_NOTE_MARKERS } = board

t('every documented marker is recognised', [
  'not stamped verified', 'needs a manual look', 'editor override',
  'late pass', 'recomputed from stored',
].every(m => INTERNAL_NOTE_MARKERS.includes(m)))

eq('a note that is nothing but QA chatter disappears entirely',
  publicNote('Needs a manual look; NOT stamped verified.'), null)
eq('the late-pass recompute note disappears',
  publicNote('recomputed from stored published figures 2026-08-12 late pass'), null)
eq('an editor-override fragment is dropped mid-note',
  publicNote('Margin under 1%. · editor override'), 'Margin under 1%.')
eq('the presentable half of a mixed note survives',
  publicNote('All precincts reporting. Needs a manual look; NOT stamped verified.'),
  'All precincts reporting.')
eq('a clean engine reason is passed through untouched',
  publicNote('Lead exceeds the recount threshold with all precincts in.'),
  'Lead exceeds the recount threshold with all precincts in.')
eq('case is ignored',
  publicNote('NEEDS A MANUAL LOOK'), null)
eq('non-strings and blanks yield null', [publicNote(null), publicNote(undefined), publicNote(''), publicNote({ reason: 'x' })], [null, null, null, null])
t('isInternalNoteFragment is exported and case-insensitive',
  isInternalNoteFragment('Late Pass') === true && isInternalNoteFragment('Ward 3 recount') === false)

t('the public board runs reasons through publicNote',
  /const reason\s*=\s*publicNote\(/.test(src('src/pages/ElectionResultsBoard.jsx')))
t('the public board no longer prints "· editor override"',
  !/·\s*editor override/.test(src('src/pages/ElectionResultsBoard.jsx').replace(/'[^']*editor override[^']*'/g, '')))
t('the ADMIN console still shows the raw stored note',
  /contest\.status_detail\.reason/.test(src('src/pages/ElectionResultsAdmin.jsx')) &&
  !/publicNote/.test(src('src/pages/ElectionResultsAdmin.jsx')))

// ═══ B13 — one definition per stat ════════════════════════════════════════════
console.log('B13 — stat derivations agree across board and admin')
const { countCalled, countReporting, hasReportedData, avgPrecinctsIn, isCalledStatus } = board

const FIX = [
  // called + certified are both "called"; declared result rows are irrelevant
  { id: 'a', status: 'called',           precincts_rptg: 10, precincts_total: 10 },
  { id: 'b', status: 'certified',        precincts_rptg: 20, precincts_total: 20 },
  { id: 'c', status: 'reporting',        precincts_rptg: 5,  precincts_total: 10 },
  { id: 'd', status: 'too_close',        precincts_rptg: 9,  precincts_total: 10 },
  { id: 'e', status: 'waiting',          precincts_rptg: 0,  precincts_total: 12 },
  { id: 'f', status: 'recount_possible', precincts_rptg: 0,  precincts_total: 0  },
]
const RESULTS = { c: [{ votes: 0 }], f: [{ votes: 40 }], e: [{ votes: 0 }] }
const resultsOf = (c) => RESULTS[c.id] || []

eq('called counts status in (called, certified) — not declared rows', countCalled(FIX), 2)
t('a race with a declared winner row but no called status is NOT counted',
  countCalled([{ id: 'z', status: 'reporting' }], c => c.status) === 0)
t('isCalledStatus is tolerant of case/nullish',
  isCalledStatus('CALLED') && isCalledStatus('Certified') && !isCalledStatus(null) && !isCalledStatus('reporting'))
t('countCalled accepts a status resolver (the board derives status per contest)',
  countCalled(FIX, () => 'called') === FIX.length)

// a, b, c, d have precincts in; f has votes but no precinct counts; only e is silent.
eq('reporting = any precincts in OR any votes recorded', countReporting(FIX, resultsOf), 5)
t('zero precincts and zero votes is not reporting',
  hasReportedData({ precincts_rptg: 0 }, [{ votes: 0 }]) === false)
t('votes with no precinct counts still counts as reporting',
  hasReportedData({ precincts_rptg: 0 }, [{ votes: 3 }]) === true)

eq('avg precincts is the mean over contests WITH precinct data',
  avgPrecinctsIn(FIX), { pct: Math.round((100 + 100 + 50 + 90 + 0) / 5), contests: 5 })
eq('avg precincts on an empty ballot is 0 with no divide-by-zero',
  avgPrecinctsIn([]), { pct: 0, contests: 0 })
eq('avg precincts never exceeds 100% on an over-reported row',
  avgPrecinctsIn([{ precincts_rptg: 30, precincts_total: 10 }]), { pct: 100, contests: 1 })
t('avg is NOT a share of races — 87 of 251 races at 99% of their own precincts',
  avgPrecinctsIn([
    ...Array.from({ length: 87 }, () => ({ precincts_rptg: 99, precincts_total: 100 })),
  ]).pct === 99)

const admin = src('src/pages/ElectionResultsAdmin.jsx')
t('admin imports the shared countCalled instead of rolling its own',
  /import \{ countCalled \} from '\.\/ElectionResultsBoard'/.test(admin) &&
  /const calledCount\s*=\s*countCalled\(contests\)/.test(admin))
t('admin no longer counts declared result rows for the Races Called stat',
  !/calledCount\s*=\s*contests\.filter\(c => \(resultsMap/.test(admin))
t('the certify button keeps its own backend-aligned count',
  /const calledNotCertified = contests\.filter\(c => c\.status === 'called'\)\.length/.test(admin))
t('the board tile is relabelled so it cannot read as a share of races',
  /Avg precincts in/.test(shipped('src/pages/ElectionResultsBoard.jsx')) &&
  !/Avg Reporting/.test(shipped('src/pages/ElectionResultsBoard.jsx')))

// ═══ B8 — raw AI output is not shown raw ══════════════════════════════════════
console.log('B8 — Intel tab display guards')
const { splitSwotPoints, isPlaceholderOnly, isAllyTemplateRow, splitBracketTokens } = intel

eq('an ARRAY quadrant becomes one point per entry',
  splitSwotPoints(['Deep roots in rural Wisconsin', 'Established organizational credentials']),
  ['Deep roots in rural Wisconsin', 'Established organizational credentials'])
eq('the live bug: bullets baked into one string with • separators',
  splitSwotPoints('Deep roots in rural Wisconsin,• Established organizational credentials• Union backing'),
  ['Deep roots in rural Wisconsin', 'Established organizational credentials', 'Union backing'])
eq('newlines still split, and markdown bullets are stripped',
  splitSwotPoints('- First point\n* Second point\n\n   \n- Third'),
  ['First point', 'Second point', 'Third'])
eq('mixed array + • inside an entry flattens completely',
  splitSwotPoints(['A • B', 'C\nD']), ['A', 'B', 'C', 'D'])
eq('empty / nullish quadrants yield no points',
  [splitSwotPoints(''), splitSwotPoints(null), splitSwotPoints(undefined), splitSwotPoints([])],
  [[], [], [], []])

t('the SWOT renderer uses the splitter, not .split(\'\\n\')',
  /splitSwotPoints\(swot\[q\.key\]\)/.test(src('src/pages/candidate/IntelViews.jsx')) &&
  !/String\(swot\[q\.key\]\)\.split\('\\n'\)/.test(src('src/pages/candidate/IntelViews.jsx')))

t('bare [RESEARCH REQUIRED] is a placeholder', isPlaceholderOnly('[RESEARCH REQUIRED]'))
t('padded / bolded placeholder is a placeholder', isPlaceholderOnly('  **[RESEARCH REQUIRED]**  '))
t('a chain of bracket tokens is still a placeholder', isPlaceholderOnly('[KNOWN] · [X/Live]'))
t('other bracket-only tokens count too', isPlaceholderOnly('[TBD]') && isPlaceholderOnly('[ ]'))
t('empty and nullish count as nothing to show',
  isPlaceholderOnly('') && isPlaceholderOnly(null) && isPlaceholderOnly(undefined))
t('real text with a token is NOT a placeholder',
  isPlaceholderOnly('[KNOWN] Voted against the county budget') === false)
t('plain real text is NOT a placeholder',
  isPlaceholderOnly('Missed 14 of 22 board votes') === false)

t('the weaknesses list filters placeholders before counting',
  /weaknesses \|\| \[\]\)\.filter\(w => !isPlaceholderOnly/.test(src('src/pages/candidate/IntelViews.jsx')))

t('the schema template row is dropped',
  isAllyTemplateRow({ name: 'Org', role: 'Role · Type · Years · Source' }))
t('the template name alone is enough',
  isAllyTemplateRow({ name: 'org' }) && isAllyTemplateRow({ name: 'Organization', role: 'x' }))
t('a field-name-only role is dropped even under a different label',
  isAllyTemplateRow({ name: 'Name', role: 'Role · Source' }))
t('a bracket-token-only ally is dropped',
  isAllyTemplateRow({ name: '[KNOWN]', role: '' }))
t('a real ally survives',
  isAllyTemplateRow({ name: 'Wisconsin Education Association Council', role: 'Endorser · Union · 2022 · WEAC release' }) === false)
t('a real ally whose role happens to contain one field word survives',
  isAllyTemplateRow({ name: 'Sierra Club', role: 'Role: chief endorser since 2018' }) === false)

eq('bracket tokens split out of a name',
  splitBracketTokens('[KNOWN] Sierra Club'),
  [{ type: 'badge', value: 'KNOWN' }, { type: 'text', value: 'Sierra Club' }])
eq('multiple tokens, including the slashed one',
  splitBracketTokens('Sierra Club [KNOWN] [X/Live]'),
  [{ type: 'text', value: 'Sierra Club' }, { type: 'badge', value: 'KNOWN' }, { type: 'badge', value: 'X/Live' }])
eq('plain text produces a single text run',
  splitBracketTokens('Sierra Club'), [{ type: 'text', value: 'Sierra Club' }])
eq('markdown links are left as text, not turned into chips',
  splitBracketTokens('[WEAC](https://weac.org) endorsed'),
  [{ type: 'text', value: '[WEAC](https://weac.org) endorsed' }])

const shared = src('src/pages/candidate/shared.jsx')
t('one chip palette serves both the markdown table and the React rows',
  /export function badgeTheme\(/.test(shared) &&
  /export function Chip\(/.test(shared) &&
  /badgeCss\(b\)/.test(shared))
t('[KNOWN] and [RESEARCH REQUIRED] keep their published colours',
  /'KNOWN':\s*\{ bg: '#dcfce7'/.test(shared) &&
  /'RESEARCH REQUIRED':\s*\{ bg: '#fef3c7'/.test(shared))
t('the Allies rows render tokens through the shared chip',
  /<TokenText text=\{a\.name\} \/>/.test(src('src/pages/candidate/IntelViews.jsx')) &&
  /Chip,\s*\n\} from '\.\/shared'/.test(src('src/pages/candidate/IntelViews.jsx')))

// ═══ B3 / B14 / B15 — admin dashboard ═════════════════════════════════════════
console.log('B3 / B14 / B15 — admin dashboard')
const dash = src('src/pages/AdminDashboard.jsx')

t('the Users table wrapper scrolls horizontally with a min width',
  /\{\/\* Users Table \*\/\}[\s\S]{0,400}?overflow-x-auto"[\s\S]{0,120}?min-w-\[\d+px\]/.test(dash))
t('the Errors table wrapper scrolls horizontally with a min width',
  /\{\/\* Errors Table \*\/\}[\s\S]{0,400}?overflow-x-auto"[\s\S]{0,120}?min-w-\[\d+px\]/.test(dash))
t('no admin table wrapper is left on overflow-hidden with a bare w-full table',
  !/shadow overflow-hidden">\s*\n\s*<table className="w-full text-sm">/.test(dash))

t('the stale hardcoded admin footer version is gone',
  !/v1\.10\.28/.test(shipped('src/pages/AdminDashboard.jsx')))
t('no version string is re-hardcoded in the admin footer',
  !/text-center py-6 text-xs text-gray-500">\s*\n\s*v\d/.test(dash))
t('Layout.jsx remains the single owner of APP_VERSION',
  /const APP_VERSION = 'v1\.\d+\.\d+'/.test(src('src/components/Layout.jsx')))

t('the daily-spend chart has a baseline and top headroom',
  /border-b-2 border-gray-200/.test(dash) && /h-40 pt-2/.test(dash))
t('bar heights are clamped to the plot area',
  /Math\.min\(100, Math\.max\(2, \(d\.cost \/ maxDaily\) \* 100\)\)/.test(dash))
t('the 90-day tile explains itself when it matches the 30-day figure',
  /const sameWindow = calls90 === calls30/.test(dash) &&
  /all logged in the last 30 days/.test(dash))
t('the backend really does compute two distinct windows (so this is a labelling fix)',
  /last_90d: round\(rows\.reduce/.test(src('netlify/functions/admin-dashboard.js')) &&
  /last_30d: round\(inWindow\.reduce/.test(src('netlify/functions/admin-dashboard.js')) &&
  /const inWindow = rows\.filter\(r => new Date\(r\.created_at\)\.getTime\(\) >= d30\)/.test(src('netlify/functions/admin-dashboard.js')))

// ═══ B6 — /offices shows its matches and its loading state ════════════════════
console.log('B6 — offices results list + loading state')
const offices = src('src/pages/Offices.jsx')

t('a results list renders when filters narrow the set',
  /const isFiltered = !!\(levelFilter \|\| typeFilter \|\| debouncedSearch\.trim\(\)\)/.test(offices) &&
  /\{!loading && isFiltered && \(/.test(offices) &&
  /Matching offices/.test(offices))
t('the list is capped and says so',
  /const RESULTS_LIST_CAP = 100/.test(offices) &&
  /offices\.slice\(0, RESULTS_LIST_CAP\)/.test(offices) &&
  /Showing \$\{listedOffices\.length\} of \$\{offices\.length\}/.test(offices))
t('each row carries name, level/type and municipality',
  /LEVEL_LABELS\[o\.level\], TYPE_LABELS\[o\.office_type\], where/.test(offices))
t('a filtered-to-nothing set gets an explicit empty state, not a blank card',
  /No offices match these filters/.test(offices))
t('the first fetch shows a loading state instead of "0 offices"',
  /Loading offices…/.test(offices) &&
  /\{loading \? \([\s\S]{0,400}?Loading offices…/.test(offices))
t('the map is still driven by the same filtered set',
  /<LeafletMapView\s+offices=\{offices\}/.test(offices))

// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
