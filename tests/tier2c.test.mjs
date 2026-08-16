#!/usr/bin/env node
// Badger Board — Tier 2C audit fixes.
//   2. Credit-pack gating is an ENTITLEMENT, not a plan family: every paid plan
//      (Action tiers included) may buy a la carte profile credits, and the
//      Pricing page must render the pack grid on both tabs.
//   2b. The Recruit comparison row is DERIVED from the real gate
//      (features.recruit + RECRUIT_MONTHLY_LOOKUPS), so the table cannot drift.
//   3. The Profiler's generation watchers poll in LIST mode — they never pull
//      the multi-KB `content` body every 5s just to notice a new row.
//   1. The Prospecting ContactCell popover escapes the `.pp-scroll` clip.
// Zero-config: node tests/tier2c.test.mjs

import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const src  = (p) => readFileSync(join(ROOT, p), 'utf8')

let pass = 0, fail = 0
const t = (name, cond) => { cond ? pass++ : fail++; console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${name}`) }

const {
  canBuyCreditPacks, canBuyBulkCredits,
  getRecruitLookupLimit, RECRUIT_MONTHLY_LOOKUPS,
  hasFeature, normalizePlan,
  CANDIDATE_PLAN_ORDER, ACTION_PLAN_ORDER, PLAN_ORDER,
  SCOUT_CANDIDATE_LIMIT, getMonitoringSlotMax, canMonitorCandidates,
} = await import('../src/lib/tiers.js')

// ─── 2: credit-pack gating ────────────────────────────────────────────────────
console.log('2 — canBuyCreditPacks / canBuyBulkCredits')

t('scout cannot buy profile credits', canBuyCreditPacks('scout') === false)
t('every paid CANDIDATE plan can buy profile credits',
  CANDIDATE_PLAN_ORDER.filter(k => k !== 'scout').every(k => canBuyCreditPacks(k) === true))
t('every ACTION plan can buy profile credits — this is the bug the Pricing tab hid',
  ACTION_PLAN_ORDER.every(k => canBuyCreditPacks(k) === true))
t('helper agrees with the raw feature flag on every plan',
  PLAN_ORDER.every(k => canBuyCreditPacks(k) === hasFeature(k, 'creditPacks')))
t('legacy plan keys normalize before the lookup',
  canBuyCreditPacks('monitor') === true && canBuyCreditPacks('agency') === true)
t('unknown / empty plan keys fail closed to scout',
  canBuyCreditPacks('enterprise_gold') === false && canBuyCreditPacks(null) === false)

t('bulk credits stay Action-Campaign-only', canBuyBulkCredits('a_campaign') === true &&
  ['a_monitor', 'a_active', 'scout', 'c_monitor', 'c_active', 'c_campaign']
    .every(k => canBuyBulkCredits(k) === false))
t('bulk credits are strictly narrower than profile credits',
  PLAN_ORDER.every(k => !canBuyBulkCredits(k) || canBuyCreditPacks(k)))

// The page-level regression: the pack grid used to live inside the
// `tab === 'candidate'` branch only. It is now one hoisted node rendered twice.
console.log('2 — Pricing page renders the pack grid on BOTH plan tabs')
{
  const pricing = src('src/pages/Pricing.jsx')
  const renders = (pricing.match(/\{creditPacksSection\}/g) || []).length
  t('creditPacksSection is defined once', /const creditPacksSection = \(/.test(pricing))
  t('and rendered on both the Candidate and Action tabs', renders === 2)
  t('the gate is the entitlement helper, not the plan family',
    /canBuyCreditPacks = !user \|\| planCanBuyCreditPacks\(userPlan\)/.test(pricing))
}

// ─── 2b: Recruit row is derived from the real gate ───────────────────────────
console.log('2b — Recruit lookups feed the comparison row')

t('Action allowances match the gameplan numbers',
  getRecruitLookupLimit('a_monitor')  === 100 &&
  getRecruitLookupLimit('a_active')   === 300 &&
  getRecruitLookupLimit('a_campaign') === 1000)
t('no Candidate plan gets Recruit lookups',
  CANDIDATE_PLAN_ORDER.every(k => getRecruitLookupLimit(k) === 0))
t('a lookup allowance exists exactly where features.recruit is true',
  PLAN_ORDER.every(k => (getRecruitLookupLimit(k) > 0) === (hasFeature(k, 'recruit') === true)))
t('the allowance table and the feature flags cover the same plans',
  Object.keys(RECRUIT_MONTHLY_LOOKUPS).every(k => hasFeature(k, 'recruit') === true))

{
  const pricing = src('src/pages/Pricing.jsx')
  t('the pricing page has a Recruit row at all (it had none)',
    /Recruit from voter list/.test(pricing))
  t('its cells are derived, not transcribed',
    /const recruitCell = \(planKey\)/.test(pricing) &&
    /getRecruitLookupLimit\(planKey\)/.test(pricing) &&
    /recruitCell\('a_monitor'\)/.test(pricing) &&
    /recruitCell\('scout'\)/.test(pricing))
  t('the derived cell renders an allowance for Action and a dash for Candidate', (() => {
    const cell = (k) => {
      const n = getRecruitLookupLimit(k)
      return n ? `${n.toLocaleString()} lookups / mo` : false
    }
    return cell('a_campaign') === '1,000 lookups / mo' && cell('c_campaign') === false
  })())
}

// ─── Untouched-export regression guard (audit scope: additions only) ─────────
console.log('2 — pre-existing tiers.js exports are unchanged')

t('SCOUT_CANDIDATE_LIMIT is still 2', SCOUT_CANDIDATE_LIMIT === 2)
t('normalizePlan still collapses legacy keys',
  normalizePlan('monitor') === 'c_monitor' && normalizePlan('agency') === 'a_campaign' &&
  normalizePlan('nope') === 'scout')
t('monitoring slots still ladder 0 / 0 / 1 / 3 on the Candidate side', (() => {
  const u = (plan) => ({ app_metadata: { plan } })
  return getMonitoringSlotMax(u('scout')) === 0 && getMonitoringSlotMax(u('c_monitor')) === 0 &&
         getMonitoringSlotMax(u('c_active')) === 1 && getMonitoringSlotMax(u('c_campaign')) === 3
})())
t('canMonitorCandidates still tracks the slot count', (() => {
  const u = (plan, bracket) => ({ app_metadata: { plan, bracket } })
  return canMonitorCandidates(u('c_monitor')) === false &&
         canMonitorCandidates(u('c_active')) === true &&
         canMonitorCandidates(u('a_monitor', 'b1')) === true
})())

// ─── 3: Profiler generation watchers poll in list mode ───────────────────────
console.log('3 — Dossiers generation watchers poll list columns only')
{
  const dossiers = src('src/pages/Dossiers.jsx')
  const calls = dossiers.match(/getDossiers\([^)]*\)/g) || []
  const scoped = calls.filter(c => !/^getDossiers\(\)$/.test(c))
  t('there are candidate-scoped getDossiers calls to check', scoped.length >= 4)
  t('every candidate-scoped poll asks for list columns',
    scoped.every(c => /\{ list: true \}/.test(c)))
  t('the library load still reads full rows (the table renders d.content)',
    /getDossiers\(\),/.test(dossiers) && /const content = d\.content/.test(dossiers))

  const supa = src('src/lib/supabase.js')
  const cols = (supa.match(/const DOSSIER_LIST_COLUMNS = '([^']+)'/) || [])[1] || ''
  t('list columns exclude the report body', !/\bcontent\b/.test(cols))
  t('list columns still carry what the watchers compare on (id, generated_at)',
    /\bid\b/.test(cols) && /\bgenerated_at\b/.test(cols))
}

// ─── 1: ContactCell popover is not clipped by .pp-scroll ─────────────────────
console.log('1 — Prospecting ContactCell popover escapes the scroll container')
{
  const p = src('src/pages/Prospecting.jsx')
  t('createPortal is imported', /import \{ createPortal \} from 'react-dom'/.test(p))
  t('the popover portals to document.body when anchored',
    /createPortal\(/.test(p) && /document\.body/.test(p))
  t('placement is measured from the trigger rect', /getBoundingClientRect\(\)/.test(p))
  t('it flips above the trigger when there is more room up than down',
    /const flip\s+= below < \d+ && above > below/.test(p))
  t('it repositions on scroll in capture phase (the .pp-scroll container scrolls)',
    /addEventListener\('scroll', place, true\)/.test(p))
  t('both ContactCell panels are anchored',
    (p.match(/anchorRef=\{(phoneBtnRef|emailBtnRef)\}/g) || []).length === 2)
  t('the touch Call pill is still a plain tel: link, untouched',
    /IS_TOUCH_DEVICE && telHref\(bestPhone\.value\) \? \(/.test(p) &&
    /<a href=\{telHref\(bestPhone\.value\)\} aria-label=\{callAria\}/.test(p))
  t('desktop single-number Call is still copy-only (no tel: attempt)',
    /Desktop: PLAIN COPY ONLY/.test(p) &&
    /onClick=\{\(\) => copy\(bestPhone\.value\)\}/.test(p))
  t('no undefined T.ink1 token survives in the popover rows', !/T\.ink1/.test(p))
}

// ─── 4: profiler StatStrip collapses on mobile ───────────────────────────────
console.log('4 — profiler StatStrip mobile collapse')
{
  const shared = src('src/pages/profiler/shared.jsx')
  t('a 2-up collapse exists', /@media \(max-width: 900px\)[\s\S]*?\.pf-strip\s+\{ grid-template-columns: 1fr 1fr !important \}/.test(shared))
  t('a 1-up collapse exists below 560px',
    /@media \(max-width: 560px\)[\s\S]*?\.pf-strip \{ grid-template-columns: 1fr !important \}/.test(shared))
  t('the collapsed strip does not draw a hairline above the card edge',
    /\.pf-strip > div:last-child \{ border-bottom: none \}/.test(shared))
  t('cells cannot overflow their column', /minmax\(0,1fr\)/.test(shared))
  t('the rules ship with every consumer of the strip', (() => {
    // ProfilerStyles carries the media queries; both routes that render a
    // StatStrip must mount it, or the collapse silently does not exist.
    const dossiers = src('src/pages/Dossiers.jsx')
    const sharedDossier = src('src/pages/SharedDossier.jsx')
    return /ProfilerShell/.test(dossiers) && /<ProfilerStyles \/>/.test(sharedDossier)
  })())
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
