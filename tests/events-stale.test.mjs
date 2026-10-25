#!/usr/bin/env node
// Badger Board — /events staleness rules.
// Sep-21 sweep: stale cached search results were rendered as "upcoming".
// Oct-25: "upcoming"/"stale" are measured from Wisconsin (America/Chicago)
// today; isStaleCache mirrors the server's re-run rule exactly; stale caches
// PROMPT the user (no automatic searches); fresh results get no re-run button.
//
// Same loader trick as tests/r2c.test.mjs: the pure helpers live inside the
// .jsx page, bracketed by
//   // ─── R4 PURE HELPERS BEGIN ───  …  // ─── R4 PURE HELPERS END ───
// and this file slices that block out and imports it as a real ES module.
// The block must therefore stay free of JSX and of imports.
//
// Zero-config: node tests/events-stale.test.mjs

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

async function loadPureBlock(file, tag) {
  const s = src(file)
  const a = s.indexOf(`${tag} PURE HELPERS BEGIN`)
  const b = s.indexOf(`${tag} PURE HELPERS END`)
  if (a < 0 || b < 0 || b < a) throw new Error(`${file}: ${tag} pure-helper sentinels missing`)
  const block = s.slice(s.indexOf('\n', a) + 1, s.lastIndexOf('\n', b))
  if (/^\s*import\s/m.test(block)) throw new Error(`${file}: pure block must not import`)
  return import('data:text/javascript;base64,' + Buffer.from(block, 'utf8').toString('base64'))
}

const FILE = 'src/pages/Events.jsx'
const { filterUpcoming, isStaleCache, centralTodayIso, isoDay, eventEndDay, fmtMonDay, areaDescription, buildCityOptions } =
  await loadPureBlock(FILE, 'R4')
const s = src(FILE)

