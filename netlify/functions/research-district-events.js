// Netlify Function: research-district-events
// Finds upcoming community events in a district using Perplexity (web research)
// + Claude (structuring + political-lean classification), enriches with og:image
// thumbnails, and caches per district for 24 hours.
// Called in two steps (research → structure) to stay under the gateway limit.

const CACHE_HOURS = 24

export const handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json',
  }
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' }
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) }

  const ANTHROPIC_API_KEY    = process.env.ANTHROPIC_API_KEY
  const PERPLEXITY_API_KEY   = process.env.PERPLEXITY_API_KEY
  const SUPABASE_URL         = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

  const authHeader = event.headers?.authorization || event.headers?.Authorization
  if (!authHeader?.startsWith('Bearer ')) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Not authenticated' }) }
  }
  const authRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${authHeader.slice(7)}` },
  })
  if (!authRes.ok) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid token' }) }

  let body
  try { body = JSON.parse(event.body || '{}') } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }
  }
  const { district_key, district_name, area_description, district_lean, force, step, research: providedResearch } = body
  if (!district_key || !district_name) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'district_key, district_name required' }) }
  }

  const sb = (path, opts = {}) => fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  })

  // ── Cache (24h TTL) ─────────────────────────────────────────────────────────
  if (!force) {
    const cacheRes = await sb(`district_events?district_key=eq.${encodeURIComponent(district_key)}&select=events,fetched_at`)
    const rows = await cacheRes.json()
    const row = rows?.[0]
    if (row?.events && row.fetched_at && (Date.now() - new Date(row.fetched_at).getTime()) < CACHE_HOURS * 3600 * 1000) {
      return { statusCode: 200, headers, body: JSON.stringify({ cached: true, events: row.events, fetched_at: row.fetched_at }) }
    }
  }

  // ── Step 1: Perplexity research ─────────────────────────────────────────────
  let research = providedResearch || null
  if (!research && PERPLEXITY_API_KEY) {
    try {
      const ctrl = new AbortController()
      setTimeout(() => ctrl.abort(), 18000)
      const today = new Date().toISOString().slice(0, 10)
      const pRes = await fetch('https://api.perplexity.ai/chat/completions', {
        method: 'POST', signal: ctrl.signal,
        headers: { Authorization: `Bearer ${PERPLEXITY_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'sonar',
          messages: [
            { role: 'system', content: 'You are a Wisconsin community events researcher helping a political campaign find public events to attend. Be specific about dates, times, venues, and organizers. Only include real, verifiable upcoming events.' },
            { role: 'user', content: `Today is ${today}. Search for upcoming public events happening in the next 60 days in and around these Wisconsin communities: ${area_description || district_name}. Search for things like "${(area_description || '').split(',')[0] || 'Wisconsin'} events calendar 2026", county fair schedules, farmers markets, summer festivals, parades, chamber of commerce calendars, county Republican and Democratic party event pages, and union events for this area. List every real event you find (aim for 10-16). For each: exact name, date(s), start time, venue and city, organizer/host, a one-sentence description, and the event website URL if one exists. These communities are in ${district_name}. Only include events you can verify from actual sources.` }
          ],
          max_tokens: 2500,
        }),
      })
      if (pRes.ok) {
        const pData = await pRes.json()
        research = pData.choices?.[0]?.message?.content || null
      }
    } catch (e) { console.warn('[district-events] Perplexity failed:', e.message) }
  }
  if (!research) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: 'Event research unavailable — try again shortly' }) }
  }
  if (step === 'research') {
    return { statusCode: 200, headers, body: JSON.stringify({ step: 'research', research }) }
  }

  // ── Step 2: Claude structures + classifies lean ─────────────────────────────
  const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4000,
      messages: [{
        role: 'user',
        content: `Convert this event research for ${district_name}, Wisconsin into strict JSON. The district's overall voter lean is ${district_lean || 'unknown'}.

Schema — an array "events":
{
  "events": [
    {
      "name": "Event Name",
      "date_start": "2026-07-17",
      "date_end": "2026-07-20" or null,
      "time": "9:00 AM" or null,
      "venue": "Venue name",
      "city": "City",
      "host": "Organizer" or null,
      "description": "One sentence describing the event and why a campaign would attend.",
      "category": "fair" | "market" | "festival" | "parade" | "civic" | "party" | "labor" | "church" | "other",
      "url": "https://..." or null,
      "lean": {
        "label": "confirmed_conservative" | "likely_conservative" | "nonpartisan" | "likely_liberal" | "confirmed_liberal",
        "certainty": 0-100,
        "score": -100 to 100,
        "basis": "short reason (host, event type, area lean)"
      }
    }
  ]
}
Lean rules — be strict:
- "confirmed_*" ONLY when the HOST is explicitly partisan (party organizations, partisan candidate events): certainty 100.
- "likely_*" when strong signals put certainty at 80-99 (labor unions → likely_liberal; rural patriotic/agricultural events in heavily R areas with other signals; progressive advocacy groups → likely_liberal).
- Everything else is "nonpartisan" (fairs, markets, chamber, civic) with certainty below 80; set score to the AREA's lean context, not the event's.
- "score": negative = liberal, positive = conservative, drives a marker on a lean bar.
Only include events with a real date in the next ~60 days. Output ONLY the JSON object.

RESEARCH:
${research}`,
      }],
    }),
  })
  if (!claudeRes.ok) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: 'Event structuring failed' }) }
  }
  const cData = await claudeRes.json()
  let parsed
  try {
    const raw = (cData.content?.[0]?.text || '').replace(/^```json?\s*/i, '').replace(/```\s*$/, '').trim()
    parsed = JSON.parse(raw)
  } catch {
    return { statusCode: 502, headers, body: JSON.stringify({ error: 'Could not parse event output' }) }
  }
  let events = (parsed.events || []).filter(e => e?.name && e?.date_start)

  // ── og:image enrichment (best-effort, tight budget) ────────────────────────
  const withUrls = events.filter(e => e.url).slice(0, 8)
  await Promise.all(withUrls.map(async (e) => {
    try {
      const ctrl = new AbortController()
      setTimeout(() => ctrl.abort(), 3500)
      const res = await fetch(e.url, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BadgerBoard/1.0)' } })
      if (!res.ok) return
      const html = (await res.text()).slice(0, 60000)
      const m = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
        || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i)
      if (m?.[1] && /^https?:\/\//.test(m[1])) e.image = m[1]
    } catch (_) { /* no image — card uses category visual */ }
  }))

  const fetched_at = new Date().toISOString()
  await sb('district_events', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ district_key, name: district_name, events, fetched_at, updated_at: fetched_at }),
  })

  return { statusCode: 200, headers, body: JSON.stringify({ cached: false, events, fetched_at }) }
}
