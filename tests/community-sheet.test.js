import test from 'node:test';
import assert from 'node:assert/strict';
import { clampSheetHeight, releaseSheetSnap, sheetHeights, stepSheetSnap } from '../src/community-sheet-utils.js';

const heights = sheetHeights(852, 150);
const release = (snap, height, velocity = 0) => releaseSheetSnap({ snap, startHeight: heights[snap], height, velocity, heights });

test('sheet has a natural summary, half-screen stop and near-full stop', () => {
  assert.deepEqual(heights, { peek: 150, half: 426, full: 784 });
  assert.deepEqual(sheetHeights(667, 178), { peek: 178, half: 334, full: 614 });
});

test('large type and short landscape screens never put a stop outside the viewport', () => {
  for (const viewport of [240, 375, 667, 852]) {
    for (const header of [100, 180, 330, 500]) {
      const stops = sheetHeights(viewport, header, 24);
      assert.ok(stops.peek <= stops.half && stops.half <= stops.full);
      assert.ok(stops.full <= viewport - 32);
      assert.equal(clampSheetHeight(-100, stops), stops.peek);
      assert.equal(clampSheetHeight(viewport + 500, stops), stops.full);
    }
  }
  assert.ok(sheetHeights(667, 350).half >= 414, 'enlarged header leaves room for content');
});

test('deliberate short swipes move one stop; small taps do not resize', () => {
  assert.equal(release('half', heights.half + 40), 'full');
  assert.equal(release('half', heights.half - 40), 'peek');
  assert.equal(release('full', heights.full - 40), 'half');
  assert.equal(release('peek', heights.peek + 40), 'half');
  assert.equal(release('half', heights.half + 5, 1.5), 'half');
});

test('long drags can cross both stops, while velocity makes a flick responsive', () => {
  assert.equal(release('peek', 760), 'full');
  assert.equal(release('full', 160), 'peek');
  assert.equal(release('half', heights.half + 14, .8), 'full');
  assert.equal(release('half', heights.half - 14, -.8), 'peek');
  assert.equal(release('peek', heights.peek - 60, -2), 'peek', 'a swipe never dismisses a selected community');
});

test('keyboard stepping clamps to visible stops', () => {
  assert.equal(stepSheetSnap('peek', -1), 'peek');
  assert.equal(stepSheetSnap('peek', 1), 'half');
  assert.equal(stepSheetSnap('half', 1), 'full');
  assert.equal(stepSheetSnap('full', 1), 'full');
  assert.equal(stepSheetSnap('full', -1), 'half');
});
