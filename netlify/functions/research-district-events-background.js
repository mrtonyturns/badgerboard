// Netlify Function: research-district-events
// Finds upcoming community events in a district using Perplexity (web research)
// + Claude (structuring + political-lean classification), enriches with og:image
// thumbnails, and caches per district for 24 hours.
// Runs as a Netlify BACKGROUND function (-background suffix → 15 min budget):
// the client gets a 202 immediately and polls the district_events cache row.

import COUNTY_SOURCES from './_county-sources.json'

const CACHE_HOURS = 24

/** Build a per-county source brief for the research prompts. */
function countySourceBrief(counties = []) {
  const parts = []
  for (const c of counties.slice(0, 5)) {
    const src = COUNTY_SOURCES[c]
    if (!src) continue
    const lines = []
    if (src.newspapers?.length)      lines.push(`newspapers: ${src.newspapers.join('; ')}`)
    if (src.broadcast?.length)       lines.push(`TV/radio: ${src.broadcast.join('; ')}`)
    if (src.chambers_tourism?.length) lines.push(`chambers/tourism: ${src.chambers_tourism.join('; ')}`)
    if (src.gov_calendars?.length)   lines.push(`government calendars: ${src.gov_calendars.join('; ')}`)
    if (src.community?.length)       lines.push(`community orgs/pages: ${src.community.join('; ')}`)
    if (src.prompt_hint)             lines.push(`tip: ${src.prompt_hint}`)
    parts.push(`${c} County —\n  ${lines.join('\n  ')}`)
  }
  return parts.join('\n')
}


// ── HTML metadata extraction ──────────────────────────────────────────────────
const EXPIRING_CDN = /(^|\.)fbcdn\.net$|(^|\.)fbsbx\.com$/i

function absolutize(src, base) {
  try {
    const u = new URL(String(src), base)
    if (!/^https?:$/.test(u.protocol)) return null
    if (EXPIRING_CDN.test(u.hostname)) return null   // signed URLs that expire
    return u.href
  } catch { return null }
}

/** Pull image + event details from a page: JSON-LD schema.org/Event first,
 *  then og:image / twitter:image / link rel=image_src. */
