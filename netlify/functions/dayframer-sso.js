// Netlify Function: dayframer-sso
// Returns the deep-link URL for a DayFramer (GoHighLevel) marketing tool in the
// user's subaccount — Email Campaigns, Social Planner, or QR Codes. The frontend
// opens this URL in a NEW TAB (not an iframe — cross-origin iframe embedding of
// GHL is impossible due to browser third-party-cookie blocking; verified by
// research, see DAYFRAMER_EMBED_REQUIREMENTS.md).
//
// In a first-party tab the session persists and the deep-link resolves. When
// agency OIDC SSO is configured (Supabase as IdP — see DAYFRAMER_SSO_SETUP.md),
// a user with no GHL session is bounced through /login/sso and silently signed
// in via their existing Badger Board (Supabase) session, then returned to this
// tool URL — one click, no re-login.
//
// GET ?section=email|social|qr
//
// Env vars:
//   DAYFRAMER_APP_URL    — white-label app base URL (default account.dayframer.com)
//   DAYFRAMER_SSO_SECRET — optional shared HMAC secret for a signed bb_sso token
//   plus the Supabase vars used by _dayframer.js

const crypto = require('crypto')
const { getUserFromRequest, hasMarketingAccess } = require('./_dayframer')

const TOKEN_TTL_SECONDS = 5 * 60
// White-label app domain — users never see the underlying provider. Overridable
// via DAYFRAMER_APP_URL. (Internal code uses the DayFramer name only.)
const DEFAULT_APP_URL   = 'https://account.dayframer.com'

// Section → path inside the DayFramer (GHL) location app.
// Verified 2026-06-21 by copying the live URLs from a logged-in DayFramer
// session (paths are everything after /v2/location/<id>/):
//   Email Campaigns → marketing/emails/statistics
//   Social Planner  → marketing/social-planner
//   QR Codes        → qr-codes  (top level, NOT under marketing)
// If GHL restructures routes, re-copy the URLs from DayFramer and update here.
const SECTION_PATHS = {
  email:  'marketing/emails/statistics',
  social: 'marketing/social-planner',
  qr:     'qr-codes',
}

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json' }

  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) }
  }

  const user = await getUserFromRequest(event)
  if (!user) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Not authenticated' }) }
  }

  if (!hasMarketingAccess(user)) {
    return { statusCode: 403, headers, body: JSON.stringify({ error: 'Marketing access required' }) }
  }

  const locationId = user.user_metadata?.dayframer_location_id
  if (!locationId) {
    return { statusCode: 409, headers, body: JSON.stringify({ error: 'No marketing workspace yet — create one first' }) }
  }

  const section = event.queryStringParameters?.section
  const path    = SECTION_PATHS[section]
  if (!path) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: `section must be one of: ${Object.keys(SECTION_PATHS).join(', ')}` }) }
  }

  const appUrl  = (process.env.DAYFRAMER_APP_URL || DEFAULT_APP_URL).replace(/\/$/, '')
  let expiresAt = null

  // Build query params. Collect them so multiple flags compose correctly.
  const params = new URLSearchParams()

  // Signed, short-lived token: userId.locationId.expiry + HMAC signature.
  // Only validated once the white-label side is configured for it.
  const secret = process.env.DAYFRAMER_SSO_SECRET
  if (secret) {
    expiresAt = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS
    const claims    = `${user.id}.${locationId}.${expiresAt}`
    const signature = crypto.createHmac('sha256', secret).update(claims).digest('base64url')
    const token     = `${Buffer.from(claims).toString('base64url')}.${signature}`
    params.set('bb_sso', token)
  }

  const qs  = params.toString()
  const url = `${appUrl}/v2/location/${locationId}/${path}${qs ? `?${qs}` : ''}`

  return { statusCode: 200, headers, body: JSON.stringify({ url, expiresAt }) }
}
