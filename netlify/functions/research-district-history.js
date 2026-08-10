// Netlify Function: research-district-history
// Researches the 15-year officeholder history for a state/federal district seat
// using Perplexity (web research) + Claude (structuring), then caches the result
// in district_intel so the AI cost is paid once per district.

import crypto from 'crypto'
import { logAiUsage } from './_ai-usage.js'
import { enforceRateLimit } from './_rate-limit.js'
import { ADMIN_EMAILS } from './_config.js'

// Audit fix (#17): the two-step flow (research → structure) round-trips the
// Perplexity research through the CLIENT to dodge the gateway timeout — which
// let any authenticated user substitute arbitrary "research" and poison the
// globally-shared district_intel cache (fake incumbents/parties/results served
// as ground truth to every user, plus a prompt-injection path into the
// structuring model). Step 1 now returns an HMAC over (district_key, research);
// step 2 refuses any research payload whose signature doesn't verify.
const SIGN_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
const signResearch = (districtKey, research) =>
  crypto.createHmac('sha256', SIGN_KEY).update(`${districtKey}\n${research}`).digest('hex')
const sigOk = (districtKey, research, sig) => {
  if (!sig || typeof sig !== 'string') return false
  const expected = signResearch(districtKey, research)
  const A = Buffer.from(expected)
  const B = Buffer.from(String(sig))
  return A.length === B.length && crypto.timingSafeEqual(A, B)
}

const DISTRICT_KEY_RE = /^[\w:.\-]{1,80}$/

