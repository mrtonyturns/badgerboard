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

import { enforceRateLimit } from './_rate-limit.js'
import { logAiUsage } from './_ai-usage.js'
import { SUPPORT_KB } from './_support-kb.js'

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
- Candidates tracked: ${ctx.candidateCount}
- Profiles generated: ${ctx.dossierCount}
- Error log entries (last 7 days): ${ctx.recentErrors}
`.trim()

  return `You are the Badger Board support assistant. Direct. Disciplined. Helpful. You answer like a field manual: short sentences, clear steps, no fluff, no hedging. You still stay professional and courteous — the discipline is in the clarity, not in being harsh.

Your knowledge base — the complete Badger Board field manual — is below. Answer questions FROM IT. If the manual covers it, use the manual's facts exactly (prices, limits, tier availability).

${SUPPORT_KB}

${contextBlock}

HARD LIMITS ON YOUR ACCESS — state these plainly if asked:
- You have NO access to the user's voter lists or any voter data. None.
- You have NO access to the user's uploaded documents or files.
- You have NO access to the user's notes. (The Profiler AI is separate, and it only reads a note or file when the user flips that item's AI toggle ON — default is OFF.)
- You see only: the user's name, email, plan tier, and the counts above. Nothing else.
- If the user asks you to read, summarize, or search their voter data, files, or notes: tell them you cannot access that data by design, and point them to the feature in the app that works with it.

Instructions:
- PLAIN TEXT ONLY. The chat widget does not render markdown — never use asterisks, bold, headers, or bullet symbols. For steps, write "1." "2." on separate lines.
- Use the user context above to personalize — e.g. tier-gating answers should reference THEIR plan.
- Never share one user's data with another. This context is exclusively for this user's session.
- Do not reveal raw internal values (UUIDs, tokens, keys, endpoint names).
- Keep responses under 5 sentences unless the question needs steps — then use a short numbered list.
- If you don't know something specific, or it's a billing/account dispute, direct them to support@badgerboardwi.com.
- Don't mention competing products. Don't invent features the manual doesn't list.`
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

  if (!Array.isArray(messages) || !messages.length) {
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

  // Durable, cross-instance per-user rate limit (Postgres-backed, fails open
  // if the limiter table is unavailable).
  const limited = await enforceRateLimit(user.id, 'support-chat', CORS_HEADERS)
  if (limited) return limited

  // Validate and STRIP the client-supplied messages array before forwarding
  // to Anthropic: only role+content pass through, roles whitelisted, sizes
  // bounded. Never forward arbitrary client JSON to the model API.
  const cleanMessages = []
  for (const m of messages.slice(-30)) {
    if (!m || typeof m !== 'object') continue
    if (m.role !== 'user' && m.role !== 'assistant') {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Invalid message role' }) }
    }
    if (typeof m.content !== 'string' || !m.content.trim()) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Invalid message content' }) }
    }
    cleanMessages.push({ role: m.role, content: m.content.slice(0, 4000) })
  }
  if (!cleanMessages.length || cleanMessages[cleanMessages.length - 1].role !== 'user') {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Conversation must end with a user message' }) }
  }

  // ── 2. Fetch user context (RLS-enforced, PRIVACY-WHITELISTED) ──────────────
  // The support agent's context is a hard whitelist of aggregate COUNTS only.
  // It must NEVER query: voters, voter_lists (row contents), candidate notes,
  // storage objects/files, or any other user content. Voter data, uploaded
  // documents, and notes are off-limits to this agent by design — do not add
  // queries against them here.
  let ctx = { candidateCount: 0, dossierCount: 0, recentErrors: 0 }

  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

    const [candidatesRes, dossiersRes, errorsRes] = await Promise.all([
      rls(token, 'candidates?select=id&limit=1'),
      rls(token, 'dossiers?select=id&limit=1'),
      rls(token, `error_logs?select=id&created_at=gte.${sevenDaysAgo}&limit=1`),
    ])

    ctx.candidateCount = candidatesRes.count ?? 0
    ctx.dossierCount   = dossiersRes.count   ?? 0
    ctx.recentErrors   = errorsRes.count     ?? 0
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
        max_tokens: 600,
        system:     systemPrompt,
        messages:   cleanMessages,
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
    logAiUsage({ userId: user.id, endpoint: 'support-chat', provider: 'anthropic', model: 'claude-haiku-4-5-20251001', inputTokens: data?.usage?.input_tokens || 0, outputTokens: data?.usage?.output_tokens || 0 })
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
