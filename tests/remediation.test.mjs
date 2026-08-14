#!/usr/bin/env node
// Badger Board — July 2026 remediation unit tests (C1, C2, H8)
// Zero-config: node tests/remediation.test.mjs
import { createRequire } from 'module'
const require = createRequire(import.meta.url)

let pass = 0, fail = 0
const t = (name, cond) => { cond ? pass++ : fail++; console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${name}`) }

// ─── C1: sanitizer ────────────────────────────────────────────────────────────
console.log('C1 — sanitizeHtml / escapeHtml')
const { JSDOM } = require('jsdom')
const dom = new JSDOM('')
global.window = dom.window
global.document = dom.window.document
const { sanitizeHtml, escapeHtml } = await import('../src/lib/sanitize.js')

t('strips <script>', !sanitizeHtml('<p>hi</p><script>alert(1)</script>').includes('script'))
t('strips onerror handler', !sanitizeHtml('<img src=x onerror=alert(1)>').includes('onerror'))
t('strips javascript: URI', !sanitizeHtml('<a href="javascript:alert(1)">x</a>').includes('javascript:'))
t('keeps inline styles from md converters', sanitizeHtml('<p style="margin:5px 0;">x</p>').includes('style='))
t('keeps basic formatting', sanitizeHtml('<strong>b</strong>').includes('<strong>'))
t('forces rel=noopener on links', sanitizeHtml('<a href="https://x.com" target="_blank">x</a>').includes('noopener'))
t('strips iframes', !sanitizeHtml('<iframe src="https://evil.com"></iframe>').includes('iframe'))
t('escapeHtml escapes all specials', escapeHtml(`<img src=x onerror="a('b')">&`) === '&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;&amp;')
t('escapeHtml handles null/numbers', escapeHtml(null) === '' && escapeHtml(42) === '42')

// ─── C2: generate-dossier-background requires auth ───────────────────────────
console.log('C2 — background dossier function auth')
process.env.ANTHROPIC_API_KEY = 'test-key'
delete process.env.SUPABASE_URL; delete process.env.VITE_SUPABASE_URL
const { handler } = require('../netlify/functions/generate-dossier-background.js')
const call = (body, headers = {}) => handler({ httpMethod: 'POST', headers, body: JSON.stringify(body) })

const r1 = await call({ candidate: { name: 'Test Person' } })
t('401 with no auth at all', r1.statusCode === 401)
const r2 = await call({ candidate: { name: 'Test Person' }, auth_header: 'Bearer garbage-jwt' })
t('401 with unverifiable body auth_header', r2.statusCode === 401)
const r3 = await call({ candidate: { name: 'Test Person' }, headers: {} , auth_header: 12345 })
t('401 with non-string auth_header', r3.statusCode === 401)
const r4 = await call({ test: true })
t('test mode requires auth too (was open)', r4.statusCode === 401)

// ─── H8: CSV parser ───────────────────────────────────────────────────────────
console.log('H8 — parseCsvRows')
const { parseCsvRows } = await import('../src/lib/csv.js')
t('quoted comma stays in field', JSON.stringify(parseCsvRows('a,b\n"Smith, John",2')[1]) === '["Smith, John","2"]')
t('escaped quotes', parseCsvRows('a\n"say ""hi"""')[1][0] === 'say "hi"')
t('CRLF has no trailing \\r', parseCsvRows('a,b\r\n1,2\r\n')[1][1] === '2')
t('newline inside quotes', parseCsvRows('a,b\n"line1\nline2",x')[1][0] === 'line1\nline2')
t('BOM stripped', parseCsvRows('﻿name\nx')[0][0] === 'name')
t('blank lines skipped', parseCsvRows('a\n\n1\n').length === 2)

// ─── F2: durable rate limiter helper ─────────────────────────────────────────
console.log('F2 — enforceRateLimit (mocked Postgres counter)')
{
  const shared = require('../netlify/functions/_shared.js')
  const realServiceClient = shared.serviceClient
  const buckets = new Map()
  let rpcShouldError = false
  shared.serviceClient = () => ({
    rpc: async (fn, args) => {
      if (rpcShouldError) return { data: null, error: { message: 'relation "rate_limits" does not exist' } }
      const bump = (key) => {
        const n = (buckets.get(key) || 0) + 1
        buckets.set(key, n)
        return n
      }
      const minute_count = bump(`${args.p_user_id}|${args.p_endpoint}|${args.p_minute_start}`)
      const day_count    = bump(`${args.p_user_id}|${args.p_endpoint}:day|${args.p_day_start}`)
      return { data: [{ minute_count, day_count }], error: null }
    },
  })
  const { enforceRateLimit, RATE_LIMITS } = require('../netlify/functions/_rate-limit.js')

  const N = RATE_LIMITS['support-chat'].perMinute
  let last = null
  for (let i = 0; i < N; i++) last = await enforceRateLimit('user-1', 'support-chat', { 'X-C': '1' })
  t(`allows first ${N} calls in a minute`, last === null)
  const over = await enforceRateLimit('user-1', 'support-chat', { 'X-C': '1' })
  t('429 on call N+1 within the window', over?.statusCode === 429)
  t('429 carries Retry-After <= 60s', over && Number(over.headers['Retry-After']) >= 1 && Number(over.headers['Retry-After']) <= 60)
  t('429 merges caller CORS headers', over?.headers?.['X-C'] === '1')
  t('other users unaffected', (await enforceRateLimit('user-2', 'support-chat')) === null)
  t('other endpoints unaffected', (await enforceRateLimit('user-1', 'research-swot')) === null)

  // Daily cap: pre-load the day bucket just over the limit
  const day = RATE_LIMITS['generate-dossier'].perDay
  for (let i = 0; i < day; i++) {
    buckets.forEach((v, k) => { if (k.includes('user-3|generate-dossier|')) buckets.delete(k) }) // keep minute low
    await enforceRateLimit('user-3', 'generate-dossier')
  }
  const dayOver = await enforceRateLimit('user-3', 'generate-dossier')
  t('429 when daily budget exhausted', dayOver?.statusCode === 429 && dayOver.body.includes('Daily'))

  rpcShouldError = true
  t('fails OPEN when limiter table is missing', (await enforceRateLimit('user-1', 'support-chat')) === null)
  rpcShouldError = false
  shared.serviceClient = realServiceClient
}

// ─── F3: checkout input validation → 400 before any Stripe call ──────────────
console.log('F3 — create-checkout-session validation')
{
  process.env.SUPABASE_URL = 'https://example.supabase.co'
  process.env.SUPABASE_ANON_KEY = 'anon'
  process.env.STRIPE_SECRET_KEY = 'sk_test_dummy_never_called'
  const realFetch = global.fetch
  let stripeCalled = false
  global.fetch = async (url, opts) => {
    const u = String(url)
    if (u.includes('/auth/v1/user')) {
      return { ok: true, json: async () => ({ id: '11111111-1111-4111-8111-111111111111', email: 'x@y.z' }) }
    }
    if (u.includes('stripe.com')) { stripeCalled = true }
    return { ok: false, status: 500, json: async () => ({}), text: async () => '' }
  }
  const { handler: checkout } = await import('../netlify/functions/create-checkout-session.js')
  const post = (body) => checkout({ httpMethod: 'POST', headers: { authorization: 'Bearer tok' }, body: JSON.stringify(body) })

  t('400 on missing plan',               (await post({ billing: 'monthly' })).statusCode === 400)
  t('400 on unknown plan',               (await post({ plan: 'platinum', billing: 'monthly' })).statusCode === 400)
  t('400 on free plan (scout)',          (await post({ plan: 'scout', billing: 'monthly' })).statusCode === 400)
  t('400 on bad billing period',         (await post({ plan: 'c_monitor', billing: 'weekly' })).statusCode === 400)
  t('400 on action plan without bracket',(await post({ plan: 'a_active', billing: 'monthly' })).statusCode === 400)
  t('400 on unknown bracket',            (await post({ plan: 'a_active', bracket: 'b999', billing: 'monthly' })).statusCode === 400)
  t('400 on enterprise bracket (no Stripe price)', (await post({ plan: 'a_active', bracket: 'ent', billing: 'monthly' })).statusCode === 400)
  t('400 on legacy plan without bracket',(await post({ plan: 'agency', billing: 'monthly' })).statusCode === 400)
  t('no Stripe API call was made for any invalid input', stripeCalled === false)

  // Credit packs used to have their own ungated endpoint (buy-dossier-credits.js,
  // deleted); the only purchase path now is create-checkout-session's
  // `product: 'credits'` branch, which validates the pack before the plan gate.
  t('credits: 400 on invalid pack', (await post({ product: 'credits', pack: 7 })).statusCode === 400)
  t('credits: 400 on missing pack', (await post({ product: 'credits' })).statusCode === 400)
  global.fetch = realFetch
}

// ─── F4: server-side tier gating on AI endpoints ─────────────────────────────
console.log('F4 — tier gates (403 for under-tier)')
{
  process.env.SUPABASE_URL = 'https://example.supabase.co'
  process.env.SUPABASE_ANON_KEY = 'anon'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-dummy'
  process.env.ANTHROPIC_API_KEY = 'test-key'
  const realFetch = global.fetch
  let mockPlan = 'c_monitor'
  global.fetch = async (url) => {
    const u = String(url)
    if (u.includes('/auth/v1/user')) {
      return { ok: true, status: 200, json: async () => ({ id: '22222222-2222-4222-8222-222222222222', email: 'user@example.com', app_metadata: { plan: mockPlan } }) }
    }
    return { ok: false, status: 500, json: async () => ({}), text: async () => 'mock-fail', headers: { get: () => null } }
  }
  const call = async (mod, body = {}) => {
    const { handler } = await import(mod)
    return handler({ httpMethod: 'POST', headers: { authorization: 'Bearer tok' }, body: JSON.stringify(body) })
  }

  mockPlan = 'c_monitor'
  t('discover-candidates 403 for c_monitor', (await call('../netlify/functions/discover-candidates.js', { mode: 'county', county: 'Dane' })).statusCode === 403)
  t('autofill-candidate 403 for c_monitor',  (await call('../netlify/functions/autofill-candidate.js', { name: 'X' })).statusCode === 403)
  t('generate-campaign-intel 403 for c_monitor', (await call('../netlify/functions/generate-campaign-intel.js', { candidate: { name: 'X' } })).statusCode === 403)
  t('generate-prospecting 403 for c_monitor', (await call('../netlify/functions/generate-prospecting.js', { listName: 'x' })).statusCode === 403)
  t('classify-csv-prospects 403 for c_monitor', (await call('../netlify/functions/classify-csv-prospects.js', { prospects: [{ name: 'A' }] })).statusCode === 403)

  mockPlan = 'c_active'
  t('generate-prospecting 403 even for c_active (action-plan entitlement)', (await call('../netlify/functions/generate-prospecting.js', { listName: 'x' })).statusCode === 403)
  const rDisc = await call('../netlify/functions/discover-candidates.js', { mode: 'county', county: 'Dane' })
  t('discover-candidates passes tier gate for c_active (not 401/403)', rDisc.statusCode !== 403 && rDisc.statusCode !== 401)

  mockPlan = 'a_monitor'
  const rPros = await call('../netlify/functions/generate-prospecting.js', { listName: 'x' })
  t('generate-prospecting passes tier gate for a_monitor (not 401/403)', rPros.statusCode !== 403 && rPros.statusCode !== 401)
  global.fetch = realFetch
}

// ─── F5: error-log endpoint contract ─────────────────────────────────────────
console.log('F5 — error-log contract')
{
  process.env.SUPABASE_URL = 'https://example.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-dummy'
  const realFetch = global.fetch
  let inserts = []
  global.fetch = async (url, opts) => {
    const u = String(url)
    if (u.includes('/auth/v1/user')) {
      const tok = (opts?.headers?.Authorization || '')
      if (tok.includes('good-token')) return { ok: true, json: async () => ({ id: '33333333-3333-4333-8333-333333333333' }) }
      return { ok: false, status: 401, json: async () => ({}) }
    }
    if (u.includes('/rest/v1/error_logs')) {
      inserts.push(JSON.parse(opts.body))
      return { ok: true, text: async () => '' }
    }
    return { ok: false, status: 500, text: async () => '' }
  }
  const { handler: errorLog } = await import('../netlify/functions/error-log.js')

  const r1 = await errorLog({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ error_message: 'boom' }) })
  t('unauthenticated POST with message → 200 {logged:true}', r1.statusCode === 200 && JSON.parse(r1.body).logged === true)
  t('unauthenticated write recorded with null user_id', inserts.length === 1 && inserts[0].user_id === null && inserts[0].error_message === 'boom')

  inserts = []
  const r2 = await errorLog({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ component: 'X' }) })
  t('POST missing error_message → 200, NO write', r2.statusCode === 200 && JSON.parse(r2.body).logged === true && inserts.length === 0)

  inserts = []
  const r3 = await errorLog({ httpMethod: 'POST', headers: { authorization: 'Bearer good-token' }, body: JSON.stringify({ error_message: 'authed' }) })
  t('verified token attributes user_id', r3.statusCode === 200 && inserts[0]?.user_id === '33333333-3333-4333-8333-333333333333')

  const r4 = await errorLog({ httpMethod: 'POST', headers: { authorization: 'Bearer bad' }, body: JSON.stringify({ error_message: 'x' }) })
  t('bad token still 200 (unattributed), never 401', r4.statusCode === 200)

  const r5 = await errorLog({ httpMethod: 'GET', headers: {} })
  t('GET → 405', r5.statusCode === 405)
  global.fetch = realFetch
}

// ─── Live results Phase 1: determination engine ──────────────────────────────
// SPEC: RESULTS-live-election-game-plan.md → "Determination engine".
// The engine is pure, so these are plain input/output assertions.
console.log('Phase 1 — determineStatus (contest status engine)')
{
  const { determineStatus, ALLOWED_STATUSES, THRESHOLDS } = require('../netlify/functions/_determination.js')
  // Vote rows the way election_results hands them over
  const R = (...votes) => votes.map((v, i) => ({ id: `r${i}`, candidate_name: `C${i}`, votes: v }))
  const run = (results, total, rptg, seats) =>
    determineStatus({ results, precinctsTotal: total, precinctsRptg: rptg, seats })

  // — thresholds are the ones the spec names —
  t('thresholds: recount 1.0 / fee-free 0.25 / too-close 0.5 @95%',
    THRESHOLDS.RECOUNT_PCT === 1.0 && THRESHOLDS.FEE_FREE_PCT === 0.25 &&
    THRESHOLDS.TOO_CLOSE_PCT === 0.5 && THRESHOLDS.TOO_CLOSE_REPORTING_PCT === 95)
  t('thresholds: projection needs 60% + 5 precincts, 1.5x safety factor',
    THRESHOLDS.PROJECT_MIN_REPORTING_PCT === 60 && THRESHOLDS.PROJECT_MIN_PRECINCTS === 5 &&
    THRESHOLDS.PROJECT_SAFETY_FACTOR === 1.5)

  // — waiting —
  const wNoRows = run([], 10, 0, 1)
  t('waiting: no result rows', wNoRows.status === 'waiting')
  t('waiting: zeroed rows (polls just closed)', run(R(0, 0, 0), 10, 2, 1).status === 'waiting')
  t('waiting detail carries a reason + computed_at',
    typeof wNoRows.detail.reason === 'string' && wNoRows.detail.reason.length > 0 &&
    !Number.isNaN(Date.parse(wNoRows.detail.computed_at)))

  // — reporting —
  const rep = run(R(600, 400), 10, 3, 1)
  t('reporting: 30% in, nothing decidable', rep.status === 'reporting')
  t('reporting: no ceiling computed below the 60% gate', rep.detail.outstanding_ceiling === undefined)
  t('reporting detail shape (margin/pct/total/reporting_pct)',
    rep.detail.margin === 200 && rep.detail.margin_pct === 20 &&
    rep.detail.total_votes === 1000 && rep.detail.reporting_pct === 30)

  // — projection: ceiling = (total-rptg) * (total_votes/rptg) * 1.5 —
  // 100 precincts, 80 in, 8,000 votes → ceiling = 20 * 100 * 1.5 = 3,000
  const projOver  = run(R(5501, 2499), 100, 80, 1)   // margin 3,002 > 3,000
  const projEdge  = run(R(5500, 2500), 100, 80, 1)   // margin 3,000 — NOT > ceiling
  t('projected: margin just above the outstanding ceiling', projOver.status === 'projected')
  t('projected: ceiling recorded in detail', projOver.detail.outstanding_ceiling === 3000)
  t('NOT projected: margin exactly equal to the ceiling stays reporting',
    projEdge.status === 'reporting' && projEdge.detail.outstanding_ceiling === 3000)
  t('projection gate: 60% reporting is too early for any real margin',
    run(R(9000, 1000), 100, 60, 1).status === 'reporting')
  t('projection gate: <5 precincts reporting never projects (tiny races)',
    run(R(900, 100), 6, 4, 1).status === 'reporting' &&
    run(R(900, 100), 6, 4, 1).detail.outstanding_ceiling === undefined)
  t('projection detail says "not final"', /not final/i.test(projOver.detail.reason))

  // — too close to call —
  const tc = run(R(50100, 49900), 100, 96, 1)        // 96% in, margin 0.2%
  t('too_close: >=95% reporting and margin under 0.5%', tc.status === 'too_close')
  t('too_close: 95% exactly is inside the band', run(R(50100, 49900), 100, 95, 1).status === 'too_close')
  t('too_close: margin of exactly 0.5% is NOT too close',
    run(R(50250, 49750), 100, 96, 1).status === 'reporting')
  t('too_close: 94% reporting is below the band',
    run(R(50100, 49900), 100, 94, 1).status !== 'too_close')

  // — recount band at 100% precincts —
  const rc100 = run(R(5050, 4950), 50, 50, 1)        // margin 100/10,000 = 1.00%
  const rc026 = run(R(5013, 4987), 50, 50, 1)        // margin  26/10,000 = 0.26%
  const rc025 = run(R(10025, 9975), 50, 50, 1)       // margin  50/20,000 = 0.25%
  t('recount_possible at exactly 1.0%', rc100.status === 'recount_possible' && rc100.detail.margin_pct === 1)
  t('1.0% is NOT fee-free', rc100.detail.fee_free === false)
  t('recount_possible at 0.26%', rc026.status === 'recount_possible' && rc026.detail.margin_pct === 0.26)
  t('0.26% is NOT fee-free', rc026.detail.fee_free === false)
  t('recount_possible at exactly 0.25%', rc025.status === 'recount_possible' && rc025.detail.margin_pct === 0.25)
  t('0.25% IS fee-free', rc025.detail.fee_free === true)
  t('recount reason names the Wisconsin threshold', /recount-petition threshold/i.test(rc100.detail.reason))
  t('just over 1.0% is called, not a recount',
    run(R(5051, 4949), 50, 50, 1).status === 'called')

  // — called —
  const called = run(R(6000, 4000), 50, 50, 1)
  t('called: all precincts in, 20-point margin', called.status === 'called')
  t('called: reporting_pct is 100', called.detail.reporting_pct === 100)
  t('called: no ceiling needed at 100%', called.detail.outstanding_ceiling === undefined)

  // — unopposed —
  const unop = run(R(500), 10, 10, 1)
  t('unopposed: single candidate at 100% is simply called',
    unop.status === 'called' && unop.detail.unopposed === true)
  t('unopposed 2-seat race with 2 candidates is called',
    run(R(500, 480), 10, 10, 2).status === 'called')
  t('unopposed but only 50% in is still reporting, never called',
    run(R(500), 10, 5, 1).status !== 'called')

  // — multi-seat: margin is Nth vs (N+1)th —
  const ms = run(R(1000, 800, 300, 100), 20, 20, 2)
  t('seats=2: margin measured between 2nd and 3rd place', ms.detail.margin === 500)
  t('seats=2: comfortable margin → called', ms.status === 'called')
  const msClose = run(R(1000, 500, 495, 5), 20, 20, 2)  // 2nd−3rd = 5 of 2,000 = 0.25%
  t('seats=2: thin 2nd/3rd margin → recount_possible',
    msClose.status === 'recount_possible' && msClose.detail.margin === 5 && msClose.detail.fee_free === true)
  t('seats=2: a landslide leader does NOT mask a tied 2nd seat',
    run(R(9000, 500, 499), 20, 20, 2).status === 'recount_possible')

  // — zero-precinct + garbage-input safety —
  const noPrec = run(R(600, 400), 0, 0, 1)
  t('zero precinct totals: reporting, 0% reporting_pct, no projection',
    noPrec.status === 'reporting' && noPrec.detail.reporting_pct === 0 &&
    noPrec.detail.outstanding_ceiling === undefined)
  t('precincts reporting above total is clamped to 100%',
    run(R(6000, 4000), 10, 99, 1).status === 'called' &&
    run(R(6000, 4000), 10, 99, 1).detail.reporting_pct === 100)
  t('garbage: null input → waiting/insufficient data',
    determineStatus(null).status === 'waiting' && determineStatus(null).detail.reason === 'insufficient data')
  t('garbage: undefined / string / array inputs → waiting',
    determineStatus(undefined).status === 'waiting' &&
    determineStatus('nonsense').status === 'waiting' &&
    determineStatus([1, 2, 3]).status === 'waiting')
  t('garbage: results not an array → waiting',
    determineStatus({ results: 'oops', precinctsTotal: 5, precinctsRptg: 5 }).status === 'waiting')
  t('garbage: non-numeric votes coerce to 0 → waiting',
    run([{ votes: 'abc' }, { votes: null }, {}], 10, 10, 1).status === 'waiting')
  t('garbage: negative votes coerce to 0, not a negative margin',
    run([{ votes: -500 }, { votes: 100 }], 10, 10, 1).detail.margin === 100)
  t('garbage: NaN/undefined precinct counts fall back to 0 precincts',
    run(R(600, 400), NaN, undefined, 1).status === 'reporting')
  t('garbage: seats 0 / negative / "2" behave sanely',
    run(R(600, 400), 10, 10, 0).status === 'called' &&
    run(R(600, 400), 10, 10, -3).status === 'called' &&
    run(R(1000, 800, 300, 100), 20, 20, '2').detail.margin === 500)
  t('numeric-string votes are parsed',
    run([{ votes: '6000' }, { votes: '4000' }], 50, 50, 1).status === 'called')

  // — invariants —
  const samples = [wNoRows, rep, projOver, projEdge, tc, rc100, rc025, called, unop, ms, msClose, noPrec]
  t('every status returned is in the DB check-constraint list',
    samples.every(s => ALLOWED_STATUSES.includes(s.status)))
  t('every detail has a one-sentence reason and computed_at',
    samples.every(s => typeof s.detail.reason === 'string' && s.detail.reason.trim().length > 0 &&
                       !Number.isNaN(Date.parse(s.detail.computed_at))))
  t('every scored detail carries margin / margin_pct / total_votes / reporting_pct',
    samples.slice(1).every(s => typeof s.detail.margin === 'number' &&
      typeof s.detail.margin_pct === 'number' && typeof s.detail.total_votes === 'number' &&
      typeof s.detail.reporting_pct === 'number'))
  t('engine never throws on hostile input', (() => {
    const hostile = [
      {}, { results: [] }, { results: [{ votes: Infinity }] }, { results: [{ votes: {} }] },
      { results: [{ votes: 1 }], precinctsTotal: -5, precinctsRptg: -5 },
      { results: new Array(3), precinctsTotal: '10', precinctsRptg: '10', seats: 'x' },
    ]
    try { hostile.forEach(h => determineStatus(h)); return true } catch { return false }
  })())
}

// ─── Live results Phase 1: engine ↔ admin-elections wiring ───────────────────
// The safety property that matters on election night: an admin's manual status
// always beats the engine, and the engine never sets `declared`.
console.log('Phase 1 — admin-elections determination wiring (mocked Supabase)')
{
  const shared = require('../netlify/functions/_shared.js')
  const realServiceClient = shared.serviceClient
  const realRequireAdmin  = shared.requireAdmin

  const CID = '11111111-1111-4111-8111-111111111111'
  const R1  = '22222222-2222-4222-8222-222222222222'
  const R2  = '33333333-3333-4333-8333-333333333333'
  let db
  const reset = () => {
    db = {
      election_contests: [{ id: CID, seats: 1, precincts_total: 10, precincts_rptg: 10, status: 'waiting', status_source: 'auto' }],
      election_results: [
        { id: R1, contest_id: CID, votes: 6000, winner: false, declared: false, candidate_name: 'A' },
        { id: R2, contest_id: CID, votes: 4000, winner: true,  declared: false, candidate_name: 'B' },
      ],
      election_poller_log: [],
      offices: [],
    }
  }
  reset()

  // Just enough of the supabase-js query builder for the calls this function makes.
  const matches = (row, fs) => fs.every(([c, v, op]) => (op === 'in' ? v.includes(row[c]) : row[c] === v))
  const from = (table) => {
    const st = { filters: [], op: null, payload: null, sel: false }
    const rows = () => (db[table] || []).filter(r => matches(r, st.filters))
    const exec = () => {
      if (st.op === 'update') { const hit = rows(); hit.forEach(r => Object.assign(r, st.payload)); return { data: st.sel ? hit : null, error: null } }
      if (st.op === 'insert') { const r = { id: `new-${db[table].length + 1}`, ...st.payload }; db[table].push(r); return { data: [r], error: null } }
      if (st.op === 'delete') { const hit = rows(); db[table] = db[table].filter(r => !hit.includes(r)); return { data: hit, error: null } }
      return { data: rows(), error: null }
    }
    const chain = {
      select() { st.sel = true; return chain },
      eq(c, v) { st.filters.push([c, v]); return chain },
      in(c, v) { st.filters.push([c, v, 'in']); return chain },
      ilike() { return chain }, limit() { return chain }, order() { return chain },
      update(p) { st.op = 'update'; st.payload = p; return chain },
      insert(p) { st.op = 'insert'; st.payload = p; return chain },
      delete() { st.op = 'delete'; return chain },
      single() { const r = exec(); return Promise.resolve({ data: r.data?.[0] || null, error: r.data?.length ? null : { message: 'no rows' } }) },
      then(ok, no) { return Promise.resolve(exec()).then(ok, no) },
    }
    return chain
  }

  shared.serviceClient = () => ({ from })
  shared.requireAdmin  = async () => ({ user: { email: 'admin@badgerboard.test' } })
  const { handler: adminElections } = require('../netlify/functions/admin-elections.js')
  const call = (action, params) =>
    adminElections({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ action, params }) })
  const contest = () => db.election_contests[0]
  const result  = (id) => db.election_results.find(r => r.id === id)

  // — auto contest: a precinct update runs the engine —
  let res = await call('update_precincts', { contest_id: CID, rptg: 10, total: 10 })
  t('update_precincts → 200', res.statusCode === 200)
  t('engine wrote status=called at 100% precincts', contest().status === 'called')
  t('engine wrote status_detail + status_updated_at',
    contest().status_detail?.margin === 2000 && typeof contest().status_detail?.reason === 'string' && !!contest().status_updated_at)
  t('engine set winner=true on the leader, false on the rest',
    result(R1).winner === true && result(R2).winner === false)
  t('engine NEVER sets declared (that stays an admin action)',
    db.election_results.every(r => r.declared === false))
  t('mutation appended an admin audit row to election_poller_log',
    db.election_poller_log.at(-1)?.source === 'admin:update_precincts' &&
    typeof db.election_poller_log.at(-1)?.duration_ms === 'number')

  // — admin override beats the engine —
  res = await call('set_status', { contest_id: CID, status: 'too_close', source: 'admin' })
  t('set_status → 200 and pins status_source=admin',
    res.statusCode === 200 && contest().status === 'too_close' && contest().status_source === 'admin')
  t('set_status rejects a status outside the check constraint',
    (await call('set_status', { contest_id: CID, status: 'bogus' })).statusCode === 400)
  await call('update_precincts', { contest_id: CID, rptg: 10, total: 10 })
  t('engine does NOT overwrite an admin-set status', contest().status === 'too_close')

  // — handing it back —
  res = await call('reset_status_auto', { contest_id: CID })
  t('reset_status_auto → auto source and an immediate recompute',
    res.statusCode === 200 && contest().status_source === 'auto' && contest().status === 'called')
  t('reset_status_auto reports the engine verdict back to the UI',
    JSON.parse(res.body).data?.determination?.status === 'called')

  // — call_race / uncall_race take the contest out of the engine's hands —
  res = await call('call_race', { result_id: R1, contest_id: CID, candidate_name: 'A' })
  t('call_race → 200, status called, source admin, declared set',
    res.statusCode === 200 && contest().status === 'called' &&
    contest().status_source === 'admin' && result(R1).declared === true)
  await call('uncall_race', { contest_id: CID })
  t('uncall_race → reporting, still admin-owned, declared cleared',
    contest().status === 'reporting' && contest().status_source === 'admin' &&
    db.election_results.every(r => r.declared === false))

  // — failures are audited too —
  const before = db.election_poller_log.length
  res = await call('update_precincts', { contest_id: 'not-a-uuid' })
  t('invalid contest_id → 400, and the failure is still logged',
    res.statusCode === 400 && db.election_poller_log.length === before + 1 &&
    !!db.election_poller_log.at(-1).error)

  // — a contest with no votes stays 'waiting' —
  reset()
  db.election_results.forEach(r => { r.votes = 0 })
  await call('update_precincts', { contest_id: CID, rptg: 0, total: 10 })
  t('no votes anywhere → waiting', contest().status === 'waiting')

  // — QA #9: a race the engine REFUSES to call must not paint anyone green —
  reset()
  result(R1).votes = 5010; result(R2).votes = 4990
  result(R1).winner = true                     // left over from an earlier pass
  await call('update_precincts', { contest_id: CID, rptg: 10, total: 10 })
  t('a 0.2% final margin is recount_possible, not called', contest().status === 'recount_possible')
  t('entering recount_possible clears stale winner flags (no green under a RECOUNT badge)',
    db.election_results.every(r => r.winner === false))
  t('the engine still refuses to touch `declared` on a recount race',
    db.election_results.every(r => r.declared === false))
  // A later pass that is STILL recount_possible must not thrash the rows.
  result(R1).winner = true
  await call('update_precincts', { contest_id: CID, rptg: 10, total: 10 })
  t('a contest already sitting in recount_possible is left alone', result(R1).winner === true)

  shared.serviceClient = realServiceClient
  shared.requireAdmin  = realRequireAdmin
}


// ─── Live results Phases 2–3: the poller's pure halves ───────────────────────
// The poller itself is all network + Supabase, but the two pieces that decide
// whether it runs at all and whether a number is allowed near the database are
// pure — and those are the two that can quietly ruin an election night.
console.log('Phases 2-3 — election-results-poller window decision')
{
  const { decideWindow, validateContestUpdate, MAX_TOTAL_VOTES } =
    require('../netlify/functions/election-results-poller.js')

  // 2026-08-11 is the Wisconsin partisan primary; Central time is CDT (UTC-5)
  // that week, so these literals pin the exact instant regardless of the host's
  // own timezone.
  const CDT = (hhmm, day = '2026-08-11') => new Date(`${day}T${hhmm}:00-05:00`)
  const DATES = ['2026-08-11']
  const w = (hhmm, day) => decideWindow(CDT(hhmm, day), DATES)

  // — election day —
  t('19:59 election day → skip (polls have not closed)',      w('19:59').run === false)
  t('20:00 election day → run, peak (5-minute cadence)',
    w('20:00').run === true && w('20:00').phase === 'peak' && w('20:00').cadence === 'every 5 minutes')
  t('21:57 → run, still the 5-minute phase',
    w('21:57').run === true && w('21:57').phase === 'peak')
  t('22:30 → skip (past 10pm it is hourly, top of the hour only)', w('22:30').run === false)
  t('23:02 → run, overnight hourly phase',
    w('23:02').run === true && w('23:02').phase === 'overnight' && w('23:02').cadence === 'hourly')
  t('22:00 → run (the 10pm hourly run itself)', w('22:00').run === true)

  // — the morning after (targets the PREVIOUS day's election) —
  const nxt = (hhmm) => w(hhmm, '2026-08-12')
  t('00:01 next day → run, and it is attributed to the 8/11 election',
    nxt('00:01').run === true && nxt('00:01').electionDate === '2026-08-11')
  t('01:03 next day → run (hourly)', nxt('01:03').run === true)
  t('03:02 next day → run — 3am is the last overnight run', nxt('03:02').run === true)
  t('03:58 next day → skip (not the top of the hour)', nxt('03:58').run === false)
  // BOUNDARY: "10pm through the next 6 hours" = 22, 23, 00, 01, 02, 03 — six
  // hourly runs, with 04:00 the exclusive end of the window. 4am does NOT run.
  t('04:02 next day → skip (4am is the exclusive end of the overnight window)',
    nxt('04:02').run === false)
  t('09:02 next day → skip (nothing between 4am and 10am)', nxt('09:02').run === false)
  t('10:02 next day → run, final sweep, once',
    nxt('10:02').run === true && nxt('10:02').phase === 'final' && nxt('10:02').cadence === 'once')
  t('10:07 next day → skip (the final sweep already went at the top of the hour)',
    nxt('10:07').run === false)
  t('11:02 next day → skip (the final sweep is the last run)', nxt('11:02').run === false)

  // — no election, no run —
  t('20:00 the day BEFORE the election → skip',
    decideWindow(CDT('20:00', '2026-08-10'), DATES).run === false)
  t('20:00 two days after the election → skip',
    decideWindow(CDT('20:00', '2026-08-13'), DATES).run === false)
  t('no election dates on file at all → skip', decideWindow(CDT('20:30'), []).run === false)
  t('a skip still explains itself', typeof w('19:59').reason === 'string' && w('19:59').reason.length > 10)

  // — DST: the window must come from a real America/Chicago conversion —
  // 2027-02-16 is the spring primary, in CST (UTC-6). A hardcoded UTC-5 would
  // read 20:00 CST as 21:00 and 19:00 CST as 20:00 — both wrong.
  const WINTER = ['2027-02-16']
  t('winter election: 20:00 CST → run (offset is -6, not -5)',
    decideWindow(new Date('2027-02-16T20:00:00-06:00'), WINTER).run === true)
  t('winter election: 19:00 CST → skip (a hardcoded -5 offset would have run it)',
    decideWindow(new Date('2027-02-16T20:00:00-05:00'), WINTER).run === false)
  t('winter election: 22:02 CST → run hourly',
    decideWindow(new Date('2027-02-16T22:02:00-06:00'), WINTER).phase === 'overnight')
  t('winter morning after: 10:01 CST → final run',
    decideWindow(new Date('2027-02-17T10:01:00-06:00'), WINTER).phase === 'final')

  // — the decision never throws on junk —
  t('window decision survives junk input', (() => {
    try {
      decideWindow(new Date('nonsense'), null)
      decideWindow(CDT('20:00'), [null, undefined, {}, new Date('2026-08-11T12:00:00-05:00')])
      return true
    } catch { return false }
  })())

  // ─── validation: nothing bad reaches the database ─────────────────────────
  console.log('Phases 2-3 — election-results-poller validation / quarantine')

  const roster = () => ([
    { id: 'r1', candidate_name: 'Sarah Godlewski', votes: 1000 },
    { id: 'r2', candidate_name: 'Tom Nelson',      votes: 900 },
  ])
  const existing = (over = {}) => ({
    office: 'Governor — Democratic Primary',
    results: roster(),
    precincts_total: 3600,
    precincts_rptg: 1200,
    ...over,
  })
  const payload = (over = {}) => ({
    office: 'Governor — Democratic Primary',
    candidates: [{ name: 'Sarah Godlewski', votes: 1500 }, { name: 'Tom Nelson', votes: 1400 }],
    precincts_reporting: 1800,
    precincts_total: 3600,
    source: 'AP via WISN (https://example.com)',
    ...over,
  })

  // — happy path —
  const good = validateContestUpdate(payload(), existing())
  t('clean payload: both candidates accepted, no notes',
    good.ok === true && good.updates.length === 2 && good.inserts.length === 0 && good.notes.length === 0)
  t('clean payload: precincts pass through', good.precincts.precincts_rptg === 1800 && good.precincts.precincts_total === 3600)
  t('clean payload: updates carry the DB row id, not the reported name',
    good.updates[0].id === 'r1' && good.updates[0].candidate_name === 'Sarah Godlewski')

  // — name matching —
  const cased = validateContestUpdate(payload({
    candidates: [{ name: 'sarah  GODLEWSKI', votes: 1500 }],
  }), existing())
  t('candidate names match case- and whitespace-insensitively',
    cased.updates.length === 1 && cased.updates[0].id === 'r1' && cased.updates[0].matched_by === 'exact')
  const lastName = validateContestUpdate(payload({
    candidates: [{ name: 'S. Godlewski', votes: 1500 }, { name: 'Thomas Nelson', votes: 1400 }],
  }), existing())
  t('last-name fallback matches "S. Godlewski" and "Thomas Nelson"',
    lastName.updates.length === 2 && lastName.updates.every(u => u.matched_by === 'last-name'))
  const ambiguous = validateContestUpdate(payload({
    candidates: [{ name: 'J. Nelson', votes: 50 }],
  }), existing({ results: [
    { id: 'r1', candidate_name: 'Tom Nelson', votes: 10 },
    { id: 'r2', candidate_name: 'Jane Nelson', votes: 10 },
  ] }))
  t('an ambiguous last name matches nobody and is quarantined',
    ambiguous.updates.length === 0 && ambiguous.notes.some(n => /more than one candidate/.test(n)))

  // — vote decreases —
  const dropped = validateContestUpdate(payload({
    candidates: [{ name: 'Sarah Godlewski', votes: 1500 }, { name: 'Tom Nelson', votes: 800 }],
  }), existing())
  t('a vote DECREASE is skipped, never written',
    dropped.updates.length === 1 && dropped.updates[0].id === 'r1')
  t('the decrease is explained in the notes (→ log row error field)',
    dropped.notes.some(n => n.includes('Tom Nelson') && /below the stored 900/.test(n)))
  const same = validateContestUpdate(payload({
    candidates: [{ name: 'Sarah Godlewski', votes: 1000 }],
  }), existing())
  t('an unchanged total is fine (>= current, not > current)', same.updates.length === 1)
  const fractional = validateContestUpdate(payload({
    candidates: [{ name: 'Sarah Godlewski', votes: 1500.5 }, { name: 'Tom Nelson', votes: 'about 1,400' }],
  }), existing())
  t('non-integer / prose vote counts are dropped',
    fractional.updates.length === 0 && fractional.notes.length === 2)
  t('comma-formatted integers are still accepted',
    validateContestUpdate(payload({ candidates: [{ name: 'Tom Nelson', votes: '1,400' }] }), existing())
      .updates[0].votes === 1400)

  // — unmatched candidates —
  const stranger = validateContestUpdate(payload({
    candidates: [{ name: 'Sarah Godlewski', votes: 1500 }, { name: 'Nobody Atall', votes: 99999 }],
  }), existing())
  t('an unmatched candidate in an ESTABLISHED contest is quarantined, not inserted',
    stranger.updates.length === 1 && stranger.inserts.length === 0 &&
    stranger.notes.some(n => /not on this contest's roster/.test(n)))
  const bootstrapped = validateContestUpdate(payload({
    candidates: [{ name: 'Sarah Godlewski', votes: 1500 }, { name: 'Late Entry', votes: 12 }],
  }), existing(), { allowInserts: true })
  t('the same name IS inserted in a contest the poller just bootstrapped',
    bootstrapped.inserts.length === 1 && bootstrapped.inserts[0].candidate_name === 'Late Entry')

  // — precincts —
  const clamped = validateContestUpdate(payload({ precincts_reporting: 5000, precincts_total: 3600 }), existing())
  t('precincts reporting above the total is clamped to the total',
    clamped.precincts.precincts_rptg === 3600 &&
    clamped.notes.some(n => /clamped to 3600/.test(n)))
  t('precincts reporting going backwards is refused',
    validateContestUpdate(payload({ precincts_reporting: 100 }), existing()).precincts === null ||
    validateContestUpdate(payload({ precincts_reporting: 100 }), existing()).precincts.precincts_rptg === 1200)
  t('omitted precinct numbers leave the stored counts alone',
    validateContestUpdate({ office: 'x', candidates: [{ name: 'Tom Nelson', votes: 950 }], source: 'clerk' },
      existing()).precincts === null)

  // — whole-contest quarantines —
  const noSource = validateContestUpdate(payload({ source: '   ' }), existing())
  t('a contest with no cited source is quarantined whole',
    noSource.ok === false && noSource.updates.length === 0 && noSource.precincts === null &&
    noSource.notes.some(n => /no source cited/.test(n)))
  const absurd = validateContestUpdate(payload({
    candidates: [{ name: 'Sarah Godlewski', votes: MAX_TOTAL_VOTES }, { name: 'Tom Nelson', votes: 1400 }],
  }), existing())
  t('a contest breaching the 4,000,000-vote sanity cap is quarantined whole',
    absurd.ok === false && absurd.updates.length === 0 &&
    absurd.notes.some(n => /sanity cap/.test(n)))
  t('an empty candidate list writes nothing',
    validateContestUpdate(payload({ candidates: [] }), existing()).ok === false)

  // — hostile input —
  t('validation never throws on hostile input', (() => {
    const hostile = [
      null, undefined, 'nope', [], 42,
      { candidates: null, source: 's' },
      { candidates: [{}, { name: 5, votes: {} }, { name: 'x', votes: -3 }], source: 's' },
      { candidates: [{ name: 'Tom Nelson', votes: Infinity }], source: 's', precincts_total: 'many' },
    ]
    try { hostile.forEach(h => validateContestUpdate(h, existing())); return true } catch { return false }
  })())
  t('hostile input still writes nothing',
    validateContestUpdate({ candidates: [{ name: 'Tom Nelson', votes: Infinity }], source: 's' }, existing()).ok === false)

  // — the manual-invocation guard runs BEFORE anything else, so this holds at
  //   any time of day (including inside a live window) —
  // admin-elections now requires the poller at module load, which can pull it
  // into the cache while _shared is mocked by earlier blocks — re-require both
  // fresh so this asserts the REAL auth guard.
  delete require.cache[require.resolve('../netlify/functions/election-results-poller.js')]
  delete require.cache[require.resolve('../netlify/functions/_shared.js')]
  const { handler: poller } = require('../netlify/functions/election-results-poller.js')
  const noAuth = await poller({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ force: true, dry_run: true }) })
  t('manual invocation without an admin JWT → 401 before any DB or AI call', noAuth.statusCode === 401)
  const preflight = await poller({ httpMethod: 'OPTIONS', headers: {}, body: '' })
  t('OPTIONS preflight → 204', preflight.statusCode === 204)
}


// ── poller: precinct figures ignored before any votes exist ─────────────────
{
  const { validateContestUpdate } = require('../netlify/functions/election-results-poller.js')
  const existing = { office: 'Governor — Democratic Primary', precincts_total: 0, precincts_rptg: 0,
    results: [{ id: 'r1', candidate_name: 'Sara Rodriguez', votes: 0 }] }
  const v1 = validateContestUpdate(
    { office: 'Governor — Democratic Primary', candidates: [{ name: 'Sara Rodriguez', votes: 0 }],
      precincts_reporting: 0, precincts_total: 50, source: 'somewhere' },
    existing)
  t('pre-vote precinct figure is ignored', !v1.precincts)
  t('pre-vote precinct ignore is noted', (v1.notes || []).some(n => /ignored/.test(n)))
  const v2 = validateContestUpdate(
    { office: 'Governor — Democratic Primary', candidates: [{ name: 'Sara Rodriguez', votes: 1200 }],
      precincts_reporting: 10, precincts_total: 3600, source: 'Dane County Clerk' },
    existing)
  t('precincts accepted once votes exist', v2.precincts && v2.precincts.precincts_total === 3600 && v2.precincts.precincts_rptg === 10)
}

// ── poller: full-ballot tiering — chunk math ────────────────────────────────
// NOTE: everything must go ABOVE the summary/process.exit lines at the bottom
// of this file. Anything appended after them never runs.
{
  console.log('Full ballot — tier-2 chunking + rotation')
  const {
    chunkList, tierTwoQueue, assignChunks, orderChunk, chunkIndexOf,
    selectRotationChunks, rotationTick, contestLine,
    countyChunk, countyDiscoveryPrompt, shapeCountyContests,
    WI_COUNTIES, COUNTY_CHUNKS, TIER2_CHUNK_SIZE, TIER2_MAX_CALLS,
  } = require('../netlify/functions/election-results-poller.js')

  // A realistic full ballot: 9 statewide + 8 US House + 17 senate + 99 assembly.
  const mk = (n, office_type, status = 'reporting', prefix = office_type) =>
    Array.from({ length: n }, (_, i) => ({
      id: `${prefix}-${String(i).padStart(3, '0')}`,
      office: `${office_type} ${i}`,
      office_type,
      status,
    }))
  const ballot = [
    ...mk(9,  'statewide'),
    ...mk(8,  'us_house'),
    ...mk(17, 'state_senate'),
    ...mk(99, 'state_assembly'),
  ]
  const ct = (hour, minute = 0) => ({ hour, minute, minutes: hour * 60 + minute })

  // — slicing —
  t('chunkList splits into fixed-size chunks, last one short',
    (() => { const c = chunkList(Array.from({ length: 25 }, (_, i) => i), 12)
      return c.length === 3 && c[0].length === 12 && c[1].length === 12 && c[2].length === 1 })())
  t('chunkList of an empty list is no chunks', chunkList([], 12).length === 0)
  t('chunkList survives junk input', chunkList(null, 0).length === 0 && chunkList([1, 2], NaN).length === 1)
  t('default chunk size is 8 and 3 staggered tier-2 calls per run (rate-limit safe)',
    TIER2_CHUNK_SIZE === 8 && TIER2_MAX_CALLS === 3)

  // — queue composition —
  const q = tierTwoQueue(ballot)
  t('statewide contests are NEVER in the tier-2 rotation',
    q.length === 124 && q.every(c => c.office_type !== 'statewide'))
  t('tier-2 queue is ordered by id, so the rotation is stable between runs',
    q.map(c => c.id).join('|') === [...q].sort((a, b) => a.id.localeCompare(b.id)).map(c => c.id).join('|'))

  const decided = [
    ...mk(4, 'state_assembly', 'called',    'called'),
    ...mk(3, 'state_assembly', 'certified', 'cert'),
    ...mk(5, 'state_assembly', 'reporting', 'live'),
    ...mk(2, 'statewide',      'reporting', 'sw'),
  ]
  const qd = tierTwoQueue(decided)
  t('decided contests KEEP their seat in the tier-2 list (chunk membership must not shift)',
    qd.length === 12 && qd.filter(c => c.status === 'reporting').length === 5)
  // Called races with counting still open (no precinct totals here) STAY in
  // the chunk — the owner's rule: updates continue until every vote is counted.
  t('a called race still being counted keeps refreshing; certified drops out',
    orderChunk(qd, ct(21, 0)).length === 9 &&
    orderChunk(qd, ct(21, 0)).every(c => c.status !== 'certified'))
  t('a called race with every precinct in is done — dropped from its chunk',
    orderChunk(qd.map(c => c.status === 'called' ? { ...c, precincts_total: 10, precincts_rptg: 10 } : c), ct(21, 0)).length === 5)

  // — waiting deprioritisation, now INSIDE a chunk (membership never moves) —
  const mixed = [
    { id: 'a', office_type: 'state_assembly', status: 'waiting'   },
    { id: 'b', office_type: 'state_assembly', status: 'reporting' },
    { id: 'c', office_type: 'state_assembly', status: 'waiting'   },
    { id: 'd', office_type: 'state_assembly', status: 'too_close' },
  ]
  t('before 11 PM CT a chunk is plain id order (waiting races still matter)',
    orderChunk(mixed, ct(21, 45)).map(c => c.id).join('') === 'abcd')
  t('after 11 PM CT the still-waiting contests are ordered LAST inside the chunk',
    orderChunk(mixed, ct(23, 0)).map(c => c.id).join('') === 'bdac')
  t('the 1 AM hourly run also deprioritises waiting contests',
    orderChunk(mixed, ct(1, 0)).map(c => c.id).join('') === 'bdac')
  t('deprioritisation keeps id order inside each band',
    orderChunk(mixed, ct(23, 0)).slice(2).map(c => c.id).join('') === 'ac')

  // — time-derived rotation: deterministic, disjoint, and it comes back round —
  const peak = (h, m) => selectRotationChunks(q, ct(h, m), { cadence: 'every 5 minutes' })
  t('rotation is fully determined by the clock — same instant, same chunks',
    peak(20, 15).indices.join(',') === peak(20, 15).indices.join(','))
  t('124 contests in rotation → 16 chunks of 8', peak(20, 0).nChunks === 16)
  t('each run takes 3 chunks', peak(20, 0).indices.length === 3 && peak(20, 5).indices.length === 3)
  t('the 20:00 run starts at chunk 0', peak(20, 0).indices.join(',') === '0,1,2')
  t('consecutive 5-minute runs cover DISJOINT chunks',
    peak(20, 5).indices.join(',') === '3,4,5' && peak(20, 10).indices.join(',') === '6,7,8')
  t('any minute inside a 5-minute bucket picks the same slice',
    peak(20, 5).indices.join(',') === peak(20, 9).indices.join(','))
  t('the rotation wraps rather than running off the end', (() => {
    const small = q.slice(0, 20)   // 20 contests → 3 chunks, up to 6 per run = all of them
    const idx = (m) => selectRotationChunks(small, ct(20, m), { cadence: 'every 5 minutes' }).indices
    return idx(20).length === 3 && new Set(idx(20)).size === 3 && idx(25).length === 3
  })())
  t('every tier-2 contest is refreshed within one full cycle of 5-minute runs', (() => {
    const seen = new Set()
    for (let m = 0; m < 60; m += 5) for (const i of peak(20, m).indices) seen.add(i)
    return seen.size === peak(20, 0).nChunks
  })())
  t('the hourly cadence advances hour by hour, not minute by minute', (() => {
    const at = (h) => selectRotationChunks(q, ct(h, 0), { cadence: 'hourly' }).indices.join(',')
    return at(22) !== at(23) && at(23) !== at(0) && at(22) === at(22)
  })())
  t('the clock ticks forward across midnight instead of jumping backwards',
    rotationTick(ct(20, 0), 'hourly') === 0 && rotationTick(ct(23, 0), 'hourly') === 3 &&
    rotationTick(ct(0, 0), 'hourly') === 4 && rotationTick(ct(3, 0), 'hourly') === 7)
  t('the 5-minute tick is 12 per hour off the same origin',
    rotationTick(ct(20, 0)) === 0 && rotationTick(ct(20, 55)) === 11 && rotationTick(ct(21, 0)) === 12)
  t('rotation math survives a junk clock',
    selectRotationChunks(q, {}, {}).indices.length === 3 && selectRotationChunks([], ct(20, 0), {}).nChunks === 0)
  t('a single short chunk is still selected exactly once',
    selectRotationChunks(mixed, ct(20, 20), {}).indices.join(',') === '0')

  // — chunk prompts carry district + county —
  t('a chunk prompt line pins the exact district',
    contestLine({ office: 'State Assembly District 85 — Democratic Primary', district: 'District 85',
      _results: [{ candidate_name: 'Ann Lee' }, { candidate_name: 'Bo Ray' }] }, 0)
      === '1. State Assembly District 85 — Democratic Primary (candidates on file: Ann Lee, Bo Ray)')
  t('a chunk prompt line pins the county when the office does not name it',
    contestLine({ office: 'Sheriff — Republican Primary', county: 'Marathon', _results: [] }, 0)
      .includes('Marathon County, Wisconsin'))
  t('district is appended when the office string omits it',
    contestLine({ office: 'State Senate — Democratic Primary', district: 'District 9', _results: [] }, 2)
      === '3. State Senate — Democratic Primary — District 9')
  t('nothing is duplicated when office already carries district and county',
    contestLine({ office: 'Marathon County Sheriff — Republican Primary', county: 'Marathon', _results: [] }, 0)
      === '1. Marathon County Sheriff — Republican Primary')

  // ── county discovery ──────────────────────────────────────────────────────
  console.log('Full ballot — county discovery shaping')
  t('all 72 Wisconsin counties, alphabetical, in 6 chunks of 12',
    WI_COUNTIES.length === 72 && COUNTY_CHUNKS === 6 &&
    WI_COUNTIES[0] === 'Adams' && WI_COUNTIES[71] === 'Wood')
  t('the six county chunks partition the state exactly once', (() => {
    const all = []
    for (let i = 0; i < COUNTY_CHUNKS; i++) all.push(...countyChunk(i))
    return all.length === 72 && new Set(all).size === 72 && all.join('|') === WI_COUNTIES.join('|')
  })())
  t('each county chunk is 12 counties', countyChunk(0).length === 12 && countyChunk(5).length === 12)
  t('an out-of-range chunk index is clamped, never thrown',
    countyChunk(-4)[0] === 'Adams' && countyChunk(99)[11] === 'Wood' && countyChunk('x')[0] === 'Adams')

  const slice = ['Marathon', 'Milwaukee', 'Monroe', 'Oneida', 'Pepin', 'Portage']
  const prompt = countyDiscoveryPrompt({ name: 'Partisan Primary', election_date: '2026-08-11' }, slice)
  t('the discovery prompt names every county in the slice',
    slice.every(c => prompt.includes(`- ${c} County`)))
  t('the discovery prompt asks only for contested partisan county offices',
    /CONTESTED PARTISAN COUNTY-OFFICE/.test(prompt) && prompt.includes('Sheriff, County Clerk, County Treasurer'))
  t('the discovery prompt forbids inventing and expects most counties to be omitted',
    /Never invent/.test(prompt) && /NO CONTESTED PARTISAN COUNTY PRIMARY/.test(prompt))
  t('the discovery prompt demands a source per contest',
    /No source, no contest/.test(prompt))

  // Mocked Perplexity reply — one of everything the extractor can get wrong.
  const reply = { contests: [
    { county: 'Marathon',        office: 'Sheriff',            party: 'Republican', candidates: ['Ann Lee', 'Bo Ray'], source: 'Marathon County Clerk (https://x)' },
    { county: 'Milwaukee County', office: 'County Treasurer',  party: 'Democratic', candidates: ['Cy Doe', 'Dee Fox'], source: 'WEC' },
    { county: 'Monroe',          office: 'Sheriff',            party: 'Republican', candidates: ['Solo Guy'],          source: 'clerk' },
    { county: 'Oneida',          office: 'County Board Supervisor District 3', party: 'Republican', candidates: ['A A', 'B B'], source: 'clerk' },
    { county: 'Pepin',           office: 'Coroner',            party: 'Democratic', candidates: ['E F', 'G H'],        source: '  ' },
    { county: 'Marathon',        office: 'sheriff',            party: 'Rep',        candidates: ['Ann Lee', 'Bo Ray'], source: 'dup' },
    { county: 'Dane',            office: 'Sheriff',            party: 'Democratic', candidates: ['X Y', 'Z W'],        source: 'clerk' },
  ] }
  const shaped = shapeCountyContests(reply, slice)

  t('county discovery shapes a contested race into the house office format',
    shaped.contests[0].office === 'Marathon County Sheriff — Republican Primary' &&
    shaped.contests[0].county === 'Marathon' &&
    shaped.contests[0].office_type === 'county' &&
    shaped.contests[0].party === 'Republican')
  t('the county name is not doubled on a "County <Office>" title',
    shaped.contests[1].office === 'Milwaukee County Treasurer — Democratic Primary')
  t('an UNCONTESTED county primary is dropped',
    !shaped.contests.some(c => /Monroe/.test(c.office)) &&
    shaped.notes.some(n => /not a contested primary/.test(n)))
  t('an office Wisconsin does not elect on a partisan county ballot is dropped',
    !shaped.contests.some(c => /Supervisor/i.test(c.office)) &&
    shaped.notes.some(n => /not a partisan county office/.test(n)))
  t('an unsourced county contest is dropped',
    !shaped.contests.some(c => /Coroner/.test(c.office)) &&
    shaped.notes.some(n => /no source cited/.test(n)))
  t('a county outside this chunk cannot be smuggled in',
    !shaped.contests.some(c => /Dane/.test(c.office)) &&
    shaped.notes.some(n => /not in this chunk's county list/.test(n)))
  t('a contest reported twice is created once',
    shaped.contests.filter(c => /Marathon County Sheriff/.test(c.office)).length === 1)
  t('exactly the two valid contests survive out of seven reported', shaped.contests.length === 2)
  t('every shaped contest carries its source',
    shaped.contests.every(c => typeof c.source === 'string' && c.source.trim().length > 0))
  t('every shaped contest carries at least two candidates',
    shaped.contests.every(c => c.candidates.length >= 2))
  t('an empty reply is a valid answer, not an error',
    shapeCountyContests({ contests: [] }, slice).contests.length === 0 &&
    shapeCountyContests({ contests: [] }, slice).notes.length === 0)
  t('unparseable discovery JSON creates nothing and says so',
    shapeCountyContests(null, slice).contests.length === 0 &&
    shapeCountyContests(null, slice).notes.some(n => /unparseable/.test(n)))
  t('county shaping never throws on hostile input', (() => {
    const hostile = [undefined, 'nope', 42, { contests: 'x' },
      { contests: [null, [], 7, { county: 'Marathon' }, { county: 'Marathon', office: 'Sheriff', party: null, candidates: 'x', source: 5 }] }]
    try { hostile.forEach(h => shapeCountyContests(h, slice)); return true } catch { return false }
  })())
  t('duplicate candidate names inside one contest are collapsed',
    shapeCountyContests({ contests: [{ county: 'Pepin', office: 'Register of Deeds', party: 'Democratic',
      candidates: ['E F', 'e  f', 'G H'], source: 'clerk' }] }, slice).contests[0].candidates.length === 2)
}


// ─── Per-race result notifications (_result-notify) ──────────────────────────
{
  const {
    buildUpdateEmail, buildWinnerEmail, buildRecountEmail,
    decideNotification, snapshotOf, snapshotChanged, marginOf, THROTTLE_MS,
  } = require('../netlify/functions/_result-notify.js')

  const ELECTION_ID = '11111111-2222-3333-4444-555555555555'
  const contestBase = {
    id: '99999999-8888-7777-6666-555555555555',
    election_id: ELECTION_ID,
    office: 'State Senate District 31',
    district: 'District 31',
    county: 'Trempealeau',
    seats: 1,
    status: 'reporting',
    status_detail: { reason: '78% of precincts reporting (39 of 50); too early to decide anything.' },
    precincts_rptg: 39,
    precincts_total: 50,
  }
  const resultsMid = [
    { candidate_name: 'Marla Vandenberg', party: 'Democrat',   votes: 24318, vote_pct: 51.3, winner: false, declared: false },
    { candidate_name: 'Dale Kupferschmidt', party: 'Republican', votes: 23107, vote_pct: 48.7, winner: false, declared: false },
  ]
  const opts = { electionId: ELECTION_ID, electionName: 'Fall General Election', now: new Date('2026-11-03T03:42:00Z') }

  // ── update email ──────────────────────────────────────────────────────────
  console.log('Result notifications — update email')
  const upd = buildUpdateEmail(contestBase, resultsMid, opts)
  t('the update subject names the office',
    upd.subject === '📊 State Senate District 31: new numbers in')
  t('the update body carries thousands separators, never raw integers',
    upd.body.includes('24,318') && upd.body.includes('23,107') && !upd.body.includes('>24318<'))
  t('the update body leads with the margin between the top two',
    upd.body.includes('Marla Vandenberg leads by 1,211 votes (2.6%)'))
  t('the leader row is bolded and flagged with a ▲',
    /▲ Marla Vandenberg/.test(upd.body) && /font-weight:700">▲ Marla Vandenberg/.test(upd.body))
  t('the runner-up is not flagged as a leader',
    !/▲ Dale Kupferschmidt/.test(upd.body))
  t('the update body states precincts reporting in plain English',
    upd.body.includes('39 of 50 precincts reporting (78%)'))
  t('the status line is plain English, not a status enum',
    upd.body.includes('Reporting — 78% of precincts in') && !upd.body.includes('recount_possible'))
  t('a projected race says victory likely, not final',
    buildUpdateEmail({ ...contestBase, status: 'projected' }, resultsMid, opts).body.includes('Victory likely — not final'))
  t('a too-close race says so',
    buildUpdateEmail({ ...contestBase, status: 'too_close' }, resultsMid, opts).body.includes('Too close to call'))
  t('the update body timestamps the numbers in Central time',
    /Numbers as of \d{1,2}:\d{2}\s?(AM|PM) CT/.test(upd.body))
  t('the update CTA points at this election on the results board',
    upd.ctaText === 'View live results' &&
    upd.ctaUrl === `https://badgerboardwi.com/game-plan?tab=results&election=${ELECTION_ID}`)
  t('the update footer explains why they got it and how to stop it',
    /every time this race's numbers change/.test(upd.footerNote) &&
    /Manage or turn off notifications from the race card/.test(upd.footerNote))
  t('the update email returns the full house-template payload',
    ['subject', 'title', 'preheader', 'body', 'ctaText', 'ctaUrl', 'footerNote'].every(k => typeof upd[k] === 'string' && upd[k].length))

  // ── winner email ──────────────────────────────────────────────────────────
  console.log('Result notifications — winner email')
  const calledContest = {
    ...contestBase,
    status: 'called',
    precincts_rptg: 50,
    status_detail: { reason: 'All 50 precincts reporting; the leader is ahead by 1,211 votes (2.55%), beyond any recount threshold.', margin: 1211, margin_pct: 2.5535 },
  }
  const resultsFinal = [
    { candidate_name: 'Marla Vandenberg', party: 'Democrat',   votes: 24318, vote_pct: 51.3, winner: true,  declared: true },
    { candidate_name: 'Dale Kupferschmidt', party: 'Republican', votes: 23107, vote_pct: 48.7, winner: false, declared: false },
  ]
  const win = buildWinnerEmail(calledContest, resultsFinal, opts)
  t('the winner subject names the winner and the office',
    win.subject === '🏆 Winner: Marla Vandenberg — State Senate District 31')
  t('the winner headline is the centered trophy announcement, banner box removed',
    win.title === '🏆 Marla Vandenberg has won.' &&
    win.titleCenter === true &&
    !win.body.includes('border:1px solid #bbe5ca') &&
    !/congratulations/i.test(win.body))
  t('the winner email states the final margin with separators',
    win.body.includes('Final margin: 1,211 votes (2.6%) over Dale Kupferschmidt, out of 47,425 cast.'))
  t('the winner row is highlighted, the loser row is not',
    win.body.includes('🏆 Marla Vandenberg') && win.body.includes('#E6F5EC') &&
    !win.body.includes('🏆 Dale Kupferschmidt'))
  t('the winner email says how it was decided, quoting status_detail.reason',
    win.body.includes('How it was decided:') && win.body.includes('All 50 precincts reporting'))
  t('an admin hand-call is quoted verbatim as the reason',
    buildWinnerEmail({ ...calledContest, status_detail: { reason: 'Called by hand for Marla Vandenberg.' } }, resultsFinal, opts)
      .body.includes('Called by hand for Marla Vandenberg.'))
  t('an unopposed winner gets a sentence that makes sense',
    buildWinnerEmail(calledContest, [resultsFinal[0]], opts).body.includes('finishes with 24,318 votes and no opponent to displace'))
  t('the winner CTA and footer match the house pattern',
    win.ctaUrl === upd.ctaUrl && /Manage or turn off notifications from the race card/.test(win.footerNote))

  // ── recount email ─────────────────────────────────────────────────────────
  console.log('Result notifications — recount email')
  const recountResults = [
    { candidate_name: 'Marla Vandenberg', party: 'Democrat',   votes: 23760, vote_pct: 50.1, winner: false, declared: false },
    { candidate_name: 'Dale Kupferschmidt', party: 'Republican', votes: 23665, vote_pct: 49.9, winner: false, declared: false },
  ]
  const recountContest = {
    ...contestBase, status: 'recount_possible', precincts_rptg: 50,
    status_detail: { fee_free: true, margin: 95, margin_pct: 0.2, reason: 'All 50 precincts reporting with a final unofficial margin of 0.2%.' },
  }
  const rec = buildRecountEmail(recountContest, recountResults, opts)
  t('the recount subject flags final numbers and the recount window',
    rec.subject === '⚖️ Final numbers — recount possible: State Senate District 31')
  t('the recount banner states the margin between the top two (redesign: single concise line)',
    rec.body.includes('Recount possible — Marla Vandenberg leads Dale Kupferschmidt by 95 votes (0.2%).'))
  t('the recount email explains both Wisconsin thresholds',
    rec.body.includes('may petition for a recount when the margin is 1% of the votes cast or less') &&
    rec.body.includes('0.25% or less, the recount is fee-free'))
  t('a fee-free margin says the recount costs the petitioner nothing',
    rec.body.includes('inside the fee-free band'))
  t('a petition-window-but-not-fee-free margin says the petitioner pays',
    buildRecountEmail({ ...recountContest, status_detail: { fee_free: false } }, recountResults, opts)
      .body.includes('outside the fee-free band, so a petitioner would have to cover the cost'))
  t('the recount email still carries the table and the CTA',
    rec.body.includes('23,760') && rec.body.includes('23,665') && rec.ctaUrl === upd.ctaUrl)

  t('the builders escape hostile candidate names instead of rendering them',
    buildUpdateEmail(contestBase, [{ candidate_name: '<script>alert(1)</script>', votes: 5 }], opts)
      .body.includes('&lt;script&gt;') === true)
  t('the builders never throw on junk input', (() => {
    const junk = [undefined, null, 'x', 42, {}, { office: null }]
    try {
      junk.forEach(c => { buildUpdateEmail(c, null, {}); buildWinnerEmail(c, 'nope', {}); buildRecountEmail(c, [null, 7], {}) })
      return true
    } catch { return false }
  })())

  // ── margin maths ──────────────────────────────────────────────────────────
  console.log('Result notifications — margin + change detection')
  t('marginOf reads first-minus-second and its share of the vote', (() => {
    const m = marginOf(resultsMid)
    return m.margin === 1211 && m.totalVotes === 47425 && Math.abs(m.marginPct - 2.5535) < 0.001
  })())
  t('marginOf on a multi-seat race compares the last seat to the first loser',
    marginOf([{ candidate_name: 'A', votes: 100 }, { candidate_name: 'B', votes: 90 }, { candidate_name: 'C', votes: 40 }], 2).margin === 50)
  t('a snapshot tracks votes, precincts and status — nothing else', (() => {
    const s = snapshotOf(contestBase, resultsMid)
    return s.votes['Marla Vandenberg'] === 24318 && s.precincts_rptg === 39 && s.status === 'reporting' &&
      Object.keys(s).length === 3
  })())
  t('a moved vote total is a change; a moved vote_pct alone is not', (() => {
    const base = snapshotOf(contestBase, resultsMid)
    const samePctDifferent = snapshotOf(contestBase, resultsMid.map(r => ({ ...r, vote_pct: r.vote_pct + 1 })))
    const votesMoved = snapshotOf(contestBase, [{ ...resultsMid[0], votes: 24319 }, resultsMid[1]])
    return snapshotChanged(base, samePctDifferent) === false && snapshotChanged(base, votesMoved) === true
  })())
  t('a first-ever snapshot always counts as a change', snapshotChanged(null, snapshotOf(contestBase, resultsMid)) === true)
  t('more precincts reporting is a change even when the votes are identical',
    snapshotChanged(snapshotOf(contestBase, resultsMid), snapshotOf({ ...contestBase, precincts_rptg: 40 }, resultsMid)) === true)

  // ── the decision matrix ───────────────────────────────────────────────────
  console.log('Result notifications — decideNotification matrix')
  const T0 = new Date('2026-11-03T03:00:00Z')
  const at = (mins) => new Date(T0.getTime() + mins * 60000)
  // A subscription that has ALREADY been seen once: it carries a baseline
  // snapshot, so the matrix below is about real changes, not first sight.
  // (First sight is its own block further down — it never emails.)
  const baseline = snapshotOf({ ...contestBase, precincts_rptg: 30 }, [
    { candidate_name: 'Marla Vandenberg', votes: 20000 },
    { candidate_name: 'Dale Kupferschmidt', votes: 19000 },
  ])
  const everyChange = { id: 's1', mode: 'every_change', last_notified_at: null, last_snapshot: baseline, winner_notified_at: null }
  const finalOnly   = { ...everyChange, id: 's2', mode: 'final_only' }

  // first change → send
  const d1 = decideNotification(everyChange, contestBase, resultsMid, T0)
  t('every_change: the first change sends an update', d1.kind === 'update')
  t('an update writes back both the throttle stamp and the snapshot',
    d1.patch.last_notified_at === T0.toISOString() && d1.patch.last_snapshot.votes['Marla Vandenberg'] === 24318 &&
    d1.patch.winner_notified_at === undefined)

  // second change 10 minutes later → suppressed
  const subAfter1 = { ...everyChange, last_notified_at: d1.patch.last_notified_at, last_snapshot: d1.patch.last_snapshot }
  const movedResults = [{ ...resultsMid[0], votes: 25900 }, resultsMid[1]]
  const d2 = decideNotification(subAfter1, { ...contestBase, precincts_rptg: 44 }, movedResults, at(10))
  t('every_change: a second change 10 minutes later is throttled',
    d2.kind === 'none' && /throttled/.test(d2.reason) && d2.patch === null)
  t('the throttle window is exactly 30 minutes', THROTTLE_MS === 30 * 60 * 1000)
  t('every_change: the same change 31 minutes later does send',
    decideNotification(subAfter1, { ...contestBase, precincts_rptg: 44 }, movedResults, at(31)).kind === 'update')
  t('every_change: no change at all sends nothing, however long it has been', (() => {
    const d = decideNotification(subAfter1, contestBase, resultsMid, at(600))
    return d.kind === 'none' && /no change/.test(d.reason)
  })())

  // winner bypasses the throttle, exactly once
  const d3 = decideNotification(subAfter1, calledContest, resultsFinal, at(2))
  t('a called race sends the winner email 2 minutes after an update — throttle ignored',
    d3.kind === 'winner')
  t('the winner send stamps winner_notified_at', d3.patch.winner_notified_at === at(2).toISOString())
  const subAfterWinner = { ...subAfter1, winner_notified_at: d3.patch.winner_notified_at, last_notified_at: d3.patch.last_notified_at, last_snapshot: d3.patch.last_snapshot }
  t('the winner email is sent exactly once, ever',
    decideNotification(subAfterWinner, calledContest, resultsFinal, at(400)).kind === 'none')
  t('a certified contest also counts as decided',
    decideNotification(everyChange, { ...contestBase, status: 'certified' }, resultsFinal, T0).kind === 'winner')
  t('a declared result row counts as decided even when the status lags',
    decideNotification(everyChange, contestBase, resultsFinal, T0).kind === 'winner')

  // final_only
  t('final_only: a numbers change sends nothing', (() => {
    const d = decideNotification(finalOnly, contestBase, resultsMid, T0)
    return d.kind === 'none' && /final_only/.test(d.reason)
  })())
  t('final_only: the winner email still arrives',
    decideNotification(finalOnly, calledContest, resultsFinal, T0).kind === 'winner')
  t('final_only: the winner email also arrives exactly once',
    decideNotification({ ...finalOnly, winner_notified_at: T0.toISOString() }, calledContest, resultsFinal, at(60)).kind === 'none')

  // recount transition
  const d4 = decideNotification(subAfter1, recountContest, recountResults, at(5))
  t('entering recount_possible emails both modes, throttle ignored',
    d4.kind === 'recount' &&
    decideNotification({ ...finalOnly, last_snapshot: subAfter1.last_snapshot }, recountContest, recountResults, at(5)).kind === 'recount')
  t('the recount email does NOT consume the winner announcement',
    d4.patch.winner_notified_at === undefined)
  const subAfterRecount = { ...subAfter1, last_notified_at: d4.patch.last_notified_at, last_snapshot: d4.patch.last_snapshot }
  t('a second identical recount_possible pass sends nothing',
    decideNotification(subAfterRecount, recountContest, recountResults, at(90)).kind === 'none')
  t('final_only stays silent while a recount race keeps re-reporting the same status',
    decideNotification({ ...finalOnly, last_snapshot: d4.patch.last_snapshot }, recountContest, recountResults, at(90)).kind === 'none')
  t('once the recount race is called, the winner email still goes out',
    decideNotification(subAfterRecount, { ...recountContest, status: 'called' }, resultsFinal, at(120)).kind === 'winner')
  t('decideNotification never throws on junk', (() => {
    try {
      decideNotification(undefined, undefined, undefined, undefined)
      decideNotification({ mode: 'nonsense', last_snapshot: 'x' }, { status: 7 }, 'nope', 'not-a-date')
      return true
    } catch { return false }
  })())
}

