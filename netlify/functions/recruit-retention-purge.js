// Netlify Scheduled Function: recruit-retention-purge
// ─── 12-month retention purge for Recruit research fields ────────────────────
//
// Promised by the footer of supabase/migrations/20260812000011_recruitment.sql:
//
//   "12-month purge of the RESEARCH fields only (affiliation_*, notoriety,
//    sentiment, evidence, research_summary) is a scheduled-function follow-up
//    (precedent: trial-expiry.js). Deliberately NOT a trigger here — deleting a
//    user's data on a schedule belongs in code that can be audited and disabled."
//
// This is that follow-up. It BLANKS research output; it never deletes a
// prospect row. The identity columns the user supplied (name, address, the
// voter-list linkage) are theirs and are left alone — what expires is the
// AI-derived profile we built ON them, which is the part with a shelf life.
//
// Schedule lives in netlify.toml (weekly, Tuesday 08:00 UTC) alongside the
// other crons. Netlify's scheduler invokes the handler with no httpMethod;
// any real HTTP request must present ADMIN_TRIGGER_SECRET in x-admin-trigger,
// exactly like monitoring-digest.js and auto-regenerate-dossiers.js.
//
// HTTP trigger (testing): POST with x-admin-trigger: ADMIN_TRIGGER_SECRET
//   body { dry_run?: true, months?: 12 }
//   dry_run counts the eligible rows and writes nothing.

const nodeCrypto = require('crypto')

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY

// Research output older than this is purged. One year, per the gameplan.
const RETENTION_MONTHS = 12

// The status a purged row carries afterwards, so a later run skips it and the
// UI can tell "never researched" (pending) apart from "researched, then aged
// out" (purged).
const PURGED_STATUS = 'purged'

// Constant-time secret comparison (L2): hash both sides to equal length, then
// crypto.timingSafeEqual — a plain !== comparison leaks timing information.
function safeEqual(a, b) {
  const A = nodeCrypto.createHash('sha256').update(String(a ?? '')).digest()
  const B = nodeCrypto.createHash('sha256').update(String(b ?? '')).digest()
  return nodeCrypto.timingSafeEqual(A, B)
}

// ─── Pure helpers (unit-tested in tests/recruit.test.mjs) ────────────────────

/**
 * The instant that divides "keep" from "purge": now minus `months` months, in
 * UTC. Anything researched STRICTLY BEFORE this is eligible.
 *
 * Month arithmetic is done on the UTC month field, so a run on the 31st of a
 * month whose counterpart is shorter (31 Mar → 31 Feb) is clamped back to the
 * last real day of that month rather than rolling forward into the next one.
 * Clamping can only ever move the cutoff EARLIER, never later, so no row is
 * ever purged before its twelve months are up.
 */
function retentionCutoff(now = new Date(), months = RETENTION_MONTHS) {
  const base = now instanceof Date ? now : new Date(now)
  const ms = base.getTime()
  if (!Number.isFinite(ms)) throw new TypeError('retentionCutoff: invalid date')

  const n = Number(months)
  const span = Number.isFinite(n) && n > 0 ? Math.floor(n) : RETENTION_MONTHS

  const day = base.getUTCDate()
  const cutoff = new Date(ms)
  cutoff.setUTCDate(1)                                   // avoid the 31st rolling over
  cutoff.setUTCMonth(cutoff.getUTCMonth() - span)
  const lastDayOfTargetMonth = new Date(Date.UTC(
    cutoff.getUTCFullYear(), cutoff.getUTCMonth() + 1, 0
  )).getUTCDate()
  cutoff.setUTCDate(Math.min(day, lastDayOfTargetMonth))
  return cutoff.toISOString()
}

/**
 * Would this prospect row be purged by a run with this cutoff?
 * Mirrors the PostgREST filter below exactly — it is the same predicate,
 * written twice, so the filter can be asserted without a database.
 */
function isPurgeable(row, cutoffIso) {
  if (!row || !row.researched_at) return false            // never researched → nothing to purge
  if (row.research_status === PURGED_STATUS) return false // already purged
  const at = Date.parse(row.researched_at)
  if (!Number.isFinite(at)) return false
  return at < Date.parse(cutoffIso)
}

// The blanked shape. 'unknown' / [] rather than NULL wherever the column has a
// CHECK-constrained vocabulary or a JSONB default, so a purged row still reads
// as a legal, boring prospect everywhere in the UI.
const PURGE_PATCH = Object.freeze({
  affiliation_value:      'unknown',
  affiliation_confidence: null,
  affiliation_basis:      null,
  notoriety:              'unknown',
  sentiment:              'unknown',
  evidence:               [],
  research_summary:       null,
  research_status:        PURGED_STATUS,
})

// ─── Handler ─────────────────────────────────────────────────────────────────

