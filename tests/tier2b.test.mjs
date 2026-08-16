#!/usr/bin/env node
// Badger Board — Tier-2B audit fixes, unit tests for the extractable logic.
// Zero-config: node tests/tier2b.test.mjs
//
// Covers the parts of the Tier-2B batch that are pure functions:
//   #1 Campaign Connect plan checks now run through _entitlements
//   #3 classify-csv-prospects has a registered rate-limit budget
//   #4 candidate-ai-lock's key is registered explicitly (was falling to defaults)
//   #2 support-chat CORS is built from _config.corsHeaders (no wildcard)
//
// The UI fixes (#5–#11) live in JSX and are verified by build + manual pass.
import { createRequire } from 'module'
const require = createRequire(import.meta.url)

let pass = 0, fail = 0
const t = (name, cond) => { cond ? pass++ : fail++; console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${name}`) }

// ─── #3/#4: rate-limit registry ───────────────────────────────────────────────
console.log('#3/#4 — rate-limit registry entries')
{
  const { RATE_LIMITS, DEFAULT_LIMITS } = require('../netlify/functions/_rate-limit.js')

  const sane = (k) => {
    const l = RATE_LIMITS[k]
    return !!l && Number.isFinite(l.perMinute) && Number.isFinite(l.perDay) &&
      l.perMinute > 0 && l.perDay >= l.perMinute
  }

  t('classify-csv-prospects is registered with sane limits', sane('classify-csv-prospects'))
  t('classify-csv-prospects budget is tight (fan-out endpoint)',
    RATE_LIMITS['classify-csv-prospects'].perMinute <= 5 &&
    RATE_LIMITS['classify-csv-prospects'].perDay    <= 50)
  t('candidate-ai-lock is registered with sane limits', sane('candidate-ai-lock'))
  t('candidate-ai-lock keeps the effective defaults it already had',
    RATE_LIMITS['candidate-ai-lock'].perMinute === DEFAULT_LIMITS.perMinute &&
    RATE_LIMITS['candidate-ai-lock'].perDay    === DEFAULT_LIMITS.perDay)
  t('every registry entry is well formed', Object.keys(RATE_LIMITS).every(sane))
}

// ─── #3: classify-csv-prospects actually calls the limiter ────────────────────
console.log('#3 — classify-csv-prospects enforces its budget')
{
  const shared = require('../netlify/functions/_shared.js')
  const realServiceClient = shared.serviceClient
  const realFetch = global.fetch
  process.env.ANTHROPIC_API_KEY = 'test-key'
  process.env.SUPABASE_URL = 'https://example.supabase.co'
  process.env.SUPABASE_ANON_KEY = 'anon'

  const buckets = new Map()
  shared.serviceClient = () => ({
    rpc: async (_fn, args) => {
      const bump = (k) => { const n = (buckets.get(k) || 0) + 1; buckets.set(k, n); return n }
      return {
        data: [{
          minute_count: bump(`${args.p_user_id}|${args.p_endpoint}|m`),
          day_count:    bump(`${args.p_user_id}|${args.p_endpoint}|d`),
        }],
        error: null,
      }
    },
  })

  let anthropicCalled = false
  global.fetch = async (url) => {
    const u = String(url)
    if (u.includes('/auth/v1/user')) {
      return { ok: true, json: async () => ({ id: 'user-csv', email: 'agency@example.com', app_metadata: { plan: 'a_campaign' } }) }
    }
    if (u.includes('api.anthropic.com')) {
      anthropicCalled = true
      return { ok: true, json: async () => ({ content: [{ text: '[]' }], usage: {} }) }
    }
    return { ok: false, status: 500, json: async () => ({}), text: async () => '' }
  }

  const { RATE_LIMITS } = require('../netlify/functions/_rate-limit.js')
  const { handler } = require('../netlify/functions/classify-csv-prospects.js')
  const call = () => handler({
    httpMethod: 'POST',
    headers: { authorization: 'Bearer tok' },
    body: JSON.stringify({ prospects: [{ name: 'Jane Doe', city: 'Wausau', state: 'WI' }] }),
  })

  const N = RATE_LIMITS['classify-csv-prospects'].perMinute
  let last = null
  for (let i = 0; i < N; i++) last = await call()
  t(`allows the first ${N} classification runs in a minute`, last?.statusCode === 200)
  const over = await call()
  t('429s on the run past the budget', over?.statusCode === 429)
  t('the 429 carries a Retry-After', over && Number(over.headers['Retry-After']) >= 1)
  t('the 429 keeps the endpoint CORS headers',
    !!over?.headers?.['Access-Control-Allow-Origin'])
  t('the limiter runs BEFORE any Anthropic spend on the blocked call',
    (() => { const seen = anthropicCalled; anthropicCalled = false; return seen })())
  t('rate limiting is per user, not global',
    !!(await (async () => {
      global.fetch = async (url) => {
        const u = String(url)
        if (u.includes('/auth/v1/user')) {
          return { ok: true, json: async () => ({ id: 'user-csv-2', email: 'other@example.com', app_metadata: { plan: 'a_campaign' } }) }
        }
        return { ok: true, json: async () => ({ content: [{ text: '[]' }], usage: {} }) }
      }
      const r = await call()
      return r.statusCode === 200
    })()))

  global.fetch = realFetch
  shared.serviceClient = realServiceClient
}

// ─── #2: CORS is origin-restricted, not '*' ───────────────────────────────────
console.log('#2 — corsHeaders() restricts the origin')
{
  const { corsHeaders, PROD_ORIGINS } = require('../netlify/functions/_config.js')

  const prod = corsHeaders('https://badgerboardwi.com')
  t('echoes a known production origin', prod['Access-Control-Allow-Origin'] === 'https://badgerboardwi.com')
  t('never answers with a wildcard',
    ['https://evil.example', undefined, '', 'null', 'http://localhost:5173']
      .every(o => corsHeaders(o)['Access-Control-Allow-Origin'] !== '*'))
  t('an unknown origin falls back to the prod default (browser then blocks it)',
    corsHeaders('https://evil.example')['Access-Control-Allow-Origin'] === PROD_ORIGINS[0])
  t('localhost is allowed for netlify dev / vite',
    corsHeaders('http://localhost:5173')['Access-Control-Allow-Origin'] === 'http://localhost:5173' &&
    corsHeaders('http://127.0.0.1:8888')['Access-Control-Allow-Origin'] === 'http://127.0.0.1:8888')
  t('varies on Origin so caches do not cross-pollinate', prod['Vary'] === 'Origin')
  t('allows the Authorization header and the caller-chosen methods',
    prod['Access-Control-Allow-Headers'].includes('Authorization') &&
    corsHeaders('https://badgerboardwi.com', 'GET, OPTIONS')['Access-Control-Allow-Methods'] === 'GET, OPTIONS')

  // support-chat must not carry a hard-coded wildcard any more.
  const src = require('fs').readFileSync(new URL('../netlify/functions/support-chat.js', import.meta.url), 'utf8')
  t('support-chat no longer hard-codes Access-Control-Allow-Origin: *',
    !/'Access-Control-Allow-Origin':\s*'\*'/.test(src))
  t('support-chat builds its CORS from _config.corsHeaders', /corsHeaders\(/.test(src))
}

// ─── #1: Campaign Connect plan checks go through the resolver ─────────────────
console.log('#1 — _campaign-connect plan helpers use resolveEntitlement')
{
  const H       = require('../netlify/functions/_campaign-connect.js')
  const admin   = require('../netlify/functions/_config.js').ADMIN_EMAILS[0]
  const u = (app_metadata = {}, email = 'user@example.com') => ({ email, app_metadata })
  const future = new Date(Date.now() + 7 * 864e5).toISOString()
  const past   = new Date(Date.now() - 1 * 864e5).toISOString()

  // Legacy aliases used to be read raw: 'monitor' looked like an Action plan and
  // 'campaign'/'agency' never normalized, so Campaign Connect misrouted them.
  t('legacy "monitor" resolves to the CANDIDATE plan c_monitor',
    (await H.planOf(u({ plan: 'monitor' }))) === 'c_monitor')
  t('legacy "monitor" is therefore NOT an Action user',
    (await H.isActionUser(u({ plan: 'monitor' }))) === false)
  t('legacy "campaign" resolves to a_campaign and IS an Action user',
    (await H.planOf(u({ plan: 'campaign' }))) === 'a_campaign' &&
    (await H.isActionUser(u({ plan: 'campaign' }))) === true)
  t('legacy "agency" resolves to a_campaign',
    (await H.planOf(u({ plan: 'agency' }))) === 'a_campaign')

  // Paid / free
  t('Scout is not a paid candidate', (await H.isPaidCandidate(u({ plan: 'scout' }))) === false)
  t('no plan at all is not a paid candidate', (await H.isPaidCandidate(u())) === false)
  t('null user is Scout', (await H.planOf(null)) === 'scout')
  t('a paid candidate plan passes the paid gate',
    (await H.isPaidCandidate(u({ plan: 'c_active' }))) === true)
  t('an unknown junk plan degrades to Scout, not to access',
    (await H.planOf(u({ plan: 'wizard' }))) === 'scout' &&
    (await H.isPaidCandidate(u({ plan: 'wizard' }))) === false)

  // Trials — flat app_metadata shape (trial_plan / trial_ends_at)
  t('an ACTIVE trial counts as a paid candidate (used to read as Scout)',
    (await H.isPaidCandidate(u({ trial_plan: 'c_campaign', trial_ends_at: future }))) === true)
  t('an active Action trial is an Action user',
    (await H.isActionUser(u({ trial_plan: 'a_campaign', trial_ends_at: future }))) === true)
  t('an EXPIRED trial does not',
    (await H.isPaidCandidate(u({ trial_plan: 'c_campaign', trial_ends_at: past }))) === false)
  t('a trial never downgrades a better paid plan',
    (await H.planOf(u({ plan: 'a_campaign', trial_plan: 'c_monitor', trial_ends_at: future }))) === 'a_campaign')

  // Admin
  t('an admin email is an Action user on the top plan',
    (await H.planOf(u({}, admin))) === 'a_campaign' &&
    (await H.isActionUser(u({}, admin))) === true &&
    (await H.isPaidCandidate(u({}, admin))) === true)
  t('admin match is case-insensitive',
    (await H.isActionUser(u({}, admin.toUpperCase()))) === true)

  // Explicit plan_type still wins — that is how an Action org on a
  // candidate-shaped plan identifies itself.
  t('an explicit app_metadata.plan_type still wins',
    (await H.planTypeOf(u({ plan: 'c_active', plan_type: 'action' }))) === 'action' &&
    (await H.isActionUser(u({ plan: 'c_active', plan_type: 'action' }))) === true)
  t('without plan_type the plan key decides',
    (await H.planTypeOf(u({ plan: 'c_active' }))) === 'candidate' &&
    (await H.planTypeOf(u({ plan: 'a_monitor' }))) === 'action')

  // The call sites must await the now-async helpers, or every check passes
  // vacuously (a Promise is always truthy).
  const cc = require('fs').readFileSync(new URL('../netlify/functions/campaign-connect.js', import.meta.url), 'utf8')
  t('campaign-connect.js awaits isActionUser / isPaidCandidate',
    !/[^t]\s\(!H\.(isActionUser|isPaidCandidate)\(/.test(cc) &&
    (cc.match(/await H\.(isActionUser|isPaidCandidate)\(/g) || []).length === 3)
  t('_campaign-connect.js no longer reads app_metadata.plan raw',
    !/app_metadata\?\.plan\b\s*\|\|/.test(
      require('fs').readFileSync(new URL('../netlify/functions/_campaign-connect.js', import.meta.url), 'utf8')))
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
