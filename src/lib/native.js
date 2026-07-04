// ─── Native app (Capacitor) integration layer ────────────────────────────────
// Detects when the app is running inside the iOS/Android shell and:
//   1. Routes Netlify function calls (relative "/.netlify/functions/*" URLs)
//      through the native HTTP layer, pointed at production. Native requests
//      are not subject to browser CORS, so the hardened CORS headers in
//      netlify.toml stay exactly as they are.
//   2. Exposes `isNativeApp` so UI can adapt (e.g. hide Stripe purchase flows,
//      which App Store rules don't allow for digital subscriptions).
//
// On the website this module is inert — `isNativeApp` is false and fetch is
// never patched.

import { Capacitor, CapacitorHttp } from '@capacitor/core'

export const isNativeApp = Capacitor.isNativePlatform()

// Production origin the native app talks to for serverless functions.
export const API_ORIGIN = 'https://badgerboardwi.com'

const FUNCTIONS_PREFIX = '/.netlify/functions/'

// ── Patch window.fetch (native only) ──────────────────────────────────────────
// Only intercepts relative Netlify function calls. Everything else — including
// all supabase-js traffic — passes through to the original fetch untouched.
export function initNativeApp() {
  if (!isNativeApp) return

  const originalFetch = window.fetch.bind(window)

  window.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input?.url || ''
    if (!url.startsWith(FUNCTIONS_PREFIX)) {
      return originalFetch(input, init)
    }

    const absoluteUrl = API_ORIGIN + url
    const method = (init.method || 'GET').toUpperCase()
    const headers = {}
    if (init.headers) {
      const h = init.headers instanceof Headers ? init.headers : new Headers(init.headers)
      h.forEach((v, k) => { headers[k] = v })
    }

    // CapacitorHttp wants parsed JSON for JSON bodies
    let data
    if (init.body != null) {
      const isJson = (headers['Content-Type'] || headers['content-type'] || '').includes('json')
      if (typeof init.body === 'string' && isJson) {
        try { data = JSON.parse(init.body) } catch { data = init.body }
      } else {
        data = init.body
      }
    }

    const res = await CapacitorHttp.request({ url: absoluteUrl, method, headers, data })

    // Re-wrap as a standard Response so calling code (res.ok / res.json())
    // works unchanged.
    const bodyText = typeof res.data === 'string' ? res.data : JSON.stringify(res.data ?? null)
    return new Response(bodyText, {
      status: res.status,
      headers: res.headers,
    })
  }
}
