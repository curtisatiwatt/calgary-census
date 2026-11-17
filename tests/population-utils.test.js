import test from 'node:test';
import assert from 'node:assert/strict';
import {
  POPULATION_GROUP_IDS,
  POPULATION_BINS,
  POPULATION_NO_DATA_COLOR,
  POPULATION_GROUP_COLORS,
  COMPOSITION_OTHER_COLOR,
  populationShare,
  compositionSegments,
  populationColor,
  donutSvg,
} from '../src/population-utils.js';

function record(overrides = {}, population = 1000) {
  return {
    population,
    counts: { ...Object.fromEntries(POPULATION_GROUP_IDS.map(id => [id, 0])), ...overrides },
  };
}

test('exact shares use the table denominator, preserve zero and distinguish missing data', () => {
  const data = record({ chinese: 85, not_visible_minority: 915 });
  data.publishedPct = { chinese: 0.09 };
  assert.equal(populationShare(data, 'chinese'), 0.085);
  assert.equal(populationShare(data, 'south_asian'), 0);
  assert.equal(populationShare(data, 'invented_category'), null);
  assert.equal(populationShare(null, 'chinese'), null);
  assert.equal(populationShare({ ...data, population: 0 }, 'chinese'), null);
  assert.equal(populationShare({ ...data, population: '1000' }, 'chinese'), null);
  delete data.counts.chinese;
  assert.equal(populationShare(data, 'chinese'), null);
});

test('rounding affects only the ring: selected and unselected counts remain intact', () => {
  const data = record({ chinese: 100, south_asian: 205, not_visible_minority: 700 });
  const segments = compositionSegments(data, ['chinese', 'south_asian', 'chinese']);
  assert.deepEqual(
    segments.map(({ id, count }) => ({ id, count })),
    [
      { id: 'chinese', count: 100 },
      { id: 'south_asian', count: 205 },
      { id: 'other', count: 700 },
    ],
  );
  assert.equal(segments[0].share, 100 / 1005);
  assert.ok(Math.abs(segments.reduce((sum, segment) => sum + segment.share, 0) - 1) < 1e-12);
  assert.equal(populationShare(data, 'chinese'), 0.1);
  assert.equal(data.counts.not_visible_minority, 700);
});

test('under-reported categories leave an explicit gap instead of inflating known group shares', () => {
  const data = record({ chinese: 100, not_visible_minority: 320 }, 460);
  const selected = compositionSegments(data, ['chinese']);
  assert.deepEqual(selected, [
    { id: 'chinese', count: 100, share: 100 / 460 },
    { id: 'other', count: 320, share: 320 / 460 },
    { id: 'statistical_gap', count: 40, share: 40 / 460 },
  ]);
  assert.equal(selected[0].share, populationShare(data, 'chinese'));
  assert.ok(Math.abs(selected.reduce((sum, segment) => sum + segment.share, 0) - 1) < 1e-12);
  const all = compositionSegments(data, POPULATION_GROUP_IDS);
  assert.equal(
    all.some(segment => segment.id === 'other'),
    false,
  );
  assert.deepEqual(all.at(-1), { id: 'statistical_gap', count: 40, share: 40 / 460 });
  const svg = donutSvg(data, ['chinese'], { chinese: '#C084FC' });
  // The gap is unfilled (no solid stroke) so it follows the light or dark ring background.
  assert.doesNotMatch(svg, /stroke="#fff(?:fff)?"/i);
  assert.match(svg, /class="donut-gap"[^>]*stroke-dasharray="1\.2 2\.2"/);
  assert.equal((svg.match(/<circle cx="20" cy="20" r="14"/g) || []).length, 2);
});

test('missing categories cannot be quietly included as zero or as the remainder', () => {
  const complete = record({ chinese: 100, not_visible_minority: 900 });
  for (const invalid of [undefined, null, NaN, -5, '0']) {
    const partial = { ...complete, counts: { ...complete.counts, korean: invalid } };
    assert.deepEqual(compositionSegments(partial, ['chinese']), []);
    assert.equal(donutSvg(partial, ['chinese'], { chinese: '#6a5acd' }), '');
  }
  assert.deepEqual(compositionSegments({ ...complete, population: null }, ['chinese']), []);
  assert.deepEqual(compositionSegments(record(), ['chinese']), []);
});

test('selection does not redefine percentages and empty selection draws no rings', () => {
  const data = record({ chinese: 100, south_asian: 200, not_visible_minority: 700 });
  const one = compositionSegments(data, ['chinese']);
  const two = compositionSegments(data, ['chinese', 'south_asian']);
  assert.equal(one[0].share, two[0].share);
  assert.deepEqual(one[1], { id: 'other', count: 900, share: 0.9 });
  assert.deepEqual(compositionSegments(data, []), []);
  assert.deepEqual(compositionSegments(data, ['not_a_real_group']), []);
  assert.equal(donutSvg(data, []), '');
  assert.deepEqual(compositionSegments(data, ['korean']), [{ id: 'other', count: 1000, share: 1 }]);
  const all = compositionSegments(data, POPULATION_GROUP_IDS);
  assert.equal(
    all.some(segment => segment.id === 'other'),
    false,
  );
  assert.equal(all.length, 3);
});

