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
      await new Promise(r => setTimeout(r, 4000))  // pace the pipeline
    } catch (e) {
      results.push({ district: row.district, status: 'error', error: e.message })
    }
  }
  console.log(`[polling-refresh] queued ${results.length} district refreshes`)
  return { statusCode: 200, headers, body: JSON.stringify({ queued: results.length, results }) }
}
