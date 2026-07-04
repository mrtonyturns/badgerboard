// Netlify Function: generate-dossier
// Lightweight synchronous trigger — validates auth, fires background function, returns immediately.
// The real work happens in generate-dossier-background.js (no timeout, saves to Supabase).

const ANTHROPIC_API_KEY  = process.env.ANTHROPIC_API_KEY
const PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY // must be set in Netlify env vars
const SUPABASE_URL       = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const CLAUDE_MODEL       = 'claude-sonnet-5'

const { ADMIN_EMAILS } = require('./_config')

function sanitize(val, maxLen = 200) {
  if (val === null || val === undefined) return ''
  return String(val).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').slice(0, maxLen).trim()
}

async function verifyUser(authHeader) {
  if (!authHeader?.startsWith('Bearer ')) return null
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return null
  const token = authHeader.slice(7)
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${token}` },
  })
  if (!res.ok) return null
  return await res.json()
}

function getUserPlan(user) {
  if (!user) return 'scout'
  if (ADMIN_EMAILS.includes(user.email?.toLowerCase())) return 'agency'
  const p = user?.user_metadata?.plan
  // Normalize new-format plan keys introduced in v1.14 pricing overhaul
  const PLAN_MAP = {
    c_monitor: 'monitor',  a_monitor: 'monitor',
    c_active:  'campaign', a_active:  'campaign',
    c_campaign:'campaign', a_campaign:'agency',
  }
  return PLAN_MAP[p] || (['scout', 'monitor', 'campaign', 'agency'].includes(p) ? p : 'scout')
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  }

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) }
  }

  let body
  try { body = JSON.parse(event.body) } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }
  }

  // Test mode — verify keys are set
  if (body.test === true) {
    if (!ANTHROPIC_API_KEY) {
      return { statusCode: 200, headers, body: JSON.stringify({ ok: false, error: 'ANTHROPIC_API_KEY is not set.' }) }
    }
    if (body.deep) {
      try {
        const ctrl = new AbortController()
        setTimeout(() => ctrl.abort(), 15000)
        const t0 = Date.now()
        const r = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST', signal: ctrl.signal,
          headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: 20, messages: [{ role: 'user', content: 'Say OK' }] }),
        })
        const ms = Date.now() - t0
        if (!r.ok) {
          const errText = await r.text()
          return { statusCode: 200, headers, body: JSON.stringify({ ok: false, error: `API ${r.status}: ${errText.slice(0, 300)}`, ms }) }
        }
        const d = await r.json()
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true, reply: d.content?.[0]?.text, ms, model: CLAUDE_MODEL }) }
      } catch (e) {
        return { statusCode: 200, headers, body: JSON.stringify({ ok: false, error: e.message }) }
      }
    }
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, key_set: true, key_prefix: ANTHROPIC_API_KEY.slice(0, 8) + '...', perplexity: !!PERPLEXITY_API_KEY }) }
  }

  if (!ANTHROPIC_API_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY is not configured.' }) }
  }

  // Validate candidate
  const { candidate, candidate_id } = body
  if (!candidate || typeof candidate !== 'object') {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'No candidate provided' }) }
  }
  const name = sanitize(candidate.name, 150)
  if (!name) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Candidate name is required' }) }
  }

  // Verify auth — reject unauthenticated callers before firing any background work
  const user = await verifyUser(event.headers?.authorization || event.headers?.Authorization)
  if (!user) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Not authenticated' }) }
  }
  const userPlan = getUserPlan(user)

  // Determine the background function URL from trusted env var (never user-controlled headers)
  const siteUrl = process.env.URL || process.env.SITE_URL || 'https://www.badgerboardwi.com'
  const bgUrl = `${siteUrl}/.netlify/functions/generate-dossier-background`

  // Fire-and-forget the background function (no await — returns 202 immediately)
  fetch(bgUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      candidate,
      candidate_id: candidate_id || null,
      user_id: user?.id || null,
      user_plan: userPlan,
      auth_header: event.headers?.authorization || event.headers?.Authorization || null,
    }),
  }).catch(e => console.error('[generate-dossier] Failed to fire background fn:', e.message))

  // Return immediately — frontend will poll Supabase for the result
  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      status: 'generating',
      candidate_name: name,
      tier: userPlan,
      message: 'Profile generation started. Poll for new profiles to get the result.',
    }),
  }
}
