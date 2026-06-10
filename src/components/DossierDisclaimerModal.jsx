import React, { useState, useEffect } from 'react'
import { Shield, ExternalLink, Check, AlertTriangle, X } from 'lucide-react'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'

const DISCLAIMER_VERSION = '1.0'

async function callDossierReview(action, payload, token) {
  const res = await fetch('/.netlify/functions/dossier-review', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ action, ...payload }),
  })
  if (!res.ok) throw new Error('Request failed')
  return res.json()
}

// ─── Hook: check if user has acknowledged the current disclaimer ──────────────
export function useDossierAck() {
  const { user } = useAuth()
  const [ackState, setAckState]   = useState('loading') // 'loading' | 'pending' | 'acknowledged'
  const [ackedAt, setAckedAt]     = useState(null)

  useEffect(() => {
    if (!user) { setAckState('pending'); return }

    // Check localStorage cache first (avoids a network call on every page load)
    const cacheKey = `bb_dossier_ack_v${DISCLAIMER_VERSION}_${user.id}`
    const cached   = localStorage.getItem(cacheKey)
    if (cached) {
      setAckState('acknowledged')
      setAckedAt(cached)
      return
    }

    // Fetch from server
    supabase.auth.getSession().then(({ data: { session } }) => {
      const token = session?.access_token
      if (!token) { setAckState('pending'); return }
      callDossierReview('get_ack', {}, token)
        .then(({ acknowledged, acknowledged_at }) => {
          if (acknowledged) {
            localStorage.setItem(cacheKey, acknowledged_at)
            setAckState('acknowledged')
            setAckedAt(acknowledged_at)
          } else {
            setAckState('pending')
          }
        })
        .catch(() => setAckState('pending'))
    })
  }, [user])

  const markAcknowledged = (at) => {
    const cacheKey = `bb_dossier_ack_v${DISCLAIMER_VERSION}_${user?.id}`
    localStorage.setItem(cacheKey, at)
    setAckState('acknowledged')
    setAckedAt(at)
  }

  return { ackState, ackedAt, markAcknowledged }
}

