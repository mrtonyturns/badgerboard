// Netlify BACKGROUND Function: polling-snapshot-background (v1.26.1, BETA-ONLY)
//
// v1.26.1 — two follow-ups from the first production run of v1.26:
//   e) 0% candidates are stripped from the final projection. A model that knows
//      a candidate withdrew often keeps listing them at 0 instead of omitting
//      them, and a 0% row reads as "the tool thinks he's still running".
//   f) each ensemble estimator retries once. A single transient failure used to
//      drop that model from the run, and losing a voter is itself a source of
//      run-to-run movement (3 estimates = median, 2 = mean, 1 = no ensemble).
//
// v1.26 — projection STABILITY pass. Four changes, in order of impact:
//   a) ensemble combines by MEDIAN over the models that actually listed each
//      candidate (was: mean with "missing from a model" scored as 0, which
//      quietly demoted anyone one model forgot), with a quorum filter so a
//      single model's invented entrant is dropped rather than diluting the field
//   b) every run is anchored to the previous shared snapshot — handed to the
//      models as a baseline AND clamped server-side to ±maxDelta per candidate
//   c) local intel now moves only the candidates it actually names, with
//      explicit magnitude limits and no collateral reordering
//   d) low temperature on all four model calls
// The AI polling pipeline. Internal-trigger auth only (fired by
// polling-snapshot or the weekly refresh cron — never directly by clients).
//
//   1. Grok (xAI) — PRIMARY research engine (v1.23.2, per accuracy review):
//      live web + X search for district signal — news, polling, past results,
//      candidates (with an explicit dropout/withdrawal check). Perplexity
//      Sonar Pro is the trailing fallback, Gemini the last resort.
//   2. Grok social pass — X conversation, informs Top Issues ONLY
//      (secondary signal; X skews demographically).
//   3. Claude synthesis to the strict snapshot JSON, validated server-side;
//      one retry on malformed output.
//
// Providers are swappable via env: POLLING_GROK_MODEL (default grok-4.3),
// POLLING_RESEARCH_MODEL (Perplexity fallback model, default sonar-pro),
// POLLING_SYNTH_MODEL (default claude-opus-4-8). All keys server-side only.

import crypto from 'crypto'
import { logAiUsage } from './_ai-usage.js'

const SUPABASE_URL   = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const SERVICE_KEY    = process.env.SUPABASE_SERVICE_ROLE_KEY
const PPLX_KEY       = process.env.PERPLEXITY_API_KEY
const XAI_KEY        = process.env.XAI_API_KEY
const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY
const GEMINI_KEY     = process.env.GEMINI_API_KEY

const GROK_MODEL     = process.env.POLLING_GROK_MODEL     || 'grok-4.3'
const RESEARCH_MODEL = process.env.POLLING_RESEARCH_MODEL || 'sonar-pro'   // Perplexity fallback
const SOCIAL_MODEL   = process.env.POLLING_SOCIAL_MODEL   || GROK_MODEL
const SYNTH_MODEL    = process.env.POLLING_SYNTH_MODEL    || 'claude-opus-4-8'

const GLOBAL_USER = '00000000-0000-0000-0000-000000000000'

// ── Local intel (v1.25): the requesting user's notes/files for this district ─
async function loadIntel(userId, district) {
  if (!userId) return null
  const res = await sb(`/poll_intel?user_id=eq.${userId}&district=eq.${encodeURIComponent(district)}&select=*&order=created_at.asc&limit=40`)
  if (!res.ok) return null
  const rows = await res.json()
  if (!rows.length) return null
  let text = ''
  for (const r of rows) {
    if (r.content) {
      const chunk = `--- ${r.title || r.kind} ---\n${r.content}\n`
      if (text.length + chunk.length < 9000) text += chunk
    }
  }
  // images: up to 3, ≤ 4 MB each, fed to the Claude synthesis (vision)
  const images = []
  for (const r of rows.filter(x => x.kind === 'image' && x.file_path)) {
    if (images.length >= 3) break
    try {
      const ir = await fetch(`${SUPABASE_URL}/storage/v1/object/poll-intel/${r.file_path}`, {
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
      })
      if (!ir.ok) continue
      const buf = Buffer.from(await ir.arrayBuffer())
      if (buf.length > 4 * 1024 * 1024) continue
      const mt = (r.file_type && /^image\/(png|jpeg|jpg|gif|webp)$/.test(r.file_type)) ? r.file_type.replace('jpg', 'jpeg') : 'image/jpeg'
      images.push({ media_type: mt, data: buf.toString('base64'), title: r.title || 'image' })
    } catch (_) {}
  }
  return { text: text.trim() || null, images, count: rows.length }
}

