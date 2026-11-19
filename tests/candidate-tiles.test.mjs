// tests/candidate-tiles.test.mjs — the Candidate-plan Candidates page (v2.0
// tiles, Nov 19 2026): tile ordering + "new this week", the add sheet's
// lookup → form → insert mapping, the candidate lookup turned back on for
// Candidate plans (client + server), and the lookup's site-photo helper.
// Prints "N passed, M failed".
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8')

let passed = 0, failed = 0
const t = (n, c, d) => { if (c) { passed++; console.log('  ✓ ' + n) } else { failed++; console.log('  ✗ ' + n + (d ? ' — ' + d : '')) } }

const H = await import('../src/pages/candidates/helpers.js')
const T = await import('../src/lib/tiers.js')

console.log('\n[1] tile order: you first, then everyone else by name')
{
  const cs = [{ id: 'b', name: 'Zed' }, { id: 'a', name: 'amy' }, { id: 'me', name: 'Moe' }]
  const o = H.orderForTiles(cs, 'me').map(c => c.id)
  t('self first', o[0] === 'me')
  t('others by name, case-insensitive', o[1] === 'a' && o[2] === 'b')
  t('no self → just by name', H.orderForTiles(cs, null).map(c => c.id).join() === 'a,me,b')
  t('unknown self id → by name', H.orderForTiles(cs, 'nope').length === 3)
  t('does not mutate the input', cs[0].id === 'b')
}

console.log('\n[2] "new this week" dot (latest weekly digest, this week, with items)')
{
  const now = new Date('2026-11-19T15:00:00')            // a Thursday
  const mon = new Date('2026-11-16T09:00:00').toISOString()
  const lastWeek = new Date('2026-11-12T09:00:00').toISOString()
  const ds = [
    { candidate_id: 'x', generated_at: mon, weekly_digest: { summary: 's', items: [{}, {}] } },
    { candidate_id: 'x', generated_at: lastWeek, weekly_digest: { summary: 's', items: [{}, {}, {}, {}] } },
    { candidate_id: 'y', generated_at: lastWeek, weekly_digest: { summary: 's', items: [{}] } },
    { candidate_id: 'z', generated_at: mon, weekly_digest: { summary: 's', items: [] } },
    { candidate_id: 'w', generated_at: mon, weekly_digest: null },
  ]
  t('this week\'s digest items are counted', H.newThisWeekCount(ds, 'x', now) === 2)
  t('a digest from last week is not "new this week"', H.newThisWeekCount(ds, 'y', now) === 0)
  t('an empty digest → no dot', H.newThisWeekCount(ds, 'z', now) === 0)
  t('a profile with no digest → no dot', H.newThisWeekCount(ds, 'w', now) === 0)
  t('no dossiers → 0', H.newThisWeekCount(undefined, 'x', now) === 0)
  t('week starts Monday: Sunday belongs to the week before', !H.isInWeekOf('2026-11-15T12:00:00', now) && H.isInWeekOf('2026-11-16T00:30:00', now))
}

