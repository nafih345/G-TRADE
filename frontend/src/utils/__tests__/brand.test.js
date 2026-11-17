// Run: npm run test:brand   (Node built-in runner; viteResolve.mjs maps extensionless imports)
//
// The Windows local edition is branded "G OPTICALS"; the cloud build keeps its Greensol branding.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import BRAND, { LOCAL_BRAND, CLOUD_BRAND } from '../brand.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('local edition product name is G OPTICALS', () => {
  assert.equal(LOCAL_BRAND.productName, 'G OPTICALS');
  assert.equal(LOCAL_BRAND.wordmarkCaps, 'G OPTICALS');
  assert.ok(!JSON.stringify(LOCAL_BRAND).includes('G-TRADE'));
  assert.ok(!/greensol/i.test(JSON.stringify(LOCAL_BRAND)));
});

test('a build without the local-edition flag (cloud, node --test) keeps the cloud brand', () => {
  assert.deepEqual(BRAND, CLOUD_BRAND);
});

test('local build rewrites the browser-tab title with the same product name', () => {
  const vite = read('vite.config.js');
  const m = vite.match(/LOCAL_PRODUCT_NAME = '([^']+)'/);
  assert.ok(m, 'vite.config.js must define LOCAL_PRODUCT_NAME');
  assert.equal(m[1], LOCAL_BRAND.productName);
  assert.match(vite, /<title>\$\{LOCAL_PRODUCT_NAME\}<\/title>/);
});

test('login, sidebar logo and 2FA prompt take their text from BRAND (no hard-coded brand)', () => {
  const login = read('src/pages/Login.jsx');
  assert.ok(!/>\s*GREENSOL\s*</.test(login) && !login.includes('\n              GREENSOL\n'));
  assert.ok(!login.includes('} Greensol ·'));
  assert.match(login, /BRAND\.wordmarkCaps/);
  const logo = read('src/components/GreensolLogo.jsx');
  assert.match(logo, /\{BRAND\.wordmark\}/);
  const tfa = read('src/components/security/TwoFactorLoginStep.jsx');
  assert.match(tfa, /\{BRAND\.productName\}/);
});
