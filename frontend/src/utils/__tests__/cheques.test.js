// Run: npm run test:cheques   (Node's built-in test runner)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  blankCheque, chequeDaysLeft, chequeDueDate, chequeFromRow, chequePayload, daysBetween, daysLeftLabel, daysLeftTone,
  validateCheque,
} from '../cheques.js';

test('daysBetween counts whole calendar days, across month and DST boundaries', () => {
  assert.equal(daysBetween('2026-10-29', '2026-11-03'), 5);
  assert.equal(daysBetween('2026-03-28', '2026-03-30'), 2);
  assert.equal(daysBetween('2026-10-29', '2026-10-29'), 0);
  assert.equal(daysBetween('2026-10-29', '2026-10-20'), -9);
  assert.equal(daysBetween('', '2026-10-20'), null);
});

test('countdown runs to the deposited date, else the cheque date', () => {
  const c = blankCheque({ chequeDate: '2026-11-05' });
  assert.equal(chequeDueDate(c), '2026-11-05');
  assert.equal(chequeDaysLeft(c, '2026-10-29'), 7);
  assert.equal(chequeDaysLeft({ ...c, depositedDate: '2026-11-10' }, '2026-10-29'), 12);
});

test('days-left wording and tone', () => {
  assert.equal(daysLeftLabel(0), 'Due today');
  assert.equal(daysLeftLabel(1), '1 day left');
  assert.equal(daysLeftLabel(4), '4 days left');
  assert.equal(daysLeftLabel(-1), 'Overdue by 1 day');
  assert.equal(daysLeftLabel(-3), 'Overdue by 3 days');
  assert.equal(daysLeftLabel(null), '—');
  assert.deepEqual([-2, 0, 7, 8, null].map(daysLeftTone), ['overdue', 'today', 'soon', 'later', '']);
});

test('validation', () => {
  assert.deepEqual(validateCheque(null, 10), ['enter the cheque details']);
  const ok = blankCheque({ chequeNumber: '445566', chequeDate: '2026-10-29' });
  assert.deepEqual(validateCheque(ok, '600'), []);
  assert.deepEqual(validateCheque({ ...ok, chequeNumber: '  ' }, '600'), ['enter the cheque number']);
  assert.deepEqual(validateCheque(ok, ''), ['enter the cheque amount']);
  assert.deepEqual(validateCheque({ ...ok, depositedDate: '2026-10-28' }, 5), ['the deposited date is before the cheque date']);
});

test('payload trims, nulls a blank deposit date and round-trips through a register row', () => {
  const c = blankCheque({ chequeNumber: ' 0012 ', chequeDate: '2026-10-29', bankName: ' SBI ', partyName: 'Asha', remarks: '' });
  const p = chequePayload(c, 17);
  assert.deepEqual(p, { cheque_number: '0012', cheque_date: '2026-10-29', bank_name: 'SBI', deposited_date: null,
    party_name: 'Asha', remarks: '', ref: '17' });
  assert.equal('ref' in chequePayload(c), false);
  assert.deepEqual(chequeFromRow({ ...p, deposited_date: null }), {
    chequeNumber: '0012', chequeDate: '2026-10-29', bankName: 'SBI', depositedDate: '', partyName: 'Asha', remarks: '' });
});
