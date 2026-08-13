// netlify/functions/admin-elections.js
// ─── Admin-only election CRUD (audit fix #13) ────────────────────────────────
//
// Migration 20260704000004 made elections/election_contests/election_results
// read-only to browser clients, but the Elections page and the election-night
// admin board kept writing directly with the anon client: INSERTs errored and
// UPDATE/DELETE silently matched 0 rows while the UI toasted success. All
// election writes now route through this service-role function, admin-gated,
// with affected-row checks so 0-row writes surface as real errors.
//
// Actions (POST { action, params }, admin JWT required):
//   save_election    { id?, data }        insert or update an election
//   delete_election  { id }
//   save_contest     { id?, data }        insert or update a contest
//   delete_contest   { id }               (cascades results via FK)
//   save_result      { id?, data }        insert/update + recalc vote_pct
//   delete_result    { id }               (recalcs vote_pct for the contest)
//   call_race        { result_id, contest_id, candidate_name }
//   uncall_race      { contest_id }
//   update_precincts { contest_id, rptg, total }
//   set_status       { contest_id, status, source }   admin override
//   reset_status_auto{ contest_id }                   hand the contest back to the engine
//   advance_unopposed{ election_id, dry_run? }        call every uncontested race at once
//
// ─── Determination engine wiring (Phase 1) ──────────────────────────────────
// After any mutation that changes a contest's vote or precinct picture
// (save_result / delete_result / update_precincts / save_contest) the pure
// engine in ./_determination.js recomputes the contest's status.
//
// The engine ONLY writes when election_contests.status_source = 'auto'. The
// moment an admin calls a race or sets a status by hand, status_source flips
// to 'admin' and the engine stops touching that contest — manual overrides
// always beat the engine (SPEC). `reset_status_auto` hands it back.
//
// Every mutation, successful or not, appends an audit row to
// election_poller_log with source 'admin:<action>'.
//
// ─── Subscriber notifications ───────────────────────────────────────────────
// save_result / update_precincts / call_race / set_status / reset_status_auto
// hand the contest to ./_result-notify.js afterwards, which emails whoever
// subscribed to that race from the Results board. It never throws and it is
// fired AFTER the write has landed, so an email problem can never fail an
// admin's edit.

const { cors, json, serviceClient, requireAdmin } = require('./_shared')
const { determineStatus, ALLOWED_STATUSES } = require('./_determination')
const { notifyContestChanges, sendStatusUpdateNow } = require('./_result-notify')
const { callEmbargoActive, ctParts } = require('./election-results-poller')

// Column whitelists — never pass client objects straight to the DB
const ELECTION_FIELDS = ['name', 'election_date', 'filing_deadline', 'type', 'year', 'notes']
const CONTEST_FIELDS  = ['election_id', 'office', 'office_type', 'district', 'county', 'precincts_total', 'precincts_rptg', 'is_nonpartisan', 'seats']
const RESULT_FIELDS   = ['contest_id', 'candidate_name', 'party', 'incumbent', 'votes', 'winner', 'declared', 'vote_pct', 'candidate_id']

const isUuid = (v) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)

function pick(obj, fields) {
  const out = {}
  for (const f of fields) if (obj && obj[f] !== undefined) out[f] = obj[f]
  return out
}

// Insert (no id) or update (id) one row; verifies the write actually landed.
async function saveRow(sb, table, fields, { id, data }) {
  const payload = pick(data, fields)
  if (!Object.keys(payload).length) return json(400, { error: 'No valid fields provided' })
  if (id) {
    if (!isUuid(id)) return json(400, { error: 'Invalid id' })
    const { data: rows, error } = await sb.from(table).update(payload).eq('id', id).select()
    if (error) return json(500, { error: error.message })
    if (!rows?.length) return json(404, { error: 'Row not found — nothing was updated' })
    return json(200, { data: rows[0] })
  }
  const { data: rows, error } = await sb.from(table).insert(payload).select()
  if (error) return json(500, { error: error.message })
  return json(200, { data: rows?.[0] || null })
}

async function deleteRow(sb, table, id) {
  if (!isUuid(id)) return json(400, { error: 'Invalid id' })
  const { data: rows, error } = await sb.from(table).delete().eq('id', id).select('id')
  if (error) return json(500, { error: error.message })
  if (!rows?.length) return json(404, { error: 'Row not found — nothing was deleted' })
  return json(200, { data: { deleted: true } })
}

