// Eye test fee rules + the printed Clinical Record & Invoice.
//
// Mirrors backend/apps/sales/eye_test_fees.py: the fee is procedure + medicine − medical aid;
// a FREE EYE TEST takes no payment; a paid test is settled at the test in Cash or GPay (UPI),
// or deferred ("Pay during frame/lens purchase") — then it stays PENDING until New Sale puts it
// on the patient's next bill as an EYE_TEST_FEE service line, which marks it BILLED.
// Pure (no imports) so Node's test runner can load it; printing lives in printEyeTestBill.js.

export const FREE_TEST_TYPE = 'FREE EYE TEST';
export const EYE_TEST_FEE_KIND = 'EYE_TEST_FEE';

export const EYE_TEST_PAY_MODES = [
  { value: 'CASH', label: 'Cash' },
  { value: 'UPI', label: 'GPay (UPI)' },
];
export const payModeLabel = (v) => EYE_TEST_PAY_MODES.find((m) => m.value === String(v || '').toUpperCase())?.label || '';

const num = (v) => Math.max(0, parseFloat(v) || 0);
const round2 = (n) => Math.round(n * 100) / 100;

// How the visit is settled, picked on the Payment Details screen.
export const PAY_NOW = 'PAY_NOW';
export const NO_PAYMENT = 'NO_PAYMENT';
export const PAY_AFTER_SALE = 'PAY_AFTER_SALE';
export const PAYMENT_CHOICES = [
  { value: PAY_NOW, label: 'Pay Now' },
  { value: NO_PAYMENT, label: 'No Payment' },
  { value: PAY_AFTER_SALE, label: 'Pay After Sale' },
];

// The explicit payment choice wins; before one is made, the Test Type decides (its default,
// FREE EYE TEST, is free).
export const isFreeEyeTest = (diagnosis = {}) => (diagnosis?.paymentChoice
  ? diagnosis.paymentChoice === NO_PAYMENT
  : (diagnosis?.testType || FREE_TEST_TYPE) === FREE_TEST_TYPE);

/** The choice to show on the Payment Details screen (the one made, else from the Test Type). */
export const paymentChoiceOf = (d = {}) => d?.paymentChoice
  || (d?.payLater ? PAY_AFTER_SALE : (isFreeEyeTest(d) ? NO_PAYMENT : PAY_NOW));

/** diagnosis fields for a choice — payLater is what the save payload / backend read. */
export const applyPaymentChoice = (choice) => ({ paymentChoice: choice, payLater: choice === PAY_AFTER_SALE });

/** What the patient owes for the visit: procedure + medicine, less the medical aid cover. */
export const eyeTestFeeTotal = (d = {}) =>
  round2(Math.max(0, num(d.procedureCharge) + num(d.medicineCharge) - num(d.medicalAidCharge)));

/** The status the backend will derive for this diagnosis (shown before the save returns). */
export function expectedFeeStatus(d = {}) {
  if (isFreeEyeTest(d)) return 'FREE';
  if (d.payLater && eyeTestFeeTotal(d) > 0) return 'PENDING';
  return 'PAID';
}

/** Eye Test → API fee fields (see EyeExaminationSerializer.validate). */
export function feePayload(d = {}) {
  const free = isFreeEyeTest(d);
  return {
    is_free_test: free,
    procedure_charge: free ? 0 : num(d.procedureCharge),
    medical_aid_charge: free ? 0 : num(d.medicalAidCharge),
    medicine_charge: free ? 0 : num(d.medicineCharge),
    fee_deferred: !free && Boolean(d.payLater),
    fee_paid_amount: free || d.payLater ? 0 : num(d.customerPaidAmount),
    fee_payment_mode: free || d.payLater ? '' : (d.paymentMode || 'CASH'),
  };
}

export const FEE_STATUS_LABELS = {
  FREE: 'Free test',
  PAID: 'Paid',
  PENDING: 'Pending eye test fee',
  BILLED: 'Billed in sale',
};

