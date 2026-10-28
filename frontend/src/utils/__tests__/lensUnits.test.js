// Run: npm run test:lens   (Node's built-in test runner)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PAIR, PIECE, BOTH, RE, LE, ONE_EYE_MESSAGE, isPairSellable, isSpectacleLensCategory, lensPricing, unitPrice,
  physicalQty, qtyLabel, stockHint, formatDioptre, validateLensLine, lensPowerText, rxFromGrid,
  lensFromSavedItem, lensToPayload, emptyEyeRx,
} from '../lensUnits.js';
import { toBillModel } from '../../billing/documentAdapters.js';
import { renderVisualBillHtml } from '../../billing/renderBillLayout.js';
import { blankConfig } from '../../billing/billLayout.js';
import { renderBillHtml } from '../../billing/renderBillHtml.js';
import { PRESET_TEMPLATES } from '../../billing/templatePresets.js';

const eye = (o = {}) => ({ ...emptyEyeRx(), ...o });
const lens = (o = {}) => ({
  sellingUnit: PAIR, eye: BOTH,
  rx: { re: eye({ sph: '-2.50', cyl: '-0.75', axis: '90' }), le: eye({ sph: '-1.75', cyl: '-0.50', axis: '85' }) },
  ...o,
});

test('only spectacle lenses get Pair / Single Lens; product flag overrides the category', () => {
  assert.equal(isSpectacleLensCategory('Prescription Lenses'), true);
  assert.equal(isSpectacleLensCategory('LENS'), true);
  assert.equal(isSpectacleLensCategory('Contact Lenses'), false);
  assert.equal(isSpectacleLensCategory('Lens Solutions'), false);
  assert.equal(isSpectacleLensCategory('FRAME'), false);
  assert.equal(isPairSellable({ category: 'Frames' }), false);
  assert.equal(isPairSellable({ category: 'Accessories' }), false);
  assert.equal(isPairSellable({ category: 'Prescription Lenses' }), true);
  assert.equal(isPairSellable({ category: 'Prescription Lenses', extra_data: { lens_unit_selection: false } }), false);
  assert.equal(isPairSellable({ category: 'Custom', extra_data: { lens_unit_selection: true } }), true);
});

test('pair-priced lens: piece price from explicit price, product %, or the business default %', () => {
  const byDefault = lensPricing({ extra_data: {} }, 2000, 50);
  assert.equal(byDefault.pairPrice, 2000);
  assert.equal(byDefault.piecePrice, 1000);
  assert.equal(byDefault.pieceSource, 'PERCENT');
  assert.equal(lensPricing({ extra_data: {} }, 2000, 60).piecePrice, 1200, 'business default is not hardcoded');
  assert.equal(lensPricing({ extra_data: { lens_piece_percent: 55 } }, 2000, 50).piecePrice, 1100);
  const explicit = lensPricing({ extra_data: { lens_piece_price: 1150, lens_piece_percent: 40 } }, 2000, 50);
  assert.equal(explicit.piecePrice, 1150);
  assert.equal(explicit.pieceSource, 'EXPLICIT');
  assert.equal(unitPrice(explicit, PAIR), 2000, 'pair price never changes');
});

test('piece-priced lens: pair price explicit or 2 × piece', () => {
  const p = lensPricing({ extra_data: { lens_price_unit: 'PIECE' } }, 900);
  assert.deepEqual([p.piecePrice, p.pairPrice, p.pairSource], [900, 1800, 'DOUBLE']);
  const q = lensPricing({ extra_data: { lens_price_unit: 'PIECE', lens_pair_price: 1700 } }, 900);
  assert.equal(q.pairPrice, 1700);
});

test('commercial vs physical quantity', () => {
  assert.equal(physicalQty(PAIR, 1), 2);
  assert.equal(physicalQty(PAIR, 2), 4);
  assert.equal(physicalQty(PAIR, 3), 6);
  assert.equal(physicalQty(PIECE, 1), 1);
  assert.equal(physicalQty(PIECE, 2), 2);
  assert.equal(qtyLabel(PAIR, 1), '1 Pair (2 Lenses)');
  assert.equal(qtyLabel(PAIR, 3), '3 Pairs (6 Lenses)');
  assert.equal(qtyLabel(PIECE, 1), '1 Piece (1 Lens)');
  assert.equal(qtyLabel(PIECE, 2), '2 Pieces (2 Lenses)');
  assert.match(stockHint(PAIR, 1, PAIR), /^1 pair from stock$/);
  assert.match(stockHint(PIECE, 1, PAIR), /whole pair/);
  assert.equal(stockHint(PAIR, 1, PIECE), '2 pieces from stock');
});

test('pair needs both eyes; one eye gives the exact warning; blank is never zero', () => {
  assert.deepEqual(validateLensLine(lens()).errors, []);
  const oneEye = lens({ rx: { re: eye({ sph: '-2.50' }), le: eye() } });
  assert.deepEqual(validateLensLine(oneEye).errors, [ONE_EYE_MESSAGE]);
  const none = lens({ rx: { re: eye(), le: eye() } });
  assert.match(validateLensLine(none).errors[0], /both eyes/);
  // A quotation may be an estimate — incomplete is fine, invalid is not.
  assert.deepEqual(validateLensLine(oneEye, { requireComplete: false }).errors, []);
  const bad = lens({ rx: { re: eye({ sph: '-2.30' }), le: eye({ sph: 'abc' }) } });
  assert.equal(validateLensLine(bad, { requireComplete: false }).errors.length, 2);
});

