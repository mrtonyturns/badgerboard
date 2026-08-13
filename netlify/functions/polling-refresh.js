// Netlify Scheduled Function: polling-refresh (v1.22)
// Monday 16:00 UTC — re-generates every EXISTING poll snapshot (districts a
// beta user has looked at before) so the Polling section stays weekly-fresh.
// Never generates new districts on its own.

const nodeCrypto = require('crypto')
function safeEqual(a, b) {
  const A = nodeCrypto.createHash('sha256').update(String(a ?? '')).digest()
  const B = nodeCrypto.createHash('sha256').update(String(b ?? '')).digest()
  return nodeCrypto.timingSafeEqual(A, B)
}

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY
const SITE_URL     = process.env.URL || 'https://badgerboardwi.com'
const MAX_PER_RUN  = 25   // cost cap

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json' }
  const isHttp = Boolean(event.httpMethod)
  if (isHttp) {
    const secret = process.env.ADMIN_TRIGGER_SECRET
    const provided = event.headers?.['x-admin-trigger'] || event.headers?.['X-Admin-Trigger']
    if (!secret || !safeEqual(provided, secret)) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Not authorized' }) }
    }
  }

  // Without Supabase credentials the query below silently returns [] and the
  // run reports "queued 0" as if there were simply nothing to refresh. A
  // misconfigured deployment should be loud.
  if (!SUPABASE_URL || !SERVICE_KEY) {
    console.error('[polling-refresh] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured')
    return { statusCode: 503, headers, body: JSON.stringify({ error: 'Supabase is not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing)' }) }
  }
  if (!process.env.ADMIN_TRIGGER_SECRET) {
    console.error('[polling-refresh] ADMIN_TRIGGER_SECRET not configured — the background function would reject every trigger')
    return { statusCode: 503, headers, body: JSON.stringify({ error: 'ADMIN_TRIGGER_SECRET is not configured' }) }
  }

  const res = await fetch(`${SUPABASE_URL}/rest/v1/poll_snapshots?select=district,generated_at&user_id=eq.00000000-0000-0000-0000-000000000000&order=generated_at.asc&limit=${MAX_PER_RUN}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  })
  const rows = res.ok ? await res.json() : []
  const results = []
  for (const row of rows) {
    try {
      await fetch(`${SITE_URL}/.netlify/functions/polling-snapshot-background`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ district: row.district, internal_trigger: process.env.ADMIN_TRIGGER_SECRET }),
      })
      results.push({ district: row.district, status: 'queued' })
      // No sleep between triggers. polling-snapshot-background is a Netlify
      // `-background` function: the POST above returns 202 the moment it is
      // accepted and the real work runs out-of-band, so pacing here bought
      // nothing and spent up to MAX_PER_RUN × 4s of this function's own
      // (much shorter) execution budget — long runs were being killed
      // mid-loop, leaving the tail of the list unrefreshed.
    } catch (e) {
      results.push({ district: row.district, status: 'error', error: e.message })
    }
  }
  console.log(`[polling-refresh] queued ${results.length} district refreshes`)
  return { statusCode: 200, headers, body: JSON.stringify({ queued: results.length, results }) }
}
