/**
 * placeDemographics.js — shared contract for the city-demographics feature.
 *
 * Data file: /public/geodata/wi-place-demographics.json
 * {
 *   meta:   { source, vintage, generated, minPop, stateFips },
 *   places: {
 *     "<county lower>|<name lower>": {      // e.g. "marathon|wausau city"
 *       name, ctv, county, geoid,
 *       pop, median_age, under18_pct, over65_pct, voting_age_pop,
 *       white_pct, black_pct, hispanic_pct, asian_pct, native_pct, two_plus_pct,
 *       median_hh_income, poverty_pct, households, avg_hh_size,
 *       ownership_pct, median_home_value, median_rent,
 *       hs_plus_pct, bachelors_plus_pct, veterans, unemployment_pct
 *     }
 *   }
 * }
 * Keys match the municipal geojson: county = feature.properties.COUNTY_NAME,
 * name = feature.properties.NAME ("Wausau city", "Hartford town", …).
 * Only places with pop >= 1500 are included.
 */

let cachePromise = null

/** Lazy-load + memoize the demographics file. Resolves to null on failure. */
export function loadPlaceDemographics() {
  if (!cachePromise) {
    cachePromise = fetch('/geodata/wi-place-demographics.json')
      .then(r => (r.ok ? r.json() : null))
      .catch(() => null)
  }
  return cachePromise
}

/** Canonical lookup key from map-feature properties. */
export function placeKey(county, name) {
  return `${String(county || '').toLowerCase().trim()}|${String(name || '').toLowerCase().trim()}`
}

/** URL slug for one path segment ("Wausau city" -> "wausau-city"). */
export function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

/** Route for the full city page. */
export function placePath(county, name) {
  return `/places/${slugify(county)}/${slugify(name)}`
}

/** Find a place entry by route slugs. Returns [key, place] or null. */
export function findPlaceBySlugs(data, countySlug, nameSlug) {
  if (!data?.places) return null
  for (const [key, p] of Object.entries(data.places)) {
    if (slugify(p.county) === countySlug && slugify(p.name) === nameSlug) return [key, p]
  }
  return null
}

/* ── formatters ── */
export const fmtNum = n => (n == null || Number.isNaN(+n) ? '—' : (+n).toLocaleString('en-US'))
export const fmtMoney = n => (n == null || Number.isNaN(+n) ? '—' : '$' + Math.round(+n).toLocaleString('en-US'))
export const fmtPct = n => (n == null || Number.isNaN(+n) ? '—' : (+n).toFixed(1) + '%')

/** Pretty display name: "Wausau city" -> "City of Wausau" style short label. */
export function displayName(p) {
  if (!p?.name) return ''
  const m = p.name.match(/^(.*)\s+(city|village|town)$/i)
  if (!m) return p.name
  const kind = m[2][0].toUpperCase() + m[2].slice(1).toLowerCase()
  return `${m[1]} (${kind})`
}
