#!/usr/bin/env python3
"""Build map context from official Calgary and NRCan geometry.

python3 scripts/build-geographic-context.py --source-dir /tmp/calgary-context --download
Raw source responses remain outside the repository. Re-run without --download to
reproduce a saved snapshot. Data maintenance requires Shapely 2.x for topology-
preserving display simplification; the website itself has no Python dependency.
"""

import argparse
import collections
import datetime
import hashlib
import json
import math
from pathlib import Path
import urllib.parse
import urllib.request
from shapely import affinity
from shapely.geometry import shape, mapping, Point

ROOT = Path(__file__).resolve().parents[1]
CALGARY_LICENSE = 'https://data.calgary.ca/d/Open-Data-Terms/u45n-7awa'
CANADA_LICENSE = 'https://open.canada.ca/en/open-government-licence-canada'
RAIL_SOURCE = 'https://data.calgary.ca/Transportation-Transit/Tracks-Non-LRT/cq6k-mmku'
PARK_SOURCE = 'https://data.calgary.ca/Recreation-and-Culture/Parks-Sites/kami-qbfh'
RESERVE_SOURCE = 'https://open.canada.ca/data/en/dataset/522b07b9-78e2-4819-b736-ad9208eb1067'
RESERVE_SERVICE = 'https://proxyinternet.nrcan-rncan.gc.ca/arcgis/rest/services/CLSS-SATC/CLSS_Administrative_Boundaries/MapServer/0'
BOUNDARY_SOURCE = 'https://data.calgary.ca/Base-Maps/Community-District-Boundaries/surr-xmvs'
QUERY_BOUNDS = [-114.5, 50.8, -113.8, 51.3]
URLS = {
    'rails.json': 'https://data.calgary.ca/resource/cq6k-mmku.geojson?' + urllib.parse.urlencode({'$limit': 50000, '$where': "rail_type = 'RAIL'"}),
    'parks.json': 'https://data.calgary.ca/resource/kami-qbfh.geojson?' + urllib.parse.urlencode({'$limit': 50000}),
    'reserves.json': RESERVE_SERVICE + '/query?' + urllib.parse.urlencode({'f': 'geojson', 'where': '1=1', 'geometry': ','.join(map(str, QUERY_BOUNDS)), 'geometryType': 'esriGeometryEnvelope', 'inSR': 4326, 'outSR': 4326, 'outFields': '*', 'returnGeometry': 'true'}),
    'rail-metadata.json': 'https://data.calgary.ca/api/views/cq6k-mmku.json',
    'park-metadata.json': 'https://data.calgary.ca/api/views/kami-qbfh.json',
}


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def ring_area(ring):
    x0, y0 = ring[0]
    return sum((a[0] - x0) * (b[1] - y0) - (b[0] - x0) * (a[1] - y0)
               for a, b in zip(ring, ring[1:])) / 2


def polygons(geometry):
    return geometry['coordinates'] if geometry['type'] == 'MultiPolygon' else [geometry['coordinates']]


def area_m2(geometry):
    return sum(sum(abs(ring_area(r)) * (1 if i == 0 else -1) for i, r in enumerate(poly))
               * math.cos(math.radians(poly[0][0][1])) * 111320 ** 2 for poly in polygons(geometry))


def distance_sq(point, start, end):
    # Local equirectangular distance is sufficient for a 3 m display tolerance.
    scale = math.cos(math.radians((start[1] + end[1]) / 2))
    px, py = (point[0] - start[0]) * scale * 111320, (point[1] - start[1]) * 111320
    dx, dy = (end[0] - start[0]) * scale * 111320, (end[1] - start[1]) * 111320
    t = max(0, min(1, (px * dx + py * dy) / (dx * dx + dy * dy))) if dx or dy else 0
    return (px - t * dx) ** 2 + (py - t * dy) ** 2


def simplify_line(points, tolerance=3):
    if len(points) <= 2:
        return points
    keep = {0, len(points) - 1}
    stack = [(0, len(points) - 1)]
    while stack:
        start, end = stack.pop()
        if end <= start + 1:
            continue
        furthest = max(range(start + 1, end), key=lambda i: distance_sq(points[i], points[start], points[end]))
        if distance_sq(points[furthest], points[start], points[end]) > tolerance * tolerance:
            keep.add(furthest)
            stack.extend([(start, furthest), (furthest, end)])
    return [points[i] for i in sorted(keep)]


def rounded(coords):
    if isinstance(coords[0], (int, float)):
        return [round(coords[0], 6), round(coords[1], 6)]
    return [rounded(x) for x in coords]


