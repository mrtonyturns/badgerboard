#!/usr/bin/env node
// Badger Board — R2B audit fixes (DEGRADED items on Prospecting, Recruit,
// VoterLists, Candidates, Compare, Pricing, Login, ResetPassword).
//
// Two kinds of assertion:
//   1. BEHAVIOUR — Prospecting's status derivation is a pure block bracketed by
//      // ─── R2B PURE HELPERS BEGIN ─── … END ───, sliced out of the .jsx and
//      imported as a real ES module (same trick as tests/r1c.test.mjs). The
//      block must stay free of JSX and imports or this file fails loudly.
//   2. SOURCE — the rest are structural fixes (a min-width, a debounce, an
//      aria-label) with no pure surface to call, so they are asserted against
//      the shipped source. Comments are stripped first: a fix that explains
//      itself must not pass its own test by quoting the thing it removed.
//
// Zero-config: node tests/r2b.test.mjs

import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = (p) => readFileSync(join(ROOT, p), 'utf8')
const shipped = (p) => src(p)
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')

let pass = 0, fail = 0
const t = (name, cond) => { cond ? pass++ : fail++; console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${name}`) }
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) console.log(`      got ${JSON.stringify(got)} · want ${JSON.stringify(want)}`)
  t(name, ok)
}

const BEGIN = 'R2B PURE HELPERS BEGIN'
const END   = 'R2B PURE HELPERS END'

async function loadPureBlock(file) {
  const s = src(file)
  const a = s.indexOf(BEGIN)
  const b = s.indexOf(END)
  if (a < 0 || b < 0 || b < a) throw new Error(`${file}: pure-helper sentinels missing`)
  const block = s.slice(s.indexOf('\n', a) + 1, s.lastIndexOf('\n', b))
  if (/^\s*import\s/m.test(block)) throw new Error(`${file}: pure block must not import`)
  if (/<\/?[A-Za-z]/.test(block.replace(/^\s*\/\/.*$/gm, ''))) throw new Error(`${file}: pure block must not contain JSX`)
  return import('data:text/javascript;base64,' + Buffer.from(block, 'utf8').toString('base64'))
}

const prospecting = await loadPureBlock('src/pages/Prospecting.jsx')
const { prospectStatus, isQueuedProspect, isEnrichedProspect, prospectCounts } = prospecting

// ═══ 1 — Prospecting: one status derivation for header, tabs and row badges ═══
console.log('1 — prospectStatus() / prospectCounts()')

// enriched_at is what the enrichment writer stamps when it saves data, so it is
// what "enriched" means — including a 'partial' run, which does save data.
eq('a pending prospect is queued',   prospectStatus({ enrichment_status: 'pending' }), 'queued')
eq('a running prospect is queued',   prospectStatus({ enrichment_status: 'running' }), 'queued')
eq('enriched_at ⇒ enriched',         prospectStatus({ enrichment_status: 'enriched', enriched_at: '2026-08-16T00:00:00Z' }), 'enriched')
eq("a 'partial' run saved data, so it is enriched, not queued",
  prospectStatus({ enrichment_status: 'partial', enriched_at: '2026-08-16T00:00:00Z' }), 'enriched')
eq('a failed run with no data is failed', prospectStatus({ enrichment_status: 'error' }), 'failed')
eq('a failed RE-run keeps the data it already had',
  prospectStatus({ enrichment_status: 'error', enriched_at: '2026-08-01T00:00:00Z' }), 'enriched')
eq('a missing row degrades to queued, never throws', prospectStatus(undefined), 'queued')

t('queued and enriched are exact complements', [
  { enrichment_status: 'pending' },
  { enrichment_status: 'error' },
  { enrichment_status: 'partial', enriched_at: 'x' },
  { enrichment_status: 'enriched', enriched_at: 'x' },
].every(p => isQueuedProspect(p) !== isEnrichedProspect(p)))

{
  // The live bug: ONE prospect, fully enriched. The header said "1 enriched ·
  // 0 queued" (enriched_at), the Enrich tab said 0 (status === 'enriched') and
  // the Discover row was badged "queued" (a prospect row merely existed).
  const one = [{ candidate_id: 'c1', enrichment_status: 'enriched', enriched_at: '2026-08-16T00:00:00Z' }]
  eq('the single enriched prospect counts once, as enriched',
    prospectCounts(one), { total: 1, enriched: 1, queued: 0, failed: 0 })
  eq('and its Discover badge now says enriched, not queued', prospectStatus(one[0]), 'enriched')
}

{
  // The other half of the old contradiction: a 'partial' row used to be in the
  // Enrich queue AND the Results table at the same time, so the tabs summed to
  // more than the number of prospects.
  const rows = [
    { enrichment_status: 'pending' },
    { enrichment_status: 'partial', enriched_at: 'x' },
    { enrichment_status: 'error' },
    { enrichment_status: 'enriched', enriched_at: 'x' },
  ]
  const c = prospectCounts(rows)
  eq('every prospect lands in exactly one bucket', c, { total: 4, enriched: 2, queued: 2, failed: 1 })
  t('enriched + queued === total (the tabs can no longer disagree)', c.enriched + c.queued === c.total)
}

eq('a non-array degrades to zeroes', prospectCounts(null), { total: 0, enriched: 0, queued: 0, failed: 0 })

{
  const s = shipped('src/pages/Prospecting.jsx')
  t('the header subtitle prints the shared counts, not its own filter',
    /counts\.enriched\} enriched · \{counts\.queued\} queued/.test(s))
  t('the tab counts print the shared counts too',
    /Enrich \(\$\{counts\.queued\}\)/.test(s) && /Results \(\$\{counts\.enriched\}\)/.test(s))
  t('the Discover badge derives from prospectStatus()', /prospectStatus\(prospectByCandidateId\.get\(c\.id\)\)/.test(s))
  t('no page-local status filters are left behind',
    !/p\.enrichment_status !== 'enriched'/.test(s) && !/prospects\.filter\(p => p\.enriched_at\)/.test(s))
}

// ═══ 2 — narrow-screen tables scroll instead of squashing ════════════════════
console.log('2 — table min-widths')
{
  const r = shipped('src/pages/Recruit.jsx')
  t('Recruit: the results table has a min width', /minWidth: 760/.test(r))
  t('Recruit: …inside the overflowX wrapper', /overflowX: 'auto'/.test(r))
  const v = shipped('src/pages/VoterLists.jsx')
  t('VoterLists: the voter table has a min width', /className="w-full min-w-\[820px\] text-xs"/.test(v))
  t('VoterLists: …inside the overflow-x-auto wrapper', /className="overflow-x-auto"/.test(v))
}

// ═══ 3 — VoterLists export dropdown dismisses ════════════════════════════════
console.log('3 — export menu dismissal')
{
  const v = shipped('src/pages/VoterLists.jsx')
  t('an outside mousedown closes it', /addEventListener\('mousedown', onDown\)/.test(v))
  t('…and the listener is torn down', /removeEventListener\('mousedown', onDown\)/.test(v))
  t('the ref wraps the trigger, so the trigger can still close it',
    /<div className="relative" ref=\{exportMenuRef\}>/.test(v))
  t('Escape closes it via useDialog with locked:false',
    /useDialog\(onClose, \{ locked: false \}\)/.test(v) && /<DismissOnEscape onClose=\{\(\) => setShowVANExport\(false\)\}/.test(v))
}

// ═══ 4 — dialogs: Escape + scroll-lock, and a modal grid that stacks ═════════
console.log('4 — useDialog on the modals')
{
  const v = shipped('src/pages/VoterLists.jsx')
  const c = shipped('src/pages/Candidates.jsx')
  for (const [name, s] of [['VoterLists', v], ['Candidates', c]]) {
    t(`${name}: imports the shared hook`, /import \{ useDialog \} from '\.\.\/lib\/useDialog'/.test(s))
    t(`${name}: the overlay component mounts it`, /function ModalOverlay\([\s\S]{0,200}useDialog\(onClose\)/.test(s))
    t(`${name}: no bare overlay divs are left`, !/<div className="fixed inset-0 bg-black\/\d0"/.test(s))
  }
  eq('VoterLists: all three modals use it', (v.match(/<ModalOverlay/g) || []).length, 3)
  eq('Candidates: all three modals use it', (c.match(/<ModalOverlay/g) || []).length, 3)
  t('VoterLists: the modal mode grid stacks on mobile', /grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4/.test(v))
  t('VoterLists: no hard 2-col grid remains in the modals', !/"grid grid-cols-2 gap-3 mb-4"/.test(v))
  t('the close buttons still exist', (v.match(/Cancel<\/button>/g) || []).length >= 3)
}

// ═══ 5 — VoterLists copy tells the truth about how lists are built ═══════════
console.log('5 — stale copy / duplicate upload controls')
{
  const v = shipped('src/pages/VoterLists.jsx')
  t('the phantom "click a voter on the map" instruction is gone',
    !/Click a voter on the map to save them to a list/.test(v))
  t('the empty saved-list state names the real paths (CSV upload, + List)',
    /No saved lists yet\. Upload a voter CSV/.test(v) && /\+ List/.test(v))
  eq('exactly two controls open the upload modal (header + empty state)',
    (v.match(/onClick=\{\(\) => setShowUploadModal\(true\)\}/g) || []).length, 2)
  t('the third one, in the sidebar card, is gone', !/Upload CSV →/.test(v))
}

// ═══ 6 — VoterLists a11y ════════════════════════════════════════════════════
console.log('6 — dropzone + colour pickers')
{
  const v = shipped('src/pages/VoterLists.jsx')
  t('the CSV dropzone is a button to the a11y tree', /role="button"[\s\S]{0,120}tabIndex=\{0\}[\s\S]{0,300}fileInputRef\.current\?\.click\(\)/.test(v))
  t('…reachable with Enter and Space', /e\.key === 'Enter' \|\| e\.key === ' '[\s\S]{0,120}fileInputRef\.current\?\.click\(\)/.test(v))
  t('…and it says what it does', /aria-label=\{csvFile \? `CSV file selected/.test(v))
  t('every swatch is named', /aria-label=\{`\$\{name\} list colour`\}/.test(v))
  eq('…in both pickers', (v.match(/aria-label=\{`\$\{name\} list colour`\}/g) || []).length, 2)
  eq('…and the selected one is announced', (v.match(/aria-pressed=\{newListColor === hex\}/g) || []).length, 2)
  t('the hexes are unchanged', /'#3B82F6'[\s\S]{0,400}'#374151'/.test(v))
}

