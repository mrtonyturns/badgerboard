#!/usr/bin/env node
// Badger Board — Sep-21 weekly-sweep fix: stale cached search results on
// /events were rendered as "upcoming" (list led with events that had already
// happened) with no staleness warning and no auto-refresh.
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
const { filterUpcoming, isStale } = await loadPureBlock(FILE, 'R4')
const s = src(FILE)

// ═══ 1 — filterUpcoming: "next 60 days" measured from now, not from search time ═══
console.log('1 — filterUpcoming drops what has already happened')
{
  const now = new Date('2026-09-21T12:00:00')
  const events = [
    { name: 'Kenosha Book Festival', date_start: '2026-08-16' },   // past
    { name: 'Kenosha Art Market',    date_start: '2026-08-16' },   // past
    { name: 'Kenosha County Fair',   date_start: '2026-08-19' },   // past
    { name: 'Today Rally',           date_start: '2026-09-21' },   // today — kept
    { name: 'October Fest',          date_start: '2026-10-15' },   // future — kept
    { name: 'Undated Mixer' },                                     // no date_start — kept, sorted last
    { name: 'Junk Date Social',      date_start: 'not-a-date' },   // unparseable — kept, sorted last
  ]
  const out = filterUpcoming(events, now)
  const names = out.map(e => e.name)

  t('past events are dropped',
    !names.includes('Kenosha Book Festival') && !names.includes('Kenosha Art Market') && !names.includes('Kenosha County Fair'))
  t('an event happening today is kept', names.includes('Today Rally'))
  t('a future event is kept', names.includes('October Fest'))
  t('an event with no date is kept, not silently dropped', names.includes('Undated Mixer'))
  t('an event with an unparseable date is kept, not silently dropped', names.includes('Junk Date Social'))
  eq('exactly the dated-upcoming + undated events survive, in that order',
    names, ['Today Rally', 'October Fest', 'Undated Mixer', 'Junk Date Social'])
  t('dated events are sorted before undated/unparseable ones',
    names.indexOf('October Fest') < names.indexOf('Undated Mixer'))

  eq('non-array input yields an empty list (never throws)', filterUpcoming(null, now), [])
  eq('empty input yields an empty list', filterUpcoming([], now), [])
}

// ═══ 2 — isStale: the 7-day freshness boundary ════════════════════════════════
console.log('2 — isStale boundary at the 7-day threshold')
{
  const now = new Date('2026-09-21T00:00:00Z')
  const d = (days) => new Date(now.getTime() - days * 24 * 3600 * 1000).toISOString()

  t('6.9 days old is not stale', isStale(d(6.9), now) === false)
  t('7.1 days old is stale', isStale(d(7.1), now) === true)
  t('exactly the default threshold (7d) is not yet stale (strictly greater-than)',
    isStale(d(7), now) === false)
  t('a null lastSearchedAt is never stale', isStale(null, now) === false)
  t('an undefined lastSearchedAt is never stale', isStale(undefined, now) === false)
  t('a junk lastSearchedAt is never stale', isStale('not-a-date', now) === false)
  t('a custom threshold is honored', isStale(d(2), now, 1) === true && isStale(d(0.5), now, 1) === false)
}

// ═══ 3 — the header count and staleness/auto-refresh wiring in the source ═════
console.log('3 — header count, staleness banner and auto-refresh guard')
{
  t('the header "N events" count is computed from the filtered (post past-date-filter) list',
    /\{filtered\.length\} event/.test(s))
  t('the rendered pipeline runs events through filterUpcoming before anything else',
    /const upcoming = useMemo\(\(\) => filterUpcoming\(events,/.test(s))
  t('the lean filters (all\\/conservative\\/liberal\\/nonpartisan) are applied on top of `upcoming`, not raw `events`',
    /const filtered = useMemo\(\(\) => \{\s*\n\s*if \(!upcoming\.length\) return \[\]/.test(s))

  t('an isStale check gates an inline banner', /isStale\(fetchedAt, new Date\(\)\)/.test(s))
  t('the banner tells the user which day the cache is from', /These results are from \{/.test(s))
  t('the banner offers an inline way to search again, reusing the shared handler',
    /Search again/.test(s) && /<button onClick=\{startSearch\}/.test(s))
  t('a distinct "refreshing now" message exists for the auto-triggered run',
    /refreshing now…/.test(s))

  t('an auto-refresh effect exists', /autoRefreshFiredRef/.test(s))
  t('the auto-refresh only fires once per mount (checked before being set)',
    /if \(autoRefreshFiredRef\.current \|\| searchStartedRef\.current\) return/.test(s) &&
    /autoRefreshFiredRef\.current = true/.test(s))
  t('the auto-refresh guards against a run already in flight (loading) and an un-checked cache',
    /if \(!cacheChecked \|\| loading\) return/.test(s))
  t('the auto-refresh reuses the exact same handler as the manual buttons (startSearch → loadEvents(true))',
    /const startSearch = useCallback\(\(\) => \{\s*\n\s*searchStartedRef\.current = true\s*\n\s*loadEvents\(true\)/.test(s))
  t('manual "Search for new events" controls also route through startSearch (so a manual click blocks the auto-refresh too)',
    (s.match(/onClick=\{startSearch\}/g) || []).length >= 2)

  t('the empty/start-state block (no cache yet) is untouched by the staleness logic',
    /cacheChecked && !events && !loading && !error/.test(s))
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
