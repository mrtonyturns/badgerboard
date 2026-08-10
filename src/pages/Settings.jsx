// src/pages/Settings.jsx — Settings shell: hero, grouped rail, one pane at a
// time, and the unsaved-changes bar.
//
// Routing: /settings is the default pane (Your account) and /settings/:pane
// deep-links the rest (/settings/plan, /settings/security, …). Legacy hash
// links that still exist across the app and in Stripe emails
// (/settings#billing, #security, #calendars) are normalised to their pane.
//
// This file owns the data every pane shares — real usage counts, notification
// preferences, the org-level AI default — and the billing/cancel/delete flows.
// The panes themselves are in src/pages/settings/.

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useLocation, useParams } from 'react-router-dom'
import {
  User, Shield, CreditCard, Bell, CalendarDays, Lock,
  Loader2, AlertTriangle, X, Trash2, CheckCircle, AlertCircle, ArrowRight, ChevronRight,
} from 'lucide-react'
import { useAuth } from '../contexts/AuthContext'
import { supabase, logActivity } from '../lib/supabase'
import {
  getUserPlan, getUserPlanType, getUserBracket, getBracketConfig,
  getEffectiveProfileLimit, getActiveCandidateLimit, ADMIN_EMAILS,
} from '../lib/tiers'
import { SettingsShell, Btn, Pill, T } from './settings/shared'
import AccountPane from './settings/AccountPane'
import SecurityPane from './settings/SecurityPane'
import PlanPane from './settings/PlanPane'
import NotificationsPane from './settings/NotificationsPane'
import CalendarsPane from './settings/CalendarsPane'
import PrivacyPane from './settings/PrivacyPane'

// ── Month boundary ────────────────────────────────────────────────────────────
// Copied verbatim from src/pages/Dossiers.jsx (the Profiler library) so the two
// monthly counters can never drift apart. See the usage query below.
const startOfThisMonth = () => {
  const d = new Date()
  d.setDate(1); d.setHours(0, 0, 0, 0)
  return d
}

// ── Rail ──────────────────────────────────────────────────────────────────────

const NAV_GROUPS = [
  { label: 'ACCOUNT', items: [
    { id: 'account',       label: 'Your account',  Icon: User },
    { id: 'security',      label: 'Security',      Icon: Shield, badge: '2FA OFF' },
  ] },
  { label: 'PLAN', items: [
    { id: 'plan',          label: 'Plan & billing', Icon: CreditCard },
  ] },
  { label: 'PREFERENCES', items: [
    { id: 'notifications', label: 'Notifications',  Icon: Bell },
    { id: 'calendars',     label: 'Calendars',      Icon: CalendarDays },
  ] },
  { label: 'DATA', items: [
    { id: 'privacy',       label: 'Data & privacy', Icon: Lock },
  ] },
]
const NAV_ITEMS = NAV_GROUPS.flatMap(g => g.items)
const PANE_IDS  = NAV_ITEMS.map(i => i.id)
const DEFAULT_PANE = 'account'

// Legacy in-app and email deep links (/settings#billing etc.) → panes.
const HASH_TO_PANE = {
  billing: 'plan', plan: 'plan', security: 'security', calendars: 'calendars',
  notifications: 'notifications', privacy: 'privacy', account: 'account',
}

const NOTIF_KEYS = ['payment_failed', 'payment_receipt', 'plan_changed', 'account_locked', 'dossier_ready']
const readPrefs = (row) => NOTIF_KEYS.reduce((acc, k) => ({ ...acc, [k]: row?.[k] ?? true }), {})

