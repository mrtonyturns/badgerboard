// tests/perplexity-client.test.mjs — the shared Perplexity client: concurrency
// gate, 429/5xx retry honouring Retry-After, abort, and adoption by every
// Perplexity caller. Prints "N passed, M failed".
import { createRequire } from 'node:module'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
const require = createRequire(import.meta.url)
const { perplexityFetch, MAX_CONCURRENT, _gate } = require('../netlify/functions/_perplexity.js')
const FN_DIR = join(new URL('..', import.meta.url).pathname, 'netlify/functions')

let passed = 0, failed = 0
const check = (n, c, d) => { if (c) { passed++; console.log('  ✓ ' + n) } else { failed++; console.log('  ✗ ' + n + (d ? ' — ' + d : '')) } }
const mk = (status, text = '{}', headers = {}) => ({ status, ok: status < 300, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, async text() { return text }, async json() { return JSON.parse(text) } })
const realFetch = globalThis.fetch

console.log('\n[1] retry on 429 honouring Retry-After, then success')
{
  const calls = []
  globalThis.fetch = async () => { calls.push(Date.now()); return calls.length < 3 ? mk(429, '{"error":"rate"}', { 'retry-after': '1' }) : mk(200, '{"choices":[{"message":{"content":"ok"}}]}') }
  const t0 = Date.now()
  const r = await perplexityFetch({ apiKey: 'k', body: { model: 'sonar' }, label: 't' })
  check('third attempt succeeds', r.status === 200 && calls.length === 3)
  check('waited roughly retry-after (≥1s) between attempts', Date.now() - t0 >= 2000 && Date.now() - t0 < 5000)
}

console.log('\n[2] gives up after the attempt cap and returns the last response')
{
  let n = 0
  globalThis.fetch = async () => { n++; return mk(503, 'down', { 'retry-after': '0' }) }
  const r = await perplexityFetch({ apiKey: 'k', body: { model: 'sonar' }, attempts: 2 })
  check('two attempts, last 503 returned', n === 2 && r.status === 503)
}

console.log('\n[3] non-retryable statuses return immediately')
{
  let n = 0
  globalThis.fetch = async () => { n++; return mk(400, 'bad') }
  const r = await perplexityFetch({ apiKey: 'k', body: { model: 'sonar' } })
  check('400 is not retried', n === 1 && r.status === 400)
}

console.log('\n[4] concurrency gate')
{
  let inFlight = 0, peak = 0
  globalThis.fetch = async () => { inFlight++; peak = Math.max(peak, inFlight); await new Promise(r => setTimeout(r, 60)); inFlight--; return mk(200) }
  await Promise.all(Array.from({ length: 7 }, () => perplexityFetch({ apiKey: 'k', body: { model: 'sonar' } })))
  check(`never more than MAX_CONCURRENT (${MAX_CONCURRENT}) in flight for a 7-wide fan-out`, peak === MAX_CONCURRENT)
  check('gate fully released afterwards', _gate.active === 0 && _gate.waiters.length === 0)
}

console.log('\n[5] abort wins')
{
  globalThis.fetch = async () => mk(429, 'rate', { 'retry-after': '5' })
  const ctrl = new AbortController()
  setTimeout(() => ctrl.abort(), 150)
  let err = ''
  try { await perplexityFetch({ apiKey: 'k', body: { model: 'sonar' }, signal: ctrl.signal }) } catch (e) { err = e.message }
  check('an abort during the retry wait rejects instead of sleeping on', /abort/.test(err) && _gate.active === 0)
}
globalThis.fetch = realFetch

console.log('\n[6] every Perplexity caller uses the shared client')
{
  const direct = readdirSync(FN_DIR).filter(f => /\.(js|mjs)$/.test(f) && f !== '_perplexity.js').filter(f => /api\.perplexity\.ai/.test(readFileSync(join(FN_DIR, f), 'utf8')))
  check('no function calls api.perplexity.ai directly', direct.length === 0, direct.join(', '))
  for (const f of ['generate-dossier-background.js', 'research-district-events-background.js', 'recruit-research-background.js', 'enrich-prospects-background.js', 'polling-snapshot-background.js', 'research-district-history.js', 'election-results-poller.js']) {
    check(`${f} imports perplexityFetch`, /perplexityFetch/.test(readFileSync(join(FN_DIR, f), 'utf8')))
  }
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) process.exitCode = 1
