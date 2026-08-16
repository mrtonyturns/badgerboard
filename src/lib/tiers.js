// ─── Plan families ────────────────────────────────────────────────────────────
// Two distinct product lines:
//   CANDIDATE PLAN  — for individual campaigns (flat monthly price)
//   ACTION PLAN     — for orgs managing multiple candidates (bracket pricing)
//
// Stored in Supabase app_metadata (service-role-writable only): { plan, bracket, plan_type, billing }
// plan_type: 'candidate' | 'action'
// billing_period: 'monthly' | 'quarterly' | 'semiannual' | 'annual'

// ─── Candidate Plan ───────────────────────────────────────────────────────────

export const CANDIDATE_PLAN_ORDER = ['scout', 'c_monitor', 'c_active', 'c_campaign']

export const CANDIDATE_PLAN_CONFIG = {
  scout: {
    key:                  'scout',
    planType:             'candidate',
    name:                 'Scout',
    price:                'Free',
    monthlyPrice:         0,
    profileLimit:         1,      // lite profile only
    liteProfileOnly:      true,   // blurred/gated after free sections
    userLimit:            1,
    activeCandidateLimit: 0,
    features: {
      dashboard:          true,
      elections:          true,
      doorKnocking:       true,
      gameplan:           false,  // locked on Scout — unlocks at Monitor (v1.18 pricing update)
      compare:            false,
      prospecting:        false,
      recruit:            false,
      offices:            false,
      multiGamePlan:      false,
      bulkProfiler:       false,
      csvImport:          false,
      campaignIntel:      false,
      discoverCandidates: false,
      socialLinks:        false,
      weeklyProfile:      false,
      creditPacks:        false,
      broadside:          false,  // paid-plan feature (v1.18.2)
    },
    unlocks: [],
    nextUnlocks: [
      'Full AI profile generation',
      'Game Plan',
      '1 user seat',
    ],
  },

  c_monitor: {
    key:                  'c_monitor',
    planType:             'candidate',
    name:                 'Monitor',
    price:                '$79 / mo',
    monthlyPrice:         79,
    profileLimit:         1,
    liteProfileOnly:      false,
    userLimit:            1,
    activeCandidateLimit: 0,
    features: {
      dashboard:          true,
      elections:          true,
      doorKnocking:       true,
      gameplan:           true,
      compare:            false,
      prospecting:        false,
      recruit:            false,
      offices:            false,
      multiGamePlan:      false,
      bulkProfiler:       false,
      csvImport:          true,
      campaignIntel:      false,
      discoverCandidates: false,
      socialLinks:        true,
      weeklyProfile:      false,
      creditPacks:        true,
      broadside:          true,   // v1.18.2: included in all paid plans
    },
    unlocks: [
      'Full AI profile generation',
      'Game Plan',
      'CSV import',
      'Social media links',
    ],
    nextUnlocks: [
      '2 profiles / month',
      '1 active candidate monitoring',
      'Compare tool',
    ],
  },

  c_active: {
    key:                  'c_active',
    planType:             'candidate',
    name:                 'Active',
    price:                '$119 / mo',
    monthlyPrice:         119,
    profileLimit:         2,
    liteProfileOnly:      false,
    userLimit:            1,
    activeCandidateLimit: 1,
    features: {
      dashboard:          true,
      elections:          true,
      doorKnocking:       true,
      gameplan:           true,
      compare:            true,
      prospecting:        false,
      recruit:            false,
      offices:            false,
      multiGamePlan:      false,
      bulkProfiler:       false,
      csvImport:          true,
      campaignIntel:      true,
      discoverCandidates: true,
      socialLinks:        true,
      weeklyProfile:      false,
      creditPacks:        true,
      broadside:          true,   // v1.18.2: included in all paid plans
    },
    unlocks: [
      '2 profiles / month',
      '1 active candidate monitoring',
      'Campaign Intel briefs',
      'AI candidate discovery',
      'Compare tool',
    ],
    nextUnlocks: [
      '6 profiles / month',
      '2 user seats',
      '3 active candidates',
    ],
  },

  c_campaign: {
    key:                  'c_campaign',
    planType:             'candidate',
    name:                 'Campaign',
    price:                '$189 / mo',
    monthlyPrice:         189,
    profileLimit:         6,
    liteProfileOnly:      false,
    userLimit:            2,
    activeCandidateLimit: 3,
    features: {
      dashboard:          true,
      elections:          true,
      doorKnocking:       true,
      gameplan:           true,
      compare:            true,
      prospecting:        false,
      recruit:            false,
      offices:            false,
      multiGamePlan:      false,
      bulkProfiler:       false,
      csvImport:          true,
      campaignIntel:      true,
      discoverCandidates: true,
      socialLinks:        true,
      weeklyProfile:      true,
      creditPacks:        true,
      broadside:          true,   // v1.18.2: included in all paid plans
    },
    unlocks: [
      '6 profiles / month',
      '2 user seats',
      '3 active candidates',
      'Weekly auto-refresh',
    ],
    nextUnlocks: [],
  },
}

