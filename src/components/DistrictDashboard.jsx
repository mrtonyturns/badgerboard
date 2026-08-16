// DistrictDashboard.jsx — full district intelligence view for state & federal
// districts, opened from the Offices map. County/municipal clicks keep the
// simple DistrictPanel. Design: v3 mockup (bold, 3-column, heat map center).
import React, { useEffect, useState, useMemo, useRef, useCallback } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { X, Sparkles, ChevronRight, Loader2, Users, MapPin, RefreshCw } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { pointInGeometry } from '../lib/geo'
import { loadPlaceDemographics, placeKey, placePath } from '../lib/placeDemographics'
import DistrictElectionHistory from './DistrictElectionHistory'
import { partyGroup, isRep, isDem, partyAbbrev, partyColorHex } from '../lib/party'

// ── module-level data caches (fetched once per session) ──────────────────────
let _demoCache = null, _presCache = null, _popCache = null
async function loadStatic() {
  if (!_demoCache) {
    const [d, p, c] = await Promise.all([
      fetch('/geodata/wi-district-demographics.json').then(r => r.json()),
      fetch('/geodata/wi-county-pres.json').then(r => r.json()),
      fetch('/geodata/wi-cousub-pop.json').then(r => r.json()),
    ])
    _demoCache = d; _presCache = p; _popCache = c
  }
  return { demo: _demoCache, pres: _presCache, pop: _popCache }
}

// ── district identity from a map click ───────────────────────────────────────
// v1.19.1 layer keys: congress / ussenate / senate / assembly (legacy
// 'federal' / 'state' still resolve for any cached callers).
export function districtKeyFor(info) {
  const num = parseInt((info.name?.match(/\d+/) || [])[0])
  if ((info.layerKey === 'congress' || info.layerKey === 'federal') && num) {
    return { key: `congress-${num}`, chamber: 'congress', num }
  }
  if (info.layerKey === 'ussenate') {
    return { key: 'state-wi', chamber: 'ussenate', num: null }
  }
  if (info.layerKey === 'senate' && num) return { key: `senate-${num}`, chamber: 'senate', num }
  if (info.layerKey === 'assembly' && num) return { key: `assembly-${num}`, chamber: 'assembly', num }
  if (info.layerKey === 'state' && num) {
    if (info.sublabel === 'State Senate District') return { key: `senate-${num}`, chamber: 'senate', num }
    return { key: `assembly-${num}`, chamber: 'assembly', num }
  }
  if (info.layerKey === 'county' && info.name) {
    const countyName = info.name.replace(/ county$/i, '').trim()
    if (countyName) return { key: `county-${countyName}`, chamber: 'county', num: null, countyName }
  }
  return null
}

const CHAMBER_META = {
  assembly: { office: (n) => `State Representative, Assembly District ${n}`, badge: 'State · Legislative', term: 2,
    elig: (n) => `Qualified elector of Assembly District ${n} (resident 28+ days before filing) · U.S. citizen, age 18+ · nomination papers with 200–400 district signatures · CF-1 + declaration of candidacy filed by June 1 of the election year · no felony conviction unless rights restored` },
  senate:   { office: (n) => `State Senator, Senate District ${n}`, badge: 'State · Legislative', term: 4,
    elig: (n) => `Qualified elector of Senate District ${n} (resident 28+ days before filing) · U.S. citizen, age 18+ · nomination papers with 400–800 district signatures · CF-1 + declaration of candidacy filed by June 1 of the election year · no felony conviction unless rights restored` },
  congress: { office: (n) => `U.S. Representative, Congressional District ${n}`, badge: 'Federal · Legislative', term: 2,
    elig: (n) => `U.S. citizen for 7+ years · age 25+ · resident of Wisconsin (district residency customary, not required) · nomination papers with 1,000–2,000 district signatures · federal FEC registration once raising/spending over $5,000 · WI filing by June 1 of the election year` },
  ussenate: { office: () => `U.S. Senator for Wisconsin`, badge: 'Federal · Statewide', term: 6,
    elig: () => `U.S. citizen for 9+ years · age 30+ · inhabitant of Wisconsin when elected (U.S. Const. Art. I §3) · nomination papers with 2,000–4,000 statewide signatures (Wis. Stat. § 8.15) · federal FEC registration once raising/spending over $5,000 · WI declaration of candidacy + filing by June 1 of the election year · seats are elected statewide on a 6-year cycle (Class I and Class III, staggered)` },
  county:   { office: (n, name) => `County Sheriff of ${name} County`, badge: 'County', term: 4,
    elig: (n, name) => `Qualified elector of ${name} County (resident 28+ days before filing) · U.S. citizen, age 18+ · nomination papers: 500–1,000 county signatures (counties of 100,000+) or 200–400 (smaller counties) · CF-1 + declaration of candidacy by June 1 of the election year · some offices carry extra requirements (Sheriff: law-enforcement certification; District Attorney: WI bar license)` },
}

