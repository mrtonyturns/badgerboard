// netlify/functions/downgrade-to-free.js
// Cancels a user's active Stripe subscription and resets their plan to Scout (free).
// Called when the user chooses "Keep my data — move to free Scout plan" in the
// cancellation flow in Settings.
//
// POST body: { userId, email }
//
// Required env vars:
//   STRIPE_SECRET_KEY
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY

import Stripe from 'stripe'

import { ADMIN_EMAILS } from './_config.js'
const SUPABASE_URL  = process.env.SUPABASE_URL  || process.env.VITE_SUPABASE_URL
const SUPABASE_ANON = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY

async function verifyCallerJWT(authHeader) {
  if (!authHeader?.startsWith('Bearer ')) return null
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON, Authorization: authHeader },
  })
  if (!res.ok) return null
  return res.json()
}

function sanitize(str, maxLen = 320) {
  if (str == null) return ''
  return String(str).replace(/[<>"'`]/g, '').slice(0, maxLen)
}

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

async function resetToScout(supabaseUserId) {
  // GET existing user metadata first to avoid clobbering unrelated fields
  const existingUser = await getSupabaseUser(supabaseUserId)
  const existingMeta = existingUser?.app_metadata ?? {}

  // Voluntary downgrade: user is in good standing on the free plan.
  // Do NOT set downgraded_at or payment_status: 'inactive' — those are
  // reserved for webhook-triggered cancellations (Stripe killed the sub).
  // Setting them here would falsely trigger the lockout overlay + deletion countdown.
  const metadata = {
    ...existingMeta,
    plan:                    'scout',
    plan_type:               'candidate',
    payment_status:          'active',
    downgraded_at:           null,
    billing:                 null,
    stripe_subscription_id:  null,
  }

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

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) }
  }

  // ── Auth guard ────────────────────────────────────────────────────────────────
  const authHeader = event.headers?.authorization || event.headers?.Authorization
  const caller = await verifyCallerJWT(authHeader)
  if (!caller) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Not authenticated' }) }
  }
  // ─────────────────────────────────────────────────────────────────────────────

  let body
  try {
    body = JSON.parse(event.body || '{}')
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }
  }

  const userId = sanitize(body.userId)

  if (!userId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'userId is required' }) }
  }

  // Verify caller is acting on their own account (admins may act on any account)
  if (caller.id !== userId && !ADMIN_EMAILS.includes(caller.email?.toLowerCase())) {
    return { statusCode: 403, body: JSON.stringify({ error: 'Forbidden' }) }
  }

  // Block admin accounts from downgrading
  const user = await getSupabaseUser(userId)
  if (user && ADMIN_EMAILS.includes(user.email?.toLowerCase())) {
    return { statusCode: 403, body: JSON.stringify({ error: 'Admin accounts cannot be downgraded.' }) }
  }

  // Use the server-verified email from Supabase for Stripe lookup — never body.email
  const verifiedEmail = user?.email?.toLowerCase()

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)

  try {
    // Find and cancel the active Stripe subscription for this user
    if (verifiedEmail) {
      const customers = await stripe.customers.list({ email: verifiedEmail, limit: 5 })
      for (const customer of customers.data) {
        const subs = await stripe.subscriptions.list({
          customer: customer.id,
          status:   'active',
          limit:    10,
        })
        for (const sub of subs.data) {
          await stripe.subscriptions.cancel(sub.id)
          console.log(`Cancelled subscription ${sub.id} (customer ${customer.id})`)
        }
      }
    }

    // Immediately reset the plan in Supabase so the app reflects scout access
    await resetToScout(userId)
    console.log(`Downgraded user ${userId} to Scout plan`)

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: "Your subscription has been cancelled. You've been moved to the free Scout plan — all your data is safe.",
      }),
    }
  } catch (err) {
    console.error('downgrade-to-free error:', err.message)
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) }
  }
}
