// Netlify Function: dayframer-subaccount
// Creates (or returns) the user's DayFramer marketing subaccount, provisioned
// from their Badger Board account details (business, name, email, phone).
//
// POST — no body required; the user is derived from the Supabase JWT.
// Gated server-side: requires an active Marketing Tier (or admin).
//
// Required env vars: see _dayframer.js

const {
  getUserFromRequest,
  hasMarketingAccess,
  provisionSubaccount,
} = require('./_dayframer')

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json' }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) }
  }

  const user = await getUserFromRequest(event)
  if (!user) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Not authenticated' }) }
  }

  if (!hasMarketingAccess(user)) {
    return { statusCode: 403, headers, body: JSON.stringify({ error: 'Marketing Tier required' }) }
  }

  try {
    const { locationId, existing } = await provisionSubaccount(user)
    console.log(`DayFramer subaccount ${existing ? 'reused' : 'created'}: ${locationId} for user ${user.id}`)
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, locationId, existing }) }
  } catch (err) {
    console.error('DayFramer subaccount error:', err.message)
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message || 'Workspace creation failed' }) }
  }
}
