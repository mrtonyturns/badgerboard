// netlify/functions/_plan-gate.js
// ─── Server-side plan-feature gate ───────────────────────────────────────────
// Prefixed with _ so Netlify does NOT deploy this as an endpoint.
//
// One rule for every endpoint, matching the client (useFeature / FeatureRoute):
// admins and beta testers pass, everyone else needs the feature in their plan
// — including the Nov 15 2026 plan-family lineup (tiers.js FAMILY_FEATURES).
//
//   const { planAllowsUser } = require('./_plan-gate')
//   if (!(await planAllowsUser(user, 'events'))) return 403

const { resolveEntitlement } = require('./_entitlements')
const { planAllows } = require('../../src/lib/tiers.js')

/** @returns {Promise<boolean>} */
async function planAllowsUser(user, feature) {
  if (!user) return false
  const ent = await resolveEntitlement(user)
  return planAllows(ent, feature)
}

const FEATURE_MESSAGES = {
  events:             'The Events finder is included with Candidate plans.',
  broadside:          'Broadside is included with paid Candidate plans.',
  sharing:            'Profile sharing is included with Action plans.',
  autofill:           'AI autofill is included with Action plans.',
  discoverCandidates: 'AI candidate discovery is included with Action plans.',
  offices:            'Offices and district maps are included with Action plans.',
}

module.exports = { planAllowsUser, FEATURE_MESSAGES }
