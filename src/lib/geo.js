// src/lib/geo.js — lightweight geometry helpers (no dependencies)

/** Ray-casting point-in-ring test. ring = [[lng,lat], ...] */
function inRing(lng, lat, ring) {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if (((yi > lat) !== (yj > lat)) && (lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi)) {
      inside = !inside
    }
  }
  return inside
}

/** True if [lng,lat] falls inside a GeoJSON Polygon or MultiPolygon geometry. */
export function pointInGeometry(lng, lat, geometry) {
  if (!geometry) return false
  const polys = geometry.type === 'Polygon' ? [geometry.coordinates]
    : geometry.type === 'MultiPolygon' ? geometry.coordinates
    : []
  for (const poly of polys) {
    if (!poly.length) continue
    if (inRing(lng, lat, poly[0])) {
      // subtract holes
      let inHole = false
      for (let h = 1; h < poly.length; h++) {
        if (inRing(lng, lat, poly[h])) { inHole = true; break }
      }
      if (!inHole) return true
    }
  }
  return false
}