// ═══════════════════════════════════════════════════════════════════════════
// Aug 2026 election-night QA fixes (Tier 1 #6–#10, Tier 2, Tier 3)
// Everything below must stay ABOVE the summary/process.exit lines.
// ═══════════════════════════════════════════════════════════════════════════

// ── T1#7 / T2: truncated-reply salvage + district-aware contest matching ────
{
  console.log('QA fixes — truncated reply salvage + contest matching')
  const {
    salvageJsonObjects, parseContestsLoose, matchContest, districtCountyAgree,
    winnerFlagAction, fatalNotesOnly, RUN_BUDGET_MS, TIER1_TIMEOUT_MS,
  } = require('../netlify/functions/election-results-poller.js')

  // A reply that ran out of tokens mid-way through the third contest.
  const truncated = '{"contests":[' +
    '{"office":"Governor — Democratic Primary","candidates":[{"name":"A A","votes":10}],"source":"clerk"},' +
    '{"office":"Governor — Republican Primary","candidates":[{"name":"B B","votes":20}],"source":"AP"},' +
    '{"office":"Attorney General — Demo'
  const salv = parseContestsLoose(truncated)
  t('a truncated reply still yields the contests that arrived whole',
    salv.salvaged === true && salv.contests.length === 2 &&
    salv.contests[0].office === 'Governor — Democratic Primary' &&
    salv.contests[1].candidates[0].votes === 20)
  t('the half-written contest at the cut is dropped, never guessed',
    !salv.contests.some(c => /Attorney General/.test(c.office || '')))
  t('salvage survives braces and brackets inside strings',
    (salvageJsonObjects('{"contests":[{"office":"Sheriff {Marathon} [x]","source":"a \\" b","candidates":[]},{"office":"cut')
      || [{}])[0].office === 'Sheriff {Marathon} [x]')
  t('a WHOLE reply is still parsed strictly, not salvaged',
    parseContestsLoose('{"contests":[{"office":"X","candidates":[],"source":"s"}]}').salvaged === false)
  t('a bare array reply is still accepted',
    parseContestsLoose('[{"office":"X","candidates":[],"source":"s"}]').contests.length === 1)
  t('an unusable reply is still nothing at all, never a guess',
    parseContestsLoose('sorry, I could not find results').contests === null &&
    parseContestsLoose('').contests === null)

  // — T2: district / county cross-check on a LOOSE match —
  const seeded8 = [{ id: 'c8', office: 'State Assembly District 8', district: 'District 8' }]
  t('"District 85" numbers are NOT written into the seeded District 8 race',
    matchContest('State Assembly District 85', seeded8) === null)
  t('the district word boundary is digit-aware, not \\b',
    districtCountyAgree('State Assembly District 85', { district: 'District 8' }) === false &&
    districtCountyAgree('State Assembly District 8 — Democratic Primary', { district: 'District 8' }) === true)
  t('a loose match with the RIGHT district still lands',
    matchContest('State Assembly District 8 — Democratic Primary', seeded8) !== null)
  const twoCounties = [
    { id: 'm', office: 'Sheriff — Republican Primary', county: 'Marathon' },
  ]
  t('one county\'s sheriff numbers cannot be written into another county\'s race',
    matchContest('Sheriff — Republican Primary — Portage County', twoCounties) === null)
  t('the SAME county still matches loosely',
    (matchContest('Marathon County Sheriff — Republican Primary', twoCounties) || {}).id === 'm')
  t('an EXACT office-name match is unaffected by the cross-check',
    matchContest('State Assembly District 8', seeded8).id === 'c8')
  t('a contest with no district or county behaves exactly as before',
    matchContest('Governor — Democratic', [{ id: 'g', office: 'Governor — Democratic Primary' }]).id === 'g')

  // — T1#9: winner flags —
  t('winner flags are applied ONLY on a called race',
    winnerFlagAction('called', 'reporting', { margin: 5 }) === 'apply' &&
    winnerFlagAction('recount_possible', 'reporting', { margin: 5 }) !== 'apply')
  t('entering recount_possible CLEARS any stale winner flags',
    winnerFlagAction('recount_possible', 'too_close', { margin: 3 }) === 'clear')
  t('a race already sitting in recount_possible is left alone',
    winnerFlagAction('recount_possible', 'recount_possible', { margin: 3 }) === 'none')
  t('a called race with a zero margin still flags nobody',
    winnerFlagAction('called', 'reporting', { margin: 0 }) === 'none' &&
    winnerFlagAction('called', 'reporting', null) === 'none')
  t('the admin console applies the identical rule', (() => {
    const admin = require('../netlify/functions/admin-elections.js')
    return admin.winnerFlagAction('called', 'reporting', { margin: 5 }) === 'apply' &&
      admin.winnerFlagAction('recount_possible', 'reporting', { margin: 5 }) === 'clear' &&
      admin.winnerFlagAction('recount_possible', 'recount_possible', { margin: 5 }) === 'none'
  })())

  // — T2: poller-log hygiene —
  t('a healthy run writes error = null (informational notes stay in the JSON)',
    fatalNotesOnly([
      'Tier 2 rotation: chunk(s) 0, 1 of 16 (124 contest(s) in the stable rotation).',
      'Discovery created 9 contest(s) with 31 candidate row(s).',
      'Notifications: 4 subscription(s) checked, nothing worth emailing yet.',
    ]).length === 0)
  t('fatals, quarantines, skips and deferrals DO reach the error column',
    fatalNotesOnly([
      'FATAL: elections lookup failed',
      'Governor: no source cited for these numbers — quarantined, nothing written',
      'Tier 2 chunk 3/15: only 900ms of the run budget left — deferred to the next cycle.',
      'Reported contest "x" does not match any contest on file — skipped.',
      'Tier 2 rotation: chunk(s) 0, 1 of 16.',
    ]).length === 4)
  t('note filtering never throws on junk', (() => {
    try { fatalNotesOnly(null); fatalNotesOnly([null, 7, {}, undefined]); return true } catch { return false }
  })())

  // — T1#6: the lighter, deadline-aware run shape —
  t('the run budget dropped to 18s and is env-overridable',
    RUN_BUDGET_MS === 18000 && TIER1_TIMEOUT_MS === 10000)
}