def simplify_geometry(geometry):
    if geometry['type'] == 'LineString':
        return {'type': 'LineString', 'coordinates': rounded(simplify_line(geometry['coordinates']))}
    # Local metre coordinates and Shapely's topology-preserving simplifier retain
    # polygon components and holes, avoiding the loss of narrow park corridors.
    original = shape(geometry)
    sx, sy = math.cos(math.radians(51)) * 111320, 111320
    projected = affinity.scale(original, xfact=sx, yfact=sy, origin=(0, 0))
    for tolerance in [3, 0.5, 0]:
        simplified = affinity.scale(projected.simplify(tolerance, preserve_topology=True), xfact=1 / sx, yfact=1 / sy, origin=(0, 0)) if tolerance else original
        converted = mapping(simplified)
        result = {'type': converted['type'], 'coordinates': rounded(converted['coordinates'])}
        # A tiny retained corridor can collapse after decimal rounding. Keep its
        # unrounded vertices if rounding changes topology or parcel area by >1%.
        result_shape = shape(result)
        if not result_shape.is_valid or abs(result_shape.area / original.area - 1) > 0.01:
            result = {'type': converted['type'], 'coordinates': converted['coordinates']}
            result_shape = shape(result)
        if result_shape.is_valid and abs(result_shape.area / original.area - 1) <= 0.01:
            return result
    raise ValueError('Display simplification changed polygon topology or area')


