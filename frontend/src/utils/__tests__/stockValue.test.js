import test from 'node:test';
import assert from 'node:assert/strict';
import { stockValue, activeOfferPrice } from '../stockValue.js';

const offerAll = { offer_price: '200.00', apply_to_all: true, remaining: 10 };

test('no offer → qty × selling price', () => {
  assert.deepEqual(stockValue({ stock: 10, retail_price: '300.00', offer: null }).value, 3000);
});

test('offer on all stock → qty × offer price', () => {
  const r = stockValue({ stock: 10, retail_price: '300', offer: offerAll });
  assert.equal(r.value, 2000);
  assert.equal(r.basis, 'offer');
});

test('partial offer → offer units at offer price, rest at selling price', () => {
  const r = stockValue({ stock: 10, retail_price: 300, offer: { offer_price: 200, apply_to_all: false, remaining: 3 } });
  assert.equal(r.value, 3 * 200 + 7 * 300);
  assert.equal(r.basis, 'mixed');
  assert.equal(stockValue({ stock: 2, retail_price: 300, offer: { offer_price: 200, apply_to_all: false, remaining: 5 } }).value, 400);
  assert.equal(stockValue({ stock: 4, retail_price: 300, offer: { offer_price: 200, apply_to_all: false, remaining: 0 } }).basis, 'regular');
});

test('"any price" offer has no offer price → selling price', () => {
  assert.equal(activeOfferPrice({ offer_price: null }), null);
  assert.equal(stockValue({ stock: 3, retail_price: 300, offer: { offer_price: null, apply_to_all: true } }).value, 900);
});

test('inline edit: changed qty keeps the offer price', () => {
  const row = { stock: 10, retail_price: '300', offer: offerAll };
  const edit = { values: { stock: '12', retail_price: '300' }, original: { stock: '10', retail_price: '300' } };
  assert.equal(stockValue(row, edit).value, 2400);
});

test('inline edit: changed selling price overrides the offer', () => {
  const row = { stock: 10, retail_price: '300', offer: offerAll };
  const edit = { values: { stock: '5', retail_price: '250' }, original: { stock: '10', retail_price: '300' } };
  const r = stockValue(row, edit);
  assert.equal(r.value, 1250);
  assert.equal(r.basis, 'edited');
});

test('negative / blank stock values as 0', () => {
  assert.equal(stockValue({ stock: -4, retail_price: 300, offer: null }).value, 0);
  assert.equal(stockValue({ stock: 1, retail_price: '', offer: null }).value, 0);
});
