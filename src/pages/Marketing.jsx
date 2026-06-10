import React, { useState, useEffect, useCallback } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  Megaphone, Mail, CalendarDays, QrCode, Check, Loader2, AlertCircle,
  Sparkles, Lock, RefreshCw, ArrowRight, ExternalLink,
} from 'lucide-react'
import { useAuth } from '../contexts/AuthContext'
import {
  MARKETING_TIER, BILLING_PERIODS,
  hasMarketingAccess, getDayframerLocationId,
  effectiveMonthlyRate, periodTotal,
} from '../lib/tiers'

const SUBACCOUNT_API = '/.netlify/functions/dayframer-subaccount'
const SSO_API        = '/.netlify/functions/dayframer-sso'

// ─── Tool definitions (Phase 2 sub-navigation) ────────────────────────────────

const TOOLS = [
  { key: 'email',  label: 'Email Campaigns', icon: Mail         },
  { key: 'social', label: 'Social Planner',  icon: CalendarDays },
  { key: 'qr',     label: 'QR Codes',        icon: QrCode       },
]

// ─── Gated pricing display (shown when Marketing Tier not purchased) ──────────

function MarketingGate() {
  const { user, session } = useAuth()
  const navigate = useNavigate()
  const [billing, setBilling] = useState('monthly')
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState(null)

  const effective = effectiveMonthlyRate(MARKETING_TIER.monthlyPrice, billing)
  const total     = periodTotal(MARKETING_TIER.monthlyPrice, billing)
  const bp        = BILLING_PERIODS[billing]

  const purchase = async () => {
    if (!user) { navigate('/login'); return }
    setLoading(true)
    setError(null)
    try {
      const token = session?.access_token
      const res = await fetch('/.netlify/functions/create-checkout-session', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ product: 'marketing', billing, userId: user.id, email: user.email }),
      })
      const json = await res.json()
      if (json.url) { window.location.href = json.url; return }
      setError(json.error || 'Could not start checkout.')
    } catch {
      setError('Could not reach the server. Check your connection.')
    }
    setLoading(false)
  }

  return (
    <div className="max-w-3xl mx-auto">
      {/* Hero */}
      <div className="text-center mb-10">
        <div className="w-14 h-14 bg-brand-red/10 rounded-2xl flex items-center justify-center mx-auto mb-4">
          <Megaphone className="w-7 h-7 text-brand-red" />
        </div>
        <h1 className="text-2xl font-bold text-gray-900 mb-2">Marketing</h1>
        <p className="text-gray-500 max-w-lg mx-auto">
          {MARKETING_TIER.description}
        </p>
      </div>

      {/* Tool teaser cards */}
      <div className="grid sm:grid-cols-3 gap-4 mb-10">
        {TOOLS.map(t => {
          const Icon = t.icon
          return (
            <div key={t.key} className="rounded-xl border border-gray-200 bg-white p-5 relative overflow-hidden">
              <div className="absolute top-3 right-3">
                <Lock className="w-3.5 h-3.5 text-gray-300" />
              </div>
              <Icon className="w-5 h-5 text-gray-400 mb-3" />
              <p className="text-sm font-semibold text-gray-900">{t.label}</p>
            </div>
          )
        })}
      </div>

      {/* Error */}
      {error && (
        <div className="flex items-start gap-3 p-4 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700 mb-6">
          <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <span>{error}</span>
          <button onClick={() => setError(null)} className="ml-auto text-red-400 hover:text-red-600">✕</button>
        </div>
      )}

      {/* Pricing card */}
      <div className="rounded-2xl border border-gray-900 bg-white shadow-md p-6 sm:p-8">
        <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-6">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <span className="text-sm font-semibold text-gray-900">{MARKETING_TIER.name}</span>
              <span className="text-xs font-medium text-white bg-brand-red px-2 py-0.5 rounded-full">Add-on</span>
            </div>
            <div className="flex items-baseline gap-1 mb-1">
              <span className="text-4xl font-bold text-gray-900 tracking-tight">${effective}</span>
              <span className="text-sm text-gray-400">/mo</span>
            </div>
            <p className="text-sm text-gray-400 min-h-[20px]">
              {billing === 'monthly'
                ? 'Billed monthly · works with any plan'
                : `$${total} billed ${bp.label.toLowerCase()} · ${bp.badge}`}
            </p>
          </div>

          {/* Billing toggle */}
          <div className="flex items-center rounded-lg border border-gray-200 p-0.5 bg-gray-50 text-sm flex-shrink-0">
            {Object.values(BILLING_PERIODS).map(b => (
              <button
                key={b.key}
                onClick={() => setBilling(b.key)}
                className={`px-3 py-1.5 rounded-md font-medium transition-all ${
                  billing === b.key
                    ? 'bg-white text-gray-900 shadow-sm border border-gray-200'
                    : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                {b.label}
              </button>
            ))}
          </div>
        </div>

        <ul className="space-y-3 my-6">
          {MARKETING_TIER.features.map((f, i) => (
            <li key={i} className="flex items-start gap-2.5">
              <Check className="w-4 h-4 text-brand-red flex-shrink-0 mt-0.5" />
              <span className="text-sm text-gray-600">{f}</span>
            </li>
          ))}
        </ul>

        <button
          onClick={purchase}
          disabled={loading}
          className="w-full sm:w-auto bg-gray-900 hover:bg-gray-700 text-white font-semibold px-8 py-3 rounded-lg text-sm transition-colors flex items-center justify-center gap-2"
        >
          {loading
            ? <><Loader2 className="w-4 h-4 animate-spin" /> Redirecting…</>
            : <>Unlock Marketing <ArrowRight className="w-4 h-4" /></>}
        </button>

        <p className="text-xs text-gray-400 mt-4">
          Cancel anytime from your account settings. See all plans on the{' '}
          <button onClick={() => navigate('/plans')} className="underline underline-offset-2 hover:text-gray-600">
            Plans &amp; Pricing
          </button>{' '}
          page.
        </p>
      </div>
    </div>
  )
}

// ─── Phase 1 — workspace creation ("Create" button) ───────────────────────────
// First interaction after purchase: provisions the DayFramer subaccount from
// the Badger Board account's profile data.

function WorkspaceSetup({ onCreated }) {
  const { user, session, refreshSession } = useAuth()
  const [creating, setCreating] = useState(false)
  const [error,    setError]    = useState(null)

  const meta = user?.user_metadata ?? {}
  const accountFields = [
    { label: 'Workspace name', value: meta.business || meta.display_name || user?.email },
    { label: 'Contact',        value: [meta.first_name, meta.last_name].filter(Boolean).join(' ') || meta.display_name || '—' },
    { label: 'Email',          value: user?.email },
    { label: 'Phone',          value: meta.phone || '—' },
  ]

  const create = async () => {
    setCreating(true)
    setError(null)
    try {
      const res = await fetch(SUBACCOUNT_API, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session?.access_token}`,
        },
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Workspace creation failed')
      // Pick up dayframer_location_id written to user_metadata
      await refreshSession?.()
      onCreated(json.locationId)
    } catch (err) {
      setError(err.message || 'Workspace creation failed. Please try again.')
    }
    setCreating(false)
  }

  return (
    <div className="max-w-xl mx-auto">
      <div className="text-center mb-8">
        <div className="w-14 h-14 bg-green-50 rounded-2xl flex items-center justify-center mx-auto mb-4 border border-green-200">
          <Sparkles className="w-7 h-7 text-green-600" />
        </div>
        <h1 className="text-2xl font-bold text-gray-900 mb-2">You're in! Set up your workspace</h1>
        <p className="text-gray-500">
          One click creates your marketing workspace using your Badger Board account details.
          This only happens once.
        </p>
      </div>

      <div className="rounded-xl border border-gray-200 bg-white p-6 mb-6">
        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-4">
          Workspace will be created with
        </p>
        <dl className="space-y-3">
          {accountFields.map(f => (
            <div key={f.label} className="flex items-center justify-between gap-4">
              <dt className="text-sm text-gray-500">{f.label}</dt>
              <dd className="text-sm font-medium text-gray-900 truncate">{f.value}</dd>
            </div>
          ))}
        </dl>
        <p className="text-xs text-gray-400 mt-4 pt-4 border-t border-gray-100">
          Need to change these? Update your profile in Settings first.
        </p>
      </div>

      {error && (
        <div className="flex items-start gap-3 p-4 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700 mb-6">
          <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      <button
        onClick={create}
        disabled={creating}
        className="w-full bg-brand-red hover:bg-red-700 text-white font-semibold py-3 rounded-lg text-sm transition-colors flex items-center justify-center gap-2"
      >
        {creating
          ? <><Loader2 className="w-4 h-4 animate-spin" /> Creating your workspace…</>
          : <>Create Marketing Workspace</>}
      </button>
    </div>
  )
}

// ─── Embedded DayFramer tool (Email Campaigns / Social Planner) ───────────────
// Fetches a short-lived SSO URL so the tool loads signed-in — no second login.

function EmbeddedTool({ section }) {
  const { session } = useAuth()
  const [url,     setUrl]     = useState(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState(null)

  const loadSso = useCallback(async () => {
    setLoading(true)
    setError(null)
    setUrl(null)
    try {
      const res = await fetch(`${SSO_API}?section=${section}`, {
        headers: { Authorization: `Bearer ${session?.access_token}` },
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Could not open the tool')
      setUrl(json.url)
    } catch (err) {
      setError(err.message || 'Could not open the tool')
    }
    setLoading(false)
  }, [section, session?.access_token])

  useEffect(() => { loadSso() }, [loadSso])

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-gray-400">
        <Loader2 className="w-6 h-6 animate-spin mb-3" />
        <p className="text-sm">Signing you in…</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-24">
        <AlertCircle className="w-6 h-6 text-red-400 mb-3" />
        <p className="text-sm text-gray-600 mb-4">{error}</p>
        <button
          onClick={loadSso}
          className="inline-flex items-center gap-2 text-sm font-medium text-gray-700 border border-gray-200 rounded-lg px-4 py-2 hover:bg-gray-50 transition-colors"
        >
          <RefreshCw className="w-4 h-4" /> Try again
        </button>
      </div>
    )
  }

  return (
    <div>
      {/* Toolbar — escape hatch in case the tool refuses to render embedded */}
      <div className="flex items-center justify-end gap-2 mb-2">
        <button
          onClick={loadSso}
          className="inline-flex items-center gap-1.5 text-xs font-medium text-gray-500 hover:text-gray-800 px-2.5 py-1.5 rounded-lg hover:bg-gray-100 transition-colors"
          title="Reload the tool"
        >
          <RefreshCw className="w-3.5 h-3.5" /> Reload
        </button>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-xs font-medium text-gray-500 hover:text-gray-800 px-2.5 py-1.5 rounded-lg hover:bg-gray-100 transition-colors"
          title="Open in a new tab"
        >
          <ExternalLink className="w-3.5 h-3.5" /> Open in new tab
        </a>
      </div>
      <iframe
        src={url}
        title={section}
        className="w-full rounded-xl border border-gray-200 bg-white"
        style={{ height: 'calc(100dvh - 270px)', minHeight: 480 }}
        allow="clipboard-write"
      />
    </div>
  )
}

// ─── Phase 2 — tool navigation shell ──────────────────────────────────────────

function MarketingTools() {
  const [tool, setTool] = useState('email')

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Marketing</h1>
          <p className="text-sm text-gray-500 mt-0.5">Campaigns, content planning, and QR codes — in one place.</p>
        </div>

        {/* Tool switcher */}
        <div className="flex items-center rounded-lg border border-gray-200 p-0.5 bg-gray-50 text-sm flex-shrink-0">
          {TOOLS.map(t => {
            const Icon = t.icon
            return (
              <button
                key={t.key}
                onClick={() => setTool(t.key)}
                className={`flex items-center gap-2 px-4 py-2 rounded-md font-medium transition-all ${
                  tool === t.key
                    ? 'bg-white text-gray-900 shadow-sm border border-gray-200'
                    : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                <Icon className="w-4 h-4" />
                <span className="hidden sm:inline">{t.label}</span>
              </button>
            )
          })}
        </div>
      </div>

      {tool === 'email'  && <EmbeddedTool section="email"  />}
      {tool === 'social' && <EmbeddedTool section="social" />}
      {tool === 'qr'     && <EmbeddedTool section="qr"     />}
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function Marketing() {
  const { user, refreshSession } = useAuth()
  const [searchParams, setSearchParams] = useSearchParams()
  const hasAccess = hasMarketingAccess(user)
  const locationFromMeta = getDayframerLocationId(user)
  // Local override so the page flips to Phase 2 right after workspace creation,
  // even before the refreshed JWT propagates through context
  const [createdLocationId, setCreatedLocationId] = useState(null)
  const [activating, setActivating] = useState(searchParams.get('marketing') === 'success' && !hasAccess)

  // After Stripe redirect, the webhook may take a few seconds to write
  // marketing_tier to user_metadata — poll the session until it lands.
  useEffect(() => {
    if (!activating) return
    let attempts = 0
    const timer = setInterval(async () => {
      attempts += 1
      await refreshSession?.()
      if (attempts >= 10) {
        clearInterval(timer)
        setActivating(false)
      }
    }, 3000)
    return () => clearInterval(timer)
  }, [activating, refreshSession])

  useEffect(() => {
    if (hasAccess && activating) {
      setActivating(false)
      // Clean the query param off the URL
      searchParams.delete('marketing')
      setSearchParams(searchParams, { replace: true })
    }
  }, [hasAccess, activating, searchParams, setSearchParams])

  if (!hasAccess) {
    if (activating) {
      return (
        <div className="flex flex-col items-center justify-center py-32 text-gray-500">
          <Loader2 className="w-8 h-8 animate-spin mb-4 text-brand-red" />
          <p className="text-sm font-medium">Activating your Marketing Tier…</p>
          <p className="text-xs text-gray-400 mt-1">This usually takes a few seconds.</p>
        </div>
      )
    }
    return <MarketingGate />
  }

  const locationId = createdLocationId || locationFromMeta
  if (!locationId) {
    return <WorkspaceSetup onCreated={setCreatedLocationId} />
  }

  return <MarketingTools />
}
