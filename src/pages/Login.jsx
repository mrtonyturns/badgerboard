import React, { useState, useMemo } from 'react'
import { useAuth } from '../contexts/AuthContext'
import SearchableSelect from '../components/SearchableSelect'
import { useNavigate, Link } from 'react-router-dom'
import { Eye, EyeOff, AlertCircle, CheckCircle, User, Building2, Phone, Mail, Briefcase } from 'lucide-react'
import BluejackLogo from '../components/BluejackLogo'
import BadgerBoardLogo from '../components/BadgerBoardLogo'
// One password scorer for the whole app — ResetPassword.jsx and
// settings/SecurityPane.jsx used to carry their own identical copies.
import { scorePassword, PASSWORD_MIN_SCORE } from '../lib/password'

const POSITION_OPTIONS = [
  { value: '', label: 'Select your role...' },
  { value: 'Candidate',               label: 'Candidate' },
  { value: 'Campaign Manager',        label: 'Campaign Manager' },
  { value: 'Campaign Staff',          label: 'Campaign Staff' },
  { value: 'Elected Official',        label: 'Elected Official' },
  { value: 'Political Consultant',    label: 'Political Consultant' },
  { value: 'Party Official',          label: 'Party Official' },
  { value: 'PAC / Advocacy Org',      label: 'PAC / Advocacy Organization' },
  { value: 'Journalist / Researcher', label: 'Journalist / Researcher' },
  { value: 'Other',                   label: 'Other' },
]

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

function formatPhone(val) {
  const d = val.replace(/\D/g, '').slice(0, 10)
  if (d.length <= 3) return d
  if (d.length <= 6) return `(${d.slice(0,3)}) ${d.slice(3)}`
  return `(${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}`
}

