// Netlify Function: recruit-research-background
// Researches candidate-recruitment prospects (Perplexity sonar for public
// sources with citations → Claude Haiku for structuring) and writes the result
// onto recruitment_prospects.
//
// Runs as a Netlify BACKGROUND function (-background suffix → 15 min budget):
// Netlify answers the browser with 202 BEFORE this handler runs, which means
// every statusCode returned below is thrown away. So the handler's real output
// contract is the rows it writes:
//   recruitment_research_progress  — the phase/status row the client polls
//   recruitment_prospects          — the per-person research result
// Every phase boundary AND every terminal error writes the progress row;
// without it a failure is invisible and the client spins forever. This mirrors
// research-district-events-background.js and generate-dossier-background.js.
//
// THIS ENDPOINT IS ALSO THE TRIGGER. Because the 202 is sent before we run,
// there is no separate synchronous validator to bounce a bad request — auth,
// the `recruit` entitlement, the rate limit, ownership of the search, and the
// run-time attestation are all checked here first, and each failure is reported
// through the progress row instead of a status code.
//
// ─── Guardrails (RECRUIT-from-voterlist-gameplan.md §4) ──────────────────────
// This is the only pipeline in the platform that researches PRIVATE residents
// rather than people who already filed for office, so:
//   • public records only — no data brokers, no people-search aggregators,
//     no private/locked social accounts, no background-check data;
//   • protected attributes (race, religion, national origin, disability,
//     sexual orientation/gender identity, immigration status, health, and
//     criminal history unrelated to public political/civic conduct) are never
//     researched and never stored — prompt rule AND code filter;
//   • evidence, not verdicts — every claim ships with its source URL;
//   • thin evidence (< 2 independent public sources) ⇒ every field Unknown;
//   • no fabricated URLs — only links present in Perplexity's citations array
//     survive coerceResearchOutput()'s allow-list.

import { logAiUsage } from './_ai-usage.js'
import {
  coerceResearchOutput, researchOutputToRow, researchCacheKey,
  RETRYABLE_RESEARCH_STATUSES, cachedModelVersion,
} from '../../src/lib/recruit.js'
import { PLAN_CONFIG, RECRUIT_BATCH_CAP, getRecruitLookupLimit } from '../../src/lib/tiers.js'

// ── Cost controls (gameplan §3.5) ────────────────────────────────────────────
const BATCH_CAP        = RECRUIT_BATCH_CAP        // people researched per run
const WAVE_SIZE        = 5                        // concurrent people per wave
const CACHE_TTL_DAYS   = 90                       // reuse across searches/lists
const DEADLINE_MS      = 13 * 60 * 1000           // stop before Netlify's 15 min
const MODEL_VERSION    = 'sonar+haiku-4-5, v1'
const HAIKU_MODEL      = 'claude-haiku-4-5-20251001'
const USAGE_ENDPOINT   = 'recruit'

// Progress stages, mirrored by PHASE_LABELS in src/pages/Recruit.jsx.
const STAGE_PREPARE   = 1   // auth, entitlement, quota, prospect load
const STAGE_SEARCH    = 2   // Perplexity public-source sweep (per person)
const STAGE_STRUCTURE = 3   // Claude structuring + guardrail coercion
const STAGE_SAVE      = 4   // writing results back

// ── Prompts ──────────────────────────────────────────────────────────────────

/** Perplexity system prompt — the public-records-only stance, verbatim. */
export const RESEARCH_SYSTEM_PROMPT = `You research PUBLIC information about Wisconsin residents for candidate-recruitment purposes. You are researching a private resident who has NOT filed for office, so the standard is strict.

USE ONLY PUBLIC SOURCES: news coverage, .gov records (campaign finance filings, public meeting minutes and testimony, court records that are already public), self-published public professional/social profiles (LinkedIn, official campaign or organization pages), and civic-org listings (Ballotpedia, chamber of commerce, and similar). Do NOT use people-search or data-broker aggregators, do NOT use private or locked social accounts, and do NOT use purchased background-check data.

NEVER report protected attributes: race, religion, national origin, disability, sexual orientation or gender identity, immigration status, health or medical status, and criminal history unrelated to public political or civic conduct. Omit them even if a source mentions them.

EVIDENCE, NOT VERDICTS: report cited facts ("the local paper covered a 2019 zoning dispute"), never unqualified conclusions ("controversial"). Every claim must be traceable to a source you actually retrieved.

If you cannot confirm the person's identity, or you find fewer than 2 independent public sources about this specific person, say so plainly. Never guess, never fill gaps from general knowledge, and never confuse this person with a different person who shares the name.`

