// CandidateDashboard.jsx — the dashboard shown to candidate-family plans
// (scout / c_monitor / c_active / c_campaign). One candidate running their own
// campaign; the monitored profile may be themselves OR an opponent.
//
// Every number on this page comes from a real row. Where the app has no source
// for a value the card renders the honest empty state from SPEC.md rule 4
// instead of a zero, a dash, or a fabricated metric.

import React, { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { format, startOfWeek, addWeeks } from 'date-fns'
import LoadingBar from '../../components/LoadingBar'
import { useAuth } from '../../contexts/AuthContext'
import {
  supabase, getCandidates, getMilestones, getElections,
  getDossiers, getVoterLists, updateMilestone, logActivity,
} from '../../lib/supabase'
import { pointInGeometry } from '../../lib/geo'
import {
  getUserPlan, getPlanConfig, getEffectiveProfileLimit,
  getBankedProfileCredits, hasFeature, monitoringUnlockLabel,
} from '../../lib/tiers'
import { PHASE_MAP, MONITORING_SERIES } from '../../lib/campaignEnums'
import {
  T, Card, CardHead, DashboardShell, DashboardHeader, NextRaceBlock,
  StatStrip, StatCell, WeeklyChip, OverdueChip, PartyPill, DigestItems,
  MilestoneRow, ElectionRows, EmptyState, CtaButton, TextLink, StatRow,
  DistrictHeatMap, HeatLegend, LivePulseDot,
  safeISO, fmtInt, fmtDate, daysUntil, isUpcoming, autoStatus, isMonitored,
  monitoringSlots, nextMonday, loadPopPoints, loadCountyPres,
  resolveDistrict, loadBoundary, countVotersInDistrict,
  weekDigestOf, latestDigestOf,
} from './shared'

// ── self-candidate resolution ────────────────────────────────────────────────
// There is no stored field anywhere in the schema that says "this candidate
// record is me" (verified: no onboarding / my_candidate / is_self column). This
// heuristic picks the most likely one and the UI exposes an override that is
// persisted to user_metadata (a display preference — entitlements live in
// app_metadata and are untouched).
export function resolveSelfCandidate(user, candidates) {
  if (!candidates?.length) return null
  const pinned = user?.user_metadata?.self_candidate_id
  if (pinned) {
    const hit = candidates.find(c => c.id === pinned)
    if (hit) return hit
  }
  const m = user?.user_metadata || {}
  const full = [m.first_name, m.last_name].filter(Boolean).join(' ').trim() || m.display_name || ''
  if (full) {
    const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z ]/g, '').trim()
    const hit = candidates.find(c => norm(c.name) === norm(full))
    if (hit) return hit
  }
  if (candidates.length === 1) return candidates[0]
  const dated = candidates
    .filter(c => c.election?.election_date)
    .sort((a, b) => String(a.election.election_date).localeCompare(String(b.election.election_date)))
  return dated[0] || candidates[0]
}

// ── monitoring activity chart ────────────────────────────────────────────────
// Stacked bars: digest items per week by category, last 8 weeks. Rule 4 — a
// week with no digest gets no bar at all rather than a zero-height one.
function MonitoringActivity({ weeks }) {
  const withData = weeks.filter(w => w.total > 0)
  if (!withData.length) {
    return (
      <EmptyState
        title="No weekly digests yet"
        body="Monitoring activity charts the items in each weekly digest. The first bar appears after the first Monday refresh."
      />
    )
  }
  const present = MONITORING_SERIES.filter(s => weeks.some(w => (w.counts[s.key] || 0) > 0))
  const maxTotal = Math.max(1, ...weeks.map(w => w.total))
  const PX   = 118 / maxTotal   // px per item, so the tallest bar fills the plot
  const BASE = 138
  return (
    <div>
      <svg viewBox="0 0 560 160" style={{ width: '100%', height: 'auto', display: 'block' }}>
        <line x1="4" y1={BASE} x2="556" y2={BASE} stroke={T.border} strokeWidth="1" />
        <line x1="4" y1="88" x2="556" y2="88" stroke="#F5F5F3" strokeWidth="1" />
        <line x1="4" y1="38" x2="556" y2="38" stroke="#F5F5F3" strokeWidth="1" />
        {weeks.map((w, i) => {
          const x = 14 + i * 68
          let y = BASE
          return (
            <g key={w.key}>
              {present.map(s => {
                const n = w.counts[s.key] || 0
                if (!n) return null
                const h = Math.max(2, n * PX)
                y -= h
                return (
                  <rect key={s.key} x={x} y={y} width="36" height={h} rx="2" fill={s.hex}>
                    <title>{`Week of ${w.label} — ${n} ${s.label}`}</title>
                  </rect>
                )
              })}
              <text x={x + 18} y={BASE + 15} textAnchor="middle" fontSize="9.5" fill={T.faint}>
                {w.label}
              </text>
            </g>
          )
        })}
      </svg>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 10 }}>
        {present.map(s => (
          <span key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10.5, color: T.muted }}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: s.hex, display: 'inline-block' }} />
            {s.label}
          </span>
        ))}
      </div>
    </div>
  )
}