exports.handler = async (event = {}) => {
  const headers = { 'Content-Type': 'application/json' }

  const isHttp = Boolean(event.httpMethod)
  let opts = {}
  if (isHttp) {
    if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' }
    const secret = process.env.ADMIN_TRIGGER_SECRET
    const provided = event.headers?.['x-admin-trigger'] || event.headers?.['X-Admin-Trigger']
    if (!secret || !safeEqual(provided, secret)) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Not authorized' }) }
    }
    try { opts = JSON.parse(event.body || '{}') } catch {}
  }

  if (!SUPABASE_URL || !SERVICE_KEY) {
    console.error('[recruit-purge] Missing Supabase env vars — skipping run')
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Missing Supabase configuration' }) }
  }

  const startedAt = Date.now()
  const months = Number.isFinite(Number(opts.months)) && Number(opts.months) > 0
    ? Math.floor(Number(opts.months))
    : RETENTION_MONTHS
  const cutoff = retentionCutoff(new Date(), months)

  // Same predicate as isPurgeable(): researched, not already purged, aged out.
  const filter = `researched_at=lt.${encodeURIComponent(cutoff)}`
    + `&research_status=neq.${PURGED_STATUS}`

  const rest = (path, init) => fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
  })

  // ── 1. How many rows are in scope? (also the whole job when dry_run) ───────
  let eligible = 0
  try {
    const res = await rest(`/recruitment_prospects?select=id&${filter}`, {
      method: 'HEAD',
      headers: { Prefer: 'count=exact', Range: '0-0' },
    })
    if (!res.ok) throw new Error(`count failed (${res.status})`)
    eligible = Number(String(res.headers.get('content-range') || '').split('/')[1]) || 0
  } catch (err) {
    console.error('[recruit-purge] count failed:', err.message)
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Count query failed' }) }
  }

  if (opts.dry_run) {
    console.log(`[recruit-purge] dry run: ${eligible} prospect(s) researched before ${cutoff} would be purged`)
    return {
      statusCode: 200, headers,
      body: JSON.stringify({ message: 'Dry run', dry_run: true, cutoff, months, eligible, purged: 0 }),
    }
  }

  if (!eligible) {
    console.log(`[recruit-purge] nothing to purge (cutoff ${cutoff})`)
    return {
      statusCode: 200, headers,
      body: JSON.stringify({ message: 'Nothing to purge', cutoff, months, eligible: 0, purged: 0 }),
    }
  }

  // ── 2. Blank the research fields in one statement ─────────────────────────
  // return=representation gives back the affected ids, which is the only count
  // we can trust (rows can age past the cutoff between the count and the write).
  const patchOnce = async (patch) => rest(
    `/recruitment_prospects?${filter}&select=id`,
    { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(patch) },
  )

  let purged = 0
  let statusWritten = true
  try {
    let res = await patchOnce(PURGE_PATCH)

    // The research_status CHECK constraint shipped in 20260812000011 predates
    // this function and does not list 'purged'. Until a migration widens it,
    // fall back to blanking everything EXCEPT the status — the user's research
    // data still goes on schedule, which is the part that matters — and say so
    // loudly in the log so the constraint gets fixed.
    if (!res.ok && res.status === 400) {
      const body = await res.text()
      if (/research_status|check constraint/i.test(body)) {
        console.warn(
          '[recruit-purge] research_status CHECK constraint rejects \'purged\' — '
          + 'purging without the status flag. Widen the constraint on '
          + 'recruitment_prospects.research_status to include \'purged\'. Detail: '
          + body.slice(0, 300)
        )
        const { research_status, ...withoutStatus } = PURGE_PATCH
        statusWritten = false
        res = await patchOnce(withoutStatus)
      } else {
        throw new Error(`purge failed (400): ${body.slice(0, 300)}`)
      }
    }

    if (!res.ok) throw new Error(`purge failed (${res.status}): ${(await res.text()).slice(0, 300)}`)
    const rows = await res.json().catch(() => [])
    purged = Array.isArray(rows) ? rows.length : 0
  } catch (err) {
    console.error('[recruit-purge] purge failed:', err.message)
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Purge failed', cutoff, eligible }) }
  }

  const summary = {
    message: 'Retention purge complete',
    cutoff,
    months,
    eligible,
    purged,
    status_flag_written: statusWritten,
    duration_ms: Date.now() - startedAt,
  }
  console.log(
    `[recruit-purge] purged research fields on ${purged} of ${eligible} prospect(s) `
    + `researched before ${cutoff} (${months}-month retention) in ${summary.duration_ms}ms`
    + (statusWritten ? '' : ' — research_status left untouched, see warning above')
  )
  return { statusCode: 200, headers, body: JSON.stringify(summary) }
}

// pure, unit-tested in tests/recruit.test.mjs
module.exports.retentionCutoff  = retentionCutoff
module.exports.isPurgeable      = isPurgeable
module.exports.PURGE_PATCH      = PURGE_PATCH
module.exports.RETENTION_MONTHS = RETENTION_MONTHS
module.exports.PURGED_STATUS    = PURGED_STATUS
