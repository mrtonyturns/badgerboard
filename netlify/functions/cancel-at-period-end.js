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

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)

  let body
  try { body = JSON.parse(event.body || '{}') } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }
  }

  const userId = sanitize(body.userId)

  // Ownership check — only allow a user to cancel their own subscription
  if (userId && userId !== callerId) {
    return { statusCode: 403, body: JSON.stringify({ error: 'You can only cancel your own subscription' }) }
  }

  // Use the server-verified email for the Stripe lookup (never body.email)
  try {
    const customers = await stripe.customers.list({ email: callerEmail, limit: 1 })
    const customer  = customers.data[0]
    if (!customer) {
      return { statusCode: 404, body: JSON.stringify({ error: 'No Stripe customer found.' }) }
    }

    const subs = await stripe.subscriptions.list({ customer: customer.id, status: 'active', limit: 1 })
    const sub  = subs.data[0]
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