// ── T1#6 + T3: deadline-aware writes, FK-join load, 429 gate ────────────────
{
  console.log('QA fixes — deadline-aware writes, FK-join load, Perplexity 429 gate')
  const {
    loadContests, updatePass, queryPerplexity, makeRunGate,
  } = require('../netlify/functions/election-results-poller.js')

  // — T3: the results load is an FK join, never a 250-id .in() —
  const queries = []
  const sbLoad = {
    from(table) {
      const st = { table, selects: [], filters: [] }
      queries.push(st)
      const chain = {
        select(s) { st.selects.push(String(s)); return chain },
        eq(c, v) { st.filters.push([c, v]); return chain },
        in(c, v) { st.filters.push([c, v, 'in']); return chain },
        then(ok, no) {
          const data = table === 'election_contests'
            ? [{ id: 'c1', office: 'Sheriff' }, { id: 'c2', office: 'Coroner' }]
            : [{ id: 'r1', contest_id: 'c1', candidate_name: 'Ann Lee', votes: 5, party: 'Republican',
                 election_contests: { election_id: 'E1' } }]
          return Promise.resolve({ data, error: null }).then(ok, no)
        },
      }
      return chain
    },
  }
  const loaded = await loadContests(sbLoad, 'E1')
  t('results are loaded through the FK join, with no id list in the URL',
    queries[1].table === 'election_results' &&
    queries[1].selects[0].includes('election_contests!inner(election_id)') &&
    queries[1].filters.some(([c, v]) => c === 'election_contests.election_id' && v === 'E1') &&
    !queries[1].filters.some(f => f[2] === 'in'))
  t('the joined key is stripped, so downstream row shape is unchanged',
    loaded[0]._results.length === 1 &&
    !('election_contests' in loaded[0]._results[0]) &&
    loaded[0]._results[0].candidate_name === 'Ann Lee' &&
    loaded[1]._results.length === 0)

  // — T3: one 429 stops the run from dispatching anything else —
  const realFetch = global.fetch
  const realKey = process.env.PERPLEXITY_API_KEY
  process.env.PERPLEXITY_API_KEY = 'test-key'
  let calls = 0
  global.fetch = async () => { calls++; return { ok: false, status: 429, text: async () => 'rate limited' } }
  const gate = makeRunGate()
  const first  = await queryPerplexity({ system: 's', user: 'u', timeoutMs: 5000, gate })
  const second = await queryPerplexity({ system: 's', user: 'u', timeoutMs: 5000, gate })
  t('an HTTP 429 closes the gate for the rest of the run',
    gate.rateLimited === true && /429/.test(first.error) && calls === 1)
  t('later calls this run are skipped instead of dispatched',
    calls === 1 && second.text === null && /skipped/.test(second.error))
  t('a fresh run gets a fresh gate', makeRunGate().rateLimited === false)

  // — T1#6: the write pass stops cleanly at the deadline —
  const reply = JSON.stringify({ contests: [
    { office: 'Sheriff — Republican Primary', candidates: [{ name: 'Ann Lee', votes: 120 }], source: 'Marathon County Clerk' },
  ] })
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: reply } }] }) })

  const contests = [{
    id: 'c1', office: 'Sheriff — Republican Primary', county: 'Marathon', seats: 1,
    status: 'reporting', status_source: 'auto', precincts_total: 10, precincts_rptg: 5,
    _results: [{ id: 'r1', candidate_name: 'Ann Lee', votes: 10 }],
  }]
  const election = { id: 'E1', name: 'Partisan Primary', election_date: '2026-08-11' }

  const writes = []
  const sbWrite = {
    from(table) {
      writes.push(table)
      const chain = {
        select() { return chain }, eq() { return chain }, in() { return chain },
        upsert() { return chain }, update() { return chain },
        then(ok, no) { return Promise.resolve({ data: [], error: null }).then(ok, no) },
      }
      return chain
    },
  }

  const touchedLate = { contests: new Set(), results: new Set() }
  const late = await updatePass(sbWrite, election, contests, {
    dryRun: false, bootstrappedIds: new Set(), touched: touchedLate,
    timeoutMs: 5000, deadline: Date.now() - 1,
  })
  t('past the run deadline the write pass writes nothing at all',
    late.contests === 0 && writes.length === 0 && touchedLate.contests.size === 0)
  t('the deferred contests are named in the notes, so the log row records them',
    late.deferred === 1 && late.notes.some(n => /deferred/.test(n) && /Sheriff/.test(n)))

  const touchedOk = { contests: new Set(), results: new Set() }
  const inTime = await updatePass(sbWrite, election, contests, {
    dryRun: false, bootstrappedIds: new Set(), touched: touchedOk,
    timeoutMs: 5000, deadline: Date.now() + 60000,
  })
  t('with budget left the same contest is written normally',
    inTime.contests === 1 && inTime.deferred === 0 && touchedOk.contests.has('c1') &&
    writes.includes('election_results'))

  global.fetch = realFetch
  if (realKey === undefined) delete process.env.PERPLEXITY_API_KEY
  else process.env.PERPLEXITY_API_KEY = realKey
}

