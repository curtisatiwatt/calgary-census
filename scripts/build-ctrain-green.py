#!/usr/bin/env python3
"""Build a Green Line snapshot from the City of Calgary's public map services.

Usage: python3 scripts/build-ctrain-green.py [--source-dir /path/to/cached-responses]
The optional directory contains green_route_raw.json and green_stations_raw.json.
The 2026-09-22 downtown decision takes precedence over superseded GIS features.
"""
import argparse
import hashlib
import json
import math
from collections import Counter
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
AS_OF = "2026-11-03"
BASE = "https://services1.arcgis.com/AVP60cs0Q9PEA8rH/arcgis/rest/services/"
ROUTES = BASE + "Approved%20Green%20Line%20Alignment%20with%20elevations/FeatureServer/0"
STATIONS = BASE + "Green_Line_Stations_for_CSC_Green_Line_Embedded_Web_Map/FeatureServer/0"
QUERY = urlencode({"where": "1=1", "outFields": "*", "outSR": 4326, "f": "json"})
DOWNTOWN = "https://www.calgary.ca/green-line/downtown-segment.html"
SOUTH = "https://www.calgary.ca/green-line/about/future-extensions/expanding-south.html"
NORTH = "https://www.calgary.ca/green-line/about/future-extensions/expanding-north.html"
STATION_PAGE = "https://www.calgary.ca/green-line/stations.html"
PHASES = {
    "phase_1_southeast": ("一期东南段", "construction", "funded", "东南段施工中，尚未运营。"),
    "phase_1_downtown": ("一期市中心段", "planned", "funded", "2026-09-22 获批的市中心地面方案，处于规划设计阶段，尚未运营。"),
    "future_north": ("远期北延线", "planned", "unfunded", "远期北延线，建设资金尚未落实；线位与站点可能调整。"),
    "future_south": ("远期南延线", "planned", "unfunded", "远期南延线，建设资金尚未落实；线位与站点可能调整。"),
}
NAME_FIXES = {
    "Ramsay / Inglewood": "Ramsay/Inglewood",
    "Lynnwood / Millican": "Lynnwood/Millican",
    "Event Centre / Grand Central Station": "Event Centre/Grand Central Station",
    "Auburn Bay / Mahogany": "Auburn Bay/Mahogany",
    "Mcknight Boulevard": "McKnight Boulevard",
    "Hospital": "South Health Campus Hospital",
}


def fetch(kind, endpoint, source_dir):
    if source_dir:
        raw = (source_dir / f"green_{kind}_raw.json").read_bytes()
    else:
        with urlopen(endpoint + "/query?" + QUERY, timeout=60) as response:
            raw = response.read()
    result = json.loads(raw)
    assert not result.get("error"), result.get("error")
    assert not result.get("exceededTransferLimit"), "Refuse a truncated response"
    assert result.get("spatialReference", {}).get("wkid") == 4326
    return result, hashlib.sha256(raw).hexdigest()


def props(phase):
    label, status, funding, note = PHASES[phase]
    return {
        "phase": phase, "phaseLabel": label, "status": status, "funding": funding,
        "geometryQuality": "official", "asOf": AS_OF, "locationNote": note,
    }


def coordinates(values):
    output = []
    for xy in values:
        assert len(xy) >= 2 and -114.2 < xy[0] < -113.8 and 50.8 < xy[1] < 51.3
        point = [round(xy[0], 7), round(xy[1], 7)]
        if not output or point != output[-1]:
            output.append(point)
    assert len(output) >= 2
    return output


