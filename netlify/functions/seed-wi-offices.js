// Netlify Function: seed-wi-offices
// Seeds the offices table with comprehensive Wisconsin political offices
// Protected by x-admin-secret header

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const ADMIN_SECRET = process.env.ADMIN_SECRET

// ─── All 72 Wisconsin Counties ───────────────────────────────────────────────

const WI_COUNTIES = [
  'Adams', 'Ashland', 'Barron', 'Bayfield', 'Brown', 'Buffalo', 'Burnett', 'Calumet', 'Chippewa', 'Clark',
  'Columbia', 'Crawford', 'Dane', 'Dodge', 'Door', 'Douglas', 'Dunn', 'Eau Claire', 'Florence', 'Fond du Lac',
  'Forest', 'Grant', 'Green', 'Green Lake', 'Iowa', 'Iron', 'Jackson', 'Jefferson', 'Juneau', 'Kenosha',
  'Kewaunee', 'La Crosse', 'Lafayette', 'Langlade', 'Lincoln', 'Manitowoc', 'Marathon', 'Marinette', 'Marquette',
  'Menominee', 'Milwaukee', 'Monroe', 'Oconto', 'Oneida', 'Outagamie', 'Ozaukee', 'Pepin', 'Pierce', 'Polk',
  'Portage', 'Price', 'Racine', 'Richland', 'Rock', 'Rusk', 'Sauk', 'Sawyer', 'Shawano', 'Sheboygan',
  'St. Croix', 'Taylor', 'Trempealeau', 'Vernon', 'Vilas', 'Walworth', 'Washburn', 'Washington', 'Waukesha',
  'Waupaca', 'Waushara', 'Winnebago', 'Wood',
]

// ─── Circuit Court judge counts per county ────────────────────────────────────
// Buffalo & Pepin share 1 judge; Florence & Forest share 1; Menominee & Shawano share 2.
// Those shared circuits are listed under the first-named county; the second gets 0.

const CIRCUIT_JUDGES = {
  Adams: 2, Ashland: 1, Barron: 3, Bayfield: 1, Brown: 8,
  Buffalo: 1, Burnett: 1, Calumet: 2, Chippewa: 3, Clark: 2,
  Columbia: 3, Crawford: 1, Dane: 23, Dodge: 4, Door: 2,
  Douglas: 2, Dunn: 3, 'Eau Claire': 6, Florence: 1, 'Fond du Lac': 5,
  Forest: 0,   // shared with Florence
  Grant: 2, Green: 2, 'Green Lake': 1, Iowa: 1, Iron: 1,
  Jackson: 2, Jefferson: 4, Juneau: 2, Kenosha: 8, Kewaunee: 1,
  'La Crosse': 5, Lafayette: 1, Langlade: 1, Lincoln: 2, Manitowoc: 4,
  Marathon: 6, Marinette: 2, Marquette: 1, Menominee: 2, Milwaukee: 47,
  Monroe: 3, Oconto: 2, Oneida: 2, Outagamie: 8, Ozaukee: 3,
  Pepin: 0,    // shared with Buffalo
  Pierce: 1, Polk: 2, Portage: 3, Price: 1, Racine: 10,
  Richland: 1, Rock: 8, Rusk: 1, Sauk: 3, Sawyer: 2,
  Shawano: 0,  // shared with Menominee
  Sheboygan: 5, 'St. Croix': 4, Taylor: 1, Trempealeau: 1,
  Vernon: 1, Vilas: 2, Walworth: 4, Washburn: 1, Washington: 4,
  Waukesha: 11, Waupaca: 3, Waushara: 2, Winnebago: 6, Wood: 4,
}

// Shared-circuit display names
const SHARED_CIRCUIT_NAME = {
  Buffalo:   'Buffalo-Pepin',
  Menominee: 'Menominee-Shawano',
  Florence:  'Florence-Forest',
}

// ─── County board supervisor counts (known) ──────────────────────────────────