// ── game plan burn-up ────────────────────────────────────────────────────────
// Cumulative completed milestones vs. a dashed "all N by election day" target.
// Completion time is `updated_at` on rows whose status is complete/skipped —
// the schema stores no dedicated completed_at, so this is a stated proxy.
function BurnUp({ points, total, targetLabel }) {
  if (!points?.length || !total) return null
  const W = 560, BASE = 112, TOP = 10, L = 4, R = 556
  const span = points.length > 1 ? (R - L) / (points.length - 1) : 0
  const xy = points.map((v, i) => [L + i * span, BASE - (v / total) * (BASE - TOP)])
  const path = xy.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
  const last = xy[xy.length - 1]
  return (
    <svg viewBox="0 0 560 130" style={{ width: '100%', height: 'auto', display: 'block', marginBottom: 4 }}>
      <defs>
        <linearGradient id="gradGP" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="rgba(185,28,28,.16)" />
          <stop offset="100%" stopColor="rgba(185,28,28,0)" />
        </linearGradient>
      </defs>
      <line x1={L} y1={BASE} x2={R} y2={BASE} stroke={T.border} strokeWidth="1" />
      <polyline points={`${L},${BASE} ${R},${TOP}`} fill="none" stroke="#D6D6D2" strokeWidth="1.5" strokeDasharray="4 5" />
      <polygon points={`${L},${BASE} ${path} ${last[0].toFixed(1)},${BASE}`} fill="url(#gradGP)" />
      <polyline points={path} fill="none" stroke={T.redHot} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={last[0]} cy={last[1]} r="4" fill={T.redHot} />
      <text x="548" y="22" textAnchor="end" fontSize="10" fill={T.faint}>{targetLabel}</text>
    </svg>
  )
}

// ── election history ─────────────────────────────────────────────────────────
// Real 2016 / 2020 / 2024 county presidential results (wi-county-pres.json),
// weighted by the district's population mix. Labelled as an estimate because it
// is county data apportioned to the district, not precinct-level district data.
function ElectionHistory({ rows }) {
  if (!rows?.length) return null
  return (
    <div style={{ marginTop: 14, paddingTop: 14, borderTop: `1px solid ${T.divider}` }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: T.ink3 }}>Election history</div>
      <div style={{ fontSize: 11, color: T.faint, marginTop: 2, marginBottom: 10 }}>
        Two-party share in your district
      </div>
      {rows.map(r => (
        <div key={r.year} style={{ marginBottom: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 4 }}>
            <span style={{ fontWeight: 600 }}>{r.year} President</span>
            <span style={{ color: T.faint }}>R {r.r}% · D {r.d}%</span>
          </div>
          <div style={{ height: 8, borderRadius: 99, background: '#F1F1EF', overflow: 'hidden', display: 'flex' }}>
            <div style={{ width: `${r.r}%`, background: T.redHot }} />
            <div style={{ width: `${r.d}%`, background: '#2563EB' }} />
          </div>
        </div>
      ))}
      <div style={{ fontSize: 10, color: T.faint, marginTop: 6, lineHeight: 1.5 }}>
        Estimated from county results apportioned by the share of district population in each county.
      </div>
    </div>
  )
}