export default function Login() {
  const { signIn, signUp, resetPassword } = useAuth()
  const navigate = useNavigate()
  // 'signin' | 'signup' | 'forgot'. /login?reset=1 opens the forgot-password
  // form directly — that's where ResetPassword sends an expired-link visitor.
  const [mode, setMode] = useState(() => (
    typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('reset')
      ? 'forgot'
      : 'signin'
  ))

  const [email, setEmail]       = useState('')
  const [password, setPassword] = useState('')
  const [showPw, setShowPw]     = useState(false)

  const [firstName, setFirstName]         = useState('')
  const [lastName, setLastName]           = useState('')
  const [business, setBusiness]           = useState('')
  const [phone, setPhone]                 = useState('')
  const [position, setPosition]           = useState('')
  const [confirmPw, setConfirmPw]         = useState('')
  const [showConfirmPw, setShowConfirmPw] = useState(false)
  const [agreedToTos, setAgreedToTos]     = useState(false)

  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState('')
  const [success, setSuccess] = useState('')

  const pwStrength = useMemo(() => scorePassword(password), [password])

  const switchMode = (m) => {
    setMode(m)
    setError('')
    // Preserve success messages when:
    // 1. Returning from forgot-password → signin (reset email confirmation)
    // 2. Returning from signup → signin (account created confirmation)
    const preserveSuccess = (mode === 'forgot' && m === 'signin') || (mode === 'signup' && m === 'signin')
    if (!preserveSuccess) setSuccess('')
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    setSuccess('')

    if (mode === 'forgot') {
      if (!email.trim()) { setError('Please enter your email address.'); return }
      setLoading(true)
      const { error } = await resetPassword(email.trim())
      setLoading(false)
      if (error) setError(error.message)
      else setSuccess('Password reset email sent! Check your inbox for a link to reset your password.')
      return
    }

    if (mode === 'signup') {
      if (!firstName.trim() || !lastName.trim()) { setError('First and last name are required.'); return }
      if (!position)                              { setError('Please select your role/position.'); return }
      if (pwStrength.score < PASSWORD_MIN_SCORE)  { setError('Please choose a stronger password (Fair or better required).'); return }
      if (password !== confirmPw)                { setError('Passwords do not match.'); return }
      if (!agreedToTos)                          { setError('You must agree to the Terms of Service to create an account.'); return }
    }

    setLoading(true)
    if (mode === 'signin') {
      const { error } = await signIn(email, password)
      if (error) setError(error.message)
      else navigate('/')
    } else {
      const { error } = await signUp(email, password, {
        first_name: firstName.trim(), last_name: lastName.trim(),
        display_name: `${firstName.trim()} ${lastName.trim()}`,
        business: business.trim(), phone, position,
      })
      // Supabase deliberately hides whether an address is already registered:
      // signing up with an existing email returns SUCCESS with a decoy user
      // (obfuscated id, empty `identities`) and sends no confirmation mail.
      // Telling the user "this email is already registered" handed that fact
      // straight back to whoever typed the address — a working account-
      // enumeration oracle on a public form. Every non-error outcome now gets
      // the SAME copy, and the one error message that also leaks it is folded
      // into that same branch.
      const leaksExistence = error && /already\s*(registered|exists|in use)|user already/i.test(error.message || '')
      if (error && !leaksExistence) setError(error.message)
      else {
        setSuccess('Check your email. If we could create an account for that address, a confirmation link is on its way — follow it, then sign in. Already have an account? Sign in below or reset your password.')
        switchMode('signin')
      }
    }
    setLoading(false)
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
            <h2 className="text-xl font-bold text-gray-900 mb-1">
              {mode === 'signin' ? 'Sign in to your account' : mode === 'signup' ? 'Create an account' : 'Reset your password'}
            </h2>
            <p className="text-sm text-gray-500 mb-6">
              {mode === 'signin' ? 'Enter your credentials to access the platform' : mode === 'signup' ? 'Fill in your details to get started' : 'Enter your email and we\'ll send you a reset link'}
            </p>

            {error && (
              <div className="flex items-start gap-2 mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
                <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />{error}
              </div>
            )}
            {success && (
              <div className="flex items-start gap-2 mb-4 p-3 bg-green-50 border border-green-200 rounded-lg text-sm text-green-700">
                <CheckCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />{success}
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-4" noValidate>

              {mode === 'signup' && (
                <>
                  {/* First / Last name — two full-width text fields side by side
                      were ~120px each on a 320px screen; they stack now. Every
                      field below carries id/htmlFor so the visible label is its
                      accessible name (and so clicking the label focuses it). */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="label" htmlFor="signup-first-name">First Name <span className="text-brand-red">*</span></label>
                      <div className="relative">
                        <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
                        <input id="signup-first-name" type="text" className="input pl-9" value={firstName}
                          onChange={e => setFirstName(e.target.value)} placeholder="Tony"
                          required autoComplete="given-name" />
                      </div>
                    </div>
                    <div>
                      <label className="label" htmlFor="signup-last-name">Last Name <span className="text-brand-red">*</span></label>
                      <input id="signup-last-name" type="text" className="input" value={lastName}
                        onChange={e => setLastName(e.target.value)} placeholder="Smith"
                        required autoComplete="family-name" />
                    </div>
                  </div>

                  {/* Business */}
                  <div>
                    <label className="label" htmlFor="signup-business">Organization / Business</label>
                    <div className="relative">
                      <Building2 className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
                      <input id="signup-business" type="text" className="input pl-9" value={business}
                        onChange={e => setBusiness(e.target.value)}
                        placeholder="The Bluejack Group" autoComplete="organization" />
                    </div>
                  </div>

                  {/* Phone */}
                  <div>
                    <label className="label" htmlFor="signup-phone">Phone Number</label>
                    <div className="relative">
                      <Phone className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
                      <input id="signup-phone" type="tel" className="input pl-9" value={phone}
                        onChange={e => setPhone(formatPhone(e.target.value))}
                        placeholder="(715) 555-0100" autoComplete="tel" />
                    </div>
                  </div>

                  {/* Position — SearchableSelect renders its own button and takes
                      no label prop, so this one stays a plain <label>; giving it
                      a programmatic name means changing that shared component,
                      which is outside this pass. */}
                  <div>
                    <label className="label">Position / Role <span className="text-brand-red">*</span></label>
                    <div className="relative">
                      <Briefcase className="absolute left-3 top-[22px] -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none z-10" />
                      <SearchableSelect
                        value={position}
                        onChange={setPosition}
                        options={POSITION_OPTIONS.filter(o => o.value).map(o => ({ value: o.value, label: o.label }))}
                        placeholder="Select your role..."
                        buttonClassName="pl-9"
                        searchPlaceholder="Search roles..." />
                    </div>
                  </div>
                </>
              )}

              {/* Email */}
              <div>
                <label className="label" htmlFor="login-email">Email Address <span className="text-brand-red">*</span></label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
                  <input id="login-email" type="email" className="input pl-9" value={email}
                    onChange={e => setEmail(e.target.value)} placeholder="you@example.com"
                    required autoComplete="email" />
                </div>
              </div>

              {/* Password — hidden in forgot mode */}
              {mode !== 'forgot' && (
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="label mb-0" htmlFor="login-password">Password <span className="text-brand-red">*</span></label>
                    {mode === 'signin' && (
                      <button type="button" onClick={() => switchMode('forgot')}
                        className="text-xs text-brand-red hover:opacity-75 font-medium">
                        Forgot password?
                      </button>
                    )}
                  </div>
                  <div className="relative">
                    <input id="login-password" type={showPw ? 'text' : 'password'} className="input pr-10"
                      value={password} onChange={e => setPassword(e.target.value)}
                      placeholder="••••••••" required minLength={8}
                      autoComplete={mode === 'signin' ? 'current-password' : 'new-password'} />
                    <button type="button" onClick={() => setShowPw(!showPw)}
                      aria-label={showPw ? 'Hide password' : 'Show password'}
                      aria-pressed={showPw}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                      {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                  {mode === 'signup' && <PasswordStrengthBar password={password} />}
                </div>
              )}

              {/* Confirm password */}
              {mode === 'signup' && (
                <div>
                  <label className="label" htmlFor="signup-confirm-password">Confirm Password <span className="text-brand-red">*</span></label>
                  <div className="relative">
                    <input id="signup-confirm-password" type={showConfirmPw ? 'text' : 'password'}
                      className={`input pr-10 ${confirmPw && confirmPw !== password ? 'border-red-400' : ''}`}
                      value={confirmPw} onChange={e => setConfirmPw(e.target.value)}
                      placeholder="••••••••" required autoComplete="new-password" />
                    <button type="button" onClick={() => setShowConfirmPw(!showConfirmPw)}
                      aria-label={showConfirmPw ? 'Hide confirmed password' : 'Show confirmed password'}
                      aria-pressed={showConfirmPw}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                      {showConfirmPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                  {confirmPw && confirmPw !== password && <p className="text-xs text-red-500 mt-1">Passwords do not match</p>}
                  {confirmPw && confirmPw === password && (
                    <p className="text-xs text-green-600 mt-1 flex items-center gap-1"><CheckCircle className="w-3 h-3" /> Passwords match</p>
                  )}
                </div>
              )}

              {/* Terms of Service */}
              {mode === 'signup' && (
                <label className="flex items-start gap-3 cursor-pointer mt-1">
                  <input type="checkbox"
                    className="mt-0.5 w-4 h-4 rounded border-gray-300 text-brand-red focus:ring-brand-navy/40 cursor-pointer flex-shrink-0"
                    checked={agreedToTos} onChange={e => setAgreedToTos(e.target.checked)} />
                  <span className="text-xs text-gray-500 leading-relaxed">
                    I agree to the{' '}
                    <Link to="/terms" target="_blank" className="text-brand-red underline underline-offset-2 hover:opacity-80 font-medium">
                      Terms of Service
                    </Link>
                    {' '}and acknowledge that this platform provides political intelligence tools subject to applicable Wisconsin law.
                  </span>
                </label>
              )}

              <button type="submit" disabled={loading} className="btn-primary w-full mt-2 py-2.5">
                {loading ? (
                  <span className="flex items-center justify-center gap-2">
                    <span className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                    {mode === 'signin' ? 'Signing in...' : mode === 'forgot' ? 'Sending reset email...' : 'Creating account...'}
                  </span>
                ) : mode === 'signin' ? 'Sign In' : mode === 'forgot' ? 'Send Reset Email' : 'Create Account'}
              </button>
            </form>

            <div className="mt-6 text-center space-y-2">
              {mode === 'forgot' ? (
                <button onClick={() => switchMode('signin')}
                  className="text-sm text-brand-red hover:opacity-80 font-medium">
                  ← Back to sign in
                </button>
              ) : (
                <button onClick={() => switchMode(mode === 'signin' ? 'signup' : 'signin')}
                  className="text-sm text-brand-red hover:opacity-80 font-medium">
                  {mode === 'signin' ? 'Need an account? Create one' : 'Already have an account? Sign in'}
                </button>
              )}
            </div>
          </div>

          <p className="text-center text-white/30 text-xs mt-8">
            © {new Date().getFullYear()} The Bluejack Group · Political Intelligence Platform
          </p>
        </div>
      </div>
    </div>
  )
}
