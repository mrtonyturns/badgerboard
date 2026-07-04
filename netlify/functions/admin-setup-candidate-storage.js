/**
 * admin-setup-candidate-storage.js
 * One-time setup: creates the `candidate-files` Supabase Storage bucket
 * and applies RLS policies so authenticated users can manage their own files.
 *
 * POST (no body required) — ADMIN only
 * Returns: { ok: true, created: boolean, message: string }
 */

const SUPABASE_URL    = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const SERVICE_KEY     = process.env.SUPABASE_SERVICE_ROLE_KEY
const SUPABASE_ANON   = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY

// Canonical admin allowlist — no divergent hardcoded fallback, no personal Gmail.
const { ADMIN_EMAILS } = require('./_config')
const BUCKET_NAME  = 'candidate-files'

const HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
}

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
    }
  }

  // ── 3. Apply storage RLS policies via SQL ─────────────────────────────────────
  // Path pattern: {userId}/{candidateId}/{filename}
  // Policy: users can only access objects under their own userId prefix
  const policies = [
    {
      name: `${BUCKET_NAME}_insert`,
      sql: `
        CREATE POLICY IF NOT EXISTS "${BUCKET_NAME}_insert"
        ON storage.objects FOR INSERT
        TO authenticated
        WITH CHECK (
          bucket_id = '${BUCKET_NAME}'
          AND (storage.foldername(name))[1] = auth.uid()::text
        );
      `,
    },
    {
      name: `${BUCKET_NAME}_select`,
      sql: `
        CREATE POLICY IF NOT EXISTS "${BUCKET_NAME}_select"
        ON storage.objects FOR SELECT
        TO authenticated
        USING (
          bucket_id = '${BUCKET_NAME}'
          AND (storage.foldername(name))[1] = auth.uid()::text
        );
      `,
    },
    {
      name: `${BUCKET_NAME}_update`,
      sql: `
        CREATE POLICY IF NOT EXISTS "${BUCKET_NAME}_update"
        ON storage.objects FOR UPDATE
        TO authenticated
        USING (
          bucket_id = '${BUCKET_NAME}'
          AND (storage.foldername(name))[1] = auth.uid()::text
        );
      `,
    },
    {
      name: `${BUCKET_NAME}_delete`,
      sql: `
        CREATE POLICY IF NOT EXISTS "${BUCKET_NAME}_delete"
        ON storage.objects FOR DELETE
        TO authenticated
        USING (
          bucket_id = '${BUCKET_NAME}'
          AND (storage.foldername(name))[1] = auth.uid()::text
        );
      `,
    },
  ]

  for (const policy of policies) {
    try {
      // Execute SQL via Supabase REST API (requires service role)
      const sqlRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/exec_sql`, {
        method: 'POST',
        headers: {
          apikey: SERVICE_KEY,
          Authorization: `Bearer ${SERVICE_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ sql: policy.sql }),
      })
      // exec_sql may not exist — that's OK, policies can be set via dashboard
      if (sqlRes.ok) {
        results.push(`Policy '${policy.name}' applied`)
      } else {
        results.push(`Policy '${policy.name}' — apply via dashboard (exec_sql unavailable)`)
      }
    } catch {
      results.push(`Policy '${policy.name}' — apply via dashboard`)
    }
  }

  return {
    statusCode: 200,
    headers: HEADERS,
    body: JSON.stringify({
      ok: true,
      bucket: BUCKET_NAME,
      existed: exists,
      results,
      note: 'If storage policies failed, add them manually in the Supabase dashboard under Storage > Policies.',
    }),
  }
}
