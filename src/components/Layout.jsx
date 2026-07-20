import React, { useState, useRef, useEffect, useCallback } from 'react'
import { Outlet, NavLink, useNavigate, useLocation, Link } from 'react-router-dom'
import {
  LayoutDashboard, Building2, CalendarDays, Target, Users, ListChecks,
  FileText, Settings, LogOut, Menu, X, ChevronRight, Bell,
  User, CreditCard, Shield, ChevronDown, Tag, DoorOpen, UserCheck,
  ShieldCheck, Sparkles, Check, Scale, MessageCircle, Send, ExternalLink, Users2, Swords,
} from 'lucide-react'
import { useAuth } from '../contexts/AuthContext'
import BluejackLogo from './BluejackLogo'
import BadgerBoardLogo from './BadgerBoardLogo'
import { getUserTier, getTierConfig } from '../lib/tiers'
import { isNativeApp } from '../lib/native'

// ── Offline banner ─────────────────────────────────────────────────────────────
// Shown while the device has no connection. Reads (recently viewed data) are
// served from the on-device cache; door-knock logging queues via offlineQueue.
function OfflineBanner() {
  const [offline, setOffline] = React.useState(
    typeof navigator !== 'undefined' && navigator.onLine === false
  )
  React.useEffect(() => {
    const on  = () => setOffline(false)
    const off = () => setOffline(true)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => {
      window.removeEventListener('online', on)
      window.removeEventListener('offline', off)
    }
  }, [])
  if (!offline) return null
  return (
    <div className="bg-amber-500 text-white text-xs font-semibold text-center px-4 py-2">
      You&apos;re offline — showing recently viewed data where available. Changes to door-knock logs will sync when you reconnect.
    </div>
  )
}
import AnnouncementBanner from './AnnouncementBanner'
import PaymentLockOverlay from './PaymentLockOverlay'
import { useDossierStatus } from '../contexts/DossierStatusContext'

const APP_VERSION = 'v1.17.0'

