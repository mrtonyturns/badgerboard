#!/usr/bin/env node
// Badger Board — functions sweep 2: behaviour tests for the second October
// 2026 Netlify-functions sweep (SSRF-safe fetch, monitoring entitlement,
// shared-cache poisoning, support-chat trimming, notifier paging, seat
// matching), plus source assertions for handlers that need a live Supabase.
//
// Network is never touched: fetch and DNS are faked where a test needs them.
//
// Zero-config: node tests/functions-sweep-2.test.mjs

import { createRequire } from 'module'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
const require = createRequire(import.meta.url)

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const src  = (p) => readFileSync(join(ROOT, p), 'utf8')

let pass = 0, fail = 0
const t = (name, cond) => { cond ? pass++ : fail++; console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${name}`) }

// ─── _safe-fetch: address classification (pure) ──────────────────────────────
console.log('_safe-fetch — isBlockedAddress / isBlockedHostname')
const SF = require('../netlify/functions/_safe-fetch.js')
{
  const { isBlockedAddress: blocked, isBlockedHostname: badHost } = SF
  const deny = ['127.0.0.1', '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254',
    '100.64.0.1', '100.127.255.254', '0.0.0.0', '0.1.2.3', '224.0.0.1', '239.255.255.250', '240.0.0.1',
    '255.255.255.255', '::', '::1', '[::1]', 'fe80::1', 'febf::1', 'fc00::1', 'fd12:3456::1', 'ff02::1',
    '::ffff:127.0.0.1', '::ffff:169.254.169.254', '64:ff9b::a9fe:a9fe', '2002:7f00:1::', '2001:db8::1', 'not-an-ip']
  const allow = ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.15.0.1', '172.32.0.1', '100.63.255.255',
    '100.128.0.1', '2606:4700:4700::1111', '2a00:1450:4001::200e', '::ffff:8.8.8.8']
  const wrongDeny  = deny.filter(ip => !blocked(ip))
  const wrongAllow = allow.filter(ip => blocked(ip))
  t(`private / loopback / link-local / CGNAT / ULA / multicast / mapped are blocked${wrongDeny.length ? ` (missed: ${wrongDeny})` : ''}`, !wrongDeny.length)
  t(`public unicast v4 + v6 is allowed${wrongAllow.length ? ` (over-blocked: ${wrongAllow})` : ''}`, !wrongAllow.length)
  t('metadata / localhost / *.internal / single-label hosts are refused',
    ['localhost', 'foo.localhost', 'metadata.google.internal', 'metadata', 'db.internal', 'intranet', 'printer.local'].every(badHost))
  t('ordinary public hostnames pass the name check', !badHost('www.example.com') && !badHost('badgerboardwi.com'))
}

console.log('_safe-fetch — assertPublicUrl / safeFetch (fake DNS + fetch)')
{
  const pub  = async () => [{ address: '93.184.216.34', family: 4 }]
  const split = async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.7', family: 4 }]
  const rejects = async (p) => { try { await p; return false } catch (e) { return e.name === 'SafeFetchError' } }

  t('non-http(s) schemes rejected', await rejects(SF.assertPublicUrl('file:///etc/passwd', { lookup: pub })))
  t('IP-literal loopback rejected (incl. decimal form)', await rejects(SF.assertPublicUrl('http://2130706433/', { lookup: pub })))
  t('a split DNS answer with ANY private address is rejected', await rejects(SF.assertPublicUrl('http://split.example.com/', { lookup: split })))
  t('credentials in the URL are rejected', await rejects(SF.assertPublicUrl('http://a:b@example.com/', { lookup: pub })))
  t('a public host resolves and passes', (await SF.assertPublicUrl('https://example.com/x', { lookup: pub })).hostname === 'example.com')

  const realFetch = globalThis.fetch
  const calls = []
  const route = (map) => { globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    const r = map[url]
    if (!r) return new Response('nf', { status: 404 })
    return new Response(r.body ?? '', { status: r.status, headers: r.headers || {} })
  } }
  try {
    route({
      'https://example.com/': { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } },
    })
    t('a public URL that 302s to the metadata IP is stopped at the hop',
      await rejects(SF.safeFetch('https://example.com/', { lookup: pub })) &&
      !calls.some(c => String(c.url).includes('169.254')))
    t('every hop is fetched with redirect:manual', calls.every(c => c.init.redirect === 'manual'))

    calls.length = 0
    route({
      'https://example.com/a': { status: 301, headers: { location: '/b' } },
      'https://example.com/b': { status: 200, body: '<html>ok</html>', headers: { 'content-type': 'text/html' } },
    })
    const ok = await SF.safeFetch('https://example.com/a', { lookup: pub })
    t('relative redirects are followed to a 200', ok.status === 200 && (await ok.text()).includes('ok') && calls.length === 2)

    const loop = {}
    for (let i = 0; i < 10; i++) loop[`https://example.com/r${i}`] = { status: 302, headers: { location: `/r${i + 1}` } }
    calls.length = 0
    route(loop)
    t('more than 5 redirects is an error', await rejects(SF.safeFetch('https://example.com/r0', { lookup: pub })) && calls.length === 6)

    route({ 'https://example.com/s': { status: 302, headers: { location: 'gopher://example.com/' } } })
    t('a redirect to a non-http scheme is rejected', await rejects(SF.safeFetch('https://example.com/s', { lookup: pub })))
  } finally {
    globalThis.fetch = realFetch
  }

  const enrich = src('netlify/functions/enrich-prospects-background.js')
  t('enrich verifyWebsite uses safeFetch (no redirect:follow fetch left)',
    /require\('\.\/_safe-fetch'\)/.test(enrich) && /await safeFetch\(target,/.test(enrich) && !/redirect: 'follow'/.test(enrich))
  const events = src('netlify/functions/research-district-events-background.js')
  t('district-events page enrichment uses safeFetch',
    /import \{ safeFetch \} from '\.\/_safe-fetch\.js'/.test(events) && /await safeFetch\(e\.url,/.test(events) && !/redirect: 'follow'/.test(events))
}

// ─── enrich-prospects: exact seat matching ───────────────────────────────────
console.log('enrich-prospects — officeMatchesSeat')
{
  const { officeMatchesSeat: m } = require('../netlify/functions/enrich-prospects-background.js')
  t('"District 1" matches "Assembly District 1"', m('Assembly District 1', 'District 1'))
  t('"District 1" does NOT match District 10–19', !m('Assembly District 12', 'District 1') && !m('Assembly District 19', 'District 1'))
  t('"Assembly District 10" does NOT match "Assembly District 100"', !m('Assembly District 100', 'Assembly District 10'))
  t('trailing text after the seat is fine', m('State Assembly District 1 (special election)', 'Assembly District 1'))
  t('needle glued to a preceding word does not match', !m('XDistrict 1', 'District 1'))
  t('regex metacharacters in the needle are literal', m('a.b', 'a.b') && !m('axb', 'a.b'))
  const s = src('netlify/functions/enrich-prospects-background.js')
  t('contests are post-filtered with officeMatchesSeat', /rawContests\.filter\(c => officeMatchesSeat\(c\.office, needle\)\)/.test(s))
}

// ─── auto-regenerate-dossiers: monitoring slots ──────────────────────────────
console.log('auto-regenerate-dossiers — monitoring slot entitlement')
{
  const AR = await import('../netlify/functions/auto-regenerate-dossiers.js')
  const { monitoringSlotLimit: lim, selectEntitledCandidates: pick } = AR
  t('slot limits mirror enforce_monitoring_cap',
    lim('scout') === 0 && lim('c_monitor') === 0 && lim('c_active') === 1 && lim('c_campaign') === 3 &&
    lim('a_monitor') === Infinity && lim('a_campaign') === Infinity)

  const cands = [
    { id: 'c3', created_by: 'u1', created_at: '2026-03-01' },
    { id: 'c1', created_by: 'u1', created_at: '2026-01-01' },
    { id: 'c2', created_by: 'u1', created_at: '2026-02-01' },
    { id: 'd1', created_by: 'u2', created_at: '2026-01-01' },
    { id: 'e1', created_by: 'u3', created_at: '2026-01-01' },
    { id: 'e2', created_by: 'u3', created_at: '2026-01-02' },
    { id: 'n1', created_by: null, created_at: '2026-01-01' },
    { id: 'x1', created_by: 'u4', created_at: '2026-01-01' },
  ]
  const ids = pick(cands, { u1: 1, u2: 0, u3: Infinity }).map(c => c.id).sort()
  t('1-slot owner keeps only their OLDEST monitored candidate', ids.includes('c1') && !ids.includes('c2') && !ids.includes('c3'))
  t('0-slot owner is skipped entirely', !ids.includes('d1'))
  t('unlimited owner keeps every candidate', ids.includes('e1') && ids.includes('e2'))
  t('ownerless rows and unresolved owners are skipped (fail closed)', !ids.includes('n1') && !ids.includes('x1'))
  t('selection is deterministic regardless of input order',
    JSON.stringify(pick([...cands].reverse(), { u1: 2 }).map(c => c.id)) === JSON.stringify(['c1', 'c2']))

  const { resolveEntitlement } = require('../netlify/functions/_entitlements.js')
  const expired = { email: 'x@example.test', app_metadata: { plan: 'scout', trial_plan: 'c_campaign', trial_ends_at: '2020-01-01T00:00:00Z' } }
  const beta    = { email: 'y@example.test', app_metadata: { beta_mode: true } }
  t('expired-trial owner resolves to 0 slots', lim((await resolveEntitlement(expired, { globalBeta: true })).plan) === 0)
  t('beta owner resolves to unlimited slots', lim((await resolveEntitlement(beta, { globalBeta: true })).plan) === Infinity)

  const s = src('netlify/functions/auto-regenerate-dossiers.js')
  t('owner lookups are deduped per owner, not per candidate',
    /new Set\(candidates\.map\(c => c\.created_by\)\.filter\(Boolean\)\)/.test(s) && /resolveEntitlement\(await uRes\.json\(\), \{ globalBeta \}\)/.test(s))
  t('only entitled candidates get dossier-age checks', /await Promise\.all\(entitled\.map\(/.test(s))
}

// ─── monitoring-digest: stale weekly_digest + concurrency ────────────────────
console.log('monitoring-digest — stale digest + bounded concurrency')
{
  const s = src('netlify/functions/monitoring-digest.js')
  t('weekly_digest is only used when the dossier is ≤ 8 days old',
    /const DIGEST_MAX_AGE_DAYS = 8/.test(s) && /fresh\s*\n?\s*\? \(d\.weekly_digest \|\|/.test(s) && !/digest: d\.weekly_digest \|\|/.test(s))
  t('owners are processed through a bounded pool', /const OWNER_CONCURRENCY\s+= 5/.test(s) && /mapLimit\(Object\.entries\(byOwner\), OWNER_CONCURRENCY/.test(s))
  t('owner email lookups are pooled too', /mapLimit\(Object\.keys\(byOwner\), OWNER_CONCURRENCY/.test(s))
  t('Resend sends are spaced', /spacedSend\(\(\) => fetch\('https:\/\/api\.resend\.com\/emails'/.test(s))
}

// ─── research-district-history: canonical labels ─────────────────────────────
console.log('research-district-history — labels derived from district_key')
{
  const { canonicalDistrict: cd } = await import('../netlify/functions/research-district-history.js')
  t('assembly key → canonical office label', cd('assembly-85')?.office === 'State Representative, Assembly District 85')
  t('senate / congress / statewide keys resolve',
    cd('senate-33')?.name === 'State Senate District 33' && cd('congress-8')?.layer === 'congress' && cd('state-wi')?.office === 'U.S. Senator for Wisconsin')
  t('multi-word county keys resolve', cd('county-St. Croix')?.name === 'St. Croix County' && cd('county-Fond du Lac')?.layer === 'county')
  t('out-of-range / unknown / prototype keys are rejected',
    cd('assembly-100') === null && cd('senate-34') === null && cd('congress-0') === null && cd('county-Atlantis') === null &&
    cd('county-toString') === null && cd('assembly-01') === null && cd('') === null)
  const s = src('netlify/functions/research-district-history.js')
  t('client district_name / office_label / layer are no longer read',
    !/rawDistrictName|rawOfficeLabel/.test(s) && /const \{ layer, name: district_name, office: office_label \} = canonical/.test(s))
}

// ─── research-district-events: canonical area ────────────────────────────────
console.log('research-district-events — area derived from district_key')
{
  const s = src('netlify/functions/research-district-events-background.js')
  // The module imports JSON (bundler-only), so evaluate the pure helper alone.
  const body = s.slice(s.indexOf('const DISTRICT_LABEL'), s.indexOf('/** Build a per-county source brief'))
    .replace('export function canonicalEventArea', 'function canonicalEventArea')
  const places = JSON.parse(src('public/geodata/wi-district-places.json'))
  const area = new Function('DISTRICT_PLACES', `${body}\nreturn canonicalEventArea`)(places)
  const a85 = area('assembly-85')
  t('district key → canonical name + counties from the places dataset',
    a85?.name === 'Assembly District 85' && JSON.stringify(a85.counties) === JSON.stringify(places['assembly-85'].counties))
  t('county key resolves', area('county-Eau Claire')?.name === 'Eau Claire County')
  const [cityCounty, cityName] = Object.entries(places)
    .filter(([k]) => k.startsWith('county-'))
    .flatMap(([k, v]) => (v.places || []).map(p => [k.slice(7), p]))
    .find(([c, p]) => / /.test(p) && / /.test(c)) || []
  t(`multi-word city + county key resolves (${cityName}, ${cityCounty})`,
    !!cityName && area(`city-${cityName}-${cityCounty}`)?.name === `${cityName}, WI` &&
    area(`city-${cityName}-${cityCounty}`)?.counties?.[0] === cityCounty)
  t('unknown keys / cities not in that county are rejected',
    area('assembly-100') === null && area('city-Madison-Marathon') === null && area('county-constructor') === null && area('x') === null)
  t('client district_name / area_description / counties / district_lean are not read',
    !/rawName|rawArea|rawCounties/.test(s) && /const district_lean\s+= null/.test(s) && /const district_name\s+= canonical\.name/.test(s))
}

// ─── support-chat: conversation trimming ─────────────────────────────────────
console.log('support-chat — cleanConversation')
{
  const { cleanConversation: cc } = await import('../netlify/functions/support-chat.js')
  const long = []
  for (let i = 0; i < 31; i++) long.push({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` })
  // 31 turns starting with user → slice(-30) starts on an assistant turn
  const out = cc(long)
  t('a window that starts on an assistant turn is trimmed to start with user',
    out.messages?.[0]?.role === 'user' && out.messages.length === 29 && out.messages.at(-1).content === 'm30')
  t('bad roles are rejected', cc([{ role: 'system', content: 'x' }]).error === 'Invalid message role')
  t('must end on a user turn', !!cc([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }]).error)
  t('assistant-only input is an error, not an empty call', !!cc([{ role: 'assistant', content: 'b' }]).error)
  t('content is capped at 4000 chars', cc([{ role: 'user', content: 'x'.repeat(5000) }]).messages[0].content.length === 4000)
}

// ─── _result-notify: paged subscription reads ────────────────────────────────
console.log('_result-notify — selectAllPages')
{
  const { selectAllPages } = require('../netlify/functions/_result-notify.js')
  const rows = Array.from({ length: 2345 }, (_, i) => ({ id: String(i).padStart(5, '0') }))
  const ranges = []
  const build = () => {
    const q = {
      order() { return q },
      range(a, b) { ranges.push([a, b]); return Promise.resolve({ data: rows.slice(a, b + 1), error: null }) },
    }
    return q
  }
  const res = await selectAllPages(build)
  t('pages past the 1000-row cap until a short page', res.data.length === 2345 && ranges.length === 3 && ranges[2][0] === 2000)
  const errBuild = () => ({ order() { return this }, range: async () => ({ data: null, error: { message: 'boom' } }) })
  t('an error on any page is surfaced', (await selectAllPages(errBuild)).error?.message === 'boom')
  const s = src('netlify/functions/_result-notify.js')
  t('subscriptions and results are both read through selectAllPages',
    /selectAllPages\(\(\) => sb\s*\n\s*\.from\('election_subscriptions'\)/.test(s) && /selectAllPages\(\(\) => sb\s*\n\s*\.from\('election_results'\)/.test(s))
}

// ─── source assertions: auth / gating fixes ──────────────────────────────────
console.log('source — X feed, AI lock, handoffs, storage setup')
{
  const x = src('netlify/functions/fetch-candidate-x-feed.js')
  const { RATE_LIMITS } = require('../netlify/functions/_rate-limit.js')
  t('X feed is rate limited under its own registered key',
    /enforceRateLimit\(user\.id, 'fetch-candidate-x-feed', CORS\)/.test(x) && RATE_LIMITS['fetch-candidate-x-feed']?.perMinute > 0)
  t('X feed is plan-gated on socialLinks via the entitlement resolver',
    /resolveEntitlement\(user\)/.test(x) && /hasFeature\(plan, 'socialLinks'\)/.test(x))
  t('X feed checks candidate ownership when a candidate id is sent', /created_by=eq\.\$\{encodeURIComponent\(user\.id\)\}/.test(x))
  const tiers = await import('../src/lib/tiers.js')
  t('socialLinks is off on Scout and on for every paid plan',
    !tiers.hasFeature('scout', 'socialLinks') && ['c_monitor', 'c_active', 'c_campaign', 'a_monitor', 'a_active', 'a_campaign'].every(p => tiers.hasFeature(p, 'socialLinks')))

  const lock = src('netlify/functions/candidate-ai-lock.js')
  t('AI lock refuses NULL-owner candidates', /if \(!cand\.created_by \|\| cand\.created_by !== user\.id\)/.test(lock) && !/if \(cand\.created_by && cand\.created_by !== user\.id\)/.test(lock))
  t('AI lock writes are scoped to the owner', (lock.match(/\.eq\('created_by', user\.id\)/g) || []).length === 2)

  const ho = src('netlify/functions/profile-handoff.js')
  t('handoff open re-checks status, expiry AND the Campaign Connect link',
    /if \(!isLive\(h, now\)\)/.test(ho) && /activeLinkIds\(\[h\.link_id\]\)\)\.has\(h\.link_id\)/.test(ho))
  t('handoff inbox hides handoffs whose link is no longer active', /live\.filter\(h => links\.has\(h\.link_id\)\)/.test(ho))
  t('handoff uses per-request CORS (H.CORS was undefined)', /const CORS = H\.cors\(event\)/.test(ho) && !/headers: H\.CORS/.test(ho))
  const cc = src('netlify/functions/campaign-connect.js')
  t('revoking a link revokes its active handoffs', /profile_handoffs\?link_id=eq\.\$\{enc\(link\.id\)\}&status=eq\.active`, 'PATCH', \{ status: 'revoked' \}/.test(cc))

  const st = src('netlify/functions/admin-setup-candidate-storage.js')
  t('storage setup no longer calls rpc/exec_sql', !/rest\/v1\/rpc\/exec_sql/.test(st) && !/CREATE POLICY IF NOT EXISTS/.test(st))
  t('storage setup stays admin-gated', /ADMIN_EMAILS\.includes\(user\.email\.toLowerCase\(\)\)/.test(st) && /Admin access required/.test(st))
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
