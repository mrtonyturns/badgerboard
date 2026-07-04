// ─── Netlify Function: ghl-webhook ────────────────────────────────────────────
// Receives GoHighLevel (Dayframer) webhook events and updates the matching
// Supabase user's tier automatically.
//
// Required Netlify environment variables:
//   SUPABASE_URL              – your Supabase project URL
//   SUPABASE_SERVICE_ROLE_KEY – service role key (NOT the anon key)
//   GHL_WEBHOOK_SECRET        – a secret string you also set in Dayframer
//                               under Automation → Webhook → Header value
//
// ─── Setup in Dayframer (GoHighLevel) ────────────────────────────────────────
// 1. Automation → Webhooks → Add Webhook
// 2. URL: https://<your-site>.netlify.app/.netlify/functions/ghl-webhook
// 3. Add header:  x-ghl-signature  =  <your GHL_WEBHOOK_SECRET value>
// 4. Events to enable:
//      Order Submitted / Order Fulfilled
//      Subscription Created / Subscription Updated / Subscription Cancelled
//
// ─── Product → Plan mapping ───────────────────────────────────────────────────
// This maps the "Product Name" field from GHL orders to a Badger Board plan.
// Update the keys to match your exact Dayframer product names.
const crypto = require('crypto')
const PLAN_TIER_MAP = {
  'Badger Scout':     'scout',
  'Badger Monitor':   'monitor',
  'Badger Campaign':  'campaign',
  'Badger Agency':    'agency',
  // Legacy product names kept for backward compatibility
  'Badger Analyst':   'monitor',
  'Badger Operative': 'campaign',
  'Badger Director':  'agency',
}

// GHL event types that mean a subscription is now active
const ACTIVATE_EVENTS = new Set([
  'OrderSubmitted',
  'OrderFulfilled',
  'SubscriptionCreated',
  'SubscriptionUpdated',
  'PaymentReceived',
  'order_submitted',
  'order_fulfilled',
  'subscription_created',
  'subscription_updated',
  'payment_received',
])

// GHL event types that mean the subscription ended → revert to free
const CANCEL_EVENTS = new Set([
  'SubscriptionCancelled',
  'SubscriptionExpired',
  'subscription_cancelled',
  'subscription_expired',
])

// ─── Supabase Admin client (lazy-initialised) ─────────────────────────────────
let _supabase = null
function getSupabaseAdmin() {
  if (_supabase) return _supabase
  // Dynamic require so the function only loads @supabase/supabase-js when needed
  const { createClient } = require('@supabase/supabase-js')
  _supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  )
  return _supabase
}

// ─── Helper: resolve product name → tier ──────────────────────────────────────
function resolveTier(productName = '') {
  // Exact match first
  if (PLAN_TIER_MAP[productName]) return PLAN_TIER_MAP[productName]
  // Fuzzy fallback (order matters – check higher plans first)
  const lower = productName.toLowerCase()
  if (lower.includes('agency')    || lower.includes('director')  || lower.includes('tier3')) return 'agency'
  if (lower.includes('campaign')  || lower.includes('operative') || lower.includes('tier2')) return 'campaign'
  if (lower.includes('monitor')   || lower.includes('analyst')   || lower.includes('tier1')) return 'monitor'
  if (lower.includes('scout')     || lower.includes('free')      || lower.includes('tier0')) return 'scout'
  return null
}

// ─── Helper: extract fields from various GHL payload shapes ──────────────────
function parsePayload(payload) {
  // GHL sends different shapes depending on the event type and workflow version.
  // Try the most common paths.
  const eventType =
    payload.type          ||
    payload.event         ||
    payload.event_type    ||
    (payload.data && payload.data.type) ||
    ''

  const email =
    payload.email                   ||
    payload.contact?.email          ||
    payload.data?.contact?.email    ||
    payload.data?.email             ||
    payload.contactEmail            ||
    ''

  const productName =
    payload.product?.name           ||
    payload.data?.product?.name     ||
    payload.planName                ||
    payload.data?.planName          ||
    payload.offer?.name             ||
    payload.data?.offer?.name       ||
    ''

  return { eventType, email: email.trim().toLowerCase(), productName }
}

// ─── Handler ──────────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json' }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) }
  }

  // ── Verify webhook secret (fail closed) ─────────────────────────────────────
  // This endpoint can change account plan tiers, so it must never run without a
  // configured secret. If GHL_WEBHOOK_SECRET is unset, reject every request.
  const secret = process.env.GHL_WEBHOOK_SECRET
  if (!secret) {
    console.error('[ghl-webhook] GHL_WEBHOOK_SECRET is not set — rejecting request')
    return { statusCode: 503, headers, body: JSON.stringify({ error: 'Webhook not configured' }) }
  }
  const incoming =
    event.headers['x-ghl-signature'] ||
    event.headers['x-webhook-secret']  ||
    event.headers['authorization']      ||
    ''
  const bare = incoming.replace(/^Bearer\s+/i, '')
  const a = Buffer.from(bare)
  const b = Buffer.from(secret)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) }
  }

  // ── Parse body ────────────────────────────────────────────────────────────
  let payload
  try {
    payload = JSON.parse(event.body || '{}')
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }
  }

  const { eventType, email, productName } = parsePayload(payload)

  if (!email) {
    // Log but don't error – some GHL test pings have no contact data
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, message: 'No email – skipped' }) }
  }

  // ── Determine target plan ─────────────────────────────────────────────────
  let newTier = null

  if (CANCEL_EVENTS.has(eventType)) {
    newTier = 'scout'
  } else if (ACTIVATE_EVENTS.has(eventType)) {
    newTier = resolveTier(productName)
  }

  if (!newTier) {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ok: true, message: `Event "${eventType}" with product "${productName}" – no tier change needed` }),
    }
  }

  // ── Look up user in Supabase ──────────────────────────────────────────────
  const supabase = getSupabaseAdmin()

  // listUsers is paginated; for most accounts one page is sufficient.
  // If you have >1000 users, implement pagination here.
  const { data: listData, error: listError } = await supabase.auth.admin.listUsers({ perPage: 1000 })
  if (listError) {
    console.error('[ghl-webhook] listUsers error:', listError)
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to query users' }) }
  }

  const user = listData?.users?.find(u => u.email?.toLowerCase() === email)
  if (!user) {
    // User doesn't exist in Supabase yet (possible if they haven't signed up).
    // Return 200 so GHL doesn't keep retrying; log for visibility.
    console.warn(`[ghl-webhook] No Supabase user found for email: ${email}`)
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ok: true, message: `No Supabase user found for ${email}` }),
    }
  }

  // ── Update user_metadata.plan ─────────────────────────────────────────────
  const { error: updateError } = await supabase.auth.admin.updateUserById(user.id, {
    user_metadata: {
      ...user.user_metadata,
      plan: newTier,
    },
  })

  if (updateError) {
    console.error('[ghl-webhook] updateUserById error:', updateError)
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to update user plan' }) }
  }

  console.log(`[ghl-webhook] ${email} → ${newTier} (event: ${eventType}, product: "${productName}")`)

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      ok:      true,
      email,
      plan:    newTier,
      eventType,
      productName,
      userId:  user.id,
    }),
  }
}
