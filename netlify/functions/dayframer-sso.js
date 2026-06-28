// Netlify Function: dayframer-sso
// Returns the embed URL for a DayFramer (GoHighLevel) tool inside the user's
// subaccount — Email Campaigns, Social Planner, or the QR Code Generator.
//
// GET ?section=email|social|qr
//
// If DAYFRAMER_SSO_SECRET is configured, the URL carries a short-lived
// HMAC-signed token (bb_sso) the white-label side can validate to start a
// session without prompting for login. Without the secret, the plain GHL URL
// is returned — the user's existing GHL session (created with their Badger
// Board email when the workspace was provisioned) keeps them signed in.
//
// Env vars:
//   DAYFRAMER_APP_URL    — app base URL (default https://app.gohighlevel.com;
//                          swap for the white-label domain when ready)
//   DAYFRAMER_SSO_SECRET — optional shared HMAC secret for token signing
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

  // Best-effort "main area only" — ask the white-label app to hide its own nav
  // chrome. Honored only if DayFramer exposes an embed view; harmless otherwise.
  // The reliable chrome-less result requires a DayFramer-side embed mode
  // (see DAYFRAMER_EMBED_REQUIREMENTS.md).
  params.set('embed', 'true')

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

  const url = `${appUrl}/v2/location/${locationId}/${path}?${params.toString()}`

  return { statusCode: 200, headers, body: JSON.stringify({ url, expiresAt }) }
}