test('single lens needs an eye and only that eye', () => {
  const noEye = lens({ sellingUnit: PIECE, eye: '', rx: { re: eye({ sph: '-2.50' }), le: eye() } });
  assert.match(validateLensLine(noEye).errors[0], /select the eye/);
  const right = { ...noEye, eye: RE };
  assert.deepEqual(validateLensLine(right).errors, []);
  const left = { ...noEye, eye: LE };
  assert.match(validateLensLine(left).errors[0], /Left eye \(LE\) SPH is required/);
});

test('value ranges: axis required with cyl, axis 0-180, add not negative, prism needs base', () => {
  const errs = (e) => validateLensLine(lens({ rx: { re: eye({ sph: '-1.00', ...e }), le: eye({ sph: '-1.00' }) } })).errors;
  assert.match(errs({ cyl: '-0.50' })[0], /AXIS is required/);
  assert.match(errs({ cyl: '-0.50', axis: '190' })[0], /between 0 and 180/);
  assert.match(errs({ add: '-1.00' })[0], /outside/);
  assert.match(errs({ prism: '2' })[0], /BASE/);
  assert.deepEqual(errs({ prism: '2', base: 'IN' }), []);
  assert.deepEqual(errs({ sph: '+1.25' }), []);
  assert.deepEqual(errs({ sph: 'PL' }), []);
});

test('power text per selling unit', () => {
  assert.equal(lensPowerText(lens()), 'RE: SPH -2.50 CYL -0.75 AXIS 90 | LE: SPH -1.75 CYL -0.50 AXIS 85');
  assert.equal(lensPowerText(lens({ sellingUnit: PIECE, eye: RE, rx: { re: eye({ sph: '-2.50' }), le: eye({ sph: '-1.00' }) } })),
    'Right Eye (RE): SPH -2.50');
  assert.equal(lensPowerText(lens({ rx: { re: eye(), le: eye() } })), '');
  assert.equal(formatDioptre('-2.5'), '-2.50');
  assert.equal(formatDioptre('1.25'), '+1.25');
  assert.equal(formatDioptre('pl'), 'PL');
});

test('grid → line → payload → saved line round trip', () => {
  const rx = rxFromGrid({ sphOD: '-2.50', cylOD: '-0.75', axisOD: '90', addOD: '+2.00', sphOS: '-1.75', prismOS: '1', baseOS: 'IN' });
  assert.equal(rx.re.add, '+2.00');
  assert.equal(rx.le.base, 'IN');
  const l = { ...lens({ rx }), pricing: lensPricing({ extra_data: {} }, 2000, 50), lensIndex: '1.67' };
  const payload = lensToPayload(l, 2);
  assert.equal(payload.selling_unit, PAIR);
  assert.equal(payload.lens_eye, BOTH);
  assert.equal(payload.physical_quantity, 4);
  const back = lensFromSavedItem({ ...payload, lens_details: { ...payload.lens_details, stock_unit: 'PIECE' } });
  assert.equal(back.sellingUnit, PAIR);
  assert.deepEqual(back.rx.re, rx.re);
  assert.equal(back.pricing.piecePrice, 1000);
  assert.equal(back.pricing.stockUnit, 'PIECE');
  assert.equal(back.rxLinked, false, 'a reopened bill keeps its own prescription');
  assert.equal(lensFromSavedItem({ selling_unit: '' }), null, 'frames / old lines stay non-lens');
});

test('bill shows "1 Pair (2 Lenses)" / "per Pair" — and leaves frames alone', () => {
  const m = toBillModel({
    invoice_number: 'INV-1', net_amount: '3000.00',
    items: [
      { description: 'Progressive Lens', quantity: 1, unit_price: '2000.00', subtotal: '2000.00', selling_unit: 'PAIR',
        power: 'RE: SPH -2.50 | LE: SPH -1.75' },
      { description: 'Single Vision Lens', quantity: 1, unit_price: '1000.00', subtotal: '1000.00', selling_unit: 'PIECE',
        power: 'Right Eye (RE): SPH -2.50' },
      { description: 'Frame', quantity: 1, unit_price: '500.00', subtotal: '500.00' },
    ],
  }, 'SALES_INVOICE');
  assert.equal(m.items[0].lensQty, '1 Pair (2 Lenses)');
  assert.equal(m.items[0].unit, 'Pair');
  assert.equal(m.items[1].lensQty, '1 Piece (1 Lens)');
  assert.equal(m.items[2].lensQty, '');
  assert.equal(m.items[2].qtyUnit, '');

  const visual = renderVisualBillHtml({ paper_size: 'A4', orientation: 'portrait', margins: { top: 10, right: 10, bottom: 10, left: 10 }, config: blankConfig() }, m, { measure: 'estimate' }).html;
  const thermal = renderBillHtml(PRESET_TEMPLATES.find((t) => t.id === 'preset-thermal-80'), m);
  for (const [name, html] of [['A4 designer template', visual], ['thermal 80mm', thermal]]) {
    assert.match(html, /1 Pair \(2 Lenses\) @ [^<]*2,000\.00 per Pair/, `${name}: pair line`);
    assert.match(html, /1 Piece \(1 Lens\) @ [^<]*1,000\.00 per Piece/, `${name}: piece line`);
    assert.match(html, /Right Eye \(RE\): SPH -2\.50/, `${name}: single-eye power`);
    assert.equal((html.match(/per Pair/g) || []).length >= 1, true);
    assert.doesNotMatch(html.slice(html.lastIndexOf('Frame')), /per (Pair|Piece)/, `${name}: frame line has no unit text`);
  }
});
