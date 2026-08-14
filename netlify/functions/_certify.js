// netlify/functions/_certify.js
// ─── 'called' → 'certified' for one election (shared writer) ──────────────────
// Prefixed with _ so Netlify does NOT deploy this as an endpoint (see netlify.toml).
//
// Wisconsin county boards of canvass certify roughly two weeks after an
// election, and WEC posts the certified canvass after that. Nothing in the app
// noticed: after election night every contest sat at 'called' forever and a
// months-old election still read like it was mid-count.
//
// TWO callers share this module so they can never disagree about what
// "certified" means:
//   • admin-elections.js  → action `certify_election` (a human presses the button)
//   • certification-watch.js → the weekly scheduled sweep, on a CITED confirmation
//
// The rules, identical on both paths:
//   • ONLY status = 'called' is flipped.
//   • 'recount_possible' is NEVER auto-certified. The engine refused to call
//     that race, so certifying it would bless an unresolved contest. Those
//     contests come back in `needs_resolution` for the admin to settle by hand
//     (call_race / set_status) first.
//   • status_source pins to 'admin' so the determination engine stops touching
//     the contest, and verified_at is stamped — exactly what set_status does
//     for status 'certified'.
//   • status_detail.reason is APPENDED to, never overwritten: "called by hand
//     for X" followed by "Certified — county canvass complete." is the audit
//     trail, and replacing it would erase how the race was decided.
//   • The UPDATE re-asserts .eq('status','called'), so a contest somebody moved
//     out of 'called' between the read and the write is left alone.
//
// No subscriber email is ever sent from here — see the note on the
// certify_election action in admin-elections.js.

const CERTIFY_REASON = 'Certified — county canvass complete.'

// Write in batches so a 400-contest November general does not open 400 sockets
// at once, and so a caller with a deadline can stop between batches.
const BATCH_SIZE = 20
// Never START another batch with less than this left on a caller's clock.
const WRITE_MIN_BUDGET_MS = 2500

const isUuid = (v) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)

/**
 * The contest's new status_detail.reason: whatever it already said, then the
 * certification sentence, then the caller's suffix (the watcher passes the
 * source URL it certified from). PURE — unit-tested in tests/remediation.test.mjs.
 */
function appendCertifyReason(detail, suffix = '') {
  const prior = detail && typeof detail === 'object' && typeof detail.reason === 'string'
    ? detail.reason.trim()
    : ''
  const tail = String(suffix == null ? '' : suffix).trim()
  return [prior, CERTIFY_REASON, tail].filter(Boolean).join(' ').slice(0, 1000)
}

/** Shape a contest row for a response / log line — never the whole row. */
const brief = (c) => ({
  contest_id: c.id,
  office:     c.office,
  district:   c.district,
  county:     c.county,
  status:     c.status,
})

function chunk(list, size) {
  const out = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

/**
 * Certify every 'called' contest in one election.
 *
 * @param {object} sb          service-role Supabase client
 * @param {string} electionId
 * @param {object} opts
 * @param {string} opts.reasonSuffix  appended after the certification sentence
 *                                    (the watcher passes "Source: <url>")
 * @param {boolean} opts.dryRun       report what would change, write nothing
 * @param {number|null} opts.deadline  epoch ms; stop starting batches near it
 * @returns {Promise<{certified:number, contests:Array, needs_resolution:Array,
 *                    deferred:number, failed:number, dry_run:boolean,
 *                    would_certify:number, error:string|null}>}
 */
async function certifyElectionContests(sb, electionId, { reasonSuffix = '', dryRun = false, deadline = null } = {}) {
  const out = {
    certified: 0,
    contests: [],
    needs_resolution: [],
    deferred: 0,
    failed: 0,
    dry_run: dryRun === true,
    would_certify: 0,
    error: null,
  }
  if (!isUuid(electionId)) { out.error = 'Invalid election_id'; return out }

  const { data: rows, error } = await sb
    .from('election_contests')
    .select('id, office, district, county, status, status_detail')
    .eq('election_id', electionId)
    .in('status', ['called', 'recount_possible'])
  if (error) { out.error = error.message; return out }

  const list = rows || []
  // Left for the admin, always — and always reported, so nobody has to go
  // looking for the races the sweep deliberately skipped.
  out.needs_resolution = list.filter(c => c.status === 'recount_possible').map(brief)

  const pending = list.filter(c => c.status === 'called')
  if (!pending.length) return out

  if (out.dry_run) {
    out.would_certify = pending.length
    out.contests = pending.map(brief)
    return out
  }

  const now = new Date().toISOString()
  const batches = chunk(pending, BATCH_SIZE)
  for (let i = 0; i < batches.length; i++) {
    if (deadline && Date.now() > deadline - WRITE_MIN_BUDGET_MS) {
      // Out of clock: everything still unwritten carries to the next run rather
      // than being killed mid-flight.
      out.deferred = batches.slice(i).reduce((s, b) => s + b.length, 0)
      break
    }
    await Promise.all(batches[i].map(async (c) => {
      const priorDetail = c.status_detail && typeof c.status_detail === 'object' && !Array.isArray(c.status_detail)
        ? c.status_detail
        : {}
      const { data: updated, error: uErr } = await sb
        .from('election_contests')
        .update({
          status: 'certified',
          status_source: 'admin',
          status_updated_at: now,
          verified_at: now,
          status_detail: {
            ...priorDetail,
            reason: appendCertifyReason(c.status_detail, reasonSuffix),
            computed_at: now,
            source: 'admin',
          },
        })
        .eq('id', c.id)
        .eq('status', 'called')     // somebody moved it since the read → leave it alone
        .select('id')
      if (uErr || !updated || !updated.length) {
        out.failed += 1
        if (uErr) console.warn(`[_certify] contest ${c.id} not certified: ${uErr.message}`)
        return
      }
      out.certified += 1
      out.contests.push(brief(c))
    }))
  }

  return out
}

module.exports = {
  certifyElectionContests,
  appendCertifyReason,
  CERTIFY_REASON,
}
