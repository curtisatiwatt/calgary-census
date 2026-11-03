#!/usr/bin/env python3
"""Extract 2021 Calgary population-group tables from official profile PDF text.

Prepare inputs with `pdftotext -layout profile.pdf profile.txt`, retaining each
official PDF filename. Then run:
  python3 scripts/extract-population-groups.py --source-dir /path/to/profiles

The checked-in community GeoJSON supplies community codes and official source
URLs. This script never changes the income, Chinese-only, or boundary dataset.
It fails closed on missing source tables, inconsistent city figures, category
omissions, and differences from the existing Chinese-only dataset.
"""

import argparse
import hashlib
import json
import re
from pathlib import Path
from urllib.parse import urlparse


ROOT = Path(__file__).resolve().parents[1]
# The original download cache used this community's HTML-page slug as filename.
# Fresh inputs can use the official PDF filename without any alias.
SOURCE_FILE_ALIASES = {"winston-heights-mountview.txt": "winston-heights.txt"}
GROUPS = [
    ("south_asian", "南亚裔", "South Asian"),
    ("chinese", "华人", "Chinese"),
    ("black", "黑人", "Black"),
    ("filipino", "菲律宾裔", "Filipino"),
    ("arab", "阿拉伯裔", "Arab"),
    ("latin_american", "拉丁美洲裔", "Latin American"),
    ("southeast_asian", "东南亚裔", "Southeast Asian"),
    ("west_asian", "西亚裔", "West Asian"),
    ("korean", "韩裔", "Korean"),
    ("japanese", "日裔", "Japanese"),
    ("visible_minority_nie", "其他可见少数族裔", "Visible minority, n.i.e."),
    ("multiple_visible_minorities", "多个可见少数族裔", "Multiple visible minorities"),
    ("not_visible_minority", "非可见少数族裔（普查分类）", "Not a visible minority"),
]


def require(condition, message):
    if not condition:
        raise ValueError(message)


