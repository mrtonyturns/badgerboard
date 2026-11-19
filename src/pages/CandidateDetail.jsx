// CandidateDetail.jsx — the candidate profile page (route `candidates/:id`).
//
// Nov 2026 redesign ("it's a lot of stuff going on and everything looks the
// same"): a dark hero header (photo, name, party, office, election countdown,
// weekly watch switch, one primary action and a menu for the rest) over four
// tabs that each look different:
//
//   Overview       who they are, this week, a handful of number tiles
//   Intel          X & news · SWOT · Attack & defense · Allies (a Segmented
//                  control, no sub-tab rows)
//   Record         past races, roles, record in office, profile history
//   Notes & files  unchanged
//
// The Profile Data tab is gone (its cards were mostly empty or wrong); the
// basics are edited from the header's Edit dialog (candidate/EditCandidate).
//
// Nothing on this page is invented: every figure comes from a row (candidates,
// dossiers, incumbent_records, profile_views) or from the newest profile's own
// text (candidate/intelModel.js), and anything with nothing behind it is left
// out rather than shown as an empty panel.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { format, differenceInCalendarDays } from 'date-fns'
import {
  ArrowLeft, Lock, MoreHorizontal, Pencil, Trash2, Sparkles, Radar,
  LayoutGrid, Crosshair, Landmark, StickyNote,
} from 'lucide-react'
import {
  supabase, getCandidate, updateCandidate, deleteCandidate,
  getDossiers, getIncumbentRecords, logActivity,
} from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import LoadingBar from '../components/LoadingBar'
import { Tile, Avatar, Button, ICON_COLORS } from '../components/ui'
import {
  getUserTier, hasFeature, getUserPlanType,
  getMonitoringSlotMax, canMonitorCandidates, monitoringUnlockLabel,
} from '../lib/tiers'
import { monitoringToggleError } from '../lib/capErrors'
import { WebOnlyCta, NATIVE_PLAN_NOTE } from '../components/UpgradeCta'
import { partyHex, candidateStatusLabel } from '../lib/campaignEnums'
import { normalizePartyForDb } from '../lib/party'
import {
  ProfileStyles, Spinner, fmtDate, safeISO, categoryTarget, sectionTarget,
  isDigestItemUnread, useDistrictCounties, fetchDossierContent,
} from './candidate/shared'
import Overview from './candidate/Overview'
import IntelView, { INTEL_VIEWS, LEGACY_INTEL_VIEW } from './candidate/IntelViews'
import RecordView from './candidate/RecordViews'
import NotesFiles, { readLockState } from './candidate/NotesFiles'
import EditCandidate from './candidate/EditCandidate'
import { findXHandle } from './candidate/intelModel'
import { resolveSelfCandidate } from './dashboard/CandidateDashboard'

// ── Navigation model ─────────────────────────────────────────────────────────
const TABS = [
  { id: 'overview', label: 'Overview',      icon: LayoutGrid, color: ICON_COLORS.ink },
  { id: 'intel',    label: 'Intel',         icon: Crosshair,  color: ICON_COLORS.red },
  { id: 'record',   label: 'Record',        icon: Landmark,   color: ICON_COLORS.blue },
  { id: 'notes',    label: 'Notes & files', icon: StickyNote, color: ICON_COLORS.purple },
]
const TAB_IDS = new Set(TABS.map(t => t.id))
const INTEL_IDS = new Set(INTEL_VIEWS.map(v => v.value))

/**
 * ?group=&view= → { tab, view }. Accepts the pre-redesign ids too: the removed
 * Profile Data tab lands on Overview, News Feed / Opposition land on their
 * Intel replacements, and the three Record sub-tabs land on the one Record page.
 */
export function resolveRoute(group, view) {
  const tab = TAB_IDS.has(group) ? group : 'overview'
  if (tab !== 'intel') return { tab, view: null }
  const v = LEGACY_INTEL_VIEW[view] || view
  return { tab, view: INTEL_IDS.has(v) ? v : 'x' }
}

