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
import { barcodeProblem, encodeBarcode, patternToRuns, renderLabelHtml, labelCss, planBarcode, moduleWidthOptions } from '../renderLabel.js';

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

test('the product barcode is never swapped for an internal code, even on older templates', () => {
  const t = { ...blankTemplate(), width_mm: 38, height_mm: 25 };
  t.layout.elements = [{ ...createElement('barcode'), id: 'bc', x: 1, y: 10, w: 36, h: 12 }];
  t.layout.elements[0].barcode.whenTooLong = 'internal'; // saved before auto-numbering was removed
  const long = { barcode: 'TITTW1234GUN54XL', internal_code: '2000000000077' };
  const { html, warnings } = renderLabelHtml(t, { fields: long }, { dpi: 203 });
  assert.match(html, /data-value="TITTW1234GUN54XL"/);
  assert.doesNotMatch(html, /2000000000077/);
  assert.ok(warnings.some((w) => w.kind === 'barcode-fit'), 'too-long codes still warn');
  assert.ok(warnings.every((w) => !(w.fixes || []).some((f) => f.id === 'internal')));
});

// ---- Print Label options: label type, Past Used Sheet, template visibility -------------
import {
  labelTypeOf, isJewelleryTemplate, startSkipFor, startFromSkip, sheetSideLabels, visibleTemplates, hiddenCount, FRESH_START,
} from '../labelModel.js';

const dumbbell = normalizeTemplate({
  id: 'd', name: 'A4 Jewellery Dumbbell', printer_type: 'a4', width_mm: 92, height_mm: 14.5, label_type: 'jewellery',
  layout: { sheet: { cols: 2, rows: 19, marginTopMm: 10, marginLeftMm: 12, colGapMm: 6, rowGapMm: 0 }, elements: [] },
});

test('label type: stored value wins, name fallback for cached templates', () => {
  assert.equal(labelTypeOf({ label_type: 'optical', name: 'Jewel card' }), 'optical');
  assert.equal(labelTypeOf({ name: 'Jewellery Rat-Tail 90 × 13 mm' }), 'jewellery');
  assert.equal(labelTypeOf({ name: 'Standard 50 × 25' }), 'standard');
  assert.ok(isJewelleryTemplate(dumbbell));
  assert.equal(normalizeTemplate({ name: 'x', is_default: true, is_hidden: true }).is_hidden, false);
});

