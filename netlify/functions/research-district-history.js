// Netlify Function: research-district-history
// Researches the 15-year officeholder history for a state/federal district seat
// using Perplexity (web research) + Claude (structuring), then caches the result
// in district_intel so the AI cost is paid once per district.

export const handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json',
  }
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' }
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) }

  const ANTHROPIC_API_KEY    = process.env.ANTHROPIC_API_KEY
  const CLAUDE_MODEL         = process.env.CLAUDE_RESEARCH_MODEL || 'claude-sonnet-5' // latest Sonnet; Fable 5's always-on thinking too costly
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

  let body
  try { body = JSON.parse(event.body || '{}') } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }
  }
  const { district_key, layer, district_name, office_label, force, step, research: providedResearch } = body
  if (!district_key || !district_name || !office_label) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'district_key, district_name, office_label required' }) }
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
        research = pData.choices?.[0]?.message?.content || null
      }
    } catch (e) { console.warn('[district-history] Perplexity failed:', e.message) }
  }
  if (!research) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: 'Research service unavailable — try again shortly' }) }
  }
  if (step === 'research') {
    return { statusCode: 200, headers, body: JSON.stringify({ step: 'research', research }) }
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
