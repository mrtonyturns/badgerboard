// netlify/functions/update-subscription.js
// Updates an existing Stripe subscription to a different plan/billing period.
// Used for mid-cycle upgrades and downgrades between paid plans.
//
// POST body: { plan, bracket?, billing, userId, email }
//
// Returns: { success: true, message } or { error: string }

import Stripe from 'stripe'

const SUPABASE_URL  = process.env.SUPABASE_URL  || process.env.VITE_SUPABASE_URL
const SUPABASE_ANON = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY

const CANDIDATE_PLANS = ['c_monitor', 'c_active', 'c_campaign']
const ACTION_PLANS    = ['a_monitor', 'a_active', 'a_campaign']
const LEGACY_PLANS    = ['monitor', 'campaign', 'agency']
const VALID_PLANS     = [...CANDIDATE_PLANS, ...ACTION_PLANS, ...LEGACY_PLANS]
const VALID_BRACKETS  = ['b1', 'b2_5', 'b6', 'b11', 'b26', 'b51']
const VALID_BILLING   = ['monthly', 'quarterly', 'semiannual', 'annual']

const BILLING_SUFFIX = { monthly: 'M', quarterly: 'Q', semiannual: 'S', annual: 'A' }

// Same baked-in price table as create-checkout-session.js
const STRIPE_PRICES = {
  STRIPE_PRICE_C_MONITOR_M:        'price_1TYwcxHGi9vK03buLmtrjdhT',
  STRIPE_PRICE_C_MONITOR_Q:        'price_1TYwcyHGi9vK03buTJWuSJcg',
  STRIPE_PRICE_C_MONITOR_S:        'price_1TYwcyHGi9vK03bu6qcKeYYu',
  STRIPE_PRICE_C_MONITOR_A:        'price_1TYwczHGi9vK03buDLQdyJfH',
  STRIPE_PRICE_C_ACTIVE_M:         'price_1TYwd0HGi9vK03bu7t2NG7NR',
  STRIPE_PRICE_C_ACTIVE_Q:         'price_1TYwd1HGi9vK03buXSVA08aT',
  STRIPE_PRICE_C_ACTIVE_S:         'price_1TYwd1HGi9vK03bulSV8mIft',
  STRIPE_PRICE_C_ACTIVE_A:         'price_1TYwd1HGi9vK03buP2Wm4UjR',
  STRIPE_PRICE_C_CAMPAIGN_M:       'price_1TYwd3HGi9vK03buv844HU3s',
  STRIPE_PRICE_C_CAMPAIGN_Q:       'price_1TYwd3HGi9vK03bunX7nYWzJ',
  STRIPE_PRICE_C_CAMPAIGN_S:       'price_1TYwd4HGi9vK03bugexNYpoQ',
  STRIPE_PRICE_C_CAMPAIGN_A:       'price_1TYwd4HGi9vK03buFVmCtU4m',
  STRIPE_PRICE_A_MONITOR_B1_M:     'price_1TYwd5HGi9vK03buf6LqP0F6',
  STRIPE_PRICE_A_MONITOR_B1_Q:     'price_1TYwd6HGi9vK03buF5hdSGE0',
  STRIPE_PRICE_A_MONITOR_B1_S:     'price_1TYwd6HGi9vK03buGe4UJWUw',
  STRIPE_PRICE_A_MONITOR_B1_A:     'price_1TYwd7HGi9vK03buRgD9s7Nn',
  STRIPE_PRICE_A_MONITOR_B2_5_M:   'price_1TYwd7HGi9vK03buwFS2ftr2',
  STRIPE_PRICE_A_MONITOR_B2_5_Q:   'price_1TYwd8HGi9vK03buoYztced9',
  STRIPE_PRICE_A_MONITOR_B2_5_S:   'price_1TYwd8HGi9vK03buhfc0WRhU',
  STRIPE_PRICE_A_MONITOR_B2_5_A:   'price_1TYwd9HGi9vK03buvCOeYJYX',
  STRIPE_PRICE_A_MONITOR_B6_M:     'price_1TYwd9HGi9vK03buu1iqtMhI',
  STRIPE_PRICE_A_MONITOR_B6_Q:     'price_1TYwdAHGi9vK03buXeycgUy1',
  STRIPE_PRICE_A_MONITOR_B6_S:     'price_1TYwdAHGi9vK03buv3bPRrFP',
  STRIPE_PRICE_A_MONITOR_B6_A:     'price_1TYwdBHGi9vK03bu7wdESP9a',
  STRIPE_PRICE_A_MONITOR_B11_M:    'price_1TYwdBHGi9vK03buw84stf3f',
  STRIPE_PRICE_A_MONITOR_B11_Q:    'price_1TYwdCHGi9vK03bu1X7Rrhe6',
  STRIPE_PRICE_A_MONITOR_B11_S:    'price_1TYwdCHGi9vK03buBis9mUKI',
  STRIPE_PRICE_A_MONITOR_B11_A:    'price_1TYwdDHGi9vK03bunYkfsdpG',
  STRIPE_PRICE_A_MONITOR_B26_M:    'price_1TYwdDHGi9vK03bumSVRCRxM',
  STRIPE_PRICE_A_MONITOR_B26_Q:    'price_1TYwdEHGi9vK03bu3U1pctVb',
  STRIPE_PRICE_A_MONITOR_B26_S:    'price_1TYwdEHGi9vK03buTY2cZFfT',
  STRIPE_PRICE_A_MONITOR_B26_A:    'price_1TYwdFHGi9vK03buieZhfIvC',
  STRIPE_PRICE_A_MONITOR_B51_M:    'price_1TYwdFHGi9vK03buW5V7VEN5',
  STRIPE_PRICE_A_MONITOR_B51_Q:    'price_1TYwdGHGi9vK03buEodiGHcu',
  STRIPE_PRICE_A_MONITOR_B51_S:    'price_1TYwdGHGi9vK03bubCWfvRaR',
  STRIPE_PRICE_A_MONITOR_B51_A:    'price_1TYwdHHGi9vK03buv5oMt7By',
  STRIPE_PRICE_A_ACTIVE_B1_M:      'price_1TYwdIHGi9vK03bu2EhS2Fyk',
  STRIPE_PRICE_A_ACTIVE_B1_Q:      'price_1TYwdIHGi9vK03bu9Y2WFark',
  STRIPE_PRICE_A_ACTIVE_B1_S:      'price_1TYwdJHGi9vK03buwwEeFFYG',
  STRIPE_PRICE_A_ACTIVE_B1_A:      'price_1TYwdJHGi9vK03buMCCfAplc',
  STRIPE_PRICE_A_ACTIVE_B2_5_M:    'price_1TYwdKHGi9vK03buI0MuHNmi',
  STRIPE_PRICE_A_ACTIVE_B2_5_Q:    'price_1TYwdKHGi9vK03butR5ZOi71',
  STRIPE_PRICE_A_ACTIVE_B2_5_S:    'price_1TYwdLHGi9vK03buP7RbIX4A',
  STRIPE_PRICE_A_ACTIVE_B2_5_A:    'price_1TYwdLHGi9vK03buwsA0EU9j',
  STRIPE_PRICE_A_ACTIVE_B6_M:      'price_1TYwdMHGi9vK03buiJISwuEj',
  STRIPE_PRICE_A_ACTIVE_B6_Q:      'price_1TYwdMHGi9vK03budMjBegMd',
  STRIPE_PRICE_A_ACTIVE_B6_S:      'price_1TYwdNHGi9vK03buraD2WaTA',
  STRIPE_PRICE_A_ACTIVE_B6_A:      'price_1TYwdNHGi9vK03butMjkPOIf',
  STRIPE_PRICE_A_ACTIVE_B11_M:     'price_1TYwdOHGi9vK03bufsf3t8Q6',
  STRIPE_PRICE_A_ACTIVE_B11_Q:     'price_1TYwdOHGi9vK03bu63Ls1rHE',
  STRIPE_PRICE_A_ACTIVE_B11_S:     'price_1TYwdPHGi9vK03burZUuExa7',
  STRIPE_PRICE_A_ACTIVE_B11_A:     'price_1TYwdPHGi9vK03bupthPJbXa',
  STRIPE_PRICE_A_ACTIVE_B26_M:     'price_1TYwdQHGi9vK03buga1bpVWm',
  STRIPE_PRICE_A_ACTIVE_B26_Q:     'price_1TYwdQHGi9vK03buozGvvENF',
  STRIPE_PRICE_A_ACTIVE_B26_S:     'price_1TYwdQHGi9vK03bulCeIxuS6',
  STRIPE_PRICE_A_ACTIVE_B26_A:     'price_1TYwdRHGi9vK03buiX3ohhmz',
  STRIPE_PRICE_A_ACTIVE_B51_M:     'price_1TYwdRHGi9vK03buQT2BpOFM',
  STRIPE_PRICE_A_ACTIVE_B51_Q:     'price_1TYwdSHGi9vK03buZMkXw7jA',
  STRIPE_PRICE_A_ACTIVE_B51_S:     'price_1TYwdSHGi9vK03buyVSHo8ce',
  STRIPE_PRICE_A_ACTIVE_B51_A:     'price_1TYwdTHGi9vK03bumDYchAkJ',
  STRIPE_PRICE_A_CAMPAIGN_B1_M:    'price_1TYwdUHGi9vK03bufcco6IOZ',
  STRIPE_PRICE_A_CAMPAIGN_B1_Q:    'price_1TYwdUHGi9vK03buiBdKTZRL',
  STRIPE_PRICE_A_CAMPAIGN_B1_S:    'price_1TYwdVHGi9vK03buhiuRM97S',
  STRIPE_PRICE_A_CAMPAIGN_B1_A:    'price_1TYwdVHGi9vK03buBWlSaWhE',
  STRIPE_PRICE_A_CAMPAIGN_B2_5_M:  'price_1TYwdWHGi9vK03buaUCRPjF4',
  STRIPE_PRICE_A_CAMPAIGN_B2_5_Q:  'price_1TYwdWHGi9vK03buyxF5Awv3',
  STRIPE_PRICE_A_CAMPAIGN_B2_5_S:  'price_1TYwdXHGi9vK03bur6PRA7he',
  STRIPE_PRICE_A_CAMPAIGN_B2_5_A:  'price_1TYwdXHGi9vK03bu8PFurFE4',
  STRIPE_PRICE_A_CAMPAIGN_B6_M:    'price_1TYwdYHGi9vK03buG7YH7Drk',
  STRIPE_PRICE_A_CAMPAIGN_B6_Q:    'price_1TYwdYHGi9vK03buOZwzmCe5',
  STRIPE_PRICE_A_CAMPAIGN_B6_S:    'price_1TYwdZHGi9vK03buKX2sSfVe',
  STRIPE_PRICE_A_CAMPAIGN_B6_A:    'price_1TYwdZHGi9vK03buIdCYNFdO',
  STRIPE_PRICE_A_CAMPAIGN_B11_M:   'price_1TYwdaHGi9vK03bumCai8vVH',
  STRIPE_PRICE_A_CAMPAIGN_B11_Q:   'price_1TYwdaHGi9vK03buFuv9xbro',
  STRIPE_PRICE_A_CAMPAIGN_B11_S:   'price_1TYwdbHGi9vK03buQnnS817B',
  STRIPE_PRICE_A_CAMPAIGN_B11_A:   'price_1TYwdbHGi9vK03buAE5pgTDR',
  STRIPE_PRICE_A_CAMPAIGN_B26_M:   'price_1TYwdcHGi9vK03buqVFOlkjU',
  STRIPE_PRICE_A_CAMPAIGN_B26_Q:   'price_1TYwdcHGi9vK03bu8ypowZ9f',
  STRIPE_PRICE_A_CAMPAIGN_B26_S:   'price_1TYwddHGi9vK03buVovx1eEk',
  STRIPE_PRICE_A_CAMPAIGN_B26_A:   'price_1TYwddHGi9vK03buMY4r96Fd',
  STRIPE_PRICE_A_CAMPAIGN_B51_M:   'price_1TYwdeHGi9vK03buFzqv18cg',
  STRIPE_PRICE_A_CAMPAIGN_B51_Q:   'price_1TYwdeHGi9vK03budqD8zLlm',
  STRIPE_PRICE_A_CAMPAIGN_B51_S:   'price_1TYwdfHGi9vK03buDPg1PQVM',
  STRIPE_PRICE_A_CAMPAIGN_B51_A:   'price_1TYwdfHGi9vK03bukudhHfG4',
}

