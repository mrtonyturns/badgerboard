// election-results-poller.js
// ─────────────────────────────────────────────────────────────────────────────
// Netlify scheduled function: runs every 2 minutes during active election
// windows (6 pm – midnight CST / CDT) and every 10 minutes otherwise.
//
// Data source: Wisconsin Elections Commission (WEC) public API
//   https://elections.wi.gov/api/results
//
// On each run it:
//   1. Checks whether any Wisconsin election is happening today/yesterday
//   2. Fetches all contest results from the WEC API
//   3. Upserts into election_contests + election_results tables
//   4. Writes a row to election_poller_log (health check)
//
// The Supabase Realtime publication on election_results means the browser
// receives vote-total updates as soon as this function writes them —
// no client-side polling needed.
// ─────────────────────────────────────────────────────────────────────────────

const { createClient } = require('@supabase/supabase-js')

// ── Supabase (service role — bypasses RLS for writes) ──────────────────────
const supabase = createClient(
  process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

// ── WEC API endpoints ──────────────────────────────────────────────────────
const WEC_BASE = 'https://elections.wi.gov/api'

// Is it within the election-night window? 6 pm–midnight CST/CDT
// CST = UTC-6  →  6pm CST = 00:00 UTC+1, midnight CST = 06:00 UTC
// CDT = UTC-5  →  6pm CDT = 23:00 UTC,   midnight CDT = 05:00 UTC
// Conservative union: UTC 22:00 – 07:00
function isElectionNightWindow() {
  const h = new Date().getUTCHours()
  return h >= 22 || h <= 7
}

// Map WEC party codes → display names
function normalizeParty(raw) {
  if (!raw) return null
  const p = raw.trim().toUpperCase()
  if (p.includes('DEM'))  return 'Democrat'
  if (p.includes('REP'))  return 'Republican'
  if (p.includes('IND'))  return 'Independent'
  if (p.includes('LIB'))  return 'Libertarian'
  if (p.includes('GRE'))  return 'Green'
  if (p.includes('NP') || p.includes('NON')) return 'Nonpartisan'
  return raw.trim()
}

// Determine office_type bucket from office name
function classifyOfficeType(officeName) {
  const n = (officeName || '').toLowerCase()
  if (n.includes('supreme') || n.includes('court of appeals') || n.includes('circuit court')) return 'judicial'
  if (n.includes('governor') || n.includes('secretary of state') || n.includes('treasurer') || n.includes('attorney general') || n.includes('superintendent')) return 'statewide'
  if (n.includes('senate') || n.includes('assembly') || n.includes('congress')) return 'legislative'
  if (n.includes('county') || n.includes('sheriff') || n.includes('register') || n.includes('clerk')) return 'county'
  if (n.includes('referendum') || n.includes('advisory') || n.includes('question')) return 'referendum'
  return 'municipal'
}

// ── Fetch WEC results for a given election date ────────────────────────────
// WEC API shape (approximate — actual shape confirmed from live API):
// GET /api/results?electionId=XXX  or  GET /api/results?date=YYYY-MM-DD
//
// Response is an array of contests:
// [{
//   race_id: "123",
//   office: "State Senate District 5",
//   county: null,
//   precincts_reporting: 12,
//   precincts_total: 18,
//   candidates: [
//     { name: "Jane Doe", party: "DEM", votes: 8241, vote_pct: 61.2, winner: false },
//     ...
//   ]
// }, ...]
//
// If WEC returns a different shape, the normalization below handles it.
async function fetchWECResults(electionDate) {
  const url = `${WEC_BASE}/results?date=${electionDate}`
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  })

  if (res.status === 404) return []           // no results yet for this date
  if (!res.ok) throw new Error(`WEC API ${res.status}: ${await res.text()}`)

  const data = await res.json()

  // WEC sometimes returns { contests: [...] } and sometimes a bare array
  if (Array.isArray(data)) return data
  if (Array.isArray(data.contests)) return data.contests
  if (Array.isArray(data.results))  return data.results
  return []
}