// ─── Changelog (newest first) ────────────────────────────────────────────────
const CHANGELOG = [
  {
    version: 'v1.17.0',
    date: 'July 16, 2026',
    changes: [
      'Broadside now fills the entire page and ends every session with an AI-written report card (message discipline, pivots, trap avoidance) quoting your actual answers',
      'Sharper coaching: filler-heavy answers get pressed, flat denials trigger the deny follow-ups, and a worn-down opponent visibly concedes ground',
      'Snappier feel: instant reaction sounds, no overlapping audio on Next/Repeat, attacks capped at soundbite length',
      'Spar button on every Profiler dossier jumps straight into a session; mic setup is now visible and skippable (typed mode)',
    ],
  },
  {
    version: 'v1.16.0',
    date: 'July 16, 2026',
    changes: [
      'BROADSIDE (admin beta): AI opposition sparring — a voice-based opponent attacks with your dossier\u2019s vulnerabilities so you can take the hit before it\u2019s real',
      'Broadside AI + voice calls run through server-side proxies — no API keys in the browser',
      'Load any Profiler dossier straight into a sparring session',
    ],
  },
  {
    version: 'v1.15.2',
    date: 'May 18, 2026',
    changes: [
      'Fix: Stripe checkout now correctly authenticates — plans and billing portal now work for all users',
      'Fix: Downgrade-to-Scout and Delete Account flows now properly authenticated',
      'Stripe: Checkout pages now show custom Badger Board billing message',
      'Admin: One-time Stripe product setup endpoint added for provisioning all plan prices',
    ],
  },
  {
    version: 'v1.15.1',
    date: 'May 18, 2026',
    changes: [
      'Rename: all remaining "dossier" references renamed to "profile" throughout the app, emails, and PDF output',
    ],
  },
  {
    version: 'v1.15.0',
    date: 'May 16, 2026',
    changes: [
      'Stripe checkout: full support for new plan keys (c_monitor, c_active, c_campaign, a_monitor, a_active, a_campaign) and quarterly billing',
      'Fix: Settings, Profiler, and Layout pages no longer crash for users with unknown or unrecognized plan keys',
      'Fix: Weekly profile badge now correctly shows for Campaign and Action plan users',
      'Backend: Stripe webhook writes plan_type to user metadata on every plan change',
      'Bug fix: Admin lock/unlock button now correctly reflects payment status',
      'Bug fix: Comparison page loads correctly when opened directly from a URL with candidates pre-selected',
      'Bug fix: Profile status accept button no longer stalls if an error occurs',
      'Bug fix: Offices search now debounced — no more rapid-fire database calls while typing',
      'Security: AI prospect classification now enforces Campaign/Agency plan gate server-side',
      'Stability: null-guard fixes across Dashboard, Admin, VoterLists, GamePlan, DoorKnocking, and backend functions',
    ],
  },
  {
    version: 'v1.14.0',
    date: 'May 16, 2026',
    changes: [
      'Profile status recommendations: generated profiles now suggest status updates you can accept or dismiss',
      'Allies section simplified: empty sub-sections are hidden entirely — only known information is shown',
      'Profile history: all remaining "dossier" references renamed to "profile" throughout the UI',
      'News feed rebuilt: news articles on left, X feed + social posts on right; every item opens in new tab',
    ],
  },
  {
    version: 'v1.13.0',
    date: 'May 16, 2026',
    changes: [
      'Notes panel: quick-add timestamped notes on any candidate without entering edit mode',
      'Files & Attachments: upload PDFs, docs, images, and more directly to a candidate profile',
      'Per-file AI toggle: mark files as "AI On" to include them when generating profiles',
      'File download via signed URLs, with note delete and file delete in one panel',
    ],
  },
  {
    version: 'v1.12.0',
    date: 'May 16, 2026',
    changes: [
      'CSV Upload prospecting: import any CSV and AI classifies each person as Conservative, Liberal, or Unknown (70% confidence threshold)',
      'Email button on every prospect with an email address — one click to compose',
      'Add to Candidates button on CSV lists — push selected prospects directly to your Candidates section',
      'Lean filter on CSV prospecting lists: view all / conservative / liberal / unknown',
    ],
  },
  {
    version: 'v1.11.0',
    date: 'May 16, 2026',
    changes: [
      'Scout plan: lite profile with blur/gate overlay on locked sections',
      'Fixed plan gating — Section 6 & 13 now correctly require Campaign tier',
      'Candidates without a linked office now appear on the map (WI centroid fallback)',
      'Feature gating updated for new plan key structure (c_campaign, a_campaign, etc.)',
    ],
  },
  {
    version: 'v1.10.28',
    date: 'May 15, 2025',
    changes: [
      'Support chat plan names updated for new plan structure',
      'Game Plan: redesigned milestones with column layout and urgency chips',
      'Offices DB: deduplication + all 72 WI county board supervisor seats seeded',
      'Lincoln County board supervisor seats now visible on the map',
    ],
  },
  {
    version: 'v1.10.20',
    date: 'May 14, 2025',
    changes: [
      'New two-product pricing — Candidate Plan & Action Plan families',
      'Pricing page rebuilt with billing period toggle and bracket table',
      'Tiers rewritten: scout, c_monitor, c_active, c_campaign, a_monitor, a_active, a_campaign',
      'Map sidebar z-index fix (no longer overlaps mobile nav)',
    ],
  },
  {
    version: 'v1.10.15',
    date: 'May 12, 2025',
    changes: [
      'Profile-ready email notification added to generate pipeline',
      'Notifications section added to Settings',
      'Profiles renamed to Profiler throughout the app',
      'Research context field replaces party in new-candidate form',
    ],
  },
]

