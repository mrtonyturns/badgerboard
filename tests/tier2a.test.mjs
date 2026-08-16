#!/usr/bin/env node
// Badger Board — Tier-2A audit fixes (voter lists · recruit · party vocabulary).
// Zero-config: node tests/tier2a.test.mjs
//
// Covers:
//   T1 — partyVanCode(): GOP must not be written as VAN's Green code
//   T2 — the VoterLists party filter now routes through partyGroup()
//   T3 — the district-lean primary exclusion matches ANY *primary* type
//   T4 — normalizePartyForDb() on the "No party" path (CHECK-safe null)
//   T5 — retryable research statuses include skipped_quota
//   T6 — cache-served results are stamped so they don't spend the allowance
//
// Predicates that live inside .jsx components can't be imported by node, so
// those items are covered two ways: the pure vocabulary/helper behaviour is
// asserted directly, and the call site is asserted against the component
// source so a regression to the old string compare fails this file.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

let pass = 0, fail = 0
const t = (name, cond) => { cond ? pass++ : fail++; console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${name}`) }

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = (p) => readFileSync(join(ROOT, p), 'utf8')

const P = await import('../src/lib/party.js')
const R = await import('../src/lib/recruit.js')

// ─── T1: VAN party code ───────────────────────────────────────────────────────
console.log('T1 — partyVanCode (VAN / VoteBuilder PartyCode)')

t("'GOP' is R, not G (G is GREEN in a VAN file)", P.partyVanCode('GOP') === 'R')
t("'Republican' → R", P.partyVanCode('Republican') === 'R')
t("'Rep' → R",        P.partyVanCode('Rep') === 'R')
t("'R' → R",          P.partyVanCode('R') === 'R')
t("'Democrat' → D",   P.partyVanCode('Democrat') === 'D')
t("'Democratic' → D (the AD77 spelling)", P.partyVanCode('Democratic') === 'D')
t("'DEM' → D",        P.partyVanCode('DEM') === 'D')
t("'Green' → G",      P.partyVanCode('Green') === 'G')
t("'Libertarian' → L", P.partyVanCode('Libertarian') === 'L')
t("'Independent' → I", P.partyVanCode('Independent') === 'I')
t("'Nonpartisan' → N", P.partyVanCode('Nonpartisan') === 'N')
t("blank → U (unchanged from the old export)", P.partyVanCode('') === 'U' && P.partyVanCode(null) === 'U' && P.partyVanCode(undefined) === 'U')
t("whitespace-only → U", P.partyVanCode('   ') === 'U')
t("unrecognised text → O, never its own initial", P.partyVanCode('Pirate') === 'O' && P.partyVanCode('Constitution') === 'O')
t('every code is a single A–Z letter',
  ['GOP', 'Democrat', 'Green', 'Libertarian', 'Independent', 'Nonpartisan', 'Working Families', '', 'Pirate']
    .every(x => /^[A-Z]$/.test(P.partyVanCode(x))))
t('no Republican spelling can ever emit the Green code',
  ['GOP', 'gop', 'Rep', 'REPUBLICAN', 'r', 'Republican Party'].every(x => P.partyVanCode(x) !== 'G'))

// the pre-fix implementation, kept as the thing we must NOT do again
const oldVanCode = (p) => (p || '').toUpperCase().charAt(0) || 'U'
t('the old first-letter rule really did corrupt GOP → G (regression guard)',
  oldVanCode('GOP') === 'G' && P.partyVanCode('GOP') === 'R')

// ─── T2: voter party filter ───────────────────────────────────────────────────
console.log('T2 — VoterLists party filter')

// The predicate as it now reads in VoterLists.jsx (voterMatchesFilters).
const matchesParty = (partyFilter, voter) => !partyFilter || P.partyGroup(voter.party) === partyFilter

t("filter 'R' matches a GOP-spelled row (the bug)", matchesParty('R', { party: 'GOP' }))
t("filter 'R' matches 'Republican' / 'Rep' / 'R'",
  ['Republican', 'Rep', 'R', 'REPUBLICAN'].every(p => matchesParty('R', { party: p })))
t("filter 'D' matches 'Democrat' / 'Democratic' / 'DEM' / 'D'",
  ['Democrat', 'Democratic', 'DEM', 'd'].every(p => matchesParty('D', { party: p })))
t("filter 'I' matches 'Independent' / 'IND'", matchesParty('I', { party: 'Independent' }) && matchesParty('I', { party: 'IND' }))
t("filter 'R' does not match a Democrat", !matchesParty('R', { party: 'Democrat' }))
t("filter 'D' does not match 'Green'", !matchesParty('D', { party: 'Green' }))
t('empty filter matches everything, including a blank party',
  matchesParty('', { party: '' }) && matchesParty('', { party: 'GOP' }))

{
  const s = src('src/pages/VoterLists.jsx')
  t('VoterLists routes the party filter through partyGroup()', /matchParty\s*=[^\n]*partyGroup\(v\.party\)/.test(s))
  t('VoterLists no longer prefix-matches party text', !/party\s*\|\|\s*''\)\.toLowerCase\(\)\.startsWith\(partyFilter/.test(s))
  t('the filter <option> values are partyGroup families', /<option value="R">Republican<\/option>/.test(s))
  t('the VAN export uses partyVanCode()', /partyVanCode\(v\.party\)/.test(s))
  t('the VAN export no longer writes the first letter of the raw party',
    !/\(v\.party \|\| ''\)\.toUpperCase\(\)\.charAt\(0\)/.test(s))
}

// ─── T3: district-lean primary exclusion ──────────────────────────────────────
console.log('T3 — district-lean primary exclusion')

// The predicate as it now reads in components/DistrictDashboard.jsx.
const isPrimaryContest = (c) =>
  /primary/i.test(String(c?.election?.type || '')) || /primary/i.test(String(c?.office || ''))

// The full elections.type CHECK list (supabase/migrations/00000000000000_baseline.sql).
const ELECTION_TYPES = ['primary', 'general', 'special', 'spring_primary', 'spring_general']

t("'spring_primary' is excluded (the bug — it used to count toward lean)",
  isPrimaryContest({ election: { type: 'spring_primary' } }))
t("'primary' is still excluded", isPrimaryContest({ election: { type: 'primary' } }))
t("a hypothetical 'partisan_primary' / 'presidential_primary' is excluded by construction",
  isPrimaryContest({ election: { type: 'partisan_primary' } }) &&
  isPrimaryContest({ election: { type: 'PRESIDENTIAL_PRIMARY' } }))
t("'general', 'spring_general' and 'special' still count",
  !isPrimaryContest({ election: { type: 'general' } }) &&
  !isPrimaryContest({ election: { type: 'spring_general' } }) &&
  !isPrimaryContest({ election: { type: 'special' } }))
t('exactly the two primary types in the CHECK list are excluded',
  ELECTION_TYPES.filter(x => isPrimaryContest({ election: { type: x } })).join(',') === 'primary,spring_primary')
t('the office-name fallback still works', isPrimaryContest({ office: 'Spring Primary — Mayor' }))
t('a contest with no election row is not treated as a primary', !isPrimaryContest({}) && !isPrimaryContest(null))

{
  const s = src('src/components/DistrictDashboard.jsx')
  t('DistrictDashboard tests the election type with /primary/i', /\/primary\/i\.test\(String\(c\?\.election\?\.type/.test(s))
  t("DistrictDashboard no longer compares type === 'primary'", !/election\?\.type === 'primary'/.test(s))
}

// ─── T4: "No party" must become NULL, never '' ────────────────────────────────
console.log('T4 — normalizePartyForDb on the CandidateDetail save path')

t("the 'No party' option ('') → null, not ''", P.normalizePartyForDb('') === null)
t('null / undefined / whitespace → null',
  P.normalizePartyForDb(null) === null && P.normalizePartyForDb(undefined) === null && P.normalizePartyForDb('  ') === null)
t('every DB_PARTIES value survives unchanged', P.DB_PARTIES.every(p => P.normalizePartyForDb(p) === p))
t("'GOP' → 'Republican' (a value the CHECK accepts)", P.normalizePartyForDb('GOP') === 'Republican')
t("'Democratic' → 'Democrat'", P.normalizePartyForDb('Democratic') === 'Democrat')
t('unknown free text → null, never a rejected string', P.normalizePartyForDb('Pirate') === null)
t('the result is always null or a CHECK-accepted value',
  ['', ' ', 'GOP', 'Democratic', 'Pirate', 'Working Families', 'Nonpartisan', null]
    .every(x => { const v = P.normalizePartyForDb(x); return v === null || P.DB_PARTIES.includes(v) }))

{
  const s = src('src/pages/CandidateDetail.jsx')
  t('CandidateDetail normalizes party before the write', /party:\s*normalizePartyForDb\(form\.party\)/.test(s))
  t('CandidateDetail no longer writes form.party raw', !/party:\s*form\.party\b/.test(s))
  t('a check-constraint failure gets a friendly message', /check constraint/i.test(s) && /Pick a party from the list/.test(s))
}

// ─── T5: skipped_quota prospects are retryable ────────────────────────────────
console.log('T5 — retryable research statuses')

t('skipped_quota is retryable (it was never actually researched)',
  R.RETRYABLE_RESEARCH_STATUSES.includes('skipped_quota'))
t('pending and error are still retryable',
  R.RETRYABLE_RESEARCH_STATUSES.includes('pending') && R.RETRYABLE_RESEARCH_STATUSES.includes('error'))
t('done and researching are NOT retried',
  !R.RETRYABLE_RESEARCH_STATUSES.includes('done') && !R.RETRYABLE_RESEARCH_STATUSES.includes('researching'))
t('every retryable status is a real research_status',
  R.RETRYABLE_RESEARCH_STATUSES.every(s => R.RESEARCH_STATUSES.includes(s)))
t('isRetryableProspect agrees with the list',
  R.isRetryableProspect({ research_status: 'skipped_quota' }) &&
  R.isRetryableProspect({ research_status: 'error' }) &&
  !R.isRetryableProspect({ research_status: 'done' }))
t('a row with no status yet counts as pending', R.isRetryableProspect({}) && R.isRetryableProspect({ research_status: null }))

{
  const s = src('netlify/functions/recruit-research-background.js')
  t('the background function selects on RETRYABLE_RESEARCH_STATUSES',
    /research_status=in\.\(\$\{RETRYABLE_RESEARCH_STATUSES\.join\(','\)\}\)/.test(s))
  t('the background function no longer hard-codes in.(pending,error)', !/in\.\(pending,error\)/.test(s))
  const page = src('src/pages/Recruit.jsx')
  t('the page counts "still to research" with the same list', /isRetryableProspect\(p\)/.test(page))
}

// ─── T6: cache hits must not spend the monthly allowance ──────────────────────
console.log('T6 — cache-served results are excluded from the monthly count')

t('a cache-served version is marked', R.isCachedModelVersion(R.cachedModelVersion('sonar+haiku-4-5, v1')))
t('a normal version is not marked', !R.isCachedModelVersion('sonar+haiku-4-5, v1'))
t('the marker matches the PostgREST *cached* pattern used by the usage query',
  R.cachedModelVersion('sonar+haiku-4-5, v1').includes('cached'))
t('the base version survives the stamp', R.cachedModelVersion('sonar+haiku-4-5, v1').startsWith('sonar+haiku-4-5, v1'))
t('stamping is idempotent — a cache-of-a-cache does not stack suffixes',
  R.cachedModelVersion(R.cachedModelVersion(R.cachedModelVersion('v1'))) === R.cachedModelVersion('v1'))
t('a null/blank model version still stamps cleanly',
  R.isCachedModelVersion(R.cachedModelVersion(null)) && R.isCachedModelVersion(R.cachedModelVersion('')))
t('nothing else in the vocabulary accidentally reads as cached',
  !R.isCachedModelVersion('cached-model-v2'))   // suffix-anchored, not a substring match

{
  const s = src('netlify/functions/recruit-research-background.js')
  t('the monthly usage count excludes cache-marked rows',
    /or=\(model_version\.is\.null,model_version\.not\.like\.\*cached\*\)/.test(s))
  t('NULL model_version rows are still counted (bare not.like would drop them)',
    /model_version\.is\.null/.test(s))
  t('cache hits write the stamped model version', /model_version: cachedModelVersion\(/.test(s))
}

// ─── T7: a failed upload chunk reconciles total_count ─────────────────────────
console.log('T7 — failed voter-upload chunk leaves no false total_count')

{
  const s = src('src/pages/VoterLists.jsx')
  t('the failure path corrects total_count to the rows actually inserted',
    /updateVoterList\(newList\.id, \{ total_count: insertedRows \}\)/.test(s))
  t('insertedRows counts real rows, not chunks', /insertedRows \+= chunk\.length/.test(s))
  t('a zero-row failure rolls the empty list back', /insertedRows === 0/.test(s) && /deleteVoterList\(newList\.id\)/.test(s))
  t('the user is told how many rows of how many were saved', /of \$\{rows\.length\.toLocaleString\(\)\} rows were saved/.test(s))
}

// ─── T8: Recruit pages the whole voter list ───────────────────────────────────
console.log('T8 — Recruit matches against the whole list')

{
  const s = src('src/pages/Recruit.jsx')
  t('Recruit pages the list instead of a single capped read', /\.range\(offset, offset \+ size - 1\)/.test(s))
  t('paging is totally ordered (last_name then id)', /\.order\('last_name'\)\s*\n\s*\.order\('id'\)/.test(s))
  t('the ceiling was raised from 5,000', /const VOTER_LOAD_CAP = 50000/.test(s))
  t('hitting the ceiling raises an on-screen warning naming both numbers',
    /Only part of this list was read/.test(s) && /total_count\.toLocaleString\(\)/.test(s))
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