// ── Core sync logic ────────────────────────────────────────────────────────
async function syncElectionResults(election) {
  const contests = await fetchWECResults(election.election_date)
  if (!contests.length) return { contestsSynced: 0, resultsUpserted: 0 }

  let contestsSynced  = 0
  let resultsUpserted = 0

  for (const contest of contests) {
    // Normalize the contest row
    const wecRaceId     = String(contest.race_id || contest.raceId || contest.id || '')
    const officeName    = contest.office || contest.race_name || contest.officeName || 'Unknown Race'
    const precinctsRptg = parseInt(contest.precincts_reporting ?? contest.precincts_rptg ?? 0, 10)
    const precinctsTotal= parseInt(contest.precincts_total    ?? contest.totalPrecincts ?? 0, 10)
    const county        = contest.county || contest.countyName || null

    // Upsert election_contest
    let { data: contestRow, error: contestErr } = await supabase
      .from('election_contests')
      .upsert({
        election_id:     election.id,
        wec_race_id:     wecRaceId || null,
        office:          officeName,
        office_type:     classifyOfficeType(officeName),
        district:        contest.district || contest.districtName || null,
        county,
        precincts_total: precinctsTotal,
        precincts_rptg:  precinctsRptg,
        is_nonpartisan:  !!(contest.nonpartisan || contest.is_nonpartisan),
        updated_at:      new Date().toISOString(),
      }, {
        onConflict:    'wec_race_id',
        ignoreDuplicates: false,
      })
      .select('id')
      .single()

    if (contestErr) {
      // wec_race_id might be null (pre-election placeholder) — try matching by election_id + office
      if (!wecRaceId) {
        const { data: existing } = await supabase
          .from('election_contests')
          .select('id')
          .eq('election_id', election.id)
          .eq('office', officeName)
          .maybeSingle()

        if (existing) {
          await supabase.from('election_contests').update({
            precincts_total: precinctsTotal,
            precincts_rptg:  precinctsRptg,
            updated_at:      new Date().toISOString(),
          }).eq('id', existing.id)
          contestRow = existing
        } else {
          const { data: inserted } = await supabase
            .from('election_contests')
            .insert({
              election_id: election.id,
              office:      officeName,
              office_type: classifyOfficeType(officeName),
              county,
              precincts_total: precinctsTotal,
              precincts_rptg:  precinctsRptg,
              is_nonpartisan: !!(contest.nonpartisan || contest.is_nonpartisan),
            })
            .select('id')
            .single()
          contestRow = inserted
        }
      } else {
        console.error('[poller] contest upsert error:', contestErr.message, '| race:', officeName)
        continue
      }
    }

    if (!contestRow?.id) continue
    contestsSynced++

    // Upsert each candidate result
    const candidates = contest.candidates || contest.results || []
    for (const cand of candidates) {
      const candName = cand.name || cand.candidate_name || cand.candidateName || 'Unknown'
      const votes    = parseInt(cand.votes ?? cand.vote_count ?? 0, 10)
      const votePct  = parseFloat(cand.vote_pct ?? cand.votePct ?? cand.percentage ?? 0)
      const winner   = !!(cand.winner || cand.is_winner)
      const declared = !!(cand.declared || cand.isApCalled || cand.called)

      // Try to find a matching candidate record in our DB
      let candidateId = null
      const { data: matchedCand } = await supabase
        .from('candidates')
        .select('id')
        .ilike('name', `%${candName.split(' ').pop()}%`)   // match on last name
        .eq('election_id', election.id)
        .maybeSingle()
      if (matchedCand) candidateId = matchedCand.id

      const { error: resultErr } = await supabase
        .from('election_results')
        .upsert({
          contest_id:     contestRow.id,
          candidate_id:   candidateId,
          candidate_name: candName,
          party:          normalizeParty(cand.party || cand.partyName),
          incumbent:      !!(cand.incumbent),
          votes,
          vote_pct:       votePct,
          winner,
          declared,
          updated_at:     new Date().toISOString(),
        }, {
          onConflict:       'contest_id,candidate_name',
          ignoreDuplicates: false,
        })

      if (resultErr) {
        console.error('[poller] result upsert error:', resultErr.message, '| candidate:', candName)
      } else {
        resultsUpserted++
        // If winner declared → update candidate status in main candidates table
        if (winner && declared && candidateId) {
          await supabase
            .from('candidates')
            .update({ status: 'elected', updated_at: new Date().toISOString() })
            .eq('id', candidateId)
        }
      }
    }
  }

  return { contestsSynced, resultsUpserted }
}

// ── Handler ────────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  const startMs = Date.now()
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  }

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' }
  }

  // Allow ?force=true to bypass the time window check (for testing)
  const qs     = event.queryStringParameters || {}
  const body   = (() => { try { return JSON.parse(event.body || '{}') } catch { return {} } })()
  const force  = qs.force === 'true' || body.force === true

  const inWindow = isElectionNightWindow()
  if (!force && !inWindow) {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ skipped: true, reason: 'Outside election window. Use ?force=true to override.' }),
    }
  }

  let electionDate = null
  let totalContests = 0
  let totalResults  = 0
  let errorMsg      = null

  try {
    // Find elections for today (or up to 48 hrs ago — covers late night runs)
    const now       = new Date()
    const twoDaysAgo = new Date(now)
    twoDaysAgo.setDate(twoDaysAgo.getDate() - 2)
    const today = now.toISOString().split('T')[0]

    const { data: elections, error: elErr } = await supabase
      .from('elections')
      .select('id, name, election_date, type')
      .gte('election_date', twoDaysAgo.toISOString().split('T')[0])
      .lte('election_date', today)
      .order('election_date', { ascending: false })

    if (elErr) throw elErr

    if (!elections || elections.length === 0) {
      // Log the run even when there's nothing to do
      await supabase.from('election_poller_log').insert({
        ran_at: new Date().toISOString(),
        election_date: today,
        contests_synced: 0,
        results_upserted: 0,
        source: 'wec',
        error: null,
        duration_ms: Date.now() - startMs,
      })
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ message: 'No active elections found', elections_checked: 0 }),
      }
    }

    // Sync each election
    for (const election of elections) {
      electionDate = election.election_date
      const { contestsSynced, resultsUpserted } = await syncElectionResults(election)
      totalContests += contestsSynced
      totalResults  += resultsUpserted
    }

  } catch (err) {
    console.error('[election-results-poller] Fatal error:', err)
    errorMsg = err.message
  }

  // Always write a health log row
  await supabase.from('election_poller_log').insert({
    ran_at:           new Date().toISOString(),
    election_date:    electionDate,
    contests_synced:  totalContests,
    results_upserted: totalResults,
    source:           'wec',
    error:            errorMsg,
    duration_ms:      Date.now() - startMs,
  })

  if (errorMsg) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: errorMsg, contests_synced: totalContests }),
    }
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      success:          true,
      contests_synced:  totalContests,
      results_upserted: totalResults,
      duration_ms:      Date.now() - startMs,
      timestamp:        new Date().toISOString(),
    }),
  }
}
