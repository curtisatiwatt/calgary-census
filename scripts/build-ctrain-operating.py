#!/usr/bin/env python3
"""Build the operating CTrain snapshot from three official Calgary sources.

Run with --cache-dir DIR to cache/reuse the downloaded source documents.
Only the maintenance script uses Python; the website consumes static GeoJSON.
"""
import argparse
import collections
import csv
from datetime import datetime, timezone
import hashlib
import io
import json
from pathlib import Path
import re
import urllib.parse
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
ROUTE_PAGE = 'https://data.calgary.ca/Transportation-Transit/Calgary-Transit-Routes/hpnd-riq4'
ROUTE_QUERY = 'https://data.calgary.ca/resource/hpnd-riq4.json?' + urllib.parse.urlencode({'$where': "route_category='LRT'", '$limit': 10})
STATION_SERVICE = 'https://services1.arcgis.com/AVP60cs0Q9PEA8rH/arcgis/rest/services/LRT_Stations/FeatureServer/0'
STATION_QUERY = STATION_SERVICE + '/query?' + urllib.parse.urlencode({'where': '1=1', 'outFields': '*', 'outSR': '4326', 'f': 'geojson'})
GTFS_PAGE = 'https://data.calgary.ca/Transportation-Transit/Calgary-Transit-Scheduling-Data/npk7-z3bj'
GTFS_DOWNLOAD = 'https://data.calgary.ca/download/npk7-z3bj/application/zip'
NAME_REFERENCE = 'https://www.calgarytransit.com/rider-information/lrt-and-bus-station-maps.html'
LINE_IDS = {'201': 'red', '202': 'blue'}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def fetch(cache, filename, url):
    path = cache / filename
    if not path.exists():
        request = urllib.request.Request(url, headers={'User-Agent': 'CalgaryCensusDataMaintenance/1.0'})
        with urllib.request.urlopen(request, timeout=120) as response:
            path.write_bytes(response.read())
    return path


def table(archive, name):
    with archive.open(name) as handle:
        yield from csv.DictReader(io.TextIOWrapper(handle, encoding='utf-8-sig'))


def cleaned_stop_name(name):
    name = re.sub(r'^(?:NB|SB|EB|WB)\s+', '', name)
    name = re.sub(r'\s*\(Free Fare Zone\)\s*', '', name)
    name = re.sub(r'\s+(?:CTrain\s+)?(?:Station|Staion|Stn)$', '', name)
    return name.strip()


def key(name):
    name = cleaned_stop_name(name).lower()
    name = re.sub(r'(\d)(?:st|nd|rd|th)\b', r'\1', name)
    name = re.sub(r'\b(?:sw|nw|se|ne)\b', '', name)
    name = re.sub(r'[^a-z0-9]', '', name)
    return {
        'cityhall': 'cityhallbowvalleycollege',
        'saitacadjubilee': 'saitauartsjubilee',
        'bridgeland': 'bridgelandmemorial',
        'calgaryzoo': 'zoo',
    }.get(name, name)


def display_name(name):
    name = cleaned_stop_name(name)
    replacements = {
        'Downtown-West Kerby': 'Downtown West / Kerby',
        'Downtown West-Kerby': 'Downtown West / Kerby',
        'Barlow - Max Bell': 'Barlow / Max Bell',
        'Bridgeland - Memorial': 'Bridgeland / Memorial',
        'City Hall/Bow Valley College': 'City Hall / Bow Valley College',
        'Zoo': 'Calgary Zoo',
    }
    return replacements.get(name, name).replace(' - ', '–')


