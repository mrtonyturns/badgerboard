import React, { useState, useRef, useCallback, useEffect } from 'react'
import {
  Map, Users, BarChart2, Smartphone, Bell, Trophy,
  Plus, Trash2, Zap, X, ChevronRight, Download, Send,
  CheckCircle, Clock, XCircle, MapPin, AlertCircle, Star,
  Calendar, FileText, MessageCircle, Wifi, WifiOff,
  RefreshCw, AlertTriangle, History, UserCheck, Database,
} from 'lucide-react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { useAuth } from '../contexts/AuthContext'
import { getUserPlan } from '../lib/tiers'
import { parseCsvRows } from '../lib/csv'
import {
  getDoorKnockCandidates, getCandidates,
  getShifts, createShift, updateShift, deleteShift,
  getMessages, sendMessage, getDoorKnocksForExport,
  getKnockHistoryByAddress, getDoorKnockLists, createDoorKnockList,
  saveCandidateSurveyQuestions,
  supabase,
  getTurfBlocks, saveTurfBlock, deleteTurfBlock,
  getTurfAssignments, saveTurfAssignment, updateTurfAssignment,
  getVolunteers,
  getVoterFileEntries, upsertVoterFileEntries, getVoterFileCount,
  getDoorKnockStats, getDoorKnockFeed,
} from '../lib/supabase'
import { queueKnock, getPendingKnocks, pendingCount, flushQueue } from '../lib/offlineQueue'
import { VolunteerManager } from './VolunteerPortal'

// ─── Empty defaults — door knocking requires real DB candidates ───────────────
// There is NO static fallback candidate list.  Every user sees only their own
// candidates (fetched from Supabase, filtered by created_by + RLS).
// If a user has no qualifying candidates, the page shows an empty state with
// instructions to add candidates first.
const STATIC_CANDIDATE_CONFIG = {}
const STATIC_CANDIDATE_LIST   = []

// ─── Derive district config from a Supabase candidate row ────────────────────
// Input: { id, name, map_color, office: { level, name, district_number, county, district_name } }
// Output: { name, color, geojson, match, label } — same shape as STATIC_CANDIDATE_CONFIG values
function deriveDistrictConfig(candidate) {
  const office = candidate.office
  if (!office) return null
  const level = office.level
  const oName = (office.name || '').toLowerCase()
  const distNum = office.district_number
  let geojson, featureName
  if (level === 'state' && oName.includes('assembly')) {
    geojson = '/geodata/wi-state-assembly-simplified.geojson'
    featureName = `Assembly District ${distNum}`
  } else if (level === 'state' && oName.includes('senate')) {
    geojson = '/geodata/wi-state-senate-simplified.geojson'
    featureName = `Senate District ${distNum}`
  } else if (level === 'federal') {
    geojson = '/geodata/wi-congressional-simplified.geojson'
    featureName = `Congressional District ${distNum}`
  } else if (level === 'county') {
    geojson = '/geodata/wi-counties-simplified.geojson'
    featureName = office.county ? `${office.county} County` : office.district_name
  } else {
    return null // municipal / other levels not yet supported
  }
  const label = office.district_name
    || (featureName + (office.county ? ` — ${office.county} County` : ''))
  return {
    name: candidate.name,
    color: candidate.map_color || '#4f46e5',
    geojson,
    match: f => f.properties.NAME === featureName,
    label,
  }
}

// ─── Build a candidateConfig map from DB rows ─────────────────────────────────
// Returns { [candidate.id]: configObj } for each candidate with derivable district data.
function buildCandidateConfig(dbRows) {
  const out = {}
  for (const row of dbRows) {
    const cfg = deriveDistrictConfig(row)
    if (cfg) out[row.id] = cfg
  }
  return out
}

// ─── Fetch GeoJSON and return raw geographic data (lat/lng) ──────────────────
// Returns { feature, ring, bbox } — no SVG projection.
// MapLibre handles all coordinate→pixel mapping natively.
const geojsonCache = {}
async function loadDistrictGeometry(cfg) {
  if (!cfg) return null
  if (!geojsonCache[cfg.geojson]) {
    const res = await fetch(cfg.geojson)
    geojsonCache[cfg.geojson] = await res.json()
  }
  const gj = geojsonCache[cfg.geojson]
  const feat = gj.features.find(cfg.match)
  if (!feat) return null
  // Handle MultiPolygon: use the largest outer ring
  let ring
  if (feat.geometry.type === 'MultiPolygon') {
    const rings = feat.geometry.coordinates.map(p => p[0])
    ring = rings.reduce((a, b) => (a.length > b.length ? a : b))
  } else {
    ring = feat.geometry.coordinates[0]
  }
  const lngs = ring.map(c => c[0]), lats = ring.map(c => c[1])
  return {
    feature: feat,
    ring,
    bbox: {
      minLng: Math.min(...lngs), maxLng: Math.max(...lngs),
      minLat: Math.min(...lats), maxLat: Math.max(...lats),
    },
  }
}

const NET_COLORS = ['#4f46e5','#059669','#dc2626','#d97706','#7c3aed','#0369a1','#be185d','#0f766e']

// ─── Point-in-polygon (ray casting) — works in any 2D coordinate space ───────
function pip(px, py, poly) {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1]
    const xj = poly[j][0], yj = poly[j][1]
    if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) inside = !inside
  }
  return inside
}

// ─── Seeded RNG ───────────────────────────────────────────────────────────────
function makeRng(seed) {
  let r = seed
  return () => { r = (r * 1664525 + 1013904223) & 0xffffffff; return (r >>> 0) / 0xffffffff }
}

// ─── Generate houses as lat/lng points inside the district ring ───────────────
// Uses a 60×60 grid sampled across the bounding box, filtered by pip.
// Houses have { id, lng, lat, status, party } — MapLibre renders them directly.
function genHousesInRing(candKey, ring) {
  if (!ring || ring.length < 3) return []
  const rand = makeRng(candKey.charCodeAt(0) * 997 + (candKey.charCodeAt(1) || 0) * 31)
  const lngs = ring.map(c => c[0]), lats = ring.map(c => c[1])
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs)
  const minLat = Math.min(...lats), maxLat = Math.max(...lats)
  const dLng = (maxLng - minLng) / 60
  const dLat = (maxLat - minLat) / 60
  const statuses = ['none','none','none','contacted','not_home','refused']
  const parties  = ['R','R','D','D','I','I','I']
  const result = []
  for (let i = 0; i <= 60; i++) {
    for (let j = 0; j <= 60; j++) {
      // jitter within the grid cell for a natural scatter
      const lng = minLng + i * dLng + (rand() - 0.5) * dLng * 0.5
      const lat = minLat + j * dLat + (rand() - 0.5) * dLat * 0.5
      if (pip(lng, lat, ring) && rand() > 0.55) {
        result.push({
          id: result.length, lng, lat,
          status: statuses[Math.floor(rand() * statuses.length)],
          party:  parties [Math.floor(rand() * parties.length)],
        })
      }
    }
  }
  return result
}

// ─── Count houses inside a lat/lng bounding box ───────────────────────────────
// bbox: { minLng, maxLng, minLat, maxLat }
function countInBbox(houses, bbox) {
  return houses.filter(h =>
    h.lng >= bbox.minLng && h.lng <= bbox.maxLng &&
    h.lat >= bbox.minLat && h.lat <= bbox.maxLat
  ).length
}

// ─── Build a GeoJSON rectangle polygon from a lat/lng bbox ───────────────────
function bboxToGeoJSON(bbox, props = {}) {
  const { minLng, maxLng, minLat, maxLat } = bbox
  return {
    type: 'Feature',
    properties: props,
    geometry: {
      type: 'Polygon',
      coordinates: [[
        [minLng, minLat], [maxLng, minLat],
        [maxLng, maxLat], [minLng, maxLat],
        [minLng, minLat],
      ]],
    },
  }
}

// ─── Time estimate ────────────────────────────────────────────────────────────
function estTime(count) {
  const mins = Math.round(count * 1.75)
  if (mins < 60) return `~${mins} min`
  const hh = Math.floor(mins / 60), mm = mins % 60
  return `~${hh}h${mm ? ` ${mm}min` : ''}`
}

// ─── House fill color ─────────────────────────────────────────────────────────
function houseColor(status) {
  if (status === 'contacted')     return '#16a34a'
  if (status === 'not_home')      return '#eab308'
  if (status === 'refused')       return '#dc2626'
  if (status === 'no_soliciting') return '#d97706'
  return '#9ca3af'
}

// ─── LEADERBOARD data (static demo) ──────────────────────────────────────────
const LEADERBOARD = [
  { rank:1, initials:'RP', name:'Rob Petersen', color:'#8b5cf6', doors:50, contact:66, streak:4 },
  { rank:2, initials:'MJ', name:'Mike Johnson', color:'#ef4444', doors:34, contact:71, streak:3 },
  { rank:3, initials:'TW', name:'Tina Weiss',   color:'#3b82f6', doors:26, contact:58, streak:2 },
  { rank:4, initials:'LS', name:'Lisa Santos',  color:'#f59e0b', doors:19, contact:52, streak:1 },
]

const MEDAL = ['#1','#2','#3','']

// ─── Sub-tab config ───────────────────────────────────────────────────────────
const TABS = [
  { id:'turf',      label:'Turf Builder',    Icon: Map },
  { id:'dash',      label:'Live Dashboard',  Icon: BarChart2 },
  { id:'team',      label:'Team',            Icon: Users },
  { id:'queue',     label:'Follow-up Queue', Icon: Bell },
  { id:'shifts',    label:'Shifts',          Icon: Calendar },
  { id:'messages',   label:'Messages',        Icon: MessageCircle },
  { id:'volunteers', label:'Volunteers',      Icon: UserCheck },
  { id:'voterfile',  label:'Voter File',      Icon: Database },
  { id:'export',     label:'Export',          Icon: FileText },
  { id:'board',      label:'Leaderboard',     Icon: Trophy },
]

