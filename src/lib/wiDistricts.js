// ─── wiDistricts.js ─────────────────────────────────────────────────────────
// Single source of truth for Wisconsin district centroids.
// ALL values computed directly from the GeoJSON boundary files in /public/geodata/
// via Shoelace centroid formula — not hand-approximated.
//
// ── How to update after redistricting ────────────────────────────────────────
// Wisconsin redraws district boundaries every 10 years following the decennial
// U.S. Census.  The next redistricting cycle is expected ~2031.
//
// Steps when new shapefiles are released:
//   1. Download updated shapefiles from the Wisconsin Legislature's GIS page:
//      https://legis.wisconsin.gov/ltsb/gis/
//      or the Wisconsin Legislative Reference Bureau:
//      https://docs.legis.wisconsin.gov/misc/ltsb/gis
//   2. Convert each shapefile to simplified GeoJSON (retaining NAME property):
//      ogr2ogr -f GeoJSON -simplify 0.001 wi-state-assembly-simplified.geojson <shapefile>.shp
//      ogr2ogr -f GeoJSON -simplify 0.001 wi-state-senate-simplified.geojson   <shapefile>.shp
//      ogr2ogr -f GeoJSON -simplify 0.001 wi-congressional-simplified.geojson  <shapefile>.shp
//      ogr2ogr -f GeoJSON -simplify 0.001 wi-counties-simplified.geojson       <shapefile>.shp
//   3. Replace the four files in /public/geodata/ with the new versions.
//   4. Rerun the centroid script to regenerate this file:
//      python3 scripts/compute-centroids.py
//   5. Verify a handful of known centroids (e.g. AD85 should remain near Wausau)
//      and commit both the new GeoJSON files and this updated wiDistricts.js.
//
// No other app code needs to change — LeafletMapView and DoorKnocking both read
// from these files dynamically, so new boundaries take effect immediately.
// ─────────────────────────────────────────────────────────────────────────────
//
// To regenerate now: python3 scripts/compute-centroids.py

// Assembly District centroids (1–99)  [lat, lng]
export const WI_ASSEMBLY_CENTROIDS = {
  1: [44.72484, -87.49348],
  2: [44.283, -87.89645],
  3: [44.07813, -88.1025],
  4: [44.8568, -88.06421],
  5: [44.45756, -88.27903],
  6: [44.84164, -88.57788],
  7: [42.98263, -87.97507],
  8: [43.00961, -87.92319],
  9: [42.99897, -87.95033],
  10: [43.10708, -87.92151],
  11: [43.13187, -87.97888],
  12: [43.1475, -88.03341],
  13: [43.0705, -88.07657],
  14: [43.0119, -88.03378],
  15: [43.06122, -88.19839],
  16: [43.05941, -87.93188],
  17: [43.08607, -87.99674],
  18: [43.05323, -87.97523],
  19: [43.04153, -87.89207],
  20: [42.94365, -87.86892],
  21: [42.89704, -87.90469],
  22: [43.31186, -87.98925],
  23: [43.19794, -87.93573],
  24: [43.16671, -88.12276],
  25: [44.02707, -87.73196],
  26: [43.71376, -87.74866],
  27: [43.795, -88.03728],
  28: [44.98515, -92.32706],
  29: [44.45228, -91.83645],
  30: [44.90699, -92.65346],
  31: [42.62604, -88.64046],
  32: [42.56394, -88.13055],
  33: [42.71037, -88.28723],
  34: [45.86707, -89.51516],
  35: [45.26407, -89.39878],
  36: [45.52046, -88.36009],
  37: [43.56125, -88.71908],
  38: [43.25574, -88.71022],
  39: [43.79401, -89.15208],
  40: [43.41526, -89.72759],
  41: [43.50744, -90.16886],
  42: [43.35377, -89.30997],
  43: [42.77557, -88.85428],
  44: [42.68663, -89.10801],
  45: [42.61569, -89.20606],
  46: [43.01854, -88.98958],
  47: [42.93738, -89.26602],
  48: [43.23153, -89.08681],
  49: [42.98518, -90.81749],
  50: [42.73572, -89.60526],
  51: [42.88037, -90.16776],
  52: [44.28026, -88.40227],
  53: [44.18512, -88.46633],
  54: [44.07031, -88.55572],
  55: [44.08794, -88.66338],
  56: [44.43304, -88.62138],
  57: [44.19384, -89.17587],
  58: [43.36254, -88.16835],
  59: [43.55258, -88.15638],
  60: [43.77826, -88.42557],
  61: [42.95152, -88.02008],
  62: [42.75241, -87.82378],
  63: [42.82722, -87.96255],
  64: [42.62222, -87.88789],
  65: [42.55429, -87.86232],
  66: [42.70857, -87.88248],
  67: [45.31466, -91.85141],
  68: [45.42472, -90.77266],
  69: [44.82665, -90.50067],
  70: [44.1532, -90.6443],
  71: [44.40547, -89.53607],
  72: [44.15065, -90.01348],
  73: [46.64279, -91.33552],
  74: [46.11654, -91.21404],
  75: [45.61326, -92.42648],
  76: [43.10698, -89.35541],
  77: [43.07953, -89.42173],
  78: [43.05492, -89.3158],
  79: [43.0559, -89.48226],
  80: [43.04055, -89.59449],
  81: [43.18997, -89.6065],
  82: [42.99529, -88.26594],
  83: [42.96765, -88.15114],
  84: [42.84231, -88.2096],
  85: [44.95105, -89.57525],
  86: [44.67911, -89.98349],
  87: [44.72169, -89.28637],
  88: [44.43424, -88.03288],
  89: [44.49806, -88.07919],
  90: [44.51254, -87.95219],
  91: [44.77091, -91.14562],
  92: [44.89623, -91.63924],
  93: [44.69154, -91.56912],
  94: [44.04048, -91.21397],
  95: [43.85864, -90.8565],
  96: [43.60693, -90.85701],
  97: [42.97223, -88.50998],
  98: [43.23416, -88.2981],
  99: [43.20341, -88.49739],
}

