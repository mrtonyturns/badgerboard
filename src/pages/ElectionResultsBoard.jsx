// ElectionResultsBoard.jsx — Embeddable live results board
// Used inside Elections.jsx Results tab.
// Accepts props instead of URL params so it works embedded in any page.
//
// Props:
//   elections       — full elections array (already loaded by parent)
//   selectedId      — id of election to display
//   onSelectElection(id) — callback when user picks a different election

import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { format, parseISO, isToday, isFuture, isPast } from 'date-fns'
import {
  BarChart2, Filter, TrendingUp, Trophy,
  Clock, MapPin, Users, ExternalLink, ChevronDown, Download, Info,
} from 'lucide-react'
import { supabase } from '../lib/supabase'
import SearchableSelect from '../components/SearchableSelect'

// ── Party colours ─────────────────────────────────────────────────────────────
const PARTY = {
  Democrat:    { bar: 'bg-blue-600',   badge: 'bg-blue-100 text-blue-800',    text: 'text-blue-700'  },
  Republican:  { bar: 'bg-red-600',    badge: 'bg-red-100 text-brand-red',     text: 'text-brand-red' },
  Independent: { bar: 'bg-purple-600', badge: 'bg-purple-100 text-purple-800', text: 'text-purple-700'},
  Libertarian: { bar: 'bg-amber-600',  badge: 'bg-amber-100 text-amber-800',   text: 'text-amber-700' },
  Nonpartisan: { bar: 'bg-gray-500',   badge: 'bg-gray-100 text-gray-700',     text: 'text-gray-600'  },
  Green:       { bar: 'bg-green-600',  badge: 'bg-green-100 text-green-800',   text: 'text-green-700' },
}
const partyStyle = (p) => PARTY[p] || PARTY.Nonpartisan

const OFFICE_LABELS = {
  statewide:   'Statewide',
  judicial:    'Courts',
  legislative: 'Legislature',
  county:      'County',
  municipal:   'Municipal',
  referendum:  'Referenda',
}
const ORDER = { statewide: 0, judicial: 1, legislative: 2, county: 3, municipal: 4, referendum: 5 }

// Whether an election type is a primary (affects "Called" display and winner framing)
const isPrimaryType = (type) => type === 'primary' || type === 'spring_primary'

const ELECTION_TYPE_LABEL = {
  primary:        { label: 'Primary', cls: 'bg-amber-100 text-amber-800' },
  spring_primary: { label: 'Spring Primary', cls: 'bg-amber-100 text-amber-800' },
  general:        { label: 'General', cls: 'bg-blue-100 text-blue-800' },
  spring_general: { label: 'Spring General', cls: 'bg-blue-100 text-blue-800' },
  special:        { label: 'Special', cls: 'bg-purple-100 text-purple-800' },
}

// ── Contest status (determination engine — Phase 1) ───────────────────────────
// election_contests.status is written by netlify/functions/_determination.js
// (or by an admin override). Badge copy and colour live here; the redesign
// token language is 9.5px/700 pills on Geist, so these are inline-styled
// rather than Tailwind text-xs.
const BADGE_FONT = "'Geist','Inter',system-ui,-apple-system,sans-serif"

const STATUS_UI = {
  waiting:          { label: 'AWAITING RESULTS',          fg: '#57534E', bg: '#F1F1EF', ring: 'border-gray-200'   },
  reporting:        { label: 'REPORTING',                 fg: '#1D4ED8', bg: '#E8EFFC', ring: 'border-blue-200'   },
  projected:        { label: 'VICTORY LIKELY — NOT FINAL', fg: '#B45309', bg: '#FDF3E3', ring: 'border-amber-300' },
  called:           { label: 'WINNER CALLED',             fg: '#15803D', bg: '#E6F5EC', ring: 'border-green-200'  },
  too_close:        { label: 'TOO CLOSE TO CALL',         fg: '#B91C1C', bg: '#FDECEC', ring: 'border-red-200'    },
  recount_possible: { label: 'RECOUNT POSSIBLE',          fg: '#C2410C', bg: '#FEF0E6', ring: 'border-orange-300' },
  certified:        { label: 'CERTIFIED',                 fg: '#14532D', bg: '#DCEEE3', ring: 'border-green-700/40' },
}

