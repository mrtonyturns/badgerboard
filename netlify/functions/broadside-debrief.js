/**
 * broadside-debrief.js
 * Post-session report card: Sonnet scores the sparring transcript on a
 * campaign rubric, quoting the trainee's actual answers as evidence.
 * Saves to broadside_sessions when the table exists (fails soft otherwise).
 *
 * ADMIN-ONLY BETA — same gate as the other broadside endpoints.
 *
 * POST body: { transcript:[{who,text}], stats:{}, dossierName?, dossierId? }
 * Returns:   { debrief: string, saved: boolean }
 */

const { json, requireAdmin, serviceClient } = require('./_shared')
const { enforceRateLimit } = require('./_rate-limit')

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY
const MODEL = 'claude-sonnet-5'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const HEADERS = {
  'Access-Control-Allow-Origin':  process.env.ALLOWED_ORIGIN || 'https://badgerboardwi.com',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
}

const SYSTEM = `You are a veteran campaign debate coach writing a post-session report card for a candidate who just finished AI opposition sparring. Be direct, specific, and useful — a coach, not a cheerleader.

FORMAT (markdown, under 350 words):
**Overall: <letter grade>** — one-line summary.

**Message discipline** — did they stay on message or wander? Quote one of their actual answers as evidence.
**Pivot quality** — how well did they move from defense to their own ground? Quote evidence.
**Trap avoidance** — did they repeat the attacker's framing, over-deny, or concede too much? Quote evidence.
**Delivery** — tics/fillers and response length, using the stats provided.
**Fix first** — the ONE thing to drill before the next session.

RULES: Quote only from the transcript. If a category has no evidence, say "not tested this session." Never invent quotes or facts.`

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: HEADERS, body: '' }
  if (event.httpMethod !== 'POST')    return json(405, { error: 'Method not allowed' }, HEADERS)

  const auth = await requireAdmin(event)
  if (auth.errorResponse) return { ...auth.errorResponse, headers: { ...HEADERS, ...auth.errorResponse.headers } }
  const { user } = auth

  const limited = await enforceRateLimit(user.id, 'broadside-debrief', HEADERS)
  if (limited) return limited

  if (!ANTHROPIC_API_KEY) return json(503, { error: 'brain-not-configured' }, HEADERS)

  let body
  try { body = JSON.parse(event.body || '{}') } catch { return json(400, { error: 'Invalid JSON body' }, HEADERS) }

  const transcript = Array.isArray(body.transcript) ? body.transcript.slice(-40) : []
  const stats = body.stats && typeof body.stats === 'object' ? body.stats : {}
  const dossierName = typeof body.dossierName === 'string' ? body.dossierName.slice(0, 120) : null
  const dossierId = UUID.test(body.dossierId || '') ? body.dossierId : null

  const turns = transcript
    .filter(t => t && typeof t.text === 'string' && (t.who === 'oppo' || t.who === 'user'))
    .map(t => ({ who: t.who, text: t.text.slice(0, 600) }))
  if (turns.filter(t => t.who === 'user').length < 1) {
    return json(400, { error: 'No trainee answers in transcript' }, HEADERS)
  }

  const usr = `CANDIDATE: ${dossierName || 'unknown'}
SESSION STATS: ${JSON.stringify({ attacks: stats.attacks, avgResponseSec: stats.avgResponse, ticsAndFillers: stats.fillers, topTics: stats.topTics }).slice(0, 500)}

TRANSCRIPT (OPPO = attacker, USER = the candidate):
${turns.map(t => `${t.who === 'oppo' ? 'OPPO' : 'USER'}: ${t.text}`).join('\n')}

Write the report card now.`

  let debrief
  try {
    const ctrl = new AbortController()
    const to = setTimeout(() => ctrl.abort(), 20000)
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: MODEL, max_tokens: 700, system: SYSTEM, messages: [{ role: 'user', content: usr }] }),
    })
    clearTimeout(to)
    if (!r.ok) throw new Error('anthropic ' + r.status)
    const j = await r.json()
    debrief = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim()
    if (!debrief) throw new Error('empty debrief')
  } catch (e) {
    console.error('[broadside-debrief] LLM error:', e.message)
    return json(502, { error: 'debrief-failed' }, HEADERS)
  }

  // Persist when the table exists; the report card still returns if not.
  let saved = false
  try {
    const { error } = await serviceClient().from('broadside_sessions').insert({
      user_id: user.id,
      dossier_id: dossierId,
      dossier_name: dossierName,
      stats,
      transcript: turns,
      debrief,
    })
    saved = !error
    if (error) console.warn('[broadside-debrief] save skipped:', error.message)
  } catch (e) {
    console.warn('[broadside-debrief] save skipped:', e.message)
  }

  return json(200, { debrief, saved }, HEADERS)
}
