/**
 * invite-volunteer.js
 * Creates a volunteer record and sends an invite email via Resend.
 *
 * POST body: { name, email, phone, role, listId }
 * Returns:   { success: true, volunteerId }
 */

import crypto from 'crypto'
import { enforceRateLimit } from './_rate-limit.js'

// Escape user-supplied text before interpolating into email HTML — the name
// field was previously injected raw, letting any account send phishing-capable
// HTML from the platform's authenticated sending domain (audit #16).
function escapeHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

const SUPABASE_URL  = process.env.SUPABASE_URL  || process.env.VITE_SUPABASE_URL
const SUPABASE_ANON = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY
const SERVICE_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY
const RESEND_API_KEY = process.env.RESEND_API_KEY

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
}

// ── Verify caller JWT ─────────────────────────────────────────────────────────
async function verifyUser(authHeader) {
  if (!authHeader?.startsWith('Bearer ')) return null
  const token = authHeader.slice(7)
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${token}` },
  })
  if (!res.ok) return null
  const user = await res.json()
  return user?.id ? user : null
}

// ── Insert volunteer via service role (bypasses RLS for insert) ───────────────
async function insertVolunteer(record) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/volunteers`, {
    method: 'POST',
    headers: {
      apikey:        SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer:        'return=representation',
    },
    body: JSON.stringify(record),
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`DB insert failed: ${err}`)
  }
  const rows = await res.json()
  return Array.isArray(rows) ? rows[0] : rows
}

// Confirm the given list belongs to the calling coordinator before we let them
// attach volunteers to it (prevents cross-coordinator volunteer injection).
async function listBelongsToUser(listId, userId) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/door_knock_lists?id=eq.${encodeURIComponent(listId)}&created_by=eq.${encodeURIComponent(userId)}&select=id`,
    { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } }
  )
  if (!res.ok) return false
  const rows = await res.json()
  return Array.isArray(rows) && rows.length > 0
}

// ── Send invite email via Resend ──────────────────────────────────────────────
async function sendInviteEmail({ name, email, token }) {
  if (!RESEND_API_KEY || !email) return { skipped: true }

  // Audit fix (#14): the link MUST carry both token and email — the portal's
  // auto-login requires both query params, so the old email-less link dumped
  // every invited volunteer on the login screen with an unusable token.
  const inviteUrl = `https://www.badgerboardwi.com/v?token=${token}&email=${encodeURIComponent(email)}`
  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>You've been invited to join a canvassing team on BadgerBoard</title></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:32px 16px">
    <tr><td align="center">
      <table width="580" cellpadding="0" cellspacing="0" style="max-width:580px;width:100%">
        <tr>
          <td style="background:#8B0000;height:4px;border-radius:4px 4px 0 0;width:33%"></td>
          <td style="background:#ffffff;height:4px;width:34%"></td>
          <td style="background:#1e40af;height:4px;border-radius:4px 4px 0 0;width:33%"></td>
        </tr>
        <tr>
          <td colspan="3" style="background:#000000;padding:20px 40px;text-align:center">
            <img src="https://www.badgerboardwi.com/badger-board-logo.png" alt="Badger Board"
                 width="200" style="display:block;margin:0 auto;max-width:200px;height:auto;border:0" />
          </td>
        </tr>
        <tr>
          <td colspan="3" style="background:#ffffff;padding:40px 40px 36px;border-radius:0 0 12px 12px">
            <h1 style="margin:0 0 20px;font-size:21px;font-weight:700;color:#111827;line-height:1.3">
              You've been invited to join a canvassing team
            </h1>
            <div style="color:#4b5563;font-size:15px;line-height:1.65">
              <p>Hi ${name ? escapeHtml(name).slice(0, 100) : 'there'},</p>
              <p>You've been invited to join a canvassing team on <strong>BadgerBoard</strong> — Wisconsin's campaign door-knocking platform.</p>
              <p>Click the button below to access your volunteer portal and get started:</p>
            </div>
            <div style="text-align:center;margin:32px 0 4px">
              <a href="${inviteUrl}" style="display:inline-block;background:#8B0000;color:#ffffff;font-weight:700;font-size:14px;padding:13px 32px;border-radius:8px;text-decoration:none;letter-spacing:0.01em">
                Open Volunteer Portal &rarr;
              </a>
            </div>
            <p style="color:#9ca3af;font-size:12px;margin:28px 0 0;border-top:1px solid #f3f4f6;padding-top:16px">
              If you weren't expecting this invite, you can safely ignore this email.
              Your portal link: <a href="${inviteUrl}" style="color:#8B0000">${inviteUrl}</a>
            </p>
          </td>
        </tr>
        <tr>
          <td colspan="3" style="padding:20px 0;text-align:center">
            <p style="color:#9ca3af;font-size:11px;margin:0">&copy; ${new Date().getFullYear()} The Bluejack Group &nbsp;&middot;&nbsp;
              <a href="https://www.badgerboardwi.com" style="color:#9ca3af;text-decoration:none">badgerboardwi.com</a>
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'Badger Board <noreply@noreply.badgerboardwi.com>',   // must match _email.js FROM (verified Resend domain)
      to: email,
      subject: "You've been invited to join a canvassing team on BadgerBoard",
      html,
    }),
  })
  if (!res.ok) {
    const err = await res.text()
    console.error('[invite-volunteer] Resend error:', err)
    return { error: err }
  }
  return res.json()
}

