/**
 * volunteer-auth.js
 * Handles volunteer magic-link authentication flow.
 *
 * Actions:
 *   send_invite   — creates volunteer record + sends magic link email
 *   verify_token  — exchanges token for volunteer session data
 *   get_volunteer — returns volunteer profile for a given email + list
 *   update_stats  — increments doors/contacts/shifts for a volunteer
 */

import crypto from 'crypto'

const SUPABASE_URL  = process.env.SUPABASE_URL
const SERVICE_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY
const SITE_URL      = process.env.URL || 'https://badgerboardwi.com'

const sb = (path, opts = {}) =>
  fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    ...opts,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(opts.headers || {}),
    },
  })

// ─── Send magic-link invite email via Supabase Auth ──────────────────────────
async function sendMagicLink(email, volunteerName, listName, token) {
  const portalLink = `${SITE_URL}/v?token=${token}&email=${encodeURIComponent(email)}`

  // Use Supabase Auth admin API to send magic link
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email,
      email_confirm: true,
      user_metadata: { volunteer: true, volunteer_name: volunteerName },
    }),
  })

  // User may already exist — that's fine.  We'll use our own token system.
  // Portal link is intentionally NOT logged — it contains an auth token.

  // Send via Supabase OTP (works if email provider configured)
  const otpRes = await fetch(`${SUPABASE_URL}/auth/v1/otp`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email,
      create_user: true,
      data: { volunteer: true, portal_token: token },
      options: {
        emailRedirectTo: portalLink,
      },
    }),
  })

  return otpRes.ok
}

// ─── Action: send_invite ──────────────────────────────────────────────────────
async function sendInvite(params, coordinatorId) {
  const { name, email, phone, list_id, role = 'canvasser', notes } = params
  if (!name || !email || !list_id) {
    return { statusCode: 400, body: JSON.stringify({ error: 'name, email, list_id required' }) }
  }

  // Verify coordinator owns this list
  const listRes = await sb(`/door_knock_lists?id=eq.${list_id}&created_by=eq.${coordinatorId}&select=id,name`)
  const lists = await listRes.json()
  if (!lists?.length) {
    return { statusCode: 403, body: JSON.stringify({ error: 'List not found or unauthorized' }) }
  }
  const listName = lists[0].name

  // Generate a secure token
  const token = crypto.randomBytes(32).toString('hex')

  // Upsert volunteer record
  const volRes = await sb('/volunteers', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify({
      created_by: coordinatorId,
      list_id,
      name,
      email,
      phone: phone || null,
      role,
      status: 'invited',
      notes: notes || null,
      magic_token: token,
    }),
  })

  if (!volRes.ok) {
    const err = await volRes.text()
    console.error('[volunteer-auth] Failed to upsert volunteer:', err)
    return { statusCode: 500, body: JSON.stringify({ error: 'Failed to create volunteer' }) }
  }

  const volunteers = await volRes.json()
  const volunteer = volunteers[0]

  // Send magic link
  const emailSent = await sendMagicLink(email, name, listName, token)

  return {
    statusCode: 200,
    body: JSON.stringify({
      volunteer,
      email_sent: emailSent,
      portal_link: `${SITE_URL}/v?token=${token}&email=${encodeURIComponent(email)}`,
    }),
  }
}

