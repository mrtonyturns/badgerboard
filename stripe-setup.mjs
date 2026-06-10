/**
 * Badger Board — Stripe One-Time Product & Price Setup
 * =====================================================
 * Run this once to create all Stripe products and prices.
 *
 * USAGE:
 *   node stripe-setup.mjs sk_live_XXXXXXXXXXXXXXXXXXXXXXXXXX
 *
 * After running, the script will print all the env var assignments.
 * Copy them and run the printed netlify commands, or paste into Netlify
 * Dashboard → Environment Variables.
 *
 * Requires: node 18+ (built-in fetch, no extra dependencies)
 */

const sk = process.argv[2]
if (!sk || !sk.startsWith('sk_')) {
  console.error('Usage: node stripe-setup.mjs sk_live_YOUR_KEY_HERE')
  console.error('Get your secret key from: https://dashboard.stripe.com/apikeys')
  process.exit(1)
}

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

function periodAmountCents(base, billingKey) {
  if (billingKey === 'monthly')    return base * 100
  if (billingKey === 'quarterly')  return Math.round(base * 0.95 * 3) * 100
  if (billingKey === 'semiannual') return Math.round(base * 0.90 * 6) * 100
  if (billingKey === 'annual')     return base * 10 * 100
  return base * 100
}

// ── Stripe API helpers (using built-in fetch) ─────────────────────────────────

const AUTH = `Basic ${Buffer.from(sk + ':').toString('base64')}`

async function stripePost(path, data) {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(data)) {
    if (v !== undefined) params.append(k, String(v))
  }
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    method:  'POST',
    headers: { Authorization: AUTH, 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    params,
  })
  return res.json()
}

async function stripeGet(path) {
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    headers: { Authorization: AUTH },
  })
  return res.json()
}

async function searchProduct(name) {
  // Try search endpoint (not available on all key types)
  try {
    const r = await fetch(
      `https://api.stripe.com/v1/products/search?query=${encodeURIComponent(`name:"${name}"`)}`,
      { headers: { Authorization: AUTH } }
    )
    const j = await r.json()
    if (j.data?.length) return j.data[0]
  } catch (_) {}
  // Fall back to list and filter
  const r2 = await stripeGet('/products?limit=100&active=true')
  return r2.data?.find(p => p.name === name) || null
}

async function getOrCreateProduct(name, metadata) {
  const existing = await searchProduct(name)
  if (existing) { process.stdout.write('↩'); return existing }
  const p = await stripePost('/products', { name, 'metadata[plan_key]': metadata.plan_key, 'metadata[plan_type]': metadata.plan_type })
  if (p.error) throw new Error(p.error.message)
  process.stdout.write('✅')
  return p
}

async function findExistingPrice(productId, amountCents, billing) {
  let url = `/prices?product=${productId}&active=true&limit=100`
  let page
  do {
    const r = await stripeGet(url + (page ? `&starting_after=${page}` : ''))
    const j = r
    for (const p of (j.data || [])) {
      if (
        p.unit_amount === amountCents &&
        p.recurring?.interval === billing.interval &&
        p.recurring?.interval_count === billing.interval_count
      ) return p
    }
    page = j.has_more ? j.data?.at(-1)?.id : null
  } while (page)
  return null
}

async function getOrCreatePrice(productId, amountCents, billing, nickname, metadata) {
  const existing = await findExistingPrice(productId, amountCents, billing)
  if (existing) { process.stdout.write('↩'); return existing }
  const p = await stripePost('/prices', {
    product:                     productId,
    unit_amount:                 amountCents,
    currency:                    'usd',
    'recurring[interval]':       billing.interval,
    'recurring[interval_count]': billing.interval_count,
    nickname,
    'metadata[plan_key]':        metadata.plan_key,
    ...(metadata.bracket ? { 'metadata[bracket]': metadata.bracket } : {}),
    'metadata[billing]':         metadata.billing,
    'metadata[plan_type]':       metadata.plan_type,
  })
  if (p.error) throw new Error(p.error.message)
  process.stdout.write('✅')
  return p
}