// How many candidate rows a free Scout account may create. This is the single
// source of truth: it used to be a bare `2` written out in Candidates.jsx (as a
// local const, three times over) and again in settings/PlanPane.jsx, so the cap
// and the copy describing it could — and did — drift apart.
//
// SERVER ENFORCEMENT NOW EXISTS. Migration 20260812000030_scout_candidate_cap
// installs the `scout_candidate_cap` BEFORE INSERT trigger on `candidates`,
// which counts the caller's rows under the insert's row lock and raises
// "Scout plans track up to 2 candidates. Upgrade to add more." past two.
// Paid plans, active trials and admin emails are exempt; service-role writes
// bypass it. A hand-crafted PostgREST insert no longer gets through.
//
// The checks against this constant in the UI are therefore the *friendly* half
// of a real boundary, not the boundary itself: they stop a doomed round trip
// and explain the cap before the user fills in a form. If this number and the
// trigger's hardcoded 2 ever diverge, the trigger wins.
export const SCOUT_CANDIDATE_LIMIT = 2

// ─── Action Plan ──────────────────────────────────────────────────────────────

export const ACTION_PLAN_ORDER = ['a_monitor', 'a_active', 'a_campaign']

export const ACTION_PLAN_CONFIG = {
  a_monitor: {
    key:                   'a_monitor',
    planType:              'action',
    name:                  'Monitor',
    price:                 'From $89 / mo',
    profilesPerCandidate:  1,      // × bracket size = monthly profile pool
    liteProfileOnly:       false,
    userLimit:             1,
    activeCandidateLimit:  Infinity, // controlled by bracket
    features: {
      dashboard:          true,
      elections:          true,
      doorKnocking:       true,
      gameplan:           true,
      multiGamePlan:      true,
      prospecting:        true,
      recruit:            true,  // v1.29 Recruit-from-voter-list (Action-plan exclusive)
      offices:            true,
      compare:            false,
      bulkProfiler:       false,
      csvImport:          true,
      campaignIntel:      true,
      discoverCandidates: true,
      socialLinks:        true,
      weeklyProfile:      false,
      creditPacks:        true,   // every paid plan can buy a la carte profile credits
      bulkCredits:        false,
      broadside:          true,   // v1.18.2: included in all paid plans
    },
    unlocks: [
      'Prospecting',
      'Recruit from voter list',
      'Multi-Candidate Game Plan',
      'Office & district maps',
      '1 profile per candidate / month',
    ],
    nextUnlocks: [
      '2 profiles per candidate / month',
      '2 user seats',
      'Compare tool',
    ],
  },

  a_active: {
    key:                   'a_active',
    planType:              'action',
    name:                  'Active',
    price:                 'From $149 / mo',
    profilesPerCandidate:  2,
    liteProfileOnly:       false,
    userLimit:             2,
    activeCandidateLimit:  Infinity,
    features: {
      dashboard:          true,
      elections:          true,
      doorKnocking:       true,
      gameplan:           true,
      multiGamePlan:      true,
      prospecting:        true,
      recruit:            true,  // v1.29 Recruit-from-voter-list (Action-plan exclusive)
      offices:            true,
      compare:            true,
      bulkProfiler:       false,
      csvImport:          true,
      campaignIntel:      true,
      discoverCandidates: true,
      socialLinks:        true,
      weeklyProfile:      true,
      creditPacks:        true,   // every paid plan can buy a la carte profile credits
      bulkCredits:        false,
      broadside:          true,   // v1.18.2: included in all paid plans
    },
    unlocks: [
      '2 profiles per candidate / month',
      '2 user seats',
      'Compare tool',
      'Weekly auto-refresh',
    ],
    nextUnlocks: [
      '4 profiles per candidate / month',
      'Unlimited user seats',
      'Bulk Profiler',
    ],
  },

  a_campaign: {
    key:                   'a_campaign',
    planType:              'action',
    name:                  'Campaign',
    price:                 'From $219 / mo',
    profilesPerCandidate:  4,
    liteProfileOnly:       false,
    userLimit:             Infinity,
    activeCandidateLimit:  Infinity,
    features: {
      dashboard:          true,
      elections:          true,
      doorKnocking:       true,
      gameplan:           true,
      multiGamePlan:      true,
      prospecting:        true,
      recruit:            true,  // v1.29 Recruit-from-voter-list (Action-plan exclusive)
      offices:            true,
      compare:            true,
      bulkProfiler:       true,
      csvImport:          true,
      campaignIntel:      true,
      discoverCandidates: true,
      socialLinks:        true,
      weeklyProfile:      true,
      creditPacks:        true,   // every paid plan can buy a la carte profile credits
      bulkCredits:        true,
      broadside:          true,   // v1.18.2: included in all paid plans
    },
    unlocks: [
      '4 profiles per candidate / month',
      'Unlimited user seats',
      'Bulk Profiler',
    ],
    nextUnlocks: [],
  },
}

