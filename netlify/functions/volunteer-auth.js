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

// UUID guard for any id interpolated into a PostgREST filter
const isUuid = (v) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)

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
  if (!isUuid(list_id)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'valid list_id required' }) }
  }

  // Verify coordinator owns this list
  const listRes = await sb(`/door_knock_lists?id=eq.${encodeURIComponent(list_id)}&created_by=eq.${encodeURIComponent(coordinatorId)}&select=id,name`)
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
  // Token is a 64-char hex string. Rejecting anything else (and encoding it)
  // prevents PostgREST filter injection that could bypass the token check.
  if (!/^[0-9a-f]{64}$/i.test(token)) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Invalid or expired token' }) }
  }

  const res = await sb(
    `/volunteers?magic_token=eq.${encodeURIComponent(token)}&email=eq.${encodeURIComponent(email)}&select=*`
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

  // Issue a durable session token (magic_token is single-use and cleared above).
  // The portal stores this and must present it on subsequent get_volunteer/update_stats calls.
  const sessionToken = crypto.randomBytes(32).toString('hex')
  await sb(`/volunteers?id=eq.${volunteer.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ session_token: sessionToken }),
  })

  return {
    statusCode: 200,
    body: JSON.stringify({
      volunteer: { ...volunteer, magic_token: undefined, session_token: undefined },
      session_token: sessionToken,
      list,
    }),
  }
}

// ─── Action: get_volunteer ────────────────────────────────────────────────────
// Returns volunteer profile by email (post-login, using stored session)
// Returns the authenticated volunteer's email if the request carries a valid
// Supabase JWT, else null. Used to let email-based self-lookups authenticate.
async function emailFromJwt(authHeader) {
  const token = (authHeader || '').replace('Bearer ', '')
  if (!token) return null
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${token}` },
    })
    if (!r.ok) return null
    const u = await r.json()
    return u?.email ? String(u.email).toLowerCase() : null
  } catch { return null }
}

async function getVolunteer(params, authHeader) {
  const { email, volunteer_id } = params
  if (!email && !volunteer_id) {
    return { statusCode: 400, body: JSON.stringify({ error: 'email or volunteer_id required' }) }
  }

  if (volunteer_id && !isUuid(volunteer_id)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'valid volunteer_id required' }) }
  }
  const filter = volunteer_id
    ? `id=eq.${encodeURIComponent(volunteer_id)}`
    : `email=eq.${encodeURIComponent(email)}`

  const res = await sb(`/volunteers?${filter}&select=*,list:door_knock_lists(id,name,candidate_id)`)
  const volunteers = await res.json()

  if (!volunteers?.length) {
    return { statusCode: 404, body: JSON.stringify({ error: 'Volunteer not found' }) }
  }

  const volunteer = volunteers[0]

  // Authorize: caller must present this volunteer's session_token, OR a valid
  // Supabase JWT whose email matches this volunteer. Prevents unauthenticated
  // enumeration of volunteer PII by email/id.
  const providedToken = params.session_token || (authHeader || '').replace('Bearer ', '')
  const tokenOk = volunteer.session_token && providedToken && providedToken === volunteer.session_token
  let jwtOk = false
  if (!tokenOk) {
    const jwtEmail = await emailFromJwt(authHeader)
    jwtOk = jwtEmail && volunteer.email && jwtEmail === String(volunteer.email).toLowerCase()
  }
  if (!tokenOk && !jwtOk) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) }
  }

  // Never leak the tokens back to the client
  delete volunteer.magic_token
  delete volunteer.session_token

  return { statusCode: 200, body: JSON.stringify({ volunteer }) }
}