test('part used sheet: page + row + side -> labels skipped, and back', () => {
  assert.equal(startSkipFor(dumbbell, FRESH_START), 0);
  assert.equal(startSkipFor(dumbbell, { enabled: true, row: 1, col: 2 }), 1); // right side of row 1
  assert.equal(startSkipFor(dumbbell, { enabled: true, row: 4, col: 1 }), 6);
  assert.equal(startSkipFor(dumbbell, { enabled: true, row: 99, col: 9 }), 37); // clamped to the last cell
  assert.equal(startSkipFor(dumbbell, { enabled: false, row: 4, col: 1 }), 0);
  assert.deepEqual(startFromSkip(dumbbell, 7), { enabled: true, page: 1, row: 4, col: 2 });
  assert.deepEqual(startFromSkip(dumbbell, 0), { enabled: false, page: 1, row: 1, col: 1 });
  // Start page: page 2, row 1, right side = one full sheet (38) + 1.
  assert.equal(startSkipFor(dumbbell, { enabled: true, page: 2, row: 1, col: 2 }), 39);
  assert.deepEqual(startFromSkip(dumbbell, 39), { enabled: true, page: 2, row: 1, col: 2 });
  assert.equal(a4SheetCount(1, dumbbell, 39), 2);
  // Thermal (e.g. Jewellery Retail 19 x 30 mm): every label is one page -> page N skips N-1.
  // (Pinned to the roll mode: jewellery otherwise defaults to the A4 grid, tested below.)
  const roll = normalizeTemplate({ name: 'Jewellery Retail 19 x 30 mm', printer_type: 'thermal', width_mm: 19, height_mm: 30, layout: { printMode: 'roll' } });
  // Thermal saved designs get a page layout (default 10 rows x 1 col, 2 cols for jewellery),
  // so row AND column are adjustable — page 2, row 3, column 2 is no longer stuck at row 1.
  const jroll = { ...roll, label_type: 'jewellery' };
  assert.equal(startSkipFor(jroll, { enabled: true, page: 2, row: 3, col: 2 }), 20 + 4 + 1);
  assert.equal(startSkipFor(roll, { enabled: true, page: 1, row: 4, col: 2 }), 7); // jewellery name -> 2 cols
  const plain = normalizeTemplate({ name: 'Optical 50 x 25', printer_type: 'thermal', width_mm: 50, height_mm: 25 });
  assert.equal(startSkipFor(plain, { enabled: true, page: 2, row: 4, col: 2 }), 13); // 10 x 1: col clamps
  assert.equal(startSkipFor(roll, { enabled: true, page: 1, row: 2, col: 3, pageRows: 5, pageCols: 3 }), 5);
  assert.equal(startSkipFor({ ...roll, layout: { ...roll.layout, pageGrid: { rows: 4, cols: 2 } } }, { enabled: true, page: 2, row: 2, col: 1 }), 10);
  assert.equal(startSkipFor(roll, { enabled: true, row: 1, col: 1 }), 0); // older value without page
  assert.deepEqual(startFromSkip(jroll, 25), { enabled: true, page: 2, row: 3, col: 2 });
  assert.deepEqual(startFromSkip(plain, 5, { pageRows: 2, pageCols: 2 }), { enabled: true, page: 2, row: 1, col: 2, pageRows: 2, pageCols: 2 });
  assert.deepEqual(normalizeTemplate({ ...roll, layout: { pageGrid: { rows: 4, cols: 2 } } }).layout.pageGrid, { rows: 4, cols: 2 });
  assert.deepEqual(sheetSideLabels(2), ['Left side', 'Right side']);
  assert.equal(sheetSideLabels(5)[4], 'Column 5');
  assert.equal(a4SheetCount(38, dumbbell, startSkipFor(dumbbell, { enabled: true, row: 1, col: 2 })), 2);
});

test('template visibility: default + kept ids always listed', () => {
  const ts = [
    { id: 'a', is_default: true, is_hidden: false },
    { id: 'b', is_hidden: true },
    { id: 'c', is_hidden: false },
    { id: 'd', is_hidden: true },
  ];
  assert.deepEqual(visibleTemplates(ts).map((t) => t.id), ['a', 'c']);
  assert.deepEqual(visibleTemplates(ts, { keepIds: ['d', null] }).map((t) => t.id), ['a', 'c', 'd']);
  assert.equal(visibleTemplates(ts, { showAll: true }).length, 4);
  assert.equal(hiddenCount(ts), 2);
});

test('part used roll: thermal roll print document feeds blank labels first', async () => {
  const { buildPrintDocument } = await import('../printLabels.js');
  const roll = normalizeTemplate({ name: 'Optical 19 x 30 mm', printer_type: 'thermal', width_mm: 19, height_mm: 30 });
  const doc = buildPrintDocument(roll, ['<i>A</i>', '<i>B</i>'], { startSkip: 2 });
  assert.equal((doc.body.match(/class="gl-page"/g) || []).length, 4);
  assert.ok(doc.body.startsWith('<div class="gl-page"></div><div class="gl-page"></div>'));
});

// ---- Print Layout Mode: Multi-Label Sheet (A4 Grid) vs Single Sticker / Thermal Roll -----
import { printMode, printsAsSheet, withPrintMode, printedPageCount, autoA4Sheet, sheetGrid as gridOf } from '../labelModel.js';
import { buildPrintDocument } from '../printLabels.js';

const count = (body, cls) => (body.match(new RegExp(`class="${cls}"`, 'g')) || []).length;
const tenLabels = Array.from({ length: 10 }, (_, i) => `<i>L${i}</i>`);

