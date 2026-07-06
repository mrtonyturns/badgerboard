// Netlify Function: generate-prospecting
// Calls Claude API to build and enrich a prospecting list of candidates
// ANTHROPIC_API_KEY must be set in Netlify environment variables

const { enforceRateLimit } = require('./_rate-limit')
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY
const SUPABASE_URL      = process.env.SUPABASE_URL  || process.env.VITE_SUPABASE_URL
const SUPABASE_ANON     = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY
const MODEL = 'claude-opus-4-8'

// ─── Sanitization & allowlists ────────────────────────────────────────────────
function sanitize(val, maxLen = 200) {
  if (val === null || val === undefined) return ''
  return String(val)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .slice(0, maxLen)
    .trim()
}
const ALLOWED_LEVELS   = ['', 'federal', 'state', 'county', 'municipal']
const ALLOWED_PARTIES  = ['', 'Republican', 'Democrat', 'Independent', 'Libertarian', 'Green', 'Constitution', 'Nonpartisan', 'Other']
const ALLOWED_STATUSES = ['', 'exploring', 'declared', 'primary_winner', 'general', 'elected', 'lost', 'withdrawn']

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  }

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' }
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) }
  }

  if (!ANTHROPIC_API_KEY) {
    return {
      statusCode: 500, headers,
      body: JSON.stringify({ error: 'ANTHROPIC_API_KEY is not configured.' })
    }
  }

  // ── Auth guard (must be before input validation) ──────────────────────────────
  const authHeader = event.headers?.authorization || event.headers?.Authorization
  if (!authHeader?.startsWith('Bearer ')) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Not authenticated' }) }
  }
  const authRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON, Authorization: authHeader },
  })
  if (!authRes.ok) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid or expired token' }) }
  }
  const caller = await authRes.json()
  if (!caller?.id) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid or expired token' }) }
  }

  // ── Durable per-user rate limit ───────────────────────────────────────────────
  const limited = await enforceRateLimit(caller.id, 'generate-prospecting', headers)
  if (limited) return limited
  // ─────────────────────────────────────────────────────────────────────────────

  let body
  try {
    body = JSON.parse(event.body)
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }
  }

  // Sanitize top-level fields
  const listName           = sanitize(body.listName, 200)
  const listDesc           = sanitize(body.listDesc, 500)
  const customInstructions = sanitize(body.customInstructions, 1000)
  const includeContact     = Boolean(body.includeContact)
  const filters            = body.filters && typeof body.filters === 'object' ? body.filters : {}

  // Validate filter values against allowlists
  const filterLevel   = ALLOWED_LEVELS.includes(filters.filterLevel)   ? sanitize(filters.filterLevel, 20)   : ''
  // Handle both legacy filterParty (string) and filterParties (array) from frontend
  const rawParties = Array.isArray(filters.filterParties)
    ? filters.filterParties
    : (filters.filterParty ? [filters.filterParty] : [])
  const validParties = rawParties.filter(p => ALLOWED_PARTIES.includes(p)).map(p => sanitize(p, 20))
  const filterParty = validParties.join(', ')
  const filterStatus  = ALLOWED_STATUSES.includes(filters.filterStatus) ? sanitize(filters.filterStatus, 20) : ''
  const filterElection = sanitize(filters.filterElection, 100)

  // Validate and sanitize candidate array
  const rawCandidates = Array.isArray(body.candidates) ? body.candidates.slice(0, 500) : []
  const candidates = rawCandidates.map(c => ({
    name:               sanitize(c.name, 150),
    party:              sanitize(c.party, 60),
    status:             sanitize(c.status, 60),
    occupation:         sanitize(c.occupation, 150),
    email:              sanitize(c.email, 254),
    phone:              sanitize(c.phone, 30),
    website:            sanitize(c.website, 300),
    campaign_committee: sanitize(c.campaign_committee, 200),
    bio_summary:        sanitize(c.bio_summary, 500),
    office: c.office ? {
      name:          sanitize(c.office.name, 150),
      district_name: sanitize(c.office.district_name, 100),
      district_number: sanitize(c.office.district_number, 10),
      county:        sanitize(c.office.county, 60),
    } : null,
  })).filter(c => c.name)

  if (candidates.length === 0) {
    return {
      statusCode: 400, headers,
      body: JSON.stringify({ error: 'No candidates provided for this list.' })
    }
  }

  // Summarize candidates for the prompt
  const candidateSummaries = candidates.map((c, i) => {
    const parts = [
      `${i + 1}. ${c.name}`,
      c.party ? `Party: ${c.party}` : null,
      c.office ? `Office: ${c.office.name}${c.office.district_name ? ` (${c.office.district_name})` : ''}` : null,
      c.office?.county ? `County: ${c.office.county}` : null,
      c.status ? `Status: ${c.status}` : null,
      c.occupation ? `Occupation: ${c.occupation}` : null,
      includeContact && c.email ? `Email: ${c.email}` : null,
      includeContact && c.phone ? `Phone: ${c.phone}` : null,
      includeContact && c.website ? `Website: ${c.website}` : null,
      c.campaign_committee ? `Committee: ${c.campaign_committee}` : null,
      c.bio_summary ? `Bio: ${c.bio_summary.slice(0, 200)}...` : null,
    ].filter(Boolean)
    return parts.join('\n   ')
  }).join('\n\n')

  const systemPrompt = `You are a senior political marketing strategist at The Bluejack Group, a Wisconsin-based political marketing agency. You build strategic prospecting lists to identify which candidates would be the best clients for the firm's services — including digital advertising, direct mail, voter outreach, opposition research, and campaign consulting.

Your analysis is:
- Strategic and business-focused (finding the best potential clients)
- Honest about each candidate's viability and likelihood of success
- Prioritized by opportunity for The Bluejack Group
- Practical and actionable`

  const userPrompt = `Build a strategic prospecting list for The Bluejack Group based on these filtered Wisconsin candidates.

**LIST NAME:** ${listName}
${listDesc ? `**DESCRIPTION:** ${listDesc}` : ''}

**FILTERS APPLIED:**
- Level: ${filterLevel || 'All'}
- Party: ${filterParty || 'All'}
- Status: ${filterStatus || 'All'}
- Election: ${filterElection || 'All'}

${customInstructions ? `**CUSTOM INSTRUCTIONS:** ${customInstructions}` : ''}

**CANDIDATES TO ANALYZE (${candidates.length} total):**

${candidateSummaries}

Please return a JSON object with this exact structure:
{
  "notes": "2-3 sentence summary of this list's overall strategic value for The Bluejack Group",
  "candidates": [
    {
      "name": "Full candidate name",
      "party": "Party affiliation",
      "office": "Office name",
      "district": "District name/number or null",
      "status": "Current status",
      "email": "email if available or null",
      "phone": "phone if available or null",
      "website": "website if available or null",
      "priority": "high|medium|low",
      "notes": "1-2 sentence strategic note: why this candidate is a good prospect, what services they'd need, and best approach for The Bluejack Group"
    }
  ]
}

Sort candidates by priority (high first, then medium, then low). Include ALL candidates but prioritize the most strategic opportunities. Return ONLY the JSON object with no markdown or other text.`

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 8000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    })

    if (!response.ok) {
      const err = await response.json()
      throw new Error(err.error?.message || `Anthropic API error: ${response.status}`)
    }

    const data = await response.json()
    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('')

    if (!text) throw new Error('No content returned from Claude')

    // Parse JSON from Claude's response
    let parsed
    try {
      // Strip any markdown code fences if present
      const cleaned = text.replace(/```json\n?/gi, '').replace(/```\n?/g, '').trim()
      parsed = JSON.parse(cleaned)
    } catch {
      // Fallback: return candidates as-is with a simple format
      parsed = {
        notes: `AI-generated prospecting list: ${listName}. ${candidates.length} candidates identified.`,
        candidates: candidates.map(c => ({
          name: c.name,
          party: c.party || '',
          office: c.office?.name || '',
          district: c.office?.district_name || (c.office?.district_number ? `District ${c.office.district_number}` : null),
          status: c.status || '',
          email: c.email || null,
          phone: c.phone || null,
          website: c.website || null,
          priority: 'medium',
          notes: `${c.party || ''} candidate for ${c.office?.name || 'office'}.`,
        }))
      }
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(parsed),
    }
  } catch (err) {
    console.error('Prospecting generation error:', err)
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message || 'Failed to generate prospecting list' }),
    }
  }
}
