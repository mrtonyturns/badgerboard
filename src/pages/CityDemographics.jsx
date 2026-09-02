import React, { useEffect, useState, useMemo } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import {
  ArrowLeft, Users, Home, GraduationCap, MapPin, Building2,
  TrendingUp, ShieldCheck, XCircle,
} from 'lucide-react'
import {
  loadPlaceDemographics, findPlaceBySlugs, fmtNum, fmtMoney, fmtPct, displayName,
} from '../lib/placeDemographics'
import { supabase } from '../lib/supabase'

// ── District (county/state) demographics — separate file, separate contract ──
// Keys look like "county-Marathon" and "state-wi". Fields available there:
// population, median_age, voting_age_pop, median_hh_income, households,
// ownership_pct, bachelors_plus_pct, veterans. That's the intersection we use
// for the City vs County vs State comparison strip below.
let districtCachePromise = null
function loadDistrictDemographics() {
  if (!districtCachePromise) {
    districtCachePromise = fetch('/geodata/wi-district-demographics.json')
      .then(r => (r.ok ? r.json() : null))
      .catch(() => null)
  }
  return districtCachePromise
}

function findCountyEntry(district, countyName) {
  if (!district || !countyName) return null
  const exact = district[`county-${countyName}`]
  if (exact) return exact
  const target = String(countyName).toLowerCase().trim()
  const key = Object.keys(district).find(
    k => k.startsWith('county-') && k.slice(7).toLowerCase() === target
  )
  return key ? district[key] : null
}

// ── small formatters not covered by the shared contract ──
const fmtDecimal = (n, digits = 1) => (n == null || Number.isNaN(+n) ? '—' : (+n).toFixed(digits))

const CTV_LABEL = { city: 'City', village: 'Village', town: 'Town' }

// "Tracked in this city" — how many office rows the list fetches. Beyond this,
// the card says "Showing 50 of N" instead of silently cutting the list off.
const OFFICE_LIMIT = 50
const OFFICE_PREVIEW = 10

const RACE_FIELDS = [
  ['white_pct', 'White'],
  ['black_pct', 'Black'],
  ['hispanic_pct', 'Hispanic / Latino'],
  ['asian_pct', 'Asian'],
  ['native_pct', 'Native American'],
  ['two_plus_pct', 'Two or more races'],
]

function bareCityName(place) {
  if (!place?.name) return ''
  return place.name.replace(/\s+(city|village|town)$/i, '').trim()
}

function StatItem({ icon: Icon, label, value, sub }) {
  return (
    <div className="flex items-start gap-3">
      {Icon && (
        <div className="w-8 h-8 rounded-lg bg-brand-navy/5 flex items-center justify-center flex-shrink-0 mt-0.5">
          <Icon className="w-4 h-4 text-brand-navy" />
        </div>
      )}
      <div className="min-w-0">
        <div className="text-xs text-gray-500">{label}</div>
        <div className="text-base font-bold text-gray-900">{value}</div>
        {sub && <div className="text-xs text-gray-400">{sub}</div>}
      </div>
    </div>
  )
}

function RaceBar({ label, pct }) {
  const width = pct == null || Number.isNaN(+pct) ? 0 : Math.max(0, Math.min(100, +pct))
  return (
    <div>
      <div className="flex items-center justify-between text-xs mb-1">
        <span className="text-gray-600">{label}</span>
        <span className="font-semibold text-gray-800">{fmtPct(pct)}</span>
      </div>
      <div className="h-2 rounded-full bg-gray-100 overflow-hidden">
        <div className="h-full bg-brand-red rounded-full" style={{ width: `${width}%` }} />
      </div>
    </div>
  )
}

