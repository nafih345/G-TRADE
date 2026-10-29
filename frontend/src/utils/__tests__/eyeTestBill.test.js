// Run: npm run test:eye-test   (Node's built-in test runner)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EYE_TEST_FEE_KIND, billRecordFromExam, buildEyeTestBillHtml, expectedFeeStatus, eyeTestFeeLine,
  eyeTestFeeTotal, feePayload, isEyeTestFeeLine, isFreeEyeTest,
} from '../eyeTestBill.js';

const paid = { testType: 'COMPREHENSIVE EYE TEST', procedureCharge: '250', medicineCharge: '50', medicalAidCharge: '100', customerPaidAmount: '200', paymentMode: 'UPI', payLater: false };

test('fee total = procedure + medicine − medical aid, never negative', () => {
  assert.equal(eyeTestFeeTotal(paid), 200);
  assert.equal(eyeTestFeeTotal({ procedureCharge: '100', medicalAidCharge: '300' }), 0);
  assert.equal(eyeTestFeeTotal({ procedureCharge: 'abc' }), 0);
});

test('Test Type FREE EYE TEST (also the default) is free', () => {
  assert.equal(isFreeEyeTest({}), true);
  assert.equal(isFreeEyeTest({ testType: 'FREE EYE TEST' }), true);
  assert.equal(isFreeEyeTest(paid), false);
});

test('expected status: free, paid, or pending when deferred with something to pay', () => {
  assert.equal(expectedFeeStatus({ testType: 'FREE EYE TEST', procedureCharge: '200' }), 'FREE');
  assert.equal(expectedFeeStatus(paid), 'PAID');
  assert.equal(expectedFeeStatus({ ...paid, payLater: true }), 'PENDING');
  assert.equal(expectedFeeStatus({ testType: 'ROUTINE REFRACTION', payLater: true }), 'PAID');
});

test('payload: free sends no charges, deferred sends no payment', () => {
  assert.deepEqual(feePayload({ testType: 'FREE EYE TEST', procedureCharge: '200', customerPaidAmount: '200' }), {
    is_free_test: true, procedure_charge: 0, medical_aid_charge: 0, medicine_charge: 0,
    fee_deferred: false, fee_paid_amount: 0, fee_payment_mode: '',
  });
  const later = feePayload({ ...paid, payLater: true });
  assert.equal(later.fee_deferred, true);
  assert.equal(later.fee_paid_amount, 0);
  assert.equal(later.fee_payment_mode, '');
  assert.equal(later.procedure_charge, 250);
  assert.equal(feePayload(paid).fee_payment_mode, 'UPI');
  assert.equal(feePayload(paid).fee_paid_amount, 200);
});

test('New Sale line for a pending exam', () => {
  const line = eyeTestFeeLine({ id: 'e1', test_no: '1003', fee_amount: '200.00', examination_date: '2026-10-28T10:00:00Z', optometrist: 'Dr. Rao' });
  assert.equal(line.item, 'Eye Test Fee (Test No 1003)');
  assert.equal(line.total, 200);
  assert.equal(line.itemType, 'SERVICE');
  assert.deepEqual(line.serviceDetails, { kind: EYE_TEST_FEE_KIND, eye_examination_id: 'e1', test_no: '1003', exam_date: '2026-10-28' });
  assert.equal(isEyeTestFeeLine(line), true);
  assert.equal(isEyeTestFeeLine({ serviceDetails: { technician: 'x' } }), false);
});

const row = (diagnosisData, extra = {}) => ({
  testNo: '1003', date: '2026-10-29', patientId: 'P-1001', name: 'Anjali <Menon>', phone: '98000',
  assignedOptometrist: 'Dr. Rao', diagnosisData, subjectiveRefraction: { od: { sph: '-1.00', va: '6/6' }, os: { sph: '-1.25' } },
  ...extra,
});

test('printed record: patient, Rx, optometrist, charges and pay mode', () => {
  const html = buildEyeTestBillHtml(billRecordFromExam(row(paid)), { store: { name: 'G Opticals' } });
  for (const s of ['G Opticals', 'Anjali &lt;Menon&gt;', 'P-1001', '98000', 'Dr. Rao', '-1.00', '-1.25', '6/6',
    '₹250.00', '₹50.00', '− ₹100.00', 'Paid (GPay (UPI))', '₹200.00']) assert.ok(html.includes(s), s);
  assert.ok(!html.includes('Balance Due'));
});

test('printed record: free test and pending fee', () => {
  const free = buildEyeTestBillHtml(billRecordFromExam(row({ testType: 'FREE EYE TEST', payLater: false, procedureCharge: '200' })));
  assert.ok(free.includes('FREE TEST'));
  assert.ok(!free.includes('₹200.00'));
  const pending = buildEyeTestBillHtml(billRecordFromExam(row({ ...paid, payLater: true })));
  assert.ok(pending.includes('PENDING EYE TEST FEE'));
  assert.ok(!pending.includes('Paid ('));
  const billed = billRecordFromExam(row({ ...paid, payLater: true }, { feeStatus: 'BILLED', feeInvoiceNumber: 'INV-0042' }));
  assert.ok(buildEyeTestBillHtml(billed).includes('INV-0042'));
});

test('a visit saved before fees were tracked is paid when it had charges', () => {
  const legacy = billRecordFromExam(row({ testType: 'FREE EYE TEST', procedureCharge: '150', customerPaidAmount: '150' }));
  assert.equal(legacy.isFreeTest, false);
  assert.equal(legacy.feeStatus, 'PAID');
  assert.equal(legacy.paidAmount, 150);
  assert.equal(billRecordFromExam(row({ testType: 'FREE EYE TEST' })).feeStatus, 'FREE');
});

test('payment receipt: receipt no, amount received and mode; pending / free wording', async () => {
  const { buildEyeTestReceiptHtml, eyeTestReceiptNo } = await import('../eyeTestBill.js');
  assert.equal(eyeTestReceiptNo('1003'), 'EYE-1003');
  assert.equal(eyeTestReceiptNo(''), '');
  const partial = { ...paid, customerPaidAmount: '150' };
  const html = buildEyeTestReceiptHtml(billRecordFromExam(row(partial)), { store: { name: 'G Opticals', phone: '0471' } });
  for (const s of ['PAYMENT RECEIPT', 'EYE-1003', 'G Opticals', 'Received (GPay (UPI))', '₹150.00', 'Balance due', '₹50.00', 'Dr. Rao'])
    assert.ok(html.includes(s), s);
  assert.ok(buildEyeTestReceiptHtml(billRecordFromExam(row({ ...paid, payLater: true }))).includes('PENDING'));
  assert.ok(buildEyeTestReceiptHtml(billRecordFromExam(row({ testType: 'FREE EYE TEST', payLater: false }))).includes('FREE TEST'));
});