// ═══ 7 — Recruit: no dead ends, keyboard-usable rows and sort headers ═══════
console.log('7 — Recruit empty state + keyboard affordances')
{
  const r = shipped('src/pages/Recruit.jsx')
  t('an empty list array gets an explanation, not an empty select',
    /officesLoaded && !lists\.length \?/.test(r) && /You don&apos;t have a voter list yet/.test(r))
  t('…with a link to where lists come from', /to="\/voter-lists"/.test(r) && /Upload a voter list first/.test(r))
  t('the sort headers are real buttons', /<th key=\{k\} scope="col"[\s\S]{0,400}<button type="button" onClick=\{\(\) => toggleSort\(k\)\}/.test(r))
  t('…and report the sort state', /aria-sort=\{sort\.key === k \? \(sort\.dir === 'asc' \? 'ascending' : 'descending'\) : 'none'\}/.test(r))
  t('the saved-search rows are operable by keyboard',
    /role="button" tabIndex=\{0\}[\s\S]{0,200}openSearch\(s\)/.test(r))
  t('…and say which one is open', /aria-pressed=\{s\.id === activeSearch\?\.id\}/.test(r))
}

// ═══ 8 — Candidates: one query per search, not one per keystroke ════════════
console.log('8 — search debounce')
{
  const c = shipped('src/pages/Candidates.jsx')
  t('a debounce interval is declared', /const SEARCH_DEBOUNCE_MS = 300/.test(c))
  t('the input still updates state on every keystroke', /value=\{search\} onChange=\{e => setSearch\(e\.target\.value\)\}/.test(c))
  t('a timer mirrors it into the query state', /setTimeout\(\(\) => setSearchQuery\(search\), SEARCH_DEBOUNCE_MS\)/.test(c))
  t('…and is cleared on the next keystroke', /return \(\) => clearTimeout\(id\)/.test(c))
  t('the fetch effect depends on the DEBOUNCED value only',
    /useEffect\(\(\) => \{ fetchData\(\) \}, \[searchQuery, partyFilter, statusFilter, officeFilter\]\)/.test(c))
  t('the server is asked for the debounced term', /search: searchQuery \|\| undefined/.test(c))
  t('no effect fires on the raw search term any more', !/\}, \[search, partyFilter/.test(c))
}

