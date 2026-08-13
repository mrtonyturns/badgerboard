// DistrictElectionHistory.jsx — office history section for DistrictDashboard.
// Renders real election_contests/election_results rows (last ~3 cycles,
// generals + primaries) as color-coded, segmented vote-share bars. Falls back
// to district_intel `history` (AI-researched officeholder list) only for
// years the real results don't cover — and even then, name + party + years
// only, never the AI-written biography/description.
//
// Data shapes this file depends on (see DistrictDashboard.jsx for the actual
// Supabase queries):
//   contests: [{ id, office, district, seats,
//                 election: { id, name, election_date, type },
//                 results: [{ candidate_name, party, votes, vote_pct, winner, declared }] }]
//     election.type ∈ 'general' | 'spring_general' | 'primary' | 'spring_primary' | 'special'
//   history: { entries: [{ year, election, name, party, vote_pct, opponent, result, current }],
//              people: [{ name, party, served, bio }], note }
//     (from netlify/functions/research-district-history.js — bios are
//     intentionally never read here)

import React from 'react'
import { partyGroup, partyAbbrev, partyColorHex } from '../lib/party'

const GENERAL_TYPES = new Set(['general', 'spring_general', 'special'])
const PRIMARY_TYPES = new Set(['primary', 'spring_primary'])

// Base party families — same party sharing a race gets a distinguishable shade.
// Keyed by partyGroup() so 'Democrat', 'Democratic' and 'DEM' share one family.
const PARTY_FAMILY = {
  R: ['#B91C1C', '#DC2626', '#EF4444', '#F87171'],
  D: ['#1D4ED8', '#2563EB', '#3B82F6', '#60A5FA'],
  I: ['#7C3AED', '#9333EA', '#A855F7', '#C084FC'],
  N: ['#64748B', '#475569', '#334155', '#94A3B8'],
  O: ['#64748B', '#94A3B8', '#475569', '#CBD5E1'],
}

function colorForCandidate(party, idxInParty) {
  const fam = PARTY_FAMILY[partyGroup(party)] || PARTY_FAMILY.O
  return fam[Math.min(idxInParty, fam.length - 1)]
}

// Assign a stable, distinguishable color to every result in a contest —
// grouped by party so same-party candidates get different shades.
function colorizeResults(results) {
  const byParty = {}
  ;(results || []).forEach(r => {
    const p = partyGroup(r.party)
    byParty[p] = byParty[p] || []
    byParty[p].push(r)
  })
  Object.values(byParty).forEach(list => list.sort((a, b) => (b.votes || 0) - (a.votes || 0)))
  const colorMap = new Map()
  Object.entries(byParty).forEach(([party, list]) => {
    list.forEach((r, i) => colorMap.set(r, colorForCandidate(party, i)))
  })
  return (results || []).map(r => ({ ...r, _color: colorMap.get(r) }))
}

const totalVotes = (c) => (c.results || []).reduce((s, r) => s + (Number(r.votes) || 0), 0)

// Group contests into election cycles (by year), keeping the best general
// contest and every primary contest that has results.
function buildCycles(contests, maxCycles = 3) {
  const byYear = new Map()
  ;(contests || []).forEach(c => {
    const ed = c.election?.election_date
    if (!ed) return
    if (!(c.results || []).length) return
    const year = new Date(ed).getFullYear()
    if (Number.isNaN(year)) return
    if (!byYear.has(year)) byYear.set(year, { year, general: null, primaries: [] })
    const bucket = byYear.get(year)
    const type = c.election?.type
    if (GENERAL_TYPES.has(type)) {
      if (!bucket.general || totalVotes(c) > totalVotes(bucket.general)) bucket.general = c
    } else if (PRIMARY_TYPES.has(type)) {
      bucket.primaries.push(c)
    } else if (!type) {
      // Unknown election type (older rows) — treat as general so it isn't lost.
      if (!bucket.general || totalVotes(c) > totalVotes(bucket.general)) bucket.general = c
    }
  })
  return [...byYear.values()]
    .filter(b => b.general || b.primaries.length)
    .sort((a, b) => b.year - a.year)
    .slice(0, maxCycles)
}

// ── segmented bar + legend ────────────────────────────────────────────────
const S = {
  sectionLabel: { fontSize: 10, fontWeight: 800, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6 },
  cycleYear: { fontSize: 12.5, fontWeight: 900, color: '#0F172A', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 },
  raceLabel: { fontSize: 10.5, fontWeight: 700, color: '#64748B', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4, marginTop: 10 },
  legendRow: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, fontWeight: 600, color: '#334155', padding: '2px 0' },
  legendDot: (c) => ({ width: 9, height: 9, borderRadius: 3, background: c, flexShrink: 0 }),
  legendName: { fontWeight: 800, color: '#0F172A' },
  legendStat: { marginLeft: 'auto', fontSize: 11, fontWeight: 700, color: '#64748B', whiteSpace: 'nowrap' },
}