const navItems = [
  { to: '/',            icon: LayoutDashboard, label: 'Dashboard',    end: true },
  { to: '/offices',     icon: Building2,       label: 'Offices'       },
  { to: '/game-plan',   icon: Target,          label: 'Game Plan'     },
  { to: '/candidates',  icon: Users,           label: 'Candidates'    },
  { to: '/prospecting', icon: ListChecks,      label: 'Prospecting'   },
  { to: '/voter-lists', icon: UserCheck,       label: 'Voter Lists'   },
  { to: '/profiler',    icon: FileText,        label: 'Profiler'      },
  { to: '/compare',     icon: Scale,           label: 'Compare'       },
  { to: '/broadside',   icon: Swords,          label: 'Broadside',     badge: 'Beta', adminOnly: true, webOnly: true },
  { to: '/events',      icon: CalendarDays,    label: 'Events',        badge: 'New' },
  { to: '/campaign-connect', icon: Users2,     label: 'Campaign Connect' },
  // Door Knocking hidden from UI (feature parked — restore this line to re-enable)
  // { to: '/door-knocking', icon: DoorOpen,      label: 'Door Knocking', badge: 'Beta', adminOnly: true },
]

// ─── NavItem ─────────────────────────────────────────────────────────────────
// Defined at module level so React never sees a new component type on re-render.
const NavItem = React.memo(function NavItem({ item, onNavigate }) {
  const Icon = item.icon
  return (
    <NavLink
      to={item.to}
      end={item.end}
      onClick={onNavigate}
      className={({ isActive }) =>
        `flex items-center gap-3 px-4 py-2.5 rounded-lg text-sm font-medium transition-all duration-150 ${
          isActive
            ? 'bg-brand-red text-white'
            : 'text-white/70 hover:text-white hover:bg-white/10'
        }`
      }
    >
      <Icon className="w-4 h-4 flex-shrink-0" />
      <span>{item.label}</span>
      {item.badge && (
        <span className="ml-auto text-xs bg-white/20 text-white px-1.5 py-0.5 rounded-full">
          {item.badge}
        </span>
      )}
    </NavLink>
  )
})

