// Run: npm run test:labels   (Node's built-in test runner — no extra dependencies)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveFieldElement, rawFieldValue, resolveLocalProductFields, formatPrice, formatDate, SAMPLE_SCENARIOS,
} from '../labelFields.js';
import {
  createElement, geometryWarnings, snapPosition, alignElements, scaleElements, fitElementsToLabel, autoLayout,
  convertLegacySettings, jobTotals, a4SheetCount, blankTemplate, templateUsesRestricted, normalizeTemplate,
} from '../labelModel.js';
import { barcodeProblem, encodeBarcode, patternToRuns, renderLabelHtml, labelCss, planBarcode, moduleWidthOptions, needsInternalCode } from '../renderLabel.js';

const data = (fields, job = {}, store = { store_name: 'Greensol Opticals' }) => ({ fields, job, store });
const fieldEl = (field, extra = {}) => ({ ...createElement('field', { field }), ...extra });

test('field values come from data, never from the template', () => {
  const el = fieldEl('selling_price', { prefix: 'MRP ' });
  assert.equal(resolveFieldElement(el, data({ selling_price: '4590.00' })).text, 'MRP ₹4,590.00');
  assert.equal(resolveFieldElement(fieldEl('store_name'), data({})).text, 'Greensol Opticals');
});

test('empty-value fallbacks: hide, blank, text, other field', () => {
  const d = data({ selling_price: '999.00' });
  assert.deepEqual(resolveFieldElement(fieldEl('mrp', { prefix: 'MRP ' }), d), { text: '', hidden: true, missing: true });
  assert.equal(resolveFieldElement(fieldEl('mrp', { fallback: { mode: 'blank' } }), d).hidden, false);
  assert.equal(resolveFieldElement(fieldEl('mrp', { prefix: 'MRP ', fallback: { mode: 'text', text: '—' } }), d).text, 'MRP —');
  const viaField = resolveFieldElement(fieldEl('mrp', { fallback: { mode: 'field', field: 'selling_price' } }), d);
  assert.equal(viaField.text, '₹999.00');
  assert.equal(viaField.missing, true);
});

test('price and date formatting', () => {
  assert.equal(formatPrice('128990', 'currency'), '₹1,28,990.00');
  assert.equal(formatPrice('4590.4', 'currency0'), '₹4,590');
  assert.equal(formatPrice('4590', 'number'), '4,590.00');
  assert.equal(formatDate('2027-12-31'), '31-12-2027');
  assert.equal(formatDate('2027-12'), '12/2027');
});

test('job fields: batch / expiry / offer per print, print date defaults to today', () => {
  const d = data({}, { batch_no: 'B-1', offer_price: '3990' });
  assert.equal(rawFieldValue('batch_no', d), 'B-1');
  assert.equal(rawFieldValue('offer_price', d), '3990.00');
  assert.match(rawFieldValue('print_date', d), /^\d{4}-\d{2}-\d{2}$/);
});

test('local (browser-only) products resolve the same field ids', () => {
  const f = resolveLocalProductFields({ name: 'Frame', sku: 'F1', barcode: '123', sellingPrice: 1500, color: 'Black', size: '52', brand: 'Generic' });
  assert.equal(f.product_name, 'Frame');
  assert.equal(f.selling_price, '1500.00');
  assert.equal(f.colour, 'Black');
  assert.equal(f.variant, 'Black / 52');
  assert.equal(f.brand, '', '"Generic" placeholder brand is not printed');
  assert.equal(f.mrp, '', 'no MRP is guessed');
  assert.equal(resolveLocalProductFields({ name: 'X', price: 0 }).selling_price, '', '₹0 is treated as missing');
});

test('geometry warnings flag elements outside the label and the safe margin', () => {
  const t = blankTemplate('thermal');
  t.layout.elements = [
    { ...createElement('text'), id: 'in', x: 2, y: 2, w: 10, h: 3 },
    { ...createElement('text'), id: 'out', x: 30, y: 2, w: 10, h: 3 },
    { ...createElement('text'), id: 'edge', x: 0.2, y: 5, w: 10, h: 3 },
  ];
  const w = geometryWarnings(t);
  assert.equal(w.find((x) => x.elementId === 'out').level, 'error');
  assert.equal(w.find((x) => x.elementId === 'edge').level, 'info');
  assert.equal(w.some((x) => x.elementId === 'in'), false);
});

