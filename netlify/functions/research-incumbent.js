// Netlify Function: research-incumbent
// Reads a candidate's latest dossier and asks Claude to extract bills, votes,
// acts, regulations, and legal events for auto-populating the Incumbent Record.

import { enforceRateLimit } from './_rate-limit.js'
import { logAiUsage } from './_ai-usage.js'

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
  const limited = await enforceRateLimit(uid, 'research-incumbent', headers)
  if (limited) return limited

  // ── Parse body ──────────────────────────────────────────────────────────────
  let body
  try { body = JSON.parse(event.body || '{}') } catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) } }
  const { candidate_id, candidate_name } = body
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  if (!candidate_id || !UUID.test(candidate_id)) return { statusCode: 400, headers, body: JSON.stringify({ error: 'valid candidate_id required' }) }

  // ── Fetch latest dossier — scoped to a candidate the CALLER owns (IDOR guard) ─
  const dossierRes = await fetch(
    `${SUPABASE_URL}/rest/v1/dossiers?candidate_id=eq.${encodeURIComponent(candidate_id)}&select=*,candidate:candidates!inner(created_by)&candidate.created_by=eq.${encodeURIComponent(uid)}&order=generated_at.desc&limit=1`,
    { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` } }
  )
  const dossiers = await dossierRes.json()
  if (!Array.isArray(dossiers) || dossiers.length === 0) {
    return { statusCode: 404, headers, body: JSON.stringify({ error: 'No profile found. Generate a profile first.' }) }
  }
  const dossier = dossiers[0]
  const content = dossier.content || ''
  if (!content || content.length < 100) {
    return { statusCode: 422, headers, body: JSON.stringify({ error: 'Profile content is too short to extract records from.' }) }
  }

  // ── Call Claude to extract incumbent records ────────────────────────────────
  if (!ANTHROPIC_API_KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured' }) }

  const extractPrompt = `You are a political opposition research analyst. Read the following AI-generated political dossier for ${candidate_name || 'a Wisconsin candidate'} and extract ALL items that belong in an Incumbent Record — this is a comprehensive log of official actions, votes, legal events, ethics issues, and controversies tied to this person's time in office.

EXTRACT ALL OF THE FOLLOWING (be thorough — do not skip anything):
1. Official votes (yes/no/abstain) on resolutions, ordinances, referendums, budgets
2. Bills, acts, resolutions, or ordinances sponsored, passed, or blocked
3. Vetoes or reversals of official decisions
4. Legal proceedings: lawsuits filed against the official, court cases, judgments
5. Ethics board complaints, investigations, findings, violations, or rulings
6. Regulatory actions, violations, fines, or penalties
7. Official proclamations, special recognitions, or declarations
8. Removals from office, censures, reprimands, or formal disciplinary actions
9. Any other notable official action in an official capacity

For each item found, output a JSON object in this EXACT schema (use only the allowed values):
{
  "record_type": "bill" | "act" | "regulation" | "law" | "legal" | "vote" | "other",
  "title": "Short descriptive title (max 80 chars)",
  "description": "2-3 sentence summary including what happened, why it matters, and outcome",
  "bill_number": "Bill/case/ordinance number if known, otherwise null",
  "vote_result": "yes" | "no" | "abstain" | "absent" | "not_applicable",
  "date": "YYYY-MM-DD if known, otherwise null",
  "significance": "major" | "notable" | "minor",
  "source": "Where this came from (outlet name, case record, ethics board, etc.)",
  "notes": "Any flags, caveats, unresolved issues, or follow-up needed"
}

RULES:
- Use "legal" record_type for ethics violations, lawsuits, investigations, court cases, or disciplinary actions.
- Use "vote" record_type for council/assembly/board votes.
- Use "other" for proclamations, removals, recognitions, or anything that doesn't fit elsewhere.
- vote_result must be exactly: "yes", "no", "abstain", "absent", or "not_applicable".
- significance must be exactly: "major", "notable", or "minor". Use "major" for ethics violations, lawsuits, and highly controversial actions.
- Use null (not empty string) for date and bill_number when unknown.
- Do NOT include general policy positions, biographical background, or campaign promises.
- Do NOT include items labeled [RESEARCH REQUIRED] unless they have enough factual detail to be useful.
- Return ONLY a valid JSON array. No markdown fences, no explanation, just the array.
- If no qualifying records are found, return: []

DOSSIER CONTENT:
---
${content.slice(0, 14000)}
---

Return ONLY the JSON array:`

  const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 3000,
      messages: [{ role: 'user', content: extractPrompt }],
    }),
  })

  if (!claudeRes.ok) {
    const err = await claudeRes.text()
    return { statusCode: 502, headers, body: JSON.stringify({ error: `Claude API error: ${err}` }) }
  }

  const claudeData = await claudeRes.json()
  logAiUsage({ userId: uid, endpoint: 'district-intel', provider: 'anthropic', model: 'claude-opus-4-8', inputTokens: claudeData?.usage?.input_tokens || 0, outputTokens: claudeData?.usage?.output_tokens || 0 })
  const rawText = claudeData.content?.[0]?.text?.trim() || '[]'

  let records = []
  try {
    // Strip any accidental markdown code fences
    const cleaned = rawText.replace(/^```(?:json)?\n?/i, '').replace(/\n?```\s*$/i, '').trim()
    records = JSON.parse(cleaned)
    if (!Array.isArray(records)) records = []
  } catch {
    return { statusCode: 200, headers, body: JSON.stringify({ records: [], warning: 'Could not parse AI response as JSON.' }) }
  }

  // ─── #5: Fetch existing records to deduplicate ────────────────────────────
  let existingRecords = []
  try {
    const existRes = await fetch(
      `${SUPABASE_URL}/rest/v1/incumbent_records?candidate_id=eq.${encodeURIComponent(candidate_id)}&select=title,bill_number,date`,
      { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` } }
    )
    if (existRes.ok) existingRecords = await existRes.json()
  } catch (e) { console.error('[research-incumbent] Could not fetch existing records for dedup:', e.message) }

  function titleSimilar(a, b) {
    const norm = s => s.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim()
    const na = norm(a), nb = norm(b)
    if (na === nb) return true
    // Check if one contains the other (truncated titles)
    if (na.length > 10 && nb.length > 10) {
      const shorter = na.length < nb.length ? na : nb
      const longer  = na.length < nb.length ? nb : na
      if (longer.includes(shorter)) return true
    }
    // Word overlap > 70%
    const wa = new Set(na.split(' ')), wb = new Set(nb.split(' '))
    const overlap = Array.from(wb).filter(w => w.length > 3 && wa.has(w)).length
    return overlap / Math.max(wa.size, wb.size) > 0.7
  }

  // Sanitize and normalize records to match DB enum values exactly
  const VALID_TYPES        = ['bill','act','regulation','law','legal','vote','other']
  const VALID_VOTE_RESULTS = ['yes','no','abstain','absent','not_applicable']
  const VALID_SIGNIFICANCE = ['major','notable','minor']

  records = records.map(r => ({
    candidate_id,
    record_type:  VALID_TYPES.includes(r.record_type)        ? r.record_type        : 'other',
    title:        (r.title || '').slice(0, 200),
    description:  r.description  || '',
    bill_number:  r.bill_number  || null,
    vote_result:  VALID_VOTE_RESULTS.includes(r.vote_result) ? r.vote_result         : 'not_applicable',
    // Map "critical" (old prompt value) → "major"; reject anything else → "notable"
    significance: VALID_SIGNIFICANCE.includes(r.significance)
      ? r.significance
      : r.significance === 'critical' ? 'major' : 'notable',
    // Reject empty string dates — Postgres date column requires NULL not ""
    date:         (r.date && /^\d{4}-\d{2}-\d{2}$/.test(r.date)) ? r.date : null,
    source:       r.source || null,
    notes:        r.notes  || null,
    url:          r.url    || null,
  }))

  // ─── Filter out duplicates of existing records ────────────────────────────
  const dedupedRecords = records.filter(r => {
    return !existingRecords.some(existing => {
      // Match by bill number if both have one
      if (r.bill_number && existing.bill_number &&
          r.bill_number.replace(/\s/g,'').toLowerCase() === existing.bill_number.replace(/\s/g,'').toLowerCase()) return true
      // Match by title similarity
      return titleSimilar(r.title || '', existing.title || '')
    })
  })

  const duplicatesRemoved = records.length - dedupedRecords.length
  if (duplicatesRemoved > 0) console.log(`[research-incumbent] Removed ${duplicatesRemoved} duplicate(s)`)

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ records: dedupedRecords, dossier_title: dossier.title || 'Profile', duplicates_removed: duplicatesRemoved }),
  }
}