console.log('\n[3] office text')
{
  const offices = [
    { id: 'o37', name: 'Wisconsin State Assembly — District 37', district_number: '37' },
    { id: 'o3', name: 'Wisconsin State Assembly — District 3', district_number: '3' },
    { id: 'm12', name: 'Marathon County Board Supervisor — District 12', district_number: '12', county: 'Marathon' },
    { id: 'gov', name: 'Governor of Wisconsin' },
    { id: 'dn', name: 'Village Trustee', district_name: 'Seat 2', county: 'Dane' },
  ]
  t('label does not repeat "District N"', H.officeOptionLabel(offices[0]) === 'Wisconsin State Assembly — District 37')
  t('label adds a district name and county the name lacks', H.officeOptionLabel(offices[4]) === 'Village Trustee — Seat 2 · Dane County')
  t('search: every word must appear', H.searchOffices('assembly 37', offices).map(h => h.office.id).join() === 'o37')
  t('search: numbers match whole numbers ("3" is not "37")', H.searchOffices('assembly 3', offices).map(h => h.office.id).join() === 'o3')
  t('search: needs 2+ characters', H.searchOffices('a', offices).length === 0)
  t('search: punctuation-insensitive', H.searchOffices('marathon county board, district 12', offices)[0]?.office.id === 'm12')
  t('exact label match → office', H.matchOffice('wisconsin state assembly — district 37', offices)?.id === 'o37')
  t('bare-name match → office', H.matchOffice('Governor of Wisconsin', offices)?.id === 'gov')
  t('loose text → no office', H.matchOffice('assembly 37', offices) === null)
  t('tile line: linked office wins', H.tileOfficeLine({ office: offices[0], research_context: 'Running for: x' }) === 'Wisconsin State Assembly — District 37')
  t('tile line: typed office from research_context', H.tileOfficeLine({ office: null, research_context: 'Lives in Wausau\nRunning for: Wausau City Council' }) === 'Wausau City Council')
  t('tile line: nothing known → null (no dead data)', H.tileOfficeLine({ office: null, research_context: 'paramedic' }) === null)
}

console.log('\n[4] links and handles')
{
  t('url: adds https', H.cleanUrl('janeforwi.com') === 'https://janeforwi.com/')
  t('url: keeps a full link', H.cleanUrl('https://x.org/a?b=1') === 'https://x.org/a?b=1')
  t('url: junk → ""', H.cleanUrl('not a url') === '' && H.cleanUrl('javascript:alert(1)') === '' && H.cleanUrl('') === '')
  t('X: @handle', H.cleanXHandle('JaneForWI') === '@JaneForWI' && H.cleanXHandle('@JaneForWI') === '@JaneForWI')
  t('X: profile links', H.cleanXHandle('https://x.com/JaneForWI') === '@JaneForWI' && H.cleanXHandle('twitter.com/JaneForWI/status/1') === '@JaneForWI')
  t('X: junk → ""', H.cleanXHandle('jane for wi!') === '' && H.cleanXHandle('a'.repeat(16)) === '')
  t('photo: https only', H.cleanPhotoUrl('https://cdn.x.org/p.jpg') === 'https://cdn.x.org/p.jpg' && H.cleanPhotoUrl('http://x.org/p.jpg') === '' && H.cleanPhotoUrl('data:image/png;base64,AA') === '')
}

console.log('\n[5] lookup response → form')
{
  // The shape autofill-candidate returns: nulls already stripped.
  const r = H.lookupToForm({
    website: 'janeforwi.com', twitter_handle: 'https://x.com/JaneForWI', facebook_url: 'facebook.com/JaneForWI',
    party: 'Democratic', photo_url: 'https://janeforwi.com/og.jpg',
    email: 'jane@janeforwi.com', occupation: 'Teacher', bio_summary: '  Long bio.  ', notes: 'Verify everything.',
    unknown_key: 'ignored', instagram_handle: 42,
  })
  t('party normalized to the DB spelling', r.patch.party === 'Democrat')
  t('website / X / Facebook cleaned', r.patch.website === 'https://janeforwi.com/' && r.patch.twitter_handle === '@JaneForWI' && r.patch.facebook_url === 'https://facebook.com/JaneForWI')
  t('photo kept (https)', r.patch.photo_url === 'https://janeforwi.com/og.jpg')
  t('found lists exactly the filled form fields', r.found.sort().join() === ['facebook_url', 'party', 'photo_url', 'twitter_handle', 'website'].sort().join())
  t('extras: known columns only, trimmed, non-strings dropped', r.extras.email === 'jane@janeforwi.com' && r.extras.bio_summary === 'Long bio.' && !('unknown_key' in r.extras) && !('instagram_handle' in r.extras))
  t('note carried', r.note === 'Verify everything.')
  const bad = H.lookupToForm({ party: 'Pirate', photo_url: 'http://x.org/a.jpg', website: 'nope' })
  t('unusable values are dropped, not shown', Object.keys(bad.patch).length === 0 && bad.found.length === 0)
  t('missing / non-object fields → empty', H.lookupToForm(undefined).found.length === 0 && H.lookupToForm('x').found.length === 0)
}

