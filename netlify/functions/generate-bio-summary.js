/**
 * generate-bio-summary.js
 * Uses Claude Haiku to distill a dossier's Biography & Background section
 * into a clean, readable plain-English candidate summary.
 *
 * POST body: { dossier_id: string }
 * Returns:   { summary: string }
 */

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY
const SUPABASE_URL      = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const SUPABASE_ANON     = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY
const SERVICE_KEY       = process.env.SUPABASE_SERVICE_ROLE_KEY
const MODEL             = 'claude-haiku-4-5-20251001'

const HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
}

// ── Verify caller JWT ─────────────────────────────────────────────────────────
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

// ── Fetch dossier content via service role (user already verified above) ──────
async function fetchDossierContent(dossierId, userId) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/dossiers?id=eq.${dossierId}&select=content,generated_by`,
    {
      headers: {
        apikey:        SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        Accept:        'application/json',
      },
    }
  )
  if (!res.ok) return null
  const rows = await res.json()
  if (!rows || rows.length === 0) return null
  const dossier = rows[0]
  // Belt-and-suspenders: ensure the requesting user owns this dossier
  if (dossier.generated_by && dossier.generated_by !== userId) return null
  return dossier.content
}

// ── Extract a numbered section from dossier content ──────────────────────────
function extractSection(content, sectionNum) {
  if (!content) return null
  // Match from "## SECTION N" up to (but not including) the next "## SECTION"
  const re = new RegExp(
    `(## SECTION ${sectionNum}[^\\n]*[\\s\\S]*?)(?=## SECTION \\d|$)`,
    'i'
  )
  const m = content.match(re)
  return m ? m[1].trim() : null
}

// ── Extract biography-relevant sections (2=Bio, 3=Timeline, 4=Political Record)
function extractBioContent(content) {
  if (!content) return null

  const sec2 = extractSection(content, 2) // BIOGRAPHY & BACKGROUND
  const sec3 = extractSection(content, 3) // TIMELINE
  const sec4 = extractSection(content, 4) // POLITICAL RECORD

  // Fallback: look for the BIOGRAPHY & BACKGROUND header directly
  if (!sec2) {
    const fallback = content.match(/#{1,3}\s*(?:SECTION\s*\d+[:\s]+)?BIOGRAPHY\s*&?\s*BACKGROUND[\s\S]*?(?=#{1,3}\s*(?:SECTION\s*\d)|$)/i)
    if (fallback) return fallback[0]
  }

  return [sec2, sec3, sec4].filter(Boolean).join('\n\n') || null
}

// ── Strip research scaffolding before sending to Haiku ────────────────────────
function cleanForHaiku(rawSection) {
  if (!rawSection) return ''
  return rawSection
    // Remove section heading
    .replace(/^## SECTION \d+[^\n]*/im, '')
    // Remove Section Confidence lines
    .replace(/^>\s*\*\*Section Confidence[^\n]*/gm, '')
    // Remove IDENTITY LOCK blocks
    .replace(/^\*\*IDENTITY LOCK:\*\*[^\n]*/gm, '')
    // Remove table separator rows
    .replace(/^\|[-| ]+\|$/gm, '')
    // Remove markdown table header/separator/row lines that are purely "NOT FOUND"
    .replace(/^\|[^|]+\|\s*(NOT FOUND|\*\*NOT FOUND\*\*|\*\*UNCONFIRMED\*\*)\s*\|[^\n]*$/gm, '')
    // Collapse multiple blank lines
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// ── Call Claude Haiku ─────────────────────────────────────────────────────────
async function generateSummary(bioContent, candidateName) {
  const cleaned = cleanForHaiku(bioContent)

  const systemPrompt = `You are a political intelligence analyst writing concise candidate briefings.
Your job is to turn structured research notes into a clean, readable narrative biography.
Write in professional third-person prose. Be factual and neutral — no spin, no editorializing.
Output ONLY the biography text — no titles, no headers, no markdown formatting of any kind (no #, ##, **, *, etc.).
Do NOT include markdown tables, "NOT FOUND" entries, confidence levels, or research methodology notes.
Do NOT start your response with a title or heading like "Political Intelligence Briefing" or the candidate's name.
If very little is publicly known about the candidate, briefly state that their background is not yet well documented.`

  const userPrompt = `Write a 2–3 paragraph plain-English biography of ${candidateName || 'this candidate'} based on the research notes below.
Cover whatever is actually known: personal background, professional experience, political history, and key policy positions.
Omit anything listed as NOT FOUND, UNCONFIRMED, or marked as requiring further research.
If little is confirmed, be honest about that briefly — do not pad or speculate.

RESEARCH NOTES (Biography, Timeline, Political Record):
${cleaned || 'No biographical data found in dossier.'}`

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key':         ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type':      'application/json',
    },
    body: JSON.stringify({
      model:      MODEL,
      max_tokens: 600,
      system:     systemPrompt,
      messages:   [{ role: 'user', content: userPrompt }],
    }),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Anthropic API error: ${res.status} — ${err}`)
  }

  const data = await res.json()
  return data.content?.[0]?.text?.trim() || ''
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
  if (!SUPABASE_ANON) {
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: 'SUPABASE_ANON_KEY not configured' }) }
  }

  // Auth
  const authHeader = event.headers?.authorization || event.headers?.Authorization
  const user = await verifyUser(authHeader)
  if (!user) {
    return { statusCode: 401, headers: HEADERS, body: JSON.stringify({ error: 'Unauthorized' }) }
  }

  let body
  try { body = JSON.parse(event.body || '{}') } catch {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) }
  }

  const { dossier_id, candidate_name } = body
  if (!dossier_id) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'dossier_id is required' }) }
  }

  try {
    const content = await fetchDossierContent(dossier_id, user.id)
    if (!content) {
      return { statusCode: 404, headers: HEADERS, body: JSON.stringify({ error: 'Profile not found or not accessible' }) }
    }

    const bioContent = extractBioContent(content)
    let summary = await generateSummary(bioContent, candidate_name)

    if (!summary) {
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ summary: null, reason: 'no_content' }) }
    }

    // Server-side header stripping — remove any leading markdown headings or
    // title-like lines (e.g. "# Political Intelligence Briefing: John Kroll")
    // that the model sometimes outputs despite instructions.
    summary = summary
      .replace(/^(#{1,6}[^\n]*\n+)+/m, '')          // strip leading ## heading lines
      .replace(/^Political Intelligence Briefing[^\n]*\n*/im, '') // strip plain title line
      .replace(/^[A-Z][^\n]{0,60}Candidate[^\n]*\n*/m, '')       // strip "... Candidate" subtitle
      .replace(/^[A-Z][^\n]{0,60}Briefing[^\n]*\n*/m, '')        // strip "... Briefing" subtitle
      .trim()

    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ summary: summary || null }) }
  } catch (err) {
    console.error('[generate-bio-summary] Error:', err)
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: err.message }) }
  }
}