// v1.26: intel is evidence about the candidate(s) it names — nothing more.
// The previous wording ("it SHOULD move the vote-share numbers") licensed every
// model to re-roll the entire field whenever any intel existed, which is how a
// note about one candidate ended up promoting an unrelated one to first place.
const INTEL_NOTE = (intel) => intel && (intel.text || intel.images.length) ? `

CAMPAIGN-PROVIDED LOCAL INTEL (private, supplied by the requesting campaign — internal canvass results, mailers, on-the-ground reports${intel.images.length ? ', plus attached images' : ''}):
${(intel.text || '(images only)').slice(0, 9000)}

HOW TO APPLY THIS INTEL — follow exactly:
1. SCOPE. First identify which race and which specific candidate(s) this intel is actually about. It is evidence about those candidates ONLY. Candidates the intel does not mention get no evidentiary change from it.
2. NO COLLATERAL REORDERING. Adjust the subject candidate(s), then absorb the difference across the rest of that party's field PROPORTIONALLY to their existing shares. A candidate the intel says nothing about must NOT overtake another candidate as a side effect of this intel. If the intel concerns candidate A, the relative order of B, C and D stays as it was.
3. MAGNITUDE. Be conservative and proportional to the evidence:
   - a complete internal poll or a full district canvass: up to ~8 points on the subject candidate
   - partial canvass tallies, mailer counts, event turnout, volunteer reports: ~3 points or less
   - a claim, photo, endorsement rumor, or opposition item with no numbers behind it: ~2 points or less
   Nothing here justifies moving a candidate into or out of first place on its own.
4. CREDIBILITY. This comes from an interested party and is unverified. Discount anything that contradicts documented public facts, and never let it override real published polling — at most it nudges within the polling's margin.
5. Note in the confidence text that campaign-provided local intel was factored in.` : ''

// The previous projection for this district, handed to every model as the
// working baseline so a refresh reproduces rather than re-rolls.
const PRIOR_NOTE = (prior) => prior?.vote_share ? `

PREVIOUS PROJECTION for this district (produced by this same system ${prior.ageDays} day(s) ago) — this is your BASELINE:
${JSON.stringify(prior.vote_share)}
Rules for the baseline:
- A refresh is a re-measurement of the same race, not a fresh opinion. If nothing material has changed, REPRODUCE these numbers (within a point or two). Voters do not swing 20 points in a week.
- Depart from the baseline only where the research below contains specific NEW evidence — a new poll, a withdrawal, a fundraising report, a major local event — and then move only the candidates that evidence concerns, citing it in the confidence note.
- If a baseline candidate has since withdrawn, drop them and redistribute their share across the remaining field in proportion to their current standing.
- If a candidate is missing from the baseline but is confirmed running in the research, add them at a level justified by the evidence.
- Do not reorder the field unless the research gives a concrete reason to.${prior.approval ? `
Previous approval read: ${JSON.stringify(prior.approval)} — same rule applies, stay close to it absent new evidence.` : ''}` : ''

// Pull the shared (global) baseline for this district. Personalized runs anchor
// to the public baseline too, which is what makes local intel a bounded
// perturbation of the shared read instead of an independent re-roll.
async function loadPrior(district) {
  try {
    const res = await sb(`/poll_snapshots?district=eq.${encodeURIComponent(district)}&user_id=eq.${GLOBAL_USER}&select=vote_share,approval,generated_at,status`)
    if (!res.ok) return null
    const row = (await res.json())?.[0]
    // NOTE: status is 'generating' by the time we run (polling-snapshot flips it
    // before firing us) — the vote_share on the row is still the previous run's,
    // which is exactly the baseline we want. Don't gate on status.
    if (!row?.vote_share) return null
    if (validateVoteShare(row.vote_share)) return null       // don't anchor to a malformed prior
    // generated_at was reset by the 'generating' upsert, so this reads ~0 on a
    // normal refresh — that's the intended tight clamp. It only widens when a
    // row has genuinely sat untouched.
    const ageDays = Math.max(0, Math.round((Date.now() - new Date(row.generated_at).getTime()) / 86400000))
    if (ageDays > 45) return null                            // too stale to constrain a new read
    const { _spread, ...vote_share } = row.vote_share
    return { vote_share, approval: row.approval || null, ageDays }
  } catch (_) { return null }
}

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

