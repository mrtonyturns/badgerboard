#!/usr/bin/env node
/**
 * build-place-demographics.mjs
 *
 * Builds public/geodata/wi-place-demographics.json from U.S. Census Bureau
 * ACS 5-year (2023) Data Profile tables (DP02, DP03, DP04, DP05) for every
 * Wisconsin county subdivision (city / village / town), keeping only places
 * with population >= MIN_POP.
 *
 * Output schema is defined in src/lib/placeDemographics.js — DO NOT change
 * the shape here without updating that file's header comment too.
 *
 * Data source: data.census.gov's keyless "access/data/table" endpoint (the
 * same one data.census.gov's own UI uses). api.census.gov now requires an
 * API key and is intentionally NOT used here.
 *
 * Usage:
 *   node scripts/build-place-demographics.mjs
 */

import { writeFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')
const OUT_PATH = path.join(REPO_ROOT, 'public/geodata/wi-place-demographics.json')
const GEOJSON_PATH = path.join(REPO_ROOT, 'public/geodata/wi-municipal-simplified.geojson')

const STATE_FIPS = '55'
const MIN_POP = 1500
const VINTAGE = 'ACS 2019-2023 5-Year Estimates'

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'

// Statewide county-subdivision query — one request per profile table covers
// all WI county subdivisions in a single shot.
const TABLE_URL = (id) =>
  `https://data.census.gov/api/access/data/table?g=040XX00US${STATE_FIPS}%240600000&id=ACSDP5Y2023.${id}`

const SENTINELS = new Set([-888888888, -666666666, -999999999, -222222222, -333333333])

function cleanNum(v) {
  if (v === null || v === undefined) return null
  if (typeof v === 'string') {
    const t = v.trim()
    if (t === '' || t === 'N' || t === '(X)' || t === '-') return null
    v = Number(t)
  }
  if (typeof v !== 'number' || Number.isNaN(v)) return null
  if (SENTINELS.has(v)) return null
  return v
}

async function fetchTable(id) {
  const url = TABLE_URL(id)
  console.log(`Fetching ${id} ...`)
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } })
  if (!res.ok) throw new Error(`${id} fetch failed: HTTP ${res.status}`)
  const json = await res.json()
  const data = json?.response?.data
  if (!Array.isArray(data) || data.length < 2) throw new Error(`${id} returned no data rows`)
  const header = data[0]
  const rows = data.slice(1)
  const idx = Object.fromEntries(header.map((h, i) => [h, i]))
  return { idx, rows }
}

function rowsToMap(table, keyCol) {
  const map = new Map()
  for (const row of table.rows) {
    const key = row[table.idx[keyCol]]
    if (key != null) map.set(key, row)
  }
  return map
}

function get(table, row, code) {
  const i = table.idx[code]
  if (i === undefined) return null
  return cleanNum(row[i])
}

// "Wausau city, Marathon County, Wisconsin" -> { place: "Wausau city", county: "Marathon" }
function parseName(name) {
  const parts = String(name).split(',').map((s) => s.trim())
  if (parts.length < 3) return null
  const place = parts[0]
  let county = parts[1]
  county = county.replace(/\s+County$/i, '').trim()
  return { place, county }
}

function ctvFromPlace(place) {
  const lower = place.toLowerCase()
  if (lower.endsWith(' city')) return 'city'
  if (lower.endsWith(' village')) return 'village'
  if (lower.endsWith(' town')) return 'town'
  return null
}

