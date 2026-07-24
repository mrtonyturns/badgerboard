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
    // 1. Cancel EVERY cancellable Stripe subscription before deleting the account.
    // Audit fix (#20): the old code listed status:'active' only, so trialing /
    // past_due / unpaid / paused subscriptions survived deletion and kept
    // billing a customer who no longer had an account to see or cancel them.
    // It also looked up the customer by email only, missing customers whose
    // Stripe email diverged after an admin email change. Resolve via the
    // stored stripe_customer_id first, and if any cancellable subscription
    // fails to cancel, ABORT the deletion instead of orphaning the billing.
    const CANCELLABLE = ['active', 'trialing', 'past_due', 'unpaid', 'paused', 'incomplete']
    const meta = user?.app_metadata || {}
    const customerIds = new Set()
    if (meta.stripe_customer_id) customerIds.add(meta.stripe_customer_id)

    try {
      // Resolve the customer from a stored subscription id too (covers accounts
      // that predate stripe_customer_id being written)
      if (meta.stripe_subscription_id) {
        try {
          const sub = await stripe.subscriptions.retrieve(meta.stripe_subscription_id)
          if (sub?.customer) customerIds.add(typeof sub.customer === 'string' ? sub.customer : sub.customer.id)
        } catch (e) { /* sub may already be gone */ }
      }
      if (verifiedEmail) {
        const customers = await stripe.customers.list({ email: verifiedEmail, limit: 5 })
        for (const c of customers.data) customerIds.add(c.id)
      }

      const failures = []
      for (const customerId of customerIds) {
        const subs = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 20 })
        for (const sub of subs.data) {
          if (!CANCELLABLE.includes(sub.status)) continue
          try {
            await stripe.subscriptions.cancel(sub.id)
            console.log(`Cancelled subscription ${sub.id} (${sub.status}) for deleted user ${userId}`)
          } catch (subErr) {
            console.error(`Failed to cancel subscription ${sub.id}:`, subErr.message)
            failures.push(sub.id)
          }
        }
      }
      if (failures.length) {
        return {
          statusCode: 502,
          body: JSON.stringify({ error: 'We could not cancel your subscription, so your account has NOT been deleted (this protects you from being billed for a deleted account). Please try again in a few minutes or contact support@badgerboardwi.com.' }),
        }
      }
    } catch (stripeErr) {
      console.error('Stripe lookup failed during account deletion:', stripeErr.message)
      // If we KNOW the user has billing on file, don't delete the account while
      // blind — that's exactly the orphaned-billing scenario. Users with no
      // stored billing markers (free accounts) proceed normally.
      if (meta.stripe_customer_id || meta.stripe_subscription_id) {
        return {
          statusCode: 502,
          body: JSON.stringify({ error: 'We could not reach our billing provider to cancel your subscription, so your account has NOT been deleted. Please try again in a few minutes.' }),
        }
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
    return { statusCode: 500, body: JSON.stringify({ error: 'An internal error occurred' }) }
  }
}