// ── New Sale ────────────────────────────────────────────────────────────────────────────────
/** The bill line for a backend exam whose fee is PENDING. */
export function eyeTestFeeLine(exam) {
  const amount = round2(num(exam.fee_amount));
  const date = String(exam.examination_date || '').split('T')[0];
  return {
    id: `ITEM-EYEFEE-${exam.id}`,
    productId: null,
    serviceId: null,
    itemType: 'SERVICE',
    serviceDetails: { kind: EYE_TEST_FEE_KIND, eye_examination_id: exam.id, test_no: exam.test_no || '', exam_date: date },
    barcode: 'EYE-TEST',
    item: `Eye Test Fee (Test No ${exam.test_no || '—'})`,
    modelNo: '—', color: '—', size: '—',
    brand: 'SERVICE', supplier: '', rack: '', stock: null,
    category: 'SERVICE', group: 'SERVICE',
    power: [date && `Examined ${date}`, exam.optometrist].filter(Boolean).join(' · '),
    serviceDescription: [date && `Examined ${date}`, exam.optometrist].filter(Boolean).join(' · '),
    qty: 1, price: amount, gross: amount,
    disc: 0, discMode: 'PCT', discValue: 0, discPercent: 0,
    tax: 0, taxPercent: 0, total: amount,
  };
}

export const isEyeTestFeeLine = (item) => item?.serviceDetails?.kind === EYE_TEST_FEE_KIND;

// ── Print ───────────────────────────────────────────────────────────────────────────────────
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => `₹${(Number(n) || 0).toFixed(2)}`;
const blank = (v) => v === undefined || v === null || String(v).trim() === '';
const cell = (v) => (blank(v) ? '—' : esc(v));

/**
 * One saved visit (an Eye Test directory row / the form's own state, same shape) → the fields
 * the printed record needs. Backend fee columns win over the client snapshot when present.
 */
export function billRecordFromExam(row = {}) {
  const p = row.patientData || {};
  const d = row.diagnosisData || row.diagnosis || {};
  const diag = typeof d === 'object' ? d : {};
  const sub = row.subjectiveRefraction || {};
  const charges = {
    procedureCharge: diag.procedureCharge ?? row.procedureCharge,
    medicineCharge: diag.medicineCharge ?? row.medicineCharge,
    medicalAidCharge: diag.medicalAidCharge ?? row.medicalAidCharge,
  };
  // Visits saved before fees were tracked have no fee status and no payLater flag, and their
  // Test Type was the old FREE EYE TEST default even when charges were taken — free only
  // if nothing was charged.
  const legacy = !row.feeStatus && diag.payLater === undefined;
  const free = legacy ? eyeTestFeeTotal(charges) === 0 : (row.isFreeTest ?? isFreeEyeTest(diag));
  const status = row.feeStatus || (legacy ? (free ? 'FREE' : 'PAID') : expectedFeeStatus(diag));
  return {
    testNo: row.testNo || diag.testNo || '',
    date: row.date || '',
    patientId: row.patientId || p.id || '',
    name: row.name || p.name || '',
    phone: row.phone || p.phone || '',
    age: row.age || p.age || '',
    gender: row.gender || p.gender || '',
    address: [row.address || p.address, row.place || p.place || p.city].filter((x) => !blank(x)).join(', '),
    optometrist: row.assignedOptometrist || p.assignedOptometrist || row.optometrist || row.doctor || '',
    testType: diag.testType || FREE_TEST_TYPE,
    rx: {
      od: sub.od || {}, os: sub.os || {},
      odAdd: sub.odNv?.sph || sub.nearAdd || '', osAdd: sub.osNv?.sph || sub.nearAdd || '',
      pd: sub.pd || '',
    },
    diagnosis: diag.primary || (typeof row.diagnosis === 'string' ? row.diagnosis : ''),
    advice: diag.advice || '',
    nextVisit: diag.nextReviewDate || '',
    isFreeTest: free,
    procedureCharge: free ? 0 : num(charges.procedureCharge),
    medicineCharge: free ? 0 : num(charges.medicineCharge),
    medicalAidCharge: free ? 0 : num(charges.medicalAidCharge),
    medicalAidName: row.medicalAidName || p.medicalAidName || '',
    paidAmount: status === 'PAID' ? num(diag.customerPaidAmount ?? row.customerPaidAmount) : 0,
    paymentMode: status === 'PAID' ? (diag.paymentMode || 'CASH') : '',
    feeStatus: status,
    feeInvoiceNumber: row.feeInvoiceNumber || '',
  };
}

