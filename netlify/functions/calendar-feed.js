// Netlify Function: calendar-feed
// Serves a user's personal Badger Board calendar feed as an iCalendar (.ics)
// document. The unguessable token in the URL is the authentication — users
// subscribe their Google/Apple/Outlook calendar to this URL once, and events
// they add from the Events page appear automatically with their reminder.

const esc = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n')
const dt = (iso, time) => {
  // All-day if no time; otherwise local floating time (WI local)
  const d = iso.replace(/-/g, '')
  if (!time) return { start: `;VALUE=DATE:${d}`, end: null }
  const m = String(time).match(/(\d{1,2}):?(\d{2})?\s*(AM|PM)?/i)
  let h = m ? parseInt(m[1]) : 9
  const min = m?.[2] ? parseInt(m[2]) : 0
  if (m?.[3]?.toUpperCase() === 'PM' && h < 12) h += 12
  if (m?.[3]?.toUpperCase() === 'AM' && h === 12) h = 0
  const hh = String(h).padStart(2, '0'), mm = String(min).padStart(2, '0')
  return { start: `:${d}T${hh}${mm}00`, end: `:${d}T${String(Math.min(h + 2, 23)).padStart(2, '0')}${mm}00` }
}

export const handler = async (event) => {
  const SUPABASE_URL         = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
  const token = event.queryStringParameters?.token
  if (!token || !/^[0-9a-f-]{36}$/i.test(token)) {
    return { statusCode: 400, body: 'Invalid feed token' }
  }

  const sb = async (path) => {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
    })
    return r.json()
  }

  const feeds = await sb(`calendar_feeds?token=eq.${token}&select=user_id`)
  const userId = feeds?.[0]?.user_id
  if (!userId) return { statusCode: 404, body: 'Feed not found' }

  const items = await sb(`calendar_feed_items?user_id=eq.${userId}&select=id,event,reminder_minutes,created_at&order=created_at.desc&limit=200`)

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Badger Board//Events//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:Badger Board Events',
    'X-WR-TIMEZONE:America/Chicago',
  ]
  for (const it of (items || [])) {
    const e = it.event || {}
    if (!e.date_start) continue
    const { start, end } = dt(e.date_start, e.time)
    const loc = [e.venue, e.city].filter(Boolean).join(', ')
    lines.push('BEGIN:VEVENT')
    lines.push(`UID:${it.id}@badgerboardwi.com`)
    lines.push(`DTSTAMP:${new Date(it.created_at).toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`)
    lines.push(`DTSTART${start}`)
    if (end) lines.push(`DTEND${end}`)
    lines.push(`SUMMARY:${esc(e.name)}`)
    if (loc) lines.push(`LOCATION:${esc(loc)}`)
    const desc = [e.description, e.host ? `Host: ${e.host}` : null, e.url].filter(Boolean).join('\n')
    if (desc) lines.push(`DESCRIPTION:${esc(desc)}`)
    if (e.url) lines.push(`URL:${esc(e.url)}`)
    const mins = it.reminder_minutes ?? 60
    lines.push('BEGIN:VALARM')
    lines.push('ACTION:DISPLAY')
    lines.push(`DESCRIPTION:${esc(e.name)}`)
    lines.push(`TRIGGER:-PT${mins}M`)
    lines.push('END:VALARM')
    lines.push('END:VEVENT')
  }
  lines.push('END:VCALENDAR')

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'inline; filename="badgerboard-events.ics"',
      'Cache-Control': 'no-cache',
    },
    body: lines.join('\r\n'),
  }
}
