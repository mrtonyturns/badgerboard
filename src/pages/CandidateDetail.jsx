// CandidateDetail.jsx — the candidate profile page (route `candidates/:id`),
// rebuilt to SPEC-candidate-profile.md against mockups/candidate-profile.dc.html.
//
// The eight flat tabs are replaced by four groups (Overview / Intel / Record /
// Notes & Files / Profile Data) with a sub-tab row, and an Overview that answers
// "what did this week's refresh actually produce?" from dossiers.weekly_digest
// and dossiers.refresh_diff.
//
// Nothing on this page is invented: every figure comes from a row (candidates,
// dossiers, incumbent_records, election_results, profile_views) and every card
// with no row renders an honest empty state instead of a zero.
//
// Shell tokens, category/status/party colors and plan limits are imported from
// the existing sources (pages/dashboard/shared, lib/campaignEnums, lib/tiers) —
// this file defines none of them.

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { format, differenceInCalendarDays } from 'date-fns'
import { Lock } from 'lucide-react'
import {
  supabase, getCandidate, updateCandidate, deleteCandidate,
  getDossiers, getIncumbentRecords, logActivity,
} from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import LoadingBar from '../components/LoadingBar'
import {
  getUserTier, hasFeature, getUserPlanType, getUserBracket,
  getBracketConfig, getActiveCandidateLimit, ADMIN_EMAILS,
} from '../lib/tiers'
import { partyHex, candidateStatusLabel, CANDIDATE_STATUS_HEX } from '../lib/campaignEnums'
import {
  T, ProfileStyles, Btn, Spinner, TextLink,
  fmtDate, safeISO, categoryTarget, sectionTarget, useBioSummary,
} from './candidate/shared'
import Overview from './candidate/Overview'
import { NewsFeedView, SwotView, OppositionView, AlliesView } from './candidate/IntelViews'
import { ElectionResultsView, IncumbentRecordView, ProfileHistoryView } from './candidate/RecordViews'
import ProfileData from './candidate/ProfileData'
import NotesFiles, { readLockState } from './candidate/NotesFiles'

// ── Navigation model (SPEC §3) ────────────────────────────────────────────────
const GROUPS = [
  { id: 'overview', label: 'Overview' },
  { id: 'intel',    label: 'Intel',    subs: [
    { id: 'news',       label: 'News Feed' },
    { id: 'swot',       label: 'SWOT' },
    { id: 'opposition', label: 'Opposition' },
    { id: 'allies',     label: 'Allies' },
  ] },
  { id: 'record',   label: 'Record',   subs: [
    { id: 'results',   label: 'Election Results' },
    { id: 'incumbent', label: 'Incumbent Record' },
    { id: 'history',   label: 'Profile History' },
  ] },
  { id: 'notes',    label: 'Notes & Files' },
  { id: 'data',     label: 'Profile Data' },
]

// The intel group is the plan-gated one — same rule the old tab bar used
// (`campaignIntel` gated intel / swot / opposition, and news / allies rendered
// their own locked card).
const GATED_SUBS = new Set(['news', 'swot', 'opposition', 'allies', 'history'])

