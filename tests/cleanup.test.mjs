#!/usr/bin/env node
// Badger Board — dead-code cleanup audit.
//   1. 23 zero-reference CRUD helpers removed from src/lib/supabase.js.
//   2. The `weeklyProfile` feature flag removed from every plan config in
//      src/lib/tiers.js (zero runtime consumers — hasFeature() was never
//      called with 'weeklyProfile' or its alias 'weeklyDossier').
//   3. Candidates.jsx's "Upgrade your plan" AI-Autofill CTA now uses
//      React Router (<Link to="/plans">) wrapped in WebOnlyCta, matching
//      every other upgrade CTA in the file, instead of a raw <a href="/settings">.
// Zero-config: node tests/cleanup.test.mjs

import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const src  = (p) => readFileSync(join(ROOT, p), 'utf8')

let pass = 0, fail = 0
const t = (name, cond) => { cond ? pass++ : fail++; console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${name}`) }

// ─── 1: dead CRUD helpers removed from supabase.js ───────────────────────────
console.log('1 — dead CRUD helpers no longer exported from supabase.js')

const supabaseSrc = src('src/lib/supabase.js')

const DELETED_HELPERS = [
  'getOffice', 'createDossier',
  'getProspectingList', 'updateProspectingList', 'deleteProspectingList',
  'getVoterList', 'deleteVoter',
  'deleteRecruitmentSearch', 'updateRecruitmentProspect',
  'getDoorKnockList', 'updateDoorKnockList', 'deleteDoorKnockList',
  'getDoorKnocks', 'createDoorKnock', 'updateDoorKnock', 'deleteDoorKnock',
  'createMilestone', 'createMilestoneBatch', 'deleteMilestone',
  'deleteMilestonesByCandidate', 'deleteTemplateMilestones',
  'createVolunteer', 'updateVolunteer',
]

for (const name of DELETED_HELPERS) {
  // Word-boundary match so e.g. "getOffice" doesn't false-negative against
  // the still-present "getOffices".
  const re = new RegExp(`\\b${name}\\b`)
  t(`${name} is gone from supabase.js`, !re.test(supabaseSrc))
}

// Helpers with overlapping names that MUST remain (referenced elsewhere, or
// are the still-used sibling of a deleted name) — guards against an overly
// broad regex silently deleting the wrong thing.
const KEPT_HELPERS = [
  'getOffices', 'getVoterLists', 'deleteVoterList', 'deleteVotersByList',
  'deleteVoterSavedList', 'getDoorKnockLists', 'createDoorKnockList',
  'getKnockHistoryByAddress', 'getDoorKnockStats', 'getDoorKnockFeed',
  'getDoorKnocksForExport', 'getMilestones', 'updateMilestone',
  'getDoorKnockCandidates', 'getVolunteers', 'updateVoter',
]
for (const name of KEPT_HELPERS) {
  const re = new RegExp(`export (const|async function) ${name}\\b`)
  t(`${name} (kept — referenced elsewhere) is still exported`, re.test(supabaseSrc))
}

// ─── 2: weeklyProfile flag removed from tiers.js ─────────────────────────────
console.log('\n2 — weeklyProfile dead flag removed from tiers.js')

const tiersSrc = src('src/lib/tiers.js')

t('weeklyProfile no longer appears anywhere in tiers.js', !/weeklyProfile/.test(tiersSrc))
t('the weeklyDossier→weeklyProfile alias is gone too', !/weeklyDossier/.test(tiersSrc))
t('the dossierLimit→profileLimit alias (unrelated) is untouched', /dossierLimit:\s*'profileLimit'/.test(tiersSrc))

const {
  CANDIDATE_PLAN_CONFIG, ACTION_PLAN_CONFIG, hasFeature,
} = await import('../src/lib/tiers.js')

t('no plan config carries a weeklyProfile feature key',
  [...Object.values(CANDIDATE_PLAN_CONFIG), ...Object.values(ACTION_PLAN_CONFIG)]
    .every(cfg => !('weeklyProfile' in cfg.features)))
t('hasFeature never resolves weeklyProfile/weeklyDossier truthily on any plan',
  [...Object.keys(CANDIDATE_PLAN_CONFIG), ...Object.keys(ACTION_PLAN_CONFIG)]
    .every(k => hasFeature(k, 'weeklyProfile') === false && hasFeature(k, 'weeklyDossier') === false))

// ─── 3: Candidates.jsx upgrade CTA uses React Router ─────────────────────────
console.log('\n3 — Candidates.jsx AI-Autofill upgrade CTA uses <Link>, not a raw <a>')

const candidatesSrc = src('src/pages/Candidates.jsx')

t('no raw <a href="/settings"> upgrade link remains', !/<a href="\/settings"/.test(candidatesSrc))
t('the AI-Autofill CTA now renders <Link to="/plans">Upgrade your plan</Link>',
  /<Link to="\/plans"[^>]*>Upgrade your plan<\/Link>/.test(candidatesSrc))
t('the CTA is wrapped in WebOnlyCta (native-app store-rule pattern), matching the rest of the file',
  /<WebOnlyCta native=\{NATIVE_PLAN_NOTE\}>\s*<Link to="\/plans"/.test(candidatesSrc))

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
