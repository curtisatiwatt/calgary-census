import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';

const root = new URL('../', import.meta.url);
const read = path => JSON.parse(fs.readFileSync(new URL(path, root), 'utf8'));
const integrity = read('geography-integrity.json');
const loaded = {};
for (const [path, expected] of Object.entries(integrity.files)) {
  const bytes = fs.readFileSync(new URL(path, root));
  assert.equal(bytes.length, expected.bytes, `${path}: audited snapshot size changed`);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), expected.sha256,
    `${path}: audited geography snapshot changed`);
  const data = JSON.parse(bytes);
  assert.equal(data.type, 'FeatureCollection');
  assert.ok(data.features.length > 0, `${path}: empty layer`);
  assert.equal(new Set(data.features.map(f => f.properties.id)).size, data.features.length,
    `${path}: feature IDs must be unique`);
  for (const feature of data.features) validateFeature(feature, path);
  loaded[path.split('/').at(-1)] = data.features;
}

function position(point, label) {
  assert.ok(Array.isArray(point) && point.length >= 2 && point.every(Number.isFinite), `${label}: invalid coordinate`);
  assert.ok(point[0] > -117 && point[0] < -112 && point[1] > 49 && point[1] < 53,
    `${label}: coordinate outside Calgary's regional context or wrong CRS`);
}
function line(points, label) {
  assert.ok(points.length >= 2, `${label}: line has fewer than two coordinates`);
  points.forEach(point => position(point, label));
}
function polygon(rings, label) {
  assert.ok(rings.length > 0);
  for (const ring of rings) {
    assert.ok(ring.length >= 4, `${label}: ring has fewer than four coordinates`);
    line(ring, label);
    assert.deepEqual(ring[0], ring.at(-1), `${label}: polygon ring is not closed`);
  }
}
function validateFeature(feature, path) {
  const p = feature.properties;
  assert.ok(p.id && p.name && p.kind && p.sourceUrl, `${path}: missing identity or provenance`);
  assert.equal(new URL(p.sourceUrl).protocol, 'https:');
  const { type, coordinates: c } = feature.geometry;
  const label = `${path}/${p.id}`;
  if (type === 'Point') position(c, label);
  else if (type === 'LineString') line(c, label);
  else if (type === 'MultiLineString') { assert.ok(c.length); c.forEach(points => line(points, label)); }
  else if (type === 'Polygon') polygon(c, label);
  else if (type === 'MultiPolygon') { assert.ok(c.length); c.forEach(rings => polygon(rings, label)); }
  else assert.fail(`${label}: unsupported geometry ${type}`);
  if (p.labelPoint) position(p.labelPoint, label);
}

const operating = loaded['ctrain-operating.geojson'];
const routes = operating.filter(f => f.properties.kind === 'transit_route');
const stations = operating.filter(f => f.properties.kind === 'transit_station');
assert.deepEqual(new Set(routes.map(f => f.properties.lineId)), new Set(['red', 'blue']));
for (const f of operating) assert.equal(f.properties.status, 'operating');
for (const f of stations) {
  assert.equal(f.geometry.type, 'Point');
  assert.ok(f.properties.lineIds.length > 0 && f.properties.lineIds.every(id => ['red', 'blue'].includes(id)));
}
assert.equal(stations.length, integrity.expected.operatingStations);
assert.equal(stations.filter(f => f.properties.lineIds.length === 2).length, integrity.expected.sharedStations);

const green = loaded['ctrain-green.geojson'];
for (const f of green) {
  assert.ok(['construction', 'planned'].includes(f.properties.status), 'Green Line must never appear operational');
  assert.ok(f.properties.kind === 'transit_station'
    ? f.properties.lineIds.length === 1 && f.properties.lineIds[0] === 'green'
    : f.properties.kind === 'transit_route' && f.properties.lineId === 'green');
}
assert.equal(green.filter(f => f.properties.kind === 'transit_station').length, integrity.expected.greenStations);
const context = loaded['geographic-context.geojson'];
assert.deepEqual(new Set(context.map(f => f.properties.kind)), new Set(['railway', 'airport', 'park', 'reserve']));
assert.ok(context.some(f => f.properties.kind === 'reserve' && /145/.test(f.properties.name)), 'Tsuut’ina 145 context is missing');
assert.ok(context.some(f => f.properties.kind === 'airport'), 'Calgary airport context is missing');
console.log(`PASS: audited official geography; ${stations.length} operating CTrain stations, ${integrity.expected.greenStations} non-operating Green Line stations; railways, airport, parks and reserves; valid regional coordinates and source links.`);
