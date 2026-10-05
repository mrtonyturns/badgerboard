#!/usr/bin/env node
// Badger Board — billing sweep 2: stripe-webhook past_due grace period,
// out-of-order subscription events, 404-vs-5xx user reads; checkout refuses a
// second live subscription; self-serve upgrade bills immediately and surfaces
// a declined proration as 402; immediate cancels invoice pending prorations.
//
// Same harness as billing-sweep.test.mjs: the real handlers run against a
// mocked global.fetch, and Stripe resource methods are stubbed on the
// prototype every client shares (the CJS and ESM builds are separate module
// instances, so both are patched).
//
// Zero-config: node tests/billing-sweep-2.test.mjs

import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const src  = (p) => readFileSync(join(ROOT, p), 'utf8')

let pass = 0, fail = 0
const t = (name, cond) => { cond ? pass++ : fail++; console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${name}`) }

process.env.SUPABASE_URL              = 'https://sb.test'
process.env.SUPABASE_ANON_KEY         = 'anon'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service'
process.env.STRIPE_SECRET_KEY         = 'sk_test_dummy'
process.env.STRIPE_WEBHOOK_SECRET     = 'whsec_test_dummy'
process.env.RESEND_API_KEY            = 're_test_dummy'

const UID = '33333333-3333-4333-8333-333333333333'

// ── Mock fetch ───────────────────────────────────────────────────────────────
let state
function reset(over = {}) {
  state = { userStatus: 200, meta: {}, puts: [], emails: [], deletes: 0, live: {}, retrieves: [], sessions: [], updates: [], updateError: null, ...over }
}
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) })
global.fetch = async (url, opts = {}) => {
  const u = String(url), method = opts.method || 'GET'
  if (u.includes('/rest/v1/stripe_webhook_events')) {
    if (method === 'DELETE') state.deletes++
    return json(201, {})
  }
  if (u.includes('/rest/v1/')) return json(200, [])
  if (u.includes('api.resend.com')) { state.emails.push(JSON.parse(opts.body)); return json(200, { id: 'em' }) }
  if (u.endsWith('/auth/v1/user')) return json(200, { id: UID, email: 'buyer@example.com', app_metadata: state.meta })
  if (u.includes('/auth/v1/admin/users/')) {
    if (method === 'PUT') { state.puts.push(JSON.parse(opts.body).app_metadata); return json(200, {}) }
    return state.userStatus === 200
      ? json(200, { id: UID, email: 'buyer@example.com', app_metadata: state.meta })
      : json(state.userStatus, { msg: 'nope' })
  }
  return json(404, {})
}

// ── Stripe stubs (both module builds) ────────────────────────────────────────
const missing = () => Object.assign(new Error('No such subscription'), { code: 'resource_missing', statusCode: 404 })
function stubStripe(S) {
  const c = new S('sk_test_dummy')
  Object.getPrototypeOf(c.subscriptions).retrieve = async (id) => {
    state.retrieves.push(id)
    if (!(id in state.live)) throw missing()
    return { id, status: state.live[id], customer: 'cus_1' }
  }
  Object.getPrototypeOf(c.subscriptions).list = async () => ({ data: [{ id: 'sub_1', status: 'active', items: { data: [{ id: 'si_1' }] } }] })
  Object.getPrototypeOf(c.subscriptions).update = async (id, params) => {
    state.updates.push({ id, params })
    if (state.updateError) throw state.updateError
    return { id }
  }
  Object.getPrototypeOf(c.customers).retrieve = async (id) => ({ id })
  Object.getPrototypeOf(c.customers).list = async () => ({ data: [] })
  Object.getPrototypeOf(c.checkout.sessions).create = async (p) => { state.sessions.push(p); return { url: 'https://checkout.test/s' } }
  return c
}
const StripeCjs = require('stripe')
const stripeSdk = stubStripe(StripeCjs)
stubStripe((await import('stripe')).default)

const { handler: webhook } = require('../netlify/functions/stripe-webhook.js')
let evtN = 0
async function deliver(type, object) {
  const payload = JSON.stringify({ id: `evt_s2_${++evtN}`, type, data: { object } })
  const sig = stripeSdk.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET })
  return webhook({ httpMethod: 'POST', headers: { 'stripe-signature': sig }, body: payload })
}
const PRICE_A = 'price_1TvXzjHGi9vK03buU5NMpJo7'   // c_active monthly (v2)
const sub = (over = {}) => ({
  id: 'sub_1', customer: 'cus_1', status: 'active',
  metadata: { supabase_user_id: UID, plan: 'c_active', billing: 'monthly' },
  items: { data: [{ price: { id: PRICE_A } }] },
  ...over,
})
const onFile = { plan: 'c_active', stripe_subscription_id: 'sub_1', payment_status: 'active' }

console.log('1 — past_due honours Stripe\'s retry window')
{
  reset({ meta: { ...onFile } })
  let r = await deliver('customer.subscription.updated', sub({ status: 'past_due' }))
  t('past_due → 200', r.statusCode === 200)
  t('past_due → plan still synced', state.puts.length === 1 && state.puts[0].plan === 'c_active')
  t('past_due → payment_status NOT set to past_due (first failure keeps access)', state.puts[0]?.payment_status === 'active')

  reset({ meta: { ...onFile, payment_status: 'past_due' } })
  await deliver('customer.subscription.updated', sub({ status: 'past_due' }))
  t('past_due during an attempt-2 lock → lock NOT cleared', state.puts[0]?.payment_status === 'past_due')

  reset({ meta: { ...onFile } })
  await deliver('customer.subscription.updated', sub({ status: 'unpaid' }))
  t('unpaid → locks (payment_status past_due)', state.puts[0]?.payment_status === 'past_due')

  reset({ meta: { ...onFile, payment_status: 'past_due', downgraded_at: 5 } })
  await deliver('customer.subscription.updated', sub({ status: 'active' }))
  t('active → restores', state.puts[0]?.payment_status === 'active' && state.puts[0]?.downgraded_at === null)

  reset({ meta: { ...onFile } })
  await deliver('invoice.payment_failed', { customer: 'cus_1', attempt_count: 1, parent: { subscription_details: { metadata: { supabase_user_id: UID } } } })
  t('invoice.payment_failed attempt 1 → no lock write', !state.puts.some(p => p.payment_status === 'past_due'))
  reset({ meta: { ...onFile } })
  await deliver('invoice.payment_failed', { customer: 'cus_1', attempt_count: 2, parent: { subscription_details: { metadata: { supabase_user_id: UID } } } })
  t('invoice.payment_failed attempt 2 → locks', state.puts.some(p => p.payment_status === 'past_due'))
}

console.log('2 — late subscription.updated cannot resurrect a deleted subscription')
{
  for (const status of ['canceled', 'incomplete_expired']) {
    reset({ meta: { plan: 'scout', stripe_subscription_id: null, payment_status: 'inactive' } })
    const r = await deliver('customer.subscription.updated', sub({ status }))
    t(`${status} snapshot → 200, no plan write`, r.statusCode === 200 && state.puts.length === 0)
  }

  reset({ meta: { plan: 'scout', stripe_subscription_id: null } })
  await deliver('customer.subscription.updated', sub({ status: 'past_due' }))
  t('non-active sub not on file → ignored', state.puts.length === 0)

  // Active snapshot (e.g. cancel-at-period-end toggle) delivered after deletion
  reset({ meta: { plan: 'scout', stripe_subscription_id: null, payment_status: 'inactive' }, live: { sub_1: 'canceled' } })
  await deliver('customer.subscription.updated', sub({ status: 'active' }))
  t('stale active snapshot, live sub canceled → no plan write', state.puts.length === 0)
  t('…and Stripe was consulted', state.retrieves.includes('sub_1'))

  // Brand-new sub whose updated beats checkout.session.completed
  reset({ meta: { plan: 'scout' }, live: { sub_1: 'active' } })
  await deliver('customer.subscription.updated', sub({ status: 'active' }))
  t('new live sub not yet on file → plan written', state.puts[0]?.plan === 'c_active' && state.puts[0]?.stripe_subscription_id === 'sub_1')

  reset({ meta: { ...onFile } })
  await deliver('customer.subscription.updated', sub())
  t('sub on file → no Stripe round-trip', state.retrieves.length === 0 && state.puts.length === 1)
}

console.log('3 — subscription.deleted: 5xx retries, 404 acknowledges, old subs ignored')
{
  reset({ userStatus: 503, meta: { ...onFile, voluntary_downgrade: true } })
  let r = await deliver('customer.subscription.deleted', sub())
  t('5xx user read → 500 (Stripe retries)', r.statusCode === 500)
  t('5xx user read → no lockout written', state.puts.length === 0)
  t('5xx user read → idempotency row released', state.deletes === 1)

  reset({ userStatus: 404 })
  r = await deliver('customer.subscription.deleted', sub())
  t('404 (account deleted) → 200, no retry storm', r.statusCode === 200)
  t('404 → nothing written', state.puts.length === 0)

  reset({ meta: { ...onFile, voluntary_downgrade: true, stripe_subscription_id: null } })
  await deliver('customer.subscription.deleted', sub())
  t('voluntary downgrade still Scout in good standing', state.puts[0]?.plan === 'scout' && state.puts[0]?.payment_status === 'active')

  reset({ meta: { ...onFile } })
  await deliver('customer.subscription.deleted', sub())
  t('involuntary cancel still locks', state.puts[0]?.plan === 'scout' && state.puts[0]?.payment_status === 'inactive')

  reset({ meta: { ...onFile, stripe_subscription_id: 'sub_new' }, live: { sub_new: 'active' } })
  await deliver('customer.subscription.deleted', sub({ id: 'sub_old' }))
  t('old sub ends while another live sub is on file → no downgrade', state.puts.length === 0)

  reset({ meta: { ...onFile, stripe_subscription_id: 'sub_gone' } })
  await deliver('customer.subscription.deleted', sub())
  t('stale stored id (missing in Stripe) → downgrade proceeds', state.puts[0]?.plan === 'scout')

  reset({ userStatus: 404 })
  r = await deliver('customer.subscription.updated', sub())
  t('subscription.updated for a deleted account → 200, no write', r.statusCode === 200 && state.puts.length === 0)

  reset({ userStatus: 503 })
  r = await deliver('customer.subscription.updated', sub())
  t('subscription.updated 5xx read → 500', r.statusCode === 500 && state.puts.length === 0)
}

// ── create-checkout-session ─────────────────────────────────────────────────
console.log('4 — checkout refuses a second live subscription')
{
  const { handler: checkout } = await import('../netlify/functions/create-checkout-session.js')
  const call = (body) => checkout({ httpMethod: 'POST', headers: { authorization: 'Bearer tok' }, body: JSON.stringify(body) })
  const plan = { plan: 'c_active', billing: 'monthly' }

  for (const status of ['active', 'trialing', 'past_due']) {
    reset({ meta: { plan: 'c_monitor', stripe_subscription_id: 'sub_1' }, live: { sub_1: status } })
    const r = await call(plan)
    t(`${status} sub on file → 409`, r.statusCode === 409 && JSON.parse(r.body).code === 'subscription_exists')
    t(`${status} → no Checkout session created`, state.sessions.length === 0)
  }

  reset({ meta: { plan: 'scout', stripe_subscription_id: 'sub_1' }, live: { sub_1: 'canceled' } })
  let r = await call(plan)
  t('canceled sub on file → checkout proceeds', r.statusCode === 200 && state.sessions.length === 1)

  reset({ meta: { plan: 'scout', stripe_subscription_id: 'sub_stale' } })
  r = await call(plan)
  t('stored id missing in Stripe → checkout proceeds', r.statusCode === 200)

  reset({ meta: { plan: 'scout' } })
  r = await call(plan)
  t('no sub on file → checkout proceeds without a lookup', r.statusCode === 200 && state.retrieves.length === 0)

  reset({ meta: { plan: 'c_active', stripe_subscription_id: 'sub_1' }, live: { sub_1: 'active' } })
  r = await call({ product: 'credits', pack: 'c5' })
  t('credit pack with a live sub → still allowed (payment mode)', r.statusCode === 200 && state.sessions[0]?.mode === 'payment')
}

// ── update-subscription ─────────────────────────────────────────────────────
console.log('5 — self-serve plan change bills the proration now')
{
  const { handler: upd } = await import('../netlify/functions/update-subscription.js')
  const call = () => upd({ httpMethod: 'POST', headers: { authorization: 'Bearer tok' }, body: JSON.stringify({ plan: 'c_campaign', billing: 'monthly' }) })

  reset({ meta: { plan: 'c_active', stripe_customer_id: 'cus_1' } })
  let r = await call()
  const p = state.updates[0]?.params || {}
  t('200 on success', r.statusCode === 200)
  t('proration_behavior always_invoice', p.proration_behavior === 'always_invoice')
  t('payment_behavior error_if_incomplete (pending_if_incomplete rejects metadata)', p.payment_behavior === 'error_if_incomplete')

  reset({ meta: { plan: 'c_active', stripe_customer_id: 'cus_1' }, updateError: Object.assign(new Error('Your card was declined.'), { type: 'StripeCardError', statusCode: 402, code: 'card_declined' }) })
  r = await call()
  const body = JSON.parse(r.body)
  t('declined proration → 402', r.statusCode === 402)
  t('402 explains the plan was not changed', /not changed/.test(body.error) && body.code === 'card_declined')

  reset({ meta: { plan: 'c_active', stripe_customer_id: 'cus_1' }, updateError: new Error('boom') })
  t('other Stripe errors stay 500', (await call()).statusCode === 500)
}

console.log('6 — admin change + immediate cancels')
{
  const ab = src('netlify/functions/admin-billing.js')
  t('admin change_plan: always_invoice', /items: \[\{ id: stripeTarget\.itemId[\s\S]{0,80}proration_behavior: 'always_invoice'/.test(ab))
  t('admin change_plan: no blocking payment_behavior', !/payment_behavior:/.test(ab))
  t('no create_prorations left in billing writers',
    ['admin-billing.js', 'update-subscription.js'].every(f => !/proration_behavior:\s*'create_prorations'/.test(src(`netlify/functions/${f}`))))
  t('admin immediate cancel invoices pending items', /subscriptions\.cancel\(subscription\.id, \{ invoice_now: true, prorate: false \}\)/.test(ab))
  t('downgrade-to-free invoices pending items', /subscriptions\.cancel\(sub\.id, \{ invoice_now: true, prorate: false \}\)/.test(src('netlify/functions/downgrade-to-free.js')))
  const del = src('netlify/functions/delete-account.js')
  t('delete-account cancels WITHOUT invoice_now', /subscriptions\.cancel\(sub\.id, \{ prorate: false \}\)/.test(del) && !/invoice_now: true/.test(del))
}

console.log('7 — admin-stripe-setup never reuses another bracket\'s price')
{
  const s = src('netlify/functions/admin-stripe-setup.js')
  const start = s.indexOf('async function getOrCreatePrice(')
  const fn = new Function(`return (${s.slice(start, s.indexOf('\n}\n', start) + 2)})`)()
  const monthly = { interval: 'month', interval_count: 1 }
  const old = { id: 'price_old_b6', unit_amount: 12900, currency: 'usd', recurring: monthly, metadata: { plan_key: 'a_monitor', bracket: 'b6', billing: 'monthly' } }
  let created = null
  const fake = (rows) => ({
    prices: {
      list: () => ({ autoPagingToArray: async () => rows }),
      create: async (p) => { created = p; return { id: 'price_new', ...p } },
    },
  })
  let r = await fn(fake([old]), 'prod', 12900, monthly, 'nick', { plan_key: 'a_monitor', bracket: 'b2_5', billing: 'monthly' })
  t('same amount, different bracket → new price minted', r.created === true && created?.metadata?.bracket === 'b2_5')
  r = await fn(fake([old]), 'prod', 12900, monthly, 'nick', { plan_key: 'a_monitor', bracket: 'b6', billing: 'monthly' })
  t('exact plan/bracket/billing/amount → reused', r.created === false && r.price.id === 'price_old_b6')
  r = await fn(fake([{ ...old, metadata: { plan_key: 'c_active', billing: 'monthly' } }]), 'prod', 12900, monthly, 'n', { plan_key: 'c_active', billing: 'monthly' })
  t('candidate (no bracket) still matches', r.created === false)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
