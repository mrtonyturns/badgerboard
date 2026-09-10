// steps.js — the first-run checklist, derived.
//
// Deliberately JSX-free and dependency-light (tiers.js has no imports of its
// own) so tests/onboarding.test.mjs can `import` it in plain node. Nothing in
// here fetches: every step's `done` is read off data the dashboards already
// hold at render time, which is the whole point — the checklist must never
// disagree with the cards underneath it, and must never cost another query.
//
// SPEC.md rule 4 applies here too: a step whose action the account's plan does
// not sell is NOT rendered as a live instruction the user can't follow. It is
// rendered as the upgrade it actually is (see the monitoring step below).

// Extension-explicit so plain node (tests/onboarding.test.mjs) resolves it the
// same way Vite does — same convention as pages/settings/planMath.js.
import { isActionPlan, getActiveCandidateLimit } from '../../lib/tiers.js'

/** Every account sees exactly four steps — three shared, one per plan family. */
export const ONBOARDING_STEP_COUNT = 4

// Same predicate as dashboard/shared.jsx `isMonitored`. Inlined rather than
// imported because shared.jsx is JSX (and pulls in leaflet), which would put
// this module out of reach of a plain-node test. One line, one source of
// truth to keep in sync — if the flag ever moves, it moves in both.
const monitoringOn = (c) => c?.section_timestamps?.monitoring === true

/**
 * How many monitoring slots this plan buys, from the plan key alone.
 *
 * Mirrors tiers.getMonitoringSlotMax(user), minus the two things a plan key
 * cannot know: the admin override and the Action bracket. Neither can turn a
 * positive max into zero, and only the ZERO case changes what we render, so
 * the plan key is enough for this decision. Callers holding a real user (both
 * dashboards do — they already compute `slots`) should pass
 * `monitoringSlotMax` explicitly and skip this.
 */
export function planMonitoringSlotMax(planKey) {
  // Action plans are bracket-capped and every bracket is ≥ 1.
  if (isActionPlan(planKey)) return Infinity
  return getActiveCandidateLimit(planKey)
}

/**
 * Build the checklist.
 *
 * @param {object}  input
 * @param {array}   input.candidates   candidate rows already loaded by the page
 * @param {array}   input.dossiers     dossier/profile rows already loaded
 * @param {array}   input.voterLists   voter-list rows already loaded
 * @param {array}   input.milestones   game-plan milestone rows already loaded
 * @param {string}  input.planKey      getUserPlan(user)
 * @param {number} [input.monitoringSlotMax]  getMonitoringSlotMax(user), when known
 * @param {number} [input.monitoredCount]     authoritative server count, when known
 * @returns {Array<{id,label,why,done,cta,href,locked}>}
 */
export function buildOnboardingSteps({
  candidates = [],
  dossiers = [],
  voterLists = [],
  milestones = [],
  planKey,
  monitoringSlotMax,
  monitoredCount,
} = {}) {
  const cands = Array.isArray(candidates) ? candidates : []
  const doss  = Array.isArray(dossiers) ? dossiers : []
  const vls   = Array.isArray(voterLists) ? voterLists : []
  const miles = Array.isArray(milestones) ? milestones : []

  const slotMax = monitoringSlotMax == null
    ? planMonitoringSlotMax(planKey)
    : monitoringSlotMax
  const monitored = monitoredCount == null
    ? cands.filter(monitoringOn).length
    : monitoredCount

  const steps = [
    {
      id: 'candidate',
      label: 'Add your first candidate',
      why: 'Profiles, digests, game plans and ballots all hang off a candidate record.',
      done: cands.length > 0,
      cta: 'Add a candidate',
      href: '/candidates',
      locked: false,
    },
    {
      id: 'profile',
      label: 'Generate your first AI profile',
      why: 'Neutral research on background, record and vulnerabilities — not a rating.',
      done: doss.length > 0,
      cta: 'Open Profiler',
      href: '/profiler',
      locked: false,
    },
    // Entitlement-aware. A plan with zero slots cannot be told to "turn on
    // Active Monitoring" — the switch is gated by the same number
    // (canMonitorCandidates), so that instruction would be a dead end. Those
    // accounts get the honest version of the step instead.
    slotMax > 0
      ? {
          id: 'monitoring',
          label: 'Turn on Active Monitoring',
          why: 'Weekly Monday digests: news, endorsements, polling and controversy.',
          done: monitored > 0,
          cta: 'Choose a candidate',
          href: '/candidates',
          locked: false,
        }
      : {
          id: 'monitoring',
          label: 'Upgrade to unlock monitoring',
          why: 'Active Monitoring is not included on your plan — no slots to fill yet.',
          done: false,
          cta: 'See plans',
          href: '/plans',
          locked: true,
        },
  ]

  // Fourth step splits by plan family: an Action account works a portfolio and
  // starts with data (voter lists); a Candidate account runs one race and
  // starts with a plan for it.
  steps.push(isActionPlan(planKey)
    ? {
        id: 'voter-list',
        label: 'Upload a voter list',
        why: 'Import a CSV and district voter counts fill in across your candidates.',
        done: vls.length > 0,
        cta: 'Open Voter Lists',
        href: '/voter-lists',
        locked: false,
      }
    : {
        id: 'game-plan',
        label: 'Set up your game plan',
        why: 'Turns your race into dated milestones from filing through GOTV.',
        done: miles.length > 0,
        cta: 'Open Game Plan',
        href: '/game-plan',
        locked: false,
      })

  return steps
}

/** { done, total, complete } for the progress bar and the auto-hide rule. */
export function onboardingProgress(steps = []) {
  const list = Array.isArray(steps) ? steps : []
  const done = list.filter(s => s?.done).length
  return { done, total: list.length, complete: list.length > 0 && done === list.length }
}

/** First step still outstanding — what the empty-state CTA lines point at. */
export function nextOnboardingStep(steps = []) {
  const list = Array.isArray(steps) ? steps : []
  return list.find(s => !s?.done) || null
}

/** 1-based position of a step id, for "This is step 2 of your setup" copy. */
export function onboardingStepNumber(id) {
  const order = ['candidate', 'profile', 'monitoring', 'voter-list', 'game-plan']
  const i = order.indexOf(id)
  // voter-list and game-plan are alternatives for the same slot, so both are 4.
  if (i < 0) return null
  return Math.min(i + 1, ONBOARDING_STEP_COUNT)
}

// ── Dismissal ────────────────────────────────────────────────────────────────
// Manual dismissal only. Completion auto-hides and is derived from the rows
// themselves, so it needs no storage and cannot go stale — an account that
// deletes its last candidate correctly gets the checklist back.
//
// Per-user key: a shared browser (a campaign office laptop) must not carry one
// staffer's dismissal onto the next person's account.

export const ONBOARDING_DISMISS_PREFIX = 'bb-onboarding-dismissed:'

export function onboardingDismissKey(userId) {
  return `${ONBOARDING_DISMISS_PREFIX}${userId || 'anon'}`
}

function store() {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null   // Safari private mode / blocked storage
  }
}

export function isOnboardingDismissed(userId) {
  const s = store()
  if (!s) return false
  try {
    return s.getItem(onboardingDismissKey(userId)) === '1'
  } catch {
    return false
  }
}

export function dismissOnboarding(userId) {
  const s = store()
  if (!s) return
  try {
    s.setItem(onboardingDismissKey(userId), '1')
  } catch {
    /* storage full or blocked — the card just reappears next visit */
  }
}
