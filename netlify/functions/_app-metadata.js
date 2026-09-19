// netlify/functions/_app-metadata.js — the ONE way to change app_metadata.
//
// ROOT CAUSE OF THE "TRIAL NEVER EXPIRES / BETA NEVER TURNS OFF" BUG
// (found Sep 19 2026 on campaign@braydenmyer.com):
//
//   Supabase's admin endpoint  PUT /auth/v1/admin/users/:id  MERGES the
//   app_metadata object you send with what is stored. A key you leave OUT of
//   the payload is KEPT, not removed. Three functions did
//       const meta = { ...user.app_metadata }; delete meta.trial_plan; PUT(meta)
//   which is a silent no-op for the deleted keys. trial-expiry therefore saw
//   the same expired trial every morning and re-sent "your trial has ended"
//   daily for a month; admin "turn off beta" left beta_mode: true in place.
//
//   The only thing the merge honors as a removal is an explicit null. This
//   helper diffs the object before and after the mutation and sends every
//   deleted key as null. Every consumer of app_metadata already treats null
//   like absent (`!m.trial_plan`, `=== true`, SQL `->>` yields NULL).

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY

const adminHeaders = () => ({
  'Content-Type': 'application/json',
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
})

async function getUser(userId) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, { headers: adminHeaders() })
  if (!res.ok) return null
  return res.json()
}

/**
 * Pure: the payload that makes the stored metadata equal `after`, given the
 * merge semantics. Deleted keys are sent as null.
 */
function mergePayload(before, after) {
  const payload = { ...after }
  for (const k of Object.keys(before || {})) {
    if (!(k in payload)) payload[k] = null
  }
  return payload
}

/** PUT a diffed payload. `before` must be the metadata as currently stored. */
async function putAppMetadataDiff(userId, before, after) {
  const payload = mergePayload(before, after)
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
    method: 'PUT',
    headers: adminHeaders(),
    body: JSON.stringify({ app_metadata: payload }),
  })
  if (!res.ok) throw new Error(`Supabase metadata update failed (${res.status}): ${await res.text()}`)
  return res.json()
}

/**
 * Fetch → mutate a copy → PUT the diff. `mutate(meta)` may add, change or
 * `delete` keys; deletions are honored. Returns { user, updated }.
 */
async function updateAppMetadata(userId, mutate) {
  const user = await getUser(userId)
  if (!user) throw new Error('User not found')
  const before = user.app_metadata || {}
  const after = { ...before }
  mutate(after)
  const updated = await putAppMetadataDiff(userId, before, after)
  return { user, updated }
}

module.exports = { getUser, mergePayload, putAppMetadataDiff, updateAppMetadata }