// ── City vs County vs State comparison row ──
function ComparisonRow({ label, city, county, state, formatter }) {
  const values = [city, county, state].filter(v => v != null && !Number.isNaN(+v)).map(Number)
  if (values.length === 0) return null
  const max = Math.max(...values, 0.0001)
  const rows = [
    { key: 'City', value: city, color: 'bg-brand-red' },
    { key: 'County', value: county, color: 'bg-brand-navy' },
    { key: 'Wisconsin', value: state, color: 'bg-gray-400' },
  ].filter(r => r.value != null && !Number.isNaN(+r.value))

  if (rows.length === 0) return null

  return (
    <div>
      <div className="text-xs font-semibold text-gray-700 mb-2">{label}</div>
      <div className="space-y-1.5">
        {rows.map(r => (
          <div key={r.key} className="flex items-center gap-2">
            <span className="w-14 text-[11px] text-gray-500 flex-shrink-0">{r.key}</span>
            <div className="flex-1 h-2 rounded-full bg-gray-100 overflow-hidden">
              <div
                className={`h-full rounded-full ${r.color}`}
                style={{ width: `${Math.max(2, (Number(r.value) / max) * 100)}%` }}
              />
            </div>
            <span className="w-20 text-[11px] font-semibold text-gray-700 text-right flex-shrink-0">
              {formatter(r.value)}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

function NotFoundCard({ onBack }) {
  return (
    <div className="flex items-center justify-center py-16">
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-8 max-w-md w-full text-center">
        <div className="flex justify-center mb-4">
          <XCircle className="w-10 h-10 text-red-400" />
        </div>
        <h2 className="text-lg font-bold text-gray-900 mb-2">No demographics available</h2>
        <p className="text-sm text-gray-500 leading-relaxed mb-6">
          No demographics available for this municipality — places under 1,500 residents
          aren&apos;t included.
        </p>
        <button
          onClick={onBack}
          className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-brand-red transition-colors"
        >
          <ArrowLeft className="w-4 h-4" /> Back to map
        </button>
      </div>
    </div>
  )
}

export default function CityDemographics() {
  const { countySlug, nameSlug } = useParams()
  const navigate = useNavigate()

  const [placeData, setPlaceData] = useState(null)   // { meta, places } | null
  const [districtData, setDistrictData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [offices, setOffices] = useState([])
  const [officesTotal, setOfficesTotal] = useState(0)
  const [officesLoading, setOfficesLoading] = useState(false)
  const [showAllOffices, setShowAllOffices] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    Promise.all([loadPlaceDemographics(), loadDistrictDemographics()])
      .then(([pd, dd]) => {
        if (cancelled) return
        setPlaceData(pd)
        setDistrictData(dd)
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  const found = useMemo(() => {
    if (!placeData) return null
    return findPlaceBySlugs(placeData, countySlug, nameSlug)
  }, [placeData, countySlug, nameSlug])

  const place = found ? found[1] : null

  useEffect(() => {
    if (!place) { setOffices([]); setOfficesTotal(0); return }
    const bareName = bareCityName(place)
    if (!bareName) { setOffices([]); setOfficesTotal(0); return }
    // Only MUNICIPAL offices for THIS municipality. The old query matched
    // `city ILIKE '%Wausau%'` at any level, which pulled in "Wisconsin Court of
    // Appeals — District III" (seated in Wausau) and every "Wausau"-containing
    // name. Municipal offices are imported either with a `city` value OR with
    // the geography in `district_name` ("City of Wausau", "Town of Grant") —
    // both are matched EXACTLY (case-insensitive), no wildcards.
    // Commas, parens and quotes would be read as PostgREST `or` syntax — strip
    // them, then double-quote each value so names with spaces ("Eau Claire")
    // parse as one literal.
    const clean = (v) => String(v || '').replace(/["'(),*]/g, ' ').replace(/\s+/g, ' ').trim()
    const term = clean(bareName)
    if (!term) { setOffices([]); setOfficesTotal(0); return }
    const ctv = String(place.ctv || '').toLowerCase()
    const geo = ['city', 'village', 'town'].includes(ctv)
      ? [`${ctv} of ${term}`]
      : [`city of ${term}`, `village of ${term}`, `town of ${term}`]
    const county = clean(String(place.county || '').replace(/\s+county$/i, ''))

    let cancelled = false
    setOfficesLoading(true)
    setShowAllOffices(false)
    let q = supabase
      .from('offices')
      .select('id, name, level, office_type, city, county, district_name', { count: 'exact' })
      .eq('level', 'municipal')
      .or([`city.ilike."${term}"`, ...geo.map(g => `district_name.ilike."${g}"`)].join(','))
    // County context: same-named towns exist in different counties. An office
    // row imported without a county is still allowed through.
    if (county) q = q.or(`county.ilike."${county}",county.ilike."${county} County",county.is.null`)
    q.order('name', { ascending: true })
      .limit(OFFICE_LIMIT)
      .then(({ data, error, count }) => {
        if (cancelled) return
        const rows = !error && Array.isArray(data) ? data : []
        setOffices(rows)
        setOfficesTotal(!error && Number.isFinite(count) ? count : rows.length)
      })
      .finally(() => { if (!cancelled) setOfficesLoading(false) })
    return () => { cancelled = true }
  }, [place])

  const handleBack = () => {
    // navigate(-1) with a safe fallback when there's no history to go back to
    // (e.g. the page was opened directly / via a shared link).
    if (typeof window !== 'undefined' && window.history.state && window.history.state.idx > 0) {
      navigate(-1)
    } else {
      navigate('/offices')
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <div className="w-10 h-10 border-4 border-brand-red border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  if (!place) {
    return <NotFoundCard onBack={handleBack} />
  }

  const countyEntry = findCountyEntry(districtData, place.county)
  const stateEntry = districtData ? districtData['state-wi'] : null

  const ctvLabel = CTV_LABEL[String(place.ctv || '').toLowerCase()] || place.ctv || ''
  const countyDisplay = place.county
    ? (/county$/i.test(place.county) ? place.county : `${place.county} County`) + ', Wisconsin'
    : 'Wisconsin'

  return (
    <div className="space-y-6 max-w-6xl">
      {/* Back */}
      <button
        onClick={handleBack}
        className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-brand-red transition-colors"
      >
        <ArrowLeft className="w-4 h-4" /> Back to map
      </button>

      {/* Header */}
      <div
        className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-brand-navy via-[#0d1b30] to-[#16273f] text-white p-7 sm:p-9"
      >
        <div className="relative z-10">
          <div className="flex flex-wrap items-center gap-2 mb-3">
            {ctvLabel && (
              <span className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider bg-white/10 rounded-full px-3 py-1 backdrop-blur">
                <Building2 className="w-3.5 h-3.5" /> {ctvLabel}
              </span>
            )}
            <span className="inline-flex items-center gap-1.5 text-xs text-white/60">
              <MapPin className="w-3.5 h-3.5" /> {countyDisplay}
            </span>
          </div>
          <h1 className="text-3xl sm:text-4xl font-black leading-tight">{displayName(place)}</h1>
          <p className="text-white/70 text-sm mt-3">
            Population <span className="font-bold text-white">{fmtNum(place.pop)}</span>
          </p>
          <p className="text-white/40 text-xs mt-4">Source: U.S. Census ACS 5-year estimates</p>
        </div>
      </div>

      {/* Stat groups */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* PEOPLE */}
        <div className="card space-y-5">
          <div className="flex items-center gap-2">
            <Users className="w-4 h-4 text-brand-red" />
            <h2 className="text-sm font-bold text-gray-900 uppercase tracking-wide">People</h2>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <StatItem label="Population" value={fmtNum(place.pop)} />
            <StatItem label="Median age" value={fmtDecimal(place.median_age)} />
            <StatItem label="Under 18" value={fmtPct(place.under18_pct)} />
            <StatItem label="65 and over" value={fmtPct(place.over65_pct)} />
            <StatItem label="Voting-age population" value={fmtNum(place.voting_age_pop)} />
          </div>
          <div className="pt-2 border-t border-gray-100 space-y-2.5">
            <div className="text-xs font-semibold text-gray-700">Race &amp; ethnicity</div>
            {RACE_FIELDS.map(([field, label]) => (
              <RaceBar key={field} label={label} pct={place[field]} />
            ))}
          </div>
        </div>

        {/* INCOME & HOUSING */}
        <div className="card space-y-5">
          <div className="flex items-center gap-2">
            <Home className="w-4 h-4 text-brand-red" />
            <h2 className="text-sm font-bold text-gray-900 uppercase tracking-wide">Income &amp; Housing</h2>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <StatItem label="Median household income" value={fmtMoney(place.median_hh_income)} />
            <StatItem label="Poverty rate" value={fmtPct(place.poverty_pct)} />
            <StatItem label="Households" value={fmtNum(place.households)} />
            <StatItem label="Avg. household size" value={fmtDecimal(place.avg_hh_size, 2)} />
            <StatItem label="Homeownership rate" value={fmtPct(place.ownership_pct)} />
            <StatItem label="Median home value" value={fmtMoney(place.median_home_value)} />
            <StatItem label="Median rent" value={fmtMoney(place.median_rent)} sub={place.median_rent != null ? 'per month' : null} />
          </div>
        </div>

        {/* EDUCATION & WORK */}
        <div className="card space-y-5">
          <div className="flex items-center gap-2">
            <GraduationCap className="w-4 h-4 text-brand-red" />
            <h2 className="text-sm font-bold text-gray-900 uppercase tracking-wide">Education &amp; Work</h2>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <StatItem label="High school grad or higher" value={fmtPct(place.hs_plus_pct)} />
            <StatItem label="Bachelor's degree or higher" value={fmtPct(place.bachelors_plus_pct)} />
            <StatItem label="Unemployment rate" value={fmtPct(place.unemployment_pct)} />
            <StatItem label="Veterans" value={fmtNum(place.veterans)} />
          </div>
        </div>
      </div>

      {/* Comparison strip: City vs County vs State */}
      {(countyEntry || stateEntry) && (
        <div className="card">
          <div className="flex items-center gap-2 mb-4">
            <TrendingUp className="w-4 h-4 text-brand-red" />
            <h2 className="text-sm font-bold text-gray-900 uppercase tracking-wide">
              How {displayName(place)} compares
            </h2>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-5">
            <ComparisonRow
              label="Median household income"
              city={place.median_hh_income}
              county={countyEntry?.median_hh_income}
              state={stateEntry?.median_hh_income}
              formatter={fmtMoney}
            />
            <ComparisonRow
              label="Median age"
              city={place.median_age}
              county={countyEntry?.median_age}
              state={stateEntry?.median_age}
              formatter={v => fmtDecimal(v)}
            />
            <ComparisonRow
              label="Bachelor's degree or higher"
              city={place.bachelors_plus_pct}
              county={countyEntry?.bachelors_plus_pct}
              state={stateEntry?.bachelors_plus_pct}
              formatter={fmtPct}
            />
            <ComparisonRow
              label="Homeownership rate"
              city={place.ownership_pct}
              county={countyEntry?.ownership_pct}
              state={stateEntry?.ownership_pct}
              formatter={fmtPct}
            />
          </div>
        </div>
      )}

      {/* Tracked in this city */}
      <div className="card">
        <div className="flex items-center gap-2 mb-4">
          <ShieldCheck className="w-4 h-4 text-brand-red" />
          <h2 className="text-sm font-bold text-gray-900 uppercase tracking-wide">Tracked in this city</h2>
        </div>
        {officesLoading ? (
          <div className="flex items-center justify-center py-8">
            <div className="w-6 h-6 border-4 border-brand-red border-t-transparent rounded-full animate-spin" />
          </div>
        ) : offices.length === 0 ? (
          <p className="text-sm text-gray-500">No tracked offices found for this municipality yet.</p>
        ) : (
          <>
            <ul className="divide-y divide-gray-100">
              {(showAllOffices ? offices : offices.slice(0, OFFICE_PREVIEW)).map(o => (
                <li key={o.id}>
                  <Link
                    to="/offices"
                    className="flex items-center justify-between py-2.5 text-sm text-gray-700 hover:text-brand-red transition-colors"
                  >
                    <span className="font-medium">{o.name}</span>
                    <span className="text-xs text-gray-400 capitalize">{o.office_type || o.level}</span>
                  </Link>
                </li>
              ))}
            </ul>
            {(offices.length > OFFICE_PREVIEW || officesTotal > offices.length) && (
              <div className="flex items-center justify-between pt-3 mt-1 border-t border-gray-100 text-xs text-gray-500">
                <span>
                  {showAllOffices || offices.length <= OFFICE_PREVIEW
                    ? `Showing ${offices.length} of ${officesTotal}`
                    : `Showing ${Math.min(OFFICE_PREVIEW, offices.length)} of ${officesTotal}`}
                </span>
                {offices.length > OFFICE_PREVIEW && (
                  <button
                    type="button"
                    onClick={() => setShowAllOffices(v => !v)}
                    className="font-semibold text-brand-navy hover:text-brand-red transition-colors"
                  >
                    {showAllOffices ? 'Show fewer' : `Show all ${offices.length}`}
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
