#!/usr/bin/env node
// Badger Board — Tier 3A: duplicate-helper consolidation + two data contracts.
//
//   1. ONE safeISO, with both contracts named (lib/date.js). Three copies had
//      OPPOSITE null behaviour — null vs new Date(0) — and both were
//      load-bearing.
//   2. StatStrip: the profiler's is a different widget from the dashboards',
//      renamed rather than merged (no pixels changed).
//   3. ONE office-line formatter (lib/office.js), preserving all three callers'
//      exact output strings.
//   4. ONE scorePassword (lib/password.js) — three identical copies, one of
//      which gated account security.
//   5. ONE plural (lib/text.js).
//   6. Every party dropdown is driven by lib/party.js DB_PARTIES.
//   7. The notification_preferences defaults cover every column the app reads.
//
// Zero-config: node tests/tier3a.test.mjs

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const src  = (p) => readFileSync(join(ROOT, p), 'utf8')

let pass = 0, fail = 0
const t = (name, cond) => { cond ? pass++ : fail++; console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${name}`) }

// ─── 1: safeISO — one implementation, two named contracts ────────────────────
console.log('1 — lib/date.js safeISO / safeISOOrEpoch')

const { safeISO, safeISOOrEpoch } = await import('../src/lib/date.js')

t('a good ISO date parses to that date',
  safeISO('2026-04-07')?.getFullYear() === 2026)
t('safeISO returns NULL for missing / malformed input — the dashboards branch on this',
  safeISO(null) === null && safeISO(undefined) === null &&
  safeISO('') === null && safeISO('not a date') === null && safeISO({}) === null)
t('safeISOOrEpoch returns the EPOCH for the same input — Elections/GamePlan pass it to date-fns unchecked',
  safeISOOrEpoch(null).getTime() === 0 && safeISOOrEpoch('').getTime() === 0 &&
  safeISOOrEpoch('not a date').getTime() === 0)
t('safeISOOrEpoch never returns an Invalid Date (the crash the epoch fallback exists to stop)',
  [null, undefined, '', 'garbage', 0, {}].every(v => Number.isFinite(+safeISOOrEpoch(v))))
t('both agree on a valid date',
  +safeISO('2026-11-03T12:00:00Z') === +safeISOOrEpoch('2026-11-03T12:00:00Z'))
t('each epoch fallback is a fresh Date object (callers may mutate)',
  safeISOOrEpoch(null) !== safeISOOrEpoch(null))

// The three former copies are gone; each page states which contract it took.
{
  const dash = src('src/pages/dashboard/shared.jsx')
  const elec = src('src/pages/Elections.jsx')
  const game = src('src/pages/GamePlan.jsx')
  t('no page defines its own safeISO any more',
    !/const safeISO = \(d\) => \{/.test(dash + elec + game))
  t('Elections.jsx and GamePlan.jsx import the EPOCH contract explicitly',
    /safeISOOrEpoch as safeISO/.test(elec) && /safeISOOrEpoch as safeISO/.test(game))
  t('dashboard/shared.jsx still exports safeISO for the candidate views',
    /export \{ safeISO \}/.test(dash))
}

// ─── 2: StatStrip — two different widgets, no longer one name ────────────────
console.log('2 — StatStrip name collision')
{
  const prof = src('src/pages/profiler/shared.jsx')
  const dash = src('src/pages/dashboard/shared.jsx')
  t('the dashboards keep StatStrip (unchanged, responsive 2-up below 760px)',
    /export function StatStrip\(/.test(dash) && dash.includes('.bb-statstrip'))
  t('the profiler widget is now ProfilerStatStrip',
    /export function ProfilerStatStrip\(/.test(prof) && !/export function StatStrip\(/.test(prof))
  t('the profiler strip still takes explicit cols + style (why it was not merged)',
    /ProfilerStatStrip\(\{ children, cols, style \}\)/.test(prof))
  t('both profiler consumers were updated',
    src('src/pages/Dossiers.jsx').includes('<ProfilerStatStrip cols={3}>') &&
    src('src/pages/profiler/ReportReader.jsx').includes('<ProfilerStatStrip cols={4}>'))
  t('no file imports StatStrip from the profiler shell any more',
    !/StatStrip[^}]*\} from '\.\/profiler\/shared'/.test(src('src/pages/Dossiers.jsx').replace(/ProfilerStatStrip/g, '')))
}

// ─── 3: office line — one formatter, three exact output strings ──────────────
console.log('3 — lib/office.js officeLine')

const { officeLine, officeParts } = await import('../src/lib/office.js')

const OFFICE_NAMED  = { name: 'State Representative', district_name: 'Assembly District 1', district_number: 1 }
const OFFICE_NUMBER = { name: 'State Senator', district_number: 12 }
const OFFICE_BARE   = { name: 'Mayor' }

// dashboard/shared.jsx officeLine — ' — ', null when there is no office
t('dashboard format: "Office — District name"',
  officeLine(OFFICE_NAMED) === 'State Representative — Assembly District 1')
t('dashboard format falls back to the district NUMBER',
  officeLine(OFFICE_NUMBER) === 'State Senator — District 12')
t('dashboard format with no district at all is just the office',
  officeLine(OFFICE_BARE) === 'Mayor')
t('dashboard format returns null for no office (fmtDate/JSX branch on it)',
  officeLine(null) === null && officeLine(undefined) === null)

// ActionDashboard.jsx officeText — ' · ', 'No office linked'
t('action-dashboard format uses a middot',
  officeLine(OFFICE_NAMED, { sep: ' · ', empty: 'No office linked' }) ===
    'State Representative · Assembly District 1')
t('action-dashboard format keeps its own empty copy',
  officeLine(null, { sep: ' · ', empty: 'No office linked' }) === 'No office linked')

// ReportReader.jsx — ' — ', '' when there is no office (rendered into JSX)
t('report-reader format returns the empty string, not null',
  officeLine(null, { empty: '' }) === '' &&
  officeLine(OFFICE_NAMED, { empty: '' }) === 'State Representative — Assembly District 1')

t('district_name always beats district_number',
  officeParts({ name: 'X', district_name: 'Ward 3', district_number: 9 })[1] === 'Ward 3')
t('district_number 0 is not rendered as "District 0"',
  officeLine({ name: 'X', district_number: 0 }) === 'X')
t('officeParts on nothing is an empty array', officeParts(null).length === 0)

{
  const act = src('src/pages/dashboard/ActionDashboard.jsx')
  const rr  = src('src/pages/profiler/ReportReader.jsx')
  t('ActionDashboard and ReportReader no longer build the line by hand',
    act.includes("officeLine(office, { sep: ' · '") &&
    rr.includes("officeLine(office, { empty: '' })") &&
    !/District \$\{office\.district_number\}/.test(act + rr))
}

// ─── 4: scorePassword — one copy, identical scores ──────────────────────────
console.log('4 — lib/password.js scorePassword')

const { scorePassword, PASSWORD_MIN_SCORE, PASSWORD_MIN_LENGTH } =
  await import('../src/lib/password.js')

// A verbatim copy of the scorer as it stood in Login.jsx / ResetPassword.jsx /
// SecurityPane.jsx before the extraction. Nothing about scoring may change.
function scorePasswordBefore(pw) {
  if (!pw) return { score: 0, label: '', color: '', pct: 0 }
  let score = 0
  if (pw.length >= 8)           score++
  if (pw.length >= 12)          score++
  if (/[A-Z]/.test(pw))        score++
  if (/[a-z]/.test(pw))        score++
  if (/[0-9]/.test(pw))        score++
  if (/[^A-Za-z0-9]/.test(pw)) score++
  if (score <= 2) return { score, label: 'Weak',   color: '#ef4444', pct: 25  }
  if (score <= 3) return { score, label: 'Fair',   color: '#f97316', pct: 50  }
  if (score <= 4) return { score, label: 'Good',   color: '#eab308', pct: 75  }
  return             { score, label: 'Strong', color: '#22c55e', pct: 100 }
}

const PW_CORPUS = [
  '', 'a', 'abc', 'abcdefg', 'abcdefgh', 'ABCDEFGH', '12345678', '!!!!!!!!',
  'abcdefgh1', 'Abcdefgh', 'Abcdefgh1', 'Abcdefgh1!', 'abcdefghijkl',
  'Abcdefghijkl', 'Abcdefghijkl1', 'Abcdefghijkl1!', 'P@ssw0rd', 'P@ssw0rd!!!!',
  'correct horse battery staple', 'ÜMLÄUTé123!', '        ', 'aA1!',
]
t('every password in the corpus scores identically to the pre-extraction copy',
  PW_CORPUS.every(pw =>
    JSON.stringify(scorePassword(pw)) === JSON.stringify(scorePasswordBefore(pw))))
t('an empty password scores 0 with no label (the bars render nothing)',
  JSON.stringify(scorePassword('')) === JSON.stringify({ score: 0, label: '', color: '', pct: 0 }))
t('the four labels, colours and bar percentages are unchanged',
  JSON.stringify(scorePassword('abcdefgh')) ===        // score 2
    JSON.stringify({ score: 2, label: 'Weak',   color: '#ef4444', pct: 25  }) &&
  JSON.stringify(scorePassword('Abcdefgh')) ===        // score 3
    JSON.stringify({ score: 3, label: 'Fair',   color: '#f97316', pct: 50  }) &&
  JSON.stringify(scorePassword('Abcdefgh1')) ===       // score 4
    JSON.stringify({ score: 4, label: 'Good',   color: '#eab308', pct: 75  }) &&
  JSON.stringify(scorePassword('Abcdefghijkl1!')) ===  // score 6
    JSON.stringify({ score: 6, label: 'Strong', color: '#22c55e', pct: 100 }))
t('the shared gate is still "Fair or better", minimum length still 8',
  PASSWORD_MIN_SCORE === 3 && PASSWORD_MIN_LENGTH === 8)

{
  const login = src('src/pages/Login.jsx')
  const reset = src('src/pages/ResetPassword.jsx')
  const sec   = src('src/pages/settings/SecurityPane.jsx')
  t('no page defines scorePassword any more',
    !/function scorePassword\(/.test(login + reset + sec))
  t('all three import it from lib/password',
    /from '\.\.\/lib\/password'/.test(login) && /from '\.\.\/lib\/password'/.test(reset) &&
    /from '\.\.\/\.\.\/lib\/password'/.test(sec))
  t('all three gate on the same shared threshold constant',
    login.includes('PASSWORD_MIN_SCORE') && reset.includes('PASSWORD_MIN_SCORE') &&
    sec.includes('PASSWORD_MIN_SCORE'))
}

// ─── 5: plural — one copy ────────────────────────────────────────────────────
console.log('5 — lib/text.js plural')

const { plural } = await import('../src/lib/text.js')

t('singular', plural(1, 'candidate') === '1 candidate')
t('plural', plural(3, 'candidate') === '3 candidates')
t('zero is plural', plural(0, 'profile') === '0 profiles')
t('irregular plural is honoured', plural(2, 'person', 'people') === '2 people')
t('irregular is ignored at n === 1', plural(1, 'person', 'people') === '1 person')
t('multi-word nouns still get the s', plural(2, 'section note') === '2 section notes')
t('no module defines its own plural any more',
  !/^(export )?const plural = /m.test(
    src('src/pages/settings/shared.jsx') +
    src('src/pages/profiler/shared.jsx') +
    src('src/pages/profiler/reportModel.js')))
t('all three re-export or import the shared one',
  src('src/pages/settings/shared.jsx').includes("from '../../lib/text'") &&
  src('src/pages/profiler/shared.jsx').includes("from '../../lib/text'") &&
  src('src/pages/profiler/reportModel.js').includes("from '../../lib/text'"))

// ─── 6: party dropdowns all driven by DB_PARTIES ────────────────────────────
console.log('6 — party dropdowns')

const { DB_PARTIES, PARTY_FAMILY_OPTIONS, partyGroup, normalizePartyForDb } =
  await import('../src/lib/party.js')

t('DB_PARTIES is the 9-value candidates.party CHECK, in order',
  JSON.stringify(DB_PARTIES) === JSON.stringify([
    'Republican', 'Democrat', 'Independent', 'Libertarian',
    'Green', 'Constitution', 'Working Families', 'Nonpartisan', 'Other',
  ]))
// campaignEnums.js is imported by source rather than executed: it uses Vite's
// extensionless import specifiers, which bare node cannot resolve.
t('campaignEnums.PARTIES is still the same array, not a copy',
  /export const PARTIES = DB_PARTIES/.test(src('src/lib/campaignEnums.js')))
t('every option a dropdown offers survives normalizePartyForDb unchanged',
  DB_PARTIES.every(p => normalizePartyForDb(p) === p))

{
  const profile = src('src/pages/candidate/ProfileData.jsx')
  const admin   = src('src/pages/ElectionResultsAdmin.jsx')
  const prosp   = src('src/pages/Prospecting.jsx')
  const voters  = src('src/pages/VoterLists.jsx')

  t('candidate profile picker is DB_PARTIES (it was missing Working Families)',
    /export const PARTIES = DB_PARTIES/.test(profile) &&
    !/'Republican', 'Democrat'/.test(profile))
  t('candidate profile picker keeps its "No party" blank option',
    profile.includes("{ value: '', label: 'No party' }"))

  t('election-results admin picker is DB_PARTIES',
    /const PARTIES = DB_PARTIES/.test(admin) && !/'Democrat', 'Republican'/.test(admin))

  t('prospecting filter is DB_PARTIES',
    /const PARTY_OPTIONS  = DB_PARTIES/.test(prosp))
  t('prospecting filter keeps its "All parties" blank option',
    prosp.includes('<option value="">All parties</option>'))

  t('voter-list filter is derived from DB_PARTIES, not a hardcoded R/D/I',
    voters.includes('PARTY_FAMILY_OPTIONS.map') &&
    !/<option value="R">Republican<\/option>/.test(voters))
  t('voter-list filter keeps its "All Parties" blank option',
    voters.includes('<option value="">All Parties</option>'))

  t('no UI file hardcodes a party-name array any more',
    ![profile, admin, prosp].some(f => /\[\s*'Republican',\s*'Democrat'/.test(f)))
}

t('PARTY_FAMILY_OPTIONS values are partyGroup() families, one per family',
  PARTY_FAMILY_OPTIONS.every(o => partyGroup(o.label) === o.value) &&
  new Set(PARTY_FAMILY_OPTIONS.map(o => o.value)).size === PARTY_FAMILY_OPTIONS.length)
t('every DB party is reachable through some family option',
  DB_PARTIES.every(p => PARTY_FAMILY_OPTIONS.some(o => o.value === partyGroup(p))))
t('the three names sharing the "O" family collapse to one "Other" entry',
  PARTY_FAMILY_OPTIONS.filter(o => o.value === 'O').length === 1 &&
  PARTY_FAMILY_OPTIONS.find(o => o.value === 'O').label === 'Other')
t('a GOP / DEM voter-file spelling still matches the R / D options',
  partyGroup('GOP') === 'R' && partyGroup('Democratic') === 'D')

// ─── 7: notification_preferences defaults cover every column ────────────────
console.log('7 — notification preference defaults')
{
  const settings = src('src/pages/Settings.jsx')

  // Columns the table actually has, read straight from the migrations.
  const migrations =
    src('supabase/migrations/20260812000020_schema_reconciliation.sql') +
    src('supabase/migrations/20260721000005_share_ack_org_ai_default.sql')
  const tableColumns = [...migrations.matchAll(
    /notification_preferences\s+add\s+column\s+if\s+not\s+exists\s+(\w+)/gi
  )].map(m => m[1].toLowerCase())

  const defaultsBlock = settings.match(/const NOTIF_PREF_DEFAULTS = \{([\s\S]*?)\n\}/)
  const defaultKeys = defaultsBlock
    ? [...defaultsBlock[1].matchAll(/^\s*(\w+):/gm)].map(m => m[1])
    : []

  t('Settings.jsx declares a NOTIF_PREF_DEFAULTS object', defaultKeys.length > 0)
  t('the defaults now include weekly_digest and ai_access_default (the two that were missing)',
    defaultKeys.includes('weekly_digest') && defaultKeys.includes('ai_access_default'))
  t('every notification_preferences column in the migrations has a default',
    tableColumns.length >= 7 && tableColumns.every(c => defaultKeys.includes(c)))
  t('every default corresponds to a real column (no invented keys)',
    defaultKeys.every(k => tableColumns.includes(k)))
  t('all defaults are true — the table is BOOLEAN NOT NULL DEFAULT true',
    defaultsBlock && !/:\s*false/.test(defaultsBlock[1]))
  t('the email toggles still write only their own five columns',
    /const NOTIF_KEYS = \['payment_failed', 'payment_receipt', 'plan_changed', 'account_locked', 'dossier_ready'\]/.test(settings) &&
    settings.includes('writePrefRow(toggleWrite('))
  t('the always-on rule is untouched',
    settings.includes('payment_failed: true, account_locked: true'))
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
