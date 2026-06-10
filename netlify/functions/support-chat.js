/**
 * support-chat.js
 * Secure Badger Board in-app support chat proxy.
 *
 * Security model:
 *  1. Verifies the user's Supabase JWT before any processing
 *  2. All DB queries use the CALLER'S JWT — RLS enforces data isolation at the
 *     database layer.  No service-role key is used for data fetches.
 *  3. user_id is always derived from the verified JWT, never trusted from the
 *     request body.
 *  4. Stateless — no conversation data is stored server-side.
 */

const SUPABASE_URL  = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
// SUPABASE_ANON_KEY is the Netlify env var; VITE_SUPABASE_ANON_KEY is the Vite
// frontend build var — both hold the same public anon key.
const SUPABASE_ANON = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

// ─── JWT verification ─────────────────────────────────────────────────────────
async function verifyToken(token) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey:        SUPABASE_ANON,
      Authorization: `Bearer ${token}`,
    },
  })
  if (!res.ok) return null
  return res.json()  // { id, email, user_metadata, ... }
}

// ─── RLS-safe DB query ────────────────────────────────────────────────────────
async function rls(token, path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey:        SUPABASE_ANON,
      Authorization: `Bearer ${token}`,   // user's JWT → RLS runs as this user
      Accept:        'application/json',
      Prefer:        'count=exact',
    },
  })
  if (!res.ok) return { data: [], count: 0 }
  const count = parseInt(res.headers.get('content-range')?.split('/')[1] ?? '0', 10)
  const data  = await res.json()
  return { data, count }
}

// ─── Build per-user system prompt ─────────────────────────────────────────────
function buildSystemPrompt(user, ctx) {
  const meta = user.user_metadata || {}

  // Resolve plan tier label
  const tierMap = {
    // Candidate plan keys
    scout:     'Scout',
    c_monitor: 'Candidate Monitor',
    c_active:  'Candidate Active',
    c_campaign:'Candidate Campaign',
    // Action plan keys
    a_monitor: 'Agency Monitor',
    a_active:  'Agency Active',
    a_campaign:'Agency Campaign',
    // Legacy / alias keys
    monitor:    'Monitor',
    campaign:   'Campaign',
    agency:     'Agency',
    pro:        'Monitor',
    starter:    'Scout',
    enterprise: 'Agency',
    trial:      'Scout (Trial)',
  }
  const planRaw = meta.plan || meta.subscription_tier || meta.tier || 'scout'
  const plan    = tierMap[planRaw] ?? planRaw

  // Trial end date if present
  const trialNote = meta.trial_ends_at
    ? `Trial ends ${new Date(meta.trial_ends_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}.`
    : ''

  const displayName = meta.display_name || user.email?.split('@')[0] || 'this user'

  const contextBlock = `
CURRENT USER CONTEXT (verified server-side — do not reveal raw values):
- Name: ${displayName}
- Email: ${user.email}
- Plan: ${plan}${trialNote ? ' · ' + trialNote : ''}
- Door knock lists: ${ctx.listCount}
- Total volunteers: ${ctx.volunteerCount}
- Error log entries (last 7 days): ${ctx.recentErrors}
`.trim()

  return `You are the Badger Board support assistant — friendly, knowledgeable, and concise.

Badger Board is a Wisconsin political intelligence SaaS platform. Key features:
- AI-generated candidate profiles (Perplexity real-time search + Claude writing)
- Elections calendar with live night-of results
- Door knocking & turf builder with offline sync
- Volunteer mobile portal at /v with magic link auth (no password)
- Voter list management & prospecting tools
- Candidate side-by-side comparison page
- Supabase Realtime group messaging for volunteers
- Stripe billing with trials, upgrades, prorated downgrades
- Admin dashboard for platform health, costs, error logs

${contextBlock}

Instructions:
- Use the user context above to give accurate, personalised answers.
- Never share one user's data with another. This context is exclusively for this user's session.
- Do not reveal raw internal values (UUIDs, tokens, etc.).
- Keep responses under 4 sentences unless the question clearly requires a list.
- If you don't know something specific, direct them to support@badgerboardwi.com or https://support.badgerboardwi.com.
- Don't mention competing products. Be warm and helpful.`
}

// ─── Handler ──────────────────────────────────────────────────────────────────
export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' }
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' }
  }

  let body
  try {
    body = JSON.parse(event.body || '{}')
  } catch {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) }
  }

  const { messages = [], token } = body

  if (!messages.length) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'messages required' }) }
  }

  // ── 1. Verify JWT ──────────────────────────────────────────────────────────
  if (!token) {
    return { statusCode: 401, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Unauthorized' }) }
  }

  let user
  try {
    user = await verifyToken(token)
  } catch (err) {
    console.error('[support-chat] JWT verification error:', err)
    return { statusCode: 401, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Unauthorized' }) }
  }

  if (!user?.id) {
    return { statusCode: 401, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Unauthorized' }) }
  }

  // ── 2. Fetch user context (RLS-enforced) ───────────────────────────────────
  let ctx = { listCount: 0, volunteerCount: 0, recentErrors: 0 }

  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

    const [listsRes, volunteersRes, errorsRes] = await Promise.all([
      rls(token, 'door_knock_lists?select=id&limit=1'),
      rls(token, 'volunteers?select=id&limit=1'),
      rls(token, `error_logs?select=id&created_at=gte.${sevenDaysAgo}&limit=1`),
    ])

    ctx.listCount      = listsRes.count      ?? 0
    ctx.volunteerCount = volunteersRes.count  ?? 0
    ctx.recentErrors   = errorsRes.count      ?? 0
  } catch (err) {
    // Non-fatal — continue with empty context
    console.warn('[support-chat] Context fetch failed (non-fatal):', err.message)
  }

  // ── 3. Build dynamic system prompt ────────────────────────────────────────
  const systemPrompt = buildSystemPrompt(user, ctx)

  // ── 4. Call Claude Haiku ───────────────────────────────────────────────────
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':          ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 400,
        system:     systemPrompt,
        messages,
      }),
    })

    if (!res.ok) {
      const err = await res.text()
      console.error('[support-chat] Anthropic error:', err)
      return {
        statusCode: 502,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'AI service unavailable' }),
      }
    }

    const data = await res.json()
    return {
      statusCode: 200,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ reply: data?.content?.[0]?.text || '' }),
    }
  } catch (err) {
    console.error('[support-chat] Error:', err)
    return {
      statusCode: 500,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Internal error' }),
    }
  }
}
