import test from 'node:test';
import assert from 'node:assert/strict';
import { allocationSummary, fifoAllocate, rowOutcome } from '../billSettlement.js';

const bills = () => [
  { id: 1, due: '1500.00', amount: '', selected: false },
  { id: 2, due: '1000.00', amount: '', selected: false },
  { id: 3, due: '500.00', amount: '', selected: false },
  { id: 4, due: '2000.00', amount: '', selected: false },
];

test('3,000 over 1,500 + 1,000 + 500 + 2,000 closes the first three (FIFO)', () => {
  const rows = fifoAllocate(bills(), 3000);
  assert.deepEqual(rows.map((r) => r.amount), ['1500', '1000', '500', '']);
  assert.deepEqual(rows.map((r) => r.selected), [true, true, true, false]);
  assert.deepEqual(rows.map((r) => rowOutcome(r).status), ['Closed', 'Closed', 'Closed', 'Open']);
  assert.equal(rowOutcome(rows[3]).after, 2000);
  assert.deepEqual(allocationSummary(rows, '3000'), { allocated: 3000, unallocated: 0, hasTotal: true });
});

test('a partial payment leaves the exact remaining balance open', () => {
  const rows = fifoAllocate(bills(), '2000.5');
  assert.deepEqual(rows.map((r) => r.amount), ['1500', '500.5', '', '']);
  assert.deepEqual(rowOutcome(rows[1]), { after: 499.5, status: 'Partial' });
});

test('more than all dues leaves the excess unallocated', () => {
  const rows = fifoAllocate(bills(), 5200);
  assert.equal(allocationSummary(rows, 5200).unallocated, 200);
});

test('manual edits show the difference to the total', () => {
  const rows = bills();
  rows[3] = { ...rows[3], selected: true, amount: '2000' };
  rows[2] = { ...rows[2], selected: true, amount: '500' };
  assert.deepEqual(allocationSummary(rows, '3000'), { allocated: 2500, unallocated: 500, hasTotal: true });
  assert.deepEqual(allocationSummary(rows, ''), { allocated: 2500, unallocated: 0, hasTotal: false });
});

test('zero / blank clears every bill and never mutates the input', () => {
  const input = fifoAllocate(bills(), 3000);
  const cleared = fifoAllocate(input, 0);
  assert.ok(cleared.every((r) => !r.selected && r.amount === ''));
  assert.equal(input[0].amount, '1500');
});
