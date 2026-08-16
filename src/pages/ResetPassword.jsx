import React, { useState, useEffect, useMemo } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { Eye, EyeOff, CheckCircle, AlertCircle, KeyRound } from 'lucide-react'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import BadgerBoardLogo from '../components/BadgerBoardLogo'

// ── Friendly error copy ───────────────────────────────────────────────────────
// Supabase's raw messages ("New password should be different from the old
// password.", "AuthApiError: invalid claim: missing sub claim") are not written
// for end users, and some of them leak internals. Map to plain English.
const ERROR_COPY = [
  [/different from the old password|same.*password/i, 'That is already your password. Choose a different one.'],
  [/(at least|minimum).*(character|length)|too short|weak/i, 'That password is too short. Use at least 8 characters.'],
  [/pwned|breach|compromis/i,                               'That password has appeared in a known data breach. Choose another one.'],
  [/expired|otp_expired/i,                                  'This reset link has expired. Request a new one and try again.'],
  [/rate limit|too many/i,                                  'Too many attempts. Wait a minute, then try again.'],
  [/session|jwt|token|claim|unauthorized|not authenticated/i,
    'This reset link is no longer valid. Request a new one and try again.'],
  [/network|fetch|timeout/i,                                'We could not reach the server. Check your connection and try again.'],
]
function friendlyError(err) {
  const raw = String(err?.message || '')
  for (const [re, copy] of ERROR_COPY) if (re.test(raw)) return copy
  return 'We could not update your password. Request a new reset link and try again.'
}

// ── Password strength (same as Login.jsx) ─────────────────────────────────────
function scorePassword(pw) {
  if (!pw) return { score: 0, label: '', color: '', pct: 0 }
  let score = 0
  if (pw.length >= 8)           score++
  if (pw.length >= 12)          score++
  if (/[A-Z]/.test(pw))        score++
  if (/[a-z]/.test(pw))        score++
  if (/[0-9]/.test(pw))        score++
  if (/[^A-Za-z0-9]/.test(pw)) score++
  if (score <= 2) return { score, label: 'Weak',   color: '#ef4444', pct: 25  }
  if (score <= 3) return { score, label: 'Fair',   color: '#f97316', pct: 50  }
  if (score <= 4) return { score, label: 'Good',   color: '#eab308', pct: 75  }
  return             { score, label: 'Strong', color: '#22c55e', pct: 100 }
}

function PasswordStrengthBar({ password }) {
  const { label, color, pct } = useMemo(() => scorePassword(password), [password])
  if (!password) return null
  return (
    <div className="mt-1.5">
      <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
        <div className="h-full rounded-full transition-all duration-300"
          style={{ width: `${pct}%`, backgroundColor: color }} />
      </div>
      <p className="text-xs mt-1 font-medium" style={{ color }}>
        {label} password
        {label === 'Weak' && ' — add uppercase, numbers, or symbols'}
        {label === 'Fair' && ' — almost there, add more variety'}
      </p>
    </div>
  )
}

