#!/usr/bin/env node
// Badger Board — Recruit-from-voter-list unit tests.
// Zero-config: node tests/recruit.test.mjs
//
// Covers the three pure-helper surfaces of the feature:
//   R1 — office type → district column mapping (and the sub-state-only filter)
//   R2 — CSV header-alias additions for the WEC district columns
//   R3 — research-output validation / Unknown coercion / guardrails

let pass = 0, fail = 0
const t = (name, cond) => { cond ? pass++ : fail++; console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${name}`) }

const R = await import('../src/lib/recruit.js')

// ─── R1: office type → district column ───────────────────────────────────────
console.log('R1 — office-type → district-column mapping')

t('county board  → county_supervisory_district', R.districtColumnForOfficeType('county_board') === 'county_supervisory_district')
t('city council   → aldermanic_district',        R.districtColumnForOfficeType('city_council') === 'aldermanic_district')
t('school board   → school_district',            R.districtColumnForOfficeType('school_board') === 'school_district')
t('village board  → ward',                       R.districtColumnForOfficeType('village_board') === 'ward')
t('town board     → ward',                       R.districtColumnForOfficeType('town_board') === 'ward')
t('unknown key    → empty string',               R.districtColumnForOfficeType('congress') === '')
t('every declared type maps to a real voters column',
  R.RECRUIT_OFFICE_TYPES.every(x => ['county_supervisory_district', 'aldermanic_district', 'school_district', 'ward'].includes(x.districtColumn)))

// Rows shaped exactly like netlify/functions/seed-wi-offices.js output.
const OFFICES = [
  { name: 'Marathon County Board Supervisor — District 4', level: 'county', office_type: 'legislative', county: 'Marathon', district_number: 4 },
  { name: 'Marathon County Board Supervisor — District 5', level: 'county', office_type: 'legislative', county: 'Marathon', district_number: 5 },
  { name: 'Marathon County Sheriff',                       level: 'county', office_type: 'executive', county: 'Marathon' },
  { name: 'Marathon County Register of Deeds',             level: 'county', office_type: 'administrative', county: 'Marathon' },
  { name: 'City of Wausau Common Council — District 3',    level: 'municipal', office_type: 'legislative', city: 'Wausau', district_number: 3 },
  { name: 'City of Milwaukee Common Council — District 1', level: 'municipal', office_type: 'legislative', city: 'Milwaukee', district_number: 1 },
  { name: 'Wausau School District Board — Seat 2',         level: 'municipal', office_type: 'administrative', city: 'Wausau', notes: 'Nonpartisan school board' },
  { name: 'Village of Weston Board Trustee — Seat 1',      level: 'municipal', office_type: 'legislative', city: 'Weston' },
  { name: 'Town of Rib Mountain Board Supervisor — Seat 2',level: 'municipal', office_type: 'legislative', city: 'Rib Mountain' },
  { name: 'City of Wausau Mayor',                          level: 'municipal', office_type: 'executive', city: 'Wausau' },
  { name: 'U.S. House — Wisconsin District 7',             level: 'federal', office_type: 'legislative', district_number: 7 },
  { name: 'U.S. Senate — Wisconsin (Class I)',             level: 'federal', office_type: 'legislative' },
  { name: 'Governor of Wisconsin',                         level: 'state', office_type: 'executive' },
  { name: 'Wisconsin State Assembly — District 85',        level: 'state', office_type: 'legislative', district_number: 85 },
  { name: 'Wisconsin State Senate — District 29',          level: 'state', office_type: 'legislative', district_number: 29 },
  { name: 'Wisconsin Supreme Court Justice',               level: 'state', office_type: 'judicial' },
]

t('county board supervisor classifies as county_board', R.classifyOffice(OFFICES[0]) === 'county_board')
t('common council classifies as city_council',          R.classifyOffice(OFFICES[4]) === 'city_council')
t('school district board classifies as school_board',   R.classifyOffice(OFFICES[6]) === 'school_board')
t('village trustee classifies as village_board',        R.classifyOffice(OFFICES[7]) === 'village_board')
t('town board supervisor classifies as town_board',     R.classifyOffice(OFFICES[8]) === 'town_board')
t('county row office (Sheriff) is NOT recruitable',     R.classifyOffice(OFFICES[2]) === null)
t('county row office (Register of Deeds) is NOT recruitable', R.classifyOffice(OFFICES[3]) === null)
t('municipal executive (Mayor) is NOT a board seat',    R.classifyOffice(OFFICES[9]) === null)
t('federal House excluded',                             R.classifyOffice(OFFICES[10]) === null)
t('federal Senate excluded',                            R.classifyOffice(OFFICES[11]) === null)
t('statewide executive excluded',                       R.classifyOffice(OFFICES[12]) === null)
t('state Assembly (state-legislative) excluded',        R.classifyOffice(OFFICES[13]) === null)
t('state Senate (state-legislative) excluded',          R.classifyOffice(OFFICES[14]) === null)
t('state judicial excluded',                            R.classifyOffice(OFFICES[15]) === null)
t('no federal/state row survives the level filter',
  OFFICES.filter(o => ['federal', 'state'].includes(o.level)).every(o => R.classifyOffice(o) === null))
t('isRecruitEligibleLevel rejects federal/state, accepts county/municipal',
  !R.isRecruitEligibleLevel('federal') && !R.isRecruitEligibleLevel('state')
  && R.isRecruitEligibleLevel('county') && R.isRecruitEligibleLevel('municipal'))
t('null/undefined office is not classified', R.classifyOffice(null) === null && R.classifyOffice(undefined) === null)

const types = R.availableOfficeTypes(OFFICES)
t('office types are enumerated from the offices DB, not hard-coded',
  types.map(x => x.key).sort().join(',') === 'city_council,county_board,school_board,town_board,village_board')
t('county_board count reflects the two seeded supervisor seats',
  types.find(x => x.key === 'county_board').officeCount === 2)
t('an offices table with only federal/state rows yields no office types',
  R.availableOfficeTypes(OFFICES.filter(o => ['federal', 'state'].includes(o.level))).length === 0)
t('officesForType narrows by county', R.officesForType(OFFICES, 'county_board', { county: 'Marathon' }).length === 2)
t('officesForType narrows by city',   R.officesForType(OFFICES, 'city_council', { city: 'Wausau' }).length === 1)

// ─── R2: CSV header aliases for the WEC district columns ─────────────────────
console.log('R2 — CSV alias additions (WEC / Badger Voters district columns)')

// parseCSV lowercases headers but keeps spaces — this is a real WEC-shaped row.
const wecRow = {
  'firstname': 'Dana', 'lastname': 'Reed', 'address': '12 Elm St', 'city': 'Wausau',
  'county': 'Marathon', 'ward': 'Ward 3',
  'county supervisory district': '04',
  'aldermanic district': 'District 7',
  'school district': 'Wausau School District',
  'high school district': 'Wausau High',
  'sanitary district': 'Rib Mountain Sanitary #1',
  'some vendor column': 'ignore me',
}
const wec = R.extractDistrictColumns(wecRow)
t('captures County Supervisory District', wec.county_supervisory_district === '04')
t('captures Aldermanic District',         wec.aldermanic_district === 'District 7')
t('captures School District',             wec.school_district === 'Wausau School District')
t('captures Ward',                        wec.ward === 'Ward 3')
t('high school district is NOT mistaken for school district', wec.school_district === 'Wausau School District')
t('unknown columns keep being ignored (only the 4 canonical keys returned)',
  Object.keys(wec).sort().join(',') === 'aldermanic_district,county_supervisory_district,school_district,ward')

const snakeRow = R.extractDistrictColumns({
  county_supervisory_district: '9', ALDERMANIC_DIST: '2', 'Sch_Dist': 'DC Everest', precinct: 'P-1',
})
t('snake_case / abbreviated / mixed-case headers all land',
  snakeRow.county_supervisory_district === '9' && snakeRow.aldermanic_district === '2'
  && snakeRow.school_district === 'DC Everest' && snakeRow.ward === 'P-1')

const emptyRow = R.extractDistrictColumns({ 'county supervisory district': 'N/A', 'aldermanic district': '  ', 'school district': 'NONE' })
t('"N/A" / blank / "NONE" normalise to empty, not to junk districts',
  emptyRow.county_supervisory_district === '' && emptyRow.aldermanic_district === '' && emptyRow.school_district === '')
t('a row with no district columns yields all-empty (existing uploads unaffected)',
  Object.values(R.extractDistrictColumns({ firstname: 'A', lastname: 'B' })).every(v => v === ''))
t('null row does not throw', Object.values(R.extractDistrictColumns(null)).every(v => v === ''))
t('normalizeHeader strips punctuation and case', R.normalizeHeader('County Supervisory-District ') === 'countysupervisorydistrict')

t('normalizeDistrictValue: "04" → "4"',            R.normalizeDistrictValue('04') === '4')
t('normalizeDistrictValue: "District 7" → "7"',    R.normalizeDistrictValue('District 7') === '7')
t('normalizeDistrictValue: "4th" → "4"',           R.normalizeDistrictValue('4th') === '4')
t('normalizeDistrictValue keeps school district names',
  R.normalizeDistrictValue('  Wausau  School District ') === 'Wausau School District')
t('districtValuesMatch is numeric- and case-insensitive',
  R.districtValuesMatch('04', 'District 4') && R.districtValuesMatch('wausau school district', 'Wausau School District'))
t('districtValuesMatch never matches on blanks', !R.districtValuesMatch('', '') && !R.districtValuesMatch(null, '4'))

const VOTERS = [
  { id: 1, full_name: 'A A', county_supervisory_district: '4',  aldermanic_district: '7', school_district: 'Wausau', ward: '1' },
  { id: 2, full_name: 'B B', county_supervisory_district: '04', aldermanic_district: '2', school_district: 'Wausau', ward: '2' },
  { id: 3, full_name: 'C C', county_supervisory_district: '10', aldermanic_district: '',  school_district: 'DC Everest', ward: '2' },
  { id: 4, full_name: 'D D', county_supervisory_district: '',   aldermanic_district: '7', school_district: '', ward: '' },
]
const opts = R.districtOptionsFromVoters(VOTERS, 'county_board')
t('district options are distinct + normalised', opts.map(o => o.value).join(',') === '4,10')
t('district options sort numerically, not lexically', opts[0].value === '4' && opts[1].value === '10')
t('district options carry resident counts', opts[0].count === 2 && opts[1].count === 1)
t('school-district options are name-based', R.districtOptionsFromVoters(VOTERS, 'school_board').map(o => o.value).sort().join(',') === 'DC Everest,Wausau')
t('matchVotersToDistrict matches "04" against "4"', R.matchVotersToDistrict(VOTERS, 'county_board', '4').map(v => v.id).join(',') === '1,2')
t('matchVotersToDistrict uses the aldermanic column for city council',
  R.matchVotersToDistrict(VOTERS, 'city_council', '7').map(v => v.id).join(',') === '1,4')
t('matchVotersToDistrict with no district returns nothing', R.matchVotersToDistrict(VOTERS, 'county_board', '').length === 0)
t('listSupportsOfficeType true when the column is populated', R.listSupportsOfficeType(VOTERS, 'county_board') === true)
t('listSupportsOfficeType false when the list lacks the column (banner case)',
  R.listSupportsOfficeType([{ id: 9, full_name: 'x', county: 'Marathon' }], 'county_board') === false)

// ─── R3: research output validator / Unknown coercion ────────────────────────
console.log('R3 — research-output validator + Unknown coercion')

const twoSources = [
  { title: 'Wausau Pilot story', url: 'https://wausaupilotandreview.com/a' },
  { title: 'County minutes',     url: 'https://co.marathon.wi.us/minutes.pdf' },
]
const good = R.coerceResearchOutput({
  affiliation: { value: 'Republican', confidence: 82, basis: 'Listed on a county party slate.' },
  notoriety: 'Medium', sentiment: 'positive',
  summary: 'Spoke at three county board meetings about zoning.',
  evidence: twoSources,
})
t('valid output with 2 independent sources survives', good.affiliation.value === 'republican' && good.notoriety === 'medium' && good.sentiment === 'positive')
t('enum values are lowercased', good.affiliation.value === 'republican')
t('confidence is preserved', good.affiliation.confidence === 82)
t('summary is preserved', good.summary.startsWith('Spoke at three'))
t('source_count counts distinct hosts', good.source_count === 2 && good.thin === false)

const thin = R.coerceResearchOutput({
  affiliation: { value: 'democrat', confidence: 95, basis: 'A blog said so.' },
  notoriety: 'high', sentiment: 'negative', summary: 'Widely disliked.',
  evidence: [
    { title: 'One', url: 'https://wausaupilotandreview.com/a' },
    { title: 'Two', url: 'https://www.wausaupilotandreview.com/b' },   // same host
  ],
})
t('THIN EVIDENCE ⇒ affiliation unknown', thin.affiliation.value === 'unknown')
t('THIN EVIDENCE ⇒ notoriety unknown',   thin.notoriety === 'unknown')
t('THIN EVIDENCE ⇒ sentiment unknown',   thin.sentiment === 'unknown')
t('THIN EVIDENCE ⇒ summary and basis dropped', thin.summary === '' && thin.affiliation.basis === '')
t('THIN EVIDENCE keeps the links so the user can still verify', thin.evidence.length === 2 && thin.thin === true)
t('www. and bare host count as ONE independent source', thin.source_count === 1)

const empty = R.coerceResearchOutput({})
t('empty model output coerces to all-unknown', empty.affiliation.value === 'unknown' && empty.notoriety === 'unknown' && empty.sentiment === 'unknown')
t('non-object model output does not throw', R.coerceResearchOutput(null).notoriety === 'unknown' && R.coerceResearchOutput('nope').sentiment === 'unknown')

const badEnums = R.coerceResearchOutput({
  affiliation: 'libertarian-ish', notoriety: 'VERY HIGH', sentiment: 'spicy', evidence: twoSources,
})
t('out-of-schema affiliation → unknown', badEnums.affiliation.value === 'unknown')
t('out-of-schema notoriety → unknown',   badEnums.notoriety === 'unknown')
t('out-of-schema sentiment → unknown',   badEnums.sentiment === 'unknown')
t('affiliation supplied as a plain string is accepted',
  R.coerceResearchOutput({ affiliation: 'independent', evidence: twoSources }).affiliation.value === 'independent')
t('confidence is clamped to 0-100',
  R.coerceResearchOutput({ affiliation: { value: 'other', confidence: 400 }, evidence: twoSources }).affiliation.confidence === 100)
t('non-numeric confidence becomes null',
  R.coerceResearchOutput({ affiliation: { value: 'other', confidence: 'high' }, evidence: twoSources }).affiliation.confidence === null)

const dirty = R.coerceResearchOutput({
  affiliation: { value: 'democrat', confidence: 70, basis: 'x' },
  notoriety: 'low', sentiment: 'mixed',
  evidence: [
    ...twoSources,
    { title: 'javascript', url: 'javascript:alert(1)' },
    { title: 'ftp',        url: 'ftp://files.example.com/x' },
    { title: 'not a url',  url: 'wausau daily herald' },
    { title: 'dupe',       url: 'https://wausaupilotandreview.com/a' },
    { url: 'https://ballotpedia.org/x' },
  ],
})
t('javascript: URLs are dropped',  !dirty.evidence.some(e => /javascript:/i.test(e.url)))
t('non-http(s) URLs are dropped',  !dirty.evidence.some(e => e.url.startsWith('ftp:')))
t('garbage URLs are dropped',      !dirty.evidence.some(e => e.url === 'wausau daily herald'))
t('duplicate URLs are de-duplicated', dirty.evidence.filter(e => e.url === 'https://wausaupilotandreview.com/a').length === 1)
t('an evidence item with no title falls back to its host', dirty.evidence.find(e => e.url.includes('ballotpedia')).title === 'ballotpedia.org')

const fabricated = R.coerceResearchOutput(
  { affiliation: 'republican', notoriety: 'high', sentiment: 'positive', evidence: [
    { title: 'real', url: 'https://co.marathon.wi.us/minutes.pdf' },
    { title: 'invented', url: 'https://totally-made-up.example.com/story' },
  ] },
  { allowedUrls: ['https://co.marathon.wi.us/minutes.pdf'] }
)
t('NO FABRICATED URLS: links outside the citations array are dropped',
  fabricated.evidence.length === 1 && fabricated.evidence[0].url === 'https://co.marathon.wi.us/minutes.pdf')
t('dropping a fabricated link can push a result under the thin-evidence bar',
  fabricated.thin === true && fabricated.notoriety === 'unknown')

t('protected attribute detected in free text', R.hasProtectedAttribute('She is a devout Catholic and a nurse.') === true)
t('ordinary civic text is not flagged', R.hasProtectedAttribute('Spoke at the county board about the levy.') === false)
const protectedOut = R.coerceResearchOutput({
  affiliation: { value: 'republican', confidence: 80, basis: 'Active in her church congregation.' },
  notoriety: 'medium', sentiment: 'positive',
  summary: 'A Hispanic small-business owner who testified on zoning.',
  evidence: twoSources,
})
t('PROTECTED ATTRIBUTES: summary mentioning ethnicity is dropped', protectedOut.summary === '')
t('PROTECTED ATTRIBUTES: affiliation basis mentioning religion is dropped', protectedOut.affiliation.basis === '')
t('the non-protected labels still survive the scrub', protectedOut.notoriety === 'medium' && protectedOut.affiliation.value === 'republican')
t('PROTECTED ATTRIBUTES: an evidence title mentioning a felony conviction is scrubbed to the host',
  R.coerceResearchOutput({ evidence: [{ title: 'Felony conviction in 2011', url: 'https://news.example.com/a' }, ...twoSources] })
    .evidence[0].title === 'news.example.com')

const row = R.researchOutputToRow(good)
t('researchOutputToRow flattens to the prospect columns',
  row.affiliation_value === 'republican' && row.notoriety === 'medium'
  && row.sentiment === 'positive' && Array.isArray(row.evidence) && row.research_summary.length > 0)

t('cache key normalises name/city/zip', R.researchCacheKey({ full_name: 'Dana  Reed', city: 'Wausau', zip: '54401-1234' }) === 'danareed|wausau|54401')
t('cache key is stable across punctuation/case', R.researchCacheKey({ full_name: "O'Brien, Pat", city: 'Wausau', zip: '54401' }) === R.researchCacheKey({ full_name: 'obrien pat', city: 'WAUSAU', zip: '54401' }))
t('empty identity yields no cache key', R.researchCacheKey({}) === '')

t('isUnknownProspect true when every field is unknown',
  R.isUnknownProspect({ affiliation_value: 'unknown', notoriety: 'unknown', sentiment: 'unknown' }) === true)
t('isUnknownProspect true for a never-researched row (all fields absent)', R.isUnknownProspect({}) === true)
t('isUnknownProspect false as soon as one field is known',
  R.isUnknownProspect({ affiliation_value: 'unknown', notoriety: 'low', sentiment: 'unknown' }) === false)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
