// Netlify Function: research-swot
// Builds the candidate profile page's SWOT from the candidate's latest profile.
//
// v2 (Nov 2026). The first version asked Haiku for "3-6 bullet points" per
// quadrant over the first 12,000 characters of the profile — about the first
// four sections, so it never saw controversies, the SWOT the profile itself
// wrote, or the attack & defense tables — and got back generic lines with no
// sourcing, no order and nothing to do with them. Now:
//
//   • Sonnet 5.5 (MODELS.CLAUDE_BALANCED) reads the whole profile (up to
//     PROFILE_CHARS) plus the race it is in (office, election, party, status,
//     incumbency).
//   • Every point is specific and cites what it rests on: `evidence` (the fact
//     from the profile) and `source` (the URL or named record the profile
//     gives, never invented).
//   • Points are ranked by `impact` in THIS race (5 = could decide it).
//   • Every point carries a `play`. The perspective decides what that means:
//       opponent → weaknesses/threats: how to use it; strengths/opportunities:
//                  how to blunt it.
//       self     → weaknesses/threats: how to defend it; strengths/
//                  opportunities: how to press it.
//     The page sends `perspective` ('self' when this is the user's own
//     candidate — resolveSelfCandidate in pages/dashboard/CandidateDashboard).
//
// POST { candidate_id, perspective?: 'self'|'opponent' }
// → { swot: { v: 2, perspective, generated_at, dossier_id, bottom_line,
//             strengths|weaknesses|opportunities|threats: [{ point, evidence, source, impact, play }] } }

const { enforceRateLimit } = require('./_rate-limit')
const { logAiUsage } = require('./_ai-usage')
const { MODELS, CLAUDE, claudeText, claudeFetch } = require('./_models')

const PROFILE_CHARS = 60000
const MODEL_TIMEOUT_MS = 50000          // netlify.toml gives the function 60s
const MAX_POINTS = 5
const QUADRANTS = ['strengths', 'weaknesses', 'opportunities', 'threats']
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
}
const json = (statusCode, body) => ({ statusCode, headers: HEADERS, body: JSON.stringify(body) })

/** The race this candidate is in, as one line for the prompt. */
function raceLine(c) {
  if (!c) return 'Race not on file.'
  const office = c.office ? [c.office.name, c.office.district_name].filter(Boolean).join(', ') : 'office not on file'
  const election = c.election ? `${c.election.name}${c.election.election_date ? ` (${c.election.election_date})` : ''}` : 'election not on file'
  return `${c.name || 'Candidate'} — ${c.party || 'party not on file'} — running for ${office} — ${election} — status: ${c.status || 'unknown'}${c.is_incumbent ? ' — INCUMBENT' : ''}.`
}

const PLAY_RULES = {
  opponent: `This candidate is an OPPONENT of the user. "play" tells the user's campaign what to do with the point:
- weaknesses and threats: HOW TO USE IT — the attack line, the audience, the channel (mail, digital, earned media, debate) and the moment.
- strengths and opportunities: HOW TO BLUNT IT — how to neutralise or reframe it.`,
  self: `This is the USER'S OWN candidate. "play" tells the campaign what to do with the point:
- weaknesses and threats: HOW TO DEFEND IT — the inoculation or response line, who delivers it, and what proof to have ready.
- strengths and opportunities: HOW TO PRESS IT — where and how to put it in front of voters.`,
}

/** The model prompt. Exported for tests. */
function buildSwotPrompt({ candidate, content, perspective }) {
  const persp = perspective === 'self' ? 'self' : 'opponent'
  const profile = String(content || '').slice(0, PROFILE_CHARS)
  return `You are a senior Wisconsin campaign strategist. Build a sharp, usable SWOT for the candidate below from their research profile.

RACE: ${raceLine(candidate)}

${PLAY_RULES[persp]}

RULES
1. Specific, not generic. Every point names the actual fact — the vote, the filing, the dollar figure, the quote, the organisation, the date. "Strong fundraiser" is not a point; "Raised $84,000 by July 2026, 3x the challenger (CFIS)" is.
2. Evidence-backed. "evidence" is the fact from the profile the point rests on (one sentence). "source" is the URL or the named record the profile gives for it (e.g. "cfis.wi.gov", "Daily Union, Jul 16 2024"). If the profile gives no source, write "profile" — never invent a URL, date, number or quote.
3. Ranked by how much it matters in THIS race. "impact" is 1-5: 5 = could decide the race, 3 = worth a line in the plan, 1 = minor. Order each list strongest first.
4. Up to ${MAX_POINTS} points per quadrant; fewer is fine. Leave a quadrant empty rather than pad it. Weaknesses and threats may come from Sections 4-6, 10, 12 and 13; use the profile's own SWOT and attack & defense tables as inputs, not as text to copy.
5. "play" is one or two concrete sentences, written to be acted on this week.
6. Treat claims the profile badges [Verify] or [RESEARCH REQUIRED] as unconfirmed: you may use them, but say "unconfirmed" in the evidence.
7. "bottom_line": one sentence — the single most important thing about this candidate in this race.

Return ONLY a JSON object, no prose and no code fence:
{"bottom_line": "…", "strengths": [{"point": "…", "evidence": "…", "source": "…", "impact": 1-5, "play": "…"}], "weaknesses": [...], "opportunities": [...], "threats": [...]}

PROFILE:
${profile}`
}