// ── Step 1: Grok research (PRIMARY grounding — live web + X search) ──────────
async function grokResearch(district, requestedBy) {
  if (!XAI_KEY) return null
  const label = districtLabel(district)
  const ctrl = new AbortController()
  setTimeout(() => ctrl.abort(), 90000)
  const res = await fetch('https://api.x.ai/v1/responses', {
    method: 'POST', signal: ctrl.signal,
    headers: { Authorization: `Bearer ${XAI_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: GROK_MODEL,
      input: [{ role: 'user', content: `[SYSTEM: You are a Wisconsin political researcher. Search the live web and X now. Report only sourced, current facts — name the outlet for every claim, never fabricate polls or results.]
Build a current opinion-signal brief for ${label}, Wisconsin (office: ${officeLabel(district)}). Report, with sources and dates:
1. CURRENT OFFICEHOLDER(S) and every declared 2026 candidate for this seat (names + parties), including the primary field for each party. CRITICAL: verify each candidate's CURRENT status — explicitly search for withdrawal/dropout/suspension news for every name you list, and clearly mark anyone who has DROPPED OUT or withdrawn (with date + source). Do not present withdrawn candidates as active.
2. EXISTING PUBLIC POLLING that covers this district or Wisconsin statewide (pollster, date, numbers) — approval and head-to-head if available.
3. PAST ELECTION RESULTS for this seat (last 2-3 cycles, vote percentages).
4. LOCAL ISSUES dominating recent local news coverage in this area (schools, taxes, roads, healthcare, agriculture, housing, public safety, etc.) — which get the most coverage and community reaction.
5. DISTRICT DEMOGRAPHICS relevant to opinion (urban/rural mix, income, age, education).
6. Any recent events likely moving opinion (plant closures, controversies, disasters, big announcements).
List the URL for every source you used.` }],
      tools: [{ type: 'web_search' }, { type: 'x_search' }],
    }),
  })
  if (!res.ok) throw new Error(`Grok ${res.status}`)
  const d = await res.json()
  logAiUsage({ userId: requestedBy, endpoint: 'polling', provider: 'xai', model: GROK_MODEL, inputTokens: d?.usage?.input_tokens || 0, outputTokens: d?.usage?.output_tokens || 0 })
  let text = null
  const citations = []
  if (Array.isArray(d.citations)) for (const u of d.citations) { if (typeof u === 'string') citations.push({ url: u }); else if (u?.url) citations.push(u) }
  for (const out of (d.output || [])) {
    if (out.type === 'message') {
      for (const c of (out.content || [])) {
        if (c.type === 'output_text' && c.text) {
          text = (text ? text + '\n' : '') + c.text
          for (const a of (c.annotations || [])) {
            const url = a?.url || a?.url_citation?.url
            if (url) citations.push({ title: a?.title || a?.url_citation?.title, url })
          }
        }
      }
    }
  }
  if (!text) throw new Error('Grok returned no text')
  return { text, citations }
}

// ── Step 1b: Perplexity research (trailing fallback) ─────────────────────────
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

async function synthesize(district, research, social, requestedBy, intel, prior) {
  const label = districtLabel(district)
  const call = async () => {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: SYNTH_MODEL,
        max_tokens: 2000,
        // NOTE: no `temperature` here — SYNTH_MODEL rejects it (400), which
        // silently failed both synthesis attempts. Run-to-run stability for
        // this call comes from PRIOR_NOTE anchoring instead.
        messages: [{
          role: 'user',
          content: `You are estimating a district opinion snapshot for ${label}, Wisconsin. Using ONLY the research below, produce STRICT JSON matching exactly this shape (no prose, no markdown fences):
${SNAPSHOT_SCHEMA_NOTE}

Rules:
- CANDIDATE STATUS: if the research marks any candidate as withdrawn, dropped out, or suspended, EXCLUDE them from every vote_share list. Only candidates confirmed still running appear.
- top_issues: the 4 issues district voters care about most right now, ranked. Ground primarily in the news/coverage research; the social-listening signal may inform ranking but weight it lightly (X skews demographically).
- approval: the current ${officeLabel(district)} (or the most electorally relevant figure in the research). Anchor to real polling when present; otherwise model from past results + lean + coverage tone. approval_pct + disapproval_pct ≤ 100 (remainder = unsure). Allocate leaners: keep unsure ≤ 15 — commit soft opinion to approve or disapprove based on lean and coverage tone.
- vote_share: today's date is ${new Date().toISOString().slice(0, 10)}. Wisconsin's 2026 partisan primary is August 11, 2026; the general is November 3, 2026. Decide the phase:
  * phase "primary" — the primary has NOT yet happened AND at least one party's nomination for this seat is contested. Fill "primaries": one entry per party that has a primary field, listing that party's ACTUAL candidates from the research. NEVER mix parties in one list. Each party's candidates + that party's "Undecided" line MUST sum to 100 ±1 WITHIN that party. BE DECISIVE: allocate undecided/soft voters to candidates using name recognition, endorsements, fundraising, incumbency, geography, and social traction — Undecided is capped at 15 per party (10 when any real polling exists). This is a projection, not a survey: the confidence margin carries the uncertainty, so do not park it in Undecided. A party with a single unopposed candidate may be included as that one candidate at 100, or omitted. Also fill "general" with the projected November head-to-head using each party's likely nominee (mark unsettled fields like "Republican nominee (TBD)") — the app shows the primaries first, then the general outlook.
  * phase "general" — primaries are over or every nomination is uncontested. Fill "general" only (omit "primaries" or use []): the head-to-head across parties, using the ACTUAL likely matchup from the research (generic R vs D ballot if no declared challenger), including an "Undecided" line capped at 10, summing to 100 ±1 — allocate leaners to the candidates the way a pollster's final projection would.
- confidence: honest uncertainty. Real district polling in the research → margin 3-5, band high. Statewide polling only → 5-8, moderate. Modeled from results/demographics alone → 8-12, low. The note says what's driving it.
- These are AI estimates, not measurements. Take a clear position on every number — express the uncertainty through the confidence margin/band, not by inflating Undecided or Unsure.

NEWS / POLLING / RESULTS RESEARCH:
${(research?.text || 'None available').slice(0, 12000)}

SOCIAL LISTENING (secondary signal, Top Issues only):
${(social || 'None available').slice(0, 4000)}${PRIOR_NOTE(prior)}${INTEL_NOTE(intel)}`
        }].map(m => {
          // attach intel images (canvass sheets, mailers, photos) as vision blocks
          if (!intel || !intel.images.length) return m
          return { role: m.role, content: [
            ...intel.images.map(img => ({ type: 'image', source: { type: 'base64', media_type: img.media_type, data: img.data } })),
            { type: 'text', text: m.content },
          ] }
        }),
      }),
    })
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`)
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
      const und = p.candidates.find(c => /^undecided$/i.test(c.candidate))
      if (und && und.pct > 25) return `primary ${p.party} Undecided too high (${und.pct}) — allocate leaners`
    }
  }
  if (vs.phase === 'general' || (Array.isArray(vs.general) && vs.general.length)) {
    if (!Array.isArray(vs.general) || vs.general.length < 2) return 'general matchup missing'
    if (!sumsTo100(vs.general)) return 'general does not sum to ~100'
    if (!vs.general.every(v => v.candidate && v.party)) return 'general entries malformed'
  }
  return null
}