// Recompute vote_pct for every result in a contest from current vote totals
async function recalcVotePct(sb, contestId) {
  const { data: rows, error } = await sb.from('election_results').select('id, votes').eq('contest_id', contestId)
  if (error || !rows?.length) return
  const total = rows.reduce((s, r) => s + (r.votes || 0), 0)
  if (total <= 0) return
  await Promise.all(rows.map(r =>
    sb.from('election_results')
      .update({ vote_pct: parseFloat(((r.votes || 0) / total * 100).toFixed(1)) })
      .eq('id', r.id)
  ))
}

// ─── Determination engine ────────────────────────────────────────────────────

// Re-run the engine for one contest and persist the verdict.
//   force = true  → run even if status_source is 'admin' (used by reset_status_auto,
//                   which has just flipped the source back to 'auto')
// Returns { status, detail, applied } or null when it declined / couldn't run.
// Never throws — a determination failure must never fail the admin's write.
async function runDetermination(sb, contestId, { force = false } = {}) {
  try {
    if (!isUuid(contestId)) return null
    const { data: contest, error: cErr } = await sb
      .from('election_contests')
      .select('id, seats, precincts_total, precincts_rptg, status, status_source')
      .eq('id', contestId).single()
    if (cErr || !contest) return null

    // Read the OLD status before anything writes over it — "did this contest
    // just enter recount_possible?" is the whole winner-flag question below.
    const previousStatus = contest.status

    // Manual overrides always beat the engine.
    if (!force && contest.status_source === 'admin') {
      return { status: contest.status, detail: null, applied: false, reason: 'admin override' }
    }

    const { data: rows } = await sb
      .from('election_results').select('id, votes').eq('contest_id', contestId)
    const results = rows || []

    let { status, detail } = determineStatus({
      results,
      precinctsTotal: contest.precincts_total,
      precinctsRptg:  contest.precincts_rptg,
      seats:          contest.seats,
    })

    // Election-night embargo: the ENGINE may not call races before 10:30 PM CT
    // even on the admin's data-entry path. The admin's explicit call_race /
    // set_status actions are untouched — the human always outranks the clock.
    if (status === 'called') {
      try {
        const { data: erow } = await sb.from('elections')
          .select('election_date').eq('id',
            (await sb.from('election_contests').select('election_id').eq('id', contestId).single()).data?.election_id
          ).single()
        if (erow && callEmbargoActive(new Date(), [erow.election_date])) {
          detail = { ...(detail || {}), embargoed_call: true,
            reason: `${(detail && detail.reason) || ''} Call withheld — no race is auto-called before 10:30 PM CT on election night.`.trim() }
          status = 'reporting'
        }
      } catch { /* embargo check is best-effort; engine result stands */ }
    }

    const { error: uErr } = await sb.from('election_contests').update({
      status,
      status_detail:     detail,
      status_updated_at: new Date().toISOString(),
    }).eq('id', contestId)
    if (uErr) { console.warn('[admin-elections] status write failed:', uErr.message); return null }

    // A CALLED contest also flags its top-N rows as winners.
    // NOTE: `declared` is deliberately NOT set here — declaring a winner stays
    // an admin action (call_race). This only mirrors the math onto the rows so
    // the board can highlight who is ahead.
    //
    // 'recount_possible' does NOT get winner flags: the engine is refusing to
    // call the race, and a green "Winner" under a RECOUNT POSSIBLE badge is a
    // lie. Entering recount_possible strips any flag an earlier pass set.
    const action = winnerFlagAction(status, previousStatus, detail)
    if (action === 'apply') {
      await applyWinnerFlags(sb, results, contest.seats || 1)
    } else if (action === 'clear') {
      await clearWinnerFlags(sb, contestId)
    }

    return { status, detail, applied: true }
  } catch (e) {
    console.warn('[admin-elections] determination skipped:', e.message)
    return null
  }
}

/**
 * What should happen to a contest's winner flags, given the engine's new status
 * and the status it carried before? PURE — mirrored in election-results-poller.js
 * so the two writers can never disagree about who the board paints green.
 *
 *   'apply' — 'called' with a real margin: flag the top N
 *   'clear' — the contest just ENTERED 'recount_possible': strip stale flags
 *   'none'  — leave the rows alone
 */
function winnerFlagAction(status, previousStatus = null, detail = null) {
  if (status === 'called' && detail && detail.margin > 0) return 'apply'
  if (status === 'recount_possible' && previousStatus !== 'recount_possible') return 'clear'
  return 'none'
}