def integer(value):
    return int(value.replace(",", ""))


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def parse_table(text, source_name):
    heading = "Visible Minority (Racialized Population)"
    require(text.count(heading) == 1, f"{source_name}: expected one population-group table")
    section = text.split(heading, 1)[1].split("*n.i.e.", 1)[0]
    totals = re.findall(r"^\s*([\d,]+)\s+100%\s+([\d,]+)\s+100%", section, re.M)
    require(len(totals) == 1, f"{source_name}: private-household denominator is missing or ambiguous")
    local = {"population": integer(totals[0][0]), "counts": {}, "publishedPct": {}}
    city = {"population": integer(totals[0][1]), "counts": {}, "publishedPct": {}}

    for group_id, _, name in GROUPS:
        # The n.i.e. source row includes a footnote asterisk. Both columns repeat
        # the category name, so requiring two full matches verifies column joins.
        pattern = re.compile(re.escape(name) + r"\*?\s+([\d,]+)\s+(\d+)%")
        matching_lines = [line for line in section.splitlines() if pattern.search(line)]
        require(len(matching_lines) == 1, f"{source_name}: {name} row is missing or duplicated")
        values = pattern.findall(matching_lines[0])
        require(len(values) == 2, f"{source_name}: {name} does not contain both table columns")
        for record, (count, pct) in zip((local, city), values):
            record["counts"][group_id] = integer(count)
            record["publishedPct"][group_id] = int(pct) / 100

    for label, record in (("community", local), ("city", city)):
        require(record["population"] > 0, f"{source_name}: nonpositive {label} denominator")
        require(all(0 <= n <= record["population"] for n in record["counts"].values()),
                f"{source_name}: {label} count out of bounds")
        require(all(0 <= n <= 1 for n in record["publishedPct"].values()),
                f"{source_name}: {label} percentage out of bounds")
        # Published category totals need not add exactly. The source documents
        # warn about rounding; Highwood also has a verified -75-person gap.
        # Preserve every source value and audit the gap instead of "fixing" it.
        # This bound is a parsing guard, not a claim that rounding explains all
        # observed discrepancies in the source publication.
        difference = sum(record["counts"].values()) - record["population"]
        require(abs(difference) <= 100, f"{source_name}: review {label} category total difference {difference}")
    return local, city


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-dir", required=True, type=Path,
                        help="Directory containing official pdftotext -layout .txt files")
    args = parser.parse_args()
    boundary_path = ROOT / "public/data/communities.geojson"
    features = json.loads(boundary_path.read_text())["features"]
    result = {
        "schemaVersion": 1,
        "censusYear": 2021,
        "variable": "visible_minority",
        "denominatorLabel": "私人住户人口",
        "groups": [{"id": gid, "label": label, "name": name} for gid, label, name in GROUPS],
        "defaultGroupIds": ["south_asian", "chinese", "filipino", "black", "latin_american"],
        "city": None,
        "communities": {},
    }
    sources, missing_codes, total_differences = [], [], {}
    for feature in sorted(features, key=lambda f: f["properties"]["code"]):
        prop = feature["properties"]
        code = prop["code"]
        source_url = prop.get("sourceUrl")
        if not source_url:
            require(prop.get("chineseCount") is None, f"{code}: Chinese data has no official source URL")
            missing_codes.append(code)
            continue
        parsed_url = urlparse(source_url)
        require(parsed_url.scheme == "https" and parsed_url.hostname == "www.calgary.ca",
                f"{code}: expected an official Calgary HTTPS profile URL")
        filename = Path(parsed_url.path).with_suffix(".txt").name
        path = args.source_dir / filename
        if not path.is_file() and filename in SOURCE_FILE_ALIASES:
            filename = SOURCE_FILE_ALIASES[filename]
            path = args.source_dir / filename
        require(path.is_file(), f"{code}: source text not found: {path}")
        local, city = parse_table(path.read_text(), filename)
        if result["city"] is None:
            result["city"] = city
        require(result["city"] == city, f"{code}: inconsistent city reference figures")
        require(local["counts"]["chinese"] == prop["chineseCount"],
                f"{code}: Chinese count differs from the existing audited dataset")
        require(local["publishedPct"]["chinese"] == prop["chinesePct"],
                f"{code}: Chinese published percentage differs from the existing audited dataset")
        local["sourceUrl"] = source_url
        result["communities"][code] = local
        difference = sum(local["counts"].values()) - local["population"]
        if difference:
            total_differences[code] = difference
        sources.append({"code": code, "textFile": filename, "sha256": sha256(path)})

    require(len(result["communities"]) == 206, "Expected all 206 existing official community profiles")
    require(len(features) == 313, "Boundary coverage changed; review the extraction contract")
    require(result["city"]["population"] == 1291790, "Unexpected Calgary reference population")
    output_path = ROOT / "public/data/population-groups.json"
    output_path.write_text(json.dumps(result, ensure_ascii=False, separators=(",", ":")) + "\n")
    audit = {
        "schemaVersion": 1,
        "source": "City of Calgary 2021 Census community profiles, printed page 11, Visible Minority (Racialized Population)",
        "sourceDirectoryUrl": "https://www.calgary.ca/communities/profiles.html",
        "method": "Parse both labelled columns from official pdftotext -layout text, join source URLs to existing community codes, require all 13 categories, and verify every city reference and existing Chinese value.",
        "censusYear": 2021,
        "denominator": "Population in private households from the same population-group table (2021 Census 25% sample data).",
        "classificationNote": "Not a visible minority is the official residual category; it includes Indigenous people and must not be relabelled White or European. Chinese is a population-group category, not citizenship, birthplace, or all Chinese ethnic-origin responses.",
        "roundingNote": "Preserves published counts and source integer percentages separately. Derived shares use count / table population. Category counts do not always sum exactly to the denominator; source profiles warn about rounding. Do not silently alter the counts or assume every discrepancy can be explained by rounding alone. Missing community data is absent, never zero.",
        "boundarySha256": sha256(boundary_path),
        "outputSha256": sha256(output_path),
        "coverage": {
            "boundaryCommunities": len(features),
            "withAll13Groups": len(result["communities"]),
            "withoutOfficialProfile": len(missing_codes),
            "missingCodes": missing_codes,
            "zeroCountsByGroup": {gid: sum(c["counts"][gid] == 0 for c in result["communities"].values()) for gid, _, _ in GROUPS},
        },
        "checks": {
            "all13CategoriesPresent": True,
            "allCityReferencesAgree": True,
            "existingChineseCountsAndPublishedPercentagesAgree": True,
            "communityCategorySumMinusDenominator": total_differences,
            "cityCategorySumMinusDenominator": sum(result["city"]["counts"].values()) - result["city"]["population"],
        },
        "reviewedSourceDiscrepancies": [{
            "code": "HIW",
            "name": "Highwood",
            "printedPage": 11,
            "population": 2205,
            "sumOf13Categories": 2130,
            "difference": -75,
            "verification": "Visually checked against the rendered official PDF page: every extracted count and the denominator match the printed table. The publication gives no specific explanation for this discrepancy; all published values are retained.",
            "sourceUrl": result["communities"]["HIW"]["sourceUrl"],
        }],
        "sourceTextFiles": sources,
    }
    (ROOT / "population-data-audit.json").write_text(json.dumps(audit, ensure_ascii=False, indent=2) + "\n")
    print(f"Extracted {len(result['communities'])} communities × {len(GROUPS)} categories; all city references and existing Chinese values agree.")
    print(f"Missing profiles: {len(missing_codes)}; data size: {output_path.stat().st_size:,} bytes.")


if __name__ == "__main__":
    main()
