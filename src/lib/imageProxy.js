// ─── Event image proxy ────────────────────────────────────────────────────────
// Event thumbnails are og:image / JSON-LD URLs scraped from arbitrary local
// event sites. Loading them directly fails two ways:
//   1. The site CSP (img-src) rightly doesn't whitelist random domains.
//   2. Many small-town sites block hotlinking or serve huge originals.
// Netlify Image CDN solves all of it: same-origin URL (passes CSP 'self'),
// CDN-cached, resized, auto-webp. remote_images is enabled in netlify.toml.

import { isNativeApp, API_ORIGIN } from './native'

export function eventImage(url, width = 640) {
  if (!url || !/^https?:\/\//i.test(url)) return null
  const base = isNativeApp ? API_ORIGIN : ''
  return `${base}/.netlify/images?url=${encodeURIComponent(url)}&w=${width}&fit=cover&q=70`
}
