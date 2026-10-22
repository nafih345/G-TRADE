// Run: npm run test:billing   (Node's built-in test runner — no extra dependencies)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fieldText, rawField, formatMoney, formatDate, amountInWords, compatibleDocTypes, incompatibilityReason,
  BILL_FIELDS, ITEM_COLUMNS,
} from '../billFields.js';
import {
  blankConfig, createElement, normalizeConfig, convertLegacyTemplate, alignElements, snapBox, ELEMENT_LIBRARY,
} from '../billLayout.js';
import {
  paginate, layoutBill, renderVisualBillHtml, pageGeometry, createEstimateMeasurer,
} from '../renderBillLayout.js';
import { toBillModel } from '../documentAdapters.js';
import { sampleBillModel } from '../sampleModels.js';
import { PRESET_TEMPLATES } from '../templatePresets.js';

const A4 = (config, over = {}) => ({ paper_size: 'A4', orientation: 'portrait', margins: { top: 10, right: 10, bottom: 10, left: 10 }, config, ...over });
const opts = { measure: 'estimate' };

// ---------------------------------------------------------------------------
// Authoritative values — never computed, never invented
// ---------------------------------------------------------------------------

test('adapter reads stored totals and leaves missing money null (no 18% back-calculation)', () => {
  const m = toBillModel({ invoice_number: 'INV-9', net_amount: '1180.00', items: [{ name: 'Frame', qty: 1, price: 1000, tax_rate: 18 }] }, 'SALES_INVOICE');
  assert.equal(m.totals.grandTotal, 1180);
  assert.equal(m.totals.tax, null, 'no tax recorded -> null, not 180');
  assert.equal(m.totals.paid, null, 'paid unknown -> null, not "fully paid"');
  assert.equal(m.totals.balance, null);
  assert.equal(m.items[0].total, null, 'a taxed line with no stored total is not recomputed');
});

test('adapter keeps the eye-test charge lines (rate x qty, nothing else) printable', () => {
  const m = toBillModel({ invoiceNumber: 'EYE-1', items: [{ name: 'Consultation', qty: 1, price: 300 }], total: 300, paidAmount: 300, balanceDue: 0 }, 'SALES_INVOICE');
  assert.equal(m.items[0].total, 300);
  assert.equal(m.totals.paid, 300);
  assert.equal(m.totals.balance, 0);
});

test('real API invoice row maps to the full model', () => {
  const m = toBillModel({
    invoice_number: 'INV-100', invoice_date: '2026-10-01', customer_name: 'Anitha', customer_phone: '900', customer_code: 'P-1',
    total_amount: '2000.00', discount_amount: '100.00', tax_amount: '228.00', net_amount: '2128.00', paid_amount: '1000.00', balance_due: '1128.00',
    payment_method: 'Cash', payment_splits: { cash: 600, upi: 400 }, fulfillment_status: 'In Lab Processing',
    items: [{ display_name: 'Blue Frame', quantity: 2, unit_price: '1000.00', tax_rate: '12.00', tax_amount: '228.00', subtotal: '2128.00', power: 'RE: SPH -1.00' }],
  }, 'ORDER_BILL');
  assert.equal(m.document.number, 'INV-100');
  assert.equal(m.party.code, 'P-1');
  assert.equal(m.totals.subtotal, 2000);
  assert.equal(m.totals.balance, 1128);
  assert.equal(m.document.fulfillmentStatus, 'In Lab Processing');
  assert.deepEqual(m.payment.splits.map((s) => s.mode), ['Cash', 'UPI']);
  assert.equal(m.items[0].name, 'Blue Frame');
  assert.equal(m.items[0].total, 2128);
  assert.equal(m.items[0].power, 'RE: SPH -1.00');
});

test('purchase, receipt and return adapters', () => {
  const p = toBillModel({ invoice_number: 'PE-1', supplier_name: 'Vision', grand_total: '500', paid_amount: '0', balance_amount: '500', cgst_amount: '20', sgst_amount: '20', items: [{ product_name: 'Lens', quantity: '5', free_quantity: '1', purchase_rate: '92', batch_number: 'B1', expiry_date: '2028-01-01', line_total: '460' }] }, 'PURCHASE_BILL');
  assert.equal(p.party.label, 'Supplier');
  assert.equal(p.items[0].batch, 'B1');
  assert.equal(p.items[0].freeQty, 1);
  assert.equal(p.totals.cgst, 20);
  const r = toBillModel({ receipt_no: 'R-1', amount: '2500', customer_name: 'A', method: 'UPI', invoice_number: 'INV-1' }, 'PAYMENT_RECEIPT');
  assert.equal(r.receipt.amount, 2500);
  assert.equal(r.receipt.invoiceNumber, 'INV-1');
  assert.equal(fieldText(r, 'totals.amountInWords'), 'Rupees Two Thousand Five Hundred Only');
  const w = toBillModel({ returnNo: 'WRET-1', invoiceNo: 'WINV-9', amount: 900, summary: { grandTotal: 900 }, items: [] }, 'RETURN_BILL');
  assert.equal(w.document.type, 'SALES_RETURN');
  assert.equal(w.document.number, 'WRET-1');
  assert.equal(w.return.originalInvoice, 'WINV-9');
  assert.equal(w.totals.refund, 900);
});

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

