// tests/profile-v5.test.mjs — Profiler v5: the prompt module (_profile-prompt.js)
// and the pipeline helpers in generate-dossier-background.js (identity stage,
// writer loop with pause_turn + web_fetch fallback, QA pass), exercised with a
// mocked fetch so no model is called. Prints "N passed, M failed".
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

const require = createRequire(import.meta.url)
process.env.ANTHROPIC_API_KEY = 'test-key'
delete process.env.SUPABASE_URL; delete process.env.VITE_SUPABASE_URL
const P = require('../netlify/functions/_profile-prompt.js')
const G = require('../netlify/functions/generate-dossier-background.js')
const SRC = readFileSync(new URL('../netlify/functions/generate-dossier-background.js', import.meta.url), 'utf8')
const MODEL_SRC = readFileSync(new URL('../src/pages/profiler/reportModel.js', import.meta.url), 'utf8')

let passed = 0, failed = 0
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name) }
  else { failed++; console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')) }
}

const safe = { name: 'Jane Doe', party: 'Republican', status: 'declared', occupation: 'Dentist', officeName: 'State Assembly', districtName: 'District 87', county: 'Marathon', research_context: 'the dentist in Mosinee', twitter_handle: 'janedoe' }
const officeLine = 'State Assembly (District 87)'
const identity = { resolved: true, legal_name: 'Jane A. Doe', location: 'Mosinee, Marathon County', office_or_role: 'Candidate, AD-87', confidence: 'high', party_evidence: [{ party: 'Republican', source: 'https://cfis.wi.gov/x', note: 'CFIS' }], canonical_urls: { ballotpedia: 'https://ballotpedia.org/Jane_Doe', campaign_site: null, other: ['https://legis.wisconsin.gov/x'] }, key_news_urls: ['https://wsaw.com/a'] }