// winner=true on the top-N rows by votes, winner=false on everyone else.
// Only called when the engine has already established a non-zero margin at the
// seat boundary, so there is no ambiguity about who the top N are.
async function applyWinnerFlags(sb, results, seats) {
  const ranked  = [...results].sort((a, b) => (b.votes || 0) - (a.votes || 0))
  const winners = ranked.slice(0, Math.max(1, seats)).filter(r => (r.votes || 0) > 0).map(r => r.id)
  if (!winners.length) return
  const losers = ranked.map(r => r.id).filter(id => !winners.includes(id))
  await sb.from('election_results').update({ winner: true }).in('id', winners)
  if (losers.length) await sb.from('election_results').update({ winner: false }).in('id', losers)
}

// Take winner=true off every row in a contest — one statement, no id list.
async function clearWinnerFlags(sb, contestId) {
  const { error } = await sb.from('election_results')
    .update({ winner: false }).eq('contest_id', contestId).eq('winner', true)
  if (error) console.warn('[admin-elections] winner-flag clear failed:', error.message)
}

// ─── Subscriber notifications ────────────────────────────────────────────────
// Fired after a mutation that changes what a subscriber to this race would
// want to know: new numbers, new precinct counts, a called race, a status
// override. Best effort in every sense — notifyContestChanges never throws,
// and this wrapper swallows anything that somehow escapes it, because the
// admin's write has already succeeded by the time we get here.
async function notifyRace(sb, contestId, action) {
  try {
    if (!isUuid(contestId)) return null
    const res = await notifyContestChanges(sb, [contestId], { trigger: `admin:${action}` })
    if (res && (res.sent || res.failed)) {
      console.log(`[admin-elections] ${action}: ${res.sent} notification email(s) sent, ${res.failed} failed`)
    }
    return res
  } catch (e) {
    console.warn('[admin-elections] notification pass skipped:', e.message)
    return null
  }
}

// Audit trail — every admin mutation lands in election_poller_log. Best effort:
// a logging failure must never fail the admin's write.
async function logAdminAction(sb, action, { contests = 0, results = 0, startedAt, error = null }) {
  try {
    await sb.from('election_poller_log').insert({
      source:           `admin:${action}`,
      contests_synced:  contests,
      results_upserted: results,
      duration_ms:      Date.now() - startedAt,
      error:            error ? String(error).slice(0, 500) : null,
    })
  } catch (e) {
    console.warn('[admin-elections] poller-log write failed:', e.message)
  }
}

// How many contests/results each action touched, for the audit row.
const LOG_SHAPE = {
  save_election:     { contests: 0, results: 0 },
  delete_election:   { contests: 0, results: 0 },
  save_contest:      { contests: 1, results: 0 },
  delete_contest:    { contests: 1, results: 0 },
  save_result:       { contests: 0, results: 1 },
  delete_result:     { contests: 0, results: 1 },
  call_race:         { contests: 1, results: 1 },
  uncall_race:       { contests: 1, results: 0 },
  update_precincts:  { contests: 1, results: 0 },
  set_status:        { contests: 1, results: 0 },
  reset_status_auto: { contests: 1, results: 0 },
  advance_unopposed: { contests: 0, results: 0 },   // real counts filled in below
}

exports.handler = async (event) => {
  const headers = { ...cors(), 'Content-Type': 'application/json' }
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' }
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' }, headers)

  const auth = await requireAdmin(event)
  if (auth.errorResponse) return auth.errorResponse

  let body
  try { body = JSON.parse(event.body || '{}') } catch {
    return json(400, { error: 'Invalid JSON' }, headers)
  }
  const { action, params = {} } = body
  const sb = serviceClient()
  const startedAt = Date.now()

  let res
  try {
    res = await route(sb, action, params, headers, event)
  } catch (e) {
    console.error('[admin-elections] error:', e.message)
    res = json(500, { error: 'An internal error occurred' }, headers)
  }

  // Audit row for every mutation — success or failure.
  if (LOG_SHAPE[action]) {
    let err = null
    if (res.statusCode !== 200) {
      try { err = JSON.parse(res.body).error } catch { err = `HTTP ${res.statusCode}` }
    }
    const shape = { ...LOG_SHAPE[action] }
    // advance_unopposed touches a variable number of rows — read the real
    // counts off the response so the audit line means something.
    if (action === 'advance_unopposed' && res.statusCode === 200) {
      try {
        const d = JSON.parse(res.body).data
        shape.contests = d?.advanced ?? 0
        shape.results  = d?.advanced ?? 0
      } catch {}
    }
    await logAdminAction(sb, action, { ...shape, startedAt, error: err })
  }

  return res
}

