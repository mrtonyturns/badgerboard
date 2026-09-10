// tests/onboarding.test.mjs — the first-run checklist's derivation.
//
//   node tests/onboarding.test.mjs
//
// steps.js is JSX-free and imports only lib/tiers.js (which has no imports of
// its own), so it runs in plain node with no bundler and no DOM.

import assert from 'node:assert/strict'
import {
  buildOnboardingSteps, onboardingProgress, nextOnboardingStep,
  onboardingStepNumber, planMonitoringSlotMax, ONBOARDING_STEP_COUNT,
  onboardingDismissKey, ONBOARDING_DISMISS_PREFIX,
} from '../src/components/onboarding/steps.js'

let passed = 0
const test = (name, fn) => {
  try {
    fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${e.message}`)
    process.exitCode = 1
  }
}

const byId = (steps) => Object.fromEntries(steps.map(s => [s.id, s]))
const ids  = (steps) => steps.map(s => s.id)

// Fixtures — shapes match the real rows the dashboards hold.
const CAND      = { id: 'c1', name: 'A', section_timestamps: {} }
const CAND_MON  = { id: 'c2', name: 'B', section_timestamps: { monitoring: true } }
const DOSSIER   = { id: 'd1', candidate_id: 'c1' }
const VLIST     = { id: 'v1', total_count: 10 }
const MILESTONE = { id: 'm1', candidate_id: 'c1', status: 'pending' }

console.log('\nonboarding — shape')

test('always four steps, on either family', () => {
  assert.equal(buildOnboardingSteps({ planKey: 'scout' }).length, ONBOARDING_STEP_COUNT)
  assert.equal(buildOnboardingSteps({ planKey: 'a_campaign' }).length, ONBOARDING_STEP_COUNT)
})

test('every step carries id/label/why/done/cta/href', () => {
  for (const s of buildOnboardingSteps({ planKey: 'c_active' })) {
    for (const k of ['id', 'label', 'why', 'done', 'cta', 'href']) {
      assert.ok(k in s, `${s.id} missing ${k}`)
    }
    assert.equal(typeof s.done, 'boolean')
    assert.ok(s.href.startsWith('/'), `${s.id} href is not a route`)
  }
})

test('no arguments at all does not throw', () => {
  const steps = buildOnboardingSteps()
  assert.equal(steps.length, ONBOARDING_STEP_COUNT)
  assert.equal(onboardingProgress(steps).done, 0)
})

test('non-array inputs are tolerated', () => {
  const steps = buildOnboardingSteps({
    candidates: null, dossiers: undefined, voterLists: 0, milestones: 'x',
    planKey: 'a_active',
  })
  assert.equal(onboardingProgress(steps).done, 0)
})

console.log('\nonboarding — empty account')

test('candidate family: nothing done, fourth step is the game plan', () => {
  const steps = buildOnboardingSteps({ planKey: 'c_active' })
  assert.deepEqual(ids(steps), ['candidate', 'profile', 'monitoring', 'game-plan'])
  assert.deepEqual(steps.map(s => s.done), [false, false, false, false])
  const p = onboardingProgress(steps)
  assert.deepEqual(p, { done: 0, total: 4, complete: false })
  assert.equal(nextOnboardingStep(steps).id, 'candidate')
})

test('action family: fourth step is the voter list', () => {
  const steps = buildOnboardingSteps({ planKey: 'a_monitor' })
  assert.deepEqual(ids(steps), ['candidate', 'profile', 'monitoring', 'voter-list'])
  assert.equal(byId(steps)['voter-list'].href, '/voter-lists')
})

test('legacy plan aliases still resolve to the right family', () => {
  // 'agency' / 'campaign' are pre-v1.10 keys that PLAN_CONFIG still honours.
  assert.equal(ids(buildOnboardingSteps({ planKey: 'agency' }))[3], 'voter-list')
  assert.equal(ids(buildOnboardingSteps({ planKey: 'monitor' }))[3], 'game-plan')
})

test('an unknown / missing plan key falls back to the candidate ladder', () => {
  assert.equal(ids(buildOnboardingSteps({ planKey: undefined }))[3], 'game-plan')
  assert.equal(ids(buildOnboardingSteps({ planKey: 'nope' }))[3], 'game-plan')
})

console.log('\nonboarding — partial')

test('one candidate marks step 1 and nothing else', () => {
  const steps = buildOnboardingSteps({ candidates: [CAND], planKey: 'c_active' })
  const m = byId(steps)
  assert.equal(m.candidate.done, true)
  assert.equal(m.profile.done, false)
  assert.equal(m.monitoring.done, false)
  assert.equal(m['game-plan'].done, false)
  assert.equal(onboardingProgress(steps).done, 1)
  assert.equal(nextOnboardingStep(steps).id, 'profile')
})

test('any dossier marks the profile step — it is not per-candidate', () => {
  const steps = buildOnboardingSteps({
    candidates: [CAND], dossiers: [{ id: 'd9', candidate_id: 'other' }], planKey: 'c_active',
  })
  assert.equal(byId(steps).profile.done, true)
})

test('monitoring reads section_timestamps.monitoring, same flag as the dashboards', () => {
  const off = buildOnboardingSteps({ candidates: [CAND], planKey: 'c_active' })
  const on  = buildOnboardingSteps({ candidates: [CAND, CAND_MON], planKey: 'c_active' })
  assert.equal(byId(off).monitoring.done, false)
  assert.equal(byId(on).monitoring.done, true)
})

test('an explicit monitoredCount overrides the array derivation', () => {
  // The dashboards hold an authoritative head+exact server count; a truncated
  // candidates array must not be able to under-report it.
  const steps = buildOnboardingSteps({
    candidates: [CAND], monitoredCount: 3, planKey: 'a_active', monitoringSlotMax: 5,
  })
  assert.equal(byId(steps).monitoring.done, true)
})

test('monitoredCount of 0 is honoured, not treated as "unknown"', () => {
  const steps = buildOnboardingSteps({
    candidates: [CAND_MON], monitoredCount: 0, planKey: 'a_active', monitoringSlotMax: 5,
  })
  assert.equal(byId(steps).monitoring.done, false)
})

test('voter lists complete step 4 on Action, milestones on Candidate', () => {
  const action = buildOnboardingSteps({ voterLists: [VLIST], planKey: 'a_active' })
  assert.equal(byId(action)['voter-list'].done, true)
  const cand = buildOnboardingSteps({ milestones: [MILESTONE], planKey: 'c_active' })
  assert.equal(byId(cand)['game-plan'].done, true)
})

test('a voter list does not complete a Candidate-plan checklist', () => {
  const steps = buildOnboardingSteps({ voterLists: [VLIST], planKey: 'c_active' })
  assert.equal(onboardingProgress(steps).done, 0)
})

test('milestones do not complete an Action-plan checklist', () => {
  const steps = buildOnboardingSteps({ milestones: [MILESTONE], planKey: 'a_active' })
  assert.equal(onboardingProgress(steps).done, 0)
})

console.log('\nonboarding — complete')

test('candidate family: all four done → complete', () => {
  const steps = buildOnboardingSteps({
    candidates: [CAND_MON], dossiers: [DOSSIER], milestones: [MILESTONE],
    planKey: 'c_active',
  })
  const p = onboardingProgress(steps)
  assert.deepEqual(p, { done: 4, total: 4, complete: true })
  assert.equal(nextOnboardingStep(steps), null)
})

test('action family: all four done → complete', () => {
  const steps = buildOnboardingSteps({
    candidates: [CAND_MON], dossiers: [DOSSIER], voterLists: [VLIST],
    planKey: 'a_campaign', monitoringSlotMax: 25,
  })
  assert.equal(onboardingProgress(steps).complete, true)
})

test('progress of an empty list is not "complete"', () => {
  assert.equal(onboardingProgress([]).complete, false)
  assert.equal(onboardingProgress().complete, false)
})

console.log('\nonboarding — entitlement (zero monitoring slots)')

test('scout (0 slots) gets the upgrade step, not a dead instruction', () => {
  const step = byId(buildOnboardingSteps({ planKey: 'scout' })).monitoring
  assert.equal(step.label, 'Upgrade to unlock monitoring')
  assert.equal(step.href, '/plans')
  assert.equal(step.locked, true)
  assert.equal(step.done, false)
})

test('c_monitor also has zero slots on the candidate ladder', () => {
  // activeCandidateLimit: scout 0, c_monitor 0, c_active 1, c_campaign 3.
  assert.equal(planMonitoringSlotMax('c_monitor'), 0)
  assert.equal(byId(buildOnboardingSteps({ planKey: 'c_monitor' })).monitoring.href, '/plans')
})

test('c_active and above get the live monitoring step', () => {
  assert.ok(planMonitoringSlotMax('c_active') > 0)
  const step = byId(buildOnboardingSteps({ planKey: 'c_active' })).monitoring
  assert.equal(step.label, 'Turn on Active Monitoring')
  assert.equal(step.href, '/candidates')
  assert.equal(step.locked, false)
})

test('every Action plan has slots (bracket-capped, always ≥ 1)', () => {
  for (const k of ['a_monitor', 'a_active', 'a_campaign']) {
    assert.ok(planMonitoringSlotMax(k) > 0, k)
    assert.equal(byId(buildOnboardingSteps({ planKey: k })).monitoring.locked, false)
  }
})

test('an explicit monitoringSlotMax of 0 beats the plan key', () => {
  // e.g. a hypothetical bracket/override the plan key cannot see.
  const step = byId(buildOnboardingSteps({ planKey: 'a_campaign', monitoringSlotMax: 0 })).monitoring
  assert.equal(step.locked, true)
  assert.equal(step.href, '/plans')
})

test('a zero-slot plan can never reach 4 of 4 on the monitoring step alone', () => {
  const steps = buildOnboardingSteps({
    candidates: [CAND_MON], dossiers: [DOSSIER], milestones: [MILESTONE], planKey: 'scout',
  })
  const p = onboardingProgress(steps)
  assert.equal(p.done, 3)
  assert.equal(p.complete, false)
  assert.equal(nextOnboardingStep(steps).id, 'monitoring')
})

console.log('\nonboarding — numbering & persistence')

test('step numbers are 1..4, with both family variants at 4', () => {
  assert.equal(onboardingStepNumber('candidate'), 1)
  assert.equal(onboardingStepNumber('profile'), 2)
  assert.equal(onboardingStepNumber('monitoring'), 3)
  assert.equal(onboardingStepNumber('voter-list'), 4)
  assert.equal(onboardingStepNumber('game-plan'), 4)
  assert.equal(onboardingStepNumber('nope'), null)
})

test('the dismissal key is namespaced per user', () => {
  assert.equal(onboardingDismissKey('u1'), `${ONBOARDING_DISMISS_PREFIX}u1`)
  assert.notEqual(onboardingDismissKey('u1'), onboardingDismissKey('u2'))
  assert.equal(onboardingDismissKey(), `${ONBOARDING_DISMISS_PREFIX}anon`)
})

console.log(`\n${passed} passed${process.exitCode ? ' — WITH FAILURES' : ''}\n`)
