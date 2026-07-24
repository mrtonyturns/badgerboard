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

import shared from './_shared.js'
import rateLimit from './_rate-limit.js'
import aiUsage from './_ai-usage.js'

const { requireBroadside } = shared
const { enforceRateLimit } = rateLimit
const { logAiUsage } = aiUsage

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

  // Adapt the Fetch Request to the classic-event shape _shared expects
  const event = { headers: { authorization: req.headers.get('authorization') || '' } }
  const auth = await requireBroadside(event)
  if (auth.errorResponse) return jsonRes(auth.errorResponse.statusCode, JSON.parse(auth.errorResponse.body))
  const { user } = auth

  const limited = await enforceRateLimit(user.id, 'broadside-brain', {})
  if (limited) return jsonRes(429, JSON.parse(limited.body))

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
