// src/pages/settings/PlanPane.jsx — Plan & billing pane (/settings/plan).
//
// Every number here comes from src/lib/tiers.js or a real count passed in by
// Settings.jsx. Nothing on this screen is illustrative.

import React, { useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import {
  PLAN_CONFIG, MONTHLY_PRICES, BILLING_PERIODS,
  getUserPlan, getUserPlanType, getUserBracket, getBracketConfig, getPlanConfig,
  getUserBillingPeriod, effectiveMonthlyRate, periodTotal,
  getEntitlementSource, getActiveTrial, hasFeature, SCOUT_CANDIDATE_LIMIT,
} from '../../lib/tiers'
import { isNativeApp } from '../../lib/native'
import {
  Card, CardBody, Btn, LinkBtn, Pill, Note, Msg, Spinner, T, money, plural,
} from './shared'
import { meterFraction, meterTicks, monitoringRowValue, UNLIMITED_ACCOUNT } from './planMath'

// The three rungs of each ladder. Scout is the free floor, not a purchase card.
const FAMILY = {
  candidate: ['c_monitor', 'c_active', 'c_campaign'],
  action:    ['a_monitor', 'a_active', 'a_campaign'],
}

const TICKS = 18

const nextResetLabel = () => {
  const d = new Date()
  return new Date(d.getFullYear(), d.getMonth() + 1, 1)
    .toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

/**
 * 18-tick equalizer bar, filled to used/cap. Red at 85% or more, navy otherwise.
 *
 * An UNLIMITED allowance (cap == null) has no fraction to draw — it used to
 * light all 18 ticks green, which is why "Profiles generated 1", "Monitoring
 * slots 3" and "Candidates tracked 27" all rendered as full gauges on the same
 * account. It now gets a thin flat rule and an explicit "Unlimited — N used".
 * The fraction itself lives in ./planMath so it can be tested.
 */
function Meter({ label, used, cap, note, loading }) {
  const frac  = meterFraction(used, cap)
  const uncapped = frac == null
  const pct   = uncapped ? 0 : Math.round(frac * 100)
  const tight = !uncapped && pct >= 85
  const fill  = tight ? T.red : T.navy
  const lit   = loading ? 0 : meterTicks(used, cap, TICKS)
  const value = loading ? '—' : uncapped ? `Unlimited — ${used} used` : `${used} of ${cap}`

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 7, marginBottom: 7 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: T.ink3 }}>{label}</span>
        <span style={{ marginLeft: 'auto', fontSize: 12.5, fontWeight: 700, color: tight && !loading ? T.red : T.ink }}>{value}</span>
      </div>
      {uncapped && !loading ? (
        // Deliberately NOT a gauge: a full 18-tick bar reads as "you are at your
        // limit". A 2px rule says "there is no limit to draw".
        <div aria-hidden="true" style={{ height: 16, display: 'flex', alignItems: 'center' }}>
          <div style={{ width: '100%', height: 2, borderRadius: 2, background: T.green, opacity: .55 }} />
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 2, alignItems: 'flex-end', height: 16 }} aria-hidden="true">
          {Array.from({ length: TICKS }, (_, i) => (
            <div key={i} style={{
              flex: 1,
              height: i < lit ? 10 + ((i % 3) * 3) : 8,
              borderRadius: 2,
              background: i < lit ? fill : T.track,
            }} />
          ))}
        </div>
      )}
      <div style={{ fontSize: 11, color: T.muted, marginTop: 6 }}>{loading ? 'Counting…' : note}</div>
    </div>
  )
}

