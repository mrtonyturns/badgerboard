// GamePlan.jsx — Campaign election calendar + results shell
// The Tasks tab renders <TaskBoard />; Calendar and Results live here.

import React, { useEffect, useState, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  format, differenceInDays,
  isPast, isFuture, parseISO, isToday,
} from 'date-fns'

// Crash-proof parseISO (see Elections.jsx): bad/missing dates → epoch.
const safeISO = (d) => {
  const t = parseISO(String(d ?? ''))
  return Number.isNaN(+t) ? new Date(0) : t
}

// Seed/QA rows ("TEST …", "ZZTEST …") never belong in the Results picker.
// (?![a-z]) so a real "Testing …" election is never swallowed by the filter.
const isTestElection = (e) => /^(zz)?test(?![a-z])/i.test(String(e?.name || '').trim())

import {
  CalendarDays, Plus, Clock, CheckCircle, Edit2, Trash2, X,
  BarChart2, AlertCircle, AlertTriangle,
} from 'lucide-react'
import {
  supabase,
  getElections, createElection, updateElection, deleteElection,
} from '../lib/supabase'
import ElectionResultsBoard from './ElectionResultsBoard'
import LoadingBar from '../components/LoadingBar'
import TaskBoard from '../components/TaskBoard'
import UpgradePrompt from '../components/UpgradePrompt'
import { useAuth } from '../contexts/AuthContext'
import { getUserPlan, hasFeature, PLAN_CONFIG } from '../lib/tiers'
import { ELECTION_TYPE_LABELS, ELECTION_TYPE_COLORS } from '../lib/campaignEnums'

// ─────────────────────────────────────────────────────────────────────────────
// ElectionModal
// ─────────────────────────────────────────────────────────────────────────────
const defaultElectionForm = {
  name: '', election_date: '', filing_deadline: '', type: 'general',
  year: new Date().getFullYear(), notes: '',
}