async function main() {
  const [dp02, dp03, dp04, dp05] = await Promise.all([
    fetchTable('DP02'),
    fetchTable('DP03'),
    fetchTable('DP04'),
    fetchTable('DP05'),
  ])

  const dp02ByGeo = rowsToMap(dp02, 'GEO_ID')
  const dp03ByGeo = rowsToMap(dp03, 'GEO_ID')
  const dp04ByGeo = rowsToMap(dp04, 'GEO_ID')

  const places = {}
  let kept = 0
  let droppedPop = 0
  let droppedNonCtv = 0
  let droppedNoName = 0

  for (const row of dp05.rows) {
    const geoId = row[dp05.idx.GEO_ID]
    const nameRaw = row[dp05.idx.NAME]
    const parsed = parseName(nameRaw)
    if (!parsed) {
      droppedNoName++
      continue
    }
    const ctv = ctvFromPlace(parsed.place)
    if (!ctv) {
      droppedNonCtv++
      continue
    }

    const pop = get(dp05, row, 'DP05_0001E')
    if (pop == null || pop < MIN_POP) {
      droppedPop++
      continue
    }

    const r02 = dp02ByGeo.get(geoId)
    const r03 = dp03ByGeo.get(geoId)
    const r04 = dp04ByGeo.get(geoId)

    // geoid: strip the "0600000US" prefix to get the standard 10-digit
    // state+county+cousub FIPS code.
    const geoid = String(geoId).replace(/^0600000US/, '')

    const entry = {
      name: parsed.place,
      ctv,
      county: parsed.county,
      geoid,
      pop,
      median_age: get(dp05, row, 'DP05_0018E'),
      under18_pct: get(dp05, row, 'DP05_0019PE'),
      over65_pct: get(dp05, row, 'DP05_0024PE'),
      voting_age_pop: get(dp05, row, 'DP05_0021E'),
      white_pct: get(dp05, row, 'DP05_0037PE'),
      black_pct: get(dp05, row, 'DP05_0038PE'),
      hispanic_pct: get(dp05, row, 'DP05_0076PE'),
      asian_pct: get(dp05, row, 'DP05_0047PE'),
      native_pct: get(dp05, row, 'DP05_0039PE'),
      two_plus_pct: get(dp05, row, 'DP05_0035PE'),
      median_hh_income: r03 ? get(dp03, r03, 'DP03_0062E') : null,
      poverty_pct: r03 ? get(dp03, r03, 'DP03_0128PE') : null,
      households: r02 ? get(dp02, r02, 'DP02_0001E') : null,
      avg_hh_size: r02 ? get(dp02, r02, 'DP02_0016E') : null,
      ownership_pct: r04 ? get(dp04, r04, 'DP04_0046PE') : null,
      median_home_value: r04 ? get(dp04, r04, 'DP04_0089E') : null,
      median_rent: r04 ? get(dp04, r04, 'DP04_0134E') : null,
      hs_plus_pct: r02 ? get(dp02, r02, 'DP02_0067PE') : null,
      bachelors_plus_pct: r02 ? get(dp02, r02, 'DP02_0068PE') : null,
      veterans: r02 ? get(dp02, r02, 'DP02_0070E') : null,
      unemployment_pct: r03 ? get(dp03, r03, 'DP03_0009PE') : null,
    }

    const key = `${parsed.county.toLowerCase()}|${parsed.place.toLowerCase()}`
    if (places[key]) {
      console.warn(`WARNING: duplicate key ${key}, overwriting`)
    }
    places[key] = entry
    kept++
  }

  console.log(
    `Parsed ${dp05.rows.length} DP05 rows -> kept ${kept}, dropped(pop<${MIN_POP})=${droppedPop}, dropped(non city/village/town)=${droppedNonCtv}, dropped(unparseable name)=${droppedNoName}`
  )

  const output = {
    meta: {
      source: 'U.S. Census Bureau, American Community Survey (ACS) 5-Year Data Profiles (DP02, DP03, DP04, DP05), via data.census.gov',
      vintage: VINTAGE,
      generated: new Date().toISOString(),
      minPop: MIN_POP,
      stateFips: STATE_FIPS,
    },
    places,
  }

  await mkdir(path.dirname(OUT_PATH), { recursive: true })
  await writeFile(OUT_PATH, JSON.stringify(output))
  console.log(`Wrote ${OUT_PATH}`)

  // ---- Validation: join against the municipal geojson ----
  try {
    const geojsonRaw = await (await import('node:fs/promises')).readFile(GEOJSON_PATH, 'utf8')
    const geojson = JSON.parse(geojsonRaw)
    const geoKeys = new Set(
      geojson.features.map((f) => {
        const p = f.properties
        return `${String(p.COUNTY_NAME || '').toLowerCase().trim()}|${String(p.NAME || '').toLowerCase().trim()}`
      })
    )
    const jsonKeys = Object.keys(places)
    let matched = 0
    const mismatches = []
    for (const k of jsonKeys) {
      if (geoKeys.has(k)) matched++
      else mismatches.push(k)
    }
    const rate = ((matched / jsonKeys.length) * 100).toFixed(1)
    console.log(`\nGeojson join validation: ${matched}/${jsonKeys.length} (${rate}%) JSON keys matched a geojson feature.`)
    if (mismatches.length) {
      console.log(`First ${Math.min(10, mismatches.length)} mismatches (of ${mismatches.length}):`)
      for (const m of mismatches.slice(0, 10)) console.log(`  - ${m}`)
    }
  } catch (e) {
    console.warn(`Could not validate against geojson: ${e.message}`)
  }

  // ---- Spot checks ----
  const spotChecks = [
    ['milwaukee', 'milwaukee city'],
    ['marathon', 'wausau city'],
    ['dane', 'madison city'],
  ]
  console.log('\nSpot checks:')
  for (const [county, name] of spotChecks) {
    const key = `${county}|${name}`
    const p = places[key]
    if (!p) {
      console.log(`  ${key}: NOT FOUND`)
    } else {
      console.log(
        `  ${key}: pop=${p.pop} median_age=${p.median_age} median_hh_income=${p.median_hh_income}`
      )
    }
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
