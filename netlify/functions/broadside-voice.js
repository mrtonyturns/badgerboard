/**
 * broadside-voice.js
 * Server-side proxy for BROADSIDE's Cartesia TTS — keeps CARTESIA_API_KEY out
 * of the browser (handoff priority #1). Returns MP3 bytes (base64).
 *
 * ADMIN-ONLY BETA: gated with requireAdmin while Broadside is admin-only.
 *
 * POST body: { transcript: string, voiceId?: string }
 * Returns:   audio/mpeg bytes (isBase64Encoded), or 503 { error:'voice-not-configured' }
 *            when no CARTESIA_API_KEY is set — the client falls back to browser TTS.
 *
 * Voice IDs are whitelisted server-side to the three shipped personas.
 */

const { json, requireAdmin } = require('./_shared')
const { enforceRateLimit } = require('./_rate-limit')

const CARTESIA_API_KEY = process.env.CARTESIA_API_KEY
const CARTESIA_VERSION = '2025-04-16'
const MODEL_ID = 'sonic-turbo'

// Frank (default) / Marcus / Victor — the three shipped personas
const ALLOWED_VOICES = new Set([
  '565510e8-6b45-45de-8758-13588fbaec73',
  '5ee9feff-1265-424a-9d7f-8e4d431a12c7',
  '228fca29-3a0a-435c-8728-5cb483251068',
])
const DEFAULT_VOICE = '565510e8-6b45-45de-8758-13588fbaec73'

const HEADERS = {
  'Access-Control-Allow-Origin':  process.env.ALLOWED_ORIGIN || 'https://badgerboardwi.com',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: HEADERS, body: '' }
  if (event.httpMethod !== 'POST')    return json(405, { error: 'Method not allowed' }, HEADERS)

  const auth = await requireAdmin(event)
  if (auth.errorResponse) return { ...auth.errorResponse, headers: { ...HEADERS, ...auth.errorResponse.headers } }
  const { user } = auth

  const limited = await enforceRateLimit(user.id, 'broadside-voice', HEADERS)
  if (limited) return limited

  if (!CARTESIA_API_KEY) return json(503, { error: 'voice-not-configured' }, HEADERS)

  let body
  try { body = JSON.parse(event.body || '{}') } catch { return json(400, { error: 'Invalid JSON body' }, HEADERS) }

  const transcript = typeof body.transcript === 'string' ? body.transcript.trim() : ''
  if (!transcript)             return json(400, { error: 'transcript is required' }, HEADERS)
  if (transcript.length > 800) return json(400, { error: 'transcript too long' }, HEADERS)

  const voiceId = ALLOWED_VOICES.has(body.voiceId) ? body.voiceId : DEFAULT_VOICE

  try {
    const ctrl = new AbortController()
    const to = setTimeout(() => ctrl.abort(), 9000)
    const r = await fetch('https://api.cartesia.ai/tts/bytes', {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'X-API-Key': CARTESIA_API_KEY,
        'Cartesia-Version': CARTESIA_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model_id: MODEL_ID,
        transcript,
        voice: { mode: 'id', id: voiceId },
        output_format: { container: 'mp3', bit_rate: 128000, sample_rate: 44100 },
      }),
    })
    clearTimeout(to)
    if (!r.ok) {
      const detail = await r.text().catch(() => '')
      console.error(`[broadside-voice] Cartesia ${r.status}: ${detail.slice(0, 300)}`)
      return json(502, { error: 'voice-upstream-error' }, HEADERS)
    }
    const buf = Buffer.from(await r.arrayBuffer())
    return {
      statusCode: 200,
      headers: { ...HEADERS, 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' },
      body: buf.toString('base64'),
      isBase64Encoded: true,
    }
  } catch (e) {
    console.error('[broadside-voice] error:', e.message)
    return json(502, { error: 'voice-upstream-error' }, HEADERS)
  }
}