function parseJsonObject(text) {
  const s = String(text || '').replace(/```(?:json)?/gi, '')
  const a = s.indexOf('{')
  const b = s.lastIndexOf('}')
  if (a < 0 || b <= a) return null
  try { return JSON.parse(s.slice(a, b + 1)) } catch { return null }
}

const str = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max)

/** Model JSON → the stored v2 SWOT (clamped, ranked, capped). */
function normalizeSwotV2(raw, { perspective, dossierId = null, now = new Date() } = {}) {
  const out = {
    v: 2,
    perspective: perspective === 'self' ? 'self' : 'opponent',
    generated_at: now.toISOString(),
    dossier_id: dossierId,
    bottom_line: str(raw?.bottom_line, 300),
  }
  for (const k of QUADRANTS) {
    const list = Array.isArray(raw?.[k]) ? raw[k] : []
    out[k] = list
      .map((x, i) => {
        if (typeof x === 'string') x = { point: x }
        if (!x || typeof x !== 'object') return null
        const point = str(x.point, 280)
        if (!point) return null
        const imp = Math.round(Number(x.impact))
        return {
          point,
          evidence: str(x.evidence, 400),
          source: str(x.source, 200),
          impact: Number.isFinite(imp) ? Math.min(5, Math.max(1, imp)) : 2,
          play: str(x.play, 400),
          _i: i,
        }
      })
      .filter(Boolean)
      .sort((a, b) => (b.impact - a.impact) || (a._i - b._i))
      .slice(0, MAX_POINTS)
      .map(({ _i, ...x }) => x)
  }
  return out
}

const hasPoints = (swot) => QUADRANTS.some(k => swot[k].length > 0)

async function handler(event, { fetchImpl = fetch, claude = claudeFetch } = {}) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: HEADERS, body: '' }
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' })

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY
  const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

  // ── Verify JWT ──────────────────────────────────────────────────────────────
  const authHeader = event.headers?.authorization || event.headers?.Authorization
  if (!authHeader?.startsWith('Bearer ')) return json(401, { error: 'Not authenticated' })
  const authRes = await fetchImpl(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: authHeader },
  })
  if (!authRes.ok) return json(401, { error: 'Invalid token' })
  const uid = (await authRes.json())?.id
  if (!uid) return json(401, { error: 'Invalid token' })

  const limited = await enforceRateLimit(uid, 'research-swot', HEADERS)
  if (limited) return limited

  let body
  try { body = JSON.parse(event.body || '{}') } catch { return json(400, { error: 'Invalid JSON' }) }
  const { candidate_id } = body
  const perspective = body.perspective === 'self' ? 'self' : 'opponent'
  if (!candidate_id || !UUID.test(candidate_id)) return json(400, { error: 'valid candidate_id required' })

  // ── Latest profile — scoped to a candidate the CALLER owns (IDOR guard) ──────
  const sel = 'id,content,candidate:candidates!inner(created_by,name,party,status,is_incumbent,office:offices(name,district_name),election:elections(name,election_date))'
  const dossierRes = await fetchImpl(
    `${SUPABASE_URL}/rest/v1/dossiers?candidate_id=eq.${encodeURIComponent(candidate_id)}&select=${encodeURIComponent(sel)}&candidate.created_by=eq.${encodeURIComponent(uid)}&order=generated_at.desc&limit=1`,
    { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` } },
  )
  if (!dossierRes.ok) return json(500, { error: 'Failed to fetch profile' })
  const dossiers = await dossierRes.json()
  if (!Array.isArray(dossiers) || !dossiers.length || !dossiers[0].content) {
    return json(404, { error: 'No profile found for this candidate. Generate one first.' })
  }
  const dossier = dossiers[0]

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), MODEL_TIMEOUT_MS)
  try {
    const aiRes = await claude({
      apiKey: ANTHROPIC_API_KEY,
      signal: ctrl.signal,
      body: {
        model: MODELS.CLAUDE_BALANCED,
        ...CLAUDE.BALANCED,
        max_tokens: 4096,
        messages: [{ role: 'user', content: buildSwotPrompt({ candidate: dossier.candidate, content: dossier.content, perspective }) }],
      },
    })
    if (!aiRes.ok) {
      const err = await aiRes.text().catch(() => '')
      console.error(`[research-swot] model ${aiRes.status}: ${err.slice(0, 300)}`)
      return json(502, { error: 'The SWOT model is unavailable right now. Try again in a minute.' })
    }
    const data = await aiRes.json()
    logAiUsage({ userId: uid, endpoint: 'campaign-intel', provider: 'anthropic', model: MODELS.CLAUDE_BALANCED, inputTokens: data?.usage?.input_tokens || 0, outputTokens: data?.usage?.output_tokens || 0 })
    const parsed = parseJsonObject(claudeText(data))
    if (!parsed) return json(502, { error: 'The SWOT came back in a shape we could not read. Try again.' })
    const swot = normalizeSwotV2(parsed, { perspective, dossierId: dossier.id })
    if (!hasPoints(swot)) return json(422, { error: 'The profile did not have enough material for a SWOT. Regenerate the profile and try again.' })
    return json(200, { swot })
  } catch (err) {
    console.error('[research-swot] error:', err.message)
    if (err.name === 'AbortError') return json(504, { error: 'The SWOT took too long. Try again in a minute.' })
    return json(500, { error: 'An internal error occurred' })
  } finally {
    clearTimeout(timer)
  }
}

module.exports = {
  handler: (event) => handler(event),
  _handler: handler,
  buildSwotPrompt, normalizeSwotV2, parseJsonObject, raceLine,
  PROFILE_CHARS, MODEL_TIMEOUT_MS, MAX_POINTS,
}
