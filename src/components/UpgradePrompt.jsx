import React from 'react'
import { useNavigate } from 'react-router-dom'
import { Lock, Sparkles, Check, ArrowRight } from 'lucide-react'
import { isNativeApp } from '../lib/native'

/**
 * UpgradePrompt — aggressive, Hormozi-style upgrade gate.
 *
 * Props:
 *   feature      {string}   — name of the locked feature, e.g. "Prospecting"
 *   hook         {string}   — value-anchor line shown under the lock icon
 *   plan         {string}   — recommended plan name, e.g. "Campaign". PASS IT:
 *                             the generic fallback is deliberately vague.
 *   price        {string}   — price string, e.g. "from $79/mo". OPTIONAL — when
 *                             it is missing no price is shown at all.
 *   benefits     {string[]} — 3-4 bullets of what they unlock
 *   compact      {bool}     — slim inline version (no icon, no hook, smaller padding)
 *
 * There are no plan/price defaults any more. They used to be `Campaign` and
 * `from $69/mo` — a founder-era rate that has not been sold since v1.18 — so a
 * call site that forgot a prop quoted a price that no longer exists. Every call
 * site in the app passes both explicitly; anything that doesn't now gets copy
 * that promises nothing specific instead of the wrong number.
 */
export default function UpgradePrompt({
  feature  = 'This Feature',
  hook     = 'Research firms charge $500–$2,000 per candidate profile. You\'re one click from unlimited intelligence.',
  plan     = 'a higher plan',
  price,
  benefits = [],
  compact  = false,
}) {
  const navigate = useNavigate()
  const priceLabel = typeof price === 'string' && price.trim() ? price.trim() : null

  // ── Native app (App Store / Play Store) version ────────────────────────────
  // Store rules don't allow linking to external purchase flows for digital
  // subscriptions, so the native app shows a neutral notice instead of
  // pricing, upgrade CTAs, or links to the plans page.
  if (isNativeApp) {
    return (
      <div className={compact
        ? 'flex items-center gap-3 p-4 bg-gray-50 border border-gray-200 rounded-xl'
        : 'rounded-2xl border border-gray-200 bg-gray-50 p-8 text-center'}
      >
        <div className={compact
          ? 'w-8 h-8 bg-gray-200 rounded-lg flex items-center justify-center flex-shrink-0'
          : 'w-14 h-14 bg-gray-200 rounded-2xl flex items-center justify-center mx-auto mb-4'}
        >
          <Lock className={compact ? 'w-4 h-4 text-gray-500' : 'w-7 h-7 text-gray-500'} />
        </div>
        <div className={compact ? 'min-w-0' : ''}>
          <p className={compact ? 'text-sm font-bold text-gray-900' : 'text-xl font-black text-gray-900 mb-2'}>
            {feature} isn&apos;t included in your current plan
          </p>
          <p className={compact ? 'text-xs text-gray-500' : 'text-sm text-gray-600 max-w-sm mx-auto'}>
            Plan changes aren&apos;t available in the app. You can manage your plan from your account on the Badger Board website.
          </p>
        </div>
      </div>
    )
  }

  if (compact) {
    return (
      <div className="flex items-center justify-between gap-4 p-4 bg-gradient-to-r from-brand-red/5 to-brand-navy/5 border border-brand-red/20 rounded-xl">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-8 h-8 bg-brand-red/10 rounded-lg flex items-center justify-center flex-shrink-0">
            <Lock className="w-4 h-4 text-brand-red" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-bold text-gray-900 truncate">{feature} — Upgrade Required</p>
            <p className="text-xs text-gray-500 truncate">
              Available on {plan}{priceLabel ? ` (${priceLabel})` : ''}
            </p>
          </div>
        </div>
        <button
          onClick={() => navigate('/plans')}
          className="flex-shrink-0 flex items-center gap-1.5 bg-brand-red hover:bg-red-700 text-white text-xs font-bold px-4 py-2 rounded-lg transition-all shadow-sm hover:shadow-md"
        >
          Upgrade <ArrowRight className="w-3.5 h-3.5" />
        </button>
      </div>
    )
  }

  return (
    <div className="rounded-2xl border-2 border-brand-red/20 bg-gradient-to-br from-red-50 via-white to-blue-50/40 p-8 text-center shadow-sm">
      {/* Lock icon */}
      <div className="w-14 h-14 bg-brand-red/10 rounded-2xl flex items-center justify-center mx-auto mb-4">
        <Lock className="w-7 h-7 text-brand-red" />
      </div>

      {/* Feature name */}
      <h3 className="text-xl font-black text-gray-900 mb-2">
        {feature} is locked on your plan
      </h3>

      {/* Value anchor — the Hormozi hook */}
      <p className="text-sm text-gray-600 max-w-sm mx-auto mb-1 leading-relaxed">
        {hook}
      </p>

      {/* Price callout — only when a price was actually passed in */}
      <p className="text-xs text-gray-400 mb-6">
        Unlock everything on <strong className="text-gray-700">{plan}</strong>
        {priceLabel && <> — starting at <strong className="text-brand-red">{priceLabel}</strong></>}
      </p>

      {/* Benefits list */}
      {benefits.length > 0 && (
        <ul className="text-left max-w-xs mx-auto space-y-2 mb-6">
          {benefits.map((b, i) => (
            <li key={i} className="flex items-start gap-2">
              <Check className="w-4 h-4 text-green-500 flex-shrink-0 mt-0.5" />
              <span className="text-sm text-gray-700">{b}</span>
            </li>
          ))}
        </ul>
      )}

      {/* Primary CTA */}
      <button
        onClick={() => navigate('/plans')}
        className="inline-flex items-center gap-2 bg-brand-red hover:bg-red-700 text-white font-bold px-8 py-3 rounded-xl text-sm transition-all shadow-md hover:shadow-lg mb-3"
      >
        <Sparkles className="w-4 h-4" />
        Upgrade to {plan}{priceLabel ? ` — ${priceLabel}` : ''}
      </button>

      {/* Trust line */}
      <p className="text-xs text-gray-400">
        Cancel anytime · No setup fees · No long-term contracts
      </p>
    </div>
  )
}