// ── quick actions ────────────────────────────────────────────────────────────
function QuickAction({ icon, tint, ink, label, sub, onClick }) {
  return (
    <button
      type="button"
      className="bb-row"
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: 10, width: '100%',
        padding: 8, margin: '0 -8px', borderRadius: 9, border: 0,
        background: 'transparent', cursor: 'pointer', textAlign: 'left',
        fontFamily: 'inherit',
      }}
    >
      <span style={{
        width: 30, height: 30, borderRadius: 8, background: tint, color: ink,
        display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13,
        flexShrink: 0,
      }}>{icon}</span>
      <span style={{ minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 12.5, fontWeight: 600 }}>{label}</span>
        {sub && <span style={{ display: 'block', fontSize: 10.5, color: T.faint, marginTop: 1 }}>{sub}</span>}
      </span>
    </button>
  )
}

// ── page ─────────────────────────────────────────────────────────────────────

export default function CandidateDashboard() {
  const { user } = useAuth()
  const nav = useNavigate()
  const plan = getUserPlan(user)
  const planCfg = getPlanConfig(plan)

  const [loading, setLoading]       = useState(true)
  const [candidates, setCandidates] = useState([])
  const [milestones, setMilestones] = useState([])
  const [elections, setElections]   = useState([])
  const [dossiers, setDossiers]     = useState([])
  const [voterLists, setVoterLists] = useState([])
  const [profilesUsed, setProfilesUsed] = useState(null)
  const [busyId, setBusyId]         = useState(null)
  const [picking, setPicking]       = useState(false)
  // Authoritative count of THIS USER's candidates with monitoring switched on.
  // null = not answered yet (fall back to the client-side derivation below).
  const [monitoredCount, setMonitoredCount] = useState(null)

  // geodata
  const [popPoints, setPopPoints] = useState(null)
  const [pres, setPres]           = useState(null)
  const [boundary, setBoundary]   = useState(undefined) // undefined = loading

  useEffect(() => {
    let dead = false
    ;(async () => {
      const startOfMonth = new Date()
      startOfMonth.setDate(1)
      startOfMonth.setHours(0, 0, 0, 0)
      const [c, m, e, d, vl] = await Promise.all([
        getCandidates({}),
        getMilestones({}),
        getElections(),
        getDossiers(null, { list: true }),   // no `content` — the dashboard only draws digests
        getVoterLists(),
      ])
      if (dead) return
      const allDossiers = d.data || []
      setCandidates(c.data || [])
      setMilestones(m.data || [])
      setElections(e.data || [])
      setDossiers(allDossiers)
      setVoterLists(vl.data || [])
      // Quota is derived from the dossiers we just fetched instead of a second
      // round-trip that asked the same table the same question. Same rule as
      // Dossiers.jsx: only this user's manual generations count — auto-
      // regenerated rows carry a null generated_by.
      setProfilesUsed(allDossiers.filter(x =>
        x.generated_by && x.generated_by === user?.id &&
        x.generated_at && new Date(x.generated_at) >= startOfMonth
      ).length)
      setLoading(false)
    })()
    return () => { dead = true }
  }, [user?.id])

  const self      = useMemo(() => resolveSelfCandidate(user, candidates), [user, candidates])
  const monitored = useMemo(() => {
    const flagged = candidates.filter(isMonitored)
    if (!flagged.length) return null
    // Prefer the user's own record when it's monitored, else the first opponent.
    return flagged.find(c => c.id === self?.id) || flagged[0]
  }, [candidates, self])

  const district = useMemo(() => resolveDistrict(self?.office), [self])

  useEffect(() => {
    let dead = false
    ;(async () => {
      const [p, pr] = await Promise.all([loadPopPoints(), loadCountyPres()])
      if (!dead) { setPopPoints(p); setPres(pr) }
    })()
    return () => { dead = true }
  }, [])

  useEffect(() => {
    let dead = false
    if (!district) { setBoundary(null); return }
    setBoundary(undefined)
    loadBoundary(district).then(g => { if (!dead) setBoundary(g) })
    return () => { dead = true }
  }, [district])

  // ── derived: municipalities + counties inside the district ────────────────
  const inside = useMemo(() => {
    if (!boundary || !popPoints) return null
    return popPoints.filter(p => pointInGeometry(p.lng, p.lat, boundary))
  }, [boundary, popPoints])

  const countyMix = useMemo(() => {
    if (!inside?.length) return null
    const mix = {}; let total = 0
    inside.forEach(p => { mix[p.co] = (mix[p.co] || 0) + p.pop; total += p.pop })
    if (!total) return null
    Object.keys(mix).forEach(k => { mix[k] = mix[k] / total })
    return mix
  }, [inside])

  // Registered voters in district = rows from the user's own uploaded voter
  // lists whose geocode falls inside the boundary. Census population is NOT a
  // substitute — it counts residents, not registered voters.
  // countVotersInDistrict filters server-side on the district bbox and pages to
  // completion, so this is exact; the old `.limit(5000)` prefix under-counted
  // any account with a large uploaded list.
  const [votersInDistrict, setVotersInDistrict] = useState(null)
  useEffect(() => {
    let dead = false
    if (!boundary) { setVotersInDistrict(null); return }
    setVotersInDistrict(null)
    countVotersInDistrict(boundary).then(n => { if (!dead) setVotersInDistrict(n) })
    return () => { dead = true }
  }, [boundary])

  const historyRows = useMemo(() => {
    if (!countyMix || !pres) return null
    const out = []
    for (const year of [2024, 2020, 2016]) {
      let gop = 0, dem = 0, w = 0
      for (const [county, share] of Object.entries(countyMix)) {
        const r = pres[county]?.[year]
        if (!r?.total) continue
        const two = (r.gop || 0) + (r.dem || 0)
        if (!two) continue
        gop += (r.gop / two) * share
        dem += (r.dem / two) * share
        w += share
      }
      if (w > 0.5) {
        const r = Math.round((gop / w) * 100)
        out.push({ year, r, d: 100 - r })
      }
    }
    return out.length ? out : null
  }, [countyMix, pres])

  // ── derived: digest + monitoring weeks ────────────────────────────────────
  const monitoredDossiers = useMemo(() => (
    dossiers
      .filter(d => d.candidate_id === monitored?.id)
      .sort((a, b) => String(b.generated_at || '').localeCompare(String(a.generated_at || '')))
  ), [dossiers, monitored])

  // The panel is titled "This week's digest", so it renders THIS week's digest.
  // It used to render the newest digest of any age, which quietly presented a
  // three-week-old summary as current. latestDigest is kept only to date the
  // empty state honestly.
  const thisWeekDigest = useMemo(() => weekDigestOf(monitoredDossiers), [monitoredDossiers])
  const latestDigest   = useMemo(() => latestDigestOf(monitoredDossiers), [monitoredDossiers])

  const weeks = useMemo(() => {
    const thisWeek = startOfWeek(new Date(), { weekStartsOn: 1 })
    const buckets = []
    for (let i = 7; i >= 0; i--) {
      const start = addWeeks(thisWeek, -i)
      buckets.push({ key: +start, start, label: format(start, 'MMM d'), counts: {}, total: 0 })
    }
    monitoredDossiers.forEach(d => {
      const t = safeISO(d.generated_at)
      if (!t) return
      const ws = +startOfWeek(t, { weekStartsOn: 1 })
      const b = buckets.find(x => x.key === ws)
      if (!b) return
      ;(d.weekly_digest?.items || []).forEach(it => {
        const k = MONITORING_SERIES.some(s => s.key === it.category) ? it.category : 'other'
        b.counts[k] = (b.counts[k] || 0) + 1
        b.total += 1
      })
    })
    return buckets
  }, [monitoredDossiers])

  // ── derived: game plan ────────────────────────────────────────────────────
  const selfMilestones = useMemo(() => (
    self ? milestones.filter(m => m.candidate_id === self.id) : milestones
  ), [milestones, self])

  const gp = useMemo(() => {
    const total = selfMilestones.length
    const done = selfMilestones.filter(m => ['complete', 'skipped'].includes(autoStatus(m))).length
    const overdue = selfMilestones.filter(m => autoStatus(m) === 'overdue').length
    const open = selfMilestones
      .filter(m => !['complete', 'skipped'].includes(autoStatus(m)))
      .sort((a, b) => {
        const ad = a.due_date || '9999', bd = b.due_date || '9999'
        return ad.localeCompare(bd)
      })
    const phase = open[0]?.phase
    return { total, done, overdue, next: open.slice(0, 5), phase }
  }, [selfMilestones])

  const nextElection = useMemo(() => {
    if (self?.election?.election_date && isUpcoming(self.election.election_date)) return self.election
    const upcoming = elections
      .filter(e => isUpcoming(e.election_date))
      .sort((a, b) => String(a.election_date).localeCompare(String(b.election_date)))
    return upcoming[0] || null
  }, [self, elections])

  const upcomingElections = useMemo(() => (
    elections
      .filter(e => isUpcoming(e.election_date))
      .sort((a, b) => String(a.election_date).localeCompare(String(b.election_date)))
      .slice(0, 4)
  ), [elections])

  // Burn-up series: cumulative completions per week from election-day target.
  const burnUp = useMemo(() => {
    const total = selfMilestones.length
    if (!total) return null
    const completed = selfMilestones
      .filter(m => ['complete', 'skipped'].includes(m.status) && m.updated_at)
      .map(m => +startOfWeek(safeISO(m.updated_at) || new Date(), { weekStartsOn: 1 }))
      .sort((a, b) => a - b)
    const thisWeek = startOfWeek(new Date(), { weekStartsOn: 1 })
    const pts = []
    for (let i = 11; i >= 0; i--) {
      const cut = +addWeeks(thisWeek, -i)
      pts.push(completed.filter(t => t <= cut).length)
    }
    return { points: pts, total }
  }, [selfMilestones])

  const toggleMilestone = async (m) => {
    const done = ['complete', 'skipped'].includes(m.status)
    setBusyId(m.id)
    const next = done ? 'in_progress' : 'complete'
    const { error } = await updateMilestone(m.id, { status: next })
    if (!error) {
      setMilestones(prev => prev.map(x => (
        x.id === m.id ? { ...x, status: next, updated_at: new Date().toISOString() } : x
      )))
      logActivity(done ? 'milestone_reopened' : 'milestone_completed', 'milestone', m.id, { title: m.title })
    }
    setBusyId(null)
  }

  const pinSelf = async (id) => {
    setPicking(false)
    await supabase.auth.updateUser({ data: { self_candidate_id: id } })
    // Reflect immediately without a reload — resolveSelfCandidate reads the
    // pinned id off `user`, which AuthContext refreshes on the next auth event.
    setCandidates(prev => [...prev])
    window.location.reload()
  }

  // ── Active-monitoring slots: used count comes from the server ──────────────
  // monitoringSlots(user, candidates) derives `used` by counting the loaded
  // array. That is only correct while the array happens to hold every candidate
  // the user owns — and getCandidates({}) sets no explicit range, so PostgREST's
  // default 1000-row ceiling silently truncates it for large Action accounts,
  // and any future filter/paginate on this page would truncate it further. A
  // short count under-reports used slots and the stat strip tells the user they
  // have free slots the `monitoring_cap` trigger will refuse to fill.
  //
  // Same query shape as Candidates.jsx refreshActiveCount() and Settings.jsx's
  // usage panel, so all three agree: scoped to created_by, head+exact count.
  // Change one, change the others.
  useEffect(() => {
    if (!supabase || !user?.id) return
    let dead = false
    supabase
      .from('candidates')
      .select('id', { count: 'exact', head: true })
      .eq('created_by', user.id)
      .contains('section_timestamps', { monitoring: true })
      .then(({ count, error }) => {
        if (dead || error) return    // on error keep the client-side fallback
        setMonitoredCount(count ?? 0)
      })
    return () => { dead = true }
  }, [user?.id])

  // ── stat strip values ─────────────────────────────────────────────────────
  // Defensive fallback: until the count lands (or if it errors) we still show
  // the array-derived number rather than a blank — it is a display stat, and
  // the real boundary is the DB trigger.
  const slots = useMemo(() => {
    const base = monitoringSlots(user, candidates)
    if (monitoredCount == null) return base
    return {
      ...base,
      used: monitoredCount,
      left: base.max === Infinity ? Infinity : Math.max(0, base.max - monitoredCount),
    }
  }, [user, candidates, monitoredCount])
  const profileLimit = getEffectiveProfileLimit(user)
  const banked = getBankedProfileCredits(user)
  const monitoredIsSelf = monitored && self && monitored.id === self.id

  const countyList = useMemo(() => {
    if (!inside?.length) return null
    const names = [...new Set(inside.map(p => p.co).filter(Boolean))].sort()
    return names
  }, [inside])

  const subLine = self ? (
    <>
      <span style={{ fontSize: 12.5, color: T.ink2 }}>
        {[self.office?.name, self.office?.district_name || (self.office?.district_number ? `District ${self.office.district_number}` : null)]
          .filter(Boolean).join(' — ') || 'No office linked'}
      </span>
      <PartyPill party={self.party} />
      {countyList?.length > 0 && (
        <span style={{ fontSize: 11.5, color: T.faint }}>
          {countyList.slice(0, 3).join(', ')}{countyList.length > 3 ? ` +${countyList.length - 3}` : ''}
        </span>
      )}
      {candidates.length > 1 && (
        <TextLink onClick={() => setPicking(p => !p)} style={{ fontSize: 11 }}>
          {picking ? 'Cancel' : 'Not you?'}
        </TextLink>
      )}
    </>
  ) : (
    <span style={{ fontSize: 12.5, color: T.muted }}>
      Add your candidate record on the Candidates page to personalise this dashboard.
    </span>
  )

  if (loading) {
    return (
      <DashboardShell>
        <LoadingBar loading />
        <div style={{ fontSize: 13, color: T.muted, padding: 40, textAlign: 'center' }}>
          Loading your dashboard…
        </div>
      </DashboardShell>
    )
  }

  return (
    <DashboardShell>
      <LoadingBar loading={false} />

      <DashboardHeader
        user={user}
        subLine={subLine}
        nextRace={
          <NextRaceBlock
            election={nextElection}
            contextLine={
              self?.election?.id && nextElection?.id === self.election.id
                ? "You're on the ballot"
                : nextElection ? 'Statewide calendar' : null
            }
          />
        }
      />

      {picking && (
        <Card style={{ padding: 16, marginBottom: 18 }}>
          <CardHead title="Which record is you?" sub="Used for your district, game plan and next race. Saved to your account." />
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {candidates.map(c => (
              <button key={c.id} type="button" onClick={() => pinSelf(c.id)} style={{
                border: `1px solid ${c.id === self?.id ? T.red : T.border}`, background: '#fff',
                borderRadius: 99, padding: '6px 14px', fontSize: 12, fontWeight: 600,
                cursor: 'pointer', fontFamily: 'inherit',
              }}>{c.name}</button>
            ))}
          </div>
        </Card>
      )}

      <StatStrip>
        <StatCell
          label="Your district"
          value={
            !district ? '—'
            : votersInDistrict == null ? '…'
            : fmtInt(votersInDistrict)
          }
          sub={
            !district ? 'Link an office to your candidate record'
            : votersInDistrict == null ? 'Matching your voter lists to the district'
            : voterLists.length === 0
              ? 'No voter list uploaded yet — import one in Voter Lists'
              : votersInDistrict === 0
                ? 'No voters in your lists fall inside this district'
                : `registered voters from ${voterLists.length} uploaded list${voterLists.length === 1 ? '' : 's'}`
          }
        />
        <StatCell
          label="Active Monitoring"
          truncate
          valueSize={17}
          value={monitored ? monitored.name : 'Off'}
          chip={monitored ? <WeeklyChip /> : null}
          sub={
            monitored
              ? `${monitoredIsSelf ? 'Your own profile' : 'Opposition research'} · next refresh ${format(nextMonday(), 'MMM d')}`
              : slots.max === 0
                ? 'Active Monitoring is not included on your plan'
                : `Turn it on for a candidate — ${slots.max === Infinity ? 'unlimited' : slots.left} slot${slots.left === 1 ? '' : 's'} open`
          }
        />
        <StatCell
          label="AI profiles this month"
          value={profilesUsed == null ? '…' : profilesUsed}
          of={profileLimit === Infinity ? '∞' : profileLimit}
          sub={
            `${planCfg?.name || plan} plan` +
            (banked > 0 ? ` · ${banked} credit${banked === 1 ? '' : 's'} banked` : '')
          }
        />
        <StatCell
          label="Game plan"
          value={gp.total ? gp.done : '—'}
          of={gp.total || undefined}
          chip={<OverdueChip n={gp.overdue} />}
          sub={
            !gp.total ? 'No milestones yet — build a plan in Game Plan'
            : gp.phase ? PHASE_MAP[gp.phase]?.label || 'In progress'
            : 'All milestones complete'
          }
        />
      </StatStrip>

      <div className="bb-main" style={{
        display: 'grid', gridTemplateColumns: '1.65fr 1fr', gap: 18, alignItems: 'start',
      }}>
        {/* ── main column ── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18, minWidth: 0 }}>

          <Card style={{ padding: '18px 20px' }}>
            <CardHead
              title={
                <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {thisWeekDigest && <LivePulseDot />}
                  This week's digest{monitored ? ` — ${monitored.name}` : ''}
                </span>
              }
              right={thisWeekDigest && (
                <span style={{ fontSize: 10.5, color: T.faint }}>
                  {fmtDate(thisWeekDigest.generated_at, 'MMM d')}
                </span>
              )}
            />
            {thisWeekDigest ? (
              <>
                <div style={{ fontSize: 12.5, lineHeight: 1.6, color: T.ink2, marginTop: 8 }}>
                  {thisWeekDigest.weekly_digest.summary}
                </div>
                <DigestItems items={thisWeekDigest.weekly_digest.items} />
              </>
            ) : monitored ? (
              <EmptyState
                title={latestDigest ? 'No digest this week yet' : 'No digest yet'}
                body={latestDigest
                  ? `${monitored.name} is being monitored. The most recent digest is from ${fmtDate(latestDigest.generated_at, 'MMM d')}; this week's lands after the next Monday refresh.`
                  : `${monitored.name} is being monitored. The first weekly digest is written after the next Monday refresh.`}
              />
            ) : (
              <EmptyState
                title="Active Monitoring is off"
                body={
                  slots.max === 0
                    // slots.max is getMonitoringSlotMax() — activeCandidateLimit
                    // on the Candidate ladder (scout 0, c_monitor 0, c_active 1,
                    // c_campaign 3), the bracket max on Action. Zero means the
                    // plan bought no slot, so this copy is the only place that
                    // has to name where slots start. It is also the gate the
                    // Candidates page uses; the two cannot disagree.
                    ? `Active Monitoring is available on ${monitoringUnlockLabel('candidate')}. Weekly digests track news, endorsements, polling and controversy for the candidate you choose.`
                    : 'Turn on Active Monitoring for yourself or an opponent from the Candidates page to start receiving weekly digests.'
                }
                action={<CtaButton onClick={() => nav('/candidates')}>Choose a candidate</CtaButton>}
              />
            )}
          </Card>

          <Card style={{ padding: '18px 20px' }}>
            <CardHead title="Monitoring activity" sub="Digest items per week, last 8 weeks" />
            <div style={{ marginTop: 8 }}>
              <MonitoringActivity weeks={weeks} />
            </div>
          </Card>

          <Card style={{ padding: '18px 20px' }}>
            <CardHead
              title="Game plan — next up"
              right={<TextLink onClick={() => nav('/game-plan')}>Open Game Plan →</TextLink>}
            />
            {!hasFeature(plan, 'gameplan') ? (
              <EmptyState
                title="Game Plan is not on your plan"
                body="Game Plan unlocks at Candidate Monitor. It turns your race into dated milestones across planning, filing, voter contact, fundraising and GOTV."
                action={<CtaButton onClick={() => nav('/plans')}>See plans</CtaButton>}
              />
            ) : !gp.total ? (
              <EmptyState
                title="No milestones yet"
                body="Build a game plan for your race and the next five milestones show up here."
                action={<CtaButton onClick={() => nav('/game-plan')}>Build a game plan</CtaButton>}
              />
            ) : (
              <>
                {burnUp && (
                  <BurnUp
                    points={burnUp.points}
                    total={burnUp.total}
                    targetLabel={`all ${burnUp.total}${nextElection ? ` by ${fmtDate(nextElection.election_date)}` : ''}`}
                  />
                )}
                {burnUp && (
                  <div style={{ fontSize: 10, color: T.faint, marginBottom: 10 }}>
                    Completion dates use each milestone's last update time.
                  </div>
                )}
                {gp.next.length ? gp.next.map(m => (
                  <MilestoneRow key={m.id} milestone={m} onToggle={toggleMilestone} busy={busyId === m.id} />
                )) : (
                  <div style={{ fontSize: 12.5, color: T.muted, padding: '8px 0' }}>
                    Every milestone is done. Nothing outstanding.
                  </div>
                )}
              </>
            )}
          </Card>
        </div>

        {/* ── right rail ── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18, minWidth: 0 }}>

          <Card style={{ padding: '18px 20px' }}>
            <CardHead
              title="Election calendar"
              right={<TextLink onClick={() => nav('/elections')}>All →</TextLink>}
            />
            <ElectionRows elections={upcomingElections} hotId={nextElection?.id} />
          </Card>

          <Card style={{ padding: '18px 20px' }}>
            <CardHead
              title={district?.label || 'Your district'}
              right={hasFeature(plan, 'offices')
                ? <TextLink onClick={() => nav('/offices')}>Open in Offices →</TextLink>
                : null}
            />
            {!district ? (
              <EmptyState
                title="No district linked"
                body="Link an office to your candidate record on the Candidates page and the district map, county breakdown and election history appear here."
              />
            ) : boundary === undefined ? (
              <div style={{ fontSize: 11.5, color: T.faint, padding: '20px 0' }}>Loading district…</div>
            ) : !boundary ? (
              <EmptyState
                title="Boundary unavailable"
                body="No mapped boundary matches this office. Municipal offices are not in the statewide district layers."
              />
            ) : (
              <>
                <DistrictHeatMap geometry={boundary} popPoints={popPoints} />
                <HeatLegend />
                <div style={{ marginTop: 12, paddingTop: 10, borderTop: `1px solid ${T.divider}` }}>
                  <StatRow label="Counties" value={countyList ? countyList.length : '—'} />
                  <StatRow label="Municipalities" value={inside ? fmtInt(inside.length) : '—'} />
                  <StatRow
                    label="Registered voters"
                    value={votersInDistrict == null ? '—' : fmtInt(votersInDistrict)}
                  />
                </div>
                {votersInDistrict === 0 && (
                  <div style={{ fontSize: 10.5, color: T.faint, marginTop: 4, lineHeight: 1.5 }}>
                    Registered voters come from your uploaded lists. Import one in Voter Lists.
                  </div>
                )}
                <ElectionHistory rows={historyRows} />
              </>
            )}
          </Card>

          <div style={{
            background: T.warmBg, border: `1px solid ${T.warmBr}`,
            borderRadius: 16, padding: '18px 20px',
          }}>
            <span style={{
              fontSize: 9, fontWeight: 700, letterSpacing: '.6px', color: T.warmInk,
              background: '#F8ECDC', borderRadius: 99, padding: '3px 8px',
            }}>AI SPARRING</span>
            <div style={{ fontSize: 13.5, fontWeight: 700, marginTop: 10 }}>Broadside</div>
            <div style={{ fontSize: 12, color: T.muted, lineHeight: 1.5, marginTop: 6 }}>
              Your opponent will use your profile's vulnerabilities. Take the hit here first — spar
              against them and get a report card on message discipline, pivots, and trap avoidance.
            </div>
            <div style={{ marginTop: 14 }}>
              {hasFeature(plan, 'broadside') ? (
                <CtaButton onClick={() => nav('/broadside')}>Start a session</CtaButton>
              ) : (
                <CtaButton onClick={() => nav('/plans')}>See plans</CtaButton>
              )}
            </div>
          </div>

          <Card style={{ padding: '18px 20px' }}>
            <CardHead title="Quick actions" />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <QuickAction
                icon="✦" tint="#E7F0FD" ink="#1D4ED8"
                label="Build a profile"
                sub={
                  profileLimit === Infinity ? 'Unlimited on your account'
                  : profilesUsed == null ? ''
                  : `${Math.max(0, profileLimit - profilesUsed)} left this month`
                }
                onClick={() => nav('/dossiers')}
              />
              <QuickAction
                icon="⚖︎" tint="#F3EDFB" ink="#7C3AED"
                label="Compare vs. opponent"
                sub={hasFeature(plan, 'compare') ? 'Side-by-side profiles' : 'Available on Active plans'}
                onClick={() => nav(hasFeature(plan, 'compare') ? '/compare' : '/plans')}
              />
              <QuickAction
                icon="☰" tint="#E6F5EC" ink="#15803D"
                label="Pull a voter list"
                sub={voterLists.length ? `${voterLists.length} list${voterLists.length === 1 ? '' : 's'} imported` : 'Import a CSV'}
                onClick={() => nav('/voter-lists')}
              />
              <QuickAction
                icon="◷" tint="#F4F0E6" ink="#B45309"
                label="Find local events"
                sub="Parades, fairs, forums"
                onClick={() => nav('/events')}
              />
            </div>
          </Card>
        </div>
      </div>

      <style>{`@media (max-width: 1100px) { .bb-main { grid-template-columns: 1fr !important } }`}</style>
    </DashboardShell>
  )
}
