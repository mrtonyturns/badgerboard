// netlify/functions/fetch-candidate-x-feed.js
// Proxies X (Twitter) API v2 recent-search server-side so the Bearer Token
// never touches the browser.
//
// Required env vars:
//   X_BEARER_TOKEN          — X Developer App Bearer Token
//   SUPABASE_URL            — or VITE_SUPABASE_URL
//   SUPABASE_ANON_KEY       — or VITE_SUPABASE_ANON_KEY
//
// POST body: { candidateName, handle?, district? }
//   candidateName — full name e.g. "Jane Smith"
//   handle        — X handle without @, e.g. "janesmith4wi"  (optional)
//   district      — e.g. "Assembly District 32"             (optional)
//
// Returns: { tweets: [ { id, text, author_name, author_username,
//                        author_image, created_at, public_metrics } ] }

const SUPABASE_URL  = process.env.SUPABASE_URL  || process.env.VITE_SUPABASE_URL
const SUPABASE_ANON = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY
const X_BEARER      = process.env.X_BEARER_TOKEN

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
}

function sanitize(val, max = 200) {
  if (val == null) return ''
  return String(val).replace(/[<>"'`]/g, '').slice(0, max)
}

// Build an X API v2 recent-search query for the candidate.
// We search by @handle (if known) OR by name in Wisconsin political context.
function buildQuery(name, handle) {
  const parts = []

  if (handle) {
    // Posts BY the candidate's account
    parts.push(`from:${handle}`)
  }

  // Posts mentioning the candidate (name in quotes, Wisconsin context)
  const quotedName = `"${name}"`
  parts.push(`${quotedName} Wisconsin`)

  // Exclude retweets to reduce noise, exclude replies for cleaner feed
  const base = parts.length > 1
    ? `(${parts.join(' OR ')})`
    : parts[0]

  return `${base} -is:retweet lang:en`
}

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) }
  }

  // ── Auth guard ──────────────────────────────────────────────────────────────
  const authHeader = event.headers?.authorization || event.headers?.Authorization
  if (!authHeader?.startsWith('Bearer ')) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Not authenticated' }) }
  }
  const authRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON, Authorization: authHeader },
  })
  if (!authRes.ok) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Invalid or expired token' }) }
  }

  // ── Check X API key ─────────────────────────────────────────────────────────
  if (!X_BEARER) {
    return {
      statusCode: 503,
      headers: CORS,
      body: JSON.stringify({
        error: 'X API not configured',
        hint: 'Add X_BEARER_TOKEN to your Netlify environment variables.',
      }),
    }
  }

  // ── Parse body ──────────────────────────────────────────────────────────────
  let body
  try {
    body = JSON.parse(event.body || '{}')
  } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }
  }

  const candidateName = sanitize(body.candidateName, 150)
  // X handles are [A-Za-z0-9_], ≤15 chars. Enforce strictly so a crafted handle
  // can't inject search operators (e.g. "foo OR from:someoneelse").
  const handle        = (sanitize(body.handle, 50).replace(/^@/, '').match(/^[A-Za-z0-9_]{1,15}/) || [''])[0]
  const district      = sanitize(body.district, 100)

  if (!candidateName) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'candidateName is required' }) }
  }

  // ── Call X API v2 recent search ─────────────────────────────────────────────
  const query = buildQuery(candidateName, handle || null)
  const params = new URLSearchParams({
    query,
    max_results:    '20',
    'tweet.fields': 'created_at,public_metrics,author_id',
    expansions:     'author_id',
    'user.fields':  'name,username,profile_image_url',
  })

  const xUrl = `https://api.twitter.com/2/tweets/search/recent?${params.toString()}`

  let xData
  try {
    const ctrl = new AbortController()
    setTimeout(() => ctrl.abort(), 15000)
    const xRes = await fetch(xUrl, {
      headers: { Authorization: `Bearer ${X_BEARER}` },
      signal: ctrl.signal,
    })

    if (xRes.status === 401) {
      return { statusCode: 503, headers: CORS, body: JSON.stringify({ error: 'X API key invalid or expired. Check X_BEARER_TOKEN in Netlify env vars.' }) }
    }
    if (xRes.status === 429) {
      return { statusCode: 429, headers: CORS, body: JSON.stringify({ error: 'X API rate limit reached. Try again in a few minutes.' }) }
    }
    if (!xRes.ok) {
      const errText = await xRes.text()
      console.error(`[x-feed] X API ${xRes.status}: ${errText}`)
      return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: `X API error: ${xRes.status}` }) }
    }

    xData = await xRes.json()
  } catch (err) {
    console.error('[x-feed] fetch error:', err.message)
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'Failed to reach X API' }) }
  }

  // ── Shape the response ──────────────────────────────────────────────────────
  const tweets  = xData.data     || []
  const users   = xData.includes?.users || []

  // Build a quick lookup: author_id → user object
  const userMap = {}
  for (const u of users) userMap[u.id] = u

  const shaped = tweets.map(t => {
    const author = userMap[t.author_id] || {}
    return {
      id:              t.id,
      text:            t.text,
      author_name:     author.name     || 'Unknown',
      author_username: author.username || '',
      author_image:    author.profile_image_url || null,
      created_at:      t.created_at,
      public_metrics:  t.public_metrics || {},
    }
  })

  console.log(`[x-feed] Returned ${shaped.length} tweets for "${candidateName}"`)

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({ tweets: shaped, query, count: shaped.length }),
  }
}
