// tests/candidate-profile.test.mjs — the Nov 2026 candidate profile redesign.
//
//   [1-9]   src/pages/candidate/intelModel.js — reading the v5 profile:
//           snapshot, controversies, attack & defense, SWOT, feeds, X handle,
//           races, record in office, roles, overdue refresh
//   [10-12] netlify/functions/fetch-candidate-x-feed.js — Grok x_search,
//           cache-first, fabricated posts dropped (fetch stubbed)
//   [13-14] netlify/functions/research-swot.js — evidence-backed, ranked,
//           perspective-aware SWOT (model stubbed)
//   [15]    page wiring — Profile Data gone, history ungated, results hidden
//           while RESULTS_ENABLED is off, no AI call on Overview open
//
// Prints "N passed, M failed" for scripts/run-unit-tests.mjs.
import { createRequire } from 'node:module'
import { readFileSync, existsSync } from 'node:fs'

const require = createRequire(import.meta.url)
const M = await import('../src/pages/candidate/intelModel.js')
const root = new URL('..', import.meta.url)
const src = (p) => readFileSync(new URL(p, root), 'utf8')
// Source with comments removed — "is this still SHOWN / wired?", not "is it mentioned in a note?"
const code = (p) => src(p).replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

let passed = 0, failed = 0
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name) }
  else { failed++; console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')) }
}
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`)

// A fictional profile in the v5 format (_profile-prompt.js).
const PROFILE = `## PROFILE SNAPSHOT
Jane Doe is a Marathon County dairy farmer and two-term town supervisor running for the 85th Assembly District. She is known locally for the 2023 fight over the county landfill expansion.

## SECTION 1: NEWS & MEDIA COVERAGE
**[HIGH]**

### [Doe announces Assembly run](https://wausaupilot.com/doe-run)
**Wausau Pilot & Review** · March 3, 2026
Doe launched her campaign at the Rib Mountain town hall. **[KNOWN]**

### Landfill vote splits town board
**WSAW** · Oct 2, 2023
Doe cast the deciding vote against the expansion. **[Verify]**

#### Coverage gaps
- [RESEARCH REQUIRED] No debate coverage found

## SECTION 2: BIOGRAPHY & BACKGROUND
**[HIGH]**

| Field | Value | Source |
|---|---|---|
| Name | Jane Doe | ballotpedia |

## SECTION 4: POLITICAL RECORD
**[HIGH]**

| Year | Office | Result | Votes / % | Margin | Opponent | Source |
|---|---|---|---|---|---|---|
| 2023 | Town of Rib Mountain Supervisor | Won | 1,204 / 58% | 16 pts | Tom Roe | https://ribmountainwi.gov/results |
| 2021 | Marathon County Board D12 | Lost | 880 / 44% | — | Al Poe | WSAW |
| NOT FOUND | | | | | | |

**Committees:** Town Plan Commission (2023–present).
**Key votes & actions:**
- Oct 2, 2023 · Landfill expansion · voted no · deciding vote · https://ribmountainwi.gov/minutes
- date · bill or action · their vote · why it matters · source

## SECTION 6: CONTROVERSIES & OPPOSITION RESEARCH
**[MEDIUM]**

| Issue | Date | What the record shows | Source | Their response | Status | Research priority | Confidence |
|---|---|---|---|---|---|---|---|
| Late property tax | 2022 | Paid 2021 property taxes 4 months late. | https://co.marathon.wi.us/treasurer | Says it was a bank error | Resolved | RESEARCH PRIORITY: LOW | [KNOWN] |
| Farm runoff citation | Jun 2024 | DNR cited the farm for manure runoff. | https://dnr.wi.gov/case/123 | None sought | Open | RESEARCH PRIORITY: HIGH | [Confirmed] |

**CAMPAIGN FINANCE MATTERS:** No violations found. **[KNOWN]**

**INCONSISTENCIES IN PUBLIC RECORD:** Said she opposed the landfill in 2021, but her 2021 mailer supported it. **[Verify]** — RESEARCH PRIORITY: MEDIUM.

## SECTION 10: SOCIAL POSTS
**[MEDIUM]**

### [Launch day post](https://x.com/janedoe4wi/status/1890000000000000001)
**X / @janedoe4wi** · March 3, 2026
"We're in it to win it." Sentiment: +. Flag: Endorsement. **[X/Live]**

## SECTION 11: DIGITAL FOOTPRINT
**[MEDIUM]**

| Platform | Handle / URL | Activity | Notes |
|---|---|---|---|
| X | @janedoe4wi | Active | campaign |

## SECTION 12: NARRATIVE & PUBLIC PERCEPTION
**[MEDIUM]**

**SWOT Analysis**
Bullets only.

- **Strengths** (advantages right now):
  - Won her last town race by 16 points. [KNOWN]