const COUNTY_BOARD_SIZES = {
  // Large metro counties
  Milwaukee: 18, Dane: 37, Brown: 26, Waukesha: 25, Racine: 21,
  Kenosha: 21, Rock: 29, Outagamie: 26, Winnebago: 36, Marathon: 38,
  Washington: 21, Dodge: 33, 'La Crosse': 29, Sheboygan: 25, Ozaukee: 19,
  'St. Croix': 21, Jefferson: 29, Manitowoc: 25, Portage: 25, Walworth: 25,
  'Fond du Lac': 29, Columbia: 25, 'Eau Claire': 29, Barron: 25, Chippewa: 29,
  Lafayette: 16,
  // Northern / central / remaining counties
  Lincoln: 19, Langlade: 21, Oneida: 21, Vilas: 21, Price: 15,
  Rusk: 23, Taylor: 20, Clark: 29, Wood: 29,
  Adams: 21, Juneau: 21, Monroe: 29, Jackson: 21,
  Trempealeau: 36, Vernon: 29, Crawford: 29, Richland: 20, Sauk: 31,
  Iowa: 25, Grant: 31, Green: 21, 'Green Lake': 20, Marquette: 17,
  Waushara: 23, Waupaca: 27, Shawano: 29, Oconto: 19, Marinette: 29,
  Menominee: 11, Florence: 9, Forest: 15, Ashland: 21, Bayfield: 21,
  Iron: 15, Burnett: 21, Washburn: 21, Sawyer: 21, Polk: 29,
  Dunn: 29, Pierce: 19, Pepin: 15, Buffalo: 20, Douglas: 21,
  Calumet: 21, Kewaunee: 21, Door: 21,
}

// Counties that have an appointed Medical Examiner instead of elected Coroner
const NO_ELECTED_CORONER = new Set(['Milwaukee'])

// ─── Court of Appeals judge counts by district ───────────────────────────────

const COA_DISTRICTS = [
  { district: 'I',   location: 'Milwaukee', judges: 4 },
  { district: 'II',  location: 'Waukesha',  judges: 4 },
  { district: 'III', location: 'Wausau',    judges: 5 },
  { district: 'IV',  location: 'Madison',   judges: 3 },
]

// ─── Build the full office list ───────────────────────────────────────────────