export default function CandidateDetail() {
  const { id } = useParams()
  const nav = useNavigate()
  const { user, session } = useAuth()
  const [searchParams, setSearchParams] = useSearchParams()

  const [candidate, setCandidate] = useState(null)
  const [dossiers, setDossiers]   = useState([])
  const [records, setRecords]     = useState([])
  const [loading, setLoading]     = useState(true)

  const [group, setGroup] = useState(searchParams.get('group') || 'overview')
  const [sub, setSub]     = useState(searchParams.get('view') || null)

  const [editing, setEditing] = useState(false)
  const [form, setForm]       = useState({})
  const [saving, setSaving]   = useState(false)
  const [saveError, setSaveError] = useState('')

  const [monitorSaving, setMonitorSaving] = useState(false)
  const [lastViewed, setLastViewed] = useState(null)
  const viewMarkedRef = useRef(false)

  const bioSummary = useBioSummary(dossiers, candidate?.name, session)

  // ── data ────────────────────────────────────────────────────────────────────
  const fetchAll = async () => {
    const [{ data: c }, { data: d }, { data: ir }] = await Promise.all([
      getCandidate(id), getDossiers(id), getIncumbentRecords(id),
    ])
    setCandidate(c)
    setForm(c || {})
    setDossiers(d || [])
    setRecords(ir || [])
    return c
  }

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    viewMarkedRef.current = false
    fetchAll().finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [id])

  // Refresh just the candidate row — used after the AI lock endpoint returns so
  // ai_access_notes / ai_access_locked_at are re-read from the server.
  const refreshCandidate = async () => {
    const { data: c } = await getCandidate(id)
    if (c) { setCandidate(c); if (!editing) setForm(c) }
  }

  // ── unread tracking (SPEC §2) ───────────────────────────────────────────────
  // Read the prior profile_views row first, hold it for the badge maths, and
  // only then stamp the new view. The upsert is best-effort: if the table isn't
  // there yet the page still renders, it just shows no NEW badges.
  useEffect(() => {
    if (!user?.id || !id || loading || viewMarkedRef.current) return
    viewMarkedRef.current = true
    let cancelled = false
    ;(async () => {
      try {
        const { data } = await supabase
          .from('profile_views')
          .select('viewed_at')
          .eq('user_id', user.id)
          .eq('candidate_id', id)
          .maybeSingle()
        if (cancelled) return
        setLastViewed(data?.viewed_at || null)
        await supabase.from('profile_views').upsert(
          { user_id: user.id, candidate_id: id, viewed_at: new Date().toISOString() },
          { onConflict: 'user_id,candidate_id' },
        )
      } catch (err) {
        console.warn('[CandidateProfile] profile_views unavailable:', err?.message)
      }
    })()
    return () => { cancelled = true }
  }, [user?.id, id, loading])

  const markAllRead = async () => {
    const now = new Date().toISOString()
    setLastViewed(now)
    try {
      await supabase.from('profile_views').upsert(
        { user_id: user.id, candidate_id: id, viewed_at: now },
        { onConflict: 'user_id,candidate_id' },
      )
    } catch (err) {
      console.warn('[CandidateProfile] could not mark read:', err?.message)
    }
  }

  const unseen = useMemo(() => {
    const cutoff = lastViewed ? Date.parse(lastViewed) : null
    const isUnseenDossier = (d) => !!cutoff && !!d?.generated_at && Date.parse(d.generated_at) > cutoff
    const items = []
    for (const d of dossiers) {
      if (!isUnseenDossier(d)) continue
      for (const it of (d.weekly_digest?.items || [])) items.push(it)
    }
    const byView = {}
    for (const it of items) {
      const [, s] = categoryTarget(it.category)
      byView[s] = (byView[s] || 0) + 1
    }
    const newDossiers = dossiers.filter(isUnseenDossier).length
    if (newDossiers) byView.history = newDossiers
    return {
      total: items.length,
      byView,
      newDossiers,
      lastViewed,
      isUnseenDossier,
      categoryTargetOf: categoryTarget,
    }
  }, [dossiers, lastViewed])

  // refresh_diff on the newest dossier drives the UPDATED badges on the views
  // that own each changed section.
  const diffFlags = useMemo(() => {
    const d = dossiers[0]
    if (!d || !unseen.isUnseenDossier(d)) return {}
    const flags = {}
    for (const s of (d.refresh_diff?.sections || [])) {
      if (s.status !== 'new' && s.status !== 'updated') continue
      const [, viewId] = sectionTarget(s.section)
      if (viewId) flags[viewId] = true
    }
    return flags
  }, [dossiers, unseen])

  // ── derived ─────────────────────────────────────────────────────────────────
  const userTier = getUserTier(user)
  const canIntel = hasFeature(userTier, 'campaignIntel')
  const canMonitor = hasFeature(userTier, 'weeklyProfile')
  const monitored = candidate?.section_timestamps?.monitoring === true
  const timestamps = candidate?.section_timestamps || {}
  const weaknesses = candidate?.weaknesses || []
  const lock = candidate ? readLockState(candidate) : { locked: false }

  const goto = (g, s = null) => {
    setGroup(g)
    const target = GROUPS.find(x => x.id === g)
    const nextSub = s || target?.subs?.[0]?.id || null
    setSub(nextSub)
    const next = { group: g }
    if (nextSub) next.view = nextSub
    setSearchParams(next, { replace: true })
  }

  // ── actions ─────────────────────────────────────────────────────────────────
  const handleSave = async () => {
    setSaving(true); setSaveError('')
    try {
      const cleanEmail = (form.email || '').split(',').map(v => v.trim()).filter(Boolean).join(',')
      const stamp = {
        updated_at: new Date().toISOString(),
        updated_by: user?.email || user?.user_metadata?.display_name || 'You',
      }
      // Preserves monitoring / monitoring_updated_at and every other key already
      // stored on section_timestamps, and stamps the four Profile Data cards.
      const newTimestamps = {
        ...(candidate.section_timestamps || {}),
        profile: stamp, contact: stamp, campaign: stamp, finance: stamp, background: stamp,
      }
      const changedFields = Object.keys(form).filter(k => String(candidate[k] ?? '') !== String(form[k] ?? ''))
      const { error } = await updateCandidate(id, {
        name: form.name, party: form.party, status: form.status,
        email: cleanEmail, phone: form.phone, website: form.website,
        campaign_address: form.campaign_address, campaign_city: form.campaign_city,
        campaign_zip: form.campaign_zip, campaign_committee: form.campaign_committee,
        campaign_manager: form.campaign_manager, treasurer: form.treasurer,
        occupation: form.occupation, employer: form.employer,
        bio_summary: form.bio_summary,
        research_context: form.research_context || null,
        twitter_handle: form.twitter_handle, facebook_url: form.facebook_url,
        instagram_handle: form.instagram_handle,
        total_raised: form.total_raised || null,
        total_spent: form.total_spent || null,
        cash_on_hand: form.cash_on_hand || null,
        is_incumbent: form.is_incumbent || false,
        incumbent_since: form.incumbent_since || null,
        section_timestamps: newTimestamps,
      })
      if (error) throw error
      logActivity('update', 'candidate', id, {
        candidate_name: form.name,
        fields_changed: changedFields,
        changed_count: changedFields.length,
      }).catch(() => {})
      setEditing(false)
      await fetchAll()
    } catch (err) {
      setSaveError(err.message || 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!window.confirm(`Delete ${candidate.name}? This cannot be undone.`)) return
    logActivity('delete', 'candidate', id, { candidate_name: candidate.name }).catch(() => {})
    await deleteCandidate(id)
    nav('/candidates')
  }

  const handleAcceptStatus = async (newStatus) => {
    const { error } = await updateCandidate(id, { status: newStatus })
    if (error) { console.error('[CandidateProfile] status update failed:', error); return }
    await fetchAll()
  }

  // Slot-limit enforcement mirrors Candidates.jsx so this toggle can't bypass
  // the cap enforced there.
  const handleMonitoringToggle = async () => {
    if (!canMonitor || !candidate) return
    setMonitorSaving(true)
    const newVal = !monitored
    if (newVal) {
      const isAdmin = user?.email && ADMIN_EMAILS.includes(user.email.toLowerCase())
      if (!isAdmin) {
        const maxSlots = getUserPlanType(user) === 'candidate'
          ? getActiveCandidateLimit(userTier)
          : (getBracketConfig(getUserBracket(user))?.max ?? Infinity)
        if (maxSlots !== Infinity) {
          const { count, error: countErr } = await supabase
            .from('candidates')
            .select('id', { count: 'exact', head: true })
            .contains('section_timestamps', { monitoring: true })
          if (!countErr && count >= maxSlots) {
            setMonitorSaving(false)
            window.alert(`All ${maxSlots} active candidate slot${maxSlots === 1 ? '' : 's'} on your plan ${maxSlots === 1 ? 'is' : 'are'} in use. Upgrade your plan or bracket on the Plans page to monitor more candidates.`)
            return
          }
        }
      }
    }
    const prevTimestamps = candidate.section_timestamps
    const newTimestamps = {
      ...(candidate.section_timestamps || {}),
      monitoring: newVal,
      monitoring_updated_at: new Date().toISOString(),
      monitoring_updated_by: user?.email || 'You',
    }
    setCandidate(prev => prev ? { ...prev, section_timestamps: newTimestamps } : prev)
    const { error } = await updateCandidate(id, { section_timestamps: newTimestamps })
    if (error) {
      setCandidate(prev => prev ? { ...prev, section_timestamps: prevTimestamps } : prev)
    } else {
      logActivity(newVal ? 'enable_monitoring' : 'disable_monitoring', 'candidate', id, {
        candidate_name: candidate.name,
      }).catch(() => {})
    }
    setMonitorSaving(false)
  }

  // ── render ──────────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div style={{ fontFamily: T.font }}>
        <LoadingBar loading />
        <Spinner pad={80} />
      </div>
    )
  }

  if (!candidate) {
    return (
      <div style={{ fontFamily: T.font, textAlign: 'center', padding: '80px 20px' }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Candidate not found.</div>
        <Btn kind="primary" onClick={() => nav('/candidates')}>Back to Candidates</Btn>
      </div>
    )
  }

  const activeGroup = GROUPS.find(g => g.id === group) || GROUPS[0]
  const subList = activeGroup.subs || []
  const activeSub = subList.length ? (subList.find(s => s.id === sub)?.id || subList[0].id) : null
  const view = subList.length ? activeSub : activeGroup.id

  const pty = partyHex(candidate.party)
  const stat = CANDIDATE_STATUS_HEX[candidate.status] || { c: T.ink3, bg: T.chip }
  const electionDate = safeISO(candidate.election?.election_date)
  const daysOut = electionDate ? differenceInCalendarDays(electionDate, new Date()) : null
  const hot = daysOut != null && daysOut >= 0 && daysOut <= 30

  const groupBadge = (gid) => {
    if (gid === 'intel') {
      return (unseen.byView.news || 0) + (unseen.byView.swot || 0)
        + (unseen.byView.opposition || 0) + (unseen.byView.allies || 0)
    }
    if (gid === 'record') return unseen.newDossiers
    return 0
  }

  const monitoringPill = canMonitor ? (
    <>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 9, minHeight: 44,
        background: monitored ? '#F0FAF4' : '#FAFAF9',
        border: `1px solid ${monitored ? '#CFEBDC' : T.border}`,
        borderRadius: 99, padding: '6px 13px 6px 10px',
      }}>
        <span style={{
          width: 7, height: 7, borderRadius: '50%',
          background: monitored ? '#15803D' : '#C0BFBA',
        }} />
        <span style={{ fontSize: 11.5, fontWeight: 700, color: monitored ? '#15803D' : T.muted }}>
          {monitored ? 'Active Monitoring on' : 'Active Monitoring off'}
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={monitored}
          aria-label={monitored
            ? `Turn off Active Monitoring for ${candidate.name}`
            : `Turn on Active Monitoring for ${candidate.name}`}
          disabled={monitorSaving}
          onClick={handleMonitoringToggle}
          style={{
            width: 30, height: 17, borderRadius: 99, border: 0, padding: 0, position: 'relative',
            background: monitored ? '#15803D' : '#D6D6D2',
            cursor: monitorSaving ? 'wait' : 'pointer', flexShrink: 0,
          }}
        >
          <span style={{
            position: 'absolute', top: 2, left: monitored ? 15 : 2, width: 13, height: 13,
            borderRadius: '50%', background: '#fff', transition: 'left .15s ease',
          }} />
        </button>
      </div>
      <div style={{ fontSize: 10.5, color: T.faint, maxWidth: 230, lineHeight: 1.4 }}>
        {monitored
          ? 'Refreshes every Monday — free, no quota used'
          : 'Enable to refresh this profile weekly, free of charge'}
      </div>
    </>
  ) : (
    <div style={{ fontSize: 11, color: T.muted, maxWidth: 260, lineHeight: 1.5 }}>
      <span style={{ fontWeight: 600 }}>Active Monitoring</span> refreshes {candidate.name}&rsquo;s profile every
      week, free of charge. Available on the Campaign and Agency plans.{' '}
      <TextLink onClick={() => nav('/plans')} style={{ color: T.red, fontWeight: 600 }}>Upgrade →</TextLink>
    </div>
  )

  return (
    <div
      className="-m-4 md:-m-6 lg:-m-8 p-4 md:p-6 lg:p-8"
      style={{ background: T.page, minHeight: '100%', fontFamily: T.font, color: T.ink }}
    >
      <ProfileStyles />
      <LoadingBar loading={loading} />

      <TextLink onClick={() => nav('/candidates')} style={{ fontSize: 12, marginBottom: 16, display: 'block' }}>
        ← Back to Candidates
      </TextLink>

      {/* ── header card (SPEC §1) ── */}
      <div style={{
        background: '#fff', border: `1px solid ${T.border}`, borderRadius: 16,
        padding: '20px 24px', boxShadow: '0 1px 3px rgba(0,0,0,.03)', marginBottom: 14,
      }}>
        <div className="cp-head" style={{ display: 'flex', alignItems: 'flex-start', gap: 16 }}>
          <div style={{
            flexShrink: 0, width: 56, height: 56, borderRadius: 16,
            background: pty.bg, color: pty.c, display: 'flex', alignItems: 'center',
            justifyContent: 'center', fontWeight: 800, fontSize: 22,
          }}>{(candidate.name || '?').charAt(0).toUpperCase()}</div>

          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 23, fontWeight: 700, letterSpacing: '-.3px' }}>{candidate.name}</span>
              {candidate.party && (
                <span style={{
                  fontSize: 10, fontWeight: 700, background: pty.bg, color: pty.c,
                  borderRadius: 99, padding: '3px 9px', textTransform: 'uppercase',
                }}>{candidate.party}</span>
              )}
              <span style={{
                fontSize: 10, fontWeight: 700, background: stat.bg, color: stat.c,
                borderRadius: 99, padding: '3px 9px', textTransform: 'uppercase',
              }}>{candidateStatusLabel(candidate.status)}</span>
              {candidate.is_incumbent && (
                <span style={{
                  fontSize: 10, fontWeight: 700, background: '#FDF3E3', color: T.warmInk,
                  borderRadius: 99, padding: '3px 9px',
                }}>INCUMBENT</span>
              )}
            </div>

            <div style={{
              display: 'flex', alignItems: 'center', gap: 8, marginTop: 7,
              fontSize: 12.5, color: T.ink3, flexWrap: 'wrap',
            }}>
              {candidate.office ? (
                <>
                  <span style={{ fontWeight: 600 }}>{candidate.office.name}</span>
                  {candidate.office.district_name && (
                    <>
                      <span style={{ color: '#C0BFBA' }}>—</span>
                      <span>{candidate.office.district_name}</span>
                    </>
                  )}
                  {(candidate.office.county || candidate.office.city) && (
                    <>
                      <span style={{ color: '#C0BFBA' }}>·</span>
                      <span>{[candidate.office.city, candidate.office.county].filter(Boolean).join(', ')}</span>
                    </>
                  )}
                </>
              ) : (
                <span style={{ color: T.faint }}>No office linked — set one under Profile Data</span>
              )}
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 5, fontSize: 12.5, color: T.ink3, flexWrap: 'wrap' }}>
              {candidate.election ? (
                <>
                  <span>{candidate.election.name}</span>
                  {electionDate && (
                    <>
                      <span style={{ color: '#C0BFBA' }}>·</span>
                      <span style={{ fontWeight: hot ? 700 : 400, color: hot ? T.red : T.ink3 }}>
                        {format(electionDate, 'EEEE, MMM d')}
                        {daysOut != null && daysOut >= 0
                          ? ` — ${daysOut === 0 ? 'today' : `${daysOut} day${daysOut === 1 ? '' : 's'} out`}`
                          : ' — past'}
                      </span>
                    </>
                  )}
                </>
              ) : (
                <span style={{ color: T.faint }}>No election linked — no countdown to show</span>
              )}
            </div>
          </div>

          <div className="cp-headright" style={{
            flexShrink: 0, display: 'flex', flexDirection: 'column',
            alignItems: 'flex-end', gap: 9,
          }}>
            {monitoringPill}
            <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
              {editing ? (
                <>
                  <Btn onClick={() => { setEditing(false); setForm({ ...candidate }); setSaveError('') }}>Cancel</Btn>
                  <Btn kind="primary" onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Btn>
                </>
              ) : (
                <>
                  <Btn onClick={() => { setEditing(true); setForm({ ...candidate }); goto('data') }}>Edit</Btn>
                  <Btn kind="primary" onClick={() => nav(`/dossiers?candidate=${id}`)}>Regenerate profile</Btn>
                  <Btn onClick={handleDelete} title={`Delete ${candidate.name}`}>Delete</Btn>
                </>
              )}
            </div>
            {saveError && <div style={{ fontSize: 11.5, color: T.redHot }}>{saveError}</div>}
          </div>
        </div>
      </div>

      {/* ── unread strip (SPEC §2) ── */}
      {monitored && unseen.total > 0 && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 11, background: T.warmBg,
          border: `1px solid ${T.warmBr}`, borderRadius: 12, padding: '11px 16px',
          marginBottom: 14, flexWrap: 'wrap',
        }}>
          <span style={{
            flexShrink: 0, width: 7, height: 7, borderRadius: '50%',
            background: T.red, animation: 'cpPulse 2s infinite',
          }} />
          <div style={{ fontSize: 12.5, minWidth: 0 }}>
            <span style={{ fontWeight: 700 }}>
              {unseen.total} new item{unseen.total === 1 ? '' : 's'}
            </span>
            {lastViewed ? ` since you last opened this profile on ${fmtDate(lastViewed)}` : ''}
            {' — from the latest refresh.'}
          </div>
          <button
            type="button"
            onClick={markAllRead}
            style={{
              marginLeft: 'auto', flexShrink: 0, border: '1px solid #E8D5C0', background: 'transparent',
              borderRadius: 99, padding: '8px 13px', fontSize: 11.5, fontWeight: 600,
              fontFamily: 'inherit', cursor: 'pointer', minHeight: 34,
            }}
          >Mark all read</button>
        </div>
      )}

      {/* ── group pill nav (SPEC §3) ── */}
      <div className="cp-nav" style={{
        display: 'flex', alignItems: 'center', gap: 4, background: T.chip,
        borderRadius: 99, padding: 4, marginBottom: 10, width: 'fit-content', maxWidth: '100%',
      }}>
        {GROUPS.map(g => {
          const on = g.id === group
          const badge = groupBadge(g.id)
          const showAiOff = g.id === 'notes' && lock.locked
          const showLock = g.id === 'intel' && !canIntel
          return (
            <button
              key={g.id}
              type="button"
              onClick={() => goto(g.id)}
              style={{
                display: 'flex', alignItems: 'center', gap: 7, borderRadius: 99, padding: '9px 16px',
                fontSize: 12.5, fontWeight: on ? 600 : 500, color: on ? T.ink : T.muted,
                background: on ? '#fff' : 'transparent',
                boxShadow: on ? '0 1px 2px rgba(0,0,0,.06)' : 'none',
                border: 0, fontFamily: 'inherit', cursor: 'pointer', whiteSpace: 'nowrap', minHeight: 36,
              }}
            >
              {g.label}
              {showLock && <Lock size={11} color={T.faint} aria-label="Locked on your plan" />}
              {badge > 0 && (
                <span style={{
                  fontSize: 9.5, fontWeight: 700, background: T.red, color: '#fff',
                  borderRadius: 99, padding: '2px 6px',
                }}>{badge}</span>
              )}
              {showAiOff && (
                <span style={{
                  fontSize: 9, fontWeight: 700, background: '#E4E7EC', color: '#4B5563',
                  borderRadius: 99, padding: '2px 6px', letterSpacing: '.3px',
                }}>AI OFF</span>
              )}
            </button>
          )
        })}
      </div>

      {/* ── sub-tab underline row ── */}
      {subList.length > 0 && (
        <div className="cp-nav" style={{
          display: 'flex', alignItems: 'center', gap: 18,
          borderBottom: `1px solid ${T.border}`, marginBottom: 18, padding: '0 2px',
        }}>
          {subList.map(s => {
            const on = s.id === activeSub
            const n = unseen.byView[s.id] || 0
            const locked = GATED_SUBS.has(s.id) && !canIntel
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => goto(group, s.id)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6, padding: '12px 0', marginBottom: -1,
                  borderBottom: `2px solid ${on ? T.red : 'transparent'}`,
                  borderTop: 0, borderLeft: 0, borderRight: 0, background: 'none',
                  fontSize: 12.5, fontWeight: on ? 600 : 500, color: on ? T.red : T.muted,
                  fontFamily: 'inherit', cursor: 'pointer', whiteSpace: 'nowrap', minHeight: 44,
                }}
              >
                {s.label}
                {locked && <Lock size={11} color={T.faint} aria-label="Locked on your plan" />}
                {n > 0 && (
                  <span style={{
                    fontSize: 9, fontWeight: 700, background: '#FBEAEA', color: T.red,
                    borderRadius: 99, padding: '2px 6px',
                  }}>{n} new</span>
                )}
                {s.id === 'incumbent' && records.length > 0 && (
                  <span style={{
                    fontSize: 9, fontWeight: 700, background: '#FDF3E3', color: T.warmInk,
                    borderRadius: 99, padding: '2px 6px',
                  }}>{records.length}</span>
                )}
              </button>
            )
          })}
        </div>
      )}

      {/* ── views ── */}
      {view === 'overview' && (
        <Overview
          candidate={candidate}
          dossiers={dossiers}
          monitored={monitored}
          canMonitor={canMonitor}
          unseen={unseen}
          bioSummary={bioSummary}
          onNavigate={goto}
          onToggleMonitoring={handleMonitoringToggle}
          onAcceptStatus={handleAcceptStatus}
          incumbentRecordCount={records.length}
          nav={nav}
        />
      )}

      {view === 'news' && (
        <NewsFeedView
          candidate={candidate}
          dossiers={dossiers}
          canIntel={canIntel}
          lastViewed={lastViewed}
          nav={nav}
        />
      )}

      {view === 'swot' && (
        <SwotView
          candidate={candidate}
          dossiers={dossiers}
          canIntel={canIntel}
          swotUpdated={!!diffFlags.swot}
          onRefresh={fetchAll}
          nav={nav}
        />
      )}

      {view === 'opposition' && (
        <OppositionView
          candidate={candidate}
          dossiers={dossiers}
          canIntel={canIntel}
          weaknesses={weaknesses}
          oppositionUpdated={!!diffFlags.opposition}
          nav={nav}
        />
      )}

      {view === 'allies' && (
        <AlliesView
          candidate={candidate}
          dossiers={dossiers}
          canIntel={canIntel}
          alliesUpdated={!!diffFlags.allies}
          nav={nav}
        />
      )}

      {view === 'results' && <ElectionResultsView candidate={candidate} nav={nav} />}

      {view === 'incumbent' && (
        <IncumbentRecordView
          candidate={candidate}
          records={records}
          dossiers={dossiers}
          userId={user?.id}
          timestamps={timestamps}
          onRefresh={fetchAll}
        />
      )}

      {view === 'history' && (
        <ProfileHistoryView
          candidate={candidate}
          dossiers={dossiers}
          canIntel={canIntel}
          unseen={unseen}
          nav={nav}
        />
      )}

      {view === 'notes' && (
        <NotesFiles
          candidate={candidate}
          userId={user?.id}
          userName={user?.user_metadata?.display_name || user?.email?.split('@')[0] || 'You'}
          onSaved={refreshCandidate}
          onLockChanged={refreshCandidate}
        />
      )}

      {view === 'data' && (
        <ProfileData
          candidate={candidate}
          editing={editing}
          form={form}
          setForm={setForm}
          timestamps={timestamps}
        />
      )}
    </div>
  )
}
