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

  const { handler: buyCredits } = await import('../netlify/functions/buy-dossier-credits.js')
  const postPack = (body) => buyCredits({ httpMethod: 'POST', headers: { authorization: 'Bearer tok' }, body: JSON.stringify(body) })
  t('buy-dossier-credits: 400 on invalid pack', (await postPack({ pack: 7 })).statusCode === 400)
  t('buy-dossier-credits: 400 on missing pack', (await postPack({})).statusCode === 400)
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
    chunkList, tierTwoQueue, selectRotationChunks, rotationTick, contestLine,
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
  t('default chunk size is 12 and at most 3 tier-2 calls per run',
    TIER2_CHUNK_SIZE === 12 && TIER2_MAX_CALLS === 3)

  // — queue composition —
  const q = tierTwoQueue(ballot, ct(20, 30))
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
  const qd = tierTwoQueue(decided, ct(21, 0))
  t('called and certified contests drop out of the rotation entirely',
    qd.length === 5 && qd.every(c => c.status === 'reporting'))

  // — waiting deprioritisation —
  const mixed = [
    { id: 'a', office_type: 'state_assembly', status: 'waiting'   },
    { id: 'b', office_type: 'state_assembly', status: 'reporting' },
    { id: 'c', office_type: 'state_assembly', status: 'waiting'   },
    { id: 'd', office_type: 'state_assembly', status: 'too_close' },
  ]
  t('before 11 PM CT the queue is plain id order (waiting races still matter)',
    tierTwoQueue(mixed, ct(21, 45)).map(c => c.id).join('') === 'abcd')
  t('after 11 PM CT the still-waiting contests sort LAST',
    tierTwoQueue(mixed, ct(23, 0)).map(c => c.id).join('') === 'bdac')
  t('the 1 AM hourly run also deprioritises waiting contests',
    tierTwoQueue(mixed, ct(1, 0)).map(c => c.id).join('') === 'bdac')
  t('deprioritisation keeps id order inside each band',
    tierTwoQueue(mixed, ct(23, 0)).slice(2).map(c => c.id).join('') === 'ac')

  // — time-derived rotation: deterministic, disjoint, and it comes back round —
  const peak = (h, m) => selectRotationChunks(q, ct(h, m), { cadence: 'every 5 minutes' })
  t('rotation is fully determined by the clock — same instant, same chunks',
    peak(20, 15).indices.join(',') === peak(20, 15).indices.join(','))
  t('124 contests in rotation → 11 chunks of 12', peak(20, 0).nChunks === 11)
  t('each run takes 3 chunks', peak(20, 0).indices.length === 3 && peak(20, 5).indices.length === 3)
  t('the 20:00 run starts at chunk 0', peak(20, 0).indices.join(',') === '0,1,2')
  t('consecutive 5-minute runs cover DISJOINT chunks',
    peak(20, 5).indices.join(',') === '3,4,5' && peak(20, 10).indices.join(',') === '6,7,8')
  t('any minute inside a 5-minute bucket picks the same slice',
    peak(20, 5).indices.join(',') === peak(20, 9).indices.join(','))
  t('the rotation wraps rather than running off the end',
    peak(20, 15).indices.join(',') === '9,10,0')
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


console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)