const WI_OFFICES = [

  // ── FEDERAL ──────────────────────────────────────────────────────────────────
  { name: 'U.S. Senate — Wisconsin (Class I)',  level: 'federal', office_type: 'legislative', term_years: 6 },
  { name: 'U.S. Senate — Wisconsin (Class III)', level: 'federal', office_type: 'legislative', term_years: 6 },
  ...Array.from({ length: 8 }, (_, i) => ({
    name: `U.S. House of Representatives — Wisconsin District ${i + 1}`,
    level: 'federal', office_type: 'legislative', district_number: i + 1, term_years: 2,
  })),

  // ── STATE EXECUTIVE ───────────────────────────────────────────────────────────
  { name: 'Governor of Wisconsin',                             level: 'state', office_type: 'executive',      term_years: 4 },
  { name: 'Lieutenant Governor of Wisconsin',                  level: 'state', office_type: 'executive',      term_years: 4 },
  { name: 'Wisconsin Attorney General',                        level: 'state', office_type: 'executive',      term_years: 4 },
  { name: 'Wisconsin Secretary of State',                      level: 'state', office_type: 'executive',      term_years: 4 },
  { name: 'Wisconsin State Treasurer',                         level: 'state', office_type: 'executive',      term_years: 4 },
  { name: 'Wisconsin Superintendent of Public Instruction',    level: 'state', office_type: 'executive',      term_years: 4, nonpartisan: true },

  // ── STATE SENATE (33 districts) ───────────────────────────────────────────────
  ...Array.from({ length: 33 }, (_, i) => ({
    name: `Wisconsin State Senate — District ${i + 1}`,
    level: 'state', office_type: 'legislative', district_number: i + 1, term_years: 4,
  })),

  // ── STATE ASSEMBLY (99 districts) ────────────────────────────────────────────
  ...Array.from({ length: 99 }, (_, i) => ({
    name: `Wisconsin State Assembly — District ${i + 1}`,
    level: 'state', office_type: 'legislative', district_number: i + 1, term_years: 2,
  })),

  // ── WISCONSIN SUPREME COURT (7 seats) ────────────────────────────────────────
  ...Array.from({ length: 7 }, (_, i) => ({
    name: `Wisconsin Supreme Court Justice — Seat ${i + 1}`,
    level: 'state', office_type: 'judicial', term_years: 10, nonpartisan: true,
  })),

  // ── WISCONSIN COURT OF APPEALS (16 judges, 4 districts) ──────────────────────
  ...COA_DISTRICTS.flatMap(({ district, location, judges }) =>
    Array.from({ length: judges }, (_, i) => ({
      name: `Wisconsin Court of Appeals Judge — District ${district}, Position ${i + 1}`,
      level: 'state', office_type: 'judicial',
      district_name: `${district} — ${location}`,
      term_years: 6, nonpartisan: true,
    }))
  ),

  // ── CIRCUIT COURT JUDGES (261 judges across 69 circuits) ─────────────────────
  ...Object.entries(CIRCUIT_JUDGES).flatMap(([county, count]) => {
    if (count === 0) return []
    const circuitName = SHARED_CIRCUIT_NAME[county] ?? county
    return Array.from({ length: count }, (_, i) => ({
      name: `${circuitName} County Circuit Court — Branch ${i + 1}`,
      level: 'state', office_type: 'judicial',
      county,
      term_years: 6, nonpartisan: true,
    }))
  }),

  // ── COUNTY EXECUTIVE / COUNTY ADMINISTRATORS ──────────────────────────────────
  // Counties with elected county executives (not all counties have this position)
  ...[
    'Milwaukee', 'Dane', 'Waukesha', 'Marathon', 'Racine', 'Kenosha',
  ].map(county => ({
    name: `${county} County Executive`,
    level: 'county', office_type: 'executive', county, term_years: 4,
  })),

  // ── COUNTY BOARD SUPERVISORS ──────────────────────────────────────────────────
  ...Object.entries(COUNTY_BOARD_SIZES).flatMap(([county, seats]) =>
    Array.from({ length: seats }, (_, i) => ({
      name: `${county} County Board Supervisor — District ${i + 1}`,
      level: 'county', office_type: 'legislative', county,
      district_number: i + 1, term_years: 2,
    }))
  ),

  // ── CONSTITUTIONAL COUNTY OFFICERS (all 72 counties) ─────────────────────────
  // Sheriff, District Attorney, County Clerk, County Treasurer,
  // Register of Deeds, Clerk of Circuit Court, Register in Probate, Coroner
  ...WI_COUNTIES.flatMap(county => [
    { name: `${county} County Sheriff`,               level: 'county', office_type: 'executive',      county, term_years: 4 },
    { name: `${county} County District Attorney`,     level: 'county', office_type: 'executive',      county, term_years: 4 },
    { name: `${county} County Clerk`,                 level: 'county', office_type: 'administrative', county, term_years: 4 },
    { name: `${county} County Treasurer`,             level: 'county', office_type: 'administrative', county, term_years: 4 },
    { name: `${county} County Register of Deeds`,     level: 'county', office_type: 'administrative', county, term_years: 4 },
    { name: `${county} County Clerk of Circuit Court`,level: 'county', office_type: 'judicial',       county, term_years: 4 },
    { name: `${county} County Register in Probate`,   level: 'county', office_type: 'judicial',       county, term_years: 4 },
    ...(NO_ELECTED_CORONER.has(county) ? [] : [
      { name: `${county} County Coroner`, level: 'county', office_type: 'administrative', county, term_years: 4 },
    ]),
  ]),

  // ── MUNICIPAL — CITY OF MILWAUKEE ────────────────────────────────────────────
  { name: 'City of Milwaukee Mayor',          level: 'municipal', office_type: 'executive',      city: 'Milwaukee', term_years: 4 },
  { name: 'City of Milwaukee City Attorney',  level: 'municipal', office_type: 'administrative', city: 'Milwaukee', term_years: 4 },
  ...Array.from({ length: 15 }, (_, i) => ({
    name: `City of Milwaukee Common Council — District ${i + 1}`,
    level: 'municipal', office_type: 'legislative', city: 'Milwaukee',
    district_number: i + 1, term_years: 4,
  })),
  ...Array.from({ length: 9 }, (_, i) => ({
    name: `Milwaukee Public Schools Board — Seat ${i + 1}`,
    level: 'municipal', office_type: 'administrative', city: 'Milwaukee',
    term_years: 3, nonpartisan: true, notes: 'Nonpartisan school board',
  })),

  // ── MUNICIPAL — CITY OF MADISON ──────────────────────────────────────────────
  { name: 'City of Madison Mayor',  level: 'municipal', office_type: 'executive', city: 'Madison', term_years: 4 },
  ...Array.from({ length: 20 }, (_, i) => ({
    name: `City of Madison Common Council — District ${i + 1}`,
    level: 'municipal', office_type: 'legislative', city: 'Madison',
    district_number: i + 1, term_years: 2,
  })),
  ...Array.from({ length: 7 }, (_, i) => ({
    name: `Madison Metropolitan School District Board — Seat ${i + 1}`,
    level: 'municipal', office_type: 'administrative', city: 'Madison',
    term_years: 3, nonpartisan: true, notes: 'Nonpartisan school board',
  })),

  // ── MUNICIPAL — CITY OF GREEN BAY ────────────────────────────────────────────
  { name: 'City of Green Bay Mayor', level: 'municipal', office_type: 'executive', city: 'Green Bay', term_years: 4 },
  ...Array.from({ length: 12 }, (_, i) => ({
    name: `City of Green Bay Common Council — District ${i + 1}`,
    level: 'municipal', office_type: 'legislative', city: 'Green Bay',
    district_number: i + 1, term_years: 2,
  })),
  ...Array.from({ length: 7 }, (_, i) => ({
    name: `Green Bay Area Public School District Board — Seat ${i + 1}`,
    level: 'municipal', office_type: 'administrative', city: 'Green Bay',
    term_years: 3, nonpartisan: true, notes: 'Nonpartisan school board',
  })),

  // ── MUNICIPAL — CITY OF KENOSHA ───────────────────────────────────────────────
  { name: 'City of Kenosha Mayor', level: 'municipal', office_type: 'executive', city: 'Kenosha', term_years: 4 },
  ...Array.from({ length: 17 }, (_, i) => ({
    name: `City of Kenosha Common Council — District ${i + 1}`,
    level: 'municipal', office_type: 'legislative', city: 'Kenosha',
    district_number: i + 1, term_years: 2,
  })),
  ...Array.from({ length: 9 }, (_, i) => ({
    name: `Kenosha Unified School District Board — Seat ${i + 1}`,
    level: 'municipal', office_type: 'administrative', city: 'Kenosha',
    term_years: 3, nonpartisan: true, notes: 'Nonpartisan school board',
  })),

  // ── MUNICIPAL — CITY OF RACINE ────────────────────────────────────────────────
  { name: 'City of Racine Mayor', level: 'municipal', office_type: 'executive', city: 'Racine', term_years: 4 },
  ...Array.from({ length: 15 }, (_, i) => ({
    name: `City of Racine Common Council — District ${i + 1}`,
    level: 'municipal', office_type: 'legislative', city: 'Racine',
    district_number: i + 1, term_years: 2,
  })),
  ...Array.from({ length: 9 }, (_, i) => ({
    name: `Racine Unified School District Board — Seat ${i + 1}`,
    level: 'municipal', office_type: 'administrative', city: 'Racine',
    term_years: 3, nonpartisan: true, notes: 'Nonpartisan school board',
  })),

  // ── MUNICIPAL — CITY OF APPLETON ──────────────────────────────────────────────
  { name: 'City of Appleton Mayor', level: 'municipal', office_type: 'executive', city: 'Appleton', term_years: 4 },
  ...Array.from({ length: 15 }, (_, i) => ({
    name: `City of Appleton Common Council — District ${i + 1}`,
    level: 'municipal', office_type: 'legislative', city: 'Appleton',
    district_number: i + 1, term_years: 2,
  })),
  ...Array.from({ length: 7 }, (_, i) => ({
    name: `Appleton Area School District Board — Seat ${i + 1}`,
    level: 'municipal', office_type: 'administrative', city: 'Appleton',
    term_years: 3, nonpartisan: true, notes: 'Nonpartisan school board',
  })),

  // ── MUNICIPAL — CITY OF WAUKESHA ──────────────────────────────────────────────
  { name: 'City of Waukesha Mayor', level: 'municipal', office_type: 'executive', city: 'Waukesha', term_years: 4 },
  ...Array.from({ length: 14 }, (_, i) => ({
    name: `City of Waukesha Common Council — District ${i + 1}`,
    level: 'municipal', office_type: 'legislative', city: 'Waukesha',
    district_number: i + 1, term_years: 2,
  })),

  // ── MUNICIPAL — CITY OF OSHKOSH ───────────────────────────────────────────────
  { name: 'City of Oshkosh Mayor', level: 'municipal', office_type: 'executive', city: 'Oshkosh', term_years: 4 },
  ...Array.from({ length: 6 }, (_, i) => ({
    name: `City of Oshkosh Common Council — District ${i + 1}`,
    level: 'municipal', office_type: 'legislative', city: 'Oshkosh',
    district_number: i + 1, term_years: 2,
  })),

  // ── MUNICIPAL — CITY OF LA CROSSE ─────────────────────────────────────────────
  { name: 'City of La Crosse Mayor', level: 'municipal', office_type: 'executive', city: 'La Crosse', term_years: 4 },
  ...Array.from({ length: 12 }, (_, i) => ({
    name: `City of La Crosse Common Council — District ${i + 1}`,
    level: 'municipal', office_type: 'legislative', city: 'La Crosse',
    district_number: i + 1, term_years: 2,
  })),
  ...Array.from({ length: 7 }, (_, i) => ({
    name: `La Crosse School District Board — Seat ${i + 1}`,
    level: 'municipal', office_type: 'administrative', city: 'La Crosse',
    term_years: 3, nonpartisan: true, notes: 'Nonpartisan school board',
  })),

  // ── MUNICIPAL — CITY OF EAU CLAIRE ───────────────────────────────────────────
  { name: 'City of Eau Claire Mayor', level: 'municipal', office_type: 'executive', city: 'Eau Claire', term_years: 4 },
  ...Array.from({ length: 5 }, (_, i) => ({
    name: `City of Eau Claire Common Council — District ${i + 1}`,
    level: 'municipal', office_type: 'legislative', city: 'Eau Claire',
    district_number: i + 1, term_years: 2,
  })),
  ...Array.from({ length: 7 }, (_, i) => ({
    name: `Eau Claire Area School District Board — Seat ${i + 1}`,
    level: 'municipal', office_type: 'administrative', city: 'Eau Claire',
    term_years: 3, nonpartisan: true, notes: 'Nonpartisan school board',
  })),

  // ── MUNICIPAL — CITY OF JANESVILLE ───────────────────────────────────────────
  { name: 'City of Janesville Mayor',        level: 'municipal', office_type: 'executive',      city: 'Janesville', term_years: 4 },
  { name: 'City of Janesville City Clerk',   level: 'municipal', office_type: 'administrative', city: 'Janesville', term_years: 4 },
  ...Array.from({ length: 7 }, (_, i) => ({
    name: `City of Janesville City Council — District ${i + 1}`,
    level: 'municipal', office_type: 'legislative', city: 'Janesville',
    district_number: i + 1, term_years: 2,
  })),
  ...Array.from({ length: 7 }, (_, i) => ({
    name: `Janesville School District Board — Seat ${i + 1}`,
    level: 'municipal', office_type: 'administrative', city: 'Janesville',
    term_years: 3, nonpartisan: true, notes: 'Nonpartisan school board',
  })),

  // ── MUNICIPAL — CITY OF SHEBOYGAN ─────────────────────────────────────────────
  { name: 'City of Sheboygan Mayor', level: 'municipal', office_type: 'executive', city: 'Sheboygan', term_years: 4 },
  ...Array.from({ length: 6 }, (_, i) => ({
    name: `City of Sheboygan Common Council — District ${i + 1}`,
    level: 'municipal', office_type: 'legislative', city: 'Sheboygan',
    district_number: i + 1, term_years: 2,
  })),

  // ── MUNICIPAL — CITY OF WAUSAU ────────────────────────────────────────────────
  { name: 'City of Wausau Mayor',       level: 'municipal', office_type: 'executive',      city: 'Wausau', term_years: 4 },
  { name: 'City of Wausau City Clerk',  level: 'municipal', office_type: 'administrative', city: 'Wausau', term_years: 4 },
  { name: 'City of Wausau City Attorney', level: 'municipal', office_type: 'administrative', city: 'Wausau', term_years: 4 },
  ...Array.from({ length: 9 }, (_, i) => ({
    name: `City of Wausau Common Council — District ${i + 1}`,
    level: 'municipal', office_type: 'legislative', city: 'Wausau',
    district_number: i + 1, term_years: 2,
  })),
  ...Array.from({ length: 5 }, (_, i) => ({
    name: `Wausau School District Board — Seat ${i + 1}`,
    level: 'municipal', office_type: 'administrative', city: 'Wausau',
    term_years: 3, nonpartisan: true, notes: 'Nonpartisan school board',
  })),

  // ── MUNICIPAL — CITY OF BELOIT ────────────────────────────────────────────────
  { name: 'City of Beloit Mayor', level: 'municipal', office_type: 'executive', city: 'Beloit', term_years: 4 },
  ...Array.from({ length: 7 }, (_, i) => ({
    name: `City of Beloit City Council — District ${i + 1}`,
    level: 'municipal', office_type: 'legislative', city: 'Beloit',
    district_number: i + 1, term_years: 2,
  })),

  // ── MUNICIPAL — CITY OF WAUWATOSA ─────────────────────────────────────────────
  { name: 'City of Wauwatosa Mayor', level: 'municipal', office_type: 'executive', city: 'Wauwatosa', term_years: 4 },
  ...Array.from({ length: 16 }, (_, i) => ({
    name: `City of Wauwatosa Common Council — District ${i + 1}`,
    level: 'municipal', office_type: 'legislative', city: 'Wauwatosa',
    district_number: i + 1, term_years: 2,
  })),

  // ── MUNICIPAL — CITY OF WEST ALLIS ───────────────────────────────────────────
  { name: 'City of West Allis Mayor', level: 'municipal', office_type: 'executive', city: 'West Allis', term_years: 4 },
  ...Array.from({ length: 8 }, (_, i) => ({
    name: `City of West Allis Common Council — District ${i + 1}`,
    level: 'municipal', office_type: 'legislative', city: 'West Allis',
    district_number: i + 1, term_years: 2,
  })),

  // ── MUNICIPAL — CITY OF FOND DU LAC ──────────────────────────────────────────
  { name: 'City of Fond du Lac Mayor', level: 'municipal', office_type: 'executive', city: 'Fond du Lac', term_years: 4 },
  ...Array.from({ length: 9 }, (_, i) => ({
    name: `City of Fond du Lac Common Council — District ${i + 1}`,
    level: 'municipal', office_type: 'legislative', city: 'Fond du Lac',
    district_number: i + 1, term_years: 2,
  })),

  // ── MUNICIPAL — CITY OF SUPERIOR ─────────────────────────────────────────────
  { name: 'City of Superior Mayor', level: 'municipal', office_type: 'executive', city: 'Superior', term_years: 4 },
  ...Array.from({ length: 10 }, (_, i) => ({
    name: `City of Superior Common Council — District ${i + 1}`,
    level: 'municipal', office_type: 'legislative', city: 'Superior',
    district_number: i + 1, term_years: 2,
  })),

  // ── MUNICIPAL — CITY OF BROOKFIELD ───────────────────────────────────────────
  { name: 'City of Brookfield Mayor', level: 'municipal', office_type: 'executive', city: 'Brookfield', term_years: 4 },
  ...Array.from({ length: 8 }, (_, i) => ({
    name: `City of Brookfield Common Council — District ${i + 1}`,
    level: 'municipal', office_type: 'legislative', city: 'Brookfield',
    district_number: i + 1, term_years: 2,
  })),

  // ── MUNICIPAL — CITY OF NEW BERLIN ───────────────────────────────────────────
  { name: 'City of New Berlin Mayor', level: 'municipal', office_type: 'executive', city: 'New Berlin', term_years: 4 },
  ...Array.from({ length: 7 }, (_, i) => ({
    name: `City of New Berlin Common Council — District ${i + 1}`,
    level: 'municipal', office_type: 'legislative', city: 'New Berlin',
    district_number: i + 1, term_years: 2,
  })),

  // ── MUNICIPAL — CITY OF FITCHBURG ─────────────────────────────────────────────
  { name: 'City of Fitchburg Mayor', level: 'municipal', office_type: 'executive', city: 'Fitchburg', term_years: 4 },
  ...Array.from({ length: 6 }, (_, i) => ({
    name: `City of Fitchburg Common Council — District ${i + 1}`,
    level: 'municipal', office_type: 'legislative', city: 'Fitchburg',
    district_number: i + 1, term_years: 2,
  })),

  // ── MUNICIPAL — CITY OF WESTON (Village) ─────────────────────────────────────
  { name: 'Village of Weston President', level: 'municipal', office_type: 'executive', city: 'Weston', term_years: 2 },
  ...Array.from({ length: 6 }, (_, i) => ({
    name: `Village of Weston Board Trustee — Seat ${i + 1}`,
    level: 'municipal', office_type: 'legislative', city: 'Weston',
    term_years: 2,
  })),

  // ── MUNICIPAL — CITY OF SUN PRAIRIE ──────────────────────────────────────────
  { name: 'City of Sun Prairie Mayor', level: 'municipal', office_type: 'executive', city: 'Sun Prairie', term_years: 4 },
  ...Array.from({ length: 8 }, (_, i) => ({
    name: `City of Sun Prairie Common Council — District ${i + 1}`,
    level: 'municipal', office_type: 'legislative', city: 'Sun Prairie',
    district_number: i + 1, term_years: 2,
  })),

  // ── MUNICIPAL — CITY OF MANITOWOC ─────────────────────────────────────────────
  { name: 'City of Manitowoc Mayor', level: 'municipal', office_type: 'executive', city: 'Manitowoc', term_years: 4 },
  ...Array.from({ length: 8 }, (_, i) => ({
    name: `City of Manitowoc Common Council — District ${i + 1}`,
    level: 'municipal', office_type: 'legislative', city: 'Manitowoc',
    district_number: i + 1, term_years: 2,
  })),

  // ── MUNICIPAL — CITY OF STEVENS POINT ────────────────────────────────────────
  { name: 'City of Stevens Point Mayor', level: 'municipal', office_type: 'executive', city: 'Stevens Point', term_years: 4 },
  ...Array.from({ length: 10 }, (_, i) => ({
    name: `City of Stevens Point Common Council — District ${i + 1}`,
    level: 'municipal', office_type: 'legislative', city: 'Stevens Point',
    district_number: i + 1, term_years: 2,
  })),

  // ── MUNICIPAL — CITY OF RHINELANDER ──────────────────────────────────────────
  { name: 'City of Rhinelander Mayor', level: 'municipal', office_type: 'executive', city: 'Rhinelander', term_years: 4 },
  ...Array.from({ length: 7 }, (_, i) => ({
    name: `City of Rhinelander Common Council — District ${i + 1}`,
    level: 'municipal', office_type: 'legislative', city: 'Rhinelander',
    district_number: i + 1, term_years: 2,
  })),

  // ── MUNICIPAL — CITY OF MARSHFIELD ───────────────────────────────────────────
  { name: 'City of Marshfield Mayor', level: 'municipal', office_type: 'executive', city: 'Marshfield', term_years: 4 },
  ...Array.from({ length: 8 }, (_, i) => ({
    name: `City of Marshfield Common Council — District ${i + 1}`,
    level: 'municipal', office_type: 'legislative', city: 'Marshfield',
    district_number: i + 1, term_years: 2,
  })),

  // ── MUNICIPAL — CITY OF WISCONSIN RAPIDS ─────────────────────────────────────
  { name: 'City of Wisconsin Rapids Mayor', level: 'municipal', office_type: 'executive', city: 'Wisconsin Rapids', term_years: 4 },
  ...Array.from({ length: 10 }, (_, i) => ({
    name: `City of Wisconsin Rapids Common Council — District ${i + 1}`,
    level: 'municipal', office_type: 'legislative', city: 'Wisconsin Rapids',
    district_number: i + 1, term_years: 2,
  })),

  // ── MUNICIPAL — VILLAGE OF KRONENWETTER (Marathon County) ────────────────────
  { name: 'Village of Kronenwetter President', level: 'municipal', office_type: 'executive', city: 'Kronenwetter', county: 'Marathon', term_years: 2 },
  { name: 'Village of Kronenwetter Clerk', level: 'municipal', office_type: 'administrative', city: 'Kronenwetter', county: 'Marathon', term_years: 2 },
  { name: 'Village of Kronenwetter Treasurer', level: 'municipal', office_type: 'administrative', city: 'Kronenwetter', county: 'Marathon', term_years: 2 },
  ...Array.from({ length: 6 }, (_, i) => ({
    name: `Village of Kronenwetter Trustee — Seat ${i + 1}`,
    level: 'municipal', office_type: 'legislative', city: 'Kronenwetter', county: 'Marathon', term_years: 2,
  })),

  // ── MUNICIPAL — VILLAGE OF PLOVER (Portage County) ───────────────────────────
  { name: 'Village of Plover President', level: 'municipal', office_type: 'executive', city: 'Plover', county: 'Portage', term_years: 2 },
  ...Array.from({ length: 6 }, (_, i) => ({
    name: `Village of Plover Trustee — Seat ${i + 1}`,
    level: 'municipal', office_type: 'legislative', city: 'Plover', county: 'Portage', term_years: 2,
  })),

  // ── MUNICIPAL — VILLAGE OF ROTHSCHILD (Marathon County) ──────────────────────
  { name: 'Village of Rothschild President', level: 'municipal', office_type: 'executive', city: 'Rothschild', county: 'Marathon', term_years: 2 },
  ...Array.from({ length: 6 }, (_, i) => ({
    name: `Village of Rothschild Trustee — Seat ${i + 1}`,
    level: 'municipal', office_type: 'legislative', city: 'Rothschild', county: 'Marathon', term_years: 2,
  })),

  // ── MUNICIPAL — VILLAGE OF EDGAR (Marathon County) ───────────────────────────
  { name: 'Village of Edgar President', level: 'municipal', office_type: 'executive', city: 'Edgar', county: 'Marathon', term_years: 2 },
  ...Array.from({ length: 6 }, (_, i) => ({
    name: `Village of Edgar Trustee — Seat ${i + 1}`,
    level: 'municipal', office_type: 'legislative', city: 'Edgar', county: 'Marathon', term_years: 2,
  })),

  // ── MUNICIPAL — VILLAGE OF SCHOFIELD (Marathon County) ───────────────────────
  { name: 'City of Schofield Mayor', level: 'municipal', office_type: 'executive', city: 'Schofield', county: 'Marathon', term_years: 4 },
  ...Array.from({ length: 6 }, (_, i) => ({
    name: `City of Schofield Common Council — Seat ${i + 1}`,
    level: 'municipal', office_type: 'legislative', city: 'Schofield', county: 'Marathon', term_years: 2,
  })),

  // ── MUNICIPAL — VILLAGE OF MERRILL (Lincoln County) ──────────────────────────
  { name: 'City of Merrill Mayor', level: 'municipal', office_type: 'executive', city: 'Merrill', county: 'Lincoln', term_years: 4 },
  ...Array.from({ length: 8 }, (_, i) => ({
    name: `City of Merrill Common Council — District ${i + 1}`,
    level: 'municipal', office_type: 'legislative', city: 'Merrill', county: 'Lincoln', district_number: i + 1, term_years: 2,
  })),

  // ── MUNICIPAL — CITY OF TOMAHAWK (Lincoln County) ────────────────────────────
  { name: 'City of Tomahawk Mayor', level: 'municipal', office_type: 'executive', city: 'Tomahawk', county: 'Lincoln', term_years: 4 },
  ...Array.from({ length: 6 }, (_, i) => ({
    name: `City of Tomahawk Common Council — District ${i + 1}`,
    level: 'municipal', office_type: 'legislative', city: 'Tomahawk', county: 'Lincoln', district_number: i + 1, term_years: 2,
  })),

]