// ═══ 0 — centralTodayIso: Wisconsin's calendar day, not UTC's or the browser's ═══
console.log('0 — centralTodayIso')
{
  eq('midday UTC → same day in Chicago', centralTodayIso(new Date('2026-10-25T17:00:00Z')), '2026-10-25')
  eq('03:00 UTC is still the previous evening in Chicago (CDT, UTC-5)',
    centralTodayIso(new Date('2026-10-26T03:00:00Z')), '2026-10-25')
  eq('05:30 UTC in winter is 23:30 the previous day (CST, UTC-6)',
    centralTodayIso(new Date('2026-01-15T05:30:00Z')), '2026-01-14')
  eq('06:30 UTC in winter has rolled over in Chicago', centralTodayIso(new Date('2026-01-15T06:30:00Z')), '2026-01-15')
  t('the default argument is "now" and yields YYYY-MM-DD', /^\d{4}-\d{2}-\d{2}$/.test(centralTodayIso()))
  t('the source uses en-CA + America/Chicago', /Intl\.DateTimeFormat\('en-CA', \{\s*\n?\s*timeZone: 'America\/Chicago'/.test(s))
}

// ═══ 1 — filterUpcoming: from Central today; multi-day events stay until they end ═══
console.log('1 — filterUpcoming drops what has already ended and hides junk dates')
{
  const today = '2026-09-21'
  const events = [
    { name: 'Kenosha Book Festival', date_start: '2026-08-16' },                         // past
    { name: 'Kenosha County Fair',   date_start: '2026-09-17', date_end: '2026-09-21' }, // ends today — kept
    { name: 'State Fair',            date_start: '2026-09-18', date_end: '2026-09-25' }, // in progress — kept
    { name: 'October Fest',          date_start: '2026-10-15' },                         // future
    { name: 'Today Rally',           date_start: '2026-09-21T18:00:00' },                // today, with a time suffix
    { name: 'Undated Mixer' },                                                           // no date — hidden
    { name: 'Junk Date Social',      date_start: 'not-a-date' },                         // unparseable — hidden
    { name: 'Feb 30 Gala',           date_start: '2026-02-30' },                         // impossible day — hidden
  ]
  const names = filterUpcoming(events, today).map(e => e.name)
  eq('only events ending today or later survive, sorted by date_start',
    names, ['Kenosha County Fair', 'State Fair', 'Today Rally', 'October Fest'])
  t('a multi-day fair that started before today is kept until it ends', names.includes('Kenosha County Fair'))
  t('events with missing/unparseable dates are hidden (never "Invalid Date")',
    !names.includes('Undated Mixer') && !names.includes('Junk Date Social') && !names.includes('Feb 30 Gala'))
  eq('a Date argument is converted to the Central day',
    filterUpcoming([{ name: 'x', date_start: '2026-09-21' }], new Date('2026-09-22T03:00:00Z')).length, 1)
  eq('non-array input yields an empty list (never throws)', filterUpcoming(null, today), [])
  eq('empty input yields an empty list', filterUpcoming([], today), [])
  eq('isoDay keeps the first 10 chars of a real day', [isoDay('2026-10-01T00:00:00Z'), isoDay('2026-13-01'), isoDay(null)],
    ['2026-10-01', null, null])
  eq('eventEndDay prefers date_end', eventEndDay({ date_start: '2026-10-01', date_end: '2026-10-04' }), '2026-10-04')
}

// ═══ 2 — isStaleCache: identical to the server's re-run rule ══════════════════
console.log('2 — isStaleCache')
{
  const today = '2026-10-25'
  const now = Date.parse('2026-10-25T15:00:00Z')
  const daysAgo = (d) => new Date(now - d * 24 * 3600 * 1000).toISOString()
  const fut = { name: 'Future', date_start: '2026-11-02' }
  const past = { name: 'Past', date_start: '2026-08-02' }

  t('a missing row is stale', isStaleCache(null, today, now) === true)
  t('an empty events array is stale', isStaleCache({ events: [], fetched_at: daysAgo(1) }, today, now) === true)
  t('a non-array events value is stale', isStaleCache({ events: null, fetched_at: daysAgo(1) }, today, now) === true)
  t('all-past events are stale even if fetched yesterday',
    isStaleCache({ events: [past], fetched_at: daysAgo(1) }, today, now) === true)
  t('one upcoming event + recent fetch is fresh', isStaleCache({ events: [past, fut], fetched_at: daysAgo(1) }, today, now) === false)
  t('an event ending today counts as upcoming',
    isStaleCache({ events: [{ date_start: '2026-10-20', date_end: '2026-10-25' }], fetched_at: daysAgo(1) }, today, now) === false)
  t('a multi-day event that ended yesterday does not',
    isStaleCache({ events: [{ date_start: '2026-10-20', date_end: '2026-10-24' }], fetched_at: daysAgo(1) }, today, now) === true)
  t('unparseable dates never count as upcoming',
    isStaleCache({ events: [{ date_start: 'soon' }, { date_start: 'TBD', date_end: 'TBD' }], fetched_at: daysAgo(1) }, today, now) === true)
  t('6.9 days old with upcoming events is fresh', isStaleCache({ events: [fut], fetched_at: daysAgo(6.9) }, today, now) === false)
  t('7.1 days old is stale even with upcoming events', isStaleCache({ events: [fut], fetched_at: daysAgo(7.1) }, today, now) === true)
  t('a missing fetched_at cannot prove freshness → stale', isStaleCache({ events: [fut] }, today, now) === true)
  t('the stored date string is compared on its first 10 chars',
    isStaleCache({ events: [{ date_start: '2026-10-25T23:00:00-05:00' }], fetched_at: daysAgo(1) }, today, now) === false)
  eq('fmtMonDay formats in Central time and never yields "Invalid Date"',
    [fmtMonDay('2026-10-03T12:00:00Z'), fmtMonDay('garbage'), fmtMonDay(null)], ['Oct 3', '', ''])
}

// ═══ 3 — area payloads: full places list, short description, city keys ═══════
console.log('3 — area description and City-mode options')
{
  eq('description names three places, counts the rest and the county',
    areaDescription(['Wausau', 'Marshfield', 'Weston', 'Kronenwetter', 'Rothschild'], ['Marathon']),
    'Wausau, Marshfield, Weston and 2 more (Marathon County)')
  eq('multi-county description', areaDescription(['A'], ['Racine', 'Kenosha']), 'A (Racine, Kenosha counties)')
  const opts = buildCityOptions([
    { n: 'Green Bay', t: 'city', c: 'Brown', p: 100, label: 'Green Bay' },
    { n: 'Weston', t: 'village', c: 'Marathon', p: 50, label: 'Weston' },
    { n: 'Weston', t: 'town', c: 'Clark', p: 5, label: 'Weston' },
    { n: 'Weston', t: 'town', c: 'Marathon', p: 4, label: 'Weston (town)' },
    { n: 'Superior', t: 'city', c: 'Douglas', p: 20, label: 'Superior' },
    { n: 'Superior', t: 'village', c: 'Douglas', p: 2, label: 'Superior' },
  ])
  const gb = opts.find(o => o.key === 'city-Green Bay-Brown')
  t('city key is `city-${label}-${county}` (spaces kept)', Boolean(gb))
  eq('city payload: places = [n], counties = [c], district_name "Label, WI"',
    [gb.places, gb.counties, gb.name], [['Green Bay'], ['Brown'], 'Green Bay, WI'])
  eq('a label used in several counties gets "(County Co.)" as its district_name',
    opts.find(o => o.key === 'city-Weston-Marathon').name, 'Weston (Marathon Co.)')
  eq('picker label always carries type and county', opts.find(o => o.key === 'city-Weston (town)-Marathon').pickLabel,
    'Weston — town, Marathon Co.')
  eq('colliding keys keep the more populous place', opts.filter(o => o.key === 'city-Superior-Douglas').map(o => o.pickLabel),
    ['Superior — city, Douglas Co.'])
}

// ═══ 4 — no automatic searches; prompts; fresh results get no re-run button ═══
console.log('4 — click-only searches, stale prompt, no re-run when fresh')
{
  t('the auto-refresh effect is gone', !/autoRefresh/i.test(s) && !/searchStartedRef/.test(s))
  const calls = s.match(/startSearch\b[^\n]*/g) || []
  t('startSearch is only ever wired to onClick (never called from an effect)',
    calls.every(l => /^startSearch = useCallback/.test(l) || /^startSearch\}/.test(l)) &&
    !/startSearch\(\)/.test(s))
  t('every startSearch reference is an onClick or its definition',
    (s.match(/startSearch/g) || []).length === (s.match(/onClick=\{startSearch\}/g) || []).length + 1)
  t('startSearch itself refuses a fresh area (owner policy)',
    /const startSearch = useCallback\(async \(\) => \{\s*\n\s*if \(!target \|\| run\) return\s*\n\s*if \(!isStaleCache\(row, centralTodayIso\(\)\)\) return/.test(s))
  t('every search control is gated on canSearch (= stale && idle)',
    /const canSearch = Boolean\(target\) && cacheChecked && !loadError && !run && stale/.test(s))
  t('the out-of-date banner copy exists', /These results are out of date/.test(s) && /Run a new search to find upcoming events\./.test(s))
  t('the banner only renders for a stale row', /row && stale && !run && !runError && \(/.test(s))
  t('the old header "Search for new events" button is gone', !/Search for new events/.test(s))
  t('the fresh state shows an "Updated <Mon d>" note gated on !stale', /\{!stale && fetchedAt && fmtMonDay\(fetchedAt\) && \(/.test(s) && /Updated \{fmtMonDay\(fetchedAt\)\}/.test(s))
  // Every search button lives inside a block gated by stale/!row or canSearch.
  const buttons = [...s.matchAll(/onClick=\{startSearch\}/g)].map(m => s.slice(Math.max(0, m.index - 1500), m.index))
  t('no search button can render while results are fresh',
    buttons.length >= 3 && buttons.every(ctx => /(row && stale|!row && !run|canSearch && \()[^]*$/.test(ctx)))
  t('the never-searched card copy', /No events for \{target\?\.name \|\| 'this area'\} yet/.test(s) &&
    /Takes 2–5 minutes\. You can leave this page — results are saved for everyone\./.test(s))
  t('the header count is computed from the filtered (upcoming) list', /\{filtered\.length\} event/.test(s))
  t('the rendered pipeline runs events through filterUpcoming with Central today',
    /const upcoming = useMemo\(\(\) => filterUpcoming\(events, todayIso\)/.test(s))
  t('the lean filters are applied on top of `upcoming`, not raw `events`',
    /const filtered = useMemo\(\(\) => \{\s*\n\s*if \(!upcoming\.length\) return \[\]/.test(s))
}

// ═══ 5 — polling correctness ═════════════════════════════════════════════════
console.log('5 — polling ignores old progress rows; heartbeat-based liveness')
{
  t('MAX_WAIT is 12 minutes', /const MAX_WAIT_MS\s*=\s*12 \* 60 \* 1000/.test(s))
  t('heartbeat timeout is 3 minutes', /const HEARTBEAT_STALE_MS = 3 \* 60 \* 1000/.test(s))
  t('the progress snapshot is taken before the POST',
    s.indexOf('Promise.all([readProgress(key), readCache(key)])', s.indexOf('const startSearch')) <
    s.indexOf("fetch('/.netlify/functions/research-district-events-background'"))
  t('progress rows at/before the snapshot are ignored (server-vs-server)', /progMs > snapMs/.test(s))
  t('liveness is measured by local time since the last updated_at change',
    /if \(prog\.updated_at !== lastSeen\) \{ lastSeen = prog\.updated_at; lastChangeLocal = Date\.now\(\) \}/.test(s) &&
    /Date\.now\(\) - lastChangeLocal > HEARTBEAT_STALE_MS/.test(s))
  t('the POST body carries places and force:false',
    /places: target\.places \|\| \[\],/.test(s) && /force: false,/.test(s))
  t('query errors surface as a retryable load error', /if \(error\) throw error/.test(s) && /Couldn't load events — retry/.test(s))
  t('the progress card is not hidden when old events are on screen', /\{run && \(\(\) => \{/.test(s) && !/loading && !events/.test(s))
}

// ═══ 6 — copy and defaults ═══════════════════════════════════════════════════
console.log('6 — neutral copy, picker, default area')
{
  t('no partisan empty-state headline', !/Find conservative events/.test(s) && /Find events in your district/.test(s))
  t('accurate subtitle', /Pick a district, county, or any Wisconsin city, village or town/.test(s))
  t('municipalities load lazily, only in City mode',
    /if \(mode === 'city' && !munis\) loadMunicipalities\(\)/.test(s) && /let _munisCache = null/.test(s))
  t('pickers still use SearchableSelect', /<SearchableSelect/.test(s))
  t('last area is persisted in localStorage inside try/catch',
    /try \{ localStorage\.setItem\(AREA_STORAGE_KEY/.test(s))
  t('default falls back to the first candidate office, then congress-1',
    /districtKeyForOffice\(c\.office\) \|\| officeToDistrict\(c\.office\)/.test(s) && /setSel\('congress-1'\)/.test(s))
}
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