function sanitize(str, maxLen = 200) {
  if (str == null) return ''
  return String(str).replace(/[<>"'`]/g, '').slice(0, maxLen)
}

function getPriceKey(plan, bracket, billing) {
  const b = BILLING_SUFFIX[billing] || 'M'
  const planUpper = plan.toUpperCase()
  if (CANDIDATE_PLANS.includes(plan)) return `STRIPE_PRICE_${planUpper}_${b}`
  const bracketUpper = (bracket || '').toUpperCase()
  return `STRIPE_PRICE_${planUpper}_${bracketUpper}_${b}`
}

function planType(plan) {
  if (ACTION_PLANS.includes(plan) || LEGACY_PLANS.includes(plan)) return 'action'
  return 'candidate'
}

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) }
  }

  // Auth guard
  const authHeader = event.headers?.authorization || event.headers?.Authorization
  if (!authHeader?.startsWith('Bearer ')) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Not authenticated' }) }
  }
  const authRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON, Authorization: authHeader },
  })
  if (!authRes.ok) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Invalid or expired token' }) }
  }
  // Capture server-verified caller identity — never trust client-supplied userId/email
  const caller = await authRes.json()
  const callerId    = caller?.id
  const callerEmail = caller?.email?.toLowerCase()
  if (!callerId || !callerEmail) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Could not resolve caller identity' }) }
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)

  let body
  try { body = JSON.parse(event.body || '{}') } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }
  }

  const plan    = sanitize(body.plan)
  const bracket = sanitize(body.bracket)
  const billing = sanitize(body.billing) || 'monthly'
  const userId  = sanitize(body.userId)

  // Ownership check — only allow a user to modify their own subscription
  if (userId && userId !== callerId) {
    return { statusCode: 403, body: JSON.stringify({ error: 'You can only update your own subscription' }) }
  }

  if (!VALID_PLANS.includes(plan)) {
    return { statusCode: 400, body: JSON.stringify({ error: `Invalid plan "${plan}"` }) }
  }
  if (!VALID_BILLING.includes(billing)) {
    return { statusCode: 400, body: JSON.stringify({ error: `Invalid billing "${billing}"` }) }
  }
  const needsBracket = ACTION_PLANS.includes(plan) || LEGACY_PLANS.includes(plan)
  if (needsBracket && (!bracket || !VALID_BRACKETS.includes(bracket))) {
    return { statusCode: 400, body: JSON.stringify({ error: `bracket required for ${plan}` }) }
  }

  const priceKey = getPriceKey(plan, bracket || null, billing)
  const priceId  = STRIPE_PRICES[priceKey] || process.env[priceKey]
  if (!priceId) {
    return { statusCode: 500, body: JSON.stringify({ error: `Price not configured: ${priceKey}` }) }
  }

  try {
    // Find the customer by the server-verified email (never body.email)
    const customers = await stripe.customers.list({ email: callerEmail, limit: 1 })
    const customer  = customers.data[0]
    if (!customer) {
      return { statusCode: 404, body: JSON.stringify({ error: 'No Stripe customer found for this account. Please subscribe first.' }) }
    }

    // Find active subscription
    const subs = await stripe.subscriptions.list({ customer: customer.id, status: 'active', limit: 1 })
    const sub  = subs.data[0]
    if (!sub) {
      return { statusCode: 404, body: JSON.stringify({ error: 'No active subscription found. Please subscribe first.' }) }
    }

    // Update the subscription item to the new price (with immediate proration)
    const item = sub.items.data[0]
    await stripe.subscriptions.update(sub.id, {
      items: [{ id: item.id, price: priceId }],
      proration_behavior: 'create_prorations',
      metadata: {
        plan,
        plan_type: planType(plan),
        ...(bracket ? { bracket } : {}),
        billing,
        supabase_user_id: userId,
      },
    })

    console.log(`Subscription updated: ${plan}${bracket ? '/' + bracket : ''}/${billing} for user ${callerId} (${callerEmail})`)

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, message: `Plan updated to ${plan}` }),
    }
  } catch (err) {
    console.error('Subscription update error:', err.message)
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) }
  }
}