test('A4 sheet that does not fit is an error', () => {
  const t = normalizeTemplate({ ...blankTemplate('a4'), width_mm: 70, layout: { sheet: { cols: 3, rows: 8, marginLeftMm: 10 }, elements: [] } });
  assert.ok(geometryWarnings(t).some((w) => /A4 is 210/.test(w.message)));
});

test('snapping to label centre / edges and to the grid', () => {
  const s = snapPosition({ x: 13.7, y: 3.33, w: 10, h: 4 }, { W: 38, H: 25, grid: 0.5 });
  assert.equal(s.x, 14); // centre 18.7 -> label centre 19
  assert.equal(s.y, 3.5); // grid
  assert.deepEqual(s.guides.map((g) => g.axis), ['x']);
});

test('align / scale / fit keep elements consistent', () => {
  const els = [{ id: 'a', x: 2, y: 2, w: 10, h: 4 }, { id: 'b', x: 8, y: 9, w: 6, h: 3 }];
  const left = alignElements(els, ['a', 'b'], 'left', 38, 25);
  assert.equal(left[1].x, 2);
  const centred = alignElements(els, ['a'], 'hcenter', 38, 25);
  assert.equal(centred[0].x, 14);
  const scaled = scaleElements([{ ...els[0], style: { fontSizePt: 10 } }], 38, 25, 76, 50);
  assert.deepEqual([scaled[0].x, scaled[0].w, scaled[0].style.fontSizePt], [4, 20, 20]);
  const fitted = fitElementsToLabel([{ id: 'c', x: 35, y: -2, w: 10, h: 4 }], 38, 25, 1);
  assert.deepEqual([fitted[0].x, fitted[0].y], [27, 1]);
});

test('quick setup (auto layout) stays inside the label for every common size', () => {
  for (const [W, H] of [[38, 25], [50, 25], [50, 30], [60, 40], [90, 13], [38.1, 21.2]]) {
    const t = { ...blankTemplate(), width_mm: W, height_mm: H };
    t.layout.elements = autoLayout({ W, H, fields: ['store_name', 'product_name', 'selling_price', 'mrp', 'colour', 'size', 'barcode_text'] });
    assert.deepEqual(geometryWarnings(t).filter((w) => w.level === 'error'), [], `${W}x${H}`);
    assert.ok(t.layout.elements.some((e) => e.type === 'barcode'));
  }
});

test('legacy browser settings convert to equivalent templates', () => {
  const legacy = {
    printerType: 'thermal', sizeId: 'roll_50x25', barcodeType: 'EAN13', labelStyle: 'jewel',
    showBusinessName: false, showProductName: true, showPrice: true, showColour: true, showSize: false,
    showProductCode: true, showBarcodeText: true, showDiscountPrice: true,
  };
  const layouts = [{ id: 'x', name: 'Shelf strip', printerType: 'a4', dims: { widthMm: 60, heightMm: 20, cols: 3, rows: 12, marginTopMm: 8, marginLeftMm: 5, colGapMm: 2, rowGapMm: 1 } }];
  const [main, custom] = convertLegacySettings(legacy, layouts);
  assert.equal(main.make_default, true);
  assert.deepEqual([main.width_mm, main.height_mm, main.layout.defaultBarcodeFormat], [50, 25, 'EAN13']);
  const fields = main.layout.elements.filter((e) => e.type === 'field').map((e) => e.field);
  assert.ok(fields.includes('product_name') && fields.includes('sku') && fields.includes('offer_price'));
  assert.ok(!fields.includes('store_name') && !fields.includes('size'));
  assert.equal(custom.printer_type, 'a4');
  assert.deepEqual(custom.layout.sheet, { cols: 3, rows: 12, marginTopMm: 8, marginLeftMm: 5, colGapMm: 2, rowGapMm: 1 });
  assert.deepEqual(convertLegacySettings(null, []), []);
  const qr = convertLegacySettings({ ...legacy, barcodeType: 'QRCODE' })[0];
  assert.ok(qr.layout.elements.some((e) => e.type === 'qr'));
});

