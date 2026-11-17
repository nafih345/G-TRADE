// Run: npm run test:ui-scale   (Node built-in runner)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_UI_SCALE, UI_SCALE_OPTIONS, formatScale, isSupportedScale, scaleBridge, scaleMenuItems } from '../uiScale.js';

test('interface size options and default match the desktop shell', () => {
  assert.deepEqual([...UI_SCALE_OPTIONS], [0.75, 0.8, 0.9, 1]);
  assert.equal(DEFAULT_UI_SCALE, 1);
  assert.equal(formatScale(0.75), '75%');
  assert.ok(isSupportedScale(0.9) && !isSupportedScale(0.5) && !isSupportedScale('x'));
});

test('the control is offered only inside a desktop shell that supports it', () => {
  assert.equal(scaleBridge(null), null); // plain browser / cloud
  assert.equal(scaleBridge({ getInfo() {} }), null); // older desktop shell without uiScale
  const b = { get: async () => ({}), set: async () => ({}) };
  assert.equal(scaleBridge({ uiScale: b }), b);
});

test('menu rows mark the active and the default size', () => {
  const rows = scaleMenuItems(0.9);
  assert.deepEqual(rows.map((r) => r.label), ['75%', '80%', '90%', '100% (default)']);
  assert.deepEqual(rows.map((r) => r.selected), [false, false, true, false]);
});