// State Senate District centroids (1–33)  [lat, lng]
export const WI_SENATE_CENTROIDS = {
  1: [44.44998, -87.74912],
  2: [44.79373, -88.42453],
  3: [42.99377, -87.95605],
  4: [43.13193, -87.98677],
  5: [43.05718, -88.13911],
  6: [43.06709, -87.96954],
  7: [42.92477, -87.89452],
  8: [43.25724, -88.01199],
  9: [43.8583, -87.92984],
  10: [44.64527, -92.04582],
  11: [42.63603, -88.39143],
  12: [45.54675, -88.98525],
  13: [43.63778, -88.97104],
  14: [43.45172, -89.87872],
  15: [42.69506, -89.04876],
  16: [43.05185, -89.08421],
  17: [42.89421, -90.31514],
  18: [44.15602, -88.49142],
  19: [44.23092, -88.97037],
  20: [43.54434, -88.18624],
  21: [42.83324, -87.95227],
  22: [42.64276, -87.88095],
  23: [45.2503, -90.91253],
  24: [44.1855, -90.28852],
  25: [46.11188, -91.46684],
  26: [43.07031, -89.35277],
  27: [43.14447, -89.59808],
  28: [42.88981, -88.20307],
  29: [44.71146, -89.61426],
  30: [44.47409, -88.02095],
  31: [44.7653, -91.41846],
  32: [43.77446, -90.93777],
  33: [43.10272, -88.46137],
}

// Congressional District centroids (1–8)  [lat, lng]
export const WI_CD_CENTROIDS = {
  1: [42.72148, -87.93704],
  2: [42.96748, -89.73814],
  3: [44.05287, -90.90286],
  4: [43.10597, -87.61938],
  5: [43.16588, -88.51339],
  6: [43.78244, -88.28336],
  7: [45.69782, -90.66329],
  8: [44.84705, -87.92679],
}

