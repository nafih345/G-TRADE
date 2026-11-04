// Run: npm run test:pricing   (Node's built-in test runner)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PAIR, PIECE } from '../lensUnits.js';
import { costUnits, findPriceViolations, offerUnitPrice, violationText } from '../pricingRules.js';

const floors = {
  frame: { cost: 100, floor: 100, base_floor: 100, lens_stock_unit: PAIR, offer: null },
  margin: { cost: 100, floor: 110, base_floor: 110, lens_stock_unit: PAIR, offer: null },
  lens: { cost: 400, floor: 400, base_floor: 400, lens_stock_unit: PAIR, offer: null },
  clear: { cost: 100, floor: 60, base_floor: 100, lens_stock_unit: PAIR,
    offer: { tag: 'Clearance Stock', offer_price: 60 } },
  free: { cost: 100, floor: null, base_floor: 100, lens_stock_unit: PAIR, offer: { tag: 'Dead Stock', offer_price: null } },
};
const row = (id, productId, price, extra = {}) => ({ id, productId, qty: 1, gross: price, disc: 0, ...extra });

test('a line under cost is flagged with the cost as its floor', () => {
  const v = findPriceViolations([row('a', 'frame', 80), row('b', 'frame', 100)], floors);
  assert.deepEqual(Object.keys(v), ['a']);
  assert.equal(violationText(v.a), '₹80.00 is below the cost price (₹100.00)');
});

test('line and bill discounts both count', () => {
  assert.ok(findPriceViolations([row('a', 'frame', 120, { disc: 30 })], floors).a);
  assert.ok(findPriceViolations([row('a', 'frame', 120)], floors, 25).a);
  assert.deepEqual(findPriceViolations([row('a', 'frame', 120, { disc: 20 })], floors), {});
});

test('margin floor and offers', () => {
  assert.match(violationText(findPriceViolations([row('a', 'margin', 105)], floors).a), /minimum selling price/);
  assert.deepEqual(findPriceViolations([row('a', 'clear', 70)], floors), {});
  assert.match(violationText(findPriceViolations([row('a', 'clear', 50)], floors).a), /Clearance Stock offer price/);
  assert.deepEqual(findPriceViolations([row('a', 'free', 1)], floors), {});
});

test('single lens of a pair-counted lens is costed at half the pair', () => {
  const single = { lens: { sellingUnit: PIECE } };
  assert.equal(costUnits({ qty: 1, ...single }, PAIR), 0.5);
  assert.equal(costUnits({ qty: 1, lens: { sellingUnit: PAIR } }, PIECE), 2);
  assert.deepEqual(findPriceViolations([row('a', 'lens', 200, single)], floors), {});
  assert.ok(findPriceViolations([row('a', 'lens', 150, single)], floors).a);
  assert.equal(offerUnitPrice({ qty: 1, ...single }, { ...floors.clear }), 30);
});

test('products with no floor info (services, custom lines) are never flagged', () => {
  assert.deepEqual(findPriceViolations([row('a', null, 1), row('b', 'unknown', 1)], floors), {});
});
