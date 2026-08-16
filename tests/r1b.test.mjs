#!/usr/bin/env node
// Badger Board — Round 1B UI audit fixes (source-level assertions).
//   B4  /plans is not horizontally scrollable on a phone: the page root has its
//       own gutters (it renders outside <Layout>), the four-option billing
//       switcher wraps, and both w-full tables carry a min-w so their
//       overflow-x-auto wrappers actually scroll instead of squashing.
//   B7  All THREE Prospecting popovers (score, agency, contact) use the
//       portalled `anchorRef` branch — the un-portalled branch clipped inside
//       `.pp-scroll` and the fixed click-catcher ate the clicks.
//   B10 Candidates has TWO empty states: first-run onboarding vs. "nothing
//       matched the current search/filters" (with a clear affordance).
//   B11 TaskBoard passes the `loading` prop LoadingBar needs; without it the
//       bar renders at opacity 0 and the Todo page is blank white.
//   B12 Dead-click buttons are disabled with a visible reason instead of
//       silently returning (VoterLists "Add to List", Recruit "Export CSV").
// Zero-config: node tests/r1b.test.mjs

import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const src  = (p) => readFileSync(join(ROOT, p), 'utf8')

let pass = 0, fail = 0
const t = (name, cond) => { cond ? pass++ : fail++; console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${name}`) }

// Slice a component's source out of a file: from `function Name(` up to the
// next top-level `function ` / `const NAME =` declaration.
const componentBody = (source, name) => {
  const start = source.indexOf(`function ${name}(`)
  if (start === -1) return ''
  const rest = source.slice(start + 1)
  const nextIdx = rest.search(/\n(?:function |const [A-Z]|\/\/ ──)/)
  return nextIdx === -1 ? rest : rest.slice(0, nextIdx)
}

// ─── B4: /plans has no page-level horizontal overflow on a phone ──────────────
console.log('B4 — Pricing.jsx mobile overflow')
const pricing = src('src/pages/Pricing.jsx')

const rootDiv = /<div className="([^"]*max-w-5xl[^"]*)">/.exec(pricing)?.[1] || ''
t('page root still uses max-w-5xl mx-auto pb-24', /max-w-5xl/.test(rootDiv) && /mx-auto/.test(rootDiv) && /pb-24/.test(rootDiv))
t('page root gained responsive horizontal padding (renders outside Layout)',
  /\bpx-4\b/.test(rootDiv) && /\bsm:px-6\b/.test(rootDiv))

// The billing switcher is the container that maps over BILLING_PERIODS.
const billingIdx = pricing.indexOf('Object.values(BILLING_PERIODS).map')
const billingContainer = /<div className="([^"]*)"/.exec(
  pricing.slice(pricing.lastIndexOf('<div className=', billingIdx), billingIdx),
)?.[1] || ''
t('billing-period switcher is a flex row', /\bflex\b/.test(billingContainer))
t('billing-period switcher wraps instead of overflowing (flex-wrap)', /\bflex-wrap\b/.test(billingContainer))
t('billing-period switcher is width-constrained on small screens',
  /\bw-full\b/.test(billingContainer) && /\bsm:w-auto\b/.test(billingContainer))

// Every <table> on the page must declare a min-w so its overflow-x-auto wrapper
// scrolls; a bare w-full table just crushes its own columns.
const tables = pricing.match(/<table className="[^"]*"/g) || []
t('Pricing.jsx still has exactly two tables', tables.length === 2)
t('every Pricing table has a min-w', tables.length > 0 && tables.every(x => /min-w-\[\d+px\]/.test(x)))
t('feature matrix min-w is ~640px', tables.some(x => /min-w-\[640px\]/.test(x)))
t('bracket price table min-w is ~520px', tables.some(x => /min-w-\[520px\]/.test(x)))
t('both tables still sit inside overflow-x-auto wrappers',
  (pricing.match(/overflow-x-auto/g) || []).length >= 2)

// ─── B7: all three Prospecting popovers are portalled ────────────────────────
console.log('B7 — Prospecting popovers use the anchorRef portal')
const prospecting = src('src/pages/Prospecting.jsx')

// NB: line-based, not `<Popover [^>]*>` — the arrow in onClose={() => …}
// contains a `>` and would truncate the match before anchorRef.
const popovers = prospecting.match(/^\s*<Popover .*$/gm) || []
t('Prospecting renders four popovers (score, agency, phones, emails)', popovers.length === 4)
t('EVERY <Popover> passes anchorRef — none use the clipped in-place branch',
  popovers.length > 0 && popovers.every(p => /anchorRef=\{/.test(p)))

for (const [cell, label] of [['ScoreCell', 'Why this score'], ['AgencyCell', 'Agency signals'], ['ContactCell', 'phone/email']]) {
  const body = componentBody(prospecting, cell)
  t(`${cell} declares a trigger ref`, /useRef\(null\)/.test(body))
  t(`${cell} attaches the ref to its trigger button`, /<button\s*\n?\s*ref=\{\w*[bB]tnRef\}/.test(body) || /ref=\{\w*[bB]tnRef\}/.test(body))
  t(`${cell} passes anchorRef to <Popover> (${label})`, /^\s*<Popover .*anchorRef=\{/m.test(body))
}
t('the Popover portal branch is still the anchorRef branch',
  /if \(anchorRef\) \{[\s\S]{0,400}createPortal\(/.test(prospecting))

// ─── B10: Candidates splits first-run vs. no-match empty states ──────────────
console.log('B10 — Candidates empty-state split')
const candidates = src('src/pages/Candidates.jsx')

t('unfiltered server total is still tracked', /totalCandidateCount/.test(candidates))
t('a filter-active predicate exists', /const hasActiveFilters\s*=/.test(candidates))
t('hasActiveFilters covers search + party + status + office',
  /const hasActiveFilters\s*=\s*!!\(\s*search \|\| partyFilter \|\| statusFilter \|\| officeFilter\s*\)/.test(candidates))
t('a clearFilters affordance exists', /const clearFilters\s*=\s*\(\)\s*=>/.test(candidates))
t('clearFilters resets all four filters',
  /clearFilters[\s\S]{0,220}setSearch\(''\)[\s\S]{0,220}setPartyFilter\(''\)[\s\S]{0,220}setStatusFilter\(''\)[\s\S]{0,220}setOfficeFilter\(''\)/.test(candidates))

t('first-run onboarding still exists', /No candidates yet/.test(candidates) && /Add First Candidate/.test(candidates))
t('a distinct no-match state exists', /No candidates match your search/.test(candidates))
t('the no-match state offers a clear affordance wired to clearFilters',
  /onClick=\{clearFilters\}/.test(candidates))

// The onboarding branch must be GATED on the unfiltered total, not on the
// filtered `candidates` array alone.
t('onboarding is gated on totalCandidateCount === 0 && !hasActiveFilters',
  /totalCandidateCount === 0 && !hasActiveFilters/.test(candidates))
const emptyBlock = candidates.slice(
  candidates.indexOf('candidates.length === 0 ?'),
  candidates.indexOf('No candidates match your search'),
)
t('"Add First Candidate" sits inside the gated branch, before the no-match copy',
  /Add First Candidate/.test(emptyBlock))

// ─── B11: LoadingBar needs its `loading` prop ────────────────────────────────
console.log('B11 — TaskBoard LoadingBar')
const loadingBar = src('src/components/LoadingBar.jsx')
const taskBoard  = src('src/components/TaskBoard.jsx')

t('LoadingBar is opacity/visibility-driven by a `loading` prop',
  /function LoadingBar\(\{ loading \}\)/.test(loadingBar) && /opacity: loading \? 1 : 0/.test(loadingBar))
t('TaskBoard passes the loading prop', /<LoadingBar loading \/>/.test(taskBoard))
t('no bare <LoadingBar /> left in TaskBoard', !/<LoadingBar\s*\/>/.test(taskBoard))
t('CandidateDetail (the reference usage) also passes it', /<LoadingBar loading \/>/.test(src('src/pages/CandidateDetail.jsx')))

// ─── B12: dead-click buttons ─────────────────────────────────────────────────
console.log('B12a — VoterLists "Add to List"')
const voterLists = src('src/pages/VoterLists.jsx')

t('a single reason string drives the disabled state', /const addToListBlockReason\s*=/.test(voterLists))
t('reason covers the new-list-name case', /addToListBlockReason[\s\S]{0,400}newListName\.trim\(\)/.test(voterLists))
t('reason covers the pick-an-existing-list case', /addToListBlockReason[\s\S]{0,500}addToExistingId/.test(voterLists))
t('reason covers the "no saved lists at all" case', /addToListBlockReason[\s\S]{0,500}savedLists\.length === 0/.test(voterLists))

const addToListBtn = /<button\s+onClick=\{handleAddToListFromModal\}[\s\S]{0,300}?<\/button>/.exec(voterLists)?.[0] || ''
t('the Add to List button is disabled when the required choice is missing',
  /disabled=\{!!addToListBlockReason\}/.test(addToListBtn))
t('an inline hint renders the same reason next to the button',
  /\{addToListBlockReason && \([\s\S]{0,220}\{addToListBlockReason\}/.test(voterLists))
t('the handler still guards on the server side (defence in depth)',
  /if \(!newListName\.trim\(\)\) return/.test(voterLists) && /if \(!addToExistingId\) return/.test(voterLists))

console.log('B12b — Recruit "Export CSV"')
const recruit = src('src/pages/Recruit.jsx')

const exportBtn = /<Btn onClick=\{exportCsv\}[^>]*>/.exec(recruit)?.[0] || ''
t('Export CSV button found', exportBtn.length > 0)
t('Export CSV is disabled on an empty view', /disabled=\{view\.length === 0\}/.test(exportBtn))
t('Export CSV carries NO title attribute (never shows on a disabled control)',
  !/title=/.test(exportBtn))
t('a visible caption explains the disabled state',
  /view\.length === 0 && \([\s\S]{0,300}Nothing to export/.test(recruit))
t('exportCsv still bails defensively on an empty view', /const exportCsv = \(\) => \{\s*\n\s*if \(!view\.length\) return/.test(recruit))
t('Btn supports a real disabled state (opacity + not-allowed)',
  /cursor: disabled \? 'not-allowed'/.test(src('src/pages/profiler/shared.jsx')) &&
  /opacity: disabled \? 0\.55 : 1/.test(src('src/pages/profiler/shared.jsx')))

// ─── Result ───────────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
