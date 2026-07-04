// ─── Plan families ────────────────────────────────────────────────────────────
// Two distinct product lines:
//   CANDIDATE PLAN  — for individual campaigns (flat monthly price)
//   ACTION PLAN     — for orgs managing multiple candidates (bracket pricing)
//
// Stored in Supabase user_metadata: { plan, bracket, plan_type, billing_period }
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
      gameplan:           true,   // 1 candidate, no sorting
      compare:            false,
      prospecting:        false,
      offices:            false,
      multiGamePlan:      false,
      bulkProfiler:       false,
      csvImport:          false,
      campaignIntel:      false,
      discoverCandidates: false,
      socialLinks:        false,
      weeklyProfile:      false,
      creditPacks:        false,
    },
    unlocks: [],
    nextUnlocks: [
      'Full AI profile generation',
      '1 user seat',
    ],
  },

  c_monitor: {
    key:                  'c_monitor',
    planType:             'candidate',
    name:                 'Monitor',
    price:                '$59 / mo',
    monthlyPrice:         59,
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
      offices:            false,
      multiGamePlan:      false,
      bulkProfiler:       false,
      csvImport:          true,
      campaignIntel:      false,
      discoverCandidates: false,
      socialLinks:        true,
      weeklyProfile:      false,
      creditPacks:        true,
    },
    unlocks: [
      'Full AI profile generation',
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
    price:                '$89 / mo',
    monthlyPrice:         89,
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
      offices:            false,
      multiGamePlan:      false,
      bulkProfiler:       false,
      csvImport:          true,
      campaignIntel:      true,
      discoverCandidates: true,
      socialLinks:        true,
      weeklyProfile:      false,
      creditPacks:        true,
    },
    unlocks: [
      '2 profiles / month',
      '1 active candidate monitoring',
      'Campaign Intel briefs',
      'AI candidate discovery',
      'Compare tool',
    ],
    nextUnlocks: [
      '4 profiles / month',
      '2 user seats',
      '3 active candidates',
    ],
  },

  c_campaign: {
    key:                  'c_campaign',
    planType:             'candidate',
    name:                 'Campaign',
    price:                '$139 / mo',
    monthlyPrice:         139,
    profileLimit:         4,
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
      offices:            false,
      multiGamePlan:      false,
      bulkProfiler:       false,
      csvImport:          true,
      campaignIntel:      true,
      discoverCandidates: true,
      socialLinks:        true,
      weeklyProfile:      true,
      creditPacks:        true,
    },
    unlocks: [
      '4 profiles / month',
      '2 user seats',
      '3 active candidates',
      'Weekly auto-refresh',
    ],
    nextUnlocks: [],
  },
}

// ─── Action Plan ──────────────────────────────────────────────────────────────

export const ACTION_PLAN_ORDER = ['a_monitor', 'a_active', 'a_campaign']

