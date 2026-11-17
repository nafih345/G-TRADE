'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ui = require('../lib/uiScale');

test('interface size offers exactly 75/80/90/100 % with 100 % as the default', () => {
  assert.deepEqual(ui.SCALES, [0.75, 0.8, 0.9, 1]);
  assert.equal(ui.DEFAULT_SCALE, 1);
  assert.deepEqual(ui.describe(0.9), { scale: 0.9, defaultScale: 1, options: [0.75, 0.8, 0.9, 1] });
});

test('only supported scales are accepted, in any reasonable spelling', () => {
  for (const v of [0.8, '0.8', 80, '80%', 0.80000001]) assert.equal(ui.normalizeScale(v), 0.8, String(v));
  assert.equal(ui.normalizeScale(100), 1);
  for (const v of [0.5, 0.85, 3, 150, NaN, Infinity, null, undefined, {}, [], '', 'big']) {
    assert.equal(ui.normalizeScale(v), null, String(v));
  }
});

test('first run, corrupt and unsupported files all read as the 100 % default', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-ui-'));
  const file = path.join(dir, ui.FILE_NAME);
  assert.equal(ui.readScale(file), 1); // missing
  fs.writeFileSync(file, '{not json');
  assert.equal(ui.readScale(file), 1);
  fs.writeFileSync(file, JSON.stringify({ scale: 0.4 }));
  assert.equal(ui.readScale(file), 1);
  fs.writeFileSync(file, JSON.stringify(null));
  assert.equal(ui.readScale(file), 1);
});

test('a saved choice persists (restart) and invalid writes change nothing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-ui-'));
  const file = path.join(dir, 'nested', ui.FILE_NAME);
  assert.equal(ui.writeScale(file, 0.9), 0.9);
  assert.equal(ui.readScale(file), 0.9);
  assert.throws(() => ui.writeScale(file, 0.5), /75%, 80%, 90%, 100%/);
  assert.equal(ui.readScale(file), 0.9);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), [ui.FILE_NAME]); // no temp files left behind
});

test('Larger / Smaller step through the presets and stop at the ends', () => {
  assert.equal(ui.stepScale(0.8, 1), 0.9);
  assert.equal(ui.stepScale(0.8, -1), 0.75);
  assert.equal(ui.stepScale(0.75, -1), 0.75);
  assert.equal(ui.stepScale(1, 1), 1);
  assert.equal(ui.stepScale('garbage', -1), 0.9); // unknown current value starts from the default (100 %)
  assert.equal(ui.label(0.75), '75%');
});

test('the shell zooms only the main window and never re-adds the stock zoom roles', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.ok(!/role:\s*'(resetZoom|zoomIn|zoomOut)'/.test(main), 'stock zoom roles would bypass the saved scale');
  const zoomCalls = main.match(/setZoomFactor\(/g) || [];
  assert.equal(zoomCalls.length, 1, 'setZoomFactor must only be called from applyScale (main window)');
  assert.match(main, /if \(mainWindow && !mainWindow\.isDestroyed\(\)\) mainWindow\.webContents\.setZoomFactor\(currentScale\)/);
  assert.match(main, /zoomFactor: currentScale/);
});
