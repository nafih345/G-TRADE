// Run: npm run test:local-data-reset   (Node's built-in test runner)
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  key: (i) => Array.from(store.keys())[i] ?? null,
  get length() { return store.size; },
};

const { clearLocalDataIfReset, clearLocalDataIfScopeChanged } = await import('../localDataReset.js');

const seedCaches = () => {
  localStorage.setItem('optical_sales_invoices', '[{"id":"old"}]');
  localStorage.setItem('optical_wholesale_invoices', '[{"id":"old"}]');
  localStorage.setItem('optical_master_cache:t1:suppliers', '{"rows":[]}');
  localStorage.setItem('optical_app_settings', '{"store":"Other shop"}');
  localStorage.setItem('active_branch_id', 'b-old');
  localStorage.setItem('access_token', 'keep');
};

beforeEach(() => store.clear());

test('first database seen is recorded without clearing (cache may hold offline work)', () => {
  seedCaches();
  assert.equal(clearLocalDataIfScopeChanged('database', 'db-a'), false);
  assert.equal(localStorage.getItem('optical_sales_invoices'), '[{"id":"old"}]');
  assert.equal(clearLocalDataIfScopeChanged('database', 'db-a'), false);
});

test('a different database clears business and settings caches but keeps the session', () => {
  clearLocalDataIfScopeChanged('database', 'db-a');
  seedCaches();
  assert.equal(clearLocalDataIfScopeChanged('database', 'db-b'), true);
  for (const key of ['optical_sales_invoices', 'optical_wholesale_invoices', 'optical_master_cache:t1:suppliers',
    'optical_app_settings', 'active_branch_id']) {
    assert.equal(localStorage.getItem(key), null, key);
  }
  assert.equal(localStorage.getItem('access_token'), 'keep');
  assert.equal(clearLocalDataIfScopeChanged('database', 'db-b'), false, 'no reload loop');
});

test('tenant and database are tracked independently', () => {
  clearLocalDataIfScopeChanged('database', 'db-a');
  clearLocalDataIfScopeChanged('tenant', 1);
  seedCaches();
  assert.equal(clearLocalDataIfScopeChanged('tenant', 1), false);
  assert.equal(clearLocalDataIfScopeChanged('database', 'db-a'), false);
  assert.equal(clearLocalDataIfScopeChanged('tenant', 2), true);
  assert.equal(localStorage.getItem('optical_sales_invoices'), null);
  assert.equal(clearLocalDataIfScopeChanged('database', 'db-a'), false, 'tenant switch left the database scope alone');
});

test('missing values (older backend, token without claim) never clear anything', () => {
  clearLocalDataIfScopeChanged('database', 'db-a');
  seedCaches();
  assert.equal(clearLocalDataIfScopeChanged('database', null), false);
  assert.equal(clearLocalDataIfScopeChanged('database', undefined), false);
  assert.equal(clearLocalDataIfScopeChanged('tenant', null), false);
  assert.equal(localStorage.getItem('optical_sales_invoices'), '[{"id":"old"}]');
});

test('a wipe epoch still clears records but keeps settings and branch choice', () => {
  seedCaches();
  assert.equal(clearLocalDataIfReset('2026-10-22T10:17:53Z'), true);
  assert.equal(localStorage.getItem('optical_sales_invoices'), null);
  assert.equal(localStorage.getItem('optical_wholesale_invoices'), null);
  assert.equal(localStorage.getItem('optical_app_settings'), '{"store":"Other shop"}');
  assert.equal(localStorage.getItem('active_branch_id'), 'b-old');
  assert.equal(clearLocalDataIfReset('2026-10-22T10:17:53Z'), false);
});