export default function PlanPane({
  user, usage, profileLimit, maxSlots,
  onManageBilling, portalLoading, billingMsg, onDismissBilling,
  onCancelPlan, cancelPeriodEnd, isDowngradeLocked, downgradedAt, navigate,
}) {
  const [yearly, setYearly] = useState(false)

  const plan       = getUserPlan(user)
  const planType   = getUserPlanType(user)
  const bracket    = getUserBracket(user)
  const bracketCfg = getBracketConfig(bracket)
  const cfg        = getPlanConfig(plan)
  const entSource  = getEntitlementSource(user)     // admin | beta | trial | paid | free
  const trial      = getActiveTrial(user)
  const period     = getUserBillingPeriod(user)

  const basePrice = (() => {
    if (plan === 'scout') return null
    const c = PLAN_CONFIG[plan]
    if (c?.monthlyPrice != null) return c.monthlyPrice
    return MONTHLY_PRICES[plan]?.[bracket] ?? null
  })()

  const chip = {
    admin: { text: 'ADMIN ACCESS', c: '#4338CA', bg: '#EEF0FD' },
    beta:  { text: 'BETA ACCESS',  c: '#4338CA', bg: '#EEF0FD' },
    trial: { text: trial ? `FREE TRIAL · ${plural(trial.daysLeft, 'day')} left` : 'FREE TRIAL', c: '#6D28D9', bg: '#F3EDFB' },
    paid:  { text: 'ACTIVE',       c: '#6FD79A', bg: 'rgba(111,215,154,.16)' },
    free:  { text: 'FREE',         c: '#A9B2C4', bg: 'rgba(255,255,255,.10)' },
  }[entSource] || { text: 'ACTIVE', c: '#6FD79A', bg: 'rgba(111,215,154,.16)' }

  const headerLine = (() => {
    if (entSource === 'admin') return 'Platform owner account — every feature, no limits, no charge.'
    if (entSource === 'beta')  return 'Full access while the beta program is on — no charge.'
    if (entSource === 'trial' && trial) {
      return `Free until ${new Date(trial.endsAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} — then the free Scout plan unless you subscribe.`
    }
    if (basePrice == null) return 'Free forever. Upgrade whenever you need full profiles.'
    // The viewer's own bracket, which is correct HERE (this line is the current
    // subscription, not a plan spec) — but it read "1 active candidates" on the
    // b1 bracket. The label can be a range ("2 – 5"), so pluralise off max.
    const bracketPart = planType === 'action'
      ? ` · ${bracketCfg.label} active candidate${bracketCfg.max === 1 ? '' : 's'}`
      : ''
    if (period === 'monthly') return `${money(basePrice)} per month${bracketPart}`
    const total = periodTotal(basePrice, period)
    const eff   = effectiveMonthlyRate(basePrice, period)
    return `${money(total)} billed ${BILLING_PERIODS[period].label.toLowerCase()} (${money(eff)}/mo equivalent)${bracketPart}`
  })()

  // ── Usage meters ────────────────────────────────────────────────────────────
  const profilesLeft = profileLimit === Infinity ? Infinity : Math.max(0, profileLimit - usage.profilesUsed)
  const slotsOpen    = maxSlots === Infinity ? Infinity : Math.max(0, maxSlots - usage.monitored)
  // Single source of truth in lib/tiers.js — this used to be a bare `2` here and
  // another bare `2` in Candidates.jsx. (Enforcement is client-side only; see
  // the SCOUT_CANDIDATE_LIMIT comment in tiers.js.)
  const scoutCandidateCap = plan === 'scout' ? SCOUT_CANDIDATE_LIMIT : null

  const meters = [
    {
      label: 'Profiles generated',
      used: usage.profilesUsed,
      cap: profileLimit === Infinity ? null : profileLimit,
      // "on your account", not "on your plan": admin / beta / enterprise
      // entitlements are what lift the cap, and the plan cards below still
      // quote the plan's own number.
      note: profileLimit === Infinity
        ? UNLIMITED_ACCOUNT
        : `${plural(profilesLeft, 'profile')} left · resets ${nextResetLabel()}`,
    },
    {
      label: 'Monitoring slots',
      used: usage.monitored,
      cap: maxSlots === Infinity ? null : maxSlots,
      note: maxSlots === Infinity
        ? `${UNLIMITED_ACCOUNT} · refreshes Mondays`
        : maxSlots === 0
          ? 'Active monitoring is not included on your plan'
          : `${slotsOpen === 1 ? '1 slot open' : `${slotsOpen} slots open`} · refreshes Mondays`,
    },
    {
      label: 'Candidates tracked',
      used: usage.candidates,
      cap: scoutCandidateCap,
      note: scoutCandidateCap
        ? `Scout tracks up to ${plural(scoutCandidateCap, 'candidate')}`
        : UNLIMITED_ACCOUNT,
    },
  ]

  // ── Plan comparison cards ───────────────────────────────────────────────────
  const ladder  = FAMILY[planType] || FAMILY.candidate
  const currIdx = ladder.indexOf(plan)

  const cards = ladder.map((key, i) => {
    const c    = PLAN_CONFIG[key]
    const base = c.monthlyPrice != null ? c.monthlyPrice : (MONTHLY_PRICES[key]?.[bracket] ?? null)
    const isCurrent = key === plan

    // These rows describe what the PLAN includes, not what this account is
    // currently allowed — the "THIS MONTH" meters above are the account. The
    // card header says so, so a plan number here can never be read as a cap.
    const rows = [
      {
        k: 'Profiles',
        v: c.planType === 'action'
          ? `${plural(c.profilesPerCandidate, 'profile')} per candidate / month`
          : `${plural(c.profileLimit ?? 0, 'profile')} per month`,
      },
      {
        // Every Action card used to print the VIEWER's bracket label verbatim,
        // so all three read "1 active candidates" — not the card's plan, and
        // ungrammatical with it. See planMath.monitoringRowValue.
        k: 'Monitoring',
        v: monitoringRowValue(key, bracket),
      },
      {
        k: 'Seats',
        v: c.userLimit === Infinity ? 'Unlimited' : plural(c.userLimit ?? 1, 'seat'),
      },
    ]

    return {
      key, name: c.name, isCurrent, rows,
      price: base == null ? 'Custom' : yearly ? money(periodTotal(base, 'annual')) : money(base),
      per:   base == null ? '' : yearly ? 'per year' : 'per month',
      sub:   base == null
        ? 'Enterprise bracket — priced with you'
        : yearly
          ? `${money(effectiveMonthlyRate(base, 'annual'))}/mo equivalent · 2 months free`
          : 'billed monthly',
      btn: isCurrent ? 'Your plan' : i > currIdx ? 'Upgrade' : 'Switch plan',
    }
  })

  const canBuyCredits = hasFeature(plan, 'creditPacks') || hasFeature(plan, 'bulkCredits')

  return (
    <>
      {billingMsg && (
        <Msg type={billingMsg.type} onDismiss={onDismissBilling}>{billingMsg.text}</Msg>
      )}

      {isDowngradeLocked && (() => {
        const deletionMs = downgradedAt + 30 * 24 * 60 * 60 * 1000
        const daysLeft   = Math.max(0, Math.ceil((deletionMs - Date.now()) / 86400000))
        const deleteDate = new Date(deletionMs).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
        return (
          <Card tone="danger">
            <div style={{ display: 'flex', gap: 12, padding: '16px 24px', alignItems: 'flex-start' }}>
              <AlertTriangle style={{ width: 18, height: 18, color: T.redHot, flex: 'none', marginTop: 1 }} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 700, color: T.redHot }}>Your subscription has ended</div>
                <Note style={{ marginTop: 4 }}>
                  This account is locked. Every candidate, profile and list is scheduled for permanent
                  deletion on <strong>{deleteDate}</strong> ({plural(daysLeft, 'day')} from now) unless you resubscribe.
                </Note>
                {isNativeApp ? (
                  <Note style={{ marginTop: 8 }}>To resubscribe, sign in on the Badger Board website.</Note>
                ) : (
                  <div style={{ marginTop: 10 }}>
                    <Btn kind="primary" onClick={() => navigate('/plans')}>Resubscribe</Btn>
                  </div>
                )}
              </div>
            </div>
          </Card>
        )
      })()}

      <Card style={{ padding: 0 }}>
        <div className="st-planhdr" style={{
          position: 'relative', overflow: 'hidden', display: 'flex', alignItems: 'flex-start',
          gap: 14, padding: '20px 24px 18px',
          background: 'linear-gradient(120deg,#0D1526 0%,#1A2440 100%)',
        }}>
          <div aria-hidden="true" style={{
            position: 'absolute', bottom: -90, left: '34%', width: 200, height: 200, borderRadius: '50%',
            background: 'radial-gradient(circle, rgba(165,28,36,.4) 0%, rgba(165,28,36,0) 70%)',
          }} />
          <div style={{ position: 'relative', flex: 1, minWidth: 210 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 17, fontWeight: 700, color: '#fff', whiteSpace: 'nowrap' }}>
                {cfg.name} plan
              </span>
              <Pill c={chip.c} bg={chip.bg}>{chip.text}</Pill>
            </div>
            <div style={{ fontSize: 12.5, color: '#A9B2C4', marginTop: 4, lineHeight: 1.5 }}>{headerLine}</div>
            {cancelPeriodEnd && (
              <div style={{ fontSize: 12, color: '#F3C892', marginTop: 6 }}>
                Scheduled to cancel on {new Date(cancelPeriodEnd * 1000).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })} — access ends then.
              </div>
            )}
            {!isNativeApp && (
              <div style={{ fontSize: 11.5, color: '#8B94A6', marginTop: 6 }}>
                Invoices, payment method and your renewal date live in the billing portal.
              </div>
            )}
          </div>
          {!isNativeApp ? (
            <div className="st-ctl" style={{ position: 'relative', marginLeft: 'auto', flex: 'none', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <Btn kind="glass" onClick={onManageBilling} disabled={portalLoading}>Invoices</Btn>
              <Btn kind="primary" onClick={onManageBilling} disabled={portalLoading}>
                {portalLoading ? <><Spinner color="#fff" /> Opening…</> : 'Manage billing'}
              </Btn>
            </div>
          ) : (
            <div className="st-ctl" style={{ position: 'relative', marginLeft: 'auto', flex: 'none', maxWidth: 260 }}>
              <div style={{ fontSize: 11.5, color: '#8B94A6', lineHeight: 1.5 }}>
                Billing, invoices and plan changes are managed from your account on the Badger Board website.
              </div>
            </div>
          )}
        </div>

        <CardBody style={{ padding: '18px 24px' }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1, color: T.faint, marginBottom: 13 }}>THIS MONTH</div>
          <div className="st-meters" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16 }}>
            {meters.map(m => <Meter key={m.label} {...m} loading={usage.loading} />)}
          </div>
        </CardBody>

        {!isNativeApp && plan !== 'scout' && !cancelPeriodEnd && entSource === 'paid' && (
          <div style={{ padding: '12px 24px 14px', borderTop: `1px solid ${T.divider}`, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <Note style={{ fontSize: 11.5, color: T.muted, flex: 1, minWidth: 200 }}>
              Cancelling keeps your access until the end of the period you have already paid for.
            </Note>
            <LinkBtn color={T.redHot} onClick={onCancelPlan}>Cancel plan</LinkBtn>
          </div>
        )}
      </Card>

      <Card
        title="Change plan"
        desc={
          'Plans differ by how many candidates you track and how many profiles you generate. ' +
          'The figures on these cards are each plan’s specification — your account’s ' +
          'current allowance is the one shown under THIS MONTH above.'
        }
        right={
          <div style={{ marginLeft: 'auto', flex: 'none', display: 'flex', gap: 4, background: T.chip, borderRadius: 99, padding: 4 }}>
            {[['Monthly', false], ['Yearly', true]].map(([label, val]) => {
              const on = yearly === val
              return (
                <button
                  key={label}
                  type="button"
                  onClick={() => setYearly(val)}
                  aria-pressed={on}
                  className="st-btn"
                  style={{
                    display: 'flex', alignItems: 'center', gap: 7, borderRadius: 99, border: 0,
                    padding: '6px 14px', fontSize: 12, fontFamily: 'inherit', lineHeight: 1.35,
                    fontWeight: on ? 600 : 500, color: on ? T.ink : T.ink4,
                    background: on ? '#fff' : 'transparent',
                    boxShadow: on ? '0 1px 2px rgba(0,0,0,.06)' : 'none',
                    cursor: 'pointer', whiteSpace: 'nowrap',
                  }}
                >
                  {label}
                  {val && (
                    <Pill c={on ? T.green : T.ink4} bg={on ? T.greenBg : '#E3E2DE'}>SAVE 17%</Pill>
                  )}
                </button>
              )
            })}
          </div>
        }
      >
        <CardBody style={{ padding: '18px 24px' }}>
          <div className="st-plans" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
            {cards.map(p => (
              <div key={p.key} style={{
                border: `1.5px solid ${p.isCurrent ? T.red : T.border}`,
                background: p.isCurrent ? '#FEFAFA' : '#fff',
                borderRadius: 14, padding: '16px 17px', display: 'flex', flexDirection: 'column',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 13.5, fontWeight: 700 }}>{p.name}</span>
                  {p.isCurrent && <Pill c={T.green} bg={T.greenBg}>CURRENT</Pill>}
                </div>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 5, marginTop: 9 }}>
                  <span style={{ fontSize: 22, fontWeight: 800, lineHeight: 1 }}>{p.price}</span>
                  {p.per && <span style={{ fontSize: 11.5, color: T.muted }}>{p.per}</span>}
                </div>
                <div style={{ fontSize: 11, color: T.muted, marginTop: 4 }}>{p.sub}</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, margin: '13px 0 15px' }}>
                  {p.rows.map(r => (
                    <div key={r.k} style={{ display: 'flex', gap: 9, alignItems: 'baseline' }}>
                      <span style={{ flex: 'none', width: 74, fontSize: 11.5, fontWeight: 700, color: T.ink3 }}>{r.k}</span>
                      <span style={{ fontSize: 11.5, color: T.ink4, lineHeight: 1.5 }}>{r.v}</span>
                    </div>
                  ))}
                </div>
                <div style={{ marginTop: 'auto' }}>
                  {p.isCurrent ? (
                    <span style={{
                      display: 'block', textAlign: 'center', background: T.line, border: `1px solid ${T.line}`,
                      color: T.faint, borderRadius: 99, padding: '8px 14px', fontSize: 12, fontWeight: 600,
                      lineHeight: 1.35,
                    }}>{p.btn}</span>
                  ) : (
                    <Btn
                      kind={p.btn === 'Upgrade' ? 'primary' : 'ghost'}
                      onClick={() => navigate('/plans')}
                      style={{ width: '100%' }}
                      disabled={isNativeApp}
                      title={isNativeApp ? 'Plan changes are made on the Badger Board website' : undefined}
                    >{p.btn}</Btn>
                  )}
                </div>
              </div>
            ))}
          </div>

          {isNativeApp && (
            <Note style={{ marginTop: 12, color: T.muted, fontSize: 11.5 }}>
              Plan changes are made from your account on the Badger Board website.
            </Note>
          )}

          {!isNativeApp && canBuyCredits && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
              background: T.warmBg, border: `1px solid ${T.warmBr}`, borderRadius: 12,
              padding: '13px 16px', marginTop: 14,
            }}>
              <div style={{ minWidth: 200, flex: 1 }}>
                <div style={{ fontSize: 12.5, fontWeight: 700 }}>Need more profiles without changing plan?</div>
                <Note style={{ fontSize: 11.5, marginTop: 2 }}>
                  Credit packs stack on top of your monthly allowance and roll over until you use them.
                </Note>
              </div>
              <Btn kind="primary" onClick={() => navigate('/plans')}>Buy a credit pack</Btn>
            </div>
          )}
        </CardBody>
      </Card>
    </>
  )
}
