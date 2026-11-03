// netlify/functions/_models.js
// ─── Single source of truth for every AI model the platform calls ───────────
// Prefixed with _ so Netlify does NOT deploy this as an endpoint.
//
// Updated 2026-11-02 to the current generation (sources: platform.claude.com
// models overview + per-model migration guides, docs.x.ai, ai.google.dev,
// docs.perplexity.ai). Change an ID here and every function follows.
//
// Claude 5.5 request rules (all three tiers):
//   • omit temperature / top_p / top_k (400 if sent)
//   • adaptive thinking is on by default and its tokens count toward max_tokens
//     — Opus 5.5 can't turn it off; Sonnet 5.5 uses thinking:{type:'between_tools'}
//     to skip up-front thinking; Haiku 5.5 accepts thinking:{type:'disabled'}
//   • output_config.effort (low|medium|high|xhigh|max) is the cost/latency dial
//   • responses may START with thinking blocks — never read content[0].text,
//     use claudeText() below
//
// Usage (CJS):  const { MODELS, CLAUDE, claudeText, claudeFetch } = require('./_models')
// Usage (ESM):  import { MODELS, CLAUDE, claudeText, claudeFetch } from './_models.js'

const MODELS = {
  // Anthropic — three tiers. QUALITY writes the long reports (dossiers, district
  // intel, event research synthesis); BALANCED is the real-time sparring partner;
  // FAST does classification, extraction, support chat and other high-volume work.
  CLAUDE_QUALITY:  'claude-opus-5-5',
  CLAUDE_BALANCED: 'claude-sonnet-5-5',
  CLAUDE_FAST:     'claude-haiku-5-5',
  // Perplexity — cited web research (sonar-pro = deep, sonar = quick/cheap)
  PPLX_PRO: 'sonar-pro',
  PPLX:     'sonar',
  // xAI — Responses API with server-side x_search + web_search
  GROK:     'grok-4.7',
  // Google — second-opinion estimator in the polling pipeline
  GEMINI:   'gemini-3.8-flash',
}

// Per-tier request options to spread into a Messages API body.
//   QUALITY : adaptive thinking stays on (Opus 5.5 can't disable it); medium
//             effort is the model default — set explicitly so a future default
//             change can't silently raise cost. Give max_tokens room for
//             thinking + the answer (see claudeMaxTokens).
//   BALANCED: no up-front thinking, low effort — these are 160-token spoken
//             lines with a 12s budget.
//   FAST    : thinking off, so max_tokens is the text budget exactly as it was
//             on Haiku 4.5 (classification / extraction don't need it).
const CLAUDE = {
  QUALITY:  { output_config: { effort: 'medium' } },
  BALANCED: { thinking: { type: 'between_tools' }, output_config: { effort: 'low' } },
  FAST:     { thinking: { type: 'disabled' } },
}

/**
 * max_tokens for a QUALITY (adaptive-thinking) call: the old text budget plus
 * headroom for thinking, which counts toward the same cap. Doubling keeps the
 * reply from being cut off when the model reasons first.
 */
function claudeMaxTokens(textBudget) {
  return Math.min(128000, Math.max(2048, Math.round(textBudget * 2)))
}

/** Join every text block of a Messages API response (skips thinking/tool blocks). */
function claudeText(data) {
  return (data?.content || []).filter(b => b && b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('')
}

// Request fields that the 5.5 generation rejects or that a stale caller might
// still send. If the API answers 400 and names one of them, strip and retry once
// so a model-generation change never takes a feature down with it.
const RETRYABLE_FIELDS = ['thinking', 'output_config', 'temperature', 'top_p', 'top_k']

/**
 * POST to /v1/messages with a safety net: on a 400 that mentions one of the
 * generation-specific fields, remove those fields and retry once.
 * @param {object} o
 * @param {string} o.apiKey
 * @param {object} o.body         Messages API body (model, max_tokens, messages, …)
 * @param {AbortSignal} [o.signal]
 * @param {object} [o.headers]    extra headers (e.g. anthropic-beta)
 * @returns {Promise<Response>}   the fetch Response (caller checks .ok / .json())
 */
async function claudeFetch({ apiKey, body, signal, headers = {} }) {
  const post = (b) => fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal,
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(b),
  })
  const res = await post(body)
  if (res.status !== 400) return res
  const hasRetryable = RETRYABLE_FIELDS.some(k => k in body)
  if (!hasRetryable) return res
  let detail = ''
  try { detail = await res.clone().text() } catch { /* fall through */ }
  if (!RETRYABLE_FIELDS.some(k => detail.includes(k))) return res
  const stripped = { ...body }
  for (const k of RETRYABLE_FIELDS) delete stripped[k]
  console.warn(`[models] Anthropic 400 on ${body.model} (${detail.slice(0, 160)}) — retrying without ${RETRYABLE_FIELDS.filter(k => k in body).join('/')}`)
  return post(stripped)
}

module.exports = { MODELS, CLAUDE, claudeMaxTokens, claudeText, claudeFetch }
