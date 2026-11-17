import test from 'node:test';
import assert from 'node:assert/strict';
import {
  colorFor,
  searchFeatures,
  hashCode,
  summarize,
  safeUrl,
  parseHashState,
  buildHashState,
  INCOME_BINS,
  MAP_GROUND,
  LABEL_INK,
  blendColor,
  displayedFill,
  contrastRatio,
  labelInk,
} from '../src/map-utils.js';
import { POPULATION_BINS } from '../src/population-utils.js';

test('income boundaries stay separate from unavailable values', () => {
  assert.equal(colorFor(null), '#d6dcd9');
  assert.equal(colorFor(undefined), '#d6dcd9');
  assert.equal(colorFor(59999), '#3979b5');
  assert.equal(colorFor(60000), '#82b8d6');
  assert.equal(colorFor(97999), '#d8e5cb');
  assert.equal(colorFor(98000), '#f1d66f');
  assert.equal(colorFor(200000), '#b83f42');
});

const features = [
  { properties: { code: 'ASP', name: 'Aspen Woods', income: 182000 } },
  { properties: { code: 'TEST', name: 'Château Test', aliases: ['Former Name'], income: null } },
];

test('search supports names, diacritics, renamed neighbourhoods and exact codes', () => {
  assert.equal(searchFeatures(features, 'aspen')[0].properties.code, 'ASP');
  assert.equal(searchFeatures(features, 'chateau test')[0].properties.code, 'TEST');
  assert.equal(searchFeatures(features, 'former name')[0].properties.code, 'TEST');
  assert.equal(searchFeatures(features, 'ASP')[0].properties.code, 'ASP');
  assert.deepEqual(searchFeatures(features, ''), []);
});

test('coverage counts only published income values; invalid deep links do not crash the app', () => {
  assert.equal(summarize(features).income, 1);
  assert.equal(hashCode('#ASP', features), 'ASP');
  assert.equal(hashCode('#%E0%A4%A', features), null);
  assert.equal(hashCode('#unrecognized', features), null);
});

test('source links cannot execute script or use insecure protocols', () => {
  assert.equal(safeUrl('javascript:alert(1)'), null);
  assert.equal(safeUrl('http://example.com'), null);
  assert.equal(safeUrl('https://www.calgary.ca'), 'https://www.calgary.ca/');
});

test('view state round-trips through the URL hash and ignores unknown values', () => {
  const features = [{ properties: { code: 'ASP' } }, { properties: { code: 'BLN' } }];
  const ids = ['chinese', 'south_asian', 'black'];
  const view = {
    code: 'ASP',
    view: 'distribution',
    groups: ['chinese', 'south_asian'],
    compare: 'south_asian',
    income: true,
    transit: true,
    landmarks: false,
    roads: true,
    labels: true,
  };
  const hash = buildHashState(view);
  assert.equal(hash, '#ASP?view=compare&groups=chinese,south_asian&compare=south_asian&income=1&layers=transit');
  assert.deepEqual(parseHashState(hash, features, ids), view);
  // The original bare-code links keep working, and stale or hostile values are dropped.
  assert.deepEqual(parseHashState('#BLN', features, ids), {
    code: 'BLN',
    groups: [],
    compare: null,
    view: 'composition',
    income: false,
    transit: false,
    landmarks: false,
    roads: true,
    labels: true,
  });
  const messy = parseHashState(
    '#nope?view=compare&groups=chinese,<script>,chinese&compare=black&layers=roads,landmarks',
    features,
    ids,
  );
  assert.deepEqual(messy, {
    code: null,
    groups: ['chinese'],
    compare: null,
    view: 'distribution',
    income: false,
    transit: false,
    landmarks: true,
    roads: true,
    labels: true,
  });
  assert.equal(hashCode('#ASP?groups=chinese', features), 'ASP');
  assert.equal(buildHashState({}), '');
  assert.equal(buildHashState({ groups: ['black'] }), '#?groups=black');
});