// Party colors live in lib/party.js so every spelling ('Democrat' /
// 'Democratic' / 'DEM') resolves to the same hex. Pill tints stay local.
const PARTY_TINT = { R: '#FEE2E2', D: '#DBEAFE' }
const heatColor = (g) => g > 0.75 ? '#DC2626' : g > 0.55 ? '#F97316' : g > 0.35 ? '#EAB308' : '#22C55E'

// ── lean computation ──────────────────────────────────────────────────────────
// elections.type is a CHECK-constrained enum with FIVE values —
// 'primary','general','special','spring_primary','spring_general' — so an
// exact `type === 'primary'` test let every spring_primary contest through and
// counted a one-party turnout race as if it measured the district's lean.
// Match the word, not the enumerated spelling (a future 'partisan_primary' or
// 'presidential_primary' is then covered by construction).
const isPrimaryContest = (c) =>
  /primary/i.test(String(c?.election?.type || '')) || /primary/i.test(String(c?.office || ''))

function computeLean({ contests, history, countyMix, pres }) {
  const factors = []
  // Factor 1 — district election results (R share − D share, recency-weighted)
  if (contests?.length) {
    let wsum = 0, sum = 0
    contests.forEach(c => {
      // Primaries measure one party's turnout, not the district's lean — skip them.
      if (isPrimaryContest(c)) return
      const results = c.results || []
      const tot = results.reduce((s, r) => s + (r.votes || 0), 0)
      if (!tot) return
      const r = results.filter(x => isRep(x.party)).reduce((s, x) => s + (x.votes || 0), 0) / tot
      const d = results.filter(x => isDem(x.party)).reduce((s, x) => s + (x.votes || 0), 0) / tot
      if (r === 0 && d === 0) return
      const yr = new Date(c.election?.election_date || 0).getFullYear()
      const w = Math.max(0.3, 1 - (new Date().getFullYear() - yr) * 0.12)
      sum += (r - d) * 100 * w; wsum += w
    })
    if (wsum > 0) factors.push({ label: 'District election results', margin: sum / wsum, weight: 0.5, n: contests.length })
  }
  // Factor 2 — officeholder party history (recency-weighted)
  if (history?.entries?.length) {
    let wsum = 0, sum = 0
    history.entries.forEach(e => {
      const g = partyGroup(e.party)
      const dir = g === 'R' ? 1 : g === 'D' ? -1 : 0
      if (!dir) return
      const margin = e.vote_pct ? (e.vote_pct - 50) * 2 : 10
      const w = Math.max(0.3, 1 - (new Date().getFullYear() - (e.year || 2010)) * 0.08)
      sum += dir * Math.min(Math.abs(margin), 40) * w; wsum += w
    })
    if (wsum > 0) factors.push({ label: 'Officeholder history — this seat', margin: sum / wsum, weight: 0.3, n: history.entries.length })
  }
  // Factor 3 — county presidential results, weighted by district population mix
  if (countyMix && Object.keys(countyMix).length && pres) {
    let sum = 0, wsum = 0
    for (const [county, popShare] of Object.entries(countyMix)) {
      const c = pres[county]
      if (!c) continue
      const YEAR_W = { 2024: 0.5, 2020: 0.3, 2016: 0.2 }
      let m = 0, mw = 0
      for (const [yr, w] of Object.entries(YEAR_W)) {
        const r = c[yr]; if (!r?.total) continue
        m += ((r.gop - r.dem) / r.total) * 100 * w; mw += w
      }
      if (mw > 0) { sum += (m / mw) * popShare; wsum += popShare }
    }
    if (wsum > 0) factors.push({ label: 'County presidential results', margin: sum / wsum, weight: 0.2, n: Object.keys(countyMix).length })
  }
  if (!factors.length) return null
  const totalW = factors.reduce((s, f) => s + f.weight, 0)
  factors.forEach(f => { f.weight = f.weight / totalW })
  const score = factors.reduce((s, f) => s + f.margin * f.weight, 0)
  const points = factors.reduce((s, f) => s + (f.n || 1), 0)
  const confidence = points >= 8 ? 'High' : points >= 4 ? 'Medium' : 'Low'
  return { score, factors, confidence, points }
}

const fmtMargin = (m) => `${m >= 0 ? 'R' : 'D'}+${Math.abs(m).toFixed(0)}`
const leanLabel = (m) => Math.abs(m) < 3 ? 'Toss-up' : `Leans ${m > 0 ? 'conservative' : 'liberal'}`

