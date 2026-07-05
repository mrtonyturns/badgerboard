import React, { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Check, ChevronDown, ChevronUp,
  ArrowLeft, AlertCircle, Loader2, Lock,
} from 'lucide-react'
import { useAuth } from '../contexts/AuthContext'
import { isNativeApp } from '../lib/native'
import {
  CANDIDATE_PLAN_CONFIG, ACTION_PLAN_CONFIG,
  CANDIDATE_PLAN_ORDER, ACTION_PLAN_ORDER,
  BRACKET_CONFIG, BRACKET_ORDER,
  ACTION_MONTHLY_PRICES,
  BILLING_PERIODS,
  CREDIT_PACKS, BULK_CREDIT_PACKS,
  effectiveMonthlyRate, periodTotal, annualSavings,
  actionEffectiveRate,
  getUserPlan, getUserBracket, getUserPlanType,
} from '../lib/tiers'

// ─── Feature matrix component ─────────────────────────────────────────────────

/**
 * colConfigs: [{ key, label, price, highlighted, current, onSelect, isEnt, loading }]
 * groups:     [{ section, rows: [{ label, [key]: true|false|string }] }]
 */
function FeatureMatrix({ groups, colConfigs, navigate, user }) {
  const highlightedKey = colConfigs.find(c => c.highlighted)?.key

  return (
    <div className="mt-12">
      {/* Section label */}
      <div className="flex items-center gap-3 mb-6">
        <div className="h-px flex-1 bg-gray-200" />
        <span className="text-xs font-semibold text-gray-400 uppercase tracking-widest px-1">
          Compare plans
        </span>
        <div className="h-px flex-1 bg-gray-200" />
      </div>

      <div className="rounded-2xl border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm" style={{ borderCollapse: 'separate', borderSpacing: 0 }}>

            {/* ── Column headers ─────────────────────────────────────────── */}
            <thead>
              <tr>
                {/* Feature label column */}
                <th className="w-[38%] py-5 px-6 text-left align-bottom bg-white border-b border-gray-100" />

                {colConfigs.map(col => (
                  <th
                    key={col.key}
                    className={`py-5 px-5 text-center align-bottom border-b ${
                      col.highlighted
                        ? 'bg-gray-950 border-gray-950'
                        : 'bg-white border-gray-100'
                    }`}
                  >
                    <div className="flex flex-col items-center gap-2">
                      <span className={`text-xs font-semibold uppercase tracking-wider ${
                        col.highlighted ? 'text-gray-400' : 'text-gray-400'
                      }`}>
                        {col.label}
                      </span>
                      <span className={`text-2xl font-bold tracking-tight ${
                        col.highlighted ? 'text-white' : 'text-gray-900'
                      }`}>
                        {col.price}
                      </span>
                      <button
                        onClick={() => {
                          if (col.key === 'scout') { navigate(user ? '/' : '/login'); return }
                          if (col.isEnt) { window.open('mailto:tony@thebluejackgroup.com'); return }
                          col.onSelect(col.key)
                        }}
                        disabled={col.current || !!col.loading}
                        className={`mt-1 w-full py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                          col.current
                            ? col.highlighted
                              ? 'bg-white/10 text-white/50 cursor-default'
                              : 'bg-gray-100 text-gray-400 cursor-default'
                            : col.highlighted
                            ? 'bg-white text-gray-900 hover:bg-gray-100'
                            : 'bg-gray-900 text-white hover:bg-gray-700'
                        }`}
                      >
                        {col.loading === col.key
                          ? '…'
                          : col.current ? 'Current'
                          : col.isEnt   ? 'Contact'
                          : col.key === 'scout' ? 'Start free'
                          : 'Get started'}
                      </button>
                    </div>
                  </th>
                ))}
              </tr>
            </thead>

            {/* ── Feature rows ───────────────────────────────────────────── */}
            <tbody>
              {groups.map((group, gi) => (
                <React.Fragment key={group.section}>

                  {/* Section header */}
                  <tr>
                    <td
                      colSpan={colConfigs.length + 1}
                      className="pt-6 pb-2 px-6 bg-white"
                    >
                      <span className="text-[11px] font-bold text-gray-400 uppercase tracking-widest">
                        {group.section}
                      </span>
                    </td>
                  </tr>

                  {/* Feature rows */}
                  {group.rows.map((row, ri) => {
                    const isLast = ri === group.rows.length - 1
                    return (
                      <tr key={row.label} className="group/row">
                        {/* Feature name */}
                        <td className={`py-3 px-6 bg-white ${isLast ? 'pb-5' : ''}`}>
                          <span className="text-sm text-gray-700">{row.label}</span>
                        </td>

                        {/* Value cells */}
                        {colConfigs.map(col => {
                          const val = row[col.key]
                          const isHighlighted = col.highlighted
                          return (
                            <td
                              key={col.key}
                              className={`py-3 px-5 text-center ${isLast ? 'pb-5' : ''} ${
                                isHighlighted ? 'bg-gray-950/[0.03]' : 'bg-white'
                              } group-hover/row:bg-gray-50/60 transition-colors`}
                            >
                              {val === true && (
                                <span className={`inline-flex items-center justify-center w-5 h-5 rounded-full ${
                                  isHighlighted
                                    ? 'bg-gray-900 text-white'
                                    : 'bg-gray-100 text-gray-700'
                                }`}>
                                  <Check className="w-3 h-3" strokeWidth={2.5} />
                                </span>
                              )}
                              {val === false && (
                                <span className="text-gray-200 text-base font-light select-none">—</span>
                              )}
                              {typeof val === 'string' && (
                                <span className={`inline-block text-xs font-medium px-2 py-0.5 rounded-md ${
                                  isHighlighted
                                    ? 'bg-gray-900/10 text-gray-700'
                                    : 'bg-gray-100 text-gray-600'
                                }`}>
                                  {val}
                                </span>
                              )}
                            </td>
                          )
                        })}
                      </tr>
                    )
                  })}
                </React.Fragment>
              ))}

              {/* Bottom padding row */}
              <tr>
                <td colSpan={colConfigs.length + 1} className="py-2 bg-white border-t border-gray-100" />
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

function FAQItem({ q, a }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="border-b border-gray-200 last:border-0">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between py-4 text-left gap-6"
      >
        <span className="text-sm font-medium text-gray-900">{q}</span>
        {open
          ? <ChevronUp  className="w-4 h-4 text-gray-400 flex-shrink-0" />
          : <ChevronDown className="w-4 h-4 text-gray-400 flex-shrink-0" />}
      </button>
      {open && (
        <p className="pb-5 text-sm text-gray-500 leading-relaxed max-w-2xl">{a}</p>
      )}
    </div>
  )
}

// ─── Feature data ─────────────────────────────────────────────────────────────

const C_FEATURES = [
  { section: 'AI Profiles',
    rows: [
      { label: 'Profiles per month',          scout: 'Lite (1×)', c_monitor: '1',    c_active: '2',    c_campaign: '4'    },
      { label: 'Full 14-section report',      scout: false,       c_monitor: true,   c_active: true,   c_campaign: true   },
      { label: 'A la carte credit packs',     scout: false,       c_monitor: true,   c_active: true,   c_campaign: true   },
      { label: 'Campaign Intelligence briefs',scout: false,       c_monitor: false,  c_active: true,   c_campaign: true   },
      { label: 'AI candidate discovery',      scout: false,       c_monitor: false,  c_active: true,   c_campaign: true   },
      { label: 'Weekly auto-refresh',         scout: false,       c_monitor: false,  c_active: false,  c_campaign: true   },
    ],
  },
  { section: 'Candidate Tools',
    rows: [
      { label: 'Dashboard',                   scout: true,        c_monitor: true,   c_active: true,   c_campaign: true   },
      { label: 'Active candidate slots',      scout: '0',         c_monitor: '0',    c_active: '1',    c_campaign: '3'    },
      { label: 'Game Plan',                   scout: '1 only',    c_monitor: true,   c_active: true,   c_campaign: true   },
      { label: 'Compare tool',                scout: false,       c_monitor: false,  c_active: true,   c_campaign: true   },
      { label: 'CSV bulk import',             scout: false,       c_monitor: true,   c_active: true,   c_campaign: true   },
      { label: 'Social media links',          scout: false,       c_monitor: true,   c_active: true,   c_campaign: true   },
      { label: 'Elections tracking',          scout: true,        c_monitor: true,   c_active: true,   c_campaign: true   },
    ],
  },
  { section: 'Account',
    rows: [
      { label: 'User seats',                  scout: '1',         c_monitor: '1',    c_active: '1',    c_campaign: '2'    },
      { label: 'Prospecting lists',           scout: false,       c_monitor: false,  c_active: false,  c_campaign: false  },
      { label: 'Offices section',             scout: false,       c_monitor: false,  c_active: false,  c_campaign: false  },
    ],
  },
]

const A_FEATURES = [
  { section: 'AI Profiles',
    rows: [
      { label: 'Profiles per month',          a_monitor: '1 per candidate', a_active: '2 per candidate', a_campaign: '4 per candidate' },
      { label: 'Campaign Intelligence briefs',a_monitor: true,           a_active: true,             a_campaign: true           },
      { label: 'AI candidate discovery',      a_monitor: true,           a_active: true,             a_campaign: true           },
      { label: 'Weekly auto-refresh',         a_monitor: false,          a_active: true,             a_campaign: true           },
      { label: 'Bulk Profiler (CSV runs)',     a_monitor: false,          a_active: false,            a_campaign: 'With credits' },
    ],
  },
  { section: 'Candidate Tools',
    rows: [
      { label: 'Active candidates',           a_monitor: 'By bracket',   a_active: 'By bracket',     a_campaign: 'By bracket'   },
      { label: 'Multi-Candidate Game Plan',   a_monitor: true,           a_active: true,             a_campaign: true           },
      { label: 'Compare tool',                a_monitor: false,          a_active: true,             a_campaign: true           },
      { label: 'Prospecting lists',           a_monitor: true,           a_active: true,             a_campaign: true           },
      { label: 'CSV bulk import',             a_monitor: true,           a_active: true,             a_campaign: true           },
      { label: 'Elections tracking',          a_monitor: true,           a_active: true,             a_campaign: true           },
    ],
  },
  { section: 'Offices',
    rows: [
      { label: 'Office seat tracking',        a_monitor: 'County',       a_active: 'Cong. + Senate', a_campaign: 'Entire state' },
      { label: 'Lean scores & officeholders', a_monitor: true,           a_active: true,             a_campaign: true           },
    ],
  },
  { section: 'Account',
    rows: [
      { label: 'User seats',                  a_monitor: '1',            a_active: '2',              a_campaign: 'Unlimited'    },
      { label: 'Bulk profile credits',         a_monitor: false,          a_active: false,            a_campaign: true           },
    ],
  },
]

const FAQS = [
  {
    q: 'What is the difference between the Candidate Plan and the Action Plan?',
    a: 'The Candidate Plan is for individual campaigns — flat monthly pricing, no bracket. The Action Plan is for political organizations managing multiple candidates. It uses bracket pricing based on how many active candidates you monitor.',
  },
  {
    q: 'What is an active candidate?',
    a: 'An active candidate is someone flagged for continuous monitoring. They appear on your dashboard, count toward your bracket on the Action Plan, and on eligible tiers receive a fresh AI profile every Friday. Candidate Plan has fixed active candidate slots (0, 1, or 3 depending on tier).',
  },
  {
    q: "What's in a full AI profile?",
    a: "Each profile is a 14-section report covering news coverage, biography, political timeline, voting record, campaign finance, controversies, policy positions, organizational affiliations, political network, social media, digital presence, media strategy, attack and defense vectors, and verification flags.",
  },
  {
    q: 'What is a lite profile on Scout?',
    a: "Scout users get one profile per month. Biography and Political Record are fully visible. Affiliations shows the first two entries. Everything else is locked. It gives you a clear sense of what the full report contains.",
  },
  {
    q: 'Can I switch plans or billing periods anytime?',
    a: 'Yes. Upgrades take effect immediately and are prorated. Downgrades take effect at your next renewal. No cancellation fees on monthly plans.',
  },
  {
    q: 'What are bulk profile credits?',
    a: 'Bulk credits enable the Bulk Profiler — a tool that generates profiles for a CSV list of candidates at once. Each run consumes bulk credits. Your monthly pool (1–4 profiles per candidate depending on tier) is separate and cannot be used for bulk runs.',
  },
  {
    q: 'What happens to my data if I cancel?',
    a: 'Your profiles and candidate data stay accessible for 90 days after cancellation. You can export everything as PDF before access ends.',
  },
]

// ─── Candidate plan highlight features (shown on cards) ──────────────────────

const C_CARD_FEATURES = {
  scout: [
    '1 lite profile per month',
    'Elections tracking',
    'Wisconsin district map',
  ],
  c_monitor: [
    '1 full AI profile per month',
    'CSV import & social links',
    'A la carte credit packs',
  ],
  c_active: [
    '2 profiles per month',
    '1 active candidate slot',
    'Campaign Intel briefs',
    'Compare tool',
  ],
  c_campaign: [
    '4 profiles per month',
    '3 active candidate slots',
    'Weekly auto-refresh',
    '2 user seats',
  ],
}

const A_CARD_FEATURES = {
  a_monitor: [
    '1 profile per candidate / month',
    'Prospecting lists',
    'Multi-Candidate Game Plan',
    'Offices — county view',
  ],
  a_active: [
    '2 profiles per candidate / month',
    'Offices — congressional & senate',
    'Compare tool',
    'Weekly auto-refresh',
  ],
  a_campaign: [
    '4 profiles per candidate / month',
    'Offices — entire state',
    'Bulk Profiler (with credits)',
    'Unlimited user seats',
  ],
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function Pricing() {
  const { user, session, refreshSession } = useAuth()
  const navigate          = useNavigate()

  // ── Native app (App Store / Play Store) ─────────────────────────────────────
  // Apple/Google rules prohibit selling digital subscriptions in-app outside
  // their IAP systems. The native app shows a neutral notice instead of plans.
  if (isNativeApp) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center p-8">
        <div className="max-w-md text-center">
          <div className="w-14 h-14 bg-gray-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
            <Lock className="w-7 h-7 text-gray-500" />
          </div>
          <h1 className="text-xl font-black text-gray-900 mb-2">Plans aren&apos;t available in the app</h1>
          <p className="text-sm text-gray-600 leading-relaxed">
            Subscriptions and plan changes are managed from your account on the BadgerBoard website. Everything included in your plan works right here in the app.
          </p>
        </div>
      </div>
    )
  }

  const userPlan          = user ? getUserPlan(user)     : null
  const userPlanType      = user ? getUserPlanType(user) : null
  const userBracket       = user ? getUserBracket(user)  : null

  const [tab,             setTab]             = useState(userPlanType === 'action' ? 'action' : 'candidate')
  const [billing,         setBilling]         = useState('monthly')
  const [bracket,         setBracket]         = useState(userBracket || 'b6')
  const [checkoutLoading, setCheckoutLoading] = useState(null)
  const [checkoutError,   setCheckoutError]   = useState(null)

  const bp = BILLING_PERIODS[billing]

  // ── Checkout ──────────────────────────────────────────────────────────────────

  const checkout = async (payload, loadKey) => {
    if (!user) { navigate('/login'); return }
    setCheckoutLoading(loadKey)
    setCheckoutError(null)
    try {
      const token = session?.access_token
      const currentPlan = user?.app_metadata?.plan
      const hasActiveSub = currentPlan && currentPlan !== 'scout' && user?.app_metadata?.stripe_subscription_id

      // Credits always use checkout (payment, not subscription)
      const isCredits = payload.product === 'credits' || payload.product === 'bulk_credits'

      if (hasActiveSub && !isCredits) {
        // Update existing subscription — no redirect needed
        const res = await fetch('/.netlify/functions/update-subscription', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ ...payload, userId: user.id, email: user.email }),
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error || 'Failed to update plan')
        // Show success — no redirect
        setCheckoutError(null)
        // Use billingMsg-style success via checkoutError repurposed as success, or navigate to settings
        await refreshSession?.()
        setCheckoutLoading(null)   // clear BEFORE navigating so the button never sticks
        navigate('/settings?billing=success&plan=' + (payload.plan || ''))
        return
      }

      const res   = await fetch('/.netlify/functions/create-checkout-session', {
        method:  'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ ...payload, userId: user.id, email: user.email }),
      })
      const json = await res.json()
      if (json.url) window.location.href = json.url
      else setCheckoutError(json.error || 'Could not start checkout.')
    } catch (err) {
      setCheckoutError(err.message || 'Could not reach the server. Check your connection.')
    }
    setCheckoutLoading(null)
  }

  // ── Price helpers ─────────────────────────────────────────────────────────────

  const cEffective = (base) => base === 0 ? 0 : effectiveMonthlyRate(base, billing)
  const cTotal     = (base) => base === 0 ? null : periodTotal(base, billing)
  const cSavings   = (base) => base === 0 ? 0 : annualSavings(base, billing)

  const aEffective = (pk)   => actionEffectiveRate(pk, bracket, billing)
  const aBase      = (pk)   => ACTION_MONTHLY_PRICES[pk]?.[bracket] ?? null

  const billedSub = (base) => {
    if (!base || billing === 'monthly') return null
    const total   = periodTotal(base, billing)
    const savings = annualSavings(base, billing)
    if (billing === 'quarterly')  return `$${total} billed every 3 months`
    if (billing === 'semiannual') return `$${total} billed every 6 months`
    if (billing === 'annual')     return `$${total} billed annually · saves $${savings}/yr`
    return null
  }

  // ── Shared plan card ──────────────────────────────────────────────────────────

  const PlanCard = ({
    planKey, name, basePrice, highlighted,
    features, current, onSelect, note, isEnt, loading,
    profilesPerMo, userSeats,
  }) => {
    const effectivePrice = basePrice != null ? cEffective(basePrice) : (isEnt ? null : aEffective(planKey))
    const bSub = basePrice != null
      ? billedSub(basePrice)
      : (isEnt ? null : billedSub(aBase(planKey)))
    const isCurrent = current
    const isLoading = loading === planKey

    return (
      <div className={`flex flex-col rounded-xl p-6 border ${
        highlighted
          ? 'border-gray-900 bg-white shadow-md'
          : 'border-gray-200 bg-white'
      }`}>

        {/* Plan name + recommended label */}
        <div className="flex items-center justify-between mb-6">
          <span className="text-sm font-semibold text-gray-900">{name}</span>
          {highlighted && (
            <span className="text-xs font-medium text-gray-500 bg-gray-100 px-2.5 py-1 rounded-full">
              Recommended
            </span>
          )}
          {isCurrent && !highlighted && (
            <span className="text-xs font-medium text-green-700 bg-green-50 px-2.5 py-1 rounded-full border border-green-200">
              Current plan
            </span>
          )}
          {isCurrent && highlighted && (
            <span className="text-xs font-medium text-green-700 bg-green-50 px-2.5 py-1 rounded-full border border-green-200">
              Current
            </span>
          )}
        </div>

        {/* Price */}
        <div className="mb-6">
          {basePrice === 0 ? (
            <>
              <div className="text-4xl font-bold text-gray-900 tracking-tight">Free</div>
              <div className="text-sm text-gray-400 mt-1">No credit card required</div>
            </>
          ) : isEnt ? (
            <>
              <div className="text-4xl font-bold text-gray-900 tracking-tight">Custom</div>
              <div className="text-sm text-gray-400 mt-1">Contact us for volume pricing</div>
            </>
          ) : effectivePrice != null ? (
            <>
              <div className="flex items-baseline gap-1">
                <span className="text-4xl font-bold text-gray-900 tracking-tight">${effectivePrice}</span>
                <span className="text-sm text-gray-400">/mo</span>
              </div>
              <div className="text-sm text-gray-400 mt-1 min-h-[20px]">
                {bSub || (billing === 'monthly' ? 'Billed monthly' : '')}
              </div>
            </>
          ) : (
            <>
              <div className="text-4xl font-bold text-gray-900 tracking-tight">—</div>
              <div className="text-sm text-gray-400 mt-1">Select a bracket above</div>
            </>
          )}
        </div>

        {/* CTA */}
        <button
          onClick={() => {
            if (planKey === 'scout') { navigate(user ? '/' : '/login'); return }
            if (isEnt) { window.open('mailto:tony@thebluejackgroup.com'); return }
            onSelect(planKey)
          }}
          disabled={isCurrent || !!checkoutLoading}
          className={`w-full py-2.5 rounded-lg text-sm font-semibold transition-colors mb-6 ${
            isCurrent
              ? 'bg-gray-100 text-gray-400 cursor-default'
              : highlighted
              ? 'bg-gray-900 hover:bg-gray-700 text-white'
              : 'bg-white hover:bg-gray-50 text-gray-900 border border-gray-200'
          }`}
        >
          {isLoading
            ? <span className="flex items-center justify-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Redirecting…</span>
            : isCurrent   ? 'Current plan'
            : isEnt       ? 'Contact sales'
            : planKey === 'scout' ? 'Get started free'
            : user        ? 'Switch plan'
            : 'Get started'}
        </button>

        {/* Features */}
        <ul className="space-y-3">
          {features.map((f, i) => (
            <li key={i} className="flex items-start gap-2.5">
              <Check className="w-4 h-4 text-gray-400 flex-shrink-0 mt-0.5" />
              <span className="text-sm text-gray-600">{f}</span>
            </li>
          ))}
        </ul>

        {note && (
          <p className="mt-4 pt-4 border-t border-gray-100 text-xs text-gray-400">{note}</p>
        )}
      </div>
    )
  }

  // ── Bracket rows ──────────────────────────────────────────────────────────────

  const bracketList = BRACKET_ORDER.map(k => BRACKET_CONFIG[k])

  return (
    <div className="max-w-5xl mx-auto pb-24">

      {/* Back */}
      <div className="pt-6 pb-8">
        <button
          onClick={() => navigate(user ? '/' : -1)}
          className="inline-flex items-center gap-2 text-sm text-gray-500 hover:text-gray-800 transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          Back
        </button>
      </div>

      {/* Header */}
      <div className="mb-10">
        <h1 className="text-3xl font-bold text-gray-900 mb-2 tracking-tight">Plans & pricing</h1>
        <p className="text-gray-500 text-base max-w-xl">
          Choose the plan that fits your operation. Cancel or change anytime — no contracts.
        </p>
      </div>

      {/* Plan family + billing controls */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-8">

        {/* Tab switcher */}
        <div className="flex items-center rounded-lg border border-gray-200 p-0.5 bg-gray-50 text-sm">
          <button
            onClick={() => setTab('candidate')}
            className={`px-4 py-1.5 rounded-md font-medium transition-all ${
              tab === 'candidate'
                ? 'bg-white text-gray-900 shadow-sm border border-gray-200'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            Candidate Plan
          </button>
          <button
            onClick={() => setTab('action')}
            className={`px-4 py-1.5 rounded-md font-medium transition-all ${
              tab === 'action'
                ? 'bg-white text-gray-900 shadow-sm border border-gray-200'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            Action Plan
          </button>
        </div>

        {/* Billing toggle */}
        <div className="flex items-center rounded-lg border border-gray-200 p-0.5 bg-gray-50 text-sm">
          {Object.values(BILLING_PERIODS).map(b => (
            <button
              key={b.key}
              onClick={() => setBilling(b.key)}
              className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-md font-medium transition-all ${
                billing === b.key
                  ? 'bg-white text-gray-900 shadow-sm border border-gray-200'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              {b.label}
              {b.badge && (
                <span className={`text-xs font-semibold px-1.5 py-0.5 rounded ${
                  billing === b.key ? 'bg-gray-100 text-gray-600' : 'text-gray-400'
                }`}>
                  {b.badge}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Error */}
      {checkoutError && (
        <div className="flex items-start gap-3 p-4 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700 mb-6">
          <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <span>{checkoutError}</span>
          <button onClick={() => setCheckoutError(null)} className="ml-auto text-red-400 hover:text-red-600">✕</button>
        </div>
      )}

      {/* ── CANDIDATE PLAN ─────────────────────────────────────────────────────── */}
      {tab === 'candidate' && (
        <>
          <p className="text-sm text-gray-500 mb-6">
            Flat monthly rate. One candidate or a small team. No bracket pricing.
          </p>

          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-10">
            {CANDIDATE_PLAN_ORDER.map(pk => {
              const plan = CANDIDATE_PLAN_CONFIG[pk]
              return (
                <PlanCard
                  key={pk}
                  planKey={pk}
                  name={plan.name}
                  basePrice={plan.monthlyPrice}
                  highlighted={pk === 'c_active'}
                  features={C_CARD_FEATURES[pk]}
                  current={userPlan === pk && userPlanType === 'candidate'}
                  loading={checkoutLoading}
                  onSelect={(key) => checkout({ plan: key, billing }, key)}
                  note={pk === 'scout' ? 'Includes a lite profile — biography and political record sections visible.' : null}
                />
              )
            })}
          </div>

          {/* A la carte credits */}
          <section className="mb-10">
            <div className="mb-4">
              <h2 className="text-base font-semibold text-gray-900">A la carte profile credits</h2>
              <p className="text-sm text-gray-500 mt-1">
                Need profiles beyond your monthly limit? Credits never expire and work on any plan.
              </p>
            </div>
            <div className="rounded-xl border border-gray-200 overflow-hidden">
              <div className="grid sm:grid-cols-4 divide-y sm:divide-y-0 sm:divide-x divide-gray-200">
                {CREDIT_PACKS.map(pack => (
                  <div key={pack.key} className="px-5 py-5">
                    <div className="text-lg font-semibold text-gray-900 mb-1">
                      {pack.qty === 1 ? '1 profile' : `${pack.qty} profiles`}
                    </div>
                    <div className="flex items-baseline gap-1 mb-1">
                      <span className="text-2xl font-bold text-gray-900">${pack.price}</span>
                    </div>
                    <div className="text-xs text-gray-400 mb-4">
                      ${pack.perCredit.toFixed(2)} per profile
                      {pack.savingsPct ? ` · ${pack.savingsPct}% off` : ''}
                    </div>
                    <button
                      onClick={() => {
                        if (!user) { navigate('/login'); return }
                        const lk    = `credits-${pack.key}`
                        const token = session?.access_token
                        setCheckoutLoading(lk)
                        setCheckoutError(null)
                        fetch('/.netlify/functions/create-checkout-session', {
                          method: 'POST',
                          headers: {
                            'Content-Type': 'application/json',
                            ...(token ? { Authorization: `Bearer ${token}` } : {}),
                          },
                          body: JSON.stringify({ product: 'credits', pack: pack.key, userId: user.id, email: user.email }),
                        })
                          .then(r => r.json())
                          .then(j => { if (j.url) window.location.href = j.url; else setCheckoutError(j.error || 'Checkout failed.') })
                          .catch(() => setCheckoutError('Could not reach the server.'))
                          .finally(() => setCheckoutLoading(null))
                      }}
                      disabled={!!checkoutLoading}
                      className={`w-full text-sm font-medium py-2 rounded-lg border transition-colors ${
                        pack.key === 'c10'
                          ? 'bg-gray-900 text-white border-gray-900 hover:bg-gray-700'
                          : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-50'
                      } ${checkoutLoading === `credits-${pack.key}` ? 'opacity-50' : ''}`}
                    >
                      {checkoutLoading === `credits-${pack.key}` ? 'Redirecting…' : 'Purchase'}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </section>

          <FeatureMatrix
            groups={C_FEATURES}
            navigate={navigate}
            user={user}
            colConfigs={CANDIDATE_PLAN_ORDER.map(pk => ({
              key:         pk,
              label:       CANDIDATE_PLAN_CONFIG[pk].name,
              price:       pk === 'scout' ? 'Free' : `$${cEffective(CANDIDATE_PLAN_CONFIG[pk].monthlyPrice)}`,
              highlighted: pk === 'c_active',
              current:     userPlan === pk && userPlanType === 'candidate',
              loading:     checkoutLoading,
              isEnt:       false,
              onSelect:    (key) => checkout({ plan: key, billing }, key),
            }))}
          />
        </>
      )}

      {/* ── ACTION PLAN ────────────────────────────────────────────────────────── */}
      {tab === 'action' && (
        <>
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
            <p className="text-sm text-gray-500">
              For organizations tracking multiple candidates. Price scales with your active candidate count.
            </p>

            {/* Bracket selector */}
            <div className="flex items-center gap-2 flex-shrink-0">
              <span className="text-sm text-gray-500">Active candidates:</span>
              <div className="relative">
                <select
                  value={bracket}
                  onChange={e => setBracket(e.target.value)}
                  className="appearance-none text-sm font-medium text-gray-900 border border-gray-200 bg-white rounded-lg px-3 py-1.5 pr-8 focus:outline-none focus:ring-2 focus:ring-gray-200 cursor-pointer"
                >
                  {bracketList.map(b => (
                    <option key={b.key} value={b.key}>{b.label}</option>
                  ))}
                </select>
                <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 pointer-events-none" />
              </div>
            </div>
          </div>

          <div className="grid sm:grid-cols-3 gap-4 mb-10">
            {ACTION_PLAN_ORDER.map(pk => {
              const plan = ACTION_PLAN_CONFIG[pk]
              const base = ACTION_MONTHLY_PRICES[pk]?.[bracket]
              return (
                <PlanCard
                  key={pk}
                  planKey={pk}
                  name={plan.name}
                  basePrice={null}
                  highlighted={pk === 'a_active'}
                  features={A_CARD_FEATURES[pk]}
                  current={userPlan === pk && userPlanType === 'action'}
                  loading={checkoutLoading}
                  isEnt={bracket === 'ent'}
                  onSelect={(key) => checkout({ plan: key, bracket, billing }, key)}
                  note={pk === 'a_campaign' ? `Bulk Profiler requires bulk credits purchased separately.` : null}
                />
              )
            })}
          </div>

          {/* Bracket price table */}
          <section className="mb-10">
            <h2 className="text-sm font-semibold text-gray-700 mb-3">
              Monthly rates by active candidate count
              {billing !== 'monthly' && (
                <span className="ml-2 text-gray-400 font-normal">
                  — showing effective monthly rate with {bp.badge}
                </span>
              )}
            </h2>
            <div className="rounded-xl border border-gray-200 overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-200 bg-gray-50">
                      <th className="text-left py-3 px-5 font-medium text-gray-500">Candidates</th>
                      {ACTION_PLAN_ORDER.map(pk => (
                        <th key={pk} className="py-3 px-4 text-center font-semibold text-gray-700">
                          {ACTION_PLAN_CONFIG[pk].name}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {bracketList.map((b, i) => (
                      <tr
                        key={b.key}
                        onClick={() => setBracket(b.key)}
                        className={`border-t border-gray-100 cursor-pointer transition-colors ${
                          bracket === b.key ? 'bg-gray-50' : 'hover:bg-gray-50'
                        }`}
                      >
                        <td className="py-3 px-5 text-gray-700 font-medium">
                          <div className="flex items-center gap-2">
                            {bracket === b.key && (
                              <span className="w-1.5 h-1.5 rounded-full bg-gray-700 flex-shrink-0" />
                            )}
                            {b.label}
                            <span className="text-xs text-gray-400 font-normal hidden sm:inline">{b.sublabel}</span>
                          </div>
                        </td>
                        {ACTION_PLAN_ORDER.map(pk => {
                          const base = ACTION_MONTHLY_PRICES[pk][b.key]
                          const eff  = base ? actionEffectiveRate(pk, b.key, billing) : null
                          return (
                            <td key={pk} className="py-3 px-4 text-center">
                              {eff != null
                                ? <span className="font-semibold text-gray-800">${eff}<span className="font-normal text-gray-400 text-xs">/mo</span></span>
                                : <span className="text-gray-400 text-xs">Contact us</span>
                              }
                            </td>
                          )
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </section>

          {/* Bulk credits */}
          <section className="mb-10">
            <div className="mb-4">
              <h2 className="text-base font-semibold text-gray-900">Bulk profile credits</h2>
              <p className="text-sm text-gray-500 mt-1">
                Required for Bulk Profiler runs on the Campaign tier. Credits never expire.
                Your monthly profile pool is separate.
              </p>
            </div>
            <div className="rounded-xl border border-gray-200 overflow-hidden">
              <div className="grid sm:grid-cols-4 divide-y sm:divide-y-0 sm:divide-x divide-gray-200">
                {BULK_CREDIT_PACKS.map(pack => (
                  <div key={pack.key} className="px-5 py-5">
                    <div className="text-lg font-semibold text-gray-900 mb-1">
                      {pack.qty} credits
                    </div>
                    <div className="flex items-baseline gap-1 mb-1">
                      <span className="text-2xl font-bold text-gray-900">${pack.price}</span>
                    </div>
                    <div className="text-xs text-gray-400 mb-4">
                      ${pack.perCredit.toFixed(2)} per profile
                      {pack.savingsPct ? ` · ${pack.savingsPct}% off` : ''}
                    </div>
                    <button
                      onClick={() => {
                        if (!user) { navigate('/login'); return }
                        const lk = `bulk-${pack.key}`
                        const token = session?.access_token
                        setCheckoutLoading(lk)
                        setCheckoutError(null)
                        fetch('/.netlify/functions/create-checkout-session', {
                          method: 'POST',
                          headers: {
                            'Content-Type': 'application/json',
                            ...(token ? { Authorization: `Bearer ${token}` } : {}),
                          },
                          body: JSON.stringify({ product: 'bulk_credits', pack: pack.key, userId: user.id, email: user.email }),
                        })
                          .then(r => r.json())
                          .then(j => { if (j.url) window.location.href = j.url; else setCheckoutError(j.error || 'Checkout failed.') })
                          .catch(() => setCheckoutError('Could not reach the server.'))
                          .finally(() => setCheckoutLoading(null))
                      }}
                      disabled={!!checkoutLoading}
                      className={`w-full text-sm font-medium py-2 rounded-lg border transition-colors ${
                        pack.key === 'bulk100'
                          ? 'bg-gray-900 text-white border-gray-900 hover:bg-gray-700'
                          : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-50'
                      } ${checkoutLoading === `bulk-${pack.key}` ? 'opacity-50' : ''}`}
                    >
                      {checkoutLoading === `bulk-${pack.key}` ? 'Redirecting…' : 'Purchase'}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </section>

          <FeatureMatrix
            groups={A_FEATURES}
            navigate={navigate}
            user={user}
            colConfigs={ACTION_PLAN_ORDER.map(pk => {
              const base = ACTION_MONTHLY_PRICES[pk]?.[bracket]
              const eff  = base ? actionEffectiveRate(pk, bracket, billing) : null
              return {
                key:         pk,
                label:       ACTION_PLAN_CONFIG[pk].name,
                price:       bracket === 'ent' ? 'Custom' : eff != null ? `$${eff}` : '—',
                highlighted: pk === 'a_active',
                current:     userPlan === pk && userPlanType === 'action',
                loading:     checkoutLoading,
                isEnt:       bracket === 'ent',
                onSelect:    (key) => checkout({ plan: key, bracket, billing }, key),
              }
            })}
          />
        </>
      )}

      {/* ── Common: FAQ ───────────────────────────────────────────────────────── */}
      <section className="mt-16 pt-10 border-t border-gray-200">
        <div className="mb-6">
          <h2 className="text-lg font-semibold text-gray-900">Common questions</h2>
          <p className="text-sm text-gray-500 mt-1">
            Anything else?{' '}
            <a href="mailto:tony@thebluejackgroup.com" className="underline underline-offset-2 hover:text-gray-800 transition-colors">
              Send us an email.
            </a>
          </p>
        </div>
        <div className="max-w-2xl">
          {FAQS.map(f => <FAQItem key={f.q} {...f} />)}
        </div>
      </section>

      {/* ── Common: Footer CTA ────────────────────────────────────────────────── */}
      <section className="mt-16 pt-10 border-t border-gray-200 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-6">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Ready to get started?</h2>
          <p className="text-sm text-gray-500 mt-1">Scout is free, takes 60 seconds to set up, and requires no credit card.</p>
        </div>
        <div className="flex items-center gap-3 flex-shrink-0">
          <button
            onClick={() => navigate(user ? '/profiler' : '/login')}
            className="bg-gray-900 hover:bg-gray-700 text-white font-semibold px-5 py-2.5 rounded-lg text-sm transition-colors"
          >
            {user ? 'Go to Profiler' : 'Start for free'}
          </button>
          <button
            onClick={() => navigate('/settings#billing')}
            className="text-gray-600 hover:text-gray-900 font-medium px-5 py-2.5 rounded-lg text-sm border border-gray-200 hover:border-gray-300 transition-colors"
          >
            Billing settings
          </button>
        </div>
      </section>

    </div>
  )
}