test('print-job totals: labels per line, skipped lines, variants and A4 sheets', () => {
  const rows = [
    { key: 'a', qty: 3, variantGroup: 'g1' },
    { key: 'b', qty: 2, variantGroup: 'g1' },
    { key: 'c', qty: 4 },
    { key: 'd', qty: 5, skipReason: 'No barcode' },
    { key: 'e', qty: 0 },
  ];
  assert.deepEqual(jobTotals(rows), { labels: 9, lines: 3, products: 2, variants: 2, skipped: 1 });
  const a4 = normalizeTemplate({ ...blankTemplate('a4') });
  assert.equal(a4SheetCount(24, a4), 1);
  assert.equal(a4SheetCount(24, a4, 1), 2);
});

test('restricted pricing detection', () => {
  const t = blankTemplate();
  t.layout.elements = [fieldEl('product_name'), fieldEl('mrp', { fallback: { mode: 'field', field: 'wholesale_price' } })];
  assert.equal(templateUsesRestricted(t), true);
});

test('barcode validation per format, incl. check digits', () => {
  assert.equal(barcodeProblem('EAN13', '8901234567890'), null);
  assert.match(barcodeProblem('EAN13', '8901234567891'), /check digit/);
  assert.match(barcodeProblem('EAN13', 'RB3025'), /12 or 13 digits/);
  assert.equal(barcodeProblem('CODE128', 'RB3025-GLD-58'), null);
  assert.match(barcodeProblem('CODE39', 'abc'), /Code 39/);
  assert.match(barcodeProblem('CODE128', ''), /No barcode/);
  assert.equal(barcodeProblem('UPC', '036000291452'), null);
});

test('sample scenarios cover long names, missing fields and long barcodes', () => {
  const ids = SAMPLE_SCENARIOS.map((s) => s.id);
  assert.deepEqual(ids, ['typical', 'long', 'minimal', 'longcode']);
  assert.equal(barcodeProblem('EAN13', SAMPLE_SCENARIOS[0].fields.barcode), null);
});

test('barcodes are real bar patterns (never a solid block)', () => {
  const ean = encodeBarcode('EAN13', '8901234567890');
  assert.equal(ean.modules, 95);
  assert.ok(ean.pattern.startsWith('101') && ean.pattern.endsWith('101'), 'EAN guard bars');
  const c128 = encodeBarcode('CODE128', '8901234567890');
  assert.equal(c128.modules, 123);
  const runs = patternToRuns(c128.pattern);
  assert.ok(runs.length > 20);
  // bars never cover the whole symbol: total black < 70 % of modules
  assert.ok(runs.reduce((a, [, w]) => a + w, 0) < c128.modules * 0.7);
  assert.equal(encodeBarcode('CODE39', 'RB3025').modules > 0, true);
  assert.match(encodeBarcode('EAN13', 'ABC').error, /12 or 13 digits/);
  assert.match(encodeBarcode('CODE128', '').error, /No barcode/);
});