// ═══ 9 — Candidates: the slot-limit reason is visible ═══════════════════════
console.log('9 — disabled monitoring toggle explains itself')
{
  const c = shipped('src/pages/Candidates.jsx')
  t('the message is kept verbatim', /Slot limit reached \(\$\{maxSlots\}\/\$\{maxSlots\}\) — deactivate another candidate first/.test(c))
  t('it renders as a hover tooltip on the WRAPPER, not a title on the disabled button',
    /<div className="relative group">[\s\S]{0,200}\{toggle\}[\s\S]{0,300}hidden group-hover:block/.test(c))
  t('the dead title= on the blocked state is gone', /blocked \? undefined/.test(c))
  t('…and the blocked button still has an accessible name', /aria-label=\{[\s\S]{0,40}blocked \? slotMessage/.test(c))
}

// ═══ 10 — Compare: the sticky candidate headers can actually stick ══════════
console.log('10 — Compare sticky column headers')
{
  const cmp = shipped('src/pages/Compare.jsx')
  // The fact card is identified by the class that replaced its overflow clip;
  // everything the sticky header needs has to live inside the next ~1.5k chars.
  const at = cmp.indexOf('[&>*:last-child]:rounded-b-2xl')
  t('the fact card is present and no longer clips its own scrollport', at > 0)
  const card = cmp.slice(at, at + 1500)
  t('…so nothing re-introduces overflow-hidden on it', !/overflow-hidden/.test(card))
  t('the column headers are still sticky', /sticky top-0 z-10/.test(card))
  t('the rounded corners survive without the clip', /rounded-t-2xl/.test(card))
  // Layout's <main> is the scroll container and the app chrome sits above it,
  // not over it — so top-0 is the right offset. Guard that assumption.
  const layout = src('src/components/Layout.jsx')
  t("Layout's <main> is still the page scroll container", /<main className=\{`flex-1 relative \$\{fullBleed \? 'overflow-hidden' : 'overflow-y-auto'\}`\}>/.test(layout))
}

// ═══ 11 — Pricing: plan-neutral copy, operable bracket rows ═════════════════
console.log('11 — Pricing copy + bracket rows')
{
  const p = shipped('src/pages/Pricing.jsx')
  t('the 60-second Scout pitch is gone', !/Scout is free, takes 60 seconds/.test(p))
  t('the free tier is still offered, without the brand name',
    /Start on the free tier — no credit card required/.test(p))
  t('the lite-profile FAQ is retitled, not deleted', /What is a lite profile on the free tier\?/.test(p))
  t('…and its body matches the title', /The free tier gives you one profile per month/.test(p))
  t('the bracket rows are operable', /role="button"[\s\S]{0,120}aria-pressed=\{bracket === b\.key\}/.test(p))
  t('…with Enter and Space', /if \(e\.key === 'Enter' \|\| e\.key === ' '\) \{ e\.preventDefault\(\); setBracket\(b\.key\) \}/.test(p))
}

// ═══ 12 — Login / ResetPassword: every field has a name ═════════════════════
console.log('12 — auth form labels')
{
  const l = shipped('src/pages/Login.jsx')
  for (const id of ['signup-first-name', 'signup-last-name', 'signup-business', 'signup-phone', 'login-email', 'login-password', 'signup-confirm-password']) {
    t(`Login: ${id} is label-linked`,
      new RegExp(`htmlFor="${id}"`).test(l) && new RegExp(`id="${id}"`).test(l))
  }
  t('Login: the signup name grid stacks on mobile', /grid grid-cols-1 sm:grid-cols-2 gap-3/.test(l))
  t('Login: no hard 2-col name grid remains', !/"grid grid-cols-2 gap-3"/.test(l))
  eq('Login: both reveal buttons are labelled',
    (l.match(/aria-label=\{show(Pw|ConfirmPw) \? 'Hide/g) || []).length, 2)

  const r = shipped('src/pages/ResetPassword.jsx')
  for (const id of ['reset-new-password', 'reset-confirm-password']) {
    t(`ResetPassword: ${id} is label-linked`,
      new RegExp(`htmlFor="${id}"`).test(r) && new RegExp(`id="${id}"`).test(r))
  }
  eq('ResetPassword: both reveal buttons are labelled',
    (r.match(/aria-label=\{show(Pw|Confirm) \? 'Hide/g) || []).length, 2)
}

console.log(`\n${fail === 0 ? '✓ ALL PASS' : '✗ FAILURES'} — ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
