import React from 'react'
import { useNavigate, useLocation, Link } from 'react-router-dom'
import { Lock, AlertTriangle, CreditCard, Calendar, ArrowRight } from 'lucide-react'
import { useAuth } from '../contexts/AuthContext'
import { isNativeApp } from '../lib/native'

// Pages that remain accessible even when payment is locked.
// /profiler is included so downgrade-locked users can still read their existing
// profiles during the 30-day grace period before data deletion.
const UNLOCKED_PATHS = ['/settings', '/login', '/terms', '/plans', '/dossier-disclaimer', '/profiler']

// Days until account data is deleted after downgrade
const DELETION_GRACE_DAYS = 30

export default function PaymentLockOverlay({ children }) {
  const { isPaymentLocked, isDowngradeLocked, downgradedAt } = useAuth()
  const location = useLocation()
  const navigate = useNavigate()

  const isLocked     = isPaymentLocked || isDowngradeLocked
  const isUnlocked   = UNLOCKED_PATHS.some(p => location.pathname.startsWith(p))

  if (!isLocked || isUnlocked) return <>{children}</>

  // ── Compute deletion countdown for downgrade case ─────────────────────────
  let daysLeft = DELETION_GRACE_DAYS
  let deletionDateStr = ''
  if (isDowngradeLocked && downgradedAt) {
    const deletionMs = downgradedAt + DELETION_GRACE_DAYS * 24 * 60 * 60 * 1000
    daysLeft = Math.max(0, Math.ceil((deletionMs - Date.now()) / (1000 * 60 * 60 * 24)))
    deletionDateStr = new Date(deletionMs).toLocaleDateString('en-US', {
      month: 'long', day: 'numeric', year: 'numeric',
    })
  }

  return (
    <div className="relative w-full h-full">
      {/* Blurred background content */}
      <div style={{ filter: 'blur(5px)', pointerEvents: 'none', userSelect: 'none' }} aria-hidden="true">
        {children}
      </div>

      {/* Lock overlay */}
      <div className="absolute inset-0 flex items-center justify-center z-40 bg-white/30 backdrop-blur-sm">
        <div
          className="bg-white rounded-2xl shadow-2xl border border-gray-200 p-8 max-w-md w-full mx-4 text-center"
          style={{ animation: 'lockCardIn 0.3s ease-out' }}
        >
          {isDowngradeLocked ? (
            /* ── Subscription ended (cancelled) ─── */
            <>
              <div className="w-16 h-16 bg-orange-100 rounded-full flex items-center justify-center mx-auto mb-5">
                <Lock className="w-8 h-8 text-orange-600" />
              </div>

              <h2 className="text-xl font-bold text-gray-900 mb-2">Your subscription has ended</h2>
              <p className="text-gray-500 text-sm mb-5 leading-relaxed">
                Your account is on the free Scout plan. Resubscribe to restore full access to all your candidates and features.
              </p>

              {/* Data deletion countdown */}
              <div className="flex items-start gap-2.5 bg-red-50 border border-red-200 rounded-xl p-3.5 text-left mb-6">
                <Calendar className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
                <div>
                  <p className="text-xs font-semibold text-red-800 mb-0.5">
                    Your data will be deleted in {daysLeft} {daysLeft === 1 ? 'day' : 'days'}
                  </p>
                  {deletionDateStr && (
                    <p className="text-xs text-red-600 leading-relaxed">
                      All candidates, profiles, and data will be permanently removed on{' '}
                      <strong>{deletionDateStr}</strong> unless you resubscribe.
                    </p>
                  )}
                </div>
              </div>

              {isNativeApp ? (
                <p className="text-sm text-gray-600 bg-gray-50 border border-gray-200 rounded-xl p-3.5">
                  Subscriptions can&apos;t be managed in the app. Sign in to your account on the Badger Board website to resubscribe.
                </p>
              ) : (
                <>
                  <Link
                    to="/plans"
                    className="w-full flex items-center justify-center gap-2 bg-brand-red hover:bg-red-700 text-white font-semibold px-6 py-3 rounded-xl transition-colors shadow-sm mb-3"
                  >
                    <ArrowRight className="w-4 h-4" />
                    Resubscribe Now
                  </Link>
                  <button
                    onClick={() => navigate('/settings#billing')}
                    className="w-full text-sm text-gray-500 hover:text-gray-700 transition-colors py-1"
                  >
                    View billing &amp; plan →
                  </button>
                </>
              )}
            </>
          ) : (
            /* ── Payment failed (past_due) ─── */
            <>
              <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-5">
                <Lock className="w-8 h-8 text-red-600" />
              </div>

              <h2 className="text-xl font-bold text-gray-900 mb-2">Account Access Suspended</h2>
              <p className="text-gray-500 text-sm mb-5 leading-relaxed">
                Your account has been temporarily suspended due to a payment issue.
                Update your payment method to restore full access.
              </p>

              <div className="flex items-start gap-2.5 bg-amber-50 border border-amber-200 rounded-xl p-3.5 text-left mb-6">
                <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" />
                <p className="text-xs text-amber-700 leading-relaxed">
                  Your data is safe and will be fully accessible once your payment is resolved.
                  Contact <a href="mailto:support@badgerboardwi.com" className="font-semibold underline">support@badgerboardwi.com</a> if you believe this is an error.
                </p>
              </div>

              {isNativeApp ? (
                <p className="text-sm text-gray-600 bg-gray-50 border border-gray-200 rounded-xl p-3.5">
                  Payment methods can&apos;t be updated in the app. Sign in to your account on the Badger Board website to resolve this.
                </p>
              ) : (
                <button
                  onClick={() => navigate('/settings#billing')}
                  className="w-full flex items-center justify-center gap-2 bg-red-600 hover:bg-red-700 text-white font-semibold px-6 py-3 rounded-xl transition-colors shadow-sm"
                >
                  <CreditCard className="w-4 h-4" />
                  Update Payment Method
                </button>
              )}
            </>
          )}
        </div>
      </div>

      <style>{`
        @keyframes lockCardIn {
          from { opacity: 0; transform: scale(0.94) translateY(8px); }
          to   { opacity: 1; transform: scale(1) translateY(0); }
        }
      `}</style>
    </div>
  )
}
