// Netlify Function: discover-candidates
// Uses Claude to discover Wisconsin candidates by county, level, or office
// ANTHROPIC_API_KEY must be set in Netlify environment variables

const { enforceRateLimit } = require('./_rate-limit')
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY
const SUPABASE_URL      = process.env.SUPABASE_URL  || process.env.VITE_SUPABASE_URL
const SUPABASE_ANON     = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY
const MODEL = 'claude-opus-4-8'

const { ADMIN_EMAILS } = require('./_config')
const CAMPAIGN_PLUS  = ['campaign', 'agency', 'c_active', 'c_campaign', 'a_monitor', 'a_active', 'a_campaign']

// ─── Sanitization & allowlists ────────────────────────────────────────────────
function sanitize(val, maxLen = 200) {
  if (val === null || val === undefined) return ''
  return String(val)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .slice(0, maxLen)
    .trim()
}

const ALLOWED_MODES  = ['county', 'level', 'office']
const ALLOWED_LEVELS = ['federal', 'state', 'county', 'municipal']

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

  if (!ANTHROPIC_API_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured' }) }
  }

  // ── Auth guard ────────────────────────────────────────────────────────────────
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
  // ── Tier check ────────────────────────────────────────────────────────────────
  const caller = await authRes.json()
  const plan = ADMIN_EMAILS.includes(caller.email?.toLowerCase())
    ? 'agency'
    : (caller?.app_metadata?.plan || 'scout')
  if (!CAMPAIGN_PLUS.includes(plan)) {
    return { statusCode: 403, headers, body: JSON.stringify({ error: 'Campaign plan or higher required.' }) }
  }

  // ── Durable per-user rate limit ───────────────────────────────────────────────
  const limited = await enforceRateLimit(caller.id, 'discover-candidates', headers)
  if (limited) return limited
  // ─────────────────────────────────────────────────────────────────────────────

  let body
  try {
    body = JSON.parse(event.body)
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }
  }

  const mode = sanitize(body.mode, 20).toLowerCase()
  if (!ALLOWED_MODES.includes(mode)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: `Invalid mode. Must be one of: ${ALLOWED_MODES.join(', ')}` }) }
  }

  // Build context based on mode
  let searchContext = ''
  if (mode === 'county') {
    const county      = sanitize(body.county, 60)
    const electionYear = sanitize(body.electionYear, 4)
    if (!county) return { statusCode: 400, headers, body: JSON.stringify({ error: 'county is required for county mode' }) }
    searchContext = `County: ${county} County, Wisconsin${electionYear ? `, Election Year: ${electionYear}` : ''}`
  } else if (mode === 'level') {
    const level = sanitize(body.level, 20).toLowerCase()
    if (!ALLOWED_LEVELS.includes(level)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: `Invalid level. Must be one of: ${ALLOWED_LEVELS.join(', ')}` }) }
    }
    searchContext = `Government Level: ${level}, State: Wisconsin`
  } else if (mode === 'office') {
    const officeName   = sanitize(body.officeName,   150)
    const districtName = sanitize(body.districtName, 100)
    const electionYear = sanitize(body.electionYear, 4)
    const level        = sanitize(body.level,        20)
    if (!officeName) return { statusCode: 400, headers, body: JSON.stringify({ error: 'officeName is required for office mode' }) }
    searchContext = `Office: ${officeName}${districtName ? ` (${districtName})` : ''}${level ? `, Level: ${level}` : ''}${electionYear ? `, Year: ${electionYear}` : ''}, State: Wisconsin`
  }

  const systemPrompt = `You are a political research assistant specializing in Wisconsin elections. You have knowledge of candidates, races, and political environments across Wisconsin. When asked to discover candidates, you provide structured, accurate data based on publicly available information. Always note the confidence level of your information.`

  const userPrompt = `Discover and list candidates for the following search parameters:

${searchContext}

For each candidate you identify, provide a structured entry in this exact JSON format. Return ONLY a JSON array — no markdown, no explanation:

[
  {
    "name": "Full Name",
    "party": "Republican|Democrat|Independent|Nonpartisan|Other",
    "office": "Full office name",
    "district": "District name or number if applicable",
    "level": "federal|state|county|municipal",
    "status": "declared|exploring|elected|unknown",
    "website": "URL or null",
    "notes": "Brief note about confidence level or source",
    "confidence": "HIGH|MEDIUM|LOW"
  }
]

Include 5-15 candidates if available. If fewer are known, include only those with reasonable confidence. Mark any candidate you are uncertain about with confidence: "LOW".`

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
        max_tokens: 7000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    })

    if (!response.ok) {
      const err = await response.json()
      throw new Error(err.error?.message || `Anthropic API error: ${response.status}`)
    }

    const data    = await response.json()
    const rawText = ((data.content || []).filter(b => b.type === 'text').map(b => b.text).join('')) || '[]'

    let candidates = []
    try {
      // Strip any accidental markdown fencing
      const cleaned = rawText.replace(/^```json?\s*/i, '').replace(/\s*```$/i, '').trim()
      candidates = JSON.parse(cleaned)
      if (!Array.isArray(candidates)) candidates = []
    } catch {
      // Return raw text if JSON parse fails — client can display it
      return { statusCode: 200, headers, body: JSON.stringify({ candidates: [], raw: rawText }) }
    }

    return { statusCode: 200, headers, body: JSON.stringify({ candidates, mode, searchContext }) }
  } catch (err) {
    console.error('Discover candidates error:', err)
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'An internal error occurred' || 'Discovery failed' }) }
  }
}
