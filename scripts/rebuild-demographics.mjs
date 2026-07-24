// scripts/rebuild-demographics.mjs
// Rebuilds public/geodata/wi-district-demographics.json from primary-source
// ACS data via the Census Reporter API (latest release — ACS 2024 5-year).
// Covers: statewide, 8 congressional, 33 state senate, 99 assembly, 72 counties.
//
// Field derivations (unchanged schema):
//   population        B01003_001
//   median_age        B01002_001
//   voting_age_pop    B01003_001 − (B01001 males 003–006 + females 027–030)
//   median_hh_income  B19013_001
//   households        B11001_001
//   ownership_pct     B25003_002 / B25003_001 × 100
//   bachelors_plus_pct (B15003_022+023+024+025) / B15003_001 × 100
//   veterans          B21001_002
//
// Usage: node scripts/rebuild-demographics.mjs [--dry-run]

import fs from 'fs'

const TABLES = 'B01003,B01002,B01001,B19013,B11001,B25003,B15003,B21001'
const OUT = 'public/geodata/wi-district-demographics.json'

// Wisconsin county FIPS → county name (72 counties)
const COUNTY_FIPS = {
  '001':'Adams','003':'Ashland','005':'Barron','007':'Bayfield','009':'Brown','011':'Buffalo','013':'Burnett','015':'Calumet','017':'Chippewa','019':'Clark','021':'Columbia','023':'Crawford','025':'Dane','027':'Dodge','029':'Door','031':'Douglas','033':'Dunn','035':'Eau Claire','037':'Florence','039':'Fond du Lac','041':'Forest','043':'Grant','045':'Green','047':'Green Lake','049':'Iowa','051':'Iron','053':'Jackson','055':'Jefferson','057':'Juneau','059':'Kenosha','061':'Kewaunee','063':'La Crosse','065':'Lafayette','067':'Langlade','069':'Lincoln','071':'Manitowoc','073':'Marathon','075':'Marinette','077':'Marquette','078':'Menominee','079':'Milwaukee','081':'Monroe','083':'Oconto','085':'Oneida','087':'Outagamie','089':'Ozaukee','091':'Pepin','093':'Pierce','095':'Polk','097':'Portage','099':'Price','101':'Racine','103':'Richland','105':'Rock','107':'Rusk','109':'St. Croix','111':'Sauk','113':'Sawyer','115':'Shawano','117':'Sheboygan','119':'Taylor','121':'Trempealeau','123':'Vernon','125':'Vilas','127':'Walworth','129':'Washburn','131':'Washington','133':'Waukesha','135':'Waupaca','137':'Waushara','139':'Winnebago','141':'Wood',
}

const pad = (n, w) => String(n).padStart(w, '0')

// key in our dataset → Census Reporter geo_id
const geos = { 'state-wi': '04000US55' }
for (let i = 1; i <= 8; i++)  geos[`congress-${i}`] = `50000US55${pad(i, 2)}`
for (let i = 1; i <= 33; i++) geos[`senate-${i}`]   = `61000US55${pad(i, 3)}`
for (let i = 1; i <= 99; i++) geos[`assembly-${i}`] = `62000US55${pad(i, 3)}`
for (const [fips, name] of Object.entries(COUNTY_FIPS)) geos[`county-${name}`] = `05000US55${fips}`

const round1 = (x) => x == null ? null : Math.round(x * 10) / 10

function deriveFields(geoData, fallbackName) {
  const t = (id) => geoData[id]?.estimate || {}
  const b01003 = t('B01003'), b01002 = t('B01002'), b01001 = t('B01001')
  const b19013 = t('B19013'), b11001 = t('B11001'), b25003 = t('B25003')
  const b15003 = t('B15003'), b21001 = t('B21001')

  const pop = b01003.B01003001 ?? null
  // under-18: males 003–006 + females 027–030
  const under18 = ['003','004','005','006','027','028','029','030']
    .reduce((s, c) => s + (b01001[`B01001${c}`] || 0), 0)
  const vap = pop != null ? pop - under18 : null

  const ownTotal = b25003.B25003001, ownOwner = b25003.B25003002
  const eduTotal = b15003.B15003001
  const eduBach  = ['022','023','024','025'].reduce((s, c) => s + (b15003[`B15003${c}`] || 0), 0)

  return {
    name: fallbackName,
    population: pop,
    median_age: round1(b01002.B01002001),
    voting_age_pop: vap,
    median_hh_income: b19013.B19013001 ?? null,
    households: b11001.B11001001 ?? null,
    ownership_pct: ownTotal ? round1(ownOwner / ownTotal * 100) : null,
    bachelors_plus_pct: eduTotal ? round1(eduBach / eduTotal * 100) : null,
    veterans: b21001.B21001002 ?? null,
  }
}

