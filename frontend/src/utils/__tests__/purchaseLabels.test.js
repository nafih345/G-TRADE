// Run: npm run test:purchase-labels   (Node's built-in test runner)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPrintLines, buildReprintLines, countThrough, jobSize, positionOf, printRows } from '../purchaseLabels.js';

const item = (id, total, printed = 0) => ({
  id, product: `p-${id}`, product_name: `Item ${id}`, total, printed,
  pending: total - printed, next_unit: printed < total ? printed + 1 : null,
});
const ten = Array.from({ length: 10 }, (_, i) => item(String(i + 1), 100));

test('print lines continue each line from its next unit, capped at what is pending', () => {
  const items = [item('a', 100, 50), item('b', 10), item('c', 5, 5)];
  assert.deepEqual(buildPrintLines(items, { a: 999, b: 4, c: 3 }), [
    { item: 'a', from_unit: 51, to_unit: 100 },
    { item: 'b', from_unit: 1, to_unit: 4 },
  ]);
  assert.deepEqual(buildPrintLines(items, {}), []);
});

test('reprint lines stay inside the printed units', () => {
  const items = [item('a', 100, 50), item('b', 10)];
  assert.deepEqual(buildReprintLines(items, { a: { from: 0, to: 80 }, b: { from: 1, to: 5 } }), [
    { item: 'a', from_unit: 1, to_unit: 50 },
  ]);
});

test('stopped after unit 50 of the 5th item = 450 labels, and back', () => {
  const lines = buildPrintLines(ten, Object.fromEntries(ten.map((i) => [i.id, i.pending])));
  assert.equal(jobSize(lines), 1000);
  assert.equal(countThrough(lines, 4, 50), 450);
  assert.deepEqual(positionOf(lines, 450), { index: 4, unit: 50 });
  assert.deepEqual(positionOf(lines, 401), { index: 4, unit: 1 });
  assert.deepEqual(positionOf(lines, 400), { index: 3, unit: 100 });
  assert.equal(positionOf(lines, 0), null);
  // Resumed job: units start at 51 on line 5.
  const resumed = [{ item: '5', from_unit: 51, to_unit: 100 }, { item: '6', from_unit: 1, to_unit: 100 }];
  assert.equal(countThrough(resumed, 0, 60), 10);
  assert.equal(countThrough(resumed, 0, 10), 0);
  assert.deepEqual(positionOf(resumed, 51), { index: 1, unit: 1 });
});

test('print rows carry the range size and the line batch / expiry', () => {
  const items = [{ ...item('a', 5), batch_number: 'B1', expiry_date: '2027-01-01', barcode: '123' }];
  const rows = printRows([{ item: 'a', from_unit: 2, to_unit: 5 }], items, { 'p-a': { fields: { barcode: '123' } } });
  assert.equal(rows[0].qty, 4);
  assert.deepEqual(rows[0].job, { batch_no: 'B1', expiry_date: '2027-01-01' });
  assert.equal(rows[0].data.fields.barcode, '123');
});