def station_distances(features):
    """Check coordinates against same-phase official lines without snapping them."""
    def project(point):
        return point[0] * 111320 * math.cos(math.radians(51)), point[1] * 111320

    def distance(point, start, end):
        p, a, b = map(project, (point, start, end))
        dx, dy = b[0] - a[0], b[1] - a[1]
        t = max(0, min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy))) if dx * dx + dy * dy else 0
        return math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy)

    result = {}
    for feature in features:
        if feature["properties"]["kind"] != "transit_station":
            continue
        lines = [line["geometry"]["coordinates"] for line in features
                 if line["properties"]["kind"] == "transit_route"
                 and line["properties"]["phase"] == feature["properties"]["phase"]]
        nearest = min(distance(feature["geometry"]["coordinates"], a, b)
                      for line in lines for a, b in zip(line, line[1:]))
        assert nearest < 50, (feature["properties"]["name"], nearest)
        result[feature["properties"]["id"]] = round(nearest, 2)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-dir", type=Path)
    args = parser.parse_args()
    routes, routes_hash = fetch("route", ROUTES, args.source_dir)
    stations, stations_hash = fetch("stations", STATIONS, args.source_dir)
    features, excluded_routes, excluded_stations = [], [], []
    # The GIS retains a legacy 2 St SW -> 7 Ave SW -> Eau Claire connection.
    # The latest City FAQ says the north connection and additional downtown
    # stations will be determined in future planning. Do not present this as
    # a settled current route merely because old geometry is still available.
    excluded_route_ids = {44, 59}
    for feature in routes["features"]:
        a, g = feature["attributes"], feature["geometry"]
        if a["OBJECTID"] in excluded_route_ids:
            excluded_routes.append(a["OBJECTID"])
            continue
        paths = [coordinates(path) for path in g["paths"]]
        if a["STAGE"] == "Southeast":
            phase = "phase_1_southeast"
        elif a["STAGE"] == "Downtown":
            phase = "phase_1_downtown"
            assert max(y for path in paths for x, y in path) < 51.044, "Downtown must end on 10 Avenue"
        else:
            assert a["STAGE"] == "Future", a
            phase = "future_south" if max(y for path in paths for x, y in path) < 51 else "future_north"
        p = {
            **props(phase), "kind": "transit_route", "id": f"green-route-{a['OBJECTID']}",
            "name": "Green Line · " + PHASES[phase][0], "lineId": "green",
            "sourceUrl": ROUTES, "sourceObjectId": a["OBJECTID"],
            "sourceStage": a["STAGE"], "sourceStructure": a["CTP_CLASS"],
        }
        features.append({"type": "Feature", "properties": p, "geometry": {
            "type": "LineString" if len(paths) == 1 else "MultiLineString",
            "coordinates": paths[0] if len(paths) == 1 else paths,
        }})

    for feature in stations["features"]:
        a, g = feature["attributes"], feature["geometry"]
        title = a["Title"]
        if title == "7 Avenue SW":
            excluded_stations.append({"sourceObjectId": a["OBJECTID"], "name": title})
            continue
        if title == "2 Street SW":
            phase = "phase_1_downtown"
        elif a["ConstructionStage"] == "SE Segment" or title == "Event Centre / Grand Central Station":
            phase = "phase_1_southeast"
        else:
            assert a["ConstructionStage"] == "TBD"
            phase = "future_south" if g["y"] < 51 else "future_north"
        p = {
            **props(phase), "kind": "transit_station", "id": f"green-station-{a['OBJECTID']}",
            "name": NAME_FIXES.get(title, title), "lineIds": ["green"],
            "sourceUrl": a.get("More_Info") or STATIONS, "geometrySourceUrl": STATIONS,
            "sourceObjectId": a["OBJECTID"], "sourceName": title,
        }
        if title == "2 Street SW":
            p["sourceUrl"] = DOWNTOWN
            p["locationNote"] = "官方规划点位；最终站址待设计确定。市中心地面方案于 2026-09-22 获批，尚未运营。"
        elif title == "Eau Claire":
            p["sourceUrl"] = DOWNTOWN
            p["locationNote"] = "远期站点；与现阶段线路的连接尚未确定，建设资金尚未落实。"
        elif phase.startswith("future_"):
            p["sourceUrl"] = SOUTH if phase == "future_south" else NORTH
        assert -114.2 < g["x"] < -113.8 and 50.8 < g["y"] < 51.3
        features.append({"type": "Feature", "properties": p, "geometry": {
            "type": "Point", "coordinates": [round(g["x"], 7), round(g["y"], 7)],
        }})
    point_counts = Counter(f["properties"]["phase"] for f in features if f["geometry"]["type"] == "Point")
    assert point_counts == {"phase_1_southeast": 10, "phase_1_downtown": 1, "future_north": 12, "future_south": 5}, point_counts
    assert len({f["properties"]["id"] for f in features}) == len(features)
    assert set(excluded_routes) == excluded_route_ids
    assert len(excluded_stations) == 1
    proximity = station_distances(features)
    result = {
        "type": "FeatureCollection", "asOf": AS_OF,
        "description": "Green Line: construction, approved downtown planning, and unfunded future extensions. No Green Line service is operating.",
        "features": features,
    }
    output = ROOT / "public/data/ctrain-green.geojson"
    output.write_text(json.dumps(result, ensure_ascii=False, separators=(",", ":")) + "\n")
    audit = {
        "schemaVersion": 1, "asOf": AS_OF,
        "sourceMap": "https://maps.calgary.ca/greenline/",
        "sourceMapItem": "https://www.arcgis.com/sharing/rest/content/items/e0444d1c2ada4758a7d6ca15caa890a6/data?f=json",
        "sources": [
            {"url": ROUTES, "query": QUERY, "rawSha256": routes_hash, "rawFeatureCount": len(routes["features"]), "serviceItemId": "ea67fac93f054502a8dbdbb21a657513", "owner": "calgary.ca", "accessInformation": "The City of Calgary", "copyrightText": "", "itemLicenseInfo": "Subject to The City of Calgary Open Data Terms of Use at https://data.calgary.ca/d/Open-Data-Terms/u45n-7awa"},
            {"url": STATIONS, "query": QUERY, "rawSha256": stations_hash, "rawFeatureCount": len(stations["features"]), "serviceItemId": "c505433ba443449daec5b170ba2b2a4c", "owner": "calgary.ca", "accessInformation": None, "copyrightText": "Subject to The City of Calgary Open Data Terms of Use at https://data.calgary.ca/d/Open-Data-Terms/u45n-7awa", "itemLicenseInfo": None},
            {"url": DOWNTOWN, "role": "2026-09-22 approved 10 Avenue surface route to 2 Street SW; exact station site and northern connection are not yet finalized."},
            {"url": SOUTH, "role": "Official five future southern station names and unfunded expansion status."},
            {"url": NORTH, "role": "Official eleven future northern station names and unfunded expansion status."},
        ],
        "license": "City of Calgary Open Data Terms of Use: https://data.calgary.ca/d/Open-Data-Terms/u45n-7awa",
        "method": "Use the official map's WGS84 line and point queries. Keep source geometry at seven decimal places; remove consecutive duplicate coordinates. No inferred routing, snapping, geocoding or fabricated connecting segments.",
        "outputSha256": hashlib.sha256(output.read_bytes()).hexdigest(),
        "counts": {"routeSegments": sum(f["properties"]["kind"] == "transit_route" for f in features), "stations": sum(point_counts.values()), "stationsByPhase": dict(point_counts)},
        "spatialChecks": {"allStationPointsWithin50MetresOfSamePhaseRoute": True, "maximumDistanceMetres": max(proximity.values()), "stationDistancesMetres": proximity},
        "excludedLegacyFeatures": {"routeSourceObjectIds": sorted(excluded_routes), "stations": excluded_stations, "reason": "Latest downtown project page says any additional downtown stations and the connection to the north corridor remain to be determined; the old 7 Avenue SW station and its connecting segments are not treated as an approved current alignment."},
        "statusOverrides": [{"name": "Event Centre/Grand Central Station", "status": "construction", "reason": "Station GIS calls this Downtown Segment, but current project pages explicitly include Event Centre/Grand Central Station as the northern end of the SE construction segment."}],
        "limitations": [
            "Official GIS geometry is for map context, not final engineering or property boundaries.",
            "2 Street SW uses an official planning point; the City states its exact station location remains to be determined.",
            "North and south extensions are unfunded. Locations and sequencing may change.",
            "Eau Claire is retained as an official future station point; no speculative connection to the current 2 Street SW terminus is drawn.",
            "Snapshot checked on 2026-11-03, not a live construction or service feed.",
        ],
    }
    (ROOT / "ctrain-green-audit.json").write_text(json.dumps(audit, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(audit["counts"]))


if __name__ == "__main__":
    main()