async function fetchBatch(geoIds, attempt = 0) {
  const url = `https://api.censusreporter.org/1.0/data/show/latest?table_ids=${TABLES}&geo_ids=${geoIds.join(',')}`
  const res = await fetch(url)
  if (!res.ok) {
    if (attempt < 3) {
      await new Promise(r => setTimeout(r, 2000 * (attempt + 1)))
      return fetchBatch(geoIds, attempt + 1)
    }
    throw new Error(`Census Reporter ${res.status} for batch ${geoIds[0]}…`)
  }
  return res.json()
}

const dryRun = process.argv.includes('--dry-run')
const old = JSON.parse(fs.readFileSync(OUT, 'utf8'))
const keys = Object.keys(geos)
const out = {}
let release = null

const BATCH = 12
for (let i = 0; i < keys.length; i += BATCH) {
  const batchKeys = keys.slice(i, i + BATCH)
  const data = await fetchBatch(batchKeys.map(k => geos[k]))
  release = data.release?.name || release
  for (const k of batchKeys) {
    const gid = geos[k]
    const geoData = data.data?.[gid]
    const geoName = data.geography?.[gid]?.name || old[k]?.name || k
    if (!geoData) { console.error(`MISSING ${k} (${gid})`); continue }
    out[k] = deriveFields(geoData, geoName)
  }
  process.stdout.write(`\r${Math.min(i + BATCH, keys.length)}/${keys.length} geographies`)
  await new Promise(r => setTimeout(r, 400))
}
console.log(`\nRelease: ${release}`)

// ── Reconciliation report vs old file ────────────────────────────────────────
let changed = 0, large = []
for (const k of keys) {
  const o = old[k], n = out[k]
  if (!o || !n) continue
  const dp = o.population && n.population ? Math.abs(n.population - o.population) / o.population : 0
  const di = o.median_hh_income && n.median_hh_income ? Math.abs(n.median_hh_income - o.median_hh_income) / o.median_hh_income : 0
  if (n.population !== o.population || n.median_hh_income !== o.median_hh_income) changed++
  if (dp > 0.10 || di > 0.25) large.push({ k, oldPop: o.population, newPop: n.population, oldInc: o.median_hh_income, newInc: n.median_hh_income })
}
console.log(`${changed}/${keys.length} entries updated with fresh ACS values`)
if (large.length) {
  console.log(`⚠ ${large.length} entries changed >10% pop or >25% income (verify these):`)
  large.slice(0, 20).forEach(x => console.log('  ', JSON.stringify(x)))
} else {
  console.log('No implausible jumps — old data was one vintage stale, new data is consistent.')
}

// Sanity checks before writing
const missing = keys.filter(k => !out[k] || out[k].population == null)
if (missing.length) { console.error('ABORT — missing entries:', missing); process.exit(1) }
const statePop = out['state-wi'].population
const assemblySum = keys.filter(k => k.startsWith('assembly-')).reduce((s, k) => s + out[k].population, 0)
const senateSum   = keys.filter(k => k.startsWith('senate-')).reduce((s, k) => s + out[k].population, 0)
const congressSum = keys.filter(k => k.startsWith('congress-')).reduce((s, k) => s + out[k].population, 0)
console.log(`state=${statePop}  Σassembly=${assemblySum}  Σsenate=${senateSum}  Σcongress=${congressSum}`)
const okSum = (s) => Math.abs(s - statePop) / statePop < 0.02
if (!okSum(assemblySum) || !okSum(senateSum) || !okSum(congressSum)) {
  console.error('ABORT — district sums do not reconcile with statewide population')
  process.exit(1)
}

if (dryRun) { console.log('(dry run — file not written)'); process.exit(0) }
fs.writeFileSync(OUT, JSON.stringify(out, null, 1))
console.log(`Wrote ${OUT} (${keys.length} entries, ${release})`)
