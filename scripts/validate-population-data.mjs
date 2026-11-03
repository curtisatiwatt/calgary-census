import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { POPULATION_GROUP_IDS, compositionSegments, populationShare } from '../src/population-utils.js';

const root = new URL('../', import.meta.url);
const read = path => JSON.parse(fs.readFileSync(new URL(path, root), 'utf8'));
const data = read('public/data/population-groups.json');
const features = read('public/data/communities.geojson').features;
const byCode = new Map(features.map(f => [f.properties.code, f.properties]));
const metadata = read('public/data/metadata.json');
const audit = read('population-data-audit.json');
assert.equal(data.schemaVersion, 1);
assert.equal(data.censusYear, 2021);
assert.equal(data.variable, 'visible_minority');
assert.equal(data.denominatorLabel, '私人住户人口');
assert.deepEqual(new Set(data.groups.map(g => g.id)), new Set(POPULATION_GROUP_IDS));
assert.equal(data.groups.length, 13);
assert.ok(data.groups.every(g => g.name && g.label));
assert.ok(!/白人|欧洲|white|european/i.test(data.groups.find(g => g.id === 'not_visible_minority').label));
assert.deepEqual(data.defaultGroupIds, ['south_asian', 'chinese', 'filipino', 'black', 'latin_american']);
const topFive = Object.entries(data.city.counts).filter(([id]) => id !== 'not_visible_minority')
  .sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id]) => id);
assert.deepEqual(data.defaultGroupIds, topFive);

function validateRecord(record, label) {
  assert.ok(Number.isInteger(record.population) && record.population > 0, `${label}: missing denominator`);
  assert.deepEqual(new Set(Object.keys(record.counts)), new Set(POPULATION_GROUP_IDS), `${label}: missing or extra category`);
  assert.deepEqual(new Set(Object.keys(record.publishedPct)), new Set(POPULATION_GROUP_IDS));
  for (const id of POPULATION_GROUP_IDS) {
    const count = record.counts[id];
    const pct = record.publishedPct[id];
    assert.ok(Number.isInteger(count) && count >= 0 && count % 5 === 0 && count <= record.population,
      `${label}/${id}: invalid published count`);
    assert.ok(Number.isFinite(pct) && pct >= 0 && pct <= 1, `${label}/${id}: invalid published percent`);
    assert.ok(Math.abs(pct - populationShare(record, id)) <= 0.0101,
      `${label}/${id}: printed percent is inconsistent with count and denominator`);
  }
  const segments = compositionSegments(record, POPULATION_GROUP_IDS);
  assert.ok(Math.abs(segments.reduce((sum, item) => sum + item.share, 0) - 1) < 1e-9);
  assert.equal(segments.some(item => item.id === 'other'), false);
}

validateRecord(data.city, 'Calgary');
assert.equal(data.city.population, 1291790);
assert.equal(data.city.counts.chinese, metadata.cityChineseCount);
assert.equal(data.city.publishedPct.chinese, metadata.cityChinesePct);
assert.equal(Object.keys(data.communities).length, 206);
let zeros = 0;
for (const [code, record] of Object.entries(data.communities)) {
  const original = byCode.get(code);
  assert.ok(original, `${code}: no community boundary`);
  validateRecord(record, code);
  assert.equal(record.sourceUrl, original.sourceUrl, `${code}: incorrect source join`);
  assert.equal(record.counts.chinese, original.chineseCount, `${code}: Chinese source count changed`);
  assert.equal(record.publishedPct.chinese, original.chinesePct, `${code}: Chinese printed percent changed`);
  if (record.counts.chinese === 0) zeros += 1;
}
for (const original of byCode.values()) {
  assert.equal(Boolean(data.communities[original.code]), original.chineseCount !== null,
    `${original.code}: population availability changed`);
}
assert.equal(zeros, 7);
const panorama = data.communities.PAN;
assert.equal(panorama.population, 25535);
assert.equal(panorama.counts.chinese, 6665);
assert.equal(panorama.counts.south_asian, 4320);
const bytes = fs.readFileSync(new URL('public/data/population-groups.json', root));
const digest = createHash('sha256').update(bytes).digest('hex');
assert.equal(digest, audit.outputSha256, 'Population snapshot differs from its extraction audit');
assert.equal(audit.coverage.withAll13Groups, Object.keys(data.communities).length);
const sumGap = record => Object.values(record.counts).reduce((sum, count) => sum + count, 0) - record.population;
assert.equal(sumGap(data.city), audit.checks.cityCategorySumMinusDenominator);
const gaps = Object.fromEntries(Object.entries(data.communities)
  .map(([code, record]) => [code, sumGap(record)]).filter(([, gap]) => gap !== 0));
assert.deepEqual(gaps, audit.checks.communityCategorySumMinusDenominator,
  'Preserve and audit source-table differences rather than silently correcting counts');
console.log(`PASS: 13 population categories across 206 community profiles; original Chinese counts/percentages and all 7 zeros preserved; shared city baseline; SHA-256 ${digest}.`);
