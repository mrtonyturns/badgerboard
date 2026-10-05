/**
 * admin-setup-candidate-storage.js
 * One-time setup: ensures the `candidate-files` Supabase Storage bucket exists
 * (Storage REST API, service role).
 *
 * The storage.objects RLS policies are NOT applied here any more: they live in
 * migrations (20260516000001_candidate_notes_files.sql, re-asserted in
 * 20260704000004_backend_hardening.sql; the bucket row itself is also in
 * 20260812000020_schema_reconciliation.sql). This function used to push raw
 * CREATE POLICY SQL through rpc/exec_sql — an arbitrary-SQL RPC that should
 * not exist on the REST surface — so that call is gone.
 *
 * POST (no body required) — ADMIN only
 * Returns: { ok, bucket, existed, results }
 */

const SUPABASE_URL    = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const SERVICE_KEY     = process.env.SUPABASE_SERVICE_ROLE_KEY
const SUPABASE_ANON   = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY

// Canonical admin allowlist — no divergent hardcoded fallback, no personal Gmail.
const { ADMIN_EMAILS, corsHeaders } = require('./_config')
const BUCKET_NAME  = 'candidate-files'

async function verifyAdmin(authHeader) {
  if (!authHeader?.startsWith('Bearer ')) return null
  const token = authHeader.slice(7)
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${token}` },
  })
  if (!res.ok) return null
  const user = await res.json()
  if (!user?.email || !ADMIN_EMAILS.includes(user.email.toLowerCase())) return null
  return user
}

async function storageRequest(path, method = 'GET', body = null) {
  const opts = {
    method,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
    },
  }
  if (body) opts.body = JSON.stringify(body)
  return fetch(`${SUPABASE_URL}/storage/v1${path}`, opts)
}

exports.handler = async (event) => {
  // Per-request CORS (admin endpoint — no wildcard origin)
  const HEADERS = corsHeaders(event.headers?.origin || event.headers?.Origin)
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: HEADERS, body: '' }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) }
  }

  if (!SERVICE_KEY) {
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' }) }
  }

  const authHeader = event.headers?.authorization || event.headers?.Authorization
  const admin = await verifyAdmin(authHeader)
  if (!admin) {
    return { statusCode: 403, headers: HEADERS, body: JSON.stringify({ error: 'Admin access required' }) }
  }

  const results = []
  let failed = false

  // ── 1. Check if bucket exists ────────────────────────────────────────────────
  const listRes = await storageRequest('/bucket')
  const buckets = listRes.ok ? await listRes.json() : []
  const exists  = Array.isArray(buckets) && buckets.some(b => b.name === BUCKET_NAME)

  if (exists) {
    results.push(`Bucket '${BUCKET_NAME}' already exists — skipping creation`)
  } else {
    // ── 2. Create bucket ───────────────────────────────────────────────────────
    const createRes = await storageRequest('/bucket', 'POST', {
      id:            BUCKET_NAME,
      name:          BUCKET_NAME,
      public:        false,
      file_size_limit: 52428800, // 50 MB
      allowed_mime_types: [
        'application/pdf',
        'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.ms-excel',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'text/plain',
        'text/csv',
        'image/jpeg',
        'image/png',
        'image/gif',
        'image/webp',
      ],
    })
    if (createRes.ok) {
      results.push(`Bucket '${BUCKET_NAME}' created successfully`)
    } else {
      const err = await createRes.text()
      results.push(`Bucket creation failed: ${err}`)
      failed = true
    }
  }

  // ── 3. Storage RLS policies ─────────────────────────────────────────────────
  // Owned by migrations (see header) — nothing to apply at runtime.
  results.push(`Storage policies for '${BUCKET_NAME}' are managed by migrations (20260516000001 / 20260704000004)`)

  return {
    statusCode: failed ? 502 : 200,
    headers: HEADERS,
    body: JSON.stringify({
      ok: !failed,
      bucket: BUCKET_NAME,
      existed: exists,
      results,
    }),
  }
}
