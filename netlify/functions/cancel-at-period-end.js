// netlify/functions/cancel-at-period-end.js
// Schedules a subscription to cancel at the end of the current billing period.
// The user keeps full access until the period ends, then the subscription.deleted
// webhook resets them to Scout.
//
// POST body: { userId, email }
// Returns: { success: true, periodEnd: <unix timestamp> } or { error: string }

import Stripe from 'stripe'

const SUPABASE_URL  = process.env.SUPABASE_URL  || process.env.VITE_SUPABASE_URL
const SUPABASE_ANON = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY

// Audit fix: resolve the Stripe customer from the stored
// app_metadata.stripe_customer_id first (same order as delete-account.js /
// admin-billing.js resolveCustomerIds), then the verified email. After a
// support email change the Stripe customer keeps the OLD email, so the
// email-only lookup 404'd billing management. caller is the /auth/v1/user
// record — app_metadata is service-role-writable only, so it's trusted.
async function resolveCustomerIds(stripe, caller, callerEmail) {
  const ids = []
  const storedId = caller?.app_metadata?.stripe_customer_id
  if (storedId) {
    try {
      const c = await stripe.customers.retrieve(storedId)
      if (c && !c.deleted) ids.push(c.id)
    } catch { /* stale/foreign id — fall back to email */ }
  }
  const customers = await stripe.customers.list({ email: callerEmail, limit: 5 })
  for (const c of customers.data) if (!ids.includes(c.id)) ids.push(c.id)
  return ids
}

function sanitize(str, maxLen = 200) {
  if (str == null) return ''
  return String(str).replace(/[<>"'`]/g, '').slice(0, maxLen)
}

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) }
  }

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
  // Use server-verified identity — never trust client-supplied userId or email
  const caller = await authRes.json()
  const callerId    = caller?.id
  const callerEmail = caller?.email?.toLowerCase()
  if (!callerId || !callerEmail) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Could not resolve caller identity' }) }
  }

  // Build the Stripe client inside the handler behind an explicit key check
  // (same pattern as admin-billing.js) — a missing key is a deployment problem
  // and should surface as a 503, not an opaque 500 from the first API call.
  const stripeKey = process.env.STRIPE_SECRET_KEY
  if (!stripeKey) {
    return { statusCode: 503, body: JSON.stringify({ error: 'Stripe is not configured (STRIPE_SECRET_KEY missing)' }) }
  }
  const stripe = new Stripe(stripeKey)

  let body
  try { body = JSON.parse(event.body || '{}') } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }
  }

  const userId = sanitize(body.userId)

  // Ownership check — only allow a user to cancel their own subscription
  if (userId && userId !== callerId) {
    return { statusCode: 403, body: JSON.stringify({ error: 'You can only cancel your own subscription' }) }
  }

  // Stored customer id first, then the server-verified email (never body.email)
  try {
    const customerIds = await resolveCustomerIds(stripe, caller, callerEmail)
    if (!customerIds.length) {
      return { statusCode: 404, body: JSON.stringify({ error: 'No Stripe customer found.' }) }
    }

    let sub = null
    for (const customerId of customerIds) {
      const subs = await stripe.subscriptions.list({ customer: customerId, status: 'active', limit: 1 })
      if ((sub = subs.data[0])) break
    }
    if (!sub) {
      return { statusCode: 404, body: JSON.stringify({ error: 'No active subscription found.' }) }
    }

    // Schedule cancellation at period end — do NOT touch Supabase yet.
    // When the subscription actually expires, the customer.subscription.deleted
    // webhook will fire and reset the user to Scout.
    const updated = await stripe.subscriptions.update(sub.id, {
      cancel_at_period_end: true,
    })

    console.log(`Subscription scheduled for cancellation at period end: user ${callerId} (${callerEmail}), ends ${updated.current_period_end}`)

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        periodEnd: (updated.current_period_end ?? updated.items?.data?.[0]?.current_period_end), // Unix timestamp
        message: `Your plan will remain active until ${new Date((updated.current_period_end ?? updated.items?.data?.[0]?.current_period_end) * 1000).toLocaleDateString()}, then access will be removed.`,
      }),
    }
  } catch (err) {
    console.error('cancel-at-period-end error:', err.message)
    return { statusCode: 500, body: JSON.stringify({ error: 'An internal error occurred' }) }
  }
}
