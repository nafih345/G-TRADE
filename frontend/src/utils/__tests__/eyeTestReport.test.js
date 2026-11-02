// Run: npm run test:eye-report   (Node's built-in test runner)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEyeTestReportHtml, reportFromExam, splitTimestamp } from '../eyeTestReport.js';

// A backend EyeExamination row: flat columns + the form's raw_data snapshot.
const backendRow = {
  id: 'b1f0c4a2-0000-4000-8000-000000000001',
  test_no: '1042', patient_id: 'P-1007', patient_name: 'Anjali Menon', age: '34', gender: 'Female',
  phone: '9800000001', optometrist: 'Dr. Ravi', test_type: 'COMPREHENSIVE EYE TEST',
  examination_date: '2026-11-02T05:30:00Z',
  sub_sph_od: '-1.25', sub_cyl_od: '-0.50', sub_axis_od: '180', sub_va_od: '6/6', sub_add_od: '',
  sub_sph_os: '-1.00', sub_va_os: '6/6', distance_pd: '62', iop_od: '14',
  primary_diagnosis: 'Myopia', fee_status: 'PAID', fee_amount: '300.00', fee_paid_amount: '300.00', fee_payment_mode: 'UPI',
  raw_data: {
    diagnosisData: { advice: 'Use glasses full time', icdCode: 'H52.1', testType: 'COMPREHENSIVE EYE TEST', testDate: '2026-11-01' },
    subjectiveRefraction: { od: { sph: '-1.25', cyl: '-0.50', axis: '180', va: '6/6' }, os: { sph: '-1.00', va: '6/6' }, odNv: { sph: '+1.00', va: 'N6' }, pd: '62' },
    visualAcuity: { distance: { odWo: '6/18', osWo: '6/12', odPinhole: '6/9' } },
    objectiveRefraction: { autoRefraction: { od: { sph: '-1.50', cyl: '-0.50', axis: '178' }, os: {} } },
    medicalHistory: { chiefComplaints: ['Blurred distance vision', 'Headache'], hasDiabetes: true },
  },
};

test('splitTimestamp gives a local date and 12-hour time', () => {
  const { date, time } = splitTimestamp('2026-11-02T05:30:00Z');
  assert.match(date, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(time, /^\d{2}:\d{2} (AM|PM)$/);
  assert.deepEqual(splitTimestamp('2026-11-02'), { date: '2026-11-02', time: '' });
  assert.deepEqual(splitTimestamp(''), { date: '', time: '' });
});

test('backend row: patient, visit, refraction and clinical notes', () => {
  const r = reportFromExam(backendRow, null);
  assert.equal(r.patient.name, 'Anjali Menon');
  assert.equal(r.patient.id, 'P-1007');
  assert.equal(r.visit.testNo, '1042');
  assert.equal(r.visit.testType, 'COMPREHENSIVE EYE TEST');
  assert.equal(r.visit.optometrist, 'Dr. Ravi');
  assert.ok(r.visit.time);
  assert.equal(r.rx.od.sph, '-1.25');
  assert.equal(r.rx.od.add, '+1.00');
  assert.equal(r.rx.od.nearVa, 'N6');
  assert.equal(r.rx.pd, '62');
  assert.equal(r.visualAcuity.od.ucva, '6/18');
  assert.equal(r.autoRefraction.od.axis, '178');
  assert.equal(r.history.complaints, 'Blurred distance vision, Headache');
  assert.equal(r.history.flags, 'Diabetic');
  const clinical = Object.fromEntries(r.clinical);
  assert.equal(clinical['Primary Diagnosis'], 'Myopia');
  assert.equal(clinical['ICD Code'], 'H52.1');
  assert.equal(clinical.Advice, 'Use glasses full time');
  assert.equal(Object.fromEntries(r.findings)['IOP (mmHg)'], 'RE 14');
});

test('without server billing a paid fee still shows its receipt number', () => {
  const r = reportFromExam(backendRow, null);
  assert.equal(r.billing.available, false);
  assert.equal(r.billing.receiptNo, 'EYE-1042');
  assert.equal(r.billing.amount, 300);
});

test('server billing reference wins and lists linked bills', () => {
  const billing = {
    fee: { status: 'BILLED', is_free_test: false, amount: '300.00', paid_amount: '0.00', receipt_no: '', invoice_number: 'INV-0099', invoice_date: '2026-11-02' },
    invoices: [{ invoice_number: 'INV-0099', document_type: 'INVOICE', invoice_date: '2026-11-02', net_amount: '4500.00', paid_amount: '2000.00', balance: '2500.00', link_label: 'Eye test fee · Dispensed against this test' }],
  };
  const r = reportFromExam(backendRow, billing);
  assert.equal(r.billing.feeStatus, 'BILLED');
  assert.equal(r.billing.receiptNo, '');
  assert.equal(r.billing.feeInvoiceNumber, 'INV-0099');
  const html = buildEyeTestReportHtml(r, { store: { name: 'G Opticals' }, paperSize: 'A5' });
  assert.match(html, /Eye Test Report/);
  assert.match(html, /size: A5/);
  assert.match(html, /INV-0099/);
  assert.match(html, /Dispensed against this test/);
  assert.match(html, /COMPREHENSIVE EYE TEST/);
  assert.match(html, /H52\.1/);
});

test('Patient History row (snapshot spread onto the row) and escaping', () => {
  const r = reportFromExam({
    name: '<b>Rahul</b>', patientId: 'P-2001', testNo: '7', date: '2026-10-01', assignedOptometrist: 'Dr. A',
    subjectiveRefraction: { od: { sph: '+0.50' }, os: {} }, diagnosis: 'Hyperopia', feeStatus: 'FREE', isFreeTest: true,
  });
  assert.equal(r.visit.date, '2026-10-01');
  assert.equal(r.visit.time, '');
  assert.equal(r.billing.isFreeTest, true);
  const html = buildEyeTestReportHtml(r);
  assert.ok(html.includes('&lt;b&gt;Rahul&lt;/b&gt;'));
  assert.match(html, /Free test/);
  assert.match(html, /not saved to the server/);
});

test('a visit with no refraction says so instead of printing an empty grid', () => {
  const html = buildEyeTestReportHtml(reportFromExam({ patient_name: 'X', test_no: '9' }, { fee: {}, invoices: [] }));
  assert.match(html, /No refraction recorded/);
  assert.match(html, /No sale bill linked/);
});
