// netlify/functions/_entitlements.js
// ─── Server-side entitlement resolver (mirrors src/lib/tiers.js) ─────────────
// Prefixed with _ so Netlify does NOT treat this as a deployable function.
//
// Resolves a user's EFFECTIVE plan from Supabase app_metadata, honoring the
// v1.18 access layers in priority order:
//
//   admin  >  beta mode  >  free trial  >  paid plan  >  scout
//
// • Beta mode:  app_metadata.beta_mode === true AND the global switch
//   (app_settings key 'beta_mode_enabled') is not 'off'. Grants the top plan
//   (a_campaign, 'ent' bracket → every feature, unlimited slots).
// • Free trial: app_metadata.trial_plan + trial_ends_at (ISO). Active while
//   trial_ends_at is in the future; overlays the paid plan when it outranks it.
//   The daily trial-expiry cron clears expired fields, but this resolver ALSO
//   treats past dates as inactive, so access ends on time regardless.
//
// Import (CJS):  const { resolveEntitlement, getGlobalBetaEnabled } = require('./_entitlements')
// Import (ESM):  import { resolveEntitlement } from './_entitlements.js'

const { ADMIN_EMAILS } = require('./_config')

const CANDIDATE_PLAN_ORDER = ['scout', 'c_monitor', 'c_active', 'c_campaign']
const ACTION_PLAN_ORDER    = ['a_monitor', 'a_active', 'a_campaign']
const LEGACY_ALIASES       = { monitor: 'c_monitor', campaign: 'a_campaign', agency: 'a_campaign' }
const PLAN_ORDER           = [...CANDIDATE_PLAN_ORDER, ...ACTION_PLAN_ORDER]
const VALID_BRACKETS       = ['b1', 'b2_5', 'b6', 'b11', 'b26', 'b51', 'ent']

const BETA_PLAN    = 'a_campaign'
const BETA_BRACKET = 'ent'

function normalizePlan(p) {
  if (!p) return 'scout'
  const norm = LEGACY_ALIASES[p] || p
  return PLAN_ORDER.includes(norm) ? norm : 'scout'
}

function planRank(p) {
  return PLAN_ORDER.indexOf(normalizePlan(p))
}

// ── Global beta switch ────────────────────────────────────────────────────────
// Stored in the app_settings table (key 'beta_mode_enabled', value 'on'/'off').
// Missing table or row → defaults to ON (per-user flags decide).
async function getGlobalBetaEnabled() {
  const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!SUPABASE_URL || !SERVICE_KEY) return true
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/app_settings?key=eq.beta_mode_enabled&select=value`,
      { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } }
    )
    if (!res.ok) return true
    const rows = await res.json()
    return rows?.[0]?.value !== 'off'
  } catch {
    return true
  }
}

// ── Trial helpers ─────────────────────────────────────────────────────────────
function getActiveTrial(appMeta) {
  const m = appMeta || {}
  if (!m.trial_plan || !m.trial_ends_at) return null
  const plan = normalizePlan(m.trial_plan)
  if (plan === 'scout') return null
  const endsAt = Date.parse(m.trial_ends_at)
  if (!Number.isFinite(endsAt) || endsAt <= Date.now()) return null
  return {
    plan,
    bracket: VALID_BRACKETS.includes(m.trial_bracket) ? m.trial_bracket : 'b1',
    endsAt,
  }
}

// ── Resolver ──────────────────────────────────────────────────────────────────
// user: Supabase auth user object ({ email, app_metadata }).
// opts.globalBeta: pass a pre-fetched boolean to skip the app_settings lookup.
// Returns { plan, bracket, source } where source ∈ admin|beta|trial|paid|free.
async function resolveEntitlement(user, opts = {}) {
  const meta  = user?.app_metadata || {}
  const email = user?.email?.toLowerCase()

  if (email && ADMIN_EMAILS.includes(email)) {
    return { plan: 'a_campaign', bracket: 'ent', source: 'admin' }
  }

  if (meta.beta_mode === true) {
    const globalBeta = opts.globalBeta !== undefined ? opts.globalBeta : await getGlobalBetaEnabled()
    if (globalBeta) return { plan: BETA_PLAN, bracket: BETA_BRACKET, source: 'beta' }
  }

  const paid   = normalizePlan(meta.plan)
  const trial  = getActiveTrial(meta)
  const paidBracket = VALID_BRACKETS.includes(meta.bracket) ? meta.bracket : 'b1'

  if (trial && planRank(trial.plan) > planRank(paid)) {
    return { plan: trial.plan, bracket: trial.bracket, source: 'trial', trialEndsAt: trial.endsAt }
  }
  if (paid !== 'scout') {
    return { plan: paid, bracket: paidBracket, source: 'paid' }
  }
  return { plan: 'scout', bracket: 'b1', source: 'free' }
}

module.exports = {
  resolveEntitlement,
  getActiveTrial,
  getGlobalBetaEnabled,
  normalizePlan,
  planRank,
  BETA_PLAN,
  BETA_BRACKET,
  PLAN_ORDER,
  VALID_BRACKETS,
}