function SegmentedBar({ results }) {
  const colored = colorizeResults(results)
  const tot = colored.reduce((s, r) => s + (Number(r.votes) || 0), 0)
  const withPct = colored.map(r => ({
    ...r,
    _pct: r.vote_pct != null ? Number(r.vote_pct) : (tot ? (Number(r.votes) || 0) / tot * 100 : 0),
  })).sort((a, b) => b._pct - a._pct)

  return (
    <>
      <div style={{ display: 'flex', height: 17, borderRadius: 8, overflow: 'hidden', width: '100%', background: '#F1F5F9' }}>
        {withPct.map((r, i) => (
          <div key={r.candidate_name + i} title={`${r.candidate_name} (${r.party || '—'}) — ${r._pct.toFixed(1)}%`}
            style={{
              width: `${Math.max(r._pct, 0.6)}%`, background: r._color,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              borderRight: i < withPct.length - 1 ? '1px solid #fff' : 'none',
              transition: 'width .6s ease', minWidth: 2,
            }}>
            {r._pct >= 12 && <span style={{ fontSize: 9.5, fontWeight: 800, color: '#fff' }}>{r._pct.toFixed(0)}%</span>}
          </div>
        ))}
      </div>
      <div style={{ marginTop: 5 }}>
        {withPct.map((r, i) => (
          <div key={r.candidate_name + i} style={S.legendRow}>
            <span style={S.legendDot(r._color)} />
            <span style={S.legendName}>{r.candidate_name}</span>
            <span style={{ color: '#94A3B8', fontWeight: 700 }}>({partyAbbrev(r.party)})</span>
            {r.winner && <span style={{ fontSize: 9, fontWeight: 800, color: '#15803D', background: '#DCFCE7', borderRadius: 99, padding: '1px 6px' }}>WON</span>}
            <span style={S.legendStat}>{r._pct.toFixed(1)}% · {(Number(r.votes) || 0).toLocaleString()} votes</span>
          </div>
        ))}
      </div>
    </>
  )
}

function CycleBlock({ cycle }) {
  return (
    <div style={{ marginBottom: 14, paddingBottom: 12, borderBottom: '1.5px solid #F1F5F9' }}>
      <div style={S.cycleYear}>{cycle.year}</div>
      {cycle.general && (
        <div>
          <div style={S.raceLabel}>General{cycle.general.office ? ` — ${cycle.general.office}` : ''}</div>
          <SegmentedBar results={cycle.general.results} />
        </div>
      )}
      {cycle.primaries.map(p => {
        // A single contest row can hold every party's primary ballot together
        // (WEC reports them jointly) — split by party so each gets its own bar.
        // Grouped by party FAMILY so 'Democrat' and 'Democratic' rows stay on one
        // ballot; the label keeps whatever spelling the rows actually carry.
        const byParty = {}
        ;(p.results || []).forEach(r => {
          const key = partyGroup(r.party)
          if (!byParty[key]) byParty[key] = { label: r.party || 'Other', results: [] }
          byParty[key].results.push(r)
        })
        return Object.entries(byParty).map(([key, grp]) => (
          <div key={p.id + key}>
            <div style={S.raceLabel}>{grp.label} Primary</div>
            <SegmentedBar results={grp.results} />
          </div>
        ))
      })}
    </div>
  )
}

// ── compact fallback row for AI-researched history not covered by real results ──
function HistoryRow({ entry, onProfiler }) {
  return (
    <div onClick={() => onProfiler && onProfiler(entry.name)}
      style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '7px 0', cursor: onProfiler ? 'pointer' : 'default' }}>
      <div style={{ width: 8, height: 8, borderRadius: 3, background: partyColorHex(entry.party), flexShrink: 0 }} />
      <div style={{ fontSize: 12.5, fontWeight: 800, color: '#0F172A' }}>{entry.name}</div>
      <span style={{ fontSize: 10, fontWeight: 700, color: '#94A3B8' }}>{entry.party}</span>
      <span style={{ marginLeft: 'auto', fontSize: 10.5, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase' }}>
        {entry.year}{entry.vote_pct != null ? ` · ${entry.vote_pct}%` : ''}
      </span>
    </div>
  )
}

export default function DistrictElectionHistory({ contests, history, onProfiler }) {
  const cycles = buildCycles(contests)
  const coveredYears = new Set(cycles.map(c => c.year))
  const extraEntries = (history?.entries || []).filter(e => e.year && !coveredYears.has(e.year))

  if (!cycles.length && !extraEntries.length) return null

  return (
    <div>
      {cycles.length > 0 && (
        <div style={{ marginBottom: extraEntries.length ? 10 : 0 }}>
          <div style={S.sectionLabel}>Election results</div>
          {cycles.map(c => <CycleBlock key={c.year} cycle={c} />)}
        </div>
      )}
      {extraEntries.length > 0 && (
        <div>
          <div style={S.sectionLabel}>Earlier officeholders (AI-researched)</div>
          {extraEntries.map(e => (
            <HistoryRow key={`${e.year}-${e.name}`} entry={e} onProfiler={onProfiler ? (name) => onProfiler(name, null) : null} />
          ))}
        </div>
      )}
    </div>
  )
}
