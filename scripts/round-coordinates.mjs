/**
 * Round published GeoJSON geometry to a fixed number of decimals.
 *
 *   node scripts/round-coordinates.mjs [--decimals 5] public/data/a.geojson ...
 *
 * Five decimals is about 1.1 m north-south and 0.7 m east-west at Calgary's
 * latitude, below one screen pixel at the map's maximum zoom (17). Only
 * geometry coordinates change: properties (including centroid and labelPoint
 * anchors) are untouched. Consecutive vertices that become identical are
 * merged; rings stay closed. Shared community borders round identically, so
 * neighbouring boundaries stay coincident.
 *
 * The script verifies every file before writing it and prints the input and
 * output fingerprints for data-integrity.json / geography-integrity.json.
 * Run `npm run check` afterwards: it re-checks anchors, counts and fingerprints.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';

const args = process.argv.slice(2);
const decimalsAt = args.indexOf('--decimals');
const decimals = decimalsAt >= 0 ? Number(args.splice(decimalsAt, 2)[1]) : 5;
assert.ok(Number.isInteger(decimals) && decimals >= 4 && decimals <= 8, 'decimals must be an integer from 4 to 8');
const scale = 10 ** decimals;
const tolerance = 0.5 / scale + 1e-12;
const round = value => Math.round(value * scale) / scale;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

let droppedParts = 0;
/** Returns null when a ring or line collapses; callers decide whether that may be dropped. */
function roundPositions(points, closed, label, optional = false) {
  const result = [];
  for (const point of points) {
    const next = [round(point[0]), round(point[1]), ...point.slice(2)];
    const last = result.at(-1);
    if (last && last[0] === next[0] && last[1] === next[1]) continue;
    result.push(next);
  }
  if (closed) {
    const first = result[0];
    const last = result.at(-1);
    if (first[0] !== last[0] || first[1] !== last[1]) result.push([...first]);
  }
  if (result.length >= (closed ? 4 : 2)) return result;
  // A sub-metre fragment of a multi-part geometry (or a hole) is invisible at
  // any zoom; dropping it is reported. A whole line or outer ring must survive.
  assert.ok(optional, `${label}: ${closed ? 'ring' : 'line'} collapsed after rounding`);
  droppedParts++;
  return null;
}

function roundGeometry(geometry, label) {
  const { type, coordinates: c } = geometry;
  const parts = values => {
    const kept = values.filter(Boolean);
    assert.ok(kept.length, `${label}: every part collapsed after rounding`);
    return kept;
  };
  const rings = (polygon, optional = false) => {
    const outer = roundPositions(polygon[0], true, `${label} outer ring`, optional);
    if (!outer) return null;
    return [
      outer,
      ...polygon
        .slice(1)
        .map((ring, index) => roundPositions(ring, true, `${label} hole ${index}`, true))
        .filter(Boolean),
    ];
  };
  const coordinates =
    type === 'Point'
      ? [round(c[0]), round(c[1]), ...c.slice(2)]
      : type === 'MultiPoint'
        ? c.map(point => [round(point[0]), round(point[1]), ...point.slice(2)])
        : type === 'LineString'
          ? roundPositions(c, false, label)
          : type === 'MultiLineString'
            ? parts(c.map((line, index) => roundPositions(line, false, `${label} part ${index}`, true)))
            : type === 'Polygon'
              ? rings(c)
              : type === 'MultiPolygon'
                ? parts(c.map(polygon => rings(polygon, true)))
                : assert.fail(`${label}: unsupported geometry ${type}`);
  return { ...geometry, coordinates };
}

/** Every output position must be an input position rounded, in the same order. */
function verify(before, after, label) {
  const positions = (geometry, out = []) => {
    const walk = value => (typeof value[0] === 'number' ? out.push(value) : value.forEach(walk));
    walk(geometry.coordinates);
    return out;
  };
  assert.equal(after.type, before.type, `${label}: geometry type changed`);
  const source = positions(before);
  const result = positions(after);
  let cursor = 0;
  for (const point of result) {
    while (
      cursor < source.length &&
      (Math.abs(source[cursor][0] - point[0]) > tolerance || Math.abs(source[cursor][1] - point[1]) > tolerance)
    )
      cursor++;
    assert.ok(cursor < source.length, `${label}: output vertex does not follow a nearby input vertex`);
  }
}

for (const path of args) {
  const input = fs.readFileSync(path);
  const data = JSON.parse(input);
  assert.equal(data.type, 'FeatureCollection', `${path}: not a FeatureCollection`);
  droppedParts = 0;
  const features = data.features.map((feature, index) => {
    const label = `${path} feature ${feature.properties?.id ?? feature.properties?.code ?? index}`;
    const geometry = roundGeometry(feature.geometry, label);
    verify(feature.geometry, geometry, label);
    return { ...feature, geometry };
  });
  const result = { ...data, features };
  data.features.forEach((feature, index) => assert.deepEqual(features[index].properties, feature.properties));
  const output = Buffer.from(JSON.stringify(result) + (input.at(-1) === 10 ? '\n' : ''));
  fs.writeFileSync(path, output);
  console.log(
    JSON.stringify({
      path,
      decimals,
      input: { bytes: input.length, sha256: sha(input) },
      output: { bytes: output.length, sha256: sha(output) },
      droppedParts,
    }),
  );
}
