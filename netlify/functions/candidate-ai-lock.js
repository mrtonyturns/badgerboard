/**
 * candidate-ai-lock.js
 * Lock / unlock AI access to one candidate's notes & documents.
 *
 * SECURITY MODEL (spec: Candidate Profile Redesign §7):
 * - Locking is instant, no confirmation.
 * - Unlocking within 5 minutes of locking needs no password (grace window).
 * - After the grace window, unlocking requires the caller's BadgerBoard
 *   account password, verified SERVER-SIDE against Supabase Auth
 *   (password grant). Passwords are never compared client-side.
 * - Lock/unlock events are written to the activity_log audit trail.
 *
 * POST { candidate_id, action: 'lock' | 'unlock', password? }
 *  -> lock:                        200 { locked: true,  locked_at }
 *  -> unlock (in grace):           200 { locked: false }
 *  -> unlock (after grace, ok pw): 200 { locked: false }
 *  -> unlock (after grace, no pw): 401 { error: 'password-required', grace_expired: true }
 *  -> unlock (bad pw):             401 { error: 'invalid-password' }
 */

const { json, requireUser, serviceClient } = require('./_shared')
const { enforceRateLimit } = require('./_rate-limit')

const SUPABASE_URL  = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const SUPABASE_ANON = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY
const GRACE_MS = 5 * 60 * 1000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const HEADERS = {
  'Access-Control-Allow-Origin':  process.env.ALLOWED_ORIGIN || 'https://badgerboardwi.com',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
}

async function audit(userId, action, candidateId, details) {
  try {
    await serviceClient().from('activity_log').insert({
      user_id: userId,
      action,                       // 'ai_lock' | 'ai_unlock'
      entity_type: 'candidate',
      entity_id: candidateId,
      details,
    })
  } catch (e) { console.warn('[ai-lock] audit failed:', e.message) }
}

/** Server-side password check via Supabase Auth password grant. */
async function verifyPassword(email, password) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  return r.ok
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: HEADERS, body: '' }
  if (event.httpMethod !== 'POST')    return json(405, { error: 'Method not allowed' }, HEADERS)

  const auth = await requireUser(event)
  if (auth.errorResponse) return { ...auth.errorResponse, headers: { ...HEADERS, ...auth.errorResponse.headers } }
  const { user } = auth

  const limited = await enforceRateLimit(user.id, 'candidate-ai-lock', HEADERS)
  if (limited) return limited

  let body
  try { body = JSON.parse(event.body || '{}') } catch { return json(400, { error: 'Invalid JSON body' }, HEADERS) }

  const candidateId = body.candidate_id
  const action = body.action
  if (!UUID.test(candidateId || '')) return json(400, { error: 'candidate_id required' }, HEADERS)
  if (action !== 'lock' && action !== 'unlock') return json(400, { error: 'action must be lock or unlock' }, HEADERS)

  // The caller must own the candidate.
  const sb = serviceClient()
  const { data: cand, error: qErr } = await sb
    .from('candidates')
    .select('id, name, created_by, ai_access_notes, ai_access_locked_at')
    .eq('id', candidateId)
    .single()
  if (qErr || !cand) return json(404, { error: 'Candidate not found' }, HEADERS)
  if (cand.created_by && cand.created_by !== user.id) {
    return json(403, { error: 'Not your candidate' }, HEADERS)
  }

  if (action === 'lock') {
    const lockedAt = new Date().toISOString()
    const { error } = await sb
      .from('candidates')
      .update({ ai_access_notes: false, ai_access_locked_at: lockedAt })
      .eq('id', candidateId)
    if (error) return json(500, { error: 'Lock failed' }, HEADERS)
    await audit(user.id, 'ai_lock', candidateId, { candidate_name: cand.name })
    return json(200, { locked: true, locked_at: lockedAt }, HEADERS)
  }

  // ── unlock ──
  if (cand.ai_access_notes !== false) return json(200, { locked: false }, HEADERS) // already unlocked

  const lockedAtMs = cand.ai_access_locked_at ? Date.parse(cand.ai_access_locked_at) : 0
  const inGrace = lockedAtMs && (Date.now() - lockedAtMs) < GRACE_MS

  if (!inGrace) {
    const password = typeof body.password === 'string' ? body.password : ''
    if (!password) return json(401, { error: 'password-required', grace_expired: true }, HEADERS)
    const ok = await verifyPassword(user.email, password)
    if (!ok) {
      await audit(user.id, 'ai_unlock_denied', candidateId, { candidate_name: cand.name, reason: 'invalid-password' })
      return json(401, { error: 'invalid-password' }, HEADERS)
    }
  }

  const { error } = await sb
    .from('candidates')
    .update({ ai_access_notes: true, ai_access_locked_at: null })
    .eq('id', candidateId)
  if (error) return json(500, { error: 'Unlock failed' }, HEADERS)
  await audit(user.id, 'ai_unlock', candidateId, {
    candidate_name: cand.name,
    method: inGrace ? 'grace-window' : 'password-reauth',
  })
  return json(200, { locked: false }, HEADERS)
}
