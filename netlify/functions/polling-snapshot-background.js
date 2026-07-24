// Netlify BACKGROUND Function: polling-snapshot-background (v1.22, BETA-ONLY)
// The AI polling pipeline. Internal-trigger auth only (fired by
// polling-snapshot or the weekly refresh cron — never directly by clients).
//
//   1. Perplexity Sonar Pro — source-cited district signal: local news,
//      existing public polling, past results, demographics. Citations →
//      sources[]. (Gemini w/ Google-Search grounding is the drop-in fallback
//      when GEMINI_API_KEY is set and Perplexity fails.)
//   2. Grok (xAI) — live X/social conversation, informs Top Issues ONLY
//      (secondary signal; X skews demographically).
//   3. Claude — synthesizes everything into the strict snapshot JSON,
//      validated server-side; one retry on malformed output.
//
// Providers are swappable via env: POLLING_RESEARCH_MODEL (default sonar-pro),
// POLLING_SOCIAL_MODEL (default grok-4.3), POLLING_SYNTH_MODEL (default
// claude-opus-4-8). All keys server-side only.

import crypto from 'crypto'
import { logAiUsage } from './_ai-usage.js'

const SUPABASE_URL   = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const SERVICE_KEY    = process.env.SUPABASE_SERVICE_ROLE_KEY
const PPLX_KEY       = process.env.PERPLEXITY_API_KEY
const XAI_KEY        = process.env.XAI_API_KEY
const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY
const GEMINI_KEY     = process.env.GEMINI_API_KEY

const RESEARCH_MODEL = process.env.POLLING_RESEARCH_MODEL || 'sonar-pro'
const SOCIAL_MODEL   = process.env.POLLING_SOCIAL_MODEL   || 'grok-4.3'
const SYNTH_MODEL    = process.env.POLLING_SYNTH_MODEL    || 'claude-opus-4-8'

function safeEqual(a, b) {
  const A = crypto.createHash('sha256').update(String(a ?? '')).digest()
  const B = crypto.createHash('sha256').update(String(b ?? '')).digest()
  return crypto.timingSafeEqual(A, B)
}

const sb = (path, opts = {}) => fetch(`${SUPABASE_URL}/rest/v1${path}`, {
  ...opts,
  headers: {
    apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`,
    'Content-Type': 'application/json', ...(opts.headers || {}),
  },
})

function districtLabel(key) {
  const m = key.match(/^(congress|senate|assembly)-(\d+)$/)
  if (!m) return key === 'state-wi' ? 'Wisconsin (statewide)' : key
  const names = { congress: 'Congressional District', senate: 'State Senate District', assembly: 'Assembly District' }
  return `${names[m[1]]} ${m[2]}`
}

function officeLabel(key) {
  const m = key.match(/^(congress|senate|assembly)-(\d+)$/)
  if (!m) return 'U.S. Senator for Wisconsin / Governor of Wisconsin'
  return { congress: 'U.S. Representative', senate: 'State Senator', assembly: 'State Representative' }[m[1]]
}

// ── Step 1a: Perplexity research (primary grounding) ─────────────────────────
async function perplexityResearch(district, requestedBy) {
  if (!PPLX_KEY) return null
  const label = districtLabel(district)
  const ctrl = new AbortController()
  setTimeout(() => ctrl.abort(), 60000)
  const res = await fetch('https://api.perplexity.ai/chat/completions', {
    method: 'POST', signal: ctrl.signal,
    headers: { Authorization: `Bearer ${PPLX_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: RESEARCH_MODEL,
      messages: [
        { role: 'system', content: 'You are a Wisconsin political researcher. Report only sourced, current facts. Name the outlet/source for every claim. Never fabricate polls or results.' },
        { role: 'user', content: `Build a current opinion-signal brief for ${label}, Wisconsin (office: ${officeLabel(district)}). Report, with sources and dates:
1. CURRENT OFFICEHOLDER(S) and any declared 2026 challengers for this seat (names + parties).
2. EXISTING PUBLIC POLLING that covers this district or Wisconsin statewide (pollster, date, numbers) — approval and head-to-head if available.
3. PAST ELECTION RESULTS for this seat (last 2-3 cycles, vote percentages).
4. LOCAL ISSUES dominating recent local news coverage in this area (schools, taxes, roads, healthcare, agriculture, housing, public safety, etc.) — which get the most coverage and community reaction.
5. DISTRICT DEMOGRAPHICS relevant to opinion (urban/rural mix, income, age, education).
6. Any recent events likely moving opinion (plant closures, controversies, disasters, big announcements).
List the URL for every source you used.` }
      ],
      max_tokens: 3000,
    }),
  })
  if (!res.ok) throw new Error(`Perplexity ${res.status}`)
  const d = await res.json()
  logAiUsage({ userId: requestedBy, endpoint: 'polling', provider: 'perplexity', model: RESEARCH_MODEL, inputTokens: d?.usage?.prompt_tokens || 0, outputTokens: d?.usage?.completion_tokens || 0 })
  return { text: d.choices?.[0]?.message?.content || null, citations: d.citations || d.search_results || [] }
}