// ── Vote-share ensemble (v1.23.4) ────────────────────────────────────────────
// Grok, Perplexity, and Gemini each independently estimate the vote share from
// the shared research; the final projection is the average of the valid
// estimates (matched by candidate, renormalized to 100).

const VOTE_SHARE_RULES = (district) => `Today's date is ${new Date().toISOString().slice(0, 10)}. Wisconsin's 2026 partisan primary is August 11, 2026; the general is November 3, 2026.
Output STRICT JSON only (no prose, no markdown fences) in exactly this shape:
{
  "phase": "primary" | "general",
  "primaries": [ { "party": "Republican", "candidates": [ { "candidate": "name", "pct": number }, ..., { "candidate": "Undecided", "pct": number } ] }, ... ],
  "general": [ { "candidate": "name", "party": "Republican|Democrat|Independent|Other", "pct": number }, ..., { "candidate": "Undecided", "party": "None", "pct": number } ]
}
Rules:
- EXCLUDE any candidate reported withdrawn, dropped out, or suspended. Use candidates' FULL names.
- phase "primary" when the primary hasn't happened and any nomination is contested: one primaries entry per party with a contested field; candidates + "Undecided" sum to 100 ±1 WITHIN each party; never mix parties. Also fill "general" with the November outlook (use "Republican nominee (TBD)" style for unsettled fields).
- phase "general" when nominations are settled: fill "general" only, summing to 100 ±1.
- BE DECISIVE: allocate soft/undecided voters by name recognition, endorsements, fundraising, incumbency, geography, and traction. Undecided ≤ 15 per party (≤ 10 with real polling or in the general).`

// Low temperature on every estimator: run-to-run swings were partly just
// sampling noise at the provider defaults.
const EST_TEMP = 0.15

// v1.26.1 — retry each estimator once. A single transient 429/5xx or one
// malformed JSON reply used to silently drop that model from the run, and
// losing a voter is precisely what destabilizes the projection: 3 estimates
// give a true median, 2 degrade to a mean, and 1 disables the ensemble
// entirely and falls back to the (less stable) synthesis number. One cheap
// retry buys back most of those runs.
async function estimateVoteShare(provider, district, research, requestedBy, intel, prior) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const out = await estimateVoteShareOnce(provider, district, research, requestedBy, intel, prior)
      if (out) return out
      if (!hasKeyFor(provider)) return null            // no key configured — retrying is pointless
    } catch (e) {
      console.warn(`[polling-bg] ${provider} estimate attempt ${attempt + 1} failed: ${e.message}`)
    }
    if (attempt === 0) await new Promise(r => setTimeout(r, 1500))
  }
  return null
}

const hasKeyFor = (p) => p === 'xai' ? !!XAI_KEY : p === 'perplexity' ? !!PPLX_KEY : !!GEMINI_KEY