// ── T3: stable chunk assignment ─────────────────────────────────────────────
{
  console.log('QA fixes — stable tier-2 chunk assignment')
  const { chunkIndexOf, selectRotationChunks, tierTwoQueue } =
    require('../netlify/functions/election-results-poller.js')
  const ct = (hour, minute = 0) => ({ hour, minute, minutes: hour * 60 + minute })

  const field = Array.from({ length: 30 }, (_, i) => ({
    id: `asm-${String(i).padStart(3, '0')}`, office_type: 'state_assembly', status: 'reporting',
  }))
  const before = new Map(field.map(c => [c.id, chunkIndexOf(c.id, field, 8)]))

  // Six races get called during the night; nobody else may move chunk.
  const after = field.map((c, i) => (i % 5 === 0 ? { ...c, status: 'called' } : c))
  t('a contest being called does NOT move any other contest to a new chunk',
    after.every(c => chunkIndexOf(c.id, after, 8) === before.get(c.id)))
  t('the called contests keep their own chunk seat too',
    after.filter(c => c.status === 'called').every(c => chunkIndexOf(c.id, after, 8) === before.get(c.id)))
  t('the 11 PM waiting re-sort does not move anybody either', (() => {
    const late = field.map((c, i) => (i % 3 === 0 ? { ...c, status: 'waiting' } : c))
    return late.every(c => chunkIndexOf(c.id, late, 8) === before.get(c.id))
  })())

  const rot = selectRotationChunks(tierTwoQueue(after), ct(20, 0), { size: 8, maxCalls: 2, cadence: 'every 5 minutes' })
  t('every contest still has a chunk, called or not',
    rot.chunks.reduce((s, c) => s + c.length, 0) === 30 && rot.nChunks === 4)
  t('a called race still counting stays in its chunk; only fully-counted drop',
    rot.selected.flat().some(c => c.status === 'called') || rot.selected.flat().every(c => c.status !== 'certified'))
  t('an all-decided chunk simply yields no work', (() => {
    const allDone = field.map(c => ({ ...c, status: 'certified' }))
    return selectRotationChunks(tierTwoQueue(allDone), ct(20, 0), { size: 8, maxCalls: 2 })
      .selected.every(list => list.length === 0)
  })())
}

