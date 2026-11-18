import test from 'node:test';
import assert from 'node:assert/strict';
import { createFirstHint, HINT_STORAGE_KEY } from '../src/first-hint.js';

function fakes(saved = {}) {
  const store = new Map(Object.entries(saved));
  const listeners = new Map();
  return {
    node: { hidden: true },
    storage: { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) },
    store,
    root: { addEventListener: (type, listener) => listeners.set(type, listener) },
    fire: (type, inControls) => listeners.get(type)({ target: { closest: () => (inControls ? {} : null) } }),
  };
}

test('the hint shows on a first visit, leaves at the first action and is remembered', () => {
  const f = fakes();
  const hint = createFirstHint(f.node, { storage: f.storage, root: f.root });
  assert.equal(f.node.hidden, true);
  hint.show();
  assert.equal(f.node.hidden, false);
  assert.equal(f.store.has(HINT_STORAGE_KEY), false);
  hint.dismiss();
  assert.equal(f.node.hidden, true);
  assert.equal(f.store.get(HINT_STORAGE_KEY), '1');
  // Gone for good: neither this page nor a later visit shows it again.
  hint.show();
  assert.equal(f.node.hidden, true);
  const later = fakes({ [HINT_STORAGE_KEY]: '1' });
  createFirstHint(later.node, { storage: later.storage, root: later.root }).show();
  assert.equal(later.node.hidden, true);
});

test('using the interface around the map dismisses the hint; the map itself does not', () => {
  const f = fakes();
  const hint = createFirstHint(f.node, { storage: f.storage, root: f.root });
  hint.show();
  f.fire('pointerdown', false);
  assert.equal(hint.isShowing(), true);
  f.fire('pointerdown', true);
  assert.equal(hint.isShowing(), false);
  assert.equal(f.store.get(HINT_STORAGE_KEY), '1');
});

test('dismissing a hint that never showed records nothing, and blocked storage is survived', () => {
  const f = fakes();
  createFirstHint(f.node, { storage: f.storage, root: f.root }).dismiss();
  assert.equal(f.store.has(HINT_STORAGE_KEY), false);
  const blocked = {
    getItem() {
      throw new Error('blocked');
    },
    setItem() {
      throw new Error('blocked');
    },
  };
  const hint = createFirstHint(f.node, { storage: blocked, root: f.root });
  hint.show();
  assert.equal(f.node.hidden, false);
  hint.dismiss();
  assert.equal(f.node.hidden, true);
});
