// Run: npm run test:master-cache   (Node's built-in test runner)
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

const cache = await import('../masterDataCache.js');
const {
  __setMasterFetcher, loadMaster, getMasterSnapshot, invalidateMaster, subscribeMaster,
  clearMasterCache, masterForUrl, MASTER_CACHE_PREFIX,
} = cache;

const token = (tenantId) => `x.${Buffer.from(JSON.stringify({ tenant_id: tenantId })).toString('base64url')}.y`;
let calls;
const fetcher = (rows) => async (url) => { calls.push(url); return typeof rows === 'function' ? rows(url) : rows; };

beforeEach(() => {
  clearMasterCache();
  store.clear();
  calls = [];
  localStorage.setItem('access_token', token(1));
});

test('concurrent loads share one request and fresh data is reused', async () => {
  __setMasterFetcher(fetcher([{ id: 1, name: 'Acme' }]));
  const [a, b] = await Promise.all([loadMaster('suppliers'), loadMaster('suppliers')]);
  assert.deepEqual(a, [{ id: 1, name: 'Acme' }]);
  assert.equal(a, b);
  await loadMaster('suppliers');
  assert.equal(calls.length, 1);
  await loadMaster('suppliers', { force: true });
  assert.equal(calls.length, 2);
});

test('a copy restored from storage paints at once and still revalidates', async () => {
  __setMasterFetcher(fetcher([{ id: 1, name: 'Old' }]));
  await loadMaster('brands');
  clearMasterCache(); // simulate a reload: memory gone…
  localStorage.setItem(`${MASTER_CACHE_PREFIX}t1:brands`, JSON.stringify({ rows: [{ id: 1, name: 'Old' }] }));
  assert.deepEqual(getMasterSnapshot('brands'), [{ id: 1, name: 'Old' }]);
  __setMasterFetcher(fetcher([{ id: 1, name: 'New' }]));
  assert.deepEqual(await loadMaster('brands'), [{ id: 1, name: 'New' }]);
});

test('lists are scoped by tenant', async () => {
  __setMasterFetcher(fetcher([{ id: 1, name: 'Tenant one' }]));
  await loadMaster('suppliers');
  localStorage.setItem('access_token', token(2));
  assert.equal(getMasterSnapshot('suppliers'), null);
});

test('invalidate refetches a list a screen is showing', async () => {
  let n = 0;
  __setMasterFetcher(fetcher(() => [{ id: 1, name: `v${++n}` }]));
  await loadMaster('categories');
  const seen = [];
  const off = subscribeMaster('categories', () => seen.push(getMasterSnapshot('categories')?.[0]?.name));
  invalidateMaster('categories');
  await new Promise((r) => setTimeout(r, 0));
  off();
  assert.equal(getMasterSnapshot('categories')[0].name, 'v2');
  assert.ok(seen.includes('v2'));
});

test('failed fetch keeps the cached rows', async () => {
  __setMasterFetcher(fetcher([{ id: 1, name: 'Keep' }]));
  await loadMaster('units');
  __setMasterFetcher(async () => { throw new Error('down'); });
  await assert.rejects(loadMaster('units', { force: true }));
  assert.deepEqual(getMasterSnapshot('units'), [{ id: 1, name: 'Keep' }]);
});

test('write URLs map to the list they change', () => {
  assert.equal(masterForUrl('/api/purchase/suppliers/'), 'suppliers');
  assert.equal(masterForUrl('https://x.onrender.com/api/masters/brands/12/?a=1'), 'brands');
  assert.equal(masterForUrl('/api/purchase/invoices/'), null);
});
