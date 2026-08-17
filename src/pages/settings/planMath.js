// src/pages/settings/planMath.js — the Plan pane's pure arithmetic and copy
// rules, in a JSX-free module so tests/r2a.test.mjs can import them under bare
// node. Every number still originates in src/lib/tiers.js.

import { getActiveCandidateLimit, getBracketConfig, getPlanConfig } from '../../lib/tiers.js'
import { plural } from '../../lib/text.js'

/**
 * Fill fraction (0…1) for a usage meter, or `null` when the allowance is
 * unlimited.
 *
 * UI audit round 2, item 3: the old Meter lit ALL 18 ticks whenever `cap` was
 * null — and cap is null for every unlimited allowance — so an admin/beta
 * account saw "Profiles generated 1", "Monitoring slots 3" and "Candidates
 * tracked 27" all painted as a full green gauge. `null` here means "there is no
 * gauge to draw"; the component renders the unlimited state instead of a bar
 * that reads as 100% of something.
 */
export function meterFraction(used, cap) {
  if (cap == null || cap === Infinity) return null
  const c = Number(cap)
  if (!Number.isFinite(c) || c <= 0) return 0
  const u = Number(used)
  if (!Number.isFinite(u) || u <= 0) return 0
  return Math.min(1, u / c)
}

/** How many of `ticks` a meter lights for `used`/`cap`. Unlimited → 0 (no bar). */
export function meterTicks(used, cap, ticks) {
  const f = meterFraction(used, cap)
  if (f == null) return 0
  return Math.round(f * ticks)
}

/**
 * The "Monitoring" row on a plan-comparison card.
 *
 * UI audit round 2, item 4: this row printed `${bracketCfg.label} active
 * candidates` for every Action card, so all three read "1 active candidates" —
 * the viewer's own bracket, not the card's plan, and ungrammatical with it.
 * Drive it from the plan being described:
 *   • Candidate plans cap monitoring themselves (scout/c_monitor 0, c_active 1,
 *     c_campaign 3) → activeCandidateLimit.
 *   • Action plans do not; the bracket does, which is what getMonitoringSlotMax
 *     reads for them. Say so, so three identical values look deliberate.
 */
export function monitoringRowValue(planKey, bracketKey) {
  const cfg = getPlanConfig(planKey)
  if (cfg?.planType === 'action') {
    const b = getBracketConfig(bracketKey)
    if (b?.max === Infinity) return 'Unlimited active candidates (Enterprise bracket)'
    return `${plural(b?.max ?? 1, 'active candidate')} · set by your bracket, not the plan`
  }
  const n = getActiveCandidateLimit(planKey)
  return n > 0 ? plural(n, 'active candidate') : 'Not included'
}

/**
 * ONE phrase for "your account's allowance is not capped", used by every
 * quota surface (dashboards, Settings hero + meters, Profiler). Plan-spec
 * numbers must never stand in for it — see planSpecLabel.
 */
export const UNLIMITED_ACCOUNT = 'Unlimited on your account'

/** "Campaign plan spec: 4/candidate/mo" — a plan number, labelled as one. */
export function planSpecLabel(planKey) {
  const cfg = getPlanConfig(planKey)
  if (!cfg) return ''
  const n = cfg.planType === 'action' ? cfg.profilesPerCandidate : cfg.profileLimit
  if (n == null) return ''
  return `${cfg.name} plan spec: ${n}/${cfg.planType === 'action' ? 'candidate/mo' : 'mo'}`
}