export const handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json',
  }
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' }
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) }

  const ANTHROPIC_API_KEY    = process.env.ANTHROPIC_API_KEY
  const CLAUDE_MODEL         = process.env.CLAUDE_RESEARCH_MODEL || 'claude-opus-4-8' // Opus 4.8 (per request)
  const PERPLEXITY_API_KEY   = process.env.PERPLEXITY_API_KEY
  const SUPABASE_URL         = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

  // ── Verify JWT ──────────────────────────────────────────────────────────────
  const authHeader = event.headers?.authorization || event.headers?.Authorization
  if (!authHeader?.startsWith('Bearer ')) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Not authenticated' }) }
  }
  const authRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${authHeader.slice(7)}` },
  })
  if (!authRes.ok) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid token' }) }
  const authUser = await authRes.json()
  const uid = authUser?.id
  if (!uid) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid token' }) }
  const isAdmin = ADMIN_EMAILS.includes((authUser.email || '').toLowerCase())

  // ── Durable per-user rate limit ─────────────────────────────────────────────
  const limited = await enforceRateLimit(uid, 'research-district-history', headers)
  if (limited) return limited

  let body
  try { body = JSON.parse(event.body || '{}') } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }
  }
  const { district_key, layer, district_name: rawDistrictName, office_label: rawOfficeLabel, force: rawForce, step, research: providedResearch, research_sig } = body
  if (!district_key || !rawDistrictName || !rawOfficeLabel) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'district_key, district_name, office_label required' }) }
  }
  // Audit fix (#17): district_key is the sole PK of a shared cache table —
  // validate its shape so arbitrary strings can't mint or overwrite rows.
  if (!DISTRICT_KEY_RE.test(district_key)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid district_key' }) }
  }
  const district_name = String(rawDistrictName).slice(0, 120)
  const office_label  = String(rawOfficeLabel).slice(0, 120)
  // Signed pass-through: reject tampered/foreign research outright
  if (providedResearch && !sigOk(district_key, providedResearch, research_sig)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid research payload — restart the research' }) }
  }
  // Force-refresh cooldown: non-admins can't hammer regeneration of a cached
  // district (each run is real Perplexity+Claude spend on a shared row).
  let force = Boolean(rawForce)
  if (force && !isAdmin) {
    const freshRes = await fetch(`${SUPABASE_URL}/rest/v1/district_intel?district_key=eq.${encodeURIComponent(district_key)}&select=history_at`, {
      headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
    })
    const freshRows = await freshRes.json().catch(() => [])
    const at = freshRows?.[0]?.history_at ? Date.parse(freshRows[0].history_at) : 0
    if (at && Date.now() - at < 24 * 60 * 60 * 1000) force = false  // fresh enough — serve cache
  }

  const sb = (path, opts = {}) => fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  })

  // ── Cache check ─────────────────────────────────────────────────────────────
  if (!force) {
    const cacheRes = await sb(`district_intel?district_key=eq.${encodeURIComponent(district_key)}&select=history,history_at`)
    const rows = await cacheRes.json()
    if (rows?.[0]?.history) {
      return { statusCode: 200, headers, body: JSON.stringify({ cached: true, history: rows[0].history }) }
    }
  }

  // ── Step 1: Perplexity research ────────────────────────────────────────────
  let research = providedResearch || null
  if (!research && PERPLEXITY_API_KEY) {
    try {
      const ctrl = new AbortController()
      setTimeout(() => ctrl.abort(), 18000)
      const pRes = await fetch('https://api.perplexity.ai/chat/completions', {
        method: 'POST', signal: ctrl.signal,
        headers: { Authorization: `Bearer ${PERPLEXITY_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'sonar',
          messages: [
            { role: 'system', content: 'You are a Wisconsin political historian. Be precise about names, parties, years, and vote percentages. Cite what actually happened in this specific district.' },
            { role: 'user', content: `List every person who has held the office of ${office_label} (${district_name}, Wisconsin) from 2010 through today. For each person include: full name, party, years served, each election in this district they won or lost with the year and their vote percentage, whether they are the current officeholder, and a 2-3 sentence biography (background, notable work, committees). Note any redistricting that changed the district's territory. Include election results for every general election for this seat from 2010 to now.` }
          ],
          max_tokens: 2500,
        }),
      })
      if (pRes.ok) {
        const pData = await pRes.json()
        logAiUsage({ userId: uid, endpoint: 'district-intel', provider: 'perplexity', model: 'sonar', inputTokens: pData?.usage?.prompt_tokens || 0, outputTokens: pData?.usage?.completion_tokens || 0 })
        research = pData.choices?.[0]?.message?.content || null
      }
    } catch (e) { console.warn('[district-history] Perplexity failed:', e.message) }
  }
  if (!research) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: 'Research service unavailable — try again shortly' }) }
  }
  if (step === 'research') {
    // Signed so step 2 can verify the payload came from us, not the client
    return { statusCode: 200, headers, body: JSON.stringify({ step: 'research', research, research_sig: signResearch(district_key, research) }) }
  }

  // ── Step 2: Claude structures the research into JSON ───────────────────────
  const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 8000,
      messages: [{
        role: 'user',
        content: `Convert this research about ${office_label} (${district_name}, Wisconsin) into strict JSON. Schema:
{
  "entries": [
    {
      "year": 2024,
      "election": "2024 general",
      "name": "Full Name",
      "party": "Republican" | "Democrat" | "Independent" | "Nonpartisan" | "Other",
      "vote_pct": 62.4 or null,
      "opponent": "Name (Party) pct%" or null,
      "result": "elected" | "re-elected" | "retired" | "lost" | "appointed",
      "current": true | false
    }
  ],
  "people": [
    { "name": "Full Name", "party": "...", "served": "2014–present", "bio": "2-3 sentence biography." }
  ],
  "note": "one-line note about redistricting or data caveats, or null"
}
Rules: entries sorted newest first, one entry per general election for this seat 2010–now (winner only). Exactly one entry has current=true. Every person in entries appears once in people with a bio. Output ONLY the JSON object.

RESEARCH:
${research}`,
      }],
    }),
  })
  if (!claudeRes.ok) {
    const t = await claudeRes.text()
    return { statusCode: 502, headers, body: JSON.stringify({ error: 'Structuring failed', detail: t.slice(0, 200) }) }
  }
  const cData = await claudeRes.json()
  logAiUsage({ userId: uid, endpoint: 'district-intel', provider: 'anthropic', model: CLAUDE_MODEL, inputTokens: cData?.usage?.input_tokens || 0, outputTokens: cData?.usage?.output_tokens || 0 })
  let history
  try {
    const raw = (cData.content?.find(b => b.type === 'text')?.text || '').replace(/^```json?\s*/i, '').replace(/```\s*$/, '').trim()
    history = JSON.parse(raw)
  } catch {
    return { statusCode: 502, headers, body: JSON.stringify({ error: 'Could not parse research output' }) }
  }
  history.researched_at = new Date().toISOString()
  history.office_label = office_label

  // ── Cache ───────────────────────────────────────────────────────────────────
  await sb('district_intel', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({
      district_key,
      layer: layer || null,
      name: district_name,
      history,
      history_at: history.researched_at,
      updated_at: history.researched_at,
    }),
  })

  return { statusCode: 200, headers, body: JSON.stringify({ cached: false, history }) }
}