// ─── Combined config (all plans) ─────────────────────────────────────────────

export const PLAN_CONFIG = {
  ...CANDIDATE_PLAN_CONFIG,
  ...ACTION_PLAN_CONFIG,
  // Legacy aliases — existing users on old keys keep working
  monitor:  CANDIDATE_PLAN_CONFIG.c_monitor,
  campaign: ACTION_PLAN_CONFIG.a_campaign,
  agency:   ACTION_PLAN_CONFIG.a_campaign,
}

export const PLAN_ORDER = [...CANDIDATE_PLAN_ORDER, ...ACTION_PLAN_ORDER]

// ─── Legacy plan keys ────────────────────────────────────────────────────────
// PLAN_CONFIG accepts the pre-v1.10 keys so old accounts keep their features,
// but PLAN_ORDER only holds canonical keys — so PLAN_ORDER.indexOf('monitor')
// is -1 and every rank comparison built on it silently breaks (trial vs paid
// comparison, isUpgrade, getNextPlan, the "current plan" card in PlanPane).
// normalizePlan collapses legacy → canonical before any of that runs.
// Mirror of netlify/functions/_entitlements.js LEGACY_ALIASES/normalizePlan.
export const LEGACY_PLAN_ALIASES = { monitor: 'c_monitor', campaign: 'a_campaign', agency: 'a_campaign' }

export function normalizePlan(planKey) {
  if (!planKey) return 'scout'
  const norm = LEGACY_PLAN_ALIASES[planKey] || planKey
  return PLAN_ORDER.includes(norm) ? norm : 'scout'
}

// ─── Bracket definitions (Action Plan only) ───────────────────────────────────

export const BRACKET_ORDER = ['b1', 'b2_5', 'b6', 'b11', 'b26', 'b51', 'ent']

export const BRACKET_CONFIG = {
  b1:   { key: 'b1',   label: '1',        sublabel: 'Solo candidate',             max: 1        },
  b2_5: { key: 'b2_5', label: '2 – 5',    sublabel: 'Small campaign team',        max: 5        },
  b6:   { key: 'b6',   label: '6 – 10',   sublabel: 'Local party slate',          max: 10       },
  b11:  { key: 'b11',  label: '11 – 25',  sublabel: 'County party & small orgs',  max: 25       },
  b26:  { key: 'b26',  label: '26 – 50',  sublabel: 'Regional operations',        max: 50       },
  b51:  { key: 'b51',  label: '51 – 100', sublabel: 'Statewide & large agencies', max: 100      },
  ent:  { key: 'ent',  label: '100+',     sublabel: 'Enterprise — contact us',    max: Infinity },
}

// ─── Action Plan pricing matrix (monthly base rates) ─────────────────────────

// v1.18 pricing update (approved 2026-07-21) — prior founder-era rates:
//   a_monitor  { b1: 69,  b2_5: 99,  b6: 129, b11: 169, b26: 219, b51: 299 }
//   a_active   { b1: 119, b2_5: 149, b6: 199, b11: 269, b26: 389, b51: 549 }
//   a_campaign { b1: 159, b2_5: 249, b6: 349, b11: 479, b26: 699, b51: 999 }
// Existing subscriptions keep their old Stripe price (grandfathered founder rate).
export const ACTION_MONTHLY_PRICES = {
  a_monitor: { b1: 89,  b2_5: 129, b6: 169, b11: 229, b26: 299, b51: 399,  ent: null },
  a_active:  { b1: 149, b2_5: 199, b6: 269, b11: 359, b26: 529, b51: 749,  ent: null },
  a_campaign:{ b1: 219, b2_5: 339, b6: 469, b11: 649, b26: 949, b51: 1349, ent: null },
}

