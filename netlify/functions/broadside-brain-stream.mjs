/**
 * broadside-brain-stream.mjs — v1.24
 * Streaming twin of broadside-brain: proxies Anthropic's SSE stream straight
 * through so the client can start speaking the opponent's line sentence-by-
 * sentence instead of waiting for the full reply. Netlify Functions 2.0
 * (default-export Request/Response API) so the body streams.
 *
 * Auth + gating identical to broadside-brain (requireBroadside + rate limit).
 * POST body: { system, user, mode?: 'quality'|'speed' }
 * Returns:   text/event-stream (Anthropic SSE passthrough)
 */

// NOTE: deliberately avoids _shared.js/_rate-limit.js — they require
// @supabase/supabase-js, which Netlify's v2 (.mjs) bundler does not inline.
// Everything here is plain fetch. _config/_entitlements/_ai-usage are
// fetch-only helpers and bundle cleanly.
import config from './_config.js'
import entitlements from './_entitlements.js'
import aiUsage from './_ai-usage.js'

const { ADMIN_EMAILS } = config
const { resolveEntitlement } = entitlements
const { logAiUsage } = aiUsage

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const SUPABASE_ANON = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const BROADSIDE_PLANS = ['c_monitor', 'c_active', 'c_campaign', 'a_monitor', 'a_active', 'a_campaign']

async function verifyUser(token) {
  if (!token) return null
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${token}` },
  })
  if (!res.ok) return null
  return res.json()
}

/** Same gate as _shared.requireBroadside, fetch-only. */
async function requireBroadsideFetch(token) {
  const user = await verifyUser(token)
  if (!user?.id) return { error: jsonRes(401, { error: 'Invalid or expired token' }) }
  if (ADMIN_EMAILS.includes((user.email || '').toLowerCase())) return { user }
  const { plan } = await resolveEntitlement(user)
  if (!BROADSIDE_PLANS.includes(plan)) {
    return { error: jsonRes(403, { error: 'Broadside is included with paid Badger Board plans. Upgrade to unlock it.' }) }
  }
  return { user }
}

/** Same durable limiter as _rate-limit.js (bump_rate_limit RPC), fetch-only.
    Fails open by design — cost control, not auth. */
async function rateLimitFetch(userId) {
  const limits = { perMinute: 40, perDay: 800 }   // broadside-brain budget
  try {
    const now = Date.now()
    const minuteStartMs = Math.floor(now / 60000) * 60000
    const d = new Date(now)
    const dayStartMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/bump_rate_limit`, {
      method: 'POST',
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        p_user_id: userId,
        p_endpoint: 'broadside-brain',
        p_minute_start: new Date(minuteStartMs).toISOString(),
        p_day_start: new Date(dayStartMs).toISOString(),
      }),
    })
    if (!res.ok) return null
    const data = await res.json()
    const row = Array.isArray(data) ? data[0] : data
    if (!row) return null
    if (row.day_count > limits.perDay) return jsonRes(429, { error: 'Daily limit for this feature reached. It resets at midnight UTC.' })
    if (row.minute_count > limits.perMinute) return jsonRes(429, { error: 'Too many requests — please slow down a moment.' })
    return null
  } catch { return null }
}

const MODELS = {
  quality: 'claude-sonnet-5',
  speed:   'claude-haiku-4-5-20251001',
}

const CORS = {
  'Access-Control-Allow-Origin':  process.env.ALLOWED_ORIGIN || 'https://badgerboardwi.com',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const jsonRes = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { status: 204, headers: CORS })
  if (req.method !== 'POST')    return jsonRes(405, { error: 'Method not allowed' })

  const authHeader = req.headers.get('authorization') || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
  const auth = await requireBroadsideFetch(token)
  if (auth.error) return auth.error
  const { user } = auth

  const limited = await rateLimitFetch(user.id)
  if (limited) return limited

  if (!process.env.ANTHROPIC_API_KEY) return jsonRes(503, { error: 'brain-not-configured' })

  let body
  try { body = await req.json() } catch { return jsonRes(400, { error: 'Invalid JSON body' }) }

  const system = typeof body.system === 'string' ? body.system : ''
  const usr    = typeof body.user   === 'string' ? body.user   : ''
  const mode   = body.mode === 'speed' ? 'speed' : 'quality'
  if (!system || !usr)                            return jsonRes(400, { error: 'system and user prompts are required' })
  if (system.length > 5000 || usr.length > 12000) return jsonRes(400, { error: 'Prompt too long' })

  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODELS[mode],
        max_tokens: 140,
        stream: true,
        system,
        messages: [{ role: 'user', content: usr }],
      }),
    })
    if (!upstream.ok || !upstream.body) {
      const detail = await upstream.text().catch(() => '')
      console.error(`[broadside-brain-stream] Anthropic ${upstream.status}: ${detail.slice(0, 300)}`)
      return jsonRes(502, { error: 'brain-upstream-error' })
    }
    // Usage isn't known until the stream ends — log a conservative flat estimate
    logAiUsage({ userId: user.id, endpoint: 'broadside', provider: 'anthropic', model: MODELS[mode], flatUsd: mode === 'speed' ? 0.003 : 0.01, estimated: true })
    return new Response(upstream.body, {
      headers: { ...CORS, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
    })
  } catch (e) {
    console.error('[broadside-brain-stream] error:', e.message)
    return jsonRes(502, { error: 'brain-upstream-error' })
  }
}
