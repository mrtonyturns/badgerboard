// ─── Badger Board Offline Read Cache ──────────────────────────────────────────
// Lightweight "recently viewed" cache. Read queries that succeed are stored
// on-device (localStorage); if the same query later fails because the device
// is offline, the cached copy is served instead so recently viewed dossiers,
// candidates, elections, and offices remain readable in the field.
//
// Deliberately conservative:
//   • No backend changes, no pre-syncing — only data the user actually viewed.
//   • LRU-capped at MAX_ENTRIES; oversized payloads are never cached.
//   • Keys are scoped per user id upstream, so switching accounts on one
//     device can't leak another user's cached data.
//   • Complements (does not replace) offlineQueue.js, which handles offline
//     *writes* for door knocking.

const PREFIX      = 'bb_cache:'
const INDEX_KEY   = 'bb_cache_index'   // [{ k, at }] — LRU bookkeeping
const MAX_ENTRIES = 40
const MAX_ITEM_BYTES = 400 * 1024      // skip anything over ~400 KB
// Entries older than this are treated as absent. Without a TTL an entry only
// left the cache by LRU eviction, so a rarely-touched key could serve
// months-old rows the first time the network hiccupped.
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000   // 24h

function readIndex() {
  try { return JSON.parse(localStorage.getItem(INDEX_KEY)) || [] } catch { return [] }
}

function writeIndex(idx) {
  try { localStorage.setItem(INDEX_KEY, JSON.stringify(idx)) } catch { /* non-fatal */ }
}

function evict(idx, count = 1) {
  idx.sort((a, b) => a.at - b.at)
  const victims = idx.splice(0, count)
  for (const v of victims) {
    try { localStorage.removeItem(PREFIX + v.k) } catch { /* ignore */ }
  }
  return idx
}

export function cachePut(key, data) {
  let payload
  try { payload = JSON.stringify({ at: Date.now(), data }) } catch { return }
  if (payload.length > MAX_ITEM_BYTES) return

  let idx = readIndex().filter(e => e.k !== key)
  if (idx.length >= MAX_ENTRIES) idx = evict(idx, idx.length - MAX_ENTRIES + 1)

  try {
    localStorage.setItem(PREFIX + key, payload)
  } catch {
    // Quota exceeded — evict a few oldest entries and retry once
    idx = evict(idx, 5)
    try { localStorage.setItem(PREFIX + key, payload) } catch { writeIndex(idx); return }
  }
  idx.push({ k: key, at: Date.now() })
  writeIndex(idx)
}

export function cacheGet(key) {
  try {
    const raw = localStorage.getItem(PREFIX + key)
    if (!raw) return null
    const { at, data } = JSON.parse(raw)
    // Stale entries are a miss: drop the row and let the caller surface the
    // real error rather than silently showing old data as if it were current.
    if (!Number.isFinite(at) || Date.now() - at > CACHE_TTL_MS) {
      cacheDelete(key)
      return null
    }
    return { data, cachedAt: at }
  } catch {
    return null
  }
}

export function cacheDelete(key) {
  try { localStorage.removeItem(PREFIX + key) } catch { /* ignore */ }
  writeIndex(readIndex().filter(e => e.k !== key))
}

// Wipe every cached read. Called on sign-out so the next account on this device
// can never be served the previous account's rows (keys are user-scoped, but
// the previous user's data has no business staying on the device either).
export function cacheClearAll() {
  try {
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith(PREFIX)) localStorage.removeItem(k)
    }
    localStorage.removeItem(INDEX_KEY)
  } catch { /* private mode / quota — non-fatal */ }
}

export function isNetworkError(err) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true
  // sw.js answers an offline API request with a synthetic 503 whose JSON body
  // carries code 'OFFLINE'; supabase-js surfaces that as a normal error object,
  // not a fetch rejection, so the message match below never caught it.
  if (err?.code === 'OFFLINE') return true
  const msg = String(err?.message || err || '').toLowerCase()
  return msg.includes('failed to fetch') ||
         msg.includes('networkerror') ||
         msg.includes('network request failed') ||
         msg.includes('load failed') ||          // Safari/WKWebView wording
         msg.includes('timed out') ||
         msg.includes('unable to connect')
}

/**
 * Wrap a read query with offline fallback.
 *   withOffline('dossiers:<uid>', () => query)
 * On success → caches `data` and returns the result unchanged.
 * On network failure → returns { data, error: null, fromCache: true, cachedAt }
 * if a cached copy exists, otherwise the original error result.
 */
export async function withOffline(key, queryFn) {
  let result
  try {
    result = await queryFn()
  } catch (err) {
    const hit = cacheGet(key)
    if (hit) return { data: hit.data, error: null, fromCache: true, cachedAt: hit.cachedAt }
    throw err
  }

  if (result && !result.error && result.data != null) {
    cachePut(key, result.data)
    return result
  }

  if (result?.error && isNetworkError(result.error)) {
    const hit = cacheGet(key)
    if (hit) return { data: hit.data, error: null, fromCache: true, cachedAt: hit.cachedAt }
  }
  return result
}