/** Claude structuring system prompt — thin-evidence and no-fabrication rules. */
export const STRUCTURING_SYSTEM_PROMPT = `You convert research notes about one Wisconsin resident into strict JSON for a candidate-recruitment tool.

HARD RULES:
1. Synthesize ONLY from the provided source excerpts and citation list. Do not add outside knowledge. Do not invent URLs that are not in the citations array provided.
2. If the research contains fewer than 2 INDEPENDENT public sources about this specific person, set affiliation, notoriety and sentiment ALL to "unknown". Thin evidence means unknown — never a guess.
3. Never output protected attributes: race, religion, national origin, disability, sexual orientation or gender identity, immigration status, health or medical status, or criminal history unrelated to public political or civic conduct. Omit any such detail entirely.
4. "sentiment" describes the tone of retrieved public coverage, not a judgment of the person. Base it on cited coverage only.
5. Every evidence item must be a URL that appears verbatim in the citations list.

Output ONLY this JSON object, no markdown:
{
  "affiliation": { "value": "republican|democrat|independent|other|unknown", "confidence": 0-100, "basis": "one sentence naming the source type" },
  "notoriety": "high|medium|low|unknown",
  "sentiment": "positive|mixed|negative|unknown",
  "evidence": [{ "title": "short source title", "url": "https://..." }],
  "summary": "2-3 sentence neutral synthesis, no unqualified adjectives"
}`

function personQuery(p) {
  const where = [p.city, p.county ? `${p.county} County` : null].filter(Boolean).join(', ')
  return `Search for public information about ${p.full_name}, a resident of ${where || 'Wisconsin'}, Wisconsin, in the context of local civic and political activity: party affiliation signals, elected or appointed roles, campaign donations on file with the Wisconsin Ethics Commission or FEC, public meeting testimony, community and civic leadership, and local news coverage.

Report what you can verify and name each source. If you find fewer than 2 independent public sources about THIS person, say "insufficient public sources" rather than reporting anything uncertain.`
}

// ── Perplexity ───────────────────────────────────────────────────────────────

function citationsOf(data) {
  const urls = []
  for (const c of data?.citations || []) if (typeof c === 'string') urls.push(c.trim())
  for (const r of data?.search_results || []) if (r?.url) urls.push(String(r.url).trim())
  return [...new Set(urls.filter(Boolean))]
}

async function perplexity({ apiKey, model, prompt, maxTokens, userId }) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 45000)
  try {
    const res = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST', signal: ctrl.signal,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: RESEARCH_SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
        max_tokens: maxTokens,
      }),
    })
    if (!res.ok) return null
    const data = await res.json()
    logAiUsage({
      userId, endpoint: USAGE_ENDPOINT, provider: 'perplexity', model,
      inputTokens: data?.usage?.prompt_tokens || 0,
      outputTokens: data?.usage?.completion_tokens || 0,
    })
    return { text: data.choices?.[0]?.message?.content || '', citations: citationsOf(data) }
  } catch (e) {
    console.warn('[recruit] perplexity failed:', e.message)
    return null
  } finally { clearTimeout(timer) }
}

// ── Research one person ──────────────────────────────────────────────────────

