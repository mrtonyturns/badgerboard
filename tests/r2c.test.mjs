#!/usr/bin/env node
// Badger Board — R2C UI-repair fixes (DEGRADED items from the Aug-16 audit).
//
// Same loader trick as tests/r1c.test.mjs: the pure helpers live inside .jsx
// pages, so each page brackets its pure block with
//   // ─── R2C PURE HELPERS BEGIN ───  …  // ─── R2C PURE HELPERS END ───
// and this file slices that block out and imports it as a real ES module. The
// block must therefore stay free of JSX and of imports.
//
// Zero-config: node tests/r2c.test.mjs

import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { PLAN_CONFIG, normalizePlan } from '../src/lib/tiers.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const src  = (p) => readFileSync(join(ROOT, p), 'utf8')

let pass = 0, fail = 0
const t = (name, cond) => { cond ? pass++ : fail++; console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${name}`) }
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) console.log(`      got ${JSON.stringify(got)} · want ${JSON.stringify(want)}`)
  t(name, ok)
}

async function loadPureBlock(file, tag = 'R2C') {
  const s = src(file)
  const a = s.indexOf(`${tag} PURE HELPERS BEGIN`)
  const b = s.indexOf(`${tag} PURE HELPERS END`)
  if (a < 0 || b < 0 || b < a) throw new Error(`${file}: ${tag} pure-helper sentinels missing`)
  const block = s.slice(s.indexOf('\n', a) + 1, s.lastIndexOf('\n', b))
  if (/^\s*import\s/m.test(block)) throw new Error(`${file}: pure block must not import`)
  return import('data:text/javascript;base64,' + Buffer.from(block, 'utf8').toString('base64'))
}

const events  = await loadPureBlock('src/pages/Events.jsx')
const connect = await loadPureBlock('src/pages/CampaignConnect.jsx')
const admin   = await loadPureBlock('src/pages/AdminDashboard.jsx')
const intel   = await loadPureBlock('src/pages/candidate/IntelViews.jsx', 'R1C')

// ═══ 1 — Events no longer starts a 2-minute AI job on page load ═══════════════
console.log('1 — the district-events search is click-gated')
{
  const s = src('src/pages/Events.jsx')
  t('the mount effect no longer calls loadEvents',
    !/useEffect\(\(\)\s*=>\s*\{\s*if\s*\(target\?\.key\)\s*\{[^}]*loadEvents/.test(s))
  t('mount reads the shared cache instead', /Promise\.all\(\[readCache\(key\), readProgress\(key\)\]\)/.test(s))
  t('mount still ATTACHES to a run already in flight (it starts nothing)',
    /prog\?\.status === 'running'/.test(s) && /await watchRun\(key,/.test(s))
  t('there is exactly one POST to the research function, inside loadEvents',
    (s.match(/fetch\('\/\.netlify\/functions\/research-district-events-background'/g) || []).length === 1)
  t('an explicit "Search for new events" control exists', /Search for new events/.test(s))
  t('the start state names the job', /Find conservative events in your districts/.test(s))
  t('a last-searched timestamp is shown', /Last searched/.test(s))
}

// ═══ 2 — Events card presentation ════════════════════════════════════════════
console.log('2 — Events cards: badge order, CTA alignment, internal strings')
{
  const s = src('src/pages/Events.jsx')
  const { dateBadgeParts, leanBadge } = events

  // (d) date badge is month-over-day, like the rest of the app
  eq('badge splits into month + day', dateBadgeParts('2026-08-19'), { month: 'Aug', day: '19' })
  eq('a junk date yields no badge', dateBadgeParts('not-a-date'), null)
  t('the month renders above the day in the card',
    s.indexOf('{dayBadge.month}') < s.indexOf('{dayBadge.day}'))

  // (b) tier codes never reach the card face
  eq('T1 → registered host', leanBadge('T1: county party host'),
    { text: 'Registered host', title: 'T1: county party host' })
  eq('T2 → documented alignment', leanBadge('T2: union host (AFSCME)'),
    { text: 'Documented alignment', title: 'T2: union host (AFSCME)' })
  eq('T3 → area lean only', leanBadge('T3: chamber of commerce host, unknown area lean'),
    { text: 'Area lean only', title: 'T3: chamber of commerce host, unknown area lean' })
  eq('registry pass → registry checked', leanBadge('Registry check: no partisan signal found'),
    { text: 'Registry checked', title: 'Registry check: no partisan signal found' })
  eq('unrecognised / empty basis shows nothing',
    [leanBadge(''), leanBadge(null), leanBadge('who knows')], [null, null, null])
  t('the raw basis string is no longer printed on the card',
    !/>\{lean\.basis/.test(s) && !/\{lean\.basis \|\| ''\}/.test(s))

  // (a) CTA pinned to the bottom of a flex-column card
  t('the card is a flex column', /transition-all shadow-sm hover:shadow-lg hover:-translate-y-0\.5 flex flex-col/.test(s))
  t('the CTA row uses mt-auto', /className="mt-auto pt-3 flex gap-2"/.test(s))

  // (c) US spelling in the progress copy
  t('"Organizing" replaces "Organising"', /Organizing events and reading each crowd/.test(s) && !/Organising/.test(s))

  // (e) select-mode cards are keyboard-operable
  t('select-mode cards get role/tabIndex/keyboard', /role: 'button',\s*\n\s*tabIndex: 0,/.test(s) && /e\.key === 'Enter' \|\| e\.key === ' '/.test(s))

  // (f) dialogs share the app's dialog contract
  t('Events imports useDialog', /import \{ useDialog \} from '\.\.\/lib\/useDialog'/.test(s))
  t('both Events modals render through <Dialog>', (s.match(/<Dialog /g) || []).length >= 2)
}

// ═══ 3 — Campaign Connect tab state lives in the URL ══════════════════════════
console.log('3 — Campaign Connect: ?tab= parsing and a stable tab row')
{
  const { parseTabParam } = connect
  const keys = ['team', 'invites', 'shared']
  eq('a known key passes through', parseTabParam('shared', keys, 'team'), 'shared')
  eq('"invitations" is an alias for the internal "invites"', parseTabParam('invitations', keys, 'team'), 'invites')
  eq('case is ignored', parseTabParam('SHARED', keys, 'team'), 'shared')
  eq('an unknown key falls back', parseTabParam('nonsense', keys, 'team'), 'team')
  eq('a key not offered to THIS user falls back',
    parseTabParam('managers', keys, 'team'), 'team')
  eq('missing/blank falls back', [parseTabParam(null, keys, 'team'), parseTabParam('', keys, 'team')], ['team', 'team'])

  const s = src('src/pages/CampaignConnect.jsx')
  t('the tab row is rendered before the hero',
    s.indexOf('{/* ── Tabs ──') < s.indexOf('{/* ── Hero ──'))
  t('the tab is read from the URL', /searchParams\.get\('tab'\)/.test(s))
  t('the invite-type grid collapses at sm', /grid grid-cols-1 sm:grid-cols-2 gap-2 mb-3/.test(s))
}

// ═══ 4 — the unread banner cannot move the candidate tab bar ══════════════════
console.log('4 — CandidateDetail: unread strip sits below the nav')
{
  const s = src('src/pages/CandidateDetail.jsx')
  t('the unread strip now renders after the sub-tab row',
    s.indexOf('unread strip (SPEC §2)') > s.indexOf('group pill nav (SPEC §3)'))
  t('there is exactly one unread strip', (s.match(/unread strip \(SPEC §2\)/g) || []).length === 1)
}

// ═══ 5 — news summaries stop at a word, and say so ════════════════════════════
console.log('5 — IntelViews: word-boundary trim + a tooltip that actually shows')
{
  const { trimToWord } = intel
  eq('short text is untouched', trimToWord('A short summary.'), 'A short summary.')
  eq('blank in, blank out', [trimToWord(''), trimToWord(null), trimToWord(undefined)], ['', '', ''])

  const long = ('word '.repeat(60)).trim()          // 299 chars
  const cut = trimToWord(long, 250)
  t('an over-length string is marked with an ellipsis', cut.endsWith('…'))
  t('the trim lands on a word boundary', !/\bwor…$/.test(cut) && cut.slice(0, -1).endsWith('word'))
  t('the result never exceeds the cap', cut.length <= 250)

  eq('trailing punctuation is not left dangling before the ellipsis',
    trimToWord('aaaa bbbb cccc, dddd', 16), 'aaaa bbbb cccc…')

  const oneLongToken = 'x'.repeat(400)
  t('a single enormous token still gets cut', trimToWord(oneLongToken, 250).length === 251)

  const s = src('src/pages/candidate/IntelViews.jsx')
  t('news descriptions run through the trimmer', /\{trimToWord\(item\.description\)\}/.test(s))
  t('the disabled Broadside button no longer relies on title=',
    /title=\{sparHref \? 'Open Broadside and spar against this profile' : undefined\}/.test(s))
  t('a group-hover tooltip replaces it', /hidden group-hover:block/.test(s))
}

// ═══ 6/7 — failures look like failures, not emptiness ═════════════════════════
console.log('6/7 — error states are distinct from empty states')
{
  const rec = src('src/pages/candidate/RecordViews.jsx')
  t('the results query error is captured, not just logged', /if \(qErr\) throw qErr/.test(rec))
  t('a distinct error state exists', /Couldn't load election results/.test(rec))
  t('it offers a retry', /setReloadKey\(k => k \+ 1\)/.test(rec))
  t('the empty state still exists separately', /No election results on file/.test(rec))

  const nc = src('src/components/NotificationCenter.jsx')
  t('a failed announcement fetch is tracked', /setLoadFailed\(true\)/.test(nc))
  t('the panel says so instead of "No notifications yet"', /Couldn&apos;t load notifications/.test(nc))
}

// ═══ 8 — Admin: plan labels, last login, modal band ═══════════════════════════
console.log('8 — AdminDashboard: plan labels, last login, dialogs')
{
  const { planLabelFrom, relativeTime } = admin
  const label = (p) => planLabelFrom(p, PLAN_CONFIG, normalizePlan)

  eq('c_campaign reads as a product name', label('c_campaign'), 'Candidate Campaign')
  eq('a_campaign is distinguished from it', label('a_campaign'), 'Action Campaign')
  eq('the legacy "campaign" slug resolves to the Action plan and is marked',
    label('campaign'), 'Action Campaign (legacy)')
  eq('the legacy "monitor" slug resolves to the Candidate plan and is marked',
    label('monitor'), 'Candidate Monitor (legacy)')
  eq('c_monitor / a_monitor stay apart', [label('c_monitor'), label('a_monitor')],
    ['Candidate Monitor', 'Action Monitor'])
  eq('scout, null and junk all read as the free plan',
    [label('scout'), label(null), label('nonsense')],
    ['Scout (free)', 'Scout (free)', 'Scout (free)'])
  t('no label is a bare slug', !/[_]/.test(label('c_active')))

  const now = Date.parse('2026-08-16T12:00:00Z')
  eq('relative time: minutes', relativeTime('2026-08-16T11:30:00Z', now), '30m ago')
  eq('relative time: hours',   relativeTime('2026-08-16T04:00:00Z', now), '8h ago')
  eq('relative time: days',    relativeTime('2026-08-10T12:00:00Z', now), '6d ago')
  eq('relative time: months',  relativeTime('2026-05-16T12:00:00Z', now), '3mo ago')
  eq('relative time: seconds round to "just now"', relativeTime('2026-08-16T11:59:40Z', now), 'just now')
  eq('no value → empty string', [relativeTime(null, now), relativeTime('', now)], ['', ''])

  const s = src('src/pages/AdminDashboard.jsx')
  t('the Last Login cell reads the field the API actually returns',
    /u\.last_sign_in_at \? \(/.test(s) && !/u\.last_login/.test(s))
  t('the Plan cell shows the RESOLVED plan', /planLabel\(u\.resolved_plan \|\| u\.plan\)/.test(s))
  t('the raw slug survives for debugging', /raw app_metadata\.plan: /.test(s))
  t('an entitlement-source marker is shown', /u\.plan_source/.test(s))
  t('no admin modal is left in the z-40 band',
    !/flex items-center justify-center z-40/.test(s))
  t('all six converted modals mount useDialog', (s.match(/useDialog\(onClose\)/g) || []).length === 6)
  t('the Change Plan grids collapse at sm',
    /grid grid-cols-1 sm:grid-cols-2 gap-2/.test(s) && /grid grid-cols-1 sm:grid-cols-3 gap-2/.test(s))
  t('the tab strip has a scroll affordance', /bg-gradient-to-l from-white to-transparent/.test(s))
  t('the sticky tab bar is opaque', /bg-white sticky top-0 z-20/.test(s))
  t('the admin toast moved out of the modal band', /z-\[9999\]/.test(s))

  const fn = src('netlify/functions/admin-dashboard.js')
  t('the function returns last_sign_in_at', /last_sign_in_at: u\.last_sign_in_at \|\| null/.test(fn))
  t('the function resolves the entitlement server-side', /resolveEntitlement\(u, \{ globalBeta \}\)/.test(fn))
  t('and ships plan + source', /resolved_plan: resolved\.plan/.test(fn) && /plan_source: resolved\.source/.test(fn))
}

// ═══ 9 — modal grids collapse; dialogs share one contract ════════════════════
console.log('9 — Elections / GamePlan / Offices dialogs')
{
  for (const [file, n] of [['src/pages/Elections.jsx', 2], ['src/pages/GamePlan.jsx', 2], ['src/pages/Offices.jsx', 3]]) {
    const s = src(file)
    t(`${file}: imports useDialog`, /useDialog/.test(s))
    eq(`${file}: ${n} modal grid(s) collapse at sm`,
      (s.match(/grid grid-cols-1 sm:grid-cols-2 gap-4/g) || []).length, n)
    t(`${file}: no hard 2-col modal grid left`, !/className="grid grid-cols-2 gap-4"/.test(s))
  }
  t('GamePlan gates the modal body so the hook mounts with the dialog',
    /function ElectionModal\(\{ open, \.\.\.props \}\)/.test(src('src/pages/GamePlan.jsx')))
}

// ═══ 10 — unknown routes get a 404, not a silent redirect ════════════════════
console.log('10 — App: catch-all renders NotFound')
{
  const s = src('src/App.jsx')
  t('NotFound is wired to the catch-all', /<Route path="\*" element=\{<NotFound \/>\} \/>/.test(s))
  t('the silent redirect is gone', !/path="\*" element=\{<Navigate to="\/" replace \/>\}/.test(s))
  t('deliberate legacy redirects survive',
    /path="\/volunteer" element=\{<Navigate to="\/v"/.test(s) &&
    /elections\/results\/:id/.test(s))
  const nf = src('src/pages/NotFound.jsx')
  t('the 404 page says what it is', /Page not found/.test(nf))
  t('and links home', /<Link to="\/"/.test(nf))
}

// ═══ 11 — clickable divs are reachable from a keyboard ═══════════════════════
console.log('11 — clickable divs get role/tabIndex/Enter+Space')
{
  for (const file of ['src/components/DistrictElectionHistory.jsx', 'src/components/DistrictDashboard.jsx']) {
    const s = src(file)
    // Either the literal form (role="button" tabIndex={0}) or the conditional
    // one used where the row is only sometimes clickable.
    t(`${file}: role="button"`, /role=(["']button["']|\{[^}]*'button')/.test(s))
    t(`${file}: tabIndex`, /tabIndex=\{[^}]*0/.test(s))
    t(`${file}: Enter and Space activate`, /Enter'\s*\|\|\s*\w+\.key === ' '/.test(s))
  }
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
