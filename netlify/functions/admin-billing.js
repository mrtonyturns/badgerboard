import Stripe from 'stripe';
import { ADMIN_EMAILS } from './_config.js';
// Price resolution is shared with self-serve checkout so an admin plan change
// uses exactly the same env-var-or-baked-in-catalog lookup.
import { resolvePriceId, billingPeriodFromPrice } from './create-checkout-session.js';
// Audit fix (#1/#5): the Supabase admin PUT MERGES app_metadata, so a plain
// `delete meta.key` + PUT is a silent no-op. Every write in this file now goes
// through the diffing helper that sends removals as explicit nulls.
import { updateAppMetadata } from './_app-metadata.js';

/**
 * Audit fix (#2): the handler's catch used to collapse EVERY failure into
 * "An internal error occurred", so the admin panel could only ever say
 * "Failed to cancel subscription" — which is exactly why the owner believed
 * cancelling was broken when the real message was "No active subscription
 * found" or "Customer not found". Errors raised deliberately by this file are
 * marked `expose` and surfaced verbatim with a real status code.
 */
class BillingError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'BillingError';
    this.expose = true;
    this.statusCode = statusCode;
  }
}

// Every subscription state an admin would reasonably call "still billing".
// Audit fix (#1b): the old code listed status:'active' only, so a past_due or
// trialing subscriber reported "No active subscription found" and the cancel
// silently did nothing.
const CANCELLABLE_STATUSES = ['active', 'trialing', 'past_due', 'unpaid', 'paused', 'incomplete'];

// Mirrors stripe-webhook.js planType() — LEGACY + action keys are 'action',
// everything else (including 'scout') is 'candidate'.
const ACTION_PLAN_KEYS_SRV = ['a_monitor', 'a_active', 'a_campaign'];
const LEGACY_PLAN_KEYS_SRV = ['monitor', 'campaign', 'agency'];
function planTypeFor(plan) {
  return ACTION_PLAN_KEYS_SRV.includes(plan) || LEGACY_PLAN_KEYS_SRV.includes(plan) ? 'action' : 'candidate';
}

// Audit fix (#1d): the key list admin-manage-access.js `reset_to_free` clears.
// Kept in one place so "cancel an account with no Stripe subscription" and
// "reset to free" can never drift apart.
const FREE_RESET_KEYS = [
  'plan', 'plan_type', 'bracket', 'beta_mode',
  'trial_plan', 'trial_bracket', 'trial_started_at', 'trial_ends_at',
  'trial_granted_by', 'trial_warning_sent',
];

