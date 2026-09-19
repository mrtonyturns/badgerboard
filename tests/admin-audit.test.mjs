#!/usr/bin/env node
// Badger Board — ADMIN SECTION contract audit (v1.41).
//
// The admin panel's failure mode is not "it crashes", it is "it says it worked".
// Every regression this file guards was a button that reported success while
// doing nothing, or reported a hardcoded failure while the backend had a real
// answer. So the assertions are deliberately structural:
//
//   §1  every action string the UI sends exists as a case in its backend
//   §2  every response key the UI reads is produced by that backend
//   §3  pure-helper unit tests (errText, isStaleProbeUser, mergePayload)
//   §4  regression guards, one per finding, citing the symptom
//
// Zero-config, no network, no env:  node tests/admin-audit.test.mjs

import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const src  = (p) => readFileSync(join(ROOT, p), 'utf8')
const fn   = (f) => src(join('netlify/functions', f))

let pass = 0, fail = 0
const t = (name, cond, detail) => {
  cond ? pass++ : fail++
  console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${name}`)
  if (!cond && detail !== undefined) console.log(`      ${detail}`)
}
const eq = (name, got, want) => t(name, JSON.stringify(got) === JSON.stringify(want),
  `got ${JSON.stringify(got)} · want ${JSON.stringify(want)}`)

// Same loader trick as r1c/r2c/r3c: pure helpers live inside a .jsx page, so the
// page brackets them with sentinels and we import the slice as a real module.
async function loadPureBlock(file, tag) {
  const s = src(file)
  const a = s.indexOf(`${tag} PURE HELPERS BEGIN`)
  const b = s.indexOf(`${tag} PURE HELPERS END`)
  if (a < 0 || b < 0 || b < a) throw new Error(`${file}: ${tag} pure-helper sentinels missing`)
  const block = s.slice(s.indexOf('\n', a) + 1, s.lastIndexOf('\n', b))
  if (/^\s*import\s/m.test(block)) throw new Error(`${file}: pure block must not import`)
  return import('data:text/javascript;base64,' + Buffer.from(block, 'utf8').toString('base64'))
}

const UI = src('src/pages/AdminDashboard.jsx')
const F = {
  dashboard: fn('admin-dashboard.js'),
  billing:   fn('admin-billing.js'),
  access:    fn('admin-manage-access.js'),
  coupons:   fn('manage-coupons.js'),
  audit:     fn('run-security-audit.js'),
  del:       fn('delete-account.js'),
  setTier:   fn('admin-set-tier.js'),
  offices:   fn('admin-offices.js'),
  appMeta:   fn('_app-metadata.js'),
}

// ── helpers that read the sources ────────────────────────────────────────────
/** Action strings the UI sends through a given helper, e.g. apiCall('users'). */
const uiActions = (helper) => {
  const out = new Set()
  const re = new RegExp(`${helper}\\(\\s*'([a-z_]+)'`, 'g')
  for (const m of UI.matchAll(re)) out.add(m[1])
  return [...out].sort()
}
/** `case 'x':` labels in a backend switch. */
const backendCases = (source) => {
  const out = new Set()
  for (const m of source.matchAll(/case\s+'([a-z_]+)'\s*:/g)) out.add(m[1])
  return out
}
/** `action === 'x'` branches (manage-coupons has no switch). */
const backendEqActions = (source) => {
  const out = new Set()
  for (const m of source.matchAll(/action\s*===\s*'([a-z_]+)'/g)) out.add(m[1])
  return out
}

console.log('\n═══ §1 — every UI action exists in its backend ═══')

{
  const cases = backendCases(F.dashboard)
  const actions = uiActions('apiCall')
  t('UI sends at least the core admin-dashboard actions', actions.length >= 10, actions.join(', '))
  for (const a of actions) {
    t(`admin-dashboard implements "${a}"`, cases.has(a),
      `AdminDashboard.jsx calls apiCall('${a}') but admin-dashboard.js has no case '${a}' — it would 400 "Unknown action" while the UI toasts success`)
  }
  // these were silently missing before and are the ones the table depends on
  for (const a of ['users', 'user_activity', 'get_notes', 'add_note', 'send_reset', 'toggle_payment', 'error_logs', 'resolve_error'])
    t(`admin-dashboard still implements "${a}"`, cases.has(a))
}

{
  const cases = backendCases(F.billing)
  const actions = uiActions('billingCall')
  for (const a of actions) {
    t(`admin-billing implements "${a}"`, cases.has(a),
      `AdminDashboard.jsx calls billingCall('${a}') with no matching case in admin-billing.js`)
  }
  t('admin-billing keeps update_plan as a change_plan alias', cases.has('change_plan') && cases.has('update_plan'))
}

{
  const cases = backendCases(F.access)
  const actions = uiActions('accessCall')
  for (const a of actions) {
    t(`admin-manage-access implements "${a}"`, cases.has(a),
      `AdminDashboard.jsx calls accessCall('${a}') with no matching case in admin-manage-access.js`)
  }
  // added recently — the UI wires all four
  for (const a of ['mute_emails', 'unmute_emails', 'reset_to_free', 'set_beta'])
    t(`admin-manage-access still implements "${a}"`, cases.has(a))
}

{
  const impl = backendEqActions(F.coupons)
  const used = new Set()
  for (const m of UI.matchAll(/couponCall\(\s*\{[^}]*action:\s*'([a-z_]+)'/g)) used.add(m[1])
  // the toggle passes a computed action: pc.active ? 'deactivate' : 'reactivate'
  for (const m of UI.matchAll(/const action = pc\.active \? '([a-z_]+)' : '([a-z_]+)'/g)) { used.add(m[1]); used.add(m[2]) }
  t('Coupons tab uses list/create/deactivate/reactivate', used.size >= 4, [...used].join(', '))
  for (const a of used) {
    t(`manage-coupons implements "${a}"`, impl.has(a),
      `CouponsTab sends action '${a}' but manage-coupons.js has no branch for it`)
  }
  t('manage-coupons reactivate branch is symmetric with deactivate',
    /action === 'deactivate' \|\| action === 'reactivate'/.test(F.coupons) && /const active = action === 'reactivate'/.test(F.coupons))
}

console.log('\n═══ §2 — every response key the UI reads is produced ═══')

{
  // users payload → the Accounts table + Billing sidebar render these
  const produced = /return\s*\{[\s\S]*?beta_mode: u\.app_metadata\?\.beta_mode === true,/.test(F.dashboard)
  t('users payload maps beta_mode as a strict === true boolean', produced,
    'a null beta_mode (how _app-metadata.js removes the key) must read as false, or "turn beta off" keeps showing Beta')
  for (const key of ['emails_muted', 'last_sign_in_at', 'resolved_plan', 'plan_source', 'payment_status', 'trial_plan', 'trial_ends_at', 'bracket'])
    t(`users payload produces "${key}" (read by the Accounts table)`, new RegExp(`\\b${key}:`).test(F.dashboard))

  t('UI reads payment_status (not the nonexistent u.status) for the Status badge',
    /u\.payment_status === 'past_due'/.test(UI))
}

{
  // get_subscription → Subscription Details panel
  for (const key of ['subscription_id', 'status', 'plan_name', 'current_period_end', 'cancel_at_period_end', 'cancel_at'])
    t(`get_subscription produces "${key}"`, new RegExp(`\\b${key}:`).test(F.billing))
  t('the panel reads subscriptionData.cancel_at_period_end', /subscriptionData\.cancel_at_period_end/.test(UI))
  t('the panel reads subscriptionData.subscription_id', /subscriptionData\.subscription_id/.test(UI))

  // cancel_subscription → the new two-mode contract
  for (const key of ['cancelled', 'metadata_cleared', 'message', 'mode'])
    t(`cancel_subscription produces "${key}"`, new RegExp(`\\b${key}:`).test(F.billing))
  t('the cancel handler reads result.message / cancelled / metadata_cleared',
    /result\?\.message/.test(UI) && /result\?\.cancelled \|\| result\?\.metadata_cleared/.test(UI))

  // portal_link / payment_history
  t('portal_link produces { url } and the UI reads data.url', /return \{ url: session\.url \}/.test(F.billing) && /data\?\.url/.test(UI))
  t('payment_history produces { invoices } and the UI reads history.invoices',
    /return \{ invoices: history \}/.test(F.billing) && /history\?\.invoices/.test(UI))
  t('payment rows use amount/status/date, the keys paymentHistory emits',
    /payment\.amount/.test(UI) && /payment\.status/.test(UI) && /payment\.date/.test(UI))

  // change_plan `stripe:` note map. The direction that matters is
  // backend → UI: a value the backend emits but the UI does not map renders as
  // a bare "Plan set to X." with no word about whether billing actually moved.
  const emitted = new Set()
  for (const m of F.billing.matchAll(/stripe: '([a-z_]+)'/g)) emitted.add(m[1])
  for (const m of F.billing.matchAll(/stripe: [^\n]*\? '([a-z_]+)' : '([a-z_]+)'/g)) { emitted.add(m[1]); emitted.add(m[2]) }
  t('change_plan emits a recognisable set of stripe states', emitted.size >= 4, [...emitted].join(', '))
  for (const n of emitted)
    t(`the UI explains stripe:"${n}" to the admin`, UI.includes(`${n}:`),
      `admin-billing returns stripe:"${n}" but AdminDashboard's stripeNote map has no entry for it`)
}

{
  // error logs
  t('error_logs produces user_email (read by the search + row)', /user_email:/.test(F.dashboard) && /e\.user_email/.test(UI))
  // announcements
  t('announcements response is { announcements }', /JSON\.stringify\(\{ announcements \}\)/.test(F.dashboard) && /data\?\.announcements/.test(UI))
  // security audit
  t('run-security-audit returns results + summary{passed,failed,total}',
    /summary: \{ passed, failed, total: results\.length \}/.test(F.audit) && /data\.summary\.failed/.test(UI))
  t('run-security-audit reports purged_probe_accounts and the UI shows it',
    /purged_probe_accounts/.test(F.audit) && /purged_probe_accounts/.test(UI))
  // coupons
  t('manage-coupons list returns { promoCodes } and the UI reads json.promoCodes',
    /promoCodes: result/.test(F.coupons) && /json\.promoCodes/.test(UI))
}

console.log('\n═══ §3 — pure helper unit tests ═══')

{
  const { errText } = await loadPureBlock('src/pages/AdminDashboard.jsx', 'ADMIN_AUDIT')

  eq('errText unwraps the JSON error body the fetch helpers throw',
    errText(new Error('{"error":"No active subscription found"}')), 'No active subscription found')
  eq('errText unwraps a JSON "message" too',
    errText(new Error('{"message":"boom"}')), 'boom')
  eq('errText passes plain text straight through',
    errText(new Error('Network request failed')), 'Network request failed')
  eq('errText falls back when the body has no usable message',
    errText(new Error('{"ok":true}'), 'Failed to cancel'), 'Failed to cancel')
  eq('errText falls back on an empty message',
    errText(new Error(''), 'Failed to cancel'), 'Failed to cancel')
  eq('errText accepts a bare string', errText('{"error":"nope"}'), 'nope')
  t('errText truncates a runaway body', errText(new Error('x'.repeat(5000))).length <= 400)
}

{
  const { isStaleProbeUser } = await import(join(ROOT, 'netlify/functions/run-security-audit.js'))
  const NOW = Date.parse('2026-09-19T12:00:00Z')
  const old = '2026-09-19T10:00:00Z'      // 2h ago
  const fresh = '2026-09-19T11:59:00Z'    // 1m ago

  t('an old sectest- probe on badger-test.invalid is swept',
    isStaleProbeUser({ email: 'sectest-a-123@badger-test.invalid', created_at: old }, NOW))
  t('a probe from the CURRENT run is never swept',
    !isStaleProbeUser({ email: 'sectest-a-123@badger-test.invalid', created_at: fresh }, NOW))
  t("the local suite's ftesta- accounts are left alone",
    !isStaleProbeUser({ email: 'ftesta-123@badger-test.invalid', created_at: old }, NOW))
  t('a real customer is never swept',
    !isStaleProbeUser({ email: 'sectest-a-1@gmail.com', created_at: old }, NOW))
  t('a lookalike domain is never swept',
    !isStaleProbeUser({ email: 'sectest-a-1@evil-badger-test.invalid.com', created_at: old }, NOW))
  t('a row with no created_at is never swept',
    !isStaleProbeUser({ email: 'sectest-a-1@badger-test.invalid' }, NOW))
}

{
  const { mergePayload } = await import(join(ROOT, 'netlify/functions/_app-metadata.js'))
  eq('mergePayload sends a deleted key as null (Supabase PUT merges)',
    mergePayload({ plan: 'c_active', beta_mode: true }, { plan: 'c_active' }),
    { plan: 'c_active', beta_mode: null })
  eq('mergePayload leaves an unchanged object alone',
    mergePayload({ plan: 'scout' }, { plan: 'scout' }), { plan: 'scout' })
}

console.log('\n═══ §4 — regression guards (one per audit finding) ═══')

// ── LEAD #1: cancel_subscription ────────────────────────────────────────────
t('#1a cancel resolves the customer by stored stripe ids, not email alone',
  /stripe_customer_id/.test(F.billing) && /stripe_subscription_id/.test(F.billing) && /resolveCustomerIds/.test(F.billing))
t('#1a the old email-only findCustomer() helper is gone',
  !/^async function findCustomer\(/m.test(F.billing),
  'findCustomer(stripe,email) with limit:1 was the root cause of "Customer not found" on renamed accounts')
t('#1b cancel covers every cancellable status, not just active',
  /CANCELLABLE_STATUSES = \['active', 'trialing', 'past_due', 'unpaid', 'paused', 'incomplete'\]/.test(F.billing))
t('#1b subscription lookups use status: \'all\' and filter locally',
  /status: 'all'/.test(F.billing) && !/status: 'active', limit: 1/.test(F.billing))
t('#1c an immediate cancel really calls stripe.subscriptions.cancel',
  /stripe\.subscriptions\.cancel\(subscription\.id\)/.test(F.billing))
t('#1c end-of-period cancel is still available as a mode',
  /mode === 'period_end'/.test(F.billing) && /cancel_at_period_end: true/.test(F.billing))
t('#1c the handler passes the mode through, defaulting to period_end',
  /cancelSubscription\(stripe, params\.user_id, params\.mode \|\| 'period_end'\)/.test(F.billing))
t('#1c the UI offers both cancels as labelled buttons',
  /CancelSubscriptionModal/.test(UI) && /onCancelNow/.test(UI) && /onCancelAtPeriodEnd/.test(UI))
t('#1c immediate cancel mirrors stripe-webhook customer.subscription.deleted',
  /meta\.plan = 'scout'/.test(F.billing) && /meta\.payment_status = 'inactive'/.test(F.billing) &&
  /meta\.downgraded_at = Date\.now\(\)/.test(F.billing) && /meta\.stripe_subscription_id = null/.test(F.billing))
{
  // the mirror must invent NO key the webhook does not write
  const webhook = fn('stripe-webhook.js')
  for (const k of ['plan', 'plan_type', 'payment_status', 'downgraded_at', 'stripe_subscription_id'])
    t(`#1c "${k}" is a key stripe-webhook.js already writes`, new RegExp(`\\b${k}\\b`).test(webhook))
}
t('#1d an account with no Stripe subscription clears the plan metadata instead of throwing',
  /no_subscription: true/.test(F.billing) && /metadata_cleared: true/.test(F.billing))
t('#1d the fallback clears the same keys as admin-manage-access reset_to_free', (() => {
  const keys = ['plan', 'plan_type', 'bracket', 'beta_mode', 'trial_plan', 'trial_bracket',
    'trial_started_at', 'trial_ends_at', 'trial_granted_by', 'trial_warning_sent']
  const listed = /FREE_RESET_KEYS = \[([\s\S]*?)\]/.exec(F.billing)?.[1] || ''
  return keys.every(k => listed.includes(`'${k}'`) && F.access.includes(`delete meta.${k}`))
})())
t('#1d "Customer not found" is no longer thrown by the cancel path',
  !/throw new Error\('Customer not found'\)/.test(F.billing))
t('#1e the UI surfaces the backend error text verbatim',
  /showToast\(errText\(err, 'Failed to cancel subscription'\), 'error'\)/.test(UI))
t('#1e the UI refetches BOTH the subscription panel and the users list',
  /billingCall\('cancel_subscription'[\s\S]{0,700}?billingCall\('get_subscription'[\s\S]{0,300}?refreshSelectedUser\(\)/.test(UI))
t('#1e cancel_at_period_end state is shown with its end date',
  /Cancellation scheduled/.test(UI) && /subscriptionData\.cancel_at \|\| subscriptionData\.current_period_end/.test(UI))
t('#1e the Cancel button disables while the call is in flight',
  /disabled=\{cancelBusy\}/.test(UI))

// ── #2 error surfacing ──────────────────────────────────────────────────────
t('#2 admin-billing returns deliberate errors verbatim instead of a blanket 500',
  /if \(err\?\.expose\)/.test(F.billing) && /class BillingError/.test(F.billing))
t('#2 admin-billing surfaces Stripe\'s own message', /String\(err\.type\)\.startsWith\('Stripe'\)/.test(F.billing))
t('#2 admin-dashboard exposes AdminError messages', /class AdminError/.test(F.dashboard) && /if \(err\?\.expose\)/.test(F.dashboard))
t('#2 manage-coupons surfaces Stripe errors', /function stripeErrorResponse/.test(F.coupons) &&
  !/manage-coupons list error[\s\S]{0,120}An internal error occurred/.test(F.coupons))
t('#2 no admin handler still hardcodes "Network error —"', !/Network error — could not/.test(UI))
{
  // every catch in the admin page must go through errText, not a bare string
  const bad = [...UI.matchAll(/catch \(err\) \{\s*console\.error\(err\)\s*showToast\('Failed to [^']+', 'error'\)/g)]
  t('#2 no catch block toasts a hardcoded "Failed to …" without errText', bad.length === 0,
    bad.map(m => m[0].replace(/\s+/g, ' ')).join(' | '))
}

// ── LEAD #2: beta / trial / reset display ───────────────────────────────────
t('#3 set_beta deletes the key (so _app-metadata sends null) rather than writing false',
  /if \(enabled\) meta\.beta_mode = true\s*\n\s*else delete meta\.beta_mode/.test(F.access))
t('#3 admin-manage-access routes every write through the diffing helper',
  /require\('\.\/_app-metadata'\)/.test(F.access) && !/method: 'PUT'[\s\S]{0,200}app_metadata: meta/.test(F.access))
t('#3 the beta toggle refetches the users list before rendering the new state',
  /accessCall\('set_beta'[\s\S]{0,200}?await refreshSelectedUser\(\)/.test(UI))
t('#3 grant_trial / revoke_trial refetch the users list too',
  /accessCall\('grant_trial'[\s\S]{0,400}?await refreshSelectedUser\(\)/.test(UI) &&
  /accessCall\('revoke_trial'[\s\S]{0,200}?await refreshSelectedUser\(\)/.test(UI))
t('#3 mute/unmute and reset_to_free refetch the users list',
  /accessCall\(muting \? 'mute_emails' : 'unmute_emails'[\s\S]{0,200}?apiCall\('users'\)/.test(UI) &&
  /accessCall\('reset_to_free'[\s\S]{0,200}?apiCall\('users'\)/.test(UI))
t('#3 the Beta badge reads the boolean the API sends', /\{u\.beta_mode &&/.test(UI))

// ── #4 other writers of app_metadata in scope ───────────────────────────────
t('#4 admin-billing change_plan routes through updateAppMetadata (deletions persist)',
  /import \{ updateAppMetadata \} from '\.\/_app-metadata\.js'/.test(F.billing) &&
  /await updateAppMetadata\(userId, \(meta\) => \{[\s\S]{0,400}?meta\.plan = plan/.test(F.billing))
t('#4 change_plan writes plan_type, like every other writer',
  /meta\.plan_type = planTypeFor\(planKey\)/.test(F.billing))
t('#4 change_plan removes bracket when moving to a candidate plan',
  /if \(bracket\) meta\.bracket = bracket;\s*\n\s*else delete meta\.bracket;/.test(F.billing))
t('#4 admin-billing no longer does a raw merging PUT of app_metadata',
  !/body: JSON\.stringify\(\{ app_metadata: updatedMetadata \}\)/.test(F.billing))
t('#4 create_user only stamps a bracket on Action plans',
  /if \(isAction\) appMetadata\.bracket = bracket \|\| 'b1'/.test(F.billing))
t('#4 admin-set-tier still uses the diffed PUT', /putAppMetadataDiff/.test(F.setTier))

// ── #5 Account Management ───────────────────────────────────────────────────
t('#5 the payment lock button no longer reads the nonexistent u.status',
  !/u\.status !== 'active'/.test(UI),
  'u.status is undefined in the users payload, so the button always showed Unlock and always sent lock:false')
t('#5 the Notes modal actually loads notes via get_notes',
  /apiCall\('get_notes'/.test(UI) && /notes\.map\(/.test(UI))
t('#5 notes render the account_notes column name (note), not a phantom .text',
  /note\.note \?\? note\.text/.test(UI))
t('#5 a muted address does not report "Reset email sent"',
  /res\?\.suppressed/.test(UI) && /suppressed: true/.test(F.dashboard))
t('#5 the bulk send_reset counts a suppressed address as a failure',
  /if \(res\?\.suppressed\) throw new Error/.test(UI))
t('#5 row-level access actions disable while pending',
  (UI.match(/disabled=\{accessPending\.has\(u\.id\)\}/g) || []).length >= 3)
t('#5 the Change Plan modal clears its saving flag on failure',
  /try \{ await onSave\(plan, isAction \? bracket : null\) \}\s*\n\s*finally \{ setSaving\(false\) \}/.test(UI))
t('#5 the Add User panel no longer promises a welcome email that is never sent',
  !/They'll receive a welcome email/.test(UI) && /no email is sent/.test(UI))
t('#5 a manually created user refreshes the accounts list', /await onCreated\?\.\(\)/.test(UI))

// ── #6 delete-account ───────────────────────────────────────────────────────
t('#6 delete-account cancels every cancellable status, not just active',
  /CANCELLABLE = \['active', 'trialing', 'past_due', 'unpaid', 'paused', 'incomplete'\]/.test(F.del))
t('#6 delete-account aborts rather than orphaning billing it could not cancel',
  /statusCode: 502/.test(F.del) && /has NOT been deleted/.test(F.del))
t('#6 a free account is no longer 503\'d just because STRIPE_SECRET_KEY is unset',
  /if \(!stripeKey && billingMarkers\)/.test(F.del),
  'the old unconditional 503 disabled the admin Delete button platform-wide when the key was missing')
t('#6 the Stripe cancellation block is skipped when there is no client',
  /if \(stripe\) try \{/.test(F.del))
t('#6 admin accounts still cannot be deleted through this endpoint',
  /Admin accounts cannot be deleted through this endpoint/.test(F.del))

// ── #7 security audit probe cleanup ─────────────────────────────────────────
t('#7 a failed setup deletes the probe users it already created',
  /catch \(e\) \{\s*\n\s*if \(userAId\) await deleteTestUser\(userAId\)/.test(F.audit),
  'the old code returned early after creating user A — that is the sectest- leak')
t('#7 each run sweeps probe accounts leaked by an earlier timed-out run',
  /purgeStaleProbeUsers\(\)/.test(F.audit))
t('#7 the sweep is scoped to this function\'s own prefix and domain',
  /PROBE_PREFIX  = 'sectest-'/.test(F.audit) && /domain !== 'badger-test\.invalid'/.test(F.audit))
t('#7 the sweep never touches an in-flight run', /STALE_MINUTES = 30/.test(F.audit))
t('#7 the finally block still deletes both probes', /if \(userAId\) await deleteTestUser\(userAId\)\s*\n\s*if \(userBId\) await deleteTestUser\(userBId\)/.test(F.audit))

// ── #8 pagination / capping ─────────────────────────────────────────────────
t('#8 getAllUsers pages until a short page (not capped at one page)',
  /per_page=1000&page=\$\{page\}/.test(F.dashboard) && /if \(batch\.length < 1000\) break/.test(F.dashboard))
t('#8 error-log email enrichment reuses the paginated getAllUsers',
  /for \(const u of await getAllUsers\(\)\)/.test(F.dashboard) && !/admin\/users\?per_page=500/.test(F.dashboard),
  'the single per_page=500 page meant any user past #500 showed as a bare UUID in Error Logs')

// ── #9 admin-only auth on every function ────────────────────────────────────
{
  const guards = [
    ['admin-dashboard.js',     F.dashboard, /ADMIN_EMAILS\.includes\(user\?\.email\?\.toLowerCase\(\)\)/],
    ['admin-billing.js',       F.billing,   /ADMIN_EMAILS\.includes\(user\?\.email\?\.toLowerCase\(\)\)/],
    ['admin-manage-access.js', F.access,    /ADMIN_EMAILS\.includes\(user\?\.email\?\.toLowerCase\(\)\)/],
    ['manage-coupons.js',      F.coupons,   /ADMIN_EMAILS\.includes\(user\?\.email\?\.toLowerCase\(\)\)/],
    ['run-security-audit.js',  F.audit,     /ADMIN_EMAILS\.includes\(user\.email\?\.toLowerCase\(\)\)/],
    ['admin-set-tier.js',      F.setTier,   /ADMIN_EMAILS\.includes\(user\?\.email\?\.toLowerCase\(\)\)/],
    ['admin-offices.js',       F.offices,   /requireAdmin\(event\)/],
  ]
  for (const [name, source, re] of guards) t(`#9 ${name} checks the admin allow-list`, re.test(source))
  t('#9 delete-account gates non-self deletion on ADMIN_EMAILS',
    /caller\.id !== userId && !ADMIN_EMAILS\.includes\(caller\.email\?\.toLowerCase\(\)\)/.test(F.del))
  // the guard must run BEFORE the action switch in each one
  for (const [name, source] of [['admin-dashboard.js', F.dashboard], ['admin-billing.js', F.billing], ['admin-manage-access.js', F.access]]) {
    const guardAt = source.indexOf('verifyAdmin(')
    const switchAt = source.indexOf('switch (action)')
    t(`#9 ${name} verifies admin before dispatching any action`, guardAt > -1 && guardAt < switchAt)
  }
  t('#9 the admin page itself redirects non-admins', /ADMIN_EMAILS\.includes\(user\.email\.toLowerCase\(\)\)/.test(UI) && /navigate\('\/'\)/.test(UI))
  t('#9 the Security Audit tab sends a bearer token', /Authorization: `Bearer \$\{session\?\.access_token\}`/.test(UI))
}

// ── #10 misc ────────────────────────────────────────────────────────────────
t('#10 manage-coupons fails cleanly when STRIPE_SECRET_KEY is missing',
  /if \(!process\.env\.STRIPE_SECRET_KEY\) \{/.test(F.coupons),
  'new Stripe(undefined) throws outside every try block — a bare 502 with no JSON body')
t('#10 the announcement body is sanitized server-side as well as in the UI',
  /function sanitizeAnnouncementMessage/.test(F.dashboard) && /sanitizeAnnouncementHtml/.test(UI))
t('#10 the announcement card double-sanitizes before dangerouslySetInnerHTML',
  /sanitizeAnnouncementDisplay\(sanitizeAnnouncementHtml\(announcement\.message\)\)/.test(UI))
t('#10 admin-offices validates against the real CHECK constraint values',
  /VALID_LEVELS = \['federal', 'state', 'county', 'municipal'\]/.test(F.offices))

console.log(`\n${fail === 0 ? '✓ ALL PASS' : '✗ FAILURES'} — ${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