async function researchProspect(p, { PERPLEXITY_API_KEY, ANTHROPIC_API_KEY, userId }) {
  // 1. Cheap pass.
  let research = await perplexity({
    apiKey: PERPLEXITY_API_KEY, model: 'sonar', prompt: personQuery(p),
    maxTokens: 900, userId,
  })
  if (!research) throw new Error('Research service did not respond')

  // 2. Escalate ONLY when the cheap pass came back thin — keeps the expensive
  //    tier rare (gameplan §3.2 step 2).
  if (research.citations.length < 2) {
    const pro = await perplexity({
      apiKey: PERPLEXITY_API_KEY, model: 'sonar-pro',
      prompt: `${personQuery(p)}\n\nA first search found little. Check local news archives, Wisconsin campaign-finance filings, municipal meeting minutes and civic-organization listings specifically. If this name is common in the area, say so and do not attribute another person's record to them.`,
      maxTokens: 1400, userId,
    })
    if (pro && pro.citations.length > research.citations.length) {
      research = { text: `${research.text}\n\n${pro.text}`, citations: [...new Set([...research.citations, ...pro.citations])] }
    }
  }

  // 3. Structure with Haiku, fenced to the citations we actually retrieved.
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: HAIKU_MODEL,
      max_tokens: 1200,
      system: STRUCTURING_SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: `PERSON: ${p.full_name}${p.city ? `, ${p.city}` : ''}${p.county ? `, ${p.county} County` : ''}, Wisconsin

CITATIONS (the ONLY URLs you may output):
${research.citations.length ? research.citations.map((u, i) => `${i + 1}. ${u}`).join('\n') : '(none)'}

RESEARCH NOTES:
${research.text || '(no research returned)'}`,
      }],
    }),
  })
  if (!res.ok) throw new Error('Structuring failed')
  const data = await res.json()
  logAiUsage({
    userId, endpoint: USAGE_ENDPOINT, provider: 'anthropic', model: HAIKU_MODEL,
    inputTokens: data?.usage?.input_tokens || 0, outputTokens: data?.usage?.output_tokens || 0,
  })

  let parsed = {}
  try {
    const raw = (data.content?.find(b => b.type === 'text')?.text || '')
      .replace(/^```json?\s*/i, '').replace(/```\s*$/, '').trim()
    parsed = JSON.parse(raw)
  } catch {
    parsed = {}   // unreadable output is thin evidence by definition → Unknown
  }

  // The guardrails are enforced in code, not just in the prompt: unknown-on-thin
  // -evidence, protected-attribute scrubbing, and the citation allow-list.
  return coerceResearchOutput(parsed, { allowedUrls: research.citations })
}

// ── Handler ──────────────────────────────────────────────────────────────────

