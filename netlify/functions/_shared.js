// netlify/functions/_shared.js
// ─── Shared helpers for all Netlify functions ─────────────────────────────────
// Prefixed with _ so Netlify does NOT deploy this as an endpoint (see netlify.toml).
//
// Usage (ESM):  import { json, cors, requireAdmin, serviceClient } from './_shared.js'
// Usage (CJS):  const { json, cors, requireAdmin, serviceClient } = require('./_shared')

const { createClient } = require('@supabase/supabase-js')
const { ADMIN_EMAILS } = require('./_config')

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY

/** Production origin for CORS. Override with ALLOWED_ORIGIN env var. */
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://badgerboardwi.com'

/**
 * CORS headers.
 * @param {boolean} publicEndpoint  true → wildcard origin (embeds/webhooks);
 *                                  false (default) → production origin only.
 */
function cors(publicEndpoint = false) {
  return {
    'Access-Control-Allow-Origin':  publicEndpoint ? '*' : ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  }
}

/** JSON response helper. */
function json(statusCode, body, extraHeaders = {}) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body),
  }
}

/** Service-role Supabase client (bypasses RLS — server-side only). */
function serviceClient() {
  return createClient(SUPABASE_URL, SERVICE_KEY)
}

/**
 * Verify the caller's Supabase JWT and require an admin email.
 * @returns {Promise<{user}|{errorResponse}>}
 */
async function requireAdmin(event) {
  const auth = event.headers?.authorization || event.headers?.Authorization || ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null
  if (!token) return { errorResponse: json(401, { error: 'Missing bearer token' }) }
  const supabase = serviceClient()
  const { data: { user }, error } = await supabase.auth.getUser(token)
  if (error || !user) return { errorResponse: json(401, { error: 'Invalid or expired token' }) }
  if (!ADMIN_EMAILS.includes((user.email || '').toLowerCase())) {
    return { errorResponse: json(403, { error: 'Admin access required' }) }
  }
  return { user }
}

/** Verify the caller's Supabase JWT (any authenticated user). */
async function requireUser(event) {
  const auth = event.headers?.authorization || event.headers?.Authorization || ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null
  if (!token) return { errorResponse: json(401, { error: 'Missing bearer token' }) }
  const supabase = serviceClient()
  const { data: { user }, error } = await supabase.auth.getUser(token)
  if (error || !user) return { errorResponse: json(401, { error: 'Invalid or expired token' }) }
  return { user }
}

/**
 * Verify the caller's JWT AND that their effective plan includes Broadside
 * (v1.18.2: all paid plans). Resolves through _entitlements, so admins and
 * beta-mode users (→ a_campaign) pass automatically, as do active trials.
 */
const BROADSIDE_PLANS = ['c_monitor', 'c_active', 'c_campaign', 'a_monitor', 'a_active', 'a_campaign']
async function requireBroadside(event) {
  const res = await requireUser(event)
  if (res.errorResponse) return res
  if (ADMIN_EMAILS.includes((res.user.email || '').toLowerCase())) return res
  const { resolveEntitlement } = require('./_entitlements')
  const { plan } = await resolveEntitlement(res.user)
  if (!BROADSIDE_PLANS.includes(plan)) {
    return { errorResponse: json(403, { error: 'Broadside is included with paid Badger Board plans. Upgrade to unlock it.' }) }
  }
  return res
}

module.exports = { cors, json, serviceClient, requireAdmin, requireUser, requireBroadside, ALLOWED_ORIGIN }