// ─── Action: verify_token ─────────────────────────────────────────────────────
// Exchanges a one-time token for volunteer data (clears token after use)
async function verifyToken(params) {
  const { token, email } = params
  if (!token || !email) {
    return { statusCode: 400, body: JSON.stringify({ error: 'token and email required' }) }
  }

  const res = await sb(
    `/volunteers?magic_token=eq.${token}&email=eq.${encodeURIComponent(email)}&select=*`
  )
  const volunteers = await res.json()

  if (!volunteers?.length) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Invalid or expired token' }) }
  }

  const volunteer = volunteers[0]

  // Clear the token (single-use) + mark active
  await sb(`/volunteers?id=eq.${volunteer.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ magic_token: null, status: 'active', last_active: new Date().toISOString() }),
  })

  // Fetch list info
  let list = null
  if (volunteer.list_id) {
    const listRes = await sb(`/door_knock_lists?id=eq.${volunteer.list_id}&select=id,name,candidate_id`)
    const lists = await listRes.json()
    list = lists?.[0] || null
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ volunteer: { ...volunteer, magic_token: undefined }, list }),
  }
}

// ─── Action: get_volunteer ────────────────────────────────────────────────────
// Returns volunteer profile by email (post-login, using stored session)
async function getVolunteer(params) {
  const { email, volunteer_id } = params
  if (!email && !volunteer_id) {
    return { statusCode: 400, body: JSON.stringify({ error: 'email or volunteer_id required' }) }
  }

  const filter = volunteer_id
    ? `id=eq.${volunteer_id}`
    : `email=eq.${encodeURIComponent(email)}`

  const res = await sb(`/volunteers?${filter}&select=*,list:door_knock_lists(id,name,candidate_id)`)
  const volunteers = await res.json()

  if (!volunteers?.length) {
    return { statusCode: 404, body: JSON.stringify({ error: 'Volunteer not found' }) }
  }

  const volunteer = volunteers[0]
  // Mask the token
  delete volunteer.magic_token

  return { statusCode: 200, body: JSON.stringify({ volunteer }) }
}

// ─── Action: update_stats ─────────────────────────────────────────────────────
async function updateStats(params) {
  const { volunteer_id, doors_knocked = 0, contacts_made = 0, shift_completed = false } = params
  if (!volunteer_id) {
    return { statusCode: 400, body: JSON.stringify({ error: 'volunteer_id required' }) }
  }

  // Get current stats
  const res = await sb(`/volunteers?id=eq.${volunteer_id}&select=doors_knocked,contacts_made,shifts_worked`)
  const rows = await res.json()
  if (!rows?.length) {
    return { statusCode: 404, body: JSON.stringify({ error: 'Volunteer not found' }) }
  }
  const current = rows[0]

  const patch = {
    doors_knocked: (current.doors_knocked || 0) + doors_knocked,
    contacts_made: (current.contacts_made || 0) + contacts_made,
    shifts_worked: (current.shifts_worked || 0) + (shift_completed ? 1 : 0),
    last_active: new Date().toISOString(),
    status: 'active',
  }

  const updateRes = await sb(`/volunteers?id=eq.${volunteer_id}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })

  return { statusCode: 200, body: JSON.stringify({ updated: updateRes.ok, stats: patch }) }
}

// ─── Action: get_volunteers_for_list ─────────────────────────────────────────
async function getVolunteersForList(params, coordinatorId) {
  const { list_id } = params
  if (!list_id) {
    return { statusCode: 400, body: JSON.stringify({ error: 'list_id required' }) }
  }

  const res = await sb(
    `/volunteers?list_id=eq.${list_id}&created_by=eq.${coordinatorId}&select=id,name,email,phone,role,status,doors_knocked,contacts_made,shifts_worked,last_active,avatar_color,notes&order=name.asc`
  )
  const volunteers = await res.json()
  return { statusCode: 200, body: JSON.stringify({ volunteers: volunteers || [] }) }
}

// ─── Action: send_notification ───────────────────────────────────────────────
async function sendNotification(params, coordinatorId) {
  const { list_id, title, body, type = 'info', volunteer_id = null } = params
  if (!list_id || !title) {
    return { statusCode: 400, body: JSON.stringify({ error: 'list_id and title required' }) }
  }

  const res = await sb('/volunteer_notifications', {
    method: 'POST',
    body: JSON.stringify({
      list_id,
      created_by: coordinatorId,
      volunteer_id: volunteer_id || null,
      title,
      body: body || null,
      type,
    }),
  })

  return { statusCode: 200, body: JSON.stringify({ sent: res.ok }) }
}

// ─── Action: delete_volunteer ─────────────────────────────────────────────────
async function deleteVolunteer(params, coordinatorId) {
  const { volunteer_id } = params
  if (!volunteer_id) {
    return { statusCode: 400, body: JSON.stringify({ error: 'volunteer_id required' }) }
  }

  await sb(`/volunteers?id=eq.${volunteer_id}&created_by=eq.${coordinatorId}`, {
    method: 'DELETE',
  })

  return { statusCode: 200, body: JSON.stringify({ deleted: true }) }
}

// ─── Main handler ─────────────────────────────────────────────────────────────
export const handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) }
  }

  let body
  try {
    body = JSON.parse(event.body || '{}')
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }
  }

  const { action, params = {} } = body

  // Token verification doesn't require coordinator auth
  if (action === 'verify_token') return verifyToken(params)
  if (action === 'get_volunteer') return getVolunteer(params)
  if (action === 'update_stats')  return updateStats(params)

  // All other actions require coordinator auth
  const authHeader = event.headers.authorization || ''
  const token = authHeader.replace('Bearer ', '')
  if (!token) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) }
  }

  // Verify coordinator via Supabase
  const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${token}` },
  })
  if (!userRes.ok) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Invalid session' }) }
  }
  const { id: coordinatorId } = await userRes.json()

  switch (action) {
    case 'send_invite':              return sendInvite(params, coordinatorId)
    case 'get_volunteers_for_list':  return getVolunteersForList(params, coordinatorId)
    case 'send_notification':        return sendNotification(params, coordinatorId)
    case 'delete_volunteer':         return deleteVolunteer(params, coordinatorId)
    default:
      return { statusCode: 400, body: JSON.stringify({ error: `Unknown action: ${action}` }) }
  }
}
