#!/usr/bin/env node
// Badger Board — Tier 3B audit fixes (hardening lane).
//   2. isUpgrade() no longer ranks plans ACROSS families. Candidate and Action
//      are different products on different pricing axes; a cross-family move is
//      a plan CHANGE, never an upgrade or a downgrade.
//   6. The credit-pack catalog is asserted in-repo three ways:
//      tiers.js ↔ stripe-setup.mjs registry ↔ create-checkout-session.js.
//   1. AuthContext applies a LATE getSession() result instead of dropping it.
//   4. No wildcard CORS left in _campaign-connect.js / classify-csv-prospects.js.
//   5. classify-csv-prospects attributes AI spend to the authenticated caller.
//   3. Dashboard monitoring slot "used" counts come from the server, not the
//      client-side candidates array.
// Zero-config: node tests/tier3b.test.mjs

import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const src  = (p) => readFileSync(join(ROOT, p), 'utf8')

let pass = 0, fail = 0
const t = (name, cond) => { cond ? pass++ : fail++; console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${name}`) }

const {
  isUpgrade, planChangeKind, normalizePlan,
  CANDIDATE_PLAN_ORDER, ACTION_PLAN_ORDER, PLAN_ORDER, PLAN_CONFIG,
  CREDIT_PACKS, BULK_CREDIT_PACKS,
} = await import('../src/lib/tiers.js')

// ─── 2: isUpgrade — the full matrix ───────────────────────────────────────────
console.log('2 — isUpgrade(): same-family ranks, cross-family never upgrades')

// 2a. Same-family, both ladders. Every strictly-higher pair is an upgrade and
//     every strictly-lower pair is not — this is the behaviour that must be
//     byte-identical to the pre-fix version.
const sameFamilyLadder = (order, label) => {
  let ok = true
  for (let i = 0; i < order.length; i++) {
    for (let j = 0; j < order.length; j++) {
      const expected = j > i
      if (isUpgrade(order[i], order[j]) !== expected) {
        ok = false
        console.log(`      ${label}: isUpgrade('${order[i]}','${order[j]}') should be ${expected}`)
      }
    }
  }
  return ok
}
t('candidate ladder ranks correctly end to end', sameFamilyLadder(CANDIDATE_PLAN_ORDER, 'candidate'))
t('action ladder ranks correctly end to end',    sameFamilyLadder(ACTION_PLAN_ORDER, 'action'))

// 2b. Cross-family: NEVER an upgrade in either direction. Before the fix, every
//     c_* → a_* pair returned true off the concatenated PLAN_ORDER — a_monitor
//     ($89) outranked c_campaign ($189), which is the nonsense being fixed.
const PAID_CANDIDATE = CANDIDATE_PLAN_ORDER.filter(k => k !== 'scout')
t('no paid candidate → action pair is an upgrade',
  PAID_CANDIDATE.every(c => ACTION_PLAN_ORDER.every(a => isUpgrade(c, a) === false)))
t('no action → paid candidate pair is an upgrade',
  ACTION_PLAN_ORDER.every(a => PAID_CANDIDATE.every(c => isUpgrade(a, c) === false)))
t('the specific nonsense case is dead: c_campaign → a_monitor is not an upgrade',
  isUpgrade('c_campaign', 'a_monitor') === false)

// 2c. scout is the shared free floor of BOTH ladders.
t('scout → every paid plan (either family) is an upgrade',
  PLAN_ORDER.filter(k => k !== 'scout').every(k => isUpgrade('scout', k) === true))
t('nothing is an upgrade TO scout',
  PLAN_ORDER.every(k => isUpgrade(k, 'scout') === false))
t('a plan is never an upgrade to itself',
  PLAN_ORDER.every(k => isUpgrade(k, k) === false))

// 2d. Legacy aliases normalize before ranking (existing tiers.test.mjs cases).
t('isUpgrade("monitor","c_campaign") is true (legacy alias, same family)',
  isUpgrade('monitor', 'c_campaign') === true)
t('isUpgrade("campaign","c_monitor") is false (a_campaign → candidate = cross-family)',
  isUpgrade('campaign', 'c_monitor') === false)
t('legacy alias agrees with its canonical key everywhere',
  PLAN_ORDER.every(k =>
    isUpgrade('monitor', k) === isUpgrade('c_monitor', k) &&
    isUpgrade('agency', k)  === isUpgrade('a_campaign', k)))
t('an unknown plan key normalizes to scout, not to a -1 rank',
  isUpgrade('no_such_plan', 'c_monitor') === true && normalizePlan('no_such_plan') === 'scout')

// 2e. planChangeKind gives the UI a label for the cross-family case, so
//     "not an upgrade" never has to render as "downgrade".
console.log('2e — planChangeKind() labels')
t('cross-family reads as "change", both directions',
  planChangeKind('c_campaign', 'a_monitor') === 'change' &&
  planChangeKind('a_campaign', 'c_monitor') === 'change')
t('same-family up/down still read as upgrade/downgrade',
  planChangeKind('c_monitor', 'c_campaign') === 'upgrade' &&
  planChangeKind('a_campaign', 'a_monitor') === 'downgrade')
t('identical plans read as "same"', planChangeKind('c_active', 'c_active') === 'same')
t('scout is an upgrade out of / a downgrade into, from either family',
  planChangeKind('scout', 'a_monitor') === 'upgrade' &&
  planChangeKind('a_monitor', 'scout') === 'downgrade')
t('every ordered pair gets a kind, and it agrees with isUpgrade',
  PLAN_ORDER.every(a => PLAN_ORDER.every(b => {
    const kind = planChangeKind(a, b)
    if (!['same', 'upgrade', 'downgrade', 'change'].includes(kind)) return false
    return (kind === 'upgrade') === isUpgrade(a, b)
  })))

// ─── 6: credit-pack registry parity ───────────────────────────────────────────
// The live Stripe price IDs cannot be verified from this repo (they are baked
// into create-checkout-session.js and overridable by Netlify env vars — see the
// comment blocks in both files). What CAN be pinned is the catalog: the SKUs
// and the dollar amounts, in all three places that state them.
console.log('6 — credit-pack SKU/amount parity: tiers.js ↔ stripe-setup.mjs ↔ create-checkout-session.js')

const setup = await import('../stripe-setup.mjs')
const checkoutSrc = src('netlify/functions/create-checkout-session.js')

t('stripe-setup.mjs is importable without a Stripe key (no top-level exit)',
  Array.isArray(setup.CREDIT_PACKS) && Array.isArray(setup.BULK_CREDIT_PACKS))

const asMap = (packs) => Object.fromEntries(packs.map(p => [p.key, p.price]))

t('profile credit packs: same SKUs in tiers.js and stripe-setup.mjs',
  JSON.stringify(CREDIT_PACKS.map(p => p.key)) ===
  JSON.stringify(setup.CREDIT_PACKS.map(p => p.key)))
t('profile credit packs: same dollar amounts',
  JSON.stringify(asMap(CREDIT_PACKS)) === JSON.stringify(asMap(setup.CREDIT_PACKS)))
t('profile credit packs: same credit quantities',
  CREDIT_PACKS.every((p, i) => p.qty === setup.CREDIT_PACKS[i].qty))

t('bulk credit packs: same SKUs in tiers.js and stripe-setup.mjs',
  JSON.stringify(BULK_CREDIT_PACKS.map(p => p.key)) ===
  JSON.stringify(setup.BULK_CREDIT_PACKS.map(p => p.key)))
t('bulk credit packs: same dollar amounts',
  JSON.stringify(asMap(BULK_CREDIT_PACKS)) === JSON.stringify(asMap(setup.BULK_CREDIT_PACKS)))
t('bulk credit packs: same credit quantities',
  BULK_CREDIT_PACKS.every((p, i) => p.qty === setup.BULK_CREDIT_PACKS[i].qty))

// perCredit is the number the Pricing page prints next to each pack; if it
// drifts from price/qty the user is quoted a per-credit rate Stripe never charges.
t('tiers.js perCredit is price ÷ qty for every pack (to the cent)',
  [...CREDIT_PACKS, ...BULK_CREDIT_PACKS].every(p =>
    Math.abs(p.perCredit - p.price / p.qty) < 0.005))

// The checkout function's allow-lists are what actually decide whether a
// purchase is accepted — they must name exactly the packs the catalog sells.
const listFromSource = (name) => {
  const m = checkoutSrc.match(new RegExp(`const\\s+${name}\\s*=\\s*\\[([^\\]]*)\\]`))
  return m ? m[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean) : null
}
const validCredit = listFromSource('VALID_CREDIT_PACKS')
const validBulk   = listFromSource('VALID_BULK_CREDIT_PACKS')

t('create-checkout-session VALID_CREDIT_PACKS was found', Array.isArray(validCredit))
t('create-checkout-session VALID_BULK_CREDIT_PACKS was found', Array.isArray(validBulk))
t('VALID_CREDIT_PACKS matches the catalog exactly',
  JSON.stringify(validCredit) === JSON.stringify(CREDIT_PACKS.map(p => p.key)))
t('VALID_BULK_CREDIT_PACKS matches the catalog exactly',
  JSON.stringify(validBulk) === JSON.stringify(BULK_CREDIT_PACKS.map(p => p.key)))

// Every pack must have a baked-in price ID under the env key the function
// derives, or checkout 500s on a pack the UI happily offers.
t('every profile pack has a STRIPE_PRICE_CREDITS_<PACK> entry in the baked-in map',
  CREDIT_PACKS.every(p => checkoutSrc.includes(`STRIPE_PRICE_CREDITS_${p.key.toUpperCase()}:`)))
t('every bulk pack has a STRIPE_PRICE_BULK_CREDITS_<PACK> entry in the baked-in map',
  BULK_CREDIT_PACKS.every(p => checkoutSrc.includes(`STRIPE_PRICE_BULK_CREDITS_${p.key.toUpperCase()}:`)))
t('packEnvKey() derives the same names create-checkout-session.js looks up',
  setup.packEnvKey('credits', 'c5') === 'STRIPE_PRICE_CREDITS_C5' &&
  setup.packEnvKey('bulk', 'bulk250') === 'STRIPE_PRICE_BULK_CREDITS_BULK250')
t('the source-of-truth location is documented where the IDs are baked in',
  /stripe-setup\.mjs/.test(checkoutSrc) && /tier3b\.test\.mjs/.test(checkoutSrc))

// ─── 1: AuthContext applies a late session ────────────────────────────────────
console.log('1 — AuthContext: a late-resolving session is applied, not dropped')

const authSrc = src('src/contexts/AuthContext.jsx')
t('there is a single applySession() writer during init',
  /const applySession = \(incoming\) =>/.test(authSrc))
t('the getSession() success arm no longer bails out on `settled`',
  !/getSession\(\)\.then\(async \(\{ data: \{ session \} \} \) => \{\s*if \(settled\) return/.test(authSrc) &&
  /getSession\(\)\.then\(async[^\n]*\n\s*if \(disposed\) return/.test(authSrc))
t('`settled` now guards only the loading gate (setLoading), not session state',
  /if \(settled\) return\s+\/\/ the 10s arm already opened the gate/.test(authSrc))
t('the 10s arm still opens the loading gate — public routes keep rendering',
  /}, 10000\)/.test(authSrc) && /setLoading\(false\)\s*\n\s*}, 10000\)/.test(authSrc))
t('the timeout only asserts signed-out when nothing has committed a session',
  /if \(latestExpiresAt\.current === 0\) applySession\(null\)/.test(authSrc))
t('applySession honours the expires_at watermark (no stale overwrite)',
  /if \(incoming && exp < latestExpiresAt\.current\) return/.test(authSrc))
t('effect cleanup marks the effect disposed so late arms stop touching state',
  /disposed = true/.test(authSrc))
t('App.jsx PUBLIC_PATHS gating is untouched',
  /if \(loading && !isPublicPath\(pathname\)\)/.test(src('src/App.jsx')))

// ─── 4: no wildcard CORS ──────────────────────────────────────────────────────
console.log('4 — per-request CORS replaces the wildcard headers')

const ccSrc     = src('netlify/functions/_campaign-connect.js')
const classSrc  = src('netlify/functions/classify-csv-prospects.js')

const noWildcardOrigin = (s) => !/'Access-Control-Allow-Origin':\s*'\*'/.test(s)
t('_campaign-connect.js has no wildcard Allow-Origin', noWildcardOrigin(ccSrc))
t('classify-csv-prospects.js has no wildcard Allow-Origin', noWildcardOrigin(classSrc))
t('_campaign-connect.js builds headers from _config.corsHeaders()',
  /require\('\.\/_config'\)/.test(ccSrc) && /corsHeaders/.test(ccSrc) &&
  /function cors\(event/.test(ccSrc))
t('_campaign-connect.js exports cors(), not a shared CORS constant',
  /\bcors,/.test(ccSrc) && !/\bCORS,/.test(ccSrc))
t('classify-csv-prospects.js builds headers per request inside the handler',
  /const HEADERS = corsHeaders\(event\.headers\?\.origin/.test(classSrc))
t('both campaign-connect entry points use the per-request helper',
  ['netlify/functions/campaign-connect.js', 'netlify/functions/campaign-connect-delegate.js']
    .every(f => {
      const s = src(f)
      return /const CORS = H\.cors\(event\)/.test(s) && !/H\.CORS/.test(s)
    }))
t('the pattern matches support-chat.js (the reference implementation)',
  /corsHeaders\(event\.headers\?\.origin \|\| event\.headers\?\.Origin\)/
    .test(src('netlify/functions/support-chat.js')))

// ─── 5: AI spend attribution ──────────────────────────────────────────────────
console.log('5 — classify-csv-prospects attributes AI usage to the caller')

t('classifyBatch takes a userId parameter', /async function classifyBatch\(prospects, userId\)/.test(classSrc))
t('logAiUsage no longer hardcodes userId: null', !/logAiUsage\(\{ userId: null/.test(classSrc))
t('logAiUsage receives the threaded userId', /logAiUsage\(\{ userId: userId \?\? null/.test(classSrc))
t('the handler passes the authenticated user.id into classifyBatch',
  /classifyBatch\(batch, user\.id\)/.test(classSrc))

// ─── 3: monitoring slot used-count is authoritative ───────────────────────────
console.log('3 — dashboard monitoring "used" comes from a server count')

for (const f of ['src/pages/dashboard/CandidateDashboard.jsx', 'src/pages/dashboard/ActionDashboard.jsx']) {
  const s = src(f)
  t(`${f.split('/').pop()} runs an exact head count of monitored candidates`,
    /\{ count: 'exact', head: true \}/.test(s) &&
    /\.contains\('section_timestamps', \{ monitoring: true \}\)/.test(s))
  t(`${f.split('/').pop()} scopes that count to the signed-in user`,
    /\.eq\('created_by', user\.id\)/.test(s))
  t(`${f.split('/').pop()} overrides monitoringSlots().used with the server count`,
    /used: monitoredCount/.test(s))
  t(`${f.split('/').pop()} keeps a defensive fallback while the count is pending`,
    /if \(monitoredCount == null\) return base/.test(s))
}
// The shared helper and the tier ladder are untouched — the fix is at the call
// sites, so getMonitoringSlotMax()/canMonitorCandidates() keep their contract.
t('getMonitoringSlotMax is still the single max ladder',
  /export function getMonitoringSlotMax/.test(src('src/lib/tiers.js')))

// ─── 7: Recruit only offers office types with seats behind them ───────────────
console.log('7 — Recruit office-type step is data-driven and never silently empty')

const recruitSrc = src('src/pages/Recruit.jsx')
const recruitLib = src('src/lib/recruit.js')
t('the menu is enumerated from the offices table, not hard-coded',
  /availableOfficeTypes\(offices\)/.test(recruitSrc))
t('availableOfficeTypes drops types with zero classified offices',
  /\.filter\(t => counts\.has\(t\.key\)\)/.test(recruitLib))
t('the loading state is distinguished from the genuinely-empty state',
  /officesLoaded/.test(recruitSrc) && /Loading the office list/.test(recruitSrc))
t('the empty state explains itself instead of rendering blank',
  /No offices on file for any Recruit-eligible type yet/.test(recruitSrc))

// ─── 8: office_type ambiguity is documented ───────────────────────────────────
console.log('8 — office_type\'s three meanings are documented at the write site')

t('Recruit.jsx names all three meanings where it writes office_type',
  /MEANS THREE DIFFERENT THINGS/.test(recruitSrc) &&
  /recruitment_searches\.office_type/.test(recruitSrc) &&
  /offices\.office_type/.test(recruitSrc) &&
  /election_contests\.office_type/.test(recruitSrc))
t('the documented offices.office_type values match admin-offices VALID_TYPES',
  /VALID_TYPES\s*=\s*\['executive', 'legislative', 'judicial', 'administrative'\]/
    .test(src('netlify/functions/admin-offices.js')))

// ─── Result ───────────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
