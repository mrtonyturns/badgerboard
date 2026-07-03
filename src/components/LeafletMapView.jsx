import React, { useEffect, useRef, useState } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import {
  WI_CENTROID,
  WI_COUNTY_CENTROIDS,
  WI_CD_CENTROIDS,
  WI_SENATE_CENTROIDS,
  WI_ASSEMBLY_CENTROIDS,
} from '../lib/wiDistricts'

// Alias to the centroid maps — all values computed from the real GeoJSON boundary files
const WI_COUNTY_COORDS  = WI_COUNTY_CENTROIDS
const WI_CD_COORDS      = WI_CD_CENTROIDS
const WI_SENATE_COORDS  = WI_SENATE_CENTROIDS

// Get approximate coords for an office that has no county/city
function getOfficeFallbackCoords(office, index) {
  const jitter = (seed) => {
    const s = (seed * 9301 + 49297) % 233280
    return (s / 233280) * 0.3 - 0.15
  }

  if (office.level === 'federal') {
    if (office.district_number && WI_CD_COORDS[office.district_number]) {
      const c = WI_CD_COORDS[office.district_number]
      return [c[0] + jitter(index), c[1] + jitter(index + 7)]
    }
    // Statewide federal (US Senate) → state centroid
    return [WI_CENTROID[0] + jitter(index) * 0.5, WI_CENTROID[1] + jitter(index + 3) * 0.5]
  }

  if (office.level === 'state') {
    const dn = parseInt(office.district_number)
    if (dn) {
      // Try exact assembly centroid first (real GeoJSON), then senate, then fallback
      const ca = WI_ASSEMBLY_CENTROIDS[dn]
      if (ca) return [ca[0] + jitter(index) * 0.05, ca[1] + jitter(index + 5) * 0.05]
      const cs = WI_SENATE_COORDS[dn]
      if (cs) return [cs[0] + jitter(index) * 0.1, cs[1] + jitter(index + 5) * 0.1]
      // Assembly district without direct centroid: use senate superset
      const senateNum = Math.ceil(dn / 3)
      const cf = WI_SENATE_COORDS[senateNum] || WI_CENTROID
      return [cf[0] + jitter(dn) * 0.15, cf[1] + jitter(dn + 11) * 0.15]
    }
    // Statewide state office (Governor, AG, etc.)
    return [WI_CENTROID[0] + jitter(index) * 0.6, WI_CENTROID[1] + jitter(index + 13) * 0.6]
  }

  if (office.level === 'municipal' || office.level === 'county') {
    // Try county field first (works for county-level and some municipal offices)
    const countyKey = (office.county || '').replace(/ county$/i, '').trim()
    if (countyKey) {
      const c = WI_COUNTY_COORDS[countyKey]
      if (c) return [c[0] + jitter(index) * 0.08, c[1] + jitter(index + 7) * 0.08]
    }
    // Fall back to WI centroid with jitter spread
    return [WI_CENTROID[0] + jitter(index) * 0.7, WI_CENTROID[1] + jitter(index + 17) * 0.7]
  }

  return null
}

const partyColor = (p) => {
  if (p === 'Republican')  return '#dc2626'
  if (p === 'Democrat')    return '#2563eb'
  if (p === 'Independent') return '#7c3aed'
  return '#6b7280'
}

const levelColor = (l) => {
  if (l === 'federal')   return '#1d4ed8'
  if (l === 'state')     return '#dc2626'
  if (l === 'county')    return '#7c3aed'
  if (l === 'municipal') return '#16a34a'
  return '#6b7280'
}

function dotIcon(color) {
  return L.divIcon({
    className: '',
    html: `<div style="width:13px;height:13px;border-radius:50%;background:${color};border:2px solid white;box-shadow:0 1px 4px rgba(0,0,0,0.35)"></div>`,
    iconSize: [13, 13], iconAnchor: [6, 6], popupAnchor: [0, -8],
  })
}

// Count badge — shown when multiple offices share the same geographic centroid
function countBadgeIcon(color, count) {
  const size = count > 99 ? 30 : count > 9 ? 26 : 22
  const fontSize = count > 99 ? 9 : count > 9 ? 10 : 11
  return L.divIcon({
    className: '',
    html: `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${color};border:2.5px solid white;box-shadow:0 1px 6px rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;color:white;font-size:${fontSize}px;font-weight:800;font-family:system-ui,sans-serif">${count}</div>`,
    iconSize: [size, size], iconAnchor: [size / 2, size / 2], popupAnchor: [0, -size / 2 - 2],
  })
}

