// Run: npm run test:network
//
// The real axios with the app's real interceptors, installed in main.jsx's order (session guard →
// backend health watch → write guard), over a fake transport scripted per test. Covers what the
// "Cannot reach the server" work promised: reads ride out a restart, writes are never blindly
// re-sent, replays carry the idempotency key, and a network failure never signs anyone out.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
globalThis.sessionStorage = globalThis.localStorage;
const events = [];
globalThis.window = {
  location: { origin: 'https://g-trade-pi.vercel.app', protocol: 'https:', hostname: 'g-trade-pi.vercel.app',
              href: 'https://g-trade-pi.vercel.app/', hash: '', reload() {} },
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent(e) { events.push(e.type); return true; },
};
globalThis.document = {
  visibilityState: 'visible', addEventListener() {}, removeEventListener() {},
  createElement: () => ({ setAttribute() {}, style: {} }), head: { appendChild() {} }, body: { appendChild() {} },
  querySelector: () => null,
};
globalThis.setInterval = () => 0;   // the health watch's timers would keep the runner alive

const axios = (await import('axios')).default;
const { installSessionGuard, SESSION_ENDED_EVENT } = await import('../sessionGuard.js');
const { installBackendHealthWatch } = await import('../backendStatus.js');
const { installApiWriteGuard } = await import('../apiWriteGuard.js');

const DIRECT = 'https://g-trade-backend.onrender.com';
let sent = [];
let script = [];        // per-test queue of answers for non-health requests
const respond = (config, status, body) => {
  const response = { data: JSON.stringify(body ?? {}), status, statusText: String(status), headers: {}, config, request: {} };
  if (status >= 400) throw new axios.AxiosError(`HTTP ${status}`, 'ERR_BAD_RESPONSE', config, {}, response);
  return response;
};
axios.defaults.adapter = async (config) => {
  await new Promise((r) => setTimeout(r, 5));
  if (config.url === '/api/health/') return respond(config, 200, { status: 'ok', api_version: 2 });
  const key = typeof config.headers?.get === 'function' ? config.headers.get('Idempotency-Key') : config.headers?.['Idempotency-Key'];
  sent.push({ method: config.method, url: config.url, base: config.baseURL, key, auth: config.headers?.Authorization });
  const next = script.shift() || { status: 200, body: {} };
  if (next.network) throw new axios.AxiosError('Network Error', 'ERR_NETWORK', config, {});
  return respond(config, next.status, typeof next.body === 'function' ? next.body(config) : next.body);
};

axios.defaults.baseURL = DIRECT;
installSessionGuard();
installBackendHealthWatch();
installApiWriteGuard();
await new Promise((r) => setTimeout(r, 50));   // let the boot health probe settle

beforeEach(() => {
  sent = [];
  script = [];
  events.length = 0;
  store.clear();
  axios.defaults.baseURL = DIRECT;
  axios.defaults.headers.common.Authorization = 'Bearer old-access';
});

test('a read that hits a restart (502) is retried and succeeds', async () => {
  script = [{ status: 502 }, { status: 200, body: { ok: 1 } }];
  const res = await axios.get('/api/products/items/');
  assert.equal(res.data.ok, 1);
  assert.equal(sent.length, 2);
});

test('read retries are bounded: three 503s give up after two retries', async () => {
  script = [{ status: 503 }, { status: 503 }, { status: 503 }, { status: 200 }];
  await assert.rejects(axios.get('/api/sales/invoices/'), (e) => e.response?.status === 503);
  assert.equal(sent.length, 3);
});

test('a write that gets a 502 is never re-sent automatically', async () => {
  script = [{ status: 502 }, { status: 201 }];
  await assert.rejects(axios.post('/api/sales/invoices/', { total: 100 }, { __silentError: true }));
  assert.equal(sent.length, 1);
});

test('a JSON write lost on the network is replayed through the proxy with the SAME idempotency key', async () => {
  script = [{ network: true }, { status: 201, body: { id: 7 } }];
  const res = await axios.post('/api/purchase/invoices/', { supplier: 1 });
  assert.equal(res.data.id, 7);
  assert.equal(sent.length, 2);
  assert.equal(sent[0].base, DIRECT);
  assert.equal(sent[1].base, '');                       // the same-origin /api proxy
  assert.ok(sent[0].key, 'the write carried an idempotency key');
  assert.equal(sent[1].key, sent[0].key);               // backend dedupes the replay
});

test('a file upload (no idempotency key possible) lost on the network is NOT replayed', async () => {
  script = [{ network: true }, { status: 201 }];
  const form = new FormData();
  form.append('file', 'x');
  await assert.rejects(axios.post('/api/import/upload/', form, { __silentError: true }));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].key ?? null, null);
});

test('PATCH, PUT and DELETE carry idempotency keys too', async () => {
  await axios.patch('/api/sales/invoices/1/', { notes: 'x' });
  await axios.put('/api/masters/brands/1/', { name: 'y' });
  await axios.delete('/api/masters/brands/1/');
  assert.equal(sent.length, 3);
  for (const s of sent) assert.ok(s.key, `${s.method} has a key`);
  assert.equal(new Set(sent.map((s) => s.key)).size, 3);
});

test('expired token: concurrent 401s share ONE refresh, then each request is retried', async () => {
  store.set('refresh_token', 'r1');
  let refreshes = 0;
  script = [
    { status: 401, body: { code: 'token_not_valid' } },
    { status: 401, body: { code: 'token_not_valid' } },
  ];
  const origAdapter = axios.defaults.adapter;
  axios.defaults.adapter = async (config) => {
    if (config.url === '/api/auth/token/refresh/') { refreshes += 1; return respond(config, 200, { access: 'new-access', refresh: 'r2' }); }
    return origAdapter(config);
  };
  try {
    const [a, b] = await Promise.all([axios.get('/api/a/'), axios.get('/api/b/')]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(refreshes, 1);
    assert.equal(store.get('access_token'), 'new-access');
    assert.equal(sent.filter((s) => s.auth === 'Bearer new-access').length, 2);
  } finally {
    axios.defaults.adapter = origAdapter;
  }
});

test('token refresh failing on the NETWORK keeps the user signed in', async () => {
  store.set('refresh_token', 'r1');
  script = [{ status: 401, body: { code: 'token_not_valid' } }];
  const origAdapter = axios.defaults.adapter;
  axios.defaults.adapter = async (config) => {
    if (config.url === '/api/auth/token/refresh/') throw new axios.AxiosError('Network Error', 'ERR_NETWORK', config, {});
    return origAdapter(config);
  };
  try {
    await assert.rejects(axios.get('/api/a/', { __noFallback: true }));
    assert.ok(!events.includes(SESSION_ENDED_EVENT), 'no sign-out on a network failure');
    assert.equal(store.get('refresh_token'), 'r1');
  } finally {
    axios.defaults.adapter = origAdapter;
  }
});

test('token refresh REFUSED by the server (401) does end the session', async () => {
  store.set('refresh_token', 'r1');
  script = [{ status: 401, body: { code: 'token_not_valid' } }];
  const origAdapter = axios.defaults.adapter;
  axios.defaults.adapter = async (config) => {
    if (config.url === '/api/auth/token/refresh/') return respond(config, 401, { code: 'token_not_valid' });
    return origAdapter(config);
  };
  try {
    await assert.rejects(axios.get('/api/a/'));
    assert.ok(events.includes(SESSION_ENDED_EVENT));
  } finally {
    axios.defaults.adapter = origAdapter;
  }
});