// ── Handler ───────────────────────────────────────────────────────────────────
export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' }
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) }
  }

  // ── Auth check ────────────────────────────────────────────────────────────
  const authHeader = event.headers['authorization'] || event.headers['Authorization'] || ''
  const user = await verifyUser(authHeader)
  if (!user) {
    return { statusCode: 401, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Unauthorized' }) }
  }

  let body
  try {
    body = JSON.parse(event.body || '{}')
  } catch {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) }
  }

  // Audit fix (#16, partial): durable per-user rate limit — this endpoint sends
  // real email from the platform domain and previously had no limit at all.
  const limited = await enforceRateLimit(user.id, 'invite-volunteer', CORS_HEADERS)
  if (limited) return limited

  const { name, email, phone, role, listId } = body
  if (!name?.trim()) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'name is required' }) }
  }

  // ── Ownership check ─────────────────────────────────────────────────────────
  // If a list is specified, it must belong to the caller. Without this, a
  // logged-in user could attach volunteers to another coordinator's list.
  if (listId) {
    const owns = await listBelongsToUser(listId, user.id)
    if (!owns) {
      return { statusCode: 403, headers: CORS_HEADERS, body: JSON.stringify({ error: 'You do not have access to that list.' }) }
    }
  }

  // ── Create volunteer record ───────────────────────────────────────────────
  // Audit fix (#14): verify_token requires a 64-char hex token — the old
  // crypto.randomUUID() (36 chars, dashed) could NEVER pass validation, so
  // every invite link was permanently dead.
  const inviteToken = crypto.randomBytes(32).toString('hex')
  // volunteers table uses: created_by (not coordinator_id), magic_token (not invite_token)
  const record = {
    created_by: user.id,
    list_id: listId || null,
    name: name.trim(),
    email: email?.trim() || null,
    phone: phone?.trim() || null,
    role: role === 'captain' ? 'captain' : 'volunteer',
    magic_token: inviteToken,
    status: 'invited',
  }

  let volunteer
  try {
    volunteer = await insertVolunteer(record)
  } catch (err) {
    console.error('[invite-volunteer] insert error:', err.message)
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'An internal error occurred' }) }
  }

  // ── Send invite email ──────────────────────────────────────────────────────
  if (email?.trim()) {
    await sendInviteEmail({ name: name.trim(), email: email.trim(), token: inviteToken }).catch(e =>
      console.error('[invite-volunteer] email send error:', e.message)
    )
  }

  const portalLink = email?.trim()
    ? `https://www.badgerboardwi.com/v?token=${inviteToken}&email=${encodeURIComponent(email.trim())}`
    : `https://www.badgerboardwi.com/v?token=${inviteToken}`

  return {
    statusCode: 200,
    headers: CORS_HEADERS,
    body: JSON.stringify({ success: true, volunteerId: volunteer?.id, portalLink }),
  }
}
