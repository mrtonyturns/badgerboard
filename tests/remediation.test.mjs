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

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