// ─── Deduplicate by name ──────────────────────────────────────────────────────

const UNIQUE_OFFICES = Array.from(
  new Map(WI_OFFICES.map(o => [o.name, o])).values()
)

// ─── Handler ──────────────────────────────────────────────────────────────────


// Constant-time secret comparison (L2): hash both sides to equal length, then
// crypto.timingSafeEqual — a plain !== comparison leaks timing information.
const nodeCrypto = require('crypto')
function safeEqual(a, b) {
  const A = nodeCrypto.createHash('sha256').update(String(a ?? '')).digest()
  const B = nodeCrypto.createHash('sha256').update(String(b ?? '')).digest()
  return nodeCrypto.timingSafeEqual(A, B)
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, x-admin-secret',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  }

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) }
  }

  const adminSecret = event.headers['x-admin-secret']
  if (!adminSecret || !safeEqual(adminSecret, ADMIN_SECRET)) {
    return { statusCode: 403, headers, body: JSON.stringify({ error: 'Unauthorized' }) }
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Missing Supabase credentials' }) }
  }

  let body
  try { body = JSON.parse(event.body || '{}') }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) } }

  if (!body.confirm) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({
        error: 'Missing confirm: true',
        total_offices: UNIQUE_OFFICES.length,
        breakdown: {
          federal: UNIQUE_OFFICES.filter(o => o.level === 'federal').length,
          state:   UNIQUE_OFFICES.filter(o => o.level === 'state').length,
          county:  UNIQUE_OFFICES.filter(o => o.level === 'county').length,
          municipal: UNIQUE_OFFICES.filter(o => o.level === 'municipal').length,
        },
      }),
    }
  }

  try {
    let totalInserted = 0
    const BATCH = 200

    for (let i = 0; i < UNIQUE_OFFICES.length; i += BATCH) {
      const batch = UNIQUE_OFFICES.slice(i, i + BATCH).map(o => ({
        name:            o.name,
        level:           o.level,
        office_type:     o.office_type     || null,
        district_number: o.district_number || null,
        district_name:   o.district_name   || null,
        county:          o.county          || null,
        city:            o.city            || null,
        term_years:      o.term_years      || null,
        notes:           o.notes           || null,
        // nonpartisan not in schema — stored in notes field above
      }))

      const res = await fetch(`${SUPABASE_URL}/rest/v1/offices`, {
        method: 'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          'apikey':        SUPABASE_SERVICE_ROLE_KEY,
          'Prefer':        'resolution=ignore-duplicates',
        },
        body: JSON.stringify(batch),
      })

      if (!res.ok) {
        const err = await res.text()
        console.error(`Batch ${Math.floor(i / BATCH) + 1} failed:`, err)
        throw new Error(`Batch ${Math.floor(i / BATCH) + 1}: ${err}`)
      }

      const result = await res.json()
      totalInserted += Array.isArray(result) ? result.length : 0
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        message: `Seeded ${totalInserted} new offices (${UNIQUE_OFFICES.length} total prepared, duplicates ignored)`,
        breakdown: {
          federal:   UNIQUE_OFFICES.filter(o => o.level === 'federal').length,
          state:     UNIQUE_OFFICES.filter(o => o.level === 'state').length,
          county:    UNIQUE_OFFICES.filter(o => o.level === 'county').length,
          municipal: UNIQUE_OFFICES.filter(o => o.level === 'municipal').length,
        },
      }),
    }
  } catch (err) {
    console.error('Seed error:', err)
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'An internal error occurred' || 'Seeding failed' }) }
  }
}
