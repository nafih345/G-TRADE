// Run: npm run test:lens-po   (Node's built-in test runner)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SINGLE_PAIR, SPLIT_PAIR, SINGLE_PIECE, lpoQtyLabel, poQtyLabel, rxCells, rxSummary, sameRx,
  pieceFromRequirement, draftItemErrors, itemPayload, buildOrderSheetHtml, lensItemsFromRequirements,
  splitPairItem, joinPairItems, groupItemsBySupplier, setEyeSupplier,
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
  assert.ok(draftItemErrors(same).some((e) => e.includes('ordered as a Pair')));

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
  for (const text of ['LPO-2026-0001', 'Selected Laboratory', 'HMC 1.56', 'Pair (2 orders)', '1 Pair (2 Pieces)',
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

test('lensItemsFromRequirements: a customer order lenses become ready-to-submit PO lines', () => {
  const order = { sales_order: 'so-1', sales_order_number: 'ORD-7', customer_name: 'Asha', product: 'hmc', product_name: 'HMC 1.56', lens_index: '1.56', outstanding: 1 };
  const products = [{ id: 'hmc', name: 'HMC 1.56', cost_price: '400', tax_rate: '12' }];
  const pair = lensItemsFromRequirements([{ ...order, eye: 'RE', rx: { sph: '-2.50' } }, { ...order, eye: 'LE', rx: { sph: '-1.75' } }], products);
  assert.equal(pair.length, 1);
  assert.equal(pair[0].order_type, SINGLE_PAIR);
  assert.deepEqual(pair[0].pieces.map((p) => [p.eye, p.rx.sph, p.sales_order]), [['RE', '-2.50', 'so-1'], ['LE', '-1.75', 'so-1']]);
  assert.equal(pair[0].unit_price, 400);
  assert.equal(pair[0].tax_percent, 12);
  assert.equal(pair[0].lens_index, '1.56');
  assert.deepEqual(draftItemErrors(pair[0]), []);

  const single = lensItemsFromRequirements([{ ...order, eye: 'LE', rx: { sph: '-1.00' } }], products);
  assert.equal(single.length, 1);
  assert.equal(single[0].order_type, SINGLE_PIECE);
  assert.equal(single[0].pricing_unit, 'PAIR'); // pair cost → the server bills half a pair
  assert.deepEqual(draftItemErrors(single[0]), []);

  // A lens line with no product in the master: kept, but the model still has to be picked.
  const custom = lensItemsFromRequirements([{ ...order, product: null, sales_order_item: 'line-1', eye: 'RE', rx: { sph: '-1.00' } }], products);
  assert.equal(custom[0].product, '');
  assert.ok(draftItemErrors(custom[0]).includes('Select the lens model.'));
});

test('pair split by eye: RE and LE to different suppliers become separate POs, and join back', () => {
  const both = { ...reqA, sales_order: 'so-a', product: 'hmc' };
  const pair = {
    key: 'k1', product: 'hmc', order_type: SINGLE_PAIR, unit_price: 1000, pricing_unit: 'PAIR', discount_amount: 100,
    tax_percent: 0, supplier: '', pieces: [pieceFromRequirement({ ...both, eye: 'LE' }, 'LE'), pieceFromRequirement(both, 'RE')],
  };
  const [re, le] = splitPairItem(pair);
  assert.equal(re.order_type, SINGLE_PIECE);
  assert.equal(re.pieces[0].eye, 'RE');
  assert.equal(le.pieces[0].eye, 'LE');
  assert.equal(re.pieces[0].sales_order, 'so-a');
  assert.equal(le.pieces[0].sales_order, 'so-a');
  assert.equal(re.unit_price, 500); // half a pair, priced per piece
  assert.equal(re.pricing_unit, 'PIECE');
  assert.equal(re.discount_amount, 50);
  assert.deepEqual(draftItemErrors(re), []);

  const lines = [re, { ...le, supplier: 'sup-b' }];
  const groups = groupItemsBySupplier(lines, 'sup-a');
  assert.deepEqual(groups.map((g) => g.supplier), ['sup-a', 'sup-b']);
  assert.deepEqual(groups.map((g) => g.items[0].pieces[0].eye), ['RE', 'LE']);

  const joined = joinPairItems(lines, 1);
  assert.equal(joined.length, 1);
  assert.equal(joined[0].order_type, SINGLE_PAIR);
  assert.equal(joined[0].unit_price, 1000);
  assert.equal(joined[0].pricing_unit, 'PAIR');
  assert.deepEqual(joined[0].pieces.map((p) => p.eye), ['RE', 'LE']);
  assert.deepEqual(draftItemErrors(joined[0]), []);
  // One supplier for the whole order = one PO.
  assert.equal(groupItemsBySupplier(joined, 'sup-a').length, 1);
});

test('lensItemsFromRequirements: lens type and coating come pre-filled as sold', () => {
  const order = { sales_order: 'so-1', sales_order_number: 'ORD-8', customer_name: 'Ravi', product: 'pg', product_name: 'Progressive', outstanding: 1 };
  const products = [{ id: 'pg', name: 'Progressive 1.60', cost_price: '1200', extra_data: { lens_design: 'Progressive', coating: 'Blue Cut', refractive_index: '1.60' } }];
  const [fromSale] = lensItemsFromRequirements([{ ...order, eye: 'RE', rx: { sph: '1.00' }, lens_type: 'Office', lens_coating: 'HMC' }], products);
  assert.equal(fromSale.lens_type, 'Office');
  assert.equal(fromSale.lens_coating, 'HMC');
  assert.equal(fromSale.lens_index, '1.60'); // product master fallback
  const [fromMaster] = lensItemsFromRequirements([{ ...order, eye: 'LE', rx: { sph: '1.00' } }], products);
  assert.equal(fromMaster.lens_type, 'Progressive');
  assert.equal(fromMaster.lens_coating, 'Blue Cut');
});

test("setEyeSupplier: changing one eye's supplier splits the pair; matching again rejoins it", () => {
  const order = { sales_order: 'so-1', sales_order_number: 'ORD-9', customer_name: 'Mini', product: 'hmc', product_name: 'HMC', outstanding: 1 };
  const [pair] = lensItemsFromRequirements([{ ...order, eye: 'RE', rx: { sph: '-1.00' } }, { ...order, eye: 'LE', rx: { sph: '-1.25' } }],
    [{ id: 'hmc', name: 'HMC', cost_price: '800' }]);
  const items = [pair];
  // Same as the header supplier: nothing changes.
  assert.equal(setEyeSupplier(items, 0, 'LE', 'sup-a', 'sup-a'), items);

  const split = setEyeSupplier(items, 0, 'LE', 'sup-b', 'sup-a');
  assert.equal(split.length, 2);
  assert.deepEqual(split.map((x) => [x.order_type, x.pieces[0].eye, x.supplier, x.unit_price]),
    [[SINGLE_PIECE, 'RE', '', 400], [SINGLE_PIECE, 'LE', 'sup-b', 400]]);
  const groups = groupItemsBySupplier(split, 'sup-a');
  assert.deepEqual(groups.map((g) => [g.supplier, g.items.length]), [['sup-a', 1], ['sup-b', 1]]);
  assert.ok(split.every((x) => x.pieces[0].sales_order === 'so-1'), 'both POs keep the customer order');

  // LE back to the PO supplier → one Pair again.
  const joined = setEyeSupplier(split, 1, 'LE', 'sup-a', 'sup-a');
  assert.equal(joined.length, 1);
  assert.equal(joined[0].order_type, SINGLE_PAIR);
  assert.equal(joined[0].unit_price, 800);
  assert.deepEqual(joined[0].pieces.map((x) => x.eye), ['RE', 'LE']);

  // An explicit Pair → Single split is not rejoined just because the suppliers match.
  const manual = splitPairItem(pair);
  assert.equal(setEyeSupplier(manual, 1, 'LE', '', 'sup-a').length, 2);
});
