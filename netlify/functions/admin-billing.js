import Stripe from 'stripe';
import { ADMIN_EMAILS } from './_config.js';
// Price resolution is shared with self-serve checkout so an admin plan change
// uses exactly the same env-var-or-baked-in-catalog lookup.
import { resolvePriceId, billingPeriodFromPrice } from './create-checkout-session.js';

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

async function findCustomer(stripe, email) {
  const list = await stripe.customers.list({ email, limit: 1 });
  return list.data[0] || null;
}

async function getUserEmail(userId) {
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
  const user = await res.json();
  return user.email;
}

async function getSubscription(stripe, userId) {
  const email = await getUserEmail(userId);
  if (!email) throw new Error('User not found');

  const customer = await findCustomer(stripe, email);
  if (!customer) {
    return { subscription: null };
  }

  const subscriptions = await stripe.subscriptions.list({
    customer: customer.id,
    status: 'active',
    limit: 1,
  });

  const subscription = subscriptions.data[0];
  if (!subscription) {
    return { subscription: null };
  }

  const item = subscription.items.data[0];
  const price = await stripe.prices.retrieve(item.price.id);

  return {
    customer_id: customer.id,
    subscription_id: subscription.id,
    status: subscription.status,
    plan_name: price.nickname || 'Unknown',
    current_period_end: new Date((subscription.current_period_end ?? subscription.items?.data?.[0]?.current_period_end) * 1000).toISOString(),
    cancel_at_period_end: subscription.cancel_at_period_end,
    amount: item.price.unit_amount,
    currency: item.price.currency,
    trial_end: subscription.trial_end ? new Date(subscription.trial_end * 1000).toISOString() : null,
  };
}

async function cancelSubscription(stripe, userId) {
  const email = await getUserEmail(userId);
  if (!email) throw new Error('User not found');

  const customer = await findCustomer(stripe, email);
  if (!customer) throw new Error('Customer not found');

  const subscriptions = await stripe.subscriptions.list({
    customer: customer.id,
    status: 'active',
    limit: 1,
  });

  const subscription = subscriptions.data[0];
  if (!subscription) throw new Error('No active subscription found');

  const updated = await stripe.subscriptions.update(subscription.id, {
    cancel_at_period_end: true,
  });

  return {
    cancelled: true,
    cancel_at: new Date(updated.cancel_at * 1000).toISOString(),
  };
}

async function retryInvoice(stripe, userId) {
  const email = await getUserEmail(userId);
  if (!email) throw new Error('User not found');

  const customer = await findCustomer(stripe, email);
  if (!customer) throw new Error('Customer not found');

  // Audit fix (#19): Stripe's invoices.list takes a SINGLE status string —
  // passing an array threw on every call, so "Retry invoice" never worked.
  // Check 'open' first (retryable), then fall back to 'uncollectible'.
  let invoice = (await stripe.invoices.list({ customer: customer.id, status: 'open', limit: 1 })).data[0]
  if (!invoice) {
    invoice = (await stripe.invoices.list({ customer: customer.id, status: 'uncollectible', limit: 1 })).data[0]
  }
  if (!invoice) throw new Error('No open invoices found');

  await stripe.invoices.pay(invoice.id);

  return { retried: true };
}

async function portalLink(stripe, userId) {
  const email = await getUserEmail(userId);
  if (!email) throw new Error('User not found');

  const customer = await findCustomer(stripe, email);
  if (!customer) throw new Error('Customer not found');

  const session = await stripe.billingPortal.sessions.create({
    customer: customer.id,
    return_url: `${process.env.SITE_URL || 'https://www.badgerboardwi.com'}/settings`,
  });

  return { url: session.url };
}