async function estimateVoteShareOnce(provider, district, research, requestedBy, intel, prior) {
  const label = districtLabel(district)
  const prompt = `You are projecting the vote share for ${label}, Wisconsin (office: ${officeLabel(district)}).
${VOTE_SHARE_RULES(district)}

RESEARCH:
${(research?.text || '').slice(0, 11000)}${PRIOR_NOTE(prior)}${INTEL_NOTE(intel)}`
  let text = null
  if (provider === 'xai') {
    if (!XAI_KEY) return null
    const res = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${XAI_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: GROK_MODEL, max_tokens: 1200, temperature: EST_TEMP, messages: [{ role: 'user', content: prompt }] }),
    })
    if (!res.ok) throw new Error(`xai ${res.status}`)
    const d = await res.json()
    logAiUsage({ userId: requestedBy, endpoint: 'polling', provider: 'xai', model: GROK_MODEL, inputTokens: d?.usage?.prompt_tokens || 0, outputTokens: d?.usage?.completion_tokens || 0 })
    text = d.choices?.[0]?.message?.content
  } else if (provider === 'perplexity') {
    if (!PPLX_KEY) return null
    const res = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${PPLX_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: RESEARCH_MODEL, max_tokens: 1200, temperature: EST_TEMP, messages: [
        { role: 'system', content: 'You are a Wisconsin election forecaster. You may verify facts with live search, but output STRICT JSON only.' },
        { role: 'user', content: prompt },
      ] }),
    })
    if (!res.ok) throw new Error(`perplexity ${res.status}`)
    const d = await res.json()
    logAiUsage({ userId: requestedBy, endpoint: 'polling', provider: 'perplexity', model: RESEARCH_MODEL, inputTokens: d?.usage?.prompt_tokens || 0, outputTokens: d?.usage?.completion_tokens || 0 })
    text = d.choices?.[0]?.message?.content
  } else if (provider === 'gemini') {
    if (!GEMINI_KEY) return null
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: EST_TEMP } }),
    })
    if (!res.ok) throw new Error(`gemini ${res.status}`)
    const d = await res.json()
    logAiUsage({ userId: requestedBy, endpoint: 'polling', provider: 'gemini', model: 'gemini-2.5-flash', flatUsd: 0.005, estimated: true })
    text = d.candidates?.[0]?.content?.parts?.map(x => x.text).filter(Boolean).join('\n')
  }
  if (!text) return null
  const cleaned = text.replace(/^[^{]*/, '').replace(/[^}]*$/, '')
  const parsed = JSON.parse(cleaned)
  const err = validateVoteShare(parsed)
  if (err) { console.warn(`[polling-bg] ${provider} estimate invalid: ${err}`); return null }
  return parsed
}

const nameKey = (n) => /undecided/i.test(n) ? 'undecided'
  : /nominee|tbd/i.test(n) ? `tbd-${(n.match(/republican|democrat|independent/i) || ['x'])[0].toLowerCase()}`
  : String(n).toLowerCase().replace(/[^a-z ]/g, '').trim().split(/\s+/).pop()

