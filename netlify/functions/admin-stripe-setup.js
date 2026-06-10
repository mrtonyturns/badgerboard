// netlify/functions/admin-stripe-setup.js
// One-time function to create all Stripe products and prices for Badger Board.
// Protected by ADMIN_SETUP_TOKEN env var — call once, then the function is inert.
//
// Usage:
//   curl -X POST https://www.badgerboardwi.com/.netlify/functions/admin-stripe-setup \
//     -H "Content-Type: application/json" \
//     -d '{"token": "<ADMIN_SETUP_TOKEN>"}'
//
// Required env vars:
//   STRIPE_SECRET_KEY    — must have Products + Prices write permissions (sk_live_ or rk_live_ with those perms)
//   ADMIN_SETUP_TOKEN    — set to any secret string to protect this endpoint
//
// After running, add the returned env vars to Netlify:
//   netlify env:set STRIPE_PRICE_C_MONITOR_M price_xxx
//   (or use the bulk script printed in the response)

import Stripe from 'stripe'
import { ADMIN_EMAILS } from './_config.js'

// ── Pricing tables ────────────────────────────────────────────────────────────

const CANDIDATE_PLANS = [
  { key: 'c_monitor',  name: 'Badger Board Monitor (Candidate)', monthlyPrice: 59  },
  { key: 'c_active',   name: 'Badger Board Active (Candidate)',  monthlyPrice: 89  },
  { key: 'c_campaign', name: 'Badger Board Campaign (Candidate)',monthlyPrice: 139 },
]

const ACTION_MONTHLY_PRICES = {
  a_monitor:  { b1: 69,  b2_5: 99,  b6: 129, b11: 169, b26: 219, b51: 299 },
  a_active:   { b1: 119, b2_5: 149, b6: 199, b11: 269, b26: 389, b51: 549 },
  a_campaign: { b1: 159, b2_5: 249, b6: 349, b11: 479, b26: 699, b51: 999 },
}

const ACTION_PLAN_NAMES = {
  a_monitor:  'Badger Board Monitor (Action)',
  a_active:   'Badger Board Active (Action)',
  a_campaign: 'Badger Board Campaign (Action)',
}

const BRACKET_LABELS = {
  b1:   '1 Active Candidate',
  b2_5: '2–5 Active Candidates',
  b6:   '6–10 Active Candidates',
  b11:  '11–25 Active Candidates',
  b26:  '26–50 Active Candidates',
  b51:  '51–100 Active Candidates',
}

const BILLING = [
  { key: 'monthly',    suffix: 'M', label: 'Monthly',     interval: 'month', interval_count: 1 },
  { key: 'quarterly',  suffix: 'Q', label: 'Quarterly',   interval: 'month', interval_count: 3 },
  { key: 'semiannual', suffix: 'S', label: 'Semi-annual', interval: 'month', interval_count: 6 },
  { key: 'annual',     suffix: 'A', label: 'Annual',      interval: 'year',  interval_count: 1 },
]

// Total amount charged per billing period (in cents)
function periodAmountCents(base, billingKey) {
  if (billingKey === 'monthly')    return base * 100
  if (billingKey === 'quarterly')  return Math.round(base * 0.95 * 3) * 100
  if (billingKey === 'semiannual') return Math.round(base * 0.90 * 6) * 100
  if (billingKey === 'annual')     return base * 10 * 100   // 2 months free
  return base * 100
}

// ── Stripe helpers ────────────────────────────────────────────────────────────

async function getOrCreateProduct(stripe, name, metadata) {
  try {
    const res = await stripe.products.search({ query: `name:"${name}"`, limit: 1 })
    if (res.data.length > 0) return { product: res.data[0], created: false }
  } catch (_) { /* search not available on all key types — fall through */ }

  const product = await stripe.products.create({ name, metadata, active: true })
  return { product, created: true }
}

