// netlify/functions/stripe-webhook.js
// Handles Stripe webhook events and syncs plan + bracket to Supabase app_metadata.
//
// Required env vars:
//   STRIPE_SECRET_KEY         — Stripe secret key
//   STRIPE_WEBHOOK_SECRET     — Webhook signing secret (whsec_...)
//   SUPABASE_URL              — Your Supabase project URL
//   SUPABASE_SERVICE_ROLE_KEY — Service role key (admin access)
//
// Price-ID → {plan, bracket} reverse map is built at runtime from all
// STRIPE_PRICE_{PLAN}_{BRACKET}_{M|A} env vars.

const Stripe = require('stripe')

// Accounts permanently pinned to agency plan — Stripe events cannot downgrade these.
const { ADMIN_EMAILS } = require('./_config')

// ─── Webhook idempotency ─────────────────────────────────────────────────────
// Stripe retries deliveries; without dedupe a retried checkout.session.completed
// re-granted credits (read-modify-write on app_metadata). Insert the event ID
// first — a unique-key conflict means it was already processed. If the table
// doesn't exist yet (migration pending), fail open with a warning so payments
// still process.
async function alreadyProcessed(eventId, eventType) {
  try {
    const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/stripe_webhook_events`, {
      method: 'POST',
      headers: {
        apikey:         process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization:  `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        Prefer:         'return=minimal',
      },
      body: JSON.stringify({ id: eventId, type: eventType }),
    })
    if (res.status === 409) return true
    if (!res.ok) console.warn('[stripe-webhook] idempotency insert failed:', res.status)
    return false
  } catch (e) {
    console.warn('[stripe-webhook] idempotency check failed:', e.message)
    return false
  }
}
const { sendEmail, getNotificationPrefs } = require('./_email')

// New plan keys
const CANDIDATE_PLANS = ['c_monitor', 'c_active', 'c_campaign']
const ACTION_PLANS    = ['a_monitor', 'a_active', 'a_campaign']
const LEGACY_PLANS    = ['monitor', 'campaign', 'agency']
const VALID_PLANS     = [...CANDIDATE_PLANS, ...ACTION_PLANS, ...LEGACY_PLANS]
const VALID_BRACKETS  = ['b1', 'b2_5', 'b6', 'b11', 'b26', 'b51']
const VALID_BILLING   = ['monthly', 'quarterly', 'semiannual', 'annual']

// Baked-in price IDs — keep in sync with create-checkout-session.js
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
  STRIPE_PRICE_CREDITS_C1:            'price_1TYxFrHGi9vK03bu47MUgMJl',
  STRIPE_PRICE_CREDITS_C5:            'price_1TYxFrHGi9vK03buICPaQ9l6',
  STRIPE_PRICE_CREDITS_C10:           'price_1TYxFrHGi9vK03buUr1PcHtF',
  STRIPE_PRICE_CREDITS_C25:           'price_1TYxFsHGi9vK03bu2jnPnGPP',
  STRIPE_PRICE_BULK_CREDITS_BULK25:   'price_1TYxFtHGi9vK03buVUHpNoXC',
  STRIPE_PRICE_BULK_CREDITS_BULK50:   'price_1TYxFtHGi9vK03buga4Mpsh4',
  STRIPE_PRICE_BULK_CREDITS_BULK100:  'price_1TYxFuHGi9vK03bucTgzM6Ju',
  STRIPE_PRICE_BULK_CREDITS_BULK250:  'price_1TYxFuHGi9vK03bu9i7e0TJ1',
}

// Human-readable plan label for emails
const PLAN_LABEL = {
  c_monitor:  'Monitor',
  c_active:   'Active',
  c_campaign: 'Campaign',
  a_monitor:  'Action Monitor',
  a_active:   'Action Active',
  a_campaign: 'Action Campaign',
  monitor:    'Monitor',
  campaign:   'Campaign',
  agency:     'Agency',
  scout:      'Scout',
}
function formatPlanLabel(plan) {
  return PLAN_LABEL[plan] || (plan.charAt(0).toUpperCase() + plan.slice(1))
}

// Derive plan_type from plan key
function planType(plan) {
  if (ACTION_PLANS.includes(plan) || LEGACY_PLANS.includes(plan)) return 'action'
  return 'candidate'
}

