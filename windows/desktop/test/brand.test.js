'use strict';
// Product rename to "G OPTICALS": customer-facing names change, install/upgrade identifiers do not.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PRODUCT_NAME, LEGACY_USER_DATA_DIRNAME } = require('../lib/brand');
const conn = require('../lib/connection');

const ROOT = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('customer-facing names are G OPTICALS', () => {
  assert.equal(PRODUCT_NAME, 'G OPTICALS');
  assert.equal(pkg.productName, 'G OPTICALS');            // Electron app name, installer title/welcome/finish
  assert.equal(pkg.build.productName, 'G OPTICALS');
  assert.equal(pkg.build.nsis.shortcutName, 'G OPTICALS');          // Desktop + Start Menu shortcut
  assert.equal(pkg.build.nsis.uninstallDisplayName, 'G OPTICALS');  // Apps & features display name
  assert.match(pkg.build.nsis.artifactName, /^G-OPTICALS-Setup-/);
  assert.match(pkg.build.copyright, /G OPTICALS/);
});

test('install/upgrade identifiers are unchanged (same app, same folder, same uninstall key)', () => {
  assert.equal(pkg.build.appId, 'com.gtrade.erp');
  assert.equal(pkg.build.nsis.guid, '7d0f5a52-6a0e-4c63-9b3e-0b8f6b4e2c11');
  assert.equal(pkg.build.win.executableName, 'G-TRADE'); // => C:\Program Files\G-TRADE\G-TRADE.exe
  assert.match(conn.MACHINE_CONFIG, /[\\/]G-TRADE[\\/]client[\\/]client\.json$/);
  assert.match(read('main.js'), /const APP_ID = 'com\.gtrade\.erp'/);
});

test('saved per-user connection survives the rename (userData pinned to the legacy folder)', () => {
  assert.equal(LEGACY_USER_DATA_DIRNAME, 'G-TRADE ERP');
  const main = read('main.js');
  assert.match(main, /app\.setPath\('userData', path\.join\(app\.getPath\('appData'\), LEGACY_USER_DATA_DIRNAME\)\)/);
  assert.match(main, /--user-data-dir/); // tests' explicit dir still wins
});

test('no hard-coded G-TRADE branding left in shell UI text', () => {
  for (const f of ['pages/connect.html', 'pages/offline.html']) assert.ok(!read(f).includes('G-TRADE'), f);
  const main = read('main.js');
  assert.ok(!/['`"][^'`"\n]*G-TRADE[^'`"\n]*['`"]/.test(main), 'main.js string literal still says G-TRADE');
  assert.equal(conn.NOT_LOCAL_SERVER, 'Not a G OPTICALS local server');
});
