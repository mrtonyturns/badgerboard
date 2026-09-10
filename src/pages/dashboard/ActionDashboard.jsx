// ActionDashboard.jsx — the dashboard shown to action-family plans
// (a_monitor / a_active / a_campaign). The user is a campaign manager,
// consultant, county party or agency working a PORTFOLIO of candidates rather
// than running one campaign.
//
// Same discipline as the Candidate dashboard: every number is read or derived
// from a real row. Anything the app doesn't compute is rendered as the honest
// empty state from SPEC.md rule 4 — never as a zero, a dash dressed up as data,
// or an invented score.

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { format, differenceInCalendarDays } from 'date-fns'
import LoadingBar from '../../components/LoadingBar'
import { useAuth } from '../../contexts/AuthContext'
import {
  supabase,
  getCandidates, getMilestones, getElections, getDossiers,
  getProspectingLists, getVoterLists, getRecentActivity,
} from '../../lib/supabase'
import {
  getUserPlan, getPlanConfig, getUserBracket, getBracketConfig,
  getEffectiveProfileLimit, getBankedProfileCredits, hasFeature,
} from '../../lib/tiers'
import { PHASE_MAP } from '../../lib/campaignEnums'
import { isRep, isDem } from '../../lib/party'
import { officeLine } from '../../lib/office'
import {
  T, Card, CardHead, DashboardShell, DashboardHeader, NextRaceBlock,
  StatStrip, StatCell, WeeklyChip, PartyPill, StatusPill, Pill, PhaseDot, DueChip,
  DigestItems, ElectionRows, EmptyState, CtaButton, TextLink, LivePulseDot,
  PartyAvatar, DashboardSkeleton, srOnly,
  safeISO, fmtInt, fmtDate, daysUntil, isUpcoming, relativeTime, initialsOf, autoStatus,
  humanizeActivityVerb,
  countdownLabel, fmtDueDate, dueChipLabel,
  isMonitored, monitoringSlots,
  resolveDistrict, loadBoundary, countVotersInDistrict,
  latestDigestOf, weekDigestOf,
} from './shared'

// ── helpers ──────────────────────────────────────────────────────────────────
// isThisWeek / latestDigestOf / weekDigestOf moved to shared.jsx so the two
// dashboards cannot drift on what "this week's digest" means.

// Recent activity's initial preview — see the "Show all activity" toggle below.
const ACTIVITY_PREVIEW_COUNT = 4

// Same office line as the rest of the app (lib/office.js) — this page's own
// separator and its own "nothing linked" copy, which is all that ever differed.
const officeText = (office) => officeLine(office, { sep: ' · ', empty: 'No office linked' })

// Profile freshness, stated as a fact about the row rather than a rating.
const freshness = (dossier) => {
  if (!dossier) return 'No profile built yet'
  const t = safeISO(dossier.generated_at)
  if (!t) return 'Profile on file'
  const age = differenceInCalendarDays(new Date(), t)
  if (age <= 0) return 'Refreshed today'
  if (age <= 7) return `Fresh · refreshed ${format(t, 'MMM d')}`
  return `${age} days old · refreshed ${format(t, 'MMM d')}`
}

// ── candidate carousel ───────────────────────────────────────────────────────

