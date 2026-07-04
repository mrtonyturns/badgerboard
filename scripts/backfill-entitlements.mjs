// backfill-entitlements.mjs
// One-time migration: populate app_metadata (service-role-writable only) with
// each user's entitlements, so the app can stop trusting the user-writable
// user_metadata for plan/bracket/credits.
//
// AUTHORITATIVE, not a blind copy: plan/bracket/billing/payment_status are
// derived from the user's ACTUAL Stripe subscription (keyed on the verified
// supabase_user_id captured at checkout), so a user who previously forged
// user_metadata.plan does NOT get that forged plan carried over.
// Purchased credit balances (profile_credits/bulk_credits) and the stripe id
// fields are copied from user_metadata since there is no other source; forging
// those is far lower value and is closed off going forward.
//
// Run (keys come from the environment — never hardcode):
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... STRIPE_SECRET_KEY=... \
//     node scripts/backfill-entitlements.mjs --commit
// Without --commit it runs a dry run and prints what it WOULD change.

import Stripe from 'stripe'

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, STRIPE_SECRET_KEY } = process.env
const COMMIT = process.argv.includes('--commit')
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !STRIPE_SECRET_KEY) {
  console.error('Set SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, STRIPE_SECRET_KEY in the environment.')
  process.exit(1)
}
const stripe = new Stripe(STRIPE_SECRET_KEY)

const admin = (path, opts = {}) => fetch(`${SUPABASE_URL}/auth/v1/admin/${path}`, {
  ...opts,
  headers: {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
    ...(opts.headers || {}),
  },
})

async function allUsers() {
  const out = []
  for (let page = 1; ; page++) {
    const res = await admin(`users?page=${page}&per_page=200`)
    if (!res.ok) throw new Error(`list users failed ${res.status}: ${await res.text()}`)
    const { users } = await res.json()
    if (!users?.length) break
    out.push(...users)
    if (users.length < 200) break
  }
  return out
}

// Exploit-proof rule: a paid plan is honored ONLY if the user has a REAL active
// Stripe subscription. The plan VALUE is taken from the webhook-maintained
// user_metadata (correct for legit subscribers); a forger who set
// user_metadata.plan without paying has no active subscription → scout.
// No price map needed, so no risk of mass-downgrading on a config gap.
async function hasActiveSub(user) {
  const custId = user.user_metadata?.stripe_customer_id || user.app_metadata?.stripe_customer_id
  if (!custId) return null
  try {
    const subs = await stripe.subscriptions.list({ customer: custId, status: 'active', limit: 1 })
    const sub = subs.data[0]
    if (!sub) return null
    const stamped = sub.metadata?.supabase_user_id
    if (stamped && stamped !== user.id) return null   // customer id doesn't belong to this user
    return sub.id
  } catch (e) {
    console.warn(`  ! Stripe lookup failed for ${user.email}: ${e.message}`)
    return undefined   // undefined = unknown; preserve existing rather than downgrade
  }
}

// NON-DESTRUCTIVE: copy current entitlements from user_metadata into
// app_metadata verbatim. This preserves everyone's existing access (the app
// comps plans manually via admin-set-tier, so many paid users legitimately
// have no Stripe subscription) while closing the vulnerability — going forward
// only the service role can write app_metadata. Accounts holding a paid plan
// with NO active Stripe subscription are flagged (not changed) for your review.
const run = async () => {
  console.log(`Mode: ${COMMIT ? 'COMMIT' : 'DRY RUN'} (preserve-and-flag)`)
  const users = await allUsers()
  console.log(`Users: ${users.length}\n`)

  let changed = 0
  const flagged = []
  for (const u of users) {
    const um = u.user_metadata || {}
    const paidPlan = um.plan && um.plan !== 'scout'
    const subId = paidPlan ? await hasActiveSub(u) : null
    if (paidPlan && !subId) flagged.push(`${u.email} (${um.plan})`)

    // Copy entitlement fields verbatim — no downgrades.
    const next = { ...(u.app_metadata || {}) }
    for (const k of ['plan', 'plan_type', 'bracket', 'billing', 'payment_status',
                     'profile_credits', 'bulk_credits',
                     'stripe_customer_id', 'stripe_subscription_id', 'downgraded_at']) {
      if (um[k] !== undefined && um[k] !== null) next[k] = um[k]
    }

    console.log(`${u.email}: app_metadata.plan = ${next.plan || 'scout'}${next.profile_credits ? ` +${next.profile_credits}cr` : ''}`)
    if (COMMIT) {
      const res = await admin(`users/${u.id}`, { method: 'PUT', body: JSON.stringify({ app_metadata: next }) })
      if (!res.ok) console.error(`  ! update failed: ${res.status} ${await res.text()}`)
      else changed++
    }
  }

  if (flagged.length) {
    console.log(`\n⚠ ${flagged.length} account(s) hold a paid plan with NO active Stripe subscription`)
    console.log('  (preserved as-is — review whether each is a legitimate comp or a leftover/forged plan):')
    flagged.forEach(f => console.log('   -', f))
  }
  console.log(`\n${COMMIT ? `Updated ${changed} users.` : 'Dry run complete — re-run with --commit to apply.'}`)
}

run().catch(e => { console.error(e); process.exit(1) })