// County centroids (72 counties)  [lat, lng]
export const WI_COUNTY_CENTROIDS = {
  'Adams': [43.96926, -89.77082],
  'Ashland': [46.70034, -90.565],
  'Barron': [45.42344, -91.84836],
  'Bayfield': [46.63522, -91.18106],
  'Brown': [44.4742, -87.99309],
  'Buffalo': [44.3798, -91.75466],
  'Burnett': [45.86272, -92.36751],
  'Calumet': [44.0817, -88.218],
  'Chippewa': [45.06935, -91.27974],
  'Clark': [44.73572, -90.61208],
  'Columbia': [43.46679, -89.33339],
  'Crawford': [43.2391, -90.93176],
  'Dane': [43.06739, -89.41804],
  'Dodge': [43.41536, -88.7074],
  'Door': [45.0326, -87.02877],
  'Douglas': [46.46427, -91.89927],
  'Dunn': [44.9468, -91.89639],
  'Eau Claire': [44.72661, -91.28597],
  'Florence': [45.8481, -88.3977],
  'Fond du Lac': [43.75353, -88.4886],
  'Forest': [45.6673, -88.77057],
  'Grant': [42.86777, -90.70646],
  'Green': [42.67975, -89.60216],
  'Green Lake': [43.80042, -89.04494],
  'Iowa': [43.00007, -90.1355],
  'Iron': [46.31703, -90.26489],
  'Jackson': [44.31932, -90.80504],
  'Jefferson': [43.02135, -88.77464],
  'Juneau': [43.92432, -90.1139],
  'Kenosha': [42.57845, -87.65356],
  'Kewaunee': [44.50642, -87.30729],
  'La Crosse': [43.90686, -91.11548],
  'Lafayette': [42.66015, -90.13206],
  'Langlade': [45.26253, -89.07203],
  'Lincoln': [45.33744, -89.73439],
  'Manitowoc': [44.11066, -87.51215],
  'Marathon': [44.89855, -89.7591],
  'Marinette': [45.35091, -88.00233],
  'Marquette': [43.81972, -89.39897],
  'Menominee': [45.00426, -88.70965],
  'Milwaukee': [43.01553, -87.58045],
  'Monroe': [43.94572, -90.61795],
  'Oconto': [44.99802, -88.21955],
  'Oneida': [45.70572, -89.52121],
  'Outagamie': [44.41556, -88.46525],
  'Ozaukee': [43.36528, -87.5942],
  'Pepin': [44.58314, -92.00147],
  'Pierce': [44.71966, -92.42244],
  'Polk': [45.46153, -92.44116],
  'Portage': [44.4758, -89.50133],
  'Price': [45.68069, -90.36082],
  'Racine': [42.75092, -87.69487],
  'Richland': [43.3759, -90.42977],
  'Rock': [42.67107, -89.07122],
  'Rusk': [45.47497, -91.1333],
  'Sauk': [43.42621, -89.94844],
  'Sawyer': [45.8795, -91.14445],
  'Shawano': [44.78884, -88.76523],
  'Sheboygan': [43.71922, -87.63545],
  'St. Croix': [45.03339, -92.45282],
  'Taylor': [45.21171, -90.50129],
  'Trempealeau': [44.30409, -91.35866],
  'Vernon': [43.59388, -90.83445],
  'Vilas': [46.05319, -89.51481],
  'Walworth': [42.66776, -88.54157],
  'Washburn': [45.89904, -91.79137],
  'Washington': [43.36888, -88.23041],
  'Waukesha': [43.01868, -88.30329],
  'Waupaca': [44.47084, -88.96535],
  'Waushara': [44.11337, -89.24316],
  'Winnebago': [44.06871, -88.64465],
  'Wood': [44.45497, -90.04187],
}

/**
 * Look up centroid [lat, lng] for any WI district.
 * @param {"assembly"|"senate"|"federal"|"county"} level
 * @param {number|string} identifier  district_number or county name
 * @returns {[number,number]|null}
 */
export function getDistrictCentroid(level, identifier) {
  if (level === "assembly" || (level === "state" && typeof identifier === "number" && identifier >= 1 && identifier <= 99)) {
    const senateNum = Math.ceil(identifier / 3)
    return WI_ASSEMBLY_CENTROIDS[identifier] || WI_SENATE_CENTROIDS[senateNum] || [44.5, -89.5]
  }
  if (level === "senate") return WI_SENATE_CENTROIDS[identifier] || [44.5, -89.5]
  if (level === "federal") return WI_CD_CENTROIDS[identifier] || [44.5, -89.5]
  if (level === "county") return WI_COUNTY_CENTROIDS[identifier] || [44.5, -89.5]
  return [44.5, -89.5]
}

// WI geographic centroid fallback
export const WI_CENTROID = [44.5, -89.5]