console.log('\n[1] writer system prompt — contract with the report parser')
{
  const S = P.WRITER_SYSTEM
  check('names the snapshot header', S.includes('## PROFILE SNAPSHOT'))
  check('names the section header shape', S.includes('## SECTION n: TITLE'))
  for (const b of ['[KNOWN]', '[Confirmed]', '[Likely]', '[Verify]', '[RESEARCH REQUIRED]']) check(`defines badge ${b}`, S.includes(b))
  check('section-level confidence line', S.includes('**[HIGH]**') && S.includes('**[LOW]**'))
  check('feed format for Sections 1 and 10', /### \[Exact title\]\(https:\/\/full-url\)/.test(S) && S.includes('**Publication or Platform / Author** · Month D, YYYY'))
  check('identity-first rule', /IDENTITY FIRST/.test(S))
  check('no-fabrication rule', /NEVER FABRICATE/.test(S))
  check('legal rules: defamation + FCRA + juvenile/sealed', /895\.05/.test(S) && /FCRA/.test(S) && /sealed, expunged or juvenile/.test(S))
  check('tells the model to fetch canonical pages before searching', /web_fetch the canonical pages/.test(S))
  check('official-source hierarchy names CFIS and the legislature', /cfis\.wi\.gov/.test(S) && /docs\.legis\.wisconsin\.gov/.test(S))
  check('forbids narration before the snapshot', /Nothing before "## PROFILE SNAPSHOT"/.test(S))
  check('long enough to prompt-cache (>1024 tokens)', S.length / 4 > 1024)
  check('does not carry the old human-researcher database laundry list', !/Google searches to perform/.test(S) && !/Mandatory Commentators/.test(S))
}

console.log('\n[2] writer tools')
{
  check('web_search + web_fetch, basic (direct, ZDR-eligible) versions', P.WRITER_TOOLS.map(t => t.type).join() === 'web_search_20250305,web_fetch_20250910')
  check('budgets: 12 searches, 10 fetches, fetch content capped', P.WRITER_TOOLS[0].max_uses === 12 && P.WRITER_TOOLS[1].max_uses === 10 && P.WRITER_TOOLS[1].max_content_tokens === 12000)
  check('search-only fallback is just web_search', P.WRITER_TOOLS_SEARCH_ONLY.length === 1 && P.WRITER_TOOLS_SEARCH_ONLY[0].name === 'web_search')
  check('pipeline budget matches the tools', G._v5.WRITER_BUDGET.searches === 12 && G._v5.WRITER_BUDGET.fetches === 10)
}

console.log('\n[3] section template')
{
  const full = P.sectionTemplate({ mode: 'challenger', canViewSection6: true })
  const lite = P.sectionTemplate({ mode: 'prospect', canViewSection6: false })
  const heads = (t) => (t.match(/^## SECTION (\d+): (.+)$/gm) || [])
  check('14 numbered sections in order (challenger)', heads(full).length === 14 && heads(full).map(h => +h.match(/\d+/)[0]).join() === '1,2,3,4,5,6,7,8,9,10,11,12,13,14')
  check('14 numbered sections in order (prospect)', heads(lite).length === 14)
  check('starts with the snapshot', full.startsWith('## PROFILE SNAPSHOT'))
  check('challenger Section 4 is POLITICAL RECORD with a races table', /## SECTION 4: POLITICAL RECORD/.test(full) && /\| Year \| Office \| Result/.test(full))
  check('prospect Section 4 is CIVIC & POLITICAL BACKGROUND and forbids invented races', /## SECTION 4: CIVIC & POLITICAL BACKGROUND/.test(lite) && /Do not invent race history/.test(lite))
  check('paid tier gets the full Section 6 table with research priority', /\| Issue \| Date \|/.test(full) && /Research priority/.test(full))
  check('free tier gets the Section 6 + 13 upsell frameworks', /available to Campaign & Agency plan subscribers/.test(lite) && (lite.match(/Upgrade to Campaign or Agency plan/g) || []).length === 2)
  check('SWOT quadrants present in Section 12', ['**Strengths**', '**Weaknesses**', '**Opportunities**', '**Threats**'].every(q => full.includes(q)))
  check('Section 10 feed flags list', /Controversial \/ Policy \/ Contradiction \/ Deleted \/ Endorsement \/ Accusation \/ Rumor \/ Praise/.test(full))
  check('Section 14 keeps a SHORT manual follow-up (3–6 rows), not the old 23-row checklist', /Three to six rows/.test(full) && !/McBride \/ Sykes \/ McKenna/.test(full))
  check('dossier footer disclaimer present', /DOSSIER FOOTER/.test(full) && /FCRA/.test(full))
  // Every section title the template emits must be one the app knows
  const titles = heads(full).map(h => h.replace(/^## SECTION \d+: /, ''))
  check('every section title is a real report section (app has 14 ids)', titles.length === 14 && /section-14/.test(MODEL_SRC))
}

console.log('\n[4] writer user prompt')
{
  const u = P.buildWriterUserPrompt({ safe, officeLine, mode: 'newly_declared', canViewSection6: true, today: 'November 2, 2026', identity, packets: { news: '### [A](https://a)\n**WSAW** · Jan 1, 2026', official: 'FEC: none', grok: '[@janedoe · Oct 1] "hi"' }, teamNotes: 'TEAM NOTES: watch the clinic story', budget: { searches: 12, fetches: 10 } })
  check('states today and the tool budget', u.includes('Today is November 2, 2026') && u.includes('web_search up to 12, web_fetch up to 10'))
  check('mode directive for newly declared', /RESEARCH MODE: NEWLY DECLARED candidate for State Assembly \(District 87\)/.test(u))
  check('candidate record with party/status marked as claims', /Party on file: Republican/.test(u) && /Status on file: declared/.test(u))
  check('user identity context is elevated', /USER-PROVIDED IDENTITY CONTEXT/.test(u) && u.includes('the dentist in Mosinee'))
  check('identity card rendered', /IDENTITY CARD \(resolved by a prior search step — confidence high\)/.test(u) && u.includes('Legal name: Jane A. Doe'))
  check('canonical URLs listed so web_fetch may open them (null entries skipped)', u.includes('- ballotpedia: https://ballotpedia.org/Jane_Doe') && u.includes('- other: https://legis.wisconsin.gov/x') && u.includes('- news: https://wsaw.com/a') && !/campaign_site: null/.test(u))
  check('only packets with data are included, with guidance', /=== NEWS RESEARCH/.test(u) && /=== OFFICIAL RECORDS/.test(u) && /=== REAL-TIME X/.test(u) && !/=== CAMPAIGN FINANCE RESEARCH/.test(u))
  check('team notes pass through', u.includes('watch the clinic story'))
  check('ends with the CANDIDATE_UPDATES spec naming the current status', /CANDIDATE_UPDATES:/.test(u) && /change from "declared" only on clear evidence/.test(u) && u.trim().endsWith('may appear.'))
  const noId = P.buildWriterUserPrompt({ safe, officeLine, mode: 'incumbent', canViewSection6: false, today: 'x', identity: null, packets: {} })
  check('unresolved identity is stated, not hidden', /could not resolve this person/.test(noId))
  check('incumbent directive prefers the legislature record', /RESEARCH MODE: INCUMBENT/.test(noId) && /docs\.legis\.wisconsin\.gov/.test(noId))
  check('unknown mode falls back to challenger', /RESEARCH MODE: ACTIVE CANDIDATE/.test(P.buildWriterUserPrompt({ safe, officeLine, mode: 'bogus', canViewSection6: true, today: 'x', identity: null })))
}

console.log('\n[5] identity + QA prompts')
{
  const ip = P.resolveIdentityPrompt({ safe, officeLine, mode: 'challenger' })
  check('identity prompt asks for JSON with canonical_urls and key_news_urls', /"canonical_urls"/.test(ip) && /"key_news_urls"/.test(ip) && /Return ONLY a JSON object/.test(ip))
  check('identity prompt caps searches and forbids fetch/invented urls', /at most 5 searches/.test(ip) && /Do not fetch anything/.test(ip) && /Never invent a URL/.test(ip))
  check('identity prompt carries the user context', ip.includes('the dentist in Mosinee'))
  const qp = P.qaPrompt({ content: '## SECTION 1\nx', candidateName: 'Jane Doe', officeLine, identity })
  check('QA prompt lists the flag types and caps at 15', /unsourced_known\|identity_risk\|legal_risk\|format\|contradiction\|stale/.test(qp) && /at most 15 flags/.test(qp))
  check('QA prompt includes the identity card essentials', qp.includes('"legal_name":"Jane A. Doe"'))
  check('QA system never rewrites', /you only flag/.test(P.QA_SYSTEM))
}

console.log('\n[6] parseJsonObject')
{
  const pj = G._v5.parseJsonObject
  check('plain JSON', pj('{"a":1}').a === 1)
  check('fenced JSON', pj('```json\n{"a":2}\n```').a === 2)
  check('JSON after prose', pj('Here you go:\n{"a":3}\nthanks').a === 3)
  check('garbage → null', pj('nope') === null && pj('') === null)
}

console.log('\n[7] writer loop — pause_turn, cache, fetch fallback, metering')
{
  const realFetch = globalThis.fetch
  const calls = []
  const mk = (status, obj) => ({ status, ok: status < 300, clone() { return this }, async text() { return JSON.stringify(obj) }, async json() { return obj } })
  const msg = (stop, text, extra = {}) => ({ stop_reason: stop, content: [{ type: 'thinking', thinking: 'x' }, { type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'q' } }, { type: 'text', text }], usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1500, server_tool_use: { web_search_requests: 3, web_fetch_requests: 2 }, ...extra } })

  // (a) two pauses then end_turn: text accumulates, assistant content is passed back
  globalThis.fetch = async (url, init) => {
    const b = JSON.parse(init.body); calls.push(b)
    if (calls.length === 1) return mk(200, msg('pause_turn', '## PROFILE SNAPSHOT\nA. '))
    if (calls.length === 2) return mk(200, msg('pause_turn', '## SECTION 1: NEWS\n'))
    return mk(200, msg('end_turn', '**[HIGH]**\nitem'))
  }
  const r = await G._v5.runWriter({ userPrompt: 'write', userId: 'u1' })
  check('continues through pause_turn until end_turn', calls.length === 3 && r.data.stop_reason === 'end_turn')
  check('text from every hop is joined', r.text === '## PROFILE SNAPSHOT\nA. ## SECTION 1: NEWS\n**[HIGH]**\nitem')
  check('continuation passes the assistant content back as-is with the same tools', calls[1].messages.length === 2 && calls[1].messages[1].role === 'assistant' && calls[1].messages[1].content[1].type === 'server_tool_use' && calls[1].tools.length === 2)
  check('system prompt is cached (ephemeral cache_control)', calls[0].system[0].cache_control?.type === 'ephemeral' && calls[0].system[0].text === P.WRITER_SYSTEM)
  check('Opus 5.5 at the configured effort, no temperature, no thinking:disabled', calls[0].model === 'claude-opus-5-5' && calls[0].output_config.effort === G._v5.WRITER_EFFORT && !('temperature' in calls[0]) && !calls[0].thinking)
  check('max_tokens leaves room for thinking + a 24k report', calls[0].max_tokens === 48000)

  // (b) 400 naming web_fetch → retry with search only
  calls.length = 0
  globalThis.fetch = async (url, init) => {
    const b = JSON.parse(init.body); calls.push(b)
    if (b.tools.some(t => t.name === 'web_fetch')) return mk(400, { error: { message: 'web_fetch is not enabled for this organization' } })
    return mk(200, msg('end_turn', 'ok'))
  }
  const r2 = await G._v5.runWriter({ userPrompt: 'write', userId: 'u1' })
  check('web_fetch rejected → retried with web_search only', r2.text === 'ok' && r2.usedTools.length === 1 && calls[calls.length - 1].tools.length === 1)

  // (c) unrelated 400 → throws
  globalThis.fetch = async () => mk(400, { error: { message: 'messages: required' } })
  let threw = false
  try { await G._v5.runWriter({ userPrompt: 'write', userId: 'u1' }) } catch { threw = true }
  check('an unrelated 400 is a hard failure', threw)

  // (d) stops after the continuation cap
  calls.length = 0
  globalThis.fetch = async (url, init) => { calls.push(JSON.parse(init.body)); return mk(200, msg('pause_turn', 'p')) }
  const r3 = await G._v5.runWriter({ userPrompt: 'write', userId: 'u1', maxContinuations: 2 })
  check('bounded continuations (cap + 1 calls)', calls.length === 3 && r3.text === 'ppp')
  globalThis.fetch = realFetch
}

console.log('\n[8] identity stage + QA pass (mocked)')
{
  const realFetch = globalThis.fetch
  const mk = (status, obj) => ({ status, ok: status < 300, clone() { return this }, async text() { return JSON.stringify(obj) }, async json() { return obj } })
  let sent = null
  globalThis.fetch = async (url, init) => { sent = JSON.parse(init.body); return mk(200, { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ resolved: true, legal_name: 'Jane A. Doe', confidence: 'high', canonical_urls: { ballotpedia: 'https://ballotpedia.org/Jane', campaign_site: 'javascript:alert(1)', other: ['https://a.b/c', 'not a url'] }, key_news_urls: ['https://n.e/1', 'ftp://x'] }) }], usage: { input_tokens: 10, output_tokens: 5, server_tool_use: { web_search_requests: 2 } } }) }
  const card = await G._v5.resolveIdentity({ safe, officeLine, mode: 'challenger', userId: 'u1' })
  check('identity stage runs Sonnet 5.5 with web_search ≤5', sent.model === 'claude-sonnet-5-5' && sent.tools[0].name === 'web_search' && sent.tools[0].max_uses === 5)
  check('identity card parsed; non-http urls dropped', card.legal_name === 'Jane A. Doe' && card.canonical_urls.ballotpedia === 'https://ballotpedia.org/Jane' && card.canonical_urls.campaign_site === null && card.canonical_urls.other.length === 1 && card.key_news_urls.length === 1)

  globalThis.fetch = async () => mk(200, { stop_reason: 'end_turn', content: [{ type: 'text', text: 'not json' }], usage: {} })
  check('identity stage returns null on non-JSON (never throws)', (await G._v5.resolveIdentity({ safe, officeLine, mode: 'challenger', userId: 'u1' })) === null)

  globalThis.fetch = async (url, init) => { sent = JSON.parse(init.body); return mk(200, { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ flags: [{ section: 6, severity: 'low', type: 'format', claim: 'x', issue: 'minor' }, { section: 4, severity: 'high', type: 'unsourced_known', claim: 'Voted for AB 1', issue: 'No source' }], identity_risk: 'possible', summary: 'ok' }) }], usage: {} }) }
  const qa = await G._v5.runQaPass({ content: '## SECTION 1\nx', candidateName: 'Jane Doe', officeLine, identity: null, userId: 'u1' })
  check('QA runs on Sonnet 5.5 with the QA system prompt', sent.model === 'claude-sonnet-5-5' && sent.system === P.QA_SYSTEM)
  check('QA flags sorted high→low and rendered as markdown bullets', qa.count === 2 && qa.markdown.split('\n')[1].startsWith('- **HIGH** · Section 4 · unsourced known: No source — “Voted for AB 1”'))
  check('identity risk is surfaced first', qa.identityRisk === 'possible' && qa.markdown.startsWith('- **IDENTITY RISK: POSSIBLE**'))

  globalThis.fetch = async () => mk(200, { stop_reason: 'end_turn', content: [{ type: 'text', text: '{"flags":[],"identity_risk":"none"}' }], usage: {} })
  check('no flags → null (nothing appended to the report)', (await G._v5.runQaPass({ content: 'x', candidateName: 'J', officeLine, identity: null, userId: 'u1' })) === null)
  globalThis.fetch = realFetch
}

