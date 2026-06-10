// netlify/functions/_dayframer.js
// ─── Shared DayFramer (GoHighLevel) helpers ───────────────────────────────────
// Prefixed with _ so Netlify does NOT treat this as a deployable function.
//
// DayFramer is the white-labeled GoHighLevel agency. Each Badger Board account
// gets its own subaccount (GHL "location"), provisioned from the account's
// profile data, plus a GHL user with the same email so the tools are connected
// to the Badger Board account.
//
// Required env vars:
//   GHL_AGENCY_API_KEY        — Agency-level Private Integration Token (pit-…)
//   SUPABASE_URL              — Supabase project URL
//   SUPABASE_ANON_KEY         — anon key (JWT verification)
//   SUPABASE_SERVICE_ROLE_KEY — service role key (metadata writes)
// Optional:
//   GHL_COMPANY_ID            — Agency company ID (auto-discovered if unset)
//   MARKETING_GATING_ENABLED  — 'true' to require the paid Marketing Tier.
//                               Default off for the initial rollout — keep in
//                               sync with MARKETING_GATING_ENABLED in
//                               src/lib/tiers.js.

const crypto = require('crypto')
const { ADMIN_EMAILS } = require('./_config')

const GHL_API     = 'https://services.leadconnectorhq.com'
const GHL_VERSION = '2021-07-28'

const SUPABASE_URL  = process.env.SUPABASE_URL  || process.env.VITE_SUPABASE_URL
const SUPABASE_ANON = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY

function ghlHeaders() {
  return {
    Authorization:  `Bearer ${process.env.GHL_AGENCY_API_KEY}`,
    Version:        GHL_VERSION,
    'Content-Type': 'application/json',
    Accept:         'application/json',
  }
}

// ── Auth ──────────────────────────────────────────────────────────────────────

// Verifies the Supabase JWT from the request and returns the full user object
// (including user_metadata), or null if invalid.
async function getUserFromRequest(event) {
  const authHeader = event.headers?.authorization || event.headers?.Authorization
  if (!authHeader?.startsWith('Bearer ')) return null
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON, Authorization: authHeader },
  })
  if (!res.ok) return null
  return res.json()
}

// Server-side Marketing gate — mirrors hasMarketingAccess() in src/lib/tiers.js.
// Gating is OFF by default for the initial rollout: every signed-in user passes.
function hasMarketingAccess(user) {
  if (!user) return false
  if (process.env.MARKETING_GATING_ENABLED !== 'true') return true
  if (ADMIN_EMAILS.includes(user.email?.toLowerCase())) return true
  return user?.user_metadata?.marketing_tier === 'active'
}

// ── Supabase admin helpers ────────────────────────────────────────────────────

async function getSupabaseUserAdmin(userId) {
  const res = await fetch(`${process.env.SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
    headers: {
      apikey:        process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
  })
  if (!res.ok) return null
  return res.json()
}

// Merges fields into user_metadata without clobbering unrelated keys.
async function mergeUserMetadata(userId, fields) {
  const existing = await getSupabaseUserAdmin(userId)
  const metadata = { ...(existing?.user_metadata ?? {}), ...fields }
  const res = await fetch(`${process.env.SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      apikey:         process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization:  `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify({ user_metadata: metadata }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Supabase metadata update failed (${res.status}): ${text}`)
  }
  return res.json()
}

// ── Agency / company ──────────────────────────────────────────────────────────

// Returns the agency company ID — from env when set, otherwise discovered by
// reading any existing location under the agency token.
async function getCompanyId() {
  if (process.env.GHL_COMPANY_ID) return process.env.GHL_COMPANY_ID
  const res  = await fetch(`${GHL_API}/locations/search?limit=1`, { headers: ghlHeaders() })
  const data = await res.json()
  const companyId = data?.locations?.[0]?.companyId
  if (!companyId) {
    throw new Error('Could not determine GHL company ID — set GHL_COMPANY_ID in env vars')
  }
  return companyId
}

// ── Subaccount provisioning ───────────────────────────────────────────────────

// Creates a GHL user inside the new subaccount with the same email as the
// Badger Board account, so the location is connected to the user. Non-fatal:
// returns null on failure (e.g. email already a GHL user elsewhere).
async function createSubaccountUser(user, locationId, companyId) {
  const meta = user?.user_metadata ?? {}
  const payload = {
    companyId,
    firstName: meta.first_name || meta.display_name || 'Badger',
    lastName:  meta.last_name  || 'Board',
    email:     user.email,
    // Random strong password — the user reaches the tools through Badger Board,
    // not by logging into GHL directly. Resettable via GHL if ever needed.
    password:  `Bb1!${crypto.randomBytes(18).toString('base64url')}`,
    type:      'account',
    role:      'admin',
    locationIds: [locationId],
  }
  try {
    const res  = await fetch(`${GHL_API}/users/`, {
      method: 'POST',
      headers: ghlHeaders(),
      body: JSON.stringify(payload),
    })
    const data = await res.json()
    if (!res.ok) {
      console.warn(`GHL user creation failed (${res.status}):`, data?.message || JSON.stringify(data))
      return null
    }
    return data?.id || data?.user?.id || null
  } catch (err) {
    console.warn('GHL user creation error:', err.message)
    return null
  }
}

// Creates the DayFramer subaccount for a user from their Badger Board profile
// data, connects a GHL user with the same email, and stores the IDs in
// user_metadata. Idempotent — returns the existing location if provisioned.
//
// `user` must be a full Supabase user object (admin or JWT-verified).
async function provisionSubaccount(user) {
  const meta = user?.user_metadata ?? {}

  if (meta.dayframer_location_id) {
    return { locationId: meta.dayframer_location_id, existing: true }
  }

  if (!process.env.GHL_AGENCY_API_KEY) {
    throw new Error('DayFramer agency API not configured (GHL_AGENCY_API_KEY)')
  }

  const companyId = await getCompanyId()

  const name = meta.business || meta.display_name || user.email
  const payload = {
    name,
    companyId,
    ...(meta.first_name && { firstName: meta.first_name }),
    ...(meta.last_name  && { lastName:  meta.last_name }),
    email: user.email,
    ...(meta.phone && { phone: meta.phone }),
    settings: { allowDuplicateContact: false },
  }

  const res = await fetch(`${GHL_API}/locations/`, {
    method: 'POST',
    headers: ghlHeaders(),
    body: JSON.stringify(payload),
  })
  const data = await res.json()
  if (!res.ok || !(data?.id || data?.location?.id)) {
    throw new Error(data?.message || `DayFramer subaccount creation failed (${res.status})`)
  }

  const locationId = data.id || data.location.id

  // Connect the Badger Board account to the subaccount via a same-email user
  const ghlUserId = await createSubaccountUser(user, locationId, companyId)

  await mergeUserMetadata(user.id, {
    dayframer_location_id: locationId,
    ...(ghlUserId && { dayframer_user_id: ghlUserId }),
  })

  return { locationId, ghlUserId, existing: false }
}

module.exports = {
  GHL_API,
  GHL_VERSION,
  ghlHeaders,
  getUserFromRequest,
  hasMarketingAccess,
  getSupabaseUserAdmin,
  mergeUserMetadata,
  getCompanyId,
  provisionSubaccount,
}