console.log('\n[6] form → insert payload')
{
  const offices = [{ id: 'o37', name: 'Wisconsin State Assembly — District 37', district_number: '37' }]
  const p = H.buildCandidatePayload({ name: '  Jane Smith ', office_text: 'Wausau City Council', party: 'dem' })
  t('name trimmed, status exploring', p.name === 'Jane Smith' && p.status === 'exploring')
  t('party normalized', p.party === 'Democrat')
  t('unmatched office text → research_context "Running for: …"', p.research_context === 'Running for: Wausau City Council' && !('office_id' in p))
  t('runningForFrom reads it back', H.runningForFrom(p.research_context) === 'Wausau City Council')
  t('blank fields are left out entirely (photo_url never sent empty)', !('photo_url' in p) && !('website' in p) && !('election_id' in p) && !('twitter_handle' in p))
  const q = H.buildCandidatePayload({ name: 'A', office_text: 'Wisconsin State Assembly — District 37' }, { offices })
  t('typed text matching an office → office_id', q.office_id === 'o37' && !('research_context' in q))
  const r = H.buildCandidatePayload({ name: 'A', office_id: 'picked', office_text: 'whatever', photo_url: 'https://x.org/p.jpg', twitter_handle: 'JaneForWI', election_id: 'e1' },
    { extras: { email: 'a@b.co', evil_column: 'x', occupation: '  ' } })
  t('picked office id wins', r.office_id === 'picked')
  t('photo, handle, election carried', r.photo_url === 'https://x.org/p.jpg' && r.twitter_handle === '@JaneForWI' && r.election_id === 'e1')
  t('extras: only known columns with text', r.email === 'a@b.co' && !('evil_column' in r) && !('occupation' in r))
  t('never writes created_by / section_timestamps / notes', !('created_by' in r) && !('section_timestamps' in r) && !('notes' in r))
}

console.log('\n[7] photo_url before its migration')
{
  const pgrst = { code: 'PGRST204', message: "Could not find the 'photo_url' column of 'candidates' in the schema cache" }
  t('PostgREST missing-column error is recognized', H.isMissingColumnError(pgrst, 'photo_url'))
  t('postgres 42703 wording too', H.isMissingColumnError({ message: 'column "photo_url" of relation "candidates" does not exist' }, 'photo_url'))
  t('other errors are not', !H.isMissingColumnError({ message: 'new row violates row-level security policy' }, 'photo_url') && !H.isMissingColumnError(null, 'photo_url'))
  const w = H.withoutColumn({ name: 'A', photo_url: 'https://x' }, 'photo_url')
  t('withoutColumn drops just that key', w.name === 'A' && !('photo_url' in w))
  t('migration adds the column idempotently', /ADD COLUMN IF NOT EXISTS photo_url TEXT/.test(read('supabase/migrations/20261119000000_candidate_photo_url.sql')))
}

console.log('\n[8] small words')
{
  t('first add on an empty page defaults to "This is me"', H.defaultRole([]) === 'self' && H.defaultRole([{}]) === 'opponent')
  t('lookup failures say what happened', /sign-in expired/.test(H.lookupFailureMessage(401)) && /a lot of lookups/.test(H.lookupFailureMessage(429)) && /couldn’t reach/.test(H.lookupFailureMessage(500)))
  t('a 403 passes the server sentence through', H.lookupFailureMessage(403, 'Nope.') === 'Nope.')
}

console.log('\n[9] lookup is back on for Candidate plans; discovery + CSV stay off')
for (const k of T.CANDIDATE_PLAN_ORDER) {
  t(`${k}: autofill on, discovery + CSV import off`, T.hasFeature(k, 'autofill') && !T.hasFeature(k, 'discoverCandidates') && !T.hasFeature(k, 'csvImport'))
}
t('FAMILY_FEATURES.candidate.autofill === true', T.FAMILY_FEATURES.candidate.autofill === true)
t('server gate follows tiers.js (planAllows)', T.planAllows({ plan: 'c_monitor', source: 'paid' }, 'autofill') && T.planAllows('scout', 'autofill'))

