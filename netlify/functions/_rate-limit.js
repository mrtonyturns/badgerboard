// netlify/functions/_rate-limit.js
// ─── Durable, cross-instance rate limiter for LLM-spending endpoints ─────────
// Prefixed with _ so Netlify does NOT deploy this as an endpoint.
//
// Backed by the public.rate_limits table (see migration 20260705000003) and the
// bump_rate_limit() SECURITY DEFINER function, called with the service role.
// Counts are kept per (user_id, endpoint, window): a 1-minute window and a
// UTC-day window, both incremented atomically in a single RPC.
//
// FAIL-OPEN by design: if the table/function has not been migrated yet, or the
// DB call errors, the request is allowed and a warning is logged. Rate limiting
// is a cost-control layer, not an auth layer — auth guards remain in each
// endpoint.
//
// Usage (CJS):  const { enforceRateLimit } = require('./_rate-limit')
// Usage (ESM):  import { enforceRateLimit } from './_rate-limit.js'
//
//   const limited = await enforceRateLimit(user.id, 'support-chat', headers)
//   if (limited) return limited            // 429 + Retry-After

const shared = require('./_shared')

/** Per-endpoint budgets. Keys MUST match the endpoint names passed by callers. */
const RATE_LIMITS = {
  'support-chat':                { perMinute: 20, perDay: 200 },
  'generate-campaign-intel':     { perMinute: 6,  perDay: 60  },
  'research-swot':               { perMinute: 6,  perDay: 60  },
  'discover-candidates':         { perMinute: 6,  perDay: 60  },
  'generate-dossier':            { perMinute: 4,  perDay: 40  },
  'generate-dossier-background': { perMinute: 4,  perDay: 40  },
  'research-incumbent':          { perMinute: 6,  perDay: 60  },
  'research-district-history':   { perMinute: 6,  perDay: 60  },
  'generate-prospecting':        { perMinute: 6,  perDay: 60  },
  'autofill-candidate':          { perMinute: 10, perDay: 100 },
  'generate-bio-summary':        { perMinute: 10, perDay: 100 },
  // BROADSIDE sparring sessions are rapid-fire spoken lines — higher per-minute
  'broadside-brain':             { perMinute: 40, perDay: 800 },
  'broadside-voice':             { perMinute: 40, perDay: 800 },
  'broadside-debrief':           { perMinute: 3,  perDay: 60  },
}

const DEFAULT_LIMITS = { perMinute: 10, perDay: 100 }

/**
 * Atomically record one hit and check budgets.
 * @param {string} userId        verified caller id (from JWT — never the body)
 * @param {string} endpoint      endpoint name (key into RATE_LIMITS)
 * @param {object} extraHeaders  response headers to merge into a 429 (CORS etc.)
 * @returns {Promise<object|null>}  null if allowed, else a Netlify 429 response
 */
async function enforceRateLimit(userId, endpoint, extraHeaders = {}) {
  if (!userId) return null
  const limits = RATE_LIMITS[endpoint] || DEFAULT_LIMITS
  const now = Date.now()
  const minuteStartMs = Math.floor(now / 60000) * 60000
  const d = new Date(now)
  const dayStartMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())

  let row
  try {
    const { data, error } = await shared.serviceClient().rpc('bump_rate_limit', {
      p_user_id:      userId,
      p_endpoint:     endpoint,
      p_minute_start: new Date(minuteStartMs).toISOString(),
      p_day_start:    new Date(dayStartMs).toISOString(),
    })
    if (error) {
      console.warn(`[rate-limit] ${endpoint}: limiter unavailable, failing open — ${error.message}`)
      return null
    }
    row = Array.isArray(data) ? data[0] : data
  } catch (e) {
    console.warn(`[rate-limit] ${endpoint}: limiter error, failing open — ${e.message}`)
    return null
  }
  if (!row) return null

  const build = (retryAfterSec, message) => ({
    statusCode: 429,
    headers: {
      'Content-Type': 'application/json',
      'Retry-After': String(Math.max(1, retryAfterSec)),
      ...extraHeaders,
    },
    body: JSON.stringify({ error: message, retry_after: Math.max(1, retryAfterSec) }),
  })

  if (row.day_count > limits.perDay) {
    const retry = Math.ceil((dayStartMs + 86400000 - now) / 1000)
    return build(retry, 'Daily limit for this feature reached. It resets at midnight UTC.')
  }
  if (row.minute_count > limits.perMinute) {
    const retry = Math.ceil((minuteStartMs + 60000 - now) / 1000)
    return build(retry, 'Too many requests — please slow down a moment.')
  }
  return null
}

module.exports = { enforceRateLimit, RATE_LIMITS, DEFAULT_LIMITS }