- **Weaknesses** (documented vulnerabilities):
  - DNR runoff citation is still open. [Confirmed]
  - [bullet]
- **Opportunities**:
  - Open seat after the incumbent retired. [KNOWN]
- **Threats**:
  - Lost the 2021 county board race. [KNOWN]

## SECTION 13: ATTACK & DEFENSE
**[MEDIUM]**

**Attack angles (what an opponent would use):**

| Vulnerability | Evidence | Likely framing | Source |
|---|---|---|---|
| Environmental record | DNR runoff citation, Jun 2024 | "Doe polluted the river she wants to protect" | dnr.wi.gov |
| Flip-flop on landfill | 2021 mailer vs 2023 vote | 'Says one thing, votes another' | WSAW |

**Defense prep (what this candidate should have ready):**

| Likely attack | Truth / context | Suggested response | Source |
|---|---|---|---|
| "Polluter" | Citation was for a 2-hour overflow during a storm | Show the remediation and the clean follow-up inspection | dnr.wi.gov |
| "Flip-flopper" | The 2021 mailer was the party's | Point to the deciding vote itself | WSAW |

## SECTION 14: VERIFICATION & RESEARCH GAPS
**[MEDIUM]**
`

// ═══ 1 — snapshot ══════════════════════════════════════════════════════════
console.log('\n[1] profileSnapshot')
{
  check('reads the v5 PROFILE SNAPSHOT', M.profileSnapshot(PROFILE).startsWith('Jane Doe is a Marathon County dairy farmer'))
  const trailing = PROFILE.replace(/## PROFILE SNAPSHOT\n[^\n]+\n\n/, '') + '\n---\n## PROFILE SNAPSHOT\n\nTrailing snapshot sentence that describes the candidate.\n\nCANDIDATE_UPDATES:\n```json\n{}\n```'
  eq('a snapshot appended after Section 14 (older runs) is read too, and stops before CANDIDATE_UPDATES', M.profileSnapshot(trailing), 'Trailing snapshot sentence that describes the candidate.')
  const noSnap = '## SECTION 2: BIOGRAPHY\n**[HIGH]**\n\n| a | b |\n|---|---|\n| x | y |\n\nShe grew up on the family farm outside Wausau and took it over in 2009, then ran for town board after the landfill fight.'
  check('falls back to the first narrative paragraph of Section 2', /^She grew up on the family farm/.test(M.profileSnapshot(noSnap)))
  eq('the unfilled template line is not a snapshot', M.profileSnapshot('## PROFILE SNAPSHOT\n(2–3 sentences, max 60 words — see format rules.)\n'), '')
}

// ═══ 2 — controversies ═════════════════════════════════════════════════════
console.log('\n[2] parseControversies (Section 6)')
{
  const c = M.parseControversies(PROFILE)
  eq('table rows + the labelled inconsistency, highest priority first', c.map(x => x.issue), ['Farm runoff citation', 'Inconsistencies In Public Record', 'Late property tax'])
  check('"No violations found" paragraphs are not controversies', !c.some(x => /campaign finance/i.test(x.issue)))
  const runoff = c[0]
  check('date, summary, source url, priority, status, confidence carried', runoff.date === 'Jun 2024' && /DNR cited/.test(runoff.summary) && runoff.url === 'https://dnr.wi.gov/case/123' && runoff.priority === 'HIGH' && runoff.status === 'Open' && runoff.confidence === 'CONFIRMED', JSON.stringify(runoff))
  check('"None sought" is not shown as a response', runoff.response === '')
  check('a real response is kept', c[2].response === 'Says it was a bank error')
  check('priority read from the status/priority cell text', c[1].priority === 'MEDIUM' && !/RESEARCH PRIORITY/.test(c[1].summary), JSON.stringify(c[1]))
  const upsell = '## SECTION 6: CONTROVERSIES & OPPOSITION RESEARCH\n**[RESEARCH REQUIRED]**\n\n*This section is available to Campaign & Agency plan subscribers.*\n\n**RESEARCH FRAMEWORK — items to investigate:**\n- [ ] Campaign finance filings'
  eq('the plan-gated template has no controversies', M.parseControversies(upsell), [])
}

// ═══ 3 — attack & defense ══════════════════════════════════════════════════
console.log('\n[3] parseAttackDefense (Section 13)')
{
  const p = M.parseAttackDefense(PROFILE)
  check('one card per attack', p.length === 2, JSON.stringify(p))
  eq('the attack line is the framing, quotes stripped', p.map(x => x.line), ['Doe polluted the river she wants to protect', 'Says one thing, votes another'])
  check('evidence and source carried', p[0].evidence === 'DNR runoff citation, Jun 2024' && p[0].source === 'dnr.wi.gov')
  check('defense paired by position', p[0].defense.attack === 'Polluter' && /remediation/.test(p[0].defense.response) && p[1].defense.attack === 'Flip-flopper')
  // Unequal tables: pair by shared words.
  const uneven = PROFILE.replace('| "Flip-flopper" | The 2021 mailer was the party\'s | Point to the deciding vote itself | WSAW |\n', '').replace('| "Polluter" |', '| "Landfill flip-flop" | The 2021 mailer was the party\'s | Point to the vote | WSAW |\n| "Polluter" |')
  const q = M.parseAttackDefense(uneven.replace('| Flip-flop on landfill | 2021 mailer vs 2023 vote | \'Says one thing, votes another\' | WSAW |\n', '| Flip-flop on landfill | 2021 mailer vs 2023 vote | \'Says one thing, votes another\' | WSAW |\n| Absentee | Missed 3 meetings | "Never shows up" | minutes |\n'))
  check('uneven tables pair by shared words', q.find(x => x.title === 'Flip-flop on landfill')?.defense?.attack === 'Landfill flip-flop', JSON.stringify(q.map(x => [x.title, x.defense?.attack])))
  const legacy = '## SECTION 13: ATTACK & DEFENSE\n**[MEDIUM]**\n\n- **Attack:** Missed votes\n- **Response:** Was on deployment\n'
  const l = M.parseAttackDefense(legacy)
  check('legacy "Attack: / Response:" prose still reads', l.length === 1 && l[0].line === 'Missed votes' && l[0].defense.response === 'Was on deployment', JSON.stringify(l))
}

// ═══ 4 — SWOT ═════════════════════════════════════════════════════════════
console.log('\n[4] SWOT: profile bullets, stored shapes, ranking')
{
  const s = M.parseProfileSwot(PROFILE)
  eq('Section 12 SWOT bullets by quadrant', [s.strengths.length, s.weaknesses.length, s.opportunities.length, s.threats.length], [1, 1, 1, 1])
  check('confidence badge kept, text cleaned, "[bullet]" template dropped', s.weaknesses[0].point === 'DNR runoff citation is still open.' && s.weaknesses[0].confidence === 'CONFIRMED')

  const legacy = { strengths: '• A\n• B', weaknesses: ['• C', 'D • E'], opportunities: '', threats: null }
  const n = M.normalizeSwot(legacy)
  eq('legacy bullet strings/arrays split into points', [n.strengths.map(x => x.point), n.weaknesses.map(x => x.point)], [['A', 'B'], ['C', 'D', 'E']])
  check('legacy points carry no evidence/impact', n.v === 1 && n.strengths[0].impact === null && n.strengths[0].evidence === '')

  const v2 = { v: 2, perspective: 'self', bottom_line: 'X', weaknesses: [
    { point: 'minor', evidence: 'e1', source: 's', impact: 1, play: 'p' },
    { point: 'major', evidence: 'e2', source: 's', impact: 5, play: 'defend it' },
    { point: 'odd', impact: 9 },
  ] }
  const r = M.normalizeSwot(v2)
  eq('v2 points ranked by impact, impact clamped to 1-5', r.weaknesses.map(x => [x.point, x.impact]), [['major', 5], ['odd', 5], ['minor', 1]])
  check('perspective and bottom line kept', r.perspective === 'self' && r.bottom_line === 'X')

  const eff = M.effectiveSwot(null, PROFILE)
  check('no stored SWOT → the profile\'s own bullets', eff.from === 'profile' && eff.weaknesses[0].point === 'DNR runoff citation is still open.')
  check('stored SWOT wins when it has points', M.effectiveSwot(v2, PROFILE).from === 'stored')
  check('nothing anywhere → from "none"', M.effectiveSwot({}, '').from === 'none')

  const kw = M.keyWeaknesses(eff, ['[RESEARCH REQUIRED]', 'Hand-entered weakness', { text: 'DNR runoff citation is still open.' }])
  eq('key weaknesses = SWOT weaknesses + any hand-entered extras (placeholders, duplicates dropped)', kw.map(x => x.point), ['DNR runoff citation is still open.', 'Hand-entered weakness'])
}

// ═══ 5 — feeds ═════════════════════════════════════════════════════════════
console.log('\n[5] feeds: Section 1 news, Section 10 X posts')
{
  const news = M.profileNews(PROFILE)
  eq('news items, coverage-gap note skipped', news.map(x => x.title), ['Doe announces Assembly run', 'Landfill vote splits town board'])
  check('source, date, url, summary, confidence', news[0].source === 'Wausau Pilot & Review' && news[0].date === 'March 3, 2026' && news[0].url === 'https://wausaupilot.com/doe-run' && /Rib Mountain/.test(news[0].summary) && news[0].confidence === 'KNOWN')
  check('a headline without a link keeps url null', news[1].url === null && news[1].confidence === 'VERIFY')
  const x = M.profileXPosts(PROFILE)
  check('X status links become post cards', x.length === 1 && x[0].id === '1890000000000000001' && x[0].author_username === 'janedoe4wi' && x[0].url === 'https://x.com/janedoe4wi/status/1890000000000000001', JSON.stringify(x))
  check('Sentiment / Flag scaffolding stripped from the post text', !/Sentiment|Flag/.test(x[0].text) && /win it/.test(x[0].text), x[0].text)
  check('"X / @handle" source reads as the handle', x[0].author_name === '@janedoe4wi')
}

// ═══ 6 — X handle ══════════════════════════════════════════════════════════
console.log('\n[6] findXHandle / cleanHandle')
{
  eq('the handle on the record wins', M.findXHandle({ twitter_handle: '@OnRecord' }, PROFILE), 'OnRecord')
  eq('else Section 11\'s X row', M.findXHandle({}, PROFILE), 'janedoe4wi')
  eq('else an x.com link in Section 10', M.findXHandle({}, PROFILE.replace('| X | @janedoe4wi | Active | campaign |\n', '')), 'janedoe4wi')
  eq('nothing → empty', M.findXHandle({}, ''), '')
  eq('x.com URL → handle', M.cleanHandle('https://x.com/janedoe4wi?s=20'), 'janedoe4wi')
  eq('search-operator injection rejected', M.cleanHandle('foo OR from:bar'), '')
  eq('reserved paths are not handles', M.cleanHandle('https://x.com/search?q=x'), '')
}

// ═══ 7 — Section 4 ════════════════════════════════════════════════════════
console.log('\n[7] races, record in office, roles')
{
  const r = M.parseRaceHistory(PROFILE)
  eq('races with outcomes; NOT FOUND row dropped', r.map(x => [x.year, x.outcome]), [['2023', 'won'], ['2021', 'lost']])
  check('votes, margin, opponent, source url', r[0].votes === '1,204 / 58%' && r[0].margin === '16 pts' && r[0].opponent === 'Tom Roe' && r[0].url === 'https://ribmountainwi.gov/results' && r[1].margin === '')
  const o = M.parseOfficeRecord(PROFILE)
  check('committees line read', o.committees === 'Town Plan Commission (2023–present).', o.committees)
  check('key votes read, template line dropped', o.actions.length === 1 && /Landfill expansion/.test(o.actions[0].text) && o.actions[0].url === 'https://ribmountainwi.gov/minutes', JSON.stringify(o.actions))
  const civic = '## SECTION 4: CIVIC & POLITICAL BACKGROUND\n**[MEDIUM]**\n\n| Org / Board / Body | Role | Years | Source |\n|---|---|---|---|\n| Rotary Club | President | 2019–2021 | rotary.org [KNOWN] |\n'
  eq('civic roles table (prospect profiles)', M.parseCivicRoles(civic).map(x => [x.org, x.role, x.years, x.confidence]), [['Rotary Club', 'President', '2019–2021', 'KNOWN']])
  eq('a race table is not a roles table', M.parseCivicRoles(PROFILE), [])
  eq('a roles table is not a race table', M.parseRaceHistory(civic), [])
}

// ═══ 8 — overdue refresh ═══════════════════════════════════════════════════
console.log('\n[8] refreshOverdue')
{
  const now = new Date('2026-11-19T12:00:00Z')
  eq('monitoring on since Aug 20, last profile Aug 20 → 12 whole weeks overdue', M.refreshOverdue({ generated_at: '2026-08-20T16:21:26Z' }, '2026-08-20T16:58:21Z', now), 12)
  eq('fresh profile → null', M.refreshOverdue({ generated_at: '2026-11-16T15:00:00Z' }, '2026-08-20T16:58:21Z', now), null)
  eq('monitoring turned on last week → not overdue yet', M.refreshOverdue({ generated_at: '2026-08-20T16:21:26Z' }, '2026-11-14T00:00:00Z', now), null)
  eq('no profile → null', M.refreshOverdue(null, null, now), null)
}

// ═══ 9 — the root cause stays fixed ════════════════════════════════════════
console.log('\n[9] Opposition read a column nothing writes')
{
  const intel = src('src/pages/candidate/IntelViews.jsx')
  check('Attack & defense reads the SWOT + Section 13/6, not candidates.weaknesses alone', /keyWeaknesses\(swot, legacy\)/.test(intel) && /parseAttackDefense\(content\)/.test(intel) && /parseControversies\(content\)/.test(intel))
  check('the page no longer hands candidates.weaknesses down as the list', !/weaknesses=\{weaknesses\}/.test(src('src/pages/CandidateDetail.jsx')))
}

// ═══ 10-12 — X feed function ═══════════════════════════════════════════════
console.log('\n[10] fetch-candidate-x-feed: wiring')
const X = require('../netlify/functions/fetch-candidate-x-feed.js')
const RL = require('../netlify/functions/_rate-limit.js')
const { MODELS } = require('../netlify/functions/_models.js')
const TOML = src('netlify.toml')
{
  check('rate limits registered for cached reads and refreshes', RL.RATE_LIMITS['fetch-candidate-x-feed']?.perMinute === 30 && RL.RATE_LIMITS['fetch-candidate-x-feed-refresh']?.perDay === 60)
  check('netlify.toml gives it 60s', /\[functions\."fetch-candidate-x-feed"\]\s*\n\s*timeout\s*=\s*60/.test(TOML))
  check('Grok abort below the function timeout', X.GROK_TIMEOUT_MS === 50000)
  const p = X.buildPrompt({ name: 'Jane Doe', party: 'Democrat', office: { name: 'State Assembly', district_name: 'District 85', county: 'Marathon' } }, 'janedoe4wi')
  check('prompt names the handle, office and place and demands real status URLs', /@janedoe4wi/.test(p) && /District 85/.test(p) && /Marathon County/.test(p) && /status\/<id>/.test(p) && /Never invent/.test(p))
  const p2 = X.buildPrompt({ name: 'Jane Doe' }, '')
  check('without a handle it searches for the account and refuses to guess', /not on file/.test(p2) && /do not guess/.test(p2))
}

console.log('\n[11] validatePosts')
{
  const parsed = { posts: [
    { url: 'https://twitter.com/janedoe4wi/status/111111', author_name: 'Jane', created_at: '2026-11-01', text: 'Real post', about: 'by_candidate' },
    { url: 'https://x.com/someone/status/222222', author_name: 'Someone', created_at: '2026-11-03', text: 'Mention' },
    { url: 'https://x.com/fake/status/333333', text: 'Never cited' },
    { url: 'https://example.com/not-x', text: 'Not a post' },
    { url: 'https://x.com/janedoe4wi/status/111111', text: 'Duplicate' },
    { url: 'https://x.com/janedoe4wi/status/444444', text: '' },
  ] }
  const cited = ['https://x.com/janedoe4wi/status/111111', 'https://x.com/someone/status/222222?s=1', 'https://x.com/janedoe4wi/status/444444']
  const out = X.validatePosts(parsed, cited)
  eq('only cited, real, non-empty, unique posts; newest first', out.map(p => p.id), ['222222', '111111'])
  check('twitter.com URLs normalized to x.com, author from URL', out[1].url === 'https://x.com/janedoe4wi/status/111111' && out[1].author_username === 'janedoe4wi' && out[1].about === 'by_candidate')
  eq('no citations in the reply → URL validation only', X.validatePosts(parsed, []).map(p => p.id), ['222222', '111111', '333333'])
  check('a future date is dropped, not shown', X.validatePosts({ posts: [{ url: 'https://x.com/a/status/55555', text: 't', created_at: '2099-01-01' }] })[0].created_at === null)
  const read = X.readGrokResponse({ output: [{ type: 'message', content: [{ type: 'output_text', text: '{"posts":[]}', annotations: [{ url: 'https://x.com/a/status/1' }] }] }], citations: ['https://x.com/b/status/2'] })
  check('readGrokResponse joins text and collects citations + annotations', read.text === '{"posts":[]}' && read.cited.length === 2)
  check('parseJsonObject tolerates a fence', X.parseJsonObject('```json\n{"handle":"a","posts":[]}\n```').handle === 'a')
  check('isStale: 7h old is stale, 1h is fresh', X.isStale({ fetched_at: new Date(Date.now() - 7 * 3600e3).toISOString() }) && !X.isStale({ fetched_at: new Date(Date.now() - 3600e3).toISOString() }))
}

console.log('\n[12] handler (fetch stubbed)')
{
  const CID = '148e3459-3d17-4519-9290-ff5aed069e00'
  Object.assign(process.env, { SUPABASE_URL: 'https://sb.test', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc', XAI_API_KEY: 'xai' })
  delete process.env.X_BEARER_TOKEN
  function stub({ cacheRow = null, cacheTable = true, grok = null, grokStatus = 200 } = {}) {
    const calls = []
    const f = async (url, opts = {}) => {
      url = String(url)
      calls.push({ url, opts })
      const json = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) })
      if (url.endsWith('/auth/v1/user')) return opts.headers?.Authorization === 'Bearer good' ? json(200, { id: 'user-1' }) : json(401, {})
      if (url.includes('/rest/v1/candidates?')) return json(200, url.includes('created_by=eq.user-1') && url.includes(CID) ? [{ id: CID, name: 'Jane Doe', twitter_handle: null, office: { name: 'Assembly', district_name: 'District 85' } }] : [])
      if (url.includes('/rest/v1/candidate_x_feed?candidate_id')) return cacheTable ? json(200, cacheRow ? [cacheRow] : []) : json(404, { code: 'PGRST205' })
      if (url.includes('/rest/v1/candidate_x_feed?on_conflict')) return json(201, {})
      if (url === 'https://api.x.ai/v1/responses') return json(grokStatus, grok)
      return json(404, {})   // rate-limit RPC, ai_usage — fail open / ignored
    }
    return { f, calls }
  }
  const ev = (body, auth = 'Bearer good') => ({ httpMethod: 'POST', headers: { authorization: auth }, body: JSON.stringify(body) })
  const prevFetch = globalThis.fetch

  let s = stub()
  globalThis.fetch = s.f
  let r = await X._handler(ev({ candidate_id: CID }, 'Bearer bad'), { fetchImpl: s.f })
  check('401 without a valid session', r.statusCode === 401)
  r = await X._handler(ev({ candidate_id: 'nope' }), { fetchImpl: s.f })
  check('400 on a bad candidate id', r.statusCode === 400)
  r = await X._handler(ev({ candidate_id: '00000000-0000-0000-0000-000000000000' }), { fetchImpl: s.f })
  check('404 for a candidate the caller does not own', r.statusCode === 404)

  const fresh = { candidate_id: CID, handle: 'janedoe4wi', posts: [{ id: '1', url: 'https://x.com/janedoe4wi/status/1', text: 'cached' }], fetched_at: new Date(Date.now() - 3600e3).toISOString(), source: 'grok' }
  s = stub({ cacheRow: fresh }); globalThis.fetch = s.f
  r = await X._handler(ev({ candidate_id: CID }), { fetchImpl: s.f })
  let b = JSON.parse(r.body)
  check('cached read: posts returned, not stale, cache available', r.statusCode === 200 && b.posts[0].text === 'cached' && b.stale === false && b.cache === true && b.handle === 'janedoe4wi')
  check('cached read makes NO xAI call', !s.calls.some(c => c.url.includes('x.ai')))

  s = stub({ cacheRow: null }); globalThis.fetch = s.f
  b = JSON.parse((await X._handler(ev({ candidate_id: CID }), { fetchImpl: s.f })).body)
  check('no cache → empty + stale (the page then asks for a refresh)', b.posts.length === 0 && b.stale === true)

  const grokReply = {
    output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ handle: 'janedoe4wi', posts: [
      { url: 'https://x.com/janedoe4wi/status/777777', author_name: 'Jane Doe', created_at: '2026-11-10', text: 'Door knocking in Wausau', about: 'by_candidate' },
      { url: 'https://x.com/ghost/status/888888', author_name: 'Ghost', created_at: '2026-11-11', text: 'Made up' },
    ] }), annotations: [{ type: 'url_citation', url: 'https://x.com/janedoe4wi/status/777777' }] }] }],
    usage: { input_tokens: 100, output_tokens: 50 },
  }
  s = stub({ grok: grokReply }); globalThis.fetch = s.f
  r = await X._handler(ev({ candidate_id: CID, handle: 'janedoe4wi', refresh: true }), { fetchImpl: s.f })
  b = JSON.parse(r.body)
  const xcall = s.calls.find(c => c.url === 'https://api.x.ai/v1/responses')
  const sent = xcall ? JSON.parse(xcall.opts.body) : {}
  check('refresh calls xAI Responses with x_search and MODELS.GROK', !!xcall && sent.model === MODELS.GROK && sent.tools?.[0]?.type === 'x_search' && xcall.opts.headers.Authorization === 'Bearer xai')
  check('the handle the page found is used in the search', /@janedoe4wi/.test(sent.input?.[0]?.content || ''))
  check('only the cited post comes back', r.statusCode === 200 && b.posts.length === 1 && b.posts[0].id === '777777' && b.source === 'grok', r.body)
  const write = s.calls.find(c => c.url.includes('candidate_x_feed?on_conflict'))
  const row = write ? JSON.parse(write.opts.body) : {}
  check('result written to the cache (upsert, owner stamped)', !!write && row.candidate_id === CID && row.created_by === 'user-1' && row.posts.length === 1 && /merge-duplicates/.test(write.opts.headers.Prefer))

  s = stub({ grok: grokReply, cacheTable: false }); globalThis.fetch = s.f
  b = JSON.parse((await X._handler(ev({ candidate_id: CID, refresh: true }), { fetchImpl: s.f })).body)
  check('without the cache table it still searches (and says cache:false)', b.posts.length === 1 && b.cache === false && !s.calls.some(c => c.url.includes('on_conflict')))

  s = stub({ cacheRow: fresh, grokStatus: 500, grok: { error: 'x' } }); globalThis.fetch = s.f
  r = await X._handler(ev({ candidate_id: CID, refresh: true }), { fetchImpl: s.f })
  b = JSON.parse(r.body)
  check('a failed refresh serves the cached posts, marked stale', r.statusCode === 200 && b.posts[0].text === 'cached' && b.stale === true && !!b.refresh_error)

  s = stub({ grokStatus: 429, grok: {} }); globalThis.fetch = s.f
  r = await X._handler(ev({ candidate_id: CID, refresh: true }), { fetchImpl: s.f })
  check('a failed refresh with no cache → 429 passed through as a plain message', r.statusCode === 429 && /busy/.test(JSON.parse(r.body).error))

  delete process.env.XAI_API_KEY
  s = stub(); globalThis.fetch = s.f
  r = await X._handler(ev({ candidate_id: CID, refresh: true }), { fetchImpl: s.f })
  check('no XAI_API_KEY and no X token → 503 that says so', r.statusCode === 503 && /XAI_API_KEY/.test(JSON.parse(r.body).error))
  globalThis.fetch = prevFetch
}

// ═══ 13-14 — research-swot ═════════════════════════════════════════════════
console.log('\n[13] research-swot: prompt + normalize')
const S = require('../netlify/functions/research-swot.js')
{
  check('netlify.toml gives it 60s', /\[functions\."research-swot"\]\s*\n\s*timeout\s*=\s*60/.test(TOML))
  const cand = { name: 'Jane Doe', party: 'Democrat', status: 'declared', is_incumbent: false, office: { name: 'State Assembly', district_name: 'District 85' }, election: { name: '2026 General', election_date: '2026-11-03' } }
  const long = 'A'.repeat(20000) + ' LATE_SECTION_MARKER'
  const opp = S.buildSwotPrompt({ candidate: cand, content: long, perspective: 'opponent' })
  const self = S.buildSwotPrompt({ candidate: cand, content: long, perspective: 'self' })
  check('reads far past the old 12,000-character cut', opp.includes('LATE_SECTION_MARKER') && S.PROFILE_CHARS >= 60000)
  check('names the race (office, election, party, status)', /District 85/.test(opp) && /2026 General/.test(opp) && /Democrat/.test(opp) && /declared/.test(opp))
  check('opponent → how to USE weaknesses; self → how to DEFEND them', /HOW TO USE IT/.test(opp) && !/HOW TO DEFEND IT/.test(opp) && /HOW TO DEFEND IT/.test(self) && /HOW TO PRESS IT/.test(self))
  check('demands evidence + source, never invented, ranked by impact', /"evidence"/.test(opp) && /never invent/i.test(opp) && /impact/.test(opp) && /strongest first/.test(opp))
  const n = S.normalizeSwotV2({ bottom_line: '  Win the farm vote.  ', weaknesses: [
    { point: 'a', evidence: 'e', source: 's', impact: 2, play: 'p' },
    { point: 'b', impact: '5' }, 'c as string', { point: '' }, null,
    { point: 'd', impact: 1 }, { point: 'e', impact: 4 }, { point: 'f', impact: 3 },
  ] }, { perspective: 'self', dossierId: 'd1', now: new Date('2026-11-19T00:00:00Z') })
  eq('ranked by impact, capped at 5, empties dropped, strings accepted', n.weaknesses.map(x => [x.point, x.impact]), [['b', 5], ['e', 4], ['f', 3], ['a', 2], ['c as string', 2]])
  check('v2 envelope', n.v === 2 && n.perspective === 'self' && n.dossier_id === 'd1' && n.generated_at === '2026-11-19T00:00:00.000Z' && n.bottom_line === 'Win the farm vote.' && Array.isArray(n.strengths))
  check('the page understands what it stores', (await import('../src/pages/candidate/intelModel.js')).normalizeSwot(n).weaknesses[0].point === 'b')
}

console.log('\n[14] research-swot: handler (model stubbed)')
{
  const CID = '148e3459-3d17-4519-9290-ff5aed069e00'
  Object.assign(process.env, { SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'svc', ANTHROPIC_API_KEY: 'ak' })
  const calls = []
  const f = async (url) => {
    url = String(url); calls.push(url)
    const json = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) })
    if (url.endsWith('/auth/v1/user')) return json(200, { id: 'user-1' })
    if (url.includes('/rest/v1/dossiers?')) return json(200, url.includes(encodeURIComponent('user-1')) ? [{ id: 'd1', content: PROFILE, candidate: { name: 'Jane Doe' } }] : [])
    return json(404, {})
  }
  const prevFetch = globalThis.fetch
  globalThis.fetch = f
  let sentBody = null
  const claude = async ({ body }) => {
    sentBody = body
    return { ok: true, status: 200, json: async () => ({ content: [{ type: 'thinking', thinking: '…' }, { type: 'text', text: '{"bottom_line":"x","weaknesses":[{"point":"DNR citation","evidence":"Jun 2024 runoff","source":"dnr.wi.gov","impact":5,"play":"Show the clean inspection"}],"strengths":[],"opportunities":[],"threats":[]}' }], usage: {} }) }
  }
  const ev = (body) => ({ httpMethod: 'POST', headers: { authorization: 'Bearer good' }, body: JSON.stringify(body) })
  let r = await S._handler(ev({ candidate_id: CID, perspective: 'self' }), { fetchImpl: f, claude })
  const b = JSON.parse(r.body)
  check('200 with a v2 SWOT', r.statusCode === 200 && b.swot.v === 2 && b.swot.perspective === 'self' && b.swot.weaknesses[0].play === 'Show the clean inspection', r.body)
  check('Sonnet (CLAUDE_BALANCED), no temperature, enough tokens', sentBody.model === MODELS.CLAUDE_BALANCED && !('temperature' in sentBody) && sentBody.max_tokens >= 4096)
  check('the profile is read scoped to the caller (IDOR guard)', calls.some(u => u.includes('candidate.created_by=eq.user-1')))
  r = await S._handler(ev({ candidate_id: CID }), { fetchImpl: f, claude: async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: 'Sorry, no.' }] }) }) })
  check('unreadable model output → 502, not a blank SWOT', r.statusCode === 502)
  r = await S._handler(ev({ candidate_id: CID }), { fetchImpl: f, claude: async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: '{"strengths":[],"weaknesses":[],"opportunities":[],"threats":[]}' }] }) }) })
  check('an empty SWOT is refused (422) instead of overwriting a good one', r.statusCode === 422)
  globalThis.fetch = prevFetch
}

// ═══ 15 — page wiring ══════════════════════════════════════════════════════
console.log('\n[15] page wiring')
{
  const page = src('src/pages/CandidateDetail.jsx')
  const files = ['src/pages/CandidateDetail.jsx', 'src/pages/candidate/Overview.jsx', 'src/pages/candidate/IntelViews.jsx', 'src/pages/candidate/RecordViews.jsx', 'src/pages/candidate/shared.jsx']
  check('the Profile Data tab file is gone', !existsSync(new URL('src/pages/candidate/ProfileData.jsx', root)))
  check('no "Profile Data" left in the profile page or its links', files.every(f => !/Profile Data|ProfileData/.test(code(f))))
  check('four tabs: Overview, Intel, Record, Notes & files', /label: 'Overview'/.test(page) && /label: 'Intel'/.test(page) && /label: 'Record'/.test(page) && /label: 'Notes & files'/.test(page) && !/id: 'data'/.test(page))
  check('Edit opens the basics dialog', /<EditCandidate/.test(page) && /office_id: form\.office_id \|\| null/.test(page) && /twitter_handle:/.test(page))
  check('old deep links still land (news → x, opposition → attack)', /LEGACY_INTEL_VIEW = \{ news: 'x', opposition: 'attack' \}/.test(src('src/pages/candidate/IntelViews.jsx')))
  const rec = src('src/pages/candidate/RecordViews.jsx')
  check('profile history is not plan-gated', !/canIntel/.test(rec) && !/LockedView/.test(rec))
  check('live results only render while RESULTS_ENABLED is on', /\{RESULTS_ENABLED && <ElectionResultsView/.test(rec))
  check('past races come from the profile', /parseRaceHistory\(content\)/.test(rec))
  const ov = src('src/pages/candidate/Overview.jsx')
  check('Overview makes no AI call on open (no generate-bio-summary)', !/generate-bio-summary'|useBioSummary\(/.test(ov + page) && /profileSnapshot\(content\)/.test(ov))
  const intel = src('src/pages/candidate/IntelViews.jsx')
  check('X posts load on open: cached read, then a background refresh when stale', /callXFeed\(\{ candidate_id: candidateId, handle: handleRef\.current \|\| undefined \}\)/.test(intel) && /if \(stale\) refresh\(false\)/.test(intel))
  check('no "Load X posts" button gate left', !/Load X posts|Posts are loaded on demand/.test(intel))
  check('perspective comes from resolveSelfCandidate', /resolveSelfCandidate\(user, data \|\| \[\]\)/.test(page))
  const mig = src('supabase/migrations/20261119000001_candidate_x_feed.sql')
  check('migration: cache table + owner-only RLS + photo_url', /create table if not exists public\.candidate_x_feed/.test(mig) && /enable row level security/.test(mig) && /c\.created_by = auth\.uid\(\)/.test(mig) && /add column if not exists photo_url/.test(mig))
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