// ── T1#8 / T2: the notifier's decisions ─────────────────────────────────────
{
  console.log('QA fixes — first-sight seeding, zero-vote suppression, delivery backoff')
  const {
    decideNotification, snapshotOf, snapshotChanged,
    deliveryStateOf, shouldBackOff, markDeliveryFailure, clearDeliveryState, hasBaseline,
    MAX_DELIVERY_FAILS, DELIVERY_BACKOFF_MS,
  } = require('../netlify/functions/_result-notify.js')

  const NOW = new Date('2026-08-12T02:00:00Z')
  const contest = {
    id: 'c1', election_id: 'e1', office: 'Sheriff — Republican Primary', county: 'Marathon',
    seats: 1, status: 'reporting', precincts_rptg: 4, precincts_total: 10,
  }
  const rows = [
    { candidate_name: 'Ann Lee', votes: 1200, vote_pct: 60 },
    { candidate_name: 'Bo Ray', votes: 800, vote_pct: 40 },
  ]
  const fresh = { id: 's1', mode: 'every_change', last_notified_at: null, last_snapshot: null, winner_notified_at: null }

  // — first sight: seed, never send —
  const seed = decideNotification(fresh, contest, rows, NOW)
  t('a brand-new subscription is SEEDED, not emailed (no table of zeros)',
    seed.kind === 'none' && /first sight/.test(seed.reason))
  t('the seeding patch writes the baseline snapshot and nothing else',
    seed.patch.last_snapshot.votes['Ann Lee'] === 1200 &&
    seed.patch.winner_notified_at === undefined &&
    seed.patch.last_notified_at === undefined)
  t('the very next real change DOES email',
    decideNotification({ ...fresh, last_snapshot: seed.patch.last_snapshot },
      { ...contest, precincts_rptg: 6 },
      [{ candidate_name: 'Ann Lee', votes: 1500 }, rows[1]], NOW).kind === 'update')

  // — first sight of a race that was already decided —
  const alreadyCalled = { ...contest, status: 'called', precincts_rptg: 10 }
  const seedCalled = decideNotification(fresh, alreadyCalled, rows, NOW)
  t('subscribing to an ALREADY-called race fires no retroactive winner email',
    seedCalled.kind === 'none' && /already-decided/.test(seedCalled.reason))
  t('…and it seeds winner_notified_at so the next admin touch stays quiet',
    seedCalled.patch.winner_notified_at === NOW.toISOString() &&
    seedCalled.patch.last_snapshot.status === 'called')
  t('a race decided only by a declared ROW is caught by the same rule',
    decideNotification(fresh, contest, [{ candidate_name: 'Ann Lee', votes: 9, declared: true }], NOW)
      .patch.winner_notified_at === NOW.toISOString())
  t('a race that is decided AFTER the baseline still sends the winner email',
    decideNotification({ ...fresh, last_snapshot: seed.patch.last_snapshot }, alreadyCalled, rows, NOW).kind === 'winner')

  // — zero votes + waiting: never an email —
  const waiting = { ...contest, status: 'waiting', precincts_rptg: 0 }
  const zeroRows = [{ candidate_name: 'Ann Lee', votes: 0 }, { candidate_name: 'Bo Ray', votes: 0 }]
  const seenWaiting = { ...fresh, last_snapshot: snapshotOf({ ...waiting, precincts_rptg: 0 }, [{ candidate_name: 'Ann Lee', votes: 0 }]) }
  // Precincts moved (and a second zero-vote candidate row appeared), so the
  // snapshot HAS changed — but there is still nothing to say.
  const zero = decideNotification(seenWaiting, { ...waiting, precincts_rptg: 2 }, zeroRows, NOW)
  t('a zero-vote race still on "waiting" is never emailed, however much churns',
    zero.kind === 'none' && /no votes reported yet/.test(zero.reason) && zero.patch === null)
  t('the same race DOES email once a single vote is reported',
    decideNotification(seenWaiting, { ...waiting, status: 'reporting' },
      [{ candidate_name: 'Ann Lee', votes: 1 }], NOW).kind === 'update')

  // — delivery backoff, stored under last_snapshot._delivery (no migration) —
  const base = snapshotOf(contest, rows)
  t('a clean subscription has no delivery failures on file',
    deliveryStateOf({ last_snapshot: base }).fails === 0 && shouldBackOff({ last_snapshot: base }, NOW) === false)
  const failed1 = markDeliveryFailure({ last_snapshot: base }, NOW)
  t('a failure is recorded inside last_snapshot, keeping the race picture',
    failed1._delivery.fails === 1 && failed1.votes['Ann Lee'] === 1200 && failed1.status === 'reporting')
  let acc = { last_snapshot: base }
  for (let i = 0; i < MAX_DELIVERY_FAILS; i++) acc = { last_snapshot: markDeliveryFailure(acc, NOW) }
  t(`${MAX_DELIVERY_FAILS} failures inside 6 hours stops the retries`,
    deliveryStateOf(acc).fails === MAX_DELIVERY_FAILS && shouldBackOff(acc, NOW) === true)
  t('four failures is still worth another try',
    shouldBackOff({ last_snapshot: { ...base, _delivery: { fails: 4, last_fail_at: NOW.toISOString() } } }, NOW) === false)
  t('the backoff expires after six hours',
    shouldBackOff(acc, new Date(NOW.getTime() + DELIVERY_BACKOFF_MS + 1000)) === false)
  t('a successful send clears the counter',
    clearDeliveryState(failed1)._delivery === undefined && clearDeliveryState(failed1).votes['Ann Lee'] === 1200)
  t('_delivery is NOT part of the change picture',
    snapshotChanged({ ...base, _delivery: { fails: 3, last_fail_at: NOW.toISOString() } }, base) === false)
  t('a row carrying ONLY _delivery is not a baseline, so first sight still seeds',
    hasBaseline({ _delivery: { fails: 2 } }) === false &&
    decideNotification({ ...fresh, last_snapshot: { _delivery: { fails: 2 } } }, contest, rows, NOW).kind === 'none')
  t('the backoff helpers never throw on junk', (() => {
    try {
      deliveryStateOf(null); deliveryStateOf({ last_snapshot: 'x' })
      shouldBackOff(undefined, 'nope'); markDeliveryFailure(null, 'nope'); clearDeliveryState(null)
      return true
    } catch { return false }
  })())
}

