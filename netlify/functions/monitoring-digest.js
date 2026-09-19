// Netlify Scheduled Function: monitoring-digest
// Runs Monday 17:00 UTC (two hours after the auto-regenerate cron at 15:00, so
// the weekly refreshes and their digests are finished) and sends every user
// with actively-monitored candidates ONE email digesting the week's
// developments across all of their candidates.
//
// Email layout (works in every major client — no interactive-CSS tricks,
// which Gmail/Outlook strip):
//   • header + intro
//   • candidate "switcher": a tab bar of anchor links that jump to each
//     candidate's section within the email
//   • one section per candidate: snapshot line, week-in-review summary,
//     categorized items, and a "View full update →" button deep-linking into
//     the app at that candidate's profile (news section)
//
// HTTP trigger (testing): POST with x-admin-trigger: ADMIN_TRIGGER_SECRET
//   body { dry_run?: true, only_email?: "user@x.com" }
//   dry_run returns the built HTML instead of sending.

const { getNotificationPrefs, isEmailSuppressed } = require('./_email')

const SUPABASE_URL   = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const SERVICE_KEY    = process.env.SUPABASE_SERVICE_ROLE_KEY
const RESEND_API_KEY = process.env.RESEND_API_KEY
const APP_URL        = 'https://badgerboardwi.com'

const nodeCrypto = require('crypto')
function safeEqual(a, b) {
  const A = nodeCrypto.createHash('sha256').update(String(a ?? '')).digest()
  const B = nodeCrypto.createHash('sha256').update(String(b ?? '')).digest()
  return nodeCrypto.timingSafeEqual(A, B)
}

const sb = async (path) => {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  })
  return res.ok ? res.json() : []
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

const CATEGORY_META = {
  news:        { label: 'News',        color: '#1d4ed8', bg: '#dbeafe' },
  social:      { label: 'Social',      color: '#0369a1', bg: '#e0f2fe' },
  podcast:     { label: 'Podcast/TV',  color: '#7c3aed', bg: '#ede9fe' },
  controversy: { label: 'Controversy', color: '#b91c1c', bg: '#fee2e2' },
  polling:     { label: 'Polling',     color: '#0d9488', bg: '#ccfbf1' },
  endorsement: { label: 'Endorsement', color: '#15803d', bg: '#dcfce7' },
  other:       { label: 'Update',      color: '#475569', bg: '#f1f5f9' },
}