// ─── Relative time helper ─────────────────────────────────────────────────────
function relTime(isoStr) {
  if (!isoStr) return ''
  const diff = Date.now() - new Date(isoStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

// ─── Status badge helper ──────────────────────────────────────────────────────
function statusBadge(status) {
  const map = {
    contacted:     { bg:'#dcfce7', c:'#15803d', label:'Contacted' },
    not_home:      { bg:'#fef9c3', c:'#a16207', label:'Left Lit' },
    refused:       { bg:'#fee2e2', c:'#b91c1c', label:'Refused' },
    no_soliciting: { bg:'#fef3c7', c:'#92400e', label:'No Soliciting' },
    moved:         { bg:'#f3f4f6', c:'#6b7280', label:'Moved' },
    wrong_address: { bg:'#fde68a', c:'#92400e', label:'Wrong Addr' },
    do_not_knock:  { bg:'#f1f5f9', c:'#475569', label:'DNC' },
  }
  const s = map[status] || { bg:'#f3f4f6', c:'#6b7280', label: status }
  return (
    <span style={{ display:'inline-block', padding:'2px 7px', borderRadius:4, fontSize:10,
      fontWeight:700, background:s.bg, color:s.c }}>{s.label}</span>
  )
}

// ─── TURF BUILDER (MapLibre) ──────────────────────────────────────────────────
const OFMAP_STYLE = 'https://tiles.openfreemap.org/styles/liberty'

// Satellite style — ESRI World Imagery (free, no API key required).
// Glyphs come from OpenFreeMap so net-label symbols still render in satellite mode.
const SATELLITE_STYLE = {
  version: 8,
  glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
  sources: {
    'esri-satellite': {
      type: 'raster',
      tiles: [
        'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      ],
      tileSize: 256,
      attribution: 'Tiles © Esri — Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGS, and the GIS User Community',
      maxzoom: 20,
    },
  },
  layers: [{ id: 'satellite-bg', type: 'raster', source: 'esri-satellite' }],
}

// ─── Street-based canvassing route optimizer ─────────────────────────────────
// Sorts lat/lng house points using a boustrophedon (snake) pattern that mirrors
// real canvassing: walk south on one side of the street, cross, walk north on
// the other.  Groups houses into ~45m longitude columns (approximate "street
// columns" for WI grid cities) then alternates direction column-by-column.
function buildCanvassingRoute(houses) {
  if (!houses || houses.length === 0) return []
  const CELL = 0.0006  // ~55m column width in WI latitude
  const cols = {}
  for (const h of houses) {
    const k = Math.round(h.lng / CELL)
    if (!cols[k]) cols[k] = { lngSum: 0, n: 0, houses: [] }
    cols[k].houses.push(h)
    cols[k].lngSum += h.lng
    cols[k].n++
  }
  const sorted = Object.values(cols)
    .map(c => ({ avgLng: c.lngSum / c.n, houses: c.houses }))
    .sort((a, b) => a.avgLng - b.avgLng)  // west → east
  const route = []
  sorted.forEach((col, i) => {
    // Alternates S→N on even columns, N→S on odd (boustrophedon)
    const dir = i % 2 === 0 ? 1 : -1
    const hs = col.houses.slice().sort((a, b) => dir * (a.lat - b.lat))
    route.push(...hs)
  })
  return route
}

// Haversine distance in meters between two lat/lng points
function haversineDist(a, b) {
  const R = 6371000
  const dLat = (b.lat - a.lat) * Math.PI / 180
  const dLng = (b.lng - a.lng) * Math.PI / 180
  const sinH = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(sinH))
}

// Total walking distance of a route in meters
function routeDistMeters(route) {
  let d = 0
  for (let i = 1; i < route.length; i++) d += haversineDist(route[i - 1], route[i])
  return d
}

// Human-readable distance (feet under 1000, then miles)
function fmtDist(meters) {
  const feet = meters * 3.28084
  if (feet < 1000) return `${Math.round(feet)}ft`
  return `${(feet / 5280).toFixed(1)}mi`
}

function TurfBuilder({ candKey, cfg, houses, districtGeo, geoLoading, listId }) {
  const { user } = useAuth()
  const mapContainerRef    = useRef(null)
  const mapRef             = useRef(null)
  const drawStartRef       = useRef(null) // { lng, lat } while user is drawing a net
  const styleInitRef       = useRef(false) // skip the first isSatellite effect run
  const [mapLoaded,    setMapLoaded]    = useState(false)
  const [nets,         setNets]         = useState([])
  const [nextId,       setNextId]       = useState(1)
  const [selectedId,   setSelectedId]   = useState(null)
  const [tool,         setTool]         = useState('draw')
  const [isSatellite,  setIsSatellite]  = useState(false)
  const [routeVisible, setRouteVisible] = useState(false)
  // Track DB block IDs keyed by net label so we can upsert
  const blockIdMapRef = useRef({}) // { [netLabel]: uuid }

  // ── Load blocks and assignments from DB on mount / when listId changes ────────
  useEffect(() => {
    if (!listId) return
    Promise.all([getTurfBlocks(listId), getTurfAssignments(listId)]).then(([blocksRes, assignRes]) => {
      const dbBlocks = blocksRes.data || []
      const dbAssign = assignRes.data || []
      if (dbBlocks.length === 0) return
      const assignMap = {}
      for (const a of dbAssign) assignMap[a.block_id] = a.volunteer_name
      const loaded = dbBlocks.map((b, i) => {
        blockIdMapRef.current[b.name] = b.id
        return {
          id: i + 1,
          bbox: b.bbox,
          color: NET_COLORS[i % NET_COLORS.length],
          houseCount: b.house_count,
          label: b.name,
          volunteer: assignMap[b.id] || null,
          _dbId: b.id,
        }
      })
      setNets(loaded)
      setNextId(loaded.length + 1)
    })
  }, [listId])

  // ── Initialise MapLibre once on mount ────────────────────────────────────────
  useEffect(() => {
    if (!mapContainerRef.current) return
    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: OFMAP_STYLE,
      center: [-89.5, 44.5],
      zoom: 10,
      attributionControl: false,
      maxZoom: 20,
    })
    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-left')
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right')
    map.addControl(new maplibregl.ScaleControl({ maxWidth: 100, unit: 'imperial' }), 'bottom-right')
    map.on('load', () => setMapLoaded(true))
    mapRef.current = map
    // ── MapLibre v5 render-loop fix ───────────────────────────────────────────
    // MapLibre v5 uses an IntersectionObserver that pauses the render loop while
    // the canvas container has 0 area (position:static collapses it before the
    // flex layout resolves).  triggerRepaint() is a no-op while _frameRequest is
    // non-null, so the two-rAF approach doesn't help.
    //
    // Fix: use a ResizeObserver on the map container.  Once it reports a non-zero
    // size we know (a) flex has resolved and (b) the IntersectionObserver has
    // already fired and re-enabled the loop.  Calling map._update(true) at that
    // point sets _sourcesDirty + _styleDirty and calls triggerRepaint() — the same
    // sequence that was confirmed to kick off tile loading when called from DevTools.
    let roActive = true
    const ro = new ResizeObserver((entries) => {
      if (!roActive) return
      const { width, height } = entries[0]?.contentRect ?? {}
      if (width > 0 && height > 0) {
        roActive = false        // only need to fire once
        ro.disconnect()
        map.resize()
        map._update(true)       // sets _sourcesDirty=true, _styleDirty=true, triggerRepaint()
      }
    })
    ro.observe(mapContainerRef.current)
    return () => {
      roActive = false
      ro.disconnect()
      map.remove()
      mapRef.current = null
      setMapLoaded(false)
    }
  }, [])

  // ── Satellite ↔ street toggle ────────────────────────────────────────────────
  // Skip on initial mount (styleInitRef guards the first run).
  // On subsequent changes: blank mapLoaded so all layer effects re-run once
  // the new style has loaded, which cleanly re-adds all custom sources/layers.
  useEffect(() => {
    if (!styleInitRef.current) { styleInitRef.current = true; return }
    const map = mapRef.current
    if (!map) return
    setMapLoaded(false)
    map.setStyle(isSatellite ? SATELLITE_STYLE : OFMAP_STYLE)
    const onStyleLoad = () => setMapLoaded(true)
    map.once('style.load', onStyleLoad)
    return () => { try { map.off('style.load', onStyleLoad) } catch {} }
  }, [isSatellite])

  // ── Reset nets when candidate changes ────────────────────────────────────────
  useEffect(() => {
    setNets([]); setNextId(1); setSelectedId(null)
  }, [candKey])

  // ── Fit map to district + add/update district + houses layers ─────────────────
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapLoaded || !districtGeo) return
    const { bbox, feature } = districtGeo

    map.fitBounds(
      [[bbox.minLng, bbox.minLat], [bbox.maxLng, bbox.maxLat]],
      { padding: 60, duration: 800, maxZoom: 15 }
    )

    const districtFC = { type: 'FeatureCollection', features: [feature] }
    if (map.getSource('district')) {
      map.getSource('district').setData(districtFC)
    } else {
      map.addSource('district', { type: 'geojson', data: districtFC })
      map.addLayer({ id: 'district-fill', type: 'fill', source: 'district',
        paint: { 'fill-color': '#4f46e5', 'fill-opacity': 0.07 }
      })
      map.addLayer({ id: 'district-outline', type: 'line', source: 'district',
        paint: { 'line-color': '#4f46e5', 'line-width': 2.5, 'line-dasharray': [5, 3] }
      })
    }
  }, [mapLoaded, districtGeo])

  // ── Houses layer ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapLoaded) return

    const housesFC = {
      type: 'FeatureCollection',
      features: houses.map(h => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [h.lng, h.lat] },
        properties: { id: h.id, status: h.status },
      })),
    }
    if (map.getSource('houses')) {
      map.getSource('houses').setData(housesFC)
    } else {
      map.addSource('houses', { type: 'geojson', data: housesFC, cluster: false })
      map.addLayer({
        id: 'houses-circle',
        type: 'circle',
        source: 'houses',
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, 2.5, 15, 5, 17, 8],
          'circle-color': ['match', ['get', 'status'],
            'contacted',     '#16a34a',
            'not_home',      '#eab308',
            'refused',       '#dc2626',
            'no_soliciting', '#d97706',
            '#9ca3af',
          ],
          'circle-opacity': 0.88,
          'circle-stroke-width': 1,
          'circle-stroke-color': 'rgba(255,255,255,0.5)',
        },
      })
    }
  }, [mapLoaded, houses])

  // ── Nets layer (updates on every nets/selectedId change) ──────────────────────
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapLoaded) return

    const netsFC = {
      type: 'FeatureCollection',
      features: nets.map(n => bboxToGeoJSON(n.bbox, {
        id: n.id, color: n.color, label: n.label, sel: n.id === selectedId ? 1 : 0,
      })),
    }
    if (map.getSource('nets')) {
      map.getSource('nets').setData(netsFC)
    } else {
      map.addSource('nets', { type: 'geojson', data: netsFC })
      map.addLayer({ id: 'nets-fill', type: 'fill', source: 'nets',
        paint: { 'fill-color': ['get', 'color'],
                 'fill-opacity': ['case', ['==', ['get', 'sel'], 1], 0.22, 0.10] }
      })
      map.addLayer({ id: 'nets-outline', type: 'line', source: 'nets',
        paint: { 'line-color': ['get', 'color'],
                 'line-width': ['case', ['==', ['get', 'sel'], 1], 3, 2] }
      })
      map.addLayer({ id: 'nets-labels', type: 'symbol', source: 'nets',
        layout: {
          'text-field': ['get', 'label'],
          'text-size': 12, 'text-font': ['Noto Sans Regular'],
          'text-anchor': 'top-left', 'text-offset': [0.4, 0.4],
        },
        paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#fff', 'text-halo-width': 2 },
      })
    }
  }, [mapLoaded, nets, selectedId])

  // ── Drawing preview source/layers ────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapLoaded) return
    const empty = { type: 'FeatureCollection', features: [] }
    if (!map.getSource('drawing')) {
      map.addSource('drawing', { type: 'geojson', data: empty })
      map.addLayer({ id: 'drawing-fill', type: 'fill', source: 'drawing',
        paint: { 'fill-color': '#6366f1', 'fill-opacity': 0.15 }
      })
      map.addLayer({ id: 'drawing-outline', type: 'line', source: 'drawing',
        paint: { 'line-color': '#6366f1', 'line-width': 2, 'line-dasharray': [4, 2] }
      })
    }
    // ── Route overlay (walking path through houses in boustrophedon order) ──
    if (!map.getSource('route')) {
      map.addSource('route', { type: 'geojson', data: empty })
      map.addLayer({
        id: 'route-line', type: 'line', source: 'route',
        paint: { 'line-color': '#8B0000', 'line-width': 2.5, 'line-opacity': 0.75, 'line-dasharray': [6, 3] },
      })
    }
  }, [mapLoaded])

  // ── Net click → select ────────────────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapLoaded) return
    const onNetClick = (e) => {
      if (e.features?.length) {
        const id = e.features[0].properties.id
        setSelectedId(prev => prev === id ? null : id)
      }
    }
    map.on('click', 'nets-fill', onNetClick)
    return () => map.off('click', 'nets-fill', onNetClick)
  }, [mapLoaded])

  // ── Route overlay — update when routeVisible / selected net changes ───────────
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapLoaded) return
    const empty = { type: 'FeatureCollection', features: [] }
    if (!routeVisible || selectedId === null) {
      map.getSource('route')?.setData(empty)
      return
    }
    const net = nets.find(n => n.id === selectedId)
    if (!net) { map.getSource('route')?.setData(empty); return }
    const netHouses = houses.filter(h =>
      h.lng >= net.bbox.minLng && h.lng <= net.bbox.maxLng &&
      h.lat >= net.bbox.minLat && h.lat <= net.bbox.maxLat
    )
    const route = buildCanvassingRoute(netHouses)
    if (route.length < 2) { map.getSource('route')?.setData(empty); return }
    map.getSource('route')?.setData({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: route.map(h => [h.lng, h.lat]) } }],
    })
  }, [mapLoaded, routeVisible, selectedId, nets, houses])

  // ── Draw-tool mouse interaction ───────────────────────────────────────────────
  // Re-registers whenever tool or houses changes so closures stay current.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapLoaded) return

    // Update cursor
    map.getCanvas().style.cursor = tool === 'draw' ? 'crosshair' : ''

    if (tool !== 'draw') return

    const onDown = (e) => {
      drawStartRef.current = { lng: e.lngLat.lng, lat: e.lngLat.lat }
      map.dragPan.disable()
    }
    const onMove = (e) => {
      if (!drawStartRef.current) return
      const { lng: sLng, lat: sLat } = drawStartRef.current
      const bbox = {
        minLng: Math.min(sLng, e.lngLat.lng), maxLng: Math.max(sLng, e.lngLat.lng),
        minLat: Math.min(sLat, e.lngLat.lat), maxLat: Math.max(sLat, e.lngLat.lat),
      }
      map.getSource('drawing')?.setData({ type: 'FeatureCollection', features: [bboxToGeoJSON(bbox)] })
    }
    const onUp = (e) => {
      if (!drawStartRef.current) return
      const { lng: sLng, lat: sLat } = drawStartRef.current
      drawStartRef.current = null
      map.dragPan.enable()
      map.getSource('drawing')?.setData({ type: 'FeatureCollection', features: [] })

      const bbox = {
        minLng: Math.min(sLng, e.lngLat.lng), maxLng: Math.max(sLng, e.lngLat.lng),
        minLat: Math.min(sLat, e.lngLat.lat), maxLat: Math.max(sLat, e.lngLat.lat),
      }
      // Require at least a ~half-block footprint to prevent accidental tiny nets
      if (bbox.maxLng - bbox.minLng < 0.0004 || bbox.maxLat - bbox.minLat < 0.0003) return

      const count = countInBbox(houses, bbox)
      setNextId(id => {
        const label = `Net ${id}`
        const newNet = {
          id, bbox, color: NET_COLORS[(id - 1) % NET_COLORS.length],
          houseCount: count, label, volunteer: null,
        }
        setNets(prev => [...prev, newNet])
        setSelectedId(id)
        // Persist to DB
        if (listId && user?.id) {
          saveTurfBlock({ list_id: listId, name: label, bbox, house_count: count, created_by: user.id })
            .then(({ data }) => { if (data?.id) blockIdMapRef.current[label] = data.id })
        }
        return id + 1
      })
    }

    map.on('mousedown', onDown)
    map.on('mousemove', onMove)
    map.on('mouseup', onUp)
    return () => {
      map.off('mousedown', onDown)
      map.off('mousemove', onMove)
      map.off('mouseup', onUp)
      map.getCanvas().style.cursor = ''
      map.dragPan.enable()
    }
  }, [mapLoaded, tool, houses])

  // ── deleteNet / autoAssign / stats ───────────────────────────────────────────
  const deleteNet = useCallback((id) => {
    setNets(prev => prev.filter(n => n.id !== id))
    setSelectedId(sel => sel === id ? null : sel)
  }, [])

  const fitDistrict = useCallback(() => {
    const map = mapRef.current
    if (!map || !districtGeo) return
    const { bbox } = districtGeo
    map.fitBounds([[bbox.minLng, bbox.minLat], [bbox.maxLng, bbox.maxLat]], { padding: 60, duration: 600 })
  }, [districtGeo])

  // ─── Street-column auto-assign ───────────────────────────────────────────────
  // Groups houses into N-S "street columns" (0.0006° ≈ 55m in WI) then packages
  // adjacent columns into walking routes of ~TARGET doors each.  This creates
  // routes that follow streets rather than arbitrary rectangles, and the bbox for
  // each net is derived from the actual house positions in that route.
  const autoAssign = useCallback(() => {
    if (!districtGeo || !houses.length) return
    const TARGET  = Math.max(15, Math.min(45, Math.ceil(houses.length / 8)))
    const CELL    = 0.0006   // street column width ~55m
    const PAD     = 0.00015  // small bbox padding

    // Group houses into N-S columns
    const colMap = {}
    for (const h of houses) {
      const k = Math.round(h.lng / CELL)
      if (!colMap[k]) colMap[k] = { k, houses: [] }
      colMap[k].houses.push(h)
    }
    const cols = Object.values(colMap).sort((a, b) => a.k - b.k) // west → east

    // Merge adjacent columns into routes of ~TARGET doors
    const routes = []
    let batch = []
    for (const col of cols) {
      if (batch.length >= TARGET && batch.length + col.houses.length > TARGET * 1.4) {
        routes.push(batch)
        batch = []
      }
      batch.push(...col.houses)
    }
    if (batch.length > 0) routes.push(batch)
    if (routes.length === 0) return

    // Build tight bbox from house positions
    const newNets = routes.map((hs, i) => {
      const lngs = hs.map(h => h.lng)
      const lats = hs.map(h => h.lat)
      return {
        id: i + 1,
        bbox: {
          minLng: Math.min(...lngs) - PAD, maxLng: Math.max(...lngs) + PAD,
          minLat: Math.min(...lats) - PAD, maxLat: Math.max(...lats) + PAD,
        },
        color: NET_COLORS[i % NET_COLORS.length],
        houseCount: hs.length,
        label: `Route ${i + 1}`,
        volunteer: null,
      }
    })
    setNets(newNets)
    setNextId(routes.length + 1)
    setSelectedId(null)
    setRouteVisible(false) // reset route overlay after reassignment
    // Persist auto-assigned blocks to DB
    if (listId && user?.id) {
      blockIdMapRef.current = {}
      for (const n of newNets) {
        saveTurfBlock({ list_id: listId, name: n.label, bbox: n.bbox, house_count: n.houseCount, created_by: user.id })
          .then(({ data }) => { if (data?.id) blockIdMapRef.current[n.label] = data.id })
      }
    }
  }, [districtGeo, houses, listId, user])

  const totalCovered = nets.reduce((s, n) => s + n.houseCount, 0)
  const pctCovered   = houses.length ? Math.round(Math.min(100, (totalCovered / houses.length) * 100)) : 0
  const totalTime    = estTime(totalCovered)

  const btnStyle = (active) => ({
    padding:'4px 11px', borderRadius:6, fontSize:12, fontWeight:600,
    cursor:'pointer', border:'1px solid',
    background: active ? '#0A1628' : '#fff',
    color:      active ? '#fff'    : '#374151',
    borderColor:active ? '#0A1628' : '#E5E7EB',
    transition:'all .15s',
  })

  return (
    <div style={{ display:'flex', flex:1, overflow:'hidden', minHeight:0 }}>
      {/* Map column */}
      <div style={{ flex:1, display:'flex', flexDirection:'column', padding:'12px 0 12px 12px', overflow:'hidden', minWidth:0 }}>

        {/* Toolbar */}
        <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:8, flexWrap:'wrap' }}>
          <span style={{ fontSize:13, fontWeight:700, color:'#111' }}>{cfg?.label}</span>
          <div style={{ marginLeft:'auto', display:'flex', gap:6, alignItems:'center', flexWrap:'wrap' }}>
            <button onClick={() => setTool('draw')}   style={btnStyle(tool==='draw')}>✎ Draw Net</button>
            <button onClick={() => setTool('select')} style={btnStyle(tool==='select')}>↖ Select</button>
            <button onClick={() => setIsSatellite(s => !s)} title={isSatellite ? 'Switch to street map' : 'Switch to satellite view'}
              style={{ ...btnStyle(isSatellite), display:'flex', alignItems:'center', gap:5 }}>
              ◍ {isSatellite ? 'Street' : 'Satellite'}
            </button>
            <button onClick={fitDistrict} title="Fit district in view"
              style={{ padding:'4px 9px', borderRadius:6, fontSize:12, fontWeight:600, cursor:'pointer', border:'1px solid #E5E7EB', background:'#fff', color:'#374151' }}>
              ⊡ Fit
            </button>
            <button onClick={() => { setNets([]); setNextId(1); setSelectedId(null) }}
              style={{ padding:'4px 11px', borderRadius:6, fontSize:12, fontWeight:600, cursor:'pointer', border:'1px solid #E5E7EB', background:'#fff', color:'#374151' }}>
              Clear All
            </button>
            <button onClick={autoAssign}
              style={{ display:'flex', alignItems:'center', gap:6, padding:'6px 14px', borderRadius:8, fontSize:12, fontWeight:700, cursor:'pointer', border:'none', background:'linear-gradient(135deg,#7c3aed,#4f46e5)', color:'#fff' }}>
              <Zap size={13}/> Auto-Assign Nets
            </button>
            <button
              onClick={() => setRouteVisible(v => !v)}
              disabled={selectedId === null}
              title={selectedId === null ? 'Select a net to show its walking route' : routeVisible ? 'Hide walking route' : 'Show street-based walking route for selected net'}
              style={{ display:'inline-flex', alignItems:'center', gap:5, padding:'4px 10px', borderRadius:6, fontSize:12, fontWeight:700, cursor: selectedId === null ? 'not-allowed' : 'pointer', border:'1px solid',
                background: routeVisible ? '#8B0000' : '#faf5ff',
                borderColor: routeVisible ? '#8B0000' : '#e9d5ff',
                color: routeVisible ? '#fff' : '#7e22ce',
                opacity: selectedId === null ? 0.5 : 1,
              }}>
              ➤ {routeVisible ? 'Hide Route' : 'Show Route'}
            </button>
          </div>
        </div>

        {/* MapLibre map container */}
        <div style={{ flex:1, minHeight:0, borderRadius:10, border:'1px solid #E5E7EB', overflow:'hidden', position:'relative' }}>
          <div ref={mapContainerRef} style={{ position:'absolute', inset:0 }}/>

          {/* Loading overlay — shown while district GeoJSON is fetching.
              We no longer gate on mapLoaded; the ResizeObserver fix ensures
              tile loading starts as soon as the container has non-zero size,
              so the style 'load' event fires shortly after the overlay clears. */}
          {geoLoading && (
            <div style={{ position:'absolute', inset:0, display:'flex', alignItems:'center', justifyContent:'center',
              background:'rgba(244,245,247,0.8)', borderRadius:10, pointerEvents:'none' }}>
              <div style={{ textAlign:'center', color:'#6B7280' }}>
                <div style={{ fontSize:24, marginBottom:8 }}>➤</div>
                <div style={{ fontSize:13, fontWeight:600 }}>Loading district map…</div>
              </div>
            </div>
          )}

          {/* Legend overlay */}
          {mapLoaded && (
            <div style={{ position:'absolute', top:8, left:8, background:'rgba(255,255,255,.92)',
              border:'1px solid #E5E7EB', borderRadius:8, padding:'8px 12px', fontSize:11, lineHeight:1.8,
              pointerEvents:'none', boxShadow:'0 1px 4px rgba(0,0,0,.1)' }}>
              <div style={{ fontWeight:700, marginBottom:4, color:'#374151', letterSpacing:.5, textTransform:'uppercase', fontSize:10 }}>Legend</div>
              {[['#9ca3af','Not knocked'],['#16a34a','Contacted'],['#eab308','Left Lit'],['#dc2626','Refused'],['#d97706','No Soliciting']].map(([c,l]) => (
                <div key={l} style={{ display:'flex', alignItems:'center', gap:6 }}>
                  <div style={{ width:9, height:9, borderRadius:'50%', background:c, flexShrink:0 }}/>
                  <span style={{ color:'#374151' }}>{l}</span>
                </div>
              ))}
              <div style={{ display:'flex', alignItems:'center', gap:6, marginTop:2 }}>
                <div style={{ width:9, height:9, borderRadius:2, background:'rgba(99,102,241,.35)', border:'1.5px solid #6366f1', flexShrink:0 }}/>
                <span style={{ color:'#374151' }}>Turf net</span>
              </div>
            </div>
          )}

          {/* Draw-mode hint */}
          {mapLoaded && tool === 'draw' && (
            <div style={{ position:'absolute', bottom:36, left:'50%', transform:'translateX(-50%)',
              background:'rgba(10,22,40,.82)', color:'#fff', fontSize:12, fontWeight:600,
              padding:'5px 14px', borderRadius:20, pointerEvents:'none', whiteSpace:'nowrap' }}>
              Click & drag to draw a turf net
            </div>
          )}
        </div>

        {/* Stats bar */}
        <div style={{ display:'flex', gap:10, marginTop:10, flexWrap:'wrap' }}>
          {[
            { val: houses.length,                                  label: 'Houses in district' },
            { val: nets.length,                                     label: 'Nets drawn' },
            { val: `${pctCovered}%`,                               label: 'District covered' },
            { val: totalTime,                                       label: 'Total est. time', color:'#7c3aed' },
            { val: houses.filter(h=>h.status==='contacted').length, label: 'Knocked today',
              style:{ borderColor:'#bbf7d0', background:'#f0fdf4' }, valStyle:{ color:'#15803d' } },
          ].map((s, i) => (
            <div key={i} style={{ background:'#fff', border:`1px solid ${s.style?.borderColor||'#E5E7EB'}`, borderRadius:8, padding:'8px 14px', ...s.style }}>
              <div style={{ fontSize:19, fontWeight:800, lineHeight:1, color: s.color || s.valStyle?.color }}>{s.val}</div>
              <div style={{ fontSize:10, color:'#6B7280', marginTop:2 }}>{s.label}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Right panel — net list */}
      <div style={{ width:280, borderLeft:'1px solid #E5E7EB', overflowY:'auto', padding:14, background:'#fff', flexShrink:0 }}>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:12 }}>
          <span style={{ fontSize:13, fontWeight:700 }}>Turf Nets</span>
          <span style={{ display:'inline-flex', alignItems:'center', padding:'2px 7px', borderRadius:999, fontSize:11, fontWeight:600, background:'#f3f4f6', color:'#374151' }}>
            {nets.length} net{nets.length !== 1 ? 's' : ''}
          </span>
        </div>

        {nets.length === 0 ? (
          <div style={{ textAlign:'center', padding:'32px 16px', color:'#6B7280' }}>
            <div style={{ fontSize:28, marginBottom:8 }}>✎</div>
            <div style={{ fontSize:13, fontWeight:600, marginBottom:4 }}>Draw nets on the map</div>
            <div style={{ fontSize:11 }}>Switch to Draw mode, then click & drag to create a turf block. Or use Auto-Assign.</div>
          </div>
        ) : (
          <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
            {nets.map(net => (
              <div key={net.id}
                onClick={() => setSelectedId(id => id === net.id ? null : net.id)}
                style={{ border:`2px solid ${selectedId===net.id ? net.color : net.color+'66'}`, borderRadius:8, padding:'10px 12px', cursor:'pointer', background: selectedId===net.id ? net.color+'0d' : '#fff', transition:'all .15s' }}>
                <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                  <div style={{ width:28, height:28, borderRadius:6, background:net.color, flexShrink:0 }}/>
                  <div style={{ flex:1 }}>
                    <div style={{ fontSize:13, fontWeight:700 }}>{net.label}</div>
                    <div style={{ fontSize:11, color:'#6B7280' }}>
                      {net.houseCount} doors · {estTime(net.houseCount)}
                      {selectedId === net.id && (() => {
                        const hs = houses.filter(h => h.lng >= net.bbox.minLng && h.lng <= net.bbox.maxLng && h.lat >= net.bbox.minLat && h.lat <= net.bbox.maxLat)
                        const route = buildCanvassingRoute(hs)
                        const dist = route.length > 1 ? routeDistMeters(route) : 0
                        return dist > 0 ? <span style={{ marginLeft:4, color:'#7c3aed' }}>· ↪ {fmtDist(dist)}</span> : null
                      })()}
                    </div>
                  </div>
                  <button onClick={(e) => { e.stopPropagation(); deleteNet(net.id) }}
                    style={{ background:'none', border:'none', color:'#9ca3af', cursor:'pointer', fontSize:16, padding:'2px 4px', borderRadius:4 }}>×</button>
                </div>
                {net.volunteer && (
                  <div style={{ marginTop:6, fontSize:11, color:'#6B7280', display:'flex', alignItems:'center', gap:4 }}>
                    <Users size={11}/> {net.volunteer}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── LIVE DASHBOARD ───────────────────────────────────────────────────────────
function LiveDashboard({ listId }) {
  const [stats, setStats]   = useState(null)
  const [feed, setFeed]     = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!listId) { setLoading(false); return }
    setLoading(true)
    Promise.all([getDoorKnockStats(listId), getDoorKnockFeed(listId)]).then(([sRes, fRes]) => {
      setStats(sRes.data)
      setFeed(Array.isArray(fRes.data) ? fRes.data : [])
      setLoading(false)
    })
  }, [listId])

  // Realtime subscription
  useEffect(() => {
    if (!listId) return
    const channel = supabase
      .channel(`door_knocks_feed_${listId}`)
      .on('postgres_changes', {
        event: 'INSERT', schema: 'public', table: 'door_knocks',
        filter: `list_id=eq.${listId}`,
      }, (payload) => {
        setFeed(prev => [payload.new, ...prev.slice(0, 19)])
        // Refresh stats on new knock
        getDoorKnockStats(listId).then(({ data }) => { if (data) setStats(data) })
      })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [listId])

  const total       = stats?.total || 0
  const contacted   = stats?.byStatus?.contacted || 0
  const leftLit     = stats?.byStatus?.not_home || 0
  const persuadable = stats?.byStatus?.persuadable || 0
  const supporter   = stats?.byStatus?.contacted || 0
  const contactRate = total > 0 ? Math.round((contacted / total) * 100) : 0

  const statusColorMap = {
    contacted:     { bg:'#dcfce7', c:'#15803d', label:'Contacted' },
    not_home:      { bg:'#fef9c3', c:'#a16207', label:'Left Lit' },
    refused:       { bg:'#fee2e2', c:'#b91c1c', label:'Refused' },
    persuadable:   { bg:'#dbeafe', c:'#1d4ed8', label:'Persuadable' },
    soft_support:  { bg:'#f3e8ff', c:'#7e22ce', label:'Soft Support' },
    do_not_knock:  { bg:'#f3f4f6', c:'#374151', label:'Do Not Knock' },
    no_soliciting: { bg:'#fef3c7', c:'#92400e', label:'No Soliciting' },
    moved:         { bg:'#f3e8ff', c:'#7e22ce', label:'Moved' },
  }

  return (
    <div style={{ overflowY:'auto', padding:'16px 20px', flex:1 }}>
      {loading && <div style={{ color:'#6B7280', fontSize:13, padding:16 }}>Loading dashboard…</div>}
      {/* Stats strip */}
      <div style={{ display:'flex', gap:12, flexWrap:'wrap', marginBottom:16 }}>
        {[
          { val: String(total), label:'Doors knocked' },
          { val: `${contactRate}%`, label:'Contact rate' },
          { val: String(supporter), label:"Contacted", style:{borderColor:'#bbf7d0',background:'#f0fdf4'}, vc:'#15803d' },
          { val: String(persuadable), label:'Persuadables', style:{borderColor:'#dbeafe',background:'#eff6ff'}, vc:'#1d4ed8' },
          { val: String(leftLit), label:'Left Lit — queued', style:{borderColor:'#fde68a',background:'#fffbeb'}, vc:'#b45309' },
        ].map((s, i) => (
          <div key={i} style={{ background:'#fff', border:`1px solid ${s.style?.borderColor||'#E5E7EB'}`, borderRadius:8, padding:'8px 14px', ...s.style }}>
            <div style={{ fontSize:19, fontWeight:800, lineHeight:1, color: s.vc||s.color||'#111' }}>{s.val}</div>
            <div style={{ fontSize:10, color:'#6B7280', marginTop:2 }}>{s.label}</div>
          </div>
        ))}
      </div>

      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16 }}>
        {/* Turf assignments table */}
        <div>
          <div style={{ background:'#fff', border:'1px solid #E5E7EB', borderRadius:10, overflow:'hidden', marginBottom:14 }}>
            <div style={{ padding:'10px 14px', borderBottom:'1px solid #E5E7EB', fontSize:13, fontWeight:700, background:'#fafafa' }}>Turf Assignments</div>
            <table style={{ width:'100%', borderCollapse:'collapse' }}>
              <thead>
                <tr>{['Volunteer','Block','Progress','Rate','Status'].map(h => (
                  <th key={h} style={{ textAlign:'left', fontSize:10, fontWeight:700, textTransform:'uppercase', letterSpacing:.5, color:'#6B7280', padding:'9px 12px', background:'#F4F5F7', borderBottom:'1px solid #E5E7EB' }}>{h}</th>
                ))}</tr>
              </thead>
              <tbody>
                {total === 0 ? (
                  <tr><td colSpan={5} style={{ padding:'18px 12px', textAlign:'center', color:'#9ca3af', fontSize:12 }}>No knocks recorded yet.</td></tr>
                ) : null}
              </tbody>
            </table>
          </div>

          {/* Result breakdown */}
          <div style={{ background:'#fff', border:'1px solid #E5E7EB', borderRadius:10, padding:'14px 16px' }}>
            <div style={{ fontSize:13, fontWeight:700, marginBottom:12 }}>Result Breakdown</div>
            {stats && Object.entries(stats.byStatus).length > 0 ? Object.entries(stats.byStatus).map(([status, count], i) => {
              const sc = statusColorMap[status] || { bg:'#f3f4f6', c:'#374151', label: status }
              const pct = stats.total > 0 ? Math.round((count / stats.total) * 100) : 0
              return (
                <div key={status} style={{ display:'flex', alignItems:'center', gap:8, fontSize:12, marginBottom:7 }}>
                  <span style={{ display:'inline-flex', padding:'2px 7px', borderRadius:4, fontSize:10, fontWeight:700, width:110, textAlign:'center', justifyContent:'center', background:sc.bg, color:sc.c }}>{sc.label}</span>
                  <div style={{ flex:1, height:7, background:'#e5e7eb', borderRadius:3, overflow:'hidden' }}>
                    <div style={{ height:'100%', width:`${pct}%`, background:sc.c, borderRadius:3 }}/>
                  </div>
                  <span style={{ fontWeight:700, minWidth:26, textAlign:'right' }}>{count}</span>
                </div>
              )
            }) : (
              <div style={{ color:'#9ca3af', fontSize:12 }}>No data yet.</div>
            )}
          </div>
        </div>

        {/* Live feed */}
        <div style={{ background:'#fff', border:'1px solid #E5E7EB', borderRadius:10, padding:'14px 16px', height:'fit-content' }}>
          <div style={{ display:'flex', alignItems:'center', gap:7, marginBottom:10 }}>
            <span style={{ width:7, height:7, borderRadius:'50%', background:'#22c55e', display:'inline-block', animation:'pulse 1.5s infinite', flexShrink:0 }}/>
            <span style={{ fontSize:13, fontWeight:700 }}>Live Results Feed</span>
          </div>
          {feed.length === 0 ? (
            <div style={{ color:'#9ca3af', fontSize:12, padding:'8px 0' }}>No activity yet.</div>
          ) : feed.map((f, i) => {
            const sc = statusColorMap[f.status] || { bg:'#f3f4f6', c:'#374151', label: f.status }
            return (
              <div key={f.id || i} style={{ display:'flex', alignItems:'flex-start', gap:7, padding:'7px 0', borderBottom: i < feed.length-1 ? '1px solid #f3f4f6':'none', fontSize:12 }}>
                <div style={{ width:7, height:7, borderRadius:'50%', background:sc.c, marginTop:3, flexShrink:0 }}/>
                <div style={{ flex:1 }}>
                  <div><b>{f.address}</b> <span style={{ padding:'2px 7px', borderRadius:4, fontSize:10, fontWeight:700, background:sc.bg, color:sc.c }}>{sc.label}</span></div>
                  {f.knocked_by && <div style={{ color:'#6B7280' }}>{f.knocked_by}</div>}
                  {f.notes && <div style={{ color:'#6B7280' }}>{f.notes}</div>}
                </div>
                <div style={{ fontSize:10, color:'#6B7280', flexShrink:0 }}>{relTime(f.created_at)}</div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// ─── TEAM & MOBILE ────────────────────────────────────────────────────────────
function TeamMobile({ listId }) {
  const { session } = useAuth()
  const [inviteName, setInviteName]   = useState('')
  const [inviteEmail, setInviteEmail] = useState('')
  const [invitePhone, setInvitePhone] = useState('')
  const [inviteRole, setInviteRole]   = useState('volunteer')
  const [sending, setSending]         = useState(false)
  const [sent, setSent]               = useState(false)
  const [inviteError, setInviteError] = useState('')
  const [volunteers, setVolunteers]   = useState([])
  const [loadingVols, setLoadingVols] = useState(true)

  const loadVolunteers = useCallback(() => {
    if (!listId) { setLoadingVols(false); return }
    setLoadingVols(true)
    getVolunteers(listId).then(({ data }) => {
      setVolunteers(Array.isArray(data) ? data : [])
    }).finally(() => setLoadingVols(false))
  }, [listId])

  useEffect(() => { loadVolunteers() }, [loadVolunteers])

  const sendInvite = async () => {
    if (!inviteName.trim()) return
    setSending(true)
    setInviteError('')
    try {
      const res = await fetch('/.netlify/functions/invite-volunteer', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session?.access_token || ''}`,
        },
        body: JSON.stringify({
          name: inviteName.trim(),
          email: inviteEmail.trim() || null,
          phone: invitePhone.trim() || null,
          role: inviteRole,
          listId,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Invite failed')
      setSent(true)
      setInviteName(''); setInviteEmail(''); setInvitePhone('')
      setTimeout(() => setSent(false), 3000)
      loadVolunteers()
    } catch (err) {
      setInviteError(err.message)
    } finally {
      setSending(false)
    }
  }

  return (
    <div style={{ overflowY:'auto', padding:'16px 20px', flex:1 }}>
      <div style={{ display:'grid', gridTemplateColumns:'1fr', gap:16, alignItems:'start' }}>
        {/* Team roster */}
        <div>
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:10 }}>
            <div style={{ fontSize:14, fontWeight:700 }}>Team Roster</div>
          </div>

          {loadingVols ? (
            <div style={{ color:'#9ca3af', fontSize:13, padding:'12px 0' }}>Loading team…</div>
          ) : volunteers.length === 0 ? (
            <div style={{ background:'#f9fafb', border:'1px solid #E5E7EB', borderRadius:10, padding:'24px 16px', textAlign:'center', color:'#6B7280', fontSize:13 }}>
              No volunteers yet. Invite your first volunteer below.
            </div>
          ) : (
            <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
              {volunteers.map((vol, i) => {
                const initials = vol.name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2)
                const COLORS = ['#0A1628','#ef4444','#3b82f6','#8b5cf6','#16a34a','#d97706']
                const bg = COLORS[i % COLORS.length]
                const isPending = vol.status === 'invited'
                const roleBg = vol.role === 'captain' ? '#dbeafe' : '#f3f4f6'
                const roleC  = vol.role === 'captain' ? '#1e3a8a' : '#374151'
                return (
                  <div key={vol.id} style={{ background:'#fff', border:'1px solid #E5E7EB', borderRadius:10, padding:14, opacity: isPending ? .65 : 1 }}>
                    <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                      <div style={{ width:36, height:36, borderRadius:'50%', background:bg, display:'flex', alignItems:'center', justifyContent:'center', fontWeight:800, fontSize:14, color:'#fff', flexShrink:0 }}>{initials}</div>
                      <div style={{ flex:1 }}>
                        <div style={{ display:'flex', alignItems:'center', gap:7 }}>
                          <span style={{ fontWeight:700 }}>{vol.name}</span>
                          <span style={{ display:'inline-flex', padding:'2px 7px', borderRadius:999, fontSize:10, fontWeight:600, background:roleBg, color:roleC }}>{vol.role}</span>
                          {isPending && <span style={{ display:'inline-flex', padding:'2px 7px', borderRadius:999, fontSize:10, fontWeight:600, background:'#fef9c3', color:'#713f12' }}>Invited</span>}
                        </div>
                        <div style={{ fontSize:11, color:'#6B7280' }}>{vol.email || vol.phone || '—'}</div>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {/* Invite form */}
          <div style={{ marginTop:16, background:'#f9fafb', border:'1px solid #E5E7EB', borderRadius:10, padding:14 }}>
            <div style={{ fontSize:13, fontWeight:700, marginBottom:10 }}>Invite New Volunteer</div>
            <div style={{ display:'flex', gap:8, marginBottom:8 }}>
              <input value={inviteName} onChange={e=>setInviteName(e.target.value)} placeholder="Name *" style={{ flex:1, padding:'7px 10px', border:'1px solid #E5E7EB', borderRadius:7, fontSize:13, outline:'none' }}/>
              <input value={inviteEmail} onChange={e=>setInviteEmail(e.target.value)} placeholder="Email" style={{ flex:2, padding:'7px 10px', border:'1px solid #E5E7EB', borderRadius:7, fontSize:13, outline:'none' }}/>
            </div>
            <div style={{ display:'flex', gap:8, marginBottom:8 }}>
              <input value={invitePhone} onChange={e=>setInvitePhone(e.target.value)} placeholder="Phone (optional)" style={{ flex:2, padding:'7px 10px', border:'1px solid #E5E7EB', borderRadius:7, fontSize:13, outline:'none' }}/>
              <select value={inviteRole} onChange={e=>setInviteRole(e.target.value)} style={{ flex:1, padding:'7px 10px', border:'1px solid #E5E7EB', borderRadius:7, fontSize:13, outline:'none' }}>
                <option value="volunteer">Volunteer</option>
                <option value="captain">Captain</option>
              </select>
            </div>
            <div style={{ display:'flex', gap:8, alignItems:'center' }}>
              <button onClick={sendInvite} disabled={sending || !inviteName.trim()}
                style={{ padding:'7px 16px', borderRadius:7, fontSize:12, fontWeight:700, cursor: inviteName.trim() ? 'pointer' : 'not-allowed', border:'none', background: sent ? '#22c55e' : '#8B0000', color:'#fff', display:'flex', alignItems:'center', gap:6, transition:'background .3s', opacity: inviteName.trim() ? 1 : 0.6 }}>
                {sent ? <><CheckCircle size={13}/> Sent!</> : sending ? 'Sending…' : <><Send size={13}/> Send Invite</>}
              </button>
            </div>
            {inviteError && <div style={{ fontSize:11, color:'#dc2626', marginTop:6 }}>{inviteError}</div>}
            <div style={{ fontSize:11, color:'#6B7280', marginTop:6 }}>Volunteer will receive an email invite with a link to access the door knocking tools.</div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── CANVASSER VIEW (unused — canvassing handled in the Volunteer Portal at /v) ─
// eslint-disable-next-line no-unused-vars
function _CanvasserView({ isOnline, listId, onKnockSaved, activeCandidates = [], activeCandidateId = null, isScout = false }) {
  const { user } = useAuth()
  const [activeHouse, setActiveHouse] = useState(null)
  const [noteText, setNoteText]       = useState('')
  const [savingKnock, setSavingKnock] = useState(false)
  const [savedStatus, setSavedStatus] = useState(null)
  const [history, setHistory]         = useState([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [offlineQueued, setOfflineQueued]   = useState(false)
  const [advancedMode, setAdvancedMode]     = useState(false)
  const [supportLevels, setSupportLevels]   = useState({}) // { [candidateId]: level }
  const [surveyAnswers, setSurveyAnswers]   = useState({}) // { [questionId]: answer }

  const houses = [
    { addr:'1842 Rib Mountain Dr', resident:'James P. (R)', age:54 },
    { addr:'1840 Rib Mountain Dr', resident:'Linda P. (D)', age:51 },
    { addr:'1836 Rib Mountain Dr', resident:'Unknown',      age:null },
    { addr:'307 N 3rd Ave',        resident:'Tom K. (R)',   age:67 },
    { addr:'309 N 3rd Ave',        resident:'Wanda K. (I)', age:64 },
  ]

  const SIMPLE_BTNS = [
    { label:'⌂ Home',          bg:'#dcfce7', c:'#15803d', val:'contacted' },
    { label:'▤ Left Lit',      bg:'#fef9c3', c:'#a16207', val:'not_home' },
    { label:'⊘ Refused',       bg:'#fee2e2', c:'#b91c1c', val:'refused' },
    { label:'■ No Soliciting', bg:'#fef3c7', c:'#92400e', val:'no_soliciting' },
  ]
  const ADVANCED_BTNS = [
    { label:'⊗ Do Not Knock',  bg:'#dbeafe', c:'#1d4ed8', val:'do_not_knock' },
    { label:'✉ Moved',         bg:'#f3e8ff', c:'#7e22ce', val:'moved' },
    { label:'✕ Wrong Address', bg:'#f3f4f6', c:'#6b7280', val:'wrong_address' },
  ]

  // Load contact history when house is selected
  useEffect(() => {
    if (activeHouse === null) { setHistory([]); return }
    const addr = houses[activeHouse].addr
    setHistoryLoading(true)
    getKnockHistoryByAddress(addr)
      .then(({ data }) => { setHistory(Array.isArray(data) ? data : []) })
      .catch(() => setHistory([]))
      .finally(() => setHistoryLoading(false))
  }, [activeHouse])

  const handleSelectHouse = (i) => {
    setActiveHouse(i)
    setSavedStatus(null)
    setNoteText('')
    setOfflineQueued(false)
    setSupportLevels({})
    setSurveyAnswers({})
  }

  const handleLog = async (statusVal) => {
    if (activeHouse === null) return
    setSavingKnock(true)
    setSavedStatus(null)
    setOfflineQueued(false)
    const knockData = {
      list_id:       listId || null,
      address:       houses[activeHouse].addr,
      status:        statusVal,
      notes:         noteText || null,
      knocked_at:    new Date().toISOString(),
      survey_answers: Object.keys(surveyAnswers).length > 0 ? surveyAnswers : null,
      support_levels: Object.keys(supportLevels).length > 0 ? supportLevels : null,
    }
    try {
      if (!isOnline) throw new Error('offline')
      const { error } = await supabase
        .from('door_knocks')
        .insert({ ...knockData, knocked_by: user?.id || null })
        .select()
      if (error) throw error
      setSavedStatus(statusVal)
      onKnockSaved && onKnockSaved()
      // Refresh history
      const { data } = await getKnockHistoryByAddress(houses[activeHouse].addr)
      setHistory(Array.isArray(data) ? data : [])
    } catch (err) {
      // Offline fallback: queue to IndexedDB
      await queueKnock(knockData)
      setOfflineQueued(true)
      setSavedStatus(statusVal)
    } finally {
      setSavingKnock(false)
    }
  }

  return (
    <div style={{ overflowY:'auto', padding:'16px 20px', flex:1 }}>
      {!isOnline && (
        <div style={{ display:'flex', alignItems:'center', gap:8, background:'#fef3c7', border:'1px solid #fcd34d', borderRadius:8, padding:'8px 14px', marginBottom:12, fontSize:12, fontWeight:600, color:'#92400e' }}>
          <WifiOff size={14}/> Offline — knocks will be saved to your device and synced when you reconnect.
        </div>
      )}
      {!listId && (
        <div style={{ display:'flex', alignItems:'center', gap:8, background:'#f0f9ff', border:'1px solid #bae6fd', borderRadius:8, padding:'8px 14px', marginBottom:12, fontSize:12, fontWeight:600, color:'#0369a1' }}>
          <Clock size={14}/> Setting up campaign… Knocks recorded now will be saved without a list assignment.
        </div>
      )}
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16, alignItems:'start' }}>

        {/* House list */}
        <div>
          <div style={{ fontSize:13, fontWeight:700, marginBottom:10 }}>Your Turf — Block 4-A ({houses.length} doors)</div>
          <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
            {houses.map((h, i) => (
              <div key={h.addr || i} onClick={() => handleSelectHouse(i)}
                style={{ background:'#fff', border:`2px solid ${activeHouse===i ? '#8B0000' : '#E5E7EB'}`, borderRadius:9, padding:'10px 14px', cursor:'pointer', transition:'all .15s' }}>
                <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between' }}>
                  <div>
                    <div style={{ fontWeight:600, fontSize:13 }}>{h.addr}</div>
                    <div style={{ fontSize:11, color:'#6B7280' }}>{h.resident}{h.age ? ` · Age ${h.age}` : ''}</div>
                  </div>
                  <ChevronRight size={16} style={{ color:'#9ca3af' }}/>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Detail panel */}
        {activeHouse !== null ? (
          <div style={{ background:'#fff', border:'1px solid #E5E7EB', borderRadius:10, padding:16 }}>
            <div style={{ fontWeight:700, fontSize:14, marginBottom:2 }}>{houses[activeHouse].addr}</div>
            <div style={{ fontSize:12, color:'#6B7280', marginBottom:12 }}>{houses[activeHouse].resident}</div>

            {/* ── Contact History (Feature 2) ── */}
            <div style={{ marginBottom:12, background:'#f9fafb', border:'1px solid #E5E7EB', borderRadius:8, padding:'10px 12px' }}>
              <div style={{ display:'flex', alignItems:'center', gap:5, fontSize:11, fontWeight:700, color:'#374151', marginBottom:6 }}>
                <History size={12}/> Prior Visits
              </div>
              {historyLoading ? (
                <div style={{ fontSize:11, color:'#9ca3af' }}>Loading history…</div>
              ) : history.length === 0 ? (
                <div style={{ fontSize:11, color:'#9ca3af' }}>No prior visits — first contact.</div>
              ) : (
                <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
                  {history.slice(0, 3).map((h, i) => (
                    <div key={h.id || `hist-${i}`} style={{ display:'flex', alignItems:'center', gap:8, fontSize:11 }}>
                      <span style={{ color:'#6B7280', minWidth:52 }}>{relTime(h.knocked_at)}</span>
                      {statusBadge(h.status)}
                      {h.notes && <span style={{ color:'#6B7280', fontStyle:'italic', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', maxWidth:120 }}>"{h.notes}"</span>}
                    </div>
                  ))}
                  {history.length > 3 && <div style={{ fontSize:10, color:'#9ca3af' }}>+{history.length - 3} more visits</div>}
                </div>
              )}
            </div>

            {/* Action buttons */}
            {savedStatus ? (
              <div style={{ textAlign:'center', padding:'16px 8px' }}>
                {offlineQueued ? (
                  <div style={{ color:'#92400e', fontSize:12, fontWeight:600 }}>
                    <WifiOff size={16} style={{ display:'block', margin:'0 auto 6px' }}/> Saved offline — will sync when connected
                  </div>
                ) : (
                  <div style={{ color:'#15803d', fontSize:12, fontWeight:600 }}>
                    <CheckCircle size={16} style={{ display:'block', margin:'0 auto 6px' }}/> Logged successfully
                  </div>
                )}
                <button onClick={() => { setSavedStatus(null); setNoteText('') }}
                  style={{ marginTop:10, padding:'6px 16px', borderRadius:7, fontSize:12, fontWeight:600, border:'1px solid #E5E7EB', background:'#fff', cursor:'pointer' }}>
                  Next Door →
                </button>
              </div>
            ) : (
              <>
                {/* ── Simple / Advanced mode toggle ── */}
                <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:8 }}>
                  <div style={{ fontSize:11, fontWeight:700, color:'#374151' }}>Log Result</div>
                  <button
                    type="button"
                    onClick={() => setAdvancedMode(m => !m)}
                    style={{ fontSize:10, fontWeight:600, color: advancedMode ? '#7e22ce' : '#6B7280', background: advancedMode ? '#f3e8ff' : '#f3f4f6', border:'none', borderRadius:5, padding:'3px 8px', cursor:'pointer' }}>
                    {advancedMode ? '▸ Simple mode' : '≡ Advanced'}
                  </button>
                </div>

                {/* ── Primary result buttons ── */}
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8, marginBottom: advancedMode ? 6 : 12 }}>
                  {SIMPLE_BTNS.map((b, i) => (
                    <button key={i} onClick={() => handleLog(b.val)} disabled={savingKnock}
                      style={{ borderRadius:10, padding:'12px 8px', fontSize:11, fontWeight:700, cursor:savingKnock?'wait':'pointer', border:'none', background:b.bg, color:b.c, display:'flex', flexDirection:'column', alignItems:'center', gap:3, opacity:savingKnock?.6:1 }}>
                      <span style={{ fontSize:18 }}>{b.label.split(' ')[0]}</span>
                      {b.label.split(' ').slice(1).join(' ')}
                    </button>
                  ))}
                </div>

                {/* ── Advanced result buttons (hidden in simple mode) ── */}
                {advancedMode && (
                  <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:6, marginBottom:12 }}>
                    {ADVANCED_BTNS.map((b, i) => (
                      <button key={i} onClick={() => handleLog(b.val)} disabled={savingKnock}
                        style={{ borderRadius:8, padding:'8px 4px', fontSize:10, fontWeight:700, cursor:savingKnock?'wait':'pointer', border:'1px dashed #E5E7EB', background:b.bg, color:b.c, display:'flex', flexDirection:'column', alignItems:'center', gap:2, opacity:savingKnock?.6:1 }}>
                        <span style={{ fontSize:14 }}>{b.label.split(' ')[0]}</span>
                        {b.label.split(' ').slice(1).join(' ')}
                      </button>
                    ))}
                  </div>
                )}

                {/* ── Multi-candidate support levels (advanced mode, 2+ candidates) ── */}
                {advancedMode && activeCandidates.length > 1 && (
                  <div style={{ background:'#fafafa', border:'1px solid #E5E7EB', borderRadius:8, padding:'10px 12px', marginBottom:10 }}>
                    <div style={{ fontSize:11, fontWeight:700, color:'#374151', marginBottom:7 }}>
                      Voter Support Levels
                    </div>
                    {activeCandidates.map(cand => (
                      <div key={cand.id} style={{ marginBottom:8 }}>
                        <div style={{ fontSize:11, fontWeight:600, color:'#374151', marginBottom:4 }}>{cand.name}</div>
                        <div style={{ display:'flex', gap:4, flexWrap:'wrap' }}>
                          {[
                            { val:'strong_support',  label:'Strong ✓', c:'#15803d', bg:'#dcfce7' },
                            { val:'lean_support',    label:'Lean ✓',   c:'#166534', bg:'#bbf7d0' },
                            { val:'undecided',       label:'Undecided',c:'#6B7280', bg:'#f3f4f6' },
                            { val:'lean_against',    label:'Lean ✗',   c:'#b91c1c', bg:'#fee2e2' },
                            { val:'strong_against',  label:'Strong ✗', c:'#991b1b', bg:'#fecaca' },
                          ].map(opt => (
                            <button
                              key={opt.val}
                              type="button"
                              onClick={() => setSupportLevels(prev => ({ ...prev, [cand.id]: opt.val }))}
                              style={{
                                fontSize:9, fontWeight:700, padding:'3px 7px', borderRadius:4, cursor:'pointer',
                                border: supportLevels[cand.id] === opt.val ? `2px solid ${opt.c}` : '1px solid #E5E7EB',
                                background: supportLevels[cand.id] === opt.val ? opt.bg : '#fff',
                                color: supportLevels[cand.id] === opt.val ? opt.c : '#6B7280',
                              }}>
                              {opt.label}
                            </button>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* ── Survey questions (advanced mode, candidate has questions defined) ── */}
                {advancedMode && !isScout && (() => {
                  const cand = activeCandidates.find(c => c.id === activeCandidateId)
                  const questions = cand?.survey_questions || []
                  if (questions.length === 0) return null
                  return (
                    <div style={{ background:'#eff6ff', border:'1px solid #bfdbfe', borderRadius:8, padding:'10px 12px', marginBottom:10 }}>
                      <div style={{ fontSize:11, fontWeight:700, color:'#1d4ed8', marginBottom:7 }}>
                        Survey Questions
                      </div>
                      {questions.map(q => (
                        <div key={q.id} style={{ marginBottom:10 }}>
                          <div style={{ fontSize:11, fontWeight:600, color:'#1e3a8a', marginBottom:4 }}>{q.text}</div>
                          {q.type === 'yes_no' ? (
                            <div style={{ display:'flex', gap:6 }}>
                              {['Yes','No','N/A'].map(opt => (
                                <button key={opt} type="button"
                                  onClick={() => setSurveyAnswers(prev => ({ ...prev, [q.id]: opt }))}
                                  style={{ fontSize:10, fontWeight:700, padding:'4px 10px', borderRadius:5, cursor:'pointer',
                                    border: surveyAnswers[q.id] === opt ? '2px solid #1d4ed8' : '1px solid #bfdbfe',
                                    background: surveyAnswers[q.id] === opt ? '#dbeafe' : '#fff', color: surveyAnswers[q.id] === opt ? '#1d4ed8' : '#6B7280' }}>
                                  {opt}
                                </button>
                              ))}
                            </div>
                          ) : q.type === 'choice' && q.options?.length > 0 ? (
                            <div style={{ display:'flex', gap:4, flexWrap:'wrap' }}>
                              {q.options.map(opt => (
                                <button key={opt} type="button"
                                  onClick={() => setSurveyAnswers(prev => ({ ...prev, [q.id]: opt }))}
                                  style={{ fontSize:10, fontWeight:600, padding:'3px 8px', borderRadius:5, cursor:'pointer',
                                    border: surveyAnswers[q.id] === opt ? '2px solid #1d4ed8' : '1px solid #bfdbfe',
                                    background: surveyAnswers[q.id] === opt ? '#dbeafe' : '#fff', color: surveyAnswers[q.id] === opt ? '#1d4ed8' : '#6B7280' }}>
                                  {opt}
                                </button>
                              ))}
                            </div>
                          ) : (
                            <input type="text" value={surveyAnswers[q.id] || ''}
                              onChange={e => setSurveyAnswers(prev => ({ ...prev, [q.id]: e.target.value }))}
                              placeholder="Type answer…"
                              style={{ width:'100%', padding:'5px 8px', border:'1px solid #bfdbfe', borderRadius:5, fontSize:11, outline:'none', boxSizing:'border-box' }}/>
                          )}
                        </div>
                      ))}
                    </div>
                  )
                })()}

                {/* ── Notes ── */}
                <textarea value={noteText} onChange={e => setNoteText(e.target.value)}
                  placeholder="Notes (optional)…"
                  style={{ width:'100%', padding:'8px 10px', border:'1px solid #E5E7EB', borderRadius:7, fontSize:12, resize:'vertical', minHeight:52, outline:'none', fontFamily:'inherit', boxSizing:'border-box' }}/>
              </>
            )}
          </div>
        ) : (
          <div style={{ background:'#fff', border:'1px solid #E5E7EB', borderRadius:10, padding:32, textAlign:'center', color:'#6B7280' }}>
            <MapPin size={28} style={{ margin:'0 auto 8px', opacity:.4 }}/>
            <div style={{ fontWeight:600 }}>Select a house to log results</div>
            <div style={{ fontSize:11, marginTop:4 }}>Prior visit history loads automatically</div>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── FOLLOW-UP QUEUE ──────────────────────────────────────────────────────────
function FollowUpQueue({ listId }) {
  const [queue, setQueue]   = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!listId) { setLoading(false); return }
    setLoading(true)
    supabase
      .from('door_knocks')
      .select('id, address, status, notes, created_at, knocked_by')
      .eq('list_id', listId)
      .in('status', ['not_home', 'soft_support', 'persuadable'])
      .order('created_at', { ascending: false })
      .limit(100)
      .then(({ data }) => {
        setQueue(Array.isArray(data) ? data : [])
        setLoading(false)
      })
  }, [listId])

  const statusLabel = { not_home:'Left Lit', soft_support:'Soft Support', persuadable:'Persuadable' }
  const statusBg    = { not_home:'#f3e8ff', soft_support:'#fef9c3', persuadable:'#dbeafe' }
  const statusColor = { not_home:'#7e22ce', soft_support:'#a16207', persuadable:'#1d4ed8' }

  return (
    <div style={{ overflowY:'auto', padding:'16px 20px', flex:1 }}>
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:12 }}>
        <div style={{ fontSize:14, fontWeight:700 }}>Follow-up Queue <span style={{ background:'#fee2e2', color:'#b91c1c', borderRadius:999, padding:'2px 8px', fontSize:12, fontWeight:700, marginLeft:6 }}>{queue.length}</span></div>
        <div style={{ display:'flex', gap:6 }}>
          <button disabled title="Coming soon" style={{ padding:'5px 12px', borderRadius:6, fontSize:12, fontWeight:600, cursor:'not-allowed', opacity:.5, border:'1px solid #E5E7EB', background:'#fff', color:'#374151' }}>Export List</button>
          <button disabled title="Coming soon" style={{ padding:'5px 12px', borderRadius:6, fontSize:12, fontWeight:600, cursor:'not-allowed', opacity:.5, border:'none', background:'#8B0000', color:'#fff' }}>Assign All</button>
        </div>
      </div>
      {loading ? (
        <div style={{ color:'#9ca3af', fontSize:13, padding:'12px 0' }}>Loading follow-ups…</div>
      ) : queue.length === 0 ? (
        <div style={{ background:'#f9fafb', border:'1px solid #E5E7EB', borderRadius:10, padding:'32px 16px', textAlign:'center', color:'#6B7280', fontSize:13 }}>
          No follow-ups queued. Addresses with "Left Lit", "Soft Support", or "Persuadable" outcomes will appear here.
        </div>
      ) : (
        <div style={{ background:'#fff', border:'1px solid #E5E7EB', borderRadius:10, overflow:'hidden' }}>
          <table style={{ width:'100%', borderCollapse:'collapse' }}>
            <thead>
              <tr>{['Address','Volunteer','Reason','Last Visit','Action'].map(h => (
                <th key={h} style={{ textAlign:'left', fontSize:10, fontWeight:700, textTransform:'uppercase', letterSpacing:.5, color:'#6B7280', padding:'9px 14px', background:'#F4F5F7', borderBottom:'1px solid #E5E7EB' }}>{h}</th>
              ))}</tr>
            </thead>
            <tbody>
              {queue.map((q) => (
                <tr key={q.id}>
                  <td style={{ padding:'10px 14px', borderBottom:'1px solid #f3f4f6', fontSize:13, fontWeight:600 }}>{q.address}</td>
                  <td style={{ padding:'10px 14px', borderBottom:'1px solid #f3f4f6', fontSize:12 }}>{q.knocked_by || '—'}</td>
                  <td style={{ padding:'10px 14px', borderBottom:'1px solid #f3f4f6' }}>
                    <span style={{ display:'inline-flex', padding:'2px 7px', borderRadius:4, fontSize:11, fontWeight:700, background: statusBg[q.status]||'#f3f4f6', color: statusColor[q.status]||'#374151' }}>
                      {statusLabel[q.status] || q.status}
                    </span>
                  </td>
                  <td style={{ padding:'10px 14px', borderBottom:'1px solid #f3f4f6', fontSize:11, color:'#6B7280' }}>{relTime(q.created_at)}</td>
                  <td style={{ padding:'10px 14px', borderBottom:'1px solid #f3f4f6' }}>
                    <button disabled title="Coming soon" style={{ padding:'3px 10px', borderRadius:5, fontSize:11, fontWeight:600, cursor:'not-allowed', opacity:.5, border:'none', background:'#0A1628', color:'#fff' }}>Assign →</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ─── VOTER FILE TAB ───────────────────────────────────────────────────────────
function VoterFileTab({ listId }) {
  const { user } = useAuth()
  const [count, setCount]         = useState(null)
  const [preview, setPreview]     = useState([])
  const [headers, setHeaders]     = useState([])
  const [parsed, setParsed]       = useState([])
  const [importing, setImporting] = useState(false)
  const [importResult, setImportResult] = useState(null)
  const [importError, setImportError]   = useState('')

  useEffect(() => {
    if (!listId) return
    getVoterFileCount(listId).then(({ count: c }) => setCount(c || 0))
  }, [listId])

  const handleFile = (e) => {
    const file = e.target.files[0]
    if (!file) return
    setImportResult(null); setImportError('')
    const reader = new FileReader()
    reader.onload = (ev) => {
      const text = ev.target.result
      const records = parseCsvRows(text).filter(r => r.some(c => c && c.trim()))
      if (records.length < 2) { setImportError('CSV must have a header row and at least one data row.'); return }
      const hdrs = records[0].map(h => h.trim().toLowerCase().replace(/^"|"$/g, ''))
      setHeaders(hdrs)
      const rows = records.slice(1).map(rawCols => {
        const cols = rawCols.map(c => c.trim())
        const row = {}
        hdrs.forEach((h, i) => { row[h] = cols[i] || '' })
        return row
      })
      setParsed(rows)
      setPreview(rows.slice(0, 5))
    }
    reader.readAsText(file)
  }

  const handleImport = async () => {
    if (!parsed.length || !listId || !user?.id) return
    setImporting(true); setImportError(''); setImportResult(null)
    // Map CSV columns to DB columns
    const entries = parsed.map(row => ({
      list_id: listId,
      created_by: user.id,
      address: row.address || row.addr || '',
      full_name: row.name || row.full_name || row['full name'] || null,
      party: row.party || null,
      age: row.age ? parseInt(row.age, 10) || null : null,
      lat: row.lat ? parseFloat(row.lat) || null : null,
      lng: row.lng || row.lon ? parseFloat(row.lng || row.lon) || null : null,
    })).filter(e => e.address)
    if (!entries.length) { setImportError('No valid address rows found in CSV.'); setImporting(false); return }
    const { error } = await upsertVoterFileEntries(entries)
    setImporting(false)
    if (error) { setImportError(error.message); return }
    setImportResult(entries.length)
    setParsed([]); setPreview([]); setHeaders([])
    getVoterFileCount(listId).then(({ count: c }) => setCount(c || 0))
  }

  return (
    <div style={{ overflowY:'auto', padding:'16px 20px', flex:1 }}>
      <div style={{ maxWidth:680 }}>
        <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:16 }}>
          <div style={{ background:'#fff', border:'1px solid #E5E7EB', borderRadius:10, padding:'10px 18px' }}>
            <div style={{ fontSize:22, fontWeight:800, color:'#0A1628' }}>{count ?? '—'}</div>
            <div style={{ fontSize:11, color:'#6B7280' }}>Voter file entries</div>
          </div>
        </div>

        <div style={{ background:'#fff', border:'1px solid #E5E7EB', borderRadius:10, padding:20, marginBottom:16 }}>
          <div style={{ fontSize:14, fontWeight:700, marginBottom:10 }}>Import Voter File (CSV)</div>
          <div style={{ fontSize:12, color:'#6B7280', marginBottom:12 }}>
            Expected columns: <b>address</b> (required), name, party, age, lat, lng
          </div>
          <input type="file" accept=".csv" onChange={handleFile}
            style={{ fontSize:13, marginBottom:12 }}/>

          {preview.length > 0 && (
            <div style={{ marginBottom:12 }}>
              <div style={{ fontSize:12, fontWeight:600, marginBottom:6, color:'#374151' }}>Preview (first {preview.length} rows):</div>
              <div style={{ overflowX:'auto' }}>
                <table style={{ width:'100%', borderCollapse:'collapse', fontSize:11 }}>
                  <thead>
                    <tr>{headers.map(h => <th key={h} style={{ textAlign:'left', padding:'5px 8px', background:'#F4F5F7', borderBottom:'1px solid #E5E7EB', fontWeight:700, textTransform:'uppercase', letterSpacing:.5, color:'#6B7280' }}>{h}</th>)}</tr>
                  </thead>
                  <tbody>
                    {preview.map((row, i) => (
                      <tr key={i}>{headers.map(h => <td key={h} style={{ padding:'5px 8px', borderBottom:'1px solid #f3f4f6', color:'#374151' }}>{row[h]}</td>)}</tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div style={{ fontSize:11, color:'#6B7280', marginTop:4 }}>{parsed.length} total rows parsed.</div>
            </div>
          )}

          {parsed.length > 0 && (
            <button onClick={handleImport} disabled={importing}
              style={{ padding:'8px 20px', borderRadius:8, fontSize:13, fontWeight:700, cursor:'pointer', border:'none', background:'#8B0000', color:'#fff' }}>
              {importing ? 'Importing…' : `Import ${parsed.length} rows`}
            </button>
          )}

          {importResult !== null && (
            <div style={{ marginTop:10, fontSize:13, color:'#15803d', fontWeight:600 }}>
              Successfully imported {importResult} voter file entries.
            </div>
          )}
          {importError && (
            <div style={{ marginTop:10, fontSize:13, color:'#dc2626' }}>{importError}</div>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── LEADERBOARD ──────────────────────────────────────────────────────────────
function Leaderboard() {
  return (
    <div style={{ overflowY:'auto', padding:'16px 20px', flex:1 }}>
      <div style={{ maxWidth:640 }}>
        <div style={{ fontSize:14, fontWeight:700, marginBottom:12 }}>★ Volunteer Leaderboard — Spring General 2026</div>
        <div style={{ background:'#fff', border:'1px solid #E5E7EB', borderRadius:10, overflow:'hidden', marginBottom:16 }}>
          {LEADERBOARD.map((v, i) => (
            <div key={v.name} style={{ display:'flex', alignItems:'center', gap:12, padding:14, borderBottom: i<LEADERBOARD.length-1 ? '1px solid #f3f4f6':'none', background: i===0 ? '#fffbeb' : '#fff' }}>
              <div style={{ width:30, height:30, borderRadius:'50%', display:'flex', alignItems:'center', justifyContent:'center', fontWeight:800, fontSize:14, background: ['#FFD700','#C0C0C0','#CD7F32','#f3f4f6'][i], color: i<3?'#fff':'#374151', flexShrink:0 }}>
                {MEDAL[i] || v.rank}
              </div>
              <div style={{ width:36, height:36, borderRadius:'50%', background:v.color, display:'flex', alignItems:'center', justifyContent:'center', color:'#fff', fontWeight:800, fontSize:14, flexShrink:0 }}>
                {v.initials}
              </div>
              <div style={{ flex:1 }}>
                <div style={{ fontWeight:700 }}>{v.name}</div>
                <div style={{ fontSize:11, color:'#6B7280' }}>{v.contact}% contact rate · {v.streak}-day streak ▲</div>
              </div>
              <div style={{ textAlign:'right' }}>
                <div style={{ fontSize:22, fontWeight:800, color: i===0?'#d97706':'#111' }}>{v.doors}</div>
                <div style={{ fontSize:10, color:'#6B7280' }}>doors</div>
              </div>
            </div>
          ))}
        </div>

        {/* Weekly challenge card */}
        <div style={{ background:'linear-gradient(135deg,#7c3aed,#4f46e5)', borderRadius:12, padding:20, color:'#fff' }}>
          <div style={{ fontSize:15, fontWeight:700, marginBottom:6 }}>◎ Weekly Challenge: 50 Doors</div>
          <p style={{ fontSize:12, color:'rgba(255,255,255,.75)', lineHeight:1.5, marginBottom:12 }}>
            First volunteer to knock 50 doors this week earns a campaign T-shirt and a personal thank-you from the candidate.
          </p>
          <div style={{ display:'flex', gap:8 }}>
            <div style={{ flex:1, background:'rgba(255,255,255,.15)', borderRadius:8, padding:'8px 12px', textAlign:'center' }}>
              <div style={{ fontSize:22, fontWeight:800 }}>3</div>
              <div style={{ fontSize:10, color:'rgba(255,255,255,.7)' }}>Days left</div>
            </div>
            <div style={{ flex:1, background:'rgba(255,255,255,.15)', borderRadius:8, padding:'8px 12px', textAlign:'center' }}>
              <div style={{ fontSize:22, fontWeight:800 }}>50</div>
              <div style={{ fontSize:10, color:'rgba(255,255,255,.7)' }}>Rob's doors (leading!)</div>
            </div>
            <div style={{ flex:1, background:'rgba(255,255,255,.15)', borderRadius:8, padding:'8px 12px', textAlign:'center' }}>
              <div style={{ fontSize:22, fontWeight:800 }}>4</div>
              <div style={{ fontSize:10, color:'rgba(255,255,255,.7)' }}>Active volunteers</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── SHIFTS TAB (Feature 3: volunteer shift scheduling) ───────────────────────
function ShiftsTab({ listId }) {
  const [shifts, setShifts]         = useState([])
  const [loading, setLoading]       = useState(true)
  const [showForm, setShowForm]     = useState(false)
  const [saving, setSaving]         = useState(false)
  const [saveError, setSaveError]   = useState('')
  const [form, setForm]             = useState({
    volunteer_name: '', volunteer_email: '', volunteer_phone: '',
    shift_date: new Date().toISOString().slice(0, 10),
    start_time: '09:00', end_time: '13:00', notes: '', status: 'scheduled',
  })

  const load = useCallback(() => {
    if (!listId) return
    setLoading(true)
    getShifts(listId).then(({ data }) => {
      setShifts(Array.isArray(data) ? data : [])
    }).finally(() => setLoading(false))
  }, [listId])

  useEffect(() => { load() }, [load])

  const handleSave = async () => {
    if (!form.volunteer_name.trim() || !form.shift_date) return
    if (form.end_time && form.start_time && form.end_time <= form.start_time) {
      setSaveError('End time must be after start time.')
      return
    }
    setSaveError('')
    setSaving(true)
    try {
      const { error } = await createShift({ ...form, list_id: listId })
      if (error) throw error
      setShowForm(false)
      setForm({ volunteer_name:'', volunteer_email:'', volunteer_phone:'',
        shift_date: new Date().toISOString().slice(0, 10),
        start_time:'09:00', end_time:'13:00', notes:'', status:'scheduled' })
      load()
    } catch (err) {
      setSaveError('Could not save shift — check your connection and try again.')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (id) => {
    try {
      await deleteShift(id)
      setShifts(prev => prev.filter(s => s.id !== id))
    } catch (_) { /* optimistic already reverted */ }
  }

  const handleStatusChange = async (id, status) => {
    // Optimistic update — revert on failure
    const prevShifts = shifts
    setShifts(prev => prev.map(s => s.id === id ? { ...s, status } : s))
    try {
      await updateShift(id, { status })
    } catch (err) {
      console.error('Failed to update shift status:', err)
      setShifts(prevShifts)
    }
  }

  const statusColors = {
    scheduled:  { bg:'#dbeafe', c:'#1d4ed8' },
    active:     { bg:'#dcfce7', c:'#15803d' },
    completed:  { bg:'#f3f4f6', c:'#374151' },
    cancelled:  { bg:'#fee2e2', c:'#b91c1c' },
  }

  return (
    <div style={{ overflowY:'auto', padding:'16px 20px', flex:1 }}>
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:16 }}>
        <div>
          <div style={{ fontSize:14, fontWeight:700 }}>Volunteer Shifts</div>
          <div style={{ fontSize:11, color:'#6B7280', marginTop:2 }}>Schedule who's showing up, when, and which turf they're covering</div>
        </div>
        <button onClick={() => setShowForm(v => !v)}
          style={{ display:'flex', alignItems:'center', gap:6, padding:'7px 14px', borderRadius:8, fontSize:12, fontWeight:700, border:'none', background:'#8B0000', color:'#fff', cursor:'pointer' }}>
          <Plus size={13}/> Add Shift
        </button>
      </div>

      {/* Add shift form */}
      {showForm && (
        <div style={{ background:'#fff', border:'1px solid #E5E7EB', borderRadius:10, padding:20, marginBottom:16 }}>
          <div style={{ fontSize:13, fontWeight:700, marginBottom:14 }}>New Shift</div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:12, marginBottom:12 }}>
            <div>
              <label style={{ fontSize:11, fontWeight:600, color:'#374151', display:'block', marginBottom:4 }}>Volunteer Name *</label>
              <input value={form.volunteer_name} onChange={e => setForm(f => ({ ...f, volunteer_name: e.target.value }))}
                placeholder="Jane Smith"
                style={{ width:'100%', padding:'7px 10px', border:'1px solid #D1D5DB', borderRadius:7, fontSize:12, outline:'none', boxSizing:'border-box' }}/>
            </div>
            <div>
              <label style={{ fontSize:11, fontWeight:600, color:'#374151', display:'block', marginBottom:4 }}>Email</label>
              <input value={form.volunteer_email} onChange={e => setForm(f => ({ ...f, volunteer_email: e.target.value }))}
                placeholder="jane@email.com" type="email"
                style={{ width:'100%', padding:'7px 10px', border:'1px solid #D1D5DB', borderRadius:7, fontSize:12, outline:'none', boxSizing:'border-box' }}/>
            </div>
            <div>
              <label style={{ fontSize:11, fontWeight:600, color:'#374151', display:'block', marginBottom:4 }}>Phone</label>
              <input value={form.volunteer_phone} onChange={e => setForm(f => ({ ...f, volunteer_phone: e.target.value }))}
                placeholder="(715) 555-0100"
                style={{ width:'100%', padding:'7px 10px', border:'1px solid #D1D5DB', borderRadius:7, fontSize:12, outline:'none', boxSizing:'border-box' }}/>
            </div>
          </div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr 2fr', gap:12, marginBottom:12 }}>
            <div>
              <label style={{ fontSize:11, fontWeight:600, color:'#374151', display:'block', marginBottom:4 }}>Date *</label>
              <input type="date" value={form.shift_date} onChange={e => setForm(f => ({ ...f, shift_date: e.target.value }))}
                style={{ width:'100%', padding:'7px 10px', border:'1px solid #D1D5DB', borderRadius:7, fontSize:12, outline:'none', boxSizing:'border-box' }}/>
            </div>
            <div>
              <label style={{ fontSize:11, fontWeight:600, color:'#374151', display:'block', marginBottom:4 }}>Start</label>
              <input type="time" value={form.start_time} onChange={e => setForm(f => ({ ...f, start_time: e.target.value }))}
                style={{ width:'100%', padding:'7px 10px', border:'1px solid #D1D5DB', borderRadius:7, fontSize:12, outline:'none', boxSizing:'border-box' }}/>
            </div>
            <div>
              <label style={{ fontSize:11, fontWeight:600, color:'#374151', display:'block', marginBottom:4 }}>End</label>
              <input type="time" value={form.end_time} onChange={e => setForm(f => ({ ...f, end_time: e.target.value }))}
                style={{ width:'100%', padding:'7px 10px', border:'1px solid #D1D5DB', borderRadius:7, fontSize:12, outline:'none', boxSizing:'border-box' }}/>
            </div>
            <div>
              <label style={{ fontSize:11, fontWeight:600, color:'#374151', display:'block', marginBottom:4 }}>Notes</label>
              <input value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                placeholder="Block 4-A — bring water"
                style={{ width:'100%', padding:'7px 10px', border:'1px solid #D1D5DB', borderRadius:7, fontSize:12, outline:'none', boxSizing:'border-box' }}/>
            </div>
          </div>
          {saveError && (
            <div style={{ fontSize:11, color:'#b91c1c', fontWeight:600, marginBottom:8, background:'#fee2e2', borderRadius:6, padding:'5px 10px' }}>
              {saveError}
            </div>
          )}
          <div style={{ display:'flex', gap:8, justifyContent:'flex-end' }}>
            <button onClick={() => { setShowForm(false); setSaveError('') }}
              style={{ padding:'7px 16px', borderRadius:7, fontSize:12, fontWeight:600, border:'1px solid #D1D5DB', background:'#fff', cursor:'pointer', color:'#374151' }}>
              Cancel
            </button>
            <button onClick={handleSave} disabled={saving || !form.volunteer_name.trim()}
              style={{ padding:'7px 16px', borderRadius:7, fontSize:12, fontWeight:700, border:'none',
                background: form.volunteer_name.trim() ? '#0A1628' : '#D1D5DB', color:'#fff', cursor: form.volunteer_name.trim() ? 'pointer' : 'not-allowed' }}>
              {saving ? 'Saving…' : 'Save Shift'}
            </button>
          </div>
        </div>
      )}

      {/* Shift list */}
      {!listId ? (
        <div style={{ textAlign:'center', padding:40, color:'#6B7280' }}>
          <Calendar size={32} style={{ margin:'0 auto 10px', opacity:.4 }}/>
          <div style={{ fontWeight:600 }}>Select a campaign to view shifts</div>
        </div>
      ) : loading ? (
        <div style={{ textAlign:'center', padding:40, color:'#9ca3af', fontSize:13 }}>Loading shifts…</div>
      ) : shifts.length === 0 ? (
        <div style={{ textAlign:'center', padding:40, color:'#6B7280' }}>
          <Calendar size={32} style={{ margin:'0 auto 10px', opacity:.4 }}/>
          <div style={{ fontWeight:600 }}>No shifts yet</div>
          <div style={{ fontSize:11, marginTop:4 }}>Click "Add Shift" to schedule your first volunteer</div>
        </div>
      ) : (
        <div style={{ background:'#fff', border:'1px solid #E5E7EB', borderRadius:10, overflow:'hidden' }}>
          <table style={{ width:'100%', borderCollapse:'collapse' }}>
            <thead>
              <tr>{['Volunteer','Contact','Date','Time','Notes','Status',''].map(h => (
                <th key={h} style={{ textAlign:'left', fontSize:10, fontWeight:700, textTransform:'uppercase', letterSpacing:.5, color:'#6B7280', padding:'9px 14px', background:'#F4F5F7', borderBottom:'1px solid #E5E7EB' }}>{h}</th>
              ))}</tr>
            </thead>
            <tbody>
              {shifts.map((s, i) => (
                <tr key={s.id}>
                  <td style={{ padding:'10px 14px', borderBottom:'1px solid #f3f4f6', fontWeight:600, fontSize:13 }}>
                    <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                      <div style={{ width:28, height:28, borderRadius:'50%', background:'#0A1628', display:'flex', alignItems:'center', justifyContent:'center', color:'#fff', fontSize:11, fontWeight:800, flexShrink:0 }}>
                        {(s.volunteer_name || '?').charAt(0)}
                      </div>
                      {s.volunteer_name}
                    </div>
                  </td>
                  <td style={{ padding:'10px 14px', borderBottom:'1px solid #f3f4f6', fontSize:11, color:'#6B7280' }}>
                    {s.volunteer_email && <div>{s.volunteer_email}</div>}
                    {s.volunteer_phone && <div>{s.volunteer_phone}</div>}
                  </td>
                  <td style={{ padding:'10px 14px', borderBottom:'1px solid #f3f4f6', fontSize:12 }}>
                    {s.shift_date ? new Date(s.shift_date + 'T00:00:00').toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric' }) : '—'}
                  </td>
                  <td style={{ padding:'10px 14px', borderBottom:'1px solid #f3f4f6', fontSize:12 }}>
                    {s.start_time} – {s.end_time}
                  </td>
                  <td style={{ padding:'10px 14px', borderBottom:'1px solid #f3f4f6', fontSize:11, color:'#6B7280', maxWidth:160 }}>{s.notes || '—'}</td>
                  <td style={{ padding:'10px 14px', borderBottom:'1px solid #f3f4f6' }}>
                    <select value={s.status} onChange={e => handleStatusChange(s.id, e.target.value)}
                      style={{ padding:'3px 8px', borderRadius:5, fontSize:11, fontWeight:700,
                        background: statusColors[s.status]?.bg || '#f3f4f6',
                        color: statusColors[s.status]?.c || '#374151',
                        border:'none', cursor:'pointer', outline:'none' }}>
                      {['scheduled','active','completed','cancelled'].map(v => (
                        <option key={v} value={v}>{v.charAt(0).toUpperCase() + v.slice(1)}</option>
                      ))}
                    </select>
                  </td>
                  <td style={{ padding:'10px 14px', borderBottom:'1px solid #f3f4f6' }}>
                    <button onClick={() => handleDelete(s.id)}
                      style={{ background:'none', border:'none', color:'#9ca3af', cursor:'pointer', padding:'2px 4px', borderRadius:4 }}>
                      <Trash2 size={14}/>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ─── EXPORT TAB (Feature 4: post-canvass PDF report) ─────────────────────────
const EXPORT_COLUMNS = [
  { key: 'address',    label: 'Address' },
  { key: 'status',     label: 'Result' },
  { key: 'notes',      label: 'Notes' },
  { key: 'knocked_by', label: 'Volunteer' },
  { key: 'knocked_at', label: 'Date/Time' },
]

function ExportTab({ listId, candidateName }) {
  const [fromDate, setFromDate] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() - 7)
    return d.toISOString().slice(0, 10)
  })
  const [toDate, setToDate]     = useState(new Date().toISOString().slice(0, 10))
  const [generating, setGenerating] = useState(false)
  const [previewData, setPreviewData] = useState(null)
  const [selectedCols, setSelectedCols] = useState(() => EXPORT_COLUMNS.map(c => c.key))

  const fetchPreview = useCallback(async () => {
    if (!listId) return
    // Guard: don't query if date range is inverted
    if (fromDate && toDate && fromDate > toDate) return
    setGenerating(true)
    try {
      const { data } = await getDoorKnocksForExport(listId, fromDate + 'T00:00:00', toDate + 'T23:59:59')
      setPreviewData(Array.isArray(data) ? data : [])
    } catch (_) {
      setPreviewData([])
    } finally {
      setGenerating(false)
    }
  }, [listId, fromDate, toDate])

  useEffect(() => { fetchPreview() }, [listId, fromDate, toDate])

  const escHtml = (s) => String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#039;')

  const generateReport = () => {
    if (!previewData) return
    const knocks = previewData
    const total  = knocks.length
    const contacted    = knocks.filter(k => k.status === 'contacted').length
    const notHome      = knocks.filter(k => k.status === 'not_home').length
    const refused      = knocks.filter(k => k.status === 'refused').length
    const noSoliciting = knocks.filter(k => k.status === 'no_soliciting').length
    const other        = total - contacted - notHome - refused - noSoliciting
    const contactRate  = total ? Math.round((contacted / total) * 100) : 0

    // Volunteer breakdown
    const byVol = {}
    knocks.forEach(k => {
      const key = k.knocked_by || 'Unknown'
      if (!byVol[key]) byVol[key] = { total:0, contacted:0, not_home:0, refused:0 }
      byVol[key].total++
      if (byVol[key][k.status] !== undefined) byVol[key][k.status]++
    })

    // Group by address / turf (naive grouping)
    const byAddr = {}
    knocks.forEach(k => {
      const addr = (k.address || 'Unknown').trim()
      if (!byAddr[addr]) byAddr[addr] = []
      byAddr[addr].push(k)
    })

    const dateRange = `${new Date(fromDate + 'T00:00:00').toLocaleDateString('en-US', { month:'long', day:'numeric', year:'numeric' })} – ${new Date(toDate + 'T00:00:00').toLocaleDateString('en-US', { month:'long', day:'numeric', year:'numeric' })}`

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<title>Canvassing Report — ${escHtml(candidateName || 'Campaign')}</title>
<style>
  * { box-sizing:border-box; margin:0; padding:0 }
  body { font-family: 'Helvetica Neue', Arial, sans-serif; color:#111; background:#fff; padding:40px 48px; font-size:13px; line-height:1.5 }
  h1 { font-size:22px; font-weight:800; color:#0A1628; margin-bottom:4px }
  h2 { font-size:14px; font-weight:700; color:#374151; margin:24px 0 10px }
  .sub { color:#6B7280; font-size:12px; margin-bottom:24px }
  .stats { display:flex; gap:16px; flex-wrap:wrap; margin-bottom:24px }
  .stat { flex:1; min-width:110px; background:#F4F5F7; border-radius:8px; padding:14px 16px; text-align:center }
  .stat .val { font-size:28px; font-weight:800; line-height:1 }
  .stat .lbl { font-size:11px; color:#6B7280; margin-top:4px }
  .bar-wrap { display:flex; align-items:center; gap:8px; margin-bottom:6px }
  .bar { flex:1; height:10px; background:#e5e7eb; border-radius:5px; overflow:hidden }
  .bar-fill { height:100%; border-radius:5px }
  .badge { display:inline-block; padding:2px 7px; border-radius:4px; font-size:11px; font-weight:700 }
  table { width:100%; border-collapse:collapse; margin-top:6px }
  th { text-align:left; font-size:10px; text-transform:uppercase; letter-spacing:.5px; color:#6B7280; padding:8px 12px; background:#F4F5F7; border-bottom:1px solid #E5E7EB }
  td { padding:8px 12px; border-bottom:1px solid #f3f4f6; font-size:12px }
  .footer { margin-top:40px; padding-top:16px; border-top:1px solid #E5E7EB; font-size:11px; color:#9ca3af }
  @media print { @page { margin:20mm } body { padding:0 } }
</style>
</head>
<body>
<h1>Canvassing Report — ${escHtml(candidateName || 'Campaign')}</h1>
<div class="sub">Period: ${dateRange} · Generated ${new Date().toLocaleString('en-US', { month:'long', day:'numeric', year:'numeric', hour:'numeric', minute:'2-digit' })}</div>

<div class="stats">
  <div class="stat"><div class="val">${total}</div><div class="lbl">Total Doors</div></div>
  <div class="stat"><div class="val" style="color:#15803d">${contacted}</div><div class="lbl">Contacted</div></div>
  <div class="stat"><div class="val" style="color:#a16207">${notHome}</div><div class="lbl">Left Lit</div></div>
  <div class="stat"><div class="val" style="color:#b91c1c">${refused}</div><div class="lbl">Refused</div></div>
  <div class="stat"><div class="val" style="color:#1d4ed8">${contactRate}%</div><div class="lbl">Contact Rate</div></div>
</div>

<h2>Result Breakdown</h2>
${[
  { label:'Contacted',     count:contacted,    color:'#16a34a' },
  { label:'Left Lit',      count:notHome,      color:'#eab308' },
  { label:'Refused',       count:refused,      color:'#dc2626' },
  { label:'No Soliciting', count:noSoliciting, color:'#92400e' },
  { label:'Other',         count:other,        color:'#9ca3af' },
].map(r => `
<div class="bar-wrap">
  <span style="min-width:90px;font-size:12px">${r.label}</span>
  <div class="bar"><div class="bar-fill" style="width:${total?Math.round(r.count/total*100):0}%;background:${r.color}"></div></div>
  <span style="min-width:34px;text-align:right;font-weight:700">${r.count}</span>
</div>`).join('')}

<h2>Volunteer Breakdown</h2>
<table>
<thead><tr><th>Volunteer</th><th>Doors</th><th>Contacted</th><th>Left Lit</th><th>Refused</th><th>Rate</th></tr></thead>
<tbody>
${Object.entries(byVol).map(([vol, d]) =>
  `<tr><td style="font-weight:600">${vol === 'Unknown' ? 'Unknown / App' : escHtml(vol.substring(0, 8)) + '…'}</td>
   <td>${d.total}</td><td style="color:#15803d;font-weight:700">${d.contacted}</td>
   <td style="color:#a16207">${d.not_home}</td><td style="color:#b91c1c">${d.refused}</td>
   <td style="font-weight:700">${d.total ? Math.round(d.contacted/d.total*100) : 0}%</td></tr>`
).join('')}
</tbody>
</table>

<h2>Doors Knocked — Full Log (${Math.min(knocks.length, 200)} of ${knocks.length})</h2>
<table>
<thead><tr><th>Address</th><th>Result</th><th>Notes</th><th>Time</th></tr></thead>
<tbody>
${knocks.slice(0, 200).map(k =>
  `<tr><td style="font-weight:600">${escHtml(k.address || '—')}</td>
   <td><span class="badge" style="background:${
     k.status==='contacted'?'#dcfce7':k.status==='not_home'?'#fef9c3':k.status==='refused'?'#fee2e2':'#f3f4f6'
   };color:${
     k.status==='contacted'?'#15803d':k.status==='not_home'?'#a16207':k.status==='refused'?'#b91c1c':'#374151'
   }">${escHtml(k.status?.replace('_',' ') || '—')}</span></td>
   <td style="color:#6B7280;font-style:italic">${escHtml(k.notes || '')}</td>
   <td style="color:#9ca3af">${k.knocked_at ? new Date(k.knocked_at).toLocaleTimeString('en-US', {hour:'numeric',minute:'2-digit'}) : ''}</td></tr>`
).join('')}
</tbody>
</table>

<div class="footer">Badger Board · WI Political Intelligence · The Bluejack Group · Confidential</div>
<script>window.onload = () => window.print()</script>
</body></html>`

    const win = window.open('', '_blank', 'width=900,height=1100')
    if (!win) {
      alert('Pop-up blocked! Please allow pop-ups for this site to generate the PDF report.')
      return
    }
    win.document.write(html)
    win.document.close()
  }

  const toggleCol = (key) => {
    setSelectedCols(prev => prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key])
  }

  const downloadCSV = () => {
    if (!previewData?.length || selectedCols.length === 0) return
    const colDefs = EXPORT_COLUMNS.filter(c => selectedCols.includes(c.key))
    const header = colDefs.map(c => c.label).join(',')
    const rows = previewData.map(k => colDefs.map(c => {
      let val = ''
      if (c.key === 'address')    val = k.address || ''
      else if (c.key === 'status')     val = (k.status || '').replace('_', ' ')
      else if (c.key === 'notes')      val = k.notes || ''
      else if (c.key === 'knocked_by') val = k.knocked_by || ''
      else if (c.key === 'knocked_at') val = k.knocked_at ? new Date(k.knocked_at).toLocaleString() : ''
      return `"${String(val).replace(/"/g, '""')}"`
    }).join(','))
    const csv = [header, ...rows].join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `canvass-${(candidateName || 'report').replace(/[^a-zA-Z0-9]/g, '_')}-${fromDate}-to-${toDate}.csv`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  return (
    <div style={{ overflowY:'auto', padding:'16px 20px', flex:1 }}>
      <div style={{ fontSize:14, fontWeight:700, marginBottom:4 }}>Post-Canvass Report</div>
      <div style={{ fontSize:11, color:'#6B7280', marginBottom:20 }}>Generate a printable PDF or download a CSV with contact rates, volunteer stats, and supporter IDs</div>

      {/* Date range controls */}
      <div style={{ background:'#fff', border:'1px solid #E5E7EB', borderRadius:10, padding:20, marginBottom:20 }}>
        <div style={{ fontSize:13, fontWeight:700, marginBottom:14 }}>Report Period</div>
        <div style={{ display:'flex', alignItems:'center', gap:12, flexWrap:'wrap' }}>
          <div>
            <label style={{ fontSize:11, fontWeight:600, color:'#374151', display:'block', marginBottom:4 }}>From</label>
            <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)}
              style={{ padding:'7px 10px', border:'1px solid #D1D5DB', borderRadius:7, fontSize:12, outline:'none' }}/>
          </div>
          <div>
            <label style={{ fontSize:11, fontWeight:600, color:'#374151', display:'block', marginBottom:4 }}>To</label>
            <input type="date" value={toDate} onChange={e => setToDate(e.target.value)}
              style={{ padding:'7px 10px', border:'1px solid #D1D5DB', borderRadius:7, fontSize:12, outline:'none' }}/>
          </div>
          {fromDate && toDate && fromDate > toDate && (
            <div style={{ color:'#b91c1c', fontSize:11, fontWeight:600, alignSelf:'flex-end', paddingBottom:4 }}>
              ⚠ "From" date must be before "To" date
            </div>
          )}
          <div style={{ paddingTop:20 }}>
            {['Today','Last 7 days','Last 30 days'].map((label, i) => {
              const d = new Date()
              const days = [0,7,30][i]
              return (
                <button key={label} onClick={() => {
                    const from = new Date(); from.setDate(from.getDate() - days)
                    setFromDate(from.toISOString().slice(0,10))
                    setToDate(new Date().toISOString().slice(0,10))
                  }}
                  style={{ marginRight:6, padding:'5px 10px', borderRadius:6, fontSize:11, fontWeight:600, border:'1px solid #E5E7EB', background:'#f9fafb', cursor:'pointer' }}>
                  {label}
                </button>
              )
            })}
          </div>
        </div>
      </div>

      {/* Preview stats */}
      {previewData && (
        <div style={{ background:'#fff', border:'1px solid #E5E7EB', borderRadius:10, padding:20, marginBottom:20 }}>
          <div style={{ fontSize:13, fontWeight:700, marginBottom:12 }}>Preview — {previewData.length} knocks in period</div>
          {previewData.length === 0 ? (
            <div style={{ fontSize:12, color:'#9ca3af' }}>No door knocks recorded in this date range.</div>
          ) : (
            <div style={{ display:'flex', gap:12, flexWrap:'wrap' }}>
              {[
                { label:'Total Doors', val: previewData.length, c:'#111' },
                { label:'Contacted',   val: previewData.filter(k=>k.status==='contacted').length, c:'#15803d' },
                { label:'Left Lit',    val: previewData.filter(k=>k.status==='not_home').length,  c:'#a16207' },
                { label:'Refused',     val: previewData.filter(k=>k.status==='refused').length,   c:'#b91c1c' },
                { label:'Contact Rate',val: previewData.length ? Math.round(previewData.filter(k=>k.status==='contacted').length/previewData.length*100)+'%' : '—', c:'#7c3aed' },
              ].map(s => (
                <div key={s.label} style={{ background:'#f9fafb', border:'1px solid #E5E7EB', borderRadius:8, padding:'10px 16px', minWidth:100, textAlign:'center' }}>
                  <div style={{ fontSize:22, fontWeight:800, color:s.c, lineHeight:1 }}>{s.val}</div>
                  <div style={{ fontSize:10, color:'#6B7280', marginTop:2 }}>{s.label}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Column selection for CSV */}
      {previewData?.length > 0 && (
        <div style={{ background:'#fff', border:'1px solid #E5E7EB', borderRadius:10, padding:'14px 20px', marginBottom:20 }}>
          <div style={{ fontSize:13, fontWeight:700, marginBottom:10 }}>Columns (for CSV export)</div>
          <div style={{ display:'flex', gap:14, flexWrap:'wrap' }}>
            {EXPORT_COLUMNS.map(c => (
              <label key={c.key} style={{ display:'flex', alignItems:'center', gap:5, fontSize:12, fontWeight:500, color:'#374151', cursor:'pointer' }}>
                <input type="checkbox" checked={selectedCols.includes(c.key)} onChange={() => toggleCol(c.key)}
                  style={{ accentColor:'#8B0000' }}/>
                {c.label}
              </label>
            ))}
          </div>
        </div>
      )}

      <div style={{ display:'flex', gap:10, flexWrap:'wrap' }}>
        <button onClick={generateReport}
          disabled={generating || !previewData?.length || (fromDate > toDate)}
          style={{ display:'flex', alignItems:'center', gap:8, padding:'10px 22px', borderRadius:9, fontSize:13, fontWeight:700,
            border:'none', cursor: (previewData?.length > 0 && !generating) ? 'pointer' : 'not-allowed',
            background: (previewData?.length > 0) ? 'linear-gradient(135deg,#0A1628,#1e3a5f)' : '#D1D5DB', color:'#fff' }}>
          <FileText size={15}/> {generating ? 'Generating…' : 'Generate PDF Report'}
        </button>
        <button onClick={downloadCSV}
          disabled={!previewData?.length || selectedCols.length === 0 || (fromDate > toDate)}
          style={{ display:'flex', alignItems:'center', gap:8, padding:'10px 22px', borderRadius:9, fontSize:13, fontWeight:700,
            border:'1px solid #E5E7EB', cursor: (previewData?.length > 0 && selectedCols.length > 0) ? 'pointer' : 'not-allowed',
            background: (previewData?.length > 0 && selectedCols.length > 0) ? '#fff' : '#f3f4f6', color:'#374151' }}>
          <Download size={15}/> Download CSV
        </button>
      </div>
      {previewData?.length === 0 && (
        <div style={{ fontSize:11, color:'#9ca3af', marginTop:8 }}>No data for selected period — adjust the date range to include days with recorded knocks.</div>
      )}
    </div>
  )
}

// ─── MESSAGES TAB (Feature 5: coordinator-to-volunteer messaging) ──────────────
function MessagesTab({ listId, coordinatorName }) {
  const [messages, setMessages]   = useState([])
  const [loading, setLoading]     = useState(true)
  const [text, setText]           = useState('')
  const [msgType, setMsgType]     = useState('broadcast')
  const [sending, setSending]     = useState(false)
  const bottomRef                 = useRef(null)

  const load = useCallback(() => {
    if (!listId) return
    setLoading(true)
    setMessages([])
    getMessages(listId).then(({ data }) => {
      setMessages(Array.isArray(data) ? [...data].reverse() : [])
    }).catch(() => setMessages([])).finally(() => setLoading(false))
  }, [listId])

  useEffect(() => { load() }, [load])

  // Supabase Realtime subscription for live messages
  useEffect(() => {
    if (!listId) return
    const channel = supabase
      .channel(`canvass-messages-${listId}`)
      .on('postgres_changes', {
        event: 'INSERT', schema: 'public', table: 'canvass_messages',
        filter: `list_id=eq.${listId}`,
      }, payload => {
        setMessages(prev => [...prev, payload.new])
        setTimeout(() => bottomRef.current?.scrollIntoView({ behavior:'smooth' }), 100)
      })
      .subscribe()
    return () => supabase.removeChannel(channel)
  }, [listId])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior:'smooth' })
  }, [messages])

  const handleSend = async () => {
    if (!text.trim() || !listId) return
    setSending(true)
    try {
      await sendMessage({
        list_id: listId,
        sender_name: coordinatorName || 'Coordinator',
        message: text.trim(),
        msg_type: msgType,
      })
      setText('')
    } catch (err) {
      console.error('Failed to send message:', err)
    } finally {
      setSending(false)
    }
  }

  const typeColors = {
    broadcast: { bg:'#dbeafe', c:'#1d4ed8', label:'◈ Broadcast' },
    alert:     { bg:'#fee2e2', c:'#b91c1c', label:'▲ Alert' },
    reroute:   { bg:'#fef9c3', c:'#a16207', label:'➤ Reroute' },
    praise:    { bg:'#dcfce7', c:'#15803d', label:'★ Praise' },
  }

  return (
    <div style={{ display:'flex', flexDirection:'column', flex:1, overflow:'hidden' }}>
      {/* Message feed */}
      <div style={{ flex:1, overflowY:'auto', padding:'16px 20px' }}>
        {!listId ? (
          <div style={{ textAlign:'center', padding:40, color:'#6B7280' }}>
            <MessageCircle size={32} style={{ margin:'0 auto 10px', opacity:.4 }}/>
            <div style={{ fontWeight:600 }}>Select a campaign to view messages</div>
          </div>
        ) : loading ? (
          <div style={{ textAlign:'center', padding:40, color:'#9ca3af', fontSize:13 }}>Loading messages…</div>
        ) : messages.length === 0 ? (
          <div style={{ textAlign:'center', padding:40, color:'#6B7280' }}>
            <MessageCircle size={32} style={{ margin:'0 auto 10px', opacity:.4 }}/>
            <div style={{ fontWeight:600 }}>No messages yet</div>
            <div style={{ fontSize:11, marginTop:4 }}>Send a broadcast to notify all active volunteers</div>
          </div>
        ) : (
          <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
            {messages.map((m, i) => {
              const tc = typeColors[m.msg_type] || typeColors.broadcast
              return (
                <div key={m.id || i} style={{ background:'#fff', border:'1px solid #E5E7EB', borderRadius:10, padding:'12px 14px' }}>
                  <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:6 }}>
                    <span style={{ display:'inline-block', padding:'2px 8px', borderRadius:999, fontSize:10, fontWeight:700,
                      background:tc.bg, color:tc.c }}>{tc.label}</span>
                    <span style={{ fontSize:11, fontWeight:700, color:'#111' }}>{m.sender_name}</span>
                    <span style={{ fontSize:10, color:'#9ca3af', marginLeft:'auto' }}>{relTime(m.sent_at)}</span>
                  </div>
                  <div style={{ fontSize:13, color:'#1f2937', lineHeight:1.5 }}>{m.message}</div>
                </div>
              )
            })}
            <div ref={bottomRef}/>
          </div>
        )}
      </div>

      {/* Compose bar */}
      {listId && (
        <div style={{ borderTop:'1px solid #E5E7EB', padding:'12px 20px', background:'#fff', flexShrink:0 }}>
          <div style={{ display:'flex', gap:8, marginBottom:8 }}>
            {Object.entries(typeColors).map(([val, tc]) => (
              <button key={val} onClick={() => setMsgType(val)}
                style={{ padding:'4px 10px', borderRadius:6, fontSize:11, fontWeight:700, cursor:'pointer',
                  border:`1px solid ${msgType===val ? tc.c : '#E5E7EB'}`,
                  background: msgType===val ? tc.bg : '#fff',
                  color: msgType===val ? tc.c : '#6B7280' }}>
                {tc.label}
              </button>
            ))}
          </div>
          <div style={{ display:'flex', gap:8 }}>
            <input value={text} onChange={e => setText(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() } }}
              placeholder={`Send a ${msgType} to all active volunteers…`}
              style={{ flex:1, padding:'9px 12px', border:'1px solid #D1D5DB', borderRadius:8, fontSize:12, outline:'none', fontFamily:'inherit' }}/>
            <button onClick={handleSend} disabled={sending || !text.trim()}
              style={{ display:'flex', alignItems:'center', gap:6, padding:'9px 16px', borderRadius:8, fontSize:12, fontWeight:700,
                border:'none', cursor: text.trim() ? 'pointer' : 'not-allowed',
                background: text.trim() ? '#8B0000' : '#D1D5DB', color:'#fff' }}>
              <Send size={13}/> {sending ? 'Sending…' : 'Send'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── SURVEY QUESTIONS EDITOR ─────────────────────────────────────────────────
// Modal for building per-candidate door-knock survey questions.
// Coordinator opens this from the campaign sidebar to define what to ask at doors.
const Q_TYPES = [
  { val:'yes_no', label:'Yes / No' },
  { val:'choice', label:'Multiple Choice' },
  { val:'text',   label:'Open Text' },
]

function SurveyQuestionsModal({ candidate, onClose, onSaved }) {
  const [questions, setQuestions] = useState(
    Array.isArray(candidate?.survey_questions) ? candidate.survey_questions : []
  )
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState('')

  const addQuestion = () => {
    setQuestions(prev => [...prev, {
      id:      `q_${Date.now()}`,
      text:    '',
      type:    'yes_no',
      options: [],
    }])
  }

  const updateQ = (id, field, val) => {
    setQuestions(prev => prev.map(q => q.id === id ? { ...q, [field]: val } : q))
  }

  const removeQ = (id) => setQuestions(prev => prev.filter(q => q.id !== id))

  const handleSave = async () => {
    const valid = questions.filter(q => q.text?.trim())
    setSaving(true)
    setError('')
    const { error: err } = await saveCandidateSurveyQuestions(candidate.id, valid)
    setSaving(false)
    if (err) { setError(err.message || 'Failed to save.'); return }
    onSaved && onSaved(candidate.id, valid)
    onClose()
  }

  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,.45)', zIndex:1000, display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}>
      <div style={{ background:'#fff', borderRadius:14, boxShadow:'0 8px 40px rgba(0,0,0,.2)', width:'100%', maxWidth:520, maxHeight:'85vh', display:'flex', flexDirection:'column' }}>
        {/* Header */}
        <div style={{ padding:'18px 20px 14px', borderBottom:'1px solid #E5E7EB', display:'flex', alignItems:'center', justifyContent:'space-between' }}>
          <div>
            <div style={{ fontWeight:700, fontSize:15 }}>Survey Questions</div>
            <div style={{ fontSize:12, color:'#6B7280', marginTop:2 }}>{candidate?.name} — Asked at the door in Advanced mode</div>
          </div>
          <button onClick={onClose} style={{ background:'none', border:'none', cursor:'pointer', color:'#6B7280', padding:4 }}>
            <X size={18}/>
          </button>
        </div>

        {/* Question list */}
        <div style={{ overflowY:'auto', padding:'14px 20px', flex:1 }}>
          {questions.length === 0 && (
            <div style={{ textAlign:'center', padding:'28px 0', color:'#9ca3af', fontSize:13 }}>
              No questions yet. Add one below to start building your door-knock survey.
            </div>
          )}
          {questions.map((q, idx) => (
            <div key={q.id} style={{ background:'#f9fafb', border:'1px solid #E5E7EB', borderRadius:9, padding:'12px 14px', marginBottom:10 }}>
              <div style={{ display:'flex', gap:8, marginBottom:8, alignItems:'flex-start' }}>
                <div style={{ flex:1 }}>
                  <input
                    type="text"
                    value={q.text}
                    onChange={e => updateQ(q.id, 'text', e.target.value)}
                    placeholder={`Question ${idx + 1}…`}
                    style={{ width:'100%', padding:'6px 9px', border:'1px solid #D1D5DB', borderRadius:6, fontSize:12, outline:'none', boxSizing:'border-box' }}
                  />
                </div>
                <select
                  value={q.type}
                  onChange={e => updateQ(q.id, 'type', e.target.value)}
                  style={{ padding:'6px 8px', border:'1px solid #D1D5DB', borderRadius:6, fontSize:11, outline:'none', background:'#fff' }}>
                  {Q_TYPES.map(t => <option key={t.val} value={t.val}>{t.label}</option>)}
                </select>
                <button onClick={() => removeQ(q.id)} style={{ background:'none', border:'none', cursor:'pointer', color:'#EF4444', padding:'4px 2px', flexShrink:0 }}>
                  <Trash2 size={14}/>
                </button>
              </div>
              {q.type === 'choice' && (
                <div style={{ marginTop:4 }}>
                  <div style={{ fontSize:10, fontWeight:600, color:'#6B7280', marginBottom:4 }}>Answer choices (one per line):</div>
                  <textarea
                    value={(q.options || []).join('\n')}
                    onChange={e => updateQ(q.id, 'options', e.target.value.split('\n').filter(Boolean))}
                    placeholder="Option A&#10;Option B&#10;Option C"
                    rows={3}
                    style={{ width:'100%', padding:'5px 8px', border:'1px solid #D1D5DB', borderRadius:5, fontSize:11, resize:'vertical', outline:'none', fontFamily:'inherit', boxSizing:'border-box' }}
                  />
                </div>
              )}
            </div>
          ))}
          <button
            onClick={addQuestion}
            style={{ width:'100%', padding:'9px', border:'2px dashed #D1D5DB', borderRadius:8, fontSize:12, fontWeight:600, color:'#6B7280', background:'#fff', cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', gap:6 }}>
            <Plus size={14}/> Add Question
          </button>
        </div>

        {/* Footer */}
        {error && <div style={{ padding:'4px 20px', fontSize:12, color:'#b91c1c' }}>{error}</div>}
        <div style={{ padding:'12px 20px', borderTop:'1px solid #E5E7EB', display:'flex', gap:10 }}>
          <button onClick={onClose} style={{ flex:1, padding:'8px', borderRadius:8, border:'1px solid #E5E7EB', background:'#fff', fontSize:13, fontWeight:600, cursor:'pointer', color:'#374151' }}>
            Cancel
          </button>
          <button onClick={handleSave} disabled={saving} style={{ flex:2, padding:'8px', borderRadius:8, border:'none', background:'#8B0000', color:'#fff', fontSize:13, fontWeight:700, cursor:saving?'wait':'pointer', opacity:saving?.7:1 }}>
            {saving ? 'Saving…' : `Save ${questions.filter(q=>q.text?.trim()).length} Question${questions.filter(q=>q.text?.trim()).length!==1?'s':''}`}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── SCOUT UPGRADE PROMPT ─────────────────────────────────────────────────────
function ScoutUpgradePrompt({ feature }) {
  return (
    <div style={{ display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', height:'100%', gap:16, padding:40, textAlign:'center' }}>
      <div style={{ fontSize:32, fontWeight:800, color:'#94A3B8' }}>▣</div>
      <div style={{ fontSize:16, fontWeight:700, color:'#111827' }}>{feature} — Campaign Plan & above</div>
      <div style={{ fontSize:13, color:'#6B7280', maxWidth:360 }}>Upgrade to unlock exports, volunteer management, unlimited doors, and more.</div>
      <a href="/plans" style={{ display:'inline-block', background:'#8B0000', color:'#fff', padding:'10px 24px', borderRadius:8, fontSize:14, fontWeight:600, textDecoration:'none' }}>View Plans →</a>
    </div>
  )
}

// ─── MAIN PAGE ────────────────────────────────────────────────────────────────
export default function DoorKnocking() {
  const { user, session } = useAuth()
  const plan = getUserPlan(user)
  const isScout = plan === 'scout'
  const [activeTab, setActiveTab] = useState('turf')
  const [candKey, setCandKey] = useState('kroll')
  const [candidateConfig, setCandidateConfig] = useState(STATIC_CANDIDATE_CONFIG)
  const [candidateList, setCandidateList] = useState(STATIC_CANDIDATE_LIST)
  const [houses, setHouses] = useState([])
  const [districtGeo, setDistrictGeo] = useState(null) // { feature, ring, bbox }
  const [geoLoading, setGeoLoading] = useState(true)

  // ── Offline / sync state ──────────────────────────────────────────────────────
  const [isOnline, setIsOnline] = useState(navigator.onLine)
  const [pendingKnocksCount, setPendingKnocksCount] = useState(0)
  const [syncing, setSyncing] = useState(false)

  // ── Active campaign door-knock list ID (Supabase door_knock_lists row) ────────
  const [activeCampListId, setActiveCampListId] = useState(null)

  // ── Survey Questions modal state ─────────────────────────────────────────────
  const [showSurveyModal, setShowSurveyModal]     = useState(false)
  const [surveyCandidate, setSurveyCandidate]     = useState(null)

  const openSurveyModal = () => {
    const cand = candidateList.find(c => c.id === candKey)
    if (cand) { setSurveyCandidate(cand); setShowSurveyModal(true) }
  }

  const handleSurveyQuestionsSaved = (candidateId, questions) => {
    setCandidateList(prev => prev.map(c =>
      c.id === candidateId ? { ...c, survey_questions: questions } : c
    ))
  }

  // ── New Campaign modal state ──────────────────────────────────────────────────
  const [showNewCampaign, setShowNewCampaign] = useState(false)
  const [allDbCandidates, setAllDbCandidates] = useState([])
  const [newCampId, setNewCampId] = useState('')
  const [newCampColor, setNewCampColor] = useState('#4f46e5')
  const [newCampError, setNewCampError] = useState('')

  const openNewCampaign = () => {
    getCandidates({}).then(({ data }) => {
      const list = Array.isArray(data) ? data : []
      setAllDbCandidates(list)
      const inList = new Set(candidateList.map(c => c.id))
      const first = list.find(c => !inList.has(c.id))
      setNewCampId(first?.id || '')
      setNewCampColor('#4f46e5')
      setNewCampError('')
      setShowNewCampaign(true)
    }).catch(() => {
      // On fetch error show modal with empty list + error msg — do NOT silently open from catch
      setAllDbCandidates([])
      setNewCampError('Could not load candidates. Check your connection and try again.')
      setNewCampId('')
      setShowNewCampaign(true)
    })
  }

  const handleAddCampaign = () => {
    if (!newCampId) { setNewCampError('Please select a candidate.'); return }
    const cand = allDbCandidates.find(c => c.id === newCampId)
    if (!cand) { setNewCampError('Candidate not found.'); return }
    if (candidateList.find(c => c.id === newCampId)) { setNewCampError('This candidate is already in the campaign list.'); return }

    // Try to derive district config; fall back to a minimal displayable entry
    const derived = deriveDistrictConfig({ ...cand, map_color: newCampColor })
    const cfg = derived || {
      name: cand.name,
      color: newCampColor,
      geojson: null,
      match: () => false,
      label: cand.office?.name || 'No district mapped',
    }

    setCandidateConfig(prev => ({ ...prev, [newCampId]: cfg }))
    setCandidateList(prev => [...prev, { id: newCampId, name: cand.name, label: cfg.label }])
    setCandKey(newCampId)
    setShowNewCampaign(false)
  }

  // Fetch the current user's candidates from Supabase on mount.
  // Only the logged-in user's own candidates are returned (created_by + RLS).
  // If the user has no qualifying candidates, candidateList stays empty and
  // the page shows an empty state prompting them to add a candidate first.
  const [candidatesLoading, setCandidatesLoading] = useState(true)
  useEffect(() => {
    let mounted = true
    setCandidatesLoading(true)
    getDoorKnockCandidates()
      .then(({ data, error }) => {
        if (!mounted) return
        setCandidatesLoading(false)
        if (error || !data || data.length === 0) return // stays empty — shows empty state
        const config = buildCandidateConfig(data)
        // Include ALL loaded candidates even if district can't be derived
        const fullConfig = { ...config }
        for (const c of data) {
          if (!fullConfig[c.id]) {
            fullConfig[c.id] = {
              name: c.name,
              color: c.map_color || '#4f46e5',
              geojson: null,
              match: () => false,
              label: c.office?.name || c.name,
            }
          }
        }
        setCandidateConfig(fullConfig)
        setCandidateList(data.map(c => ({
          id: c.id,
          name: c.name,
          label: fullConfig[c.id]?.label || c.name,
          survey_questions: Array.isArray(c.survey_questions) ? c.survey_questions : [],
        })))
        setCandKey(data[0].id)
      })
      .catch(() => { if (mounted) setCandidatesLoading(false) })
    return () => { mounted = false }
  }, [])

  // ── Online / offline detection ────────────────────────────────────────────────
  useEffect(() => {
    const onOnline  = () => setIsOnline(true)
    const onOffline = () => setIsOnline(false)
    window.addEventListener('online',  onOnline)
    window.addEventListener('offline', onOffline)
    return () => {
      window.removeEventListener('online',  onOnline)
      window.removeEventListener('offline', onOffline)
    }
  }, [])

  // ── Poll pending-knocks count (updates badge even when CanvasserView unmounted) ─
  useEffect(() => {
    let mounted = true
    const check = () => pendingCount().then(n => { if (mounted) setPendingKnocksCount(n) }).catch(() => {})
    check()
    const iv = setInterval(check, 10000) // every 10 s
    return () => { mounted = false; clearInterval(iv) }
  }, [])

  // ── Auto-sync when connection returns ─────────────────────────────────────────
  useEffect(() => {
    if (!isOnline || pendingKnocksCount === 0 || syncing) return
    syncOfflineKnocks()
  }, [isOnline, user]) // eslint-disable-line react-hooks/exhaustive-deps

  const [syncResult, setSyncResult] = useState(null) // null | { synced, failed }

  async function syncOfflineKnocks() {
    if (!user?.id) return
    setSyncing(true)
    setSyncResult(null)
    try {
      const result = await flushQueue(supabase, user.id)
      const synced = result.synced || 0
      const failed = result.failed || 0
      if (synced > 0) setPendingKnocksCount(prev => Math.max(0, prev - synced))
      setSyncResult({ synced, failed })
      // Auto-dismiss success after 5s
      if (failed === 0) setTimeout(() => setSyncResult(null), 5000)
    } catch (_) {
      setSyncResult({ synced: 0, failed: -1 }) // -1 = total failure
    }
    finally { setSyncing(false) }
  }

  // ── Resolve the door_knock_lists DB row for the active candidate ──────────────
  // Creates a default list if none exists so Shifts/Messages/Export always have an ID.
  useEffect(() => {
    if (!candKey) return
    setActiveCampListId(null)
    getDoorKnockLists()
      .then(async ({ data, error }) => {
        if (error) return
        const lists = Array.isArray(data) ? data : []
        const existing = lists.find(l => l.candidate_id === candKey)
        if (existing) {
          setActiveCampListId(existing.id)
        } else {
          // Create a default list for this candidate automatically
          const { data: newList } = await createDoorKnockList({
            candidate_id: candKey,
            name: `${candidateConfig[candKey]?.name || 'Campaign'} – Default List`,
          })
          if (newList?.id) setActiveCampListId(newList.id)
        }
      })
      .catch(() => {})
  }, [candKey, candidateConfig]) // eslint-disable-line react-hooks/exhaustive-deps

  // Load real GeoJSON geometry whenever candidate or config changes
  useEffect(() => {
    let mounted = true
    setGeoLoading(true)
    setDistrictGeo(null)
    loadDistrictGeometry(candidateConfig[candKey]).then(geo => {
      if (!mounted) return
      setDistrictGeo(geo)
      const allHouses = geo ? genHousesInRing(candKey, geo.ring) : []
      setHouses(isScout ? allHouses.slice(0, 100) : allHouses)
      setGeoLoading(false)
    }).catch(() => {
      if (mounted) setGeoLoading(false)
    })
    return () => { mounted = false }
  }, [candKey, candidateConfig])

  const handleCandChange = (key) => {
    setCandKey(key)
  }

  return (
    <div className="h-full flex flex-col" style={{ margin:'-32px', height:'calc(100vh - 64px)' }}>
      {/* Page header */}
      <div style={{ background:'#fff', borderBottom:'1px solid #E5E7EB', padding:'0 20px', height:54, display:'flex', alignItems:'center', justifyContent:'space-between', flexShrink:0 }}>
        <div>
          <div style={{ fontSize:15, fontWeight:700 }}>Door Knocking</div>
          <div style={{ fontSize:11, color:'#6B7280', marginTop:1 }}>Turf management, live canvassing, team coordination · Spring General 2026</div>
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:8 }}>
          {/* Offline indicator */}
          {!isOnline && (
            <div style={{ display:'flex', alignItems:'center', gap:5, background:'#fef3c7', border:'1px solid #fcd34d', borderRadius:7, padding:'5px 10px', fontSize:12, fontWeight:600, color:'#92400e' }}>
              <WifiOff size={13}/> Offline
              {pendingKnocksCount > 0 && <span style={{ background:'#f59e0b', color:'#fff', borderRadius:10, padding:'1px 6px', fontSize:10, fontWeight:700 }}>{pendingKnocksCount}</span>}
            </div>
          )}
          {isOnline && pendingKnocksCount > 0 && (
            <button
              type="button"
              onClick={() => syncOfflineKnocks()}
              disabled={syncing}
              style={{ display:'flex', alignItems:'center', gap:5, background:'#eff6ff', border:'1px solid #bfdbfe', borderRadius:7, padding:'5px 10px', fontSize:12, fontWeight:600, color:'#1d4ed8', cursor:syncing?'wait':'pointer' }}
            >
              <RefreshCw size={13} style={{ animation: syncing ? 'spin 1s linear infinite' : 'none' }}/> Sync {pendingKnocksCount}
            </button>
          )}
          {/* Sync result feedback */}
          {syncResult && syncResult.synced > 0 && syncResult.failed === 0 && (
            <div style={{ display:'flex', alignItems:'center', gap:5, background:'#dcfce7', border:'1px solid #86efac', borderRadius:7, padding:'5px 10px', fontSize:11, fontWeight:600, color:'#15803d' }}>
              <CheckCircle size={13}/> {syncResult.synced} synced
            </div>
          )}
          {syncResult && syncResult.failed > 0 && (
            <div style={{ display:'flex', alignItems:'center', gap:5, background:'#fee2e2', border:'1px solid #fca5a5', borderRadius:7, padding:'5px 10px', fontSize:11, fontWeight:600, color:'#b91c1c' }}>
              <AlertTriangle size={13}/> {syncResult.failed} failed to sync
              <button type="button" onClick={() => syncOfflineKnocks()} style={{ fontSize:11, fontWeight:700, color:'#b91c1c', background:'none', border:'none', cursor:'pointer', textDecoration:'underline' }}>Retry</button>
            </div>
          )}
          {syncResult && syncResult.failed === -1 && (
            <div style={{ display:'flex', alignItems:'center', gap:5, background:'#fee2e2', border:'1px solid #fca5a5', borderRadius:7, padding:'5px 10px', fontSize:11, fontWeight:600, color:'#b91c1c' }}>
              <AlertTriangle size={13}/> Sync failed — check connection
              <button type="button" onClick={() => syncOfflineKnocks()} style={{ fontSize:11, fontWeight:700, color:'#b91c1c', background:'none', border:'none', cursor:'pointer', textDecoration:'underline' }}>Retry</button>
            </div>
          )}
          {candidatesLoading ? (
            <div style={{ display:'flex', alignItems:'center', gap:8, fontSize:12, color:'#6B7280' }}>
              <div style={{ width:14, height:14, border:'2px solid #E5E7EB', borderTopColor:'#8B0000', borderRadius:'50%', animation:'spin 0.8s linear infinite' }}/>
              Loading your candidates…
            </div>
          ) : candidateList.length > 0 ? (
            <select
              value={candKey}
              onChange={e => handleCandChange(e.target.value)}
              style={{ padding:'6px 12px', border:'2px solid #E5E7EB', borderRadius:8, fontSize:13, fontWeight:600, outline:'none', background:'#fff', cursor:'pointer', minWidth:240 }}
            >
              {candidateList.map(c => (
                <option key={c.id} value={c.id}>{c.name} — {c.label}</option>
              ))}
            </select>
          ) : (
            <span style={{ fontSize:12, color:'#9CA3AF', fontStyle:'italic' }}>No candidates yet — add one below</span>
          )}
          {candidateList.length > 0 && (
            <div style={{ display:'flex', alignItems:'center', gap:6, background:'#f0fdf4', border:'1px solid #bbf7d0', borderRadius:7, padding:'5px 11px', fontSize:12, fontWeight:600, color:'#15803d' }}>
              <span style={{ width:7, height:7, borderRadius:'50%', background:'#22c55e', display:'inline-block' }}/>
              {candidateList.length} Active
            </div>
          )}
          {candidateList.length > 0 && (
            <button
              type="button"
              onClick={openSurveyModal}
              title="Configure door-knock survey questions for the active candidate"
              style={{ padding:'6px 11px', borderRadius:7, fontSize:12, fontWeight:600, cursor:'pointer', border:'1px solid #bfdbfe', background:'#eff6ff', color:'#1d4ed8', display:'inline-flex', alignItems:'center', gap:5 }}
            >
              <FileText size={13}/> Survey
            </button>
          )}
          {!isScout && (
            <button
              type="button"
              onClick={e => { e.preventDefault(); e.stopPropagation(); openNewCampaign() }}
              style={{ padding:'6px 13px', borderRadius:7, fontSize:12, fontWeight:600, cursor:'pointer', border:'none', background:'#8B0000', color:'#fff', display:'inline-flex', alignItems:'center', gap:5 }}
            >
              <Plus size={13}/> New Campaign
            </button>
          )}
        </div>
      </div>

      {/* Scout lite banner */}
      {isScout && (
        <div style={{ background:'#fffbeb', borderBottom:'1px solid #fcd34d', padding:'8px 20px', display:'flex', alignItems:'center', justifyContent:'space-between', flexShrink:0 }}>
          <span style={{ fontSize:12, fontWeight:600, color:'#92400e' }}>
            Free plan · {houses.length}/100 doors used · Upgrade for unlimited doors, surveys, exports &amp; volunteer management
          </span>
          <a href="/plans" style={{ fontSize:12, fontWeight:700, color:'#8B0000', textDecoration:'none', marginLeft:16 }}>Upgrade →</a>
        </div>
      )}

      {/* Survey Questions Modal */}
      {showSurveyModal && surveyCandidate && (
        <SurveyQuestionsModal
          candidate={surveyCandidate}
          onClose={() => { setShowSurveyModal(false); setSurveyCandidate(null) }}
          onSaved={handleSurveyQuestionsSaved}
        />
      )}

      {/* ── Empty state: no candidates yet ── */}
      {!candidatesLoading && candidateList.length === 0 && (
        <div style={{ flex:1, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', padding:40, textAlign:'center' }}>
          <div style={{ width:64, height:64, borderRadius:'50%', background:'#F3F4F6', display:'flex', alignItems:'center', justifyContent:'center', marginBottom:20 }}>
            <MapPin size={28} style={{ color:'#D1D5DB' }}/>
          </div>
          <h3 style={{ fontSize:18, fontWeight:700, color:'#111827', margin:'0 0 8px' }}>No campaigns yet</h3>
          <p style={{ fontSize:14, color:'#6B7280', maxWidth:400, margin:'0 0 24px', lineHeight:1.5 }}>
            Door knocking is organized around your candidates. Add a candidate to your account first,
            then come back here to set up turf and start canvassing.
          </p>
          <a
            href="/candidates"
            style={{ padding:'10px 22px', borderRadius:8, fontSize:13, fontWeight:700, background:'#8B0000', color:'#fff', textDecoration:'none', display:'inline-flex', alignItems:'center', gap:7 }}
          >
            <Plus size={15}/> Add a Candidate
          </a>
        </div>
      )}

      {/* Sub-tabs + tab content — only visible when at least one candidate is loaded */}
      {candidateList.length > 0 && <><div style={{ background:'#fff', borderBottom:'1px solid #E5E7EB', padding:'0 20px', display:'flex', alignItems:'center', flexShrink:0 }}>
        <div style={{ display:'flex', gap:3, background:'#F4F5F7', padding:3, borderRadius:9, margin:'8px 0', overflowX:'auto' }}>
          {TABS.map(t => (
            <button
              type="button"
              key={t.id}
              onClick={() => setActiveTab(t.id)}
              style={{ padding:'5px 14px', fontSize:12, fontWeight:600, borderRadius:6, cursor:'pointer', border:'none', background: activeTab===t.id ? '#fff' : 'transparent', color: activeTab===t.id ? '#111' : '#6B7280', boxShadow: activeTab===t.id ? '0 1px 3px rgba(0,0,0,.08)' : 'none', transition:'all .15s', display:'flex', alignItems:'center', gap:5, flexShrink:0 }}
            >
              <t.Icon size={13}/> {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Tab content */}
      <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden', minHeight:0 }}>
        {activeTab === 'turf'      && <TurfBuilder candKey={candKey} cfg={candidateConfig[candKey]} houses={houses} districtGeo={districtGeo} geoLoading={geoLoading} listId={activeCampListId}/>}
        {activeTab === 'dash'      && <LiveDashboard listId={activeCampListId}/>}
        {activeTab === 'team'      && <TeamMobile listId={activeCampListId}/>}
        {activeTab === 'queue'     && <FollowUpQueue listId={activeCampListId}/>}
        {activeTab === 'voterfile' && <VoterFileTab listId={activeCampListId}/>}
        {activeTab === 'shifts'    && <ShiftsTab listId={activeCampListId}/>}
        {activeTab === 'messages'   && <MessagesTab listId={activeCampListId} coordinatorName={user?.email || 'Coordinator'}/>}
        {activeTab === 'volunteers' && (
          isScout ? <ScoutUpgradePrompt feature="Volunteer Management" /> : (
            <div style={{ flex:1, overflowY:'auto', padding:'20px' }}>
              <VolunteerManager listId={activeCampListId} session={session?.access_token} />
            </div>
          )
        )}
        {activeTab === 'export'    && (isScout ? <ScoutUpgradePrompt feature="Export" /> : <ExportTab listId={activeCampListId} candidateName={candidateConfig[candKey]?.name || 'Campaign'}/>)}
        {activeTab === 'board'     && <Leaderboard/>}
      </div></>}

      {/* ── New Campaign Modal ──────────────────────────────────────────────── */}
      {showNewCampaign && (
        <div
          onClick={() => setShowNewCampaign(false)}
          style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.45)', zIndex:9999, display:'flex', alignItems:'center', justifyContent:'center' }}
        >
          <div onClick={e => e.stopPropagation()} style={{ background:'#fff', borderRadius:14, padding:28, width:420, maxWidth:'95vw', boxShadow:'0 20px 60px rgba(0,0,0,.25)' }}>
            <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:20 }}>
              <h2 style={{ margin:0, fontSize:16, fontWeight:700, color:'#111827' }}>Add Campaign</h2>
              <button onClick={() => setShowNewCampaign(false)} style={{ background:'none', border:'none', cursor:'pointer', color:'#6B7280', padding:4 }}>
                <X size={18}/>
              </button>
            </div>

            <div style={{ marginBottom:16 }}>
              <label style={{ display:'block', fontSize:12, fontWeight:600, color:'#374151', marginBottom:6 }}>Candidate</label>
              {allDbCandidates.length === 0 ? (
                <p style={{ fontSize:12, color:'#6B7280', margin:0 }}>No candidates found in the database.</p>
              ) : (
                <select
                  value={newCampId}
                  onChange={e => { setNewCampId(e.target.value); setNewCampError('') }}
                  style={{ width:'100%', padding:'8px 10px', border:'1px solid #D1D5DB', borderRadius:8, fontSize:13, outline:'none', background:'#fff' }}
                >
                  <option value="">Select a candidate…</option>
                  {allDbCandidates
                    .filter(c => !candidateList.find(cl => cl.id === c.id))
                    .map(c => (
                      <option key={c.id} value={c.id}>
                        {c.name}{c.office?.name ? ` — ${c.office.name}` : ''}
                      </option>
                    ))
                  }
                </select>
              )}
            </div>

            <div style={{ marginBottom:20 }}>
              <label style={{ display:'block', fontSize:12, fontWeight:600, color:'#374151', marginBottom:6 }}>Campaign Color</label>
              <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                <input
                  type="color"
                  value={newCampColor}
                  onChange={e => setNewCampColor(e.target.value)}
                  style={{ width:36, height:36, border:'1px solid #D1D5DB', borderRadius:6, cursor:'pointer', padding:2 }}
                />
                <span style={{ fontSize:12, color:'#6B7280' }}>Used for map turf shading and pins</span>
              </div>
            </div>

            {newCampError && (
              <p style={{ fontSize:12, color:'#dc2626', margin:'0 0 12px' }}>{newCampError}</p>
            )}

            <div style={{ display:'flex', gap:10, justifyContent:'flex-end' }}>
              <button
                onClick={() => setShowNewCampaign(false)}
                style={{ padding:'8px 18px', borderRadius:8, fontSize:13, fontWeight:600, border:'1px solid #D1D5DB', background:'#fff', cursor:'pointer', color:'#374151' }}
              >
                Cancel
              </button>
              <button
                onClick={handleAddCampaign}
                disabled={!newCampId}
                style={{ padding:'8px 18px', borderRadius:8, fontSize:13, fontWeight:600, border:'none', background: newCampId ? '#8B0000' : '#D1D5DB', color:'#fff', cursor: newCampId ? 'pointer' : 'not-allowed' }}
              >
                Add Campaign
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
