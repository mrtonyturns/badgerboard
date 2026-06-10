// Netlify Function: dayframer-sso
// Issues a short-lived signed embed URL for a DayFramer tool so users can open
// Email Campaigns / Social Planner inside Badger Board without a second login.
//
// GET ?section=email|social
//
// The returned URL points at the DayFramer white-label app with an HMAC-signed
// token (bb_sso). The DayFramer side validates the token with the shared
// secret and starts a session scoped to the user's subaccount.
//
// Required env vars:
//   DAYFRAMER_APP_URL    — white-label app base URL (e.g. https://app.dayframer.com)
//   DAYFRAMER_SSO_SECRET — shared HMAC secret for token signing
//   plus the Supabase vars used by _dayframer.js

const crypto = require('crypto')
const { getUserFromRequest, hasMarketingAccess } = require('./_dayframer')

const TOKEN_TTL_SECONDS = 5 * 60

// Section → path inside the DayFramer location app
const SECTION_PATHS = {
  email:  'marketing/emails',
  social: 'marketing/social-planner',
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
    return { statusCode: 403, headers, body: JSON.stringify({ error: 'Marketing Tier required' }) }
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

  const appUrl = process.env.DAYFRAMER_APP_URL
  const secret = process.env.DAYFRAMER_SSO_SECRET
  if (!appUrl || !secret) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'DayFramer SSO not configured (DAYFRAMER_APP_URL / DAYFRAMER_SSO_SECRET)' }),
    }
  }

  // Signed, short-lived token: userId.locationId.expiry + HMAC signature.
  // DayFramer validates with the shared secret and rejects expired tokens.
  const expiresAt = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS
  const claims    = `${user.id}.${locationId}.${expiresAt}`
  const signature = crypto.createHmac('sha256', secret).update(claims).digest('base64url')
  const token     = `${Buffer.from(claims).toString('base64url')}.${signature}`

  const url = `${appUrl.replace(/\/$/, '')}/v2/location/${locationId}/${path}?bb_sso=${token}`

  return { statusCode: 200, headers, body: JSON.stringify({ url, expiresAt }) }
}