// Legacy alias
export const MONTHLY_PRICES = {
  ...ACTION_MONTHLY_PRICES,
  monitor:  ACTION_MONTHLY_PRICES.a_monitor,
  campaign: ACTION_MONTHLY_PRICES.a_campaign,
  agency:   ACTION_MONTHLY_PRICES.a_campaign,
}

// ─── Billing periods ──────────────────────────────────────────────────────────
// monthly:    full rate, billed monthly
// quarterly:  5% off, billed every 3 months
// semiannual: 10% off, billed every 6 months
// annual:     2 months free (10/12 = 16.7% off), billed annually

export const BILLING_PERIODS = {
  monthly: {
    key:      'monthly',
    label:    'Monthly',
    discount: 0,
    months:   1,
    badge:    null,
  },
  quarterly: {
    key:      'quarterly',
    label:    'Quarterly',
    discount: 0.05,
    months:   3,
    badge:    '5% off',
  },
  semiannual: {
    key:      'semiannual',
    label:    'Semi-annual',
    discount: 0.10,
    months:   6,
    badge:    '10% off',
  },
  annual: {
    key:      'annual',
    label:    'Annual',
    discount: 2 / 12,   // 2 months free = 16.67% off
    months:   12,
    badge:    '2 months free',
  },
}

// Effective monthly rate after billing period discount
export function effectiveMonthlyRate(baseMonthlyPrice, billingPeriod = 'monthly') {
  const period = BILLING_PERIODS[billingPeriod] ?? BILLING_PERIODS.monthly
  return Math.round(baseMonthlyPrice * (1 - period.discount))
}

// Total amount charged per billing period.
//
// MUST match stripe-setup.mjs periodAmountCents() to the cent — that script is
// what actually mints the Stripe prices, so any other formula shows the user a
// number Stripe will not charge. Stripe rounds ONCE, on the period total:
//   monthly     base
//   quarterly   round(base × 0.95 × 3)
//   semiannual  round(base × 0.90 × 6)
//   annual      base × 10           (2 months free)
// The old version here rounded the per-month rate first and then multiplied,
// which drifts by a dollar or two on ~half the bracket/period combos
// (e.g. base 129 quarterly: round(122.55) × 3 = 369, Stripe charges 368).
export function periodTotal(baseMonthlyPrice, billingPeriod = 'monthly') {
  if (billingPeriod === 'annual') {
    // 2 months free = pay 10 months (integer, no rounding needed)
    return baseMonthlyPrice * 10
  }
  const period = BILLING_PERIODS[billingPeriod] ?? BILLING_PERIODS.monthly
  return Math.round(baseMonthlyPrice * (1 - period.discount) * period.months)
}

// Annual savings vs monthly for a given billing period
export function annualSavings(baseMonthlyPrice, billingPeriod) {
  if (billingPeriod === 'monthly') return 0
  const annualAtMonthly = baseMonthlyPrice * 12
  const period = BILLING_PERIODS[billingPeriod]
  const annualAtPeriod  = billingPeriod === 'annual'
    ? baseMonthlyPrice * 10
    : periodTotal(baseMonthlyPrice, billingPeriod) * (12 / period.months)
  return Math.round(annualAtMonthly - annualAtPeriod)
}

// Action Plan helpers
export function actionMonthlyBase(plan, bracket) {
  return ACTION_MONTHLY_PRICES[plan]?.[bracket] ?? null
}

export function actionEffectiveRate(plan, bracket, billingPeriod = 'monthly') {
  const base = actionMonthlyBase(plan, bracket)
  return base ? effectiveMonthlyRate(base, billingPeriod) : null
}

export function actionPeriodTotal(plan, bracket, billingPeriod = 'monthly') {
  const base = actionMonthlyBase(plan, bracket)
  return base ? periodTotal(base, billingPeriod) : null
}

// ─── A la carte profile credit packs (every PAID plan) ───────────────────────
// The header used to read "Candidate Plan only", which has not been true since
// features.creditPacks was switched on for a_monitor / a_active / a_campaign
// ("every paid plan can buy a la carte profile credits"). The Pricing page had
// inherited that stale premise and rendered the pack grid inside the Candidate
// tab only, so an Action subscriber could not reach packs their entitlement
// already grants — and create-checkout-session, which gates on the same
// features.creditPacks flag via entitlementFeature('creditPacks'), would have
// happily sold them. Scout is the only plan that cannot buy.

