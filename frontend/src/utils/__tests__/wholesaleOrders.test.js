import test from 'node:test';
import assert from 'node:assert/strict';
import {
  availableUnits, buildOrderLine, combineReservations, docFromApi, docToApi, isOpenDoc, lineProblems,
  lineUnits, orderLineToCartLine, reservedUnits, summarizeLines,
} from '../../pages/wholesale/wholesaleOrders.js';

const product = {
  id: 'p-1', code: 'FR-1', barcode: '890001', name: 'Frame One', brand: 'Acme', modelNo: 'M1', color: 'Black',
  size: '52', wholesalePrice: 1000, retailPrice: 1500, gst: 12, availableStock: 20, stock: 20,
};
const dealer = { id: 'd-1', name: 'Shop', priceList: 'WHOLESALE' };

test('lineUnits counts qty + free qty and ignores services', () => {
  assert.equal(lineUnits({ qty: 5, freeQty: 1 }), 6);
  assert.equal(lineUnits({ qty: '3' }), 3);
  assert.equal(lineUnits({ itemType: 'SERVICE', qty: 4 }), 0);
});

test('reservations: wholesale + retail are subtracted, never below zero', () => {
  const r = { wholesale: { 'p-1': 6 }, retail: { 'p-1': 4, 'p-2': 1 } };
  assert.equal(reservedUnits(r, 'p-1'), 10);
  assert.equal(availableUnits(product, r), 10);
  assert.equal(availableUnits({ ...product, availableStock: 3 }, r), 0);
  assert.deepEqual(combineReservations(r), { 'p-1': 10, 'p-2': 1 });
  assert.deepEqual(combineReservations(null), {});
});

test('buildOrderLine prices for the dealer and keeps exclusive rate', () => {
  const line = buildOrderLine(product, dealer, 2);
  assert.equal(line.id, 'p-1');
  assert.equal(line.qty, 2);
  assert.equal(line.rate, 1000);
  assert.equal(line.gst, 12);
  assert.equal(line.taxInclusive, false);
  const incl = buildOrderLine({ ...product, taxInclusive: true }, dealer, 1);
  assert.equal(incl.inclRate, 1000);
  assert.ok(Math.abs(incl.rate - 1000 / 1.12) < 1e-9);
  const zero = buildOrderLine({ ...product, gst: 0 }, dealer, 1);
  assert.equal(zero.gst, 0); // 0% stays 0, never the 18% default
});

test('summarizeLines totals match the POS line maths', () => {
  const s = summarizeLines([
    { qty: 2, rate: 1000, discount: 10, gst: 12 },
    { qty: 1, rate: 500, discount: 0, gst: 0 },
  ]);
  assert.equal(s.totalQty, 3);
  assert.equal(s.subtotal, 2500);
  assert.equal(s.totalDiscount, 200);
  assert.equal(s.totalGst, 216);
  assert.equal(s.grandTotal, 2516);
});

test('lineProblems flags bad qty / discount', () => {
  assert.deepEqual(lineProblems([{ qty: 1, rate: 1, discount: 0 }]), {});
  assert.ok(lineProblems([{ qty: '', rate: 1 }])[0]);
  assert.ok(lineProblems([{ qty: 0, rate: 1 }])[0]);
  assert.ok(lineProblems([{ qty: 1, rate: 1, discount: 120 }])[0]);
});

test('docToApi / docFromApi round-trip for orders and quotations', () => {
  const lines = [{ ...buildOrderLine(product, dealer, 3), discount: '5' }];
  const body = docToApi('order', { dealer, lines, notes: 'rush' });
  assert.equal(body.dealer, 'd-1');
  assert.equal(body.details.items[0].discount, 5); // typed text saved as a number
  assert.equal(body.details.notes, 'rush');
  assert.equal(body.total_amount, body.details.summary.grandTotal.toFixed(2));
  const doc = docFromApi('order', { id: 'o-1', order_number: 'WO-2026-0001', order_date: '2026-11-10', status: 'CONFIRMED', dealer: 'd-1', dealer_name: 'Shop', total_amount: '100.00', details: body.details, invoice_number: null });
  assert.equal(doc.number, 'WO-2026-0001');
  assert.equal(doc.items.length, 1);
  assert.equal(isOpenDoc(doc), true);
  assert.equal(isOpenDoc({ ...doc, status: 'BILLED' }), false);

  const q = docToApi('quotation', { dealer, lines, expiryDate: '2026-11-25' });
  assert.equal(q.expiry_date, '2026-11-25');
  assert.ok(q.grand_total && q.tax_amount && q.subtotal);
  const qd = docFromApi('quotation', { id: 'q', quotation_number: 'WQ-2026-0001', date: '2026-11-10', status: 'QUOTATION', grand_total: '1', details: q.details });
  assert.equal(isOpenDoc(qd), true);
});

test('orderLineToCartLine keeps the agreed price over the fresh catalogue line', () => {
  const orderLine = { ...buildOrderLine(product, dealer, 4), rate: 900, discount: 2, priceTier: 'CUSTOM', notes: 'agreed' };
  const fresh = { ...buildOrderLine({ ...product, name: 'Frame One (renamed)' }, dealer, 4), batch: '', availableStock: 99 };
  const line = orderLineToCartLine(orderLine, fresh, 7);
  assert.equal(line.name, 'Frame One (renamed)');
  assert.equal(line.rate, 900);
  assert.equal(line.discount, 2);
  assert.equal(line.qty, 4);
  assert.equal(line.availableStock, 7);
  const orphan = orderLineToCartLine(orderLine, null, 0);
  assert.equal(orphan.name, 'Frame One');
  assert.equal(orphan.availableStock, 0);
});