// ─── Action: update_stats ─────────────────────────────────────────────────────
async function updateStats(params, authHeader) {
  const { volunteer_id, doors_knocked = 0, contacts_made = 0, shift_completed = false } = params
  if (!volunteer_id || !isUuid(volunteer_id)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'valid volunteer_id required' }) }
  }

  // Get current stats + token for authorization
  const res = await sb(`/volunteers?id=eq.${encodeURIComponent(volunteer_id)}&select=doors_knocked,contacts_made,shifts_worked,session_token,email`)
  const rows = await res.json()
  if (!rows?.length) {
    return { statusCode: 404, body: JSON.stringify({ error: 'Volunteer not found' }) }
  }
  const current = rows[0]

  // Authorize: session_token match OR a Supabase JWT whose email matches.
  const providedToken = params.session_token || (authHeader || '').replace('Bearer ', '')
  const tokenOk = current.session_token && providedToken && providedToken === current.session_token
  let jwtOk = false
  if (!tokenOk) {
    const jwtEmail = await emailFromJwt(authHeader)
    jwtOk = jwtEmail && current.email && jwtEmail === String(current.email).toLowerCase()
  }
  if (!tokenOk && !jwtOk) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) }
  }

  const patch = {
    doors_knocked: (current.doors_knocked || 0) + doors_knocked,
    contacts_made: (current.contacts_made || 0) + contacts_made,
    shifts_worked: (current.shifts_worked || 0) + (shift_completed ? 1 : 0),
    last_active: new Date().toISOString(),
    status: 'active',
  }

  const updateRes = await sb(`/volunteers?id=eq.${encodeURIComponent(volunteer_id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })

  return { statusCode: 200, body: JSON.stringify({ updated: updateRes.ok, stats: patch }) }
}

// ─── Action: log_knock ────────────────────────────────────────────────────────
// Audit fix (#3): the portal used to insert door_knocks directly with the anon
// browser client — RLS rejected the insert, the result was never checked, and
// every volunteer knock was silently dropped while "Logged!" showed. This
// action inserts via the service role AND increments the volunteer's stats in
// one authorized call. list_id comes from the volunteer's own row (never the
// client) so a volunteer cannot write knocks into someone else's list.
// The portal's outcome values differ from the door_knocks.status CHECK
// constraint ('contacted','not_home','refused','moved','wrong_address',
// 'do_not_knock') — the old direct insert would have violated the CHECK even
// without RLS. Map portal values to DB values; canonical DB values pass through.
const KNOCK_STATUS_MAP = {
  contact:       'contacted',      // portal "Spoke With Voter"
  no_answer:     'not_home',       // portal "No Answer"
  not_home:      'not_home',       // portal "Left Lit"
  refused:       'refused',
  moved:         'wrong_address',  // portal value 'moved' is labeled "Wrong Address"
  contacted:     'contacted',
  wrong_address: 'wrong_address',
  do_not_knock:  'do_not_knock',
}

async function logKnock(params, authHeader) {
  const { volunteer_id, address, status, support_level = null, notes = null } = params
  if (!volunteer_id || !isUuid(volunteer_id)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'valid volunteer_id required' }) }
  }
  const cleanAddress = typeof address === 'string' ? address.trim().slice(0, 300) : ''
  if (!cleanAddress) {
    return { statusCode: 400, body: JSON.stringify({ error: 'address required' }) }
  }
  const cleanStatus = KNOCK_STATUS_MAP[status] || 'not_home'
  // contacts_made should track actual voter conversations, not the raw status string
  const madeContact = cleanStatus === 'contacted'

  // Fetch the volunteer row — authorization + server-side list_id in one read
  const res = await sb(`/volunteers?id=eq.${encodeURIComponent(volunteer_id)}&select=id,list_id,user_id,email,session_token,doors_knocked,contacts_made`)
  const rows = await res.json()
  if (!rows?.length) {
    return { statusCode: 404, body: JSON.stringify({ error: 'Volunteer not found' }) }
  }
  const vol = rows[0]

  // Authorize exactly like update_stats: session_token match OR matching JWT email
  const providedToken = params.session_token || (authHeader || '').replace('Bearer ', '')
  const tokenOk = vol.session_token && providedToken && providedToken === vol.session_token
  let jwtOk = false
  if (!tokenOk) {
    const jwtEmail = await emailFromJwt(authHeader)
    jwtOk = jwtEmail && vol.email && jwtEmail === String(vol.email).toLowerCase()
  }
  if (!tokenOk && !jwtOk) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) }
  }

  if (!vol.list_id) {
    return { statusCode: 400, body: JSON.stringify({ error: 'No walk list assigned to this volunteer yet' }) }
  }

  // Insert the knock via the service role (bypasses the RLS that silently
  // dropped the old client-side insert)
  const insertRes = await sb('/door_knocks', {
    method: 'POST',
    body: JSON.stringify({
      list_id: vol.list_id,
      address: cleanAddress,
      status: cleanStatus,
      support_level: Number.isInteger(support_level) && support_level >= 1 && support_level <= 5 ? support_level : null,
      notes: typeof notes === 'string' && notes.trim() ? notes.trim().slice(0, 2000) : null,
      knocked_at: new Date().toISOString(),
      knocked_by: vol.user_id || null,
    }),
  })
  if (!insertRes.ok) {
    const err = await insertRes.text()
    console.error('[volunteer-auth] log_knock insert failed:', err)
    return { statusCode: 500, body: JSON.stringify({ error: 'Failed to save the door knock — please try again' }) }
  }

  // Increment stats in the same action (atomic from the portal's point of view)
  const statsPatch = {
    doors_knocked: (vol.doors_knocked || 0) + 1,
    contacts_made: (vol.contacts_made || 0) + (madeContact ? 1 : 0),
    last_active: new Date().toISOString(),
    status: 'active',
  }
  const statsRes = await sb(`/volunteers?id=eq.${encodeURIComponent(volunteer_id)}`, {
    method: 'PATCH',
    body: JSON.stringify(statsPatch),
  })
  if (!statsRes.ok) {
    console.error('[volunteer-auth] log_knock stats update failed:', await statsRes.text())
  }

  return {
    statusCode: 200,
    body: JSON.stringify({
      logged: true,
      stats_updated: statsRes.ok,
      doors_knocked: statsPatch.doors_knocked,
      contacts_made: statsPatch.contacts_made,
    }),
  }
}

// ─── Action: get_volunteers_for_list ─────────────────────────────────────────
async function getVolunteersForList(params, coordinatorId) {
  const { list_id } = params
  if (!list_id || !isUuid(list_id)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'valid list_id required' }) }
  }

  const res = await sb(
    `/volunteers?list_id=eq.${encodeURIComponent(list_id)}&created_by=eq.${encodeURIComponent(coordinatorId)}&select=id,name,email,phone,role,status,doors_knocked,contacts_made,shifts_worked,last_active,avatar_color,notes&order=name.asc`
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

  // IDOR guard: the coordinator must own the list (same check as sendInvite)
  const ownRes = await sb(`/door_knock_lists?id=eq.${encodeURIComponent(list_id)}&created_by=eq.${encodeURIComponent(coordinatorId)}&select=id`)
  const ownRows = await ownRes.json()
  if (!Array.isArray(ownRows) || ownRows.length === 0) {
    return { statusCode: 403, body: JSON.stringify({ error: 'Not authorized for this list' }) }
  }
  // If targeting one volunteer, they must belong to that list and coordinator
  if (volunteer_id) {
    const vRes = await sb(`/volunteers?id=eq.${encodeURIComponent(volunteer_id)}&list_id=eq.${encodeURIComponent(list_id)}&created_by=eq.${encodeURIComponent(coordinatorId)}&select=id`)
    const vRows = await vRes.json()
    if (!Array.isArray(vRows) || vRows.length === 0) {
      return { statusCode: 403, body: JSON.stringify({ error: 'Volunteer not in your list' }) }
    }
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
  if (!volunteer_id || !isUuid(volunteer_id)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'valid volunteer_id required' }) }
  }

  await sb(`/volunteers?id=eq.${encodeURIComponent(volunteer_id)}&created_by=eq.${encodeURIComponent(coordinatorId)}`, {
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

  // verify_token exchanges a single-use magic link for a durable session token.
  // get_volunteer/update_stats are self-service but now require that session
  // token (or a matching Supabase JWT) — see the checks inside each.
  const selfAuthHeader = event.headers.authorization || event.headers.Authorization || ''
  if (action === 'verify_token') return verifyToken(params)
  if (action === 'get_volunteer') return getVolunteer(params, selfAuthHeader)
  if (action === 'update_stats')  return updateStats(params, selfAuthHeader)
  if (action === 'log_knock')     return logKnock(params, selfAuthHeader)

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
