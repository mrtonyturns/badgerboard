/**
 * classify-csv-prospects.js
 * Accepts an array of CSV row objects and uses Claude Haiku to classify each
 * person as likely "conservative", "liberal", or "unknown".
 * Confidence threshold: 70% — below that, returns "unknown".
 *
 * POST body: { prospects: Array<{ name, email?, city?, state?, zip?, [any] }> }
 * Returns:   { results: Array<{ ...original, lean, confidence, reasoning }> }
 */

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY
const SUPABASE_URL      = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const SUPABASE_ANON     = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY
const MODEL             = 'claude-haiku-4-5-20251001'

// Tier gating — CSV prospect classification is part of Prospecting, an
// Action-plan entitlement (tiers.js features.prospecting — single source of truth).
const { PLAN_CONFIG } = require('../../src/lib/tiers.js')
const { ADMIN_EMAILS } = require('./_config')
const PROSPECTING_PLANS = Object.keys(PLAN_CONFIG).filter(k => PLAN_CONFIG[k]?.features?.prospecting)

const HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
}

// ── Auth ──────────────────────────────────────────────────────────────────────
async function verifyUser(authHeader) {
  if (!authHeader?.startsWith('Bearer ')) return null
  const token = authHeader.slice(7)
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${token}` },
  })
  if (!res.ok) return null
  const user = await res.json()
  return user?.id ? user : null
}

// ── Sanitize a single field ───────────────────────────────────────────────────
function safe(val, maxLen = 120) {
  if (val === null || val === undefined) return ''
  return String(val).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').slice(0, maxLen).trim()
}

// ── Build a compact text description of one prospect ─────────────────────────
function describeProspect(row) {
  const parts = []
  // Try common column names for name
  const name = safe(row.name || row.Name || row.full_name || row['Full Name'] || row.first_name || '')
  const last  = safe(row.last_name || row['Last Name'] || '')
  const first = safe(row.first_name || row['First Name'] || '')
  const displayName = name || [first, last].filter(Boolean).join(' ') || 'Unknown'

  parts.push(`Name: ${displayName}`)

  const city    = safe(row.city    || row.City    || row['City/Town'] || '')
  const state   = safe(row.state   || row.State   || row.ST          || '')
  const zip     = safe(row.zip     || row.Zip     || row.postal_code || row['Zip Code'] || '')
  const county  = safe(row.county  || row.County  || '')
  const employer= safe(row.employer|| row.Employer|| row.company     || row.Company     || '')
  const title   = safe(row.title   || row.Title   || row.occupation  || row.Occupation  || '')
  const org     = safe(row.organization || row.Organization || row.org || '')
  const notes   = safe(row.notes   || row.Notes   || row.bio         || row.Bio         || '')
  const party   = safe(row.party   || row.Party   || row['Party Affiliation'] || '')

  if (city || state)  parts.push(`Location: ${[city, state, zip].filter(Boolean).join(', ')}`)
  if (county)         parts.push(`County: ${county}`)
  if (employer)       parts.push(`Employer: ${employer}`)
  if (title)          parts.push(`Title/Role: ${title}`)
  if (org)            parts.push(`Organization: ${org}`)
  if (party)          parts.push(`Party Affiliation: ${party}`)
  if (notes)          parts.push(`Notes: ${notes}`)

  return { displayName, description: parts.join(' | ') }
}

// ── Classify a batch of prospects via Haiku ───────────────────────────────────
async function classifyBatch(prospects) {
  const items = prospects.map((p, i) => {
    const { displayName, description } = describeProspect(p)
    return `[${i}] ${description}`
  })

  const systemPrompt = `You are a political data analyst specializing in Wisconsin voter and donor classification.
Your task is to assess whether each person in a list is likely politically conservative, liberal, or unknown.

Classification rules:
- "conservative": 70%+ confidence they lean right (Republican-leaning, conservative values, right-of-center)
- "liberal": 70%+ confidence they lean left (Democrat-leaning, progressive values, left-of-center)
- "unknown": insufficient data, ambiguous signals, or confidence below 70%

Base your assessment on: location (county/city — Wisconsin political geography matters), employer/organization, job title, party affiliation if stated, and any other contextual signals.
Be conservative (cautious) with your confidence — only go above 70% when signals are reasonably clear.
Nonpartisan roles (teachers, nurses, clergy, etc.) should generally be "unknown" unless other signals exist.

Output ONLY a valid JSON array. Each element must have:
{ "index": number, "lean": "conservative"|"liberal"|"unknown", "confidence": 0-100, "reasoning": "1 short sentence" }

No markdown, no explanation outside the JSON array.`

  const userPrompt = `Classify each person below:\n\n${items.join('\n')}\n\nReturn a JSON array with ${prospects.length} elements, one per person in order.`

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key':         ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type':      'application/json',
    },
    body: JSON.stringify({
      model:      MODEL,
      max_tokens: 2000,
      system:     systemPrompt,
      messages:   [{ role: 'user', content: userPrompt }],
    }),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Anthropic API error: ${res.status} — ${err}`)
  }

  const data = await res.json()
  const raw  = data.content?.[0]?.text?.trim() || '[]'

  // Strip any accidental markdown fences
  const cleaned = raw.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim()

  let parsed
  try {
    parsed = JSON.parse(cleaned)
  } catch {
    throw new Error('Haiku returned invalid JSON: ' + raw.slice(0, 200))
  }

  return parsed
}

