// Netlify Function: autofill-candidate
// Given a candidate's name, party, office, and election, uses Claude to
// look up and return any publicly available information to auto-populate
// the Add Candidate form fields.
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
    : (caller?.app_metadata?.plan || 'scout')
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

  const name     = sanitize(body.name,     150)
  const party    = sanitize(body.party,    60)
  const office   = sanitize(body.office,   150)
  const election = sanitize(body.election, 150)

  if (!name) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'name is required' }) }
  }

  const prompt = `You are a political research assistant helping populate a Wisconsin candidate database. You must follow an extremely strict accuracy standard.

CANDIDATE PROVIDED:
- Name: ${name}
- Party: ${party || 'Unknown'}
- Running for: ${office || 'Unknown'}
- Election: ${election || 'Unknown'}

CRITICAL RULES — read carefully before filling anything:
1. Only fill a field if you have DIRECT, SPECIFIC knowledge of that exact person in that exact role. Not inference, not assumption, not "probably" — only verified facts you are certain about.
2. Local officials (mayors, county executives, aldermen, school board, county board, municipal judges, etc.) are frequently unknown or confused in training data. If the office is local/municipal/county level, return null for nearly everything unless you are absolutely certain.
3. Do NOT infer occupation from office title. A mayor is not automatically listed as "Mayor" for occupation — return null unless you know their actual day job.
4. Do NOT assume party affiliation from the office or context if not provided.
5. If you are even slightly uncertain about a field, return null. It is far better to return null than to return wrong data.
6. Never fabricate websites, emails, phone numbers, committee names, or social handles. These must be known facts, not guesses.
7. bio_summary: Only include if you have solid biographical knowledge of this specific person. Do not write generic bios based on their office title.

Return ONLY a valid JSON object with exactly these keys. No markdown, no explanation, no extra text:

{
  "email": null,
  "phone": null,
  "website": null,
  "campaign_address": null,
  "campaign_city": null,
  "campaign_zip": null,
  "campaign_committee": null,
  "campaign_manager": null,
  "treasurer": null,
  "occupation": null,
  "employer": null,
  "bio_summary": null,
  "twitter_handle": null,
  "facebook_url": null,
  "instagram_handle": null,
  "notes": null
}

Additional rules:
- website: full URL including https:// — only if you know the actual campaign or official site
- twitter_handle: include the @ symbol — only if you know the verified handle
- notes: briefly describe what you do and don't know about this person, and remind the user to verify everything independently
- All values must be strings or null — never boolean or number
- When in doubt, return null. An empty form is better than wrong data.`

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
        max_tokens: 6000,
        messages: [{ role: 'user', content: prompt }],
      }),
    })

    if (!response.ok) {
      const err = await response.json()
      throw new Error(err.error?.message || `Anthropic API error: ${response.status}`)
    }

    const data    = await response.json()
    const rawText = ((data.content || []).filter(b => b.type === 'text').map(b => b.text).join('')) || '{}'

    let fields = {}
    try {
      const cleaned = rawText.replace(/^```json?\s*/i, '').replace(/\s*```$/i, '').trim()
      fields = JSON.parse(cleaned)
    } catch {
      return { statusCode: 200, headers, body: JSON.stringify({ fields: {}, raw: rawText }) }
    }

    // Strip any null values so frontend only merges fields that have data
    const populated = Object.fromEntries(
      Object.entries(fields).filter(([, v]) => v !== null && v !== '')
    )

    return { statusCode: 200, headers, body: JSON.stringify({ fields: populated, name }) }
  } catch (err) {
    console.error('Autofill error:', err)
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'An internal error occurred' || 'Autofill failed' }) }
  }
}