export const CREDIT_PACKS = [
  { key: 'c1',  qty: 1,  price: 49,  perCredit: 49.00, savingsPct: null },
  { key: 'c5',  qty: 5,  price: 199, perCredit: 39.80, savingsPct: 19   },
  { key: 'c10', qty: 10, price: 349, perCredit: 34.90, savingsPct: 29   },
  { key: 'c25', qty: 25, price: 749, perCredit: 29.96, savingsPct: 39   },
]

/**
 * May this plan buy a la carte profile credit packs?
 * Single source of truth for the purchase UI, mirroring the server's
 * entitlementFeature('creditPacks') check in create-checkout-session.js.
 */
export function canBuyCreditPacks(planKey) {
  return hasFeature(normalizePlan(planKey), 'creditPacks')
}

/** May this plan buy BULK profile credits (Bulk Profiler fuel)? */
export function canBuyBulkCredits(planKey) {
  return hasFeature(normalizePlan(planKey), 'bulkCredits')
}

// ─── Recruit lookups (Action Plan only) ──────────────────────────────────────
// Reputation lookups are a much cheaper unit than a full AI dossier
// (~$0.01–0.03 per person vs. $2.40–3.96 per bulk credit), so they are a plain
// monthly allowance per plan rather than a metered SKU — they deliberately do
// NOT reuse BULK_CREDIT_PACKS. Numbers are gameplan §3.5's proposal.
export const RECRUIT_MONTHLY_LOOKUPS = {
  a_monitor:  100,
  a_active:   300,
  a_campaign: 1000,
}

// Hard cap per research run: bounds both spend and the background function's
// 15-minute budget. One run researches at most this many people; the user
// presses Research again to continue a larger list.
export const RECRUIT_BATCH_CAP = 25

/** Monthly Recruit lookup allowance for a plan (0 when the plan lacks the feature). */
export function getRecruitLookupLimit(planKey) {
  const cfg = PLAN_CONFIG[planKey]
  if (!cfg?.features?.recruit) return 0
  return RECRUIT_MONTHLY_LOOKUPS[cfg.key] ?? 0
}

// ─── Bulk profile credit packs (Action Plan Campaign only) ───────────────────

export const BULK_CREDIT_PACKS = [
  { key: 'bulk25',  qty: 25,  price: 99,  perCredit: 3.96, savingsPct: null },
  { key: 'bulk50',  qty: 50,  price: 179, perCredit: 3.58, savingsPct: 10   },
  { key: 'bulk100', qty: 100, price: 299, perCredit: 2.99, savingsPct: 25   },
  { key: 'bulk250', qty: 250, price: 599, perCredit: 2.40, savingsPct: 40   },
]

// ─── Scout lite profile — free sections ──────────────────────────────────────
// Sections that are visible on Scout's lite profile (1x/month).
// Everything else is blurred with an upgrade gate.

export const LITE_PROFILE_FREE_SECTIONS = [
  { sectionNumber: 2, name: 'Biography',       freeItems: null    }, // full section
  { sectionNumber: 4, name: 'Political Record', freeItems: null    }, // full section
  { sectionNumber: 8, name: 'Affiliations',     freeItems: 2       }, // first 2 allies only
]

// ─── Admin emails (always pinned to a_campaign) ───────────────────────────────

export const ADMIN_EMAILS = ['tony@bluejackgroup.com', 'tony@thebluejackgroup.com', 'tom@thebluejackgroup.com']

// ─── Core getters ─────────────────────────────────────────────────────────────
//
// Entitlements (plan, bracket, billing, credits, payment_status) are read from
// `app_metadata`, which ONLY the service-role key can write (via the Stripe
// webhook / admin functions). This is deliberate: `user_metadata` is writable
// by the end user themselves (supabase.auth.updateUser), so trusting it for
// plan/credits let anyone self-grant a paid tier. `ent()` reads app_metadata.
function ent(user) {
  return user?.app_metadata ?? {}
}

// ─── Beta mode ────────────────────────────────────────────────────────────────
// Two layers:
//   1. Per-user flag:   app_metadata.beta_mode === true (service-role writable)
//   2. Global switch:   app_settings table, key 'beta_mode_enabled' — fetched by
//      AuthContext on load and pushed here via setGlobalBetaEnabled().
// While beta is active for a user they resolve to the top plan (a_campaign,
// 'ent' bracket = every feature, unlimited slots). The moment either layer
// turns off, the resolver falls straight through to trial → paid → scout.

export const BETA_PLAN    = 'a_campaign'
export const BETA_BRACKET = 'ent'

let _globalBetaEnabled = true  // optimistic default until AuthContext fetches the setting