// ─── The modal itself ─────────────────────────────────────────────────────────
export default function DossierDisclaimerModal({ onAcknowledged, onClose }) {
  const { user } = useAuth()
  const [loading,   setLoading]   = useState(false)
  const [error,     setError]     = useState('')
  const [checked,   setChecked]   = useState(false)

  // Get the Supabase session token
  const getToken = async () => {
    const { data: { session } } = await supabase.auth.getSession()
    return session?.access_token || null
  }

  const handleAcknowledge = async () => {
    if (!checked) { setError('Please check the box to confirm you have read and understood the disclaimer.'); return }
    setError('')
    setLoading(true)
    try {
      const token = await getToken()
      if (!token) throw new Error('Session expired — please sign in again.')
      const result = await callDossierReview('acknowledge', {}, token)
      onAcknowledged(result.acknowledged_at)
    } catch (err) {
      // Graceful fallback: if the dossier_acknowledgments table doesn't exist yet,
      // record the ack locally so the user isn't blocked.
      console.warn('Disclaimer API error (falling back to local):', err.message)
      const now = new Date().toISOString()
      onAcknowledged(now)
    }
    setLoading(false)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg relative overflow-hidden">
        {/* Top accent bar */}
        <div className="h-1.5 w-full bg-gradient-to-r from-brand-red via-gray-200 to-blue-700" />

        {/* Header */}
        <div className="px-6 pt-5 pb-4 border-b border-gray-100">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-xl bg-brand-red/10 flex items-center justify-center flex-shrink-0">
              <Shield className="w-5 h-5 text-brand-red" />
            </div>
            <div className="flex-1 min-w-0">
              <h2 className="text-lg font-bold text-gray-900">Research Use Disclaimer</h2>
              <p className="text-xs text-gray-500 mt-0.5">Required before accessing any profile · Version {DISCLAIMER_VERSION}</p>
            </div>
            {onClose && (
              <button onClick={onClose} className="p-1 rounded-lg hover:bg-gray-100 transition-colors text-gray-400 hover:text-gray-600">
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>

        {/* Body */}
        <div className="px-6 py-4 space-y-3 max-h-72 overflow-y-auto">
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-3.5">
            <div className="flex gap-2.5">
              <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
              <p className="text-xs text-amber-800 leading-relaxed font-medium">
                All profiles and candidate reports are <strong>AI-generated</strong> and have not been independently verified.
                Information may contain errors, inaccuracies, or fabricated details.
              </p>
            </div>
          </div>

          <p className="text-sm text-gray-700 leading-relaxed">
            By continuing, you acknowledge and agree to the following:
          </p>

          <ul className="space-y-2">
            {[
              'All AI-Generated Content must be independently verified before use in any campaign, publication, or professional context.',
              'You may not use this platform\'s content for purposes regulated by the Fair Credit Reporting Act (FCRA), including employment screening, credit decisions, or housing eligibility.',
              'Publishing false or unverified information derived from this platform may expose you to defamation liability under Wisconsin law (Wis. Stat. § 895.05) and other applicable statutes.',
              'You assume full responsibility for any downstream use of AI-Generated Content and agree to indemnify The Bluejack Group from all resulting claims.',
              'You will not use profile content in formal legal proceedings without independent corroboration by a qualified professional.',
              'You accept that Section 230 does not protect AI-generated outputs, requiring heightened care before reliance or republication.',
            ].map((item, i) => (
              <li key={i} className="flex gap-2.5 text-xs text-gray-600 leading-relaxed">
                <Check className="w-3.5 h-3.5 text-green-600 flex-shrink-0 mt-0.5" />
                {item}
              </li>
            ))}
          </ul>

          <a
            href="/dossier-disclaimer"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-xs text-brand-red hover:text-red-700 font-semibold transition-colors"
          >
            <ExternalLink className="w-3.5 h-3.5" />
            View Full Research Use Disclaimer (opens in new tab)
          </a>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-100 bg-gray-50 rounded-b-2xl space-y-3">
          {/* Checkbox */}
          <label className="flex items-start gap-3 cursor-pointer group">
            <div className="relative mt-0.5 flex-shrink-0">
              <input
                type="checkbox"
                checked={checked}
                onChange={e => { setChecked(e.target.checked); setError('') }}
                className="sr-only"
              />
              <div className={`w-5 h-5 rounded border-2 flex items-center justify-center transition-colors ${checked ? 'bg-brand-red border-brand-red' : 'border-gray-300 bg-white group-hover:border-gray-400'}`}>
                {checked && <Check className="w-3 h-3 text-white" />}
              </div>
            </div>
            <span className="text-xs text-gray-700 leading-relaxed">
              I confirm that I have read and understood the Research Use Disclaimer in full, including all
              obligations regarding independent verification, FCRA compliance, defamation liability, and
              assumption of risk. I agree to be bound by these terms as a condition of accessing profiles
              on this platform.
            </span>
          </label>

          {error && (
            <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>
          )}

          <button
            onClick={handleAcknowledge}
            disabled={loading || !checked}
            className={`w-full py-2.5 rounded-xl font-semibold text-sm transition-all ${
              checked && !loading
                ? 'bg-brand-red text-white hover:bg-red-700 shadow-sm'
                : 'bg-gray-200 text-gray-400 cursor-not-allowed'
            }`}
          >
            {loading ? (
              <span className="flex items-center justify-center gap-2">
                <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                Recording acknowledgment…
              </span>
            ) : (
              'I Acknowledge & Continue'
            )}
          </button>

          <p className="text-center text-xs text-gray-400">
            A timestamped confirmation will be sent to {user?.email || 'your email'}.
          </p>
        </div>
      </div>
    </div>
  )
}
