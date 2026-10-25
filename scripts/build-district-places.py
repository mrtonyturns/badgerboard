# Generator for public/geodata/wi-district-places.json and wi-municipalities.json.
# Usage: python3 scripts/build-district-places.py public/geodata   (needs: pip install shapely)
import json, re, sys
from shapely.geometry import shape
from shapely.validation import make_valid
from shapely.strtree import STRtree
G = sys.argv[1]  # public/geodata dir
def load(fn, key='NAME'):
    fc = json.load(open(f'{G}/{fn}'))
    return [(f['properties'], make_valid(shape(f['geometry']))) for f in fc['features']]

munis = load('wi-municipal-simplified.geojson')  # raw file is incomplete (608 features, no county)
pop = {}
for r in json.load(open(f'{G}/wi-cousub-pop.json')):
    pop[(r['n'], r['co'])] = r['pop']
SUFFIX = re.compile(r'\s+(city|village|town)$', re.I)
def base(n): return SUFFIX.sub('', n).strip()

# aggregate muni pieces by (full NAME): total area, pop, county pieces
agg = {}
for p, g in munis:
    # towns repeat statewide (dozens of "Union", "Grant", "Hull" towns) — a town is
    # (name, county); cities/villages keep one identity across county lines.
    k = (p['NAME'], p['COUNTY_NAME']) if p['CTV'] == 'town' else (p['NAME'], None)
    a = agg.setdefault(k, {'name': base(p['NAME']), 'ctv': p['CTV'], 'pieces': [], 'area': 0.0, 'pop': 0})
    a['pieces'].append((p['COUNTY_NAME'], g)); a['area'] += g.area
    a['pop'] += pop.get((p['NAME'], p['COUNTY_NAME']), 0)
# home county = county pieces with >= 5% of the muni's area (drops slivers)
for a in agg.values():
    a['counties'] = [c for c, g in sorted(a['pieces'], key=lambda x: -x[1].area) if g.area >= 0.05 * a['area']]

geoms = [g for _, g in munis]; tree = STRtree(geoms)
def places_in(dgeom):
    hits = {}
    for i in tree.query(dgeom):
        p, g = munis[i]
        if not g.intersects(dgeom): continue
        inter = g.intersection(dgeom).area
        if inter <= 0: continue
        full = agg[(p['NAME'], p['COUNTY_NAME']) if p['CTV'] == 'town' else (p['NAME'], None)]
        # muni counts if >=5% of it is inside, or it is >=2% of the district
        if inter >= 0.05 * full['area'] or inter >= 0.02 * dgeom.area:
            hits[id(full)] = full
    names, seen = [], set()
    for full in sorted(hits.values(), key=lambda a: -a['pop']):
        if full['name'] not in seen:
            seen.add(full['name']); names.append(full['name'])
    return names

def counties_in(dgeom, counties):
    out = []
    for name, cg in counties:
        if not cg.intersects(dgeom): continue
        inter = cg.intersection(dgeom).area
        if inter >= 0.002 * cg.area or inter >= 0.02 * dgeom.area:
            out.append((inter, name))
    return [n for _, n in sorted(out, reverse=True)]

counties = [(re.sub(r'\s+County$', '', p['NAME']), g) for p, g in load('wi-counties-raw.geojson')]
result = {}
for fn, prefix in [('wi-state-assembly.geojson','assembly'),('wi-state-senate.geojson','senate'),('wi-congressional.geojson','congress')]:
    for p, g in load(fn):
        n = int(re.search(r'(\d+)', p['NAME']).group(1))
        result[f'{prefix}-{n}'] = {'places': places_in(g), 'counties': counties_in(g, counties)}
for cname, cg in counties:
    result[f'county-{cname}'] = {'places': places_in(cg), 'counties': [cname]}

# City picker list: one entry per (municipality, home county)
munilist = []
for full_name, a in agg.items():
    for c in a['counties']:
        munilist.append({'n': a['name'], 't': a['ctv'], 'c': c, 'p': a['pop']})
# disambiguate same name+county with different type (e.g. Weston village / Weston town)
from collections import Counter
cnt = Counter((m['n'], m['c']) for m in munilist)
top = {}
for m in sorted(munilist, key=lambda m: -m['p']):
    top.setdefault((m['n'], m['c']), m)
for m in munilist:
    # Same name + county with different types (Weston village/town, Superior
    # city/village, Waukesha city/village): the most populous keeps the bare
    # name, the others get their type so every picker key stays unique.
    m['label'] = m['n'] if cnt[(m['n'], m['c'])] == 1 or m is top[(m['n'], m['c'])] else f"{m['n']} ({m['t']})"
munilist.sort(key=lambda m: (-m['p'], m['label']))
json.dump(dict(sorted(result.items())), open(f'{G}/wi-district-places.json','w'), separators=(',',':'))
json.dump(munilist, open(f'{G}/wi-municipalities.json','w'), separators=(',',':'))
empty = [k for k,v in result.items() if not v['places']]
print('areas', len(result), 'empty', empty, 'munis', len(munilist))
for k in ['assembly-8','assembly-79','assembly-87','assembly-89','senate-4','county-Marathon']:
    v = result[k]; print(k, len(v['places']), v['places'][:6], v['counties'])
