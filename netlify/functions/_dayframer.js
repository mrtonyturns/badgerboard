// netlify/functions/_dayframer.js
// ─── Shared DayFramer (GoHighLevel) helpers ───────────────────────────────────
// Prefixed with _ so Netlify does NOT treat this as a deployable function.
//
// DayFramer is the white-labeled GoHighLevel agency. Each Badger Board account
// with the Marketing Tier gets its own subaccount (GHL "location"), provisioned
// from the account's profile data.
//
// Required env vars:
//   GHL_AGENCY_API_KEY        — Agency-level API key (can create locations)
//   GHL_COMPANY_ID            — Agency company ID (locations are created under it)
//   SUPABASE_URL              — Supabase project URL
//   SUPABASE_ANON_KEY         — anon key (JWT verification)
//   SUPABASE_SERVICE_ROLE_KEY — service role key (metadata writes)

const { ADMIN_EMAILS } = require('./_config')

const GHL_API     = 'https://services.leadconnectorhq.com'
const GHL_VERSION = '2021-07-28'

const SUPABASE_URL  = process.env.SUPABASE_URL  || process.env.VITE_SUPABASE_URL
const SUPABASE_ANON = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY

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

// Server-side Marketing Tier gate — mirrors hasMarketingAccess() in src/lib/tiers.js
function hasMarketingAccess(user) {
  if (!user) return false
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

// ── Subaccount provisioning ───────────────────────────────────────────────────

// Creates the DayFramer subaccount for a user from their Badger Board profile
// data and stores the location ID in user_metadata. Idempotent — returns the
// existing location ID if one was already provisioned.
//
// `user` must be a full Supabase user object (admin or JWT-verified).
async function provisionSubaccount(user) {
  const meta = user?.user_metadata ?? {}

  if (meta.dayframer_location_id) {
    return { locationId: meta.dayframer_location_id, existing: true }
  }

  const agencyKey = process.env.GHL_AGENCY_API_KEY
  const companyId = process.env.GHL_COMPANY_ID
  if (!agencyKey || !companyId) {
    throw new Error('DayFramer agency API not configured (GHL_AGENCY_API_KEY / GHL_COMPANY_ID)')
  }

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
    headers: {
      Authorization:  `Bearer ${agencyKey}`,
      Version:        GHL_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })
  const data = await res.json()
  if (!res.ok || !(data?.id || data?.location?.id)) {
    throw new Error(data?.message || `DayFramer subaccount creation failed (${res.status})`)
  }

  const locationId = data.id || data.location.id
  await mergeUserMetadata(user.id, { dayframer_location_id: locationId })

  return { locationId, existing: false }
}

module.exports = {
  GHL_API,
  GHL_VERSION,
  getUserFromRequest,
  hasMarketingAccess,
  getSupabaseUserAdmin,
  mergeUserMetadata,
  provisionSubaccount,
}