def feature(kind, identifier, name, geometry, source, quality='official', **extra):
    result = {'type': 'Feature', 'properties': {'kind': kind, 'id': identifier, 'name': name, 'sourceUrl': source,
                                               'geometryQuality': quality, **extra}, 'geometry': simplify_geometry(geometry)}
    if kind != 'railway':
        geometry_shape = shape(result['geometry'])
        components = list(geometry_shape.geoms) if geometry_shape.geom_type == 'MultiPolygon' else [geometry_shape]
        point_shape = max(components, key=lambda p: p.area).representative_point()
        point = [round(point_shape.x, 8), round(point_shape.y, 8)]
        if not geometry_shape.contains(Point(point)):
            point = [point_shape.x, point_shape.y]
        if not geometry_shape.contains(Point(point)):
            raise ValueError(f'Label outside polygon: {identifier}')
        result['properties']['labelPoint'] = point
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-dir', required=True, type=Path)
    parser.add_argument('--download', action='store_true')
    parser.add_argument('--snapshot-date', default='2026-11-03')
    args = parser.parse_args()
    args.source_dir.mkdir(parents=True, exist_ok=True)
    if args.download:
        for name, url in URLS.items():
            with urllib.request.urlopen(url, timeout=120) as response:
                data = response.read()
            parsed = json.loads(data)
            if 'error' in parsed:
                raise ValueError(f'{name}: {parsed["error"]}')
            (args.source_dir / name).write_bytes(data)
    raw = {name: json.loads((args.source_dir / name).read_text()) for name in URLS}
    rails, parks, reserves = [raw[name]['features'] for name in ['rails.json', 'parks.json', 'reserves.json']]
    if not rails or not parks or not reserves or any(f.get('geometry') is None for f in rails + parks + reserves):
        raise ValueError('Empty or incomplete official geometry')
    features = []
    rail_groups = collections.defaultdict(list)
    for rail in rails:
        assert rail['properties']['rail_type'] == 'RAIL'
        assert rail['geometry']['type'] == 'LineString'
        rail_groups[rail['properties']['obscured']].append(simplify_geometry(rail['geometry'])['coordinates'])
    for obscured, lines in sorted(rail_groups.items()):
        # Group fragments for rendering without inventing connections between them.
        features.append({'type': 'Feature', 'properties': {'kind': 'railway', 'id': 'non-lrt-' + obscured.lower(),
                         'name': 'Non-LRT railway tracks', 'sourceUrl': RAIL_SOURCE, 'geometryQuality': 'official',
                         'obscured': obscured == 'YES', 'sourceSegmentCount': len(lines)},
                         'geometry': {'type': 'MultiLineString', 'coordinates': lines}})
    selected_parks = []
    for park in parks:
        p = park['properties']
        area = area_m2(park['geometry'])
        if p['planning_category'] in ['NON-PARK', 'PARKS DEPOT'] or p['life_cycle_status'] != 'ACTIVE':
            continue
        if area < 50000 and not (p['planning_category'] == 'REGIONAL PARK' and p.get('site_name')):
            continue
        source_name = p.get('site_name')
        name = source_name.title() if source_name else f'Park / open space {p["asset_cd"]}'
        selected_parks.append(p['asset_cd'])
        features.append(feature('park', 'park-' + p['asset_cd'], name, park['geometry'], PARK_SOURCE,
                                sourceName=source_name, parkCategory=p['planning_category'], areaHa=round(area / 10000, 2),
                                labelPriority=round(area / 10000, 1), named=bool(source_name)))
    communities_path = ROOT / 'public/data/communities.geojson'
    communities = {f['properties']['code']: f for f in json.loads(communities_path.read_text())['features']}
    for code, kind, name in [('CIA', 'airport', 'Calgary International Airport (YYC)'), ('FPK', 'park', 'Fish Creek Park'), ('COP', 'park', 'Canada Olympic Park')]:
        original = communities[code]
        features.append(feature(kind, 'community-' + code, name, original['geometry'], BOUNDARY_SOURCE,
                                quality='community_boundary_proxy', communityCode=code, named=True, labelPriority=1000,
                                note='显示区域采用市府社区边界，非机场设施或公园精确管理边界。'))
    reserve_names = {'06639': "Tsuut'ina Nation 145", '06642': 'Stoney 142, 143, 144'}
    for reserve in reserves:
        p = reserve['properties']
        assert p['distributionType'] == 'IR' and p['jurisdiction'] == 'AB'
        features.append(feature('reserve', 'reserve-' + p['adminAreaId'], reserve_names.get(p['adminAreaId'], p['adminAreaNameEng']),
                                reserve['geometry'], RESERVE_SOURCE, sourceName=p['adminAreaNameEng'],
                                reserveId=p['adminAreaId'], labelPriority=2000, named=True))
    features.sort(key=lambda f: (f['properties']['kind'], f['properties']['id']))
    ids = [f['properties']['id'] for f in features]
    if len(ids) != len(set(ids)):
        raise ValueError('Duplicate feature IDs')
    collection = {'type': 'FeatureCollection', 'name': 'Calgary geographic context', 'snapshotDate': args.snapshot_date,
                  'features': features}
    output = ROOT / 'public/data/geographic-context.geojson'
    output.write_text(json.dumps(collection, ensure_ascii=False, separators=(',', ':')) + '\n')
    audit = {'schemaVersion': 1, 'snapshotDate': args.snapshot_date,
             'sourceCounts': {'railSegments': len(rails), 'parkSites': len(parks), 'reserveAreas': len(reserves)},
             'outputCounts': dict(collections.Counter(f['properties']['kind'] for f in features)),
             'outputBytes': output.stat().st_size, 'outputSha256': sha(output), 'communityBoundarySha256': sha(communities_path),
             'parkSelection': 'Active park/open-space sites >= 5 hectares, plus all named regional-park sites; NON-PARK and PARKS DEPOT excluded. Fish Creek and Canada Olympic Park use community-boundary proxies.',
             'selectedParkAssetCodes': sorted(selected_parks),
             'reserveSelection': {'intersectsWgs84Bounds': QUERY_BOUNDS, 'fullPolygonsRetained': True, 'reserveIds': sorted(f['properties']['reserveId'] for f in features if f['properties']['kind'] == 'reserve')},
             'simplification': 'Non-LRT rail lines use Douglas-Peucker with approximately 3 metres local planar tolerance. Polygons use Shapely topology-preserving simplification at approximately 3 metres, falling back to 0.5 metres or original vertices until relative area change is <=1%. Coordinates rounded to 6 decimals unless that changes topology or area beyond the bound; no invented connecting segments.',
             'labelPoints': 'Interior point in largest polygon component, verified after coordinate rounding.',
             'notes': ['公园图层为市府公园及开放空间维护区域，包含部分学校和运动场地，不表示植被覆盖率，也不是完整公园名录。',
                       'YYC、Fish Creek Park、Canada Olympic Park 使用市府社区边界作区域示意，已逐项标为 community_boundary_proxy。',
                       '原住民保留区取自 NRCan 官方行政边界，仅作地理参考；不用于界址或产权判断。',
                       '铁路数据不含 CTrain。OBSCURED 字段保留，用于被遮挡的轨道段显示。'],
             'sources': [{'name': 'Calgary non-LRT tracks', 'url': RAIL_SOURCE, 'licenseUrl': CALGARY_LICENSE,
                          'updatedAt': datetime.datetime.fromtimestamp(raw['rail-metadata.json']['rowsUpdatedAt'], datetime.timezone.utc).isoformat()},
                         {'name': 'Calgary Parks Sites', 'url': PARK_SOURCE, 'licenseUrl': CALGARY_LICENSE,
                          'updatedAt': datetime.datetime.fromtimestamp(raw['park-metadata.json']['rowsUpdatedAt'], datetime.timezone.utc).isoformat()},
                         {'name': 'Calgary Community District Boundaries', 'url': BOUNDARY_SOURCE, 'licenseUrl': CALGARY_LICENSE},
                         {'name': 'NRCan Aboriginal Lands of Canada Legislative Boundaries', 'url': RESERVE_SOURCE, 'serviceUrl': RESERVE_SERVICE, 'licenseUrl': CANADA_LICENSE}],
             'rawSources': [{'file': name, 'url': url, 'sha256': sha(args.source_dir / name)} for name, url in URLS.items()]}
    (ROOT / 'geographic-context-audit.json').write_text(json.dumps(audit, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'features': len(features), 'counts': audit['outputCounts'], 'bytes': output.stat().st_size,
                      'sha256': audit['outputSha256']}, ensure_ascii=False))


if __name__ == '__main__':
    main()