// Fail CLOSED. The old body was `v !== false`, so anything that was not a
// literal `false` — including the `undefined` a failed/short-circuited
// app_settings read hands back — turned the global beta switch ON and gave
// every beta-flagged account a_campaign/ent across every gate. Only an explicit
// `true` may enable it; every other value (undefined, null, an Error, 'off')
// resolves to OFF.
export function setGlobalBetaEnabled(v) { _globalBetaEnabled = v === true }
export function getGlobalBetaEnabled()  { return _globalBetaEnabled }

export function isBetaActive(user) {
  return _globalBetaEnabled && ent(user).beta_mode === true
}

// ─── Free trials (30/60/90-day giveaways) ─────────────────────────────────────
// Stored in app_metadata (service-role writable only):
//   trial_plan, trial_bracket, trial_started_at, trial_ends_at (ISO), trial_granted_by
// A trial is an overlay: while active, the user resolves to the trial plan if it
// outranks their paid plan. At expiry the daily cron clears the fields and the
// resolver falls back to paid plan or scout automatically — client-side we also
// treat a past trial_ends_at as inactive, so access ends on time even before
// the cron runs.

export function getActiveTrial(user) {
  const e = ent(user)
  if (!e.trial_plan || !e.trial_ends_at) return null
  if (!PLAN_CONFIG[e.trial_plan]) return null
  const endsAt = Date.parse(e.trial_ends_at)
  if (!Number.isFinite(endsAt) || endsAt <= Date.now()) return null
  return {
    // Canonical key only — a legacy trial_plan would rank -1 against the paid
    // plan below and the trial would never win.
    plan:     normalizePlan(e.trial_plan),
    bracket:  e.trial_bracket && BRACKET_CONFIG[e.trial_bracket] ? e.trial_bracket : 'b1',
    endsAt,
    daysLeft: Math.max(1, Math.ceil((endsAt - Date.now()) / 86400000)),
  }
}

// ─── Resolver ─────────────────────────────────────────────────────────────────
// Priority: admin > beta > trial (if it outranks paid) > paid > scout

// Raw app_metadata.plan is the ONLY place an un-normalized key enters the app,
// so it is normalized here — every consumer downstream (rank comparisons,
// getNextPlan, isUpgrade, PlanPane's current-plan card) sees a canonical key.
function rawPaidPlan(user) {
  const p = ent(user).plan
  return p && PLAN_CONFIG[p] ? normalizePlan(p) : 'scout'
}

export function getUserPlan(user) {
  if (!user) return 'scout'
  if (ADMIN_EMAILS.includes(user.email?.toLowerCase())) return 'a_campaign'
  if (isBetaActive(user)) return BETA_PLAN
  const paid  = rawPaidPlan(user)
  const trial = getActiveTrial(user)
  if (trial && PLAN_ORDER.indexOf(trial.plan) > PLAN_ORDER.indexOf(paid)) return trial.plan
  return paid
}

// Where the user's current access comes from — for badges in Settings/Admin UI.
export function getEntitlementSource(user) {
  if (!user) return 'free'
  if (ADMIN_EMAILS.includes(user.email?.toLowerCase())) return 'admin'
  if (isBetaActive(user)) return 'beta'
  const paid  = rawPaidPlan(user)
  const trial = getActiveTrial(user)
  if (trial && PLAN_ORDER.indexOf(trial.plan) > PLAN_ORDER.indexOf(paid)) return 'trial'
  return paid === 'scout' ? 'free' : 'paid'
}

export function getUserPlanType(user) {
  const plan = getUserPlan(user)
  return PLAN_CONFIG[plan]?.planType ?? 'candidate'
}

export function getUserBracket(user) {
  if (user && !ADMIN_EMAILS.includes(user.email?.toLowerCase())) {
    if (isBetaActive(user)) return BETA_BRACKET
    const source = getEntitlementSource(user)
    if (source === 'trial') {
      const trial = getActiveTrial(user)
      if (trial?.bracket) return trial.bracket
    }
  }
  const b = ent(user).bracket
  return b && BRACKET_CONFIG[b] ? b : 'b1'
}

export function getUserBillingPeriod(user) {
  const bp = ent(user).billing
  return bp && BILLING_PERIODS[bp] ? bp : 'monthly'
}

export function getPlanConfig(planKey) {
  return PLAN_CONFIG[planKey] ?? PLAN_CONFIG.scout
}

export function getBracketConfig(bracketKey) {
  return BRACKET_CONFIG[bracketKey] ?? BRACKET_CONFIG.b1
}

// Feature key aliases for backward compatibility (old name → new name)
const FEATURE_ALIASES = {
  weeklyDossier: 'weeklyProfile',  // renamed in tiers.js rewrite
  dossierLimit:  'profileLimit',   // renamed in tiers.js rewrite
}