// Returns: user object if admin, 'forbidden' if valid token but not admin, null if no/invalid token
async function verifyAdmin(authHeader) {
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  const res = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${token}`,
    },
  });
  if (!res.ok) return null;
  const user = await res.json();
  return ADMIN_EMAILS.includes(user?.email?.toLowerCase()) ? user : 'forbidden';
}

// (findCustomer() — the old email-only, limit-1 lookup — was removed. It was the
// root cause of finding #1a and every call site now uses resolveCustomerIds().)

// Full Supabase auth record — we need app_metadata (stripe ids) as well as the
// email, so the email-only helper below is now derived from this one.
async function getUserRecord(userId) {
  if (!userId) return null;
  const res = await fetch(
    `${process.env.SUPABASE_URL}/auth/v1/admin/users/${userId}`,
    {
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
    }
  );
  if (!res.ok) return null;
  return res.json();
}

// (getUserEmail() removed with its last caller — everything needs app_metadata
// as well as the email now, so getUserRecord() is the single lookup.)

/**
 * Audit fix (#1a): every Stripe lookup in this file resolved the customer by
 * EMAIL ONLY. An account whose Stripe email diverged (admin email change,
 * checkout done under a different address, a second customer record) reported
 * "Customer not found" and the admin panel showed a generic failure. This is
 * the same resolution order delete-account.js uses: stored customer id →
 * customer behind the stored subscription id → email.
 */
async function resolveCustomerIds(stripe, user) {
  const meta = user?.app_metadata || {};
  const ids = new Set();
  if (meta.stripe_customer_id) ids.add(meta.stripe_customer_id);
  if (meta.stripe_subscription_id) {
    try {
      const sub = await stripe.subscriptions.retrieve(meta.stripe_subscription_id);
      if (sub?.customer) ids.add(typeof sub.customer === 'string' ? sub.customer : sub.customer.id);
    } catch (e) { /* subscription may already be gone — fall through to email */ }
  }
  if (user?.email) {
    const customers = await stripe.customers.list({ email: user.email, limit: 5 });
    for (const c of customers.data) ids.add(c.id);
  }
  return [...ids];
}

/**
 * First subscription in a state an admin would call "still billing", across
 * every customer record that belongs to this user.
 */
async function findLiveSubscription(stripe, customerIds) {
  for (const customerId of customerIds) {
    const subs = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 20 });
    const sub = subs.data.find((s) => CANCELLABLE_STATUSES.includes(s.status));
    if (sub) return { subscription: sub, customerId };
  }
  return null;
}

async function getSubscription(stripe, userId) {
  const user = await getUserRecord(userId);
  if (!user) throw new BillingError('User not found', 404);

  const customerIds = await resolveCustomerIds(stripe, user);
  if (!customerIds.length) {
    return { subscription: null };
  }

  // Audit fix (#1b): status:'active' only meant a past_due / trialing / unpaid
  // subscriber rendered as "No Stripe subscription", so the Cancel button on
  // the very accounts that most need cancelling looked like a no-op.
  const found = await findLiveSubscription(stripe, customerIds);
  if (!found) {
    return { subscription: null, customer_id: customerIds[0] };
  }
  const { subscription, customerId } = found;

  const item = subscription.items.data[0];
  const price = await stripe.prices.retrieve(item.price.id);

  return {
    customer_id: customerId,
    subscription_id: subscription.id,
    status: subscription.status,
    plan_name: price.nickname || 'Unknown',
    current_period_end: new Date((subscription.current_period_end ?? subscription.items?.data?.[0]?.current_period_end) * 1000).toISOString(),
    cancel_at_period_end: subscription.cancel_at_period_end,
    cancel_at: subscription.cancel_at ? new Date(subscription.cancel_at * 1000).toISOString() : null,
    amount: item.price.unit_amount,
    currency: item.price.currency,
    trial_end: subscription.trial_end ? new Date(subscription.trial_end * 1000).toISOString() : null,
  };
}

/**
 * Cancel a subscription. THE reported bug.
 *
 * Audit fix (#1):
 *  a) resolve the customer via stored stripe ids first, email only as fallback
 *  b) cover every cancellable status, not just 'active'
 *  c) offer BOTH an immediate cancel and an end-of-period cancel — the old
 *     code only ever set cancel_at_period_end, so the admin saw the account
 *     still on its paid plan and concluded the button was broken
 *  d) an account with no Stripe subscription at all (manual / beta / trial
 *     plans) used to throw "Customer not found". The admin's intent is "end
 *     their paid access", so we say so specifically AND clear the plan
 *     metadata, the same keys admin-manage-access `reset_to_free` clears.
 *
 * @param {'immediate'|'period_end'} mode
 */
async function cancelSubscription(stripe, userId, mode = 'period_end') {
  if (!['immediate', 'period_end'].includes(mode)) {
    throw new BillingError(`Invalid cancel mode "${mode}". Use "immediate" or "period_end".`);
  }
  const user = await getUserRecord(userId);
  if (!user) throw new BillingError('User not found', 404);

  const customerIds = await resolveCustomerIds(stripe, user);
  const found = customerIds.length ? await findLiveSubscription(stripe, customerIds) : null;

  // ── (d) No Stripe subscription: be honest, and still end their paid access ──
  if (!found) {
    const hadPlan = Boolean(user.app_metadata?.plan && user.app_metadata.plan !== 'scout')
      || user.app_metadata?.beta_mode === true
      || Boolean(user.app_metadata?.trial_plan);
    await updateAppMetadata(userId, (meta) => {
      for (const k of FREE_RESET_KEYS) delete meta[k];
    });
    const why = customerIds.length
      ? 'This account has a Stripe customer record but no cancellable subscription'
      : 'This account has no Stripe customer — its plan was assigned manually (admin / beta / trial)';
    return {
      cancelled: false,
      no_subscription: true,
      metadata_cleared: true,
      mode,
      email: user.email,
      message: `${why}. Nothing was cancelled in Stripe. ${hadPlan
        ? 'Their plan, beta flag and trial have been cleared — the account is now on the free Scout plan.'
        : 'The account was already on the free Scout plan, so nothing changed.'}`,
    };
  }

  const { subscription } = found;

  // ── (c) End of period: keep access until they have paid through ────────────
  if (mode === 'period_end') {
    if (subscription.cancel_at_period_end) {
      return {
        cancelled: true,
        already_scheduled: true,
        mode,
        subscription_id: subscription.id,
        status: subscription.status,
        cancel_at_period_end: true,
        cancel_at: subscription.cancel_at ? new Date(subscription.cancel_at * 1000).toISOString() : null,
        message: 'This subscription was already scheduled to cancel at the end of the period — no change made.',
      };
    }
    const updated = await stripe.subscriptions.update(subscription.id, { cancel_at_period_end: true });
    const cancelAt = updated.cancel_at
      ?? updated.current_period_end
      ?? updated.items?.data?.[0]?.current_period_end
      ?? null;
    return {
      cancelled: true,
      mode,
      subscription_id: updated.id,
      status: updated.status,
      cancel_at_period_end: true,
      cancel_at: cancelAt ? new Date(cancelAt * 1000).toISOString() : null,
      message: cancelAt
        ? `Subscription will end on ${new Date(cancelAt * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}. They keep access until then.`
        : 'Subscription is scheduled to cancel at the end of the current period.',
    };
  }

  // ── (c) Immediate: billing stops now, access drops now ─────────────────────
  const cancelled = await stripe.subscriptions.cancel(subscription.id);

  // Mirror EXACTLY what stripe-webhook.js writes on customer.subscription.deleted
  // (updateSupabasePlan('scout', null, null, …) + the extraFields below), so the
  // entitlement/plan display is correct immediately instead of waiting for — or
  // disagreeing with — the webhook. No new metadata keys are invented here.
  await updateAppMetadata(userId, (meta) => {
    meta.plan = 'scout';
    meta.plan_type = planTypeFor('scout');
    delete meta.bracket;                 // cleared when moving to a candidate plan
    meta.payment_status = 'inactive';
    meta.downgraded_at = Date.now();
    meta.stripe_subscription_id = null;
  });

  return {
    cancelled: true,
    mode: 'immediate',
    subscription_id: cancelled.id,
    status: cancelled.status,
    cancel_at_period_end: false,
    canceled_at: cancelled.canceled_at ? new Date(cancelled.canceled_at * 1000).toISOString() : null,
    plan_reset: true,
    message: 'Subscription cancelled immediately. Billing has stopped and the account is now on the free Scout plan.',
  };
}

/**
 * Audit fix (#1a, applied file-wide): resolve the customer the same way the
 * cancel path does, and raise an EXPOSED error when there genuinely isn't one
 * so the admin reads "This account has no Stripe customer…" instead of a
 * generic "Failed to …".
 */
async function requireCustomerId(stripe, userId, whatFor) {
  const user = await getUserRecord(userId);
  if (!user) throw new BillingError('User not found', 404);
  const ids = await resolveCustomerIds(stripe, user);
  if (!ids.length) {
    throw new BillingError(
      `This account has no Stripe customer record, so there is nothing to ${whatFor}. Its plan (if any) was assigned manually.`,
      404
    );
  }
  return ids[0];
}

async function retryInvoice(stripe, userId) {
  const customerId = await requireCustomerId(stripe, userId, 'charge');

  // Audit fix (#19): Stripe's invoices.list takes a SINGLE status string —
  // passing an array threw on every call, so "Retry invoice" never worked.
  // Check 'open' first (retryable), then fall back to 'uncollectible'.
  let invoice = (await stripe.invoices.list({ customer: customerId, status: 'open', limit: 1 })).data[0]
  if (!invoice) {
    invoice = (await stripe.invoices.list({ customer: customerId, status: 'uncollectible', limit: 1 })).data[0]
  }
  if (!invoice) throw new BillingError('No open or uncollectible invoice to retry — there is nothing outstanding on this account.', 404);

  const paid = await stripe.invoices.pay(invoice.id);

  return {
    retried: true,
    invoice_id: paid.id,
    status: paid.status,
    amount_paid: paid.amount_paid,
    message: paid.status === 'paid'
      ? `Invoice ${paid.number || paid.id} paid successfully.`
      : `Retry submitted — invoice ${paid.number || paid.id} is now "${paid.status}".`,
  };
}

async function portalLink(stripe, userId) {
  const customerId = await requireCustomerId(stripe, userId, 'open a billing portal for');

  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: `${process.env.SITE_URL || 'https://www.badgerboardwi.com'}/settings`,
  });

  return { url: session.url };
}

async function paymentHistory(stripe, userId) {
  const user = await getUserRecord(userId);
  if (!user) throw new BillingError('User not found', 404);

  const customerIds = await resolveCustomerIds(stripe, user);
  if (!customerIds.length) {
    return { invoices: [] };
  }

  const invoices = await stripe.invoices.list({
    customer: customerIds[0],
    limit: 10,
  });

  const history = invoices.data.map((inv) => ({
    id: inv.id,
    amount: inv.amount_paid,
    status: inv.status,
    date: new Date(inv.created * 1000).toISOString(),
    invoice_url: inv.hosted_invoice_url,
  }));

  return { invoices: history };
}

async function applyCredit(stripe, userId, amountCents, description) {
  const cents = Math.round(Number(amountCents));
  if (!Number.isFinite(cents) || cents === 0) {
    throw new BillingError('A valid non-zero credit amount (in cents) is required');
  }
  amountCents = cents;
  const customerId = await requireCustomerId(stripe, userId, 'credit');
  const customer = await stripe.customers.retrieve(customerId);

  // Stripe balance is negative = credit, positive = owed
  const newBalance = (customer.balance || 0) - amountCents;

  const updated = await stripe.customers.update(customerId, {
    balance: newBalance,
    ...(description ? { metadata: { last_admin_credit_note: String(description).slice(0, 480) } } : {}),
  });

  return {
    applied: true,
    new_balance: updated.balance,
    message: `Credit applied. Customer balance is now ${(updated.balance / 100).toFixed(2)} USD (negative = credit on file).`,
  };
}

// Audit fix (#4): server-side validation — the admin UI once sent bracket keys
// (b2, b3, b6-as-26-50…) that either wrote garbage into app_metadata or moved
// live subscriptions to the wrong price. Never trust the picker.
const VALID_PLAN_KEYS = ['scout', 'free', 'c_monitor', 'c_active', 'c_campaign', 'a_monitor', 'a_active', 'a_campaign', 'monitor', 'campaign', 'agency'];
const VALID_BRACKET_KEYS = ['b1', 'b2_5', 'b6', 'b11', 'b26', 'b51', 'ent'];

function validatePlanBracket(plan, bracket) {
  if (plan && !VALID_PLAN_KEYS.includes(String(plan).toLowerCase())) {
    throw new BillingError(`Invalid plan key "${plan}". Valid: ${VALID_PLAN_KEYS.join(', ')}`);
  }
  if (bracket && !VALID_BRACKET_KEYS.includes(String(bracket))) {
    throw new BillingError(`Invalid bracket key "${bracket}". Valid: ${VALID_BRACKET_KEYS.join(', ')}`);
  }
}

const FREE_PLANS = ['scout', 'free'];

async function updatePlan(stripe, userId, plan, bracket) {
  validatePlanBracket(plan, bracket);
  const user = await getUserRecord(userId);
  if (!user) throw new BillingError('User not found', 404);

  const planKey = String(plan || '').toLowerCase();
  const isFree  = FREE_PLANS.includes(planKey);
  // Resolved once and reused: email-only lookup missed customers whose Stripe
  // email diverged, which made a plan change silently metadata-only (#1a).
  const customerIds = stripe ? await resolveCustomerIds(stripe, user) : [];

  // ── 0. Resolve Stripe BEFORE touching app_metadata ────────────────────────
  // The old order wrote the entitlement first and then discovered the price was
  // missing, leaving the account on a paid plan with no matching subscription.
  // Everything that can fail is resolved here; app_metadata is written only
  // once we know the Stripe side can be carried out.
  let stripeTarget = null;   // { subscription, itemId, priceId }
  if (stripe && !isFree) {
    const found = await findLiveSubscription(stripe, customerIds);
    if (found) {
      const subscription = found.subscription;
      const item = subscription.items.data[0];
      // Respect what the subscriber is actually billed on — the old code
      // always resolved the _M (monthly) price, silently moving annual and
      // quarterly subscribers onto monthly billing.
      const billing = billingPeriodFromPrice(item?.price);
      const { key, priceId } = resolvePriceId(planKey, bracket || 'b1', billing);
      if (!priceId) {
        throw new BillingError(`Stripe price not configured for ${planKey}/${bracket || 'b1'}/${billing} (${key}) — plan not changed.`);
      }
      stripeTarget = { subscription, itemId: item.id, priceId, billing };
    }
  }

  // ── 1. Update Supabase app_metadata ───────────────────────────────────────
  // Audit fix (#5): this used a raw merging PUT, so moving an account from an
  // Action plan to a Candidate plan could not actually remove `bracket`, and
  // plan_type was never written at all (stripe-webhook and admin-set-tier both
  // write it). Routed through the diffing helper: deletions persist.
  await updateAppMetadata(userId, (meta) => {
    meta.plan = plan;
    meta.plan_type = planTypeFor(planKey);
    if (bracket) meta.bracket = bracket;
    else delete meta.bracket;
    // Keep the recorded billing period in step with the subscription we're
    // about to move, so the Plans page's "current plan" check stays accurate.
    if (stripeTarget?.billing) meta.billing = stripeTarget.billing;
    // Moving to free clears the manual access layers too, so the resolved
    // entitlement in the admin table matches what we just did.
    if (isFree) {
      delete meta.bracket;
      delete meta.beta_mode;
      for (const k of ['trial_plan', 'trial_bracket', 'trial_started_at', 'trial_ends_at', 'trial_granted_by', 'trial_warning_sent']) {
        delete meta[k];
      }
    }
  });

  // ── 2. Also update Stripe subscription if one exists (paid plans) ──────────
  // Free/scout users have no Stripe sub — we still succeed after the metadata update above.
  if (!stripe) return { updated: true, stripe: 'not_configured' };

  if (isFree) {
    // Downgrading to free: cancel Stripe sub at period end if one exists
    const found = await findLiveSubscription(stripe, customerIds);
    if (found) {
      await stripe.subscriptions.update(found.subscription.id, { cancel_at_period_end: true });
      return { updated: true, stripe: 'subscription_scheduled_for_cancellation' };
    }
    return { updated: true, stripe: customerIds.length ? 'no_active_subscription' : 'no_stripe_customer' };
  }

  // Paid plan with no Stripe subscription to move: metadata updated, nothing to sync.
  // (stripeTarget is only set when a customer AND a live subscription exist,
  // and in that case the price was already resolved above — it cannot be missing here.)
  if (!stripeTarget) return { updated: true, stripe: customerIds.length ? 'no_active_subscription' : 'no_stripe_customer' };

  await stripe.subscriptions.update(stripeTarget.subscription.id, {
    items: [{ id: stripeTarget.itemId, price: stripeTarget.priceId }],
    proration_behavior: 'create_prorations',
  });

  return { updated: true, stripe: 'subscription_updated', billing: stripeTarget.billing };
}

// NOTE (audit): this Stripe-backed grant_trial is NOT what the admin panel's
// "Free Trial Giveaway" uses — that goes to admin-manage-access `grant_trial`,
// which writes internal trial_* metadata and needs no Stripe subscription. This
// action is kept for API back-compat only; nothing in src/ calls it.
async function grantTrial(stripe, userId, days) {
  const user = await getUserRecord(userId);
  if (!user) throw new BillingError('User not found', 404);

  const customerIds = await resolveCustomerIds(stripe, user);
  if (!customerIds.length) throw new BillingError('No Stripe customer found for this user', 404);

  const found = await findLiveSubscription(stripe, customerIds);
  if (!found) throw new BillingError('No live Stripe subscription to apply a trial to. Use the Free Trial Giveaway panel instead — it needs no Stripe subscription.', 404);

  const trialEnd = Math.floor(Date.now() / 1000) + days * 86400;
  await stripe.subscriptions.update(found.subscription.id, {
    trial_end: trialEnd,
  });

  return { granted: true, trial_end: new Date(trialEnd * 1000).toISOString() };
}

async function createUser(email, password, plan, bracket) {
  validatePlanBracket(plan, bracket);
  if (!email || !password) throw new BillingError('email and password are required');
  if (String(password).length < 8) throw new BillingError('Password must be at least 8 characters');

  const planKey = String(plan || 'scout').toLowerCase();
  const isAction = ACTION_PLAN_KEYS_SRV.includes(planKey) || LEGACY_PLAN_KEYS_SRV.includes(planKey);
  // Audit fix (#6): `bracket: bracket || 'b1'` was written for EVERY plan,
  // stamping candidate and free accounts with an Action-plan bracket they do
  // not have; plan_type was never written at all, unlike every other writer
  // (stripe-webhook, admin-set-tier).
  const appMetadata = { plan: planKey, plan_type: planTypeFor(planKey) };
  if (isAction) appMetadata.bracket = bracket || 'b1';

  // Create user in Supabase Auth
  const res = await fetch(`${process.env.SUPABASE_URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email,
      password,
      email_confirm: true,
      app_metadata: appMetadata,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    // Supabase's own message ("A user with this email address has already been
    // registered") is exactly what the admin needs to see.
    throw new BillingError(err.msg || err.message || err.error_description || `Failed to create user (HTTP ${res.status})`, res.status === 422 ? 400 : 502);
  }
  const user = await res.json();
  return { created: true, user_id: user.id, email: user.email, plan: planKey };
}

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const admin = await verifyAdmin(event.headers.authorization);
  if (admin === 'forbidden') {
    return { statusCode: 403, body: JSON.stringify({ error: 'Forbidden — admin only' }) };
  }
  if (!admin) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  // Degrade gracefully when Stripe isn't configured: metadata-backed actions
  // still work, and read actions report the gap instead of 500ing on every
  // account (the old behavior behind the admin panel's "Failed to load billing
  // data" / "everyone Past Due" symptoms).
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  const stripe = stripeKey ? new Stripe(stripeKey) : null;

  try {
    const { action, ...params } = JSON.parse(event.body || '{}');

    const STRIPE_REQUIRED = ['cancel_subscription', 'retry_invoice', 'portal_link', 'apply_credit', 'grant_trial'];
    if (!stripe && STRIPE_REQUIRED.includes(action)) {
      return { statusCode: 503, body: JSON.stringify({ error: 'Stripe is not configured (STRIPE_SECRET_KEY missing)' }) };
    }

    switch (action) {
      case 'get_subscription': {
        if (!stripe) return { statusCode: 200, body: JSON.stringify({ subscription: null, stripe_unavailable: true }) };
        const result = await getSubscription(stripe, params.user_id);
        return { statusCode: 200, body: JSON.stringify(result) };
      }

      case 'cancel_subscription': {
        // Audit fix (#1c): the admin now chooses. `mode` defaults to
        // 'period_end' so any older caller keeps the previous behavior.
        const result = await cancelSubscription(stripe, params.user_id, params.mode || 'period_end');
        return { statusCode: 200, body: JSON.stringify(result) };
      }

      case 'retry_invoice': {
        const result = await retryInvoice(stripe, params.user_id);
        return { statusCode: 200, body: JSON.stringify(result) };
      }

      case 'portal_link': {
        const result = await portalLink(stripe, params.user_id);
        return { statusCode: 200, body: JSON.stringify(result) };
      }

      case 'payment_history': {
        if (!stripe) return { statusCode: 200, body: JSON.stringify({ invoices: [], stripe_unavailable: true }) };
        const result = await paymentHistory(stripe, params.user_id);
        return { statusCode: 200, body: JSON.stringify(result) };
      }

      case 'apply_credit': {
        const result = await applyCredit(
          stripe,
          params.user_id,
          params.amount_cents,
          params.description
        );
        return { statusCode: 200, body: JSON.stringify(result) };
      }

      // Both action names accepted — frontend uses 'change_plan', keeping 'update_plan' for back-compat
      case 'change_plan':
      case 'update_plan': {
        const result = await updatePlan(stripe, params.user_id, params.plan, params.bracket);
        return { statusCode: 200, body: JSON.stringify(result) };
      }

      case 'grant_trial': {
        const result = await grantTrial(stripe, params.user_id, params.days || 30);
        return { statusCode: 200, body: JSON.stringify(result) };
      }

      case 'create_user': {
        const result = await createUser(params.email, params.password, params.plan, params.bracket);
        return { statusCode: 200, body: JSON.stringify(result) };
      }

      default:
        return { statusCode: 400, body: JSON.stringify({ error: 'Unknown action' }) };
    }
  } catch (err) {
    console.error('Admin billing error:', err);

    // Audit fix (#2): collapsing every failure into "An internal error
    // occurred" is what made "cancelling doesn't work" undiagnosable — the
    // admin panel could only ever print its own generic fallback. This
    // endpoint is admin-gated, so the two classes of message below are safe
    // AND are the whole point of having an admin panel:
    //   1. errors this file raises on purpose (BillingError)
    //   2. Stripe's own API errors ("No such subscription: sub_…")
    if (err?.expose) {
      return { statusCode: err.statusCode || 400, body: JSON.stringify({ error: err.message }) };
    }
    if (err?.type && String(err.type).startsWith('Stripe')) {
      return {
        statusCode: err.statusCode && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 502,
        body: JSON.stringify({ error: `Stripe: ${err.message}`, stripe_code: err.code || null }),
      };
    }
    // Anything unanticipated stays opaque to the client and detailed in the log.
    return { statusCode: 500, body: JSON.stringify({ error: 'An internal error occurred' }) };
  }
};
