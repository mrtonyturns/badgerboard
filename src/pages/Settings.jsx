import React, { useState, useEffect, useRef } from 'react'
import {
  Settings as SettingsIcon, Key, CheckCircle, AlertCircle,
  User, Users, Shield, CreditCard, ExternalLink, Lock,
  Loader2, ChevronRight, Sparkles, ArrowRight, Edit2, Eye, EyeOff, Save,
  Trash2, AlertTriangle, X, Bell,
  CalendarDays, Copy, Check } from 'lucide-react'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import {
  getUserPlan, getUserBracket, getPlanConfig, getBracketConfig,
  PLAN_CONFIG, MONTHLY_PRICES, getProfileLimit, getEffectiveProfileLimit,
} from '../lib/tiers'
import { isNativeApp } from '../lib/native'
import { useNavigate, useLocation } from 'react-router-dom'

// ── helpers ──────────────────────────────────────────────────────────────────

function getStartOfMonth() {
  const d = new Date()
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString()
}

// ── Dossier usage bar ─────────────────────────────────────────────────────────

function DossierBar({ used, limit }) {
  if (limit === Infinity) {
    return (
      <div className="flex items-center gap-2 p-2.5 bg-green-50 border border-green-200 rounded-lg mb-5">
        <CheckCircle className="w-4 h-4 text-green-600 flex-shrink-0" />
        <span className="text-xs font-semibold text-green-700">Unlimited profiles — Agency plan</span>
      </div>
    )
  }
  const remaining = Math.max(0, limit - used)
  const pct       = Math.min(100, Math.round((used / limit) * 100))
  const color     = pct >= 80
    ? { bar: '#ef4444', bg: 'bg-red-50',    border: 'border-red-200',    text: 'text-red-700'    }
    : pct >= 60
    ? { bar: '#f97316', bg: 'bg-orange-50', border: 'border-orange-200', text: 'text-orange-700' }
    : { bar: '#22c55e', bg: 'bg-green-50',  border: 'border-green-200',  text: 'text-green-700'  }

  return (
    <div className={`p-2.5 rounded-lg border ${color.bg} ${color.border} mb-5`}>
      <div className="flex items-center justify-between mb-1.5">
        <span className={`text-xs font-semibold ${color.text}`}>
          {remaining === 0
            ? 'Monthly limit reached'
            : remaining === 1
            ? '1 profile remaining this month'
            : `${remaining} of ${limit} profiles remaining`}
        </span>
        <span className="text-xs text-gray-400">{used}/{limit}</span>
      </div>
      <div className="h-1.5 bg-white/70 rounded-full overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{ width: `${pct}%`, backgroundColor: color.bar }}
        />
      </div>
      <p className="text-xs text-gray-400 mt-1">{used} of {limit} profiles used this month · resets the 1st</p>
    </div>
  )
}

// ── Main Settings page ────────────────────────────────────────────────────────


// ── Calendars (Outreach events) ───────────────────────────────────────────────
const CAL_PROVIDERS = [
  { key: 'google',  name: 'Google Calendar',  color: '#1A73E8', letter: 'G',
    steps: ['Open Google Calendar on the web', 'In the left sidebar: Other calendars → + → From URL', 'Paste your feed URL below and click "Add calendar"'] },
  { key: 'apple',   name: 'Apple Calendar',   color: '#0F172A', letter: '\uF8FF',
    steps: ['Click the webcal button below (or Calendar → File → New Calendar Subscription)', 'Confirm the subscription', 'Set auto-refresh to "Every hour" for fastest updates'] },
  { key: 'outlook', name: 'Outlook Calendar', color: '#0F6CBD', letter: 'O',
    steps: ['Open Outlook calendar on the web', 'Add calendar → Subscribe from web', 'Paste your feed URL below and name it "Badger Board Events"'] },
]
const REMINDER_OPTIONS = [[15,'15 min'],[30,'30 min'],[60,'1 hour'],[120,'2 hours'],[1440,'1 day']]

// User-agent fingerprints of each provider's feed fetcher — used to VERIFY that
// the calendar service actually pulled the user's feed before marking connected.
const PROVIDER_UA = {
  google:  /google/i,
  apple:   /calendaragent|dataaccessd|ical|apple|cfnetwork|swiftbird/i,
  outlook: /microsoft|outlook|office|exchange/i,
}