export default function Settings() {
  const { user, session, signOut, refreshSession, isDowngradeLocked, downgradedAt } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const { pane: paneParam } = useParams()

  // ── Which pane ──────────────────────────────────────────────────────────────
  const hashPane = HASH_TO_PANE[location.hash.replace('#', '')] || null
  const pane = PANE_IDS.includes(paneParam) ? paneParam : (hashPane || DEFAULT_PANE)

  useEffect(() => {
    // Normalise legacy hash links and unknown panes onto a real URL.
    if (hashPane) { navigate(`/settings/${hashPane}`, { replace: true }); return }
    if (paneParam && !PANE_IDS.includes(paneParam)) navigate('/settings', { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hashPane, paneParam])

  const goPane = (id) => {
    navigate(id === DEFAULT_PANE ? '/settings' : `/settings/${id}`)
    if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  // ── Plan facts ──────────────────────────────────────────────────────────────
  const plan         = getUserPlan(user)
  const planType     = getUserPlanType(user)
  const bracketCfg   = getBracketConfig(getUserBracket(user))
  const profileLimit = getEffectiveProfileLimit(user)
  const isAdmin      = !!user?.email && ADMIN_EMAILS.includes(user.email.toLowerCase())
  // Monitoring slot accounting mirrors Candidates.jsx exactly.
  const maxSlots = isAdmin
    ? Infinity
    : planType === 'candidate'
      ? getActiveCandidateLimit(plan)
      : (bracketCfg?.max ?? Infinity)

  // ── Real usage counts ───────────────────────────────────────────────────────
  const [usage, setUsage] = useState({ loading: true, profilesUsed: 0, monitored: 0, candidates: 0 })

  useEffect(() => {
    if (!supabase || !user?.id) return
    let alive = true
    ;(async () => {
      const [monthly, candidates, monitored] = await Promise.all([
        // SAME QUERY SHAPE as the Profiler library's monthly counter in
        // src/pages/Dossiers.jsx → fetchData():
        //   supabase.from('dossiers').select('id')
        //     .gte('generated_at', startOfThisMonth().toISOString())
        //     .eq('generated_by', user.id).not('generated_by', 'is', null)
        // Only the user's own manual generations draw down the monthly
        // allowance; auto-refreshes have generated_by = null and are free.
        // If you change one of these, change the other — otherwise Settings and
        // the Profiler will disagree about how many profiles are left.
        supabase.from('dossiers').select('id')
          .gte('generated_at', startOfThisMonth().toISOString())
          .eq('generated_by', user.id).not('generated_by', 'is', null),
        supabase.from('candidates').select('id', { count: 'exact', head: true })
          .eq('created_by', user.id),
        supabase.from('candidates').select('id', { count: 'exact', head: true })
          .eq('created_by', user.id).contains('section_timestamps', { monitoring: true }),
      ])
      if (!alive) return
      setUsage({
        loading: false,
        profilesUsed: (monthly.data || []).length,
        candidates: candidates.count ?? 0,
        monitored: monitored.count ?? 0,
      })
    })().catch(() => { if (alive) setUsage(u => ({ ...u, loading: false })) })
    return () => { alive = false }
  }, [user?.id])

  // ── Live share links (Data & privacy) ───────────────────────────────────────
  const [shares, setShares] = useState({ loading: true, count: 0 })
  useEffect(() => {
    if (!supabase || !user?.id) return
    let alive = true
    supabase.from('dossier_shares').select('id', { count: 'exact', head: true })
      .eq('created_by', user.id).eq('is_active', true).gt('expires_at', new Date().toISOString())
      .then(({ count }) => { if (alive) setShares({ loading: false, count: count ?? 0 }) })
      .catch(() => { if (alive) setShares({ loading: false, count: 0 }) })
    return () => { alive = false }
  }, [user?.id])

  // ── Profile fields + unsaved-changes bar ────────────────────────────────────
  const metaName = user?.user_metadata?.display_name || ''
  const metaOrg  = user?.user_metadata?.business || ''
  const [savedName, setSavedName] = useState(metaName)
  const [savedOrg, setSavedOrg]   = useState(metaOrg)
  const [nameField, setNameField] = useState(metaName)
  const [orgField, setOrgField]   = useState(metaOrg)
  const [savingProfile, setSavingProfile] = useState(false)
  const [formMsg, setFormMsg]     = useState(null)

  const nameDirty  = nameField.trim() !== savedName.trim()
  const orgDirty   = orgField.trim() !== savedOrg.trim()
  const dirtyCount = (nameDirty ? 1 : 0) + (orgDirty ? 1 : 0)
  const dirtyRef   = useRef(dirtyCount)
  useEffect(() => { dirtyRef.current = dirtyCount })

  useEffect(() => {
    setSavedName(metaName); setSavedOrg(metaOrg)
    if (!dirtyRef.current) { setNameField(metaName); setOrgField(metaOrg) }
  }, [metaName, metaOrg])

  const discardChanges = () => {
    setNameField(savedName); setOrgField(savedOrg); setFormMsg(null)
  }

  const saveChanges = async () => {
    const name = nameField.trim()
    const org  = orgField.trim()
    if (!name) { setFormMsg({ type: 'error', text: 'Your display name cannot be empty.' }); return }
    setSavingProfile(true); setFormMsg(null)
    const { error } = await supabase.auth.updateUser({ data: { display_name: name, business: org } })
    if (error) {
      setFormMsg({ type: 'error', text: error.message })
    } else {
      setSavedName(name); setSavedOrg(org)
      setNameField(name); setOrgField(org)
      setFormMsg({ type: 'success', text: dirtyCount === 1 ? 'Change saved.' : 'Changes saved.' })
      logActivity('profile_updated', 'account', user?.id, {}).catch(() => {})
    }
    setSavingProfile(false)
  }

  // ── Notification preferences (+ AI default, + digest) ───────────────────────
  const [notifPrefs, setNotifPrefs] = useState(readPrefs(null))
  const [aiDefault, setAiDefault]   = useState(true)
  const [aiSaving, setAiSaving]     = useState(false)
  const [aiMsg, setAiMsg]           = useState(null)
  const [digest, setDigest]         = useState('monday')
  const [digestMsg, setDigestMsg]   = useState(null)

  const notifDebounceRef = useRef(null)
  const notifPendingRef  = useRef(null)

  useEffect(() => {
    if (!supabase || !user?.id) return
    let alive = true
    supabase.from('notification_preferences').select('*').eq('user_id', user.id).maybeSingle()
      .then(({ data }) => {
        if (!alive || !data) return
        const loaded = readPrefs(data)
        // payment_failed and account_locked are ALWAYS ON. If a stored row says
        // otherwise (set before this rule existed), repair it — the badge has to
        // be true, not decorative.
        if (loaded.payment_failed === false || loaded.account_locked === false) {
          const repaired = { ...loaded, payment_failed: true, account_locked: true }
          setNotifPrefs(repaired)
          writePrefRow(repaired).then(() => {}, () => {})
        } else {
          setNotifPrefs(loaded)
        }
        // ai_access_default: the org-level AI default (column added by
        // supabase/migrations/20260721000005_share_ack_org_ai_default.sql).
        setAiDefault(data.ai_access_default !== false)
        setDigest(data.weekly_digest === false ? 'never' : 'monday')
      })
      .catch(() => {})
    return () => { alive = false }
  }, [user?.id])

  /** One write path for this row — the email toggles, the AI default and the
   *  digest cadence all land in notification_preferences. */
  const writePrefRow = (patch) => supabase
    .from('notification_preferences')
    .upsert({ user_id: user.id, ...patch, updated_at: new Date().toISOString() })

  const handleNotifToggle = (key) => {
    setNotifPrefs(prev => {
      const next = { ...prev, [key]: !prev[key] }
      notifPendingRef.current = next
      // Debounce: cancel any pending write and schedule a new one, so rapid
      // toggling coalesces into a single upsert with the final state.
      if (notifDebounceRef.current) clearTimeout(notifDebounceRef.current)
      notifDebounceRef.current = setTimeout(async () => {
        const toWrite = notifPendingRef.current
        if (!toWrite || !user?.id) return
        try {
          const { error } = await writePrefRow(toWrite)
          if (error) throw error
        } catch (e) {
          // Revert to last saved state on error — reload from the DB.
          supabase.from('notification_preferences').select('*').eq('user_id', user.id).maybeSingle()
            .then(({ data }) => { if (data) setNotifPrefs(readPrefs(data)) })
            .catch(() => {})
          console.error('Failed to save notification pref:', e.message)
        }
      }, 400)
      return next
    })
  }

  const handleAiDefault = async (value) => {
    const previous = aiDefault
    setAiDefault(value); setAiSaving(true); setAiMsg(null)
    const { error } = await writePrefRow({ ai_access_default: value })
    if (error) {
      setAiDefault(previous)
      setAiMsg({ type: 'error', text: 'That could not be saved. Your AI default is unchanged.' })
    } else {
      setAiMsg({
        type: 'success',
        text: value
          ? 'New candidates will let AI tools read their notes and documents unless you lock them.'
          : 'New candidates now start closed — AI tools will not read their notes or documents.',
      })
      logActivity('ai_access_default_changed', 'account', user?.id, { ai_access_default: value }).catch(() => {})
    }
    setAiSaving(false)
  }

  const handleDigest = async (value) => {
    const previous = digest
    if (value === previous) return
    setDigest(value); setDigestMsg(null)
    const { error } = await writePrefRow({ weekly_digest: value !== 'never' })
    if (error) {
      setDigest(previous)
      setDigestMsg({ type: 'error', text: 'That could not be saved. Your digest setting is unchanged.' })
    }
  }

  // ── Billing ─────────────────────────────────────────────────────────────────
  const [billingMsg, setBillingMsg]     = useState(null)
  const [portalLoading, setPortalLoading] = useState(false)

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get('billing') === 'success') {
      const planName = params.get('plan') || ''
      setBillingMsg({
        type: 'success',
        text: planName
          ? 'Your plan is updated and active — the new limits apply right away.'
          : 'Your plan is updated and active.',
      })
      window.history.replaceState({}, '', window.location.pathname)
      // Refresh the session so the new plan is active immediately — no sign-out.
      refreshSession?.().catch(() => {})
    } else if (params.get('billing') === 'cancelled') {
      setBillingMsg({ type: 'info', text: 'Checkout was cancelled — nothing changed.' })
      window.history.replaceState({}, '', window.location.pathname)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleManageBilling = async () => {
    setPortalLoading(true)
    const token = session?.access_token
    try {
      const res = await fetch('/.netlify/functions/create-portal-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({}),
      })
      const json = await res.json()
      if (json.url) window.location.href = json.url
      else setBillingMsg({ type: 'error', text: json.error || 'Could not open the billing portal.' })
    } catch {
      setBillingMsg({ type: 'error', text: 'Could not reach the server.' })
    }
    setPortalLoading(false)
  }

  // ── Cancel at period end (soft cancel) ──────────────────────────────────────
  const [cancelPeriodModal, setCancelPeriodModal]     = useState(false)
  const [cancelPeriodLoading, setCancelPeriodLoading] = useState(false)
  const [cancelPeriodEnd, setCancelPeriodEnd]         = useState(null) // unix timestamp

  const handleCancelAtPeriodEnd = async () => {
    setCancelPeriodLoading(true)
    try {
      const token = session?.access_token
      const res = await fetch('/.netlify/functions/cancel-at-period-end', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ userId: user?.id, email: user?.email }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to cancel subscription')
      setCancelPeriodEnd(data.periodEnd)
      setCancelPeriodModal(false)
      setBillingMsg({
        type: 'info',
        text: data.message || 'Your plan stays active until the end of this billing period, then access is removed.',
      })
    } catch (err) {
      console.error('Cancel at period end error:', err)
      setBillingMsg({ type: 'error', text: err.message || 'Could not cancel the subscription. Please try again.' })
      setCancelPeriodModal(false)
    } finally {
      setCancelPeriodLoading(false)
    }
  }

  // ── Account cancellation flow ───────────────────────────────────────────────
  // null → 'warn' (step 1: downgrade offer) → 'confirm' (step 2: delete confirm)
  const [cancelStep, setCancelStep]       = useState(null)
  const [deleteLoading, setDeleteLoading] = useState(false)
  const [deleteMsg, setDeleteMsg]         = useState(null)

  const handleDowngradeToFree = async () => {
    setDeleteLoading(true)
    const token = session?.access_token
    try {
      const res = await fetch('/.netlify/functions/downgrade-to-free', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ userId: user?.id, email: user?.email }),
      })
      // Never show "cancelled" unless the server actually confirmed it — a
      // 401/500 here previously produced a success banner while Stripe kept billing.
      if (!res.ok) {
        let errText = 'We couldn\'t cancel your subscription. Please try again, or use "Manage billing" to cancel through the billing portal.'
        try { const j = await res.json(); if (j?.error) errText = `${j.error} — please try again or use "Manage billing" to cancel through the billing portal.` } catch { /* keep default */ }
        setBillingMsg({ type: 'error', text: errText })
        setCancelStep(null); setDeleteLoading(false)
        return
      }
      const json = await res.json()
      await refreshSession?.()
      setCancelStep(null)
      setBillingMsg({
        type: 'success',
        text: json.message || 'Your subscription is cancelled. You\'re on the free Scout plan and all your data is safe.',
      })
      navigate('/settings/plan')
    } catch {
      setBillingMsg({ type: 'error', text: 'Could not reach the server to cancel. Please try again, or use "Manage billing" to cancel through the billing portal.' })
      setCancelStep(null)
    }
    setDeleteLoading(false)
  }

  const handleConfirmDelete = async () => {
    setDeleteLoading(true); setDeleteMsg(null)
    const token = session?.access_token
    try {
      const res = await fetch('/.netlify/functions/delete-account', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ userId: user?.id, email: user?.email }),
      })
      // A non-2xx here previously signed the user out as if the account were
      // deleted while it (and its Stripe subscription) lived on.
      let json = {}
      try { json = await res.json() } catch { /* non-JSON error body */ }
      if (!res.ok || json.error) {
        setDeleteMsg({ type: 'error', text: json.error || `Account deletion failed (HTTP ${res.status}). Please try again or contact support — your account has NOT been deleted.` })
      } else {
        try { await signOut() } catch { /* account is already gone */ } finally { navigate('/login') }
      }
    } catch {
      setDeleteMsg({ type: 'error', text: 'Could not reach the server. Please try again or contact support.' })
    }
    setDeleteLoading(false)
  }

  // ── Hero ────────────────────────────────────────────────────────────────────
  const displayName = savedName || user?.email?.split('@')[0] || 'Your account'
  const heroStats = useMemo(() => ([
    {
      label: 'PROFILES LEFT',
      value: usage.loading ? '—'
        : profileLimit === Infinity ? 'Unlimited'
        : String(Math.max(0, profileLimit - usage.profilesUsed)),
    },
    {
      label: 'MONITORING',
      value: usage.loading ? '—'
        : maxSlots === Infinity ? String(usage.monitored)
        : `${usage.monitored} / ${maxSlots}`,
    },
    { label: 'CANDIDATES', value: usage.loading ? '—' : String(usage.candidates) },
  ]), [usage, profileLimit, maxSlots])

  const railItem = (item, chip) => {
    const on = item.id === pane
    const { Icon } = item
    if (chip) {
      return (
        <button
          key={item.id}
          type="button"
          onClick={() => goPane(item.id)}
          className="st-btn"
          aria-current={on ? 'page' : undefined}
          style={{
            flex: 'none', display: 'inline-flex', alignItems: 'center', gap: 7,
            border: `1px solid ${on ? T.ink : T.field}`, background: on ? T.ink : '#fff',
            color: on ? '#fff' : T.ink4, borderRadius: 99, padding: '7px 14px', minHeight: 44,
            fontSize: 12.5, fontWeight: on ? 600 : 500, fontFamily: 'inherit',
            cursor: 'pointer', whiteSpace: 'nowrap',
          }}
        >
          <Icon style={{ width: 14, height: 14, flex: 'none' }} />
          {item.label}
        </button>
      )
    }
    return (
      <button
        key={item.id}
        type="button"
        onClick={() => goPane(item.id)}
        className="st-nav"
        data-on={on ? 'true' : 'false'}
        aria-current={on ? 'page' : undefined}
        style={{
          display: 'flex', alignItems: 'center', gap: 10, width: '100%',
          padding: '8px 11px', minHeight: 44, borderRadius: 10, border: 0,
          background: on ? T.navy : 'transparent',
          boxShadow: on ? '0 4px 12px rgba(13,21,38,.2)' : 'none',
          cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit',
        }}
      >
        <span aria-hidden="true" style={{
          flex: 'none', width: 22, height: 22, borderRadius: 7,
          background: on ? T.red : '#EFEEEA',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          transition: 'background .16s ease',
        }}>
          <Icon style={{ width: 13, height: 13, color: on ? '#fff' : T.faint }} />
        </span>
        <span style={{ fontSize: 13, fontWeight: on ? 600 : 500, color: on ? '#fff' : T.ink4, minWidth: 0 }}>
          {item.label}
        </span>
        {item.badge && (
          <Pill
            c={on ? '#FCA5A5' : T.redHot}
            bg={on ? 'rgba(165,28,36,.28)' : T.redBg}
            style={{ marginLeft: 'auto' }}
          >{item.badge}</Pill>
        )}
      </button>
    )
  }

  return (
    <SettingsShell>
      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <div style={{
        position: 'relative', overflow: 'hidden', borderRadius: 18, padding: '22px 26px',
        marginBottom: 20, boxShadow: '0 12px 30px rgba(13,21,38,.18)',
        background: 'linear-gradient(135deg, #0D1526 0%, #16203A 58%, #263255 100%)',
      }}>
        <div aria-hidden="true" style={{
          position: 'absolute', top: -120, right: '18%', width: 320, height: 320, borderRadius: '50%',
          background: 'radial-gradient(circle, rgba(165,28,36,.38) 0%, rgba(165,28,36,0) 70%)',
        }} />
        <div className="st-hero" style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 16 }}>
          <div style={{ flex: 1, minWidth: 180 }}>
            <div style={{
              fontSize: 21, fontWeight: 700, color: '#fff', letterSpacing: '-.3px',
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            }}>{displayName}</div>
            <div style={{
              fontSize: 12, color: '#A9B2C4', marginTop: 2,
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            }}>{user?.email}</div>
          </div>
          <div className="st-herostats" style={{ marginLeft: 'auto', flex: 'none', display: 'flex', gap: 9 }}>
            {heroStats.map(h => (
              <div key={h.label} style={{
                minWidth: 96, background: 'rgba(255,255,255,.07)',
                border: '1px solid rgba(255,255,255,.12)', borderRadius: 12,
                padding: '9px 13px', textAlign: 'center',
              }}>
                <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.8px', color: '#9AA4B8' }}>{h.label}</div>
                <div style={{ fontSize: 17, fontWeight: 800, color: '#fff', lineHeight: 1.15, marginTop: 3 }}>{h.value}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── Chip row (below 900px) ───────────────────────────────────────── */}
      <div className="st-chips" style={{ display: 'none', gap: 6, overflowX: 'auto', paddingBottom: 14 }}>
        {NAV_ITEMS.map(item => railItem(item, true))}
      </div>

      <div style={{ display: 'flex', gap: 26, alignItems: 'flex-start', paddingBottom: 120 }}>
        {/* ── Rail ───────────────────────────────────────────────────────── */}
        <nav className="st-rail" aria-label="Settings sections" style={{
          flex: 'none', width: 212, position: 'sticky', top: 0,
          display: 'flex', flexDirection: 'column', gap: 16,
        }}>
          {NAV_GROUPS.map(group => (
            <div key={group.label}>
              <div style={{
                fontSize: 11, fontWeight: 700, letterSpacing: '1.2px',
                color: T.faint, padding: '0 10px 7px',
              }}>{group.label}</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                {group.items.map(item => railItem(item, false))}
              </div>
            </div>
          ))}
        </nav>

        {/* ── Pane ───────────────────────────────────────────────────────── */}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 16 }}>
          {formMsg && (
            <div style={{
              background: formMsg.type === 'error' ? T.redBg : T.greenBg,
              border: `1px solid ${formMsg.type === 'error' ? T.redBr : '#CDE9D8'}`,
              color: formMsg.type === 'error' ? T.redHot : T.green,
              borderRadius: 12, padding: '11px 14px', fontSize: 12.5, fontWeight: 500,
            }}>{formMsg.text}</div>
          )}

          {pane === 'account' && (
            <AccountPane
              user={user}
              savedName={savedName}
              nameField={nameField}
              orgField={orgField}
              onName={setNameField}
              onOrg={setOrgField}
            />
          )}

          {pane === 'security' && <SecurityPane user={user} />}

          {pane === 'plan' && (
            <PlanPane
              user={user}
              usage={usage}
              profileLimit={profileLimit}
              maxSlots={maxSlots}
              onManageBilling={handleManageBilling}
              portalLoading={portalLoading}
              billingMsg={billingMsg}
              onDismissBilling={() => setBillingMsg(null)}
              onCancelPlan={() => setCancelPeriodModal(true)}
              cancelPeriodEnd={cancelPeriodEnd}
              isDowngradeLocked={isDowngradeLocked}
              downgradedAt={downgradedAt}
              navigate={navigate}
            />
          )}

          {pane === 'notifications' && (
            <NotificationsPane
              prefs={notifPrefs}
              onToggle={handleNotifToggle}
              digest={digest}
              onDigest={handleDigest}
              digestMsg={digestMsg}
              monitoredCount={usage.monitored}
              monitoringLoading={usage.loading}
            />
          )}

          {pane === 'calendars' && <CalendarsPane user={user} />}

          {pane === 'privacy' && (
            <PrivacyPane
              aiDefault={aiDefault}
              onAiDefault={handleAiDefault}
              aiMsg={aiMsg}
              aiLoading={aiSaving}
              shareCount={shares.count}
              shareLoading={shares.loading}
              onReviewShares={() => navigate('/profiler')}
              onDeleteAccount={() => { setCancelStep('warn'); setDeleteMsg(null) }}
            />
          )}
        </div>
      </div>

      {/* ── Unsaved-changes bar ──────────────────────────────────────────── */}
      {dirtyCount > 0 && (
        <div role="status" style={{
          position: 'fixed', bottom: 22, left: '50%', transform: 'translateX(-50%)', zIndex: 40,
          display: 'flex', alignItems: 'center', gap: 14,
          background: T.navy, color: '#fff', borderRadius: 99,
          padding: '8px 12px 8px 20px', boxShadow: '0 14px 34px rgba(13,21,38,.34)',
          animation: 'stRise .22s ease', maxWidth: 'calc(100vw - 32px)',
        }}>
          <span style={{ fontSize: 12.5, fontWeight: 500, whiteSpace: 'nowrap' }}>
            {dirtyCount === 1 ? '1 unsaved change' : `${dirtyCount} unsaved changes`}
          </span>
          <button
            type="button"
            onClick={discardChanges}
            disabled={savingProfile}
            style={{
              background: 'none', border: 0, color: '#B7BECD', fontSize: 12, fontWeight: 600,
              fontFamily: 'inherit', cursor: savingProfile ? 'not-allowed' : 'pointer',
              minHeight: 44, padding: '0 4px', whiteSpace: 'nowrap',
            }}
          >Discard</button>
          <Btn kind="primary" onClick={saveChanges} disabled={savingProfile}>
            {savingProfile ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Saving…</> : 'Save changes'}
          </Btn>
        </div>
      )}

      {/* ── Cancel at period end modal ───────────────────────────────────── */}
      {cancelPeriodModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full overflow-hidden">
            <div className="bg-gradient-to-r from-yellow-500 to-orange-500 px-6 py-5 flex items-start justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-white/20 rounded-xl flex items-center justify-center flex-shrink-0">
                  <AlertTriangle className="w-5 h-5 text-white" />
                </div>
                <div>
                  <h3 className="text-white font-black text-base">Cancel your plan?</h3>
                  <p className="text-yellow-100 text-xs mt-0.5">You keep access until this billing period ends</p>
                </div>
              </div>
              <button onClick={() => setCancelPeriodModal(false)} className="text-white/60 hover:text-white mt-0.5" aria-label="Close">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="px-6 py-5 space-y-4">
              <p className="text-sm text-gray-700">
                Your plan stays active until the end of the period you have already paid for. After that
                your access is removed and you move to the free Scout tier. Your data stays.
              </p>
              <div className="flex flex-col gap-2 pt-1">
                <button
                  onClick={() => setCancelPeriodModal(false)}
                  disabled={cancelPeriodLoading}
                  className="w-full py-2.5 bg-gray-100 hover:bg-gray-200 text-gray-800 text-sm font-bold rounded-xl transition-colors disabled:opacity-60"
                >Keep my plan</button>
                <button
                  onClick={handleCancelAtPeriodEnd}
                  disabled={cancelPeriodLoading}
                  className="w-full py-2.5 bg-red-600 hover:bg-red-700 text-white text-sm font-bold rounded-xl transition-colors disabled:opacity-60 flex items-center justify-center gap-2"
                >
                  {cancelPeriodLoading ? <><Loader2 className="w-4 h-4 animate-spin" /> Cancelling…</> : 'Yes, cancel my plan'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Cancellation / deletion modal ────────────────────────────────── */}
      {cancelStep && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
          {cancelStep === 'warn' && (
            <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full overflow-hidden">
              <div className="bg-gradient-to-r from-red-600 to-red-700 px-6 py-5 flex items-start justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-white/20 rounded-xl flex items-center justify-center flex-shrink-0">
                    <AlertTriangle className="w-5 h-5 text-white" />
                  </div>
                  <div>
                    <h3 className="text-white font-black text-base">Wait — don't lose your data</h3>
                    <p className="text-red-200 text-xs mt-0.5">Before you go, there's a better option</p>
                  </div>
                </div>
                <button onClick={() => setCancelStep(null)} className="text-white/60 hover:text-white mt-0.5" aria-label="Close">
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="px-6 py-5 space-y-4">
                <div className="p-4 bg-red-50 border border-red-200 rounded-xl">
                  <p className="text-xs font-bold text-red-700 uppercase tracking-wider mb-2.5 flex items-center gap-1.5">
                    <Trash2 className="w-3.5 h-3.5" /> Deleting your account permanently destroys:
                  </p>
                  <ul className="space-y-1.5">
                    {[
                      'Every candidate record and its tracking history',
                      'Every generated profile, including credits you paid for',
                      'Your election monitoring data and alerts',
                      'All prospecting lists and saved filters',
                      'Your entire account history',
                    ].map(item => (
                      <li key={item} className="flex items-start gap-2 text-xs text-red-700">
                        <span className="mt-0.5 flex-shrink-0 font-bold">–</span>
                        {item}
                      </li>
                    ))}
                  </ul>
                </div>

                <p className="text-xs text-gray-600 text-center">
                  <strong className="text-gray-800">There is a smaller step:</strong> move to the free Scout plan.
                  Billing stops, your account stays, and every profile you have made stays with it.
                </p>

                <button
                  onClick={handleDowngradeToFree}
                  disabled={deleteLoading}
                  className="w-full flex items-center justify-between p-4 bg-green-50 border-2 border-green-400 rounded-xl hover:bg-green-100 transition-colors text-left disabled:opacity-60"
                >
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 bg-green-600 rounded-lg flex items-center justify-center flex-shrink-0">
                      <CheckCircle className="w-4 h-4 text-white" />
                    </div>
                    <div>
                      <p className="text-sm font-bold text-green-800">Keep my data — move to the free Scout plan</p>
                      <p className="text-xs text-green-700 mt-0.5">Billing stops · candidates and profiles stay · free</p>
                    </div>
                  </div>
                  {deleteLoading
                    ? <Loader2 className="w-4 h-4 text-green-700 animate-spin flex-shrink-0" />
                    : <ArrowRight className="w-4 h-4 text-green-700 flex-shrink-0" />}
                </button>

                <button
                  onClick={() => setCancelStep('confirm')}
                  disabled={deleteLoading}
                  className="w-full flex items-center justify-between p-3 border border-gray-200 rounded-xl hover:bg-gray-50 transition-colors text-left disabled:opacity-60"
                >
                  <div>
                    <p className="text-sm font-semibold text-gray-700">Permanently delete everything</p>
                    <p className="text-xs text-gray-500 mt-0.5">All data destroyed · cannot be reversed</p>
                  </div>
                  <ChevronRight className="w-4 h-4 text-gray-500 flex-shrink-0" />
                </button>
              </div>
            </div>
          )}

          {cancelStep === 'confirm' && (
            <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full overflow-hidden">
              <div className="bg-gray-900 px-6 py-5 flex items-start justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-red-600 rounded-xl flex items-center justify-center flex-shrink-0">
                    <Trash2 className="w-5 h-5 text-white" />
                  </div>
                  <div>
                    <h3 className="text-white font-black text-base">This cannot be undone</h3>
                    <p className="text-gray-300 text-xs mt-0.5">You are about to permanently destroy this account</p>
                  </div>
                </div>
                <button onClick={() => setCancelStep(null)} className="text-gray-400 hover:text-white mt-0.5" aria-label="Close">
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="px-6 py-5 space-y-4">
                <div className="space-y-1.5">
                  {[
                    ['Candidates', 'every record, note, document and game plan'],
                    ['Profiles', 'every generated report, including purchased credits'],
                    ['Elections', 'all race monitoring, alerts and result tracking'],
                    ['Prospecting', 'all saved lists, filters and contact intelligence'],
                    ['Your account', 'credentials, billing history and audit trail'],
                  ].map(([label, desc]) => (
                    <div key={label} className="flex items-center gap-3 p-2.5 bg-red-50 border border-red-100 rounded-lg">
                      <Trash2 className="w-3.5 h-3.5 text-red-600 flex-shrink-0" />
                      <div>
                        <span className="text-xs font-bold text-red-700">{label}</span>
                        <span className="text-xs text-red-700 ml-1.5">{desc}</span>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl flex items-start gap-2.5">
                  <AlertTriangle className="w-4 h-4 text-amber-700 flex-shrink-0 mt-0.5" />
                  <p className="text-xs text-amber-800">
                    <strong>There is still time to change your mind.</strong> The free Scout plan keeps
                    everything intact, and you can re-upgrade whenever you want.
                  </p>
                </div>

                {deleteMsg && (
                  <div className="flex items-start gap-2 p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700">
                    <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                    {deleteMsg.text}
                  </div>
                )}

                <div className="flex flex-col gap-2 pt-1">
                  <button
                    onClick={handleDowngradeToFree}
                    disabled={deleteLoading}
                    className="w-full py-2.5 bg-green-700 hover:bg-green-800 text-white text-sm font-bold rounded-xl transition-colors disabled:opacity-60"
                  >
                    {deleteLoading ? <Loader2 className="w-4 h-4 animate-spin mx-auto" /> : 'Actually — keep my data on Scout (free)'}
                  </button>
                  <button
                    onClick={handleConfirmDelete}
                    disabled={deleteLoading}
                    className="w-full py-2.5 bg-red-600 hover:bg-red-700 text-white text-sm font-bold rounded-xl transition-colors disabled:opacity-60 flex items-center justify-center gap-2"
                  >
                    {deleteLoading
                      ? <><Loader2 className="w-4 h-4 animate-spin" /> Deleting…</>
                      : <><Trash2 className="w-4 h-4" /> Yes, permanently delete my account</>}
                  </button>
                  <button
                    onClick={() => setCancelStep(null)}
                    disabled={deleteLoading}
                    className="text-xs text-gray-500 hover:text-gray-700 text-center py-1 transition-colors"
                  >Cancel — I changed my mind</button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </SettingsShell>
  )
}
