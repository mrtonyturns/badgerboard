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

const { cors, json, serviceClient, requireAdmin } = require('./_shared')

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

  try {
    switch (action) {
      case 'save_election':   return await saveRow(sb, 'elections', ELECTION_FIELDS, params)
      case 'delete_election': return await deleteRow(sb, 'elections', params.id)
      case 'save_contest':    return await saveRow(sb, 'election_contests', CONTEST_FIELDS, params)
      case 'delete_contest':  return await deleteRow(sb, 'election_contests', params.id)

      case 'save_result': {
        const res = await saveRow(sb, 'election_results', RESULT_FIELDS, params)
        const contestId = params.data?.contest_id
        if (res.statusCode === 200 && isUuid(contestId)) await recalcVotePct(sb, contestId)
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
        if (res.statusCode === 200 && contestId) await recalcVotePct(sb, contestId)
        return res
      }

      case 'call_race': {
        const { result_id, contest_id, candidate_name } = params
        if (!isUuid(result_id)) return json(400, { error: 'Invalid result_id' })
        const { data: rows, error } = await sb.from('election_results')
          .update({ winner: true, declared: true }).eq('id', result_id).select('id, contest_id')
        if (error) return json(500, { error: error.message })
        if (!rows?.length) return json(404, { error: 'Result not found — race was NOT called' })

        // Best-effort officeholder sync (single-seat races, unambiguous office match)
        let officeholderSynced = false
        try {
          const cid = contest_id || rows[0].contest_id
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

        return json(200, { data: { called: true, officeholder_synced: officeholderSynced } })
      }

      case 'uncall_race': {
        const { contest_id } = params
        if (!isUuid(contest_id)) return json(400, { error: 'Invalid contest_id' })
        const { error } = await sb.from('election_results')
          .update({ winner: false, declared: false }).eq('contest_id', contest_id)
        if (error) return json(500, { error: error.message })
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
        return json(200, { data: { updated: true } })
      }

      default:
        return json(400, { error: `Unknown action: ${action}` }, headers)
    }
  } catch (e) {
    console.error('[admin-elections] error:', e.message)
    return json(500, { error: 'An internal error occurred' }, headers)
  }
}