// Contests written before the status migration (or held in stale local state)
// have no status — fall back to what the rows themselves say rather than
// showing a misleading "AWAITING RESULTS".
function contestStatus(contest, results) {
  if (contest?.status && STATUS_UI[contest.status]) return contest.status
  const sorted = [...results].sort((a, b) => (b.votes || 0) - (a.votes || 0))
  const totalVotes = sorted.reduce((s, r) => s + (r.votes || 0), 0)
  if (sorted.some(r => r.declared)) return 'called'
  if (totalVotes <= 0) return 'waiting'
  if (sorted.length >= 2 && Math.abs((sorted[0]?.vote_pct || 0) - (sorted[1]?.vote_pct || 0)) < 0.5) return 'too_close'
  return 'reporting'
}

function StatusBadge({ status, contest }) {
  const ui  = STATUS_UI[status] || STATUS_UI.waiting
  const pct = contest?.precincts_total > 0
    ? Math.min(100, Math.round((contest.precincts_rptg / contest.precincts_total) * 100))
    : null
  const label = status === 'reporting' && pct != null ? `REPORTING ${pct}%` : ui.label
  return (
    <span
      title={contest?.status_source === 'admin' ? 'Set by a Badger Board editor' : 'Determined automatically from reported returns'}
      style={{
        fontSize: 9.5, fontWeight: 700, letterSpacing: '.2px', lineHeight: 1.6,
        color: ui.fg, background: ui.bg, fontFamily: BADGE_FONT,
        borderRadius: 99, padding: '2px 8px', whiteSpace: 'nowrap',
        display: 'inline-block', flex: 'none',
      }}
    >{label}</span>
  )
}

function VerifiedStamp({ at }) {
  if (!at) return null
  let when = null
  try { when = format(parseISO(at), 'MMM d, h:mm a') } catch { when = null }
  return (
    <span
      title={when ? `Checked line-by-line against the county's final unofficial numbers on ${when}` : 'Checked against official county numbers'}
      style={{
        fontSize: 9.5, fontWeight: 700, letterSpacing: '.2px', lineHeight: 1.6,
        color: '#14532D', background: 'transparent', fontFamily: BADGE_FONT,
        border: '1px solid #14532D', borderRadius: 99, padding: '1px 7px',
        whiteSpace: 'nowrap', display: 'inline-block', flex: 'none',
      }}
    >✓ VERIFIED</span>
  )
}

// "Last updated" — engine/admin stamp first, newest row timestamp as fallback.
function lastUpdatedAt(contest, results) {
  const stamps = [contest?.status_updated_at, ...results.map(r => r.updated_at)]
    .filter(Boolean)
    .map(s => { const d = new Date(s); return Number.isNaN(d.getTime()) ? null : d })
    .filter(Boolean)
  if (!stamps.length) return null
  return contest?.status_updated_at && !Number.isNaN(new Date(contest.status_updated_at).getTime())
    ? new Date(contest.status_updated_at)
    : new Date(Math.max(...stamps.map(d => d.getTime())))
}

const fmtStamp = (d) => (isToday(d) ? format(d, 'h:mm a') : format(d, 'MMM d, h:mm a'))

// ── Sub-components ────────────────────────────────────────────────────────────
function PrecinctBar({ reporting, total }) {
  const pct = total > 0 ? Math.min(100, Math.round((reporting / total) * 100)) : 0
  return (
    <div className="flex items-center gap-2 text-xs text-gray-500">
      <div className="flex-1 h-1.5 bg-gray-200 rounded-full overflow-hidden">
        <div className="h-full bg-gray-400 rounded-full transition-all duration-1000" style={{ width: `${pct}%` }} />
      </div>
      <span className="tabular-nums whitespace-nowrap">{reporting}/{total} precincts ({pct}%)</span>
    </div>
  )
}

