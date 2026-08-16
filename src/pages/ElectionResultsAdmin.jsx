// ElectionResultsAdmin.jsx
// Manual election results entry for the admin panel.
// Replaces the fake WEC poller — an admin enters results by hand on election night.

import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { format, parseISO } from 'date-fns'
import {
  BarChart2, Plus, Edit2, Trash2, Trophy, ChevronDown, ChevronUp,
  CheckCircle2, X, MapPin, Users, Radio, ExternalLink, AlertTriangle,
  Search, Filter, ShieldCheck,
} from 'lucide-react'
import { supabase, adminElections } from '../lib/supabase'
import SearchableSelect from '../components/SearchableSelect'
import { partyGroup, DB_PARTIES } from '../lib/party'
// One definition of "called", shared with the public board.
import { countCalled } from './ElectionResultsBoard'

// ── Constants ─────────────────────────────────────────────────────────────────
// Order and labels match the public board (ElectionResultsBoard.jsx). The three
// legislative types were missing, so editing one of the 244 us_house /
// state_senate / state_assembly races showed a blank type and touching the
// dropdown silently refiled the race into the wrong group on the board.
const OFFICE_TYPES = [
  { value: 'statewide',      label: 'Statewide' },
  { value: 'us_house',       label: 'U.S. House' },
  { value: 'state_senate',   label: 'State Senate' },
  { value: 'state_assembly', label: 'State Assembly' },
  { value: 'county',         label: 'County' },
  { value: 'judicial',       label: 'Judicial' },
  { value: 'legislative',    label: 'Legislative' },
  { value: 'municipal',      label: 'Municipal' },
  { value: 'referendum',     label: 'Referendum' },
]
const OFFICE_TYPE_LABEL = Object.fromEntries(OFFICE_TYPES.map(t => [t.value, t.label]))
const OFFICE_TYPE_ORDER = Object.fromEntries(OFFICE_TYPES.map((t, i) => [t.value, i]))

// Seed/QA rows that should never be the thing an admin lands on at 8 PM.
// (?![a-z]) so a real "Testing …" election is never swallowed by the filter.
const isTestElection = (e) => /^(zz)?test(?![a-z])/i.test(String(e?.name || '').trim())

// Today's date in America/Chicago — Wisconsin votes on Central time, and the
// console must open on tonight's election for an admin anywhere.
const ctToday = () => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date())

/**
 * Default election for the console: today's, else the nearest PAST one.
 * Never a future election — the seeds run through 2028 and date-descending
 * order used to open on "2028 November General" with "No contests yet".
 */
function pickDefaultElection(list) {
  const pool = (list || []).filter(e => !isTestElection(e) && e.election_date)
  if (!pool.length) return null
  const today = ctToday()
  const onToday = pool.find(e => String(e.election_date).slice(0, 10) === today)
  if (onToday) return onToday
  const past = pool
    .filter(e => String(e.election_date).slice(0, 10) < today)
    .sort((a, b) => b.election_date.localeCompare(a.election_date))
  if (past[0]) return past[0]
  // Nothing has happened yet — the soonest upcoming beats the furthest one.
  return [...pool].sort((a, b) => a.election_date.localeCompare(b.election_date))[0] || null
}

// Same vocabulary the rest of the app writes (lib/party.js DB_PARTIES — the
// `candidates.party` CHECK). This was a hand-kept copy that had drifted out of
// order and was missing 'Working Families'.
const PARTIES = DB_PARTIES

// Keyed by partyGroup() — results rows carry both 'Democrat' and 'Democratic'.
const PARTY_COLORS = {
  D: 'bg-blue-100 text-blue-800',
  R: 'bg-red-100 text-red-700',
  I: 'bg-purple-100 text-purple-800',
  N: 'bg-gray-100 text-gray-700',
  L: 'bg-amber-100 text-amber-800',
  G: 'bg-green-100 text-green-800',
}

// ── Determination-engine status (Phase 1) ─────────────────────────────────────
// election_contests.status is normally written by netlify/functions/_determination.js
// after every result/precinct change. An admin override pins status_source to
// 'admin' and the engine backs off until "Back to auto" is pressed.
const STATUS_OPTIONS = [
  { value: 'waiting',          label: 'Awaiting results' },
  { value: 'reporting',        label: 'Reporting' },
  { value: 'projected',        label: 'Victory likely (projected)' },
  { value: 'called',           label: 'Winner called' },
  { value: 'too_close',        label: 'Too close to call' },
  { value: 'recount_possible', label: 'Recount possible' },
  { value: 'certified',        label: 'Certified' },
]
const STATUS_LABEL = Object.fromEntries(STATUS_OPTIONS.map(o => [o.value, o.label]))
const STATUS_CHIP = {
  waiting:          'bg-gray-100 text-gray-600',
  reporting:        'bg-blue-100 text-blue-700',
  projected:        'bg-amber-100 text-amber-800',
  called:           'bg-green-100 text-green-700',
  too_close:        'bg-red-100 text-red-700',
  recount_possible: 'bg-orange-100 text-orange-700',
  certified:        'bg-emerald-900/10 text-emerald-900',
}

const defaultContest = {
  office: '', office_type: 'judicial', district: '', county: '',
  precincts_total: '', precincts_rptg: '', is_nonpartisan: false, seats: 1,
}

const defaultResult = {
  candidate_name: '', party: 'Nonpartisan', incumbent: false,
  votes: '', winner: false, declared: false,
}

