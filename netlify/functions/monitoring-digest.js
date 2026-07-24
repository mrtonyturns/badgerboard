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

const { getNotificationPrefs } = require('./_email')

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
  // entries: [{ candidate: {id, name}, digest, snapshot, generatedAt }]
  const tabBar = entries.map(e =>
    `<a href="#cand-${slug(e.candidate.name)}" style="display:inline-block;background:#f3f4f6;border:1px solid #e5e7eb;color:#111827;font-weight:700;font-size:12px;text-decoration:none;padding:7px 14px;border-radius:999px;margin:0 6px 8px 0;">${esc(e.candidate.name)}</a>`
  ).join('')

  const sections = entries.map(e => {
    const d = e.digest || {}
    const items = (d.items || []).map(i => {
      const cat = CATEGORY_META[i.category] || CATEGORY_META.other
      return `<tr>
        <td style="padding:7px 10px 7px 0;vertical-align:top;white-space:nowrap;">
          <span style="display:inline-block;background:${cat.bg};color:${cat.color};font-size:10px;font-weight:800;letter-spacing:0.04em;text-transform:uppercase;padding:3px 9px;border-radius:999px;">${cat.label}</span>
        </td>
        <td style="padding:7px 0;vertical-align:top;">
          <div style="font-size:13.5px;font-weight:700;color:#111827;line-height:1.35;">${esc(i.title)}</div>
          ${i.note ? `<div style="font-size:12.5px;color:#6b7280;line-height:1.45;margin-top:2px;">${esc(i.note)}</div>` : ''}
        </td>
      </tr>`
    }).join('')

    const deepLink = `${APP_URL}/profiler?candidate=${encodeURIComponent(e.candidate.id)}&section=section-1`
    return `
    <table id="cand-${slug(e.candidate.name)}" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid #e5e7eb;border-radius:14px;margin:0 0 18px;">
      <tr><td style="padding:20px 22px;">
        <div style="font-size:17px;font-weight:900;color:#111827;">${esc(e.candidate.name)}</div>
        ${e.snapshot ? `<div style="font-size:12.5px;color:#6b7280;line-height:1.5;margin-top:4px;">${esc(e.snapshot)}</div>` : ''}
        <div style="background:#fef2f2;border-left:3px solid #b91c1c;border-radius:0 10px 10px 0;padding:11px 14px;margin:14px 0;">
          <div style="font-size:10px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;color:#b91c1c;margin-bottom:4px;">This week</div>
          <div style="font-size:13.5px;color:#1f2937;line-height:1.55;">${esc(d.summary || 'No significant new developments detected this week.')}</div>
        </div>
        ${items ? `<table width="100%" cellpadding="0" cellspacing="0">${items}</table>` : ''}
        <div style="margin-top:14px;">
          <a href="${deepLink}" style="display:inline-block;background:#8B0000;color:#ffffff;font-weight:800;font-size:13px;text-decoration:none;padding:11px 22px;border-radius:10px;">View full update &rarr;</a>
        </div>
      </td></tr>
    </table>`
  }).join('')

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Weekly monitoring digest</title></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="display:none;max-height:0;overflow:hidden;">Your weekly candidate monitoring digest — ${esc(weekLabel)}</div>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:28px 14px;"><tr><td align="center">
    <table width="620" cellpadding="0" cellspacing="0" style="max-width:620px;width:100%;">
      <tr>
        <td style="background:#8B0000;height:4px;border-radius:4px 4px 0 0;width:33%"></td>
        <td style="background:#ffffff;height:4px;width:34%"></td>
        <td style="background:#1e40af;height:4px;border-radius:4px 4px 0 0;width:33%"></td>
      </tr>
      <tr><td colspan="3" style="background:#000000;padding:18px 32px;text-align:center;">
        <img src="${APP_URL}/badger-board-logo.png" alt="Badger Board" width="180" style="display:block;margin:0 auto;max-width:180px;height:auto;border:0" />
      </td></tr>
      <tr><td colspan="3" style="background:#ffffff;padding:26px 26px 8px;border-radius:0 0 14px 14px;">
        <h1 style="margin:0 0 6px;font-size:20px;font-weight:900;color:#111827;">Weekly monitoring digest</h1>
        <p style="margin:0 0 16px;font-size:13px;color:#6b7280;line-height:1.55;">
          ${userFirst ? `Hi ${esc(userFirst)}, here&rsquo;s` : 'Here&rsquo;s'} what happened with your ${entries.length === 1 ? 'monitored candidate' : `${entries.length} monitored candidates`} for the week of ${esc(weekLabel)}. Jump to a candidate:
        </p>
        <div style="margin-bottom:18px;">${tabBar}</div>
        ${sections}
        <p style="color:#9ca3af;font-size:11px;line-height:1.5;margin:8px 0 18px;">
          Profiles refresh automatically every Monday for candidates with Active Monitoring turned on. AI-generated from public sources &mdash; verify before use. Manage monitoring from each candidate&rsquo;s profile.
        </p>
      </td></tr>
      <tr><td colspan="3" style="padding:16px 0;text-align:center;">
        <p style="color:#9ca3af;font-size:11px;margin:0;">&copy; ${new Date().getFullYear()} The Bluejack Group &nbsp;&middot;&nbsp; <a href="${APP_URL}" style="color:#9ca3af;">badgerboardwi.com</a></p>
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
        subject: `Weekly monitoring digest — ${entries.length === 1 ? entries[0].candidate.name : `${entries.length} candidates`} · ${weekLabel}`,
        html,
      }),
    })
    results.push({ owner: email, status: send.ok ? 'sent' : `error_${send.status}`, candidates: entries.length })
  }

  const sent = results.filter(r => r.status === 'sent').length
  console.log(`[monitoring-digest] done: ${sent} sent`, JSON.stringify(results))
  return { statusCode: 200, headers, body: JSON.stringify({ message: 'Digest run complete', sent, results }) }
}