// ── Main ─────────────────────────────────────────────────────────────────────

const envVars = {}

async function run() {
  console.log('\n🦡 Badger Board — Stripe Setup')
  console.log('='.repeat(50))

  // Verify the key works
  const me = await stripeGet('/account')
  if (me.error) {
    console.error('Key error:', me.error.message)
    process.exit(1)
  }
  console.log(`Account: ${me.business_profile?.name || me.id}  (${me.livemode ? 'LIVE' : 'TEST'})`)
  console.log()

  // ── Candidate plans ──────────────────────────────────────────────────────────
  console.log('── Candidate Plans ──────────────────────────────────────')
  for (const plan of CANDIDATE_PLANS) {
    process.stdout.write(`  ${plan.name}: `)
    let productId
    try {
      const product = await getOrCreateProduct(plan.name, { plan_key: plan.key, plan_type: 'candidate' })
      productId = product.id
    } catch (err) {
      console.log(` ERROR: ${err.message}`)
      continue
    }
    process.stdout.write(' | ')
    for (const billing of BILLING) {
      const cents    = periodAmountCents(plan.monthlyPrice, billing.key)
      const nickname = `${plan.key} — ${billing.label}`
      try {
        const price = await getOrCreatePrice(productId, cents, billing, nickname, {
          plan_key: plan.key, billing: billing.key, plan_type: 'candidate',
        })
        const envKey    = `STRIPE_PRICE_${plan.key.toUpperCase()}_${billing.suffix}`
        envVars[envKey] = price.id
      } catch (err) {
        process.stdout.write(`ERR(${billing.suffix})`)
      }
    }
    console.log()
  }

  // ── Action plans ─────────────────────────────────────────────────────────────
  console.log('\n── Action Plans ─────────────────────────────────────────')
  for (const [planKey, brackets] of Object.entries(ACTION_MONTHLY_PRICES)) {
    const planName = ACTION_PLAN_NAMES[planKey]
    process.stdout.write(`  ${planName}: `)
    let productId
    try {
      const product = await getOrCreateProduct(planName, { plan_key: planKey, plan_type: 'action' })
      productId = product.id
    } catch (err) {
      console.log(` ERROR: ${err.message}`)
      continue
    }
    process.stdout.write(' | ')
    for (const [bracket, base] of Object.entries(brackets)) {
      const bracketUpper = bracket.toUpperCase()
      for (const billing of BILLING) {
        const cents    = periodAmountCents(base, billing.key)
        const nickname = `${planKey} — ${BRACKET_LABELS[bracket]} — ${billing.label}`
        try {
          const price = await getOrCreatePrice(productId, cents, billing, nickname, {
            plan_key: planKey, bracket, billing: billing.key, plan_type: 'action',
          })
          const envKey    = `STRIPE_PRICE_${planKey.toUpperCase()}_${bracketUpper}_${billing.suffix}`
          envVars[envKey] = price.id
        } catch (err) {
          process.stdout.write(`ERR`)
        }
      }
    }
    console.log()
  }

  // ── Output ───────────────────────────────────────────────────────────────────
  console.log('\n\n' + '='.repeat(50))
  console.log(`✅ Done — ${Object.keys(envVars).length} price IDs collected`)
  console.log('='.repeat(50))

  console.log('\n── Copy this and run it in your project folder ──────────')
  const lines = Object.entries(envVars).sort(([a], [b]) => a.localeCompare(b))
  for (const [k, v] of lines) {
    console.log(`npx netlify-cli env:set ${k} ${v}`)
  }

  // Write to a file too
  const { writeFileSync } = await import('fs')
  const out = lines.map(([k, v]) => `${k}=${v}`).join('\n') + '\n'
  writeFileSync('stripe-env-vars.txt', out)
  console.log('\n(Also saved to stripe-env-vars.txt)')
}

run().catch(err => {
  console.error('\nFatal:', err.message)
  process.exit(1)
})
