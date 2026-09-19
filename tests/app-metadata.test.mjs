// tests/app-metadata.test.mjs — the merge-semantics regression (v1.40.0).
// Supabase's admin PUT merges app_metadata; deleted keys must be sent as null.
import { createRequire } from 'module'
import { readFileSync } from 'fs'
const require = createRequire(import.meta.url)
const { mergePayload } = require('../netlify/functions/_app-metadata.js')

let pass = 0, fail = 0
const t = (name, ok) => { ok ? pass++ : fail++; console.log(`  ${ok ? '✓' : '✗ FAIL'} ${name}`) }

{
  const before = { plan: 'c_campaign', beta_mode: true, trial_plan: 'c_campaign', trial_ends_at: '2026-08-20', provider: 'email' }
  const after = { ...before }
  delete after.trial_plan; delete after.trial_ends_at; delete after.beta_mode
  const p = mergePayload(before, after)
  t('deleted keys are sent as explicit null', p.trial_plan === null && p.trial_ends_at === null && p.beta_mode === null)
  t('kept keys pass through unchanged', p.plan === 'c_campaign' && p.provider === 'email')
  t('no key from before is silently omitted', Object.keys(before).every(k => k in p))
}
{
  const p = mergePayload({ a: 1 }, { a: 1, b: 2 })
  t('added keys are included', p.b === 2 && p.a === 1)
  t('nothing spurious is nulled', !('c' in p))
}
{
  const p = mergePayload(undefined, { x: 1 })
  t('tolerates missing before', p.x === 1)
}

// Every metadata writer that deletes keys must go through the diffing helper.
const fn = (f) => readFileSync(new URL(`../netlify/functions/${f}`, import.meta.url), 'utf8')
t('admin-manage-access uses the shared helper', /require\('\.\/_app-metadata'\)/.test(fn('admin-manage-access.js')) && !/body: JSON\.stringify\(\{ app_metadata: meta \}\)/.test(fn('admin-manage-access.js')))
t('trial-expiry uses the diffed PUT', /putAppMetadataDiff/.test(fn('trial-expiry.js')) && !/body: JSON\.stringify\(\{ app_metadata: meta \}\)/.test(fn('trial-expiry.js')))
t('admin-set-tier uses the diffed PUT', /putAppMetadataDiff/.test(fn('admin-set-tier.js')))
t('every sender consults the suppression list', ['_email.js', 'monitoring-digest.js', 'admin-dashboard.js', 'dossier-review.js', 'invite-volunteer.js', 'payment-webhook.js'].every(f => /isEmailSuppressed/.test(fn(f))))
t('admin-manage-access exposes mute/unmute/reset actions', ['mute_emails', 'unmute_emails', 'reset_to_free'].every(a => fn('admin-manage-access.js').includes(`case '${a}'`)))

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