test('rendered barcode SVG: explicit black bars, no background rect, no CSS fill override', () => {
  const t = { ...blankTemplate(), width_mm: 50, height_mm: 25 };
  t.layout.elements = [{ ...createElement('barcode', { labelW: 50, labelH: 25 }), id: 'bc', x: 1, y: 1, w: 48, h: 14 }];
  const { html, warnings } = renderLabelHtml(t, { fields: { barcode: '8901234567890' } }, { dpi: 203 });
  assert.match(html, /<path d="M\d/);
  assert.match(html, /fill="#000000"/);
  assert.doesNotMatch(html, /<rect/);
  assert.match(html, /data-value="8901234567890"/);
  assert.match(html, />8901234567890</, 'human-readable digits match the encoded value');
  assert.doesNotMatch(labelCss(), /rect\s*\{[^}]*fill/);
  assert.deepEqual(warnings.filter((w) => w.kind === 'barcode'), []);
  // module width snapped to whole 203-dpi dots, with ≥10-module quiet zones
  const m = html.match(/class="gl-bars" style="left:([\d.]+)mm;width:([\d.]+)mm/);
  const moduleMm = Number(m[2]) / 123;
  assert.ok(Math.abs(moduleMm / (25.4 / 203) - Math.round(moduleMm / (25.4 / 203))) < 0.02);
  assert.ok(Number(m[1]) >= 10 * moduleMm - 0.01);
});

test('resizing the barcode box keeps every bar proportional (uniform module width)', () => {
  for (const w of [30, 45, 60]) {
    const t = { ...blankTemplate(), width_mm: 70, height_mm: 30 };
    t.layout.elements = [{ ...createElement('barcode'), id: 'bc', x: 1, y: 1, w, h: 12 }];
    const { html } = renderLabelHtml(t, { fields: { barcode: 'RB3025-GLD-58' } }, { dpi: 0 });
    assert.match(html, /viewBox="0 0 \d+ 1" preserveAspectRatio="none"/); // x scale = 1 module ⇒ moduleMm, y only height
  }
});

test('38 × 25 mm @ 203 dpi: Code 39 13-digit bars are unsafe; Code 128 fits at exactly 2 dots', () => {
  const box = 36; // barcode box on the 38 mm label
  const c39 = planBarcode({ value: '8901234567890', format: 'CODE39', boxW: box, barcode: { quietZoneMm: 1.44 }, dpi: 203 });
  assert.equal(c39.modules, 240);
  assert.equal(c39.safe, false);
  assert.ok(c39.moduleMm < 0.14);
  const c128 = planBarcode({ value: '8901234567890', format: 'CODE128', boxW: box, barcode: { quietZoneMm: 1.44 }, dpi: 203 });
  assert.equal(c128.modules, 123);
  assert.equal(c128.safe, true);
  assert.equal(Math.round(c128.dots * 1000) / 1000, 2);
  assert.ok(c128.barsW + 2 * 1.44 <= box);
  assert.deepEqual(moduleWidthOptions(203), [0.25, 0.375]); // 2 and 3 dots
});

test('a fixed bar width that does not fit is reported, never silently accepted', () => {
  const p = planBarcode({ value: '8901234567890', format: 'CODE128', boxW: 36, barcode: { moduleMm: 0.375 }, dpi: 203 });
  assert.equal(p.fits, false);
  assert.ok(Math.abs(p.moduleMm - 0.25) < 0.001, 'falls back to the widest safe whole-dot width');
  const t = { ...blankTemplate(), width_mm: 38, height_mm: 25 };
  t.layout.defaultBarcodeFormat = 'CODE39';
  t.layout.elements = [{ ...createElement('barcode'), id: 'bc', x: 1, y: 10, w: 36, h: 12 }];
  const { warnings } = renderLabelHtml(t, { fields: { barcode: '8901234567890' } }, { dpi: 203 });
  const w = warnings.find((x) => x.kind === 'barcode-fit');
  assert.ok(w && /below the 0.25 mm minimum/.test(w.message));
  assert.ok(w.fixes.some((f) => f.id === 'format128'));
});

test('short internal code is only used when opted in, and only for codes too long to scan', () => {
  const t = { ...blankTemplate(), width_mm: 38, height_mm: 25 };
  t.layout.elements = [{ ...createElement('barcode'), id: 'bc', x: 1, y: 10, w: 36, h: 12 }];
  const long = { barcode: 'TITTW1234GUN54XL', internal_code: '2000000000077' };
  assert.equal(needsInternalCode(t, long, { dpi: 203 }), false); // not opted in
  t.layout.elements[0].barcode.whenTooLong = 'internal';
  assert.equal(needsInternalCode(t, long, { dpi: 203 }), true);
  assert.equal(needsInternalCode(t, { barcode: '8901234567890' }, { dpi: 203 }), false); // fits → original
  const { html } = renderLabelHtml(t, { fields: long }, { dpi: 203 });
  assert.match(html, /data-value="2000000000077"/);
  assert.match(html, />2000000000077</, 'digits match what is encoded');
});
