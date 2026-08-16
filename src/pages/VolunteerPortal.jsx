/**
 * VolunteerPortal.jsx
 * Mobile-first portal for campaign volunteers.
 * Accessible at /v — entirely separate from the main app auth.
 *
 * Sections:
 *   1. Login  — magic link email entry + token-from-URL auto-login
 *   2. Home   — stats overview + notifications
 *   3. Doors  — simplified door-knocking interface
 *   4. Chat   — real-time group messaging with coordinator
 *   5. Profile — volunteer stats + settings
 */

import React, { useState, useEffect, useRef, useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { isNativeApp, API_ORIGIN } from '../lib/native'
import {
  Home, DoorOpen, MessageCircle, User, Bell, Send,
  CheckCircle, XCircle, Clock, MapPin, Phone, Mail,
  ChevronRight, LogOut, Star, Zap, Trophy, Target,
  AlertCircle, Info, AlertTriangle, Wifi, WifiOff,
  ArrowRight, RefreshCw, ThumbsUp, ThumbsDown, Minus,
  ChevronLeft, MoreVertical, Circle,
} from 'lucide-react'

// ─── Constants ────────────────────────────────────────────────────────────────
const VOLUNTEER_SESSION_KEY = 'bb_volunteer_session'
const API = '/.netlify/functions/volunteer-auth'

const KNOCK_OUTCOMES = [
  { value: 'contact',     label: 'Spoke With Voter',  icon: CheckCircle, color: 'emerald' },
  { value: 'no_answer',   label: 'No Answer',          icon: Clock,       color: 'yellow'  },
  { value: 'not_home',    label: 'Left Lit',            icon: XCircle,     color: 'slate'   },
  { value: 'refused',     label: 'Refused',            icon: ThumbsDown,  color: 'red'     },
  { value: 'moved',       label: 'Wrong Address',      icon: MapPin,      color: 'orange'  },
]

const SUPPORT_LEVELS = [
  { value: 5, label: 'Strong Support',   emoji: '▲▲' },
  { value: 4, label: 'Lean Support',     emoji: '▲' },
  { value: 3, label: 'Undecided',        emoji: '●' },
  { value: 2, label: 'Lean Oppose',      emoji: '▼' },
  { value: 1, label: 'Strong Oppose',    emoji: '▼▼' },
]

const NOTIF_ICONS = {
  info:    { Icon: Info,          bg: 'bg-blue-500/20',   text: 'text-blue-400'   },
  warning: { Icon: AlertTriangle, bg: 'bg-yellow-500/20', text: 'text-yellow-400' },
  success: { Icon: CheckCircle,   bg: 'bg-emerald-500/20',text: 'text-emerald-400'},
  urgent:  { Icon: AlertCircle,   bg: 'bg-red-500/20',    text: 'text-red-400'    },
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
const callApi = async (action, params = {}, token = null) => {
  const headers = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(API, {
    method: 'POST',
    headers,
    body: JSON.stringify({ action, params }),
  })
  return res.json()
}

const saveSession = (data) =>
  localStorage.setItem(VOLUNTEER_SESSION_KEY, JSON.stringify(data))

const loadSession = () => {
  try { return JSON.parse(localStorage.getItem(VOLUNTEER_SESSION_KEY) || 'null') }
  catch { return null }
}

const clearSession = () => localStorage.removeItem(VOLUNTEER_SESSION_KEY)

const avatarInitials = (name = '') =>
  name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()

const timeAgo = (ts) => {
  if (!ts) return ''
  const diff = Date.now() - new Date(ts).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1)  return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatCard({ label, value, icon: Icon, color = 'red' }) {
  const colors = {
    red:     'from-red-600/30 to-red-800/10 border-red-500/20 text-red-400',
    emerald: 'from-emerald-600/30 to-emerald-800/10 border-emerald-500/20 text-emerald-400',
    blue:    'from-blue-600/30 to-blue-800/10 border-blue-500/20 text-blue-400',
    yellow:  'from-yellow-600/30 to-yellow-800/10 border-yellow-500/20 text-yellow-400',
  }
  return (
    <div className={`bg-gradient-to-br ${colors[color]} border rounded-xl p-4 flex flex-col gap-1`}>
      <Icon className={`w-5 h-5 ${colors[color].split(' ')[3]}`} />
      <div className="text-2xl font-bold text-white">{value}</div>
      <div className="text-xs text-white/50">{label}</div>
    </div>
  )
}

function NotifBadge({ count }) {
  if (!count) return null
  return (
    <span className="absolute -top-1 -right-1 bg-red-500 text-white text-xs font-bold rounded-full w-4 h-4 flex items-center justify-center">
      {count > 9 ? '9+' : count}
    </span>
  )
}

// ─── Login Screen ─────────────────────────────────────────────────────────────
function LoginScreen({ onLogin }) {
  const [email, setEmail]       = useState('')
  const [loading, setLoading]   = useState(false)
  const [sent, setSent]         = useState(false)
  const [error, setError]       = useState('')

  const handleSend = async (e) => {
    e.preventDefault()
    if (!email.trim()) return
    setLoading(true)
    setError('')
    try {
      // We use Supabase's OTP flow for magic links.
      // In the native shell window.location.origin is capacitor://localhost —
      // a link no mail client can open — so send native users to the web origin.
      const origin = isNativeApp ? API_ORIGIN : window.location.origin
      const { error: otpError } = await supabase.auth.signInWithOtp({
        email: email.trim().toLowerCase(),
        options: {
          emailRedirectTo: `${origin}/v`,
          // The volunteer portal is invite-only: a volunteer row must already
          // exist. Without this, signInWithOtp silently CREATES an auth user
          // for any address typed here, so anyone could mint an account from a
          // public URL and land on an empty portal.
          shouldCreateUser: false,
        },
      })
      if (otpError) throw otpError
      setSent(true)
    } catch (err) {
      setError(err.message || 'Failed to send login link. Try again.')
    }
    setLoading(false)
  }

  if (sent) {
    return (
      <div className="min-h-screen bg-[#0a0f1e] flex flex-col items-center justify-center p-6 text-center">
        <div className="w-16 h-16 bg-emerald-500/20 rounded-full flex items-center justify-center mb-6">
          <CheckCircle className="w-8 h-8 text-emerald-400" />
        </div>
        <h2 className="text-2xl font-bold text-white mb-2">Check Your Email</h2>
        <p className="text-white/60 text-sm mb-6">
          We sent a login link to <span className="text-white font-medium">{email}</span>.
          Tap the link in your email to sign in — no password needed.
        </p>
        <button
          onClick={() => setSent(false)}
          className="text-white/40 text-sm underline"
        >
          Use a different email
        </button>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-[#0a0f1e] flex flex-col items-center justify-center p-6">
      {/* Logo */}
      <div className="mb-8 text-center">
        <div className="w-16 h-16 bg-red-600 rounded-2xl flex items-center justify-center mx-auto mb-4 shadow-lg shadow-red-600/30">
          <DoorOpen className="w-8 h-8 text-white" />
        </div>
        <h1 className="text-2xl font-bold text-white">Badger Board</h1>
        <p className="text-white/50 text-sm mt-1">Volunteer Portal</p>
      </div>

      {/* Form */}
      <div className="w-full max-w-sm">
        <div className="bg-white/5 border border-white/10 rounded-2xl p-6">
          <h2 className="text-lg font-semibold text-white mb-1">Welcome back!</h2>
          <p className="text-white/50 text-sm mb-5">Enter your email to get a login link.</p>

          <form onSubmit={handleSend} className="space-y-4">
            <div>
              <label className="text-white/60 text-xs font-medium mb-1.5 block">Email Address</label>
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="you@email.com"
                required
                className="w-full bg-white/10 border border-white/20 rounded-xl px-4 py-3 text-white placeholder-white/30 text-sm focus:outline-none focus:ring-2 focus:ring-red-500/50 focus:border-red-500/50"
              />
            </div>

            {error && (
              <div className="flex items-center gap-2 bg-red-500/20 border border-red-500/30 rounded-lg px-3 py-2">
                <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0" />
                <p className="text-red-300 text-xs">{error}</p>
              </div>
            )}

            <button
              type="submit"
              disabled={loading || !email.trim()}
              className="w-full bg-red-600 hover:bg-red-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold py-3 rounded-xl text-sm transition-colors flex items-center justify-center gap-2"
            >
              {loading ? (
                <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
              ) : (
                <>Send Login Link <ArrowRight className="w-4 h-4" /></>
              )}
            </button>
          </form>
        </div>

        <p className="text-center text-white/30 text-xs mt-6">
          You must be invited by a campaign coordinator to use this portal.
        </p>
      </div>
    </div>
  )
}

// ─── Home Tab ─────────────────────────────────────────────────────────────────
function HomeTab({ volunteer, notifications, onMarkNotifRead, onRefresh }) {
  const unread = notifications.filter(n => !n.read_by?.includes(volunteer.id))

  return (
    <div className="p-4 space-y-5 pb-24">
      {/* Welcome header */}
      <div className="flex items-center gap-3 pt-2">
        <div
          className="w-12 h-12 rounded-2xl flex items-center justify-center text-white font-bold text-lg flex-shrink-0"
          style={{ backgroundColor: volunteer.avatar_color || '#dc2626' }}
        >
          {avatarInitials(volunteer.name)}
        </div>
        <div>
          <h2 className="text-lg font-bold text-white">Hey, {volunteer.name.split(' ')[0]}!</h2>
          <p className="text-white/50 text-xs capitalize">{volunteer.role} • {volunteer.list?.name || 'No list assigned'}</p>
        </div>
        <button onClick={onRefresh} className="ml-auto text-white/30 hover:text-white/60 transition-colors">
          <RefreshCw className="w-4 h-4" />
        </button>
      </div>

      {/* Stats grid */}
      <div>
        <h3 className="text-white/50 text-xs font-semibold uppercase tracking-wider mb-3">Your Stats</h3>
        <div className="grid grid-cols-2 gap-3">
          <StatCard label="Doors Knocked" value={volunteer.doors_knocked || 0} icon={DoorOpen} color="red" />
          <StatCard label="Contacts Made" value={volunteer.contacts_made || 0} icon={CheckCircle} color="emerald" />
          <StatCard label="Shifts Worked" value={volunteer.shifts_worked || 0} icon={Clock} color="blue" />
          <StatCard label="Last Active"
            value={volunteer.last_active ? timeAgo(volunteer.last_active) : 'Never'}
            icon={Zap} color="yellow" />
        </div>
      </div>

      {/* Notifications */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-white/50 text-xs font-semibold uppercase tracking-wider">
            Notifications
          </h3>
          {unread.length > 0 && (
            <span className="bg-red-500/20 text-red-400 text-xs px-2 py-0.5 rounded-full border border-red-500/20">
              {unread.length} new
            </span>
          )}
        </div>

        {notifications.length === 0 ? (
          <div className="bg-white/5 border border-white/10 rounded-xl p-4 text-center">
            <Bell className="w-6 h-6 text-white/20 mx-auto mb-2" />
            <p className="text-white/30 text-sm">No notifications yet</p>
          </div>
        ) : (
          <div className="space-y-2">
            {notifications.slice(0, 10).map(notif => {
              const cfg   = NOTIF_ICONS[notif.type] || NOTIF_ICONS.info
              const isNew = !notif.read_by?.includes(volunteer.id)
              return (
                <button
                  key={notif.id}
                  onClick={() => onMarkNotifRead(notif.id)}
                  className={`w-full text-left flex items-start gap-3 p-3 rounded-xl border transition-all ${
                    isNew
                      ? 'bg-white/8 border-white/15'
                      : 'bg-white/3 border-white/5 opacity-60'
                  }`}
                >
                  <div className={`w-8 h-8 rounded-lg ${cfg.bg} flex items-center justify-center flex-shrink-0 mt-0.5`}>
                    <cfg.Icon className={`w-4 h-4 ${cfg.text}`} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="text-white text-sm font-medium truncate">{notif.title}</p>
                      {isNew && <Circle className="w-2 h-2 fill-red-500 text-red-500 flex-shrink-0" />}
                    </div>
                    {notif.body && (
                      <p className="text-white/50 text-xs mt-0.5 line-clamp-2">{notif.body}</p>
                    )}
                    <p className="text-white/30 text-xs mt-1">{timeAgo(notif.created_at)}</p>
                  </div>
                </button>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Doors Tab ────────────────────────────────────────────────────────────────
function DoorsTab({ volunteer }) {
  const [address, setAddress]       = useState('')
  const [outcome, setOutcome]       = useState(null)
  const [support, setSupport]       = useState(null)
  const [notes, setNotes]           = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted]   = useState(false)
  const [submitError, setSubmitError] = useState(null)
  const [total, setTotal]           = useState(volunteer.doors_knocked || 0)

  const handleSubmit = async () => {
    if (!address.trim() || !outcome) return
    setSubmitting(true)
    setSubmitError(null)

    // Audit fix (#3): the knock used to be inserted directly with the anon
    // Supabase client — RLS rejected it, the result was never checked, and the
    // knock silently vanished while "Logged!" showed. It now goes through the
    // volunteer-auth log_knock action (service role, authorized by the durable
    // session token), which saves the knock AND updates stats in one call —
    // and we only celebrate if the server says it worked.
    try {
      const res = await callApi('log_knock', {
        volunteer_id: volunteer.id,
        address: address.trim(),
        status: outcome,
        support_level: support,
        notes: notes.trim() || null,
        session_token: loadSession()?.session_token,
      })

      if (!res?.logged) {
        setSubmitError(res?.error || "We couldn't save that door knock. Check your connection and try again.")
        setSubmitting(false)
        return
      }

      setTotal(typeof res.doors_knocked === 'number' ? res.doors_knocked : t => t + 1)
      setSubmitted(true)
      setSubmitting(false)

      // Reset after 1.5s
      setTimeout(() => {
        setAddress('')
        setOutcome(null)
        setSupport(null)
        setNotes('')
        setSubmitted(false)
      }, 1800)
    } catch {
      setSubmitError("We couldn't save that door knock. Check your connection and try again.")
      setSubmitting(false)
    }
  }

  if (submitted) {
    return (
      <div className="flex flex-col items-center justify-center h-full min-h-[400px] p-6 text-center pb-24">
        <div className="w-20 h-20 bg-emerald-500/20 rounded-full flex items-center justify-center mb-4 animate-pulse">
          <CheckCircle className="w-10 h-10 text-emerald-400" />
        </div>
        <h3 className="text-2xl font-bold text-white mb-1">Logged!</h3>
        <p className="text-white/50 text-sm">Door #{total} today</p>
      </div>
    )
  }

  return (
    <div className="p-4 space-y-5 pb-28">
      {/* Counter */}
      <div className="bg-gradient-to-r from-red-600/20 to-red-800/10 border border-red-500/20 rounded-2xl p-4 flex items-center gap-4">
        <DoorOpen className="w-8 h-8 text-red-400 flex-shrink-0" />
        <div>
          <div className="text-3xl font-bold text-white">{total}</div>
          <div className="text-white/50 text-xs">Doors knocked total</div>
        </div>
      </div>

      {/* Address */}
      <div>
        <label className="text-white/60 text-xs font-semibold uppercase tracking-wider mb-2 block">
          Address
        </label>
        <input
          type="text"
          value={address}
          onChange={e => setAddress(e.target.value)}
          placeholder="123 Main St"
          className="w-full bg-white/10 border border-white/20 rounded-xl px-4 py-3.5 text-white placeholder-white/30 text-base focus:outline-none focus:ring-2 focus:ring-red-500/50"
        />
      </div>

      {/* Outcome */}
      <div>
        <label className="text-white/60 text-xs font-semibold uppercase tracking-wider mb-2 block">
          Result
        </label>
        <div className="grid grid-cols-1 gap-2">
          {KNOCK_OUTCOMES.map(o => {
            const colors = {
              emerald: 'border-emerald-500 bg-emerald-500/20 text-emerald-300',
              yellow:  'border-yellow-500  bg-yellow-500/20  text-yellow-300',
              slate:   'border-slate-400   bg-slate-400/20   text-slate-300',
              red:     'border-red-500     bg-red-500/20     text-red-300',
              orange:  'border-orange-500  bg-orange-500/20  text-orange-300',
            }
            const isSelected = outcome === o.value
            return (
              <button
                key={o.value}
                onClick={() => setOutcome(o.value)}
                className={`flex items-center gap-3 px-4 py-3 rounded-xl border text-sm font-medium transition-all ${
                  isSelected
                    ? colors[o.color]
                    : 'border-white/10 bg-white/5 text-white/60'
                }`}
              >
                <o.icon className="w-4 h-4 flex-shrink-0" />
                {o.label}
                {isSelected && <CheckCircle className="w-4 h-4 ml-auto" />}
              </button>
            )
          })}
        </div>
      </div>

      {/* Support level (only if contact) */}
      {outcome === 'contact' && (
        <div>
          <label className="text-white/60 text-xs font-semibold uppercase tracking-wider mb-2 block">
            Support Level
          </label>
          <div className="grid grid-cols-5 gap-1.5">
            {SUPPORT_LEVELS.map(s => (
              <button
                key={s.value}
                onClick={() => setSupport(s.value)}
                className={`flex flex-col items-center gap-1 p-2 rounded-xl border text-xs transition-all ${
                  support === s.value
                    ? 'border-red-500 bg-red-500/20 text-white'
                    : 'border-white/10 bg-white/5 text-white/50'
                }`}
              >
                <span className="text-lg">{s.emoji}</span>
                <span className="leading-tight text-center">{s.label.split(' ')[0]}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Notes */}
      <div>
        <label className="text-white/60 text-xs font-semibold uppercase tracking-wider mb-2 block">
          Notes (optional)
        </label>
        <textarea
          value={notes}
          onChange={e => setNotes(e.target.value)}
          placeholder="Any details about this conversation..."
          rows={2}
          className="w-full bg-white/10 border border-white/20 rounded-xl px-4 py-3 text-white placeholder-white/30 text-sm focus:outline-none focus:ring-2 focus:ring-red-500/50 resize-none"
        />
      </div>

      {/* Error */}
      {submitError && (
        <div className="bg-red-500/15 border border-red-500/40 rounded-xl px-4 py-3 text-red-300 text-sm">
          {submitError}
        </div>
      )}

      {/* Submit */}
      <button
        onClick={handleSubmit}
        disabled={!address.trim() || !outcome || submitting}
        className="w-full bg-red-600 hover:bg-red-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-bold py-4 rounded-2xl text-base transition-colors flex items-center justify-center gap-2 shadow-lg shadow-red-600/20"
      >
        {submitting ? (
          <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
        ) : (
          <>Log Door Knock <ChevronRight className="w-5 h-5" /></>
        )}
      </button>
    </div>
  )
}

// ─── Chat Tab ─────────────────────────────────────────────────────────────────
function ChatTab({ volunteer, messages, onSend }) {
  const [text, setText]    = useState('')
  const [sending, setSend] = useState(false)
  const bottomRef          = useRef(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const handleSend = async () => {
    if (!text.trim() || sending) return
    setSend(true)
    await onSend(text.trim())
    setText('')
    setSend(false)
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-4 py-3 border-b border-white/10 flex-shrink-0">
        <h3 className="text-white font-semibold text-sm">{volunteer.list?.name || 'Campaign Chat'}</h3>
        <p className="text-white/40 text-xs">Group message thread</p>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3 pb-4" style={{ minHeight: 0 }}>
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-center py-12">
            <MessageCircle className="w-10 h-10 text-white/20 mb-3" />
            <p className="text-white/30 text-sm">No messages yet.</p>
            <p className="text-white/20 text-xs mt-1">Start the conversation!</p>
          </div>
        )}
        {messages.map(msg => {
          const isMe = msg.sender_id === volunteer.id
          return (
            <div key={msg.id} className={`flex gap-2 ${isMe ? 'flex-row-reverse' : ''}`}>
              {!isMe && (
                <div
                  className="w-7 h-7 rounded-full flex items-center justify-center text-white text-xs font-bold flex-shrink-0"
                  style={{ backgroundColor: msg.sender_type === 'coordinator' ? '#dc2626' : '#4f46e5' }}
                >
                  {avatarInitials(msg.sender_name)}
                </div>
              )}
              <div className={`max-w-[75%] ${isMe ? 'items-end' : 'items-start'} flex flex-col gap-1`}>
                {!isMe && (
                  <span className="text-white/40 text-xs px-1">
                    {msg.sender_name}
                    {msg.sender_type === 'coordinator' && (
                      <span className="ml-1 bg-red-500/20 text-red-400 text-xs px-1 rounded">Coordinator</span>
                    )}
                  </span>
                )}
                <div className={`px-3.5 py-2.5 rounded-2xl text-sm ${
                  isMe
                    ? 'bg-red-600 text-white rounded-tr-sm'
                    : 'bg-white/10 text-white/90 rounded-tl-sm'
                }`}>
                  {msg.content}
                </div>
                <span className="text-white/25 text-xs px-1">{timeAgo(msg.created_at)}</span>
              </div>
            </div>
          )
        })}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="flex-shrink-0 px-3 py-3 border-t border-white/10 flex items-end gap-2">
        <textarea
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() }
          }}
          placeholder="Message the team..."
          rows={1}
          className="flex-1 bg-white/10 border border-white/20 rounded-xl px-4 py-2.5 text-white placeholder-white/30 text-sm focus:outline-none focus:ring-2 focus:ring-red-500/50 resize-none"
        />
        <button
          onClick={handleSend}
          disabled={!text.trim() || sending}
          className="w-10 h-10 bg-red-600 hover:bg-red-500 disabled:opacity-40 rounded-xl flex items-center justify-center flex-shrink-0 transition-colors"
        >
          {sending
            ? <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
            : <Send className="w-4 h-4 text-white" />
          }
        </button>
      </div>
    </div>
  )
}

// ─── Profile Tab ──────────────────────────────────────────────────────────────
function ProfileTab({ volunteer, onLogout }) {
  return (
    <div className="p-4 space-y-5 pb-24">
      {/* Avatar */}
      <div className="flex flex-col items-center py-4">
        <div
          className="w-20 h-20 rounded-3xl flex items-center justify-center text-white font-bold text-2xl mb-3 shadow-xl"
          style={{ backgroundColor: volunteer.avatar_color || '#dc2626' }}
        >
          {avatarInitials(volunteer.name)}
        </div>
        <h2 className="text-xl font-bold text-white">{volunteer.name}</h2>
        <p className="text-white/50 text-sm capitalize">{volunteer.role}</p>
        <div className="flex items-center gap-2 mt-2">
          <span className={`text-xs px-2 py-0.5 rounded-full border ${
            volunteer.status === 'active'
              ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/20'
              : 'bg-yellow-500/20 text-yellow-400 border-yellow-500/20'
          }`}>
            {volunteer.status}
          </span>
        </div>
      </div>

      {/* Contact info */}
      <div className="bg-white/5 border border-white/10 rounded-2xl overflow-hidden">
        <div className="px-4 py-3 border-b border-white/5">
          <h3 className="text-white/70 text-xs font-semibold uppercase tracking-wider">Contact</h3>
        </div>
        <div className="p-4 space-y-3">
          <div className="flex items-center gap-3">
            <Mail className="w-4 h-4 text-white/40 flex-shrink-0" />
            <span className="text-white/80 text-sm">{volunteer.email}</span>
          </div>
          {volunteer.phone && (
            <div className="flex items-center gap-3">
              <Phone className="w-4 h-4 text-white/40 flex-shrink-0" />
              <span className="text-white/80 text-sm">{volunteer.phone}</span>
            </div>
          )}
          {volunteer.list?.name && (
            <div className="flex items-center gap-3">
              <MapPin className="w-4 h-4 text-white/40 flex-shrink-0" />
              <span className="text-white/80 text-sm">{volunteer.list.name}</span>
            </div>
          )}
        </div>
      </div>

      {/* Achievements */}
      <div>
        <h3 className="text-white/50 text-xs font-semibold uppercase tracking-wider mb-3">Achievements</h3>
        <div className="space-y-2">
          {[
            { threshold: 1,   icon: '⚑', label: 'First Door',       desc: 'Knocked your first door' },
            { threshold: 10,  icon: '✦', label: 'Getting Warmed Up', desc: 'Knocked 10 doors'        },
            { threshold: 50,  icon: '▲', label: 'On Fire',           desc: 'Knocked 50 doors'        },
            { threshold: 100, icon: '★', label: 'Century Club',      desc: 'Knocked 100 doors'       },
            { threshold: 250, icon: '◆', label: 'Road Warrior',      desc: 'Knocked 250 doors'       },
          ].map(a => {
            const earned = (volunteer.doors_knocked || 0) >= a.threshold
            return (
              <div key={a.threshold} className={`flex items-center gap-3 p-3 rounded-xl border ${
                earned ? 'bg-white/8 border-white/15' : 'bg-white/3 border-white/5 opacity-40'
              }`}>
                <span className="text-2xl">{a.icon}</span>
                <div>
                  <p className="text-white text-sm font-medium">{a.label}</p>
                  <p className="text-white/40 text-xs">{a.desc}</p>
                </div>
                {earned && <CheckCircle className="w-4 h-4 text-emerald-400 ml-auto" />}
              </div>
            )
          })}
        </div>
      </div>

      {/* Sign out */}
      <button
        onClick={onLogout}
        className="w-full flex items-center justify-center gap-2 bg-white/5 hover:bg-white/10 border border-white/10 text-white/70 hover:text-white py-3 rounded-xl text-sm transition-colors"
      >
        <LogOut className="w-4 h-4" />
        Sign Out
      </button>
    </div>
  )
}

// ─── Coordinator: Volunteer Management (embedded in DoorKnocking page) ────────
// Exported separately so DoorKnocking.jsx can import it
export function VolunteerManager({ listId, session }) {
  const [volunteers, setVols]   = useState([])
  const [loading, setLoading]   = useState(true)
  const [showInvite, setShow]   = useState(false)
  const [form, setForm]         = useState({ name: '', email: '', phone: '', role: 'canvasser' })
  const [notifForm, setNotif]   = useState({ title: '', body: '', type: 'info' })
  const [showNotif, setShowN]   = useState(false)
  const [saving, setSaving]     = useState(false)
  const [copiedLink, setCopied] = useState(null)

  const load = useCallback(async () => {
    if (!listId) {
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const { data, error } = await supabase
        .from('volunteers')
        .select('id, name, email, phone, role, status, created_at, doors_knocked, contacts_made, avatar_color')
        .eq('list_id', listId)
        .order('created_at', { ascending: false })
      if (error) throw error
      setVols(Array.isArray(data) ? data : [])
    } catch (err) {
      console.error('[VolunteerManager] load error:', err)
      setVols([])
    }
    setLoading(false)
  }, [listId])

  useEffect(() => { load() }, [load])

  const handleInvite = async (e) => {
    e.preventDefault()
    setSaving(true)
    try {
      const res = await fetch('/.netlify/functions/invite-volunteer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session}` },
        body: JSON.stringify({ name: form.name, email: form.email, phone: form.phone, role: form.role === 'captain' ? 'captain' : 'volunteer', listId }),
      })
      const json = await res.json()
      if (json.portalLink) {
        setCopied(json.portalLink)
        setTimeout(() => setCopied(null), 6000)
      }
      load()
    } catch (err) {
      console.error('[VolunteerManager] invite error:', err)
    }
    setForm({ name: '', email: '', phone: '', role: 'canvasser' })
    setShow(false)
    setSaving(false)
  }

  const handleNotification = async (e) => {
    e.preventDefault()
    setSaving(true)
    // Broadcast notification — stores in volunteer_notifications table when available
    try {
      await supabase.from('volunteer_notifications').insert({
        list_id: listId,
        title: notifForm.title,
        body: notifForm.body || null,
        type: notifForm.type,
        created_at: new Date().toISOString(),
      })
    } catch (_) { /* table may not exist yet — graceful no-op */ }
    setNotif({ title: '', body: '', type: 'info' })
    setShowN(false)
    setSaving(false)
  }

  const handleDelete = async (id) => {
    if (!confirm('Remove this volunteer?')) return
    await supabase.from('volunteers').delete().eq('id', id)
    setVols(v => v.filter(x => x.id !== id))
  }

  const handleResend = async (vol) => {
    if (!vol.email) { alert('No email address on file for this volunteer.'); return }
    setSaving(true)
    try {
      const res = await fetch('/.netlify/functions/invite-volunteer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session}` },
        body: JSON.stringify({ name: vol.name, email: vol.email, phone: vol.phone, role: vol.role, listId }),
      })
      const json = await res.json()
      if (json.portalLink) {
        setCopied(json.portalLink)
        setTimeout(() => setCopied(null), 6000)
      }
      load()
    } catch (err) {
      console.error('[VolunteerManager] resend error:', err)
    }
    setSaving(false)
  }

  const statusColor = s => ({
    invited:  'bg-yellow-500/20 text-yellow-400',
    active:   'bg-emerald-500/20 text-emerald-400',
    inactive: 'bg-white/10 text-white/40',
  }[s] || 'bg-white/10 text-white/40')

  return (
    <div className="space-y-4">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-white font-semibold text-sm">Volunteers ({volunteers.length})</h3>
          <p className="text-white/40 text-xs mt-0.5">Manage canvassers for this list</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setShowN(s => !s)}
            className="flex items-center gap-1.5 bg-blue-600/20 hover:bg-blue-600/30 border border-blue-500/30 text-blue-400 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
          >
            <Bell className="w-3.5 h-3.5" /> Notify
          </button>
          <button
            onClick={() => setShow(s => !s)}
            className="flex items-center gap-1.5 bg-red-600/20 hover:bg-red-600/30 border border-red-500/30 text-red-400 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
          >
            + Invite
          </button>
        </div>
      </div>

      {/* Copied link toast */}
      {copiedLink && (
        <div className="bg-emerald-500/20 border border-emerald-500/30 rounded-lg p-3 flex items-start gap-2">
          <CheckCircle className="w-4 h-4 text-emerald-400 flex-shrink-0 mt-0.5" />
          <div className="min-w-0">
            <p className="text-emerald-300 text-xs font-medium">Invite link ready!</p>
            <p className="text-emerald-400/70 text-xs mt-0.5 break-all">{copiedLink}</p>
            <p className="text-emerald-400/50 text-xs mt-1">Share this link or copy to clipboard — magic link email also sent.</p>
          </div>
        </div>
      )}

      {/* Invite form */}
      {showInvite && (
        <form onSubmit={handleInvite} className="bg-white/5 border border-white/10 rounded-xl p-4 space-y-3">
          <h4 className="text-white font-medium text-sm">Invite New Volunteer</h4>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-white/50 text-xs mb-1 block">Full Name *</label>
              <input
                required value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                placeholder="Jane Smith"
                className="w-full bg-white/10 border border-white/20 rounded-lg px-3 py-2 text-white text-sm placeholder-white/30 focus:outline-none focus:ring-1 focus:ring-red-500/50"
              />
            </div>
            <div>
              <label className="text-white/50 text-xs mb-1 block">Email *</label>
              <input
                required type="email" value={form.email}
                onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                placeholder="jane@email.com"
                className="w-full bg-white/10 border border-white/20 rounded-lg px-3 py-2 text-white text-sm placeholder-white/30 focus:outline-none focus:ring-1 focus:ring-red-500/50"
              />
            </div>
            <div>
              <label className="text-white/50 text-xs mb-1 block">Phone</label>
              <input
                value={form.phone}
                onChange={e => setForm(f => ({ ...f, phone: e.target.value }))}
                placeholder="715-555-0100"
                className="w-full bg-white/10 border border-white/20 rounded-lg px-3 py-2 text-white text-sm placeholder-white/30 focus:outline-none focus:ring-1 focus:ring-red-500/50"
              />
            </div>
            <div>
              <label className="text-white/50 text-xs mb-1 block">Role</label>
              <select
                value={form.role}
                onChange={e => setForm(f => ({ ...f, role: e.target.value }))}
                className="w-full bg-[#1a2236] border border-white/20 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-1 focus:ring-red-500/50"
              >
                <option value="canvasser">Canvasser</option>
                <option value="captain">Captain</option>
              </select>
            </div>
          </div>
          <div className="flex gap-2">
            <button
              type="submit" disabled={saving}
              className="flex-1 bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white font-medium py-2 rounded-lg text-sm transition-colors"
            >
              {saving ? 'Sending...' : 'Send Invite'}
            </button>
            <button
              type="button" onClick={() => setShow(false)}
              className="px-4 bg-white/5 hover:bg-white/10 border border-white/10 text-white/60 rounded-lg text-sm transition-colors"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {/* Notification form */}
      {showNotif && (
        <form onSubmit={handleNotification} className="bg-white/5 border border-white/10 rounded-xl p-4 space-y-3">
          <h4 className="text-white font-medium text-sm">Broadcast Notification</h4>
          <input
            required value={notifForm.title}
            onChange={e => setNotif(f => ({ ...f, title: e.target.value }))}
            placeholder="Notification title..."
            className="w-full bg-white/10 border border-white/20 rounded-lg px-3 py-2 text-white text-sm placeholder-white/30 focus:outline-none focus:ring-1 focus:ring-blue-500/50"
          />
          <textarea
            value={notifForm.body}
            onChange={e => setNotif(f => ({ ...f, body: e.target.value }))}
            placeholder="Optional message body..."
            rows={2}
            className="w-full bg-white/10 border border-white/20 rounded-lg px-3 py-2 text-white text-sm placeholder-white/30 focus:outline-none focus:ring-1 focus:ring-blue-500/50 resize-none"
          />
          <div className="flex gap-2 items-center">
            <select
              value={notifForm.type}
              onChange={e => setNotif(f => ({ ...f, type: e.target.value }))}
              className="bg-[#1a2236] border border-white/20 rounded-lg px-3 py-2 text-white text-sm focus:outline-none"
            >
              <option value="info">Info</option>
              <option value="success">Success</option>
              <option value="warning">Warning</option>
              <option value="urgent">Urgent</option>
            </select>
            <button
              type="submit" disabled={saving}
              className="flex-1 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-medium py-2 rounded-lg text-sm transition-colors"
            >
              {saving ? 'Sending...' : 'Send to All'}
            </button>
            <button
              type="button" onClick={() => setShowN(false)}
              className="px-4 bg-white/5 hover:bg-white/10 border border-white/10 text-white/60 rounded-lg text-sm transition-colors"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {/* Volunteer list */}
      {loading ? (
        <div className="text-center py-6">
          <div className="w-6 h-6 border-2 border-white/20 border-t-white/60 rounded-full animate-spin mx-auto" />
        </div>
      ) : volunteers.length === 0 ? (
        <div className="bg-white/3 border border-dashed border-white/10 rounded-xl p-6 text-center">
          <Users className="w-8 h-8 text-white/20 mx-auto mb-2" />
          <p className="text-white/30 text-sm">No volunteers yet. Invite your first canvasser.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {volunteers.map(vol => (
            <div key={vol.id} className="bg-white/5 border border-white/10 rounded-xl p-3 flex items-center gap-3">
              <div
                className="w-9 h-9 rounded-xl flex items-center justify-center text-white text-xs font-bold flex-shrink-0"
                style={{ backgroundColor: vol.avatar_color || '#4f46e5' }}
              >
                {avatarInitials(vol.name)}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-white text-sm font-medium truncate">{vol.name}</p>
                  <span className={`text-xs px-1.5 py-0.5 rounded-full ${statusColor(vol.status)}`}>
                    {vol.status}
                  </span>
                </div>
                <p className="text-white/40 text-xs truncate">{vol.email}</p>
                <div className="flex items-center gap-3 mt-0.5">
                  <span className="text-white/30 text-xs">{vol.doors_knocked || 0} doors</span>
                  <span className="text-white/30 text-xs">{vol.contacts_made || 0} contacts</span>
                  <span className="text-white/30 text-xs capitalize">{vol.role}</span>
                </div>
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => handleResend(vol)}
                  title="Resend invite"
                  className="p-1.5 text-white/30 hover:text-white/70 transition-colors"
                >
                  <Send className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={() => handleDelete(vol.id)}
                  title="Remove volunteer"
                  className="p-1.5 text-white/30 hover:text-red-400 transition-colors"
                >
                  <XCircle className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Missing Users import for VolunteerManager ──────────────────────────────
function Users(props) {
  return (
    <svg {...props} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  )
}

// ─── Main Portal Component ────────────────────────────────────────────────────
export default function VolunteerPortal() {
  const { signOut }                           = useAuth()
  const [searchParams]                        = useSearchParams()
  const [volunteer, setVolunteer]             = useState(null)
  const [loading, setLoading]                 = useState(true)
  const [activeTab, setActiveTab]             = useState('home')
  const [messages, setMessages]               = useState([])
  const [notifications, setNotifications]     = useState([])
  const [unreadMsgs, setUnreadMsgs]           = useState(0)
  const [unreadNotifs, setUnreadNotifs]       = useState(0)
  const [online, setOnline]                   = useState(navigator.onLine)
  const lastMsgCountRef                       = useRef(0)

  // ── Online/offline detection ──────────────────────────────────────────────
  useEffect(() => {
    const on  = () => setOnline(true)
    const off = () => setOnline(false)
    window.addEventListener('online',  on)
    window.addEventListener('offline', off)
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off) }
  }, [])

  // ── Auto-login from URL token ─────────────────────────────────────────────
  useEffect(() => {
    const initAuth = async () => {
      // 1. Check URL token (from magic link)
      const token = searchParams.get('token')
      const email = searchParams.get('email')

      if (token && email) {
        const res = await callApi('verify_token', { token, email })
        if (res.volunteer) {
          const sessionData = { volunteer: res.volunteer, list: res.list, session_token: res.session_token }
          saveSession(sessionData)
          setVolunteer({ ...res.volunteer, list: res.list })
          // Clean URL
          window.history.replaceState({}, '', '/v')
          setLoading(false)
          return
        }
      }

      // 2. Check Supabase session (from OTP email link)
      const { data: { session } } = await supabase.auth.getSession()
      if (session?.user?.email) {
        // Look up volunteer by email — authenticate with the Supabase JWT
        const res = await callApi('get_volunteer', { email: session.user.email }, session.access_token)
        if (res.volunteer) {
          const sessionData = { volunteer: res.volunteer }
          saveSession(sessionData)
          setVolunteer(res.volunteer)
          setLoading(false)
          return
        }
      }

      // 3. Check local session cache
      const cached = loadSession()
      if (cached?.volunteer) {
        // Re-validate from server using the durable session token
        const res = await callApi('get_volunteer', { volunteer_id: cached.volunteer.id, session_token: cached.session_token })
        if (res.volunteer) {
          saveSession({ volunteer: res.volunteer, list: cached.list, session_token: cached.session_token })
          setVolunteer(res.volunteer)
        } else {
          clearSession()
        }
      }

      setLoading(false)
    }

    initAuth()

    // Also listen for Supabase auth changes (magic link click).
    // The callback MUST stay synchronous: supabase-js holds its auth lock for the
    // duration of the callback, so awaiting a network round-trip in here stalled
    // every other auth call (getSession, refresh, signOut) until this finished.
    // Capture what we need, then defer the async work with setTimeout(…, 0) —
    // the pattern Supabase documents for exactly this.
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      const email = session?.user?.email
      const accessToken = session?.access_token
      if (!email || volunteer) return
      setTimeout(async () => {
        const res = await callApi('get_volunteer', { email }, accessToken)
        if (res.volunteer) {
          saveSession({ volunteer: res.volunteer })
          setVolunteer(res.volunteer)
          setLoading(false)
        }
      }, 0)
    })

    return () => subscription.unsubscribe()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Load + poll messages and notifications ─────────────────────────────────
  // Audit fix (#15): the portal used to query volunteer_messages /
  // volunteer_notifications directly with the anon client — RLS grants those
  // tables only to the coordinator, so chat loaded empty, sends silently
  // failed, and Realtime (which also respects RLS) never delivered a thing.
  // Everything now goes through the authorized volunteer-auth actions, with a
  // 15-second poll standing in for the realtime channel that could never work.
  useEffect(() => {
    if (!volunteer?.list_id) return
    let alive = true

    const loadData = async () => {
      const token = loadSession()?.session_token
      const [msgsRes, notifsRes] = await Promise.all([
        callApi('get_messages', { volunteer_id: volunteer.id, session_token: token }),
        callApi('get_notifications', { volunteer_id: volunteer.id, session_token: token }),
      ])
      if (!alive) return

      const msgs = msgsRes.messages || []
      const notifs = notifsRes.notifications || []

      setMessages(prev => {
        // Unread badge for messages that arrived since the last poll
        const prevIds = new Set(prev.map(m => m.id))
        const fresh = msgs.filter(m => !prevIds.has(m.id) && m.sender_id !== volunteer.id)
        if (prev.length && fresh.length && activeTabRef.current !== 'chat') {
          setUnreadMsgs(c => c + fresh.length)
        }
        return msgs
      })
      lastMsgCountRef.current = msgs.length

      setNotifications(prevNotifs => {
        const prevIds = new Set(prevNotifs.map(n => n.id))
        const fresh = notifs.filter(n => !prevIds.has(n.id))
        if (prevNotifs.length && fresh.length && 'Notification' in window && Notification.permission === 'granted') {
          for (const n of fresh) new Notification(n.title, { body: n.body || '' })
        }
        return notifs
      })
      setUnreadNotifs(notifs.filter(n => !n.read_by?.includes(volunteer.id)).length)
    }

    loadData()
    const interval = setInterval(loadData, 15000)
    return () => { alive = false; clearInterval(interval) }
  }, [volunteer?.list_id, volunteer?.id])

  // Track the active tab in a ref so the poll callback sees the current value
  const activeTabRef = useRef(activeTab)
  useEffect(() => { activeTabRef.current = activeTab }, [activeTab])

  // ── Request notification permission ──────────────────────────────────────
  useEffect(() => {
    if (volunteer && 'Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission()
    }
  }, [volunteer])

  // ── Tab switch: clear unread ──────────────────────────────────────────────
  useEffect(() => {
    if (activeTab === 'chat')  setUnreadMsgs(0)
    if (activeTab === 'home')  setUnreadNotifs(0)
  }, [activeTab])

  // ── Send message ──────────────────────────────────────────────────────────
  const handleSendMessage = async (content) => {
    if (!volunteer?.list_id) return
    // Audit fix (#15): authorized service-role send; append on confirmed success
    const res = await callApi('send_message', {
      volunteer_id: volunteer.id,
      content,
      session_token: loadSession()?.session_token,
    })
    if (res?.sent && res.message) {
      setMessages(prev => prev.some(m => m.id === res.message.id) ? prev : [...prev, res.message])
    }
    return res
  }

  // ── Mark notification read ────────────────────────────────────────────────
  const handleMarkNotifRead = async (notifId) => {
    const notif = notifications.find(n => n.id === notifId)
    if (!notif || notif.read_by?.includes(volunteer.id)) return
    const res = await callApi('mark_notif_read', {
      volunteer_id: volunteer.id,
      notif_id: notifId,
      session_token: loadSession()?.session_token,
    })
    if (!res?.read) return
    const newReadBy = [...(notif.read_by || []), volunteer.id]
    setNotifications(prev =>
      prev.map(n => n.id === notifId ? { ...n, read_by: newReadBy } : n)
    )
    setUnreadNotifs(c => Math.max(0, c - 1))
  }

  // ── Refresh volunteer data ─────────────────────────────────────────────────
  const handleRefresh = useCallback(async () => {
    if (!volunteer?.id) return
    const cached = loadSession()
    const res = await callApi('get_volunteer', { volunteer_id: volunteer.id, session_token: cached?.session_token })
    if (res.volunteer) {
      const updated = { ...res.volunteer, list: volunteer.list }
      saveSession({ volunteer: updated, list: cached?.list, session_token: cached?.session_token })
      setVolunteer(updated)
    }
  }, [volunteer])

  // ── Logout ────────────────────────────────────────────────────────────────
  // Goes through AuthContext's signOut, not supabase.auth.signOut directly: the
  // shared path flushes the offline door-knock queue while the session is still
  // valid, clears the on-device caches (turf blocks, assignments, offline reads)
  // and tears the auth context down. Calling the SDK straight left unsynced
  // knocks stranded in IndexedDB and the context holding a dead session.
  const handleLogout = async () => {
    clearSession()
    await signOut()
    setVolunteer(null)
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="min-h-screen bg-[#0a0f1e] flex items-center justify-center">
        <div className="text-center">
          <div className="w-12 h-12 border-3 border-red-600/30 border-t-red-500 rounded-full animate-spin mx-auto mb-4" />
          <p className="text-white/40 text-sm">Loading portal...</p>
        </div>
      </div>
    )
  }

  if (!volunteer) {
    return <LoginScreen onLogin={setVolunteer} />
  }

  const tabs = [
    { id: 'home',    Icon: Home,          label: 'Home',    badge: unreadNotifs },
    { id: 'doors',   Icon: DoorOpen,      label: 'Doors',   badge: 0            },
    { id: 'chat',    Icon: MessageCircle, label: 'Chat',    badge: unreadMsgs   },
    { id: 'profile', Icon: User,          label: 'Profile', badge: 0            },
  ]

  return (
    <div className="min-h-screen bg-[#0a0f1e] flex flex-col max-w-md mx-auto relative">
      {/* Status bar */}
      <div className="flex-shrink-0 flex items-center justify-between px-4 py-2 bg-[#0a0f1e] border-b border-white/5">
        <div className="flex items-center gap-2">
          <div className="w-5 h-5 bg-red-600 rounded-md flex items-center justify-center">
            <DoorOpen className="w-3 h-3 text-white" />
          </div>
          <span className="text-white/60 text-xs font-medium">Volunteer Portal</span>
        </div>
        <div className="flex items-center gap-2">
          {online
            ? <Wifi className="w-3.5 h-3.5 text-emerald-400" />
            : <WifiOff className="w-3.5 h-3.5 text-red-400" />
          }
          <span className={`text-xs ${online ? 'text-emerald-400' : 'text-red-400'}`}>
            {online ? 'Online' : 'Offline'}
          </span>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto" style={{ paddingBottom: '64px' }}>
        {activeTab === 'home' && (
          <HomeTab
            volunteer={volunteer}
            notifications={notifications}
            onMarkNotifRead={handleMarkNotifRead}
            onRefresh={handleRefresh}
          />
        )}
        {activeTab === 'doors' && (
          <DoorsTab volunteer={volunteer} />
        )}
        {activeTab === 'chat' && (
          <div className="flex flex-col" style={{ height: 'calc(100vh - 130px)' }}>
            <ChatTab
              volunteer={volunteer}
              messages={messages}
              onSend={handleSendMessage}
            />
          </div>
        )}
        {activeTab === 'profile' && (
          <ProfileTab volunteer={volunteer} onLogout={handleLogout} />
        )}
      </div>

      {/* Bottom nav */}
      <div className="fixed bottom-0 left-1/2 -translate-x-1/2 w-full max-w-md bg-[#0d1425]/95 backdrop-blur border-t border-white/10 flex items-center z-50">
        {tabs.map(tab => {
          const isActive = activeTab === tab.id
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex-1 flex flex-col items-center gap-1 py-3 transition-colors relative ${
                isActive ? 'text-red-400' : 'text-white/30 hover:text-white/60'
              }`}
            >
              <div className="relative">
                <tab.Icon className="w-5 h-5" />
                {tab.badge > 0 && <NotifBadge count={tab.badge} />}
              </div>
              <span className="text-xs font-medium">{tab.label}</span>
              {isActive && (
                <div className="absolute top-0 left-1/2 -translate-x-1/2 w-8 h-0.5 bg-red-500 rounded-full" />
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}
