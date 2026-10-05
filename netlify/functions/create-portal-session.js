// netlify/functions/create-portal-session.js
// Creates a Stripe Customer Portal session so users can manage/cancel their subscription.
//
// Required env vars:
//   STRIPE_SECRET_KEY  — Stripe secret key
//   SITE_URL           — e.g. https://www.badgerboardwi.com

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
  const customers = await stripe.customers.list({ email: callerEmail, limit: 1 })
  for (const c of customers.data) if (!ids.includes(c.id)) ids.push(c.id)
  return ids
}

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) }
  }

  // Auth guard — require a valid Supabase JWT
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

  // Use server-verified caller identity — never trust client-supplied email
  const caller      = await authRes.json()
  const callerEmail = caller?.email?.toLowerCase()
  if (!callerEmail) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Could not resolve caller identity' }) }
  }

  // Build the Stripe client inside the handler behind an explicit key check
  // (same pattern as admin-billing.js). `new Stripe(undefined)` constructs fine
  // and then fails deep inside the first API call as an opaque 500; a missing
  // key is a deployment problem, so say so with a 503.
  const stripeKey = process.env.STRIPE_SECRET_KEY
  if (!stripeKey) {
    return { statusCode: 503, body: JSON.stringify({ error: 'Stripe is not configured (STRIPE_SECRET_KEY missing)' }) }
  }
  const stripe  = new Stripe(stripeKey)
  const siteUrl = process.env.SITE_URL || 'https://www.badgerboardwi.com'

  // Stored customer id, else verified email — ignore any client-supplied email/customerId
  let stripeCustomerId
  try {
    stripeCustomerId = (await resolveCustomerIds(stripe, caller, callerEmail))[0]
  } catch (err) {
    console.error('Customer lookup error:', err.message)
  }

  if (!stripeCustomerId) {
    return {
      statusCode: 404,
      body: JSON.stringify({ error: 'No Stripe customer found for this account. Make sure you have an active subscription.' }),
    }
  }

  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: stripeCustomerId,
      return_url: `${siteUrl}/settings`,
    })

    return {
      statusCode: 200,
      body: JSON.stringify({ url: session.url }),
    }
  } catch (err) {
    console.error('Portal session error:', err.message)
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'An internal error occurred' }),
    }
  }
}
