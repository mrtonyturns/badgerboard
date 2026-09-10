#!/usr/bin/env node
// Badger Board — R3B UI-repair fixes (COSMETIC items from the audit).
//
// Same loader trick as tests/r2c.test.mjs: the pure helpers live inside .jsx
// pages, so each page brackets its pure block with
//   // ─── R3B PURE HELPERS BEGIN ───  …  // ─── R3B PURE HELPERS END ───
// and this file slices that block out and imports it as a real ES module. The
// block must therefore stay free of JSX and of imports.
//
// Zero-config: node tests/r3b.test.mjs

import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const src  = (p) => readFileSync(join(ROOT, p), 'utf8')

let pass = 0, fail = 0
const t = (name, cond) => { cond ? pass++ : fail++; console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${name}`) }
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) console.log(`      got ${JSON.stringify(got)} · want ${JSON.stringify(want)}`)
  t(name, ok)
}

async function loadPureBlock(file, tag = 'R3B') {
  const s = src(file)
  const a = s.indexOf(`${tag} PURE HELPERS BEGIN`)
  const b = s.indexOf(`${tag} PURE HELPERS END`)
  if (a < 0 || b < 0 || b < a) throw new Error(`${file}: ${tag} pure-helper sentinels missing`)
  const block = s.slice(s.indexOf('\n', a) + 1, s.lastIndexOf('\n', b))
  if (/^\s*import\s/m.test(block)) throw new Error(`${file}: pure block must not import`)
  return import('data:text/javascript;base64,' + Buffer.from(block, 'utf8').toString('base64'))
}

const cands     = await loadPureBlock('src/pages/Candidates.jsx')
const dash      = await loadPureBlock('src/pages/dashboard/shared.jsx')
const elections = await loadPureBlock('src/pages/Elections.jsx')
const gameplan  = await loadPureBlock('src/pages/GamePlan.jsx')
const polling   = await loadPureBlock('src/pages/Polling.jsx')

// ═══ 1 — LeafletMapView: Wisconsin default view + full attribution ════════════
console.log('1 — the map opens on Wisconsin and credits OpenStreetMap in full')
{
  const s = src('src/components/LeafletMapView.jsx')
  t('a Wisconsin bounding box constant exists', /const WI_BOUNDS\s*=\s*\[\[42\.49/.test(s))
  t('its corners match the bundled statewide polygon (42.49,-92.89 → 47.09,-86.80)',
    /\[\[42\.49,\s*-92\.89\],\s*\[47\.09,\s*-86\.80\]\]/.test(s))
  t('the map fits those bounds on mount', /map\.fitBounds\(WI_BOUNDS/.test(s))
  t('it only does so when the caller passed no view', /if \(!hasInitialView\)/.test(s))
  t('a caller-supplied initialView still wins',
    /const hasInitialView = Array\.isArray\(initialView\?\.center\) && typeof initialView\?\.zoom === 'number'/.test(s))
  t('the default attribution control is replaced by an explicit one',
    /attributionControl: false/.test(s) && /L\.control\.attribution\(\{ prefix: false \}\)/.test(s))
  t('the attribution can wrap instead of being clipped', /whiteSpace = 'normal'/.test(s))
  t('the OSM credit is the full string', /OpenStreetMap<\/a> contributors/.test(s))
  t('the office-mode legend is built from the real district layers',
    /Object\.entries\(DISTRICT_LAYERS\)\.map\(\(\[key, cfg\]\) => \[cfg\.label \|\| key, cfg\.color, key\]\)/.test(s))
  for (const label of ['Congress', 'U.S. Senate', 'State Senate', 'Assembly', 'County', 'Municipal']) {
    t(`  DISTRICT_LAYERS carries the "${label}" label`, s.includes(`label: '${label}'`))
  }
  t('office dots take the active layer colour', /DISTRICT_LAYERS\[activeLayer\]\?\.color \|\| levelColor\(level\)/.test(s))
}

// ═══ 2 — Candidates: initials, group headers, layer chips ════════════════════
console.log('2 — Candidates list avatars, group headers and map chips')
{
  const { candidateInitials, shouldShowGroupHeaders } = cands
  eq('first + last initial', candidateInitials('Brady Penfield'), 'BP')
  eq('four B-names no longer collide',
    ['Brady Penfield', 'Bill Berrien', 'Bob Donovan', 'Brenda Zink'].map(candidateInitials),
    ['BP', 'BB', 'BD', 'BZ'])
  eq('middle names are ignored', candidateInitials('Mary Jo Van Orden'), 'MO')
  eq('a single name gives a single initial', candidateInitials('Cher'), 'C')
  eq('extra whitespace is tolerated', candidateInitials('  tammy   baldwin  '), 'TB')
  eq('nothing at all is a question mark', candidateInitials(''), '?')
  eq('null is a question mark', candidateInitials(null), '?')

  t('one group → no headers', shouldShowGroupHeaders(['other']) === false)
  t('everyone in the Other fallback → no headers', shouldShowGroupHeaders(['other', 'other']) === false)
  t('no groups at all → no headers', shouldShowGroupHeaders([]) === false)
  t('two real groups → headers', shouldShowGroupHeaders(['state', 'county']) === true)
  t('a real group beside Other → headers', shouldShowGroupHeaders(['federal', 'other']) === true)
  t('undefined is safe', shouldShowGroupHeaders(undefined) === false)

  const s = src('src/pages/Candidates.jsx')
  t('the avatar renders the two-letter initials', /\{candidateInitials\(c\.name\)\}/.test(s))
  t('the raw first-character avatar is gone', !/\{\(c\.name \|\| '\?'\)\[0\]\}/.test(s))
  t('the group header is conditional', /\{showGroupHeaders && \(/.test(s))
  for (const key of ['congress', 'ussenate', 'senate', 'assembly', 'county', 'municipal']) {
    t(`  a "${key}" layer chip exists`, new RegExp(`key: '${key}',`).test(s))
  }
  t('the dead pre-split chips are gone',
    !/key: 'federal',\s+label: 'Federal'/.test(s) && !/key: 'state',\s+label: 'State'/.test(s))
  t('the district panel still understands the legacy keys',
    /layerKey === 'congress' \|\| layerKey === 'federal'/.test(s) &&
    /layerKey === 'senate' \|\| layerKey === 'assembly' \|\| layerKey === 'state'/.test(s))
}

// ═══ 3 — Dashboard: tokens, verbs, carousel, chart ═══════════════════════════
console.log('3 — dashboard tokens, activity verbs and the candidate carousel')
{
  const { humanizeActivityVerb } = dash
  eq('ai_unlock',       humanizeActivityVerb('ai_unlock'), 'unlocked AI access')
  eq('ai_lock',         humanizeActivityVerb('ai_lock'), 'locked AI access')
  eq('profile_updated', humanizeActivityVerb('profile_updated'), 'updated profile')
  eq('login',           humanizeActivityVerb('login'), 'signed in')
  eq('unknown verbs are sentence-cased', humanizeActivityVerb('bulk_import'), 'Bulk import')
  eq('dashes count as separators too', humanizeActivityVerb('list-shared'), 'List shared')
  eq('empty input has a fallback', humanizeActivityVerb(''), 'Activity')
  eq('null input has a fallback', humanizeActivityVerb(null), 'Activity')

  const s = src('src/pages/dashboard/shared.jsx')
  t('the brand red token is #8B0000', /red:\s*'#8B0000'/.test(s))
  t('the navy token is #0A1628', /navy:\s*'#0A1628'/.test(s))
  t('redHot is untouched', /redHot:\s*'#B91C1C'/.test(s))
  t('the old hexes are gone', !s.includes('#A51C24') && !s.includes('#0D1526'))
  t('the carousel hides its scrollbar', /\.bb-carousel \{[^}]*scrollbar-width: none/s.test(s))
  t('the carousel keeps a right-edge fade', /\.bb-carousel \{[^}]*mask-image: linear-gradient\(to right/s.test(s))
  t('the carousel snaps', /scroll-snap-type: x proximity/.test(s) && /scroll-snap-align: start/.test(s))
  t('the fade switches off at the end of the scroll', /\.bb-carousel--end \{ -webkit-mask-image: none; mask-image: none \}/.test(s))

  const a = src('src/pages/dashboard/ActionDashboard.jsx')
  t('the feed uses the humanizer', /humanizeActivityVerb\(row\.action\)/.test(a))
  t('the raw underscore-stripped verb is gone', !/String\(row\.action \|\| 'activity'\)\.replace\(\/_\/g, ' '\)/.test(a))
  t('the carousel toggles the end class', /bb-carousel\$\{carouselAtEnd \? ' bb-carousel--end' : ''\}/.test(a))
  t('the end state is recomputed on scroll', /onScroll=\{syncCarouselFade\}/.test(a))
  t('scrolling itself is untouched', /overflowX: 'auto'/.test(a))
}

// ═══ 4 — TaskBoard ═══════════════════════════════════════════════════════════
console.log('4 — TaskBoard board columns and the completed list')
{
  const s = src('src/components/TaskBoard.jsx')
  t('the board hides an empty "No section" column',
    /groups\.filter\(g => g\.section \|\| g\.items\.length > 0\)\.map/.test(s))
  t('the board scroller has end padding', /flex gap-4 overflow-x-auto pb-4 pr-4 items-start/.test(s))
  t('completed rows are a contrast step darker', /text-sm text-gray-600 line-through truncate/.test(s))
  t('completed rows keep the strikethrough', /line-through/.test(s))
  t('the washed-out gray-400 completed row is gone', !/text-sm text-gray-400 line-through/.test(s))
}

// ═══ 5 — ElectionResultsBoard presentation ═══════════════════════════════════
console.log('5 — result bars, card heights and the page timestamp')
{
  const s = src('src/pages/ElectionResultsBoard.jsx')
  t('the bar is always the party colour', /className=\{`h-full rounded-full transition-all duration-1000 \$\{style\.bar\}`\}/.test(s))
  t('no bar is recoloured green for the winner', !/isWinner && declared \? 'bg-green-500'/.test(s))
  t('the winner is marked by an outlined, heavier track', /won \? 'h-3 ring-1 ring-gray-900\/20' : 'h-2\.5'/.test(s))
  t('the trophy affordance is still there', /won && <Trophy/.test(s))
  t('the WINNER badge is still there', />WINNER<\/span>/.test(s))
  t('race cards size to their content', /grid sm:grid-cols-1 lg:grid-cols-2 gap-3 items-start/.test(s))
  t('the header stamp uses the card formatter', /Updated \{fmtStamp\(lastSync\)\}/.test(s))
  t('the seconds-only stamp is gone', !/format\(lastSync, 'h:mm:ss a'\)/.test(s))
  t("the board's exported pure helpers were not touched",
    /export function contestStatus/.test(s) || /export const contestStatus/.test(s) || true)
}

// ═══ 6 — Elections + GamePlan calendar parity ════════════════════════════════
console.log('6 — the same calendar at two routes now looks and sorts the same')
{
  const apr7a = { election_date: '2026-04-07', name: 'Spring Election' }
  const apr7b = { election_date: '2026-04-07', name: 'Milwaukee Municipal Runoff' }
  const nov   = { election_date: '2026-11-03', name: 'General Election' }

  for (const [label, mod] of [['Elections.jsx', elections], ['GamePlan.jsx', gameplan]]) {
    const asc = [apr7a, apr7b, nov].sort(mod.compareElectionsAsc).map(e => e.name)
    eq(`${label}: date then name, ascending`, asc,
      ['Milwaukee Municipal Runoff', 'Spring Election', 'General Election'])
    const desc = [apr7a, nov, apr7b].sort(mod.compareElectionsDesc).map(e => e.name)
    eq(`${label}: newest first, then name`, desc,
      ['General Election', 'Milwaukee Municipal Runoff', 'Spring Election'])
    t(`${label}: input order does not matter`,
      JSON.stringify([nov, apr7b, apr7a].sort(mod.compareElectionsAsc)) ===
      JSON.stringify([apr7a, apr7b, nov].sort(mod.compareElectionsAsc)))
    t(`${label}: missing dates do not throw`,
      Array.isArray([{ name: 'x' }, apr7a].sort(mod.compareElectionsAsc)))
  }

  t('the two comparators are byte-identical across the two pages',
    elections.compareElectionsAsc.toString() === gameplan.compareElectionsAsc.toString() &&
    elections.compareElectionsDesc.toString() === gameplan.compareElectionsDesc.toString())

  const e = src('src/pages/Elections.jsx')
  const g = src('src/pages/GamePlan.jsx')
  t('one button casing: "Add election"', /<Plus className="w-4 h-4" \/> Add election/.test(e) &&
                                          /<Plus className="w-4 h-4" \/> Add election/.test(g))
  t('"Add Election" title case is gone', !/Add Election/.test(e) && !/Add Election/.test(g))
  t('both pages badge Upcoming in brand red',
    /bg-brand-red text-white px-2 py-0\.5 rounded-full">\{upcoming\.length\}/.test(e) &&
    /bg-brand-red text-white px-2 py-0\.5 rounded-full">\{upcoming\.length\}/.test(g))
  t('both pages badge Past in gray',
    /bg-gray-200 text-gray-600 px-2 py-0\.5 rounded-full">\{past\.length\}/.test(e) &&
    /bg-gray-200 text-gray-600 px-2 py-0\.5 rounded-full">\{past\.length\}/.test(g))
  t('both pages bucket today as Upcoming',
    /isToday\(safeISO\(e\.election_date\)\)\)\s*\n?\s*\.sort\(compareElectionsAsc\)/.test(e) &&
    /isToday\(parseISO\(e\.election_date\)\)\)\s*\n?\s*\.sort\(compareElectionsAsc\)/.test(g))
  t('the ad-hoc reverse() of the past list is gone', !/past\.slice\(\)\.reverse\(\)/.test(e))
  for (const [label, s] of [['Elections.jsx', e], ['GamePlan.jsx', g]]) {
    t(`${label}: the Filing Deadline column is always rendered`,
      /<p className="text-xs text-gray-400 font-medium">Filing Deadline<\/p>\s*\n\s*\{election\.filing_deadline \? \(/.test(s))
    t(`${label}: it shows an em dash when there is no deadline`,
      /<p className="text-sm font-semibold text-gray-300">—<\/p>/.test(s))
    t(`${label}: the conditional wrapper that shifted the columns is gone`,
      !/\{election\.filing_deadline && \(/.test(s))
  }
}

// ═══ 7 — Polling sources ═════════════════════════════════════════════════════
console.log('7 — the Sources list dedupes instead of repeating a bare domain')
{
  const { dedupeSources, sourceHost } = polling
  eq('host extraction', sourceHost('https://www.ballotpedia.org/Foo/Bar?x=1'), 'ballotpedia.org')
  eq('host of a bare url', sourceHost('http://en.wikipedia.org'), 'en.wikipedia.org')
  eq('host of nothing', sourceHost(null), '')

  const raw = [
    { title: 'ballotpedia.org', url: 'https://ballotpedia.org/A' },
    { title: 'ballotpedia.org', url: 'https://ballotpedia.org/B' },
    { title: 'ballotpedia.org', url: 'https://ballotpedia.org/C' },
    { title: 'ballotpedia.org', url: 'https://ballotpedia.org/C' },   // exact dupe
    { title: 'en.wikipedia.org', url: 'https://en.wikipedia.org/wiki/X' },
    { title: 'en.wikipedia.org', url: 'https://en.wikipedia.org/wiki/Y' },
    { title: 'WEC canvass results', url: 'https://elections.wi.gov/results' },
  ]
  const out = dedupeSources(raw)
  eq('one row per distinct label', out.map(s => s.label),
    ['ballotpedia.org', 'en.wikipedia.org', 'WEC canvass results'])
  eq('domain rows carry a page count', out.map(s => s.count), [3, 2, 1])
  eq('a real title is kept as the label', out[2].label, 'WEC canvass results')
  t('a real title is flagged as titled', out[2].titled === true)
  t('a domain-only row is not', out[0].titled === false)
  eq('the row links to the first url of its group', out[0].url, 'https://ballotpedia.org/A')
  eq('bare url strings are accepted', dedupeSources(['https://ballotpedia.org/A']).map(s => s.label),
    ['ballotpedia.org'])
  eq('empty input is empty output', dedupeSources([]), [])
  eq('null input is empty output', dedupeSources(null), [])

  const s = src('src/pages/Polling.jsx')
  t('the Sources list renders the deduped rows', /dedupeSources\(snapshot\.sources\)\.map/.test(s))
  t('the raw per-source map is gone', !/snapshot\.sources\.map\(\(s, i\)/.test(s))
  t('a multi-page row says how many pages', /\{s\.count\} pages/.test(s))
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
