// Eye Test Report — one visit's complete clinical record (A to Z) with its billing reference.
//
// reportFromExam() reads any shape a visit comes in: a backend EyeExamination row (flat columns +
// the form's raw_data snapshot), a Patient History row (raw_data spread onto the row) or an Eye
// Test directory row (the snapshot itself). The snapshot wins where it holds more than the flat
// columns (grid sections without DB columns); flat columns cover rows saved before the snapshot
// carried them. `billing` is GET /api/sales/eye-examinations/<id>/report/'s `billing` (fee
// receipt, the bill a deferred fee went onto, bills dispensed against the Test No) — null when the
// visit was never saved to the server, and the report then says the bill links are unavailable.
// Pure (no imports beyond eyeTestBill.js) so Node's test runner can load it.

import { FEE_STATUS_LABELS, eyeTestReceiptNo, payModeLabel } from './eyeTestBill.js';

const blank = (v) => v === undefined || v === null || String(v).trim() === '' || String(v).trim() === '—';
const pick = (...vals) => {
  const hit = vals.find((v) => !blank(v));
  return hit === undefined ? '' : String(hit).trim();
};
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const list = (v) => (Array.isArray(v) ? v.filter((x) => !blank(x)).join(', ') : v);
const num = (v) => Math.max(0, parseFloat(v) || 0);
const pad = (n) => String(n).padStart(2, '0');