export function hasFeature(planKey, feature) {
  const cfg = PLAN_CONFIG[planKey]
  if (!cfg) return false
  const resolvedFeature = FEATURE_ALIASES[feature] || feature
  if (resolvedFeature in cfg.features) return cfg.features[resolvedFeature]
  return false
}

// ─── "Where does this unlock?" copy ──────────────────────────────────────────
// Upgrade badges and locked-feature blurbs used to hard-code plan names, and
// those names drifted from the config: a "Pro" pill (no such plan has ever
// existed) on the Discover and CSV buttons, and "Campaign & Agency plans" on
// Active Monitoring — 'Agency' is a pre-v1.10 legacy alias, not a sellable
// plan, and weeklyProfile actually unlocks at Active on the Action side.
// Derive the names from PLAN_CONFIG instead so they can never go stale again.

/** Lowest plan in each family that unlocks `feature` (null when none does). */
export function lowestPlansWithFeature(feature) {
  const find = (order) => order.find(k => hasFeature(k, feature)) ?? null
  return { candidate: find(CANDIDATE_PLAN_ORDER), action: find(ACTION_PLAN_ORDER) }
}

/**
 * Human label for where a feature unlocks.
 *   featureUnlockLabel('weeklyProfile')             → 'Campaign (Candidate) and Active (Action)'
 *   featureUnlockLabel('discoverCandidates', 'candidate') → 'Active'
 * Pass the viewer's plan family to name only their own ladder; omit it for
 * copy that has to speak to both.
 */
export function featureUnlockLabel(feature, planTypeHint) {
  const { candidate, action } = lowestPlansWithFeature(feature)
  const nameOf = (k) => (k ? (PLAN_CONFIG[k]?.name ?? k) : null)
  if (planTypeHint === 'candidate' && candidate) return nameOf(candidate)
  if (planTypeHint === 'action'    && action)    return nameOf(action)
  const parts = []
  if (candidate) parts.push(`${nameOf(candidate)} (Candidate)`)
  if (action)    parts.push(`${nameOf(action)} (Action)`)
  return parts.length ? parts.join(' and ') : null
}

// Returns the effective monthly profile limit for a plan+bracket combination.
// Candidate plans have a fixed limit. Action plans scale: profilesPerCandidate × bracketMax.
export function getProfileLimit(planKey, bracketKey) {
  const cfg = PLAN_CONFIG[planKey]
  if (!cfg) return 0
  // Action plan: multiply per-candidate rate by bracket size
  if (cfg.planType === 'action' && cfg.profilesPerCandidate != null) {
    const bracketMax = BRACKET_CONFIG[bracketKey]?.max ?? 1
    return bracketMax === Infinity ? Infinity : cfg.profilesPerCandidate * bracketMax
  }
  return cfg.profileLimit ?? 0
}

// Effective monthly profile limit for a USER — admin accounts (platform owners)
// are never capped; everyone else gets their plan/bracket limit.
export function getBankedProfileCredits(user) {
  const n = Number(ent(user).profile_credits)
  return Number.isFinite(n) && n > 0 ? n : 0
}

export function getEffectiveProfileLimit(user) {
  if (user?.email && ADMIN_EMAILS.includes(user.email.toLowerCase())) return Infinity
  const base = getProfileLimit(getUserPlan(user), getUserBracket(user))
  if (base === Infinity) return Infinity
  // Purchased credits bank on top of the monthly allotment and roll over until used.
  return base + getBankedProfileCredits(user)
}

// Human-readable label for the profile limit shown in UI (e.g. "2 per candidate")
export function getProfileLimitLabel(planKey) {
  const cfg = PLAN_CONFIG[planKey]
  if (!cfg) return '0'
  if (cfg.planType === 'action' && cfg.profilesPerCandidate != null) {
    return `${cfg.profilesPerCandidate} per candidate`
  }
  if (cfg.liteProfileOnly) return '1 lite profile'
  return String(cfg.profileLimit ?? 0)
}

export function getUserLimit(planKey) {
  return PLAN_CONFIG[planKey]?.userLimit ?? 1
}

export function getActiveCandidateLimit(planKey) {
  return PLAN_CONFIG[planKey]?.activeCandidateLimit ?? 0
}