def round_coordinates(value):
    if isinstance(value[0], (int, float)):
        return [round(v, 7) for v in value[:2]]
    return [round_coordinates(item) for item in value]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cache-dir', required=True, type=Path)
    parser.add_argument('--retrieved-at', default='2026-11-03')
    args = parser.parse_args()
    args.cache_dir.mkdir(parents=True, exist_ok=True)
    paths = {
        'routes': fetch(args.cache_dir, 'ctrain-routes-raw.json', ROUTE_QUERY),
        'stations': fetch(args.cache_dir, 'ctrain-stations-raw.geojson', STATION_QUERY),
        'gtfs': fetch(args.cache_dir, 'CT_GTFS.zip', GTFS_DOWNLOAD),
        'stationMetadata': fetch(args.cache_dir, 'ctrain-stations-metadata.json', STATION_SERVICE + '?f=json'),
        'routeMetadata': fetch(args.cache_dir, 'ctrain-routes-metadata.json', 'https://data.calgary.ca/api/views/hpnd-riq4.json'),
        'gtfsMetadata': fetch(args.cache_dir, 'ctrain-gtfs-metadata.json', 'https://data.calgary.ca/api/views/npk7-z3bj.json'),
    }
    raw_routes = json.loads(paths['routes'].read_text())
    raw_stations = json.loads(paths['stations'].read_text())
    route_metadata = json.loads(paths['routeMetadata'].read_text())
    station_metadata = json.loads(paths['stationMetadata'].read_text())
    gtfs_metadata = json.loads(paths['gtfsMetadata'].read_text())
    require({r['route_short_name'] for r in raw_routes} == set(LINE_IDS), 'Expected exactly the two LRT routes 201/202')
    require(all(r['route_category'] == 'LRT' for r in raw_routes), 'Bus route leaked into rail selection')
    source_dates = {
        'routeDataUpdated': datetime.fromtimestamp(route_metadata['rowsUpdatedAt'], timezone.utc).isoformat(),
        'stationDataUpdated': datetime.fromtimestamp(station_metadata['editingInfo']['dataLastEditDate'] / 1000, timezone.utc).isoformat(),
        # This is a file asset, so rowsUpdatedAt is its 2016 creation timestamp.
        # viewLastModified matches the current ZIP publication shown by the catalogue.
        'gtfsUpdated': datetime.fromtimestamp(gtfs_metadata['viewLastModified'], timezone.utc).isoformat(),
    }
    with zipfile.ZipFile(paths['gtfs']) as archive:
        route_ids = {r['route_id']: r['route_short_name'] for r in table(archive, 'routes.txt') if r['route_short_name'] in LINE_IDS and r['route_type'] == '0'}
        require(set(route_ids.values()) == set(LINE_IDS), 'Both rail services must exist in GTFS')
        trip_lines = {t['trip_id']: route_ids[t['route_id']] for t in table(archive, 'trips.txt') if t['route_id'] in route_ids}
        stop_lines = collections.defaultdict(set)
        for stop_time in table(archive, 'stop_times.txt'):
            line = trip_lines.get(stop_time['trip_id'])
            if line:
                stop_lines[stop_time['stop_id']].add(LINE_IDS[line])
        platform_groups = collections.defaultdict(list)
        for stop in table(archive, 'stops.txt'):
            if stop['stop_id'] in stop_lines:
                platform_groups[key(stop['stop_name'])].append(stop)
        calendars = list(table(archive, 'calendar.txt'))
        service_range = {'start': min(row['start_date'] for row in calendars), 'end': max(row['end_date'] for row in calendars)}

    gis_groups = collections.defaultdict(list)
    excluded = []
    for feature in raw_stations['features']:
        p = feature['properties']
        if p['STATUS'] != 'Current' or not set(p['ROUTE'].split('/')).issubset(LINE_IDS):
            excluded.append(p)
            continue
        gis_groups[key(p['STATIONNAM'])].append(feature)
    require(set(gis_groups) == set(platform_groups), 'Station inventory differs between GIS and GTFS; review source changes before publishing')
    require(len(gis_groups) == 45, 'Expected 45 distinct operating stations; review expansion before publishing')
    features = []
    for route in sorted(raw_routes, key=lambda r: r['route_short_name']):
        line_id = LINE_IDS[route['route_short_name']]
        geometry = route['multilinestring']
        require(geometry['type'] == 'MultiLineString', 'Unexpected route geometry')
        features.append({'type': 'Feature', 'properties': {
            'kind': 'transit_route', 'id': f'ctrain-{line_id}', 'name': route['route_long_name'],
            'lineId': line_id, 'status': 'operating', 'routeNumber': route['route_short_name'],
            'sourceUrl': ROUTE_PAGE,
        }, 'geometry': {'type': geometry['type'], 'coordinates': round_coordinates(geometry['coordinates'])}})

    station_audit = []
    for station_key in sorted(gis_groups):
        gis_features = sorted(gis_groups[station_key], key=lambda f: f['properties']['OBJECTID'])
        platforms = sorted(platform_groups[station_key], key=lambda s: int(s['stop_id']))
        line_ids = sorted({line for stop in platforms for line in stop_lines[stop['stop_id']]}, key=lambda line: ['red', 'blue'].index(line))
        gis_line_ids = {LINE_IDS[route] for feature in gis_features for route in feature['properties']['ROUTE'].split('/')}
        require(set(line_ids) == gis_line_ids, f'Line assignment differs for {station_key}')
        # Retain a published GIS coordinate exactly (apart from 7-decimal precision).
        # The two duplicated platforms at City Hall and Kerby use the first source record.
        representative = gis_features[0]
        point = round_coordinates(representative['geometry']['coordinates'])
        require(-115 < point[0] < -113 and 50 < point[1] < 52, f'Station outside Calgary: {station_key}')
        name = display_name(platforms[0]['stop_name'])
        features.append({'type': 'Feature', 'geometry': {'type': 'Point', 'coordinates': point}, 'properties': {
            'kind': 'transit_station', 'id': f'ctrain-station-{station_key}', 'name': name,
            'lineIds': line_ids, 'status': 'operating', 'sourceUrl': STATION_SERVICE,
            'nameSourceUrl': GTFS_PAGE, 'sourceStationIds': [f['properties']['OBJECTID'] for f in gis_features],
            'sourceStopIds': [s['stop_id'] for s in platforms],
        }})
        station_audit.append({'id': station_key, 'name': name, 'lineIds': line_ids,
            'gisNames': sorted({f['properties']['STATIONNAM'] for f in gis_features}),
            'gisObjectIds': [f['properties']['OBJECTID'] for f in gis_features],
            'gtfsStops': [{'id': s['stop_id'], 'name': s['stop_name']} for s in platforms]})

    result = {'type': 'FeatureCollection', 'retrievedAt': args.retrieved_at, 'sourceDates': source_dates,
        'sources': [{'label': 'Calgary Transit Routes', 'url': ROUTE_PAGE}, {'label': 'City of Calgary LRT Stations', 'url': STATION_SERVICE}, {'label': 'Calgary Transit GTFS', 'url': GTFS_PAGE}],
        'note': 'Operating network snapshot, not real-time service. Station points are published city GIS locations; current display names and line assignments are cross-checked against official GTFS. Duplicate platform records at City Hall and Downtown West/Kerby are represented once.',
        'features': features}
    output = ROOT / 'public/data/ctrain-operating.geojson'
    output.write_text(json.dumps(result, ensure_ascii=False, separators=(',', ':')) + '\n')
    station_features = [f for f in features if f['properties']['kind'] == 'transit_station']
    audit = {'schemaVersion': 1, 'retrievedAt': args.retrieved_at, 'sourceDates': source_dates,
        'sources': result['sources'], 'nameReferenceUrl': NAME_REFERENCE,
        'licenseUrl': 'https://data.calgary.ca/d/Open-Data-Terms/u45n-7awa',
        'method': 'Select only official LRT route rows 201/202. Join Current GIS station records to GTFS stops served by route_type 0 trips on routes 201/202. Normalize direction prefixes and name aliases for joins; verify exact station and line membership agreement. Preserve one official GIS point per station, choosing the lowest OBJECTID where opposite platforms duplicate a station. Geometry rounded to 7 decimals; no routes or station coordinates are hand-drawn.',
        'counts': {'routes': 2, 'rawGisStationPoints': len(raw_stations['features']), 'distinctStations': len(station_features), 'gtfsPlatforms': len(stop_lines),
            'redStations': sum('red' in f['properties']['lineIds'] for f in station_features),
            'blueStations': sum('blue' in f['properties']['lineIds'] for f in station_features),
            'sharedStations': sum(len(f['properties']['lineIds']) == 2 for f in station_features)},
        'gtfsServiceRange': service_range, 'excludedGisRecords': excluded,
        'limitations': ['Geographic overview, not a live timetable or closure feed.', 'Opposite platform points are represented by one published station coordinate; use the official station maps for entrances/accessibility.', 'Shared downtown Red/Blue route geometry overlaps; the renderer should retain both line identities.'],
        'sourceSha256': {name: hashlib.sha256(path.read_bytes()).hexdigest() for name, path in paths.items()},
        'outputSha256': hashlib.sha256(output.read_bytes()).hexdigest(), 'stations': station_audit}
    (ROOT / 'ctrain-operating-audit.json').write_text(json.dumps(audit, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'output': str(output), 'bytes': output.stat().st_size, 'counts': audit['counts'], 'sourceDates': source_dates}, ensure_ascii=False))


if __name__ == '__main__':
    main()
