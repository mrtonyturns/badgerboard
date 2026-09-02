#!/usr/bin/env node
// Badger Board — Prospecting v2 unit tests (pure logic only)
// Zero-config, no network, no database:  node tests/prospecting.test.mjs
//
// Covers the three pure layers of the pipeline:
//   _win-odds.js                    the transparent scoring model
//   enrich-prospects-background.js  its exported pure validators/extractors
//   src/lib/prospectCsv.js          the CSV export builder
import { createRequire } from 'module'
const require = createRequire(import.meta.url)

let pass = 0, fail = 0
const t = (name, cond) => { cond ? pass++ : fail++; console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${name}`) }

// ─── W1: win-odds model ──────────────────────────────────────────────────────
console.log('W1 — computeWinOdds (weights, renormalization, transparency)')
const { computeWinOdds, primaryMarginFromResults, scoreBand, FACTORS, ENABLED_WEIGHT } =
  require('../netlify/functions/_win-odds.js')

const weightOf = (k) => FACTORS.find(f => f.key === k).weight
t('game-plan weights are intact', weightOf('incumbency') === 0.25 && weightOf('district_lean') === 0.25
  && weightOf('fundraising') === 0.20 && weightOf('primary_margin') === 0.15
  && weightOf('contested') === 0.10 && weightOf('seat_history') === 0.05)
t('all six factors sum to 1.00', Math.abs(FACTORS.reduce((s, f) => s + f.weight, 0) - 1) < 1e-9)
t('fundraising is disabled pending the CFIS legal read',
  FACTORS.find(f => f.key === 'fundraising').enabled === false && Math.abs(ENABLED_WEIGHT - 0.8) < 1e-9)

{
  const none = computeWinOdds({})
  t('no measurable factor → null score, not a fake 50', none.score === null && none.band === 'unknown' && none.confidence === 0)
  t('unmeasured factors are reported, not hidden', none.unavailable.length === 5)
}

{
  const best = computeWinOdds({
    is_incumbent: true, contested: false, field_size: 1, district_lean: 40,
    primary_margin: 40, primary_won: true, seat_history: 'safe_same_party',
  })
  t('a maximal profile scores near the ceiling', best.score >= 95 && best.score <= 100)
  t('confidence is 1 when every enabled factor was measured', best.confidence === 1)

  const worst = computeWinOdds({
    is_incumbent: false, contested: true, field_size: 4, district_lean: -40,
    primary_margin: -30, primary_won: false, seat_history: 'opposite_party_hold',
  })
  t('a challenger in a hostile seat scores low', worst.score <= 25)
  t('better inputs never score worse', best.score > worst.score)
}

{
  // Only incumbency measurable: the score must equal that factor alone, i.e.
  // renormalization, not a 25%-of-the-model dilution toward zero.
  const one = computeWinOdds({ is_incumbent: true, contested: false })
  t('single measurable factor renormalizes to itself', one.score === 100)
  t('confidence reports the share of the model that was available',
    Math.abs(one.confidence - (0.25 + 0.10) / 0.8) < 0.011)
  const applied = one.factors.filter(f => f.available).reduce((s, f) => s + f.weight_applied, 0)
  t('applied weights of available factors sum to 1', Math.abs(applied - 1) < 1e-6)
}

{
  const mid = computeWinOdds({ is_incumbent: true, contested: true, district_lean: 0, primary_margin: 0, seat_history: 'open' })
  const points = mid.factors.filter(f => f.available).reduce((s, f) => s + f.points, 0)
  t('the visible factor breakdown adds up to the score', Math.abs(points - mid.score) <= 0.6)
  t('every available factor carries a plain-English basis',
    mid.factors.filter(f => f.available).every(f => typeof f.basis === 'string' && f.basis.length > 8))
  t('the disabled factor still names why it is excluded',
    /11\.1304|legal/i.test(mid.factors.find(f => f.key === 'fundraising').source))
}

{
  const input = { is_incumbent: true, contested: true, district_lean: 12 }
  const snapshot = JSON.stringify(input)
  const a = computeWinOdds(input)
  const b = computeWinOdds(input)
  t('pure: same input → same score', a.score === b.score)
  t('pure: the input object is never mutated', JSON.stringify(input) === snapshot)
}

{
  t('district lean saturates rather than overflowing',
    computeWinOdds({ district_lean: 400 }).score === computeWinOdds({ district_lean: 40 }).score)
  t('garbage inputs are ignored, not coerced',
    computeWinOdds({ district_lean: 'very red', primary_margin: NaN }).score === null)
  t('bands map as documented',
    scoreBand(80) === 'strong' && scoreBand(50) === 'competitive' && scoreBand(10) === 'longshot' && scoreBand(null) === 'unknown')
}

// ─── W2: primary margin from our own election_results ────────────────────────
console.log('W2 — primaryMarginFromResults')
{
  const rows = [
    { candidate_name: 'Jane Doe', votes: 600, vote_pct: 60 },
    { candidate_name: 'John Roe', votes: 400, vote_pct: 40 },
  ]
  const r = primaryMarginFromResults(rows, 'Jane Doe')
  t('margin + winner + field size', r.margin === 20 && r.won === true && r.field_size === 2 && r.pct === 60)
  t('the loser gets a negative margin', primaryMarginFromResults(rows, 'John Roe').margin === -20)
  t('percentages are derived from raw votes when vote_pct is missing',
    primaryMarginFromResults([{ candidate_name: 'A', votes: 750 }, { candidate_name: 'B', votes: 250 }], 'A').margin === 50)
  t('a unique last name still matches', primaryMarginFromResults(rows, 'Jane R. Doe')?.margin === 20)
  t('an unknown candidate returns null, never a guess', primaryMarginFromResults(rows, 'Nobody Here') === null)
  t('a one-candidate contest yields no margin', primaryMarginFromResults([{ candidate_name: 'A', votes: 5 }], 'A') === null)
  t('empty input is null', primaryMarginFromResults([], 'A') === null && primaryMarginFromResults(null, 'A') === null)
}

// ─── E1: enrichment validators/extractors (pure exports) ─────────────────────
console.log('E1 — enrichment pure helpers')
const enrich = require('../netlify/functions/enrich-prospects-background.js')
const {
  normalizeUrl, classifySocial, extractSocialsFromHtml, detectAgencySignals,
  extractContactsFromHtml, websiteState, buildContact, parseCitedFields,
} = enrich

t('batch cap matches the documented 10', enrich.MAX_PROSPECTS_PER_RUN === 10)

t('normalizeUrl adds a scheme to a bare domain', normalizeUrl('janedoeforassembly.com') === 'https://janedoeforassembly.com/')
t('normalizeUrl strips trailing punctuation', normalizeUrl('https://a.com/x).') === 'https://a.com/x')
t('normalizeUrl rejects javascript:', normalizeUrl('javascript:alert(1)') === null)
t('normalizeUrl rejects mailto/tel', normalizeUrl('mailto:a@b.com') === null && normalizeUrl('tel:+15551234567') === null)
t('normalizeUrl rejects prose', normalizeUrl('no website found') === null && normalizeUrl('unknown') === null)
t('normalizeUrl rejects null/undefined', normalizeUrl(null) === null && normalizeUrl(undefined) === null)

t('classifySocial identifies a real profile', classifySocial('https://facebook.com/JaneForWI') === 'facebook')
t('x.com and twitter.com both map to x',
  classifySocial('https://x.com/jane') === 'x' && classifySocial('https://twitter.com/jane') === 'x')
t('share widgets are not profiles', classifySocial('https://facebook.com/sharer/sharer.php?u=x') === null)
t('a bare platform link is not a profile', classifySocial('https://instagram.com/') === null)
t('non-social URLs are not classified', classifySocial('https://janedoe.com') === null)

{
  const html = `<html><footer>
    <a href="https://www.facebook.com/JaneForWI">fb</a>
    <a href="https://twitter.com/intent/tweet?url=x">share</a>
    <a href="https://x.com/JaneForWI">x</a>
    <a href="/about">about</a>
    <a href="https://www.instagram.com/janeforwi/">ig</a>
  </footer></html>`
  const s = extractSocialsFromHtml(html, 'https://janeforwi.com')
  t('socials scraped from the site markup', s.facebook.includes('JaneForWI') && s.x === 'https://x.com/JaneForWI' && !!s.instagram)
  t('share-intent links are skipped', !String(s.x).includes('intent'))
  t('missing platforms come back null, not undefined', s.tiktok === null && s.linkedin === null)
  t('empty html is safe', extractSocialsFromHtml('', '').facebook === null)
}

// ─── E2: agency detection from web-visible signals only ──────────────────────
console.log('E2 — detectAgencySignals (web-visible evidence, no CFIS)')
{
  const empty = detectAgencySignals({ html: '<html><body>Vote Jane!</body></html>', url: 'https://a.com' })
  t('a plain site yields no detection', empty.detected === false && empty.evidence.length === 0)

  const paid = detectAgencySignals({
    html: '<footer>Paid for by Friends of Jane Doe, Meridian Strategies LLC treasurer</footer>',
    url: 'https://janeforwi.com',
  })
  t('a "paid for by" line is captured as evidence',
    paid.evidence.some(e => e.type === 'paid_for_by') && paid.detected === true)
  t('evidence carries the page it came from', paid.evidence[0].url === 'https://janeforwi.com/')

  const credit = detectAgencySignals({
    html: '<footer>Site by Northwoods Digital Group</footer><script src="https://secure.actblue.com/w.js"></script>',
    url: 'https://janeforwi.com',
  })
  t('a footer vendor credit is captured', credit.evidence.some(e => e.type === 'vendor_credit'))
  t('an ActBlue embed registers as a platform fingerprint',
    credit.evidence.some(e => e.type === 'platform_embed' && /ActBlue/.test(e.detail)))

  const staff = detectAgencySignals({ html: '<p>Campaign Manager: Sam Smith</p>', url: 'https://a.com' })
  t('a lone staff title is evidence but not, by itself, a detection',
    staff.evidence.some(e => e.type === 'staff_page') && staff.detected === false)

  const research = detectAgencySignals({
    html: '', url: '',
    researchText: 'Meta Ad Library shows ads paid for by Cardinal Media https://facebook.com/ads/library/?id=1',
  })
  t('a cited ad-library line becomes evidence', research.evidence.some(e => e.type === 'ad_library'))
  t('uncited research lines are dropped',
    detectAgencySignals({ researchText: 'They probably use a consultant.' }).evidence.length === 0)
  t('nothing in the evidence shape references CFIS/campaign finance',
    !JSON.stringify(credit).toLowerCase().includes('cfis'))
}

// ─── E3: contact extraction + assembly ───────────────────────────────────────
console.log('E3 — contact extraction (compliant sources, per-field confidence)')
{
  const html = `<a href="mailto:info@janeforwi.com">Email</a><a href="tel:+1-715-555-0142">Call</a>
    <p>Press: press@janeforwi.com or (715) 555-0199</p>
    <img src="logo@2x.png"> <script>Sentry.init({dsn:"https://x@sentry.io/1"})</script>`
  const c = extractContactsFromHtml(html)
  t('mailto and body emails are both found', c.emails.includes('info@janeforwi.com') && c.emails.includes('press@janeforwi.com'))
  t('toolchain noise is filtered out', !c.emails.some(e => /sentry|@2x/.test(e)))
  t('phones are normalized to one format', c.phones.includes('(715) 555-0142') && c.phones.includes('(715) 555-0199'))
  t('empty html yields empty lists', extractContactsFromHtml('').emails.length === 0)

  const merged = buildContact({
    site: { emails: ['info@janeforwi.com'], phones: ['(715) 555-0142'] },
    siteUrl: 'https://janeforwi.com',
    research: { emails: [{ value: 'jane@news.example', source_url: 'https://news.example/story', confidence: 65 }], phones: [] },
    db: { email: 'old@list.example', phone: null },
  })
  t('the candidate\'s own site outranks research and the DB', merged.emails[0].source === 'candidate_website' && merged.confidence === 85)
  t('every contact point carries a source', merged.emails.every(e => !!e.source) && merged.phones.every(p => !!p.source))
  t('every contact point carries a confidence', merged.emails.every(e => typeof e.confidence === 'number'))
  t('research contacts keep their citation URL',
    merged.emails.find(e => e.source === 'web_research').source_url === 'https://news.example/story')
  t('duplicates are collapsed',
    buildContact({ site: { emails: ['a@b.com', 'A@B.com'], phones: [] } }).emails.length === 1)
  t('the compliance note travels with the contact record', /11\.1304/.test(merged.compliance_note))
  t('no contact at all is an honest zero', buildContact({}).confidence === 0 && buildContact({}).source === null)
}

// ─── E4: tri-state website answer + citation parsing ─────────────────────────
console.log('E4 — websiteState + parseCitedFields')
t('a verified fetch is "yes"', websiteState({ verified: true, hasFacebook: false }) === 'yes')
t('no site but a Facebook page is "facebook_only" (a better lead, not a "no")',
  websiteState({ verified: false, hasFacebook: true }) === 'facebook_only')
t('nothing at all is "no"', websiteState({ verified: false, hasFacebook: false }) === 'no')

{
  const parsed = parseCitedFields([
    'CAMPAIGN_WEBSITE: https://janeforwi.com',
    'EMAIL: info@janeforwi.com — https://janeforwi.com/contact',
    'PHONE: unknown',
    'PARTY: Republican (no source)',
  ].join('\n'))
  t('cited lines are kept', parsed.EMAIL[0].value === 'info@janeforwi.com' && parsed.EMAIL[0].source_url === 'https://janeforwi.com/contact')
  t('a URL-only line still counts as cited', parsed.CAMPAIGN_WEBSITE[0].source_url === 'https://janeforwi.com/')
  t('uncited lines are dropped entirely', !parsed.PHONE && !parsed.PARTY)
  t('prose without fields parses to nothing', Object.keys(parseCitedFields('I could not find anything.')).length === 0)
}

// ─── C1: CSV export builder ──────────────────────────────────────────────────
console.log('C1 — buildProspectCsv')
{
  const { buildProspectCsv, csvEscape, csvFilename, COLUMNS, factorSummary } =
    await import('../src/lib/prospectCsv.js')

  t('quotes are doubled and the field wrapped', csvEscape('say "hi"') === '"say ""hi"""')
  t('commas force quoting', csvEscape('Doe, Jane') === '"Doe, Jane"')
  t('newlines force quoting', csvEscape('a\nb') === '"a\nb"')
  t('formula injection is neutralized', csvEscape('=cmd|calc').startsWith("'="))
  t('null/undefined become empty', csvEscape(null) === '' && csvEscape(undefined) === '')

  const row = {
    name: 'Jane "JD" Doe',
    office_name: 'Assembly, District 85',
    win_odds_score: 71.5,
    win_odds_band: 'strong',
    win_odds_factors: { confidence: 0.75, factors: [{ label: 'Incumbency', points: 31.3, available: true }] },
    affiliation: 'Republican',
    affiliation_detail: { inferred: true, confidence: 80, basis: 'Endorsed by county GOP' },
    website_state: 'yes',
    website_url: 'https://janeforwi.com',
    socials: { facebook: 'https://facebook.com/j', x: null },
    agency_signals: { detected: true, confidence: 65, evidence: [{ type: 'paid_for_by', detail: 'Paid for by X', url: 'https://a.com' }] },
    contact: { emails: [{ value: 'info@janeforwi.com', source: 'candidate_website', confidence: 85 }], phones: [], source: 'candidate_website', confidence: 85 },
    enrichment_status: 'enriched',
    enriched_at: '2026-08-12T10:00:00Z',
    research_citations: [{ label: 'EMAIL', url: 'https://janeforwi.com/contact' }],
  }
  const csv = buildProspectCsv([row])
  const lines = csv.split('\r\n')
  t('header + one row', lines.length === 2)
  t('header matches the column allowlist', lines[0].split(',').length === COLUMNS.length)
  t('embedded quotes survive the round trip', lines[1].includes('"Jane ""JD"" Doe"'))
  t('a comma in the office name does not add a column',
    lines[1].includes('"Assembly, District 85"'))
  t('agency detection exports as yes/no', lines[1].includes(',yes,'))
  t('contact source and confidence are exported', csv.includes('candidate_website') && csv.includes('85'))
  t('the win-odds factors are exported as the WHY', factorSummary(row) === 'Incumbency 31.3 pts' && csv.includes('Incumbency 31.3 pts'))
  t('an inferred affiliation is labelled INFERRED', csv.includes('INFERRED'))
  t('no CFIS/campaign-finance column exists',
    !/cfis|campaign finance|disbursement|treasurer/i.test(lines[0]))
  t('an empty list still produces a header', buildProspectCsv([]).split('\r\n').length === 1)
  t('junk rows do not throw', buildProspectCsv([null, {}, { socials: 'nope' }]).split('\r\n').length === 4)
  t('filename is date-stamped and safe', /^badger_prospects_\d{4}-\d{2}-\d{2}\.csv$/.test(csvFilename('badger prospects', new Date('2026-08-12T00:00:00Z'))))
}


// ── Apollo-style confidence bands (owner decision #3) ────────────────────────
{
  const { confidenceBand, buildProspectCsv } = await import('../src/lib/prospectCsv.js')
  t('band: >=85 is Verified', confidenceBand(85) === 'Verified' && confidenceBand(100) === 'Verified')
  t('band: 60-84 is Likely', confidenceBand(60) === 'Likely' && confidenceBand(84) === 'Likely')
  t('band: <60 is Unconfirmed', confidenceBand(59) === 'Unconfirmed' && confidenceBand(0) === 'Unconfirmed')
  t('band: null/garbage is empty', confidenceBand(null) === '' && confidenceBand('x') === '')
  const csv = buildProspectCsv([{ name: 'A', contact: { emails: [{ value: 'a@b.c', source: 's', confidence: 62 }], phones: [{ value: '555', source: 's', confidence: 90 }] } }])
  t('CSV carries band columns and vocabulary round-trips',
    csv.includes('Email confidence band') && csv.includes('Phone confidence band') &&
    csv.includes('Likely') && csv.includes('Verified'))
}

// ─── V3: AI discovery + brief enrichment (Prospecting rebuild, Sept 2026) ────
console.log('V3 — discover-prospects-background pure helpers')
{
  const d = require('../netlify/functions/discover-prospects-background.js')
  t('party normalizes every spelling the model uses',
    d.normalizeParty('Rep') === 'Republican' && d.normalizeParty('Democratic') === 'Democrat' &&
    d.normalizeParty('Ind.') === 'Independent' && d.normalizeParty('non-partisan') === 'Nonpartisan' &&
    d.normalizeParty('Libertarian') === 'Other' && d.normalizeParty('??') === null)
  t('level classifies by office name when the model omits it',
    d.normalizeLevel('County Board Supervisor') === 'county' && d.normalizeLevel('State Assembly') === 'state' &&
    d.normalizeLevel('Wausau Mayor') === 'municipal' && d.normalizeLevel('School Board') === 'school' &&
    d.normalizeLevel('US House') === 'federal')
  const cites = ['https://ballotpedia.org/a', 'https://news.example.com/b']
  t('source refs resolve citation indexes AND raw URLs',
    d.resolveSource('[2]', cites) === 'https://news.example.com/b' && d.resolveSource('1', cites) === 'https://ballotpedia.org/a' &&
    d.resolveSource('https://x.org/p', cites) === 'https://x.org/p' && d.resolveSource('[9]', cites) === null)
  t('inline markers are stripped from values', d.stripMarkers('Jane Doe [1][2]') === 'Jane Doe')
  const prose = 'Found these [1]:\n```json\n[{"name":"Jane Doe [1]","office":"County Board Supervisor","source_url":"[1]"},{"name":"John Roe","office":"Mayor","source_url":"https://x.org/r"},{"name":"Nocite Guy","office":"Mayor"},{"name":"Cher","office":"Mayor","source_url":"[2]"},{"name":"Trunc'
  const entries = d.parseCandidateJson(prose)
  t('parser anchors on the object array (not a [1] in prose) and salvages a truncated array', entries.length === 4)
  const rows = d.buildProspectRows(entries, { userId: 'u', query: { mode: 'county', county: 'Marathon', electionYear: 2026 }, citations: cites })
  t('rows: uncited and single-token names dropped, index refs resolved, siloed (candidate_id null)',
    rows.length === 2 && rows.every(r => r.candidate_id === null && r.discovery_source === 'ai_discovery') &&
    rows[0].research_citations[0].url === 'https://ballotpedia.org/a' && rows[0].level === 'county' && rows[1].level === 'municipal')
  t('discovery metadata rides in win_odds_factors.discovery (no migration)', rows[0].win_odds_factors.discovery.query.county === 'Marathon')
  t('de-dupes on name+office', d.buildProspectRows([
    { name: 'A B', office: 'Mayor', source_url: 'https://x.org/1' }, { name: 'a  b', office: 'MAYOR', source_url: 'https://x.org/2' },
  ], { userId: 'u', query: {}, citations: [] }).length === 1)
  t('cap is 50', d.MAX_DISCOVERED === 50)

  // Jurisdiction guard — the Milwaukee bug: county search returned SD-17 and a Governor.
  const { COUNTY_DISTRICTS } = require('../netlify/functions/_wi-county-districts.js')
  t('county→district map covers all 72 counties', Object.keys(COUNTY_DISTRICTS).length === 72)
  t('map: Marathon = AD 35/69/85/86/87, SD 12/23/29, CD 7',
    COUNTY_DISTRICTS.Marathon.assembly.join() === '35,69,85,86,87' && COUNTY_DISTRICTS.Marathon.senate.join() === '12,23,29' && COUNTY_DISTRICTS.Marathon.congress.join() === '7')
  t('chamber classification', d.chamberOf('State Senator') === 'senate' && d.chamberOf('State Representative') === 'assembly' &&
    d.chamberOf('U.S. Representative') === 'congress' && d.chamberOf('Governor of Wisconsin') === 'statewide' && d.chamberOf('County Board Supervisor') === 'local')
  t('district number parsing', d.districtNumberOf('District 17', null) === 17 && d.districtNumberOf(null, 'Senate District 3') === 3 &&
    d.districtNumberOf('4th Congressional District', null) === 4 && d.districtNumberOf(null, 'County Sheriff') === null)
  const rej = []
  const kept = d.buildProspectRows([
    { name: 'Corrine Hendrickson', office: 'State Senator', district: 'District 17', source_url: 'https://a.org/1' },
    { name: 'Tom Tiffany', office: 'Governor of Wisconsin', source_url: 'https://a.org/2' },
    { name: 'Tim Carpenter', office: 'State Senator', district: 'District 3', source_url: 'https://a.org/3' },
    { name: 'Jane Local', office: 'Milwaukee County Board Supervisor', district: 'District 4', source_url: 'https://a.org/4' },
    { name: 'Other County', office: 'Village Board Trustee', county: 'Waukesha', source_url: 'https://a.org/5' },
    { name: 'No Number', office: 'State Representative', source_url: 'https://a.org/6' },
    { name: 'Gwen Moore', office: 'U.S. Representative', district: '4th Congressional District', source_url: 'https://a.org/7' },
  ], { userId: 'u', query: { mode: 'county', county: 'Milwaukee', electionYear: 2026 }, citations: [], rejected: rej })
  t('county mode keeps only races that touch the county (SD-3, county board, CD-4)',
    kept.map(r => r.name).join() === 'Tim Carpenter,Jane Local,Gwen Moore' && kept.every(r => r.county === 'Milwaukee'))
  t('county mode rejects SD-17, statewide, other-county local, and district-less state rows with reasons',
    rej.length === 4 && /district 17/.test(rej[0]) && /statewide/.test(rej[1]) && /Waukesha/.test(rej[2]) && /without a district/.test(rej[3]))
  t('no county searched → county is what the model said, never the query',
    d.buildProspectRows([{ name: 'A B', office: 'Mayor', county: 'Dane', source_url: 'https://a.org/9' }], { userId: 'u', query: { mode: 'level', level: 'municipal' }, citations: [] })[0].county === 'Dane')
}

console.log('V3 — enrich-prospects-background brief mode helpers')
{
  const m = require('../netlify/functions/enrich-prospects-background.js')
  t('brief cap is 50, deep cap still 10', m.MAX_BRIEF_PER_RUN === 50 && m.MAX_PROSPECTS_PER_RUN === 10)
  const txt = 'PARTY: Republican — https://ballotpedia.org/x\nEMAIL: jane@janefor.com — https://janefor.com/contact\nWIN_ODDS: 72\nRATIONALE: Incumbent in an R+12 district.'
  const est = m.parseBriefEstimate(txt)
  t('estimate parsed without requiring a citation', est.score === 72 && /R\+12/.test(est.rationale))
  t('out-of-range or missing WIN_ODDS → null', m.parseBriefEstimate('WIN_ODDS: 140').score === null && m.parseBriefEstimate('').score === null)
  t('bands match the deep model vocabulary', m.bandFor(72) === 'strong' && m.bandFor(50) === 'competitive' && m.bandFor(12) === 'longshot' && m.bandFor(null) === 'unknown')
  t('cited fact lines still parse alongside the estimate', Object.keys(m.parseCitedFields(txt)).sort().join() === 'EMAIL,PARTY')
}

console.log('V3 — CSV labels the estimate honestly')
{
  const { buildProspectCsv, factorSummary, isEstimate } = await import('../src/lib/prospectCsv.js')
  const row = { name: 'A B', win_odds_score: 63, win_odds_band: 'competitive', win_odds_factors: { model_version: 'ai_estimate_v1', estimate: true, rationale: 'Open seat, lean R.' } }
  t('isEstimate detects brief rows', isEstimate(row) && !isEstimate({ win_odds_factors: { factors: [] } }))
  t('factor summary carries the rationale', factorSummary(row) === 'AI estimate: Open seat, lean R.')
  const csv = buildProspectCsv([row])
  t('CSV says "AI estimate" in the confidence column', csv.includes('AI estimate'))
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