// Extract bbox centroid [lat, lng] from a GeoJSON geometry
function bboxCentroid(geometry) {
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity
  const processRing = (ring) => ring.forEach(([lng, lat]) => {
    if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat
    if (lng < minLng) minLng = lng; if (lng > maxLng) maxLng = lng
  })
  if (geometry.type === 'Polygon') geometry.coordinates.forEach(processRing)
  else if (geometry.type === 'MultiPolygon') geometry.coordinates.forEach(p => p.forEach(processRing))
  return isFinite(minLat) ? [(minLat + maxLat) / 2, (minLng + maxLng) / 2] : null
}

// ── Bundled GeoJSON — served from /public/geodata/ ───────────────────────────
const DISTRICT_LAYERS = {
  federal: {
    color: '#1d4ed8',
    sources: [{
      url: '/geodata/wi-congressional-simplified.geojson',
      style:      { color: '#1d4ed8', weight: 2,   opacity: 0.85, fillOpacity: 0.15, fillColor: '#1d4ed8' },
      hoverStyle: { fillOpacity: 0.25 },
      selectStyle:{ fillOpacity: 0.52 },
      sublabel: 'Congressional District',
    }],
  },
  state: {
    color: '#dc2626',
    sources: [
      {
        url: '/geodata/wi-state-senate-simplified.geojson',
        style:      { color: '#dc2626', weight: 2,   opacity: 0.8,  fillOpacity: 0.12, fillColor: '#dc2626' },
        hoverStyle: { fillOpacity: 0.25 },
        selectStyle:{ fillOpacity: 0.48 },
        sublabel: 'State Senate District',
      },
      {
        url: '/geodata/wi-state-assembly-simplified.geojson',
        style:      { color: '#dc2626', weight: 1,   opacity: 0.7,  fillOpacity: 0.08, fillColor: '#dc2626', dashArray: '5 4' },
        hoverStyle: { fillOpacity: 0.22, dashArray: null },
        selectStyle:{ fillOpacity: 0.45, dashArray: null },
        sublabel: 'State Assembly District',
      },
    ],
  },
  county: {
    color: '#7c3aed',
    sources: [{
      url: '/geodata/wi-counties-simplified.geojson',
      style:      { color: '#7c3aed', weight: 1.5, opacity: 0.8,  fillOpacity: 0.07, fillColor: '#7c3aed' },
      hoverStyle: { fillOpacity: 0.25 },
      selectStyle:{ fillOpacity: 0.52 },
      sublabel: 'County',
    }],
  },
  municipal: {
    color: '#16a34a',
    sources: [{
      url: '/geodata/wi-municipal-simplified.geojson',
      style:      { color: '#16a34a', weight: 1,   opacity: 0.75, fillOpacity: 0.12, fillColor: '#16a34a' },
      hoverStyle: { fillOpacity: 0.25 },
      selectStyle:{ fillOpacity: 0.50 },
      sublabel: 'Municipality',
    }],
  },
}

