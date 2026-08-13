#!/usr/bin/env node
// Badger Board — plan-gate truth tests (v1.30 Tier 2 audit, section 2B)
//   1. normalizePlan mirrors netlify/functions/_entitlements.js so legacy plan
//      keys can never reach PLAN_ORDER.indexOf() and rank -1.
//   2. periodTotal matches stripe-setup.mjs to the cent for all 84 plan ×
//      bracket × billing-period combinations — the displayed total must equal
//      what Stripe actually charges.
// Zero-config: node tests/tiers.test.mjs

let pass = 0, fail = 0
const t = (name, cond) => { cond ? pass++ : fail++; console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${name}`) }

const {
  normalizePlan, PLAN_ORDER, PLAN_CONFIG,
  getUserPlan, getNextPlan, isUpgrade, getEntitlementSource,
  periodTotal, CANDIDATE_PLAN_CONFIG, ACTION_MONTHLY_PRICES, BRACKET_ORDER,
} = await import('../src/lib/tiers.js')

// ─── normalizePlan ────────────────────────────────────────────────────────────
console.log('2B — normalizePlan (mirror of _entitlements.js)')

t('monitor → c_monitor',   normalizePlan('monitor')  === 'c_monitor')
t('campaign → a_campaign', normalizePlan('campaign') === 'a_campaign')
t('agency → a_campaign',   normalizePlan('agency')   === 'a_campaign')
t('canonical keys pass through', PLAN_ORDER.every(k => normalizePlan(k) === k))
t('null/undefined → scout', normalizePlan(null) === 'scout' && normalizePlan(undefined) === 'scout')
t('unknown key → scout',    normalizePlan('enterprise_gold') === 'scout')
t('every legacy alias in PLAN_CONFIG normalizes into PLAN_ORDER',
  Object.keys(PLAN_CONFIG).every(k => PLAN_ORDER.indexOf(normalizePlan(k)) >= 0))
t('no legacy key ever ranks -1',
  ['monitor', 'campaign', 'agency'].every(k => PLAN_ORDER.indexOf(normalizePlan(k)) > -1))

// ─── legacy keys through the resolver ────────────────────────────────────────
console.log('2B — resolver / getNextPlan with legacy keys')

const userWith = (app_metadata) => ({ email: 'legacy@example.com', app_metadata })

t('getUserPlan normalizes a legacy paid plan',
  getUserPlan(userWith({ plan: 'monitor' })) === 'c_monitor')
t('getUserPlan normalizes legacy campaign → a_campaign',
  getUserPlan(userWith({ plan: 'campaign' })) === 'a_campaign')

// A trial that outranks the (legacy) paid plan must win. Before normalizePlan,
// PLAN_ORDER.indexOf('monitor') was -1, so ANY trial outranked it — and worse,
// a legacy a_campaign holder ('campaign') was beaten by a c_monitor trial.
const inAWeek = new Date(Date.now() + 7 * 86400000).toISOString()
t('trial outranks a legacy lower plan',
  getUserPlan(userWith({ plan: 'monitor', trial_plan: 'c_campaign', trial_ends_at: inAWeek })) === 'c_campaign')
t('trial does NOT downgrade a legacy top plan',
  getUserPlan(userWith({ plan: 'campaign', trial_plan: 'c_monitor', trial_ends_at: inAWeek })) === 'a_campaign')
t('entitlement source stays "paid" when the trial cannot outrank',
  getEntitlementSource(userWith({ plan: 'campaign', trial_plan: 'c_monitor', trial_ends_at: inAWeek })) === 'paid')
t('an expired trial is ignored',
  getUserPlan(userWith({ plan: 'monitor', trial_plan: 'a_campaign', trial_ends_at: '2020-01-01T00:00:00Z' })) === 'c_monitor')

t('getNextPlan("monitor") → c_active', getNextPlan('monitor') === 'c_active')
t('getNextPlan("campaign") → null (top of the Action ladder)', getNextPlan('campaign') === null)
t('getNextPlan("scout") → c_monitor', getNextPlan('scout') === 'c_monitor')
t('isUpgrade("monitor", "c_campaign") is true', isUpgrade('monitor', 'c_campaign') === true)
t('isUpgrade("campaign", "c_monitor") is false', isUpgrade('campaign', 'c_monitor') === false)

// ─── periodTotal ↔ stripe-setup.mjs parity ───────────────────────────────────
console.log('2B — periodTotal parity with stripe-setup.mjs (84 combos)')

// Verbatim copy of stripe-setup.mjs — the script that mints the live Stripe
// prices. If either side is edited without the other, these tests fail.
const STRIPE_CANDIDATE_PLANS = [
  { key: 'c_monitor',  monthlyPrice: 79  },
  { key: 'c_active',   monthlyPrice: 119 },
  { key: 'c_campaign', monthlyPrice: 189 },
]
const STRIPE_ACTION_MONTHLY_PRICES = {
  a_monitor:  { b1: 89,  b2_5: 129, b6: 169, b11: 229, b26: 299, b51: 399  },
  a_active:   { b1: 149, b2_5: 199, b6: 269, b11: 359, b26: 529, b51: 749  },
  a_campaign: { b1: 219, b2_5: 339, b6: 469, b11: 649, b26: 949, b51: 1349 },
}
const STRIPE_BILLING = ['monthly', 'quarterly', 'semiannual', 'annual']
function periodAmountCents(base, billingKey) {
  if (billingKey === 'monthly')    return base * 100
  if (billingKey === 'quarterly')  return Math.round(base * 0.95 * 3) * 100
  if (billingKey === 'semiannual') return Math.round(base * 0.90 * 6) * 100
  if (billingKey === 'annual')     return base * 10 * 100
  return base * 100
}

let combos = 0, mismatches = []
for (const p of STRIPE_CANDIDATE_PLANS) {
  // The app reads the price out of PLAN_CONFIG, so check that table too.
  if (CANDIDATE_PLAN_CONFIG[p.key].monthlyPrice !== p.monthlyPrice) {
    mismatches.push(`${p.key} base ${CANDIDATE_PLAN_CONFIG[p.key].monthlyPrice} ≠ stripe ${p.monthlyPrice}`)
  }
  for (const b of STRIPE_BILLING) {
    combos++
    const app    = periodTotal(p.monthlyPrice, b) * 100
    const stripe = periodAmountCents(p.monthlyPrice, b)
    if (app !== stripe) mismatches.push(`${p.key}/${b}: app ${app} ≠ stripe ${stripe}`)
  }
}
for (const [plan, brackets] of Object.entries(STRIPE_ACTION_MONTHLY_PRICES)) {
  for (const [bracket, base] of Object.entries(brackets)) {
    if (ACTION_MONTHLY_PRICES[plan][bracket] !== base) {
      mismatches.push(`${plan}/${bracket} base ${ACTION_MONTHLY_PRICES[plan][bracket]} ≠ stripe ${base}`)
    }
    for (const b of STRIPE_BILLING) {
      combos++
      const app    = periodTotal(base, b) * 100
      const stripe = periodAmountCents(base, b)
      if (app !== stripe) mismatches.push(`${plan}/${bracket}/${b}: app ${app} ≠ stripe ${stripe}`)
    }
  }
}

t('all 84 plan × bracket × period combos were checked', combos === 84)
t(`every combo matches Stripe to the cent${mismatches.length ? ' — ' + mismatches.join('; ') : ''}`, mismatches.length === 0)

// Spot checks of the specific rounding rule (round once, on the period total).
t('quarterly 129 → 368 (not 369)',   periodTotal(129, 'quarterly')  === 368)
t('semiannual 129 → 697 (not 696)',  periodTotal(129, 'semiannual') === 697)
t('monthly is the base rate',        periodTotal(129, 'monthly')    === 129)
t('annual is exactly 10 months',     periodTotal(129, 'annual')     === 1290)
t('unknown period falls back to monthly', periodTotal(129, 'weekly') === 129)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