console.log('\n[10] the page wiring')
{
  const page = read('src/pages/Candidates.jsx')
  const tiles = read('src/pages/candidates/CandidateTiles.jsx')
  const sheet = read('src/pages/candidates/AddCandidateSheet.jsx')
  t('Candidates.jsx: Candidate plans get the tiles, Action plans the list', /getUserPlanType\(user\) === 'candidate' \? <CandidateTiles \/> : <CandidatesList \/>/.test(page))
  t('tiles: "which one is you" comes from resolveSelfCandidate', /resolveSelfCandidate\(user, candidates\)/.test(tiles))
  t('tiles: "This is me" pins user_metadata.self_candidate_id', /supabase\.auth\.updateUser\(\{ data: \{ self_candidate_id: c\.id \} \}\)/.test(tiles))
  t('tiles: each opens /candidates/:id', /to=\{`\/candidates\/\$\{c\.id\}`\}/.test(tiles))
  t('tiles: Scout cap closes the add tile', /atScoutCap\s*=\s*tier === 'scout' && candidates\.length >= SCOUT_CANDIDATE_LIMIT/.test(tiles) && /<CapTile/.test(tiles))
  t('tiles: monitoring slots from the unfiltered server count', /contains\('section_timestamps', \{ monitoring: true \}\)/.test(tiles))
  t('tiles: monitoring toggle reverts with the cap sentence', /monitoringToggleError\(err\)/.test(tiles))
  t('sheet: name search first, calls autofill-candidate', /Who are you adding\?/.test(sheet) && /'\/\.netlify\/functions\/autofill-candidate'/.test(sheet) && />\s*\{canLookup \? 'Look them up' : 'Continue'\}/.test(sheet))
  t('sheet: the manual form is one click away', /Skip the lookup and fill it in myself/.test(sheet))
  t('sheet: gated on the autofill feature (admin/beta bypass via useFeature)', /useFeature\('autofill'\)/.test(sheet))
  t('sheet: "This is me" pins the new row', /updateUser\(\{ data: \{ self_candidate_id: res\.data\.id \} \}\)/.test(sheet))
  t('sheet: retries without photo_url when the column is missing', /isMissingColumnError\(res\.error, 'photo_url'\)/.test(sheet))
  t('sheet: Scout cap pre-check + trigger sentence', /SCOUT_CANDIDATE_LIMIT/.test(sheet) && /scoutCapMessage\(res\.error\)/.test(sheet))
  t('photos go through the same-origin image proxy (CSP)', /eventImage\(photo/.test(read('src/pages/candidates/Portrait.jsx')))
}

console.log('\n[11] autofill-candidate: site photo + party, gate open for Candidate plans')
{
  process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key'   // read at module load
  const fn = require('../netlify/functions/autofill-candidate.js')
  const { photoFromHtml, findSitePhoto, isFetchablePublicHttps } = fn._photo
  t('og:image (property first)', photoFromHtml('<meta property="og:image" content="https://a.org/x.jpg">', 'https://a.org/') === 'https://a.org/x.jpg')
  t('og:image (content first) + relative → absolute', photoFromHtml('<meta content="/img/x.jpg" property="og:image">', 'https://a.org/about') === 'https://a.org/img/x.jpg')
  t('twitter:image fallback, &amp; decoded', photoFromHtml('<meta name="twitter:image" content="https://a.org/x.jpg?a=1&amp;b=2">', 'https://a.org/') === 'https://a.org/x.jpg?a=1&b=2')
  t('http images are refused', photoFromHtml('<meta property="og:image" content="http://a.org/x.jpg">', 'https://a.org/') === null)
  t('no image → null', photoFromHtml('<html></html>', 'https://a.org/') === null)
  t('only public https hosts are fetched', isFetchablePublicHttps('https://janeforwi.com') && !isFetchablePublicHttps('http://janeforwi.com') &&
    !isFetchablePublicHttps('https://169.254.169.254/') && !isFetchablePublicHttps('https://localhost/') && !isFetchablePublicHttps('https://[::1]/') && !isFetchablePublicHttps('nope'))
  const html = (img) => ({ ok: true, url: 'https://janeforwi.com/', headers: { get: () => 'text/html; charset=utf-8' }, text: async () => `<meta property="og:image" content="${img}">` })
  t('findSitePhoto reads the page', await findSitePhoto('https://janeforwi.com', async () => html('https://janeforwi.com/og.jpg')) === 'https://janeforwi.com/og.jpg')
  t('findSitePhoto: non-HTML → null', await findSitePhoto('https://janeforwi.com', async () => ({ ok: true, headers: { get: () => 'application/pdf' }, text: async () => '' })) === null)
  t('findSitePhoto: fetch error → null', await findSitePhoto('https://janeforwi.com', async () => { throw new Error('boom') }) === null)
  t('findSitePhoto: redirect to a private host → null', await findSitePhoto('https://janeforwi.com', async () => ({ ...html('https://x.org/a.jpg'), url: 'https://127.0.0.1/' })) === null)
  t('findSitePhoto: never fetches a non-public URL', await findSitePhoto('http://janeforwi.com', async () => { throw new Error('should not fetch') }) === null)

  const src = read('netlify/functions/autofill-candidate.js')
  t('prompt asks for party with the no-guessing rule', /"party": null/.test(src) && /Do not guess it from the office/.test(src))
  t('a model-written photo_url is discarded', /delete populated\.photo_url/.test(src))

  // Handler, end to end with every network call stubbed.
  process.env.SUPABASE_URL = 'https://example.supabase.co'
  process.env.SUPABASE_ANON_KEY = 'anon'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-dummy'
  const realFetch = global.fetch
  let plan = 'c_monitor'
  const seen = []
  global.fetch = async (url) => {
    const u = String(url)
    seen.push(u)
    if (u.includes('/auth/v1/user')) return { ok: true, status: 200, json: async () => ({ id: '44444444-4444-4444-8444-444444444444', email: 'cand@example.com', app_metadata: { plan } }) }
    if (u.includes('api.anthropic.com')) {
      const fields = { website: 'https://janeforwi.com', twitter_handle: '@JaneForWI', party: 'Democrat', photo_url: 'https://made-up.example/face.jpg', email: null, notes: 'Verify.' }
      return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: JSON.stringify(fields) }], usage: { input_tokens: 1, output_tokens: 1 } }) }
    }
    if (u.startsWith('https://janeforwi.com')) return html('https://janeforwi.com/headshot.jpg')
    return { ok: false, status: 500, json: async () => ({}), text: async () => 'stub', headers: { get: () => null } }
  }
  const { handler } = fn
  const call = (body) => handler({ httpMethod: 'POST', headers: { authorization: 'Bearer tok' }, body: JSON.stringify(body) })
  const r1 = await call({ name: 'Jane Smith', office: 'Wausau City Council' })
  t('c_monitor passes the plan gate now and gets an answer', r1.statusCode === 200, `got ${r1.statusCode} ${r1.body}`)
  const body = JSON.parse(r1.body || '{}')
  t('party comes back', body.fields?.party === 'Democrat')
  t('photo is the site\'s share image, not the model\'s link', body.fields?.photo_url === 'https://janeforwi.com/headshot.jpg')
  t('the site fetched was the found website', seen.some(u => u.startsWith('https://janeforwi.com')))
  t('null fields stripped', !('email' in (body.fields || {})))
  plan = 'scout'
  const r2 = await call({ name: 'Jane Smith' })
  t('scout passes the plan gate too', r2.statusCode === 200, `got ${r2.statusCode}`)
  global.fetch = realFetch
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) process.exitCode = 1