export function buildEyeTestBillHtml(r, { store = {}, paperSize = 'A4' } = {}) {
  const storeName = store.display_name || store.name || '';
  const address = store.document_address || [store.address, store.city, store.state, store.pin_code].filter(Boolean).join(', ');
  const contact = [store.phone && `Ph: ${store.phone}`, store.email, store.gstin && `GSTIN: ${store.gstin}`].filter(Boolean).join(' · ');
  const total = r.isFreeTest ? 0 : eyeTestFeeTotal(r);
  const balance = Math.max(0, total - (r.paidAmount || 0));

  const lines = r.isFreeTest
    ? [['Eye Examination — Free Test', 0]]
    : [['Eye Examination / Procedure Charge', r.procedureCharge],
      ...(r.medicineCharge ? [['Medicine / Pharmacy Charge', r.medicineCharge]] : []),
      ...(r.medicalAidCharge ? [[`Medical Aid Cover${r.medicalAidName ? ` (${r.medicalAidName})` : ''}`, -r.medicalAidCharge]] : [])];
  const chargeRows = lines.map(([label, amt], i) =>
    `<tr><td class="c">${i + 1}</td><td>${esc(label)}</td><td class="r">${amt < 0 ? `− ${money(-amt)}` : money(amt)}</td></tr>`).join('');

  let settlement;
  if (r.isFreeTest) settlement = '<tr class="grand"><td colspan="2" class="r">Amount Payable</td><td class="r">FREE</td></tr>';
  else if (r.feeStatus === 'PENDING' || r.feeStatus === 'BILLED') {
    settlement = `<tr class="grand"><td colspan="2" class="r">Total</td><td class="r">${money(total)}</td></tr>
      <tr><td colspan="3" class="note">${r.feeStatus === 'BILLED'
    ? `Eye test fee billed on ${esc(r.feeInvoiceNumber || 'the frame / lens purchase bill')}.`
    : 'PENDING EYE TEST FEE — payable with the frame / lens purchase.'}</td></tr>`;
  } else {
    settlement = `<tr class="grand"><td colspan="2" class="r">Total</td><td class="r">${money(total)}</td></tr>
      <tr><td colspan="2" class="r">Paid${r.paymentMode ? ` (${esc(payModeLabel(r.paymentMode))})` : ''}</td><td class="r">${money(r.paidAmount)}</td></tr>
      ${balance > 0.004 ? `<tr><td colspan="2" class="r"><b>Balance Due</b></td><td class="r"><b>${money(balance)}</b></td></tr>` : ''}`;
  }

  const eyeRow = (label, e, add) => `<tr><td class="c"><b>${label}</b></td><td class="c">${cell(e.sph)}</td><td class="c">${cell(e.cyl)}</td>
    <td class="c">${cell(e.axis)}</td><td class="c">${cell(e.va)}</td><td class="c">${cell(add)}</td></tr>`;
  const hasRx = ['sph', 'cyl', 'axis', 'va'].some((k) => !blank(r.rx.od[k]) || !blank(r.rx.os[k])) || !blank(r.rx.odAdd) || !blank(r.rx.osAdd);
  const a5 = paperSize === 'A5';

  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(`Eye Test ${r.testNo || ''}`.trim())}</title>