function CandidateCard({ c, selected, flagged, sub, onSelect }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      style={{
        flex: 'none', width: 206, textAlign: 'left', cursor: 'pointer',
        background: T.card, borderRadius: 16, padding: 15, position: 'relative',
        fontFamily: 'inherit', color: 'inherit',
        border: `1px solid ${selected ? T.red : T.border}`,
        boxShadow: selected
          ? '0 0 0 1px #8B0000, 0 6px 18px rgba(139,0,0,.10)'
          : '0 1px 3px rgba(0,0,0,.03)',
      }}
    >
      {flagged && (
        <span
          title="Controversy item in this week's digest"
          style={{
            position: 'absolute', top: 13, right: 13, width: 8, height: 8,
            borderRadius: '50%', background: T.redHot, animation: 'bbLivePulse 2s infinite',
          }}
        />
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
        <PartyAvatar name={c.name} party={c.party} size={42} />
        <div style={{ minWidth: 0 }}>
          <div style={{
            fontSize: 13, fontWeight: 600, lineHeight: 1.25,
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>{c.name}</div>
          <div style={{
            fontSize: 10.5, color: T.faint, marginTop: 1,
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>{officeText(c.office)}</div>
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 12, flexWrap: 'wrap' }}>
        <StatusPill status={c.status} style={{ fontWeight: 600 }} />
        <PartyPill party={c.party} />
        {isMonitored(c) && <Pill c="#15803D" bg="#E6F5EC" style={{ fontWeight: 600 }}>● Active</Pill>}
      </div>
      <div style={{ fontSize: 10.5, color: T.faint, marginTop: 10 }}>{sub}</div>
    </button>
  )
}

// ── selected-candidate panel tiles ───────────────────────────────────────────

function StatTile({ label, value, title }) {
  return (
    <div title={title} style={{
      background: T.hover, border: `1px solid ${T.divider}`,
      borderRadius: 10, padding: '8px 13px', minWidth: 0,
    }}>
      <div style={{ fontSize: 10, color: T.faint, whiteSpace: 'nowrap' }}>{label}</div>
      <div style={{ fontSize: 12.5, fontWeight: 600, whiteSpace: 'nowrap' }}>{value}</div>
    </div>
  )
}

// ── needs attention ──────────────────────────────────────────────────────────

function AttentionRow({ item, onClick }) {
  return (
    <div
      className="bb-row"
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      style={{
        display: 'flex', alignItems: 'center', gap: 13,
        padding: 10, margin: '0 -10px', borderRadius: 10,
        cursor: onClick ? 'pointer' : 'default',
      }}
    >
      <span style={{
        flex: 'none', width: 34, height: 34, borderRadius: 9,
        background: item.tileBg, color: item.tileFg, fontSize: 14,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>{item.glyph}</span>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{
          fontSize: 13, fontWeight: 600, lineHeight: 1.35,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{item.title}</div>
        <div style={{
          fontSize: 11, color: T.faint, marginTop: 1,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{item.sub}</div>
      </div>
      <span style={{
        flex: 'none', fontSize: 10.5, fontWeight: 600,
        color: item.chipColor, background: item.chipBg,
        borderRadius: 99, padding: '3px 10px', whiteSpace: 'nowrap',
      }}>{item.chip}</span>
    </div>
  )
}

// ── prospecting ──────────────────────────────────────────────────────────────

// Lean counts come from the stored AI classification on each prospect row
// (Prospecting.jsx writes `lean` ∈ conservative | liberal | unknown). Lists
// with no classification render the count without a bar rather than guessing.
function ProspectRow({ list }) {
  const rows = Array.isArray(list.candidates) ? list.candidates : []
  const total = list.total_count ?? rows.length
  const cons = rows.filter(r => r.lean === 'conservative').length
  const lib  = rows.filter(r => r.lean === 'liberal').length
  const unk  = Math.max(0, total - cons - lib)
  const classified = cons + lib > 0
  const pct = (n) => (total ? `${(n / total) * 100}%` : '0%')
  const meta = [
    rows.length && !classified ? 'not lean-classified' : classified ? 'AI lean classification' : null,
    list.created_at ? fmtDate(list.created_at, 'MMM d') : null,
  ].filter(Boolean).join(' · ')
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 5 }}>
        <div style={{
          fontSize: 12.5, fontWeight: 600, minWidth: 0,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{list.name}</div>
        <div style={{ fontSize: 10.5, color: T.faint, whiteSpace: 'nowrap' }}>{meta}</div>
        <span style={{ marginLeft: 'auto', fontSize: 11.5, fontWeight: 600 }}>{fmtInt(total)}</span>
      </div>
      {classified ? (
        <>
          <div style={{
            display: 'flex', height: 6, borderRadius: 99,
            overflow: 'hidden', background: T.chip,
          }}>
            <div style={{ width: pct(cons), background: '#B91C1C' }} />
            <div style={{ width: pct(lib), background: '#2563EB' }} />
          </div>
          <div style={{ display: 'flex', gap: 12, marginTop: 4, fontSize: 10, color: T.faint }}>
            <span><span style={{ color: '#B91C1C', fontWeight: 700 }}>●</span> {cons} conservative</span>
            <span><span style={{ color: '#2563EB', fontWeight: 700 }}>●</span> {lib} liberal</span>
            <span>{unk} unknown</span>
          </div>
        </>
      ) : (
        <div style={{ fontSize: 10.5, color: T.faint }}>
          No AI lean classification stored for this list.
        </div>
      )}
    </div>
  )
}

// ── activity feed ────────────────────────────────────────────────────────────

const ACTION_VERBS = {
  create: 'added', update: 'updated', delete: 'removed',
  enable_monitoring: 'turned on Active Monitoring for',
  disable_monitoring: 'turned off Active Monitoring for',
  milestone_completed: 'completed a milestone', milestone_reopened: 'reopened a milestone',
}

const ENTITY_LABEL = {
  candidate: 'candidate', incumbent_record: 'record', milestone: 'milestone',
}

function activityLine(row) {
  const d = row.details || {}
  const subject = d.candidate_name || d.record_title || d.title || d.name ||
    ENTITY_LABEL[row.entity_type] || row.entity_type || 'an item'
  const verb = ACTION_VERBS[row.action]
  // Anything this page has no phrasing for goes through the shared humanizer
  // ('ai_unlock' → 'unlocked AI access') instead of being printed raw, which is
  // where "You ai unlock — Brady Penfield" came from.
  if (!verb) return `${humanizeActivityVerb(row.action)} — ${subject}`
  if (row.action === 'milestone_completed' || row.action === 'milestone_reopened') {
    return `${verb}${d.title ? `: ${d.title}` : ''}`
  }
  if (row.action === 'create' || row.action === 'update' || row.action === 'delete') {
    return `${verb} ${ENTITY_LABEL[row.entity_type] || row.entity_type} ${subject === ENTITY_LABEL[row.entity_type] ? '' : subject}`.trim()
  }
  return `${verb} ${subject}`
}

// ── page ─────────────────────────────────────────────────────────────────────

export default function ActionDashboard() {
  const { user } = useAuth()
  const nav = useNavigate()
  const plan = getUserPlan(user)
  const planCfg = getPlanConfig(plan)
  const bracket = getBracketConfig(getUserBracket(user))

  const [loading, setLoading]     = useState(true)
  const [candidates, setCands]    = useState([])
  const [milestones, setMiles]    = useState([])
  const [elections, setElections] = useState([])
  const [dossiers, setDossiers]   = useState([])
  const [prospects, setProspects] = useState([])
  const [voterLists, setVLists]   = useState([])
  const [activity, setActivity]   = useState([])
  // The right rail (Election calendar + Recent activity) could run ~400px
  // past the left column's (Needs attention + Prospecting) natural end, since
  // activity kept rendering every fetched row while the left side was often
  // short. Capped to a short preview with an in-place expand — state only, no
  // extra fetch, since getRecentActivity(8) already bounds the source list.
  const [showAllActivity, setShowAllActivity] = useState(false)
  const [profilesUsed, setUsed]   = useState(null)
  const [selId, setSelId]         = useState(null)
  // Authoritative count of THIS USER's candidates with monitoring switched on.
  // null = not answered yet (fall back to the client-side derivation below).
  const [monitoredCount, setMonitoredCount] = useState(null)

  useEffect(() => {
    let dead = false
    ;(async () => {
      const startOfMonth = new Date()
      startOfMonth.setDate(1)
      startOfMonth.setHours(0, 0, 0, 0)
      const [c, m, e, d, pl, vl, act] = await Promise.all([
        getCandidates({}),
        getMilestones({}),
        getElections(),
        getDossiers(null, { list: true }),   // no `content` — this page only draws digests
        getProspectingLists(),
        getVoterLists(),
        getRecentActivity(8),
      ])
      if (dead) return
      const allDossiers = d.data || []
      setCands(c.data || [])
      setMiles(m.data || [])
      setElections(e.data || [])
      setDossiers(allDossiers)
      setProspects(pl.data || [])
      setVLists(vl.data || [])
      setActivity(act.data || [])
      // Quota derived from the dossiers already fetched instead of a second
      // query against the same table. Same rule as Dossiers.jsx — auto-
      // regenerated rows carry a null generated_by and don't count.
      setUsed(allDossiers.filter(x =>
        x.generated_by && x.generated_by === user?.id &&
        x.generated_at && new Date(x.generated_at) >= startOfMonth
      ).length)
      setLoading(false)
    })()
    return () => { dead = true }
  }, [user?.id])

  // ── dossiers indexed by candidate ─────────────────────────────────────────
  const byCandidate = useMemo(() => {
    const map = {}
    dossiers.forEach(d => {
      if (!d.candidate_id) return
      ;(map[d.candidate_id] ||= []).push(d)
    })
    Object.values(map).forEach(list => list.sort((a, b) =>
      String(b.generated_at || '').localeCompare(String(a.generated_at || ''))))
    return map
  }, [dossiers])

  const latestOf = (id) => byCandidate[id]?.[0] || null
  // Per-candidate wrappers over the shared helpers.
  const latestDigestForId = (id) => latestDigestOf(byCandidate[id] || [])
  const weekDigestForId   = (id) => weekDigestOf(byCandidate[id] || [])

  const flaggedIds = useMemo(() => {
    const set = new Set()
    candidates.forEach(c => {
      const wk = weekDigestForId(c.id)
      if (wk?.weekly_digest?.items?.some(i => i.category === 'controversy')) set.add(c.id)
    })
    return set
  }, [candidates, byCandidate])

  // Monitored candidates first (they're the ones with fresh intel), then the
  // most recently profiled, then alphabetical.
  const ordered = useMemo(() => (
    [...candidates].sort((a, b) => {
      const am = isMonitored(a) ? 0 : 1, bm = isMonitored(b) ? 0 : 1
      if (am !== bm) return am - bm
      const ad = latestOf(a.id)?.generated_at || '', bd = latestOf(b.id)?.generated_at || ''
      if (ad !== bd) return String(bd).localeCompare(String(ad))
      return String(a.name).localeCompare(String(b.name))
    })
  ), [candidates, byCandidate])

  const shown = useMemo(() => ordered.slice(0, 12), [ordered])

  // Carousel right-edge fade. The scrollbar is hidden (see DashboardStyles), so
  // the fade is the only "there's more this way" affordance — which means it has
  // to switch off once there is nothing more, or the last card just looks washed
  // out. `bb-carousel--end` covers both the scrolled-to-the-end and the
  // everything-already-fits cases.
  const carouselRef = useRef(null)
  const [carouselAtEnd, setCarouselAtEnd] = useState(true)
  const syncCarouselFade = () => {
    const el = carouselRef.current
    if (!el) return
    setCarouselAtEnd(el.scrollLeft + el.clientWidth >= el.scrollWidth - 2)
  }
  useEffect(() => { syncCarouselFade() }, [shown.length])
  const sel = useMemo(
    () => ordered.find(c => c.id === selId) || ordered[0] || null,
    [ordered, selId],
  )

  // ── selected candidate detail ─────────────────────────────────────────────
  const selMilestones = useMemo(
    () => (sel ? milestones.filter(m => m.candidate_id === sel.id) : []),
    [milestones, sel],
  )

  const selGp = useMemo(() => {
    const total = selMilestones.length
    const done = selMilestones.filter(m => ['complete', 'skipped'].includes(autoStatus(m))).length
    const next = selMilestones
      .filter(m => !['complete', 'skipped'].includes(autoStatus(m)))
      .sort((a, b) => (a.due_date || '9999').localeCompare(b.due_date || '9999'))
      .slice(0, 4)
    return { total, done, next }
  }, [selMilestones])

  // The panel this feeds is headed "THIS WEEK'S DIGEST", so it must be this
  // week's — it used to render the newest digest of any age. selLatestDigest is
  // kept so the empty state can date the last one honestly.
  const selDigest       = useMemo(() => (sel ? weekDigestForId(sel.id) : null), [sel, byCandidate])
  const selLatestDigest = useMemo(() => (sel ? latestDigestForId(sel.id) : null), [sel, byCandidate])
  const selProfile = useMemo(() => (sel ? latestOf(sel.id) : null), [sel, byCandidate])

  // Per-candidate voter count: rows from the account's uploaded voter lists whose
  // geocode falls inside that candidate's district. There is no candidate↔voter
  // list foreign key, so this is the only honest per-candidate figure available.
  const [selBoundary, setSelBoundary] = useState(undefined)
  const selDistrict = useMemo(() => resolveDistrict(sel?.office), [sel])

  useEffect(() => {
    let dead = false
    if (!selDistrict) { setSelBoundary(null); return }
    setSelBoundary(undefined)
    loadBoundary(selDistrict).then(g => { if (!dead) setSelBoundary(g) })
    return () => { dead = true }
  }, [selDistrict])

  // Exact: countVotersInDistrict narrows on the district bbox server-side and
  // pages to completion. The previous `.limit(5000)` prefetch under-counted any
  // account whose uploaded lists exceeded 5,000 geocoded rows.
  const [selVoters, setSelVoters] = useState(null)
  useEffect(() => {
    let dead = false
    if (!selBoundary) { setSelVoters(null); return }
    setSelVoters(null)
    countVotersInDistrict(selBoundary).then(n => { if (!dead) setSelVoters(n) })
    return () => { dead = true }
  }, [selBoundary])

  // ── portfolio aggregates ──────────────────────────────────────────────────
  const partySplit = useMemo(() => {
    const r = candidates.filter(c => isRep(c.party)).length
    const d = candidates.filter(c => isDem(c.party)).length
    const rest = candidates.length - r - d
    const bits = []
    if (r) bits.push(`${r} R`)
    if (d) bits.push(`${d} D`)
    if (rest) bits.push(`${rest} nonpartisan or other`)
    return bits.join(' · ') || 'No candidates added yet'
  }, [candidates])

  // ── Active-monitoring slots: used count comes from the server ──────────────
  // monitoringSlots(user, candidates) counts the loaded array. Action accounts
  // are exactly the ones where that breaks: getCandidates({}) sets no explicit
  // range, so PostgREST's default 1000-row ceiling truncates the list for a
  // b51/ent roster, and a short count tells the user they have free slots the
  // `monitoring_cap` trigger will refuse to fill. Ask the server instead.
  //
  // Same query shape as Candidates.jsx refreshActiveCount() and Settings.jsx's
  // usage panel — scoped to created_by, head+exact count. Change one, change
  // the others.
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

  // Defensive fallback: until the count lands (or if it errors) show the
  // array-derived number rather than a blank — it is a display stat, and the
  // real boundary is the DB trigger.
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

  const prospectTotal = useMemo(
    () => prospects.reduce((n, p) => n + (p.total_count || 0), 0),
    [prospects],
  )

  const upcoming = useMemo(() => (
    elections
      .filter(e => isUpcoming(e.election_date))
      .sort((a, b) => String(a.election_date).localeCompare(String(b.election_date)))
  ), [elections])

  const nextRace = useMemo(() => {
    const linked = new Set(candidates.map(c => c.election_id).filter(Boolean))
    return upcoming.find(e => linked.has(e.id)) || upcoming[0] || null
  }, [upcoming, candidates])

  const onNextRace = useMemo(
    () => (nextRace ? candidates.filter(c => c.election_id === nextRace.id) : []),
    [candidates, nextRace],
  )

  // ── needs attention ───────────────────────────────────────────────────────
  // Only real signals: controversy items in this week's digests, overdue
  // milestones, and ballots inside 45 days that candidates are linked to.
  // The mockup's "profile suggests a status change" row is deliberately absent —
  // nothing in the schema stores a Profiler status suggestion.
  const attention = useMemo(() => {
    const out = []
    candidates.forEach(c => {
      const wk = weekDigestForId(c.id)
      const hit = wk?.weekly_digest?.items?.find(i => i.category === 'controversy')
      if (hit) {
        out.push({
          key: `c-${c.id}`, priority: 0, candidateId: c.id,
          glyph: '⚑︎', tileBg: '#FBEAEA', tileFg: T.red,
          title: `${c.name}: controversy item in this week's digest`,
          sub: [hit.title, hit.note].filter(Boolean).join(' — '),
          chip: 'Digest', chipColor: T.redHot, chipBg: '#FEF2F2',
        })
      }
    })
    const overdueBy = {}
    milestones.forEach(m => {
      if (autoStatus(m) !== 'overdue') return
      const id = m.candidate_id || 'none'
      ;(overdueBy[id] ||= []).push(m)
    })
    Object.entries(overdueBy).forEach(([id, list]) => {
      const c = candidates.find(x => x.id === id)
      const soonest = list.slice().sort((a, b) => (a.due_date || '').localeCompare(b.due_date || ''))[0]
      out.push({
        key: `o-${id}`, priority: 1, candidateId: c?.id,
        glyph: '!', tileBg: '#FFF7ED', tileFg: '#C2410C',
        // "overdue" is the chip's word and the chip's alone — the title used to
        // repeat it, so one row said "overdue" twice.
        title: `${c ? `${c.name}: ` : ''}${soonest.title}${list.length > 1 ? ` +${list.length - 1} more` : ''}`,
        // fmtDueDate carries the year when it isn't this one: a bare "Sep 2"
        // beside "348d overdue" read as a date 17 days in the FUTURE.
        sub: `Game Plan · ${PHASE_MAP[soonest.phase]?.label || 'Unassigned'} · due ${fmtDueDate(soonest.due_date)}`,
        // Signed, so a future due date can never be announced as overdue.
        chip: dueChipLabel(soonest.due_date), chipColor: T.redHot, chipBg: '#FEF2F2',
      })
    })
    upcoming.forEach(e => {
      const d = daysUntil(e.election_date)
      if (d == null || d > 45) return
      const on = candidates.filter(c => c.election_id === e.id)
      if (!on.length) return
      out.push({
        key: `e-${e.id}`, priority: 2,
        glyph: '◷', tileBg: '#F4F0E6', tileFg: T.warmInk,
        title: `${e.name}: ${on.length} candidate${on.length === 1 ? '' : 's'} on the ballot`,
        sub: on.slice(0, 3).map(c => c.name).join(' · ') + (on.length > 3 ? ` +${on.length - 3}` : ''),
        chip: countdownLabel(e.election_date), chipColor: T.ink3, chipBg: T.chip,
      })
    })
    return out.sort((a, b) => a.priority - b.priority).slice(0, 6)
  }, [candidates, milestones, upcoming, byCandidate])

  const subLine = (
    <span style={{ fontSize: 13, color: T.muted }}>
      {candidates.length
        ? `${candidates.length} candidate${candidates.length === 1 ? '' : 's'} · ` +
          `${slots.used} actively monitored · ` +
          `${new Set(milestones.map(m => m.candidate_id).filter(Boolean)).size} with a game plan`
        : 'Add candidates on the Candidates page to start tracking your portfolio.'}
    </span>
  )

  if (loading) {
    return (
      <DashboardShell>
        <LoadingBar loading />
        {/* The fetch below is six parallel calls and can sit here for several
            seconds — a blank "Loading…" sentence used to be the whole screen
            for that whole time. A shimmer skeleton in the dashboard's own shape
            reads as "drawing itself", not "broken"; the sentence itself still
            exists for screen readers. */}
        <div aria-live="polite" style={srOnly}>Loading your dashboard…</div>
        <DashboardSkeleton />
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
            election={nextRace}
            contextLine={
              onNextRace.length
                ? `${onNextRace.length} of your candidate${onNextRace.length === 1 ? ' is' : 's are'} on this ballot`
                : nextRace ? 'No candidates linked to this ballot yet' : null
            }
          />
        }
      />

      <StatStrip>
        <StatCell
          label="Candidates"
          value={candidates.length}
          sub={partySplit}
        />
        <StatCell
          label="Active Monitoring"
          value={slots.used}
          of={slots.max === Infinity ? '∞' : slots.max}
          chip={slots.used > 0 ? <WeeklyChip /> : null}
          sub={
            slots.max === Infinity
              ? 'unlimited slots · refreshes Mondays'
              : `bracket slots used${bracket ? ` (${bracket.label})` : ''} · refreshes Mondays`
          }
        />
        <StatCell
          label="AI profiles this month"
          value={profilesUsed == null ? '…' : profilesUsed}
          of={profileLimit === Infinity ? '∞' : profileLimit}
          sub={
            `${fmtInt(dossiers.length)} profile${dossiers.length === 1 ? '' : 's'} on file` +
            // Never quote the PLAN spec as if it were the ACCOUNT's cap. When the
            // resolved allowance is unlimited (admin / beta / enterprise) this
            // sublabel read "4 per candidate / mo" directly under "1 of ∞".
            // One treatment app-wide: "Unlimited on your account", and any plan
            // number is labelled as a plan spec.
            (profileLimit === Infinity
              ? ' · Unlimited on your account'
              : planCfg?.profilesPerCandidate
                ? ` · ${planCfg.name} plan spec: ${planCfg.profilesPerCandidate}/candidate/mo`
                : '') +
            (banked > 0 ? ` · ${banked} banked` : '')
          }
        />
        <StatCell
          label="Prospect lists"
          value={prospects.length}
          sub={
            prospects.length
              ? `${fmtInt(prospectTotal)} prospect${prospectTotal === 1 ? '' : 's'} across your lists`
              : 'Build one in Prospecting to find candidates to work with'
          }
        />
      </StatStrip>

      {/* ── candidate carousel ── */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 11 }}>
        <div style={{ fontSize: 15, fontWeight: 700 }}>Your candidates</div>
        <div style={{ fontSize: 12, color: T.faint }}>
          {candidates.length
            ? `${slots.used} monitored shown first`
            : 'none yet'}
        </div>
        <TextLink onClick={() => nav('/candidates')} style={{ marginLeft: 'auto', fontSize: 12 }}>
          {candidates.length > shown.length ? `View all ${candidates.length} →` : 'Open Candidates →'}
        </TextLink>
      </div>

      {candidates.length === 0 ? (
        <Card style={{ padding: '18px 20px', marginBottom: 18 }}>
          <EmptyState
            title="No candidates yet"
            body="Add the candidates you're working with — or prospecting — and their profiles, digests, game plans and ballots appear here."
            action={<CtaButton onClick={() => nav('/candidates')}>Add a candidate</CtaButton>}
          />
        </Card>
      ) : (
        <div
          ref={carouselRef}
          onScroll={syncCarouselFade}
          className={`bb-carousel${carouselAtEnd ? ' bb-carousel--end' : ''}`}
          style={{
            display: 'flex', gap: 12, overflowX: 'auto',
            paddingBottom: 8, marginBottom: 16,
          }}
        >
          {shown.map(c => {
            const wk = weekDigestForId(c.id)
            const last = latestOf(c.id)
            const sub = isMonitored(c)
              ? wk
                ? `Digest updated ${fmtDate(wk.generated_at)} · ${wk.weekly_digest.items?.length || 0} items`
                : 'Monitored · first digest after the next Monday refresh'
              : last
                ? `Not monitored · profile ${fmtDate(last.generated_at)}`
                : 'Not monitored · no profile yet'
            return (
              <CandidateCard
                key={c.id}
                c={c}
                sub={sub}
                selected={sel?.id === c.id}
                flagged={flaggedIds.has(c.id)}
                onSelect={() => setSelId(c.id)}
              />
            )
          })}
        </div>
      )}

      {/* ── selected candidate panel ── */}
      {sel && (
        <Card style={{ marginBottom: 18 }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap',
            padding: '18px 24px', borderBottom: `1px solid ${T.divider}`,
          }}>
            <PartyAvatar name={sel.name} party={sel.party} size={44} />
            <div style={{ minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 16.5, fontWeight: 700 }}>{sel.name}</span>
                <StatusPill status={sel.status} style={{ fontWeight: 600 }} />
                {isMonitored(sel) && (
                  <Pill c="#15803D" bg="#E6F5EC" style={{ fontWeight: 600 }}>● Active Monitoring</Pill>
                )}
              </div>
              <div style={{ fontSize: 12, color: T.muted, marginTop: 2 }}>
                {[officeText(sel.office), sel.party, sel.election?.name].filter(Boolean).join(' · ')}
              </div>
            </div>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <StatTile
                label="Last profile"
                value={selProfile ? fmtDate(selProfile.generated_at, 'EEE, MMM d') : 'None'}
              />
              <StatTile
                label="Game plan"
                value={selGp.total ? `${selGp.done} of ${selGp.total}` : 'None'}
              />
              <StatTile
                label="Voters in district"
                title="Rows from your uploaded voter lists that geocode inside this candidate's district"
                value={
                  !selDistrict ? '—'
                  : selBoundary === undefined ? '…'
                  : !selBoundary ? '—'
                  : selVoters == null ? '…'
                  : fmtInt(selVoters)
                }
              />
              <CtaButton onClick={() => nav(`/candidates/${sel.id}`)} style={{ padding: '9px 16px' }}>
                Open profile
              </CtaButton>
            </div>
          </div>

          <div className="bb-panel" style={{ display: 'grid', gridTemplateColumns: '1.3fr 1.1fr .95fr' }}>
            {/* digest */}
            <div style={{ padding: '18px 24px', minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 6 }}>
                {selDigest && <LivePulseDot />}
                <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.8px', color: T.muted }}>
                  THIS WEEK'S DIGEST
                </span>
                <span style={{ marginLeft: 'auto', fontSize: 10.5, color: T.faint }}>
                  {selDigest
                    ? `Week of ${fmtDate(selDigest.generated_at)}`
                    : selLatestDigest
                      ? `Last digest ${fmtDate(selLatestDigest.generated_at)}`
                      : 'No monitoring'}
                </span>
              </div>
              {selDigest ? (
                <>
                  <div style={{ fontSize: 12.5, lineHeight: 1.55, color: T.ink2 }}>
                    {selDigest.weekly_digest.summary}
                  </div>
                  <DigestItems items={selDigest.weekly_digest.items} />
                </>
              ) : isMonitored(sel) ? (
                <EmptyState
                  title={selLatestDigest ? 'No digest this week yet' : 'No digest written yet'}
                  body={selLatestDigest
                    ? `${sel.name} is being monitored. The most recent digest is from ${fmtDate(selLatestDigest.generated_at)}; this week's lands after the next Monday refresh.`
                    : `${sel.name} is being monitored. The first weekly digest lands after the next Monday refresh.`}
                />
              ) : (
                <EmptyState
                  title="Active Monitoring is off for this candidate"
                  body={
                    slots.left === Infinity
                      ? 'Turn it on from the candidate page for weekly Monday refreshes and digest updates.'
                      : slots.left > 0
                        ? `Turn it on from the candidate page for weekly Monday refreshes and digest updates — ${slots.left} bracket slot${slots.left === 1 ? '' : 's'} open.`
                        : `All ${slots.max} bracket slots are in use. Turn monitoring off for another candidate, or move up a bracket, to add this one.`
                  }
                  action={
                    <CtaButton onClick={() => nav(`/candidates/${sel.id}`)}>
                      Open {sel.name.split(' ')[0]}
                    </CtaButton>
                  }
                />
              )}
            </div>

            {/* game plan */}
            <div style={{ padding: '18px 24px', borderLeft: `1px solid ${T.divider}`, minWidth: 0 }}>
              <div style={{
                fontSize: 11, fontWeight: 700, letterSpacing: '.8px',
                color: T.muted, marginBottom: 13,
              }}>GAME PLAN — NEXT UP</div>
              {selGp.next.length ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
                  {selGp.next.map(m => (
                    <div key={m.id} style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                      <PhaseDot phase={m.phase} />
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{
                          fontSize: 12, fontWeight: 600, lineHeight: 1.4,
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }}>{m.title}</div>
                        <div style={{ fontSize: 10.5, color: T.faint }}>
                          {PHASE_MAP[m.phase]?.label || 'Unassigned'}
                        </div>
                      </div>
                      <DueChip milestone={m} />
                    </div>
                  ))}
                </div>
              ) : selGp.total ? (
                <EmptyState
                  title="Every milestone is done"
                  body="Nothing outstanding on this candidate's plan."
                />
              ) : (
                <EmptyState
                  title="No game plan yet"
                  body="Build one and the next milestones show up here."
                  action={<CtaButton onClick={() => nav('/game-plan')}>Open Game Plan</CtaButton>}
                />
              )}
            </div>

            {/* profiler */}
            <div style={{ padding: '18px 24px', borderLeft: `1px solid ${T.divider}`, minWidth: 0 }}>
              <div style={{
                fontSize: 11, fontWeight: 700, letterSpacing: '.8px',
                color: T.muted, marginBottom: 13,
              }}>PROFILER</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{
                  background: T.hover, border: `1px solid ${T.divider}`,
                  borderRadius: 10, padding: '10px 13px',
                }}>
                  <div style={{ fontSize: 10.5, color: T.faint }}>Profile status</div>
                  <div style={{ fontSize: 12.5, fontWeight: 600, marginTop: 2 }}>
                    {freshness(selProfile)}
                  </div>
                  <div style={{ fontSize: 10.5, color: T.faint, marginTop: 3, lineHeight: 1.45 }}>
                    {byCandidate[sel.id]?.length
                      ? `${byCandidate[sel.id].length} profile${byCandidate[sel.id].length === 1 ? '' : 's'} on file · neutral intel, not a rating`
                      : 'Neutral intel, not a rating'}
                  </div>
                </div>
                <button
                  type="button"
                  className="bb-row"
                  onClick={() => nav('/dossiers')}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 9, width: '100%',
                    border: `1px solid ${T.border}`, borderRadius: 10, padding: '9px 13px',
                    background: T.card, cursor: 'pointer', fontFamily: 'inherit',
                    color: 'inherit', textAlign: 'left',
                  }}
                >
                  <span style={{ fontSize: 13 }}>✦</span>
                  <span>
                    <span style={{ display: 'block', fontSize: 12, fontWeight: 600 }}>
                      {selProfile ? 'Refresh the profile' : 'Build a profile'}
                    </span>
                    <span style={{ display: 'block', fontSize: 10, color: T.faint }}>
                      {profileLimit === Infinity
                        ? 'Unlimited on your account'
                        : `${Math.max(0, profileLimit - (profilesUsed || 0))} of ${profileLimit} left this month`}
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  className="bb-row"
                  onClick={() => nav(hasFeature(plan, 'broadside') ? '/broadside' : '/plans')}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 9, width: '100%',
                    border: `1px solid ${T.border}`, borderRadius: 10, padding: '9px 13px',
                    background: T.card, cursor: 'pointer', fontFamily: 'inherit',
                    color: 'inherit', textAlign: 'left',
                  }}
                >
                  <span style={{ fontSize: 13 }}>⚔︎</span>
                  <span>
                    <span style={{ display: 'block', fontSize: 12, fontWeight: 600 }}>Spar in Broadside</span>
                    <span style={{ display: 'block', fontSize: 10, color: T.faint }}>
                      AI opponent uses this profile
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  className="bb-row"
                  onClick={() => nav('/voter-lists')}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 9, width: '100%',
                    border: `1px solid ${T.border}`, borderRadius: 10, padding: '9px 13px',
                    background: T.card, cursor: 'pointer', fontFamily: 'inherit',
                    color: 'inherit', textAlign: 'left',
                  }}
                >
                  <span style={{ fontSize: 13 }}>☰</span>
                  <span>
                    <span style={{ display: 'block', fontSize: 12, fontWeight: 600 }}>Voter lists</span>
                    <span style={{ display: 'block', fontSize: 10, color: T.faint }}>
                      {voterLists.length
                        ? `${voterLists.length} list${voterLists.length === 1 ? '' : 's'} imported · ${fmtInt(
                            voterLists.reduce((a, l) => a + (l.total_count || 0), 0)
                          )} rows`
                        : 'Import a CSV'}
                    </span>
                  </span>
                </button>
              </div>
            </div>
          </div>
        </Card>
      )}

      {/* ── bottom grid ── */}
      <div className="bb-bottom" style={{
        display: 'grid', gridTemplateColumns: '1.65fr 1fr', gap: 18, alignItems: 'start',
      }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18, minWidth: 0 }}>

          <Card style={{ padding: '20px 24px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 14 }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: T.red }} />
              <span style={{ fontSize: 14, fontWeight: 700 }}>Needs attention</span>
            </div>
            {attention.length ? (
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                {attention.map(item => (
                  <AttentionRow
                    key={item.key}
                    item={item}
                    onClick={item.candidateId ? () => nav(`/candidates/${item.candidateId}`) : undefined}
                  />
                ))}
              </div>
            ) : (
              <EmptyState
                title="Nothing needs attention"
                body="No controversy items in this week's digests, no overdue milestones, and no ballots inside 45 days for your candidates."
              />
            )}
          </Card>

          <Card style={{ padding: '20px 24px' }}>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 14 }}>
              <span style={{ fontSize: 14, fontWeight: 700 }}>Prospecting</span>
              <span style={{ marginLeft: 8, fontSize: 11.5, color: T.faint }}>AI lean classification</span>
              <TextLink onClick={() => nav('/prospecting')} style={{ marginLeft: 'auto' }}>
                Open Prospecting →
              </TextLink>
            </div>
            {prospects.length ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 13 }}>
                {prospects.slice(0, 4).map(p => <ProspectRow key={p.id} list={p} />)}
              </div>
            ) : (
              <EmptyState
                title="No prospect lists yet"
                body="Generate a list of candidates to work with, or import a CSV — each prospect gets an AI lean classification."
                action={<CtaButton onClick={() => nav('/prospecting')}>Open Prospecting</CtaButton>}
              />
            )}
          </Card>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 18, minWidth: 0 }}>

          <Card style={{ padding: '18px 20px' }}>
            <CardHead
              title="Election calendar"
              right={<TextLink onClick={() => nav('/elections')}>View all →</TextLink>}
            />
            <ElectionRows elections={upcoming.slice(0, 4)} hotId={nextRace?.id} />
          </Card>

          <Card style={{ padding: '18px 20px' }}>
            <CardHead
              title="Recent activity"
              sub="Actions logged on your own account — Badger Board does not record other seats' activity."
            />
            {activity.length ? (
              <>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 12 }}>
                  {(showAllActivity ? activity : activity.slice(0, ACTIVITY_PREVIEW_COUNT)).map(row => (
                    <div key={row.id} style={{ display: 'flex', gap: 10 }}>
                      <span style={{
                        flex: 'none', width: 26, height: 26, borderRadius: '50%',
                        background: T.red, color: '#fff', fontSize: 10, fontWeight: 700,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                      }}>{initialsOf(user?.user_metadata?.display_name || user?.email || 'You')}</span>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 12.5, lineHeight: 1.4 }}>
                          You {activityLine(row)}
                        </div>
                        <div style={{ fontSize: 10.5, color: T.faint, marginTop: 2 }}>
                          {relativeTime(row.created_at)}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
                {!showAllActivity && activity.length > ACTIVITY_PREVIEW_COUNT && (
                  <TextLink onClick={() => setShowAllActivity(true)} style={{ marginTop: 12 }}>
                    Show all activity ({activity.length}) →
                  </TextLink>
                )}
              </>
            ) : (
              <EmptyState
                title="No activity logged yet"
                body="Candidate edits, monitoring changes and record updates appear here as you make them."
              />
            )}
          </Card>
        </div>
      </div>

      <style>{`
        @media (max-width: 1200px) {
          .bb-panel { grid-template-columns: 1fr !important }
          .bb-panel > div + div { border-left: 0 !important; border-top: 1px solid ${T.divider} }
        }
        @media (max-width: 1100px) {
          .bb-bottom { grid-template-columns: 1fr !important }
        }
      `}</style>
    </DashboardShell>
  )
}