test('all heat maps use the same absolute bins, including boundaries and unavailable data', () => {
  assert.equal(populationColor(0), POPULATION_BINS[0].color);
  assert.notEqual(populationColor(0), POPULATION_NO_DATA_COLOR);
  assert.equal(populationColor(0.0499), POPULATION_BINS[0].color);
  assert.equal(populationColor(0.05), POPULATION_BINS[1].color);
  assert.equal(populationColor(0.1), POPULATION_BINS[2].color);
  assert.equal(populationColor(0.2), POPULATION_BINS[3].color);
  assert.equal(populationColor(0.3), POPULATION_BINS[4].color);
  assert.equal(populationColor(0.4), POPULATION_BINS[5].color);
  assert.equal(populationColor(0.75), populationColor(0.95));
  for (const invalid of [undefined, null, NaN, -0.1, '0.2']) {
    assert.equal(populationColor(invalid), POPULATION_NO_DATA_COLOR);
  }
  // Equal shares give the same shade despite different community sizes.
  assert.equal(
    populationColor(populationShare(record({ chinese: 200 }), 'chinese')),
    populationColor(populationShare(record({ chinese: 400 }, 2000), 'chinese')),
  );
});

test('donut SVG permits only safe colors and numeric dimensions; no source labels are inserted', () => {
  const data = record({ chinese: 100, not_visible_minority: 900 });
  const svg = donutSvg(data, ['chinese'], { chinese: '#c084fc" onload="alert(1)' }, '<script>');
  assert.match(svg, /width="32"/);
  assert.match(svg, /aria-hidden="true"/);
  assert.doesNotMatch(svg, /onload|alert|script|chinese/);
  assert.match(svg, /stroke="#4c7870"/);
  assert.match(donutSvg(data, ['chinese'], { chinese: '#C084FC' }, 24), /stroke="#C084FC"/);
});

/** CIEDE2000 colour difference between two #rrggbb colours. */
function colorDifference(first, second) {
  const lab = hex => {
    const [r, g, b] = [1, 3, 5]
      .map(index => parseInt(hex.slice(index, index + 2), 16) / 255)
      .map(c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    const f = value => (value > 0.008856 ? Math.cbrt(value) : 7.787 * value + 16 / 116);
    const x = f((0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047);
    const y = f(0.2126729 * r + 0.7151522 * g + 0.072175 * b);
    const z = f((0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883);
    return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
  };
  const radians = degrees => (degrees * Math.PI) / 180;
  const hue = (b, a) => ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
  const [l1, a1, b1] = lab(first);
  const [l2, a2, b2] = lab(second);
  const meanChroma = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2;
  const g = 0.5 * (1 - Math.sqrt(meanChroma ** 7 / (meanChroma ** 7 + 25 ** 7)));
  const [a1p, a2p] = [a1 * (1 + g), a2 * (1 + g)];
  const [c1, c2] = [Math.hypot(a1p, b1), Math.hypot(a2p, b2)];
  const [h1, h2] = [c1 ? hue(b1, a1p) : 0, c2 ? hue(b2, a2p) : 0];
  let hueGap = c1 * c2 ? h2 - h1 : 0;
  if (hueGap > 180) hueGap -= 360;
  else if (hueGap < -180) hueGap += 360;
  const deltaHue = 2 * Math.sqrt(c1 * c2) * Math.sin(radians(hueGap / 2));
  const meanLight = (l1 + l2) / 2;
  const meanC = (c1 + c2) / 2;
  let meanHue = h1 + h2;
  if (c1 * c2) meanHue = Math.abs(h1 - h2) <= 180 ? meanHue / 2 : (meanHue + (meanHue < 360 ? 360 : -360)) / 2;
  const t =
    1 -
    0.17 * Math.cos(radians(meanHue - 30)) +
    0.24 * Math.cos(radians(2 * meanHue)) +
    0.32 * Math.cos(radians(3 * meanHue + 6)) -
    0.2 * Math.cos(radians(4 * meanHue - 63));
  const sl = 1 + (0.015 * (meanLight - 50) ** 2) / Math.sqrt(20 + (meanLight - 50) ** 2);
  const sc = 1 + 0.045 * meanC;
  const sh = 1 + 0.015 * meanC * t;
  const rotation =
    -Math.sin(radians(60 * Math.exp(-(((meanHue - 275) / 25) ** 2)))) *
    2 *
    Math.sqrt(meanC ** 7 / (meanC ** 7 + 25 ** 7));
  const [dl, dc, dh] = [(l2 - l1) / sl, (c2 - c1) / sc, deltaHue / sh];
  return Math.sqrt(dl ** 2 + dc ** 2 + dh ** 2 + rotation * dc * dh);
}

test('every group colour is defined and clearly apart from the "other groups" grey and from each other', () => {
  assert.equal(colorDifference('#ffffff', '#ffffff'), 0);
  assert.ok(colorDifference('#000000', '#ffffff') > 99);
  // The colour this replaced: indistinguishable from the grey once both sat side by side in a ring.
  assert.ok(colorDifference('#c2c9bd', COMPOSITION_OTHER_COLOR) < 3);
  assert.deepEqual(Object.keys(POPULATION_GROUP_COLORS), [...POPULATION_GROUP_IDS]);
  const entries = Object.entries(POPULATION_GROUP_COLORS);
  for (const [id, color] of entries) {
    assert.match(color, /^#[0-9a-f]{6}$/, id);
    // The old not_visible_minority colour sat 1.9 away from the grey and merged with it in the ring.
    assert.ok(colorDifference(color, COMPOSITION_OTHER_COLOR) >= 12, `${id} is too close to the "other groups" grey`);
  }
  for (const [index, [id, color]] of entries.entries())
    for (const [otherId, otherColor] of entries.slice(index + 1))
      assert.ok(colorDifference(color, otherColor) >= 6, `${id} and ${otherId} are too similar`);
});
