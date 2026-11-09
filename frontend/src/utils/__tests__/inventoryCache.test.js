// Run: node --test src/utils/__tests__/inventoryCache.test.js   (Node's built-in test runner)
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const { reconcileLocalInventory, LOCAL_INVENTORY_KEY } = await import('../inventoryCache.js');
const cached = () => JSON.parse(localStorage.getItem(LOCAL_INVENTORY_KEY));

beforeEach(() => store.clear());

test('drops cached products the server does not have and takes the server stock', () => {
  localStorage.setItem(LOCAL_INVENTORY_KEY, JSON.stringify([
    { id: 'a', name: 'Kept', stock: 10, image: 'x.png' },
    { id: 'other-account', name: 'Stale', stock: 50 },
    { id: '1731150000000', name: 'Browser-only', stock: 4 },
  ]));
  const out = reconcileLocalInventory([{ id: 'a', stock: 8 }, { id: 'b', stock: 3 }]);
  assert.deepEqual(out, [{ id: 'a', name: 'Kept', stock: 8, image: 'x.png' }]);
  assert.deepEqual(cached(), out);
});

test('an empty server list empties the cache; a failed fetch (null) leaves it', () => {
  localStorage.setItem(LOCAL_INVENTORY_KEY, JSON.stringify([{ id: 'a', stock: 1 }]));
  assert.equal(reconcileLocalInventory(null), null);
  assert.equal(cached().length, 1);
  assert.deepEqual(reconcileLocalInventory([]), []);
  assert.deepEqual(cached(), []);
});

test('unchanged cache is not rewritten', () => {
  localStorage.setItem(LOCAL_INVENTORY_KEY, '[{"id":"a","stock":2}]');
  reconcileLocalInventory([{ id: 'a', stock: 2 }]);
  assert.equal(localStorage.getItem(LOCAL_INVENTORY_KEY), '[{"id":"a","stock":2}]');
});
