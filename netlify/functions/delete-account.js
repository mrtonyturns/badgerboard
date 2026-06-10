// netlify/functions/delete-account.js
// Permanently deletes a user's account, cancels any active Stripe subscription,
// and removes all data from Supabase. Called from the Settings danger-zone flow
// only after two explicit confirmations from the user.
//
// POST body: { userId }
//
// Required env vars:
//   STRIPE_SECRET_KEY
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY

const Stripe = require('stripe')

const { ADMIN_EMAILS } = require('./_config')
const { sendEmail } = require('./_email')
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

async function deleteSupabaseUser(supabaseUserId) {
  const res = await fetch(
    `${process.env.SUPABASE_URL}/auth/v1/admin/users/${supabaseUserId}`,
    {
      method: 'DELETE',
      headers: {
        apikey:        process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
    }
  )
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Supabase user deletion failed (${res.status}): ${text}`)
  }
  return true
}

exports.handler = async (event) => {
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

  // Verify caller is deleting their own account (admins may delete any account)
  if (caller.id !== userId && !ADMIN_EMAILS.includes(caller.email?.toLowerCase())) {
    return { statusCode: 403, body: JSON.stringify({ error: 'Forbidden' }) }
  }

  // Fetch the user from Supabase to get their verified email for Stripe lookup
  const user = await getSupabaseUser(userId)

  // Block admin accounts from being deleted
  if (user && ADMIN_EMAILS.includes(user.email?.toLowerCase())) {
    return { statusCode: 403, body: JSON.stringify({ error: 'Admin accounts cannot be deleted through this endpoint.' }) }
  }

  // Use the server-verified email for Stripe lookup — never trust client-supplied email
  const verifiedEmail = user?.email

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)

  try {
    // 1. Immediately cancel any active Stripe subscriptions (no grace period).
    // Wrapped in its own try/catch so a Stripe failure doesn't abort the Supabase deletion.
    if (verifiedEmail) {
      try {
        const customers = await stripe.customers.list({ email: verifiedEmail, limit: 5 })
        for (const customer of customers.data) {
          const subs = await stripe.subscriptions.list({
            customer: customer.id,
            status:   'active',
            limit:    10,
          })
          for (const sub of subs.data) {
            try {
              await stripe.subscriptions.cancel(sub.id)
              console.log(`Cancelled subscription ${sub.id} for deleted user ${userId}`)
            } catch (subErr) {
              console.error(`Failed to cancel subscription ${sub.id}:`, subErr.message)
            }
          }
        }
      } catch (stripeErr) {
        console.error('Stripe lookup failed during account deletion (proceeding with Supabase delete):', stripeErr.message)
      }
    }

    // 2. Send goodbye email before wiping the record (while we still have the email)
    try {
      if (verifiedEmail) {
        await sendEmail({
          to: verifiedEmail,
          subject: 'Your Badger Board account has been deleted',
          title: 'Account deleted',
          body: `<p>Your Badger Board account and all associated data have been permanently deleted.</p><p>We're sorry to see you go. If you ever want to come back, you're always welcome to create a new account.</p>`,
          footerNote: 'If you did not request this deletion, please contact support@badgerboardwi.com immediately.',
        })
      }
    } catch (e) { console.error('[email] account deletion email:', e.message) }

    // 3. Delete the Supabase user (cascades to user_metadata; row-level security
    //    ensures all tables with user_id FK are also cleaned up if configured).
    await deleteSupabaseUser(userId)
    console.log(`Deleted Supabase user ${userId}`)

    return {
      statusCode: 200,
      body: JSON.stringify({ message: 'Account permanently deleted.' }),
    }
  } catch (err) {
    console.error('delete-account error:', err.message)
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) }
  }
}