// ── Component ─────────────────────────────────────────────────────────────────
export default function LeafletMapView({
  candidates,
  offices,
  activeLayer = '',
  onDistrictClick,   // (info: { name, sublabel, layerKey } | null) => void
}) {
  const containerRef       = useRef(null)
  const mapRef             = useRef(null)
  const markerLayer        = useRef(L.layerGroup())
  const maskLayerRef       = useRef(null)
  const geoLayersRef       = useRef({})
  const geoDataCache       = useRef({})
  const selectedRef        = useRef(null)   // { lyr, geoLayer, source }
  const onClickRef         = useRef(onDistrictClick)
  const citycentroidsRef   = useRef({})     // normalized city name → [lat, lng]
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError]   = useState(null)
  const [layerReloadKey, setLayerReloadKey] = useState(0)

  // Keep callback ref fresh across re-renders
  useEffect(() => { onClickRef.current = onDistrictClick })

  // ── 0. Preload city centroids from municipal GeoJSON ───────────────────────
  // Done once at mount so municipal office dots have accurate coordinates.
  useEffect(() => {
    if (Object.keys(citycentroidsRef.current).length > 0) return
    fetch('/geodata/wi-municipal-simplified.geojson')
      .then(r => r.json())
      .then(data => {
        const centroids = {}
        ;(data.features || []).forEach(f => {
          const rawName = (f.properties?.NAME || f.properties?.name || '')
          if (!rawName) return
          const c = bboxCentroid(f.geometry)
          if (!c) return
          const normName = rawName.replace(/ (city|village|town|township|borough|cdp)$/i, '').trim().toLowerCase()
          centroids[normName] = c
        })
        citycentroidsRef.current = centroids
      })
      .catch(err => console.warn('[LeafletMapView] city centroids load failed:', err))
  }, [])

  // ── 1. Init map ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return

    const map = L.map(containerRef.current, { center: [44.5, -89.5], zoom: 7 })

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 18,
    }).addTo(map)

    markerLayer.current.addTo(map)
    mapRef.current = map

    // Clicking the map background deselects the current district
    map.on('click', () => {
      if (selectedRef.current) {
        const { lyr, geoLayer } = selectedRef.current
        try { geoLayer.resetStyle(lyr) } catch (_) {}
        selectedRef.current = null
        onClickRef.current?.(null)
      }
    })

    requestAnimationFrame(() => requestAnimationFrame(() => map.invalidateSize()))

    // Keep the map sized to its container — handles table→map view toggles and
    // responsive layout changes where the container was hidden or resized.
    const ro = new ResizeObserver(() => {
      try { map.invalidateSize() } catch (_) {}
    })
    ro.observe(containerRef.current)
    map._bbResizeObserver = ro

    // ── Load WI grey mask (always on) ────────────────────────────────────────
    fetch('/geodata/wi-mask.geojson')
      .then(r => r.json())
      .then(data => {
        if (!mapRef.current) return
        const mask = L.geoJSON(data, {
          style: {
            fillColor: '#64748b',
            fillOpacity: 0.28,
            color: '#334155',
            weight: 1.5,
            opacity: 0.6,
          },
          interactive: false,  // clicks pass through to the map / districts below
        })
        mask.addTo(map)
        maskLayerRef.current = mask
        // District GeoJSON layers call bringToBack() when added, so the mask
        // (added here) stays above them. Markers live in markerPane (z-600)
        // which is always above overlayPane (z-400) — no manual reordering needed.
      })
      .catch(err => console.warn('[LeafletMapView] mask load failed:', err))

    return () => {
      try { map._bbResizeObserver?.disconnect() } catch (_) {}
      map.remove()
      mapRef.current = null
    }
  }, [])

  // ── 2. Dot markers ─────────────────────────────────────────────────────────
  useEffect(() => {
    const layer = markerLayer.current
    if (!mapRef.current) return
    layer.clearLayers()

    // ── Candidate dots (party-colored) ──────────────────────────────────────
    ;(candidates || []).forEach((c, i) => {
      let coords = WI_COUNTY_COORDS[c.office?.county]
      if (!coords && c.office) coords = getOfficeFallbackCoords(c.office, i)
      // Fallback: place unresolved candidates at WI centroid with jitter so they
      // still appear on the map rather than being silently dropped.
      if (!coords) {
        const jFn = (seed) => ((seed * 7919 + i * 1237) % 1000 - 500) / 2000
        coords = [WI_CENTROID[0] + jFn(i), WI_CENTROID[1] + jFn(i + 99)]
      }
      L.marker(coords, { icon: dotIcon(partyColor(c.party)) })
        .bindPopup(
          `<b>${c.name}</b>` +
          (c.party        ? `<br><small>${c.party}</small>` : '') +
          (c.office?.name ? `<br><small>${c.office.name}</small>` : '') +
          (c.status       ? `<br><small style="color:#888">${c.status.replace(/_/g,' ')}</small>` : '')
        ).addTo(layer)
    })

    // ── Office dots (level-colored, layer-filtered, count-badged) ─────────
    // Only render dots for the active layer — prevents rendering 2000+ at once.
    // When no layer is selected there's nothing to plot.
    const levelMap = { federal: 'federal', state: 'state', county: 'county', municipal: 'municipal' }
    const targetLevel = levelMap[activeLayer] || null
    const activeDots = targetLevel
      ? (offices || []).filter(o => o.level === targetLevel)
      : []

    if (activeDots.length > 0) {
      // Helper: return un-jittered base coordinate for an office
      const getBaseCoords = (o) => {
        // Municipal offices: use city centroid from preloaded municipal GeoJSON
        if (o.level === 'municipal' && o.city) {
          const cityKey = o.city.replace(/ (city|village|town|township|borough|cdp)$/i, '').trim().toLowerCase()
          const cc = citycentroidsRef.current[cityKey]
          if (cc) return cc
        }
        // County offices: use county centroid
        if (o.county) {
          const normKey = o.county.replace(/ county$/i, '').trim()
          const cc = WI_COUNTY_COORDS[normKey] || WI_COUNTY_COORDS[o.county]
          if (cc) return cc
        }
        // City field as fallback county lookup (some offices store city but not county)
        if (o.city) {
          const normKey = o.city.replace(/ county$/i, '').trim()
          const cc = WI_COUNTY_COORDS[normKey] || WI_COUNTY_COORDS[o.city]
          if (cc) return cc
        }
        // State / federal: use district centroid
        return getOfficeFallbackCoords(o, 0)
      }

      // Group offices by their base centroid (rounded to ~5 km grid)
      // so stacked offices get a single count badge instead of dozens of overlapping dots.
      const groups = new Map() // 'lat,lng' → { coords, count, level, names }
      activeDots.forEach(o => {
        const base = getBaseCoords(o)
        if (!base) return
        const key = `${base[0].toFixed(2)},${base[1].toFixed(2)}`
        if (!groups.has(key)) groups.set(key, { coords: base, count: 0, level: o.level, names: [] })
        const g = groups.get(key)
        g.count++
        if (g.names.length < 5) g.names.push(o.name)
      })

      groups.forEach(({ coords, count, level, names }) => {
        const color = levelColor(level)
        const icon  = count > 1 ? countBadgeIcon(color, count) : dotIcon(color)
        const popup = count === 1
          ? `<b>${names[0]}</b><br><small>${level}</small>`
          : `<b>${count} ${level} offices</b>` +
            (names.length ? `<br><small style="color:#555">${names.slice(0,5).join('<br>')}</small>` : '')
        L.marker(coords, { icon }).bindPopup(popup).addTo(layer)
      })
    }

    // Markers live in Leaflet's markerPane (z-index 600) which is always
    // above overlayPane (z-400) where GeoJSON polygons/masks live.
  }, [candidates, offices, activeLayer])

  // ── 3. District overlay ────────────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    let cancelled = false

    // Clear any active selection before switching layers
    if (selectedRef.current) {
      const { lyr, geoLayer } = selectedRef.current
      try { geoLayer.resetStyle(lyr) } catch (_) {}
      selectedRef.current = null
      onClickRef.current?.(null)
    }

    // Remove all overlay layers
    Object.values(geoLayersRef.current).forEach(lyr => {
      if (map.hasLayer(lyr)) map.removeLayer(lyr)
    })

    if (!activeLayer) return

    const config = DISTRICT_LAYERS[activeLayer]
    if (!config) return

    const addSource = async (source, refKey) => {
      if (geoLayersRef.current[refKey]) {
        if (!cancelled && mapRef.current) {
          geoLayersRef.current[refKey].addTo(mapRef.current)
          geoLayersRef.current[refKey].bringToBack()
          // Keep mask above district fill (mask was added earlier, stays in front)
          maskLayerRef.current?.bringToFront()
        }
        return
      }

      let data = geoDataCache.current[source.url]
      if (!data) {
        const res = await fetch(source.url)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        data = await res.json()
        geoDataCache.current[source.url] = data
      }
      if (cancelled || !mapRef.current) return

      const capturedLayerKey = activeLayer

      const geoLayer = L.geoJSON(data, {
        style: () => ({ ...source.style }),
        onEachFeature(feature, lyr) {
          const name = feature.properties?.NAME || ''
          // Municipal layer extras (regenerated geodata): county + city/town/village type.
          // Towns share names across counties, so county is required for precise matching.
          const county = feature.properties?.COUNTY_NAME || null
          const ctv    = feature.properties?.CTV || null

          lyr.on({
            mouseover(e) {
              if (selectedRef.current?.lyr !== e.target) {
                // Only patch the specific hover properties — never change weight/dash
                e.target.setStyle(source.hoverStyle)
              }
            },
            mouseout(e) {
              if (selectedRef.current?.lyr !== e.target) {
                geoLayer.resetStyle(e.target)
              }
            },
            click(e) {
              L.DomEvent.stopPropagation(e)

              // Deselect previous feature
              if (selectedRef.current) {
                const { lyr: prev, geoLayer: prevGeo } = selectedRef.current
                try { prevGeo.resetStyle(prev) } catch (_) {}
              }

              // Select this feature — only patch fillOpacity, keep border unchanged
              e.target.setStyle(source.selectStyle)
              selectedRef.current = { lyr: e.target, geoLayer, source }

              onClickRef.current?.({
                name,
                sublabel: source.sublabel,
                layerKey: capturedLayerKey,
                county,
                ctv,
                geometry: feature.geometry,
              })
            },
          })

          if (name) {
            const tooltipText = ctv === 'town' && county ? `${name} (${county} Co.)` : name
            lyr.bindTooltip(tooltipText, {
              sticky: true,
              direction: 'top',
              offset: [0, -4],
              className: 'leaflet-district-tooltip',
            })
          }
        },
      })

      geoLayersRef.current[refKey] = geoLayer
      if (!cancelled && mapRef.current) {
        geoLayer.addTo(mapRef.current)
        geoLayer.bringToBack()
        // Keep mask above district fill
        maskLayerRef.current?.bringToFront()
      }
    }

    const loadAll = async () => {
      setLoading(true)
      try {
        for (let i = 0; i < config.sources.length; i++) {
          await addSource(config.sources[i], `${activeLayer}-${i}`)
        }
      } catch (err) {
        console.warn('[LeafletMapView] boundary load failed:', err)
        if (!cancelled) setLoadError('District boundaries failed to load — check your connection and try again.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    setLoadError(null)
    loadAll()
    return () => { cancelled = true }
  }, [activeLayer, layerReloadKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Legend ─────────────────────────────────────────────────────────────────
  const isOfficeMode = !!(offices && offices.length > 0)
  const legend = isOfficeMode
    ? [['Federal','#1d4ed8'],['State','#dc2626'],['County','#7c3aed'],['Municipal','#16a34a']]
    : [['Republican','#dc2626'],['Democrat','#2563eb'],['Independent','#7c3aed'],['Other','#6b7280']]

  return (
    <div style={{ position: 'relative', height: '100%', width: '100%' }}>
      <div ref={containerRef} style={{ height: '100%', width: '100%' }} />

      {loading && (
        <div style={{
          position:'absolute', top:12, right:50, zIndex:1000,
          background:'white', borderRadius:20, padding:'5px 10px',
          boxShadow:'0 1px 6px rgba(0,0,0,0.18)', fontSize:12,
          display:'flex', alignItems:'center', gap:6, pointerEvents:'none',
        }}>
          <div className="animate-spin" style={{ width:12, height:12, border:'2px solid #dc2626', borderTopColor:'transparent', borderRadius:'50%' }} />
          <span style={{ color:'#555' }}>Loading boundaries…</span>
        </div>
      )}

      {loadError && !loading && (
        <div style={{
          position:'absolute', top:12, left:'50%', transform:'translateX(-50%)', zIndex:1100,
          background:'#fef2f2', border:'1px solid #fca5a5', color:'#b91c1c',
          borderRadius:8, padding:'8px 14px', fontSize:12, fontWeight:600,
          display:'flex', alignItems:'center', gap:8, boxShadow:'0 1px 6px rgba(0,0,0,0.12)',
        }}>
          {loadError}
          <button
            type="button"
            onClick={() => { setLoadError(null); setLayerReloadKey(k => k + 1) }}
            style={{ background:'none', border:'none', color:'#b91c1c', fontWeight:700, cursor:'pointer', textDecoration:'underline', fontSize:12 }}
          >
            Retry
          </button>
        </div>
      )}

      <div style={{
        position:'absolute', bottom:24, left:12, zIndex:1000,
        background:'white', borderRadius:8, padding:'8px 12px',
        boxShadow:'0 1px 6px rgba(0,0,0,0.15)', fontSize:12, pointerEvents:'none',
      }}>
        {legend.map(([label, color]) => (
          <div key={label} style={{ display:'flex', alignItems:'center', gap:6, marginBottom:3 }}>
            <div style={{ width:10, height:10, borderRadius:'50%', background:color, flexShrink:0 }} />
            <span style={{ color:'#444' }}>{label}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