// ─── Active monitoring slots ─────────────────────────────────────────────────
// How many candidates a user may have monitoring switched on for:
//   admin        → Infinity (matches the profile-limit rule)
//   candidate    → activeCandidateLimit (scout 0, c_monitor 0, c_active 1, c_campaign 3)
//   action       → the bracket max (every bracket is ≥ 1)
// This mirrors the `monitoring_cap` trigger in migration 20260812000040 —
// the trigger is the boundary, this is the friendly half.
//
// Candidates.jsx, CandidateDetail.jsx, Settings.jsx and dashboard/shared.jsx
// each wrote this ladder out longhand. It lives here now because the FEATURE
// GATE has to agree with it: monitoring used to be gated on features.weeklyProfile,
// which is false on c_active and on every Action plan — so a plan that pays for
// a slot could not reach the switch that fills it. The gate is "do you have a
// slot", i.e. canMonitorCandidates(), and it reads the same number the counter does.
export function getMonitoringSlotMax(user) {
  if (user?.email && ADMIN_EMAILS.includes(user.email.toLowerCase())) return Infinity
  if (getUserPlanType(user) === 'candidate') return getActiveCandidateLimit(getUserPlan(user))
  return getBracketConfig(getUserBracket(user))?.max ?? Infinity
}

/** Does this user's plan include any active-monitoring slots at all? */
export function canMonitorCandidates(user) {
  return getMonitoringSlotMax(user) > 0
}

/** Lowest plan in each family that includes a monitoring slot, as UI copy. */
export function monitoringUnlockLabel(planTypeHint) {
  const nameOf = (k) => (k ? (PLAN_CONFIG[k]?.name ?? k) : null)
  const candidate = CANDIDATE_PLAN_ORDER.find(k => getActiveCandidateLimit(k) > 0) ?? null
  const action    = ACTION_PLAN_ORDER.find(k => getActiveCandidateLimit(k) > 0) ?? null
  if (planTypeHint === 'candidate' && candidate) return nameOf(candidate)
  if (planTypeHint === 'action'    && action)    return nameOf(action)
  const parts = []
  if (candidate) parts.push(`${nameOf(candidate)} (Candidate)`)
  if (action)    parts.push(`${nameOf(action)} (Action)`)
  return parts.length ? parts.join(' and ') : null
}

export function isLiteProfileOnly(planKey) {
  return PLAN_CONFIG[planKey]?.liteProfileOnly ?? false
}

export function isCandidatePlan(planKey) {
  return PLAN_CONFIG[planKey]?.planType === 'candidate'
}

export function isActionPlan(planKey) {
  return PLAN_CONFIG[planKey]?.planType === 'action'
}

export function isUpgrade(fromPlan, toPlan) {
  // Within same plan family, use order index (legacy keys normalized first —
  // PLAN_ORDER has no entry for them, so a raw 'monitor' would rank -1).
  const fromIdx = PLAN_ORDER.indexOf(normalizePlan(fromPlan))
  const toIdx   = PLAN_ORDER.indexOf(normalizePlan(toPlan))
  return toIdx > fromIdx
}

export function getNextPlan(planKey) {
  const key    = normalizePlan(planKey)
  const isCand = isCandidatePlan(key)
  const order  = isCand ? CANDIDATE_PLAN_ORDER : ACTION_PLAN_ORDER
  const idx    = order.indexOf(key)
  return idx >= 0 && idx < order.length - 1 ? order[idx + 1] : null
}

// ─── Backward-compatibility aliases ──────────────────────────────────────────

export const getUserTier   = getUserPlan
export const getTierConfig  = getPlanConfig
export const TIER_ORDER     = PLAN_ORDER
export const TIER_CONFIG    = PLAN_CONFIG
export const getNextTier    = getNextPlan

// annualMonthlyPrice / annualTotalPrice kept for any code still importing them
export function annualMonthlyPrice(plan, bracket) {
  const base = ACTION_MONTHLY_PRICES[plan]?.[bracket]
  return base ? effectiveMonthlyRate(base, 'annual') : null
}
export function annualTotalPrice(plan, bracket) {
  const base = ACTION_MONTHLY_PRICES[plan]?.[bracket]
  return base ? periodTotal(base, 'annual') : null
}
export function annualSavingsAmount(plan, bracket) {
  const base = ACTION_MONTHLY_PRICES[plan]?.[bracket]
  return base ? annualSavings(base, 'annual') : null
}
export function semiannualMonthlyPrice(plan, bracket) {
  const base = ACTION_MONTHLY_PRICES[plan]?.[bracket]
  return base ? effectiveMonthlyRate(base, 'semiannual') : null
}
export function semiannualTotalPrice(plan, bracket) {
  const base = ACTION_MONTHLY_PRICES[plan]?.[bracket]
  return base ? periodTotal(base, 'semiannual') : null
}
