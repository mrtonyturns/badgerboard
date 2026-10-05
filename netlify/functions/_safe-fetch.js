// netlify/functions/_safe-fetch.js
// ─── SSRF-safe fetch for user/AI-supplied URLs ──────────────────────────────
// Prefixed with _ so Netlify does NOT treat this as a deployable function.
//
// A URL a user typed (candidate.website) or an LLM produced (event pages) must
// never make the server talk to its own network: loopback, RFC 1918, link-
// local (169.254.169.254 is the cloud metadata service), CGNAT, unique-local
// IPv6 and friends. safeFetch():
//   • allows only http/https and refuses localhost / *.internal / single-label
//     hostnames outright,
//   • resolves the hostname with dns.promises.lookup({ all: true }) and refuses
//     if ANY address is non-public (a split A/AAAA answer can't sneak through),
//   • follows redirects MANUALLY (max 5), re-validating every hop — the old
//     redirect:'follow' let a public URL 302 to http://169.254.169.254/,
//   • aborts after timeoutMs (covers the body read too).
// Residual risk: fetch() re-resolves the name after our check, so a DNS-
// rebinding host with a ~0s TTL could still race it. Pinning would need a
// custom undici dispatcher; the check above stops every non-adversarial-DNS
// case and all redirect-based pivots.
//
// Import (CJS):  const { safeFetch } = require('./_safe-fetch')
// Import (ESM):  import { safeFetch } from './_safe-fetch.js'

const dns = require('dns')
const net = require('net')

class SafeFetchError extends Error {
  constructor(message) { super(message); this.name = 'SafeFetchError' }
}

// ── IPv4 ──────────────────────────────────────────────────────────────────────
// [network, prefix] pairs that are never a public web server.
const BLOCKED_V4 = [
  ['0.0.0.0', 8],        // "this network"
  ['10.0.0.0', 8],       // RFC 1918
  ['100.64.0.0', 10],    // CGNAT
  ['127.0.0.0', 8],      // loopback
  ['169.254.0.0', 16],   // link-local / cloud metadata
  ['172.16.0.0', 12],    // RFC 1918
  ['192.0.0.0', 24],     // IETF protocol assignments
  ['192.0.2.0', 24],     // TEST-NET-1
  ['192.88.99.0', 24],   // 6to4 relay anycast
  ['192.168.0.0', 16],   // RFC 1918
  ['198.18.0.0', 15],    // benchmarking
  ['198.51.100.0', 24],  // TEST-NET-2
  ['203.0.113.0', 24],   // TEST-NET-3
  ['224.0.0.0', 4],      // multicast
  ['240.0.0.0', 4],      // reserved + broadcast
]
const v4ToInt = (ip) => ip.split('.').reduce((n, o) => ((n << 8) | Number(o)) >>> 0, 0)
const BLOCKED_V4_INT = BLOCKED_V4.map(([base, bits]) => {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
  return { net: (v4ToInt(base) & mask) >>> 0, mask }
})

function isBlockedIPv4(ip) {
  if (!net.isIPv4(ip)) return true
  const n = v4ToInt(ip)
  return BLOCKED_V4_INT.some(({ net: base, mask }) => ((n & mask) >>> 0) === base)
}