// ── T1#10 / T2: the notifier runner (mocked Supabase + mailer) ──────────────
{
  console.log('QA fixes — notifier runner: skipped sends, backoff, deadline, concurrency')
  const emailer = require('../netlify/functions/_email.js')
  const realSend = emailer.sendEmail
  const {
    notifyContestChanges, snapshotOf, runPool, NOTIFY_CONCURRENCY,
  } = require('../netlify/functions/_result-notify.js')

  const CID = 'aaaaaaaa-1111-4111-8111-111111111111'
  const EID = 'bbbbbbbb-2222-4222-8222-222222222222'
  const contestRow = {
    id: CID, election_id: EID, office: 'Sheriff — Republican Primary', district: null,
    county: 'Marathon', seats: 1, status: 'reporting', status_detail: null,
    precincts_rptg: 6, precincts_total: 10,
  }
  const resultRows = [
    { contest_id: CID, candidate_name: 'Ann Lee', party: 'Republican', votes: 1500, vote_pct: 60, winner: false, declared: false },
    { contest_id: CID, candidate_name: 'Bo Ray', party: 'Republican', votes: 1000, vote_pct: 40, winner: false, declared: false },
  ]
  const staleSnapshot = snapshotOf({ ...contestRow, precincts_rptg: 3 }, [
    { candidate_name: 'Ann Lee', votes: 900 }, { candidate_name: 'Bo Ray', votes: 800 },
  ])

  const mkDb = (subs) => ({
    election_subscriptions: subs.map(s => ({ ...s })),
    election_contests: [{ ...contestRow }],
    election_results: resultRows.map(r => ({ ...r })),
    elections: [{ id: EID, name: 'Partisan Primary' }],
  })
  const mkClient = (db) => ({
    from(table) {
      const st = { filters: [], op: null, payload: null }
      const rows = () => (db[table] || []).filter(r =>
        st.filters.every(([c, v, op]) => (op === 'in' ? v.includes(r[c]) : r[c] === v)))
      const chain = {
        select() { return chain },
        eq(c, v) { st.filters.push([c, v]); return chain },
        in(c, v) { st.filters.push([c, v, 'in']); return chain },
        update(p) { st.op = 'update'; st.payload = p; return chain },
        then(ok, no) {
          if (st.op === 'update') {
            const hit = rows()
            hit.forEach(r => Object.assign(r, st.payload))
            return Promise.resolve({ data: hit, error: null }).then(ok, no)
          }
          return Promise.resolve({ data: rows(), error: null }).then(ok, no)
        },
      }
      return chain
    },
    auth: { admin: { getUserById: async (id) => ({ data: { user: { email: `${id}@example.test` } }, error: null }) } },
  })

  const sub = (over = {}) => ({
    id: `sub-${Math.random().toString(36).slice(2, 8)}`, user_id: 'user-1', contest_id: CID,
    mode: 'every_change', last_notified_at: null, last_snapshot: staleSnapshot, winner_notified_at: null,
    ...over,
  })

  // — T1#10: a "skipped" send is a FAILURE, and must not be booked as sent —
  emailer.sendEmail = async () => ({ skipped: true })
  let db = mkDb([sub()])
  let out = await notifyContestChanges(mkClient(db), [CID], { trigger: 'test' })
  t('a skipped send counts as failed, never as sent',
    out.sent === 0 && out.failed === 1)
  t('a skipped send writes NO delivery bookkeeping, so the email is retried',
    db.election_subscriptions[0].last_notified_at === null &&
    db.election_subscriptions[0].winner_notified_at === null)
  t('a skipped send only bumps the failure counter',
    db.election_subscriptions[0].last_snapshot._delivery.fails === 1 &&
    db.election_subscriptions[0].last_snapshot.votes['Ann Lee'] === 900)

  // — a real send books the bookkeeping and clears the counter —
  const sentTo = []
  emailer.sendEmail = async ({ to, subject }) => { sentTo.push(`${to}|${subject}`); return { id: 'msg_1' } }
  db = mkDb([sub({ last_snapshot: { ...staleSnapshot, _delivery: { fails: 2, last_fail_at: new Date().toISOString() } } })])
  out = await notifyContestChanges(mkClient(db), [CID], { trigger: 'test' })
  t('a delivered update books last_notified_at and the new snapshot',
    out.sent === 1 && out.failed === 0 &&
    db.election_subscriptions[0].last_notified_at !== null &&
    db.election_subscriptions[0].last_snapshot.votes['Ann Lee'] === 1500)
  t('a delivered email clears the failed-attempt counter',
    db.election_subscriptions[0].last_snapshot._delivery === undefined)

  // — first sight through the runner: seeded, no email —
  db = mkDb([sub({ last_snapshot: null })])
  const before = sentTo.length
  out = await notifyContestChanges(mkClient(db), [CID], { trigger: 'test' })
  t('the runner seeds a first-sight subscription without sending anything',
    out.sent === 0 && sentTo.length === before &&
    db.election_subscriptions[0].last_snapshot.votes['Ann Lee'] === 1500 &&
    db.election_subscriptions[0].last_notified_at === null)

  // — backoff: a hard-bouncing address is left alone —
  db = mkDb([sub({ last_snapshot: { ...staleSnapshot, _delivery: { fails: 5, last_fail_at: new Date().toISOString() } } })])
  const beforeBounce = sentTo.length
  out = await notifyContestChanges(mkClient(db), [CID], { trigger: 'test' })
  t('a five-times-failed address is skipped for six hours, costing nothing',
    out.sent === 0 && out.skipped === 1 && sentTo.length === beforeBounce &&
    out.notes.some(n => /backing off/.test(n)))

  // — deadline: nothing is started that cannot be finished —
  db = mkDb([sub(), sub(), sub()])
  const beforeDeadline = sentTo.length
  out = await notifyContestChanges(mkClient(db), [CID], { trigger: 'test', deadline: Date.now() - 1 })
  t('past the deadline the notifier starts no new work',
    out.sent === 0 && out.deferred === 3 && sentTo.length === beforeDeadline)
  t('deferred subscriptions keep their old bookkeeping, so the next run retries them',
    db.election_subscriptions.every(s => s.last_notified_at === null && s.last_snapshot.votes['Ann Lee'] === 900))
  t('the deferral is noted for the poller log', out.notes.some(n => /deferred/.test(n)))

  // — the pool: 4 at a time, error-isolated —
  db = mkDb(Array.from({ length: 9 }, (_, i) => sub({ user_id: `user-${i}` })))
  let inFlight = 0, peak = 0
  emailer.sendEmail = async () => {
    inFlight++; peak = Math.max(peak, inFlight)
    await new Promise(r => setTimeout(r, 2))
    inFlight--
    return { id: 'msg' }
  }
  out = await notifyContestChanges(mkClient(db), [CID], { trigger: 'test' })
  t('all nine subscribers are emailed', out.sent === 9 && out.failed === 0)
  t(`sends run ${NOTIFY_CONCURRENCY} at a time, not one after another`,
    peak > 1 && peak <= NOTIFY_CONCURRENCY)

  // — one exploding subscription cannot take the pass down —
  let n = 0
  emailer.sendEmail = async () => { n++; if (n === 2) throw new Error('resend exploded'); return { id: 'msg' } }
  db = mkDb([sub(), sub(), sub()])
  out = await notifyContestChanges(mkClient(db), [CID], { trigger: 'test' })
  t('one thrown send is isolated; the rest still go out',
    out.sent === 2 && out.failed === 1)

  // — runPool itself —
  {
    let live = 0, high = 0
    const done = []
    await runPool(Array.from({ length: 10 }, (_, i) => i), 4, async (i) => {
      live++; high = Math.max(high, live)
      try {
        await new Promise(r => setTimeout(r, 1))
        if (i === 3) throw new Error('boom')
        done.push(i)
      } finally { live-- }
    })
    t('runPool caps concurrency and finishes every other item',
      high <= 4 && high > 1 && done.length === 9 && !done.includes(3))
    t('runPool on an empty list is a no-op', (await runPool([], 4, async () => { throw new Error('never') })) === undefined)
  }

  emailer.sendEmail = realSend
}