function CandidateRow({ cand, totalVotes, isWinner, declared, isNonpartisan, leadsProjection }) {
  const style    = partyStyle(cand.party)
  // Bars scale to 100% of total votes cast — not relative to the leader
  const widthPct = totalVotes > 0 ? Math.min(100, (cand.votes / totalVotes) * 100) : 0
  // Show party badge only when the race is partisan
  const showPartyBadge = cand.party && !isNonpartisan
  const won = isWinner && declared
  return (
    <div className={`relative rounded-lg px-4 py-3 transition-all duration-700 ${
      won ? 'bg-green-50 border border-green-200 shadow-sm'
          : leadsProjection ? 'bg-amber-50 border border-amber-200 border-l-4 border-l-amber-400'
          : 'bg-white border border-gray-100'
    }`}>
      {/* Projection is NOT a call — say so, right next to the leader. */}
      {leadsProjection && (
        <p className="text-[10px] font-bold uppercase tracking-wide text-amber-700 mb-1.5" style={{ fontFamily: BADGE_FONT }}>
          Projected — not final
        </p>
      )}
      <div className="flex items-center gap-3">
        <div className="w-5 flex-shrink-0">
          {won && <Trophy className="w-4 h-4 text-green-500" />}
          {!won && leadsProjection && <TrendingUp className="w-4 h-4 text-amber-500" />}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1.5 flex-wrap">
            <span className={`font-semibold text-sm truncate ${isWinner && declared ? 'text-green-800' : 'text-gray-900'}`}>
              {cand.candidate_name}
            </span>
            {cand.incumbent && (
              <span className="text-xs bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded font-medium flex-shrink-0">Incumbent</span>
            )}
            {showPartyBadge && (
              <span className={`text-xs px-1.5 py-0.5 rounded font-medium flex-shrink-0 ${style.badge}`}>{cand.party}</span>
            )}
            {isWinner && declared && (
              <span className="text-xs bg-green-100 text-green-700 px-1.5 py-0.5 rounded font-semibold flex-shrink-0">WINNER</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <div className="flex-1 h-2.5 bg-gray-100 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-1000 ${isWinner && declared ? 'bg-green-500' : style.bar}`}
                style={{ width: `${widthPct}%` }}
              />
            </div>
            <span className="text-xs font-bold tabular-nums text-gray-700 w-12 text-right flex-shrink-0">
              {cand.vote_pct != null ? `${Number(cand.vote_pct).toFixed(1)}%` : '—'}
            </span>
          </div>
        </div>
        <div className="text-right flex-shrink-0 min-w-[76px]">
          <span className="text-sm font-bold tabular-nums text-gray-800">
            {cand.votes != null ? Number(cand.votes).toLocaleString() : '—'}
          </span>
          <span className="text-xs text-gray-400 block">votes</span>
        </div>
      </div>
    </div>
  )
}

function RaceCard({ contest, results }) {
  const [expanded, setExpanded] = useState(true)
  // Total votes across all candidates — bars scale to this so proportions are accurate
  const totalVotes = results.reduce((sum, r) => sum + (r.votes || 0), 0)
  const sorted = [...results].sort((a, b) => {
    if (a.winner && !b.winner) return -1
    if (!a.winner && b.winner) return 1
    return (b.votes || 0) - (a.votes || 0)
  })

  // ── Determination-engine status ───────────────────────────────────────────
  const status  = contestStatus(contest, results)
  const ui      = STATUS_UI[status] || STATUS_UI.waiting
  const detail  = contest.status_detail && typeof contest.status_detail === 'object' ? contest.status_detail : null
  const reason  = typeof detail?.reason === 'string' ? detail.reason : null
  const feeFree = status === 'recount_possible' && detail?.fee_free === true
  const updated = lastUpdatedAt(contest, results)
  const seats   = contest.seats || 1
  // Engine-called races flag `winner` without `declared` (declaring stays an
  // admin action) — trust either signal for the on-card winner treatment.
  const showWinner = (r) => !!r.winner && (r.declared || status === 'called' || status === 'certified')
  // Strictly by votes — a projection follows the count, never a winner flag.
  const projectedLeaders = status === 'projected'
    ? new Set([...results].sort((a, b) => (b.votes || 0) - (a.votes || 0))
        .filter(r => (r.votes || 0) > 0).slice(0, seats).map(r => r.id))
    : new Set()

  return (
    <div className={`rounded-xl border-2 overflow-hidden transition-all duration-300 ${ui.ring}`}>
      <button
        type="button"
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-start gap-3 p-4 bg-white hover:bg-gray-50 transition-colors text-left"
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="font-bold text-gray-900 text-sm">{contest.office}</h3>
            {contest.district && <span className="text-xs text-gray-500">{contest.district}</span>}
            <StatusBadge status={status} contest={contest} />
            <VerifiedStamp at={contest.verified_at} />
          </div>
          {/* What the determination engine (or the editor who overrode it) thinks */}
          {reason && (
            <p className="text-xs text-gray-400 mt-1 leading-snug">
              {reason}{feeFree ? ' (fee-free band)' : ''}
            </p>
          )}
          {contest.county && (
            <p className="text-xs text-gray-400 mt-0.5 flex items-center gap-1">
              <MapPin className="w-3 h-3" />{contest.county} County
            </p>
          )}
          {updated && (
            <p className="text-xs text-gray-400 mt-0.5 flex items-center gap-1">
              <Clock className="w-3 h-3" />
              Last updated {fmtStamp(updated)}
              {contest.status_source === 'admin' && <span className="text-gray-300">· editor override</span>}
            </p>
          )}
          {contest.precincts_total > 0 && (
            <div className="mt-2">
              <PrecinctBar reporting={contest.precincts_rptg} total={contest.precincts_total} />
            </div>
          )}
        </div>
        {!expanded && results.length > 0 && (
          <div className="flex-shrink-0 text-right">
            {sorted.slice(0, 2).map(r => (
              <p key={r.id} className="text-xs text-gray-700 tabular-nums">
                <span className={`font-semibold ${r.winner ? 'text-green-700' : ''}`}>
                  {r.candidate_name.split(' ').pop()}
                </span>{' '}
                {r.vote_pct != null ? `${Number(r.vote_pct).toFixed(1)}%` : ''}
              </p>
            ))}
          </div>
        )}
        <ChevronDown className={`w-4 h-4 text-gray-400 flex-shrink-0 mt-0.5 transition-transform ${expanded ? 'rotate-180' : ''}`} />
      </button>
      {expanded && (
        <div className="bg-gray-50 px-4 pb-4 space-y-2">
          {results.length === 0 ? (
            <p className="text-center text-xs text-gray-400 py-4">Awaiting first returns…</p>
          ) : sorted.map(cand => (
            <CandidateRow
              key={cand.id}
              cand={cand}
              totalVotes={totalVotes}
              isWinner={showWinner(cand)}
              declared={showWinner(cand)}
              leadsProjection={projectedLeaders.has(cand.id)}
              isNonpartisan={contest.is_nonpartisan}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function LiveDot() {
  return (
    <span className="relative flex items-center gap-1.5">
      <span className="relative flex h-2.5 w-2.5">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
        <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-red-500" />
      </span>
      <span className="text-xs font-bold text-red-600 tracking-wide uppercase">Live</span>
    </span>
  )
}

// ── Main board component ──────────────────────────────────────────────────────
export default function ElectionResultsBoard({ elections, selectedId, onSelectElection }) {
  // Guard against "null"/"undefined" strings leaking in from URL params
  const cleanId    = (selectedId && selectedId !== 'null' && selectedId !== 'undefined') ? selectedId : null
  const election   = elections.find(e => e.id === cleanId) || null
  const electionId = election?.id || null

  const [contests,     setContests]     = useState([])
  const [resultsMap,   setResultsMap]   = useState({})
  const [loading,      setLoading]      = useState(false)
  const [lastSync,     setLastSync]     = useState(null)
  const [officeFilter, setOfficeFilter] = useState('all')
  const [countyFilter, setCountyFilter] = useState('all')
  const [pulse,        setPulse]        = useState(false)
  const realtimeRef = useRef(null)

  // ── Load contests + results ─────────────────────────────────────────────────
  const loadData = useCallback(async (id, quiet = false) => {
    if (!id) return
    if (!quiet) setLoading(true)
    try {
      // select('*') deliberately — it already carries the Phase 1 status
      // columns (status, status_source, status_updated_at, status_detail,
      // verified_at) added by migration 20260810000002.
      const { data: contestRows } = await supabase
        .from('election_contests')
        .select('*')
        .eq('election_id', id)
        .order('office_type')
        .order('office')

      setContests(contestRows || [])
      if (!contestRows?.length) { setLoading(false); return }

      const { data: resultRows } = await supabase
        .from('election_results')
        .select('*')
        .in('contest_id', contestRows.map(c => c.id))
        .order('votes', { ascending: false })

      const map = {}
      for (const r of resultRows || []) {
        if (!map[r.contest_id]) map[r.contest_id] = []
        map[r.contest_id].push(r)
      }
      setResultsMap(map)
      setLastSync(new Date())
    } catch (err) {
      console.error('[ElectionResultsBoard] load error:', err)
    }
    if (!quiet) setLoading(false)
  }, [])

  useEffect(() => {
    setContests([])
    setResultsMap({})
    setOfficeFilter('all')
    setCountyFilter('all')
    if (electionId) loadData(electionId)
  }, [electionId, loadData])

  // ── Realtime ────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!electionId) return
    if (realtimeRef.current) supabase.removeChannel(realtimeRef.current)

    const channel = supabase
      .channel(`board-${electionId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'election_results' }, (payload) => {
        const row = payload.new || payload.old
        if (!row?.contest_id) return
        setPulse(true); setTimeout(() => setPulse(false), 2000)
        setLastSync(new Date())
        setResultsMap(prev => {
          const cid      = row.contest_id
          const existing = prev[cid] || []
          if (payload.eventType === 'DELETE') return { ...prev, [cid]: existing.filter(r => r.id !== row.id) }
          const idx = existing.findIndex(r => r.id === row.id)
          const upd = idx >= 0 ? existing.map((r, i) => i === idx ? payload.new : r) : [...existing, payload.new]
          return { ...prev, [cid]: upd.sort((a, b) => (b.votes || 0) - (a.votes || 0)) }
        })
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'election_contests' }, (payload) => {
        if (!payload?.new?.id) return
        // Merge rather than replace: the payload carries the status columns
        // (status, status_source, status_updated_at, status_detail,
        // verified_at) so a determination-engine write lands on the board
        // instantly, and anything the replication payload happens to omit
        // keeps its loaded value instead of going undefined.
        setContests(prev => prev.map(c => c.id === payload.new.id ? { ...c, ...payload.new } : c))
        setLastSync(new Date())
      })
      .subscribe()

    realtimeRef.current = channel

    // Polling fallback: realtime requires the tables to be in the project's
    // realtime publication — if that's ever disabled, this keeps the board live.
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') loadData(electionId, true)
    }, 60000)

    return () => { supabase.removeChannel(channel); clearInterval(interval) }
  }, [electionId, loadData])

  // ── CSV export ──────────────────────────────────────────────────────────────
  const exportCSV = () => {
    if (!election) return
    const rows = [['Race', 'District', 'Candidate', 'Party', 'Votes', 'Pct', 'Winner', 'Precincts Rptg', 'Precincts Total', 'Status', 'Status Source', 'Status Updated']]
    for (const c of contests) {
      const st = contestStatus(c, resultsMap[c.id] || [])
      for (const r of (resultsMap[c.id] || [])) {
        rows.push([c.office, c.district || '', r.candidate_name, r.party || '', r.votes, r.vote_pct, r.winner ? 'Yes' : 'No', c.precincts_rptg, c.precincts_total, st, c.status_source || 'auto', c.status_updated_at || ''])
      }
    }
    const csv  = rows.map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob)
    a.download = `${(election.name || 'results').replace(/\s+/g, '_')}_results.csv`
    a.click()
  }

  // ── Filters ─────────────────────────────────────────────────────────────────
  const officeTypes = useMemo(() => [...new Set(contests.map(c => c.office_type).filter(Boolean))].sort(), [contests])
  const counties    = useMemo(() => [...new Set(contests.map(c => c.county).filter(Boolean))].sort(), [contests])

  const filtered = useMemo(() => contests.filter(c => {
    if (officeFilter !== 'all' && c.office_type !== officeFilter) return false
    if (countyFilter !== 'all' && c.county !== countyFilter)       return false
    return true
  }), [contests, officeFilter, countyFilter])

  const sorted = [...filtered].sort(
    (a, b) => (ORDER[a.office_type] ?? 9) - (ORDER[b.office_type] ?? 9) || a.office.localeCompare(b.office)
  )

  const grouped = useMemo(() => {
    const g = {}
    for (const c of sorted) {
      const k = c.office_type || 'other'
      if (!g[k]) g[k] = []
      g[k].push(c)
    }
    return g
  }, [sorted])

  const isLive    = election ? isToday(parseISO(election.election_date)) && contests.length > 0 : false
  const isPrimary = election ? isPrimaryType(election.type) : false

  // Past elections with results (for the election picker tabs)
  const electionsWithPast = elections
    .filter(e => isPast(parseISO(e.election_date)) || isToday(parseISO(e.election_date)))
    .sort((a, b) => b.election_date.localeCompare(a.election_date))
    .slice(0, 8)

  // ─────────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-5">
      {/* ── Election header ── */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-lg font-bold text-gray-900">
              {election ? election.name : 'Election Results'}
            </h2>
            {election?.type && ELECTION_TYPE_LABEL[election.type] && (
              <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${ELECTION_TYPE_LABEL[election.type].cls}`}>
                {ELECTION_TYPE_LABEL[election.type].label}
              </span>
            )}
            {isLive && <LiveDot />}
          </div>
          {election && (
            <p className="text-sm text-gray-400 mt-0.5">
              {format(parseISO(election.election_date), 'EEEE, MMMM d, yyyy')}
              {isPrimaryType(election.type) && (
                <span className="ml-2 text-amber-600 font-medium">· Top candidates advance to General</span>
              )}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {lastSync && (
            <span className="text-xs text-gray-400 flex items-center gap-1">
              <Clock className="w-3 h-3" />
              Updated {format(lastSync, 'h:mm:ss a')}
            </span>
          )}
          {contests.length > 0 && (
            <button onClick={exportCSV} className="btn-secondary text-xs flex items-center gap-1.5 py-1.5 px-3">
              <Download className="w-3.5 h-3.5" /> CSV
            </button>
          )}
        </div>
      </div>

      {/* ── Election selector tabs ── */}
      {electionsWithPast.length > 1 && (
        <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-hide -mx-1 px-1">
          {electionsWithPast.map(e => (
            <button
              key={e.id}
              onClick={() => onSelectElection(e.id)}
              className={`flex-shrink-0 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                cleanId === e.id
                  ? 'bg-brand-red text-white shadow-sm'
                  : 'bg-white border border-gray-200 text-gray-600 hover:border-brand-red/40 hover:text-brand-red'
              }`}
            >
              {e.name}
              <span className="ml-1.5 opacity-70 font-normal">
                {format(parseISO(e.election_date), 'M/d/yy')}
              </span>
            </button>
          ))}
        </div>
      )}

      {/* ── Filters ── */}
      {(officeTypes.length > 1 || counties.length > 0) && (
        <div className="flex items-center gap-3 flex-wrap">
          <Filter className="w-4 h-4 text-gray-400 flex-shrink-0" />
          {officeTypes.length > 1 && (
            <div className="flex gap-1.5 flex-wrap">
              {['all', ...officeTypes].map(type => (
                <button
                  key={type}
                  onClick={() => setOfficeFilter(type)}
                  className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                    officeFilter === type ? 'bg-brand-navy text-white' : 'bg-white border border-gray-200 text-gray-600 hover:border-gray-300'
                  }`}
                >
                  {type === 'all' ? 'All Races' : OFFICE_LABELS[type] || type}
                </button>
              ))}
            </div>
          )}
          {counties.length > 0 && (
            <SearchableSelect
              className="w-44"
              buttonClassName="text-xs py-1.5"
              value={countyFilter}
              onChange={setCountyFilter}
              options={[{ value: 'all', label: 'All Counties' }, ...counties.map(c => ({ value: c, label: `${c} County` }))]}
              placeholder="All Counties"
              searchPlaceholder="Search counties…" />
          )}
        </div>
      )}

      {/* ── Content ── */}
      {loading ? (
        <div className="flex flex-col items-center justify-center py-20 gap-3">
          <div className="w-10 h-10 border-4 border-brand-red border-t-transparent rounded-full animate-spin" />
          <p className="text-gray-400 text-sm">Loading results…</p>
        </div>
      ) : !election ? (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <BarChart2 className="w-12 h-12 text-gray-200 mb-3" />
          {elections.length === 0 ? (
            <>
              <div className="w-7 h-7 border-4 border-brand-red border-t-transparent rounded-full animate-spin mb-3" />
              <p className="text-gray-400 text-sm">Loading elections…</p>
            </>
          ) : (
            <>
              <p className="text-gray-500 font-semibold">No election selected</p>
              <p className="text-gray-400 text-sm mt-1">Pick an election from the Calendar tab to view its results.</p>
            </>
          )}
        </div>
      ) : contests.length === 0 ? (
        <div className="space-y-5">
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <div className="w-16 h-16 rounded-full bg-gray-100 flex items-center justify-center mb-4">
              <BarChart2 className="w-8 h-8 text-gray-300" />
            </div>
            <h3 className="text-gray-700 font-semibold text-lg">No results yet</h3>
            <p className="text-gray-400 text-sm mt-2 max-w-sm">
              {isFuture(parseISO(election.election_date))
                ? 'Results will appear here once staff begins entering them after polls close on election night.'
                : 'No results have been entered for this election yet. Check back on election night.'}
            </p>
          </div>
          <div className="p-4 bg-blue-50 border border-blue-200 rounded-xl flex items-start gap-3">
            <Info className="w-4 h-4 text-blue-500 flex-shrink-0 mt-0.5" />
            <p className="text-sm text-blue-700">
              Results are entered by Badger Board staff on election night and update here in real time — no page refresh needed.
            </p>
          </div>
        </div>
      ) : (
        <div className="space-y-6">
          {/* Summary stats */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="bg-white rounded-xl border border-gray-200 p-3 text-center">
              <p className="text-2xl font-bold text-gray-900">{contests.length}</p>
              <p className="text-xs text-gray-500 mt-0.5">Total Races</p>
            </div>
            {isPrimary ? (
              <div className="bg-white rounded-xl border border-gray-200 p-3 text-center">
                <p className="text-2xl font-bold text-amber-600">
                  {contests.filter(c => c.precincts_rptg > 0 || (resultsMap[c.id] || []).some(r => r.votes > 0)).length}
                </p>
                <p className="text-xs text-gray-500 mt-0.5">Races Reporting</p>
              </div>
            ) : (
              <div className="bg-white rounded-xl border border-gray-200 p-3 text-center">
                <p className="text-2xl font-bold text-green-600">
                  {contests.filter(c => ['called', 'certified'].includes(contestStatus(c, resultsMap[c.id] || []))).length}
                </p>
                <p className="text-xs text-gray-500 mt-0.5">Called</p>
              </div>
            )}
            <div className="bg-white rounded-xl border border-gray-200 p-3 text-center">
              <p className="text-2xl font-bold text-gray-900">
                {Math.round(
                  contests.reduce((s, c) => c.precincts_total ? s + (c.precincts_rptg / c.precincts_total) * 100 : s, 0) /
                  Math.max(1, contests.filter(c => c.precincts_total > 0).length)
                )}%
              </p>
              <p className="text-xs text-gray-500 mt-0.5">Avg Reporting</p>
            </div>
            <div className="bg-white rounded-xl border border-gray-200 p-3 text-center">
              <p className="text-xl font-bold text-gray-900 tabular-nums">
                {Object.values(resultsMap).reduce((s, arr) => s + arr.reduce((x, r) => x + (r.votes || 0), 0), 0).toLocaleString()}
              </p>
              <p className="text-xs text-gray-500 mt-0.5">Total Votes</p>
            </div>
          </div>

          {/* Too close / recount banner — driven by the determination engine */}
          {(() => {
            const close   = sorted.filter(c => contestStatus(c, resultsMap[c.id] || []) === 'too_close')
            const recount = sorted.filter(c => contestStatus(c, resultsMap[c.id] || []) === 'recount_possible')
            if (!close.length && !recount.length) return null
            return (
              <div className="space-y-2">
                {close.length > 0 && (
                  <div className="p-3 bg-red-50 border border-red-200 rounded-xl flex items-center gap-2">
                    <TrendingUp className="w-4 h-4 text-red-600 flex-shrink-0" />
                    <span className="text-sm text-red-800 font-medium">
                      {close.length} race{close.length !== 1 ? 's' : ''} too close to call — margin under 0.5% with nearly all precincts in
                    </span>
                  </div>
                )}
                {recount.length > 0 && (
                  <div className="p-3 bg-orange-50 border border-orange-200 rounded-xl flex items-center gap-2">
                    <Info className="w-4 h-4 text-orange-600 flex-shrink-0" />
                    <span className="text-sm text-orange-800 font-medium">
                      {recount.length} race{recount.length !== 1 ? 's' : ''} finished inside Wisconsin's 1% recount-petition window
                    </span>
                  </div>
                )}
              </div>
            )
          })()}

          {/* Race sections */}
          {Object.entries(grouped).map(([type, typeContests]) => (
            <div key={type} className="space-y-3">
              <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wider flex items-center gap-2">
                {type === 'statewide'   && <TrendingUp className="w-3.5 h-3.5" />}
                {type === 'judicial'    && <Users className="w-3.5 h-3.5" />}
                {type === 'legislative' && <BarChart2 className="w-3.5 h-3.5" />}
                {(type === 'county' || type === 'municipal') && <MapPin className="w-3.5 h-3.5" />}
                {OFFICE_LABELS[type] || type}
                <span className="font-normal text-gray-400 normal-case tracking-normal">({typeContests.length})</span>
              </h3>
              <div className="grid sm:grid-cols-1 lg:grid-cols-2 gap-3">
                {typeContests.map(c => (
                  <RaceCard key={c.id} contest={c} results={resultsMap[c.id] || []} />
                ))}
              </div>
            </div>
          ))}

          {/* Attribution */}
          <div className="flex items-center gap-2 text-xs text-gray-400 pt-2 border-t border-gray-100">
            <ExternalLink className="w-3 h-3" />
            Results compiled by Badger Board staff from official{' '}
            <a href="https://elections.wi.gov" target="_blank" rel="noopener noreferrer" className="underline hover:text-brand-red transition-colors">
              Wisconsin Elections Commission
            </a>
            {' '}reporting. Updates appear in real time on election night.
          </div>
        </div>
      )}
    </div>
  )
}