function ElectionModal({ open, onClose, editing, onSave, saving }) {
  const [form, setForm] = useState(defaultElectionForm)
  useEffect(() => {
    setForm(editing
      ? { name: editing.name, election_date: editing.election_date, filing_deadline: editing.filing_deadline || '', type: editing.type, year: editing.year, notes: editing.notes || '' }
      : defaultElectionForm)
  }, [editing, open])

  if (!open) return null
  const f = k => e => setForm(p => ({ ...p, [k]: e.target.value }))

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="fixed inset-0 bg-black/40 backdrop-blur-[1px]" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-lg ring-1 ring-gray-200">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <h2 className="text-base font-semibold text-gray-900">{editing ? 'Edit election' : 'Add election'}</h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-gray-100 text-gray-400 transition-colors"><X className="w-4 h-4" /></button>
        </div>
        <form onSubmit={e => { e.preventDefault(); onSave(form) }} className="p-6 space-y-4">
          <div>
            <label className="label">Election Name *</label>
            <input className="input" value={form.name} onChange={f('name')} placeholder="e.g. 2026 November General Election" required autoFocus />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">Election Date *</label>
              <input className="input" type="date" value={form.election_date} onChange={f('election_date')} required />
            </div>
            <div>
              <label className="label">Filing Deadline</label>
              <input className="input" type="date" value={form.filing_deadline} onChange={f('filing_deadline')} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">Type *</label>
              <select className="input" value={form.type} onChange={f('type')}>
                {Object.entries(ELECTION_TYPE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Year *</label>
              <input className="input" type="number" value={form.year} onChange={f('year')} min={2024} max={2035} required />
            </div>
          </div>
          <div>
            <label className="label">Notes</label>
            <textarea className="input" rows={2} value={form.notes} onChange={f('notes')} placeholder="Additional context…" />
          </div>
          <div className="flex gap-3 pt-1">
            <button type="button" onClick={onClose} className="btn-secondary flex-1">Cancel</button>
            <button type="submit" className="btn-primary flex-1" disabled={saving}>
              {saving ? 'Saving…' : editing ? 'Save changes' : 'Add election'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// ElectionRow
// ─────────────────────────────────────────────────────────────────────────────
function ElectionRow({ election, onEdit, onDelete, deleting, onViewResults }) {
  const daysUntil  = differenceInDays(parseISO(election.election_date), new Date())
  const isUpcoming = isFuture(parseISO(election.election_date))
  const isOngoing  = isToday(parseISO(election.election_date))
  const colors     = ELECTION_TYPE_COLORS[election.type] || ELECTION_TYPE_COLORS.general

  return (
    <div className={`p-4 rounded-xl border-2 ${isUpcoming || isOngoing ? colors.border : 'border-gray-200'} ${isUpcoming || isOngoing ? 'bg-white' : 'bg-gray-50'} transition-all hover:shadow-sm`}>
      <div className="flex items-start gap-4">
        <div className={`${isUpcoming || isOngoing ? colors.bg : 'bg-gray-400'} text-white rounded-xl p-3 text-center min-w-[60px] flex-shrink-0`}>
          <p className="text-xs font-medium opacity-80">{format(parseISO(election.election_date), 'MMM')}</p>
          <p className="text-2xl font-bold leading-tight">{format(parseISO(election.election_date), 'd')}</p>
          <p className="text-xs opacity-80">{format(parseISO(election.election_date), 'yyyy')}</p>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <h3 className={`font-bold ${isUpcoming || isOngoing ? 'text-gray-900' : 'text-gray-500'}`}>{election.name}</h3>
              <div className="flex items-center gap-2 mt-1 flex-wrap">
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${colors.light}`}>
                  {ELECTION_TYPE_LABELS[election.type] || election.type}
                </span>
                {isOngoing && (
                  <span className="flex items-center gap-1 text-xs font-bold text-red-600">
                    <span className="relative flex h-2 w-2">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
                      <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500" />
                    </span>
                    Election Night
                  </span>
                )}
                {isUpcoming && !isOngoing && (
                  <span className={`flex items-center gap-1 text-xs font-semibold ${daysUntil <= 30 ? 'text-brand-red' : daysUntil <= 90 ? 'text-orange-600' : 'text-gray-500'}`}>
                    <Clock className="w-3 h-3" />
                    {daysUntil === 0 ? 'Today!' : `${daysUntil} days away`}
                  </span>
                )}
                {!isUpcoming && !isOngoing && (
                  <span className="flex items-center gap-1 text-xs text-gray-400">
                    <CheckCircle className="w-3 h-3" /> Completed
                  </span>
                )}
              </div>
            </div>
            <div className="flex items-center gap-1 flex-shrink-0">
              <button onClick={() => onViewResults(election.id)} className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold transition-colors bg-brand-red/10 text-brand-red hover:bg-brand-red hover:text-white">
                <BarChart2 className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Results</span>
              </button>
              <button onClick={() => onEdit(election)} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-700 transition-colors">
                <Edit2 className="w-4 h-4" />
              </button>
              <button onClick={() => { if (window.confirm('Delete this election?')) onDelete(election.id) }} disabled={deleting === election.id} className="p-1.5 rounded-lg hover:bg-red-50 text-gray-400 hover:text-brand-red transition-colors">
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mt-3">
            {election.filing_deadline && (
              <div>
                <p className="text-xs text-gray-400 font-medium">Filing Deadline</p>
                <p className={`text-sm font-semibold ${isPast(parseISO(election.filing_deadline)) ? 'text-gray-400' : 'text-brand-red'}`}>
                  {format(parseISO(election.filing_deadline), 'MMM d, yyyy')}
                </p>
              </div>
            )}
            <div>
              <p className="text-xs text-gray-400 font-medium">Election Date</p>
              <p className="text-sm font-semibold text-gray-900">{format(parseISO(election.election_date), 'EEEE, MMMM d, yyyy')}</p>
            </div>
          </div>
          {election.notes && (() => {
            try { const p = JSON.parse(election.notes); if (p.results) return null } catch {}
            return <p className="text-xs text-gray-400 mt-2 italic">{election.notes}</p>
          })()}
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Main GamePlan component
// ─────────────────────────────────────────────────────────────────────────────
export default function GamePlan() {
  const { user } = useAuth()
  const [searchParams, setSearchParams] = useSearchParams()
  // Unknown ?tab= values fall back to milestones instead of a blank page.
  const rawTab = searchParams.get('tab')
  const activeTab = ['milestones', 'calendar', 'results'].includes(rawTab) ? rawTab : 'milestones'

  // ── Plan gate — Game Plan unlocks at Monitor (locked on Scout) ────────────
  const userPlan = getUserPlan(user)
  const gamePlanUnlocked = hasFeature(userPlan, 'gameplan')

  const _rawElection = searchParams.get('election')
  const selectedResultsId = (_rawElection && _rawElection !== 'null' && _rawElection !== 'undefined')
    ? _rawElection : null

  // The legacy game_plan_milestones UI (phase sections, milestone modal, plan
  // generator) was replaced by <TaskBoard /> and has been removed — nothing in
  // this page reads or writes that table any more.
  const [loading, setLoading] = useState(true)

  // ── Elections state ───────────────────────────────────────────────────────
  const [elections,     setElections]    = useState([])
  const [electLoading,  setElectLoading] = useState(true)
  const [showElect,     setShowElect]    = useState(false)
  const [editingElect,  setEditingElect] = useState(null)
  const [electSaving,   setElectSaving]  = useState(false)
  const [electError,    setElectError]   = useState(null)
  const [deleting,      setDeleting]     = useState(null)
  const [yearFilter,    setYearFilter]   = useState(String(new Date().getFullYear()))
  // Bug fix: a failed elections fetch used to leave the Results tab spinning
  // on "Loading elections…" forever. Record the failure and say so instead.
  const [electFetchError, setElectFetchError] = useState(null)
  // election ids that actually have at least one contest row (null = not looked
  // up yet) — used to pick a sensible default election for the Results tab.
  const [electionsWithContests, setElectionsWithContests] = useState(null)

  // ── Load data ─────────────────────────────────────────────────────────────
  useEffect(() => { fetchAll() }, [])

  const fetchAll = async () => {
    const [eRes] = await Promise.allSettled([getElections()])

    if (eRes.status === 'fulfilled' && !eRes.value?.error) {
      setElections(eRes.value?.data || [])
      setElectFetchError(null)
    } else {
      const err = eRes.status === 'fulfilled' ? eRes.value.error : eRes.reason
      console.error('fetchAll elections error:', err)
      setElections([])
      setElectFetchError(err?.message || 'Elections could not be loaded.')
    }

    setLoading(false)
    setElectLoading(false)
  }

  const fetchElections = async () => {
    setElectLoading(true)
    try {
      const { data, error } = await getElections()
      if (error) throw error
      setElections(data || [])
      setElectFetchError(null)
    } catch (err) {
      console.error('fetchElections error:', err)
      setElectFetchError(err?.message || 'Elections could not be loaded.')
    }
    setElectLoading(false)
  }

  const retryElections = () => {
    setElectionsWithContests(null)
    fetchElections()
  }

  // Which elections actually have contests? Only the ones the default could
  // plausibly land on — today plus the three most recent past — and each is a
  // head-only exact count, stopping at the first hit. (This used to pull every
  // contest row of every election just to answer a yes/no question; on a
  // 250-contest night that is the whole table.)
  useEffect(() => {
    if (activeTab !== 'results') return
    if (!elections.length) return
    if (electionsWithContests !== null) return
    let cancelled = false
    ;(async () => {
      const pool  = elections.filter(e => !isTestElection(e) && e.election_date)
      const today = pool.filter(e => isToday(safeISO(e.election_date)))
      const past  = pool
        .filter(e => isPast(safeISO(e.election_date)) && !isToday(safeISO(e.election_date)))
        .sort((a, b) => b.election_date.localeCompare(a.election_date))
        .slice(0, 3)
      const found = new Set()
      for (const e of [...today, ...past]) {
        try {
          const { count, error } = await supabase
            .from('election_contests')
            .select('id', { count: 'exact', head: true })
            .eq('election_id', e.id)
          if (cancelled) return
          if (error) throw error
          if ((count || 0) > 0) { found.add(e.id); break }
        } catch (err) {
          console.warn('[GamePlan] contest probe failed, falling back to date order:', err?.message)
          break   // empty ⇒ resolution falls through to date order
        }
      }
      if (!cancelled) setElectionsWithContests(found)
    })()
    return () => { cancelled = true }
  }, [activeTab, elections, electionsWithContests])

  const goToTab     = (t)  => setSearchParams(t === 'milestones' ? {} : { tab: t })
  const goToResults = (id) => {
    const params = { tab: 'results' }
    if (id && id !== 'null' && id !== 'undefined') params.election = id
    setSearchParams(params)
  }

  // ── Elections CRUD ────────────────────────────────────────────────────────
  const handleSaveElection = async (form) => {
    setElectSaving(true); setElectError(null)
    const payload = { ...form, year: parseInt(form.year), filing_deadline: form.filing_deadline || null }
    const { error } = editingElect
      ? await updateElection(editingElect.id, payload)
      : await createElection(payload)
    setElectSaving(false)
    if (error) { setElectError('Failed to save election.'); return }
    setEditingElect(null); setShowElect(false); fetchElections()
  }

  const handleDeleteElection = async (id) => {
    setDeleting(id)
    const { error } = await deleteElection(id)
    setDeleting(null)
    if (error) { console.error('Delete election error:', error); return }
    fetchElections()
  }

  const hasTodayElection = elections.some(e => isToday(parseISO(e.election_date)))
  const years            = [...new Set(elections.map(e => e.year))].sort()
  const filteredElect    = yearFilter ? elections.filter(e => String(e.year) === String(yearFilter)) : elections
  const upcoming         = filteredElect.filter(e => isFuture(parseISO(e.election_date)) || isToday(parseISO(e.election_date)))
  const past             = filteredElect.filter(e => isPast(parseISO(e.election_date)) && !isToday(parseISO(e.election_date)))
                             .sort((a, b) => parseISO(b.election_date) - parseISO(a.election_date))
  // ── Default election for the Results tab ──────────────────────────────────
  // Bug fix: this used to fall straight to "most recent past election", which
  // on a fresh account is an election with no contest rows — the board then
  // said "No results yet" forever. Preference order:
  //   1. an election happening today
  //   2. the most recent PAST election that actually has contests
  //   3. the next upcoming election
  //   4. the most recent past election (last resort)
  const resolvedResultsId = useMemo(() => {
    if (selectedResultsId) return selectedResultsId
    if (!elections.length) return null
    // Never default to a TEST/ZZTEST row — they're hidden from the picker.
    const pool = elections.filter(e => !isTestElection(e))
    if (!pool.length) return null

    const today = pool.find(e => isToday(parseISO(e.election_date)))
    if (today) return today.id

    const pastDesc = [...pool]
      .filter(e => isPast(parseISO(e.election_date)))
      .sort((a, b) => parseISO(b.election_date) - parseISO(a.election_date))

    if (electionsWithContests?.size) {
      const withResults = pastDesc.find(e => electionsWithContests.has(e.id))
      if (withResults) return withResults.id
    }

    const nextUp = [...pool]
      .filter(e => isFuture(parseISO(e.election_date)))
      .sort((a, b) => parseISO(a.election_date) - parseISO(b.election_date))[0]
    if (nextUp) return nextUp.id

    return pastDesc[0]?.id || null
  }, [selectedResultsId, elections, electionsWithContests])

  // The board renders its own election tab strip from this list.
  const publicElections = useMemo(
    () => elections.filter(e => !isTestElection(e) || e.id === selectedResultsId),
    [elections, selectedResultsId])

  // Push the resolved id into the URL so the Results tab is linkable and a
  // refresh lands on the same election (mirrors Elections.jsx). replace:true —
  // auto-selection is not a navigation the back button should have to undo.
  useEffect(() => {
    if (activeTab !== 'results') return
    if (selectedResultsId) return
    if (!elections.length) return
    if (electionsWithContests === null) return   // wait for the contest lookup
    if (resolvedResultsId) {
      setSearchParams({ tab: 'results', election: resolvedResultsId }, { replace: true })
    }
  }, [activeTab, selectedResultsId, elections.length, electionsWithContests, resolvedResultsId, setSearchParams])

  // ─────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────

  // Locked state — Scout doesn't include Game Plan (unlocks at Monitor)
  if (!gamePlanUnlocked) {
    return (
      <div className="space-y-5">
        <div className="flex items-center gap-4">
          <div>
            <h1 className="text-xl font-bold text-gray-900">Game Plan</h1>
            <p className="text-gray-400 text-sm mt-0.5">Campaign tasks &amp; election calendar</p>
          </div>
        </div>
        <UpgradePrompt
          feature="Game Plan"
          hook="Winning campaigns run on a plan — milestones, filing deadlines, voter contact, fundraising, and GOTV in one timeline. Unlock it in 60 seconds."
          plan={PLAN_CONFIG.c_monitor.name}
          price={PLAN_CONFIG.c_monitor.price}
          benefits={[
            'Full campaign milestone timeline with phases',
            'Election calendar & filing deadline tracking',
            'Task board with quick-add and progress tracking',
            'Plus full AI profiles, CSV import & social links',
          ]}
        />
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <LoadingBar loading={loading} />

      {/* ── Page header lives in the top bar (v1.24.1) ── */}
      <div className="flex items-center gap-4">
        <div className="ml-auto flex items-center gap-2">
          {activeTab === 'calendar' && (
            <button onClick={() => { setEditingElect(null); setShowElect(true) }} className="btn-primary flex items-center gap-2 text-sm">
              <Plus className="w-4 h-4" /> Add election
            </button>
          )}
        </div>
      </div>

      {/* Internal tab bar removed (v1.23) — Todo lives in the sidebar; Calendar and Results are Campaign top-bar tabs. ?tab= routing unchanged. */}

      {/* ══════════════════════════════════════════════════════════ */}
      {/* TASKS TAB — Todoist-style task manager                    */}
      {/* ══════════════════════════════════════════════════════════ */}
      {/* Kept mounted across tab switches so the board doesn't refetch on every flip */}
      <div className={activeTab === 'milestones' ? '' : 'hidden'}>
        <TaskBoard />
      </div>

      {/* ══════════════════════════════════════════════════════════ */}
      {/* CALENDAR TAB                                             */}
      {/* ══════════════════════════════════════════════════════════ */}
      {activeTab === 'calendar' && (
        <>
          {hasTodayElection && (() => {
            const todayEl = elections.find(e => isToday(parseISO(e.election_date)))
            return (
              <button
                onClick={() => goToResults(todayEl?.id)}
                className="w-full rounded-xl bg-brand-navy text-white p-4 flex items-center justify-between gap-4 hover:bg-brand-navy/90 transition-colors text-left"
              >
                <div className="flex items-center gap-3">
                  <span className="relative flex h-3 w-3 flex-shrink-0">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
                    <span className="relative inline-flex rounded-full h-3 w-3 bg-red-500" />
                  </span>
                  <div>
                    <p className="font-bold text-sm">Election Night — Live Results</p>
                    <p className="text-xs text-white/70">Results updating automatically via WEC · Click to open the live board</p>
                  </div>
                </div>
                <BarChart2 className="w-5 h-5 text-white/60 flex-shrink-0" />
              </button>
            )
          })()}

          {years.length > 1 && (
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs text-gray-500 font-medium">Year:</span>
              <button onClick={() => setYearFilter('')} className={`text-xs px-3 py-1 rounded-full font-medium transition-colors ${!yearFilter ? 'bg-brand-red text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>All</button>
              {years.map(y => (
                <button key={y} onClick={() => setYearFilter(String(y))} className={`text-xs px-3 py-1 rounded-full font-medium transition-colors ${String(yearFilter) === String(y) ? 'bg-brand-red text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>{y}</button>
              ))}
            </div>
          )}

          {electLoading ? (
            <div className="flex items-center justify-center py-20">
              <div className="w-7 h-7 border-2 border-brand-red border-t-transparent rounded-full animate-spin" />
            </div>
          ) : (
            <div className="space-y-6">
              {upcoming.length > 0 && (
                <div>
                  <div className="flex items-center gap-2 mb-3">
                    <AlertCircle className="w-4 h-4 text-brand-red" />
                    <h2 className="text-sm font-bold text-gray-900">Upcoming</h2>
                    <span className="text-xs bg-brand-red text-white px-2 py-0.5 rounded-full">{upcoming.length}</span>
                  </div>
                  <div className="space-y-3">
                    {upcoming.map(e => <ElectionRow key={e.id} election={e} onEdit={el => { setEditingElect(el); setShowElect(true) }} onDelete={handleDeleteElection} deleting={deleting} onViewResults={goToResults} />)}
                  </div>
                </div>
              )}
              {past.length > 0 && (
                <div>
                  <div className="flex items-center gap-2 mb-3">
                    <CheckCircle className="w-4 h-4 text-gray-400" />
                    <h2 className="text-sm font-bold text-gray-500">Past Elections</h2>
                    <span className="text-xs bg-gray-200 text-gray-600 px-2 py-0.5 rounded-full">{past.length}</span>
                  </div>
                  <div className="space-y-3">
                    {past.map(e => <ElectionRow key={e.id} election={e} onEdit={el => { setEditingElect(el); setShowElect(true) }} onDelete={handleDeleteElection} deleting={deleting} onViewResults={goToResults} />)}
                  </div>
                </div>
              )}
              {filteredElect.length === 0 && (
                <div className="text-center py-16 border-2 border-dashed border-gray-200 rounded-2xl">
                  <CalendarDays className="w-10 h-10 text-gray-300 mx-auto mb-3" />
                  {elections.length > 0 && yearFilter ? (
                    <>
                      <p className="text-gray-500 font-medium text-sm">No elections in {yearFilter}</p>
                      <button onClick={() => setYearFilter('')} className="btn-secondary text-sm mt-4">Show all years</button>
                    </>
                  ) : (
                    <>
                      <p className="text-gray-500 font-medium text-sm mb-1">No elections added yet</p>
                      <p className="text-gray-400 text-sm mb-4">Add elections to track filing deadlines and results</p>
                      <button onClick={() => { setEditingElect(null); setShowElect(true) }} className="btn-primary text-sm">Add first election</button>
                    </>
                  )}
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* ══════════════════════════════════════════════════════════ */}
      {/* RESULTS TAB                                              */}
      {/* ══════════════════════════════════════════════════════════ */}
      {activeTab === 'results' && (
        electFetchError ? (
          // Honest failure beats an eternal spinner.
          <div className="text-center py-16 border-2 border-dashed border-red-200 bg-red-50/40 rounded-2xl">
            <AlertTriangle className="w-10 h-10 text-red-400 mx-auto mb-3" />
            <p className="text-gray-800 font-semibold text-sm">Couldn't load elections</p>
            <p className="text-gray-500 text-sm mt-1 max-w-sm mx-auto">{electFetchError}</p>
            <button onClick={retryElections} disabled={electLoading} className="btn-secondary text-sm mt-4">
              {electLoading ? 'Retrying…' : 'Retry'}
            </button>
          </div>
        ) : electLoading ? (
          <div className="flex flex-col items-center justify-center py-20 gap-3">
            <div className="w-8 h-8 border-4 border-brand-red border-t-transparent rounded-full animate-spin" />
            <p className="text-gray-400 text-sm">Loading elections…</p>
          </div>
        ) : elections.length === 0 ? (
          <div className="text-center py-16 border-2 border-dashed border-gray-200 rounded-2xl">
            <CalendarDays className="w-10 h-10 text-gray-300 mx-auto mb-3" />
            <p className="text-gray-500 font-medium text-sm mb-1">No elections yet</p>
            <p className="text-gray-400 text-sm mb-4">Add an election on the Calendar tab and results will show up here.</p>
            <button onClick={() => goToTab('calendar')} className="btn-secondary text-sm">Go to Calendar</button>
          </div>
        ) : (
          <ElectionResultsBoard
            elections={publicElections}
            selectedId={resolvedResultsId}
            onSelectElection={goToResults}
          />
        )
      )}

      {/* ── Modals ── */}
      <ElectionModal
        open={showElect}
        onClose={() => { if (!electSaving) { setEditingElect(null); setShowElect(false) } }}
        editing={editingElect}
        onSave={handleSaveElection}
        saving={electSaving}
      />
    </div>
  )
}
