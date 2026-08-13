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

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
