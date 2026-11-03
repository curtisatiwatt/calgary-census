import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { searchFeatures, isNumber } from '../src/map-utils.js';

const root = new URL('../', import.meta.url);
const read = path => JSON.parse(fs.readFileSync(new URL(path, root), 'utf8'));
const integrity = read('data-integrity.json');
for (const [path, expected] of Object.entries(integrity.files)) {
  const bytes = fs.readFileSync(new URL(path, root));
  assert.equal(bytes.length, expected.bytes, `${path}: original data file size changed`);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), expected.sha256,
    `${path}: differs from the published Calgary data snapshot`);
}

const communities = read('public/data/communities.geojson');
const basemap = read('public/data/basemap.geojson');
const metadata = read('public/data/metadata.json');
const audit = read('data-audit.json');
const basemapAudit = read('basemap-audit.json');
assert.equal(communities.type, 'FeatureCollection');
assert.equal(communities.features.length, audit.features);
assert.equal(new Set(communities.features.map(f => f.properties.code)).size, 313);
assert.equal(metadata.cityName, 'Calgary');
assert.equal(metadata.cityIncomeMedian, audit.cityIncomeMedian);
assert.equal(metadata.cityChineseCount, audit.cityChineseCount);
assert.equal(metadata.cityChinesePct, audit.cityChinesePct);
assert.equal(metadata.populationYear, audit.populationYear);
assert.equal(metadata.incomeYear, audit.incomeYear);
assert.ok(metadata.sources.every(source => new URL(source.url).protocol === 'https:'));

function inRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function containsAnchor(feature) {
  const polygons = feature.geometry.type === 'MultiPolygon'
    ? feature.geometry.coordinates : [feature.geometry.coordinates];
  return polygons.some(([outer, ...holes]) => inRing(feature.properties.centroid, outer)
    && !holes.some(hole => inRing(feature.properties.centroid, hole)));
}

const counts = { income: 0, chinese: 0, chineseZero: 0, chineseSum: 0 };
const types = {};
for (const feature of communities.features) {
  const p = feature.properties;
  assert.ok(p.name && p.code && p.note, 'Every area needs its original identity and reference note');
  assert.ok(['Polygon', 'MultiPolygon'].includes(feature.geometry.type));
  assert.ok(Array.isArray(p.centroid) && p.centroid[0] > -115 && p.centroid[0] < -113
    && p.centroid[1] > 50 && p.centroid[1] < 52);
  assert.ok(containsAnchor(feature), `${p.name}: display anchor must be inside the community`);
  types[p.type] = (types[p.type] || 0) + 1;
  if (p.income !== null) {
    assert.ok(isNumber(p.income) && p.income > 0 && p.sourceUrl);
    assert.ok(Number.isInteger(p.incomeRank) && p.incomeRank > 0 && p.incomeRank <= audit.incomeNumeric);
    counts.income += 1;
  }
  if (p.chineseCount !== null) {
    assert.ok(Number.isInteger(p.chineseCount) && p.chineseCount >= 0 && p.sourceUrl);
    assert.ok(isNumber(p.chinesePct) && p.chinesePct >= 0 && p.chinesePct <= 1);
    counts.chinese += 1;
    counts.chineseSum += p.chineseCount;
    if (p.chineseCount === 0) counts.chineseZero += 1;
  } else {
    assert.equal(p.chinesePct, null, `${p.name}: unavailable Chinese count must retain an unavailable percentage`);
  }
  assert.ok(p.children === null || (isNumber(p.children) && p.children >= 0 && p.children <= 1));
  assert.ok(p.population === null || (Number.isInteger(p.population) && p.population >= 0));
  assert.ok(p.householdSize === null || (isNumber(p.householdSize) && p.householdSize > 0));
  if (p.sourceUrl) assert.ok(p.sourceUrl.startsWith('https://www.calgary.ca/'));
}
assert.equal(counts.income, audit.incomeNumeric);
assert.equal(counts.chinese, audit.chineseNumeric);
assert.equal(counts.chineseZero, audit.chineseZeroNames.length);
assert.equal(counts.chineseSum, audit.sumPublishedCommunityChineseCounts);
assert.deepEqual(types, audit.classificationCounts);
assert.equal(basemap.type, 'FeatureCollection');
assert.equal(basemap.features.filter(f => f.properties.kind === 'road').length, basemapAudit.roadFeatures);
assert.equal(basemap.features.filter(f => f.properties.kind === 'water').length, basemapAudit.waterFeatures);
assert.equal(searchFeatures(communities.features, 'aspen woods')[0].properties.code, 'ASP');
assert.equal(searchFeatures(communities.features, 'AUB')[0].properties.code, 'AUB');

console.log(`PASS: original data SHA-256 matches; 313 unique Calgary areas; ${counts.income} income and ${counts.chinese} Chinese values; 7 published zeros; all anchors inside boundaries; metadata, sources and basemap valid.`);
