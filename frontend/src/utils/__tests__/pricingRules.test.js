// Run: npm run test:pricing   (Node's built-in test runner)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PAIR, PIECE } from '../lensUnits.js';
import {
  costUnits, findPriceViolations, offerUnitPrice, violationText, indexOffers, offerForProduct, offerForBarcode,
  offerUnitsInBill, offerUnitsLeft, offerBadgeText,
} from '../pricingRules.js';

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

test('a partial-quantity offer lowers the floor only for tagged lines', () => {
  const partial = { partial: { cost: 100, floor: 60, base_floor: 100, lens_stock_unit: PAIR,
    offer: { id: 'o1', tag: 'Festival Offer', offer_price: 60, apply_to_all: false, remaining: 3 } } };
  const untagged = findPriceViolations([row('a', 'partial', 60)], partial);
  assert.ok(untagged.a);
  assert.equal(untagged.a.offer, null);
  assert.match(violationText(untagged.a), /cost price/);
  assert.deepEqual(findPriceViolations([row('a', 'partial', 60, { pricingOfferId: 'o1' })], partial), {});
});

test('offer index: barcode scan, product beats category, category by id or name', () => {
  const idx = indexOffers([
    { id: 'p', scope: 'PRODUCT', product: 'f1', offer_barcode: '1001-0001', offer_price: 120, apply_to_all: false, remaining: 3 },
    { id: 'c', scope: 'CATEGORY', category: 'cat', category_name: 'Frames', offer_price: null, apply_to_all: true },
  ]);
  assert.equal(offerForBarcode(idx, ' 1001-0001 ').id, 'p');
  assert.equal(offerForBarcode(idx, '1001'), null);
  assert.equal(offerForProduct(idx, { id: 'f1', category_id: 'cat' }).id, 'p');
  assert.equal(offerForProduct(idx, { id: 'f2', category_id: 'cat' }).id, 'c');
  assert.equal(offerForProduct(idx, { id: 'f3', category: 'frames' }).id, 'c');
  assert.equal(offerForProduct(idx, { id: 'f4', category: 'Lens' }), null);
});

test('offer units left in this bill and the badge text', () => {
  const offer = { id: 'p', offer_price: 120, apply_to_all: false, remaining: 3 };
  const rows = [{ id: 'a', qty: 2, pricingOfferId: 'p' }, { id: 'b', qty: 5 }, { id: 'c', qty: '1', pricingOfferId: 'p' }];
  assert.equal(offerUnitsInBill(rows, 'p'), 3);
  assert.equal(offerUnitsLeft(offer, rows), 0);
  assert.equal(offerUnitsLeft(offer, rows, 'a'), 2);
  assert.equal(offerUnitsLeft({ ...offer, apply_to_all: true }, rows), Infinity);
  assert.equal(offerBadgeText(offer), 'On Offer: ₹120.00 · 3 left');
  assert.equal(offerBadgeText(offer, { left: 1 }), 'On Offer: ₹120.00 · 1 left');
  assert.equal(offerBadgeText({ offer_price: null, apply_to_all: true }), 'On Offer: any price');
});
