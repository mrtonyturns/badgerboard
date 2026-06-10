// Netlify Function: get-shared-dossier
// Public (no auth required) — validates a share token and returns dossier content.
// Also handles listing/deactivating shares (requires auth).
//
// Actions:
//   GET  /.netlify/functions/get-shared-dossier?token=XXX  → view dossier (public)
//   POST { action: 'list',       dossier_id }              → list shares for a dossier (auth)
//   POST { action: 'deactivate', share_id   }              → deactivate a share (auth)

const SUPABASE_URL     = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const SUPABASE_SVC_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Content-Type': 'application/json',
}

// ─── Supabase REST helper ─────────────────────────────────────────────────────
async function supa(path, method = 'GET', body = null, params = '', prefer = '') {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}${params}`, {
    method,
    headers: {
      apikey:          SUPABASE_SVC_KEY,
      Authorization:   `Bearer ${SUPABASE_SVC_KEY}`,
      'Content-Type':  'application/json',
      ...(prefer ? { Prefer: prefer } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  let data = null
  try { data = JSON.parse(text) } catch {}
  return { ok: res.ok, status: res.status, data }
}

// ─── Auth helper ──────────────────────────────────────────────────────────────
async function verifyUser(authHeader) {
  if (!authHeader?.startsWith('Bearer ')) return null
  const token = authHeader.slice(7)
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_SVC_KEY, Authorization: `Bearer ${token}` },
  })
  if (!res.ok) return null
  return await res.json()
}

// ─── Handler ──────────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' }

  // ── GET: public dossier view ─────────────────────────────────────────────
  if (event.httpMethod === 'GET') {
    const token = event.queryStringParameters?.token
    if (!token) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'token is required' }) }

    // Fetch share record
    const shareRes = await supa(
      'dossier_shares', 'GET', null,
      `?token=eq.${encodeURIComponent(token)}&is_active=eq.true&select=id,dossier_id,expires_at,view_count,created_at`
    )
    if (!shareRes.ok || !Array.isArray(shareRes.data) || shareRes.data.length === 0) {
      return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'Share link not found or has been deactivated.' }) }
    }

    const share = shareRes.data[0]

    // Check expiry
    if (new Date(share.expires_at) < new Date()) {
      return { statusCode: 410, headers: CORS, body: JSON.stringify({ error: 'This share link has expired.' }) }
    }

    // Fetch the dossier (title + content + candidate info)
    const dossierRes = await supa(
      'dossiers', 'GET', null,
      `?id=eq.${share.dossier_id}&select=id,title,content,generated_at,candidates(name,party,is_incumbent,offices(name,district_name))`
    )
    if (!dossierRes.ok || !Array.isArray(dossierRes.data) || dossierRes.data.length === 0) {
      return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'Profile not found.' }) }
    }

    const dossier = dossierRes.data[0]

    // Increment view count (fire and forget — don't block the response)
    supa(
      `dossier_shares?id=eq.${share.id}`, 'PATCH',
      { view_count: share.view_count + 1 },
      '', 'return=minimal'
    ).catch(() => {})

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        dossier: {
          id:           dossier.id,
          title:        dossier.title,
          content:      dossier.content,
          generated_at: dossier.generated_at,
          candidate:    dossier.candidates,
        },
        share: {
          expires_at:  share.expires_at,
          view_count:  share.view_count, // reflects count before this visit
          created_at:  share.created_at,
        },
      }),
    }
  }

  // ── POST: authenticated share management ─────────────────────────────────
  if (event.httpMethod === 'POST') {
    const user = await verifyUser(event.headers?.authorization || event.headers?.Authorization)
    if (!user) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Unauthorized' }) }

    let body
    try { body = JSON.parse(event.body) } catch {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }
    }

    const { action } = body

    // List shares for a dossier
    if (action === 'list') {
      const { dossier_id } = body
      if (!dossier_id) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'dossier_id required' }) }

      // Verify ownership
      const own = await supa('dossiers', 'GET', null, `?id=eq.${dossier_id}&generated_by=eq.${user.id}&select=id`)
      if (!own.ok || !Array.isArray(own.data) || own.data.length === 0) {
        return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'Access denied' }) }
      }

      const shares = await supa(
        'dossier_shares', 'GET', null,
        `?dossier_id=eq.${dossier_id}&created_by=eq.${user.id}&order=created_at.desc&select=id,token,expires_at,view_count,is_active,created_at`
      )
      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({ shares: shares.data || [] }),
      }
    }

    // Deactivate a share
    if (action === 'deactivate') {
      const { share_id } = body
      if (!share_id) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'share_id required' }) }

      const res = await supa(
        `dossier_shares?id=eq.${share_id}&created_by=eq.${user.id}`,
        'PATCH', { is_active: false }, '', 'return=minimal'
      )
      if (!res.ok) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Failed to deactivate share' }) }
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) }
    }

    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: `Unknown action: ${action}` }) }
  }

  return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) }
}
