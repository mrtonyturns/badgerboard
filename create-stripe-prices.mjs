// create-stripe-prices.mjs
// Creates all new Stripe products + prices for Badger Board updated pricing.
// Outputs a JSON map of env var name → price ID for Netlify.

import Stripe from 'stripe'

// Never hardcode secrets. Run with:  STRIPE_SECRET_KEY=sk_live_... node create-stripe-prices.mjs
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY
if (!STRIPE_KEY) {
  console.error('Set STRIPE_SECRET_KEY in the environment before running this script.')
  process.exit(1)
}
const stripe = new Stripe(STRIPE_KEY)

const MONTHLY = {
  monitor:  { b1: 49,  b2_5: 69,  b6: 89,  b11: 119, b26: 159, b51: 219 },
  campaign: { b1: 69,  b2_5: 109, b6: 149, b11: 199, b26: 289, b51: 399 },
  agency:   { b1: 119, b2_5: 189, b6: 269, b11: 369, b26: 519, b51: 719 },
}

const PLAN_DISPLAY    = { monitor: 'Monitor', campaign: 'Campaign', agency: 'Agency' }
const BRACKET_DISPLAY = { b1: '1', b2_5: '2-5', b6: '6-10', b11: '11-25', b26: '26-50', b51: '51-100' }
const BRACKETS        = ['b1', 'b2_5', 'b6', 'b11', 'b26', 'b51']
const PLANS           = ['monitor', 'campaign', 'agency']

const CREDIT_PACKS = [
  { key: 'c1',  qty: 1,  label: '1 Dossier Credit',   price: 49  },
  { key: 'c5',  qty: 5,  label: '5 Dossier Credits',  price: 199 },
  { key: 'c10', qty: 10, label: '10 Dossier Credits', price: 349 },
  { key: 'c25', qty: 25, label: '25 Dossier Credits', price: 749 },
]

const results = {}
const errors  = []

async function safe(label, fn) {
  try {
    const result = await fn()
    console.log(`  ✓  ${label}`)
    return result
  } catch (err) {
    console.error(`  ✗  ${label}: ${err.message}`)
    errors.push({ label, error: err.message })
    return null
  }
}

console.log('\n── Creating subscription products & prices ───────────────────────────\n')

for (const plan of PLANS) {
  console.log(`\n[${PLAN_DISPLAY[plan]}]`)

  // One product per plan
  const product = await safe(`Product: Badger Board ${PLAN_DISPLAY[plan]}`, () =>
    stripe.products.create({
      name:        `Badger Board ${PLAN_DISPLAY[plan]}`,
      description: `${PLAN_DISPLAY[plan]} plan — AI political intelligence for Wisconsin campaigns`,
      metadata:    { plan },
    })
  )
  if (!product) continue

  for (const bracket of BRACKETS) {
    const m       = MONTHLY[plan][bracket]
    const bLabel  = BRACKET_DISPLAY[bracket]
    const envBase = `STRIPE_PRICE_${plan.toUpperCase()}_${bracket.toUpperCase()}`

    // Monthly ($m/month)
    const mp = await safe(`${envBase}_M  $${m}/mo`, () =>
      stripe.prices.create({
        product:    product.id,
        unit_amount: m * 100,
        currency:   'usd',
        recurring:  { interval: 'month' },
        nickname:   `${PLAN_DISPLAY[plan]} · ${bLabel} candidates · Monthly`,
        metadata:   { plan, bracket, billing: 'monthly' },
      })
    )
    if (mp) results[`${envBase}_M`] = mp.id

    // Semiannual (full price billed every 6 months + 10 bonus dossier credits)
    const sp = await safe(`${envBase}_S  $${m * 6} every 6mo`, () =>
      stripe.prices.create({
        product:    product.id,
        unit_amount: m * 6 * 100,
        currency:   'usd',
        recurring:  { interval: 'month', interval_count: 6 },
        nickname:   `${PLAN_DISPLAY[plan]} · ${bLabel} candidates · 6-Month (+10 dossier credits)`,
        metadata:   { plan, bracket, billing: 'semiannual' },
      })
    )
    if (sp) results[`${envBase}_S`] = sp.id

    // Annual (10 months billed = 2 months free — Founding Member rate)
    const annualTotal = m * 10
    const ap = await safe(`${envBase}_A  $${annualTotal}/yr (10mo)`, () =>
      stripe.prices.create({
        product:    product.id,
        unit_amount: annualTotal * 100,
        currency:   'usd',
        recurring:  { interval: 'year' },
        nickname:   `${PLAN_DISPLAY[plan]} · ${bLabel} candidates · Annual Founding Member (2 months free)`,
        metadata:   { plan, bracket, billing: 'annual' },
      })
    )
    if (ap) results[`${envBase}_A`] = ap.id
  }
}

console.log('\n── Creating a la carte dossier credit products & prices ──────────────\n')

const creditsProduct = await safe('Product: Badger Board Dossier Credits', () =>
  stripe.products.create({
    name:        'Badger Board Dossier Credits',
    description: 'A la carte AI dossier generation credits — never expire, work with any plan',
    metadata:    { product: 'credits' },
  })
)

if (creditsProduct) {
  for (const pack of CREDIT_PACKS) {
    const envKey = `STRIPE_PRICE_CREDITS_${pack.key.toUpperCase()}`
    const cp = await safe(`${envKey}  $${pack.price} (${pack.label})`, () =>
      stripe.prices.create({
        product:    creditsProduct.id,
        unit_amount: pack.price * 100,
        currency:   'usd',
        nickname:   pack.label,
        metadata:   { product: 'credits', pack: pack.key, qty: String(pack.qty) },
      })
    )
    if (cp) results[envKey] = cp.id
  }
}

console.log('\n── Results ────────────────────────────────────────────────────────────\n')
console.log(JSON.stringify(results, null, 2))

if (errors.length) {
  console.error(`\n⚠️  ${errors.length} error(s):\n`)
  errors.forEach(e => console.error(`  • ${e.label}: ${e.error}`))
} else {
  console.log(`\n✅  All ${Object.keys(results).length} prices created successfully.`)
}
