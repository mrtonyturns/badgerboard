#!/usr/bin/env node
// Badger Board — functions sweep: behaviour tests for the October 2026
// Netlify-functions bug sweep (dossier IDOR + test-mode gate, poller precinct
// regression, win-odds missing inputs, Haiku pricing), plus source-slice
// assertions for the handlers that can't run without a live Supabase.
//
// Network is never touched: handlers run against a routed fake `fetch`.
//
// Zero-config: node tests/functions-sweep.test.mjs

import { createRequire } from 'module'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
const require = createRequire(import.meta.url)

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const src  = (p) => readFileSync(join(ROOT, p), 'utf8')

let pass = 0, fail = 0
const t = (name, cond) => { cond ? pass++ : fail++; console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${name}`) }

// ─── win-odds: missing inputs are unmeasured, not zero ───────────────────────
console.log('_win-odds — null / undefined / "" inputs')
{
  const { computeWinOdds } = require('../netlify/functions/_win-odds.js')
  const factor = (o, k) => o.factors.find(f => f.key === k)

  const nulls = computeWinOdds({ is_incumbent: true, contested: true, district_lean: null, primary_margin: null })
  t('district_lean null → factor unavailable (was scored as an even 0-pt seat)',
    factor(nulls, 'district_lean').available === false)
  t('primary_margin null → factor unavailable', factor(nulls, 'primary_margin').available === false)

  const blank = computeWinOdds({ is_incumbent: true, district_lean: '', primary_margin: '  ' })
  t('"" / whitespace inputs are unmeasured too',
    factor(blank, 'district_lean').available === false && factor(blank, 'primary_margin').available === false)

  const fallback = computeWinOdds({ primary_margin: null, primary_won: true })
  t('primary_margin null no longer blocks the primary_won fallback',
    factor(fallback, 'primary_margin').available === true && factor(fallback, 'primary_margin').value === 0.65)

  const zero = computeWinOdds({ district_lean: 0, primary_margin: 0 })
  t('a real 0 is still a measured value',
    factor(zero, 'district_lean').available === true && factor(zero, 'primary_margin').value === 0.5)

  const withNull = computeWinOdds({ is_incumbent: true, district_lean: null })
  const without  = computeWinOdds({ is_incumbent: true })
  t('confidence is not inflated by a null input', withNull.confidence === without.confidence)
}

// ─── poller: precincts_total can't shrink under a monotonic rptg ─────────────
console.log('election-results-poller — validateContestUpdate precincts')
{
  const { validateContestUpdate } = require('../netlify/functions/election-results-poller.js')
  const { determineStatus } = require('../netlify/functions/_determination.js')
  const existing = {
    office: 'Assembly District 87',
    results: [{ id: 'r1', candidate_name: 'Ann Able', votes: 4000 }, { id: 'r2', candidate_name: 'Bob Baker', votes: 3000 }],
    precincts_total: 100,
    precincts_rptg: 80,
  }
  const payload = (over = {}) => ({
    office: 'Assembly District 87',
    candidates: [{ name: 'Ann Able', votes: 4100 }, { name: 'Bob Baker', votes: 3050 }],
    source: 'County clerk (https://example.com)',
    ...over,
  })

  const shrink = validateContestUpdate(payload({ precincts_total: 50, precincts_reporting: 50 }), existing)
  const p = shrink.precincts || { precincts_rptg: 80, precincts_total: 100 }
  t('a lower reported total keeps the stored total', p.precincts_total === 100)
  t('rptg never ends above total', p.precincts_rptg <= p.precincts_total)
  t('the shrink is noted', shrink.notes.some(n => /below the stored 100/.test(n)))
  t('votes still apply when the total is refused', shrink.ok === true && shrink.updates.length === 2)
  const status = determineStatus({
    results: [{ votes: 4100 }, { votes: 3050 }], precinctsTotal: p.precincts_total, precinctsRptg: p.precincts_rptg,
  }).status
  t('no false "called" from a shrunken total (was rptg 80 ≥ total 50)', status !== 'called')

  const zeroTotal = validateContestUpdate(payload({ precincts_total: 0, precincts_reporting: 90 }), existing)
  t('a reported total of 0 also keeps the stored total',
    zeroTotal.precincts && zeroTotal.precincts.precincts_total === 100 && zeroTotal.precincts.precincts_rptg === 90)

  const grow = validateContestUpdate(payload({ precincts_total: 120, precincts_reporting: 90 }), existing)
  t('a higher total is still accepted', grow.precincts && grow.precincts.precincts_total === 120 && grow.precincts.precincts_rptg === 90)

  const bad = validateContestUpdate(payload({ precincts_reporting: 70 }), { ...existing, precincts_rptg: 130 })
  t('the monotonic floor is clamped to total (stored rptg 130 > total 100)',
    bad.precincts && bad.precincts.precincts_rptg === 100)
}

// ─── _ai-usage: Haiku 4.5 pricing ────────────────────────────────────────────
console.log('_ai-usage — Haiku 4.5 price')
{
  const { priceFor } = require('../netlify/functions/_ai-usage.js')
  const h = priceFor('claude-haiku-4-5-20251001')
  t('Haiku 4.5 is $1 in / $5 out per MTok', h.in === 1.00 && h.out === 5.00)
}

// ─── generate-dossier / -background: candidate ownership + test gate ─────────
console.log('generate-dossier — IDOR guard and admin-only test mode')
{
  process.env.SUPABASE_URL = 'https://supa.test'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc-test'
  process.env.ANTHROPIC_API_KEY = 'test-key'
  process.env.URL = 'https://site.test'

  // Rate limiter → always allow (no Postgres)
  const shared = require('../netlify/functions/_shared.js')
  shared.serviceClient = () => ({ rpc: async () => ({ data: [{ minute_count: 1, day_count: 1 }], error: null }) })

  const calls = []
  let ownsCandidate = false
  const realFetch = globalThis.fetch
  const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  globalThis.fetch = async (url) => {
    const u = String(url)
    calls.push(u)
    if (u.endsWith('/auth/v1/user')) return reply(200, { id: 'user-1', email: 'member@example.com', app_metadata: { plan: 'c_campaign' } })
    if (u.includes('/rest/v1/candidates')) return reply(200, ownsCandidate ? [{ id: 'cand-1' }] : [])
    if (u.includes('generate-dossier-background')) return reply(202, {})
    if (u.includes('api.anthropic.com') || u.includes('perplexity') || u.includes('x.ai')) return reply(500, { error: 'should not be called' })
    return reply(200, [])
  }

  const { handler } = require('../netlify/functions/generate-dossier.js')
  const post = (body, auth = 'Bearer good') => handler({ httpMethod: 'POST', headers: { authorization: auth }, body: JSON.stringify(body) })
  const candidate = { name: 'Victim Candidate' }

  calls.length = 0; ownsCandidate = false
  const idor = await post({ candidate, candidate_id: 'cand-1' })
  t('someone else\'s candidate_id → 404', idor.statusCode === 404)
  t('ownership is checked against created_by = caller',
    calls.some(u => u.includes('/rest/v1/candidates') && u.includes('created_by=eq.user-1')))
  t('nothing is forwarded to the background worker', !calls.some(u => u.includes('generate-dossier-background')))

  calls.length = 0; ownsCandidate = true
  const owned = await post({ candidate, candidate_id: 'cand-1' })
  t('own candidate → 200 and forwarded', owned.statusCode === 200 && calls.some(u => u.includes('generate-dossier-background')))

  calls.length = 0; ownsCandidate = false
  const noId = await post({ candidate })
  t('no candidate_id → no ownership lookup, still allowed',
    noId.statusCode === 200 && !calls.some(u => u.includes('/rest/v1/candidates')))

  calls.length = 0
  const testAnon = await handler({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ test: true, deep: true }) })
  t('test mode without auth → 401 (ran before auth)', testAnon.statusCode === 401)
  const testUser = await post({ test: true, deep: true })
  t('test mode as a non-admin → 401, no model call',
    testUser.statusCode === 401 && !calls.some(u => u.includes('api.anthropic.com')))
  t('test mode response leaks no key prefix', !String(testUser.body).includes('key_prefix'))

  // Background worker, invoked directly with a user JWT
  const bg = require('../netlify/functions/generate-dossier-background.js')
  calls.length = 0; ownsCandidate = false
  const bgIdor = await bg.handler({
    httpMethod: 'POST', headers: {},
    body: JSON.stringify({ candidate, candidate_id: 'cand-1', auth_header: 'Bearer good' }),
  })
  t('background: someone else\'s candidate_id → 404', bgIdor.statusCode === 404)
  t('background: no research/LLM call before the 404',
    !calls.some(u => /anthropic|perplexity|x\.ai/.test(u)))

  globalThis.fetch = realFetch
}

// ─── source-slice checks (handlers that need a live Supabase) ────────────────
console.log('source checks — share links, reviews, seed, GHL')
{
  const share = src('netlify/functions/create-dossier-share.js')
  t('share cap ignores expired links', /is_active=eq\.true&expires_at=gt\./.test(share))

  const getShared = src('netlify/functions/get-shared-dossier.js')
  t('list ownership no longer requires generated_by', !/generated_by=eq\.\$\{user\.id\}/.test(getShared))
  t('list ownership falls back to the candidate owner', /candidates'.*created_by=eq\.\$\{user\.id\}/.test(getShared))
  t('view_count PATCH is awaited', /await supa\(\s*`dossier_shares\?id=eq\.\$\{share\.id\}`/.test(getShared))

  const review = src('netlify/functions/dossier-review.js')
  const SECTION_ID = /^[\w-]{1,64}$/
  t('section_id is a short slug, not a UUID',
    review.includes('const SECTION_ID = /^[\\w-]{1,64}$/') && !review.includes('!UUID.test(section_id)') &&
    SECTION_ID.test('section-6') && SECTION_ID.test('overview') && !SECTION_ID.test('a&b=c'))
  t('claim lookup is an exact eq., not like.', /claim_text=eq\./.test(review) && !/claim_text=like\./.test(review))
  t('save_review PATCH result is checked', /const upd = await supabaseQuery[\s\S]{0,200}if \(!upd\.ok\)/.test(review))

  const reviewer = src('src/pages/profiler/ClaimReviewer.jsx')
  t('ClaimReviewer checks res.ok before marking saved',
    /if \(!res\.ok\)[\s\S]*throw new Error\(msg\)[\s\S]*setSavedIds\(prev => new Set\(\[\.\.\.prev, claim\.id\]\)\)/.test(reviewer))

  const seed = src('netlify/functions/seed-wi-offices.js')
  t('seed never res.json()s a possibly-empty body', !/const result = await res\.json\(\)/.test(seed))

  const ghl = src('netlify/functions/ghl-webhook.js')
  t('GHL user lookup paginates', /listUsers\(\{ page, perPage: PER_PAGE \}\)/.test(ghl) && /users\.length < PER_PAGE/.test(ghl))
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