/** Local date (YYYY-MM-DD) + time (hh:mm AM/PM) of a server timestamp — the server stores UTC. */
export function splitTimestamp(iso) {
  if (blank(iso) || !String(iso).includes('T')) return { date: blank(iso) ? '' : String(iso).slice(0, 10), time: '' };
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { date: String(iso).slice(0, 10), time: '' };
  const h = d.getHours();
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(h % 12 || 12)}:${pad(d.getMinutes())} ${h < 12 ? 'AM' : 'PM'}`,
  };
}

const eyeRow = (...sources) => ({
  sph: pick(...sources.map((s) => s.sph)),
  cyl: pick(...sources.map((s) => s.cyl)),
  axis: pick(...sources.map((s) => s.axis)),
  va: pick(...sources.map((s) => s.va)),
});

export function reportFromExam(row = {}, billing = null) {
  const raw = Object.keys(obj(row.raw_data)).length ? row.raw_data : row;
  const p = obj(raw.patientData || row.patientData);
  const diag = obj(raw.diagnosisData || row.diagnosisData || (typeof raw.diagnosis === 'object' ? raw.diagnosis : null));
  const sub = obj(raw.subjectiveRefraction || row.subjectiveRefraction);
  const va = obj(raw.visualAcuity || row.visualAcuity);
  const objective = obj(raw.objectiveRefraction || row.objectiveRefraction);
  const health = obj(raw.eyeHealth || row.eyeHealth);
  const bv = obj(raw.binocularVision || row.binocularVision);
  const mh = obj(raw.medicalHistory || row.medicalHistory);
  const presc = obj(raw.prescription || row.prescription);
  const ar = obj(objective.autoRefraction);
  const ret = obj(objective.retinoscopy);
  const k = obj(objective.kReading);
  const dist = obj(va.distance);
  const near = obj(va.near);
  const ant = obj(health.anterior);
  const post = obj(health.posterior);
  const iop = obj(health.iop);
  const cdr = obj(health.cupDiscRatio);

  const stamp = splitTimestamp(row.examination_date);
  const date = pick(stamp.date, row.date, raw.date);
  const testDate = pick(diag.testDate);

  const fee = obj(billing?.fee);
  const feeStatus = pick(fee.status, row.fee_status, row.feeStatus);
  const testNo = pick(row.test_no, row.testNo, raw.testNo, diag.testNo);

  return {
    patient: {
      name: pick(row.patient_name, row.name, p.name),
      id: pick(row.patient_code, row.patient_id, row.patientId, p.id),
      age: pick(row.age, p.age),
      gender: pick(row.gender, p.gender),
      phone: pick(row.phone, p.phone),
      email: pick(row.email, p.email),
      address: [pick(row.address, p.address), pick(row.place, p.place, p.city)].filter(Boolean).join(', '),
      occupation: pick(row.occupation, p.occupation),
      medicalAid: [pick(p.medicalAidName, row.medicalAidName), pick(p.medicalAidMemberNumber)].filter(Boolean).join(' · '),
    },
    visit: {
      testNo,
      testType: pick(row.test_type, diag.testType, row.testType),
      date,
      // The Date the optometrist picked on the form, when it isn't the day the record was saved.
      testDate: testDate && testDate !== date ? testDate : '',
      time: stamp.time,
      optometrist: pick(row.optometrist, row.assignedOptometrist, p.assignedOptometrist, row.doctor),
      branch: pick(row.branch, p.branch),
      visitNumber: pick(row.visit_number, p.visitNum),
      appointment: pick(row.appointment_id, p.appointmentNum),
    },
    history: {
      complaints: pick(row.complaints, list(mh.chiefComplaints), list(mh.complaints)),
      duration: pick(row.complaint_duration, mh.complaintDuration),
      glassesUsage: pick(row.glasses_usage, mh.glassesUsage, mh.previousGlasses),
      medical: pick(row.medical_history, list(mh.systemicConditions), mh.medicalHistory, mh.medical_history),
      ocular: pick(mh.ocularHistory),
      surgery: pick(mh.previousSurgery),
      medication: pick(mh.currentMedication),
      allergies: pick(row.allergies, mh.allergy, mh.allergies),
      family: pick(row.family_history, mh.familyHistory),
      contactLens: pick(mh.contactLensHistory),
      lifestyle: pick(mh.lifestyle),
      flags: [mh.hasDiabetes && 'Diabetic', mh.hasHypertension && 'Hypertensive'].filter(Boolean).join(', '),
      notes: pick(mh.notes),
    },
    previousGlasses: {
      od: { sph: pick(row.pgp_od_sph, mh.pgpOdSph), cyl: pick(row.pgp_od_cyl, mh.pgpOdCyl), axis: pick(row.pgp_od_axis, mh.pgpOdAxis), va: pick(row.pgp_od_va, mh.pgpOdVa), add: pick(row.pgp_od_add, mh.pgpOdAdd) },
      os: { sph: pick(row.pgp_os_sph, mh.pgpOsSph), cyl: pick(row.pgp_os_cyl, mh.pgpOsCyl), axis: pick(row.pgp_os_axis, mh.pgpOsAxis), va: pick(row.pgp_os_va, mh.pgpOsVa), add: pick(row.pgp_os_add, mh.pgpOsAdd) },
      date: pick(row.previous_glasses_date, mh.previousGlassesDate),
    },
    visualAcuity: {
      od: { ucva: pick(dist.odWo, row.va_od_distance_unaided), ph: pick(dist.odPinhole, row.va_od_pinhole), bcva: pick(dist.odWith, row.va_od_distance_corrected), near: pick(near.odWith, near.odWo, row.va_od_near) },
      os: { ucva: pick(dist.osWo, row.va_os_distance_unaided), ph: pick(dist.osPinhole, row.va_os_pinhole), bcva: pick(dist.osWith, row.va_os_distance_corrected), near: pick(near.osWith, near.osWo, row.va_os_near) },
      colorVision: pick(va.colorVision),
      contrast: pick(va.contrastSensitivity),
    },
    autoRefraction: {
      od: eyeRow(obj(ar.od), { sph: row.ar_sph_od, cyl: row.ar_cyl_od, axis: row.ar_axis_od }),
      os: eyeRow(obj(ar.os), { sph: row.ar_sph_os, cyl: row.ar_cyl_os, axis: row.ar_axis_os }),
    },
    retinoscopy: { od: eyeRow(obj(ret.od)), os: eyeRow(obj(ret.os)) },
    keratometry: {
      od: [pick(k.odK1, row.k1_od), pick(k.odK2, row.k2_od)].filter(Boolean).join(' / '),
      os: [pick(k.osK1, row.k1_os), pick(k.osK2, row.k2_os)].filter(Boolean).join(' / '),
    },
    rx: {
      od: { ...eyeRow(obj(sub.od), { sph: row.sub_sph_od, cyl: row.sub_cyl_od, axis: row.sub_axis_od, va: row.sub_va_od }),
        add: pick(obj(sub.odNv).sph, sub.nearAdd, row.sub_add_od), nearVa: pick(obj(sub.odNv).va, row.sub_add_va_od) },
      os: { ...eyeRow(obj(sub.os), { sph: row.sub_sph_os, cyl: row.sub_cyl_os, axis: row.sub_axis_os, va: row.sub_va_os }),
        add: pick(obj(sub.osNv).sph, sub.nearAdd, row.sub_add_os), nearVa: pick(obj(sub.osNv).va, row.sub_add_va_os) },
      pd: pick(sub.pd, row.distance_pd, row.distancePD),
      nearPd: pick(row.near_pd),
      prism: pick(sub.prism, row.sub_prism_od, row.sub_prism_os),
    },
    findings: [
      ['IOP (mmHg)', [pick(iop.od, row.iop_od) && `RE ${pick(iop.od, row.iop_od)}`, pick(iop.os, row.iop_os) && `LE ${pick(iop.os, row.iop_os)}`, pick(iop.method) && `(${iop.method})`].filter(Boolean).join('  ')],
      ['Cup / Disc Ratio', [cdr.od && `RE ${cdr.od}`, cdr.os && `LE ${cdr.os}`].filter(Boolean).join('  ')],
      ['Lids / Lashes', [pick(ant.lids, row.eyelids), pick(ant.lashes)].filter(Boolean).join(' / ')],
      ['Conjunctiva', pick(ant.conjunctiva, row.conjunctiva)],
      ['Cornea', pick(ant.cornea, row.cornea)],
      ['Anterior Chamber', pick(ant.anteriorChamber, row.anterior_chamber)],
      ['Iris / Pupil', pick(ant.iris, row.pupillary_reflex)],
      ['Lens', pick(ant.lens, row.lens_state)],
      ['Optic Disc', pick(post.disc, row.optic_disc)],
      ['Macula', pick(post.macula)],
      ['Retina / Vessels', [pick(post.retina, row.retina), pick(post.vessels)].filter(Boolean).join(' / ')],
      ['Tear Film', pick(row.tear_film)],
      ['Dilated Exam', pick(health.dilatedExam)],
      ['NPC', pick(bv.npc, row.npc)],
      ['Cover Test', pick(bv.coverTest)],
      ['Phoria', pick(bv.phoria, row.phoria_test)],
      ['Vergence / Accommodation', [pick(bv.vergence), pick(bv.accommodation)].filter(Boolean).join(' / ')],
      ['Worth 4 Dot', pick(bv.worthFourDot)],
      ['Stereopsis', pick(bv.stereoVision, row.va_ou_stereo)],
      ['Dominant Eye', pick(bv.eyeDominance, va.dominantEye, row.va_ou_dominant)],
      ['Binocular Balance', pick(sub.balanceTest, row.binocular_balance)],
      ['Orthoptic Notes', pick(bv.therapyNotes)],
    ].filter(([, v]) => !blank(v)),
    clinical: [
      ['Primary Diagnosis', pick(row.primary_diagnosis, diag.primary, typeof row.diagnosis === 'string' ? row.diagnosis : '')],
      ['ICD Code', pick(diag.icdCode)],
      ['Ocular Assessment', pick(diag.ocularAssessment)],
      ['Clinical Remarks', pick(diag.remarks)],
      ['Procedure', pick(diag.procedure)],
      ['Medicine', pick(diag.medicine)],
      ['Advice', pick(diag.advice)],
      ['Ergonomics Advice', pick(diag.ergonomicsAdvice)],
      ['Lens Recommendation', pick([row.rec_lens_brand, row.rec_lens_type, row.rec_lens_coating].filter((x) => !blank(x)).join(' '), presc.lensRecommendation)],
      ['Frame Recommendation', pick([row.rec_frame_brand, row.rec_frame_shape, row.rec_frame_color, row.rec_frame_size].filter((x) => !blank(x)).join(' '), presc.frameRecommendation)],
      ['Contact Lens Advice', pick(row.cl_recommend, [row.cl_brand, row.cl_type, row.cl_power].filter((x) => !blank(x)).join(' '))],
      ['Dispensing Remarks', pick(diag.dispensingRemarks)],
      ['Next Review', pick(diag.nextReviewDate, diag.nextReview, row.follow_up_date)],
      ['Follow-up Interval', pick(row.follow_up_interval)],
    ].filter(([, v]) => !blank(v)),
    billing: {
      available: Boolean(billing),
      feeStatus,
      isFreeTest: fee.is_free_test ?? row.is_free_test ?? row.isFreeTest ?? feeStatus === 'FREE',
      procedureCharge: num(pick(fee.procedure_charge, row.procedure_charge, diag.procedureCharge)),
      medicineCharge: num(pick(fee.medicine_charge, row.medicine_charge, diag.medicineCharge)),
      medicalAidCharge: num(pick(fee.medical_aid_charge, row.medical_aid_charge, diag.medicalAidCharge)),
      amount: num(pick(fee.amount, row.fee_amount)),
      paidAmount: num(pick(fee.paid_amount, row.fee_paid_amount)),
      paymentMode: pick(fee.payment_mode, row.fee_payment_mode),
      receiptNo: billing ? pick(fee.receipt_no)
        : (feeStatus === 'PAID' && num(row.fee_paid_amount) > 0 ? eyeTestReceiptNo(testNo) : ''),
      feeInvoiceNumber: pick(fee.invoice_number, row.fee_invoice_number, row.feeInvoiceNumber),
      feeInvoiceDate: pick(fee.invoice_date),
      invoices: Array.isArray(billing?.invoices) ? billing.invoices : [],
    },
  };
}

// ── Print ───────────────────────────────────────────────────────────────────────────────────
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => `₹${(Number(n) || 0).toFixed(2)}`;
const cell = (v) => (blank(v) ? '—' : esc(v));
const anyIn = (...rows) => rows.some((r) => Object.values(r).some((v) => !blank(v)));
const DOC_LABELS = { INVOICE: 'Invoice', ORDER: 'Order', QUOTATION: 'Quotation' };

const kv = (pairs) => `<table class="kv">${pairs.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')}</table>`;

export function buildEyeTestReportHtml(r, { store = {}, paperSize = 'A4' } = {}) {
  const a5 = paperSize === 'A5';
  const storeName = store.display_name || store.name || '';
  const address = store.document_address || [store.address, store.city, store.state, store.pin_code].filter(Boolean).join(', ');
  const contact = [store.phone && `Ph: ${store.phone}`, store.email, store.gstin && `GSTIN: ${store.gstin}`].filter(Boolean).join(' · ');
  const { patient: pt, visit: v, rx, billing: b } = r;

  const sections = [];
  const h = (title) => `<h3>${esc(title)}</h3>`;

  const historyPairs = [
    ['Chief Complaints', r.history.complaints], ['Duration', r.history.duration], ['Glasses Usage', r.history.glassesUsage],
    ['Systemic / Medical History', r.history.medical], ['Risk Flags', r.history.flags], ['Ocular History', r.history.ocular],
    ['Previous Surgery', r.history.surgery], ['Current Medication', r.history.medication], ['Allergies', r.history.allergies],
    ['Family History', r.history.family], ['Contact Lens History', r.history.contactLens], ['Lifestyle', r.history.lifestyle],
    ['Notes', r.history.notes],
  ].filter(([, val]) => !blank(val));
  if (historyPairs.length) sections.push(h('Presenting Complaints & History') + kv(historyPairs));

  const { od: vod, os: vos } = r.visualAcuity;
  if (anyIn(vod, vos)) {
    const vaRow = (label, e) => `<tr><td class="c"><b>${label}</b></td><td class="c">${cell(e.ucva)}</td><td class="c">${cell(e.ph)}</td><td class="c">${cell(e.bcva)}</td><td class="c">${cell(e.near)}</td></tr>`;
    const extra = [r.visualAcuity.colorVision && `Colour vision: ${esc(r.visualAcuity.colorVision)}`,
      r.visualAcuity.contrast && `Contrast sensitivity: ${esc(r.visualAcuity.contrast)}`].filter(Boolean).join(' · ');
    sections.push(`${h('Visual Acuity')}<table><thead><tr><th>Eye</th><th>Unaided (UCVA)</th><th>Pinhole (PH)</th><th>Corrected (BCVA)</th><th>Near</th></tr></thead>
      <tbody>${vaRow('RE (OD)', vod)}${vaRow('LE (OS)', vos)}</tbody></table>${extra ? `<div class="small">${extra}</div>` : ''}`);
  }

  const refrRow = (e) => `<td class="c">${cell(e.sph)}</td><td class="c">${cell(e.cyl)}</td><td class="c">${cell(e.axis)}</td>`;
  const objRows = [['Auto Refraction', r.autoRefraction], ['Retinoscopy', r.retinoscopy]].filter(([, x]) => anyIn(x.od, x.os));
  if (objRows.length || r.keratometry.od || r.keratometry.os) {
    sections.push(`${h('Objective Refraction')}${objRows.length ? `<table><thead><tr><th rowspan="2">Method</th><th colspan="3">RE (OD)</th><th colspan="3">LE (OS)</th></tr>
      <tr><th>SPH</th><th>CYL</th><th>AXIS</th><th>SPH</th><th>CYL</th><th>AXIS</th></tr></thead><tbody>
      ${objRows.map(([label, x]) => `<tr><td><b>${label}</b></td>${refrRow(x.od)}${refrRow(x.os)}</tr>`).join('')}</tbody></table>` : ''}
      ${r.keratometry.od || r.keratometry.os ? `<div class="small">Keratometry (K1 / K2): RE ${cell(r.keratometry.od)} · LE ${cell(r.keratometry.os)}</div>` : ''}`);
  }

  const pg = r.previousGlasses;
  if (anyIn(pg.od, pg.os)) {
    const pgRow = (label, e) => `<tr><td class="c"><b>${label}</b></td><td class="c">${cell(e.sph)}</td><td class="c">${cell(e.cyl)}</td><td class="c">${cell(e.axis)}</td><td class="c">${cell(e.va)}</td><td class="c">${cell(e.add)}</td></tr>`;
    sections.push(`${h(`Previous Glasses (PGP)${pg.date ? ` — ${pg.date}` : ''}`)}<table><thead><tr><th>Eye</th><th>SPH</th><th>CYL</th><th>AXIS</th><th>VA</th><th>ADD</th></tr></thead>
      <tbody>${pgRow('RE (OD)', pg.od)}${pgRow('LE (OS)', pg.os)}</tbody></table>`);
  }

  const rxRow = (label, e) => `<tr><td class="c"><b>${label}</b></td><td class="c big">${cell(e.sph)}</td><td class="c big">${cell(e.cyl)}</td><td class="c big">${cell(e.axis)}</td><td class="c">${cell(e.va)}</td><td class="c big">${cell(e.add)}</td><td class="c">${cell(e.nearVa)}</td></tr>`;
  const rxExtra = [rx.pd && `PD: ${esc(rx.pd)} mm`, rx.nearPd && `Near PD: ${esc(rx.nearPd)} mm`, rx.prism && `Prism: ${esc(rx.prism)}`].filter(Boolean).join(' · ');
  sections.push(`${h('Final Subjective Refraction (Prescription)')}${anyIn(rx.od, rx.os)
    ? `<table class="rx"><thead><tr><th>Eye</th><th>SPH</th><th>CYL</th><th>AXIS</th><th>VA</th><th>ADD</th><th>Near VA</th></tr></thead>
      <tbody>${rxRow('RE (OD)', rx.od)}${rxRow('LE (OS)', rx.os)}</tbody></table>${rxExtra ? `<div class="small">${rxExtra}</div>` : ''}`
    : '<div class="small">No refraction recorded for this visit.</div>'}`);

  if (r.findings.length) sections.push(h('Eye Health & Binocular Vision') + kv(r.findings));
  if (r.clinical.length) sections.push(h('Diagnosis & Clinical Notes') + kv(r.clinical));

  // Billing reference
  const statusLabel = b.isFreeTest ? 'Free test' : (FEE_STATUS_LABELS[b.feeStatus] || (b.feeStatus ? b.feeStatus : 'Not recorded'));
  const feePairs = [
    ['Fee Status', statusLabel],
    ...(b.isFreeTest ? [] : [
      ['Procedure Charge', money(b.procedureCharge)],
      ...(b.medicineCharge ? [['Medicine Charge', money(b.medicineCharge)]] : []),
      ...(b.medicalAidCharge ? [[`Medical Aid Cover${pt.medicalAid ? ` (${pt.medicalAid})` : ''}`, `− ${money(b.medicalAidCharge)}`]] : []),
      ['Eye Test Fee', money(b.amount)],
    ]),
    ...(b.feeStatus === 'PAID' ? [['Paid at Test', `${money(b.paidAmount)}${b.paymentMode ? ` (${payModeLabel(b.paymentMode) || b.paymentMode})` : ''}`]] : []),
    ...(b.receiptNo ? [['Payment Receipt No', b.receiptNo]] : []),
    ...(b.feeInvoiceNumber ? [['Fee Billed On', `${b.feeInvoiceNumber}${b.feeInvoiceDate ? ` (${b.feeInvoiceDate})` : ''}`]] : []),
    ...(b.feeStatus === 'PENDING' ? [['Note', 'Payable with the frame / lens purchase']] : []),
  ];
  const billRows = b.invoices.map((inv) => `<tr><td><b>${cell(inv.invoice_number)}</b></td><td>${esc(DOC_LABELS[inv.document_type] || inv.document_type || '')}</td>
    <td class="c">${cell(inv.invoice_date)}</td><td class="r">${money(inv.net_amount)}</td><td class="r">${money(inv.paid_amount)}</td>
    <td class="r">${money(inv.balance)}</td><td>${cell(inv.link_label)}</td></tr>`).join('');
  sections.push(`${h('Billing & Transaction Reference')}${kv(feePairs)}
    ${billRows ? `<table style="margin-top:4px"><thead><tr><th>Bill No</th><th>Type</th><th>Date</th><th class="r">Amount</th><th class="r">Paid</th><th class="r">Balance</th><th>Linked As</th></tr></thead><tbody>${billRows}</tbody></table>`
    : `<div class="small">${b.available ? 'No sale bill linked to this eye test yet.' : 'Linked bills unavailable — this visit is not saved to the server.'}</div>`}`);

  const when = [v.date, v.time].filter(Boolean).join(', ');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(`Eye Test Report ${v.testNo ? `#${v.testNo}` : ''} ${pt.name}`.trim())}</title>
<style>
  @page { size: ${a5 ? 'A5' : 'A4'}; margin: ${a5 ? '8mm' : '11mm'}; }
  * { box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; color: #0f172a; font-size: ${a5 ? '10px' : '11.5px'}; margin: 0; }
  @media screen { body { padding: ${a5 ? '8mm' : '11mm'}; } }
  .head { text-align: center; border-bottom: 2px solid #0f172a; padding-bottom: 5px; margin-bottom: 6px; }
  .head h1 { margin: 0; font-size: ${a5 ? '16px' : '20px'}; letter-spacing: .5px; }
  .head .sub { color: #475569; font-size: .92em; margin-top: 1px; }
  .title { display: flex; justify-content: space-between; align-items: baseline; margin: 4px 0 6px; }
  .title h2 { margin: 0; font-size: 1.2em; text-transform: uppercase; letter-spacing: .8px; }
  .badge { border: 1.5px solid #0f172a; border-radius: 4px; padding: 1px 8px; font-weight: 700; font-size: .9em; }
  .boxes { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
  .box { border: 1px solid #94a3b8; border-radius: 4px; padding: 4px 6px; }
  .box h4 { margin: 0 0 3px; font-size: .85em; text-transform: uppercase; color: #334155; letter-spacing: .4px; }
  .box div { margin: 1px 0; } .box span { color: #475569; display: inline-block; min-width: ${a5 ? '70px' : '88px'}; }
  h3 { font-size: .92em; text-transform: uppercase; letter-spacing: .5px; margin: 9px 0 3px; color: #1e3a8a; border-bottom: 1px solid #cbd5e1; padding-bottom: 1px; }
  table { width: 100%; border-collapse: collapse; page-break-inside: avoid; }
  th, td { border: 1px solid #94a3b8; padding: 3px 5px; }
  thead th { background: #e2e8f0; font-size: .9em; }
  table.kv th { background: #f8fafc; text-align: left; width: 32%; font-weight: 600; color: #334155; }
  table.rx td.big { font-size: 1.15em; font-weight: 700; }
  .c { text-align: center; } .r { text-align: right; white-space: nowrap; }
  .small { color: #334155; margin-top: 3px; }
  .sign { display: flex; justify-content: space-between; margin-top: ${a5 ? '20px' : '32px'}; }
  .sign div { border-top: 1px solid #0f172a; padding-top: 3px; min-width: 150px; text-align: center; }
  .foot { margin-top: 8px; color: #64748b; font-size: .85em; text-align: center; }
</style></head><body>
  <div class="head">
    <h1>${esc(storeName || 'Eye Clinic')}</h1>
    ${address ? `<div class="sub">${esc(address)}</div>` : ''}
    ${contact ? `<div class="sub">${esc(contact)}</div>` : ''}
    ${store.clinical_reg_no ? `<div class="sub">Clinical Reg. No: ${esc(store.clinical_reg_no)}</div>` : ''}
  </div>
  <div class="title"><h2>Eye Test Report</h2><span class="badge">${esc(v.testType || 'EYE TEST')}</span></div>
  <div class="boxes">
    <div class="box"><h4>Patient Information</h4>
      <div><span>Name</span><b>${cell(pt.name)}</b></div>
      <div><span>Patient ID</span><b>${cell(pt.id)}</b></div>
      <div><span>Age / Gender</span>${cell([pt.age && `${pt.age} Yrs`, pt.gender].filter(Boolean).join(' / '))}</div>
      <div><span>Contact</span>${cell(pt.phone)}</div>
      ${pt.email ? `<div><span>Email</span>${esc(pt.email)}</div>` : ''}
      ${pt.address ? `<div><span>Address</span>${esc(pt.address)}</div>` : ''}
      ${pt.occupation ? `<div><span>Occupation</span>${esc(pt.occupation)}</div>` : ''}
      ${pt.medicalAid ? `<div><span>Medical Aid</span>${esc(pt.medicalAid)}</div>` : ''}
    </div>
    <div class="box"><h4>Examination Details</h4>
      <div><span>Test No</span><b>${cell(v.testNo)}</b></div>
      <div><span>Test Type</span>${cell(v.testType)}</div>
      <div><span>Date &amp; Time</span><b>${cell(when)}</b></div>
      ${v.testDate ? `<div><span>Test Date</span>${esc(v.testDate)}</div>` : ''}
      <div><span>Examined By</span><b>${cell(v.optometrist)}</b></div>
      ${v.branch ? `<div><span>Branch</span>${esc(v.branch)}</div>` : ''}
      ${v.appointment ? `<div><span>Appointment</span>${esc(v.appointment)}</div>` : ''}
      ${v.visitNumber ? `<div><span>Visit Ref</span>${esc(v.visitNumber)}</div>` : ''}
    </div>
  </div>
  ${sections.join('\n')}
  <div class="sign"><div>Patient Signature</div><div>${esc(v.optometrist || 'Optometrist')}<br><small>Optometrist / Doctor</small></div></div>
  <div class="foot">This report reflects the eye examination recorded on ${cell(when)}${v.testNo ? ` under Test No ${esc(v.testNo)}` : ''}.</div>
</body></html>`;
}