// officesScope: 'county' | 'district' | 'state'
export const ACTION_PLAN_CONFIG = {
  a_monitor: {
    key:                   'a_monitor',
    planType:              'action',
    name:                  'Monitor',
    price:                 'From $69 / mo',
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
      offices:            true,
      officesScope:       'county',
      compare:            false,
      bulkProfiler:       false,
      csvImport:          true,
      campaignIntel:      true,
      discoverCandidates: true,
      socialLinks:        true,
      weeklyProfile:      false,
      bulkCredits:        false,
    },
    unlocks: [
      'Prospecting',
      'Multi-Candidate Game Plan',
      'Offices — county view',
      '1 profile per candidate / month',
    ],
    nextUnlocks: [
      '2 profiles per candidate / month',
      '2 user seats',
      'Offices — congressional & senate districts',
      'Compare tool',
    ],
  },

  a_active: {
    key:                   'a_active',
    planType:              'action',
    name:                  'Active',
    price:                 'From $119 / mo',
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
      offices:            true,
      officesScope:       'district',
      compare:            true,
      bulkProfiler:       false,
      csvImport:          true,
      campaignIntel:      true,
      discoverCandidates: true,
      socialLinks:        true,
      weeklyProfile:      true,
      bulkCredits:        false,
    },
    unlocks: [
      '2 profiles per candidate / month',
      '2 user seats',
      'Offices — congressional & senate districts',
      'Compare tool',
      'Weekly auto-refresh',
    ],
    nextUnlocks: [
      '4 profiles per candidate / month',
      'Unlimited user seats',
      'Offices — entire state',
      'Bulk Profiler',
    ],
  },

  a_campaign: {
    key:                   'a_campaign',
    planType:              'action',
    name:                  'Campaign',
    price:                 'From $159 / mo',
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
      offices:            true,
      officesScope:       'state',
      compare:            true,
      bulkProfiler:       true,
      csvImport:          true,
      campaignIntel:      true,
      discoverCandidates: true,
      socialLinks:        true,
      weeklyProfile:      true,
      bulkCredits:        true,
    },
    unlocks: [
      '4 profiles per candidate / month',
      'Unlimited user seats',
      'Offices — entire state',
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

export const ACTION_MONTHLY_PRICES = {
  a_monitor: { b1: 69,  b2_5: 99,  b6: 129, b11: 169, b26: 219, b51: 299, ent: null },
  a_active:  { b1: 119, b2_5: 149, b6: 199, b11: 269, b26: 389, b51: 549, ent: null },
  a_campaign:{ b1: 159, b2_5: 249, b6: 349, b11: 479, b26: 699, b51: 999, ent: null },
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

// Total amount charged per billing period
export function periodTotal(baseMonthlyPrice, billingPeriod = 'monthly') {
  if (billingPeriod === 'annual') {
    // 2 months free = pay 10 months (no per-month rounding needed)
    return baseMonthlyPrice * 10
  }
  const period = BILLING_PERIODS[billingPeriod] ?? BILLING_PERIODS.monthly
  // Derive from the rounded per-month rate so periodTotal = displayedRate × months
  return effectiveMonthlyRate(baseMonthlyPrice, billingPeriod) * period.months
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

// ─── A la carte profile credit packs (Candidate Plan only) ───────────────────

export const CREDIT_PACKS = [
  { key: 'c1',  qty: 1,  price: 49,  perCredit: 49.00, savingsPct: null },
  { key: 'c5',  qty: 5,  price: 199, perCredit: 39.80, savingsPct: 19   },
  { key: 'c10', qty: 10, price: 349, perCredit: 34.90, savingsPct: 29   },
  { key: 'c25', qty: 25, price: 749, perCredit: 29.96, savingsPct: 39   },
]

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

export function getUserPlan(user) {
  if (!user) return 'scout'
  if (ADMIN_EMAILS.includes(user.email?.toLowerCase())) return 'a_campaign'
  const p = user?.user_metadata?.plan
  return p && PLAN_CONFIG[p] ? p : 'scout'
}

export function getUserPlanType(user) {
  const plan = getUserPlan(user)
  return PLAN_CONFIG[plan]?.planType ?? 'candidate'
}

export function getUserBracket(user) {
  const b = user?.user_metadata?.bracket
  return b && BRACKET_CONFIG[b] ? b : 'b1'
}

export function getUserBillingPeriod(user) {
  const bp = user?.user_metadata?.billing
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

export function getOfficesScope(planKey) {
  const cfg = PLAN_CONFIG[planKey]
  if (!cfg?.features?.offices) return null
  return cfg.features.officesScope ?? null
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
export function getEffectiveProfileLimit(user) {
  if (user?.email && ADMIN_EMAILS.includes(user.email.toLowerCase())) return Infinity
  return getProfileLimit(getUserPlan(user), getUserBracket(user))
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
  // Within same plan family, use order index
  const fromIdx = PLAN_ORDER.indexOf(fromPlan)
  const toIdx   = PLAN_ORDER.indexOf(toPlan)
  return toIdx > fromIdx
}

export function getNextPlan(planKey) {
  const isCand = isCandidatePlan(planKey)
  const order  = isCand ? CANDIDATE_PLAN_ORDER : ACTION_PLAN_ORDER
  const idx    = order.indexOf(planKey)
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