test('print layout mode: smart defaults by template type, saved and per-job overrides', () => {
  const jewel = normalizeTemplate({ name: 'Jewellery Tag 22 x 13 mm', label_type: 'jewellery', printer_type: 'thermal', width_mm: 22, height_mm: 13 });
  const std = normalizeTemplate({ name: 'Optical 50 x 25', printer_type: 'thermal', width_mm: 50, height_mm: 25 });
  assert.equal(printMode(jewel), 'sheet');
  assert.equal(printMode(std), 'roll');
  assert.equal(printMode(dumbbell), 'sheet');
  // Jewellery on A4: 2 across x 19 down = 38 per page, centred.
  assert.deepEqual(gridOf(jewel), { rows: 19, cols: 2, perSheet: 38 });
  const auto = autoA4Sheet(jewel);
  assert.ok(auto.marginLeftMm > 0 && auto.marginTopMm > 0);
  // Labels too tall for 19 rows: as many as physically fit, never past A4.
  const tall = normalizeTemplate({ name: 'Jewellery Retail 19 x 30 mm', label_type: 'jewellery', printer_type: 'thermal', width_mm: 19, height_mm: 30 });
  assert.equal(gridOf(tall).cols, 2);
  assert.ok(gridOf(tall).rows * 30 <= 297 - 10);
  // Saved mode wins (also the older pageGrid.mode); the print screen can switch per job.
  assert.equal(printMode({ ...std, layout: { ...std.layout, printMode: 'sheet' } }), 'sheet');
  assert.equal(printMode({ ...jewel, layout: { ...jewel.layout, pageGrid: { mode: 'roll' } } }), 'roll');
  assert.ok(printsAsSheet(withPrintMode(std, 'sheet')));
  assert.ok(!printsAsSheet(withPrintMode(jewel, 'roll')));
  assert.equal(withPrintMode(jewel, ''), jewel);
  assert.equal(normalizeTemplate({ ...std, layout: { printMode: 'sheet', sheet: { cols: 4, rows: 10 } } }).layout.sheet.cols, 4);
  assert.equal(normalizeTemplate({ ...std, layout: { printMode: 'bogus' } }).layout.printMode, undefined);
});

