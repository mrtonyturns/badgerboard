// ElectionResultsAdmin.jsx
// Manual election results entry for the admin panel.
// Replaces the fake WEC poller — an admin enters results by hand on election night.

import React, { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { format, parseISO } from 'date-fns'
import {
  BarChart2, Plus, Edit2, Trash2, Trophy, ChevronDown, ChevronUp,
  CheckCircle2, X, MapPin, Users, Radio, ExternalLink, AlertTriangle,
} from 'lucide-react'
import { supabase } from '../lib/supabase'

// ── Constants ─────────────────────────────────────────────────────────────────
const OFFICE_TYPES = [
  { value: 'statewide',   label: 'Statewide' },
  { value: 'judicial',    label: 'Judicial' },
  { value: 'legislative', label: 'Legislative' },
  { value: 'county',      label: 'County' },
  { value: 'municipal',   label: 'Municipal' },
  { value: 'referendum',  label: 'Referendum' },
]

const PARTIES = [
  'Democrat', 'Republican', 'Independent', 'Nonpartisan',
  'Libertarian', 'Green', 'Constitution', 'Other',
]

const PARTY_COLORS = {
  Democrat:    'bg-blue-100 text-blue-800',
  Republican:  'bg-red-100 text-red-700',
  Independent: 'bg-purple-100 text-purple-800',
  Nonpartisan: 'bg-gray-100 text-gray-700',
  Libertarian: 'bg-amber-100 text-amber-800',
  Green:       'bg-green-100 text-green-800',
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
  const [expanded,         setExpanded]         = useState({})

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
        setElections(data || [])
        if (data?.length) setSelectedElection(data[0])
      })
  }, [])

  // Load contests + results whenever selected election changes
  useEffect(() => {
    if (selectedElection) loadContests(selectedElection.id)
  }, [selectedElection])

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
      const { data: rData } = await supabase
        .from('election_results')
        .select('*')
        .in('contest_id', cData.map(c => c.id))
        .order('votes', { ascending: false })

      const map = {}
      for (const r of rData || []) {
        if (!map[r.contest_id]) map[r.contest_id] = []
        map[r.contest_id].push(r)
      }
      setResultsMap(map)
    } else {
      setResultsMap({})
    }
    setLoading(false)
  }, [showToast])

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

    const { error } = contestModal === 'add'
      ? await supabase.from('election_contests').insert(payload)
      : await supabase.from('election_contests').update(payload).eq('id', contestModal.id)

    setSaving(false)
    if (error) { showToast('Save failed: ' + error.message, 'error'); return }
    showToast(contestModal === 'add' ? 'Contest added' : 'Contest updated')
    setContestModal(null)
    loadContests(selectedElection.id)
  }

  const deleteContest = async (id) => {
    if (!window.confirm('Delete this contest and all its candidate results?')) return
    setDeleting(id)
    const { error } = await supabase.from('election_contests').delete().eq('id', id)
    setDeleting(null)
    if (error) { showToast('Delete failed: ' + error.message, 'error'); return }
    showToast('Contest deleted')
    loadContests(selectedElection.id)
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

    const { data: savedRow, error } = !resultModal.result
      ? await supabase.from('election_results').insert(payload).select().single()
      : await supabase.from('election_results').update(payload).eq('id', resultModal.result.id).select().single()

    if (error) { setSaving(false); showToast('Save failed: ' + error.message, 'error'); return }

    // Auto-recalculate vote_pct for all candidates in this contest
    const { data: allRows } = await supabase
      .from('election_results')
      .select('id, votes')
      .eq('contest_id', contestId)
    const totalVotes = (allRows || []).reduce((s, r) => s + (r.votes || 0), 0)
    if (totalVotes > 0 && allRows?.length) {
      await Promise.all(allRows.map(r =>
        supabase.from('election_results').update({
          vote_pct: parseFloat(((r.votes || 0) / totalVotes * 100).toFixed(1))
        }).eq('id', r.id)
      ))
    }

    setSaving(false)
    showToast(!resultModal.result ? 'Candidate added' : 'Result updated')
    setResultModal(null)
    loadContests(selectedElection.id)
  }

  const deleteResult = async (id) => {
    if (!window.confirm('Remove this candidate result?')) return
    setDeleting(id)
    const { error } = await supabase.from('election_results').delete().eq('id', id)
    setDeleting(null)
    if (error) { showToast('Delete failed: ' + error.message, 'error'); return }
    showToast('Result removed')
    loadContests(selectedElection.id)
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
    const { contestId, candidateId, seats } = callConfirm
    const results = resultsMap[contestId] || []
    // Mark this candidate as winner+declared; leave others untouched (multi-seat allows multiple winners)
    await supabase.from('election_results').update({ winner: true, declared: true }).eq('id', candidateId)
    // If this fills the last seat, optionally mark all remaining non-winners as declared=false, winner=false
    const newWinnerCount = results.filter(r => r.declared || r.id === candidateId).length
    setCallConfirm(null)
    showToast(newWinnerCount >= seats ? `All ${seats} seat${seats > 1 ? 's' : ''} called` : 'Candidate declared winner')
    loadContests(selectedElection.id)

    // Best-effort: keep offices.current_officeholder in sync so the Offices page
    // "previous office holders" history always shows who currently holds the seat.
    // Single-seat races only — multi-seat bodies don't map to one officeholder.
    try {
      if ((seats || 1) === 1) {
        const contest = contests.find(c => c.id === contestId)
        const winnerName = callConfirm.candidateName
        if (contest?.office && winnerName) {
          const { data: matches } = await supabase
            .from('offices')
            .select('id, name')
            .ilike('name', `%${contest.office}%`)
            .limit(2)
          if (matches?.length === 1) {
            await supabase.from('offices')
              .update({ current_officeholder: winnerName })
              .eq('id', matches[0].id)
          }
        }
      }
    } catch (err) {
      console.warn('[ElectionResultsAdmin] officeholder sync skipped:', err)
    }
  }

  const uncallRace = async (contestId) => {
    const results = resultsMap[contestId] || []
    await Promise.all(results.map(r =>
      supabase.from('election_results').update({ winner: false, declared: false }).eq('id', r.id)
    ))
    showToast('Race un-called')
    loadContests(selectedElection.id)
  }

  // ── Precinct quick-update ─────────────────────────────────────────────────
  const [precEdit, setPrecEdit] = useState({}) // contestId -> { rptg, total }

  const updatePrecincts = async (contestId) => {
    const { rptg, total } = precEdit[contestId] || {}
    const { error } = await supabase.from('election_contests').update({
      precincts_rptg:  parseInt(rptg)  || 0,
      precincts_total: parseInt(total) || 0,
    }).eq('id', contestId)
    if (error) { showToast('Update failed: ' + error.message, 'error'); return }
    showToast('Precincts updated')
    loadContests(selectedElection.id)
  }

  // ── Derived ───────────────────────────────────────────────────────────────
  const calledCount  = contests.filter(c => (resultsMap[c.id] || []).some(r => r.declared)).length
  const totalVotes   = Object.values(resultsMap).flat().reduce((s, r) => s + (r.votes || 0), 0)

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
          <select
            className="input py-1.5 text-sm flex-1 max-w-xs"
            value={selectedElection?.id || ''}
            onChange={e => {
              const el = elections.find(x => x.id === e.target.value)
              setSelectedElection(el || null)
            }}
          >
            {elections.map(el => (
              <option key={el.id} value={el.id}>
                {el.name} — {format(parseISO(el.election_date), 'MMM d, yyyy')}
              </option>
            ))}
          </select>
          {selectedElection && (
            <button
              onClick={openAddContest}
              className="btn-primary flex items-center gap-1.5 text-sm py-1.5"
            >
              <Plus className="w-4 h-4" /> Add Contest
            </button>
          )}
        </div>
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
          </div>
          <div className="bg-white rounded-xl border border-gray-200 p-3 text-center">
            <p className="text-xl font-bold text-gray-900 tabular-nums">{totalVotes.toLocaleString()}</p>
            <p className="text-xs text-gray-500 mt-0.5">Total Votes</p>
          </div>
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
          {contests.map(contest => {
            const results       = (resultsMap[contest.id] || []).sort((a, b) => (b.votes || 0) - (a.votes || 0))
            const isOpen        = expanded[contest.id] !== false // default open
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
                                <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${PARTY_COLORS[r.party] || 'bg-gray-100 text-gray-700'}`}>
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
                              onClick={() => deleteResult(r.id)}
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
                <select
                  className="input"
                  value={resultForm.party}
                  onChange={e => setResultForm({ ...resultForm, party: e.target.value })}
                >
                  {PARTIES.map(p => <option key={p} value={p}>{p}</option>)}
                </select>
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
