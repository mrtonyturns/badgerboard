// Metadata-aware price mint: every plan×bracket×billing gets a price whose
// metadata matches exactly — never reuses a same-amount price from another bracket.
import Stripe from 'stripe'
const stripe = new Stripe(process.argv[2])

const CANDIDATE = [
  { key: 'c_monitor',  name: 'Badger Board Monitor (Candidate)', base: 79  },
  { key: 'c_active',   name: 'Badger Board Active (Candidate)',  base: 119 },
  { key: 'c_campaign', name: 'Badger Board Campaign (Candidate)',base: 189 },
]
const ACTION = {
  a_monitor:  { name: 'Badger Board Monitor (Action)',  brackets: { b1: 89,  b2_5: 129, b6: 169, b11: 229, b26: 299, b51: 399  } },
  a_active:   { name: 'Badger Board Active (Action)',   brackets: { b1: 149, b2_5: 199, b6: 269, b11: 359, b26: 529, b51: 749  } },
  a_campaign: { name: 'Badger Board Campaign (Action)', brackets: { b1: 219, b2_5: 339, b6: 469, b11: 649, b26: 949, b51: 1349 } },
}
const BILLING = [
  { key: 'monthly',    suffix: 'M', interval: 'month', count: 1 },
  { key: 'quarterly',  suffix: 'Q', interval: 'month', count: 3 },
  { key: 'semiannual', suffix: 'S', interval: 'month', count: 6 },
  { key: 'annual',     suffix: 'A', interval: 'year',  count: 1 },
]
const cents = (base, b) =>
  b === 'monthly' ? base*100 : b === 'quarterly' ? Math.round(base*0.95*3)*100 :
  b === 'semiannual' ? Math.round(base*0.90*6)*100 : base*10*100

async function product(name) {
  const r = await stripe.products.search({ query: `name:"${name}"`, limit: 1 }).catch(() => ({data:[]}))
  if (r.data.length) return r.data[0]
  throw new Error('product missing: ' + name)
}

async function ensurePrice(productId, amount, billing, meta, nickname) {
  const list = await stripe.prices.list({ product: productId, active: true, limit: 100 })
  const match = list.data.find(p =>
    p.unit_amount === amount &&
    p.recurring?.interval === billing.interval &&
    p.recurring?.interval_count === billing.count &&
    (p.metadata?.bracket || null) === (meta.bracket || null) &&
    (p.metadata?.billing || null) === meta.billing &&
    (p.metadata?.plan_key || null) === meta.plan_key &&
    (p.metadata?.pricing_gen || null) === 'v2026_07'
  )
  if (match) return { id: match.id, created: false }
  const p = await stripe.prices.create({
    product: productId, unit_amount: amount, currency: 'usd',
    recurring: { interval: billing.interval, interval_count: billing.count },
    nickname, metadata: { ...meta, pricing_gen: 'v2026_07' },
  })
  return { id: p.id, created: true }
}

const out = {}
let created = 0, reused = 0
for (const plan of CANDIDATE) {
  const prod = await product(plan.name)
  for (const b of BILLING) {
    const r = await ensurePrice(prod.id, cents(plan.base, b.key), b,
      { plan_key: plan.key, billing: b.key, plan_type: 'candidate' },
      `${plan.key} — ${b.key} — v2026_07`)
    out[`STRIPE_PRICE_${plan.key.toUpperCase()}_${b.suffix}`] = r.id
    r.created ? created++ : reused++
  }
}
for (const [planKey, cfg] of Object.entries(ACTION)) {
  const prod = await product(cfg.name)
  for (const [bracket, base] of Object.entries(cfg.brackets)) {
    for (const b of BILLING) {
      const r = await ensurePrice(prod.id, cents(base, b.key), b,
        { plan_key: planKey, bracket, billing: b.key, plan_type: 'action' },
        `${planKey} — ${bracket} — ${b.key} — v2026_07`)
      out[`STRIPE_PRICE_${planKey.toUpperCase()}_${bracket.toUpperCase()}_${b.suffix}`] = r.id
      r.created ? created++ : reused++
    }
  }
}
console.log(JSON.stringify({ created, reused_v2: reused, count: Object.keys(out).length, prices: out }, null, 2))
