// netlify/functions/buy-dossier-credits.js
// Creates a Stripe Checkout session for one-time dossier credit pack purchases.
//
// Required env vars:
//   STRIPE_SECRET_KEY            — Stripe secret key
//   STRIPE_PRICE_DOSSIERS_5      — Price ID for 5-dossier pack
//   STRIPE_PRICE_DOSSIERS_10     — Price ID for 10-dossier pack
//   STRIPE_PRICE_DOSSIERS_20     — Price ID for 20-dossier pack
//   STRIPE_PRICE_DOSSIERS_50     — Price ID for 50-dossier pack
//   STRIPE_PRICE_DOSSIERS_100    — Price ID for 100-dossier pack
//   SITE_URL                     — e.g. https://www.badgerboardwi.com

import Stripe from 'stripe'

const SUPABASE_URL  = process.env.SUPABASE_URL  || process.env.VITE_SUPABASE_URL
const SUPABASE_ANON = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY

const PACK_CONFIG = {
  5:   { label: '5 Dossier Credits',   priceEnv: 'STRIPE_PRICE_DOSSIERS_5',   qty: 5   },
  10:  { label: '10 Dossier Credits',  priceEnv: 'STRIPE_PRICE_DOSSIERS_10',  qty: 10  },
  20:  { label: '20 Dossier Credits',  priceEnv: 'STRIPE_PRICE_DOSSIERS_20',  qty: 20  },
  50:  { label: '50 Dossier Credits',  priceEnv: 'STRIPE_PRICE_DOSSIERS_50',  qty: 50  },
  100: { label: '100 Dossier Credits', priceEnv: 'STRIPE_PRICE_DOSSIERS_100', qty: 100 },
}

function sanitize(val, max = 200) {
  if (val == null) return ''
  return String(val).replace(/[<>"'`]/g, '').slice(0, max)
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
  // Bank credits to the VERIFIED caller — never a body-supplied id (that let a
  // paying user credit an arbitrary account).
  const authedUser = await authRes.json()
  const userId     = authedUser?.id
  if (!userId) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Invalid or expired token' }) }
  }

  const stripe  = new Stripe(process.env.STRIPE_SECRET_KEY)
  const siteUrl = process.env.SITE_URL || 'https://www.badgerboardwi.com'

  let body
  try {
    body = JSON.parse(event.body || '{}')
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }
  }

  const pack  = parseInt(sanitize(body.pack))
  const email = authedUser?.email || sanitize(body.email, 320)

  if (!PACK_CONFIG[pack]) {
    return { statusCode: 400, body: JSON.stringify({ error: `Invalid pack size. Choose from: ${Object.keys(PACK_CONFIG).join(', ')}` }) }
  }

  const config  = PACK_CONFIG[pack]
  const priceId = process.env[config.priceEnv]

  if (!priceId) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: `Price ID for ${config.label} not configured. Set ${config.priceEnv} in Netlify env vars.`,
      }),
    }
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      client_reference_id: userId,
      customer_email: email || undefined,
      metadata: {
        type:              'dossier_credits',
        dossier_credits:   String(pack),
        supabase_user_id:  userId,
      },
      success_url: `${siteUrl}/profiler?credits=success&pack=${pack}`,
      cancel_url:  `${siteUrl}/profiler?credits=cancelled`,
      allow_promotion_codes: true,
    })

    return { statusCode: 200, body: JSON.stringify({ url: session.url }) }
  } catch (err) {
    console.error('Stripe dossier credits checkout error:', err.message)
    return { statusCode: 500, body: JSON.stringify({ error: 'An internal error occurred' }) }
  }
}