test('the default layers are kept in the link only when they are switched off', () => {
  assert.equal(buildHashState({ code: 'ASP', roads: true, labels: true }), '#ASP');
  assert.equal(buildHashState({ code: 'ASP', roads: false }), '#ASP?hide=roads');
  const hash = buildHashState({ transit: true, roads: false, labels: false });
  assert.equal(hash, '#?layers=transit&hide=roads,labels');
  const parsed = parseHashState(hash, features, []);
  assert.equal(parsed.roads, false);
  assert.equal(parsed.labels, false);
  assert.equal(parsed.transit, true);
  assert.equal(parsed.code, null);
  // Unknown names are ignored; "layers=roads" in an older link never hid anything.
  const odd = parseHashState('#ASP?layers=roads&hide=transit,nothing', features, []);
  assert.deepEqual([odd.roads, odd.labels, odd.transit], [true, true, false]);
});

test('blendColor paints a translucent colour over an opaque ground', () => {
  assert.equal(blendColor('#000000', '#ffffff', 0.5), '#808080');
  assert.equal(blendColor('#095746', '#edf1e9', 1), '#095746');
  assert.equal(blendColor('#095746', '#edf1e9', 0), '#edf1e9');
  // The deepest light-theme bin is far paler on the map than its raw colour.
  assert.equal(displayedFill('population', '#095746', false), '#5b8e81');
  assert.equal(displayedFill('population', '#88d1b0', true), blendColor('#88d1b0', MAP_GROUND.dark, 0.92));
});

test('contrast follows the WCAG definition and picks the more readable ink', () => {
  assert.equal(contrastRatio('#000000', '#ffffff'), 21);
  assert.equal(contrastRatio('#777777', '#777777'), 1);
  assert.equal(labelInk('#ffffff'), 'dark');
  assert.equal(labelInk('#000000'), 'light');
  assert.equal(labelInk(MAP_GROUND.light), 'dark');
  assert.equal(labelInk(MAP_GROUND.dark), 'light');
});

test('every scale step leaves a community name readable (4.5:1) in one of the two inks', () => {
  const fills = [];
  for (const dark of [false, true]) {
    for (const bin of POPULATION_BINS)
      fills.push([`population ${bin.label}`, dark, displayedFill('population', dark ? bin.dark : bin.color, dark)]);
    for (const bin of INCOME_BINS) fills.push([`income ${bin.label}`, dark, displayedFill('income', bin.color, dark)]);
    fills.push(['no data', dark, MAP_GROUND[dark ? 'dark' : 'light']]);
  }
  for (const [name, dark, fill] of fills) {
    const ratio = contrastRatio(fill, LABEL_INK[labelInk(fill)]);
    assert.ok(ratio >= 4.5, `${name} (${dark ? 'dark' : 'light'} theme, ${fill}) only reaches ${ratio.toFixed(2)}:1`);
  }
  // White names on the two brightest dark-theme steps were the original defect (1.9:1 and 3:1).
  const brightest = displayedFill('population', POPULATION_BINS.at(-1).dark, true);
  assert.ok(contrastRatio(brightest, LABEL_INK.light) < 2);
  assert.equal(labelInk(brightest), 'dark');
});

test('the map ground in the stylesheets matches the one legends and labels are computed from', async () => {
  const { readFile } = await import('node:fs/promises');
  const read = name => readFile(new URL(`../src/styles/${name}`, import.meta.url), 'utf8');
  const [map, base] = await Promise.all([read('map.css'), read('base.css')]);
  assert.match(map, new RegExp(`\\.leaflet-container \\{[^}]*background: ${MAP_GROUND.light};`));
  assert.match(
    base,
    new RegExp(`html\\[data-theme='dark'\\] \\.leaflet-container,[^}]*\\{\\s*background: ${MAP_GROUND.dark};`),
  );
});