// ── Main component ────────────────────────────────────────────────────────────
export default function ElectionResultsAdmin({ showToast }) {
  const [elections,        setElections]        = useState([])
  const [selectedElection, setSelectedElection] = useState(null)
  const [contests,         setContests]         = useState([])
  const [resultsMap,       setResultsMap]       = useState({})
  const [loading,          setLoading]          = useState(false)
  // Contests start COLLAPSED — 250 open cards is 17,826 DOM nodes and 500 vote
  // inputs. `expanded[id] === true` opens one.
  const [expanded,         setExpanded]         = useState({})
  const [search,           setSearch]           = useState('')
  const [typeFilter,       setTypeFilter]       = useState('all')

  // Modal state
  const [contestModal, setContestModal] = useState(null) // null | 'add' | contest-obj (edit)
  const [resultModal,  setResultModal]  = useState(null) // null | { contestId, result? }
  const [contestForm,  setContestForm]  = useState(defaultContest)
  const [resultForm,   setResultForm]   = useState(defaultResult)
  const [saving,       setSaving]       = useState(false)
  const [deleting,     setDeleting]     = useState(null)
  // Call confirmation: { contestId, candidateId, candidateName, seats, currentWinners }
  const [callConfirm,  setCallConfirm]  = useState(null)

  // Load elections list
  useEffect(() => {
    supabase
      .from('elections')
      .select('*')
      .order('election_date', { ascending: false })
      .then(({ data }) => {
        const list = data || []
        setElections(list)
        setSelectedElection(pickDefaultElection(list))
      })
  }, [])

  // Test/seed rows never belong in the picker an admin uses on election night.
  const pickerElections = useMemo(
    () => elections.filter(e => !isTestElection(e) || e.id === selectedElection?.id),
    [elections, selectedElection?.id])

  // Load contests + results whenever selected election changes
  useEffect(() => {
    if (selectedElection) loadContests(selectedElection.id)
  }, [selectedElection])

  // Switching elections should not carry the previous ballot's filters over.
  // (nor the last certification sweep's leftovers)
  useEffect(() => { setSearch(''); setTypeFilter('all'); setExpanded({}); setNeedsResolution([]) }, [selectedElection?.id])

  const loadContests = useCallback(async (electionId) => {
    setLoading(true)
    const { data: cData, error: cErr } = await supabase
      .from('election_contests')
      .select('*')
      .eq('election_id', electionId)
      .order('office_type')
      .order('office')

    if (cErr) { showToast('Load error: ' + cErr.message, 'error'); setLoading(false); return }
    setContests(cData || [])

    if (cData?.length) {
      // FK-join filter rather than a 250-id `.in()` — that URL is ~10KB today
      // and crosses the gateway limit at November's ~400 contests.
      const { data: rData } = await supabase
        .from('election_results')
        .select('*, election_contests!inner(election_id)')
        .eq('election_contests.election_id', electionId)
        .order('votes', { ascending: false })

      const map = {}
      for (const raw of rData || []) {
        const { election_contests: _join, ...r } = raw
        if (!map[r.contest_id]) map[r.contest_id] = []
        map[r.contest_id].push(r)
      }
      setResultsMap(map)
    } else {
      setResultsMap({})
    }
    setLoading(false)
  }, [showToast])

  /**
   * Refresh ONE contest after a per-row save. The old code refetched the whole
   * election after every keystroke-sized edit, which on a 250-contest ballot
   * re-rendered the page and threw away scroll position and expansion state.
   */
  const refreshContest = useCallback(async (contestId) => {
    if (!contestId) return
    const [{ data: cRow }, { data: rRows }] = await Promise.all([
      supabase.from('election_contests').select('*').eq('id', contestId).maybeSingle(),
      supabase.from('election_results').select('*').eq('contest_id', contestId).order('votes', { ascending: false }),
    ])
    if (cRow) {
      setContests(prev => prev.map(c => (c.id === contestId ? { ...c, ...cRow } : c)))
      setResultsMap(prev => ({ ...prev, [contestId]: rRows || [] }))
    } else {
      // Row is gone (deleted elsewhere) — drop it rather than showing a ghost.
      setContests(prev => prev.filter(c => c.id !== contestId))
      setResultsMap(prev => { const next = { ...prev }; delete next[contestId]; return next })
    }
  }, [])

  // ── Contest CRUD ──────────────────────────────────────────────────────────
  const openAddContest = () => {
    setContestForm({ ...defaultContest })
    setContestModal('add')
  }

  const openEditContest = (c) => {
    setContestForm({
      office:          c.office,
      office_type:     c.office_type || 'judicial',
      district:        c.district    || '',
      county:          c.county      || '',
      precincts_total: c.precincts_total ?? '',
      precincts_rptg:  c.precincts_rptg  ?? '',
      is_nonpartisan:  c.is_nonpartisan  || false,
      seats:           c.seats ?? 1,
    })
    setContestModal(c)
  }

  const saveContest = async (e) => {
    e.preventDefault()
    setSaving(true)
    const payload = {
      election_id:     selectedElection.id,
      office:          contestForm.office.trim(),
      office_type:     contestForm.office_type,
      district:        contestForm.district.trim() || null,
      county:          contestForm.county.trim()   || null,
      precincts_total: parseInt(contestForm.precincts_total) || 0,
      precincts_rptg:  parseInt(contestForm.precincts_rptg)  || 0,
      is_nonpartisan:  contestForm.is_nonpartisan,
      seats:           parseInt(contestForm.seats) || 1,
    }

    // Audit fix (#13): RLS blocks direct client writes to election tables —
    // updates silently matched 0 rows. All writes now go through the
    // admin-verified service-role function, which checks affected rows.
    const { error } = contestModal === 'add'
      ? await adminElections('save_contest', { data: payload })
      : await adminElections('save_contest', { id: contestModal.id, data: payload })

    setSaving(false)
    if (error) { showToast('Save failed: ' + error.message, 'error'); return }
    const editedId = contestModal === 'add' ? null : contestModal.id
    showToast(contestModal === 'add' ? 'Contest added' : 'Contest updated')
    setContestModal(null)
    // A brand-new contest has to come from the list query; an edit only needs
    // its own row.
    if (editedId) refreshContest(editedId)
    else loadContests(selectedElection.id)
  }

  const deleteContest = async (id) => {
    if (!window.confirm('Delete this contest and all its candidate results?')) return
    setDeleting(id)
    const { error } = await adminElections('delete_contest', { id })
    setDeleting(null)
    if (error) { showToast('Delete failed: ' + error.message, 'error'); return }
    showToast('Contest deleted')
    setContests(prev => prev.filter(c => c.id !== id))
    setResultsMap(prev => { const next = { ...prev }; delete next[id]; return next })
  }

  // ── Result CRUD ───────────────────────────────────────────────────────────
  const openAddResult = (contestId) => {
    setResultForm({ ...defaultResult })
    setResultModal({ contestId })
  }

  const openEditResult = (contestId, result) => {
    setResultForm({
      candidate_name: result.candidate_name,
      party:          result.party    || 'Nonpartisan',
      incumbent:      result.incumbent || false,
      votes:          result.votes    ?? '',
      winner:         result.winner   || false,
      declared:       result.declared || false,
    })
    setResultModal({ contestId, result })
  }

  const saveResult = async (e) => {
    e.preventDefault()
    setSaving(true)
    const contestId = resultModal.contestId
    const payload = {
      contest_id:     contestId,
      candidate_name: resultForm.candidate_name.trim(),
      party:          resultForm.party,
      incumbent:      resultForm.incumbent,
      votes:          parseInt(resultForm.votes) || 0,
      winner:         resultForm.winner,
      declared:       resultForm.declared,
    }

    // Audit fix (#13): service-role write; vote_pct recalculation for the whole
    // contest happens server-side in the same action.
    const { error } = !resultModal.result
      ? await adminElections('save_result', { data: payload })
      : await adminElections('save_result', { id: resultModal.result.id, data: payload })

    if (error) { setSaving(false); showToast('Save failed: ' + error.message, 'error'); return }

    setSaving(false)
    showToast(!resultModal.result ? 'Candidate added' : 'Result updated')
    setResultModal(null)
    // Only this contest's slice — vote_pct for its siblings is recalculated
    // server-side in the same action, so one contest refetch is enough.
    refreshContest(contestId)
  }

  const deleteResult = async (id, contestId) => {
    if (!window.confirm('Remove this candidate result?')) return
    setDeleting(id)
    const { error } = await adminElections('delete_result', { id })
    setDeleting(null)
    if (error) { showToast('Delete failed: ' + error.message, 'error'); return }
    showToast('Result removed')
    refreshContest(contestId)
  }

  // ── Quick-call a race ─────────────────────────────────────────────────────
  // Opens confirmation dialog rather than calling immediately
  const promptCallRace = (contest, candidateId, candidateName) => {
    const results        = resultsMap[contest.id] || []
    const currentWinners = results.filter(r => r.declared).length
    setCallConfirm({ contestId: contest.id, candidateId, candidateName, seats: contest.seats || 1, currentWinners })
  }

  const confirmCallRace = async () => {
    if (!callConfirm) return
    const { contestId, candidateId, candidateName, seats } = callConfirm
    const results = resultsMap[contestId] || []
    // Audit fix (#13): the old direct update silently matched 0 rows under RLS
    // — on election night "declared winner" toasted success while the live
    // board never changed. Service-role write with affected-row verification;
    // officeholder sync happens server-side in the same action.
    const { error } = await adminElections('call_race', {
      result_id: candidateId,
      contest_id: contestId,
      candidate_name: candidateName,
    })
    setCallConfirm(null)
    if (error) { showToast('Call failed: ' + error.message + ' — the board was NOT updated', 'error'); return }
    const newWinnerCount = results.filter(r => r.declared || r.id === candidateId).length
    showToast(newWinnerCount >= seats ? `All ${seats} seat${seats > 1 ? 's' : ''} called` : 'Candidate declared winner')
    refreshContest(contestId)
  }

  const uncallRace = async (contestId) => {
    const { error } = await adminElections('uncall_race', { contest_id: contestId })
    if (error) { showToast('Un-call failed: ' + error.message, 'error'); return }
    showToast('Race un-called')
    refreshContest(contestId)
  }

  // ── Status override / determination engine ────────────────────────────────
  const [statusSaving, setStatusSaving] = useState(null) // contestId being written

  const overrideStatus = async (contestId, status) => {
    if (!status) return
    setStatusSaving(contestId)
    const { error } = await adminElections('set_status', { contest_id: contestId, status, source: 'admin' })
    setStatusSaving(null)
    if (error) { showToast('Status override failed: ' + error.message, 'error'); return }
    showToast(`Status set to "${STATUS_LABEL[status] || status}" — the engine will leave this race alone`)
    refreshContest(contestId)
  }

  const backToAuto = async (contestId) => {
    setStatusSaving(contestId)
    const { data, error } = await adminElections('reset_status_auto', { contest_id: contestId })
    setStatusSaving(null)
    if (error) { showToast('Reset failed: ' + error.message, 'error'); return }
    const engineSaid = data?.determination?.status
    showToast(engineSaid
      ? `Back on auto — engine says "${STATUS_LABEL[engineSaid] || engineSaid}"`
      : 'Back on auto')
    refreshContest(contestId)
  }

  // ── Precinct quick-update ─────────────────────────────────────────────────
  const [precEdit, setPrecEdit] = useState({}) // contestId -> { rptg, total }

  const updatePrecincts = async (contestId) => {
    const { rptg, total } = precEdit[contestId] || {}
    const { error } = await adminElections('update_precincts', { contest_id: contestId, rptg, total })
    if (error) { showToast('Update failed: ' + error.message, 'error'); return }
    showToast('Precincts updated')
    // Drop the pending edit so the inputs fall back to the saved values.
    setPrecEdit(prev => { const next = { ...prev }; delete next[contestId]; return next })
    refreshContest(contestId)
  }

  // ── Unopposed sweep ───────────────────────────────────────────────────────
  // A race nobody ran against never produces returns, so the poller leaves it
  // 'waiting' forever and the board shows an unresolved contest months later.
  // One click marks every such race called with its sole candidate as winner
  // (declared stays false — nobody declared anything). No subscriber emails.
  const [advancing, setAdvancing] = useState(false)

  const electionPassed = selectedElection?.election_date
    ? String(selectedElection.election_date) < format(new Date(), 'yyyy-MM-dd')
    : false

  const unopposedWaiting = contests.filter(
    c => c.status === 'waiting' && (resultsMap[c.id] || []).length === 1
  ).length

  const advanceUnopposed = async () => {
    if (!selectedElection || !unopposedWaiting) return
    if (!window.confirm(
      `${unopposedWaiting} uncontested race${unopposedWaiting === 1 ? '' : 's'} will be marked called, `
      + 'with the sole candidate flagged as the winner (not "declared"). '
      + 'No subscriber emails are sent. Continue?'
    )) return
    setAdvancing(true)
    const { data, error } = await adminElections('advance_unopposed', { election_id: selectedElection.id })
    setAdvancing(false)
    if (error) { showToast('Advance failed: ' + error.message, 'error'); return }
    const n = data?.advanced || 0
    showToast(n
      ? `${n} unopposed race${n === 1 ? '' : 's'} advanced — no notifications sent`
      : 'Nothing to advance')
    loadContests(selectedElection.id)
  }

  // ── Certification ─────────────────────────────────────────────────────────
  // Wisconsin county boards of canvass certify about two weeks after an
  // election; until somebody says so every contest stays 'called' and a
  // months-old election still reads like unofficial returns. This is the
  // manual version of the weekly certification-watch sweep — same writer.
  // Races at 'recount_possible' are never certified automatically: they come
  // back as needs_resolution for the admin to settle first.
  const [certifying,      setCertifying]      = useState(false)
  const [needsResolution, setNeedsResolution] = useState([])

  const calledNotCertified = contests.filter(c => c.status === 'called').length

  const certifyElection = async () => {
    if (!selectedElection || !calledNotCertified) return
    if (!window.confirm(
      `${calledNotCertified} called race${calledNotCertified === 1 ? '' : 's'} will be marked certified `
      + '(verified timestamp stamped, engine locked out). Races at "Recount possible" are NOT '
      + 'certified — resolve those by hand first. No subscriber emails are sent. Continue?'
    )) return
    setCertifying(true)
    const { data, error } = await adminElections('certify_election', { election_id: selectedElection.id })
    setCertifying(false)
    if (error) { showToast('Certification failed: ' + error.message, 'error'); return }
    const n = data?.certified || 0
    const pending = data?.needs_resolution || []
    setNeedsResolution(pending)
    showToast(n
      ? `${n} race${n === 1 ? '' : 's'} certified${pending.length ? ` — ${pending.length} still need${pending.length === 1 ? 's' : ''} a decision` : ''}`
      : 'Nothing to certify')
    loadContests(selectedElection.id)
  }

  // ── Derived ───────────────────────────────────────────────────────────────
  // "Races Called" used to count contests with a `declared` RESULT ROW — 10 on
  // an election where the certify button, three inches away, read "225 called".
  // Declaring a winner row and the contest's status are different writes, and
  // the engine calls races without ever setting `declared`. One definition now:
  // status IN ('called','certified'), shared with the public board.
  const calledCount  = countCalled(contests)
  const totalVotes   = contests.reduce(
    (s, c) => s + (resultsMap[c.id] || []).reduce((x, r) => x + (r.votes || 0), 0), 0)

  // ── Search + office-type filter ───────────────────────────────────────────
  // Finding one sheriff race in 250 contests used to mean scrolling past all of
  // them. Case-insensitive substring across office / county / district.
  const officeTypes = useMemo(
    () => [...new Set(contests.map(c => c.office_type).filter(Boolean))]
      .sort((a, b) => (OFFICE_TYPE_ORDER[a] ?? 99) - (OFFICE_TYPE_ORDER[b] ?? 99) || a.localeCompare(b)),
    [contests])

  const visibleContests = useMemo(() => {
    const q = search.trim().toLowerCase()
    return contests.filter(c => {
      if (typeFilter !== 'all' && (c.office_type || '') !== typeFilter) return false
      if (!q) return true
      return [c.office, c.county, c.district].filter(Boolean).join(' ').toLowerCase().includes(q)
    })
  }, [contests, search, typeFilter])

  // ─────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className="max-w-5xl mx-auto p-6 space-y-6">

      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-xl font-bold text-gray-900 flex items-center gap-2">
            <BarChart2 className="w-5 h-5 text-brand-red" />
            Election Results — Manual Entry
          </h2>
          <p className="text-sm text-gray-500 mt-1">
            Enter results by hand on election night. Changes appear live on the public results board.
          </p>
        </div>
        <Link to="/elections?tab=results" className="btn-secondary flex items-center gap-1.5 text-sm py-2">
          <Radio className="w-4 h-4" /> View Live Board
        </Link>
      </div>

      {/* Election picker */}
      <div className="card py-3">
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Election</span>
          <SearchableSelect
            className="flex-1 max-w-xs"
            buttonClassName="py-1.5 text-sm"
            value={selectedElection?.id || ''}
            onChange={v => setSelectedElection(elections.find(x => x.id === v) || null)}
            options={pickerElections.map(el => ({ value: el.id, label: `${el.name} — ${format(parseISO(el.election_date), 'MMM d, yyyy')}` }))}
            placeholder="Select election…"
            searchPlaceholder="Search elections…" />
          {selectedElection && (
            <button
              onClick={openAddContest}
              className="btn-primary flex items-center gap-1.5 text-sm py-1.5"
            >
              <Plus className="w-4 h-4" /> Add Contest
            </button>
          )}
          {selectedElection && electionPassed && unopposedWaiting > 0 && (
            <button
              onClick={advanceUnopposed}
              disabled={advancing}
              title="Mark every single-candidate race still awaiting results as called"
              className="btn-secondary flex items-center gap-1.5 text-sm py-1.5"
            >
              <Trophy className="w-4 h-4" />
              {advancing ? 'Advancing…' : `Advance ${unopposedWaiting} unopposed`}
            </button>
          )}
          {selectedElection && electionPassed && calledNotCertified > 0 && (
            <button
              onClick={certifyElection}
              disabled={certifying}
              title="Mark every called race certified — for after the county boards of canvass have finished"
              className="btn-secondary flex items-center gap-1.5 text-sm py-1.5"
            >
              <ShieldCheck className="w-4 h-4" />
              {certifying ? 'Certifying…' : `Certify election (${calledNotCertified} called)`}
            </button>
          )}
        </div>

        {/* Races the certification sweep deliberately did not touch. */}
        {needsResolution.length > 0 && (
          <div className="mt-3 rounded-lg border border-orange-200 bg-orange-50 p-3">
            <p className="text-xs font-semibold text-orange-800 flex items-center gap-1.5">
              <AlertTriangle className="w-4 h-4" />
              {needsResolution.length} race{needsResolution.length === 1 ? '' : 's'} not certified — recount possible
            </p>
            <p className="text-xs text-orange-700 mt-1">
              Certification never resolves these. Call the race or set its status by hand, then certify again.
            </p>
            <ul className="mt-2 space-y-0.5 text-xs text-orange-900 max-h-40 overflow-y-auto">
              {needsResolution.map(c => (
                <li key={c.contest_id}>
                  {[c.office, c.district, c.county && `${c.county} County`].filter(Boolean).join(' · ')}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* Stats bar */}
      {selectedElection && !loading && (
        <div className="grid grid-cols-3 gap-3">
          <div className="bg-white rounded-xl border border-gray-200 p-3 text-center">
            <p className="text-2xl font-bold text-gray-900">{contests.length}</p>
            <p className="text-xs text-gray-500 mt-0.5">Contests</p>
          </div>
          <div className="bg-white rounded-xl border border-gray-200 p-3 text-center">
            <p className="text-2xl font-bold text-green-600">{calledCount}</p>
            <p className="text-xs text-gray-500 mt-0.5">Races Called</p>
            <p className="text-[10px] text-gray-400 leading-tight">called or certified</p>
          </div>
          <div className="bg-white rounded-xl border border-gray-200 p-3 text-center">
            <p className="text-xl font-bold text-gray-900 tabular-nums">{totalVotes.toLocaleString()}</p>
            <p className="text-xs text-gray-500 mt-0.5">Total Votes</p>
          </div>
        </div>
      )}

      {/* ── Find a race ── */}
      {selectedElection && !loading && contests.length > 0 && (
        <div className="card py-3 space-y-3">
          <div className="flex items-center gap-3 flex-wrap">
            <div className="relative flex-1 min-w-[220px] max-w-md">
              <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="search"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search office, county or district…"
                className="w-full pl-9 pr-3 py-1.5 text-xs rounded-lg border border-gray-200 bg-white text-gray-700 placeholder-gray-400 focus:outline-none focus:border-brand-red/40"
              />
            </div>
            <span className="text-xs text-gray-400 tabular-nums">
              {visibleContests.length} of {contests.length} contest{contests.length !== 1 ? 's' : ''}
            </span>
            {(search || typeFilter !== 'all') && (
              <button
                onClick={() => { setSearch(''); setTypeFilter('all') }}
                className="text-xs text-gray-500 hover:text-brand-red font-medium"
              >
                Clear
              </button>
            )}
          </div>
          {officeTypes.length > 1 && (
            <div className="flex items-center gap-2 flex-wrap">
              <Filter className="w-4 h-4 text-gray-400 flex-shrink-0" />
              <div className="flex gap-1.5 flex-wrap">
                {['all', ...officeTypes].map(type => (
                  <button
                    key={type}
                    onClick={() => setTypeFilter(type)}
                    className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                      typeFilter === type ? 'bg-brand-navy text-white' : 'bg-white border border-gray-200 text-gray-600 hover:border-gray-300'
                    }`}
                  >
                    {type === 'all' ? 'All Races' : OFFICE_TYPE_LABEL[type] || type}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Contest list */}
      {loading ? (
        <div className="flex justify-center py-16">
          <div className="w-8 h-8 border-4 border-brand-red border-t-transparent rounded-full animate-spin" />
        </div>
      ) : contests.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center border-2 border-dashed border-gray-200 rounded-xl">
          <BarChart2 className="w-10 h-10 text-gray-200 mb-3" />
          <p className="text-gray-500 font-semibold">No contests yet</p>
          <p className="text-gray-400 text-sm mt-1 mb-4">Add the races for this election to start entering results.</p>
          <button onClick={openAddContest} className="btn-primary flex items-center gap-2 text-sm">
            <Plus className="w-4 h-4" /> Add First Contest
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {visibleContests.length === 0 && (
            <p className="text-center text-sm text-gray-400 py-10">
              No contests match {search ? `“${search}”` : 'this filter'}.
            </p>
          )}
          {visibleContests.map(contest => {
            const results       = [...(resultsMap[contest.id] || [])].sort((a, b) => (b.votes || 0) - (a.votes || 0))
            const isOpen        = expanded[contest.id] === true // default collapsed
            const seats         = contest.seats || 1
            const declaredCount = results.filter(r => r.declared).length
            const isCalled      = declaredCount >= seats && declaredCount > 0
            const prec     = precEdit[contest.id]

            return (
              <div key={contest.id} className={`rounded-xl border-2 overflow-hidden ${isCalled ? 'border-green-200' : 'border-gray-200'}`}>

                {/* Contest header */}
                <div className="bg-white px-4 py-3 flex items-start gap-3">
                  <button
                    onClick={() => setExpanded(prev => ({ ...prev, [contest.id]: !isOpen }))}
                    className="mt-0.5 text-gray-400 hover:text-gray-700 flex-shrink-0"
                  >
                    {isOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                  </button>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-bold text-gray-900 text-sm">{contest.office}</span>
                      <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">
                        {contest.office_type || 'other'}
                      </span>
                      {seats > 1 && (
                        <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full font-semibold">
                          {seats} seats
                        </span>
                      )}
                      {isCalled ? (
                        <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full font-semibold flex items-center gap-1">
                          <CheckCircle2 className="w-3 h-3" /> Called ({declaredCount}/{seats})
                        </span>
                      ) : declaredCount > 0 && (
                        <span className="text-xs bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full font-semibold">
                          {declaredCount}/{seats} called
                        </span>
                      )}
                      {contest.county && (
                        <span className="text-xs text-gray-400 flex items-center gap-0.5">
                          <MapPin className="w-3 h-3" />{contest.county} Co.
                        </span>
                      )}
                      {/* Collapsed by default — say whether anything is entered
                          without making the admin open the card to find out. */}
                      {!isOpen && (
                        <span className="text-xs text-gray-400">
                          {results.length === 0 ? 'no candidates' : `${results.length} candidate${results.length !== 1 ? 's' : ''}`}
                        </span>
                      )}
                    </div>

                    {/* Precinct inline edit */}
                    <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                      <span className="text-xs text-gray-500">Precincts:</span>
                      <input
                        type="number"
                        placeholder={String(contest.precincts_rptg)}
                        value={prec?.rptg ?? contest.precincts_rptg}
                        onChange={e => setPrecEdit(prev => ({
                          ...prev,
                          [contest.id]: { rptg: e.target.value, total: prec?.total ?? contest.precincts_total }
                        }))}
                        className="w-16 text-xs border border-gray-200 rounded px-1.5 py-0.5 text-center tabular-nums"
                      />
                      <span className="text-xs text-gray-400">/</span>
                      <input
                        type="number"
                        placeholder={String(contest.precincts_total)}
                        value={prec?.total ?? contest.precincts_total}
                        onChange={e => setPrecEdit(prev => ({
                          ...prev,
                          [contest.id]: { rptg: prec?.rptg ?? contest.precincts_rptg, total: e.target.value }
                        }))}
                        className="w-20 text-xs border border-gray-200 rounded px-1.5 py-0.5 text-center tabular-nums"
                      />
                      {prec && (
                        <button
                          onClick={() => updatePrecincts(contest.id)}
                          className="text-xs bg-brand-red text-white px-2 py-0.5 rounded font-medium hover:bg-brand-red/90"
                        >
                          Save
                        </button>
                      )}
                      {contest.precincts_total > 0 && (
                        <span className="text-xs text-gray-400 tabular-nums">
                          ({Math.round((contest.precincts_rptg / contest.precincts_total) * 100)}% in)
                        </span>
                      )}
                    </div>

                    {/* ── Determination engine: what it decided, and the override ── */}
                    <div className="mt-2 pt-2 border-t border-dashed border-gray-100">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs text-gray-500">Board status:</span>
                        <span className={`text-xs px-2 py-0.5 rounded-full font-semibold ${STATUS_CHIP[contest.status] || STATUS_CHIP.waiting}`}>
                          {STATUS_LABEL[contest.status] || contest.status || 'unknown'}
                        </span>
                        <span
                          className={`text-xs px-1.5 py-0.5 rounded font-medium ${
                            contest.status_source === 'admin' ? 'bg-purple-100 text-purple-700' : 'bg-gray-100 text-gray-500'
                          }`}
                          title={contest.status_source === 'admin'
                            ? 'Manually overridden — the determination engine will not touch this contest'
                            : 'Set automatically by the determination engine after each results change'}
                        >
                          {contest.status_source === 'admin' ? 'manual override' : 'auto'}
                        </span>
                        {contest.verified_at && (
                          <span className="text-xs px-1.5 py-0.5 rounded font-medium bg-emerald-100 text-emerald-800">
                            verified {format(parseISO(contest.verified_at), 'MMM d, h:mm a')}
                          </span>
                        )}
                        {contest.status_updated_at && (
                          <span className="text-xs text-gray-400">
                            updated {format(parseISO(contest.status_updated_at), 'MMM d, h:mm a')}
                          </span>
                        )}
                      </div>

                      {/* Why — straight from the engine (or from whoever overrode it) */}
                      {contest.status_detail?.reason && (
                        <p className="text-xs text-gray-400 mt-1 leading-snug">
                          {contest.status_detail.reason}
                          {contest.status_detail.fee_free ? ' (fee-free band)' : ''}
                        </p>
                      )}

                      <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                        <select
                          value=""
                          disabled={statusSaving === contest.id}
                          onChange={e => overrideStatus(contest.id, e.target.value)}
                          className="text-xs border border-gray-200 rounded px-1.5 py-1 bg-white text-gray-600"
                          title="Override the engine and pin this status"
                        >
                          <option value="">Override status…</option>
                          {STATUS_OPTIONS.map(o => (
                            <option key={o.value} value={o.value}>{o.label}</option>
                          ))}
                        </select>
                        {contest.status_source === 'admin' && (
                          <button
                            onClick={() => backToAuto(contest.id)}
                            disabled={statusSaving === contest.id}
                            className="text-xs border border-gray-200 rounded px-2 py-1 text-gray-600 hover:bg-gray-50 disabled:opacity-50"
                            title="Hand this contest back to the determination engine and recompute now"
                          >
                            {statusSaving === contest.id ? 'Working…' : 'Back to auto'}
                          </button>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Contest actions */}
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <button
                      onClick={() => openEditContest(contest)}
                      className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-700"
                      title="Edit contest"
                    >
                      <Edit2 className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => deleteContest(contest.id)}
                      disabled={deleting === contest.id}
                      className="p-1.5 rounded-lg hover:bg-red-50 text-gray-400 hover:text-brand-red"
                      title="Delete contest"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                {/* Candidate results */}
                {isOpen && (
                  <div className="bg-gray-50 border-t border-gray-100 px-4 py-3 space-y-2">
                    {results.length === 0 ? (
                      <p className="text-xs text-gray-400 text-center py-2">No candidates yet</p>
                    ) : (
                      results.map(r => (
                        <div
                          key={r.id}
                          className={`flex items-center gap-3 rounded-lg px-3 py-2 border ${
                            r.winner && r.declared
                              ? 'bg-green-50 border-green-200'
                              : 'bg-white border-gray-100'
                          }`}
                        >
                          {/* Winner icon */}
                          <div className="w-4 flex-shrink-0">
                            {r.winner && r.declared && <Trophy className="w-3.5 h-3.5 text-green-500" />}
                          </div>

                          {/* Candidate info */}
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-sm font-semibold text-gray-900">{r.candidate_name}</span>
                              {r.incumbent && (
                                <span className="text-xs bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded">Inc.</span>
                              )}
                              {r.party && (
                                <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${PARTY_COLORS[partyGroup(r.party)] || 'bg-gray-100 text-gray-700'}`}>
                                  {r.party}
                                </span>
                              )}
                              {r.winner && r.declared && (
                                <span className="text-xs bg-green-100 text-green-700 px-1.5 py-0.5 rounded font-semibold">WINNER</span>
                              )}
                            </div>
                            <p className="text-xs text-gray-500 tabular-nums mt-0.5">
                              {(r.votes || 0).toLocaleString()} votes
                              {r.vote_pct != null && ` · ${Number(r.vote_pct).toFixed(1)}%`}
                            </p>
                          </div>

                          {/* Actions */}
                          <div className="flex items-center gap-1 flex-shrink-0">
                            {!r.declared && results.length >= 1 && declaredCount < seats && (
                              <button
                                onClick={() => promptCallRace(contest, r.id, r.candidate_name)}
                                className="text-xs bg-green-100 text-green-700 hover:bg-green-200 px-2 py-1 rounded font-medium"
                                title="Declare this candidate a winner"
                              >
                                Call
                              </button>
                            )}
                            {r.declared && (
                              <button
                                onClick={() => uncallRace(contest.id)}
                                className="text-xs bg-amber-100 text-amber-700 hover:bg-amber-200 px-2 py-1 rounded font-medium"
                                title="Un-call all winners in this race"
                              >
                                Un-call
                              </button>
                            )}
                            <button
                              onClick={() => openEditResult(contest.id, r)}
                              className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-700"
                              title="Edit result"
                            >
                              <Edit2 className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={() => deleteResult(r.id, contest.id)}
                              disabled={deleting === r.id}
                              className="p-1.5 rounded-lg hover:bg-red-50 text-gray-400 hover:text-brand-red"
                              title="Remove candidate"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                      ))
                    )}

                    <button
                      onClick={() => openAddResult(contest.id)}
                      className="flex items-center gap-1.5 text-xs text-brand-red hover:text-brand-red/80 font-medium mt-1"
                    >
                      <Plus className="w-3.5 h-3.5" /> Add Candidate
                    </button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* ── Contest Modal ── */}
      {contestModal && (
        <Modal title={contestModal === 'add' ? 'Add Contest' : 'Edit Contest'} onClose={() => setContestModal(null)}>
          <form onSubmit={saveContest} className="space-y-4">
            <div>
              <label className="label">Office Name *</label>
              <input
                className="input"
                value={contestForm.office}
                onChange={e => setContestForm({ ...contestForm, office: e.target.value })}
                placeholder="e.g. Wisconsin Supreme Court"
                required
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">Office Type</label>
                <select
                  className="input"
                  value={contestForm.office_type}
                  onChange={e => setContestForm({ ...contestForm, office_type: e.target.value })}
                >
                  {OFFICE_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
              </div>
              <div>
                <label className="label">District</label>
                <input
                  className="input"
                  value={contestForm.district}
                  onChange={e => setContestForm({ ...contestForm, district: e.target.value })}
                  placeholder="e.g. District 5"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">County</label>
                <input
                  className="input"
                  value={contestForm.county}
                  onChange={e => setContestForm({ ...contestForm, county: e.target.value })}
                  placeholder="e.g. Milwaukee"
                />
              </div>
              <div className="flex items-center gap-2 mt-5">
                <input
                  type="checkbox"
                  id="is_nonpartisan"
                  checked={contestForm.is_nonpartisan}
                  onChange={e => setContestForm({ ...contestForm, is_nonpartisan: e.target.checked })}
                  className="w-4 h-4 rounded border-gray-300 text-brand-red"
                />
                <label htmlFor="is_nonpartisan" className="text-sm text-gray-700 cursor-pointer">Nonpartisan race</label>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="label">Seats</label>
                <input
                  className="input"
                  type="number"
                  min={1}
                  value={contestForm.seats}
                  onChange={e => setContestForm({ ...contestForm, seats: e.target.value })}
                  placeholder="1"
                  title="Number of winners in this race (1 for single-winner, 2+ for multi-seat)"
                />
              </div>
              <div>
                <label className="label">Precincts Reporting</label>
                <input
                  className="input"
                  type="number"
                  min={0}
                  value={contestForm.precincts_rptg}
                  onChange={e => setContestForm({ ...contestForm, precincts_rptg: e.target.value })}
                  placeholder="0"
                />
              </div>
              <div>
                <label className="label">Total Precincts</label>
                <input
                  className="input"
                  type="number"
                  min={0}
                  value={contestForm.precincts_total}
                  onChange={e => setContestForm({ ...contestForm, precincts_total: e.target.value })}
                  placeholder="0"
                />
              </div>
            </div>
            <ModalActions onCancel={() => setContestModal(null)} saving={saving}
              label={contestModal === 'add' ? 'Add Contest' : 'Save Changes'} />
          </form>
        </Modal>
      )}

      {/* ── Call Confirmation Modal ── */}
      {callConfirm && (
        <Modal title="Confirm Race Call" onClose={() => setCallConfirm(null)}>
          <div className="space-y-4">
            <div className="p-4 bg-amber-50 border border-amber-200 rounded-xl flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-semibold text-amber-900">
                  Declare <span className="text-brand-red">{callConfirm.candidateName}</span> as winner?
                </p>
                <p className="text-xs text-amber-700 mt-1">
                  {callConfirm.seats > 1
                    ? `This race has ${callConfirm.seats} seats. ${callConfirm.currentWinners} of ${callConfirm.seats} already called. This will call seat ${callConfirm.currentWinners + 1}.`
                    : 'This will mark them as officially declared and show the WINNER badge on the public board.'}
                  {' '}Use "Un-call" on the race to reverse this.
                </p>
              </div>
            </div>
            <div className="flex gap-3">
              <button type="button" onClick={() => setCallConfirm(null)} className="btn-secondary flex-1">Cancel</button>
              <button type="button" onClick={confirmCallRace} className="btn-primary flex-1">Yes, Call It</button>
            </div>
          </div>
        </Modal>
      )}

      {/* ── Result Modal ── */}
      {resultModal && (
        <Modal title={!resultModal.result ? 'Add Candidate' : 'Edit Result'} onClose={() => setResultModal(null)}>
          <form onSubmit={saveResult} className="space-y-4">
            <div>
              <label className="label">Candidate Name *</label>
              <input
                className="input"
                value={resultForm.candidate_name}
                onChange={e => setResultForm({ ...resultForm, candidate_name: e.target.value })}
                placeholder="Full name"
                required
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">Party</label>
                <SearchableSelect
                  value={resultForm.party}
                  onChange={v => setResultForm({ ...resultForm, party: v })}
                  options={PARTIES.map(p => ({ value: p, label: p }))}
                  placeholder="Select party…" />
              </div>
              <div className="flex items-center gap-2 mt-5">
                <input
                  type="checkbox"
                  id="incumbent"
                  checked={resultForm.incumbent}
                  onChange={e => setResultForm({ ...resultForm, incumbent: e.target.checked })}
                  className="w-4 h-4 rounded border-gray-300 text-brand-red"
                />
                <label htmlFor="incumbent" className="text-sm text-gray-700 cursor-pointer">Incumbent</label>
              </div>
            </div>
            <div>
              <label className="label">Votes</label>
              <input
                className="input"
                type="number"
                min={0}
                value={resultForm.votes}
                onChange={e => setResultForm({ ...resultForm, votes: e.target.value })}
                placeholder="0"
              />
              <p className="text-xs text-gray-400 mt-1">Vote % will be auto-calculated across all candidates when saved.</p>
            </div>
            <div className="flex gap-6">
              <label className="flex items-center gap-2 cursor-pointer" title="Check if this candidate is currently projected to win based on available returns.">
                <input
                  type="checkbox"
                  checked={resultForm.winner}
                  onChange={e => setResultForm({ ...resultForm, winner: e.target.checked })}
                  className="w-4 h-4 rounded border-gray-300 text-brand-red"
                />
                <span className="text-sm text-gray-700">Projected Winner</span>
                <span className="text-xs text-gray-400">(leading in returns)</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer" title="Check only once the race has been officially called — shows WINNER badge publicly.">
                <input
                  type="checkbox"
                  checked={resultForm.declared}
                  onChange={e => setResultForm({ ...resultForm, declared: e.target.checked })}
                  className="w-4 h-4 rounded border-gray-300 text-brand-red"
                />
                <span className="text-sm text-gray-700">Officially Called</span>
                <span className="text-xs text-gray-400">(shows WINNER badge)</span>
              </label>
            </div>
            <ModalActions onCancel={() => setResultModal(null)} saving={saving}
              label={!resultModal.result ? 'Add Candidate' : 'Save Result'} />
          </form>
        </Modal>
      )}
    </div>
  )
}

// ── Shared modal shell ────────────────────────────────────────────────────────
function Modal({ title, onClose, children }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="fixed inset-0 bg-black/50" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-6 border-b border-gray-100 sticky top-0 bg-white z-10">
          <h3 className="text-lg font-bold text-gray-900">{title}</h3>
          <button onClick={onClose}><X className="w-5 h-5 text-gray-400 hover:text-gray-700" /></button>
        </div>
        <div className="p-6">{children}</div>
      </div>
    </div>
  )
}

function ModalActions({ onCancel, saving, label }) {
  return (
    <div className="flex gap-3 pt-2">
      <button type="button" onClick={onCancel} className="btn-secondary flex-1">Cancel</button>
      <button type="submit" className="btn-primary flex-1" disabled={saving}>
        {saving ? 'Saving…' : label}
      </button>
    </div>
  )
}