test('money, dates and words', () => {
  assert.equal(formatMoney(1234567.5), '₹12,34,567.50');
  assert.equal(formatMoney(1234567.5, { thousands: 'international', currencySymbol: '$', decimals: 0 }), '$1,234,568');
  assert.equal(formatMoney(-0.35), '-₹0.35');
  assert.equal(formatMoney(null), '');
  assert.equal(formatMoney(0, { zeroAsDash: true }), '—');
  assert.equal(formatDate('2026-10-16', 'DD MMM YYYY'), '16 Oct 2026');
  assert.equal(formatDate('2026-10-16', 'DD/MM/YYYY'), '16/10/2026');
  assert.equal(amountInWords(111682.9), 'Rupees One Lakh Eleven Thousand Six Hundred Eighty Two and Ninety Paise Only');
  assert.equal(amountInWords(25000000), 'Rupees Two Crore Fifty Lakh Only');
});

test('field catalog ids are unique and resolvable', () => {
  const ids = BILL_FIELDS.map((f) => f.id);
  assert.equal(new Set(ids).size, ids.length);
  const m = sampleBillModel('SALES_INVOICE');
  assert.equal(rawField(m, 'party.name'), 'Anitha Krishnan');
  assert.ok(fieldText(m, 'totals.grandTotal').startsWith('₹'));
  assert.equal(new Set(ITEM_COLUMNS.map((c) => c.key)).size, ITEM_COLUMNS.length);
});

// ---------------------------------------------------------------------------
// Compatibility
// ---------------------------------------------------------------------------

test('compatibility follows the fields a layout uses', () => {
  const cfg = blankConfig();
  assert.ok(!compatibleDocTypes(cfg).includes('PAYMENT_RECEIPT'), 'items table excludes receipts');
  assert.match(incompatibilityReason(cfg, 'PAYMENT_RECEIPT'), /line items/);
  cfg.bands.items.table.columns.push({ key: 'batch', label: 'Batch', width: 10, visible: true });
  assert.deepEqual(compatibleDocTypes(cfg), ['PURCHASE_BILL', 'PURCHASE_RETURN']);
  const receipt = blankConfig();
  receipt.bands.items.visible = false;
  receipt.bands.summary.elements.push(createElement('field', { field: 'receipt.amount' }));
  assert.deepEqual(compatibleDocTypes(receipt), ['PAYMENT_RECEIPT']);
  assert.equal(compatibleDocTypes({ sections: [] }).length, 8, 'legacy templates adapt to every type');
});

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

test('paginate: rows split across pages, summary kept whole, header repeat honoured', () => {
  const base = { contentH: 277, thermal: false, hH: 60, hS: 70, hF: 8, items: true, mt: 2, mb: 3, thead: 7, headerOnEveryPage: false, summaryAt: 'after-items', fillPage: false };
  const one = paginate({ ...base, rows: [8, 8, 8] });
  assert.equal(one.pages.length, 1);
  assert.equal(one.pages[0].summaryTop, 60 + 2 + 7 + 24 + 3);

  const many = paginate({ ...base, rows: Array(60).fill(8) });
  const covered = many.pages.filter((p) => p.table).reduce((s, p) => s + (p.table.end - p.table.start), 0);
  assert.equal(covered, 60, 'every row printed exactly once');
  many.pages.forEach((p) => {
    if (!p.table) return;
    const used = (p.table.end - p.table.start) * 8;
    assert.ok(p.table.top + 7 + used <= base.contentH - base.hF, 'rows never run into the footer');
  });
  const last = many.pages[many.pages.length - 1];
  assert.ok(last.summaryTop + base.hS <= base.contentH - base.hF + 0.01, 'summary fits above the footer');
  assert.equal(many.pages[1].showHeader, false);
  const rep = paginate({ ...base, headerOnEveryPage: true, rows: Array(60).fill(8) });
  assert.ok(rep.pages.every((p) => p.showHeader));
  assert.ok(rep.pages.length >= many.pages.length);

  const bottom = paginate({ ...base, summaryAt: 'page-bottom', rows: [8] });
  assert.equal(bottom.pages[0].summaryTop, 277 - 8 - 70);
  const fill = paginate({ ...base, fillPage: true, rows: [8] });
  assert.ok(fill.pages[0].table.filler > 50);

  const thermal = paginate({ ...base, thermal: true, contentH: null, hF: 0, rows: [5, 5, 5, 5] });
  assert.equal(thermal.pages.length, 1);
  assert.equal(thermal.height, 60 + 2 + 7 + 20 + 3 + 70);
});