const median = (arr) => {
  const s = [...arr].sort((x, y) => x - y)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

// Renormalize a list to exactly 100 (integers), Undecided last.
function normalize100(rows) {
  const sum = rows.reduce((t, r) => t + r.pct, 0) || 1
  const out = rows.map(r => ({ ...r, pct: Math.round((r.pct / sum) * 100) }))
  const drift = 100 - out.reduce((t, r) => t + r.pct, 0)
  if (drift !== 0 && out.length) {
    // give drift to the largest non-Undecided line so rounding never invents a leader
    const idx = out.reduce((best, r, i) =>
      (/undecided/i.test(r.candidate) ? best : (out[best] && out[best].pct >= r.pct ? best : i)), 0)
    out[idx].pct += drift
  }
  out.sort((a, b) => (/undecided/i.test(a.candidate) ? 1 : 0) - (/undecided/i.test(b.candidate) ? 1 : 0) || b.pct - a.pct)
  return out
}

// v1.26 — combine model estimates by MEDIAN over the models that actually
// listed each candidate.
//
// The previous implementation summed pct and divided by lists.length, so a
// candidate one model forgot to list was scored 0 for that model — a real
// front-runner listed by 2 of 3 models lost a third of their share and could be
// overtaken by a weaker candidate all three happened to list. That single bug
// explains most of the run-to-run reordering. Now: a candidate is kept only if
// a quorum of models named them (which drops one model's hallucinated entrant
// instead of diluting everyone else), and their number is the median of the
// models that did — so one outlier estimate can no longer swing the ranking.
function combineLists(lists, withParty) {
  const n = lists.length
  const acc = new Map()  // key → { candidate, party, vals[] }
  for (const list of lists) {
    const seenThisModel = new Set()
    for (const c of list) {
      const k = nameKey(c.candidate)
      if (seenThisModel.has(k)) continue      // one model listing a name twice counts once
      seenThisModel.add(k)
      if (!acc.has(k)) acc.set(k, { candidate: c.candidate, party: c.party, vals: [] })
      const a = acc.get(k)
      a.vals.push(typeof c.pct === 'number' ? c.pct : 0)
      // prefer the longest name variant (fuller names read better)
      if (String(c.candidate).length > String(a.candidate).length) a.candidate = c.candidate
      if (!a.party && c.party) a.party = c.party
    }
  }
  // Quorum: with 3 models require 2; with 2 models a single mention stands
  // (there's no majority to appeal to). Undecided always survives.
  const quorum = n >= 3 ? 2 : 1
  const kept = [...acc.values()].filter(a => a.vals.length >= quorum || /undecided/i.test(a.candidate))
  const rows = (kept.length ? kept : [...acc.values()]).map(a => ({
    candidate: a.candidate,
    ...(withParty ? { party: a.party || 'Other' } : {}),
    pct: median(a.vals),
  }))
  return normalize100(rows)
}

// Widest disagreement between models on any candidate they all weighed in on —
// feeds the confidence margin so a split ensemble reports as less certain.
function ensembleSpread(lists) {
  const acc = new Map()
  for (const list of lists) {
    for (const c of list) {
      if (/undecided/i.test(c.candidate)) continue
      const k = nameKey(c.candidate)
      if (!acc.has(k)) acc.set(k, [])
      acc.get(k).push(typeof c.pct === 'number' ? c.pct : 0)
    }
  }
  let worst = 0
  for (const vals of acc.values()) {
    if (vals.length < 2) continue
    worst = Math.max(worst, Math.max(...vals) - Math.min(...vals))
  }
  return worst
}

function averageVoteShares(estimates) {
  if (!estimates.length) return null
  // Phase: majority vote (ties → primary, the safer pre-August default)
  const primaryVotes = estimates.filter(e => e.phase === 'primary').length
  const phase = primaryVotes * 2 >= estimates.length ? 'primary' : 'general'
  const out = { phase, primaries: [], general: [] }
  let spread = 0

  if (phase === 'primary') {
    const parties = [...new Set(estimates.flatMap(e => (e.primaries || []).map(p => p.party)))]
    for (const party of parties) {
      const lists = estimates.map(e => (e.primaries || []).find(p => p.party === party)?.candidates).filter(Boolean)
      if (lists.length) {
        out.primaries.push({ party, candidates: combineLists(lists, false) })
        spread = Math.max(spread, ensembleSpread(lists))
      }
    }
  }
  const genLists = estimates.map(e => e.general).filter(g => Array.isArray(g) && g.length)
  if (genLists.length) {
    out.general = combineLists(genLists, true)
    spread = Math.max(spread, ensembleSpread(genLists))
  }
  out._spread = spread
  return (out.primaries.length || out.general.length) ? out : null
}

// ── Prior-snapshot anchoring (v1.26) ─────────────────────────────────────────
// A regeneration is a fresh sample of the same underlying reality, not a fresh
// opinion. Absent new evidence the numbers should barely move. We tell every
// model the previous projection (see PRIOR_NOTE) and then enforce it here:
// any candidate that appears in both runs is held within maxDelta points of
// where they were, and each list is renormalized. Candidates who are new, or
// who have dropped out since, are unconstrained — genuine news still lands.
function clampList(rows, priorRows, maxDelta) {
  if (!Array.isArray(priorRows) || !priorRows.length) return rows
  const prior = new Map(priorRows.map(p => [nameKey(p.candidate), typeof p.pct === 'number' ? p.pct : null]))
  const adjusted = rows.map(r => {
    const p = prior.get(nameKey(r.candidate))
    if (p == null) return r                                  // new name — let it stand
    return { ...r, pct: Math.min(p + maxDelta, Math.max(p - maxDelta, r.pct)) }
  })
  return stabilizeRank(normalize100(adjusted), prior)
}

// Rank hysteresis: when the top two are inside the dead-heat band the ordering
// carries no real information, so flipping the #1 badge on every refresh is
// noise presented as news. If the run puts a new name on top by ≤ TIE_BAND
// points and the previous baseline had it the other way, keep the prior order.
// Outside the band the new result stands — a real lead change still shows.
const TIE_BAND = 3
function stabilizeRank(rows, priorMap) {
  const real = rows.filter(r => !/undecided/i.test(r.candidate))
  if (real.length < 2) return rows
  const [a, b] = real
  if (a.pct - b.pct > TIE_BAND) return rows
  const pa = priorMap.get(nameKey(a.candidate))
  const pb = priorMap.get(nameKey(b.candidate))
  if (pa == null || pb == null || pb <= pa) return rows       // no flip to undo
  const t = a.pct; a.pct = b.pct; b.pct = t                   // restore prior order
  rows.sort((x, y) => (/undecided/i.test(x.candidate) ? 1 : 0) - (/undecided/i.test(y.candidate) ? 1 : 0) || y.pct - x.pct)
  return rows
}

// v1.26.1 — strip 0% lines. A model that knows a candidate withdrew often keeps
// listing them at 0 rather than omitting them (Kell Bales did exactly this on
// senate-1). A 0% row reads to the user as "the tool still thinks he's running",
// which is the same complaint that started this. Dropping them can't break the
// sum — they contribute nothing — and Undecided is exempt so a district with no
// undecideds still renders the line.
function dropZeroed(vs) {
  const strip = (rows) => (Array.isArray(rows)
    ? rows.filter(r => /undecided/i.test(r.candidate) || !(typeof r.pct === 'number' && r.pct <= 0))
    : rows)
  if (Array.isArray(vs?.primaries)) for (const g of vs.primaries) g.candidates = strip(g.candidates)
  if (Array.isArray(vs?.general)) vs.general = strip(vs.general)
  if (Array.isArray(vs)) return strip(vs)
  return vs
}

function anchorVoteShare(vs, prior, maxDelta) {
  if (!vs || !prior?.vote_share || prior.vote_share.phase !== vs.phase) return vs
  const pv = prior.vote_share
  if (Array.isArray(vs.primaries)) {
    for (const grp of vs.primaries) {
      const pg = (pv.primaries || []).find(p => p.party === grp.party)
      if (pg) grp.candidates = clampList(grp.candidates, pg.candidates, maxDelta)
    }
  }
  if (Array.isArray(vs.general) && vs.general.length && Array.isArray(pv.general) && pv.general.length) {
    vs.general = clampList(vs.general, pv.general, maxDelta)
  }
  return vs
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
  const snapshotUser = /^[0-9a-f-]{36}$/i.test(String(body.snapshot_user || '')) ? body.snapshot_user : null
  const rowUser = snapshotUser || GLOBAL_USER

  const fail = async (note) => {
    await sb(`/poll_snapshots?district=eq.${encodeURIComponent(district)}&user_id=eq.${rowUser}`, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ status: 'error', error_note: String(note).slice(0, 300) }),
    })
    console.error(`[polling-bg] ${district} failed: ${note}`)
    return { statusCode: 200, headers, body: JSON.stringify({ ok: false }) }
  }

  try {
    // 1. Primary grounding: Grok (most accurate in testing) → Perplexity
    //    trailing fallback → Gemini last resort
    let research = null, researchProvider = 'xai'
    try { research = await grokResearch(district, requestedBy) }
    catch (e) {
      console.warn(`[polling-bg] Grok research failed (${e.message}) — trying Perplexity fallback`)
      try { research = await perplexityResearch(district, requestedBy); researchProvider = 'perplexity' }
      catch (e2) {
        console.warn(`[polling-bg] Perplexity failed (${e2.message}) — trying Gemini fallback`)
        try { research = await geminiResearch(district, requestedBy); researchProvider = 'gemini' } catch (e3) { console.warn('[polling-bg] Gemini failed:', e3.message) }
      }
    }
    if (!research?.text) return await fail('Research providers unavailable')

    // 1b. Local intel (personalized snapshots only) + the shared baseline this
    //     run anchors to. Personalized runs anchor to the GLOBAL baseline, so
    //     intel perturbs the public read instead of replacing it.
    const [intel, prior] = await Promise.all([
      loadIntel(snapshotUser, district).catch(() => null),
      loadPrior(district).catch(() => null),
    ])

    // 2. Social signal (best-effort)
    const social = await grokSocialSignal(district, requestedBy)

    // 3. Synthesis (full snapshot) + 3-model vote-share ensemble, in parallel
    const EST_PROVIDERS = ['xai', 'perplexity', 'gemini']
    const [snapshot, ...estimates] = await Promise.all([
      synthesize(district, research, social, requestedBy, intel, prior),
      ...EST_PROVIDERS.map(prov =>
        estimateVoteShare(prov, district, research, requestedBy, intel, prior)
          .catch(e => { console.warn(`[polling-bg] ${prov} estimate failed: ${e.message}`); return null })),
    ])
    if (!snapshot) return await fail('Synthesis produced invalid output twice')

    // Which models actually voted. Named in model_used rather than hardcoding
    // "grok/perplexity/gemini": a provider whose key is missing or whose model
    // name has gone stale fails silently every run, and a "median of 2" label
    // that still lists three providers hides which one is dead.
    const estProviders = EST_PROVIDERS.filter((_, i) => estimates[i])
    const estLabel = estProviders.map(p => p === 'xai' ? 'grok' : p).join('/')
    for (const p of EST_PROVIDERS.filter(p => !estProviders.includes(p))) {
      console.warn(`[polling-bg] estimator ${p} contributed nothing this run (key missing, model rejected, or invalid JSON twice)`)
    }

    // 4. Ensemble — median across Grok/Perplexity/Gemini, quorum-filtered.
    //    Needs ≥2 valid estimates; otherwise the Claude synthesis vote_share
    //    stands (and is still anchored below).
    const validEstimates = estimates.filter(Boolean)
    let ensembleUsed = false
    let spread = 0
    if (validEstimates.length >= 2) {
      const averaged = averageVoteShares(validEstimates)
      if (averaged) {
        spread = averaged._spread || 0
        delete averaged._spread
        if (!validateVoteShare(averaged)) { snapshot.vote_share = averaged; ensembleUsed = true }
        else console.warn(`[polling-bg] ensemble failed validation: ${validateVoteShare(averaged)}`)
      }
    }

    // 5. Anchor to the prior baseline. Candidates present in both runs are held
    //    within maxDelta points of where they were; new entrants and dropouts
    //    are unconstrained. Intel widens the band so a campaign's own data can
    //    actually move its candidate — but not re-rank the whole field.
    const maxDelta = 8 + (intel ? 4 : 0) + Math.min(10, prior?.ageDays || 0)
    snapshot.vote_share = dropZeroed(snapshot.vote_share)
    if (prior) {
      const before = JSON.stringify(snapshot.vote_share)
      snapshot.vote_share = anchorVoteShare(snapshot.vote_share, prior, maxDelta)
      const vErr = validateVoteShare(snapshot.vote_share)
      if (vErr) { console.warn(`[polling-bg] anchoring broke validation (${vErr}) — reverting`); snapshot.vote_share = JSON.parse(before) }
    }

    // 6. Model disagreement feeds the confidence band — a split ensemble is a
    //    genuinely less certain read and should say so.
    if (spread > 12 && snapshot.confidence) {
      snapshot.confidence.margin_pts = Math.max(snapshot.confidence.margin_pts || 0, Math.round(spread / 2))
      if (spread > 20) snapshot.confidence.band = 'low'
      else if (snapshot.confidence.band === 'high') snapshot.confidence.band = 'moderate'
      snapshot.confidence.note = `${String(snapshot.confidence.note || '').replace(/\s*$/, '')} Models disagreed by up to ${Math.round(spread)} pts on this field, which widens the margin.`.trim().slice(0, 400)
    }

    console.log(`[polling-bg] ${district} ensemble: ${validEstimates.length}/3 valid, used=${ensembleUsed}, spread=${Math.round(spread)}, anchored=${!!prior} (Δ≤${maxDelta}, prior ${prior?.ageDays ?? '-'}d)`)

    // Sources: prefer structured citations; else pull URLs out of the research text
    const hostOf = (u) => String(u || '').replace(/^https?:\/\/(www\.)?/, '').split('/')[0]
    let sources = (research.citations || []).map(c => {
      const url = String(c.url || c).slice(0, 500)
      let title = String(c.title || c.name || '').trim().slice(0, 160)
      // Grok annotations often carry bare footnote numbers as titles — use the domain instead
      if (!title || /^[\d.\[\]#]+$/.test(title)) title = hostOf(url)
      return { title, url }
    }).filter(s => /^https?:\/\//.test(s.url))
    // dedupe by URL (multi-annotation citations repeat)
    sources = [...new Map(sources.map(s => [s.url, s])).values()].slice(0, 12)
    if (!sources.length) {
      sources = [...new Set((research.text.match(/https?:\/\/[^\s)\]]+/g) || []).slice(0, 12))]
        .map(u => ({ title: u.replace(/^https?:\/\/(www\.)?/, '').split('/')[0], url: u }))
    }

    const researchModelName = researchProvider === 'xai' ? GROK_MODEL : researchProvider === 'gemini' ? 'gemini-2.5-flash' : RESEARCH_MODEL
    const modelUsed = `${researchProvider}:${researchModelName} + anthropic:${SYNTH_MODEL}${ensembleUsed ? ` + vote-share median of ${validEstimates.length} models (${estLabel})` : ''}${prior ? ' + baseline-anchored' : ''}`

    // on_conflict=district is REQUIRED: merge-duplicates alone resolves on the
    // id PK, so re-saving an existing district 409s on the UNIQUE(district)
    const up = await sb('/poll_snapshots?on_conflict=district,user_id', {
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
        user_id: rowUser,
        intel_count: intel ? intel.count : 0,
      }),
    })
    if (!up.ok) return await fail(`Save failed ${up.status}`)
    console.log(`[polling-bg] ${district} snapshot ready (${modelUsed})`)
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) }
  } catch (e) {
    return await fail(e.message)
  }
}
