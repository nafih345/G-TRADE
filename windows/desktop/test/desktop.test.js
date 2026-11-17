'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const sec = require('../lib/security');
const conn = require('../lib/connection');

const fx = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8');
const GOOD_CA = fx('good-ca.crt');
const ROGUE_CA = fx('rogue-ca.crt');
const GOOD_FP = sec.fingerprintOfPem(GOOD_CA);

test('server URL normalisation accepts host[:port] and refuses anything risky', () => {
  assert.deepEqual(sec.normalizeServerUrl('SHOP-SRV'), { origin: 'https://shop-srv:8443', host: 'shop-srv', port: 8443 });
  assert.equal(sec.normalizeServerUrl('192.168.1.20:9443').origin, 'https://192.168.1.20:9443');
  assert.throws(() => sec.normalizeServerUrl('http://shop-srv:8443'), /HTTPS/);
  assert.throws(() => sec.normalizeServerUrl('https://user:pw@shop-srv'), /user name/);
  assert.throws(() => sec.normalizeServerUrl('https://shop-srv/evil'), /only the server/);
  assert.throws(() => sec.normalizeServerUrl(''), /Enter/);
});

test('navigation is limited to the server origin; external links only https/mailto', () => {
  const origin = 'https://shop-srv:8443';
  assert.ok(sec.isAllowedNavigation('https://shop-srv:8443/#/sales/new', origin));
  assert.ok(!sec.isAllowedNavigation('https://shop-srv:9443/', origin));
  assert.ok(!sec.isAllowedNavigation('https://evil.example/', origin));
  assert.ok(!sec.isAllowedNavigation('file:///C:/Windows/', origin));
  assert.ok(sec.isSafeExternalUrl('https://api.whatsapp.com/send?text=x'));
  assert.ok(!sec.isSafeExternalUrl('file:///C:/Windows/System32/calc.exe'));
  assert.ok(!sec.isSafeExternalUrl('javascript:alert(1)'));
});

test('pairing code is derived from the CA fingerprint and compared in constant time', () => {
  const code = sec.pairingCode(GOOD_FP);
  assert.match(code, /^[0-9A-F]{4}-[0-9A-F]{4}$/);
  assert.ok(sec.pairingCodeMatches(code.toLowerCase().replace('-', ' '), GOOD_FP));
  assert.ok(!sec.pairingCodeMatches(sec.pairingCode(sec.fingerprintOfPem(ROGUE_CA)), GOOD_FP));
  assert.ok(!sec.pairingCodeMatches('', GOOD_FP));
});

test('pinned leaf verification: right CA + host passes; rogue CA, wrong host or wrong pin fail', () => {
  const leaf = fx('good-server.crt');
  for (const host of ['localhost', '127.0.0.1', 'SHOP-SRV', '192.168.50.10']) {
    assert.ok(sec.verifyPinnedLeaf({ hostname: host, leafPem: leaf, caPem: GOOD_CA, pinnedFingerprint: GOOD_FP }).ok, host);
  }
  assert.ok(!sec.verifyPinnedLeaf({ hostname: 'other-host', leafPem: leaf, caPem: GOOD_CA, pinnedFingerprint: GOOD_FP }).ok);
  assert.ok(!sec.verifyPinnedLeaf({ hostname: 'localhost', leafPem: fx('rogue-server.crt'), caPem: GOOD_CA, pinnedFingerprint: GOOD_FP }).ok);
  assert.ok(!sec.verifyPinnedLeaf({ hostname: 'localhost', leafPem: leaf, caPem: ROGUE_CA, pinnedFingerprint: GOOD_FP }).ok);
  const future = new Date(Date.now() + 500 * 86400e3);
  assert.match(sec.verifyPinnedLeaf({ hostname: 'localhost', leafPem: leaf, caPem: GOOD_CA, pinnedFingerprint: GOOD_FP, now: future }).reason, /expired/);
});

test('version compare, print options and permissions', () => {
  assert.equal(sec.compareVersions('1.0.0', '1.0.1'), -1);
  assert.equal(sec.compareVersions('1.10.0', '1.9.9'), 1);
  assert.equal(sec.compareVersions('1.0', '1.0.0'), 0);
  assert.deepEqual(sec.sanitizePrintOptions({ silent: 1, copies: 99, deviceName: 'TSC TE244', pageRanges: 'x', landscape: true }),
    { silent: true, printBackground: true, deviceName: 'TSC TE244', landscape: true });
  assert.ok(sec.isPermissionAllowed('clipboard-sanitized-write'));
  for (const p of ['media', 'geolocation', 'notifications', 'openExternal', 'hid', 'serial', 'usb']) assert.ok(!sec.isPermissionAllowed(p));
});