test('a single very tall row still prints (on its own page) instead of looping', () => {
  const r = paginate({ contentH: 100, thermal: false, hH: 20, hS: 20, hF: 5, items: true, mt: 1, mb: 1, thead: 5, rows: [8, 300, 8], headerOnEveryPage: false, summaryAt: 'after-items' });
  const covered = r.pages.filter((p) => p.table).reduce((s, p) => s + (p.table.end - p.table.start), 0);
  assert.equal(covered, 3);
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

test('renders exact page boxes, repeats table header, numbers pages, no sample data in template', () => {
  const cfg = blankConfig();
  cfg.bands.footer = { height: 6, elements: [{ ...createElement('pageNumber'), id: 'pg', x: 150, y: 0, w: 40, h: 5 }] };
  const tpl = A4(cfg);
  const model = sampleBillModel('SALES_INVOICE', { itemCount: 60, longNames: true });
  const { html, layout } = renderVisualBillHtml(tpl, model, opts);
  assert.ok(layout.pages.length >= 3);
  assert.match(html, /@page\{size:210mm 297mm;margin:0\}/);
  assert.equal((html.match(/class="bd-page"/g) || []).length, layout.pages.length);
  assert.equal((html.match(/<thead>/g) || []).length, layout.pages.filter((p) => p.table).length, 'header row on every table page');
  assert.ok(html.includes(`Page ${layout.pages.length} of ${layout.pages.length}`));
  assert.ok(!JSON.stringify(cfg).includes('Anitha'), 'template config holds no transaction values');
  for (let i = 0; i < 60; i += 1) assert.ok(html.includes(`data-row="${i}"`), `row ${i} printed`);
});

test('escapes document text (no markup injection)', () => {
  const model = sampleBillModel('SALES_INVOICE');
  model.party.name = '<img src=x onerror=alert(1)>';
  model.items[0].name = '<script>bad()</script>';
  const { html } = renderVisualBillHtml(A4(blankConfig()), model, opts);
  assert.ok(!html.includes('<script>bad'));
  assert.ok(!html.includes('<img src=x'));
  assert.ok(html.includes('&lt;img src=x'));
});

test('totals: zero rows skipped, missing figures never print as 0', () => {
  const cfg = blankConfig();
  const model = sampleBillModel('SALES_INVOICE');
  model.totals.discount = 0;
  model.totals.paid = null;
  const { html } = renderVisualBillHtml(A4(cfg), model, opts);
  assert.ok(!html.includes('data-k="discount"'));
  assert.ok(/Amount Paid<\/td><td class="bd-r">—/.test(html), 'unknown paid shows a dash');
});

test('text tokens resolve to live values', () => {
  const cfg = blankConfig();
  cfg.bands.summary.elements.push({ ...createElement('text'), id: 't1', text: 'Bill {{document.number}} for {{party.name}}', x: 0, y: 0, w: 100, h: 6 });
  const { html } = renderVisualBillHtml(A4(cfg), sampleBillModel('SALES_INVOICE'), opts);
  assert.ok(html.includes('Bill INV-002741 for Anitha Krishnan'));
});

test('thermal roll: one page exactly as long as the content', () => {
  const tpl = { paper_size: '80mm', margins: { top: 3, right: 3, bottom: 3, left: 3 }, config: convertLegacyTemplate(PRESET_TEMPLATES[2], 74) };
  const short = layoutBill(tpl, sampleBillModel('SALES_INVOICE', { itemCount: 2 }), opts);
  const long = layoutBill(tpl, sampleBillModel('SALES_INVOICE', { itemCount: 30 }), opts);
  assert.equal(short.pages.length, 1);
  assert.equal(long.pages.length, 1);
  assert.ok(long.geometry.pageH > short.geometry.pageH + 50);
});

test('A5 / landscape / custom geometry', () => {
  assert.deepEqual([pageGeometry({ paper_size: 'A5' }).pageW, pageGeometry({ paper_size: 'A5' }).pageH], [148, 210]);
  const l = pageGeometry({ paper_size: 'A5', orientation: 'landscape', margins: { top: 8, right: 8, bottom: 8, left: 8 } });
  assert.deepEqual([l.pageW, l.pageH, l.contentW], [210, 148, 194]);
  const c = pageGeometry({ paper_size: 'CUSTOM', custom_width_mm: 100, custom_height_mm: '' });
  assert.equal(c.thermal, true);
});

test('every legacy preset converts to a renderable visual layout', () => {
  PRESET_TEMPLATES.forEach((t) => {
    const g = pageGeometry(t);
    const cfg = normalizeConfig(convertLegacyTemplate(t, g.contentW));
    assert.equal(cfg.schema, 2);
    const { layout } = renderVisualBillHtml({ ...t, config: cfg }, sampleBillModel('SALES_INVOICE', { itemCount: 5 }), opts);
    assert.ok(layout.pages.length >= 1, t.name);
  });
});

test('designer helpers', () => {
  ELEMENT_LIBRARY.forEach((it) => assert.ok(createElement(it.type, { preset: it.preset }).id));
  const els = [{ id: 'a', x: 5, y: 0, w: 10, h: 5 }, { id: 'b', x: 30, y: 4, w: 20, h: 5 }];
  assert.equal(alignElements(els, ['a', 'b'], 'left', 190)[1].x, 5);
  assert.equal(alignElements(els, ['b'], 'right', 190)[1].x, 170);
  const s = snapBox({ x: 4.6, y: 10, w: 10, h: 5 }, { others: [{ x: 5, y: 0, w: 10, h: 5 }], W: 190, H: 60 });
  assert.equal(s.x, 5);
  assert.ok(s.guides.length);
  assert.ok(createEstimateMeasurer({ fontSize: 9, lineHeight: 1.3 }, blankConfig().bands.items.table, 190).table('', [{ name: 'x' }], [{ key: 'name', width: 40 }]).rows[0] > 0);
});

// ---------------------------------------------------------------------------
// Bill language (Settings → Business & Localization → "Bills & Documents Print In")
// ---------------------------------------------------------------------------

test('bills print in English, Arabic, or English + Arabic', async () => {
  const { publishBusinessPrefs } = await import('../../utils/localeFormat.js');
  const { renderBillHtml } = await import('../renderBillHtml.js');
  const { billLabel } = await import('../billI18n.js');
  const model = sampleBillModel('SALES_INVOICE', { itemCount: 2 });
  const legacy = PRESET_TEMPLATES[0];
  const visual = A4(convertLegacyTemplate(PRESET_TEMPLATES[0], 190));
  const setMode = (language, mode) => publishBusinessPrefs({ preferences: { language, bill_language_mode: mode } });
  try {
    setMode('ar', 'EN');
    let html = renderBillHtml(legacy, model);
    assert.ok(html.includes('Grand Total') && !html.includes('الإجمالي الكلي'));

    setMode('ar', 'LOCAL');
    html = renderBillHtml(legacy, model);
    assert.ok(html.includes('الإجمالي الكلي'), 'Arabic grand total');
    assert.ok(!/>Grand Total</.test(html), 'no English label in Arabic-only mode');
    assert.ok(html.includes('dir="rtl"'), 'Arabic-only bill reads right to left');
    assert.ok(html.includes(model.items[0].name), 'item names print as entered');

    setMode('ar', 'BILINGUAL');
    html = renderBillHtml(legacy, model);
    assert.ok(html.includes('Grand Total / <span class="bl-loc" lang="ar" dir="rtl">الإجمالي الكلي</span>'));
    const v = renderVisualBillHtml(visual, model, opts).html;
    assert.ok(v.includes('الإجمالي الكلي') && v.includes('Grand Total'), 'visual templates are bilingual too');

    assert.equal(billLabel('Date:', { lang: { mode: 'BILINGUAL', lang: 'ml' } }),
      'Date / <span class="bl-loc" lang="ml" dir="ltr">തീയതി</span>:');
    assert.equal(billLabel('My own label', { lang: { mode: 'LOCAL', lang: 'ar' } }), 'My own label');

    setMode('fr', 'LOCAL'); // no bill wording for French → English
    assert.ok(renderBillHtml(legacy, model).includes('Grand Total'));
  } finally {
    setMode('en', 'EN');
  }
});