// Extract the PROFILE SNAPSHOT line from stored content for the email intro
function snapshotOf(content) {
  const m = String(content || '').match(/##\s*PROFILE SNAPSHOT\s*\n([\s\S]*?)(?=\n##\s|$)/i)
  return m ? m[1].replace(/\*\*\[[^\]]*\]\*\*/g, '').replace(/[*#>_`]/g, '').replace(/\s+/g, ' ').trim() : ''
}

function buildEmailHtml(userFirst, entries, weekLabel) {
  // v1.21.1 redesign: plain, personal, minimal — reads like a staffer's memo,
  // not a template. No pill chips, no color-coded badges; simple type,
  // hairline rules, and the red "View full update" button per candidate.
  const CAT_LABEL = { news: 'News', social: 'Social', podcast: 'Podcast/TV', controversy: 'Controversy', polling: 'Polling', endorsement: 'Endorsement', other: 'Update' }

  const index = entries.length > 1
    ? `<p style="margin:0 0 26px;font-size:13px;color:#6b7280;">In this digest: ${entries.map(e => `<a href="#cand-${slug(e.candidate.name)}" style="color:#8B0000;text-decoration:none;font-weight:600;">${esc(e.candidate.name)}</a>`).join(' &nbsp;&middot;&nbsp; ')}</p>`
    : ''

  const sections = entries.map((e, idx) => {
    const d = e.digest || {}
    const items = (d.items || []).map(i =>
      `<tr>
        <td style="padding:5px 0;font-size:13.5px;color:#374151;line-height:1.55;">
          <span style="color:#9ca3af;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.03em;">${esc(CAT_LABEL[i.category] || 'Update')}</span>
          &nbsp; <span style="font-weight:600;color:#111827;">${esc(i.title)}</span>${i.note ? ` &mdash; ${esc(i.note)}` : ''}
        </td>
      </tr>`
    ).join('')

    const deepLink = `${APP_URL}/profiler?candidate=${encodeURIComponent(e.candidate.id)}&section=section-1`
    return `
      <div id="cand-${slug(e.candidate.name)}" style="${idx > 0 ? 'border-top:1px solid #e5e7eb;margin-top:28px;padding-top:26px;' : ''}">
        <h2 style="margin:0 0 10px;font-size:16px;font-weight:800;color:#111827;">${esc(e.candidate.name)}</h2>
        <p style="margin:0 0 12px;font-size:14px;color:#374151;line-height:1.65;">${esc(d.summary || 'No significant new developments this week.')}</p>
        ${items ? `<table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 14px;">${items}</table>` : ''}
        <a href="${deepLink}" style="display:inline-block;background:#8B0000;color:#ffffff;font-weight:700;font-size:13px;text-decoration:none;padding:10px 20px;border-radius:8px;">View full update &rarr;</a>
      </div>`
  }).join('')

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Weekly Active Monitoring digest</title></head>
<body style="margin:0;padding:0;background:#f6f6f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;">
  <div style="display:none;max-height:0;overflow:hidden;">What happened with your monitored candidates this week</div>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f6f6f6;padding:26px 14px;"><tr><td align="center">
    <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border:1px solid #e5e7eb;border-radius:10px;overflow:hidden;">
      <tr><td style="background-color:#0A1628;background:linear-gradient(135deg,#0A1628 0%,#16273f 55%,#1E3A5F 100%);padding:22px 34px;border-radius:10px 10px 0 0;" align="center">
        <img src="${APP_URL}/badger-board-logo.png" alt="Badger Board" width="150" style="display:block;margin:0 auto;max-width:150px;height:auto;border:0;" />
      </td></tr>
      <tr><td style="padding:24px 34px 6px;">
        <h1 style="margin:0 0 6px;font-size:19px;font-weight:800;color:#111827;">Weekly Active Monitoring digest</h1>
        <p style="margin:0 0 22px;font-size:13.5px;color:#6b7280;line-height:1.6;">${userFirst ? `Hi ${esc(userFirst)} &mdash; here&rsquo;s` : 'Here&rsquo;s'} what happened with ${entries.length === 1 ? esc(entries[0].candidate.name) : `your ${entries.length} monitored candidates`} for the week of ${esc(weekLabel)}.</p>
        ${index}
        ${sections}
        <p style="color:#9ca3af;font-size:11px;line-height:1.55;margin:30px 0 26px;border-top:1px solid #f3f4f6;padding-top:14px;">
          Profiles refresh automatically every Monday for candidates with Active Monitoring on. AI-generated from public sources &mdash; verify before use.<br/>
          &copy; ${new Date().getFullYear()} The Bluejack Group &middot; <a href="${APP_URL}" style="color:#9ca3af;">badgerboardwi.com</a>
        </p>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`
}

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json' }

  // Scheduled invocations carry no HTTP method; manual HTTP calls must present
  // the shared trigger secret (same pattern as auto-regenerate-dossiers).
  const isHttp = Boolean(event.httpMethod)
  let opts = {}
  if (isHttp) {
    const secret = process.env.ADMIN_TRIGGER_SECRET
    const provided = event.headers?.['x-admin-trigger'] || event.headers?.['X-Admin-Trigger']
    if (!secret || !safeEqual(provided, secret)) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Not authorized' }) }
    }
    try { opts = JSON.parse(event.body || '{}') } catch {}
  }

  if (!SUPABASE_URL || !SERVICE_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Missing Supabase configuration' }) }
  }

  // 1. Monitored candidates grouped by owner
  const candidates = await sb(`/candidates?section_timestamps->>monitoring=eq.true&select=id,name,created_by`)
  if (!candidates.length) {
    return { statusCode: 200, headers, body: JSON.stringify({ message: 'No monitored candidates', sent: 0 }) }
  }
  const byOwner = {}
  for (const c of candidates) {
    if (!c.created_by) continue
    ;(byOwner[c.created_by] ||= []).push(c)
  }

  // 2. Resolve owner emails
  const owners = {}
  for (const ownerId of Object.keys(byOwner)) {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${ownerId}`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
    })
    if (res.ok) owners[ownerId] = await res.json()
  }

  const weekLabel = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
  const results = []

  for (const [ownerId, cands] of Object.entries(byOwner)) {
    const owner = owners[ownerId]
    const email = owner?.email
    if (!email) { results.push({ owner: ownerId, status: 'no_email' }); continue }
    if (opts.only_email && email.toLowerCase() !== String(opts.only_email).toLowerCase()) {
      results.push({ owner: email, status: 'filtered' }); continue
    }

    // Admin mute outranks everything (v1.40.0) — this sender talks to Resend
    // directly, so it must consult the suppression list itself.
    if (await isEmailSuppressed(email)) { results.push({ owner: email, status: 'suppressed' }); continue }

    // Respect notification preferences (weekly_digest, default on)
    try {
      const prefs = await getNotificationPrefs(ownerId)
      if (prefs.weekly_digest === false) { results.push({ owner: email, status: 'opted_out' }); continue }
    } catch {}

    // 3. Latest dossier per candidate (digest + snapshot), only if refreshed in the last 8 days
    const entries = []
    for (const c of cands) {
      const rows = await sb(`/dossiers?candidate_id=eq.${c.id}&order=generated_at.desc&limit=1&select=id,generated_at,weekly_digest,content`)
      const d = rows?.[0]
      if (!d) continue
      const ageDays = (Date.now() - new Date(d.generated_at).getTime()) / 86400000
      entries.push({
        candidate: c,
        digest: d.weekly_digest || (ageDays <= 8 ? { summary: 'Profile refreshed this week — open it for the full picture.', items: [] } : { summary: `Last refreshed ${Math.round(ageDays)} days ago — a new refresh is scheduled for Monday.`, items: [] }),
        snapshot: snapshotOf(d.content),
        generatedAt: d.generated_at,
      })
    }
    if (!entries.length) { results.push({ owner: email, status: 'no_dossiers' }); continue }

    entries.sort((a, b) => a.candidate.name.localeCompare(b.candidate.name))
    const first = (owner.user_metadata?.display_name || '').split(' ')[0] || null
    const html = buildEmailHtml(first, entries, weekLabel)

    if (opts.dry_run) {
      results.push({ owner: email, status: 'dry_run', candidates: entries.length, html_bytes: html.length })
      if (opts.return_html) results[results.length - 1].html = html
      continue
    }

    if (!RESEND_API_KEY) { results.push({ owner: email, status: 'no_resend_key' }); continue }
    const send = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Badger Board <noreply@noreply.badgerboardwi.com>',  // Resend-verified domain (same as _email.js)
        to: email,
        subject: `Weekly Active Monitoring digest — ${entries.length === 1 ? entries[0].candidate.name : `${entries.length} candidates`} · ${weekLabel}`,
        html,
      }),
    })
    results.push({ owner: email, status: send.ok ? 'sent' : `error_${send.status}`, candidates: entries.length })
  }

  const sent = results.filter(r => r.status === 'sent').length
  console.log(`[monitoring-digest] done: ${sent} sent`, JSON.stringify(results))
  return { statusCode: 200, headers, body: JSON.stringify({ message: 'Digest run complete', sent, results }) }
}
