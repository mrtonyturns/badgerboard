// Elections.jsx — Calendar + live results in one page
// Two tabs: Calendar (upcoming/past) | Results (live board for selected election)
// Clicking "View Results" on any card switches to Results tab with that election loaded.

import React, { useEffect, useState, useCallback, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { format, differenceInDays, isPast, isFuture, parseISO, isToday } from 'date-fns'

// Crash-proof parseISO: null/undefined/malformed dates → epoch (renders as
// past) instead of Invalid Date, which crashes format() and comparisons.
// This page passes the result straight into date-fns with no null check, so it
// needs the EPOCH contract — not lib/date.js's safeISO, which returns null.
import { safeISOOrEpoch as safeISO } from '../lib/date'
import {
  CalendarDays, Plus, Clock, CheckCircle, Edit2, Trash2, X,
  BarChart2, AlertCircle, AlertTriangle, Radio,
} from 'lucide-react'
import { supabase, getElections, createElection, updateElection, deleteElection } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import ElectionResultsBoard from './ElectionResultsBoard'
import LoadingBar from '../components/LoadingBar'
import { useDialog } from '../lib/useDialog'

// Escape + scroll-lock for this page's add/edit dialog. Mounted only while the
// dialog is open, so the hook's effect is scoped to its lifetime.
function Dialog({ onClose, children }) {
  useDialog(onClose)
  return <div className="fixed inset-0 z-50 flex items-center justify-center p-4">{children}</div>
}

// ── Constants ─────────────────────────────────────────────────────────────────
const TYPE_LABELS = {
  primary:        'Partisan Primary',
  general:        'General Election',
  spring_primary: 'Spring Primary',
  spring_general: 'Spring General',
  special:        'Special Election',
}

const TYPE_COLORS = {
  primary:        { bg: 'bg-orange-500', light: 'bg-orange-100 text-orange-800', border: 'border-orange-300' },
  general:        { bg: 'bg-blue-600',   light: 'bg-blue-100 text-blue-800',     border: 'border-blue-300' },
  spring_primary: { bg: 'bg-purple-600', light: 'bg-purple-100 text-purple-800', border: 'border-purple-300' },
  spring_general: { bg: 'bg-emerald-600',light: 'bg-emerald-100 text-emerald-800',border: 'border-emerald-300' },
  special:        { bg: 'bg-yellow-500', light: 'bg-yellow-100 text-yellow-800', border: 'border-yellow-300' },
}

// ─── R3B PURE HELPERS BEGIN ───────────────────────────────────────────────────
// (no imports in this block — tests/r3b.test.mjs slices it out and imports it)
// The identical pair is duplicated in GamePlan.jsx, whose Calendar tab is the
// same feature at a second route: the two Apr 7 2026 elections used to come out
// in different orders because neither page had a tiebreak after the date.

/** Calendar order: election date ascending, then name. */
export const compareElectionsAsc = (a, b) => {
  const ad = String(a?.election_date || ''), bd = String(b?.election_date || '')
  if (ad !== bd) return ad < bd ? -1 : 1
  return String(a?.name || '').localeCompare(String(b?.name || ''))
}

/** Past list: most recent first, then name (NOT a reversed ascending sort —
 *  that would flip the name tiebreak too). */
export const compareElectionsDesc = (a, b) => {
  const ad = String(a?.election_date || ''), bd = String(b?.election_date || '')
  if (ad !== bd) return ad < bd ? 1 : -1
  return String(a?.name || '').localeCompare(String(b?.name || ''))
}
// ─── R3B PURE HELPERS END ─────────────────────────────────────────────────────

const defaultForm = {
  name: '', election_date: '', filing_deadline: '', type: 'general',
  year: new Date().getFullYear(), notes: '',
}

// Seed/QA rows ("TEST Spring Primary 2026", "ZZTEST …") are not something a
// visitor should be offered in the results tab strip.
// (?![a-z]) so a real "Testing …" election is never swallowed by the filter.
const isTestElection = (e) => /^(zz)?test(?![a-z])/i.test(String(e?.name || '').trim())

// ─────────────────────────────────────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────────────────────────────────────
export default function Elections() {
  const [searchParams, setSearchParams] = useSearchParams()

  // Tab state — driven by ?tab=results&election=<id> so it survives refresh
  const activeTab        = searchParams.get('tab') || 'calendar'
  // Guard against "null" / "undefined" strings that end up in the URL if id was missing
  const _rawElection     = searchParams.get('election')
  const selectedResultsId = (_rawElection && _rawElection !== 'null' && _rawElection !== 'undefined')
    ? _rawElection : null

  const [elections,   setElections]   = useState([])
  const [loading,     setLoading]     = useState(true)
  const [showModal,   setShowModal]   = useState(false)
  const [editing,     setEditing]     = useState(null)
  const [saving,      setSaving]      = useState(false)
  const [deleting,    setDeleting]    = useState(null)
  const [form,        setForm]        = useState(defaultForm)
  const [yearFilter,  setYearFilter]  = useState(String(new Date().getFullYear()))
  const [writeError,  setWriteError]  = useState(null)
  // A failed elections fetch used to leave the Results tab spinning forever
  // ("Loading elections…") with no way out. Record the failure and offer Retry.
  const [fetchError,  setFetchError]  = useState(null)
  // Election ids known to have at least one contest row (null = not probed
  // yet). Drives the default Results election so the tab doesn't land on a
  // recent-but-empty election and say "No results yet".
  const [electionsWithContests, setElectionsWithContests] = useState(null)
  // Audit fix (#13): election writes are admin-only (RLS blocks everyone else
  // and the server function requires admin) — hide write controls accordingly.
  const { isAdmin } = useAuth()

  // ── Load elections ──────────────────────────────────────────────────────────
  useEffect(() => { fetchElections() }, [])

  const fetchElections = async () => {
    setLoading(true)
    try {
      const { data, error } = await getElections()
      if (error) throw error
      setElections(data || [])
      setFetchError(null)
    } catch (err) {
      // Keep whatever list we already had — a transient failure should not
      // blank a working page.
      console.error('[Elections] fetch error:', err)
      setFetchError(err?.message || 'Elections could not be loaded.')
    }
    setLoading(false)
  }

  const retryElections = () => {
    setElectionsWithContests(null)
    fetchElections()
  }

  const hasTodayElection = useCallback((list) => list.some(e => isToday(safeISO(e.election_date))), [])

  // ── Tab helpers ─────────────────────────────────────────────────────────────
  const goToCalendar = () => setSearchParams({})
  const goToResults  = (electionId) => {
    // Never write null/undefined into the URL — the auto-select logic in resolvedResultsId handles that
    const params = { tab: 'results' }
    if (electionId && electionId !== 'null' && electionId !== 'undefined') params.election = electionId
    setSearchParams(params)
  }

  // ── Modal helpers ───────────────────────────────────────────────────────────
  const openAdd = () => { setEditing(null); setForm(defaultForm); setShowModal(true) }
  const openEdit = (e) => {
    setEditing(e)
    setForm({ name: e.name, election_date: e.election_date, filing_deadline: e.filing_deadline || '', type: e.type, year: e.year, notes: e.notes || '' })
    setShowModal(true)
  }

  const handleSave = async (evt) => {
    evt.preventDefault()
    setSaving(true)
    setWriteError(null)
    const payload = { ...form, year: parseInt(form.year), filing_deadline: form.filing_deadline || null }
    // Audit fix (#13): check the result — the old code closed the modal and
    // refetched no matter what, so RLS-blocked writes looked like success
    // while the election silently never changed.
    const { error } = editing ? await updateElection(editing.id, payload) : await createElection(payload)
    setSaving(false)
    if (error) {
      setWriteError(`Couldn't save the election: ${error.message}`)
      return
    }
    setShowModal(false)
    fetchElections()
  }

  const handleDelete = async (id) => {
    setDeleting(id)
    setWriteError(null)
    const { error } = await deleteElection(id)
    setDeleting(null)
    if (error) {
      setWriteError(`Couldn't delete the election: ${error.message}`)
      return
    }
    fetchElections()
  }

  // ── Derived data ────────────────────────────────────────────────────────────
  const currentYear = new Date().getFullYear()
  const years       = [...new Set(elections.map(e => e.year))].sort().filter(y => Number(y) >= currentYear)
  const filtered    = yearFilter ? elections.filter(e => String(e.year) === String(yearFilter)) : elections
  // Same buckets and the same sort as the Game Plan calendar tab: today's
  // election is Upcoming (it used to fall into Past here, so the identical
  // calendar showed a gray "Past" badge on one route and the red "Upcoming"
  // badge on the other), and same-date elections order by name instead of by
  // whatever order the rows arrived in.
  const upcoming    = filtered
    .filter(e => isFuture(safeISO(e.election_date)) || isToday(safeISO(e.election_date)))
    .sort(compareElectionsAsc)
  const past        = filtered
    .filter(e => isPast(safeISO(e.election_date)) && !isToday(safeISO(e.election_date)))
    .sort(compareElectionsDesc)

  // Elections a visitor may be shown in the Results tab strip.
  const publicElections = useMemo(
    () => elections.filter(e => !isTestElection(e) || e.id === selectedResultsId),
    [elections, selectedResultsId])

  // ── Which recent elections actually have contests? ──────────────────────────
  // Cheap probes only: head + exact count, at most four, newest first, stopping
  // at the first hit. (The old fetch-every-row approach pulled the entire
  // contests table just to answer "which one has data?".)
  useEffect(() => {
    if (activeTab !== 'results') return
    if (!elections.length) return
    if (electionsWithContests !== null) return
    let cancelled = false
    ;(async () => {
      const pool = elections.filter(e => !isTestElection(e) && e.election_date)
      const today = pool.filter(e => isToday(safeISO(e.election_date)))
      const past  = pool
        .filter(e => isPast(safeISO(e.election_date)) && !isToday(safeISO(e.election_date)))
        .sort((a, b) => b.election_date.localeCompare(a.election_date))
      const probes = [...today, ...past].slice(0, 4)
      const found = new Set()
      for (const e of probes) {
        try {
          const { count, error } = await supabase
            .from('election_contests')
            .select('id', { count: 'exact', head: true })
            .eq('election_id', e.id)
          if (cancelled) return
          if (error) throw error
          if ((count || 0) > 0) { found.add(e.id); break }
        } catch (err) {
          console.warn('[Elections] contest probe failed, falling back to date order:', err?.message)
          break
        }
      }
      if (!cancelled) setElectionsWithContests(found)
    })()
    return () => { cancelled = true }
  }, [activeTab, elections, electionsWithContests])

  // ── Default Results election ────────────────────────────────────────────────
  //   1. one happening today   2. most recent PAST election that has contests
  //   3. next upcoming         4. most recent past (last resort)
  const resolvedResultsId = useMemo(() => {
    if (selectedResultsId) return selectedResultsId
    if (!elections.length) return null
    const pool = elections.filter(e => !isTestElection(e))
    if (!pool.length) return null

    const today = pool.find(e => isToday(safeISO(e.election_date)))
    if (today) return today.id

    const pastDesc = [...pool]
      .filter(e => isPast(safeISO(e.election_date)))
      .sort((a, b) => b.election_date.localeCompare(a.election_date))

    if (electionsWithContests?.size) {
      const withResults = pastDesc.find(e => electionsWithContests.has(e.id))
      if (withResults) return withResults.id
    }

    const nextUp = [...pool]
      .filter(e => isFuture(safeISO(e.election_date)))
      .sort((a, b) => a.election_date.localeCompare(b.election_date))[0]
    if (nextUp) return nextUp.id

    return pastDesc[0]?.id || null
  }, [selectedResultsId, elections, electionsWithContests])

  // Once elections load, push the auto-selected ID into the URL so the
  // Results tab doesn't stay blank when navigated to without ?election=.
  // replace:true — auto-selection is not a navigation the back button should
  // have to undo (it used to trap users on the Results tab).
  useEffect(() => {
    if (activeTab !== 'results') return
    if (selectedResultsId) return
    if (!elections.length) return
    if (electionsWithContests === null) return   // wait for the contest probes
    if (resolvedResultsId) {
      setSearchParams({ tab: 'results', election: resolvedResultsId }, { replace: true })
    }
  }, [activeTab, selectedResultsId, elections.length, electionsWithContests, resolvedResultsId, setSearchParams])

  // ── Election card ───────────────────────────────────────────────────────────
  const ElectionRow = ({ election }) => {
    const daysUntil  = differenceInDays(safeISO(election.election_date), new Date())
    const isUpcoming = isFuture(safeISO(election.election_date))
    const isOngoing  = isToday(safeISO(election.election_date))
    const colors     = TYPE_COLORS[election.type] || TYPE_COLORS.general

    return (
      <div className={`p-4 rounded-xl border-2 ${isUpcoming || isOngoing ? colors.border : 'border-gray-200'} ${isUpcoming || isOngoing ? 'bg-white' : 'bg-gray-50'} transition-all hover:shadow-sm`}>
        <div className="flex items-start gap-4">
          {/* Date block */}
          <div className={`${isUpcoming || isOngoing ? colors.bg : 'bg-gray-400'} text-white rounded-xl p-3 text-center min-w-[60px] flex-shrink-0`}>
            <p className="text-xs font-medium opacity-80">{format(safeISO(election.election_date), 'MMM')}</p>
            <p className="text-2xl font-bold leading-tight">{format(safeISO(election.election_date), 'd')}</p>
            <p className="text-xs opacity-80">{format(safeISO(election.election_date), 'yyyy')}</p>
          </div>

          {/* Info */}
          <div className="flex-1 min-w-0">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <h3 className={`font-bold ${isUpcoming || isOngoing ? 'text-gray-900' : 'text-gray-500'}`}>{election.name}</h3>
                <div className="flex items-center gap-2 mt-1 flex-wrap">
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${colors.light}`}>
                    {TYPE_LABELS[election.type] || election.type}
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

              {/* Action buttons */}
              <div className="flex items-center gap-1 flex-shrink-0">
                <button
                  onClick={() => goToResults(election.id)}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold transition-colors bg-brand-red/10 text-brand-red hover:bg-brand-red hover:text-white"
                  title="View results"
                >
                  <BarChart2 className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">Results</span>
                </button>
                {isAdmin && (
                  <>
                    <button onClick={() => openEdit(election)} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-700 transition-colors">
                      <Edit2 className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => { if (window.confirm('Delete this election?')) handleDelete(election.id) }}
                      disabled={deleting === election.id}
                      className="p-1.5 rounded-lg hover:bg-red-50 text-gray-400 hover:text-brand-red transition-colors"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </>
                )}
              </div>
            </div>

            {/* Fixed columns: Filing Deadline always occupies the first cell, so
                Election Date stays in the second one and the cards scan down a
                straight line. Cards with no deadline show an em dash. */}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mt-3">
              <div>
                <p className="text-xs text-gray-400 font-medium">Filing Deadline</p>
                {election.filing_deadline ? (
                  <p className={`text-sm font-semibold ${isPast(parseISO(election.filing_deadline)) ? 'text-gray-400' : 'text-brand-red'}`}>
                    {format(parseISO(election.filing_deadline), 'MMM d, yyyy')}
                  </p>
                ) : (
                  <p className="text-sm font-semibold text-gray-300">—</p>
                )}
              </div>
              <div>
                <p className="text-xs text-gray-400 font-medium">Election Date</p>
                <p className="text-sm font-semibold text-gray-900">
                  {format(safeISO(election.election_date), 'EEEE, MMMM d, yyyy')}
                </p>
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
  // Render
  // ─────────────────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      <LoadingBar loading={loading} />
      {/* ── Page header ── */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-4">
        {activeTab === 'calendar' && isAdmin && (
          <button onClick={openAdd} className="btn-primary sm:ml-auto flex items-center gap-2">
            <Plus className="w-4 h-4" /> Add election
          </button>
        )}
      </div>

      {/* Write error banner */}
      {writeError && (
        <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-700">
          <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <span className="flex-1">{writeError}</span>
          <button onClick={() => setWriteError(null)} className="text-red-400 hover:text-red-600"><X className="w-4 h-4" /></button>
        </div>
      )}

      {/* ── Tab bar ── */}
      <div className="flex gap-1 border-b border-gray-200">
        <button
          onClick={goToCalendar}
          className={`flex items-center gap-2 px-5 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px ${
            activeTab === 'calendar'
              ? 'border-brand-red text-brand-red'
              : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
          }`}
        >
          <CalendarDays className="w-4 h-4" />
          Calendar
        </button>
        <button
          onClick={() => goToResults(resolvedResultsId)}
          className={`flex items-center gap-2 px-5 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px ${
            activeTab === 'results'
              ? 'border-brand-red text-brand-red'
              : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
          }`}
        >
          <BarChart2 className="w-4 h-4" />
          Results
          {hasTodayElection(elections) && (
            <span className="relative flex h-2 w-2 ml-0.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500" />
            </span>
          )}
        </button>
      </div>

      {/* ══════════════════════════════════════════════════════════ */}
      {/* CALENDAR TAB                                             */}
      {/* ══════════════════════════════════════════════════════════ */}
      {activeTab === 'calendar' && (
        <>
          {/* Election night banner — quick jump to results */}
          {hasTodayElection(elections) && (() => {
            const todayEl = elections.find(e => isToday(safeISO(e.election_date)))
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

          {/* Year filter */}
          {years.length > 1 && (
            <div className="card py-3">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs text-gray-500 font-medium mr-1">Year:</span>
                <button
                  onClick={() => setYearFilter('')}
                  className={`text-xs px-3 py-1 rounded-full font-medium transition-colors ${!yearFilter ? 'bg-brand-red text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
                >All</button>
                {years.map(y => (
                  <button
                    key={y}
                    onClick={() => setYearFilter(String(y))}
                    className={`text-xs px-3 py-1 rounded-full font-medium transition-colors ${String(yearFilter) === String(y) ? 'bg-brand-red text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
                  >{y}</button>
                ))}
              </div>
            </div>
          )}

          {loading ? (
            <div className="flex items-center justify-center py-20">
              <div className="w-8 h-8 border-4 border-brand-red border-t-transparent rounded-full animate-spin" />
            </div>
          ) : (
            <div className="space-y-6">
              {upcoming.length > 0 && (
                <div>
                  <div className="flex items-center gap-2 mb-3">
                    <AlertCircle className="w-4 h-4 text-brand-red" />
                    <h2 className="text-base font-bold text-gray-900">Upcoming Elections</h2>
                    <span className="text-xs bg-brand-red text-white px-2 py-0.5 rounded-full">{upcoming.length}</span>
                  </div>
                  <div className="space-y-3">
                    {upcoming.map(e => <ElectionRow key={e.id} election={e} />)}
                  </div>
                </div>
              )}
              {past.length > 0 && (
                <div>
                  <div className="flex items-center gap-2 mb-3">
                    <CheckCircle className="w-4 h-4 text-gray-400" />
                    <h2 className="text-base font-bold text-gray-500">Past Elections</h2>
                    <span className="text-xs bg-gray-200 text-gray-600 px-2 py-0.5 rounded-full">{past.length}</span>
                  </div>
                  <div className="space-y-3">
                    {past.map(e => <ElectionRow key={e.id} election={e} />)}
                  </div>
                </div>
              )}
              {filtered.length === 0 && (
                <div className="text-center py-16">
                  <CalendarDays className="w-12 h-12 text-gray-200 mx-auto mb-3" />
                  <p className="text-gray-400 font-medium">No elections found</p>
                  {isAdmin && <button onClick={openAdd} className="btn-primary text-sm mt-4">Add first election</button>}
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
        fetchError && elections.length === 0 ? (
          // Honest failure beats an eternal spinner.
          <div className="text-center py-16 border-2 border-dashed border-red-200 bg-red-50/40 rounded-2xl">
            <AlertTriangle className="w-10 h-10 text-red-400 mx-auto mb-3" />
            <p className="text-gray-800 font-semibold text-sm">Couldn't load elections</p>
            <p className="text-gray-500 text-sm mt-1 max-w-sm mx-auto">{fetchError}</p>
            <button onClick={retryElections} disabled={loading} className="btn-secondary text-sm mt-4">
              {loading ? 'Retrying…' : 'Retry'}
            </button>
          </div>
        ) : loading && elections.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 gap-3">
            <div className="w-8 h-8 border-4 border-brand-red border-t-transparent rounded-full animate-spin" />
            <p className="text-gray-400 text-sm">Loading elections…</p>
          </div>
        ) : (
          <>
            {/* Refresh failed but we still have a list — say so above the board
                instead of replacing live numbers with an error page. */}
            {fetchError && (
              <div className="mb-4 flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-xl px-4 py-2.5 text-sm text-amber-800">
                <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                <span className="flex-1">Couldn't refresh the election list — showing the last known one.</span>
                <button onClick={retryElections} disabled={loading} className="text-xs font-semibold underline hover:no-underline">
                  {loading ? 'Retrying…' : 'Retry'}
                </button>
              </div>
            )}
            <ElectionResultsBoard
              elections={publicElections}
              selectedId={resolvedResultsId}
              onSelectElection={goToResults}
            />
          </>
        )
      )}

      {/* ── Add/Edit modal ── */}
      {showModal && (
        <Dialog onClose={() => setShowModal(false)}>
          <div className="fixed inset-0 bg-black/50" onClick={() => setShowModal(false)} />
          <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-lg">
            <div className="flex items-center justify-between p-6 border-b border-gray-100">
              <h2 className="text-lg font-bold text-gray-900">{editing ? 'Edit election' : 'Add election'}</h2>
              <button onClick={() => setShowModal(false)}><X className="w-5 h-5 text-gray-400" /></button>
            </div>
            <form onSubmit={handleSave} className="p-6 space-y-4">
              <div>
                <label className="label">Election Name *</label>
                <input className="input" value={form.name} onChange={e => setForm({...form, name: e.target.value})} placeholder="e.g. 2026 November General Election" required />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="label">Election Date *</label>
                  <input className="input" type="date" value={form.election_date} onChange={e => setForm({...form, election_date: e.target.value})} required />
                </div>
                <div>
                  <label className="label">Filing Deadline</label>
                  <input className="input" type="date" value={form.filing_deadline} onChange={e => setForm({...form, filing_deadline: e.target.value})} />
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="label">Type *</label>
                  <select className="input" value={form.type} onChange={e => setForm({...form, type: e.target.value})}>
                    {Object.entries(TYPE_LABELS).map(([val, label]) => <option key={val} value={val}>{label}</option>)}
                  </select>
                </div>
                <div>
                  <label className="label">Year *</label>
                  <input className="input" type="number" value={form.year} onChange={e => setForm({...form, year: e.target.value})} min={2024} max={2035} required />
                </div>
              </div>
              <div>
                <label className="label">Notes</label>
                <textarea className="input" rows={2} value={form.notes} onChange={e => setForm({...form, notes: e.target.value})} placeholder="Additional context..." />
              </div>
              <div className="flex gap-3 pt-2">
                <button type="button" onClick={() => setShowModal(false)} className="btn-secondary flex-1">Cancel</button>
                <button type="submit" className="btn-primary flex-1" disabled={saving}>
                  {saving ? 'Saving…' : (editing ? 'Save changes' : 'Add election')}
                </button>
              </div>
            </form>
          </div>
        </Dialog>
      )}
    </div>
  )
}