test('stored connection must be complete and its CA must match the pin; user overrides machine', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gtrade-conn-'));
  const machine = path.join(dir, 'machine.json');
  const user = path.join(dir, 'user.json');
  fs.writeFileSync(machine, JSON.stringify({ serverUrl: 'https://localhost:8443', caPem: GOOD_CA, caFingerprint: GOOD_FP, mode: 'standalone' }));
  assert.equal(conn.loadConnection(user, machine).source, 'machine');
  fs.writeFileSync(user, JSON.stringify({ serverUrl: 'https://localhost:8443', caPem: ROGUE_CA, caFingerprint: GOOD_FP }));
  assert.equal(conn.loadConnection(user, machine).source, 'machine', 'tampered user file ignored');
  assert.throws(() => conn.saveUserConnection(user, { serverUrl: 'https://x:8443', caPem: ROGUE_CA, caFingerprint: GOOD_FP }));
  conn.saveUserConnection(user, { serverUrl: 'SHOP-SRV', caPem: GOOD_CA, caFingerprint: GOOD_FP });
  const c = conn.loadConnection(user, machine);
  assert.equal(c.source, 'user');
  assert.equal(c.serverUrl, 'https://shop-srv:8443');
  assert.ok(!JSON.stringify(c).match(/password|secret/i));
  fs.rmSync(dir, { recursive: true, force: true });
});

function startServer(name, body) {
  return new Promise((resolve) => {
    const srv = https.createServer({ key: fx(`${name}-server.key`), cert: fx(`${name}-server.crt`) }, (req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(body));
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

test('probe reads the CA from the chain; pinned health check trusts only that CA', async () => {
  const health = { status: 'ok', edition: 'local', server_version: '1.0.0', min_client_version: '1.0.0', database: 'connected', migrations: 'up_to_date' };
  const srv = await startServer('good', health);
  const url = `https://localhost:${srv.address().port}`;
  try {
    const probe = await conn.probeServerCa(url);
    assert.equal(probe.caFingerprint, GOOD_FP);
    assert.equal(probe.pairingCode, sec.pairingCode(GOOD_FP));
    const ok = await conn.checkServer({ serverUrl: url, caPem: GOOD_CA }, '1.0.0');
    assert.equal(ok.state, 'online');
    assert.equal(ok.serverVersion, '1.0.0');
    const pinnedWrong = await conn.checkServer({ serverUrl: url, caPem: ROGUE_CA }, '1.0.0');
    assert.equal(pinnedWrong.state, 'offline');
    assert.ok(pinnedWrong.tlsError);
  } finally {
    srv.close();
  }
});

test('client older than the server minimum is reported; maintenance is degraded', async () => {
  const srv = await startServer('good', { status: 'ok', edition: 'local', min_client_version: '2.0.0', maintenance: null });
  const url = `https://127.0.0.1:${srv.address().port}`;
  try {
    const s = await conn.checkServer({ serverUrl: url, caPem: GOOD_CA }, '1.0.0');
    assert.equal(s.state, 'degraded');
    assert.ok(s.clientTooOld);
  } finally {
    srv.close();
  }
  const srv2 = await startServer('good', { status: 'ok', edition: 'local', maintenance: 'update to 1.0.1' });
  try {
    const s = await conn.checkServer({ serverUrl: `https://localhost:${srv2.address().port}`, caPem: GOOD_CA }, '1.0.0');
    assert.equal(s.state, 'degraded');
    assert.match(s.detail, /Maintenance/);
  } finally {
    srv2.close();
  }
});

test('unreachable server is offline, not an exception', async () => {
  const s = await conn.checkServer({ serverUrl: 'https://127.0.0.1:1', caPem: GOOD_CA }, '1.0.0');
  assert.equal(s.state, 'offline');
});

// ---- regression: automated runs must never open the user's real browser (example.com incident) ----
test('external opener: https/mailto only, and a smoke run never reaches the OS browser', () => {
  const opened = [];
  const live = sec.createExternalOpener({ open: (u) => opened.push(u), smoke: false });
  assert.equal(live('https://wa.me/911234567890'), true);
  assert.equal(live('mailto:shop@localhost'), true);
  assert.equal(live('http://insecure.invalid/'), false);
  assert.equal(live('file:///C:/Windows/'), false);
  assert.equal(live('javascript:alert(1)'), false);
  assert.deepEqual(opened, ['https://wa.me/911234567890', 'mailto:shop@localhost']);

  const smokeOpened = [];
  const smoke = sec.createExternalOpener({ open: (u) => smokeOpened.push(u), smoke: true });
  assert.equal(smoke('https://gtrade-navigation-probe.invalid/'), false);
  assert.deepEqual(smokeOpened, [], 'smoke mode must not open anything');
  assert.deepEqual(smoke.suppressed, ['https://gtrade-navigation-probe.invalid/']);
});

function shippedDesktopFiles() {
  const root = path.join(__dirname, '..');
  const out = [path.join(root, 'main.js'), path.join(root, 'preload.js')];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else out.push(p);
    }
  };
  walk(path.join(root, 'lib'));
  walk(path.join(root, 'pages'));
  return out;
}

test('shipped desktop code has no placeholder domains (example.com/.org/.net)', () => {
  for (const f of shippedDesktopFiles()) {
    const text = fs.readFileSync(f, 'utf8');
    assert.ok(!/\bexample\.(com|org|net)\b/i.test(text), `${path.basename(f)} references a documentation placeholder domain`);
  }
});

test('main.js opens external links only through the smoke-aware opener', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const direct = src.match(/shell\.openExternal\(/g) || [];
  assert.equal(direct.length, 1, 'exactly one shell.openExternal call: the one wrapped by createExternalOpener');
  assert.match(src, /createExternalOpener\(\{\s*open:\s*\(url\)\s*=>\s*shell\.openExternal\(url\),\s*smoke:\s*Boolean\(SMOKE_OUT\)\s*\}\)/);
  assert.ok(!/openExternal\([^)]*example\./.test(src));
});
