// Netlify Function: generate-campaign-intel
// Generates focused campaign intelligence for a specific candidate
// ANTHROPIC_API_KEY must be set in Netlify environment variables

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY
const SUPABASE_URL      = process.env.SUPABASE_URL  || process.env.VITE_SUPABASE_URL
const SUPABASE_ANON     = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY
const MODEL = 'claude-opus-4-8'

const { ADMIN_EMAILS } = require('./_config')
// Include all new-format plan keys that have campaignIntel access (tiers.js: c_active+)
const CAMPAIGN_PLUS  = ['campaign', 'agency', 'c_active', 'c_campaign', 'a_monitor', 'a_active', 'a_campaign']

function sanitize(val, maxLen = 200) {
  if (val === null || val === undefined) return ''
  return String(val)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .slice(0, maxLen)
    .trim()
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
    : (caller?.user_metadata?.plan || 'scout')
  if (!CAMPAIGN_PLUS.includes(plan)) {
    return { statusCode: 403, headers, body: JSON.stringify({ error: 'Campaign plan or higher required.' }) }
  }
  // ─────────────────────────────────────────────────────────────────────────────

  let body
  try {
    body = JSON.parse(event.body)
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }
  }

  const { candidate } = body
  if (!candidate || typeof candidate !== 'object') {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'No candidate provided' }) }
  }

  const safe = {
    name:    sanitize(candidate.name,    150),
    party:   sanitize(candidate.party,   60),
    status:  sanitize(candidate.status,  60),
    office:  sanitize(candidate.office?.name, 150),
    district: sanitize(candidate.office?.district_name, 100),
    election: sanitize(candidate.election?.name, 150),
    website: sanitize(candidate.website, 300),
    bio:     sanitize(candidate.bio_summary, 2000),
    twitter: sanitize(candidate.twitter_handle, 80),
  }

  if (!safe.name) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Candidate name is required' }) }
  }

  const officeLine = safe.office
    ? `${safe.office}${safe.district ? ` (${safe.district})` : ''}`
    : 'Unknown Office'

  const prompt = `Generate a focused campaign intelligence brief for this Wisconsin candidate:

Name: ${safe.name}
Party: ${safe.party || 'Unknown'}
Office: ${officeLine}
Status: ${safe.status || 'Unknown'}
Election: ${safe.election || 'Unknown'}
Website: ${safe.website || 'Not listed'}
Twitter: ${safe.twitter || 'Not listed'}
Bio: ${safe.bio || 'Not provided'}

Provide:
1. **Electoral Assessment** — district competitiveness, incumbency, party lean
2. **Campaign Strengths** — messaging advantages, coalition, resources
3. **Vulnerabilities** — weaknesses, opposition angles, risk areas
4. **Key Issues** — top 3-5 issues driving this race
5. **Engagement Recommendations** — how The Bluejack Group should approach this candidate (as potential client or opposition)`

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
        max_tokens: 1500,
        messages: [{ role: 'user', content: prompt }],
      }),
    })

    if (!response.ok) {
      const err = await response.json()
      throw new Error(err.error?.message || `Anthropic API error: ${response.status}`)
    }

    const data = await response.json()
    const content = data.content?.[0]?.text
    if (!content) throw new Error('No content returned')

    return { statusCode: 200, headers, body: JSON.stringify({ content }) }
  } catch (err) {
    console.error('Campaign intel error:', err)
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message || 'Failed to generate intel' }) }
  }
}