// ── Handler ───────────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: HEADERS, body: '' }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) }
  }

  if (!ANTHROPIC_API_KEY) {
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured' }) }
  }

  // Auth
  const authHeader = event.headers?.authorization || event.headers?.Authorization
  const user = await verifyUser(authHeader)
  if (!user) {
    return { statusCode: 401, headers: HEADERS, body: JSON.stringify({ error: 'Unauthorized' }) }
  }

  // Tier gate — prospecting classification requires an Action plan (matches the
  // tiers.js 'prospecting' entitlement and the Prospecting page UI gate)
  const plan = ADMIN_EMAILS.includes((user.email || '').toLowerCase())
    ? 'a_campaign'
    : (user.app_metadata?.plan || 'scout').toLowerCase()
  if (!PROSPECTING_PLANS.includes(plan)) {
    return { statusCode: 403, headers: HEADERS, body: JSON.stringify({ error: 'Action plan required for AI prospect classification.' }) }
  }

  let body
  try { body = JSON.parse(event.body || '{}') } catch {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) }
  }

  const { prospects } = body
  if (!Array.isArray(prospects) || prospects.length === 0) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'prospects array is required' }) }
  }
  if (prospects.length > 500) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Maximum 500 prospects per request' }) }
  }

  // Process in batches of 20 to stay within token limits
  const BATCH_SIZE = 20
  const allResults = []

  for (let i = 0; i < prospects.length; i += BATCH_SIZE) {
    const batch      = prospects.slice(i, i + BATCH_SIZE)
    const batchStart = i

    try {
      const classifications = await classifyBatch(batch)

      // Merge classifications back into original rows
      batch.forEach((prospect, j) => {
        const cls = classifications.find(c => c.index === j) || { lean: 'unknown', confidence: 0, reasoning: 'Classification unavailable' }
        const { displayName } = describeProspect(prospect)

        // Extract email robustly
        const email = safe(
          prospect.email || prospect.Email || prospect['E-mail'] ||
          prospect['Email Address'] || prospect['email_address'] || ''
        )
        const phone = safe(
          prospect.phone || prospect.Phone || prospect['Phone Number'] ||
          prospect['Cell Phone'] || prospect.cell || ''
        )

        allResults.push({
          // Preserved original fields
          ...prospect,
          // Normalized display fields
          name:       displayName,
          email:      email || undefined,
          phone:      phone || undefined,
          // AI classification
          lean:       cls.lean       || 'unknown',
          confidence: cls.confidence || 0,
          reasoning:  cls.reasoning  || '',
        })
      })
    } catch (err) {
      // On batch error, mark the whole batch as unknown rather than failing the whole request
      console.error(`[classify-csv-prospects] Batch ${batchStart}-${batchStart + batch.length} error:`, err.message)
      batch.forEach((prospect) => {
        const { displayName } = describeProspect(prospect)
        allResults.push({
          ...prospect,
          name:       displayName,
          lean:       'unknown',
          confidence: 0,
          reasoning:  'Classification error — please retry',
        })
      })
    }
  }

  return {
    statusCode: 200,
    headers: HEADERS,
    body: JSON.stringify({ results: allResults }),
  }
}
