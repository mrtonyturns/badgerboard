// netlify/functions/create-portal-session.js
// Creates a Stripe Customer Portal session so users can manage/cancel their subscription.
//
// Required env vars:
//   STRIPE_SECRET_KEY  — Stripe secret key
//   SITE_URL           — e.g. https://www.badgerboardwi.com

import Stripe from 'stripe'

const SUPABASE_URL  = process.env.SUPABASE_URL  || process.env.VITE_SUPABASE_URL
const SUPABASE_ANON = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY

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

  const stripe  = new Stripe(process.env.STRIPE_SECRET_KEY)
  const siteUrl = process.env.SITE_URL || 'https://www.badgerboardwi.com'

  // Look up Stripe customer by verified email only — ignore any client-supplied email/customerId
  let stripeCustomerId
  try {
    const customers = await stripe.customers.list({ email: callerEmail, limit: 1 })
    stripeCustomerId = customers.data[0]?.id
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