function CalendarsSection({ user }) {
  const meta = user?.user_metadata || {}
  const [feedToken, setFeedToken]   = useState(null)
  const [connecting, setConnecting] = useState(null)   // provider key with open instructions
  const [verifying, setVerifying]   = useState(null)   // provider key being verified
  const [verifyMsg, setVerifyMsg]   = useState(null)   // { key, ok, text }
  const [copied, setCopied]         = useState(false)
  const [saving, setSaving]         = useState(false)
  const [local, setLocal]           = useState({
    reminder: meta.cal_reminder ?? 60,
    ask: meta.cal_ask !== false,
    connected: { google: !!meta.cal_google, apple: !!meta.cal_apple, outlook: !!meta.cal_outlook },
    defaults: meta.cal_defaults || [],
  })

  useEffect(() => {
    if (!user?.id) return
    supabase.from('calendar_feeds').select('token').eq('user_id', user.id).maybeSingle().then(async ({ data }) => {
      if (data?.token) { setFeedToken(data.token); return }
      const { data: ins } = await supabase.from('calendar_feeds').insert({ user_id: user.id }).select('token').single()
      if (ins?.token) setFeedToken(ins.token)
    })
  }, [user?.id])

  const feedUrl   = feedToken ? `https://badgerboardwi.com/.netlify/functions/calendar-feed?token=${feedToken}` : ''
  const webcalUrl = feedUrl.replace(/^https:/, 'webcal:')

  const localRef = useRef(local)
  useEffect(() => { localRef.current = local }, [local])
  const persist = async (patch) => {
    setSaving(true)
    // Merge against the LATEST local state (ref), not the render-time closure —
    // prevents a rapid second click (e.g. connect → reminder) from reverting the first.
    const next = { ...localRef.current, ...patch }
    localRef.current = next
    setLocal(next)
    const { data } = await supabase.auth.updateUser({ data: {
      cal_google: next.connected.google, cal_apple: next.connected.apple, cal_outlook: next.connected.outlook,
      cal_defaults: next.defaults, cal_reminder: next.reminder, cal_ask: next.ask,
    } })
    setSaving(false)
    return data
  }

  const toggleConnected = async (key, value) => {
    const connected = { ...localRef.current.connected, [key]: value }
    const defaults = value ? [...new Set([...localRef.current.defaults, key])] : localRef.current.defaults.filter(d => d !== key)
    await persist({ connected, defaults })
    if (!value) setConnecting(null)
  }

  const copy = () => { navigator.clipboard?.writeText(feedUrl); setCopied(true); setTimeout(() => setCopied(false), 2000) }

  const verifyConnection = async (key) => {
    setVerifying(key); setVerifyMsg(null)
    const startedAt = Date.now() - 10 * 60 * 1000   // accept fetches from the last 10 min (subscribe happens before clicking verify)
    const matcher = PROVIDER_UA[key]
    for (let i = 0; i < 20; i++) {
      const { data } = await supabase.from('calendar_feeds').select('fetch_log').eq('user_id', user.id).maybeSingle()
      const log = Array.isArray(data?.fetch_log) ? data.fetch_log : []
      const hit = log.find(f => matcher.test(f.ua || '') && new Date(f.at).getTime() >= startedAt)
      if (hit) {
        await toggleConnected(key, true)
        setVerifying(null)
        setVerifyMsg({ key, ok: true, text: `Verified — ${CAL_PROVIDERS.find(p => p.key === key).name} fetched your feed ${new Date(hit.at).toLocaleTimeString()}` })
        return
      }
      // any fetch at all (unknown client) after start also counts on later passes
      if (i > 10) {
        const anyHit = log.find(f => new Date(f.at).getTime() >= Date.now() - 5 * 60 * 1000)
        if (anyHit) {
          await toggleConnected(key, true)
          setVerifying(null)
          setVerifyMsg({ key, ok: true, text: 'Verified — your feed was fetched by a calendar client' })
          return
        }
      }
      await new Promise(r => setTimeout(r, 3000))
    }
    setVerifying(null)
    setVerifyMsg({ key, ok: false, text: "We haven't seen this calendar fetch your feed yet. Double-check you pasted the URL and finished the subscribe step — then verify again. (Some providers take a minute to make their first fetch.)" })
  }

  return (
    <section id="calendars" className="card scroll-mt-8">
      <h2 className="text-base font-bold text-gray-900 mb-1 flex items-center gap-2">
        <CalendarDays className="w-4 h-4 text-brand-red" /> Calendars
      </h2>
      <p className="text-sm text-gray-500 mb-5">
        Connect your calendars once — events you add from the Events page appear in them automatically with your default reminder.
      </p>

      {CAL_PROVIDERS.map(p => {
        const isConn = local.connected[p.key]
        const isDflt = local.defaults.includes(p.key)
        return (
          <div key={p.key} className="border-b border-gray-100 last:border-0">
            <div className="flex items-center gap-3 py-3">
              <span className="w-10 h-10 rounded-xl flex items-center justify-center text-white text-sm font-black flex-shrink-0" style={{ background: p.color }}>{p.letter}</span>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-bold text-gray-900 flex items-center gap-2">
                  {p.name}
                  {isDflt && <span className="text-[9px] font-black bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full tracking-wide">DEFAULT</span>}
                </div>
                <div className="text-xs text-gray-400 font-medium">{isConn ? 'Connected · synced via your personal feed' : 'Not connected'}</div>
              </div>
              {isConn && (
                <button onClick={() => persist({ defaults: isDflt ? local.defaults.filter(d => d !== p.key) : [...local.defaults, p.key] })}
                  className="text-xs font-bold text-gray-400 hover:text-amber-600">{isDflt ? 'Unset default' : 'Set default'}</button>
              )}
              {isConn ? (
                <button onClick={() => toggleConnected(p.key, false)} className="text-xs font-bold bg-green-100 text-green-700 border border-green-200 px-3.5 py-2 rounded-lg">✓ Connected</button>
              ) : (
                <button onClick={() => setConnecting(connecting === p.key ? null : p.key)} className="btn-secondary text-xs px-3.5 py-2">Connect →</button>
              )}
            </div>
            {connecting === p.key && !isConn && (
              <div className="mb-4 ml-13 bg-gray-50 rounded-xl p-4" style={{ marginLeft: 52 }}>
                <ol className="text-xs text-gray-600 font-medium space-y-1.5 list-decimal list-inside">
                  {p.steps.map((st, i) => <li key={i}>{st}</li>)}
                </ol>
                <div className="flex items-center gap-2 mt-3">
                  <input readOnly value={feedUrl} className="input text-xs flex-1 font-mono" onFocus={e => e.target.select()} />
                  <button onClick={copy} className="btn-secondary text-xs px-3 py-2 flex items-center gap-1">
                    {copied ? <Check className="w-3.5 h-3.5 text-green-600" /> : <Copy className="w-3.5 h-3.5" />} {copied ? 'Copied' : 'Copy'}
                  </button>
                </div>
                <div className="flex items-center gap-2 mt-3 flex-wrap">
                  {p.key === 'apple' && (
                    <a href={webcalUrl} className="text-xs font-bold bg-brand-navy text-white px-3.5 py-2 rounded-lg">Open in Apple Calendar (webcal)</a>
                  )}
                  <button onClick={() => verifyConnection(p.key)} disabled={verifying === p.key}
                    className="text-xs font-bold bg-brand-red text-white px-3.5 py-2 rounded-lg disabled:opacity-60 flex items-center gap-1.5">
                    {verifying === p.key ? (<><Loader2 className="w-3.5 h-3.5 animate-spin" /> Watching for {p.name.split(' ')[0]}'s first fetch…</>) : "I've subscribed — verify connection"}
                  </button>
                  {verifyMsg?.key === p.key && !verifyMsg.ok && (
                    <button onClick={() => toggleConnected(p.key, true)} className="text-xs font-bold text-gray-400 hover:text-gray-600 underline">
                      Mark connected anyway
                    </button>
                  )}
                </div>
                {verifyMsg?.key === p.key && (
                  <p className={`text-xs font-bold mt-2 ${verifyMsg.ok ? 'text-green-700' : 'text-amber-600'}`}>{verifyMsg.ok ? '✓ ' : '⚠ '}{verifyMsg.text}</p>
                )}
              </div>
            )}
          </div>
        )
      })}

      <div className="flex items-center gap-2 flex-wrap pt-4 mt-1 border-t border-gray-100">
        <span className="text-sm font-semibold text-gray-700 mr-1">Default event reminder</span>
        {REMINDER_OPTIONS.map(([mins, label]) => (
          <button key={mins} onClick={() => persist({ reminder: mins })}
            className={`text-xs font-bold px-3.5 py-1.5 rounded-full border-2 transition-colors ${local.reminder === mins ? 'bg-brand-red border-brand-red text-white' : 'bg-white border-gray-200 text-gray-500 hover:border-gray-300'}`}>
            {label}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-2 flex-wrap pt-4 mt-3 border-t border-gray-100">
        <span className="text-sm font-semibold text-gray-700 mr-1">When adding events</span>
        <button onClick={() => persist({ ask: true })}
          className={`text-xs font-bold px-3.5 py-1.5 rounded-full border-2 ${local.ask ? 'bg-brand-red border-brand-red text-white' : 'bg-white border-gray-200 text-gray-500'}`}>Always ask which calendar</button>
        <button onClick={() => persist({ ask: false })}
          className={`text-xs font-bold px-3.5 py-1.5 rounded-full border-2 ${!local.ask ? 'bg-brand-red border-brand-red text-white' : 'bg-white border-gray-200 text-gray-500'}`}>Use default calendar</button>
      </div>
      <p className="text-xs text-gray-400 font-medium mt-4 leading-relaxed">
        Your feed URL is private — anyone with it can see events you add, so treat it like a password.
        Google refreshes subscribed feeds every few hours; Apple and Outlook are faster.
        {saving ? ' Saving…' : ''}
      </p>
    </section>
  )
}

export default function Settings() {
  const { user, session, signOut, refreshSession, isDowngradeLocked, downgradedAt } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()

  // Scroll to hash anchor (e.g. /settings#billing) after page renders
  useEffect(() => {
    if (location.hash) {
      const id = location.hash.slice(1)
      // Small delay to ensure the DOM has rendered
      const timer = setTimeout(() => {
        const el = document.getElementById(id)
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }, 150)
      return () => clearTimeout(timer)
    }
  }, [location.hash])
  const [dossiersUsed, setDossiersUsed] = useState(0)
  const [testResult, setTestResult]     = useState(null)
  const [testing, setTesting]           = useState(false)
  const [portalLoading, setPortalLoading]     = useState(false)
  const [billingMsg, setBillingMsg]           = useState(null)
  // Profile editing
  const [editingName, setEditingName]       = useState(false)
  const [displayName, setDisplayName]       = useState(user?.user_metadata?.display_name || '')
  const [savingName, setSavingName]         = useState(false)
  const [nameMsg, setNameMsg]               = useState(null)

  // Password change
  const [currentPw, setCurrentPw]           = useState('')
  const [newPw, setNewPw]                   = useState('')
  const [confirmPw, setConfirmPw]           = useState('')
  const [showCurrentPw, setShowCurrentPw]   = useState(false)
  const [showNewPw, setShowNewPw]           = useState(false)
  const [savingPw, setSavingPw]             = useState(false)
  const [pwMsg, setPwMsg]                   = useState(null)

  const userPlan     = getUserPlan(user)
  const userBracket  = getUserBracket(user)
  const planConfig   = getPlanConfig(userPlan) || getPlanConfig('scout')
  const bracketCfg   = getBracketConfig(userBracket)
  const dossierLimit = getEffectiveProfileLimit(user)

  // Live monthly price for current plan+bracket
  const currentPrice = (() => {
    if (userPlan === 'scout') return null
    const cfg = PLAN_CONFIG[userPlan]
    if (cfg?.monthlyPrice != null) return cfg.monthlyPrice
    return MONTHLY_PRICES[userPlan]?.[userBracket] ?? null
  })()

  // Load dossier usage count for this month
  useEffect(() => {
    if (!supabase || !user?.id) return
    supabase
      .from('dossiers')
      .select('id, generated_at')
      .eq('generated_by', user.id)       // scope to current user only
      .gte('generated_at', getStartOfMonth())
      .not('generated_by', 'is', null)  // exclude auto-regenerated dossiers from quota
      .then(({ data, error }) => {
        if (error) { console.error('Failed to fetch dossier usage:', error); return }
        if (data) setDossiersUsed(data.length)
      })
      .catch(err => console.error('Dossier usage fetch error:', err))
  }, [])

  // Handle Stripe redirect params
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get('billing') === 'success') {
      const planName    = PLAN_CONFIG[params.get('plan')]?.name ?? 'your new plan'
      const bracketName = params.get('bracket') ?? ''
      setBillingMsg({
        type: 'success',
        text: `You're now on ${planName}! Your access has been updated.`,
      })
      window.history.replaceState({}, '', '/settings')
      // Refresh the session so the new plan is active immediately — no sign-out needed
      refreshSession?.().catch(() => {})
    } else if (params.get('billing') === 'cancelled') {
      setBillingMsg({ type: 'info', text: 'Checkout was cancelled — no changes were made.' })
      window.history.replaceState({}, '', '/settings')
    }
  }, [])

  // ── Stripe Customer Portal ──────────────────────────────────────────────────
  const handleManageBilling = async () => {
    setPortalLoading(true)
    const token = session?.access_token
    try {
      const res  = await fetch('/.netlify/functions/create-portal-session', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({}),
      })
      const json = await res.json()
      if (json.url) {
        window.location.href = json.url
      } else {
        setBillingMsg({ type: 'error', text: json.error || 'Could not open billing portal.' })
      }
    } catch {
      setBillingMsg({ type: 'error', text: 'Could not reach the server.' })
    }
    setPortalLoading(false)
  }

  // ── Save display name ────────────────────────────────────────────────────────
  const handleSaveName = async () => {
    if (!displayName.trim()) return
    setSavingName(true)
    setNameMsg(null)
    const { error } = await supabase.auth.updateUser({ data: { display_name: displayName.trim() } })
    if (error) {
      setNameMsg({ type: 'error', text: error.message })
    } else {
      setNameMsg({ type: 'success', text: 'Display name updated.' })
      setEditingName(false)
    }
    setSavingName(false)
  }

  // ── Change password ──────────────────────────────────────────────────────────
  const handleChangePassword = async () => {
    setPwMsg(null)
    if (!newPw || newPw.length < 8) {
      setPwMsg({ type: 'error', text: 'New password must be at least 8 characters.' })
      return
    }
    if (newPw !== confirmPw) {
      setPwMsg({ type: 'error', text: 'Passwords do not match.' })
      return
    }
    setSavingPw(true)
    // Re-authenticate first to verify current password
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email: user.email,
      password: currentPw,
    })
    if (signInError) {
      setPwMsg({ type: 'error', text: 'Current password is incorrect.' })
      setSavingPw(false)
      return
    }
    const { error } = await supabase.auth.updateUser({ password: newPw })
    if (error) {
      setPwMsg({ type: 'error', text: error.message })
    } else {
      setPwMsg({ type: 'success', text: 'Password changed successfully.' })
      setCurrentPw('')
      setNewPw('')
      setConfirmPw('')
    }
    setSavingPw(false)
  }

  // ── API test ────────────────────────────────────────────────────────────────
  const testApiConnection = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const res  = await fetch('/.netlify/functions/generate-dossier', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ candidate: null, test: true }),
      })
      const json = await res.json()
      setTestResult(json.ok
        ? { success: true,  message: 'Claude API is connected and responding correctly.' }
        : { success: false, message: json.error || 'API connection failed.' }
      )
    } catch {
      setTestResult({ success: false, message: 'Could not reach the API endpoint.' })
    }
    setTesting(false)
  }

  // ── Notification preferences ────────────────────────────────────────────────
  const NOTIF_PREFS = [
    { key: 'payment_failed',  label: 'Payment failed warning',    desc: 'Get notified when a payment attempt fails so you can update your card before access is interrupted.' },
    { key: 'payment_receipt', label: 'Payment receipts',          desc: 'Receive a receipt email each time a subscription payment is successfully processed.' },
    { key: 'plan_changed',    label: 'Plan changes',              desc: 'Get notified when your plan is upgraded, downgraded, or your subscription is cancelled.' },
    { key: 'account_locked',  label: 'Account security alerts',   desc: 'Receive alerts if your account is locked due to failed payments or security events.' },
    { key: 'dossier_ready',   label: 'Profile ready',             desc: 'Get an email when a political intelligence profile you requested has been generated.' },
  ]
  const [notifPrefs, setNotifPrefs] = useState({ payment_failed: true, payment_receipt: true, plan_changed: true, account_locked: true, dossier_ready: true })
  // Debounce: hold a timer ref + a stable snapshot of what to write, so rapid
  // toggling coalesces into a single Supabase upsert with the final state.
  const notifDebounceRef = useRef(null)
  const notifPendingRef  = useRef(null)

  useEffect(() => {
    if (!supabase || !user?.id) return
    supabase
      .from('notification_preferences')
      .select('*')
      .eq('user_id', user.id)
      .maybeSingle()
      .then(({ data }) => {
        if (data) setNotifPrefs({
          payment_failed:  data.payment_failed  ?? true,
          payment_receipt: data.payment_receipt ?? true,
          plan_changed:    data.plan_changed    ?? true,
          account_locked:  data.account_locked  ?? true,
          dossier_ready:   data.dossier_ready   ?? true,
        })
      })
      .catch(() => {})
  }, [user?.id])

  const handleNotifToggle = (key) => {
    setNotifPrefs(prev => {
      const newPrefs = { ...prev, [key]: !prev[key] }
      notifPendingRef.current = newPrefs
      // Debounce: cancel any pending write and schedule a new one
      if (notifDebounceRef.current) clearTimeout(notifDebounceRef.current)
      notifDebounceRef.current = setTimeout(async () => {
        const toWrite = notifPendingRef.current
        if (!toWrite || !user?.id) return
        try {
          const { error } = await supabase
            .from('notification_preferences')
            .upsert({ user_id: user.id, ...toWrite, updated_at: new Date().toISOString() })
          if (error) throw error
        } catch (e) {
          // Revert to last saved state on error — reload from DB
          supabase.from('notification_preferences').select('*').eq('user_id', user.id).maybeSingle()
            .then(({ data }) => { if (data) setNotifPrefs({ payment_failed: data.payment_failed ?? true, payment_receipt: data.payment_receipt ?? true, plan_changed: data.plan_changed ?? true, account_locked: data.account_locked ?? true, dossier_ready: data.dossier_ready ?? true }) })
            .catch(() => {})
          console.error('Failed to save notification pref:', e.message)
        }
      }, 400)
      return newPrefs
    })
  }

  // ── Cancel at period end (pause/soft cancel) ───────────────────────────────
  const [cancelPeriodModal, setCancelPeriodModal]   = useState(false)
  const [cancelPeriodLoading, setCancelPeriodLoading] = useState(false)
  const [cancelPeriodEnd, setCancelPeriodEnd]       = useState(null) // unix timestamp

  const handleCancelAtPeriodEnd = async () => {
    setCancelPeriodLoading(true)
    try {
      const token = session?.access_token
      const res = await fetch('/.netlify/functions/cancel-at-period-end', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ userId: user?.id, email: user?.email }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to cancel subscription')
      setCancelPeriodEnd(data.periodEnd)
      setCancelPeriodModal(false)
      setBillingMsg({
        type: 'info',
        text: data.message || `Your plan will remain active until the end of your billing period, then access will be removed.`,
      })
    } catch (err) {
      console.error('Cancel at period end error:', err)
      setBillingMsg({ type: 'error', text: err.message || 'Could not cancel subscription. Please try again.' })
      setCancelPeriodModal(false)
    } finally {
      setCancelPeriodLoading(false)
    }
  }

  // ── Account cancellation flow ───────────────────────────────────────────────
  // null → 'warn' (step 1: downgrade offer) → 'confirm' (step 2: delete confirm)
  const [cancelStep, setCancelStep]         = useState(null)
  const [deleteLoading, setDeleteLoading]   = useState(false)
  const [deleteMsg, setDeleteMsg]           = useState(null)

  const handleDowngradeToFree = async () => {
    setDeleteLoading(true)
    const token = session?.access_token
    try {
      const res  = await fetch('/.netlify/functions/downgrade-to-free', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ userId: user?.id, email: user?.email }),
      })
      const json = res.ok ? await res.json() : {}
      // Refresh JWT so the app immediately reflects Scout plan (no stale tier in UI)
      await refreshSession?.()
      setCancelStep(null)
      setBillingMsg({
        type: 'success',
        text: json.message || 'Your subscription has been cancelled. You\'ve been moved to the free Scout plan — all your data is safe.',
      })
    } catch {
      // Fallback: open billing portal to let them cancel themselves
      handleManageBilling()
      setCancelStep(null)
    }
    setDeleteLoading(false)
  }

  const handleConfirmDelete = async () => {
    setDeleteLoading(true)
    setDeleteMsg(null)
    const token = session?.access_token
    try {
      const res  = await fetch('/.netlify/functions/delete-account', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ userId: user?.id, email: user?.email }),
      })
      const json = res.ok ? await res.json() : {}
      if (json.error) {
        setDeleteMsg({ type: 'error', text: json.error })
      } else {
        // Sign out and redirect — account is gone
        try {
          await signOut()
        } catch {
          // signOut failed but account is already deleted — force navigate to login
        } finally {
          navigate('/login')
        }
      }
    } catch {
      setDeleteMsg({ type: 'error', text: 'Could not reach the server. Please try again or contact support.' })
    }
    setDeleteLoading(false)
  }

  return (
    <div className="space-y-8 max-w-2xl">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
          <SettingsIcon className="w-6 h-6 text-brand-red" /> Settings
        </h1>
        <p className="text-gray-500 text-sm mt-1">Manage your profile, billing, and account security</p>
      </div>

      {/* ── Billing message banner ─────────────────────────────────────────── */}
      {billingMsg && (
        <div className={`flex items-start gap-3 p-4 rounded-xl border text-sm ${
          billingMsg.type === 'success' ? 'bg-green-50 border-green-200 text-green-800' :
          billingMsg.type === 'error'   ? 'bg-red-50   border-red-200   text-red-800'   :
                                          'bg-blue-50  border-blue-200  text-blue-800'
        }`}>
          {billingMsg.type === 'success'
            ? <CheckCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
            : <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />}
          <span>{billingMsg.text}</span>
          <button onClick={() => setBillingMsg(null)} className="ml-auto opacity-50 hover:opacity-100">✕</button>
        </div>
      )}

      {/* ── Account ───────────────────────────────────────────────────────── */}
      <section className="card scroll-mt-8">
        <h2 className="text-base font-bold text-gray-900 mb-5 flex items-center gap-2">
          <User className="w-4 h-4 text-brand-red" /> My Profile
        </h2>

        {/* Avatar + email row */}
        <div className="flex items-center gap-4 mb-5">
          <div className="w-14 h-14 bg-brand-red rounded-full flex items-center justify-center text-white text-2xl font-bold flex-shrink-0">
            {(user?.user_metadata?.display_name || user?.email || 'U')[0].toUpperCase()}
          </div>
          <div>
            <p className="text-base font-bold text-gray-900">
              {user?.user_metadata?.display_name || user?.email?.split('@')[0] || 'User'}
            </p>
            <p className="text-sm text-gray-400">{user?.email}</p>
            <div className="flex items-center gap-1.5 mt-1 text-xs text-green-700 bg-green-100 px-2 py-0.5 rounded-full font-medium w-fit">
              <CheckCircle className="w-3 h-3" /> Active
            </div>
          </div>
        </div>

        {/* Display name edit */}
        <div className="space-y-3">
          <div className="p-4 bg-gray-50 rounded-xl">
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Display Name</p>
              {!editingName && (
                <button
                  onClick={() => { setEditingName(true); setNameMsg(null) }}
                  className="text-xs text-brand-navy flex items-center gap-1 hover:underline"
                >
                  <Edit2 className="w-3 h-3" /> Edit
                </button>
              )}
            </div>
            {editingName ? (
              <div className="flex gap-2">
                <input
                  className="input text-sm flex-1"
                  value={displayName}
                  onChange={e => setDisplayName(e.target.value)}
                  placeholder="Your name"
                  maxLength={60}
                  onKeyDown={e => e.key === 'Enter' && handleSaveName()}
                />
                <button
                  onClick={handleSaveName}
                  disabled={savingName || !displayName.trim()}
                  className="btn-primary text-xs px-3 flex items-center gap-1 disabled:opacity-50"
                >
                  {savingName ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
                  Save
                </button>
                <button
                  onClick={() => { setEditingName(false); setDisplayName(user?.user_metadata?.display_name || '') }}
                  className="btn-secondary text-xs px-3"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <p className="text-sm text-gray-900 font-medium">
                {user?.user_metadata?.display_name || <span className="text-gray-400 italic">Not set</span>}
              </p>
            )}
            {nameMsg && (
              <div className={`mt-2 text-xs flex items-center gap-1.5 ${nameMsg.type === 'success' ? 'text-green-700' : 'text-red-600'}`}>
                {nameMsg.type === 'success' ? <CheckCircle className="w-3.5 h-3.5" /> : <AlertCircle className="w-3.5 h-3.5" />}
                {nameMsg.text}
              </div>
            )}
          </div>

          <div className="p-4 bg-gray-50 rounded-xl">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Email</p>
            <p className="text-sm text-gray-700 font-medium">{user?.email}</p>
            <p className="text-xs text-gray-400 mt-0.5">To change your email, contact support.</p>
          </div>

          <div className="text-xs text-gray-400 space-y-1 px-1">
            <p>User ID: <span className="font-mono text-gray-500">{user?.id}</span></p>
            <p>Member since: {user?.created_at ? new Date(user.created_at).toLocaleDateString() : 'Unknown'}</p>
            <p>Last sign in: {user?.last_sign_in_at ? new Date(user.last_sign_in_at).toLocaleString() : 'Unknown'}</p>
          </div>
        </div>
      </section>

      {/* ── Billing & Plan ─────────────────────────────────────────────────── */}
      <section id="billing" className="card scroll-mt-8">
        <h2 className="text-base font-bold text-gray-900 mb-5 flex items-center gap-2">
          <CreditCard className="w-4 h-4 text-brand-red" /> Billing &amp; Plan
        </h2>

        {/* ── Downgrade lockout warning ───────────────────────────────────── */}
        {isDowngradeLocked && (() => {
          const deletionMs  = downgradedAt + 30 * 24 * 60 * 60 * 1000
          const daysLeft    = Math.max(0, Math.ceil((deletionMs - Date.now()) / (1000 * 60 * 60 * 24)))
          const deleteDate  = new Date(deletionMs).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
          return (
            <div className="flex items-start gap-3 bg-red-50 border border-red-300 rounded-xl p-4 mb-5">
              <AlertTriangle className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-semibold text-red-800 mb-1">Your subscription has ended</p>
                <p className="text-xs text-red-700 leading-relaxed">
                  Your account is locked. All candidates, profiles, and data will be <strong>permanently deleted on {deleteDate}</strong> ({daysLeft} {daysLeft === 1 ? 'day' : 'days'} from now) unless you resubscribe.
                </p>
                {isNativeApp ? (
                  <p className="mt-3 text-xs text-red-700">
                    To resubscribe, sign in to your account on the BadgerBoard website.
                  </p>
                ) : (
                  <button
                    onClick={() => navigate('/plans')}
                    className="mt-3 inline-flex items-center gap-1.5 bg-red-600 hover:bg-red-700 text-white text-xs font-semibold px-4 py-2 rounded-lg transition-colors"
                  >
                    Resubscribe Now →
                  </button>
                )}
              </div>
            </div>
          )
        })()}

        {/* ── Current plan card ──────────────────────────────────────────── */}
        <div className="p-5 bg-brand-red/5 border border-brand-red/20 rounded-xl mb-4">
          <p className="text-xs text-brand-red font-semibold uppercase tracking-wider mb-3">Your Current Plan</p>

          <div className="flex items-center justify-between gap-4 mb-4">
            <div>
              <p className="text-2xl font-black text-gray-900">{planConfig.name}</p>
              {userPlan !== 'scout' && ['a_monitor','a_active','a_campaign','monitor','campaign','agency'].includes(userPlan) && (
                <p className="text-xs text-gray-500 mt-1 flex items-center gap-1.5">
                  <Users className="w-3.5 h-3.5" />
                  {bracketCfg.label} active candidates
                </p>
              )}
            </div>
            <div className="text-right flex-shrink-0">
              {currentPrice ? (
                <>
                  <p className="text-3xl font-black text-brand-red leading-none">
                    ${currentPrice}
                  </p>
                  <p className="text-xs text-gray-400 mt-1">per month</p>
                </>
              ) : (
                <p className="text-xl font-black text-gray-400">Free</p>
              )}
            </div>
          </div>

          {/* Dossier usage */}
          <div className="pt-4 border-t border-brand-red/10">
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-semibold text-gray-700">AI Profiles this month</p>
              {dossierLimit === Infinity ? (
                <span className="text-xs font-semibold text-green-700 bg-green-100 px-2 py-0.5 rounded-full flex items-center gap-1">
                  <CheckCircle className="w-3 h-3" /> Unlimited
                </span>
              ) : (
                <span className="text-xs text-gray-500 font-medium">
                  {dossiersUsed} / {dossierLimit} used
                </span>
              )}
            </div>
            {dossierLimit !== Infinity && dossierLimit > 0 && (
              <>
                <div className="h-2 bg-white rounded-full overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all duration-500"
                    style={{
                      width: `${Math.min(100, Math.round((dossiersUsed / dossierLimit) * 100))}%`,
                      backgroundColor:
                        dossiersUsed / dossierLimit >= 0.8 ? '#ef4444' :
                        dossiersUsed / dossierLimit >= 0.6 ? '#f97316' : '#22c55e',
                    }}
                  />
                </div>
                <p className="text-xs text-gray-400 mt-1.5">
                  {Math.max(0, dossierLimit - dossiersUsed)} remaining · resets the 1st of each month
                </p>
              </>
            )}
          </div>
        </div>

        {/* ── Cancellation scheduled banner ─────────────────────────────── */}
        {cancelPeriodEnd && (
          <div className="flex items-start gap-3 p-4 bg-yellow-50 border border-yellow-300 rounded-xl mb-4 text-sm text-yellow-800">
            <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5 text-yellow-600" />
            <span>
              Your plan is scheduled to cancel on{' '}
              <strong>{new Date(cancelPeriodEnd * 1000).toLocaleDateString()}</strong>.
              You will lose access after this date.
            </span>
          </div>
        )}

        {/* ── Need more dossiers ─────────────────────────────────────────── */}
        {/* Upsell hidden in native app builds (store rules) */}
        {!isNativeApp && dossierLimit !== Infinity && (
          <div className="p-4 bg-brand-navy/5 border border-brand-navy/15 rounded-xl flex items-center justify-between gap-4 mb-4">
            <div>
              <p className="text-sm font-bold text-gray-900 flex items-center gap-1.5">
                <Sparkles className="w-4 h-4 text-brand-navy" />
                Need more profiles?
              </p>
              <p className="text-xs text-gray-500 mt-0.5">
                Upgrade your plan for a higher monthly limit — up to unlimited on Agency.
              </p>
            </div>
            <button
              onClick={() => navigate('/plans')}
              className="flex-shrink-0 inline-flex items-center gap-1.5 text-xs font-bold bg-brand-navy text-white px-4 py-2 rounded-lg hover:bg-brand-navy/90 transition-colors whitespace-nowrap"
            >
              Upgrade plan <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* ── Manage billing link ────────────────────────────────────────── */}
        {isNativeApp ? (
          <div className="pt-3 border-t border-gray-100">
            <p className="text-xs text-gray-400">
              Billing, invoices, and plan changes are managed from your account on the BadgerBoard website.
            </p>
          </div>
        ) : (
          <div className="flex items-center justify-between pt-3 border-t border-gray-100">
            <p className="text-xs text-gray-400">Invoices, payment method, and subscription details.</p>
            <div className="flex items-center gap-3">
              {userPlan !== 'scout' && !cancelPeriodEnd && (
                <button
                  onClick={() => setCancelPeriodModal(true)}
                  className="inline-flex items-center gap-1.5 text-xs text-red-500 font-semibold hover:underline underline-offset-2"
                >
                  Cancel plan
                </button>
              )}
              <button
                onClick={handleManageBilling}
                disabled={portalLoading}
                className="inline-flex items-center gap-1.5 text-xs text-brand-navy font-semibold hover:underline underline-offset-2 disabled:opacity-50"
              >
                {portalLoading
                  ? <><Loader2 className="w-3 h-3 animate-spin" /> Opening…</>
                  : <><ExternalLink className="w-3 h-3" /> Manage billing</>}
              </button>
            </div>
          </div>
        )}
      </section>

      {/* AI API Configuration — hidden from users; managed via Netlify env vars */}

      {/* ── Security ─────────────────────────────────────────────────────────── */}
      <section id="security" className="card scroll-mt-8">
        <h2 className="text-base font-bold text-gray-900 mb-4 flex items-center gap-2">
          <Shield className="w-4 h-4 text-brand-red" /> Security
        </h2>

        {/* Security status */}
        <div className="p-4 bg-gray-50 rounded-xl space-y-2 text-xs mb-5">
          {[
            ['Data Isolation', 'Row-Level Security Active'],
            ['Connection', 'HTTPS / TLS Encrypted'],
            ['Auth Provider', 'Supabase Auth'],
            ['Content Security', 'CSP + XSS headers active'],
          ].map(([label, val]) => (
            <div key={label} className="flex justify-between items-center">
              <span className="text-gray-500">{label}</span>
              <span className="flex items-center gap-1 text-green-700 font-semibold">
                <CheckCircle className="w-3 h-3" /> {val}
              </span>
            </div>
          ))}
        </div>

        {/* Change password */}
        <div className="border border-gray-200 rounded-xl p-4">
          <h3 className="text-sm font-bold text-gray-900 mb-4 flex items-center gap-2">
            <Lock className="w-4 h-4 text-gray-500" /> Change Password
          </h3>
          <div className="space-y-3">
            {/* Current password */}
            <div>
              <label className="label text-xs">Current Password</label>
              <div className="relative">
                <input
                  type={showCurrentPw ? 'text' : 'password'}
                  className="input pr-10 text-sm"
                  value={currentPw}
                  onChange={e => setCurrentPw(e.target.value)}
                  placeholder="Enter current password"
                  autoComplete="current-password"
                />
                <button
                  type="button"
                  onClick={() => setShowCurrentPw(v => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                >
                  {showCurrentPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>
            {/* New password */}
            <div>
              <label className="label text-xs">New Password</label>
              <div className="relative">
                <input
                  type={showNewPw ? 'text' : 'password'}
                  className="input pr-10 text-sm"
                  value={newPw}
                  onChange={e => setNewPw(e.target.value)}
                  placeholder="At least 8 characters"
                  autoComplete="new-password"
                />
                <button
                  type="button"
                  onClick={() => setShowNewPw(v => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                >
                  {showNewPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>
            {/* Confirm password */}
            <div>
              <label className="label text-xs">Confirm New Password</label>
              <input
                type="password"
                className="input text-sm"
                value={confirmPw}
                onChange={e => setConfirmPw(e.target.value)}
                placeholder="Repeat new password"
                autoComplete="new-password"
              />
            </div>

            {pwMsg && (
              <div className={`flex items-start gap-2 p-3 rounded-lg text-xs ${
                pwMsg.type === 'success'
                  ? 'bg-green-50 border border-green-200 text-green-800'
                  : 'bg-red-50 border border-red-200 text-red-700'
              }`}>
                {pwMsg.type === 'success'
                  ? <CheckCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                  : <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />}
                {pwMsg.text}
              </div>
            )}

            <button
              onClick={handleChangePassword}
              disabled={savingPw || !currentPw || !newPw || !confirmPw}
              className="btn-primary text-sm flex items-center gap-2 disabled:opacity-50"
            >
              {savingPw
                ? <><Loader2 className="w-4 h-4 animate-spin" /> Saving…</>
                : <><Lock className="w-4 h-4" /> Update Password</>}
            </button>
          </div>
        </div>
      </section>

      <CalendarsSection user={user} />

      {/* ── Notifications ────────────────────────────────────────────────────── */}
      <section id="notifications" className="card scroll-mt-8">
        <h2 className="text-base font-bold text-gray-900 mb-1 flex items-center gap-2">
          <Bell className="w-4 h-4 text-brand-red" /> Notifications
        </h2>
        <p className="text-xs text-gray-400 mb-5">Choose which email notifications you receive from Badger Board.</p>

        <div className="divide-y divide-gray-100">
          {NOTIF_PREFS.map(pref => (
            <div key={pref.key} className="flex items-center justify-between gap-4 py-3.5 first:pt-0 last:pb-0">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-gray-900">{pref.label}</p>
                <p className="text-xs text-gray-400 mt-0.5 leading-relaxed">{pref.desc}</p>
              </div>
              <button
                onClick={() => handleNotifToggle(pref.key)}
                className={`relative w-11 h-6 rounded-full transition-colors duration-200 flex-shrink-0 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-brand-red ${
                  notifPrefs[pref.key] ? 'bg-brand-red' : 'bg-gray-200'
                }`}
                role="switch"
                aria-checked={notifPrefs[pref.key]}
              >
                <span
                  className={`absolute top-1 w-4 h-4 bg-white rounded-full shadow-sm transition-transform duration-200 ${
                    notifPrefs[pref.key] ? 'translate-x-6' : 'translate-x-1'
                  }`}
                />
              </button>
            </div>
          ))}
        </div>
      </section>

      {/* ── Danger Zone ──────────────────────────────────────────────────────── */}
      <section className="card border-red-200 bg-red-50/30">
        <h2 className="text-base font-bold text-red-700 mb-1 flex items-center gap-2">
          <Trash2 className="w-4 h-4" /> Danger Zone
        </h2>
        <p className="text-xs text-red-500 mb-4">These actions are permanent and cannot be undone.</p>

        <div className="flex items-start justify-between gap-4 p-4 bg-white border border-red-200 rounded-xl">
          <div>
            <p className="text-sm font-semibold text-gray-900">Cancel my account</p>
            <p className="text-xs text-gray-500 mt-0.5">
              Remove your paid subscription. You can keep your data on the free Scout plan.
            </p>
          </div>
          <button
            onClick={() => { setCancelStep('warn'); setDeleteMsg(null) }}
            className="flex-shrink-0 text-xs font-semibold text-red-600 border border-red-200 hover:bg-red-50 px-3 py-1.5 rounded-lg transition-colors"
          >
            Cancel account
          </button>
        </div>
      </section>

      {/* ── Cancel at period end modal ─────────────────────────────────────── */}
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
                  <p className="text-yellow-100 text-xs mt-0.5">You'll keep access until your billing period ends</p>
                </div>
              </div>
              <button onClick={() => setCancelPeriodModal(false)} className="text-white/60 hover:text-white mt-0.5">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="px-6 py-5 space-y-4">
              <p className="text-sm text-gray-700">
                Your plan will remain active until the end of your current billing period.
                After that, your access will be fully removed and you'll be moved to the free Scout tier.
                This cannot be undone.
              </p>

              <div className="flex flex-col gap-2 pt-1">
                <button
                  onClick={() => setCancelPeriodModal(false)}
                  disabled={cancelPeriodLoading}
                  className="w-full py-2.5 bg-gray-100 hover:bg-gray-200 text-gray-800 text-sm font-bold rounded-xl transition-colors disabled:opacity-60"
                >
                  Keep My Plan
                </button>
                <button
                  onClick={handleCancelAtPeriodEnd}
                  disabled={cancelPeriodLoading}
                  className="w-full py-2.5 bg-red-600 hover:bg-red-700 text-white text-sm font-bold rounded-xl transition-colors disabled:opacity-60 flex items-center justify-center gap-2"
                >
                  {cancelPeriodLoading
                    ? <><Loader2 className="w-4 h-4 animate-spin" /> Cancelling…</>
                    : 'Yes, Cancel Plan'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Cancellation modal overlay ──────────────────────────────────────── */}
      {cancelStep && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">

          {/* ── Step 1: Downgrade offer ───────────────────────────────────────── */}
          {cancelStep === 'warn' && (
            <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full overflow-hidden">
              {/* Header */}
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
                <button onClick={() => setCancelStep(null)} className="text-white/60 hover:text-white mt-0.5">
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="px-6 py-5 space-y-4">
                {/* What they'd lose */}
                <div className="p-4 bg-red-50 border border-red-200 rounded-xl">
                  <p className="text-xs font-bold text-red-700 uppercase tracking-wider mb-2.5 flex items-center gap-1.5">
                    <Trash2 className="w-3.5 h-3.5" /> If you delete your account, you permanently lose:
                  </p>
                  <ul className="space-y-1.5">
                    {[
                      'Every candidate profile and their tracking history',
                      'All AI-generated profiles (including any credits you purchased)',
                      'Your election monitoring data and alerts',
                      'All prospecting lists and saved filters',
                      'Your entire account history — gone forever',
                    ].map(item => (
                      <li key={item} className="flex items-start gap-2 text-xs text-red-700">
                        <span className="mt-0.5 flex-shrink-0 font-bold">✕</span>
                        {item}
                      </li>
                    ))}
                  </ul>
                </div>

                <p className="text-xs text-gray-500 text-center">
                  <strong className="text-gray-800">There's a smarter option:</strong> downgrade to the free Scout plan.
                  Your data stays safe, your account stays active — just without the paid features.
                </p>

                {/* Option A — Downgrade (recommended) */}
                <button
                  onClick={handleDowngradeToFree}
                  disabled={deleteLoading}
                  className="w-full flex items-center justify-between p-4 bg-green-50 border-2 border-green-400 rounded-xl hover:bg-green-100 transition-colors text-left disabled:opacity-60"
                >
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 bg-green-500 rounded-lg flex items-center justify-center flex-shrink-0">
                      <CheckCircle className="w-4 h-4 text-white" />
                    </div>
                    <div>
                      <p className="text-sm font-bold text-green-800">Keep my data — move to free Scout plan</p>
                      <p className="text-xs text-green-600 mt-0.5">Cancel billing · Keep all candidates & profiles · Free forever</p>
                    </div>
                  </div>
                  {deleteLoading
                    ? <Loader2 className="w-4 h-4 text-green-600 animate-spin flex-shrink-0" />
                    : <ArrowRight className="w-4 h-4 text-green-600 flex-shrink-0" />}
                </button>

                {/* Option B — Delete (destructive) */}
                <button
                  onClick={() => setCancelStep('confirm')}
                  disabled={deleteLoading}
                  className="w-full flex items-center justify-between p-3 border border-gray-200 rounded-xl hover:bg-gray-50 transition-colors text-left disabled:opacity-60"
                >
                  <div>
                    <p className="text-sm font-semibold text-gray-600">Permanently delete everything</p>
                    <p className="text-xs text-gray-400 mt-0.5">All data destroyed · cannot be reversed</p>
                  </div>
                  <ChevronRight className="w-4 h-4 text-gray-400 flex-shrink-0" />
                </button>
              </div>
            </div>
          )}

          {/* ── Step 2: Final delete confirmation ────────────────────────────── */}
          {cancelStep === 'confirm' && (
            <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full overflow-hidden">
              {/* Skull header */}
              <div className="bg-gray-900 px-6 py-5 flex items-start justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-red-600 rounded-xl flex items-center justify-center flex-shrink-0">
                    <Trash2 className="w-5 h-5 text-white" />
                  </div>
                  <div>
                    <h3 className="text-white font-black text-base">This cannot be undone</h3>
                    <p className="text-gray-400 text-xs mt-0.5">You are about to permanently destroy your account</p>
                  </div>
                </div>
                <button onClick={() => setCancelStep(null)} className="text-gray-500 hover:text-white mt-0.5">
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="px-6 py-5 space-y-4">
                <div className="p-4 bg-gray-900 rounded-xl text-center">
                  <p className="text-white font-black text-lg">⚠ PERMANENT DATA DESTRUCTION ⚠</p>
                  <p className="text-gray-400 text-xs mt-1">The following will be <span className="text-red-400 font-bold">immediately and permanently wiped</span>:</p>
                </div>

                <div className="space-y-1.5">
                  {[
                    ['Candidates', 'Every profile, note, and tracking history'],
                    ['Profiles', 'Every AI report — including credits you paid for'],
                    ['Elections', 'All race monitoring, alerts, and result tracking'],
                    ['Prospecting', 'All saved lists, filters, and contact intelligence'],
                    ['Your account', 'Login credentials and all account history'],
                  ].map(([label, desc]) => (
                    <div key={label} className="flex items-center gap-3 p-2.5 bg-red-50 border border-red-100 rounded-lg">
                      <Trash2 className="w-3.5 h-3.5 text-red-500 flex-shrink-0" />
                      <div>
                        <span className="text-xs font-bold text-red-700">{label}</span>
                        <span className="text-xs text-red-500 ml-1.5">{desc}</span>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl flex items-start gap-2.5">
                  <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
                  <p className="text-xs text-amber-800">
                    <strong>Still time to change your mind.</strong> Downgrading to the free Scout plan keeps everything intact. You can re-upgrade anytime.
                  </p>
                </div>

                {deleteMsg && (
                  <div className="flex items-start gap-2 p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700">
                    <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                    {deleteMsg.text}
                  </div>
                )}

                <div className="flex flex-col gap-2 pt-1">
                  {/* Last escape hatch */}
                  <button
                    onClick={handleDowngradeToFree}
                    disabled={deleteLoading}
                    className="w-full py-2.5 bg-green-600 hover:bg-green-700 text-white text-sm font-bold rounded-xl transition-colors disabled:opacity-60"
                  >
                    {deleteLoading ? <Loader2 className="w-4 h-4 animate-spin mx-auto" /> : 'Actually — keep my data on Scout (free)'}
                  </button>
                  {/* Nuclear button */}
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
                    className="text-xs text-gray-400 hover:text-gray-600 text-center py-1 transition-colors"
                  >
                    Cancel — I changed my mind
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
