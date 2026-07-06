// Netlify Function: research-swot
// Reads a candidate's latest dossier and asks Claude to generate a SWOT analysis.

import { enforceRateLimit } from './_rate-limit.js'

export const handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json',
  }
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' }
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) }

  const ANTHROPIC_API_KEY  = process.env.ANTHROPIC_API_KEY
  const SUPABASE_URL       = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

  // ── Verify JWT ──────────────────────────────────────────────────────────────
  const authHeader = event.headers?.authorization || event.headers?.Authorization
  if (!authHeader?.startsWith('Bearer ')) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Not authenticated' }) }
  }
  const token = authHeader.slice(7)
  const authRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${token}` },
  })
  if (!authRes.ok) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid token' }) }
  const uid = (await authRes.json())?.id
  if (!uid) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid token' }) }

  // ── Durable per-user rate limit ─────────────────────────────────────────────
  const limited = await enforceRateLimit(uid, 'research-swot', headers)
  if (limited) return limited

  // ── Parse body ──────────────────────────────────────────────────────────────
  let body
  try { body = JSON.parse(event.body) } catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) } }

  const { candidate_id, candidate_name } = body
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  if (!candidate_id || !UUID.test(candidate_id)) return { statusCode: 400, headers, body: JSON.stringify({ error: 'valid candidate_id required' }) }

  // ── Fetch latest dossier — scoped to a candidate the CALLER owns (IDOR guard) ─
  const dossierRes = await fetch(
    `${SUPABASE_URL}/rest/v1/dossiers?candidate_id=eq.${encodeURIComponent(candidate_id)}&select=*,candidate:candidates!inner(created_by)&candidate.created_by=eq.${encodeURIComponent(uid)}&order=generated_at.desc&limit=1`,
    { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` } }
  )
  if (!dossierRes.ok) return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to fetch profile' }) }
  const dossiers = await dossierRes.json()
  if (!dossiers.length || !dossiers[0].content) {
    return { statusCode: 404, headers, body: JSON.stringify({ error: 'No profile found for this candidate' }) }
  }

  const dossierContent = dossiers[0].content

  // ── Call Claude to generate SWOT ────────────────────────────────────────────
  const prompt = `You are a senior political strategist. Based on the following political intelligence dossier for ${candidate_name || 'this candidate'}, generate a SWOT analysis.

Analyze the dossier carefully and produce a JSON object with exactly these four keys:
- "strengths": Political strengths, advantages, strong base of support, experience, fundraising ability, popular positions, etc.
- "weaknesses": Political vulnerabilities, controversial positions, lack of experience, funding gaps, scandals, legal troubles, inconsistencies, etc.
- "opportunities": Favorable political conditions, potential endorsements, emerging issues they could capitalize on, opponent weaknesses, demographic shifts, etc.
- "threats": Risks to their campaign or position — strong opponents, negative press, changing voter sentiment, redistricting, legal proceedings, etc.

Each field should be 3-6 bullet points written as a plain text list (use bullet character • at the start of each point). Be specific and reference actual information from the dossier. Do not include generic filler.

Return ONLY valid JSON, no markdown fences.

DOSSIER:
${dossierContent.slice(0, 12000)}`

  try {
    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }],
      }),
    })

    if (!aiRes.ok) {
      const err = await aiRes.json()
      throw new Error(err.error?.message || `Claude API error: ${aiRes.status}`)
    }

    const data = await aiRes.json()
    let text = data.content?.[0]?.text || ''

    // Strip markdown code fences if present
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim()

    let swot
    try { swot = JSON.parse(text) } catch {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to parse SWOT response from AI' }) }
    }

    // Ensure all four keys exist
    swot = {
      strengths:     swot.strengths     || '',
      weaknesses:    swot.weaknesses    || '',
      opportunities: swot.opportunities || '',
      threats:       swot.threats       || '',
    }

    return { statusCode: 200, headers, body: JSON.stringify({ swot }) }
  } catch (err) {
    console.error('SWOT generation error:', err)
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'An internal error occurred' || 'SWOT generation failed' }) }
  }
}