export default function ResetPassword() {
  const { updatePassword, user } = useAuth()
  const navigate = useNavigate()

  const [password, setPassword]       = useState('')
  const [confirmPw, setConfirmPw]     = useState('')
  const [showPw, setShowPw]           = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)
  const [loading, setLoading]         = useState(false)
  const [error, setError]             = useState('')
  const [done, setDone]               = useState(false)
  // sessionReady gates the form — stays false until we have a confirmed recovery session
  const [sessionReady, setSessionReady] = useState(false)
  // Supabase reports a dead/consumed reset link by redirecting back here with an
  // ERROR in the hash (#error=access_denied&error_code=otp_expired&...). The page
  // used to ignore that and bounce to /login after a 4s "Verifying your reset
  // link…" spinner, so an expired link looked like the app was broken.
  const [linkError, setLinkError] = useState(null)

  // ── Recovery gate ───────────────────────────────────────────────────────────
  // The form used to open for ANY session, so a signed-in user who wandered to
  // /reset-password (or was sent there) could change the password without ever
  // proving control of the mailbox. It now needs a genuine recovery landing:
  // either the reset link's `type=recovery` marker in the URL, or the
  // PASSWORD_RECOVERY event the Supabase client emits when it parses that link.
  const [recoveryEvent, setRecoveryEvent] = useState(false)
  // Read once on mount — the client strips the hash as soon as it parses it.
  const [recoveryInUrl] = useState(() => {
    if (typeof window === 'undefined') return false
    return /type=recovery/.test(window.location.hash || '') ||
           /type=recovery/.test(window.location.search || '')
  })
  const isRecovery = recoveryEvent || recoveryInUrl

  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY') setRecoveryEvent(true)
    })
    return () => subscription.unsubscribe()
  }, [])

  const pwStrength = useMemo(() => scorePassword(password), [password])

  // Supabase puts the recovery token in the URL hash as #access_token=...&type=recovery
  // The Supabase JS client automatically handles this — if the user lands here via
  // the reset email link, they'll be signed in with a recovery session and we can
  // call updateUser({ password }).
  // If somehow they land here without a valid session, redirect to login.
  useEffect(() => {
    const hash = window.location.hash
    const hasRecoveryToken = hash.includes('type=recovery') || hash.includes('access_token')

    // Read the error the mail link came back with, if any. Supabase also uses
    // the query string in some flows, so check both.
    const hp = new URLSearchParams(hash.replace(/^#/, ''))
    const qp = new URLSearchParams(window.location.search)
    const errCode = hp.get('error_code') || qp.get('error_code')
    const err     = hp.get('error')      || qp.get('error')
    if (err || errCode) {
      const expired = errCode === 'otp_expired' || /expired/i.test(hp.get('error_description') || qp.get('error_description') || '')
      setLinkError({
        expired,
        message: (hp.get('error_description') || qp.get('error_description') || '').replace(/\+/g, ' '),
      })
      return
    }

    if (user && isRecovery) {
      // Confirmed recovery session — show the form
      setSessionReady(true)
      return
    }

    if (!hasRecoveryToken && !isRecovery) {
      // No recovery token and no recovery event — a direct URL visit, whether or
      // not the visitor happens to be signed in. Send them to the app/login.
      navigate('/login', { replace: true })
      return
    }

    // Has a recovery token but Supabase hasn't parsed it yet — show spinner and wait.
    // Give up after 4 seconds (generous for slow connections) and send to login.
    const timer = setTimeout(() => {
      if (!(user && isRecovery) && !done) navigate('/login', { replace: true })
    }, 4000)
    return () => clearTimeout(timer)
  }, [user, navigate, done, isRecovery])

  // Mark form as ready once a recovery session is confirmed
  useEffect(() => {
    if (user && isRecovery && !sessionReady) setSessionReady(true)
  }, [user, isRecovery, sessionReady])

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')

    if (pwStrength.score < 3) {
      setError('Please choose a stronger password (Fair or better required).')
      return
    }
    if (password !== confirmPw) {
      setError('Passwords do not match.')
      return
    }

    setLoading(true)
    const { error } = await updatePassword(password)
    setLoading(false)

    if (error) {
      console.warn('[ResetPassword] updateUser failed:', error.message)
      setError(friendlyError(error))
    } else {
      setDone(true)
      setTimeout(() => navigate('/'), 3000)
    }
  }

  return (
    <div className="min-h-screen bg-brand-navy flex flex-col">
      <div className="flex h-1.5">
        <div className="flex-1 bg-brand-red" /><div className="flex-1 bg-white" /><div className="flex-1 bg-blue-600" />
      </div>

      <div className="flex flex-1 items-center justify-center px-4 py-12">
        <div className="w-full max-w-md">
          {/* Branding */}
          <div className="text-center mb-8">
            <div className="flex justify-center mb-4">
              <BadgerBoardLogo width={260} />
            </div>
            <p className="text-white/45 text-xs uppercase" style={{ letterSpacing: '0.2em' }}>Campaigns Made Simple.</p>
          </div>

          {/* Card */}
          <div className="bg-white rounded-2xl shadow-2xl p-8">
            {done ? (
              <div className="text-center py-4">
                <div className="w-14 h-14 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-4">
                  <CheckCircle className="w-7 h-7 text-green-600" />
                </div>
                <h2 className="text-xl font-bold text-gray-900 mb-2">Password updated!</h2>
                <p className="text-sm text-gray-500">Your password has been changed. Redirecting you to the app…</p>
              </div>
            ) : linkError ? (
              <div className="text-center py-4">
                <div className="w-14 h-14 rounded-full bg-amber-100 flex items-center justify-center mx-auto mb-4">
                  <AlertCircle className="w-7 h-7 text-amber-600" />
                </div>
                <h2 className="text-xl font-bold text-gray-900 mb-2">
                  {linkError.expired ? 'This reset link has expired' : 'This reset link is no longer valid'}
                </h2>
                <p className="text-sm text-gray-500 mb-5">
                  {/* Deliberately does NOT echo error_description from the URL —
                      it is caller-controlled text written for developers. */}
                  {linkError.expired
                    ? 'Password reset links are single-use and time-limited. Request a new one and use the newest email — older links stop working as soon as a new one is sent.'
                    : 'The link could not be verified. Request a new password reset email and try again.'}
                </p>
                <Link to="/login?reset=1" className="btn-primary inline-flex items-center justify-center">
                  Request a new link
                </Link>
              </div>
            ) : !sessionReady ? (
              /* Waiting for Supabase to parse the recovery token from the URL hash */
              <div className="text-center py-8">
                <div className="w-10 h-10 border-4 border-brand-red border-t-transparent rounded-full animate-spin mx-auto mb-4" />
                <p className="text-sm text-gray-500">Verifying your reset link…</p>
              </div>
            ) : (
              <>
                <div className="flex items-center gap-3 mb-5">
                  <div className="w-10 h-10 rounded-xl bg-brand-red/10 flex items-center justify-center flex-shrink-0">
                    <KeyRound className="w-5 h-5 text-brand-red" />
                  </div>
                  <div>
                    <h2 className="text-xl font-bold text-gray-900">Set new password</h2>
                    <p className="text-sm text-gray-500">Choose a strong password for your account</p>
                  </div>
                </div>

                {error && (
                  <div className="flex items-start gap-2 mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
                    <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />{error}
                  </div>
                )}

                <form onSubmit={handleSubmit} className="space-y-4">
                  <div>
                    <label className="label">New Password <span className="text-brand-red">*</span></label>
                    <div className="relative">
                      <input
                        type={showPw ? 'text' : 'password'}
                        className="input pr-10"
                        value={password}
                        onChange={e => setPassword(e.target.value)}
                        placeholder="••••••••"
                        required minLength={8}
                        autoComplete="new-password"
                        autoFocus
                      />
                      <button type="button" onClick={() => setShowPw(p => !p)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                        {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>
                    <PasswordStrengthBar password={password} />
                  </div>

                  <div>
                    <label className="label">Confirm New Password <span className="text-brand-red">*</span></label>
                    <div className="relative">
                      <input
                        type={showConfirm ? 'text' : 'password'}
                        className={`input pr-10 ${confirmPw && confirmPw !== password ? 'border-red-400' : ''}`}
                        value={confirmPw}
                        onChange={e => setConfirmPw(e.target.value)}
                        placeholder="••••••••"
                        required
                        autoComplete="new-password"
                      />
                      <button type="button" onClick={() => setShowConfirm(p => !p)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                        {showConfirm ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>
                    {confirmPw && confirmPw !== password && (
                      <p className="text-xs text-red-500 mt-1">Passwords do not match</p>
                    )}
                    {confirmPw && confirmPw === password && (
                      <p className="text-xs text-green-600 mt-1 flex items-center gap-1">
                        <CheckCircle className="w-3 h-3" /> Passwords match
                      </p>
                    )}
                  </div>

                  <button type="submit" disabled={loading} className="btn-primary w-full py-2.5 mt-2">
                    {loading ? (
                      <span className="flex items-center justify-center gap-2">
                        <span className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                        Updating password…
                      </span>
                    ) : 'Update Password'}
                  </button>
                </form>

                <div className="mt-5 text-center">
                  <Link to="/login" className="text-sm text-brand-red hover:opacity-80 font-medium">
                    ← Back to sign in
                  </Link>
                </div>
              </>
            )}
          </div>

          <p className="text-center text-white/30 text-xs mt-8">
            © {new Date().getFullYear()} The Bluejack Group · Political Intelligence Platform
          </p>
        </div>
      </div>
    </div>
  )
}
