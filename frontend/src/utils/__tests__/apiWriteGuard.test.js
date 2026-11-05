// Run: npm run test:write-guard   (Node built-in runner; viteResolve.mjs maps extensionless imports)
//
// Drives the real axios with a fake transport that counts what reaches the network.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const axios = (await import('axios')).default;
const { installApiWriteGuard } = await import('../apiWriteGuard.js');

let sent = [];
let answer = () => ({ status: 200, body: { results: [{ id: 1, name: 'Ray-Ban' }] } });
axios.defaults.adapter = (config) => new Promise((resolve, reject) => {
  sent.push(`${config.method} ${config.url} ${config.headers?.['X-Branch-Id'] || ''}`);
  setTimeout(() => {
    const { status, body } = answer(config);
    const response = { data: JSON.stringify(body), status, statusText: String(status), headers: {}, config, request: {} };
    if (status >= 400) {
      const err = new axios.AxiosError(`HTTP ${status}`, 'ERR_BAD_RESPONSE', config, {}, response);
      reject(err);
    } else resolve(response);
  }, 10);
});
installApiWriteGuard();

beforeEach(() => {
  sent = [];
  store.clear();
  answer = () => ({ status: 200, body: { results: [{ id: 1, name: 'Ray-Ban' }] } });
});

test('identical reads in flight together go out once, each caller gets its own copy', async () => {
  const [a, b, c] = await Promise.all([
    axios.get('/api/masters/brands/'), axios.get('/api/masters/brands/'), axios.get('/api/masters/brands/'),
  ]);
  assert.equal(sent.length, 1);
  assert.deepEqual(a.data, b.data);
  a.data.results[0].name = 'changed by one screen';
  assert.equal(b.data.results[0].name, 'Ray-Ban');   // parsed per caller, not shared
  assert.notEqual(a.config, b.config);
  assert.equal(c.status, 200);
});

test('reads one after another are not cached — each asks the server', async () => {
  await axios.get('/api/masters/brands/');
  await axios.get('/api/masters/brands/');
  assert.equal(sent.length, 2);
});

test('different params, branch or user are different reads', async () => {
  await Promise.all([
    axios.get('/api/products/items/', { params: { page: 1 } }),
    axios.get('/api/products/items/', { params: { page: 2 } }),
    axios.get('/api/products/items/', { params: { page: 1 }, headers: { Authorization: 'Bearer other-user' } }),
  ]);
  assert.equal(sent.length, 3);
  store.set('active_branch_id', 'branch-1');
  const first = axios.get('/api/sales/invoices/');
  await new Promise(r => setImmediate(r));   // interceptors run async; let the first one read branch-1
  store.set('active_branch_id', 'branch-2');
  await Promise.all([first, axios.get('/api/sales/invoices/')]);
  assert.equal(sent.length, 5);
});

test('abortable reads are never shared', async () => {
  const ctl = new AbortController();
  await Promise.all([axios.get('/api/masters/brands/', { signal: ctl.signal }), axios.get('/api/masters/brands/')]);
  assert.equal(sent.length, 2);
});

test('a shared failure reaches every caller with its own config', async () => {
  answer = () => ({ status: 500, body: { detail: 'boom' } });
  const results = await Promise.allSettled([
    axios.get('/api/masters/brands/', { __tag: 'one' }), axios.get('/api/masters/brands/', { __tag: 'two' }),
  ]);
  assert.equal(sent.length, 1);
  assert.deepEqual(results.map(r => r.status), ['rejected', 'rejected']);
  assert.deepEqual(results.map(r => r.reason.config.__tag), ['one', 'two']);
  assert.deepEqual(results.map(r => r.reason.response.config.__tag), ['one', 'two']);
  assert.equal(results[1].reason.response.data.detail, 'boom');
});

test('double-submitted writes are still sent once and carry an Idempotency-Key', async () => {
  answer = () => ({ status: 201, body: { id: 'new' } });
  const body = { name: 'Hoya' };
  const [a, b] = await Promise.all([axios.post('/api/masters/brands/', body), axios.post('/api/masters/brands/', body)]);
  assert.equal(sent.length, 1);
  assert.equal(a.data.id, 'new');
  assert.equal(b.data.id, 'new');
  assert.ok(a.config.headers['Idempotency-Key']);
});
