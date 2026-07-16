/**
 * broadside-brain.js
 * Server-side proxy for BROADSIDE's LLM "actor" — writes the opponent's next
 * spoken line. Keeps ANTHROPIC_API_KEY out of the browser (handoff priority #1).
 *
 * ADMIN-ONLY BETA: gated with requireAdmin while Broadside is admin-only.
 * When the feature opens to paid tiers, switch to requireUser + a tier check
 * (see discover-candidates.js for the pattern).
 *
 * POST body: { system: string, user: string, mode?: 'quality'|'speed' }
 * Returns:   { text: string }
 *
 * The model is chosen server-side from a fixed map — the client can only pick
 * a mode, never an arbitrary model string.
 */

const { json, requireAdmin } = require('./_shared')
const { enforceRateLimit } = require('./_rate-limit')

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY

const MODELS = {
  quality: 'claude-sonnet-5',
  speed:   'claude-haiku-4-5-20251001',
}

const HEADERS = {
  'Access-Control-Allow-Origin':  process.env.ALLOWED_ORIGIN || 'https://badgerboardwi.com',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: HEADERS, body: '' }
  if (event.httpMethod !== 'POST')    return json(405, { error: 'Method not allowed' }, HEADERS)

  const auth = await requireAdmin(event)
  if (auth.errorResponse) return { ...auth.errorResponse, headers: { ...HEADERS, ...auth.errorResponse.headers } }
  const { user } = auth

  const limited = await enforceRateLimit(user.id, 'broadside-brain', HEADERS)
  if (limited) return limited

  if (!ANTHROPIC_API_KEY) return json(503, { error: 'brain-not-configured' }, HEADERS)

  let body
  try { body = JSON.parse(event.body || '{}') } catch { return json(400, { error: 'Invalid JSON body' }, HEADERS) }

  const system = typeof body.system === 'string' ? body.system : ''
  const usr    = typeof body.user   === 'string' ? body.user   : ''
  const mode   = body.mode === 'speed' ? 'speed' : 'quality'

  if (!system || !usr)                       return json(400, { error: 'system and user prompts are required' }, HEADERS)
  if (system.length > 4000 || usr.length > 12000) return json(400, { error: 'Prompt too long' }, HEADERS)

  try {
    const ctrl = new AbortController()
    const to = setTimeout(() => ctrl.abort(), 9000)
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODELS[mode],
        max_tokens: 120,
        system,
        messages: [{ role: 'user', content: usr }],
      }),
    })
    clearTimeout(to)
    if (!r.ok) {
      const detail = await r.text().catch(() => '')
      console.error(`[broadside-brain] Anthropic ${r.status}: ${detail.slice(0, 300)}`)
      return json(502, { error: 'brain-upstream-error' }, HEADERS)
    }
    const j = await r.json()
    const text = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join(' ').trim()
    if (!text) return json(502, { error: 'brain-empty' }, HEADERS)
    return json(200, { text }, HEADERS)
  } catch (e) {
    console.error('[broadside-brain] error:', e.message)
    return json(502, { error: 'brain-upstream-error' }, HEADERS)
  }
}
