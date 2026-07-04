// Netlify Function: ghl-contact
// Syncs a candidate contact record to GoHighLevel (Dayframer)
// Required env vars: GHL_API_KEY, GHL_LOCATION_ID

const GHL_API_KEY     = process.env.GHL_API_KEY
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID

// ─── Sanitization ─────────────────────────────────────────────────────────────
function sanitize(val, maxLen = 200) {
  if (val === null || val === undefined) return ''
  return String(val)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .slice(0, maxLen)
    .trim()
}

function isValidEmail(email) {
  return /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/.test(email)
}

const ALLOWED_POSITIONS = [
  'Governor', 'Lt. Governor', 'Attorney General', 'Secretary of State',
  'State Treasurer', 'State Senator', 'State Assembly', 'State Representative',
  'US Senator', 'US Representative', 'Mayor', 'County Executive',
  'County Board', 'City Council', 'School Board', 'District Attorney',
  'Sheriff', 'County Clerk', 'Register of Deeds', 'Circuit Court Judge',
  'Supreme Court Justice', 'Other',
]

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  }

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) }
  }

  // Require a signed-in user — prevents anonymous abuse that spams the CRM.
  const SUPABASE_URL  = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const SUPABASE_ANON = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY
  const authHeader = event.headers?.authorization || event.headers?.Authorization
  if (!authHeader?.startsWith('Bearer ')) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Not authenticated' }) }
  }
  try {
    const authRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_ANON, Authorization: authHeader },
    })
    if (!authRes.ok) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid token' }) }
  } catch {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Auth check failed' }) }
  }

  if (!GHL_API_KEY || !GHL_LOCATION_ID) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'GHL API not configured' }) }
  }

  let body
  try {
    body = JSON.parse(event.body)
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }
  }

  // Validate and sanitize inputs
  const firstName = sanitize(body.firstName, 100)
  const lastName  = sanitize(body.lastName,  100)
  const email     = sanitize(body.email,     254)
  const phone     = sanitize(body.phone,     30)
  const business  = sanitize(body.business,  200)
  const position  = sanitize(body.position,  100)

  if (!firstName) return { statusCode: 400, headers, body: JSON.stringify({ error: 'firstName is required' }) }
  if (!lastName)  return { statusCode: 400, headers, body: JSON.stringify({ error: 'lastName is required' }) }
  if (!email || !isValidEmail(email)) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Valid email is required' }) }
  if (position && !ALLOWED_POSITIONS.includes(position)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: `Invalid position value` }) }
  }

  const contactPayload = {
    locationId: GHL_LOCATION_ID,
    firstName,
    lastName,
    email,
    ...(phone    && { phone }),
    ...(business && { companyName: business }),
    ...(position && { customFields: [{ key: 'political_position', value: position }] }),
    tags: ['badger-board', 'candidate'],
  }

  try {
    // Check if contact exists first
    const searchRes = await fetch(
      `https://services.leadconnectorhq.com/contacts/search?locationId=${GHL_LOCATION_ID}&email=${encodeURIComponent(email)}`,
      { headers: { Authorization: `Bearer ${GHL_API_KEY}`, Version: '2021-07-28' } }
    )
    const searchData = await searchRes.json()
    const existing = searchData?.contacts?.[0]

    let result
    if (existing?.id) {
      // Update existing contact
      const updateRes = await fetch(
        `https://services.leadconnectorhq.com/contacts/${existing.id}`,
        {
          method: 'PUT',
          headers: { Authorization: `Bearer ${GHL_API_KEY}`, Version: '2021-07-28', 'Content-Type': 'application/json' },
          body: JSON.stringify(contactPayload),
        }
      )
      result = await updateRes.json()
    } else {
      // Create new contact
      const createRes = await fetch(
        'https://services.leadconnectorhq.com/contacts/',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${GHL_API_KEY}`, Version: '2021-07-28', 'Content-Type': 'application/json' },
          body: JSON.stringify(contactPayload),
        }
      )
      result = await createRes.json()
    }

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, contact: result?.contact || result }) }
  } catch (err) {
    console.error('GHL contact sync error:', err)
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message || 'GHL sync failed' }) }
  }
}