// Build a reverse map: Stripe price ID → { plan, plan_type, bracket, billing }
// Scans all STRIPE_PRICE_* env vars at startup.
function buildPriceMap() {
  const map = {}
  const billingKeys = [['M', 'monthly'], ['Q', 'quarterly'], ['A', 'annual'], ['S', 'semiannual']]

  // Candidate plans (no bracket): STRIPE_PRICE_C_MONITOR_M, etc.
  for (const plan of CANDIDATE_PLANS) {
    for (const [billingKey, billing] of billingKeys) {
      const envKey  = `STRIPE_PRICE_${plan.toUpperCase()}_${billingKey}`
      const priceId = STRIPE_PRICES[envKey]
      if (priceId) {
        map[priceId] = { plan, plan_type: 'candidate', bracket: null, billing }
      }
    }
  }

  // Action plans (with bracket): STRIPE_PRICE_A_MONITOR_B1_M, etc.
  for (const plan of ACTION_PLANS) {
    for (const bracket of VALID_BRACKETS) {
      for (const [billingKey, billing] of billingKeys) {
        const envKey  = `STRIPE_PRICE_${plan.toUpperCase()}_${bracket.toUpperCase()}_${billingKey}`
        const priceId = STRIPE_PRICES[envKey]
        if (priceId) {
          map[priceId] = { plan, plan_type: 'action', bracket, billing }
        }
      }
    }
  }

  // Legacy plans (old naming): STRIPE_PRICE_MONITOR_B6_M, etc.
  for (const plan of LEGACY_PLANS) {
    for (const bracket of VALID_BRACKETS) {
      for (const [billingKey, billing] of billingKeys) {
        const envKey  = `STRIPE_PRICE_${plan.toUpperCase()}_${bracket.toUpperCase()}_${billingKey}`
        const priceId = STRIPE_PRICES[envKey]
        if (priceId) {
          map[priceId] = { plan, plan_type: 'action', bracket, billing }
        }
      }
    }
  }

  return map
}

// ── Supabase helpers ──────────────────────────────────────────────────────────