// ─── Changelog Popover ────────────────────────────────────────────────────────
function ChangelogPopover({ onClose }) {
  return (
    <div className="absolute bottom-full left-0 right-0 mb-2 mx-3 z-50">
      <div className="bg-gray-900 border border-white/10 rounded-xl shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-3.5 py-2.5 border-b border-white/10">
          <span className="text-xs font-bold text-white/80 uppercase tracking-wider">What's New</span>
          <button onClick={onClose} className="text-white/40 hover:text-white/80 transition-colors">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
        {/* Entries */}
        <div className="max-h-72 overflow-y-auto divide-y divide-white/5">
          {CHANGELOG.map((entry) => (
            <div key={entry.version} className="px-3.5 py-2.5">
              <div className="flex items-center gap-2 mb-1.5">
                <span className="text-xs font-bold text-brand-red">{entry.version}</span>
                <span className="text-white/30 text-xs">·</span>
                <span className="text-white/40 text-xs">{entry.date}</span>
              </div>
              <ul className="space-y-0.5">
                {entry.changes.map((c, i) => (
                  <li key={i} className="text-xs text-white/60 flex items-start gap-1.5">
                    <span className="text-white/25 mt-0.5 flex-shrink-0">·</span>
                    <span>{c}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ─── Sidebar ─────────────────────────────────────────────────────────────────
// Also module-level. Receives everything it needs via props.
const Sidebar = React.memo(function Sidebar({ isAdmin, onNavigate, onSignOut, tierConfig }) {
  const [showChangelog, setShowChangelog] = useState(false)
  return (
    <div className="flex flex-col h-full bg-brand-navy">
      {/* Badger Board logo */}
      <div className="px-4 pt-4 pb-3 border-b border-white/10">
        <div className="flex justify-center">
          <BadgerBoardLogo width={180} />
        </div>
        <p className="text-white/30 text-center mt-1" style={{ fontSize: '9px', letterSpacing: '0.22em', textTransform: 'uppercase' }}>
          CAMPAIGNS MADE SIMPLE.
        </p>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
        <p className="text-white/30 text-xs font-semibold uppercase tracking-wider px-4 mb-3">Intelligence</p>
        {navItems.slice(0, 4).map(item => (
          <NavItem key={item.to} item={item} onNavigate={onNavigate} />
        ))}
        <p className="text-white/30 text-xs font-semibold uppercase tracking-wider px-4 mb-3 mt-5">AI Tools</p>
        {navItems.slice(4, 9).filter(item => (!item.adminOnly || isAdmin) && !(item.webOnly && isNativeApp)).map(item => (
          <NavItem key={item.to} item={item} onNavigate={onNavigate} />
        ))}
        <p className="text-white/30 text-xs font-semibold uppercase tracking-wider px-4 mb-3 mt-5">Outreach</p>
        {navItems.slice(9, 11).map(item => (
          <NavItem key={item.to} item={item} onNavigate={onNavigate} />
        ))}
        {/* Field Ops group hidden (Door Knocking parked) — restore with the nav item to re-enable
        <p className="text-white/30 text-xs font-semibold uppercase tracking-wider px-4 mb-3 mt-5">Field Ops</p>
        {navItems.slice(9).filter(item => !item.adminOnly || isAdmin).map(item => (
          <NavItem key={item.to} item={item} onNavigate={onNavigate} />
        ))}
        */}
      </nav>

      {/* Bottom section */}
      <div className="p-3 border-t border-white/10 space-y-1">
        {isAdmin && (
          <NavLink
            to="/admin"
            onClick={onNavigate}
            className={({ isActive }) =>
              `flex items-center gap-3 px-4 py-2.5 rounded-lg text-sm font-medium transition-all duration-150 ${
                isActive ? 'bg-brand-red text-white' : 'text-white/70 hover:text-white hover:bg-white/10'
              }`
            }
          >
            <ShieldCheck className="w-4 h-4" />
            <span>Admin Panel</span>
          </NavLink>
        )}
        {/* Store rules: no purchase/pricing UI in the native app */}
        {!isNativeApp && (
          <NavLink
            to="/plans"
            onClick={onNavigate}
            className={({ isActive }) =>
              `flex items-center gap-3 px-4 py-2.5 rounded-lg text-sm font-medium transition-all duration-150 ${
                isActive ? 'bg-brand-red text-white' : 'text-white/70 hover:text-white hover:bg-white/10'
              }`
            }
          >
            <Tag className="w-4 h-4" />
            <span>Plans &amp; Pricing</span>
          </NavLink>
        )}
        <NavLink
          to="/settings"
          onClick={onNavigate}
          className={({ isActive }) =>
            `flex items-center gap-3 px-4 py-2.5 rounded-lg text-sm font-medium transition-all duration-150 ${
              isActive ? 'bg-brand-red text-white' : 'text-white/70 hover:text-white hover:bg-white/10'
            }`
          }
        >
          <Settings className="w-4 h-4" />
          <span>Settings</span>
        </NavLink>
        <button
          type="button"
          onClick={onSignOut}
          className="w-full flex items-center gap-3 px-4 py-2.5 rounded-lg text-sm font-medium text-white/70 hover:text-white hover:bg-white/10 transition-all duration-150"
        >
          <LogOut className="w-4 h-4" />
          <span>Sign Out</span>
        </button>

        {/* Powered by Bluejack Group + version changelog */}
        <div className="px-4 py-3 mt-1 flex flex-col items-center gap-1.5 relative">
          {showChangelog && <ChangelogPopover onClose={() => setShowChangelog(false)} />}
          <div className="flex items-center gap-2">
            <span className="text-white/30 text-xs">Powered by</span>
            <a href="https://www.thebluejackgroup.com" target="_blank" rel="noopener noreferrer">
              <BluejackLogo width={80} className="opacity-90 hover:opacity-100 transition-opacity" />
            </a>
          </div>
          <div className="flex items-center gap-2">
            <a href="/terms" className="text-white/25 hover:text-white/50 text-xs transition-colors" style={{ letterSpacing: '0.05em' }}>
              Terms of Service
            </a>
            <span className="text-white/15 text-xs">·</span>
            <button
              onClick={() => setShowChangelog(v => !v)}
              className="text-white/25 hover:text-white/60 text-xs transition-colors underline decoration-dotted underline-offset-2 cursor-pointer"
              title="What's new in this version"
            >
              {APP_VERSION}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
})

// ─── Dossier Status Indicator ─────────────────────────────────────────────────
function DossierStatusIndicator() {
  const { phase, candidateName, readyDossier, clearStatus } = useDossierStatus()
  const navigate    = useNavigate()
  const [hover, setHover] = useState(false)

  if (phase === 'idle') return null

  if (phase === 'generating') {
    return (
      <div
        className="relative flex items-center gap-2 px-3 py-1.5 rounded-lg bg-brand-navy/8 border border-brand-navy/15"
        title={`Generating profile${candidateName ? ` for ${candidateName}` : ''}…`}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
      >
        <Sparkles className="w-4 h-4 text-brand-navy animate-pulse flex-shrink-0" />
        <span className="text-xs font-medium text-brand-navy hidden sm:block max-w-28 truncate">
          {candidateName ? `Generating…` : 'Generating…'}
        </span>
        {/* Pulsing dot */}
        <span className="w-2 h-2 rounded-full bg-amber-400 flex-shrink-0">
          <span className="absolute w-2 h-2 rounded-full bg-amber-400 animate-ping" />
        </span>
        {hover && candidateName && (
          <div className="absolute top-full left-1/2 -translate-x-1/2 mt-2 z-50 bg-gray-900 text-white text-xs rounded-lg px-3 py-1.5 whitespace-nowrap shadow-lg">
            Generating profile for <span className="font-semibold">{candidateName}</span>
          </div>
        )}
      </div>
    )
  }

  if (phase === 'ready' && readyDossier) {
    return (
      <div className="relative flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => {
            navigate(`/dossiers?view=${readyDossier.id}`)
            clearStatus()
          }}
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-green-50 border border-green-200 hover:bg-green-100 hover:border-green-300 transition-colors group"
          title={`Profile ready — ${readyDossier.candidateName}`}
        >
          <div className="relative flex-shrink-0">
            <FileText className="w-4 h-4 text-green-700" />
            <div className="absolute -top-1 -right-1 w-3 h-3 bg-green-500 rounded-full flex items-center justify-center">
              <Check className="w-2 h-2 text-white" strokeWidth={3} />
            </div>
          </div>
          <span className="text-xs font-semibold text-green-800 hidden sm:block max-w-36 truncate">
            {readyDossier.candidateName} — Ready
          </span>
          <ChevronRight className="w-3 h-3 text-green-600 flex-shrink-0 hidden sm:block opacity-0 group-hover:opacity-100 transition-opacity" />
        </button>
        <button
          type="button"
          onClick={clearStatus}
          className="p-1 rounded hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors"
          title="Dismiss"
        >
          <X className="w-3 h-3" />
        </button>
      </div>
    )
  }

  return null
}

// ─── Support Chat Widget ──────────────────────────────────────────────────────
const CHAT_API = '/.netlify/functions/support-chat'

function SupportChatWidget() {
  const { session }             = useAuth()
  const [open, setOpen]         = useState(false)
  const [messages, setMessages] = useState([
    { role: 'assistant', content: 'Hi! I\'m the Badger Board support assistant. How can I help you today?' }
  ])
  const [input, setInput]       = useState('')
  const [loading, setLoading]   = useState(false)
  const bottomRef               = useRef(null)

  useEffect(() => {
    if (open) bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, open])

  const sendMessage = async (e) => {
    e?.preventDefault()
    const text = input.trim()
    if (!text || loading) return

    const userMsg = { role: 'user', content: text }
    setMessages(prev => [...prev, userMsg])
    setInput('')
    setLoading(true)

    try {
      // Build history excluding the initial greeting (which is UI-only)
      const history = [...messages.slice(1), userMsg]
        .map(m => ({ role: m.role, content: m.content }))

      const res = await fetch(CHAT_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: history,
          // JWT is verified server-side; user_id is derived from the token there,
          // never from the request body, preventing identity spoofing.
          token: session?.access_token ?? null,
        }),
      })
      const data = await res.json()
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: data.reply || 'Sorry, I couldn\'t get a response. Try support@badgerboardwi.com.'
      }])
    } catch {
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: 'Something went wrong. Please try again or email support@badgerboardwi.com.'
      }])
    }
    setLoading(false)
  }

  return (
    <>
      {/* Chat panel */}
      {open && (
        <div
          style={{
            position: 'fixed', bottom: '80px', right: '16px',
            width: 'min(340px, calc(100vw - 32px))',
            maxHeight: 'min(480px, calc(100dvh - 120px))',
            background: '#fff', borderRadius: '16px',
            boxShadow: '0 20px 60px rgba(0,0,0,0.18)', zIndex: 9999,
            display: 'flex', flexDirection: 'column', overflow: 'hidden',
            border: '1px solid #e5e7eb',
          }}
        >
          {/* Header */}
          <div style={{ background: '#1e3a5f', padding: '14px 16px', display: 'flex', alignItems: 'center', gap: '10px', flexShrink: 0 }}>
            <div style={{ width: 32, height: 32, background: '#dc2626', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <MessageCircle style={{ width: 16, height: 16, color: '#fff' }} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ color: '#fff', fontWeight: 600, fontSize: 14, lineHeight: 1.3 }}>Badger Board Support</div>
              <div style={{ color: 'rgba(255,255,255,0.55)', fontSize: 11 }}>AI assistant · Usually instant</div>
            </div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <a
                href="https://support.badgerboardwi.com"
                target="_blank"
                rel="noopener noreferrer"
                title="Full support site"
                style={{ color: 'rgba(255,255,255,0.5)', display: 'flex', alignItems: 'center' }}
              >
                <ExternalLink style={{ width: 14, height: 14 }} />
              </a>
              <button
                onClick={() => setOpen(false)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(255,255,255,0.5)', padding: 2, display: 'flex', alignItems: 'center' }}
              >
                <X style={{ width: 16, height: 16 }} />
              </button>
            </div>
          </div>

          {/* Messages */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '14px 14px 8px', display: 'flex', flexDirection: 'column', gap: 10 }}>
            {messages.map((msg, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start' }}>
                <div style={{
                  maxWidth: '82%',
                  padding: '8px 12px',
                  borderRadius: msg.role === 'user' ? '12px 12px 3px 12px' : '12px 12px 12px 3px',
                  background: msg.role === 'user' ? '#dc2626' : '#f3f4f6',
                  color: msg.role === 'user' ? '#fff' : '#111827',
                  fontSize: 13,
                  lineHeight: 1.5,
                }}>
                  {msg.content}
                </div>
              </div>
            ))}
            {loading && (
              <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
                <div style={{ background: '#f3f4f6', borderRadius: '12px 12px 12px 3px', padding: '8px 14px', display: 'flex', gap: 4, alignItems: 'center' }}>
                  {[0,1,2].map(i => (
                    <div key={i} style={{ width: 6, height: 6, borderRadius: '50%', background: '#9ca3af', animation: `bounce 1s ease-in-out ${i * 0.15}s infinite` }} />
                  ))}
                </div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          {/* Input */}
          <form
            onSubmit={sendMessage}
            style={{ borderTop: '1px solid #e5e7eb', padding: '10px 12px', display: 'flex', gap: 8, flexShrink: 0 }}
          >
            <input
              value={input}
              onChange={e => setInput(e.target.value)}
              placeholder="Ask a question…"
              disabled={loading}
              style={{
                flex: 1, border: '1px solid #e5e7eb', borderRadius: 8, padding: '8px 12px',
                fontSize: 13, outline: 'none', background: loading ? '#f9fafb' : '#fff',
                color: '#111827',
              }}
            />
            <button
              type="submit"
              disabled={!input.trim() || loading}
              style={{
                background: input.trim() && !loading ? '#dc2626' : '#e5e7eb',
                border: 'none', borderRadius: 8, padding: '8px 12px', cursor: input.trim() && !loading ? 'pointer' : 'not-allowed',
                display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'background .15s', flexShrink: 0,
              }}
            >
              <Send style={{ width: 15, height: 15, color: input.trim() && !loading ? '#fff' : '#9ca3af' }} />
            </button>
          </form>
        </div>
      )}

      {/* FAB */}
      <button
        onClick={() => setOpen(o => !o)}
        title="Support chat"
        style={{
          position: 'fixed', bottom: 20, right: 20, width: 52, height: 52,
          borderRadius: '50%', background: '#1e3a5f',
          boxShadow: '0 4px 20px rgba(30,58,95,0.4)', border: '2px solid rgba(255,255,255,0.15)',
          cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
          zIndex: 9998, transition: 'transform .15s, box-shadow .15s',
        }}
        onMouseEnter={e => { e.currentTarget.style.transform = 'scale(1.08)'; e.currentTarget.style.boxShadow = '0 6px 24px rgba(30,58,95,0.5)' }}
        onMouseLeave={e => { e.currentTarget.style.transform = 'scale(1)'; e.currentTarget.style.boxShadow = '0 4px 20px rgba(30,58,95,0.4)' }}
      >
        {open
          ? <X style={{ width: 20, height: 20, color: '#fff' }} />
          : <MessageCircle style={{ width: 22, height: 22, color: '#fff' }} />
        }
      </button>

      <style>{`
        @keyframes bounce {
          0%, 80%, 100% { transform: scale(0.6); opacity: 0.4; }
          40%            { transform: scale(1);   opacity: 1;   }
        }
      `}</style>
    </>
  )
}

// ─── Layout ───────────────────────────────────────────────────────────────────
export default function Layout() {
  const { user, signOut, isAdmin } = useAuth()
  // Full-bleed routes own the whole content area (no padding, no outer scroll)
  const { pathname } = useLocation()
  const fullBleed = pathname.startsWith('/broadside')
  const navigate           = useNavigate()
  const [sidebarOpen, setSidebarOpen]   = useState(false)
  const [profileOpen, setProfileOpen]   = useState(false)
  const profileRef                       = useRef(null)

  const userTier   = getUserTier(user)
  const tierConfig = getTierConfig(userTier) || getTierConfig('scout')

  // Close profile dropdown when clicking outside
  useEffect(() => {
    const handler = (e) => {
      if (profileRef.current && !profileRef.current.contains(e.target)) {
        setProfileOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const handleSignOut = useCallback(async () => {
    setProfileOpen(false)
    await signOut()
    navigate('/login')
  }, [signOut, navigate])

  // Stable callback — passed to Sidebar/NavItem so they never re-render due to
  // a new function reference being created on each Layout render.
  const onNavigate = useCallback(() => setSidebarOpen(false), [])

  return (
    <div className="flex h-screen overflow-hidden bg-brand-gray">
      {/* Sidebar — visible on md+ (iPad portrait and up) */}
      <aside className="hidden md:flex md:flex-col w-64 flex-shrink-0">
        <Sidebar
          isAdmin={isAdmin}
          onNavigate={onNavigate}
          onSignOut={handleSignOut}
          tierConfig={tierConfig}
        />
      </aside>

      {/* Mobile sidebar overlay — phones only (< md) */}
      {sidebarOpen && (
        <div className="md:hidden fixed inset-0 z-[9990] flex">
          <div className="fixed inset-0 bg-black/60" onClick={() => setSidebarOpen(false)} />
          <div className="relative flex flex-col w-72 max-w-xs">
            <Sidebar
              isAdmin={isAdmin}
              onNavigate={onNavigate}
              onSignOut={handleSignOut}
              tierConfig={tierConfig}
            />
            <button
              type="button"
              onClick={() => setSidebarOpen(false)}
              className="absolute top-4 right-4 text-white/70 hover:text-white"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>
      )}

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Top bar */}
        <header className="bg-white border-b border-gray-200 px-4 md:px-6 lg:px-8 py-3 flex items-center gap-4 flex-shrink-0">
          <button
            type="button"
            className="md:hidden p-2 rounded-lg hover:bg-gray-100 transition-colors"
            onClick={() => setSidebarOpen(true)}
          >
            <Menu className="w-5 h-5 text-gray-600" />
          </button>


          <div className="ml-auto flex items-center gap-3">
            {/* Dossier generation status indicator */}
            <DossierStatusIndicator />

            <button
              type="button"
              disabled
              title="Notifications — coming soon"
              aria-label="Notifications (coming soon)"
              className="relative p-2 rounded-lg opacity-40 cursor-not-allowed"
            >
              <Bell className="w-4 h-4 text-gray-500" />
            </button>

            {/* Profile dropdown */}
            <div className="relative" ref={profileRef}>
              <button
                type="button"
                onClick={() => setProfileOpen(o => !o)}
                className="flex items-center gap-1.5 rounded-xl hover:bg-gray-100 pl-1 pr-2 py-1 transition-colors"
              >
                <div className="w-8 h-8 bg-brand-red rounded-full flex items-center justify-center text-white text-sm font-bold flex-shrink-0">
                  {user?.user_metadata?.display_name?.[0]?.toUpperCase() ?? user?.email?.[0]?.toUpperCase() ?? 'U'}
                </div>
                <ChevronDown className={`w-3.5 h-3.5 text-gray-400 transition-transform duration-150 ${profileOpen ? 'rotate-180' : ''}`} />
              </button>

              {profileOpen && (
                <div className="absolute right-0 top-full mt-2 w-64 bg-white rounded-xl shadow-xl border border-gray-200 py-2 z-50">
                  {/* User info header */}
                  <div className="px-4 py-3 border-b border-gray-100">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 bg-brand-red rounded-full flex items-center justify-center text-white text-base font-bold flex-shrink-0">
                        {user?.user_metadata?.display_name?.[0]?.toUpperCase() ?? user?.email?.[0]?.toUpperCase() ?? 'U'}
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-gray-900 truncate">
                          {user?.user_metadata?.display_name || user?.email?.split('@')[0] || 'User'}
                        </p>
                        <p className="text-xs text-gray-400 truncate">{user?.email}</p>
                      </div>
                    </div>
                    {/* Plan badge */}
                    <div className="mt-2.5 flex items-center justify-between">
                      <span className="text-xs text-gray-400">Current plan</span>
                      <span className="text-xs font-semibold text-brand-red bg-brand-red/10 px-2 py-0.5 rounded-full">
                        {tierConfig?.name || 'Scout'}
                      </span>
                    </div>
                  </div>

                  {/* Menu items */}
                  <div className="py-1">
                    <Link
                      to="/settings"
                      onClick={() => setProfileOpen(false)}
                      className="flex items-center gap-3 px-4 py-2.5 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
                    >
                      <User className="w-4 h-4 text-gray-400" />
                      My Profile
                    </Link>
                    <Link
                      to="/settings#billing"
                      onClick={() => setProfileOpen(false)}
                      className="flex items-center gap-3 px-4 py-2.5 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
                    >
                      <CreditCard className="w-4 h-4 text-gray-400" />
                      Billing &amp; Plan
                    </Link>
                    <Link
                      to="/settings#security"
                      onClick={() => setProfileOpen(false)}
                      className="flex items-center gap-3 px-4 py-2.5 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
                    >
                      <Shield className="w-4 h-4 text-gray-400" />
                      Security
                    </Link>
                  </div>

                  <div className="border-t border-gray-100 py-1">
                    <button
                      type="button"
                      onClick={handleSignOut}
                      className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-red-600 hover:bg-red-50 transition-colors"
                    >
                      <LogOut className="w-4 h-4" />
                      Sign Out
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </header>

        {/* Announcement banner (above page content) */}
        <AnnouncementBanner />

        {/* Offline indicator */}
        <OfflineBanner />

        {/* Page content */}
        <main className={`flex-1 relative ${fullBleed ? 'overflow-hidden' : 'overflow-y-auto'}`}>
          <PaymentLockOverlay>
            <div className={fullBleed ? 'h-full' : 'p-4 md:p-6 lg:p-8'}>
              <Outlet />
            </div>
          </PaymentLockOverlay>
        </main>
      </div>

      {/* Floating support chat widget */}
      <SupportChatWidget />
    </div>
  )
}