export default function CandidateDetail() {
  const { id } = useParams()
  const nav = useNavigate()
  const { user } = useAuth()
  const [searchParams, setSearchParams] = useSearchParams()

  const [candidate, setCandidate] = useState(null)
  const [dossiers, setDossiers]   = useState([])
  const [records, setRecords]     = useState([])
  const [loading, setLoading]     = useState(true)
  const [content, setContent]     = useState(null)
  const [contentLoading, setContentLoading] = useState(false)

  const [editing, setEditing] = useState(false)
  const [form, setForm]       = useState({})
  const [saving, setSaving]   = useState(false)
  const [saveError, setSaveError] = useState('')
  const [monitorError, setMonitorError] = useState('')   // why the last monitoring toggle failed
  const [monitorSaving, setMonitorSaving] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [lastViewed, setLastViewed] = useState(null)
  const [selfId, setSelfId] = useState(null)
  const [perspectiveChoice, setPerspectiveChoice] = useState(null)
  const viewMarkedRef = useRef(false)
  const menuRef = useRef(null)

  // The ⋯ menu closes on any click outside it or on Escape.
  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e) => { if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false) }
    const onKey = (e) => { if (e.key === 'Escape') setMenuOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('touchstart', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('touchstart', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  // Counties covered by this candidate's district, from the static places map.
  const districtCounties = useDistrictCounties(candidate?.office)

  // ── data ────────────────────────────────────────────────────────────────────
  const fetchAll = useCallback(async () => {
    const [{ data: c }, { data: d }, { data: ir }] = await Promise.all([
      getCandidate(id), getDossiers(id), getIncumbentRecords(id),
    ])
    setCandidate(c)
    setDossiers(d || [])
    setRecords(ir || [])
    return c
  }, [id])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    viewMarkedRef.current = false
    // React Router keeps this component mounted across :id changes, so an
    // edit session or a perspective flip on the previous candidate must not
    // carry over.
    setEditing(false); setSaveError(''); setMenuOpen(false); setPerspectiveChoice(null)
    setContent(null)
    fetchAll().finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [fetchAll])

  // The newest profile's text, read once and handed to every tab.
  const newestId = dossiers[0]?.id || null
  const newestRef = useRef(null)
  newestRef.current = dossiers[0] || null
  useEffect(() => {
    if (!newestId) { setContent(null); return }
    let cancelled = false
    setContentLoading(true)
    fetchDossierContent(newestRef.current).then(c => {
      if (!cancelled) { setContent(c || ''); setContentLoading(false) }
    })
    return () => { cancelled = true }
  }, [newestId])

  // Is this the user's own candidate? Same rule the dashboards use
  // (resolveSelfCandidate) — it decides whether the SWOT and Attack & defense
  // talk about how to USE a weakness or how to DEFEND it.
  useEffect(() => {
    if (!user?.id) return
    let cancelled = false
    supabase.from('candidates').select('id, name, election:elections(election_date)').eq('created_by', user.id)
      .then(({ data }) => { if (!cancelled) setSelfId(resolveSelfCandidate(user, data || [])?.id || null) })
    return () => { cancelled = true }
  }, [user])

  // ── Route → view sync ───────────────────────────────────────────────────────
  // A candidate URL with no ?group= always means "start on Overview", so both
  // are re-derived from the URL whenever the candidate or the params change.
  const route = resolveRoute(searchParams.get('group'), searchParams.get('view'))
  const tab = route.tab
  const intelView = route.view || 'x'

  const goto = (g, v = null) => {
    const next = { group: g }
    if (g === 'intel') next.view = v || 'x'
    setSearchParams(next, { replace: true })
    window.scrollTo?.({ top: 0, behavior: 'smooth' })
  }

  // Refresh just the candidate row — used after the AI lock endpoint returns.
  const refreshCandidate = async () => {
    const { data: c } = await getCandidate(id)
    if (c) setCandidate(c)
  }

  // ── unread tracking ─────────────────────────────────────────────────────────
  // Read the prior profile_views row first, hold it for the badge maths, and
  // only then stamp the new view. Best-effort: no table, no NEW badges.
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
      const dossierUnseen = isUnseenDossier(d)
      for (const it of (d.weekly_digest?.items || [])) {
        if (isDigestItemUnread(it, d, lastViewed, dossierUnseen)) items.push(it)
      }
    }
    const byView = {}
    for (const it of items) {
      const [, s] = categoryTarget(it.category)
      byView[s] = (byView[s] || 0) + 1
    }
    // A refresh that changed a section flags the Intel view that owns it.
    const newest = dossiers[0]
    if (newest && isUnseenDossier(newest)) {
      for (const s of (newest.refresh_diff?.sections || [])) {
        if (s.status !== 'new' && s.status !== 'updated') continue
        const [g, v] = sectionTarget(s.section)
        if (g === 'intel' && v && !byView[v]) byView[v] = Number(s.new_items) || 1
      }
    }
    const newDossiers = dossiers.filter(isUnseenDossier).length
    return { total: items.length, byView, newDossiers, lastViewed, isUnseenDossier, categoryTargetOf: categoryTarget }
  }, [dossiers, lastViewed])

  // ── derived ─────────────────────────────────────────────────────────────────
  const userTier = getUserTier(user)
  const canIntel = hasFeature(userTier, 'campaignIntel')
  // Gate on SLOTS, not features.weeklyProfile — see getMonitoringSlotMax().
  const canMonitor = canMonitorCandidates(user)
  const monitored = candidate?.section_timestamps?.monitoring === true
  const timestamps = candidate?.section_timestamps || {}
  const lock = candidate ? readLockState(candidate) : { locked: false }
  const xHandle = useMemo(() => findXHandle(candidate, content), [candidate, content])
  const perspective = perspectiveChoice || (selfId && selfId === id ? 'self' : 'opponent')

  // ── actions ─────────────────────────────────────────────────────────────────
  const openEdit = () => { setForm({ ...candidate }); setSaveError(''); setEditing(true); setMenuOpen(false) }

  const handleSave = async () => {
    setSaving(true); setSaveError('')
    try {
      const stamp = {
        updated_at: new Date().toISOString(),
        updated_by: user?.email || user?.user_metadata?.display_name || 'You',
      }
      const changedFields = Object.keys(form).filter(k => typeof form[k] !== 'object' && String(candidate[k] ?? '') !== String(form[k] ?? ''))
      const payload = {
        name: String(form.name || '').trim(),
        // "No party" is the empty option, and the candidates.party CHECK
        // accepts DB_PARTIES or NULL — never ''. normalizePartyForDb() turns
        // blank (and unknown free text) into null.
        party: normalizePartyForDb(form.party),
        status: form.status,
        office_id: form.office_id || null,
        election_id: form.election_id || null,
        is_incumbent: !!form.is_incumbent,
        website: form.website || null,
        twitter_handle: form.twitter_handle ? String(form.twitter_handle).trim().replace(/^@/, '') : null,
        facebook_url: form.facebook_url || null,
        instagram_handle: form.instagram_handle || null,
        linkedin_url: form.linkedin_url || null,
        research_context: form.research_context || null,
        // Preserves monitoring and every other key already on section_timestamps.
        section_timestamps: { ...(candidate.section_timestamps || {}), profile: stamp },
      }
      const photoChanged = String(form.photo_url ?? '') !== String(candidate.photo_url ?? '')
      let { error } = await updateCandidate(id, photoChanged ? { ...payload, photo_url: form.photo_url || null } : payload)
      // candidates.photo_url arrives with supabase/migrations/20261119000000;
      // until it is applied, save everything else and say why the photo didn't.
      let photoNote = ''
      if (error && photoChanged && /photo_url/i.test(String(error.message || ''))) {
        ;({ error } = await updateCandidate(id, payload))
        photoNote = 'Saved — except the photo, which needs a database update this site has not had yet.'
      }
      if (error) throw error
      logActivity('update', 'candidate', id, {
        candidate_name: payload.name, fields_changed: changedFields, changed_count: changedFields.length,
      }).catch(() => {})
      await fetchAll()
      if (photoNote) { setSaveError(photoNote); return }
      setEditing(false)
    } catch (err) {
      // The dialog stays open and filled on failure, so nothing typed is lost.
      const msg = String(err?.message || '')
      setSaveError(
        /check constraint/i.test(msg) && /party/i.test(msg)
          ? 'That party isn’t one this database accepts. Pick a party from the list (or “No party”) and save again — your other changes are still here.'
          : msg || 'Save failed'
      )
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    setMenuOpen(false)
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
    setMonitorError('')
    const newVal = !monitored
    if (newVal) {
      const maxSlots = getMonitoringSlotMax(user)
      if (maxSlots !== Infinity) {
        const { count, error: countErr } = await supabase
          .from('candidates')
          .select('id', { count: 'exact', head: true })
          .contains('section_timestamps', { monitoring: true })
        if (!countErr && count >= maxSlots) {
          setMonitorSaving(false)
          setMonitorError(`All ${maxSlots} active candidate slot${maxSlots === 1 ? '' : 's'} on your plan ${maxSlots === 1 ? 'is' : 'are'} in use. Turn monitoring off on another candidate, or upgrade your plan or bracket on the Plans page.`)
          return
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
      // Never snap the switch back in silence: show the `monitoring_cap`
      // trigger's own sentence when that is what fired, otherwise the real error.
      setMonitorError(monitoringToggleError(error))
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
      <div>
        <LoadingBar loading />
        <Spinner pad={80} />
      </div>
    )
  }

  if (!candidate) {
    return (
      <div className="px-5 py-20 text-center">
        <div className="mb-4 text-[16px] font-bold">Candidate not found.</div>
        <Button variant="dark" onClick={() => nav('/candidates')}>Back to Candidates</Button>
      </div>
    )
  }

  const pty = partyHex(candidate.party)
  const electionDate = safeISO(candidate.election?.election_date)
  const daysOut = electionDate ? differenceInCalendarDays(electionDate, new Date()) : null
  const officeLine = candidate.office
    ? [candidate.office.name, candidate.office.district_name].filter(Boolean).join(' — ')
    : null
  const place = candidate.office
    ? (districtCounties?.length
        ? `${districtCounties.slice(0, 3).join(', ')}${districtCounties.length === 1 ? ' County' : ' counties'}${districtCounties.length > 3 ? ` +${districtCounties.length - 3}` : ''}`
        : [candidate.office.city, candidate.office.county].filter(Boolean).join(', '))
    : null

  const tabBadge = (tid) => {
    if (tid === 'intel') return Object.values(unseen.byView).reduce((a, b) => a + b, 0)
    if (tid === 'record') return unseen.newDossiers
    return 0
  }

  const primaryLabel = dossiers.length ? 'Regenerate profile' : 'Generate profile'

  return (
    <div className="pb-6">
      <ProfileStyles />
      <LoadingBar loading={loading} />

      <button
        type="button"
        onClick={() => nav('/candidates')}
        className="mb-3 inline-flex items-center gap-1.5 rounded-lg py-1 text-[14px] font-semibold text-brand-mute hover:text-brand-ink"
      >
        <ArrowLeft className="h-4 w-4" /> Candidates
      </button>

      {/* ── hero header ── */}
      <Tile dark className="!overflow-visible p-5 md:p-8">
        <div className="flex flex-col gap-6 md:flex-row md:items-center">
          <div className="flex min-w-0 flex-1 items-center gap-4 md:gap-6">
            <div className="relative flex-shrink-0">
              <Avatar
                name={candidate.name}
                photo={candidate.photo_url || null}
                size={88}
                color={pty.c}
                className="ring-4 ring-white/15 max-md:!h-[68px] max-md:!w-[68px] max-md:!text-[24px]"
              />
            </div>
            <div className="min-w-0">
              <h1 className="text-[28px] font-extrabold leading-[1.05] tracking-display text-white md:text-[42px]">{candidate.name}</h1>
              <div className="mt-2.5 flex flex-wrap items-center gap-2">
                {candidate.party && (
                  <span className="rounded-full px-2.5 py-0.5 text-[12px] font-bold uppercase tracking-[0.06em]" style={{ background: pty.bg, color: pty.c }}>{candidate.party}</span>
                )}
                <span className="rounded-full bg-white/10 px-2.5 py-0.5 text-[12px] font-bold uppercase tracking-[0.06em] text-white/85">{candidateStatusLabel(candidate.status)}</span>
                {candidate.is_incumbent && <span className="rounded-full bg-[#FDF3E3] px-2.5 py-0.5 text-[12px] font-bold uppercase tracking-[0.06em] text-[#B45309]">Incumbent</span>}
                {perspective === 'self' && <span className="rounded-full bg-white px-2.5 py-0.5 text-[12px] font-bold uppercase tracking-[0.06em] text-brand-ink">Your candidate</span>}
              </div>
              <div className="mt-2 text-[15px] leading-snug text-white/75">
                {officeLine
                  ? <>{officeLine}{place && <span className="text-white/50"> · {place}</span>}</>
                  : <button type="button" onClick={openEdit} className="text-white/60 underline-offset-2 hover:text-white hover:underline">No office set — add one</button>}
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-4 md:items-end">
            {electionDate && (
              <div className="md:text-right">
                <div className="flex items-baseline gap-2 md:justify-end">
                  <span className="text-[44px] font-extrabold leading-none tracking-display text-white md:text-[52px]">
                    {daysOut != null && daysOut >= 0 ? daysOut : fmtDate(candidate.election.election_date, 'MMM d')}
                  </span>
                  {daysOut != null && daysOut >= 0 && <span className="text-[15px] font-medium text-white/70">{daysOut === 1 ? 'day' : 'days'} to go</span>}
                </div>
                <div className="mt-1 text-[14px] text-white/70">
                  {candidate.election.name} · {format(electionDate, 'EEE, MMM d, yyyy')}{daysOut != null && daysOut < 0 ? ' (past)' : ''}
                </div>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              {canMonitor ? (
                <button
                  type="button"
                  role="switch"
                  aria-checked={monitored}
                  aria-label={monitored ? `Turn off weekly watch for ${candidate.name}` : `Turn on weekly watch for ${candidate.name}`}
                  disabled={monitorSaving}
                  onClick={handleMonitoringToggle}
                  title={monitored ? 'Refreshes every Monday — free, no quota used' : 'Refresh this profile every Monday, free'}
                  className="inline-flex items-center gap-2.5 rounded-xl border border-white/15 bg-white/10 px-3.5 py-2.5 text-[14px] font-bold text-white hover:bg-white/15 disabled:cursor-wait"
                >
                  <Radar className="h-4 w-4" />
                  Weekly watch {monitored ? 'on' : 'off'}
                  <span className={`relative h-5 w-9 rounded-full transition-colors ${monitored ? 'bg-[#22C55E]' : 'bg-white/25'}`}>
                    <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${monitored ? 'left-[18px]' : 'left-0.5'}`} />
                  </span>
                </button>
              ) : (
                <span className="text-[13px] text-white/60">
                  Weekly watch starts on {monitoringUnlockLabel(getUserPlanType(user))}.{' '}
                  <WebOnlyCta native={NATIVE_PLAN_NOTE}>
                    <button type="button" onClick={() => nav('/plans')} className="font-bold text-white underline-offset-2 hover:underline">Upgrade</button>
                  </WebOnlyCta>
                </span>
              )}
              <button
                type="button"
                onClick={() => nav(`/dossiers?candidate=${id}`)}
                className="inline-flex items-center gap-2 rounded-xl bg-white px-4 py-2.5 text-[14px] font-bold text-brand-ink shadow-e2 hover:bg-white/90"
              >
                <Sparkles className="h-4 w-4" /> {primaryLabel}
              </button>
              <div className="relative" ref={menuRef}>
                <button
                  type="button"
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  aria-label="More actions"
                  onClick={() => setMenuOpen(o => !o)}
                  className="inline-flex h-[42px] w-[42px] items-center justify-center rounded-xl border border-white/15 bg-white/10 text-white hover:bg-white/15"
                >
                  <MoreHorizontal className="h-5 w-5" />
                </button>
                {menuOpen && (
                  <>
                    <div role="menu" className="absolute right-0 top-full z-[25] mt-2 w-48 overflow-hidden rounded-xl bg-white py-1 text-brand-ink shadow-e4">
                      <button type="button" role="menuitem" onClick={openEdit} className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-[14px] font-semibold hover:bg-black/5">
                        <Pencil className="h-4 w-4" /> Edit details
                      </button>
                      <button type="button" role="menuitem" onClick={handleDelete} className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-[14px] font-semibold text-[#B42318] hover:bg-[#FBEDEB]">
                        <Trash2 className="h-4 w-4" /> Delete candidate
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      </Tile>

      {monitorError && (
        <div className="mt-3 flex items-start gap-3 rounded-xl bg-[#FBEDEB] px-4 py-3 text-[14px] text-[#B42318]">
          <span className="flex-1">{monitorError}</span>
          <button type="button" onClick={() => setMonitorError('')} className="font-bold" aria-label="Dismiss">✕</button>
        </div>
      )}

      {/* ── group pill nav (SPEC §3) ── */}
      <nav className="mt-6" aria-label="Profile sections">
        <div className="grid grid-cols-4 gap-1 rounded-2xl bg-white p-1.5 shadow-e1 md:inline-flex md:gap-2">
          {TABS.map(t => {
            const on = t.id === tab
            const badge = tabBadge(t.id)
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => goto(t.id, t.id === 'intel' ? intelView : null)}
                aria-current={on ? 'page' : undefined}
                className={`relative flex flex-col items-center gap-1 whitespace-nowrap rounded-xl px-1 py-2 text-[12px] md:flex-row md:gap-2 md:px-4 md:py-2.5 md:text-[15px] font-bold transition-colors ${on ? 'bg-brand-ink text-white' : 'text-brand-mute hover:bg-black/5 hover:text-brand-ink'}`}
              >
                <t.icon className="h-[18px] w-[18px]" style={{ color: on ? '#fff' : t.color }} />
                {t.label}
                {t.id === 'intel' && !canIntel && <Lock className="h-3.5 w-3.5 opacity-60 max-md:absolute max-md:left-1.5 max-md:top-1.5" aria-label="Locked on your plan" />}
                {badge > 0 && <span className="max-md:absolute max-md:right-1 max-md:top-1 rounded-full bg-brand-red px-1.5 py-0.5 text-[11px] font-bold leading-none text-white">{badge}</span>}
                {t.id === 'notes' && lock.locked && <span className={`max-md:absolute max-md:right-1 max-md:top-1 max-md:text-[8px] rounded-full px-1.5 py-0.5 text-[10px] font-bold leading-none ${on ? 'bg-white/20 text-white' : 'bg-black/5 text-brand-mute'}`}>AI OFF</span>}
              </button>
            )
          })}
        </div>
      </nav>

      {/* ── unread strip (SPEC §2) ──
          Renders BELOW the nav: the unseen counts arrive a moment after first
          paint, and above the tabs this strip pushed them down under a finger
          already on its way to one. */}
      {monitored && unseen.total > 0 && (
        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-xl bg-[#FFF8EC] px-4 py-3">
          <span className="h-2 w-2 flex-shrink-0 animate-pulse rounded-full bg-brand-red" />
          <div className="min-w-0 text-[14px] text-brand-ink">
            <b>{unseen.total} new item{unseen.total === 1 ? '' : 's'}</b>
            {lastViewed ? ` since you last opened this profile on ${fmtDate(lastViewed)}` : ''} — from the latest refresh.
          </div>
          <Button variant="secondary" className="ml-auto !py-1.5" onClick={markAllRead}>Mark all read</Button>
        </div>
      )}

      {/* ── tabs ── */}
      <div className="mt-6">
        {tab === 'overview' && (
          <Overview
            candidate={candidate}
            dossiers={dossiers}
            content={content}
            monitored={monitored}
            canMonitor={canMonitor}
            canIntel={canIntel}
            unseen={unseen}
            xHandle={xHandle}
            onNavigate={goto}
            onToggleMonitoring={handleMonitoringToggle}
            onAcceptStatus={handleAcceptStatus}
            nav={nav}
          />
        )}

        {tab === 'intel' && (
          <IntelView
            candidate={candidate}
            dossiers={dossiers}
            content={content}
            contentLoading={contentLoading && !content}
            canIntel={canIntel}
            view={intelView}
            onView={(v) => goto('intel', v)}
            perspective={perspective}
            onPerspective={setPerspectiveChoice}
            xHandle={xHandle}
            lastViewed={lastViewed}
            unseenByView={unseen.byView}
            onRefresh={fetchAll}
            nav={nav}
          />
        )}

        {tab === 'record' && (
          <RecordView
            candidate={candidate}
            dossiers={dossiers}
            content={content}
            records={records}
            userId={user?.id}
            timestamps={timestamps}
            unseen={unseen}
            onRefresh={fetchAll}
            nav={nav}
          />
        )}

        {tab === 'notes' && (
          <NotesFiles
            candidate={candidate}
            userId={user?.id}
            userName={user?.user_metadata?.display_name || user?.email?.split('@')[0] || 'You'}
            onSaved={refreshCandidate}
            onLockChanged={refreshCandidate}
          />
        )}
      </div>

      {editing && (
        <EditCandidate
          form={form}
          setForm={setForm}
          saving={saving}
          error={saveError}
          onSave={handleSave}
          onCancel={() => { setEditing(false); setSaveError('') }}
        />
      )}
    </div>
  )
}
