// netlify/functions/_perplexity.js
// ─── Shared Perplexity client: concurrency gate + 429 retry ───────────────────
// Prefixed with _ so Netlify does NOT deploy this as an endpoint.
//
// Why this exists (found 2026-11-03 with the admin diagnostic): the account
// answers HTTP 429 "Request rate limit exceeded" with retry-after: 1 to any
// burst of concurrent requests — five fired at once, one succeeded. The profile
// pipeline fans out SEVEN sonar-pro searches at once, Events three, Recruit
// dozens; every saved profile since August recorded perplexity_sources_used = 1.
//
// perplexityFetch() returns the fetch Response (callers keep their own JSON
// handling) but, per function instance, lets only PPLX_MAX_CONCURRENT requests
// run at once and retries 429 / 5xx / network errors with backoff that honours
// Retry-After. A caller's AbortSignal still cancels the whole thing.
//
// Usage (CJS):  const { perplexityFetch } = require('./_perplexity')
// Usage (ESM):  import { perplexityFetch } from './_perplexity.js'
//
//   const res = await perplexityFetch({ apiKey, body: { model, messages, max_tokens }, signal, label: 'news' })
//   if (!res.ok) …; const data = await res.json()

const PPLX_URL = 'https://api.perplexity.ai/chat/completions'
const MAX_CONCURRENT = Math.max(1, Number(process.env.PPLX_MAX_CONCURRENT) || 2)
const MAX_ATTEMPTS = 6

// Tiny semaphore. Module state is per warm function instance — exactly the
// scope where our own fan-outs collide.
const gate = { active: 0, waiters: [] }
function acquire() {
  if (gate.active < MAX_CONCURRENT) { gate.active++; return Promise.resolve() }
  return new Promise(resolve => gate.waiters.push(resolve)).then(() => { gate.active++ })
}
function release() {
  gate.active = Math.max(0, gate.active - 1)
  const next = gate.waiters.shift()
  if (next) next()
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms)
  if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')) }, { once: true })
})

function retryDelayMs(res, attempt) {
  const ra = Number(res?.headers?.get?.('retry-after'))
  const base = Number.isFinite(ra) && ra > 0 ? ra * 1000 : 1200 * (attempt + 1)
  return Math.min(15000, base + Math.round(Math.random() * 400))
}

/**
 * @param {object} o
 * @param {string} o.apiKey
 * @param {object} o.body        chat/completions body (model, messages, max_tokens, …)
 * @param {AbortSignal} [o.signal]
 * @param {string} [o.label]     for logs
 * @param {number} [o.attempts]  max attempts (default 6)
 * @returns {Promise<Response>}
 */
async function perplexityFetch({ apiKey, body, signal, label = body?.model || 'pplx', attempts = MAX_ATTEMPTS }) {
  if (signal?.aborted) throw new Error('aborted')
  await acquire()
  try {
    let last = null
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (signal?.aborted) throw new Error('aborted')
      let res
      try {
        res = await fetch(PPLX_URL, {
          method: 'POST',
          signal,
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
      } catch (e) {
        if (signal?.aborted || e.name === 'AbortError') throw e
        last = e
        if (attempt + 1 >= attempts) throw e
        console.warn(`[perplexity] ${label}: ${e.message} — retry ${attempt + 1}/${attempts - 1}`)
        await sleep(retryDelayMs(null, attempt), signal)
        continue
      }
      if (res.status !== 429 && res.status < 500) return res
      last = res
      if (attempt + 1 >= attempts) return res
      const wait = retryDelayMs(res, attempt)
      console.warn(`[perplexity] ${label}: HTTP ${res.status} — retry ${attempt + 1}/${attempts - 1} in ${wait}ms`)
      await sleep(wait, signal)
    }
    return last
  } finally { release() }
}

module.exports = { perplexityFetch, PPLX_URL, MAX_CONCURRENT, _gate: gate }
