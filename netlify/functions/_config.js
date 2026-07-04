// netlify/functions/_config.js
// ─── Shared configuration for all Netlify functions ──────────────────────────
// Prefixed with _ so Netlify does NOT treat this as a deployable function.
//
// Import (ESM):   import { ADMIN_EMAILS, corsHeaders } from './_config.js'
// Require (CJS):  const { ADMIN_EMAILS, corsHeaders } = require('./_config')

/**
 * Email addresses with admin-level access to the Badger Board platform.
 * Add new admin emails here — this is the single source of truth.
 */
const ADMIN_EMAILS = ['tony@bluejackgroup.com', 'tony@thebluejackgroup.com', 'tom@thebluejackgroup.com']

/**
 * CORS headers for authenticated endpoints.
 * Returns the specific allowed origin rather than `*` so browsers enforce
 * same-origin restrictions on cross-site requests.
 *
 * @param {string|undefined} reqOrigin - value of the request's Origin header
 * @param {'GET'|'POST'|'OPTIONS'|string} [methods='POST, OPTIONS']
 */
const PROD_ORIGINS = [
  process.env.APP_URL            || 'https://www.badgerboardwi.com',
  'https://www.badgerboardwi.com',
  'https://badgerboardwi.com',
]

function corsHeaders(reqOrigin, methods = 'POST, OPTIONS') {
  // Allow localhost in development (netlify dev, Vite, etc.)
  const isLocalhost = reqOrigin && (
    reqOrigin.startsWith('http://localhost') ||
    reqOrigin.startsWith('http://127.0.0.1')
  )
  const origin = (isLocalhost || PROD_ORIGINS.includes(reqOrigin))
    ? reqOrigin
    : PROD_ORIGINS[0]   // prod default — browser will block mismatched origins
  return {
    'Access-Control-Allow-Origin':  origin,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': methods,
    'Content-Type': 'application/json',
    'Vary': 'Origin',
  }
}

// Support both ESM (import) and CJS (require)
module.exports = { ADMIN_EMAILS, corsHeaders, PROD_ORIGINS }