<style>
  @page { size: ${a5 ? 'A5' : 'A4'}; margin: ${a5 ? '8mm' : '12mm'}; }
  * { box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; color: #0f172a; font-size: ${a5 ? '11px' : '12.5px'}; margin: 0; }
  .head { text-align: center; border-bottom: 2px solid #0f172a; padding-bottom: 6px; margin-bottom: 8px; }
  .head h1 { margin: 0; font-size: ${a5 ? '17px' : '21px'}; letter-spacing: .5px; }
  .head .sub { color: #475569; font-size: .92em; margin-top: 2px; }
  .title { display: flex; justify-content: space-between; align-items: baseline; margin: 6px 0 8px; }
  .title h2 { margin: 0; font-size: 1.15em; text-transform: uppercase; letter-spacing: .6px; }
  .badge { border: 1.5px solid #0f172a; border-radius: 4px; padding: 1px 8px; font-weight: 700; font-size: .9em; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 3px 18px; margin-bottom: 8px; }
  .grid div span { color: #475569; display: inline-block; min-width: 92px; }
  h3 { font-size: .95em; text-transform: uppercase; letter-spacing: .5px; margin: 10px 0 4px; color: #334155; }
  table { width: 100%; border-collapse: collapse; }
  th, td { border: 1px solid #94a3b8; padding: 4px 6px; }
  th { background: #e2e8f0; font-size: .9em; }
  .c { text-align: center; } .r { text-align: right; white-space: nowrap; }
  tr.grand td { font-weight: 700; background: #f1f5f9; }
  td.note { font-weight: 700; text-align: center; background: #fef3c7; }
  .notes div { margin: 2px 0; } .notes span { color: #475569; }
  .sign { display: flex; justify-content: space-between; margin-top: ${a5 ? '22px' : '36px'}; }
  .sign div { border-top: 1px solid #0f172a; padding-top: 3px; min-width: 150px; text-align: center; }
</style></head><body>
  <div class="head">
    <h1>${esc(storeName || 'Eye Clinic')}</h1>
    ${address ? `<div class="sub">${esc(address)}</div>` : ''}
    ${contact ? `<div class="sub">${esc(contact)}</div>` : ''}
    ${store.clinical_reg_no ? `<div class="sub">Clinical Reg. No: ${esc(store.clinical_reg_no)}</div>` : ''}
  </div>
  <div class="title"><h2>Clinical Record &amp; Invoice</h2><span class="badge">${esc(r.isFreeTest ? 'FREE TEST' : (r.testType || 'EYE TEST'))}</span></div>
  <div class="grid">
    <div><span>Patient</span><b>${cell(r.name)}</b></div>
    <div><span>Test No</span><b>${cell(r.testNo)}</b></div>
    <div><span>Patient ID</span>${cell(r.patientId)}</div>
    <div><span>Date</span>${cell(r.date)}</div>
    <div><span>Contact</span>${cell(r.phone)}</div>
    <div><span>Age / Gender</span>${cell([r.age, r.gender].filter((x) => !blank(x)).join(' / '))}</div>
    ${r.address ? `<div><span>Address</span>${esc(r.address)}</div>` : ''}
    <div><span>Optometrist</span><b>${cell(r.optometrist)}</b></div>
  </div>

  <h3>Examination / Prescription</h3>
  ${hasRx ? `<table><thead><tr><th>Eye</th><th>SPH</th><th>CYL</th><th>AXIS</th><th>VA</th><th>ADD</th></tr></thead>
    <tbody>${eyeRow('RE (OD)', r.rx.od, r.rx.odAdd)}${eyeRow('LE (OS)', r.rx.os, r.rx.osAdd)}</tbody></table>
    ${r.rx.pd ? `<div style="margin-top:3px">PD: ${esc(r.rx.pd)}</div>` : ''}` : '<div>No refraction recorded.</div>'}
  <div class="notes">
    ${r.diagnosis ? `<div><span>Diagnosis:</span> ${esc(r.diagnosis)}</div>` : ''}
    ${r.advice ? `<div><span>Advice:</span> ${esc(r.advice)}</div>` : ''}
    ${r.nextVisit ? `<div><span>Next visit:</span> ${esc(r.nextVisit)}</div>` : ''}
  </div>

  <h3>Charges</h3>
  <table><thead><tr><th class="c" style="width:36px">#</th><th>Description</th><th class="r">Amount</th></tr></thead>
    <tbody>${chargeRows}</tbody><tfoot>${settlement}</tfoot></table>

  <div class="sign"><div>Patient Signature</div><div>${esc(r.optometrist || 'Optometrist')}</div></div>
</body></html>`;
}

/** Receipt number for a fee paid at the test — the same number its ledger voucher carries. */
export const eyeTestReceiptNo = (testNo) => (testNo ? `EYE-${testNo}` : '');

/** A short payment receipt (80 mm roll or any printer) for what was collected at the test. */
export function buildEyeTestReceiptHtml(r, { store = {} } = {}) {
  const storeName = store.display_name || store.name || '';
  const address = store.document_address || [store.address, store.city, store.state, store.pin_code].filter(Boolean).join(', ');
  const total = r.isFreeTest ? 0 : eyeTestFeeTotal(r);
  const balance = Math.max(0, total - (r.paidAmount || 0));
  const row = (label, value, strong) => `<tr${strong ? ' class="b"' : ''}><td>${esc(label)}</td><td class="r">${value}</td></tr>`;
  let settled;
  if (r.isFreeTest) settled = row('Amount', 'FREE TEST', true);
  else if (r.feeStatus === 'PENDING' || r.feeStatus === 'BILLED') {
    settled = `${row('Fee', money(total), true)}<tr><td colspan="2" class="note">${r.feeStatus === 'BILLED'
      ? `Billed on ${esc(r.feeInvoiceNumber || 'the sale bill')}` : 'PENDING — payable with frame / lens purchase'}</td></tr>`;
  } else {
    settled = `${row('Fee', money(total))}${row(`Received${r.paymentMode ? ` (${payModeLabel(r.paymentMode)})` : ''}`, money(r.paidAmount), true)}${
      balance > 0.004 ? row('Balance due', money(balance), true) : ''}`;
  }
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(eyeTestReceiptNo(r.testNo) || 'Eye Test Receipt')}</title>
<style>
  @page { size: 80mm auto; margin: 4mm; }
  body { font-family: Arial, Helvetica, sans-serif; color: #000; font-size: 12px; margin: 0 auto; width: 72mm; }
  h1 { font-size: 15px; margin: 0; text-align: center; } .c { text-align: center; } .sub { font-size: 10.5px; text-align: center; }
  h2 { font-size: 12.5px; text-align: center; margin: 6px 0 4px; letter-spacing: .5px; border-top: 1px dashed #000; border-bottom: 1px dashed #000; padding: 3px 0; }
  table { width: 100%; border-collapse: collapse; } td { padding: 2px 0; vertical-align: top; } .r { text-align: right; white-space: nowrap; }
  tr.b td { font-weight: 700; } td.note { text-align: center; font-weight: 700; padding-top: 4px; }
  .sep { border-top: 1px dashed #000; margin: 5px 0; } .foot { text-align: center; margin-top: 8px; font-size: 11px; }
</style></head><body>
  <h1>${esc(storeName || 'Eye Clinic')}</h1>
  ${address ? `<div class="sub">${esc(address)}</div>` : ''}
  ${store.phone ? `<div class="sub">Ph: ${esc(store.phone)}</div>` : ''}
  <h2>PAYMENT RECEIPT</h2>
  <table>
    ${row('Receipt No', cell(eyeTestReceiptNo(r.testNo)))}
    ${row('Date', cell(r.date))}
    ${row('Patient', cell(r.name))}
    ${row('Patient ID', cell(r.patientId))}
    ${r.phone ? row('Contact', esc(r.phone)) : ''}
    ${row('Test No', cell(r.testNo))}
    ${row('Optometrist', cell(r.optometrist))}
  </table>
  <div class="sep"></div>
  <table>
    ${r.isFreeTest ? '' : row('Eye examination', money(r.procedureCharge))}
    ${!r.isFreeTest && r.medicineCharge ? row('Medicine', money(r.medicineCharge)) : ''}
    ${!r.isFreeTest && r.medicalAidCharge ? row(`Medical aid${r.medicalAidName ? ` (${r.medicalAidName})` : ''}`, `− ${money(r.medicalAidCharge)}`) : ''}
  </table>
  <div class="sep"></div>
  <table>${settled}</table>
  <div class="foot">Thank you</div>
</body></html>`;
}