// ── Step 1b: Gemini fallback (Google Search grounding) ───────────────────────
async function geminiResearch(district, requestedBy) {
  if (!GEMINI_KEY) return null
  const label = districtLabel(district)
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: `Research current political opinion signal for ${label}, Wisconsin: current officeholder + challengers, any public polling, past election results, dominant local issues in news coverage, district demographics, recent opinion-moving events. Cite sources with URLs.` }] }],
      tools: [{ google_search: {} }],
    }),
  })
  if (!res.ok) throw new Error(`Gemini ${res.status}`)
  const d = await res.json()
  logAiUsage({ userId: requestedBy, endpoint: 'polling', provider: 'gemini', model: 'gemini-2.5-flash', flatUsd: 0.01, estimated: true })
  const text = d.candidates?.[0]?.content?.parts?.map(p => p.text).filter(Boolean).join('\n') || null
  const cites = (d.candidates?.[0]?.groundingMetadata?.groundingChunks || [])
    .map(c => ({ title: c.web?.title, url: c.web?.uri })).filter(c => c.url)
  return { text, citations: cites }
}

// ── Step 2: Grok social signal (Top Issues input only) ───────────────────────
async function grokSocialSignal(district, requestedBy) {
  if (!XAI_KEY) return null
  const label = districtLabel(district)
  try {
    const ctrl = new AbortController()
    setTimeout(() => ctrl.abort(), 60000)
    const res = await fetch('https://api.x.ai/v1/responses', {
      method: 'POST', signal: ctrl.signal,
      headers: { Authorization: `Bearer ${XAI_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: SOCIAL_MODEL,
        input: [{ role: 'user', content: `[SYSTEM: Real-time social listening for Wisconsin politics. Search X now.]\nWhat issues are people in and around ${label}, Wisconsin talking about most on X in the last 60 days — local concerns, complaints, political topics? List the top recurring themes with example posts/handles and rough volume. Note this is X conversation (skews younger/more online).` }],
        tools: [{ type: 'x_search' }],
      }),
    })
    if (!res.ok) return null
    const d = await res.json()
    logAiUsage({ userId: requestedBy, endpoint: 'polling', provider: 'xai', model: SOCIAL_MODEL, flatUsd: 0.03, estimated: true })
    for (const out of (d.output || [])) {
      if (out.type === 'message') {
        for (const c of (out.content || [])) if (c.type === 'output_text' && c.text) return c.text
      }
    }
    return null
  } catch (e) { console.warn('[polling-bg] grok skipped:', e.message); return null }
}

// ── Step 3: Claude synthesis to strict JSON ──────────────────────────────────
const SNAPSHOT_SCHEMA_NOTE = `{
  "top_issues": [ { "rank": 1, "issue": "string", "why": "one line" }, ... exactly 4 items ranked 1-4 ],
  "approval": { "subject": "officeholder/candidate name + office", "approval_pct": number, "disapproval_pct": number },
  "vote_share": {
    "phase": "primary" | "general",
    "primaries": [ { "party": "Republican", "candidates": [ { "candidate": "name", "pct": number }, ..., { "candidate": "Undecided", "pct": number } ] }, { "party": "Democrat", "candidates": [ ... ] } ],
    "general": [ { "candidate": "name", "party": "Republican|Democrat|Independent|Other", "pct": number }, ..., { "candidate": "Undecided", "party": "None", "pct": number } ]
  },
  "confidence": { "margin_pts": number, "band": "low|moderate|high", "note": "one line on what drives the uncertainty" }
}`

async function synthesize(district, research, social, requestedBy) {
  const label = districtLabel(district)
  const call = async () => {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: SYNTH_MODEL,
        max_tokens: 2000,
        messages: [{
          role: 'user',
          content: `You are estimating a district opinion snapshot for ${label}, Wisconsin. Using ONLY the research below, produce STRICT JSON matching exactly this shape (no prose, no markdown fences):
${SNAPSHOT_SCHEMA_NOTE}

Rules:
- top_issues: the 4 issues district voters care about most right now, ranked. Ground primarily in the news/coverage research; the social-listening signal may inform ranking but weight it lightly (X skews demographically).
- approval: the current ${officeLabel(district)} (or the most electorally relevant figure in the research). Anchor to real polling when present; otherwise model from past results + lean + coverage tone. approval_pct + disapproval_pct ≤ 100 (remainder = unsure).
- vote_share: today's date is ${new Date().toISOString().slice(0, 10)}. Wisconsin's 2026 partisan primary is August 11, 2026; the general is November 3, 2026. Decide the phase:
  * phase "primary" — the primary has NOT yet happened AND at least one party's nomination for this seat is contested. Fill "primaries": one entry per party that has a primary field, listing that party's ACTUAL candidates from the research. NEVER mix parties in one list. Each party's candidates + that party's "Undecided" line MUST sum to 100 ±1 WITHIN that party. A party with a single unopposed candidate may be included as that one candidate at 100, or omitted. Also fill "general" with the projected November head-to-head using each party's likely nominee (mark unsettled fields like "Republican nominee (TBD)") — the app shows the primaries first, then the general outlook.
  * phase "general" — primaries are over or every nomination is uncontested. Fill "general" only (omit "primaries" or use []): the head-to-head across parties, using the ACTUAL likely matchup from the research (generic R vs D ballot if no declared challenger), including an "Undecided" line, summing to 100 ±1.
- confidence: honest uncertainty. Real district polling in the research → margin 3-5, band high. Statewide polling only → 5-8, moderate. Modeled from results/demographics alone → 8-12, low. The note says what's driving it.
- These are AI estimates, not measurements — be conservative, never invent precision.

NEWS / POLLING / RESULTS RESEARCH:
${(research?.text || 'None available').slice(0, 12000)}

SOCIAL LISTENING (secondary signal, Top Issues only):
${(social || 'None available').slice(0, 4000)}`
        }],
      }),
    })
    if (!res.ok) throw new Error(`Anthropic ${res.status}`)
    const d = await res.json()
    logAiUsage({ userId: requestedBy, endpoint: 'polling', provider: 'anthropic', model: SYNTH_MODEL, inputTokens: d?.usage?.input_tokens || 0, outputTokens: d?.usage?.output_tokens || 0 })
    return (d.content?.[0]?.text || '').replace(/^```json?\s*/i, '').replace(/```\s*$/, '').trim()
  }

  // Validate; one retry on malformed output
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const parsed = JSON.parse(await call())
      const err = validateSnapshot(parsed)
      if (!err) return parsed
      console.warn(`[polling-bg] validation failed (attempt ${attempt + 1}): ${err}`)
    } catch (e) {
      console.warn(`[polling-bg] synthesis attempt ${attempt + 1} failed: ${e.message}`)
    }
  }
  return null
}

function sumsTo100(list) {
  const sum = list.reduce((t, v) => t + (typeof v.pct === 'number' ? v.pct : NaN), 0)
  return sum >= 98 && sum <= 102
}

// vote_share: legacy flat array (pre-v1.23 general-style) OR the phased object
function validateVoteShare(vs) {
  if (Array.isArray(vs)) {
    if (vs.length < 2) return 'vote_share too short'
    if (!sumsTo100(vs)) return 'vote_share does not sum to ~100'
    if (!vs.every(v => v.candidate && v.party)) return 'vote_share entries malformed'
    return null
  }
  if (!vs || typeof vs !== 'object') return 'vote_share malformed'
  if (vs.phase !== 'primary' && vs.phase !== 'general') return 'vote_share.phase invalid'
  if (vs.phase === 'primary') {
    if (!Array.isArray(vs.primaries) || vs.primaries.length < 1) return 'primaries missing'
    for (const p of vs.primaries) {
      if (!p.party || !Array.isArray(p.candidates) || p.candidates.length < 1) return 'primary group malformed'
      if (!p.candidates.every(c => c.candidate && typeof c.pct === 'number')) return `primary ${p.party} entries malformed`
      if (!sumsTo100(p.candidates)) return `primary ${p.party} does not sum to ~100`
    }
  }
  if (vs.phase === 'general' || (Array.isArray(vs.general) && vs.general.length)) {
    if (!Array.isArray(vs.general) || vs.general.length < 2) return 'general matchup missing'
    if (!sumsTo100(vs.general)) return 'general does not sum to ~100'
    if (!vs.general.every(v => v.candidate && v.party)) return 'general entries malformed'
  }
  return null
}

function validateSnapshot(s) {
  if (!s || typeof s !== 'object') return 'not an object'
  if (!Array.isArray(s.top_issues) || s.top_issues.length !== 4) return 'top_issues must have exactly 4 items'
  for (const [i, it] of s.top_issues.entries()) {
    if (it.rank !== i + 1 || !it.issue || !it.why) return `top_issues[${i}] malformed`
  }
  const a = s.approval
  if (!a || typeof a.approval_pct !== 'number' || typeof a.disapproval_pct !== 'number' || !a.subject) return 'approval malformed'
  if (a.approval_pct < 0 || a.approval_pct > 100 || a.disapproval_pct < 0 || a.approval_pct + a.disapproval_pct > 101) return 'approval out of range'
  const vsErr = validateVoteShare(s.vote_share)
  if (vsErr) return vsErr
  const c = s.confidence
  if (!c || typeof c.margin_pts !== 'number' || !['low', 'moderate', 'high'].includes(c.band)) return 'confidence malformed'
  return null
}

export const handler = async (event) => {
  const headers = { 'Content-Type': 'application/json' }
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: '{}' }

  let body
  try { body = JSON.parse(event.body || '{}') } catch { return { statusCode: 400, headers, body: '{}' } }

  // Internal trigger only — this endpoint is never called by clients
  const secret = process.env.ADMIN_TRIGGER_SECRET
  const provided = event.headers?.['x-internal-trigger'] || body.internal_trigger
  if (!secret || !provided || !safeEqual(provided, secret)) {
    return { statusCode: 404, headers, body: JSON.stringify({ error: 'Not found' }) }
  }

  const district = String(body.district || '')
  if (!/^(congress-\d+|senate-\d+|assembly-\d+|state-wi)$/.test(district)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid district' }) }
  }
  const requestedBy = body.requested_by || null

  const fail = async (note) => {
    await sb(`/poll_snapshots?district=eq.${encodeURIComponent(district)}`, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ status: 'error', error_note: String(note).slice(0, 300) }),
    })
    console.error(`[polling-bg] ${district} failed: ${note}`)
    return { statusCode: 200, headers, body: JSON.stringify({ ok: false }) }
  }

  try {
    // 1. Primary grounding (Perplexity → Gemini fallback)
    let research = null, researchProvider = 'perplexity'
    try { research = await perplexityResearch(district, requestedBy) }
    catch (e) {
      console.warn(`[polling-bg] Perplexity failed (${e.message}) — trying Gemini fallback`)
      try { research = await geminiResearch(district, requestedBy); researchProvider = 'gemini' } catch (e2) { console.warn('[polling-bg] Gemini failed:', e2.message) }
    }
    if (!research?.text) return await fail('Research providers unavailable')

    // 2. Social signal (best-effort)
    const social = await grokSocialSignal(district, requestedBy)

    // 3. Synthesis + validation
    const snapshot = await synthesize(district, research, social, requestedBy)
    if (!snapshot) return await fail('Synthesis produced invalid output twice')

    // Sources: prefer structured citations; else pull URLs out of the research text
    let sources = (research.citations || []).map(c => ({
      title: String(c.title || c.name || c.url || c).slice(0, 160),
      url: String(c.url || c).slice(0, 500),
    })).filter(s => /^https?:\/\//.test(s.url))
    if (!sources.length) {
      sources = [...new Set((research.text.match(/https?:\/\/[^\s)\]]+/g) || []).slice(0, 12))]
        .map(u => ({ title: u.replace(/^https?:\/\/(www\.)?/, '').split('/')[0], url: u }))
    }

    const modelUsed = `${researchProvider}:${researchProvider === 'gemini' ? 'gemini-2.5-flash' : RESEARCH_MODEL} + ${social ? `xai:${SOCIAL_MODEL} + ` : ''}anthropic:${SYNTH_MODEL}`

    // on_conflict=district is REQUIRED: merge-duplicates alone resolves on the
    // id PK, so re-saving an existing district 409s on the UNIQUE(district)
    const up = await sb('/poll_snapshots?on_conflict=district', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({
        district,
        district_name: districtLabel(district),
        generated_at: new Date().toISOString(),
        top_issues: snapshot.top_issues,
        approval: snapshot.approval,
        vote_share: snapshot.vote_share,
        confidence: snapshot.confidence,
        sources: sources.slice(0, 15),
        model_used: modelUsed,
        disclaimer: 'AI-Estimated. Not a scientific poll.',
        status: 'ready',
        error_note: null,
        requested_by: requestedBy,
      }),
    })
    if (!up.ok) return await fail(`Save failed ${up.status}`)
    console.log(`[polling-bg] ${district} snapshot ready (${modelUsed})`)
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) }
  } catch (e) {
    return await fail(e.message)
  }
}