export const handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json',
  }
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' }
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) }

  const startedAt            = Date.now()
  const ANTHROPIC_API_KEY    = process.env.ANTHROPIC_API_KEY
  const PERPLEXITY_API_KEY   = process.env.PERPLEXITY_API_KEY
  const SUPABASE_URL         = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

  const sb = (path, opts = {}) => fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  })

  // Body first: without a search_id we cannot tell the client anything at all.
  let body
  try { body = JSON.parse(event.body || '{}') } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }
  }
  const searchId = String(body.search_id || '')
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(searchId)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'search_id required' }) }
  }

  // The client's only window into this run. Best-effort: a failed progress
  // write must never take down a run that is otherwise working.
  const reportStage = async (stage, status = 'running', message = null, counts = {}) => {
    try {
      await sb('recruitment_research_progress', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({
          search_id: searchId, stage, status, message,
          processed: counts.processed ?? 0,
          total: counts.total ?? 0,
          ...(stage === STAGE_PREPARE && status === 'running' ? { started_at: new Date().toISOString() } : {}),
          updated_at: new Date().toISOString(),
        }),
      })
    } catch (e) { console.warn('[recruit] reportStage failed:', e.message) }
  }
  const fail = async (message, stage = STAGE_PREPARE, code = 400) => {
    await reportStage(stage, 'error', message)
    try {
      await sb(`recruitment_searches?id=eq.${searchId}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ status: 'error', updated_at: new Date().toISOString() }),
      })
    } catch { /* progress row already carries the reason */ }
    return { statusCode: code, headers, body: JSON.stringify({ error: message }) }
  }

  try {
    // ── Auth ────────────────────────────────────────────────────────────────
    // Deliberately BEFORE the first progress write: the progress row is
    // service-role-written, so an unauthenticated caller who guessed a search
    // UUID should not be able to stamp "running" on someone else's search.
    // An unverified caller gets NO progress write at all — the signed-in page
    // falls back to its own no-heartbeat timeout, which is the correct outcome
    // for a request that could not prove who it is.
    const unauthed = { statusCode: 401, headers, body: JSON.stringify({ error: 'Not authenticated' }) }
    const authHeader = event.headers?.authorization || event.headers?.Authorization
    if (!authHeader?.startsWith('Bearer ')) return unauthed
    const authRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${authHeader.slice(7)}` },
    })
    if (!authRes.ok) return unauthed
    const authUser = await authRes.json()
    if (!authUser?.id) return unauthed

    await reportStage(STAGE_PREPARE, 'running')

    // ── Entitlement: Recruit is Action-plan exclusive (tiers.js features.recruit) ──
    const { resolveEntitlement } = await import('./_entitlements.js')
    const ent = await resolveEntitlement(authUser)
    if (!PLAN_CONFIG[ent.plan]?.features?.recruit) {
      return await fail('Recruit is included with Action plans — upgrade to run prospect research.', STAGE_PREPARE, 403)
    }

    // ── Rate limit (durable, cross-instance) ────────────────────────────────
    const { enforceRateLimit } = await import('./_rate-limit.js')
    const limited = await enforceRateLimit(authUser.id, 'recruit-research-background', headers)
    if (limited) {
      return await fail('You have run a lot of prospect research recently — give it a few minutes and try again.', STAGE_PREPARE, 429)
    }

    if (!PERPLEXITY_API_KEY || !ANTHROPIC_API_KEY) {
      return await fail('The research service is not configured right now. Nothing was saved.', STAGE_PREPARE, 502)
    }

    // ── Ownership: the search must belong to the caller ─────────────────────
    const searchRes = await sb(
      `recruitment_searches?id=eq.${searchId}&created_by=eq.${authUser.id}&select=id,name,attested_use,status,research_requested_count`
    )
    const search = (await searchRes.json())?.[0]
    if (!search) return await fail('That recruitment search could not be found on your account.', STAGE_PREPARE, 404)

    // ── Run-time attestation (gameplan §4) ──────────────────────────────────
    if (!search.attested_use) {
      return await fail('Confirm the recruitment-use attestation before running research.', STAGE_PREPARE, 400)
    }

    // ── Monthly quota ───────────────────────────────────────────────────────
    const monthStart = new Date()
    monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0)
    // Cache hits are excluded: a result served from the 90-day cache costs no
    // API call, so it must not spend a lookup. Cache-served rows are stamped
    // '… (cached)' in model_version below; `or=(is.null, not.like)` keeps rows
    // written before that stamp existed (model_version NULL) counted, because a
    // bare `not.like` is NULL — and therefore false — for a NULL column.
    const usedRes = await sb(
      `recruitment_prospects?created_by=eq.${authUser.id}&research_status=eq.done&researched_at=gte.${monthStart.toISOString()}` +
      `&or=(model_version.is.null,model_version.not.like.*cached*)&select=id`,
      { headers: { Prefer: 'count=exact', Range: '0-0' } }
    )
    const used = Number(String(usedRes.headers.get('content-range') || '').split('/')[1]) || 0
    const monthlyLimit = getRecruitLookupLimit(ent.plan)
    const remaining = Math.max(0, monthlyLimit - used)
    if (remaining <= 0) {
      return await fail(`You have used all ${monthlyLimit} Recruit lookups for this month. The allowance resets on the 1st.`, STAGE_PREPARE, 429)
    }

    // ── Pending prospects, capped per run ───────────────────────────────────
    // RETRYABLE_RESEARCH_STATUSES includes `skipped_quota`: those people were
    // parked when a previous run ran out of allowance and were never actually
    // researched, so a re-run with quota available has to pick them back up.
    const pendingRes = await sb(
      `recruitment_prospects?search_id=eq.${searchId}&research_status=in.(${RETRYABLE_RESEARCH_STATUSES.join(',')})&excluded=is.false&select=id,full_name,city,county,zip&order=last_name&limit=${BATCH_CAP}`
    )
    const pending = await pendingRes.json()
    if (!Array.isArray(pending) || pending.length === 0) {
      await reportStage(STAGE_SAVE, 'done', 'Everyone in this search has already been researched.', { processed: 0, total: 0 })
      await sb(`recruitment_searches?id=eq.${searchId}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ status: 'done', updated_at: new Date().toISOString() }),
      })
      return { statusCode: 200, headers, body: JSON.stringify({ processed: 0 }) }
    }

    const batch = pending.slice(0, Math.min(BATCH_CAP, remaining))
    const total = batch.length
    await sb(`recruitment_searches?id=eq.${searchId}`, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        status: 'researching',
        research_requested_count: (search.research_requested_count || 0) + total,
        quota_snapshot: { plan: ent.plan, bracket: ent.bracket, source: ent.source, monthly_limit: monthlyLimit, used_before_run: used, batch_cap: BATCH_CAP },
        updated_at: new Date().toISOString(),
      }),
    })
    await reportStage(STAGE_SEARCH, 'running', null, { processed: 0, total })

    // ── Cache lookup (90-day TTL, cross-search reuse; hits are free) ────────
    const cacheTtlIso = new Date(Date.now() - CACHE_TTL_DAYS * 86400 * 1000).toISOString()
    const keys = batch.map(p => researchCacheKey(p)).filter(Boolean)
    const cacheByKey = new Map()
    if (keys.length) {
      try {
        const inList = keys.map(k => `"${k.replace(/"/g, '')}"`).join(',')
        const cRes = await sb(
          `recruitment_prospects?research_cache_key=in.(${encodeURIComponent(inList)})&research_status=eq.done&researched_at=gte.${cacheTtlIso}&created_by=eq.${authUser.id}` +
          `&select=research_cache_key,affiliation_value,affiliation_confidence,affiliation_basis,notoriety,sentiment,evidence,research_summary,model_version&order=researched_at.desc`
        )
        for (const row of (await cRes.json()) || []) {
          if (row?.research_cache_key && !cacheByKey.has(row.research_cache_key)) cacheByKey.set(row.research_cache_key, row)
        }
      } catch (e) { console.warn('[recruit] cache lookup skipped:', e.message) }
    }

    // ── Research waves ──────────────────────────────────────────────────────
    let processed = 0
    let spent = 0            // lookups that actually cost money (cache misses)
    let deadlineHit = false

    for (let i = 0; i < batch.length; i += WAVE_SIZE) {
      if (Date.now() - startedAt > DEADLINE_MS) { deadlineHit = true; break }
      const wave = batch.slice(i, i + WAVE_SIZE)

      await Promise.all(wave.map(async (p) => {
        const cacheKey = researchCacheKey(p)
        const patch = { research_cache_key: cacheKey || null, researched_at: new Date().toISOString(), research_error: null }

        const cached = cacheKey ? cacheByKey.get(cacheKey) : null
        if (cached) {
          Object.assign(patch, {
            affiliation_value: cached.affiliation_value, affiliation_confidence: cached.affiliation_confidence,
            affiliation_basis: cached.affiliation_basis, notoriety: cached.notoriety, sentiment: cached.sentiment,
            evidence: cached.evidence || [], research_summary: cached.research_summary,
            // Stamped as cache-served so the monthly usage count above skips it:
            // this row cost no API call and must not spend a lookup.
            model_version: cachedModelVersion(cached.model_version || MODEL_VERSION),
            research_status: 'done',
          })
        } else if (spent >= remaining) {
          // Quota ran out mid-run: mark the rest honestly instead of silently
          // dropping them or spending past the allowance.
          Object.assign(patch, { research_status: 'skipped_quota', researched_at: null })
        } else {
          spent++
          try {
            const coerced = await researchProspect(p, { PERPLEXITY_API_KEY, ANTHROPIC_API_KEY, userId: authUser.id })
            Object.assign(patch, researchOutputToRow(coerced), { research_status: 'done', model_version: MODEL_VERSION })
          } catch (e) {
            Object.assign(patch, {
              research_status: 'error', researched_at: null,
              research_error: String(e.message || 'Research failed').slice(0, 300),
            })
          }
        }

        try {
          await sb(`recruitment_prospects?id=eq.${p.id}`, {
            method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(patch),
          })
        } catch (e) { console.warn('[recruit] prospect write failed:', e.message) }
      }))

      processed += wave.length
      await reportStage(processed >= total ? STAGE_STRUCTURE : STAGE_SEARCH, 'running', null, { processed, total })
    }

    // ── Save + terminal report ──────────────────────────────────────────────
    await reportStage(STAGE_SAVE, 'running', null, { processed, total })
    const doneRes = await sb(
      `recruitment_prospects?search_id=eq.${searchId}&research_status=eq.done&select=id`,
      { headers: { Prefer: 'count=exact', Range: '0-0' } }
    )
    const completed = Number(String(doneRes.headers.get('content-range') || '').split('/')[1]) || processed

    await sb(`recruitment_searches?id=eq.${searchId}`, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ status: 'done', research_completed_count: completed, updated_at: new Date().toISOString() }),
    })

    const note = deadlineHit
      ? 'This run hit its time budget — press Research again to continue where it stopped.'
      : (pending.length > total || batch.length === BATCH_CAP
        ? `Researched ${processed} of this search. Press Research again to continue (${BATCH_CAP} per run).`
        : null)
    await reportStage(STAGE_SAVE, 'done', note, { processed, total })
    return { statusCode: 200, headers, body: JSON.stringify({ processed, total, completed }) }

  } catch (err) {
    // A background invocation swallows thrown errors entirely — without this the
    // page would poll a status row that never leaves "running".
    console.error('[recruit] unhandled error:', err?.stack || err?.message || err)
    return await fail('Something went wrong while researching these prospects. Partial results were saved — try again.', STAGE_SEARCH, 500)
  }
}