async function route(sb, action, params, headers, event) {
  switch (action) {
    case 'save_election':   return await saveRow(sb, 'elections', ELECTION_FIELDS, params)
    case 'delete_election': return await deleteRow(sb, 'elections', params.id)
    case 'delete_contest':  return await deleteRow(sb, 'election_contests', params.id)

    case 'save_contest': {
      const res = await saveRow(sb, 'election_contests', CONTEST_FIELDS, params)
      // Editing a contest can change precincts_total / seats, which are engine
      // inputs — recompute so the badge never lags the data.
      let contestId = params.id || null
      if (!contestId) { try { contestId = JSON.parse(res.body)?.data?.id || null } catch { contestId = null } }
      if (res.statusCode === 200 && isUuid(contestId)) await runDetermination(sb, contestId)
      return res
    }

    case 'save_result': {
      const res = await saveRow(sb, 'election_results', RESULT_FIELDS, params)
      const contestId = params.data?.contest_id
      if (res.statusCode === 200 && isUuid(contestId)) {
        await recalcVotePct(sb, contestId)
        await runDetermination(sb, contestId)
        await notifyRace(sb, contestId, 'save_result')
      }
      return res
    }

    case 'delete_result': {
      // Capture contest_id BEFORE deleting so we can recalc percentages after
      let contestId = null
      if (isUuid(params.id)) {
        const { data: row } = await sb.from('election_results').select('contest_id').eq('id', params.id).single()
        contestId = row?.contest_id || null
      }
      const res = await deleteRow(sb, 'election_results', params.id)
      if (res.statusCode === 200 && contestId) {
        await recalcVotePct(sb, contestId)
        await runDetermination(sb, contestId)
      }
      return res
    }

    case 'call_race': {
      const { result_id, contest_id, candidate_name } = params
      if (!isUuid(result_id)) return json(400, { error: 'Invalid result_id' })
      const { data: rows, error } = await sb.from('election_results')
        .update({ winner: true, declared: true }).eq('id', result_id).select('id, contest_id')
      if (error) return json(500, { error: error.message })
      if (!rows?.length) return json(404, { error: 'Result not found — race was NOT called' })

      const cid = isUuid(contest_id) ? contest_id : rows[0].contest_id

      // An admin call is authoritative: pin the contest to 'called' and take it
      // out of the engine's hands until someone hits "Back to auto".
      if (isUuid(cid)) {
        await sb.from('election_contests').update({
          status: 'called',
          status_source: 'admin',
          status_updated_at: new Date().toISOString(),
          status_detail: {
            reason: candidate_name
              ? `Called by hand for ${String(candidate_name).slice(0, 150)}.`
              : 'Called by hand by a Badger Board admin.',
            computed_at: new Date().toISOString(),
            source: 'admin',
          },
        }).eq('id', cid)
      }

      // Best-effort officeholder sync (single-seat races, unambiguous office match)
      let officeholderSynced = false
      try {
        if (isUuid(cid) && candidate_name) {
          const { data: contest } = await sb.from('election_contests').select('office, seats').eq('id', cid).single()
          if (contest?.office && (contest.seats || 1) === 1) {
            const { data: matches } = await sb.from('offices').select('id').ilike('name', `%${contest.office}%`).limit(2)
            if (matches?.length === 1) {
              const { error: offErr } = await sb.from('offices')
                .update({ current_officeholder: String(candidate_name).slice(0, 150) })
                .eq('id', matches[0].id)
              officeholderSynced = !offErr
            }
          }
        }
      } catch (e) { console.warn('[admin-elections] officeholder sync skipped:', e.message) }

      // Everyone watching this race hears about it, whichever mode they picked.
      await notifyRace(sb, cid, 'call_race')

      return json(200, { data: { called: true, officeholder_synced: officeholderSynced } })
    }

    case 'uncall_race': {
      const { contest_id } = params
      if (!isUuid(contest_id)) return json(400, { error: 'Invalid contest_id' })
      const { error } = await sb.from('election_results')
        .update({ winner: false, declared: false }).eq('contest_id', contest_id)
      if (error) return json(500, { error: error.message })
      // Still an admin decision — un-calling is not an invitation for the engine
      // to immediately re-call the race. Use reset_status_auto for that.
      await sb.from('election_contests').update({
        status: 'reporting',
        status_source: 'admin',
        status_updated_at: new Date().toISOString(),
        status_detail: {
          reason: 'Un-called by a Badger Board admin; back to reporting.',
          computed_at: new Date().toISOString(),
          source: 'admin',
        },
      }).eq('id', contest_id)
      return json(200, { data: { uncalled: true } })
    }

    case 'update_precincts': {
      const { contest_id, rptg, total } = params
      if (!isUuid(contest_id)) return json(400, { error: 'Invalid contest_id' })
      const { data: rows, error } = await sb.from('election_contests')
        .update({ precincts_rptg: parseInt(rptg) || 0, precincts_total: parseInt(total) || 0 })
        .eq('id', contest_id).select('id')
      if (error) return json(500, { error: error.message })
      if (!rows?.length) return json(404, { error: 'Contest not found — precincts NOT updated' })
      const determination = await runDetermination(sb, contest_id)
      await notifyRace(sb, contest_id, 'update_precincts')
      return json(200, { data: { updated: true, determination } })
    }

    // ── Explicit admin override of the engine's verdict ────────────────────
    case 'set_status': {
      const { contest_id, status, source } = params
      if (!isUuid(contest_id)) return json(400, { error: 'Invalid contest_id' })
      if (!ALLOWED_STATUSES.includes(status)) {
        return json(400, { error: `Invalid status. Allowed: ${ALLOWED_STATUSES.join(', ')}` })
      }
      const now = new Date().toISOString()
      const patch = {
        status,
        status_source: source === 'auto' ? 'auto' : 'admin',
        status_updated_at: now,
        status_detail: {
          reason: `Set to "${status}" by a Badger Board admin, overriding the determination engine.`,
          computed_at: now,
          source: 'admin',
        },
      }
      if (status === 'certified') patch.verified_at = now
      const { data: rows, error } = await sb.from('election_contests')
        .update(patch).eq('id', contest_id).select('id, status, status_source')
      if (error) return json(500, { error: error.message })
      if (!rows?.length) return json(404, { error: 'Contest not found — status NOT updated' })
      await notifyRace(sb, contest_id, 'set_status')
      return json(200, { data: rows[0] })
    }

    // ── Hand the contest back to the engine ────────────────────────────────
    case 'reset_status_auto': {
      const { contest_id } = params
      if (!isUuid(contest_id)) return json(400, { error: 'Invalid contest_id' })
      const { data: rows, error } = await sb.from('election_contests')
        .update({ status_source: 'auto', status_updated_at: new Date().toISOString() })
        .eq('id', contest_id).select('id')
      if (error) return json(500, { error: error.message })
      if (!rows?.length) return json(404, { error: 'Contest not found — status NOT reset' })
      const determination = await runDetermination(sb, contest_id, { force: true })
      await notifyRace(sb, contest_id, 'reset_status_auto')
      return json(200, { data: { status_source: 'auto', determination } })
    }

    // ── Sweep the races nobody ran against ────────────────────────────────
    // An unopposed contest never produces returns worth reporting, so the
    // poller leaves it 'waiting' forever and the board shows a race that looks
    // unresolved months after the fact (164 of them sat like that after the
    // 11 Aug 2026 primary). Reality is that the sole candidate advanced the
    // moment the polls closed. This is the one-shot cleanup: for every contest
    // in an election that is still 'waiting' after election day AND has exactly
    // one candidate row, mark that candidate a winner and call the contest.
    //
    //   winner   = true   — they did in fact advance
    //   declared = false  — nobody DECLARED anything; there was no call to make
    //
    // status_source is pinned to 'admin' so the determination engine (which
    // reads zero votes and correctly says 'waiting') does not undo it on the
    // next pass.
    //
    // NOTE: notifyRace is deliberately NOT fired. Race subscribers signed up
    // for election-night movement; nobody wants a "winner declared" email for
    // an uncontested primary they already knew the answer to, least of all in a
    // 164-message batch weeks later.
    case 'advance_unopposed': {
      const { election_id, dry_run } = params
      if (!isUuid(election_id)) return json(400, { error: 'Invalid election_id' })

      const { data: election, error: eErr } = await sb
        .from('elections').select('id, name, election_date').eq('id', election_id).single()
      if (eErr || !election) return json(404, { error: 'Election not found' })

      // "Election day has passed" in Central time — the same clock the poller
      // and the results board use. Strictly before today, so nothing advances
      // while the polls are still open.
      const todayCT = ctParts().date
      if (!election.election_date || String(election.election_date) >= todayCT) {
        return json(400, { error: 'Election day has not passed yet — nothing to advance' })
      }

      const { data: waiting, error: cErr } = await sb
        .from('election_contests')
        .select('id, office, district, county')
        .eq('election_id', election_id)
        .eq('status', 'waiting')
      if (cErr) return json(500, { error: cErr.message })
      if (!waiting?.length) return json(200, { data: { advanced: 0, contests: [] } })

      const { data: results, error: rErr } = await sb
        .from('election_results')
        .select('id, contest_id, candidate_name')
        .in('contest_id', waiting.map(c => c.id))
      if (rErr) return json(500, { error: rErr.message })

      // Exactly one candidate row = unopposed. Zero rows means we simply have
      // no data yet, which is not the same thing and must not be called.
      const byContest = new Map()
      for (const r of results || []) {
        if (!byContest.has(r.contest_id)) byContest.set(r.contest_id, [])
        byContest.get(r.contest_id).push(r)
      }
      const unopposed = waiting
        .map(c => ({ contest: c, rows: byContest.get(c.id) || [] }))
        .filter(x => x.rows.length === 1)

      if (!unopposed.length) return json(200, { data: { advanced: 0, contests: [] } })

      const preview = unopposed.map(x => ({
        contest_id: x.contest.id,
        office: x.contest.office,
        district: x.contest.district,
        county: x.contest.county,
        candidate_name: x.rows[0].candidate_name,
      }))

      if (dry_run === true) {
        return json(200, { data: { advanced: 0, dry_run: true, would_advance: preview.length, contests: preview } })
      }

      const now = new Date().toISOString()
      const resultIds  = unopposed.map(x => x.rows[0].id)
      const contestIds = unopposed.map(x => x.contest.id)

      const { error: wErr } = await sb.from('election_results')
        .update({ winner: true, declared: false }).in('id', resultIds)
      if (wErr) return json(500, { error: wErr.message })

      const { data: updated, error: sErr } = await sb.from('election_contests')
        .update({
          status: 'called',
          status_source: 'admin',
          status_updated_at: now,
          status_detail: {
            reason: 'Unopposed — advanced automatically after election day.',
            computed_at: now,
            source: 'admin',
          },
        })
        .in('id', contestIds)
        .select('id')
      if (sErr) return json(500, { error: sErr.message })

      const advanced = updated?.length || 0
      console.log(`[admin-elections] advance_unopposed: ${advanced} uncontested race(s) advanced for "${election.name}" (${election.election_date}); no subscriber emails sent`)
      return json(200, { data: { advanced, contests: preview } })
    }

    // ── Manually trigger the scheduled poller (scheduled functions are not
    //    URL-invocable on Netlify, so the admin console reaches it here).
    //    The poller re-validates the same admin JWT from the forwarded headers.
    //
    //    { discover: 'county', chunk: 0…5 } runs ONE 12-county discovery call
    //    instead of the results pass — this function has a 26-second cap, so a
    //    full 72-county sweep is six calls, one per chunk.
    case 'run_poller': {
      const poller = require('./election-results-poller')
      const res = await poller.handler({
        httpMethod: 'POST',
        headers: (event && event.headers) || {},
        body: JSON.stringify({
          force: params.force !== false,          // default true — that's the point
          dry_run: params.dry_run === true,
          election_date: params.election_date || undefined,
          discover: params.discover === 'county' ? 'county' : undefined,
          chunk: params.discover === 'county' ? (Number(params.chunk) || 0) : undefined,
        }),
      })
      let parsed
      try { parsed = JSON.parse(res.body) } catch { parsed = { raw: String(res.body).slice(0, 500) } }
      return json(res.statusCode || 200, parsed, headers)
    }

    // Push a "current numbers" update email to every subscriber right now,
    // bypassing change-detection and throttles. Owner-triggered only.
    case 'send_status_update': {
      const out = await sendStatusUpdateNow(sb, { contestId: isUuid(params.contest_id) ? params.contest_id : null })
      return json(200, { data: out }, headers)
    }

    default:
      return json(400, { error: `Unknown action: ${action}` }, headers)
  }
}

// pure, unit-tested in tests/remediation.test.mjs
module.exports.winnerFlagAction = winnerFlagAction
