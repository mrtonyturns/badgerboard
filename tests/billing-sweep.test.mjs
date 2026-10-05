#!/usr/bin/env node
// Badger Board — billing sweep: stripe-webhook (plan-updated email gating,
// voluntary-downgrade flag clear + PUT check, credit read-failure guard),
// update-subscription / cancel-at-period-end / create-portal-session
// (stored stripe_customer_id resolution, cancel_at_period_end reset),
// create-checkout-session (verified email, success_url), Pricing.jsx redirect,
// payment-webhook (500 on failed write), trial-expiry (emails settled before
// return).
//
// Behaviour tests run the real handlers against a mocked global.fetch (the
// webhook is signed with the Stripe SDK's own test-header helper, so no
// network). The Stripe-SDK-backed endpoints can't be driven without a live
// Stripe, so their resolveCustomerIds() is sliced out and run against a fake
// client, plus source assertions for the rest.
//
// Zero-config: node tests/billing-sweep.test.mjs

import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const src  = (p) => readFileSync(join(ROOT, p), 'utf8')

let pass = 0, fail = 0
const t = (name, cond) => { cond ? pass++ : fail++; console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${name}`) }

// Env must be set before _email.js / trial-expiry.js load (read at module scope)
process.env.SUPABASE_URL              = 'https://sb.test'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service'
process.env.STRIPE_SECRET_KEY         = 'sk_test_dummy'
process.env.STRIPE_WEBHOOK_SECRET     = 'whsec_test_dummy'
process.env.RESEND_API_KEY            = 're_test_dummy'
process.env.PAYMENT_WEBHOOK_SECRET    = 'pw_test_dummy'

const UID = '22222222-2222-4222-8222-222222222222'

// ── Mock fetch ───────────────────────────────────────────────────────────────
let state
function reset(over = {}) {
  state = { userStatus: 200, putStatus: 200, meta: {}, puts: [], emails: [], deletes: 0, emailDelay: 0, users: null, ...over }
}
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) })
global.fetch = async (url, opts = {}) => {
  const u = String(url), method = opts.method || 'GET'
  if (u.includes('/rest/v1/stripe_webhook_events')) {
    if (method === 'DELETE') state.deletes++
    return json(201, {})
  }
  if (u.includes('/rest/v1/')) return json(200, [])   // prefs, suppressions
  if (u.includes('api.resend.com')) {
    if (state.emailDelay) await new Promise(r => setTimeout(r, state.emailDelay))
    state.emails.push(JSON.parse(opts.body))
    return json(200, { id: 'em_' + state.emails.length })
  }
  if (u.includes('/auth/v1/admin/users?')) return json(200, { users: state.users || [] })
  if (u.includes('/auth/v1/admin/users/')) {
    if (method === 'PUT') {
      state.puts.push(JSON.parse(opts.body).app_metadata)
      return json(state.putStatus, {})
    }
    return state.userStatus === 200
      ? json(200, { id: UID, email: 'buyer@example.com', app_metadata: state.meta })
      : json(state.userStatus, { msg: 'unavailable' })
  }
  return json(404, {})
}

// ── stripe-webhook ───────────────────────────────────────────────────────────
const Stripe = require('stripe')
const stripeSdk = new Stripe('sk_test_dummy')
const { handler: webhook } = require('../netlify/functions/stripe-webhook.js')
let evtN = 0
async function deliver(type, object, previous_attributes) {
  const payload = JSON.stringify({ id: `evt_test_${++evtN}`, type, data: { object, ...(previous_attributes ? { previous_attributes } : {}) } })
  const sig = stripeSdk.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET })
  return webhook({ httpMethod: 'POST', headers: { 'stripe-signature': sig }, body: payload })
}
const PRICE_A = 'price_1TvXzjHGi9vK03buU5NMpJo7'   // c_active monthly (v2)
const PRICE_B = 'price_1TvXzlHGi9vK03bu0KQriS7E'   // c_campaign monthly (v2)
const sub = (price, meta = {}) => ({
  id: 'sub_1', customer: 'cus_1', status: 'active',
  metadata: { supabase_user_id: UID, plan: 'c_active', billing: 'monthly', ...meta },
  items: { data: [{ price: { id: price }, current_period_end: 2000 }] },
})
const planEmails = () => state.emails.filter(e => /plan has been updated/.test(e.subject)).length

console.log('1 — subscription.updated only emails on a real plan change')
{
  reset()
  let r = await deliver('customer.subscription.updated', sub(PRICE_A), { items: { data: [{ price: { id: PRICE_A }, current_period_end: 1000 }] }, latest_invoice: 'in_old' })
  t('renewal (items in previous_attributes, same price) → 200', r.statusCode === 200)
  t('renewal → no "plan updated" email', planEmails() === 0)
  t('renewal still syncs app_metadata', state.puts.length === 1)

  reset()
  await deliver('customer.subscription.updated', { ...sub(PRICE_A), cancel_at_period_end: true }, { cancel_at_period_end: false })
  t('cancel-at-period-end toggle → no email', planEmails() === 0)

  reset()
  await deliver('customer.subscription.updated', { ...sub(PRICE_A), status: 'past_due' }, { status: 'active' })
  t('past_due transition → no email', planEmails() === 0)

  reset()
  await deliver('customer.subscription.updated', sub(PRICE_B, { plan: 'c_campaign' }), { items: { data: [{ price: { id: PRICE_A } }] }, metadata: { plan: 'c_active' } })
  t('price change → exactly one email', planEmails() === 1)

  reset()
  await deliver('customer.subscription.updated', sub(PRICE_A, { plan: 'c_campaign' }), { metadata: { plan: 'c_active' } })
  t('metadata plan change alone → email', planEmails() === 1)

  reset()
  await deliver('customer.subscription.updated', sub(PRICE_A), { metadata: { billing: 'annual' } })
  t('unrelated metadata change → no email', planEmails() === 0)
}

console.log('2 — voluntary downgrade clears the flag and checks the PUT')
{
  reset({ meta: { plan: 'c_active', voluntary_downgrade: true, stripe_customer_id: 'cus_1' } })
  let r = await deliver('customer.subscription.deleted', sub(PRICE_A))
  const put = state.puts[0] || {}
  t('200 on success', r.statusCode === 200)
  t('voluntary_downgrade sent as null (merge-safe)', Object.prototype.hasOwnProperty.call(put, 'voluntary_downgrade') && put.voluntary_downgrade === null)
  t('Scout in good standing', put.plan === 'scout' && put.payment_status === 'active')

  reset({ putStatus: 500, meta: { plan: 'c_active', voluntary_downgrade: true } })
  r = await deliver('customer.subscription.deleted', sub(PRICE_A))
  t('failed PUT → 500 so Stripe retries', r.statusCode === 500)
  t('failed PUT → idempotency row released', state.deletes === 1)
}

console.log('3 — credit purchase never recomputes from 0 on a failed user read')
{
  const session = { mode: 'payment', metadata: { product: 'credits', pack: 'c5', supabase_user_id: UID } }
  reset({ meta: { profile_credits: 7 } })
  let r = await deliver('checkout.session.completed', session)
  t('healthy read → 200', r.statusCode === 200)
  t('healthy read → balance 7 + 5 = 12', state.puts[0]?.profile_credits === 12)

  reset({ userStatus: 503 })
  r = await deliver('checkout.session.completed', session)
  t('5xx read → 500 (Stripe retries)', r.statusCode === 500)
  t('5xx read → no PUT (banked credits untouched)', state.puts.length === 0)

  reset({ userStatus: 503 })
  r = await deliver('checkout.session.completed', { mode: 'payment', metadata: { type: 'dossier_credits', dossier_credits: '3', supabase_user_id: UID } })
  t('dossier credits: 5xx read → 500, no PUT', r.statusCode === 500 && state.puts.length === 0)
}

// ── payment-webhook ──────────────────────────────────────────────────────────
console.log('4 — payment-webhook 500s when the metadata write fails')
{
  const { handler: pw } = await import('../netlify/functions/payment-webhook.js')
  const call = () => pw({ httpMethod: 'POST', headers: { 'x-webhook-secret': 'pw_test_dummy' }, body: JSON.stringify({ user_id: UID, status: 'active' }) })
  reset({ putStatus: 500 })
  t('failed PUT → 500', (await call()).statusCode === 500)
  reset()
  t('successful PUT → 200', (await call()).statusCode === 200)
}

// ── trial-expiry ─────────────────────────────────────────────────────────────
console.log('5 — trial-expiry settles its emails before returning')
{
  const { handler: trial } = require('../netlify/functions/trial-expiry.js')
  const past = new Date(Date.now() - 86400000).toISOString()
  const soon = new Date(Date.now() + 86400000).toISOString()
  reset({
    emailDelay: 30,
    users: [
      { id: 'u1', email: 'expired@example.com', app_metadata: { trial_plan: 'c_active', trial_ends_at: past } },
      { id: 'u2', email: 'soon@example.com',    app_metadata: { trial_plan: 'c_active', trial_ends_at: soon } },
    ],
  })
  const r = await trial()
  const body = JSON.parse(r.body)
  t('one expired + one warned', body.expired === 1 && body.warned === 1)
  t('both emails delivered by the time the handler returns', state.emails.length === 2)
}

// ── Stored stripe_customer_id resolution ─────────────────────────────────────
console.log('6 — billing endpoints prefer app_metadata.stripe_customer_id')
function sliceResolver(file) {
  const s = src(file)
  const start = s.indexOf('async function resolveCustomerIds(')
  const end = s.indexOf('\n}\n', start)
  if (start < 0 || end < 0) return null
  return new Function(`return (${s.slice(start, end + 2)})`)()
}
for (const file of ['update-subscription.js', 'cancel-at-period-end.js', 'create-portal-session.js']) {
  const resolve = sliceResolver(`netlify/functions/${file}`)
  t(`${file}: resolveCustomerIds present`, typeof resolve === 'function')
  if (!resolve) continue
  const fake = (customers) => ({
    customers: {
      retrieve: async (id) => { if (!customers[id]) throw new Error('No such customer'); return customers[id] },
      list: async ({ email }) => ({ data: Object.values(customers).filter(c => !c.deleted && c.email === email) }),
    },
  })
  const caller = { app_metadata: { stripe_customer_id: 'cus_stored' } }
  // Email changed by support: Stripe still has the old address
  let ids = await resolve(fake({ cus_stored: { id: 'cus_stored', email: 'old@example.com' } }), caller, 'new@example.com')
  t(`${file}: stored id found after an email change`, ids[0] === 'cus_stored')
  ids = await resolve(fake({ cus_stored: { id: 'cus_stored', deleted: true }, cus_new: { id: 'cus_new', email: 'new@example.com' } }), caller, 'new@example.com')
  t(`${file}: deleted stored customer skipped → email fallback`, ids[0] === 'cus_new' && !ids.includes('cus_stored'))
  ids = await resolve(fake({ cus_new: { id: 'cus_new', email: 'new@example.com' } }), caller, 'new@example.com')
  t(`${file}: unknown stored id → email fallback`, ids.length === 1 && ids[0] === 'cus_new')
  ids = await resolve(fake({ cus_new: { id: 'cus_new', email: 'new@example.com' } }), {}, 'new@example.com')
  t(`${file}: no stored id → email lookup`, ids[0] === 'cus_new')
}
{
  const upd = src('netlify/functions/update-subscription.js')
  const call = upd.slice(upd.indexOf('stripe.subscriptions.update('), upd.indexOf('console.log(`Subscription updated'))
  t('update-subscription: plan change clears scheduled cancellation', /cancel_at_period_end:\s*false/.test(call))
  for (const f of ['update-subscription.js', 'cancel-at-period-end.js', 'create-portal-session.js']) {
    t(`${f}: lookup goes through resolveCustomerIds(stripe, caller, …)`, /resolveCustomerIds\(stripe, caller, callerEmail\)/.test(src(`netlify/functions/${f}`).split('export const handler')[1] || ''))
  }
}

// ── Checkout email + success redirect ────────────────────────────────────────
console.log('7 — checkout uses the verified email and lands on the Plan pane')
{
  const co = src('netlify/functions/create-checkout-session.js')
  t('checkout: email comes from the verified user', /const email\s*=\s*authedUser\?\.email/.test(co))
  t('checkout: body.email no longer read', !/sanitize\(body\.email/.test(co))
  t('checkout: success_url → /settings/plan?billing=success', /success_url: `\$\{siteUrl\}\/settings\/plan\?billing=success&plan=\$\{plan\}/.test(co))
  t('checkout: no /settings?billing= left', !/\/settings\?billing=/.test(co))
  const pr = src('src/pages/Pricing.jsx')
  t('Pricing: in-place upgrade navigates to /settings/plan?billing=success', /navigate\('\/settings\/plan\?billing=success&plan='/.test(pr))
  t('Pricing: no /settings?billing= left', !/\/settings\?billing=/.test(pr))
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