test('A4 grid: 10 labels -> ONE A4 page, breaks only after full sheets, part-used offsets', () => {
  const jewel = normalizeTemplate({ name: 'Jewellery Tag 22 x 13 mm', label_type: 'jewellery', printer_type: 'thermal', width_mm: 22, height_mm: 13 });
  const doc = buildPrintDocument(jewel, tenLabels, {});
  assert.equal(count(doc.body, 'gl-sheet'), 1);
  assert.equal(count(doc.body, 'gl-cell'), 10);
  assert.equal(count(doc.body, 'gl-page'), 0);
  assert.match(doc.css, /@page \{ size: A4 portrait;/);
  assert.match(doc.css, /grid-template-columns: repeat\(2, 22mm\)/);
  // page-break only on the sheet container, never on cells.
  assert.match(doc.css, /\.gl-sheet \{[^}]*page-break-after: always/);
  assert.doesNotMatch(doc.css, /\.gl-cell \{[^}]*page-break/);
  assert.equal(printedPageCount(jewel, 10), 1);
  assert.equal(printedPageCount(jewel, 38), 1);
  assert.equal(printedPageCount(jewel, 39), 2);
  // Part used: start row 18, right side -> 35 used; 10 labels -> 3 on page 1, 7 on page 2.
  const skip = startSkipFor(jewel, { enabled: true, page: 1, row: 18, col: 2 });
  assert.equal(skip, 35);
  const used = buildPrintDocument(jewel, tenLabels, { startSkip: skip });
  assert.equal(count(used.body, 'gl-sheet'), 2);
  assert.equal(printedPageCount(jewel, 10, skip), 2);
  // A standard sticker switched to the A4 grid on the print screen.
  const std = normalizeTemplate({ name: 'Optical 50 x 25', printer_type: 'thermal', width_mm: 50, height_mm: 25 });
  const asSheet = buildPrintDocument(withPrintMode(std, 'sheet'), tenLabels, {});
  assert.equal(count(asSheet.body, 'gl-sheet'), 1);
  assert.match(asSheet.css, /@page \{ size: A4 portrait;/);
});

test('thermal roll: @page = label size, one sticker per page', () => {
  const std = normalizeTemplate({ name: 'Optical 50 x 25', printer_type: 'thermal', width_mm: 50, height_mm: 25 });
  const doc = buildPrintDocument(std, tenLabels, {});
  assert.equal(count(doc.body, 'gl-page'), 10);
  assert.equal(count(doc.body, 'gl-sheet'), 0);
  assert.match(doc.css, /@page \{ size: 50mm 25mm; margin: 0/);
  assert.equal(printedPageCount(std, 10, 2), 12);
  // A jewellery template switched to the roll on the print screen.
  const jewel = normalizeTemplate({ name: 'Jewellery Tag 22 x 13 mm', label_type: 'jewellery', printer_type: 'thermal', width_mm: 22, height_mm: 13 });
  assert.equal(count(buildPrintDocument(withPrintMode(jewel, 'roll'), tenLabels, {}).body, 'gl-page'), 10);
});

test('start row / column: any custom value, auto Part Used / Fresh, skip formula', async () => {
  const { applyStartPosition } = await import('../labelModel.js');
  const jewel = normalizeTemplate({ name: 'Jewellery Tag 22 x 13 mm', label_type: 'jewellery', printer_type: 'thermal', width_mm: 22, height_mm: 13 });
  // A4 grid (2 x 19): row 5, column 2 -> Part Used, skip = (5-1)*2 + (2-1) = 9.
  let v = applyStartPosition(jewel, FRESH_START, { row: 5 });
  assert.equal(v.enabled, true);
  v = applyStartPosition(jewel, v, { col: 2 });
  assert.deepEqual([v.row, v.col, startSkipFor(jewel, v)], [5, 2, 9]);
  // 10 labels from row 5 col 2: 9 blank cells + 10 labels on page 1, one A4 page.
  const doc = buildPrintDocument(jewel, tenLabels, { startSkip: startSkipFor(jewel, v) });
  assert.equal(count(doc.body, 'gl-sheet'), 1);
  assert.equal(count(doc.body, 'gl-cell'), 19);
  assert.ok(doc.body.indexOf('<i>L0</i>') > doc.body.lastIndexOf('<div class="gl-cell"></div>'));
  // Row past the sheet clamps to the last row; back to 1 / 1 -> Fresh Sheet.
  assert.equal(applyStartPosition(jewel, v, { row: 99 }).row, 19);
  const fresh = applyStartPosition(jewel, v, { row: 1, col: 1 });
  assert.equal(fresh.enabled, false);
  assert.equal(startSkipFor(jewel, fresh), 0);
  // Thermal roll (1 column): column 3 is accepted and grows the strip layout.
  const std = normalizeTemplate({ name: 'Optical 50 x 25', printer_type: 'thermal', width_mm: 50, height_mm: 25 });
  const r = applyStartPosition(std, FRESH_START, { row: 12, col: 3 });
  assert.deepEqual([r.enabled, r.row, r.col, r.pageRows, r.pageCols], [true, 12, 3, 12, 3]);
  assert.equal(startSkipFor(std, r), 11 * 3 + 2);
  // Overflow past page 1 continues on page 2 from row 1, column 1.
  const late = applyStartPosition(jewel, FRESH_START, { row: 19, col: 2 }); // 37 used
  const two = buildPrintDocument(jewel, tenLabels, { startSkip: startSkipFor(jewel, late) });
  const pages = two.body.split('<div class="gl-sheet">').slice(1);
  assert.equal(pages.length, 2);
  assert.equal(count(pages[1], 'gl-cell'), 9);
  assert.ok(pages[1].startsWith('<div class="gl-grid"><div class="gl-cell"><i>L1</i>'));
});
