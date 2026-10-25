#!/usr/bin/env node
// Badger Board — research-district-events-background.js server contract.
// Only 21 of 619 areas had ever been searched in production: the key regex
// rejected every name with a space ("city-Green Bay-Brown", "county-St. Croix"),
// failures were invisible, and cache staleness / "today" were computed in UTC.
//
// Pure helpers are require()d from the function module; the handler itself is
// exercised with a mocked global fetch (no network, no env secrets).
//
// Zero-config: node tests/events-server.test.mjs

import { createRequire } from 'module'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)

// Env must be set before the module (and _shared / _ai-usage) is loaded.
process.env.SUPABASE_URL = 'http://sb.test'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key'
process.env.ANTHROPIC_API_KEY = 'anthropic-key'
process.env.PERPLEXITY_API_KEY = 'pplx-key'
delete process.env.X_BEARER_TOKEN
delete process.env.CLAUDE_RESEARCH_MODEL

const M = require('../netlify/functions/research-district-events-background.js')

let pass = 0, fail = 0
const t = (name, cond) => { cond ? pass++ : fail++; console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${name}`) }
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) console.log(`      got ${JSON.stringify(got)} · want ${JSON.stringify(want)}`)
  t(name, ok)
}

// ═══ 1 — district_key regex ═══
console.log('1 — district_key regex')
for (const k of ['city-Green Bay-Brown', 'county-St. Croix', 'county-Fond du Lac', 'city-Weston (town)-Marathon', 'assembly-8', 'senate-12', 'congress-7', "city-O'Brien-Dane"]) {
  t(`accepts "${k}"`, M.DISTRICT_KEY_RE.test(k))
}
for (const k of ['x;drop', 'a'.repeat(101), '', 'city-"Bay"-Brown', 'county-a/b', 'county-a\nb']) {
  t(`rejects ${JSON.stringify(k.length > 20 ? k.slice(0, 12) + '…(' + k.length + ')' : k)}`, !M.DISTRICT_KEY_RE.test(k))
}

// ═══ 2 — isStaleCache ═══
console.log('2 — isStaleCache')
{
  const today = '2026-10-25'
  const now = Date.parse('2026-10-25T17:00:00Z')
  const fresh = new Date(now - 2 * 86400000).toISOString()
  t('missing row → stale', M.isStaleCache(null, today, now) === true)
  t('undefined row → stale', M.isStaleCache(undefined, today, now) === true)
  t('empty events → stale', M.isStaleCache({ events: [], fetched_at: fresh }, today, now) === true)
  t('events not an array → stale', M.isStaleCache({ events: null, fetched_at: fresh }, today, now) === true)
  t('all past → stale', M.isStaleCache({ events: [{ date_start: '2026-10-01' }, { date_start: '2026-10-24', date_end: '2026-10-24' }], fetched_at: fresh }, today, now) === true)
  t('upcoming present → fresh', M.isStaleCache({ events: [{ date_start: '2026-10-01' }, { date_start: '2026-11-02' }], fetched_at: fresh }, today, now) === false)
  t('event today counts as upcoming', M.isStaleCache({ events: [{ date_start: '2026-10-25' }], fetched_at: fresh }, today, now) === false)
  t('multi-day ongoing via date_end → fresh', M.isStaleCache({ events: [{ date_start: '2026-10-20', date_end: '2026-10-27' }], fetched_at: fresh }, today, now) === false)
  t('ISO datetime date_end compared by first 10 chars', M.isStaleCache({ events: [{ date_start: '2026-10-20', date_end: '2026-10-25T08:00:00Z' }], fetched_at: fresh }, today, now) === false)
  t('unparseable dates only → stale', M.isStaleCache({ events: [{ date_start: 'TBD' }, { date_start: 'next Friday' }, { name: 'no date' }, { date_start: '2026-13-45' }], fetched_at: fresh }, today, now) === true)
  t('unparseable + one upcoming → fresh', M.isStaleCache({ events: [{ date_start: 'TBD' }, { date_start: '2026-11-15' }], fetched_at: fresh }, today, now) === false)
  t('fetched 8 days ago → stale', M.isStaleCache({ events: [{ date_start: '2026-11-15' }], fetched_at: new Date(now - 8 * 86400000).toISOString() }, today, now) === true)
  t('fetched 6 days ago → fresh', M.isStaleCache({ events: [{ date_start: '2026-11-15' }], fetched_at: new Date(now - 6 * 86400000).toISOString() }, today, now) === false)
  t('missing fetched_at → stale', M.isStaleCache({ events: [{ date_start: '2026-11-15' }] }, today, now) === true)
  // default nowMs = Date.now()
  const realToday = M.centralTodayIso()
  t('8 days old with default clock → stale', M.isStaleCache({ events: [{ date_start: '2099-01-01' }], fetched_at: new Date(Date.now() - 8 * 86400000).toISOString() }, realToday) === true)
}

// ═══ 3 — centralTodayIso ═══
console.log('3 — centralTodayIso (America/Chicago, not UTC)')
eq('2026-10-26T03:30Z → 2026-10-25 (still the 25th in Wisconsin)', M.centralTodayIso(new Date('2026-10-26T03:30:00Z')), '2026-10-25')
eq('2026-10-26T05:30Z → 2026-10-26', M.centralTodayIso(new Date('2026-10-26T05:30:00Z')), '2026-10-26')
eq('winter (CST) 2026-12-01T05:59Z → 2026-11-30', M.centralTodayIso(new Date('2026-12-01T05:59:00Z')), '2026-11-30')
t('default argument returns YYYY-MM-DD', /^\d{4}-\d{2}-\d{2}$/.test(M.centralTodayIso()))

// ═══ 4 — model-output JSON parsing / salvage ═══
console.log('4 — parseModelJson')
{
  const fenced = '```json\n{"events":[{"name":"A","date_start":"2026-11-01"}]}\n```'
  eq('fenced', M.listFromParsed(M.parseModelJson(fenced), 'events').map(e => e.name), ['A'])
  const preamble = 'Here is the JSON you asked for:\n\n```json\n{"events":[{"name":"A"},{"name":"B"}]}\n```\nLet me know if you need more.'
  const p = M.parseModelJson(preamble)
  eq('preamble + fences + trailing commentary', M.listFromParsed(p, 'events').map(e => e.name), ['A', 'B'])
  t('clean parse is not flagged salvaged', p.salvaged === false)
  const truncated = 'Sure!\n```json\n{"events":[{"name":"A","date_start":"2026-11-01","lean":{"label":"nonpartisan","score":0}},{"name":"B {tricky} \\"quoted\\" ]","date_start":"2026-11-02"},{"name":"C","date_st'
  const s = M.parseModelJson(truncated)
  eq('truncated → complete objects salvaged', M.listFromParsed(s, 'events').map(e => e.name), ['A', 'B {tricky} "quoted" ]'])
  t('truncated parse is flagged salvaged', s.salvaged === true)
  eq('bare array', M.listFromParsed(M.parseModelJson('[{"name":"X"}]'), 'events').map(e => e.name), ['X'])
  eq('hosts key', M.listFromParsed(M.parseModelJson('{"hosts":[{"host":"Lions"}]}'), 'hosts').map(h => h.host), ['Lions'])
  t('no JSON at all → null', M.parseModelJson('Sorry, I could not find any events.') === null)
  t('empty → null', M.parseModelJson('') === null && M.parseModelJson(undefined) === null)
}

// ═══ 5 — dates: past filter + recurring roll-forward ═══
console.log('5 — upcomingOrNull')
{
  const today = '2026-10-25'
  t('future kept', M.upcomingOrNull({ name: 'a', date_start: '2026-11-01' }, today)?.date_start === '2026-11-01')
  t('past dropped', M.upcomingOrNull({ name: 'a', date_start: '2026-10-01' }, today) === null)
  t('ongoing via date_end kept', M.upcomingOrNull({ name: 'a', date_start: '2026-10-01', date_end: '2026-10-30' }, today) !== null)
  t('unparseable dropped', M.upcomingOrNull({ name: 'a', date_start: 'Every Saturday' }, today) === null)
  t('missing date dropped', M.upcomingOrNull({ name: 'a' }, today) === null)
  eq('weekly rolled to next occurrence ≥ today', M.upcomingOrNull({ name: 'Fish fry', date_start: '2026-10-02', recurrence: 'weekly' }, today)?.date_start, '2026-10-30')
  eq('weekly landing on today stays today', M.upcomingOrNull({ name: 'x', date_start: '2026-10-18', recurrence: 'weekly' }, today)?.date_start, '2026-10-25')
  t('weekly series that ended is dropped', M.upcomingOrNull({ name: 'Market', date_start: '2026-06-06', date_end: '2026-10-17', recurrence: 'weekly' }, today) === null)
  eq('seasonal weekly series keeps date_end', M.upcomingOrNull({ name: 'Market', date_start: '2026-06-06', date_end: '2026-10-31', recurrence: 'weekly' }, today), { name: 'Market', date_start: '2026-10-31', date_end: '2026-10-31', recurrence: 'weekly' })
}

// ═══ 6 — places, prompt area and in-area filter ═══
console.log('6 — places & boundary filter')
{
  const places = Array.from({ length: 40 }, (_, i) => `Place${i + 1}`)
  const pa = M.promptArea(places, ['Marathon'])
  t('prompt names at most 15 places', pa.startsWith('Place1, ') && pa.includes('Place15') && !pa.includes('Place16'))
  t('prompt adds "and other communities in Marathon County"', pa.endsWith('and other communities in Marathon County'))
  eq('short list has no tail', M.promptArea(['Wausau', 'Schofield'], ['Marathon']), 'Wausau, Schofield')
  eq('no places → counties', M.promptArea([], ['Door', 'Kewaunee']), 'communities in Door, Kewaunee counties')
  t('never fences on the district label', !M.parseAreaDescriptionPlaces('Assembly District 8').length)
  eq('legacy area_description parsed', M.parseAreaDescriptionPlaces('Wausau, Schofield, Rib Mountain (Marathon County)'), ['Wausau', 'Schofield', 'Rib Mountain'])
  t('places: non-array → null (legacy path)', M.normalizePlaces(undefined) === null)
  eq('places: trims, caps length, dedupes, drops non-strings', M.normalizePlaces([' Wausau ', 'wausau', 7, '', 'X'.repeat(80)]), ['Wausau', 'X'.repeat(60)])
  eq('county from key', [M.countyFromKey('county-St. Croix'), M.countyFromKey('city-Weston (town)-Marathon'), M.countyFromKey('assembly-8')], ['St. Croix', 'Marathon', null])

  const big = [...places, 'Green Bay', 'De Pere', 'Weston (town)', 'St. Croix Falls']
  const inArea = M.buildAreaMatcher({ places: big, counties: ['Brown'], districtKey: 'assembly-4' })
  t('matches place #41 (full list used, not first 15)', inArea({ city: 'Green Bay' }))
  t('case-insensitive', inArea({ city: 'DE PERE' }))
  t('matches inside an address', inArea({ city: null, address: '100 Main St, De Pere, WI' }))
  t('"(town)" suffix matched by bare name', inArea({ city: 'Weston' }))
  t('periods ignored (St. Croix Falls / St Croix Falls)', inArea({ city: 'St Croix Falls' }))
  t('whole word only (Green Bayside ≠ Green Bay)', !inArea({ city: 'Green Bayside' }))
  t('out-of-area dropped', !inArea({ city: 'Appleton' }))
  t('county fair always kept', inArea({ city: 'Seymour', category: 'fair' }))
  t('county name NOT enough for a legislative district', !inArea({ city: 'Somewhere', name: 'Brown County craft show' }))

  const county = M.buildAreaMatcher({ places: ['Hudson', 'River Falls'], counties: ['St. Croix'], districtKey: 'county-St. Croix' })
  t('county key: place match', county({ city: 'Hudson' }))
  t('county key: text naming the county accepted', county({ city: 'Baldwin', name: 'St. Croix County Board meeting' }))
  t('county key: unrelated dropped', !county({ city: 'Eau Claire', name: 'Fall fest' }))

  const noPlaces = M.buildAreaMatcher({ places: [], counties: ['Door'], districtKey: 'assembly-1' })
  t('no places → county fallback', noPlaces({ city: 'Sturgeon Bay', address: 'Door County Fairgrounds' }) && !noPlaces({ city: 'Sturgeon Bay' }))
}

// ═══ 7 — rate-limit messages ═══
console.log('7 — rate-limit messages')
eq('per-day', M.rateLimitMessage({ body: JSON.stringify({ limit: 'day' }) }), "You've reached today's event-search limit — it resets at midnight.")
eq('per-minute', M.rateLimitMessage({ body: JSON.stringify({ limit: 'minute' }) }), 'Too many searches in the last minute — try again shortly.')
t('limiter reports which budget tripped', /'day'\)/.test(readFileSync(join(ROOT, 'netlify/functions/_rate-limit.js'), 'utf8')) && /'minute'\)/.test(readFileSync(join(ROOT, 'netlify/functions/_rate-limit.js'), 'utf8')))

// ═══ 8 — model id + usage logging ═══
console.log('8 — model id & ai-usage model names')
{
  const src = readFileSync(join(ROOT, 'netlify/functions/research-district-events-background.js'), 'utf8')
  eq('default model matches the codebase-wide Opus id', M.DEFAULT_CLAUDE_MODEL, 'claude-opus-4-8')
  t('usage is logged with the model actually called (no hardcoded sonar-pro)', !/model:\s*'sonar-pro',\s*inputTokens/.test(src))
  t('sonar-pro extra pass timeout raised to 45 s', /perplexityExtra:\s*45000/.test(src))
  t('structuring call timeout 150 s', /anthropicStructure:\s*150000/.test(src))
  t('research calls run in parallel', /Promise\.allSettled\(\[mainSearch, xSearch, newsSearch\]\)/.test(src))
  t('no ESM export left (module is require()-able)', !/^export\s/m.test(src))
}

// ═══ 9 — geodata: every area key the page can produce is valid ═══
console.log('9 — geodata')
{
  const dp = JSON.parse(readFileSync(join(ROOT, 'public/geodata/wi-district-places.json'), 'utf8'))
  const keys = Object.keys(dp)
  const emptyPlaces = keys.filter(k => !Array.isArray(dp[k]?.places) || !dp[k].places.length)
  t(`all ${keys.length} wi-district-places keys have a non-empty places array`, keys.length > 0 && emptyPlaces.length === 0)
  if (emptyPlaces.length) console.log('      empty:', emptyPlaces.slice(0, 10).join(', '))
  const badDistrictKeys = keys.filter(k => !M.DISTRICT_KEY_RE.test(k))
  t('every wi-district-places key passes the key regex', badDistrictKeys.length === 0)
  if (badDistrictKeys.length) console.log('      bad:', badDistrictKeys.slice(0, 10).join(', '))
  const tooLong = keys.filter(k => dp[k].places.some(p => String(p).length > 60))
  t('every place name ≤ 60 chars', tooLong.length === 0)

  const munis = JSON.parse(readFileSync(join(ROOT, 'public/geodata/wi-municipalities.json'), 'utf8'))
  t('wi-municipalities is a non-empty array', Array.isArray(munis) && munis.length > 0)
  const badCity = munis.filter(m => !M.DISTRICT_KEY_RE.test(`city-${m.label}-${m.c}`))
  t(`all ${munis.length} municipality keys city-<label>-<county> pass the key regex`, badCity.length === 0)
  if (badCity.length) console.log('      bad:', badCity.slice(0, 10).map(m => `city-${m.label}-${m.c}`).join(', '))
  const counties = [...new Set(munis.map(m => m.c))]
  t(`all ${counties.length} county keys pass the key regex`, counties.every(c => M.DISTRICT_KEY_RE.test(`county-${c}`)))
}

// ═══ 10 — handler behaviour with mocked fetch ═══
console.log('10 — handler (mocked network)')
{
  const realFetch = globalThis.fetch
  const realLog = console.log, realWarn = console.warn, realErr = console.error
  const quiet = () => { console.log = () => {}; console.warn = () => {}; console.error = () => {} }
  const loud  = () => { console.log = realLog; console.warn = realWarn; console.error = realErr }
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } })

  const run = async ({ cacheRow = null, rate = { minute_count: 1, day_count: 1 }, authOk = true, email = 'user@example.com', body, structure }) => {
    const calls = []
    const progress = []
    globalThis.fetch = async (url, opts = {}) => {
      const u = String(url)
      calls.push(u)
      if (u.endsWith('/auth/v1/user')) return authOk ? json({ id: 'u1', email }) : json({}, 401)
      if (u.includes('/rest/v1/rpc/bump_rate_limit')) return json([rate])
      if (u.includes('/rest/v1/district_events_progress')) {
        if ((opts.method || 'GET') === 'POST') progress.push(JSON.parse(opts.body))
        return (opts.method || 'GET') === 'GET' ? json([]) : new Response(null, { status: 201 })
      }
      if (u.includes('/rest/v1/district_events?')) return json(cacheRow ? [cacheRow] : [])
      if (u.endsWith('/rest/v1/district_events')) return new Response(null, { status: 201 })
      if (u.includes('api.perplexity.ai')) return json({ choices: [{ message: { content: 'Research text' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } })
      if (u.includes('api.anthropic.com')) return json({ content: [{ type: 'text', text: structure }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } })
      return new Response('', { status: 404 })
    }
    quiet()
    try {
      const res = await M.handler({
        httpMethod: 'POST',
        headers: { authorization: 'Bearer tok' },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      })
      return { res, calls, progress }
    } finally { loud(); globalThis.fetch = realFetch }
  }

  const today = M.centralTodayIso()
  const future = (d) => { const x = new Date(Date.parse(today + 'T12:00:00Z') + d * 86400000); return x.toISOString().slice(0, 10) }
  const base = { district_key: 'city-Green Bay-Brown', district_name: 'Green Bay', counties: ['Brown'], places: ['Green Bay'] }

  // fresh cache → no search, no rate limit
  {
    const { calls, progress } = await run({
      body: base,
      cacheRow: { events: [{ name: 'x', date_start: future(3) }], fetched_at: new Date().toISOString() },
    })
    const last = progress.at(-1)
    t('fresh cache: ends done/stage 4/"fresh"', last?.status === 'done' && last?.stage === 4 && last?.message === 'fresh')
    t('fresh cache: running row written first with started_at', progress[0]?.status === 'running' && progress[0]?.stage === 1 && !!progress[0]?.started_at)
    t('fresh cache: rate limiter NOT consumed', !calls.some(u => u.includes('bump_rate_limit')))
    t('fresh cache: no AI calls', !calls.some(u => /perplexity|anthropic/.test(u)))
  }

  // non-admin force on a fresh cache is still a no-op
  {
    const { calls, progress } = await run({
      body: { ...base, force: true },
      cacheRow: { events: [{ name: 'x', date_start: future(3) }], fetched_at: new Date().toISOString() },
    })
    t('non-admin force:true on fresh cache → no search', progress.at(-1)?.message === 'fresh' && !calls.some(u => /perplexity|anthropic/.test(u)))
  }

  // stale cache → full run, saves, done
  {
    const structure = 'Here you go:\n```json\n' + JSON.stringify({ events: [
      { name: 'Packers Tailgate', date_start: future(5), city: 'Green Bay', category: 'festival' },
      { name: 'Appleton Fest', date_start: future(5), city: 'Appleton', category: 'festival' },
      { name: 'Old Thing', date_start: '2020-01-01', city: 'Green Bay', category: 'other' },
      { name: 'Undated', date_start: 'TBD', city: 'Green Bay', category: 'other' },
    ] }) + '\n```'
    const { calls, progress } = await run({ body: base, cacheRow: { events: [{ name: 'old', date_start: '2020-01-01' }], fetched_at: new Date().toISOString() }, structure })
    const saved = calls.filter(u => u.endsWith('/rest/v1/district_events')).length
    t('stale cache: rate limiter consumed once', calls.filter(u => u.includes('bump_rate_limit')).length === 1)
    t('stale cache: cache written once', saved === 1)
    t('stale cache: ends done', progress.at(-1)?.status === 'done' && progress.at(-1)?.stage === 4)
    const stages = progress.filter(p => p.status === 'running').map(p => p.stage)
    t('stage order 1 → 2 → 3 → 4', JSON.stringify(stages.filter((s, i) => s !== stages[i - 1])) === JSON.stringify([1, 2, 3, 4]))
  }

  // zero confirmed events → error and NO cache write
  {
    const structure = JSON.stringify({ events: [{ name: 'Appleton Fest', date_start: future(5), city: 'Appleton' }] })
    const { calls, progress } = await run({ body: base, structure })
    t('zero confirmed events: error written', progress.at(-1)?.status === 'error' && /No public events/.test(progress.at(-1)?.message))
    t('zero confirmed events: cache NOT overwritten', !calls.some(u => u.endsWith('/rest/v1/district_events')))
  }

  // unreadable output → error, no write
  {
    const { calls, progress } = await run({ body: base, structure: 'I could not do that.' })
    t('unreadable output: error written', progress.at(-1)?.status === 'error' && /unreadable/.test(progress.at(-1)?.message))
    t('unreadable output: cache NOT written', !calls.some(u => u.endsWith('/rest/v1/district_events')))
  }

  // rate limited (per day / per minute)
  {
    const { progress } = await run({ body: base, rate: { minute_count: 1, day_count: 999 } })
    eq('per-day limit message', progress.at(-1)?.message, "You've reached today's event-search limit — it resets at midnight.")
    const r2 = await run({ body: base, rate: { minute_count: 999, day_count: 1 } })
    eq('per-minute limit message', r2.progress.at(-1)?.message, 'Too many searches in the last minute — try again shortly.')
  }

  // auth failure writes NOTHING — progress rows are shared across users, so an
  // unauthenticated request must not be able to mark an area as failed
  {
    const { progress } = await run({ body: base, authOk: false })
    t('auth failure: no shared progress row is written', progress.length === 0)
  }

  // missing name, bad JSON, bad key
  {
    const { progress } = await run({ body: { district_key: 'county-St. Croix' } })
    t('missing name: error row written', progress.at(-1)?.status === 'error' && progress.at(-1)?.district_key === 'county-St. Croix')
    const bad = await run({ body: '{"district_key":"county-Fond du Lac", oops' })
    t('bad JSON: error row written for sniffed key', bad.progress.at(-1)?.status === 'error' && bad.progress.at(-1)?.district_key === 'county-Fond du Lac')
    const badKey = await run({ body: { ...base, district_key: 'x;drop' } })
    t('invalid key: rejected, nothing written', badKey.res.statusCode === 400 && badKey.progress.length === 0)
  }
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