// ── mini heat map ─────────────────────────────────────────────────────────────
// City dots with pop >= 1500 are clickable when a demographics entry exists
// for them (same key contract as CityDemographicsPanel: placeKey(co, n)) —
// clicking navigates to the full city demographics page. Dots for places with
// no entry (small places, or the JSON hasn't loaded/doesn't exist) stay
// non-interactive, matching current behavior.
const MIN_CLICKABLE_POP = 1500

function DistrictHeatMap({ geometry, popPoints, navigate }) {
  const ref = useRef(null)
  const mapRef = useRef(null)
  const [places, setPlaces] = useState(null) // demographics places map, or null while loading/unavailable

  useEffect(() => {
    let alive = true
    loadPlaceDemographics().then(data => { if (alive) setPlaces(data?.places || {}) })
    return () => { alive = false }
  }, [])

  useEffect(() => {
    if (!ref.current || mapRef.current || !geometry) return
    const map = L.map(ref.current, { scrollWheelZoom: false, zoomControl: true })
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap', maxZoom: 18,
    }).addTo(map)
    const boundary = L.geoJSON({ type: 'Feature', geometry }, {
      style: { color: '#8B0000', weight: 3, fillColor: '#8B0000', fillOpacity: 0.05 },
    }).addTo(map)
    map.fitBounds(boundary.getBounds(), { padding: [14, 14] })

    const inside = (popPoints || []).filter(p => pointInGeometry(p.lng, p.lat, geometry))
    const maxPop = Math.max(1, ...inside.map(p => p.pop))
    inside.forEach(p => {
      if (!p.pop) return
      const g = Math.pow(p.pop / maxPop, 0.35)
      const radius = 700 + Math.sqrt(p.pop) * 55
      const clickable = p.pop >= MIN_CLICKABLE_POP && !!places?.[placeKey(p.co, p.n)]
      L.circle([p.lat, p.lng], { radius: radius * 1.8, color: 'transparent', fillColor: heatColor(g), fillOpacity: 0.10 }).addTo(map)
      const dot = L.circle([p.lat, p.lng], {
        radius, color: 'transparent', fillColor: heatColor(g), fillOpacity: 0.32,
        ...(clickable ? { className: 'dd-heatmap-clickable' } : {}),
      }).addTo(map)
        .bindTooltip(clickable ? `${p.n} — ${p.pop.toLocaleString()} residents · click for demographics` : `${p.n} — ${p.pop.toLocaleString()} residents`, { direction: 'top' })
      if (clickable && navigate) {
        dot.on('click', () => navigate(placePath(p.co, p.n)))
      }
    })
    mapRef.current = map
    const ro = new ResizeObserver(() => { try { map.invalidateSize() } catch (_) {} })
    ro.observe(ref.current)
    return () => { ro.disconnect(); map.remove(); mapRef.current = null }
  }, [geometry, popPoints, places, navigate])
  return (
    <>
      <div ref={ref} style={{ height: '100%', minHeight: 420, borderRadius: 14, overflow: 'hidden' }} className="dd-heatmap" />
      <style>{`.dd-heatmap .dd-heatmap-clickable { cursor: pointer; }`}</style>
    </>
  )
}

