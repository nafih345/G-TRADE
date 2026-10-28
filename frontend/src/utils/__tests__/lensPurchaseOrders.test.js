// Run: npm run test:lens-po   (Node's built-in test runner)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SINGLE_PAIR, SPLIT_PAIR, SINGLE_PIECE, lpoQtyLabel, poQtyLabel, rxCells, rxSummary, sameRx,
  pieceFromRequirement, draftItemErrors, itemPayload, buildOrderSheetHtml,
} from '../lensPurchaseOrders.js';

const reqA = { sales_order: 'so-a', sales_order_number: 'SO-101', customer_name: 'Customer A', product: 'hmc', eye: 'RE',
  rx: { sph: '-2.50', cyl: '-0.75', axis: '90' } };
const reqB = { sales_order: 'so-b', sales_order_number: 'SO-102', customer_name: 'Customer B', product: 'hmc', eye: 'LE',
  rx: { sph: '-1.75', cyl: '-0.50', axis: '85' } };
const split = () => ({ product: 'hmc', lens_model: 'HMC 1.56', order_type: SPLIT_PAIR, unit_price: 800,
  pieces: [pieceFromRequirement(reqA), pieceFromRequirement(reqB)] });

test('quantities are never a bare "1"', () => {
  assert.equal(lpoQtyLabel(SPLIT_PAIR, 1), '1 Pair (2 Pieces)');
  assert.equal(lpoQtyLabel(SINGLE_PAIR, 2), '2 Pairs (4 Pieces)');
  assert.equal(lpoQtyLabel(SINGLE_PIECE, 1), '1 Piece (1 Lens)');
  assert.equal(poQtyLabel([{ order_type: SPLIT_PAIR }, { order_type: SINGLE_PIECE }]), '1 Pair + 1 Piece (3 Lenses)');
});

test('rx display and comparison', () => {
  assert.deepEqual(rxCells({ sph: '-2.5', axis: '90' }), { sph: '-2.50', cyl: '—', axis: '90', add: '—', prism: '' });
  assert.equal(rxSummary(reqA.rx), 'SPH -2.50 CYL -0.75 AXIS 90');
  assert.ok(sameRx({ sph: '-2.5' }, { sph: '-2.50', cyl: '' }));
  assert.ok(!sameRx({ sph: '-2.75' }, { sph: '-2.50' }));
});

test('a valid split pair has no errors and posts each lens to its own order', () => {
  const d = split();
  assert.deepEqual(draftItemErrors(d), []);
  const body = itemPayload(d);
  assert.equal(body.pricing_unit, 'PAIR');
  assert.deepEqual(body.pieces.map((p) => [p.sales_order, p.eye, p.rx.sph]), [['so-a', 'RE', '-2.50'], ['so-b', 'LE', '-1.75']]);
});

test('split pair validation', () => {
  const same = split();
  same.pieces[1] = pieceFromRequirement({ ...reqA, eye: 'LE' });
  assert.ok(draftItemErrors(same).some((e) => e.includes('two different customers')));

  const wrongModel = split();
  wrongModel.pieces[1].product = 'bluecut';
  assert.ok(draftItemErrors(wrongModel).some((e) => e.includes('not the selected model')));

  const changed = split();
  changed.pieces[0].rx = { ...changed.pieces[0].rx, sph: '-2.75' };
  assert.ok(draftItemErrors(changed).some((e) => e.includes('give a reason')));
  changed.pieces[0].rx_change_reason = 'Re-checked';
  assert.deepEqual(draftItemErrors(changed), []);
});

test('single customer pair needs one order and both eyes', () => {
  const d = { product: 'hmc', order_type: SINGLE_PAIR, pieces: [pieceFromRequirement(reqA, 'RE'), pieceFromRequirement(reqA, 'RE')] };
  assert.ok(draftItemErrors(d).some((e) => e.includes('one Right (OD) and one Left (OS)')));
  d.pieces[1] = pieceFromRequirement({ ...reqA, eye: 'LE' }, 'LE');
  assert.deepEqual(draftItemErrors(d), []);
});

test('vendor sheet shows both prescriptions and hides customer names', () => {
  const po = {
    po_number: 'LPO-2026-0001', supplier_name: 'Selected Laboratory', order_date: '2026-10-28', status: 'ORDERED',
    items: [{ lens_model: 'HMC 1.56', order_type: SPLIT_PAIR, commercial_quantity: 1, pieces: [
      { piece_number: 1, eye: 'RE', rx: reqA.rx, sales_order_number: 'SO-101', customer_name: 'Customer A', receiving_status: 'PENDING' },
      { piece_number: 2, eye: 'LE', rx: reqB.rx, sales_order_number: 'SO-102', customer_name: 'Customer B', receiving_status: 'PENDING' },
    ] }],
  };
  const vendor = buildOrderSheetHtml(po, { store: { name: 'G Opticals' } });
  for (const text of ['LPO-2026-0001', 'Selected Laboratory', 'HMC 1.56', 'Split Pair', '1 Pair (2 Pieces)',
    '-2.50', '-0.75', '>90<', '-1.75', '-0.50', '>85<', '>OD<', '>OS<', 'SO-101', 'SO-102', 'G Opticals']) {
    assert.ok(vendor.includes(text), `vendor sheet missing ${text}`);
  }
  assert.ok(!vendor.includes('Customer A'));
  assert.ok(!/Qty:\s*1\b/.test(vendor));

  const internal = buildOrderSheetHtml(po, { variant: 'internal' });
  assert.ok(internal.includes('Customer A') && internal.includes('Customer B') && internal.includes('Internal copy'));
  assert.ok(buildOrderSheetHtml(po, { showCustomerOnVendor: true }).includes('Customer B'));
});

test('order sheet escapes HTML', () => {
  const html = buildOrderSheetHtml({ po_number: '<x>', items: [], remarks: '<script>' });
  assert.ok(!html.includes('<script>') && html.includes('&lt;script&gt;'));
});

test('order form numbers lenses in sequence and totals like an invoice', () => {
  const pieces = (n) => Array.from({ length: n }, (_, k) => ({ piece_number: k + 1, eye: k ? 'LE' : 'RE', rx: reqA.rx, sales_order_number: `SO-${k}` }));
  const po = { po_number: 'LPO-1', items: [
    { lens_model: 'HMC 1.56', order_type: SPLIT_PAIR, unit_price: '800', pricing_unit: 'PAIR', tax_percent: '12', line_total: '896.00', pieces: pieces(2) },
    { lens_model: 'Blue Cut', order_type: SINGLE_PIECE, unit_price: '450', pricing_unit: 'PIECE', tax_percent: '0', line_total: '450.00', pieces: pieces(1) },
  ] };
  const html = buildOrderSheetHtml(po);
  const serials = [...html.matchAll(/<td class="c">(\d+)<\/td>\s*(?:<td rowspan|<td class="c">\d of)/g)].map((m) => m[1]);
  assert.deepEqual(serials, ['1', '2', '3']);
  assert.ok(html.includes('1 of 2') && html.includes('2 of 2') && html.includes('1 of 1'));
  assert.ok(html.includes('>1250.00<'), 'sub total = 800 + 450');
  assert.ok(html.includes('>96.00<'), 'GST');
  assert.ok(html.includes('>1346.00<'), 'grand total');
  assert.ok(html.includes('1 Pair + 1 Piece (3 Lenses)'));
  assert.ok(!buildOrderSheetHtml(po, { showPrices: false }).includes('Grand Total'));
});