function extractEventMeta(html, pageUrl) {
  const out = {}

  // 1. JSON-LD (authoritative when present)
  for (const b of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const nodes = []
      const walk = (n) => {
        if (!n) return
        if (Array.isArray(n)) return n.forEach(walk)
        if (typeof n === 'object') { nodes.push(n); if (n['@graph']) walk(n['@graph']) }
      }
      walk(JSON.parse(b[1].trim()))
      const ev = nodes.find(n => /(^|\W)Event/i.test(String(n['@type'] || '')))
      if (!ev) continue
      const rawImg = Array.isArray(ev.image) ? ev.image[0] : ev.image
      const imgUrl = typeof rawImg === 'object' ? rawImg?.url : rawImg
      if (imgUrl) out.image = absolutize(imgUrl, pageUrl)
      if (ev.startDate) {
        out.date_start = String(ev.startDate).slice(0, 10)
        const t = String(ev.startDate).match(/T(\d{2}:\d{2})/)
        if (t) out.time = t[1]
      }
      if (ev.endDate) out.date_end = String(ev.endDate).slice(0, 10)
      const loc = Array.isArray(ev.location) ? ev.location[0] : ev.location
      if (loc?.name) out.venue = String(loc.name)
      const addr = loc?.address
      if (typeof addr === 'string') out.address = addr
      else if (addr?.streetAddress) {
        out.address = [addr.streetAddress, addr.addressLocality].filter(Boolean).join(', ')
      }
      break
    } catch { /* malformed JSON-LD block — try the next one */ }
  }

  // 2. Meta-tag fallbacks for the image — try each candidate until one
  // survives absolutize() (which rejects non-http and expiring-CDN URLs)
  if (!out.image) {
    const candidates = [
      html.match(/<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]+content=["']([^"']+)["']/i),
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image(?::secure_url)?["']/i),
      html.match(/<meta[^>]+name=["']twitter:image(?::src)?["'][^>]+content=["']([^"']+)["']/i),
      html.match(/<link[^>]+rel=["']image_src["'][^>]+href=["']([^"']+)["']/i),
    ]
    for (const m of candidates) {
      const abs = m?.[1] ? absolutize(m[1], pageUrl) : null
      if (abs) { out.image = abs; break }
    }
  }
  if (out.image === null) delete out.image
  return out
}

export const handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json',
  }
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' }
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) }

  const ANTHROPIC_API_KEY    = process.env.ANTHROPIC_API_KEY
  const CLAUDE_MODEL         = process.env.CLAUDE_RESEARCH_MODEL || 'claude-opus-4-8' // Opus 4.8 (per request)
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
  const { district_key, district_name, area_description, district_lean, counties, force } = body
  const sourceBrief = countySourceBrief(Array.isArray(counties) ? counties : [])
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
  let research = null
  if (PERPLEXITY_API_KEY) {
    try {
      const ctrl = new AbortController()
      setTimeout(() => ctrl.abort(), 60000)
      const today = new Date().toISOString().slice(0, 10)
      const pRes = await fetch('https://api.perplexity.ai/chat/completions', {
        method: 'POST', signal: ctrl.signal,
        headers: { Authorization: `Bearer ${PERPLEXITY_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'sonar-pro',
          messages: [
            { role: 'system', content: 'You are a Wisconsin community events researcher helping a political campaign find public events to attend. Be specific about dates, times, venues, and organizers. Include well-known annual and recurring events (county fairs, farmers markets, festivals, parades) that fall in the window based on their usual schedule even if the current-year page is sparse — note when a date is approximate. Never invent one-off events.' },
            { role: 'user', content: `Today is ${today}. Search for upcoming public events happening in the next 60 days in and around these Wisconsin communities: ${area_description || district_name}. Search for things like "${(area_description || '').split(',')[0] || 'Wisconsin'} events calendar 2026", county fair schedules, farmers markets, summer festivals, parades, chamber of commerce calendars, county Republican and Democratic party event pages, and union events for this area. List every event you find (aim for 10-16), including recurring weekly ones (farmers markets) and annual ones whose usual dates fall in the window — mark approximate dates. ONLY include events open to the general public with no invitation, membership, or private registration required — skip private parties, members-only club events, and invite-only gatherings. For each: name, date(s), start time, venue with its STREET ADDRESS and city, organizer/host, a one-sentence description, and the event website URL if known. These communities are in ${district_name}, Wisconsin.${sourceBrief ? ` Check these county-specific sources known to publish local events:\n${sourceBrief}` : ''}` }
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
  // ── Supplementary sources: X (Twitter) + local news outlets ─────────────────
  const placeList = (area_description || district_name).split('(')[0].split(',').map(x => x.trim()).filter(Boolean).slice(0, 4)

  let xPosts = null
  if (process.env.X_BEARER_TOKEN && placeList.length) {
    try {
      const ctrlX = new AbortController()
      setTimeout(() => ctrlX.abort(), 12000)
      const q = `(${placeList.map(pl => `"${pl}"`).join(' OR ')}) (event OR festival OR parade OR fair OR "farmers market" OR concert OR fundraiser OR "town hall" OR happening) -is:retweet lang:en`
      const xr = await fetch(`https://api.x.com/2/tweets/search/recent?query=${encodeURIComponent(q)}&max_results=25&tweet.fields=created_at,author_id&expansions=author_id&user.fields=username,name`, {
        signal: ctrlX.signal,
        headers: { Authorization: `Bearer ${process.env.X_BEARER_TOKEN}` },
      })
      if (xr.ok) {
        const xd = await xr.json()
        const users = Object.fromEntries((xd.includes?.users || []).map(u => [u.id, u]))
        const rows = (xd.data || []).map(t => {
          const u = users[t.author_id] || {}
          return `@${u.username || 'unknown'} (${u.name || ''}) on ${String(t.created_at).slice(0, 10)}: ${t.text.replace(/\s+/g, ' ').slice(0, 260)}`
        })
        if (rows.length) xPosts = rows.join('\n')
      } else {
        console.warn('[district-events] X search HTTP', xr.status)
      }
    } catch (e) { console.warn('[district-events] X search skipped:', e.message) }
  }

  let newsResearch = null
  if (PERPLEXITY_API_KEY) {
    try {
      const ctrlN = new AbortController()
      setTimeout(() => ctrlN.abort(), 21000)
      const nr = await fetch('https://api.perplexity.ai/chat/completions', {
        method: 'POST', signal: ctrlN.signal,
        headers: { Authorization: `Bearer ${PERPLEXITY_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'sonar',
          messages: [
            { role: 'system', content: 'You research LOCAL NEWS coverage of upcoming community events in Wisconsin. Prefer local TV stations, local newspapers, and city/chamber announcement pages. Name the outlet for every item.' },
            { role: 'user', content: `Check local news outlets and their community/event calendars covering ${placeList.join(', ')}, Wisconsin.${sourceBrief ? ` Prioritize these county-specific sources:\n${sourceBrief}` : ' Check local TV, local papers and city weeklies, chamber and city hall announcements.'}\nWhat upcoming public events in the next 60 days have they announced or covered? For each: event name, date, time, venue with street address, city, host, one-sentence description, the OUTLET that reported it, and the article/calendar URL if available.` }
          ],
          max_tokens: 1800,
        }),
      })
      if (nr.ok) {
        const nd = await nr.json()
        newsResearch = nd.choices?.[0]?.message?.content || null
      }
    } catch (e) { console.warn('[district-events] news pass skipped:', e.message) }
  }

  if (!research) {
    // Research source unavailable (e.g. Perplexity credits exhausted). Never
    // overwrite an existing good cache — only mark empty if nothing was cached.
    const existing = await (await sb(`district_events?district_key=eq.${encodeURIComponent(district_key)}&select=events`)).json()
    if (!existing?.[0]?.events?.length) {
      const fetched_at = new Date().toISOString()
      await sb('district_events', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ district_key, name: district_name, events: [], fetched_at, updated_at: fetched_at }),
      })
    }
    return { statusCode: 502, headers, body: JSON.stringify({ error: 'Event research unavailable' }) }
  }

  // ── Step 2: Claude structures + classifies lean ─────────────────────────────
  const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 9000,
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
      "address": "street address (e.g. 1582 Kronenwetter Dr) or null",
      "city": "City",
      "host": "Organizer" or null,
      "description": "One sentence describing the event and why a campaign would attend.",
      "category": "fair" | "market" | "festival" | "parade" | "civic" | "party" | "labor" | "church" | "other",
      "url": "https://..." or null,
      "source": "web" | "news" | "x",
      "source_note": "attribution, e.g. 'Wausau Pilot & Review' or '@WausauChamber on X'" or null,
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
Include EVERY event from the research that is public and has a usable date in the next ~60 days — do not drop events merely because a date is approximate (keep them, using the best-estimate date). Recurring weekly events get one entry starting at the next occurrence.
PUBLIC-ONLY RULE: include only events open to the general public. EXCLUDE anything private, invite-only, members-only, or requiring approval to attend (private fundraisers with invitation lists, closed club meetings, school-family-only events). Free-and-open government meetings, fairs, markets, festivals, and ticketed-but-open events all count as public. Output ONLY the JSON object.

Merge events found across ALL sources below and dedupe by name, keeping the fullest details for each event. SOURCE LABELING (strict): if an event appears in LOCAL NEWS RESEARCH, set source="news" and source_note to the outlet name (e.g. "Wausau Pilot & Review") — even if it also appears in web research. If an event appears only in the X posts, set source="x" and source_note to the handle (e.g. "@WausauChamber on X"). Otherwise source="web" with source_note null. Events found ONLY on X must clearly be real public events with a date — skip vague chatter, national politics, and anything that is not a local event announcement.

WEB RESEARCH:
${research}

LOCAL NEWS RESEARCH:
${newsResearch || '(none available)'}

RECENT X (TWITTER) POSTS FROM THE AREA:
${xPosts || '(none available)'}`,
      }],
    }),
  })
  if (!claudeRes.ok) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: 'Event structuring failed' }) }
  }
  const cData = await claudeRes.json()
  let parsed
  try {
    const raw = (cData.content?.find(b => b.type === 'text')?.text || '').replace(/^```json?\s*/i, '').replace(/```\s*$/, '').trim()
    parsed = JSON.parse(raw)
  } catch {
    return { statusCode: 502, headers, body: JSON.stringify({ error: 'Could not parse event output' }) }
  }
  let events = (parsed.events || []).filter(e => e?.name && e?.date_start)

  // Thin result (search variance): one supplemental research pass, merged + deduped.
  if (events.length < 6 && PERPLEXITY_API_KEY) {
    try {
      const ctrl2 = new AbortController()
      setTimeout(() => ctrl2.abort(), 21000)
      const p2 = await fetch('https://api.perplexity.ai/chat/completions', {
        method: 'POST', signal: ctrl2.signal,
        headers: { Authorization: `Bearer ${PERPLEXITY_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'sonar-pro',
          messages: [
            { role: 'system', content: 'You are a Wisconsin community events researcher. Only public events. Include street addresses.' },
            { role: 'user', content: `List public community events (fairs, markets, festivals, parades, concerts, civic meetings, party events) in the next 60 days near ${area_description || district_name}, Wisconsin that are NOT in this list: ${events.map(e => e.name).join('; ') || 'none'}. Name, date, time, venue with street address, city, host, one-sentence description, URL if known.` }
          ],
          max_tokens: 2000,
        }),
      })
      if (p2.ok) {
        const d2 = await p2.json()
        const extra = d2.choices?.[0]?.message?.content
        if (extra) {
          const c2 = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: CLAUDE_MODEL, max_tokens: 6000,
              messages: [{ role: 'user', content: `Convert to the same strict JSON schema {"events":[...]} used before (name, date_start, date_end, time, venue, address, city, host, description, category, url, lean{label,certainty,score,basis}). Public events only, next 60 days, district lean ${district_lean || 'unknown'}. Output ONLY JSON.

RESEARCH:
${extra}` }],
            }),
          })
          if (c2.ok) {
            const cd2 = await c2.json()
            const raw2 = (cd2.content?.find(b => b.type === 'text')?.text || '').replace(/^```json?\s*/i, '').replace(/```\s*$/, '').trim()
            const more = (JSON.parse(raw2).events || []).filter(e => e?.name && e?.date_start)
            const seen = new Set(events.map(e => e.name.toLowerCase()))
            for (const e of more) if (!seen.has(e.name.toLowerCase())) { events.push(e); seen.add(e.name.toLowerCase()) }
          }
        }
      }
    } catch (e) { console.warn('[district-events] supplemental pass skipped:', e.message) }
  }

  // ── Image + detail enrichment (JSON-LD Event > og:image > twitter:image) ───
  // Event pages very often embed schema.org/Event JSON-LD with authoritative
  // dates, venue, address, AND an image. Fall back to og/twitter meta tags.
  // Images are later served through the Netlify Image CDN proxy, so any
  // https URL works — but skip expiring CDNs (Facebook) that die in days.
  const withUrls = events.filter(e => e.url).slice(0, 16)
  await Promise.all(withUrls.map(async (e) => {
    try {
      const ctrl = new AbortController()
      setTimeout(() => ctrl.abort(), 5000)
      const res = await fetch(e.url, {
        signal: ctrl.signal, redirect: 'follow',
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BadgerBoard/1.0; +https://badgerboardwi.com)' },
      })
      if (!res.ok || !/text\/html/i.test(res.headers.get('content-type') || '')) return
      const html = (await res.text()).slice(0, 250000)
      const meta = extractEventMeta(html, res.url || e.url)
      // Fill details the research pass missed (never overwrite existing values)
      if (meta.date_start && !e.date_start) e.date_start = meta.date_start
      if (meta.date_end   && !e.date_end)   e.date_end   = meta.date_end
      if (meta.time       && !e.time)       e.time       = meta.time
      if (meta.venue      && !e.venue)      e.venue      = meta.venue
      if (meta.address    && !e.address)    e.address    = meta.address
      if (meta.image) e.image = meta.image
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