// ── 10:30 PM CT election-night embargo ───────────────────────────────────────
{
  const { callEmbargoActive } = require('../netlify/functions/election-results-poller.js')
  const { winnerEmbargoActive, decideNotification } = require('../netlify/functions/_result-notify.js')
  const ctInstant = (h, m) => new Date(Date.UTC(2026, 7, 12, (h + 5) % 24, m)) // CDT = UTC-5; 8/11 CT evening
  const eight = new Date(Date.UTC(2026, 7, 12, 1, 15))   // 8:15 PM CT Aug 11
  const tenTwentyNine = new Date(Date.UTC(2026, 7, 12, 3, 29))
  const tenThirty = new Date(Date.UTC(2026, 7, 12, 3, 30))
  t('embargo holds at 8:15 PM CT on election day', callEmbargoActive(eight, ['2026-08-11']) === true)
  t('embargo holds at 10:29 PM CT', callEmbargoActive(tenTwentyNine, ['2026-08-11']) === true)
  t('embargo lifts at exactly 10:30 PM CT', callEmbargoActive(tenThirty, ['2026-08-11']) === false)
  t('no embargo the morning after', callEmbargoActive(new Date(Date.UTC(2026, 7, 12, 15, 0)), ['2026-08-11']) === false)
  t('notifier embargo mirrors the poller clock',
    winnerEmbargoActive('2026-08-11', eight) === true && winnerEmbargoActive('2026-08-11', tenThirty) === false)
  const sub = { mode: 'every_change', last_snapshot: { votes: { A: 10, B: 5 }, precincts_rptg: 1, status: 'reporting' } }
  const calledContest = { status: 'called', precincts_rptg: 10, precincts_total: 10 }
  const rows = [{ candidate_name: 'A', votes: 100, winner: true }, { candidate_name: 'B', votes: 50 }]
  const embargoed = decideNotification(sub, calledContest, rows, eight, { winnerEmbargo: true })
  t('winner email withheld under embargo, bookkeeping untouched',
    embargoed.kind === 'none' && embargoed.patch === null && /embargo/.test(embargoed.reason))
  const after = decideNotification(sub, calledContest, rows, tenThirty, { winnerEmbargo: false })
  t('the same touch after the embargo sends the winner email', after.kind === 'winner')
}