console.log('\n[9] pipeline wiring (source checks)')
{
  check('identity stage is launched alongside the research fan-out', /const identityCardPromise = resolveIdentity\(/.test(SRC))
  check('writer prompt comes from _profile-prompt.js', /buildWriterUserPrompt\(\{/.test(SRC) && !/You are a WI opposition researcher/.test(SRC))
  check('old Haiku verification pass is gone; QA pass appends VERIFICATION FLAGS', !/runVerificationPass/.test(SRC) && /runQaPass\(\{ content/.test(SRC) && /VERIFICATION FLAGS \(AI Quality Check\)/.test(SRC))
  check('leak guard keeps the PROFILE SNAPSHOT', /content\.search\(\/\^##\\s\*PROFILE SNAPSHOT\/im\)/.test(SRC))
  check('web search fees are metered', /web_search_requests\) \|\| 0/.test(SRC) && /flatUsd: searches \* 0\.01/.test(SRC))
  check('writer effort configurable via PROFILE_EFFORT, default high', /process\.env\.PROFILE_EFFORT/.test(SRC) && G._v5.WRITER_EFFORT === 'high')
  check('writer call has its own 10-minute timeout inside the 15-minute function', /WRITER_CALL_TIMEOUT_MS = 10 \* 60 \* 1000/.test(SRC))
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) process.exitCode = 1
