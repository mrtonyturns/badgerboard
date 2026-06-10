// ─── Badger Board Service Worker v1.0 ────────────────────────────────────────
// Strategy:
//   • App shell (JS/CSS/HTML) → Cache-First (stale-while-revalidate on update)
//   • GeoJSON district files  → Cache-First (geographic data rarely changes)
//   • Supabase REST API calls → Network-First with graceful offline response
//   • All other fetch         → Network-First with cache fallback

const CACHE_NAME    = 'badgerboard-v1'
const GEODATA_CACHE = 'badgerboard-geodata-v1'

// Assets to pre-cache on install (app shell)
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/favicon.svg',
  '/badger-board-logo.svg',
]

// ── Install: pre-cache app shell ──────────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      cache.addAll(PRECACHE_URLS).catch(() => {})  // non-fatal if offline at install
    )
  )
  self.skipWaiting()
})

// ── Activate: clean old caches ────────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE_NAME && k !== GEODATA_CACHE)
          .map(k => caches.delete(k))
      )
    )
  )
  self.clients.claim()
})

// ── Fetch: routing logic ──────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)

  // 1. GeoJSON district files → Cache-First
  if (url.pathname.startsWith('/geodata/')) {
    event.respondWith(
      caches.open(GEODATA_CACHE).then(async cache => {
        const cached = await cache.match(event.request)
        if (cached) return cached
        try {
          const resp = await fetch(event.request)
          if (resp.ok) cache.put(event.request, resp.clone())
          return resp
        } catch {
          return new Response(JSON.stringify({ error: 'offline' }), {
            headers: { 'Content-Type': 'application/json' }, status: 503
          })
        }
      })
    )
    return
  }

  // 2. Supabase API → Network-First, graceful offline JSON
  if (url.hostname.includes('supabase.co')) {
    event.respondWith(
      fetch(event.request.clone()).catch(() =>
        new Response(JSON.stringify({ error: 'offline', code: 'OFFLINE' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' }
        })
      )
    )
    return
  }

  // 3. App JS/CSS/images → Stale-While-Revalidate
  if (
    url.hostname === self.location.hostname &&
    (url.pathname.endsWith('.js') || url.pathname.endsWith('.css') || url.pathname.endsWith('.svg'))
  ) {
    event.respondWith(
      caches.open(CACHE_NAME).then(async cache => {
        const cached = await cache.match(event.request)
        const fetchPromise = fetch(event.request).then(resp => {
          if (resp.ok) cache.put(event.request, resp.clone())
          return resp
        }).catch(() => cached || new Response('', { status: 503 }))
        return cached || fetchPromise
      })
    )
    return
  }

  // 4. Navigation requests (page loads) → Network-First, fallback to cached /
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(() =>
        caches.match('/index.html').then(r => r || new Response('Offline', { status: 503 }))
      )
    )
    return
  }

  // 5. Everything else → passthrough
})

// ── Message handler: force cache refresh on manual sync ───────────────────────
self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') {
    self.skipWaiting()
  }
})
