// netlify/functions/_ai-usage.js
// ─── Real AI cost metering (v1.20) ───────────────────────────────────────────
// One row per AI API call into public.ai_usage. Fire-and-forget: metering
// must NEVER break or slow the user-facing path.
//
// Usage (CJS):  const { logAiUsage } = require('./_ai-usage')
// Usage (ESM):  import { logAiUsage } from './_ai-usage.js'
//
//   logAiUsage({ userId, endpoint: 'profiler', provider: 'anthropic',
//                model: 'claude-opus-4-8', inputTokens, outputTokens })
//
// endpoint = app section key (profiler | events | district-intel | broadside |
// support-chat | prospecting | campaign-intel | ...) so the dashboard can show
// which parts of the app cost the most.

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY

// $ per MILLION tokens; flat = fixed per-call fee (Perplexity search fees).
// estimate = flat per-call cost used when the provider's usage block is
// unavailable at the call site.
const PRICING = {
  'claude-opus-4-8':           { in: 5.00, out: 25.00 },
  'claude-sonnet-4':           { in: 3.00, out: 15.00 },
  'claude-sonnet':             { in: 3.00, out: 15.00 },
  'claude-haiku-4-5-20251001': { in: 0.80, out: 4.00  },
  'claude-haiku':              { in: 0.80, out: 4.00  },
  'sonar-pro':                 { in: 3.00, out: 15.00, flat: 0.006 },
  'sonar':                     { in: 1.00, out: 1.00,  flat: 0.005 },
  'grok-4.3':                  { in: 3.00, out: 15.00, flat: 0.02 },  // + server-side search tools
}
const DEFAULT_PRICE = { in: 3.00, out: 15.00 }

function priceFor(model) {
  if (!model) return DEFAULT_PRICE
  if (PRICING[model]) return PRICING[model]
  const key = Object.keys(PRICING).find(k => String(model).startsWith(k))
  return key ? PRICING[key] : DEFAULT_PRICE
}

/**
 * Log one AI call. Never throws; never awaited on the hot path if you don't want to.
 * @param {object} o
 * @param {string|null} o.userId       verified caller id (null for cron/system)
 * @param {string} o.endpoint          app section key
 * @param {string} o.provider          anthropic | perplexity | xai
 * @param {string} o.model
 * @param {number} [o.inputTokens]     from the provider's usage block
 * @param {number} [o.outputTokens]
 * @param {number} [o.flatUsd]         override/add a flat cost (when no tokens)
 * @param {boolean} [o.estimated]      mark as estimate (no real token counts)
 */
async function logAiUsage({ userId = null, endpoint, provider, model, inputTokens = 0, outputTokens = 0, flatUsd = 0, estimated = false }) {
  try {
    if (!SUPABASE_URL || !SERVICE_KEY || !endpoint || !provider) return
    const p = priceFor(model)
    const tokenCost = (inputTokens / 1e6) * p.in + (outputTokens / 1e6) * p.out
    const cost = tokenCost + (p.flat || 0) + flatUsd
    await fetch(`${SUPABASE_URL}/rest/v1/ai_usage`, {
      method: 'POST',
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        user_id: userId || null,
        endpoint,
        provider,
        model: model || null,
        input_tokens: Math.max(0, Math.round(inputTokens)),
        output_tokens: Math.max(0, Math.round(outputTokens)),
        cost_usd: Math.round(cost * 1e6) / 1e6,
        estimated: estimated || (!inputTokens && !outputTokens),
      }),
    })
  } catch (e) {
    console.warn('[ai-usage] log skipped:', e.message)
  }
}

module.exports = { logAiUsage, priceFor }