// ── Stripe price resolution shared by checkout + admin plan changes ──────────
// admin-billing.js now resolves the price BEFORE writing app_metadata, and
// resolves it for the subscriber's ACTUAL billing interval instead of always _M.
{
  console.log('Stripe price resolution (create-checkout-session exports)')
  const { resolvePriceId, billingPeriodFromPrice, getPriceEnvKey } =
    await import('../netlify/functions/create-checkout-session.js')

  t('candidate plans build a bracket-free price key',
    getPriceEnvKey('c_active', 'b1', 'monthly') === 'STRIPE_PRICE_C_ACTIVE_M')
  t('action plans keep the bracket segment',
    getPriceEnvKey('a_active', 'b2_5', 'annual') === 'STRIPE_PRICE_A_ACTIVE_B2_5_A')
  t('a candidate plan resolves to a baked-in price id',
    typeof resolvePriceId('c_active', 'b1', 'monthly').priceId === 'string')
  t('the billing period changes which price is resolved',
    resolvePriceId('a_active', 'b2_5', 'monthly').priceId !== resolvePriceId('a_active', 'b2_5', 'annual').priceId)
  t('an unconfigured price resolves to null, never undefined',
    resolvePriceId('nope', 'b1', 'monthly').priceId === null)

  t('monthly interval → monthly',    billingPeriodFromPrice({ recurring: { interval: 'month', interval_count: 1 } }) === 'monthly')
  t('3-month interval → quarterly',  billingPeriodFromPrice({ recurring: { interval: 'month', interval_count: 3 } }) === 'quarterly')
  t('6-month interval → semiannual', billingPeriodFromPrice({ recurring: { interval: 'month', interval_count: 6 } }) === 'semiannual')
  t('yearly interval → annual',      billingPeriodFromPrice({ recurring: { interval: 'year',  interval_count: 1 } }) === 'annual')
  t('12-month interval → annual',    billingPeriodFromPrice({ recurring: { interval: 'month', interval_count: 12 } }) === 'annual')
  t('a one-time price falls back to monthly', billingPeriodFromPrice({}) === 'monthly' && billingPeriodFromPrice(null) === 'monthly')
}

// ── Party vocabulary — one normalizer for every spelling ─────────────────────
// The AD77 "+R" bug (Aug 12 2026): election_results carried BOTH 'Democrat' and
// 'Democratic' while call sites compared strictly against 'Democrat', so
// Democratic votes counted as zero and deep-blue districts painted red.
// partyGroup() is now the single vocabulary — and the CJS copy used by the
// Netlify functions must agree with the ESM one exactly.
{
  console.log('Party vocabulary — src/lib/party.js + netlify/functions/_party.js')
  const {
    partyGroup, isDem, isRep, partyAbbrev, partyColorHex, partyMapHex, partyBadgeClasses,
  } = await import('../src/lib/party.js')
  const cjs = require('../netlify/functions/_party.js')

  t("'Democrat' and 'Democratic' are the same party",
    partyGroup('Democrat') === 'D' && partyGroup('Democratic') === 'D')
  t('DEM / dem / d normalize to D',
    ['DEM', 'dem', 'd', 'D', 'Democratic Party', ' democrat '].every(v => partyGroup(v) === 'D'))
  t('Republican / GOP / REP / rep normalize to R',
    ['Republican', 'GOP', 'gop', 'REP', 'rep', 'R'].every(v => partyGroup(v) === 'R'))
  t('Nonpartisan → N; null, undefined, empty and unknown → O',
    partyGroup('Nonpartisan') === 'N' && partyGroup(null) === 'O' &&
    partyGroup(undefined) === 'O' && partyGroup('') === 'O' && partyGroup('Pirate') === 'O')
  t('isDem / isRep follow the family, never the spelling',
    isDem('Democratic') && isDem('DEM') && !isDem('Republican') &&
    isRep('GOP') && isRep('rep') && !isRep('Democrat') && !isDem(null) && !isRep(null))
  t('both Democrat spellings share one color, map dot and badge',
    partyColorHex('Democrat') === partyColorHex('Democratic') &&
    partyMapHex('Democrat') === partyMapHex('Democratic') &&
    partyBadgeClasses('Democrat') === partyBadgeClasses('Democratic'))
  t('abbrev is the family letter, with ? for nothing at all',
    partyAbbrev('Democratic') === 'D' && partyAbbrev('GOP') === 'R' &&
    partyAbbrev('Nonpartisan') === 'N' && partyAbbrev(null) === '?')

  const VOCAB = [
    'Democrat', 'Democratic', 'DEM', 'dem', 'Republican', 'GOP', 'REP', 'rep',
    'Nonpartisan', 'Independent', 'Libertarian', 'Green', 'Pirate', '', null, undefined,
  ]
  t('the CJS mirror agrees with the ESM helper on every spelling',
    VOCAB.every(v =>
      cjs.partyGroup(v) === partyGroup(v) &&
      cjs.partyAbbrev(v) === partyAbbrev(v) &&
      cjs.partyColorHex(v) === partyColorHex(v) &&
      cjs.isDem(v) === isDem(v) && cjs.isRep(v) === isRep(v)))
}

// ── Certification watch — eligibility window + cited-verdict parsing ─────────
// After election night contests sat at 'called' forever. The weekly sweep asks
// ONE question per election and may only write on a CITED "CERTIFIED": an
// answer with no source URL is exactly as worthless as no answer, and
// certifying an election that has not been canvassed is unrecoverable.
{
  console.log('Certification watch — netlify/functions/certification-watch.js + _certify.js')
  const cw = require('../netlify/functions/certification-watch.js')
  const { appendCertifyReason, CERTIFY_REASON } = require('../netlify/functions/_certify.js')

  // ── window date math (pure string/UTC, no time zone) ──
  t('shiftDays walks backwards across a month boundary',
    cw.shiftDays('2026-08-14', -14) === '2026-07-31')
  t('shiftDays walks across a leap day',
    cw.shiftDays('2028-03-01', -1) === '2028-02-29')
  t('shiftDays rejects garbage instead of guessing a date',
    cw.shiftDays('not-a-date', -14) === null && cw.shiftDays(null, -14) === null)

  const win = cw.certificationWindow('2026-08-14')
  t('the window is today-60 … today-14 inclusive',
    win.from === '2026-06-15' && win.to === '2026-07-31')

  t('an election 14 days back is eligible (earliest a canvass could be done)',
    cw.inCertificationWindow('2026-07-31', '2026-08-14'))
  t('13 days back is too early — the canvass is still running',
    !cw.inCertificationWindow('2026-08-01', '2026-08-14'))
  t('60 days back is still chased; 61 is not',
    cw.inCertificationWindow('2026-06-15', '2026-08-14') &&
    !cw.inCertificationWindow('2026-06-14', '2026-08-14'))
  t('a future election is never in the window',
    !cw.inCertificationWindow('2026-11-03', '2026-08-14'))
  t('a timestamp-shaped election_date still resolves by its date part',
    cw.inCertificationWindow('2026-07-31T00:00:00Z', '2026-08-14'))
  t('a missing or malformed election_date is not eligible',
    !cw.inCertificationWindow(null, '2026-08-14') &&
    !cw.inCertificationWindow('', '2026-08-14') &&
    !cw.inCertificationWindow('July 31 2026', '2026-08-14'))

  // ── verdict parsing: citations are mandatory ──
  const cited = cw.parseCertificationVerdict(
    '{"status":"CERTIFIED","source_url":"https://elections.wi.gov/canvass","as_of":"2026-08-12"}')
  t('a cited CERTIFIED is the only thing that authorizes a write',
    cited.verdict === 'CERTIFIED' && cited.cited === true && cited.certify === true &&
    cited.sourceUrl === 'https://elections.wi.gov/canvass')

  const uncited = cw.parseCertificationVerdict('{"status":"CERTIFIED"}')
  t('CERTIFIED with no source URL never certifies anything',
    uncited.verdict === 'CERTIFIED' && uncited.cited === false && uncited.certify === false)

  const bareSource = cw.parseCertificationVerdict(
    '{"status":"CERTIFIED","source_url":"the county clerk\'s website"}')
  t('a prose "source" is not a citation',
    bareSource.certify === false && bareSource.sourceUrl === null)

  const notYet = cw.parseCertificationVerdict(
    '{"status":"NOT_YET","source_url":"https://county.example.gov/canvass"}')
  t('NOT_YET never certifies, even with a perfectly good URL',
    notYet.verdict === 'NOT_YET' && notYet.certify === false)

  t('NOT YET / not-yet normalize to NOT_YET',
    cw.parseCertificationVerdict('{"status":"NOT YET"}').verdict === 'NOT_YET' &&
    cw.parseCertificationVerdict('{"status":"not-yet"}').verdict === 'NOT_YET')

  t('UNCLEAR, an unknown verdict, an empty reply and non-strings all land on UNCLEAR',
    ['{"status":"UNCLEAR"}', '{"status":"probably?"}', '', '   ', null, undefined, 42]
      .every(v => {
        const r = cw.parseCertificationVerdict(v)
        return r.verdict === 'UNCLEAR' && r.certify === false
      }))

  const fenced = cw.parseCertificationVerdict(
    '```json\n{"status":"CERTIFIED","source_url":"https://elections.wi.gov/x"}\n```')
  t('markdown fences are stripped before parsing',
    fenced.certify === true && fenced.sourceUrl === 'https://elections.wi.gov/x')

  const prose = cw.parseCertificationVerdict(
    'CERTIFIED — the Dane County board of canvass finished on Aug 12. Source: https://danecounty.gov/canvass.')
  t('a reply that ignored the JSON format is still read, URL trimmed of punctuation',
    prose.verdict === 'CERTIFIED' && prose.sourceUrl === 'https://danecounty.gov/canvass' && prose.certify === true)

  t('the prompt asks only the canvass question and demands a URL for CERTIFIED', (() => {
    const p = cw.certificationPrompt({ name: 'Spring Election', election_date: '2026-04-07' })
    return p.includes('CERTIFIED') && p.includes('NOT_YET') && p.includes('UNCLEAR') &&
      /source URL/i.test(p) && /Spring Election/.test(p) && /2026-04-07/.test(p) &&
      /Do not report vote totals/i.test(p) && /Never estimate/i.test(p)
  })())

  // ── reason appending: the audit trail is never overwritten ──
  t('the certification sentence is appended to whatever the reason already said',
    appendCertifyReason({ reason: 'Called by hand for Jane Doe.' }) ===
      'Called by hand for Jane Doe. Certified — county canvass complete.')
  t('the watcher records the source URL it certified from',
    appendCertifyReason({ reason: 'Called by hand for Jane Doe.' }, 'Source: https://elections.wi.gov/x') ===
      'Called by hand for Jane Doe. Certified — county canvass complete. Source: https://elections.wi.gov/x')
  t('a missing / malformed status_detail still produces the sentence',
    appendCertifyReason(null) === CERTIFY_REASON &&
    appendCertifyReason({}) === CERTIFY_REASON &&
    appendCertifyReason({ reason: 42 }) === CERTIFY_REASON)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)