async function getSupabaseUser(supabaseUserId) {
  const res = await fetch(
    `${process.env.SUPABASE_URL}/auth/v1/admin/users/${supabaseUserId}`,
    {
      headers: {
        apikey:        process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
    }
  )
  if (!res.ok) return null
  return res.json()
}

async function isAdminUser(supabaseUserId) {
  try {
    const user = await getSupabaseUser(supabaseUserId)
    return ADMIN_EMAILS.includes(user?.email?.toLowerCase())
  } catch {
    return false
  }
}

// Writes plan + plan_type + bracket (and optionally billing) to app_metadata.
// Merges with existing metadata — does NOT clobber other fields.
// extraFields: optional object merged in last (e.g. payment_status, downgraded_at)
async function updateSupabasePlan(supabaseUserId, plan, bracket, billing, stripeIds, extraFields = {}) {
  // GET existing user metadata first to avoid clobbering unrelated fields
  const existingUser = await getSupabaseUser(supabaseUserId)
  const existingMeta = existingUser?.app_metadata ?? {}

  const newFields = { plan, plan_type: planType(plan) }
  if (bracket) newFields.bracket = bracket
  else delete existingMeta.bracket  // clear bracket when moving to candidate plan
  if (billing) newFields.billing = billing

  const metadata = { ...existingMeta, ...newFields, ...extraFields }
  if (stripeIds?.stripe_customer_id) metadata.stripe_customer_id = stripeIds.stripe_customer_id
  if (stripeIds?.stripe_subscription_id) metadata.stripe_subscription_id = stripeIds.stripe_subscription_id
  // Allow extraFields to explicitly nullify stripe IDs (e.g. on subscription deletion)
  if (Object.prototype.hasOwnProperty.call(extraFields, 'stripe_subscription_id')) {
    metadata.stripe_subscription_id = extraFields.stripe_subscription_id
  }

  // Entitlements live in app_metadata (service-role-writable only) so users
  // cannot self-grant a plan via supabase.auth.updateUser.
  const res = await fetch(
    `${process.env.SUPABASE_URL}/auth/v1/admin/users/${supabaseUserId}`,
    {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        apikey:         process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization:  `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({ app_metadata: metadata }),
    }
  )
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Supabase update failed (${res.status}): ${text}`)
  }
  return res.json()
}

// Updates payment_status in app_metadata (e.g. 'active', 'past_due')
async function updateSupabasePaymentStatus(supabaseUserId, paymentStatus) {
  // GET existing user metadata first to avoid clobbering unrelated fields
  const existingUser = await getSupabaseUser(supabaseUserId)
  const existingMeta = existingUser?.app_metadata ?? {}

  const metadata = { ...existingMeta, payment_status: paymentStatus }

  const res = await fetch(
    `${process.env.SUPABASE_URL}/auth/v1/admin/users/${supabaseUserId}`,
    {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        apikey:         process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization:  `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({ app_metadata: metadata }),
    }
  )
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Supabase payment_status update failed (${res.status}): ${text}`)
  }
  return res.json()
}

async function findSupabaseUserByEmail(email) {
  const res = await fetch(
    `${process.env.SUPABASE_URL}/auth/v1/admin/users?email=${encodeURIComponent(email)}`,
    {
      headers: {
        apikey:        process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
    }
  )
  const json = await res.json()
  return json?.users?.[0] || null
}

// ── Credit helpers ────────────────────────────────────────────────────────────

function getCreditsForPack(product, pack) {
  const creditMap = { c1: 1, c5: 5, c10: 10, c25: 25 }
  const bulkMap   = { bulk25: 25, bulk50: 50, bulk100: 100, bulk250: 250 }
  if (product === 'credits') return creditMap[pack] || 0
  if (product === 'bulk_credits') return bulkMap[pack] || 0
  return 0
}

// Bank a raw number of profile credits (used by dossier credit packs, which
// carry their quantity directly rather than a pack key).
async function addProfileCredits(userId, qty) {
  const existingUser = await getSupabaseUser(userId)
  const existingMeta = existingUser?.app_metadata ?? {}
  const metadata = { ...existingMeta, profile_credits: (existingMeta.profile_credits || 0) + qty }
  const res = await fetch(
    `${process.env.SUPABASE_URL}/auth/v1/admin/users/${userId}`,
    {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        apikey:         process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization:  `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({ app_metadata: metadata }),
    }
  )
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Supabase profile-credits update failed (${res.status}): ${text}`)
  }
  return res.json()
}

async function addCreditsToUser(userId, product, pack) {
  const existingUser = await getSupabaseUser(userId)
  const existingMeta = existingUser?.app_metadata ?? {}
  const amount = getCreditsForPack(product, pack)
  if (amount === 0) return

  const metadata = { ...existingMeta }
  if (product === 'credits') {
    metadata.profile_credits = (existingMeta.profile_credits || 0) + amount
  } else if (product === 'bulk_credits') {
    metadata.bulk_credits = (existingMeta.bulk_credits || 0) + amount
  }

  const res = await fetch(
    `${process.env.SUPABASE_URL}/auth/v1/admin/users/${userId}`,
    {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        apikey:         process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization:  `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({ app_metadata: metadata }),
    }
  )
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Supabase credits update failed (${res.status}): ${text}`)
  }
  return res.json()
}

// ── Handler ───────────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' }
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)
  const sig    = event.headers['stripe-signature']

  let stripeEvent
  try {
    stripeEvent = stripe.webhooks.constructEvent(
      event.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    )
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message)
    return { statusCode: 400, body: `Webhook Error: ${err.message}` }
  }

  const priceMap = buildPriceMap()

  // Dedupe retried deliveries BEFORE any credit/plan mutation
  if (await alreadyProcessed(stripeEvent.id, stripeEvent.type)) {
    console.log(`[stripe-webhook] duplicate delivery skipped: ${stripeEvent.id}`)
    return { statusCode: 200, body: JSON.stringify({ received: true, duplicate: true }) }
  }

  try {
    switch (stripeEvent.type) {

      // ── New subscription or upgrade checkout completed ────────────────────
      case 'checkout.session.completed': {
        const session        = stripeEvent.data.object
        const supabaseUserId = session.metadata?.supabase_user_id || session.client_reference_id

        // Handle one-time payment (credit packs)
        if (session.mode === 'payment') {
          const product = session.metadata?.product
          const pack    = session.metadata?.pack
          const uid     = session.metadata?.supabase_user_id

          // Dossier credit packs (buy-dossier-credits.js) carry the quantity
          // directly in metadata.dossier_credits and bank into profile_credits.
          if (session.metadata?.type === 'dossier_credits') {
            const qty = parseInt(session.metadata?.dossier_credits, 10)
            if (uid && Number.isFinite(qty) && qty > 0) {
              await addProfileCredits(uid, qty)
              console.log(`Dossier credits added: ${qty} for user ${uid}`)
            } else {
              console.warn('dossier_credits payment missing uid/qty in metadata')
            }
            break
          }

          if (uid && product && pack) {
            await addCreditsToUser(uid, product, pack)
            console.log(`Credits added: ${product} pack ${pack} for user ${uid}`)
          } else {
            console.warn('credit payment missing uid/product/pack in metadata')
          }
          break
        }

        // Skip non-subscription events
        if (session.mode !== 'subscription') break

        const { plan, bracket, billing } = session.metadata ?? {}

        if (!plan || !supabaseUserId) {
          console.warn('checkout.session.completed: missing plan or user ID in metadata')
          break
        }

        if (await isAdminUser(supabaseUserId)) {
          console.log(`Admin account ${supabaseUserId} — pinning to a_campaign/b6`)
          await updateSupabasePlan(supabaseUserId, 'a_campaign', 'b6', 'monthly')
          break
        }

        console.log(`Activating ${plan}/${bracket}/${billing} for user ${supabaseUserId}`)
        await updateSupabasePlan(supabaseUserId, plan, bracket, billing, {
          stripe_customer_id: session.customer,
          stripe_subscription_id: session.subscription,
        }, {
          // Clear downgrade lock if user is re-subscribing
          payment_status: 'active',
          downgraded_at:  null,
        })

        // Send plan activated email
        try {
          const user = await getSupabaseUser(supabaseUserId)
          const prefs = await getNotificationPrefs(supabaseUserId)
          if (user?.email && prefs.payment_receipt) {
            const planLabel = formatPlanLabel(plan)
            await sendEmail({
              to: user.email,
              subject: `You're on the ${planLabel} plan — welcome!`,
              title: `${planLabel} plan activated`,
              preheader: `Your Badger Board ${planLabel} plan is now active.`,
              body: `<p>Your <strong>${planLabel}</strong> plan is now active and everything is ready to go.</p><p>Head back to Badger Board to continue building your campaign strategy.</p>`,
              ctaText: 'Open Badger Board',
              ctaUrl: 'https://www.badgerboardwi.com',
            })
          }
        } catch (e) { console.error('[email] checkout activated email failed:', e.message) }
        break
      }

      // ── Subscription changed (plan/bracket upgrade, downgrade, renewal) ───
      case 'customer.subscription.updated': {
        const sub            = stripeEvent.data.object
        const supabaseUserId = sub.metadata?.supabase_user_id
        const priceId        = sub.items?.data?.[0]?.price?.id

        if (!supabaseUserId) {
          console.warn('customer.subscription.updated: no supabase_user_id in metadata')
          break
        }

        if (await isAdminUser(supabaseUserId)) {
          console.log(`Admin account ${supabaseUserId} — enforcing a_campaign/b6`)
          await updateSupabasePlan(supabaseUserId, 'a_campaign', 'b6', 'monthly')
          break
        }

        // Try metadata first (most reliable), fall back to price-ID reverse lookup
        const metaPlan    = sub.metadata?.plan
        const metaBracket = sub.metadata?.bracket
        const metaBilling = sub.metadata?.billing
        const mapped      = priceId ? priceMap[priceId] : null

        const plan    = metaPlan    || mapped?.plan
        const bracket = metaBracket || mapped?.bracket
        const billing = metaBilling || mapped?.billing

        if (plan) {
          console.log(`Updating to ${plan}/${bracket}/${billing} for user ${supabaseUserId}`)
          await updateSupabasePlan(supabaseUserId, plan, bracket, billing, {
            stripe_customer_id: sub.customer,
            stripe_subscription_id: sub.id,
          }, {
            // Clear any downgrade lock when the subscription becomes active again
            payment_status: 'active',
            downgraded_at:  null,
          })

          // Send plan updated email
          try {
            const user = await getSupabaseUser(supabaseUserId)
            const prefs = await getNotificationPrefs(supabaseUserId)
            if (user?.email && prefs.plan_changed) {
              const planLabel = formatPlanLabel(plan)
              await sendEmail({
                to: user.email,
                subject: 'Your Badger Board plan has been updated',
                title: 'Plan updated',
                body: `<p>Your account has been updated to the <strong>${planLabel}</strong> plan. The change is effective immediately.</p>`,
                ctaText: 'View your plan',
                ctaUrl: 'https://www.badgerboardwi.com/settings#billing',
              })
            }
          } catch (e) { console.error('[email] subscription updated email failed:', e.message) }
        } else {
          console.warn(`customer.subscription.updated: could not resolve plan for price ${priceId}`)
        }
        break
      }

      // ── Subscription cancelled / expired → downgrade to Scout (free) ─────
      case 'customer.subscription.deleted': {
        const sub            = stripeEvent.data.object
        const supabaseUserId = sub.metadata?.supabase_user_id

        if (!supabaseUserId) {
          console.warn('customer.subscription.deleted: no supabase_user_id in metadata')
          break
        }

        if (await isAdminUser(supabaseUserId)) {
          console.log(`Admin account ${supabaseUserId} — refusing downgrade, keeping agency`)
          break
        }

        console.log(`Subscription cancelled — downgrading to scout for user ${supabaseUserId}`)
        await updateSupabasePlan(supabaseUserId, 'scout', null, null, null, {
          payment_status:        'inactive',
          downgraded_at:         Date.now(),
          stripe_subscription_id: null,
        })

        // Send cancellation email
        try {
          const user = await getSupabaseUser(supabaseUserId)
          const prefs = await getNotificationPrefs(supabaseUserId)
          if (user?.email && prefs.plan_changed) {
            await sendEmail({
              to: user.email,
              subject: 'Your Badger Board subscription has ended',
              title: 'Subscription cancelled',
              body: `<p>Your subscription has been cancelled and your account has moved to the free Scout plan.</p><p>You can resubscribe anytime to restore full access to all features.</p>`,
              ctaText: 'View plans',
              ctaUrl: 'https://www.badgerboardwi.com/plans',
            })
          }
        } catch (e) { console.error('[email] cancellation email failed:', e.message) }
        break
      }

      // ── Invoice payment failed — mark account past_due ───────────────────
      case 'invoice.payment_failed': {
        const invoice        = stripeEvent.data.object
        const supabaseUserId = invoice.subscription_details?.metadata?.supabase_user_id
                            || invoice.metadata?.supabase_user_id

        console.warn(`Payment failed for customer ${invoice.customer}, attempt ${invoice.attempt_count}`)

        if (supabaseUserId) {
          // Skip admin accounts
          if (!(await isAdminUser(supabaseUserId))) {
            const attemptCount = invoice.attempt_count || 1
            if (attemptCount >= 2) {
              // Subsequent failure — mark past_due and send lockout email
              try {
                await updateSupabasePaymentStatus(supabaseUserId, 'past_due')
                console.log(`Marked user ${supabaseUserId} as past_due after ${attemptCount} failed attempts`)
              } catch (err) {
                console.error(`Failed to mark past_due for ${supabaseUserId}:`, err.message)
              }
              try {
                const user = await getSupabaseUser(supabaseUserId)
                const prefs = await getNotificationPrefs(supabaseUserId)
                if (user?.email && prefs.account_locked) {
                  await sendEmail({
                    to: user.email,
                    subject: 'Your Badger Board account has been locked',
                    title: 'Account access suspended',
                    preheader: 'Update your payment method to restore access.',
                    body: `<p>After multiple failed payment attempts, access to your Badger Board account has been suspended.</p><p>Update your payment method to immediately restore full access.</p>`,
                    ctaText: 'Restore access',
                    ctaUrl: 'https://www.badgerboardwi.com/settings#billing',
                  })
                }
              } catch (e) { console.error('[email] account_locked email:', e.message) }
            } else {
              // First failure — warn the user
              console.log(`First payment failure for user ${supabaseUserId} — waiting for retry before marking past_due`)
              try {
                const user = await getSupabaseUser(supabaseUserId)
                const prefs = await getNotificationPrefs(supabaseUserId)
                if (user?.email && prefs.payment_failed) {
                  await sendEmail({
                    to: user.email,
                    subject: 'Action required: payment failed for Badger Board',
                    title: 'Payment failed',
                    preheader: 'Please update your payment method to avoid losing access.',
                    body: `<p>We were unable to process your payment. Please update your payment method to avoid any interruption to your Badger Board service.</p>`,
                    ctaText: 'Update payment method',
                    ctaUrl: 'https://www.badgerboardwi.com/settings#billing',
                  })
                }
              } catch (e) { console.error('[email] payment_failed warning email:', e.message) }
            }
          }
        } else {
          // Try to find user by customer email as fallback
          const customerEmail = invoice.customer_email
          if (customerEmail) {
            const user = await findSupabaseUserByEmail(customerEmail)
            if (user && !ADMIN_EMAILS.includes(user.email?.toLowerCase())) {
              const attemptCount = invoice.attempt_count || 1
              if (attemptCount >= 2) {
                try {
                  await updateSupabasePaymentStatus(user.id, 'past_due')
                  console.log(`Marked user ${user.id} (${customerEmail}) as past_due`)
                } catch (err) {
                  console.error(`Failed to mark past_due for ${customerEmail}:`, err.message)
                }
                try {
                  const prefs = await getNotificationPrefs(user.id)
                  if (prefs.account_locked) {
                    await sendEmail({
                      to: customerEmail,
                      subject: 'Your Badger Board account has been locked',
                      title: 'Account access suspended',
                      body: `<p>After multiple failed payment attempts, access to your Badger Board account has been suspended.</p><p>Update your payment method to immediately restore full access.</p>`,
                      ctaText: 'Restore access',
                      ctaUrl: 'https://www.badgerboardwi.com/settings#billing',
                    })
                  }
                } catch (e) { console.error('[email] account_locked fallback email:', e.message) }
              } else {
                try {
                  const prefs = await getNotificationPrefs(user.id)
                  if (prefs.payment_failed) {
                    await sendEmail({
                      to: customerEmail,
                      subject: 'Action required: payment failed for Badger Board',
                      title: 'Payment failed',
                      body: `<p>We were unable to process your payment. Please update your payment method to avoid any interruption to your service.</p>`,
                      ctaText: 'Update payment method',
                      ctaUrl: 'https://www.badgerboardwi.com/settings#billing',
                    })
                  }
                } catch (e) { console.error('[email] payment_failed fallback email:', e.message) }
              }
            }
          }
        }
        break
      }

      // ── Invoice payment succeeded — clear any past_due flag ──────────────
      case 'invoice.payment_succeeded': {
        const invoice        = stripeEvent.data.object
        const supabaseUserId = invoice.subscription_details?.metadata?.supabase_user_id
                            || invoice.metadata?.supabase_user_id

        if (supabaseUserId && !(await isAdminUser(supabaseUserId))) {
          try {
            await updateSupabasePaymentStatus(supabaseUserId, 'active')
            console.log(`Payment succeeded — cleared past_due for user ${supabaseUserId}`)
          } catch (err) {
            console.error(`Failed to clear past_due for ${supabaseUserId}:`, err.message)
          }
          // Send payment receipt email
          try {
            const emailTo = invoice.customer_email || (await getSupabaseUser(supabaseUserId))?.email
            const prefs = await getNotificationPrefs(supabaseUserId)
            if (emailTo && prefs.payment_receipt && invoice.amount_paid > 0) {
              const amount = `$${(invoice.amount_paid / 100).toFixed(2)}`
              await sendEmail({
                to: emailTo,
                subject: 'Payment confirmed — Badger Board',
                title: 'Payment confirmed',
                body: `<p>Your payment of <strong>${amount}</strong> has been processed successfully. Thank you!</p>`,
                footerNote: 'This is your payment confirmation. Keep this email for your records.',
              })
            }
          } catch (e) { console.error('[email] payment receipt email:', e.message) }
        }
        break
      }

      default:
        break
    }

    return { statusCode: 200, body: JSON.stringify({ received: true }) }
  } catch (err) {
    console.error('Webhook handler error:', err.message)
    return { statusCode: 500, body: JSON.stringify({ error: 'An internal error occurred' }) }
  }
}