async function paymentHistory(stripe, userId) {
  const email = await getUserEmail(userId);
  if (!email) throw new Error('User not found');

  const customer = await findCustomer(stripe, email);
  if (!customer) {
    return { invoices: [] };
  }

  const invoices = await stripe.invoices.list({
    customer: customer.id,
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
    throw new Error('A valid non-zero credit amount (in cents) is required');
  }
  amountCents = cents;
  const email = await getUserEmail(userId);
  if (!email) throw new Error('User not found');

  const customer = await findCustomer(stripe, email);
  if (!customer) throw new Error('Customer not found');

  // Stripe balance is negative = credit, positive = owed
  const newBalance = customer.balance - amountCents;

  const updated = await stripe.customers.update(customer.id, {
    balance: newBalance,
  });

  return {
    applied: true,
    new_balance: updated.balance,
  };
}

// Audit fix (#4): server-side validation — the admin UI once sent bracket keys
// (b2, b3, b6-as-26-50…) that either wrote garbage into app_metadata or moved
// live subscriptions to the wrong price. Never trust the picker.
const VALID_PLAN_KEYS = ['scout', 'free', 'c_monitor', 'c_active', 'c_campaign', 'a_monitor', 'a_active', 'a_campaign', 'monitor', 'campaign', 'agency'];
const VALID_BRACKET_KEYS = ['b1', 'b2_5', 'b6', 'b11', 'b26', 'b51', 'ent'];

function validatePlanBracket(plan, bracket) {
  if (plan && !VALID_PLAN_KEYS.includes(String(plan).toLowerCase())) {
    throw new Error(`Invalid plan key "${plan}". Valid: ${VALID_PLAN_KEYS.join(', ')}`);
  }
  if (bracket && !VALID_BRACKET_KEYS.includes(String(bracket))) {
    throw new Error(`Invalid bracket key "${bracket}". Valid: ${VALID_BRACKET_KEYS.join(', ')}`);
  }
}

const FREE_PLANS = ['scout', 'free'];

async function updatePlan(stripe, userId, plan, bracket) {
  validatePlanBracket(plan, bracket);
  const email = await getUserEmail(userId);
  if (!email) throw new Error('User not found');

  const planKey = String(plan || '').toLowerCase();
  const isFree  = FREE_PLANS.includes(planKey);

  // ── 0. Resolve Stripe BEFORE touching app_metadata ────────────────────────
  // The old order wrote the entitlement first and then discovered the price was
  // missing, leaving the account on a paid plan with no matching subscription.
  // Everything that can fail is resolved here; app_metadata is written only
  // once we know the Stripe side can be carried out.
  let stripeTarget = null;   // { subscription, itemId, priceId }
  if (stripe && !isFree) {
    const customer = await findCustomer(stripe, email);
    if (customer) {
      const subs = await stripe.subscriptions.list({ customer: customer.id, status: 'active', limit: 1 });
      const subscription = subs.data[0];
      if (subscription) {
        const item = subscription.items.data[0];
        // Respect what the subscriber is actually billed on — the old code
        // always resolved the _M (monthly) price, silently moving annual and
        // quarterly subscribers onto monthly billing.
        const billing = billingPeriodFromPrice(item?.price);
        const { key, priceId } = resolvePriceId(planKey, bracket || 'b1', billing);
        if (!priceId) {
          throw new Error(`Stripe price not configured for ${planKey}/${bracket || 'b1'}/${billing} (${key}) — plan not changed.`);
        }
        stripeTarget = { subscription, itemId: item.id, priceId, billing };
      }
    }
  }

  // ── 1. Update Supabase app_metadata ───────────────────────────────────────
  const userRes = await fetch(
    `${process.env.SUPABASE_URL}/auth/v1/admin/users/${userId}`,
    {
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
    }
  );
  if (!userRes.ok) {
    const errText = await userRes.text();
    throw new Error(`Failed to fetch user for plan update: ${userRes.status} ${errText}`);
  }
  const user = await userRes.json();

  const updatedMetadata = { ...user.app_metadata, plan, bracket };
  // Keep the recorded billing period in step with the subscription we're about
  // to move, so the Plans page's "current plan" check stays accurate.
  if (stripeTarget?.billing) updatedMetadata.billing = stripeTarget.billing;

  const metaRes = await fetch(
    `${process.env.SUPABASE_URL}/auth/v1/admin/users/${userId}`,
    {
      method: 'PUT',
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ app_metadata: updatedMetadata }),
    }
  );
  if (!metaRes.ok) {
    const errText = await metaRes.text();
    throw new Error(`Failed to update user metadata: ${metaRes.status} ${errText}`);
  }

  // ── 2. Also update Stripe subscription if one exists (paid plans) ──────────
  // Free/scout users have no Stripe sub — we still succeed after the metadata update above.
  if (!stripe) return { updated: true, stripe: 'not_configured' };

  if (isFree) {
    // Downgrading to free: cancel Stripe sub at period end if one exists
    const customer = await findCustomer(stripe, email);
    if (customer) {
      const subs = await stripe.subscriptions.list({ customer: customer.id, status: 'active', limit: 1 });
      const sub = subs.data[0];
      if (sub) {
        await stripe.subscriptions.update(sub.id, { cancel_at_period_end: true });
        return { updated: true, stripe: 'subscription_scheduled_for_cancellation' };
      }
    }
    return { updated: true, stripe: 'no_subscription' };
  }

  // Paid plan with no Stripe subscription to move: metadata updated, nothing to sync.
  // (stripeTarget is only set when a customer AND an active subscription exist,
  // and in that case the price was already resolved above — it cannot be missing here.)
  if (!stripeTarget) return { updated: true, stripe: 'no_active_subscription' };

  await stripe.subscriptions.update(stripeTarget.subscription.id, {
    items: [{ id: stripeTarget.itemId, price: stripeTarget.priceId }],
    proration_behavior: 'create_prorations',
  });

  return { updated: true, stripe: 'subscription_updated', billing: stripeTarget.billing };
}

async function grantTrial(stripe, userId, days) {
  const email = await getUserEmail(userId);
  if (!email) throw new Error('User not found');

  const customer = await findCustomer(stripe, email);
  if (!customer) throw new Error('No Stripe customer found for this user');

  const subscriptions = await stripe.subscriptions.list({
    customer: customer.id,
    status: 'active',
    limit: 1,
  });

  const subscription = subscriptions.data[0];
  if (!subscription) throw new Error('No active subscription to apply trial to');

  const trialEnd = Math.floor(Date.now() / 1000) + days * 86400;
  await stripe.subscriptions.update(subscription.id, {
    trial_end: trialEnd,
  });

  return { granted: true, trial_end: new Date(trialEnd * 1000).toISOString() };
}

async function createUser(email, password, plan, bracket) {
  validatePlanBracket(plan, bracket);
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
      app_metadata: { plan: plan || 'scout', bracket: bracket || 'b1' },
    }),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.message || 'Failed to create user');
  }
  const user = await res.json();
  return { created: true, user_id: user.id, email: user.email };
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
        const result = await cancelSubscription(stripe, params.user_id);
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
    // Validation errors are safe (and necessary) to show the admin verbatim
    if (String(err.message || '').startsWith('Invalid plan key') || String(err.message || '').startsWith('Invalid bracket key')) {
      return { statusCode: 400, body: JSON.stringify({ error: err.message }) };
    }
    return { statusCode: 500, body: JSON.stringify({ error: 'An internal error occurred' }) };
  }
};
