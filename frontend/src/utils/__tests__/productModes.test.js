// Add New Product Frame / Lens isolation: mode inference + per-mode lists.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const {
  inferCategoryMode, inferBrandMode, inMode, readModeLists, MODE_LISTS, LS_KEYS,
} = await import('../../components/inventory/productAttributeOptions.js');

test('categories and brands infer their mode from the name', () => {
  assert.equal(inferCategoryMode('Prescription Lenses'), 'LENS');
  assert.equal(inferCategoryMode('Progressive Lenses'), 'LENS');
  assert.equal(inferCategoryMode('Frames'), 'FRAME');
  assert.equal(inferCategoryMode('Contact Lenses'), 'FRAME');
  assert.equal(inferCategoryMode('Sunglasses'), 'FRAME');
  assert.equal(inferBrandMode('Essilor'), 'LENS');
  assert.equal(inferBrandMode('Zeiss'), 'LENS');
  assert.equal(inferBrandMode('RayBan'), 'FRAME');
});

test('BOTH is listed in either mode; FRAME / LENS only in their own', () => {
  assert.ok(inMode('BOTH', 'LENS') && inMode('BOTH', 'FRAME'));
  assert.ok(inMode('LENS', 'LENS') && !inMode('LENS', 'FRAME'));
  assert.ok(!inMode('FRAME', 'LENS'));
});

test('each mode shows only its own attribute fields', () => {
  assert.deepEqual(Object.keys(MODE_LISTS.FRAME).sort(), ['color', 'frameShape', 'group', 'material', 'size', 'subCategory']);
  assert.deepEqual(Object.keys(MODE_LISTS.LENS).sort(), ['coating', 'group', 'lensDesign', 'material', 'powerRange', 'refractive', 'subCategory']);
});

test('frame lists seeded from the old shared list drop lens entries; lens lists stay separate', () => {
  store.clear();
  localStorage.setItem(LS_KEYS.material, JSON.stringify(['Acetate', 'CR39', 'Polycarbonate', 'My Metal']));
  localStorage.setItem(LS_KEYS.group, JSON.stringify(['Optical Frame', 'Ophthalmic Lens']));
  const frame = readModeLists('FRAME');
  const lens = readModeLists('LENS');
  assert.deepEqual(frame.material, ['Acetate', 'My Metal']);
  assert.deepEqual(frame.group, ['Optical Frame']);
  assert.ok(lens.material.includes('CR39') && !lens.material.includes('Acetate'));
  assert.ok(!lens.group.includes('Optical Frame'));
  // The old shared list (still used by Add Multiple Items) is left untouched.
  assert.deepEqual(JSON.parse(localStorage.getItem(LS_KEYS.material)), ['Acetate', 'CR39', 'Polycarbonate', 'My Metal']);
});