// ── IPv6 ──────────────────────────────────────────────────────────────────────
// Expand to 8 numeric hextets (handles '::' and a trailing dotted IPv4).
function parseIPv6(ip) {
  let s = String(ip).toLowerCase().replace(/^\[|\]$/g, '').split('%')[0]
  const dotted = s.match(/(\d+\.\d+\.\d+\.\d+)$/)
  if (dotted) {
    if (!net.isIPv4(dotted[1])) return null
    const n = v4ToInt(dotted[1])
    s = s.slice(0, -dotted[1].length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`
  }
  const halves = s.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0
  if (fill < 0) return null
  const parts = [...head, ...Array(fill).fill('0'), ...tail]
  if (parts.length !== 8 || parts.some(p => !/^[0-9a-f]{1,4}$/.test(p))) return null
  return parts.map(p => parseInt(p, 16))
}

const embeddedV4 = (h, i) => [h[i] >> 8, h[i] & 0xff, h[i + 1] >> 8, h[i + 1] & 0xff].join('.')

function isBlockedIPv6(ip) {
  const h = parseIPv6(ip)
  if (!h) return true
  if (h.every(x => x === 0)) return true                                   // :: unspecified
  if (h.slice(0, 7).every(x => x === 0) && h[7] === 1) return true          // ::1 loopback
  if (h.slice(0, 5).every(x => x === 0) && h[5] === 0xffff) return isBlockedIPv4(embeddedV4(h, 6)) // ::ffff:a.b.c.d
  if (h.slice(0, 6).every(x => x === 0)) return true                        // ::a.b.c.d (deprecated compat)
  if (h[0] === 0x64 && h[1] === 0xff9b) return isBlockedIPv4(embeddedV4(h, 6)) // NAT64
  if (h[0] === 0x2002) return isBlockedIPv4(embeddedV4(h, 1))               // 6to4
  if ((h[0] & 0xfe00) === 0xfc00) return true                               // fc00::/7 unique-local
  if ((h[0] & 0xffc0) === 0xfe80) return true                               // fe80::/10 link-local
  if ((h[0] & 0xffc0) === 0xfec0) return true                               // fec0::/10 site-local
  if ((h[0] & 0xff00) === 0xff00) return true                               // ff00::/8 multicast
  if (h[0] === 0x2001 && h[1] === 0x0db8) return true                       // documentation
  if (h[0] === 0x2001 && h[1] === 0x0000) return true                       // Teredo
  if (h[0] === 0x0100 && h[1] === 0 && h[2] === 0 && h[3] === 0) return true // discard-only
  return false
}

/** Pure: true when an IP literal is NOT a public unicast address. */
function isBlockedAddress(ip) {
  const s = String(ip || '').replace(/^\[|\]$/g, '')
  if (net.isIPv4(s)) return isBlockedIPv4(s)
  if (net.isIPv6(s.split('%')[0])) return isBlockedIPv6(s)
  return true
}

// Hostnames refused before DNS (metadata aliases, local-only names).
const BLOCKED_HOSTS = new Set(['localhost', 'metadata', 'metadata.google.internal', 'instance-data'])
function isBlockedHostname(host) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '')
  if (!h) return true
  if (BLOCKED_HOSTS.has(h)) return true
  if (/\.(localhost|local|internal|localdomain|home\.arpa)$/.test(h)) return true
  // Single-label names resolve through resolver search domains to internal hosts
  if (!h.includes('.') && !net.isIP(h.replace(/^\[|\]$/g, ''))) return true
  return false
}

/**
 * Validate a URL for an outbound request. Resolves the hostname and throws a
 * SafeFetchError unless it is http(s) and every resolved address is public.
 * Returns the parsed URL.
 */
async function assertPublicUrl(raw, { lookup = dns.promises.lookup } = {}) {
  let u
  try { u = new URL(String(raw)) } catch { throw new SafeFetchError('Invalid URL') }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new SafeFetchError('Only http(s) URLs are allowed')
  if (u.username || u.password) throw new SafeFetchError('Credentials in URL are not allowed')
  const host = u.hostname.replace(/^\[|\]$/g, '')
  if (isBlockedHostname(host)) throw new SafeFetchError('Host not allowed')
  if (net.isIP(host)) {
    if (isBlockedAddress(host)) throw new SafeFetchError('Address not allowed')
    return u
  }
  let addrs
  try { addrs = await lookup(host, { all: true, verbatim: true }) } catch { throw new SafeFetchError('Host did not resolve') }
  if (!Array.isArray(addrs) || !addrs.length) throw new SafeFetchError('Host did not resolve')
  if (addrs.some(a => isBlockedAddress(a.address))) throw new SafeFetchError('Address not allowed')
  return u
}

/**
 * fetch() for untrusted URLs. Same init as fetch, plus:
 *   timeoutMs (default 8000), maxRedirects (default 5).
 * The returned Response's .url is the final hop. Redirects are followed for
 * GET/HEAD only (a 303 always becomes a GET without a body).
 */
async function safeFetch(url, opts = {}) {
  const { timeoutMs = 8000, maxRedirects = 5, signal, lookup, ...init } = opts
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  if (typeof timer.unref === 'function') timer.unref()
  if (signal) {
    if (signal.aborted) ctrl.abort()
    else signal.addEventListener('abort', () => ctrl.abort(), { once: true })
  }
  let current = String(url)
  let reqInit = { ...init }
  try {
    for (let hop = 0; ; hop++) {
      const u = await assertPublicUrl(current, lookup ? { lookup } : undefined)
      const res = await fetch(u.href, { ...reqInit, redirect: 'manual', signal: ctrl.signal })
      const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null
      if (!location) return res
      try { await res.body?.cancel() } catch { /* already drained */ }
      if (hop >= maxRedirects) throw new SafeFetchError('Too many redirects')
      const method = String(reqInit.method || 'GET').toUpperCase()
      if (res.status === 303 && method !== 'HEAD') reqInit = { ...reqInit, method: 'GET', body: undefined }
      else if (method !== 'GET' && method !== 'HEAD') return res   // don't replay a body cross-origin
      current = new URL(location, u).href
    }
  } catch (e) {
    clearTimeout(timer)
    throw e
  }
}

module.exports = {
  safeFetch,
  assertPublicUrl,
  isBlockedAddress,
  isBlockedHostname,
  SafeFetchError,
}