// ── main component ────────────────────────────────────────────────────────────
export default function DistrictDashboard({ district, panelOffices, allCandidates, onClose, navigate }) {
  const id = districtKeyFor(district)
  const meta = id ? CHAMBER_META[id.chamber] : null
  const officeLabel = meta ? meta.office(id.num, id.countyName) : district.name

  const [statics, setStatics]   = useState(null)
  const [contests, setContests] = useState([])
  const [history, setHistory]   = useState(null)
  const [histLoading, setHistLoading] = useState(false)
  const [histErr, setHistErr]   = useState(null)
  const [voters, setVoters]     = useState(null)
  const [showAllElig, setShowAllElig] = useState(false)

  // static data + DB contests + cached history + voters
  useEffect(() => {
    let alive = true
    loadStatic().then(s => { if (alive) setStatics(s) })

    const num = id?.num
    const baseSel = supabase.from('election_contests')
      .select('id, office, district, seats, election:elections(id, name, election_date, type), results:election_results(candidate_name, party, votes, vote_pct, winner, declared)')
    if (id?.chamber === 'county') {
      baseSel.eq('county', id.countyName).limit(60).then(({ data }) => { if (alive) setContests(data || []) })
    } else if (id?.chamber === 'ussenate') {
      // Statewide race — no district number to match on
      baseSel.or('office.ilike.%U.S. Senat%,office.ilike.%United States Senat%,office.ilike.%US Senat%')
        .limit(40)
        .then(({ data }) => { if (alive) setContests(data || []) })
    } else {
      const chamberWord = id?.chamber === 'assembly' ? 'Assembly' : id?.chamber === 'senate' ? 'Senate' : 'Congressional'
      baseSel.or(`office.ilike.%${chamberWord}%District ${num}%,district.ilike.%District ${num}%`)
        .limit(40)
        .then(({ data }) => {
          if (!alive) return
          const filtered = (data || []).filter(c =>
            (c.office || '').toLowerCase().includes(chamberWord.toLowerCase()) &&
            new RegExp(`district\\s*0*${num}(\\D|$)`, 'i').test(`${c.office} ${c.district || ''}`))
          setContests(filtered)
        })
    }

    supabase.from('district_intel').select('history').eq('district_key', id?.key || '').maybeSingle()
      .then(({ data }) => { if (alive && data?.history) setHistory(data.history) })

    supabase.from('voters').select('id, full_name, first_name, last_name, address, city, latitude, longitude, voter_list_id').not('latitude', 'is', null).limit(5000)
      .then(({ data }) => { if (alive) setVoters(data || []) })

    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id?.key])

  const demo = statics?.demo?.[id?.key]

  // population-weighted county mix from municipalities inside the boundary
  const countyMix = useMemo(() => {
    if (!statics?.pop || !district.geometry) return null
    const mix = {}
    let total = 0
    statics.pop.forEach(p => {
      if (!p.co || !p.pop) return
      if (pointInGeometry(p.lng, p.lat, district.geometry)) { mix[p.co] = (mix[p.co] || 0) + p.pop; total += p.pop }
    })
    if (!total) return null
    Object.keys(mix).forEach(k => { mix[k] = mix[k] / total })
    return mix
  }, [statics, district.geometry])

  const lean = useMemo(() => computeLean({ contests, history, countyMix, pres: statics?.pres }),
    [contests, history, countyMix, statics])

  const districtCandidates = useMemo(() => {
    const ids = new Set((panelOffices || []).map(o => o.id))
    return (allCandidates || []).filter(c => c.office_id && ids.has(c.office_id))
  }, [panelOffices, allCandidates])

  const eligible = useMemo(() => {
    if (!voters || !district.geometry) return null
    return voters.filter(v => v.longitude != null && pointInGeometry(v.longitude, v.latitude, district.geometry))
  }, [voters, district.geometry])

  const researchHistory = useCallback(async (force = false) => {
    setHistLoading(true); setHistErr(null)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const call = async (payload) => {
        const res = await fetch('/.netlify/functions/research-district-history', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
          body: JSON.stringify({ district_key: id.key, layer: district.layerKey, district_name: district.name, office_label: officeLabel, ...payload }),
        })
        const data = await res.json().catch(() => ({ error: 'Service temporarily unavailable — try again' }))
        if (!res.ok) throw new Error(data.error || 'Research failed')
        return data
      }
      // Two fast calls (web research, then structuring) — each stays under the
      // serverless gateway time limit. Cached results return from call one.
      const step1 = await call({ force, step: 'research' })
      if (step1.history) { setHistory(step1.history); setHistLoading(false); return }
      // research_sig proves the research came from step 1 unmodified (anti-poisoning)
      const step2 = await call({ force, research: step1.research, research_sig: step1.research_sig })
      setHistory(step2.history)
    } catch (e) { setHistErr(e.message) }
    setHistLoading(false)
  }, [id?.key, district, officeLabel])

  const goProfiler = (name, bio) => {
    const ctx = `${officeLabel} — ${district.name}, Wisconsin. ${bio || ''}`.slice(0, 400)
    navigate(`/profiler?newname=${encodeURIComponent(name)}&context=${encodeURIComponent(ctx)}`)
  }

  if (!id) return null
  const people = history?.people || []
  const entries = history?.entries || []
  const current = entries.find(e => e.current)
  const hasContestResults = contests.some(c => (c.results || []).length > 0)
  const leanPct = lean ? Math.max(6, Math.min(94, 50 + lean.score * 1.6)) : 50
  const eligShown = showAllElig ? (eligible || []) : (eligible || []).slice(0, 4)

  const S = {
    kicker: { fontSize: 11, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.45)', fontWeight: 600 },
    cardTitle: { fontSize: 11.5, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.1em', color: '#64748B', display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12 },
    note: { fontWeight: 600, letterSpacing: 0, textTransform: 'none', fontSize: 12, color: '#94A3B8' },
    card: { background: '#fff', borderRadius: 18, padding: '18px 20px', boxShadow: '0 2px 12px rgba(15,23,42,0.05)' },
    stat: { background: '#F8FAFC', borderRadius: 12, padding: '10px 13px', borderLeft: '4px solid #E2E8F0', marginBottom: 8 },
    statHot: { borderLeftColor: '#8B0000' },
    statLabel: { fontSize: 10.5, color: '#94A3B8', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em' },
    statVal: { fontSize: 21, fontWeight: 900, color: '#0F172A', letterSpacing: '-0.02em', lineHeight: 1.3 },
    pill: (bg, fg) => ({ fontSize: 11, fontWeight: 800, padding: '2px 9px', borderRadius: 99, background: bg, color: fg, whiteSpace: 'nowrap' }),
    btn: { fontSize: 12.5, fontWeight: 800, padding: '8px 14px', borderRadius: 10, border: '1.5px solid #E2E8F0', background: '#fff', color: '#334155', cursor: 'pointer', whiteSpace: 'nowrap' },
  }
  const fmt = (v, opts = {}) => v == null ? '—' : opts.money ? `$${Number(v).toLocaleString()}` : opts.pct ? `${v}%` : Number(v).toLocaleString()

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 3000, display: 'flex', alignItems: 'stretch', justifyContent: 'center', background: 'rgba(4,10,22,0.72)', overflowY: 'auto', padding: '24px 12px' }} onClick={onClose}>
      <div style={{ maxWidth: 1240, width: '100%', margin: 'auto' }} onClick={e => e.stopPropagation()}>
        <div style={{ background: '#F4F6FA', borderRadius: 22, overflow: 'hidden', boxShadow: '0 32px 80px rgba(0,0,0,0.55)' }}>

          {/* hero */}
          <div style={{ background: 'linear-gradient(135deg, #0A1628 0%, #12203A 60%, #1A0A0A 100%)', padding: '26px 28px 22px', color: '#fff', position: 'relative' }}>
            <div style={S.kicker}>District intelligence</div>
            <h1 style={{ fontSize: 30, fontWeight: 900, letterSpacing: '-0.02em', lineHeight: 1.05, margin: '6px 0 0' }}>{district.name}</h1>
            <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <span style={{ ...S.pill('#8B0000', '#fff'), padding: '5px 12px' }}>{meta.badge}</span>
              {countyMix && (
                <span style={{ ...S.pill('transparent', 'rgba(255,255,255,0.85)'), border: '1px solid rgba(255,255,255,0.25)', padding: '4px 12px' }}>
                  {Object.entries(countyMix).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([c]) => c).join(', ')} {Object.keys(countyMix).length > 4 ? `+${Object.keys(countyMix).length - 4}` : ''} Co.
                </span>
              )}
              <span style={{ ...S.pill('transparent', 'rgba(255,255,255,0.85)'), border: '1px solid rgba(255,255,255,0.25)', padding: '4px 12px' }}>{(panelOffices || []).length} offices tracked</span>
            </div>
            {lean && (
              <div style={{ position: 'absolute', right: 28, bottom: -24, background: '#fff', borderRadius: 14, padding: '10px 18px', boxShadow: '0 12px 32px rgba(0,0,0,0.18)', textAlign: 'center' }}>
                <div style={{ fontSize: 22, fontWeight: 900, color: lean.score >= 0 ? '#B91C1C' : '#1D4ED8' }}>{fmtMargin(lean.score)}</div>
                <div style={{ fontSize: 10.5, fontWeight: 600, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Voter lean</div>
              </div>
            )}
            <button onClick={onClose} aria-label="Close" style={{ position: 'absolute', top: 20, right: 24, width: 36, height: 36, borderRadius: '50%', background: 'rgba(255,255,255,0.1)', color: '#fff', border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
              <X size={17} />
            </button>
          </div>

          <div style={{ padding: '34px 22px 8px' }}>

            {/* lean bar */}
            <div style={{ ...S.card, marginBottom: 14 }}>
              <div style={S.cardTitle}>Voter lean {lean ? <span style={S.note}>{lean.confidence} confidence · {lean.points} data points</span> : <span style={S.note}>Gathering data…</span>}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                <span style={{ fontSize: 13, fontWeight: 800, color: '#1D4ED8' }}>Liberal</span>
                <div style={{ flex: 1, height: 16, borderRadius: 99, position: 'relative', background: 'linear-gradient(to right, #1D4ED8, #93C5FD 38%, #E2E8F0 50%, #FCA5A5 62%, #B91C1C)' }}>
                  <div style={{ position: 'absolute', left: `${leanPct}%`, top: -6, width: 6, height: 28, background: '#0F172A', border: '2px solid #fff', borderRadius: 4, boxShadow: '0 2px 8px rgba(0,0,0,0.3)', transform: 'translateX(-50%)', transition: 'left .6s ease' }} />
                </div>
                <span style={{ fontSize: 13, fontWeight: 800, color: '#B91C1C' }}>Conservative</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12, flexWrap: 'wrap', gap: 8 }}>
                <b style={{ fontSize: 19, fontWeight: 900, color: lean ? (lean.score >= 0 ? '#B91C1C' : '#1D4ED8') : '#94A3B8' }}>
                  {lean ? `${fmtMargin(lean.score)} — ${leanLabel(lean.score)}` : 'Not enough data yet'}
                </b>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {(lean?.factors || []).map(f => (
                    <span key={f.label} style={{ fontSize: 12, fontWeight: 700, color: '#475569', background: '#F1F5F9', padding: '5px 11px', borderRadius: 99 }}>
                      {f.label} <b style={{ color: f.margin >= 0 ? '#B91C1C' : '#1D4ED8' }}>{fmtMargin(f.margin)} · {Math.round(f.weight * 100)}%</b>
                    </span>
                  ))}
                  {!history && lean && <span style={{ fontSize: 12, fontWeight: 600, color: '#94A3B8' }}>Run history research to add the officeholder factor</span>}
                </div>
              </div>
            </div>

            {/* 3-column band */}
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(210px, 240px) minmax(320px, 1fr) minmax(300px, 350px)', gap: 14, marginBottom: 14 }} className="dd-grid3">
              {/* left — at a glance */}
              <div style={S.card}>
                <div style={S.cardTitle}>At a glance</div>
                <div style={{ ...S.stat, ...S.statHot }}><p style={S.statLabel}>Residents</p><b style={S.statVal}>{fmt(demo?.population)}</b></div>
                <div style={{ ...S.stat, ...S.statHot }}><p style={S.statLabel}>Households</p><b style={S.statVal}>{fmt(demo?.households)}</b></div>
                <div style={{ ...S.stat, ...S.statHot }}><p style={S.statLabel}>Median income</p><b style={S.statVal}>{fmt(demo?.median_hh_income, { money: true })}</b></div>
                <div style={S.stat}><p style={S.statLabel}>Median age</p><b style={S.statVal}>{demo?.median_age ?? '—'}</b></div>
                <div style={S.stat}><p style={S.statLabel}>Homeownership</p><b style={S.statVal}>{fmt(demo?.ownership_pct, { pct: true })}</b></div>
                <div style={S.stat}><p style={S.statLabel}>College degree</p><b style={S.statVal}>{fmt(demo?.bachelors_plus_pct, { pct: true })}</b></div>
                <div style={S.stat}><p style={S.statLabel}>Veterans</p><b style={S.statVal}>{fmt(demo?.veterans)}</b></div>
                <div style={S.stat}><p style={S.statLabel}>Voting-age adults</p><b style={S.statVal}>{fmt(demo?.voting_age_pop)}</b></div>
                <div style={{ fontSize: 11, color: '#B6BFCC', marginTop: 8, fontWeight: 600 }}>U.S. Census ACS 5-year</div>
              </div>

              {/* center — heat map */}
              <div style={{ ...S.card, display: 'flex', flexDirection: 'column' }}>
                <div style={S.cardTitle}>District map — population density <span style={S.note}>Exact boundary</span></div>
                <div style={{ flex: 1 }}>
                  <DistrictHeatMap geometry={district.geometry} popPoints={statics?.pop} navigate={navigate} />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10, flexWrap: 'wrap' }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, color: '#64748B' }}>
                    <span style={{ width: 22, height: 12, borderRadius: 4, background: 'rgba(139,0,0,0.14)', border: '2.5px solid #8B0000' }} /> Boundary
                  </span>
                  <span style={{ fontSize: 12, fontWeight: 700, color: '#22C55E' }}>Low</span>
                  <div style={{ flex: 1, minWidth: 120, height: 10, borderRadius: 99, background: 'linear-gradient(to right, #22C55E, #EAB308, #F97316, #DC2626)' }} />
                  <span style={{ fontSize: 12, fontWeight: 700, color: '#DC2626' }}>High</span>
                </div>
              </div>

              {/* right — office history */}
              <div style={S.card}>
                <div style={S.cardTitle}>Office history <span style={S.note}>{id.chamber === 'county' ? 'County Sheriff · 15 years' : '15 years'}</span></div>

                {!history && !hasContestResults && !histLoading && (
                  <div style={{ textAlign: 'center', padding: '28px 10px' }}>
                    <Sparkles size={26} style={{ color: '#8B0000', margin: '0 auto 10px' }} />
                    <p style={{ fontSize: 14, fontWeight: 700, color: '#0F172A' }}>{id.chamber === 'county' ? 'Research this county\'s flagship seat' : "Research this seat's history"}</p>
                    <p style={{ fontSize: 12.5, color: '#94A3B8', margin: '6px 0 14px', lineHeight: 1.5 }}>
                      {id.chamber === 'county'
                        ? 'AI researches the elected County Sheriff — every officeholder since 2010 with bios and results — then saves it for everyone.'
                        : 'AI finds every officeholder since 2010 with bios and results, then saves it for everyone. Takes ~20 seconds, runs once.'}
                    </p>
                    <button onClick={() => researchHistory(false)} style={{ ...S.btn, background: '#8B0000', borderColor: '#8B0000', color: '#fff' }}>
                      <Sparkles size={13} style={{ display: 'inline', verticalAlign: -2, marginRight: 6 }} />Research history
                    </button>
                    {histErr && <p style={{ fontSize: 12, color: '#B91C1C', marginTop: 10, fontWeight: 600 }}>{histErr}</p>}
                  </div>
                )}
                {histLoading && (
                  <div style={{ textAlign: 'center', padding: '36px 10px' }}>
                    <Loader2 size={26} style={{ color: '#8B0000', margin: '0 auto 10px', animation: 'spin 1s linear infinite' }} />
                    <p style={{ fontSize: 13, fontWeight: 700, color: '#475569' }}>Researching officeholders…</p>
                  </div>
                )}

                {(history || hasContestResults) && !histLoading && (
                  <>
                    {current && (
                      <div style={{ background: 'linear-gradient(135deg, #12203A, #0A1628)', borderRadius: 14, padding: 15, color: '#fff', marginBottom: 12 }}>
                        <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '0.12em', textTransform: 'uppercase', color: '#FCA5A5' }}>Current officeholder</div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 11, marginTop: 8 }}>
                          <div style={{ width: 44, height: 44, borderRadius: 13, background: partyColorHex(current.party), display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15, fontWeight: 900, flexShrink: 0 }}>
                            {String(current?.name || '').split(' ').filter(Boolean).map(w => w[0]).slice(0, 2).join('')}
                          </div>
                          <div>
                            <div style={{ fontSize: 16.5, fontWeight: 900 }}>{current.name}</div>
                            <div style={{ fontSize: 11.5, color: 'rgba(255,255,255,0.6)', fontWeight: 600, marginTop: 1 }}>{current.party}{people.find(p => p.name === current.name)?.served ? ` · ${people.find(p => p.name === current.name).served}` : ''}</div>
                          </div>
                        </div>
                        {current.vote_pct != null && (
                          <>
                            <div style={{ height: 7, borderRadius: 99, background: 'rgba(255,255,255,0.15)', marginTop: 11, overflow: 'hidden' }}>
                              <div style={{ height: '100%', borderRadius: 99, background: current.party ? partyColorHex(current.party) : '#94A3B8', width: `${current.vote_pct}%`, transition: 'width 1s ease' }} />
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10.5, fontWeight: 700, color: 'rgba(255,255,255,0.65)', marginTop: 4 }}>
                              <span>{current.election}</span><span>{current.vote_pct}% of the vote</span>
                            </div>
                          </>
                        )}
                        <button onClick={() => goProfiler(current.name, null)} style={{ marginTop: 11, background: '#B91C1C', color: '#fff', fontSize: 11.5, fontWeight: 800, padding: '8px 13px', borderRadius: 9, border: 'none', cursor: 'pointer' }}>
                          Create full profile in Profiler →
                        </button>
                      </div>
                    )}

                    <DistrictElectionHistory contests={contests} history={history} onProfiler={goProfiler} />

                    {history?.note && <div style={{ fontSize: 11.5, color: '#94A3B8', fontWeight: 600, marginTop: 4 }}>{history.note}</div>}
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 10 }}>
                      <span style={{ fontSize: 11.5, color: '#94A3B8', fontWeight: 600 }}>
                        {history ? '✦ AI-researched, saved for all users' : hasContestResults ? 'From live election results' : ''}
                      </span>
                      <button onClick={() => researchHistory(true)} title="Re-run the AI research" style={{ background: 'none', border: 'none', color: '#94A3B8', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, fontSize: 11.5, fontWeight: 700 }}>
                        <RefreshCw size={11} /> {history ? 'Refresh' : 'Research officeholders'}
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* candidates */}
            <div style={{ ...S.card, marginBottom: 14 }}>
              <div style={S.cardTitle}>Your candidates in this district <span style={S.note}>Matched to district offices</span></div>
              {districtCandidates.length === 0 ? (
                <p style={{ fontSize: 13.5, color: '#94A3B8', fontWeight: 600 }}>
                  None of your tracked candidates are linked to offices in this district yet.
                  <button onClick={() => navigate('/candidates')} style={{ background: 'none', border: 'none', color: '#8B0000', fontWeight: 800, cursor: 'pointer', fontSize: 13.5 }}>Add one →</button>
                </p>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: 10 }}>
                  {districtCandidates.map(c => (
                    <div key={c.id} onClick={() => navigate(`/candidates/${c.id}`)}
                      style={{ border: '1.5px solid #E9EDF3', borderRadius: 14, padding: 14, display: 'flex', gap: 12, alignItems: 'center', cursor: 'pointer' }}
                      onMouseEnter={ev => { ev.currentTarget.style.borderColor = '#8B0000' }}
                      onMouseLeave={ev => { ev.currentTarget.style.borderColor = '#E9EDF3' }}>
                      <div style={{ width: 44, height: 44, borderRadius: 13, background: c.party ? partyColorHex(c.party) : '#0A1628', color: '#fff', fontWeight: 800, fontSize: 15, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                        {(c.name || '?').split(' ').map(w => w[0]).slice(0, 2).join('')}
                      </div>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 15, fontWeight: 800, color: '#0F172A' }}>{c.name} {c.party && <span style={S.pill(PARTY_TINT[partyGroup(c.party)] || '#F1F5F9', partyColorHex(c.party))}>{partyAbbrev(c.party)}</span>}</div>
                        <div style={{ fontSize: 12.5, color: '#64748B', marginTop: 2, fontWeight: 600, textTransform: 'capitalize' }}>{c.status || 'exploring'}</div>
                      </div>
                      <ChevronRight size={15} style={{ marginLeft: 'auto', color: '#CBD5E1' }} />
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* eligible to run */}
            <div style={{ ...S.card, marginBottom: 14 }}>
              <div style={S.cardTitle}>Eligible to run — people in your lists <span style={S.note}>Addresses inside this district</span></div>
              <div style={{ background: '#0A1628', borderRadius: 14, padding: '15px 18px', fontSize: 13.5, color: 'rgba(255,255,255,0.85)', lineHeight: 1.65, fontWeight: 500 }}>
                <b style={{ color: '#fff', fontWeight: 800 }}>To run for this seat:</b> {meta.elig(id.num, id.countyName)}
              </div>
              {eligible === null ? (
                <p style={{ fontSize: 13, color: '#94A3B8', fontWeight: 600, marginTop: 12 }}>Checking your voter lists…</p>
              ) : eligible.length === 0 ? (
                <p style={{ fontSize: 13.5, color: '#94A3B8', fontWeight: 600, marginTop: 12 }}>
                  <MapPin size={13} style={{ display: 'inline', verticalAlign: -2 }} /> No one in your voter lists has a geocoded address inside this district yet. Upload a voter CSV with addresses on the Voter Lists page and they'll appear here.
                </p>
              ) : (
                <>
                  <div style={{ marginTop: 6 }}>
                    {eligShown.map(v => {
                      const nm = v.full_name || `${v.first_name || ''} ${v.last_name || ''}`.trim() || 'Unnamed'
                      return (
                        <div key={v.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 0', borderBottom: '1.5px solid #F1F5F9' }}>
                          <div style={{ width: 38, height: 38, borderRadius: '50%', background: '#EFF6FF', color: '#1D4ED8', fontWeight: 800, fontSize: 12.5, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                            {nm.split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase()}
                          </div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 14.5, fontWeight: 800, color: '#0F172A' }}>{nm} <span style={S.pill('#DCFCE7', '#15803D')}>✓ In district</span> <span style={S.pill('#DBEAFE', '#1D4ED8')}>Voter list</span></div>
                            <div style={{ fontSize: 12.5, color: '#94A3B8', marginTop: 2, fontWeight: 500 }}>{[v.address, v.city].filter(Boolean).join(', ') || 'Address on file'} · resident of the district</div>
                          </div>
                          <button onClick={() => navigate('/voter-lists')} style={S.btn}>View</button>
                        </div>
                      )
                    })}
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12, flexWrap: 'wrap', gap: 8 }}>
                    <span style={{ fontSize: 13, color: '#94A3B8', fontWeight: 600 }}>
                      <Users size={13} style={{ display: 'inline', verticalAlign: -2 }} /> {eligible.length.toLocaleString()} {eligible.length === 1 ? 'person' : 'people'} in your lists live in this district
                    </span>
                    {eligible.length > 4 && (
                      <button onClick={() => setShowAllElig(s => !s)} style={{ ...S.btn, background: '#8B0000', borderColor: '#8B0000', color: '#fff' }}>
                        {showAllElig ? 'Show fewer' : `See all ${eligible.length.toLocaleString()} eligible residents →`}
                      </button>
                    )}
                  </div>
                  <p style={{ fontSize: 11.5, color: '#B6BFCC', marginTop: 10, fontWeight: 600 }}>
                    District residency verified by address. Confirm voter registration, age, and other requirements before recruiting.
                  </p>
                </>
              )}
            </div>

            {/* offices footer */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '2px 6px 20px' }}>
              <span style={{ fontSize: 13, color: '#94A3B8', fontWeight: 600 }}>
                {(panelOffices || []).length} tracked {(panelOffices || []).length === 1 ? 'office' : 'offices'} in this district{(panelOffices || []).length ? ` — ${(panelOffices || []).slice(0, 3).map(o => o.name).join(' · ')}${(panelOffices || []).length > 3 ? ' …' : ''}` : ''}
              </span>
              <button onClick={onClose} style={S.btn}>Back to map →</button>
            </div>

          </div>
        </div>
      </div>
      <style>{`@media (max-width: 1000px) { .dd-grid3 { grid-template-columns: 1fr !important; } }`}</style>
    </div>
  )
}