async function getOrCreatePrice(stripe, productId, amountCents, billing, nickname, metadata) {
  const existing = await stripe.prices.list({ product: productId, active: true, limit: 100 })
  const match = existing.data.find(p =>
    p.unit_amount === amountCents &&
    p.recurring?.interval === billing.interval &&
    p.recurring?.interval_count === billing.interval_count
  )
  if (match) return { price: match, created: false }

  const price = await stripe.prices.create({
    product:      productId,
    unit_amount:  amountCents,
    currency:     'usd',
    recurring:    { interval: billing.interval, interval_count: billing.interval_count },
    nickname,
    metadata,
  })
  return { price, created: true }
}

// ── Main handler ─────────────────────────────────────────────────────────────

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'POST only' }) }
  }

  let body
  try { body = JSON.parse(event.body || '{}') } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }
  }

  // Token check
  const token = process.env.ADMIN_SETUP_TOKEN
  if (!token || body.token !== token) {
    return { statusCode: 403, body: JSON.stringify({ error: 'Forbidden' }) }
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)

  const envVars    = {}
  const created    = []
  const existing   = []
  const errors     = []

  // ── Candidate plans ─────────────────────────────────────────────────────────
  for (const plan of CANDIDATE_PLANS) {
    let productId
    try {
      const { product, created: c } = await getOrCreateProduct(stripe, plan.name, {
        plan_key:  plan.key,
        plan_type: 'candidate',
      })
      productId = product.id
      if (c) created.push(`product: ${plan.name}`)
      else existing.push(`product: ${plan.name}`)
    } catch (err) {
      errors.push(`Product "${plan.name}": ${err.message}`)
      continue
    }

    for (const billing of BILLING) {
      const amountCents = periodAmountCents(plan.monthlyPrice, billing.key)
      const nickname    = `${plan.key} — ${billing.label}`
      try {
        const { price, created: c } = await getOrCreatePrice(
          stripe, productId, amountCents, billing, nickname,
          { plan_key: plan.key, billing: billing.key, plan_type: 'candidate' }
        )
        const envKey   = `STRIPE_PRICE_${plan.key.toUpperCase()}_${billing.suffix}`
        envVars[envKey] = price.id
        if (c) created.push(`price: ${nickname} = ${price.id}`)
        else existing.push(`price: ${nickname} = ${price.id}`)
      } catch (err) {
        errors.push(`Price "${nickname}": ${err.message}`)
      }
    }
  }

  // ── Action plans ─────────────────────────────────────────────────────────────
  for (const [planKey, brackets] of Object.entries(ACTION_MONTHLY_PRICES)) {
    const planName = ACTION_PLAN_NAMES[planKey]
    let productId
    try {
      const { product, created: c } = await getOrCreateProduct(stripe, planName, {
        plan_key:  planKey,
        plan_type: 'action',
      })
      productId = product.id
      if (c) created.push(`product: ${planName}`)
      else existing.push(`product: ${planName}`)
    } catch (err) {
      errors.push(`Product "${planName}": ${err.message}`)
      continue
    }

    for (const [bracket, base] of Object.entries(brackets)) {
      for (const billing of BILLING) {
        const amountCents  = periodAmountCents(base, billing.key)
        const bracketUpper = bracket.toUpperCase()
        const nickname     = `${planKey} — ${BRACKET_LABELS[bracket]} — ${billing.label}`
        try {
          const { price, created: c } = await getOrCreatePrice(
            stripe, productId, amountCents, billing, nickname,
            { plan_key: planKey, bracket, billing: billing.key, plan_type: 'action' }
          )
          const envKey   = `STRIPE_PRICE_${planKey.toUpperCase()}_${bracketUpper}_${billing.suffix}`
          envVars[envKey] = price.id
          if (c) created.push(`price: ${nickname} = ${price.id}`)
          else existing.push(`price: ${nickname} = ${price.id}`)
        } catch (err) {
          errors.push(`Price "${nickname}": ${err.message}`)
        }
      }
    }
  }

  // ── Build Netlify CLI bulk-set script ─────────────────────────────────────
  const netlifyScript = Object.entries(envVars)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `netlify env:set ${k} ${v}`)
    .join('\n')

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      summary: {
        total_env_vars: Object.keys(envVars).length,
        created:        created.length,
        already_existed: existing.length,
        errors:         errors.length,
      },
      env_vars:        envVars,
      netlify_script:  netlifyScript,
      errors:          errors.length ? errors : undefined,
    }, null, 2),
  }
}
