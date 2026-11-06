// Lens Purchase Order helpers shared by the Lens PO screens and the order-sheet printout.
// The server (backend/apps/purchasing/lens_orders.py) is the authority on every rule here; these
// only give the screen instant feedback and consistent labels.
import { formatDioptre } from './lensUnits.js';

export const SINGLE_PAIR = 'SINGLE_PAIR';
export const SPLIT_PAIR = 'SPLIT_PAIR';
export const SINGLE_PIECE = 'SINGLE_PIECE';

export const ORDER_TYPES = {
  // Supplier-centric wording: a Pair is both eyes (RE + LE) from one supplier; a Single Lens is one
  // eye — the other eye of a pair can then be ordered from a different supplier on its own PO.
  // SPLIT_PAIR (two orders sharing one pair) can no longer be created; old POs still show it.
  [SINGLE_PAIR]: { label: 'Pair — RE + LE', short: 'Pair', pieces: 2, unit: 'PAIR' },
  [SPLIT_PAIR]: { label: 'Pair — 2 orders', short: 'Pair (2 orders)', pieces: 2, unit: 'PAIR' },
  [SINGLE_PIECE]: { label: 'Single Lens — RE or LE', short: 'Single Lens', pieces: 1, unit: 'PIECE' },
};

export const LPO_STATUSES = {
  DRAFT: { label: 'Draft', color: 'default' },
  PENDING: { label: 'Pending', color: 'warning' },
  ORDERED: { label: 'Ordered', color: 'info' },
  PARTIALLY_RECEIVED: { label: 'Partially Received', color: 'secondary' },
  RECEIVED: { label: 'Received', color: 'success' },
  CANCELLED: { label: 'Cancelled', color: 'error' },
};

export const RECEIVING_STATUSES = {
  PENDING: { label: 'Pending', color: 'default' },
  RECEIVED: { label: 'Received', color: 'success' },
  DAMAGED: { label: 'Damaged', color: 'error' },
  MISSING: { label: 'Missing', color: 'warning' },
  INCORRECT: { label: 'Incorrect', color: 'error' },
};

export const FITTING_STATUSES = {
  PENDING: 'Pending',
  WAITING: 'Waiting for other lens',
  READY_FOR_FITTING: 'Ready for Fitting',
};

export const statusMeta = (status) => LPO_STATUSES[status] || { label: status || '—', color: 'default' };

export const eyeLabel = (eye) => (eye === 'RE' ? 'Right (OD)' : eye === 'LE' ? 'Left (OS)' : '—');
export const eyeShort = (eye) => (eye === 'RE' ? 'OD' : eye === 'LE' ? 'OS' : '—');

/** Never a bare "Qty: 1" — always pairs AND pieces. */
export function lpoQtyLabel(orderType, count = 1) {
  const n = Math.max(0, parseInt(count, 10) || 0);
  if (orderType === SINGLE_PIECE) return `${n} Piece${n === 1 ? '' : 's'} (${n} Lens${n === 1 ? '' : 'es'})`;
  return `${n} Pair${n === 1 ? '' : 's'} (${n * 2} Pieces)`;
}

/** Pairs / pieces across a whole PO, e.g. "2 Pairs + 1 Piece (5 Lenses)". */
export function poQtyLabel(items = []) {
  const pairs = items.filter((it) => (it.order_type || it.orderType) !== SINGLE_PIECE).length;
  const pieces = items.length - pairs;
  const lenses = pairs * 2 + pieces;
  const parts = [];
  if (pairs) parts.push(`${pairs} Pair${pairs === 1 ? '' : 's'}`);
  if (pieces) parts.push(`${pieces} Piece${pieces === 1 ? '' : 's'}`);
  return parts.length ? `${parts.join(' + ')} (${lenses} Lens${lenses === 1 ? '' : 'es'})` : '0 Lenses';
}

const blank = (v) => v === null || v === undefined || String(v).trim() === '';

/** {sph, cyl, axis, add} formatted for a table cell; '—' when blank. */
export function rxCells(rx = {}) {
  const r = rx || {};
  return {
    sph: blank(r.sph) ? '—' : formatDioptre(r.sph),
    cyl: blank(r.cyl) ? '—' : formatDioptre(r.cyl),
    axis: blank(r.axis) ? '—' : String(r.axis).trim(),
    add: blank(r.add) ? '—' : formatDioptre(r.add),
    prism: blank(r.prism) ? '' : `${String(r.prism).trim()}${blank(r.base) ? '' : ` ${String(r.base).toUpperCase()}`}`,
  };
}

export function rxSummary(rx = {}) {
  const c = rxCells(rx);
  const parts = [`SPH ${c.sph}`];
  if (c.cyl !== '—') parts.push(`CYL ${c.cyl}`);
  if (c.axis !== '—') parts.push(`AXIS ${c.axis}`);
  if (c.add !== '—') parts.push(`ADD ${c.add}`);
  if (c.prism) parts.push(`PRISM ${c.prism}`);
  return blank((rx || {}).sph) && parts.length === 1 ? '' : parts.join(' ');
}

const RX_KEYS = ['sph', 'cyl', 'axis', 'add', 'prism', 'base'];
const norm = (v) => {
  if (blank(v)) return '';
  const n = Number(String(v).trim());
  return Number.isFinite(n) ? String(n) : String(v).trim().toUpperCase();
};
export const sameRx = (a = {}, b = {}) => RX_KEYS.every((k) => norm((a || {})[k]) === norm((b || {})[k]));

/** A fresh lens-assignment slot. `req` is a row from pending-requirements. */
export function pieceFromRequirement(req, eye) {
  const rx = { sph: '', cyl: '', axis: '', add: '', prism: '', base: '', ...(req?.rx || {}) };
  return {
    sales_order: req?.sales_order || '',
    sales_order_number: req?.sales_order_number || '',
    customer_name: req?.customer_name || '',
    patient_code: req?.patient_code || '',
    order_date: req?.order_date || '',
    eye: eye || req?.eye || '',
    rx,
    original_rx: { ...rx },
    rx_change_reason: '',
    piece_reference: '',
    product: req?.product || null,
    product_name: req?.product_name || '',
  };
}

/** Client-side checks for one lens line before it is added to the PO (the server re-checks). */
export function draftItemErrors(draft) {
  const errors = [];
  const type = ORDER_TYPES[draft?.order_type];
  if (!draft?.product) errors.push('Select the lens model.');
  if (!type) { errors.push('Select the order type.'); return errors; }
  const pieces = draft.pieces || [];
  if (pieces.length !== type.pieces) errors.push(`${type.short} needs ${type.pieces} lens assignment(s).`);
  pieces.forEach((p, i) => {
    const label = `Lens ${i + 1}`;
    if (!p.sales_order) errors.push(`${label}: select the customer's sales order.`);
    if (p.eye !== 'RE' && p.eye !== 'LE') errors.push(`${label}: select the eye.`);
    if (blank(p.rx?.sph)) errors.push(`${label}: SPH is required.`);
    if (p.product && draft.product && String(p.product) !== String(draft.product)) {
      errors.push(`${label}: ${p.sales_order_number} was sold with ${p.product_name || 'another lens'}, not the selected model.`);
    }
    if (p.original_rx && !sameRx(p.rx, p.original_rx) && blank(p.rx_change_reason)) {
      errors.push(`${label}: the prescription was changed — give a reason.`);
    }
  });
  if (draft.order_type === SINGLE_PAIR && pieces.length === 2) {
    if (pieces[0].sales_order && pieces[0].sales_order !== pieces[1].sales_order) errors.push('Both lenses of a pair belong to one sales order.');
    if ([pieces[0].eye, pieces[1].eye].sort().join() !== 'LE,RE') errors.push('A pair is one Right (OD) and one Left (OS) lens.');
  }
  if (draft.order_type === SPLIT_PAIR && pieces.length === 2 && pieces[0].sales_order && pieces[0].sales_order === pieces[1].sales_order) {
    errors.push('Both eyes of one order are ordered as a Pair.');
  }
  return errors;
}

/** The POST/PUT body for one lens line. */
export function itemPayload(draft) {
  return {
    product: draft.product,
    lens_model: draft.lens_model || '',
    lens_type: draft.lens_type || '',
    lens_index: draft.lens_index || '',
    lens_coating: draft.lens_coating || '',
    order_type: draft.order_type,
    unit_price: parseFloat(draft.unit_price) || 0,
    pricing_unit: draft.pricing_unit || ORDER_TYPES[draft.order_type]?.unit || 'PAIR',
    discount_amount: parseFloat(draft.discount_amount) || 0,
    tax_percent: parseFloat(draft.tax_percent) || 0,
    pieces: (draft.pieces || []).map((p) => ({
      sales_order: p.sales_order,
      eye: p.eye,
      rx: p.rx,
      rx_change_reason: p.rx_change_reason || '',
      piece_reference: p.piece_reference || '',
    })),
  };
}

/** A saved PO item back into the editor's draft shape. */
export function draftFromItem(it) {
  return {
    key: it.id || `${Date.now()}-${Math.random()}`,
    product: it.product,
    product_name: it.product_name,
    lens_model: it.lens_model,
    lens_type: it.lens_type,
    lens_index: it.lens_index,
    lens_coating: it.lens_coating,
    order_type: it.order_type,
    unit_price: it.unit_price,
    pricing_unit: it.pricing_unit,
    discount_amount: it.discount_amount,
    tax_percent: it.tax_percent,
    pieces: (it.pieces || []).map((p) => ({
      ...p,
      rx: { ...(p.rx || {}) },
      original_rx: { ...(p.original_rx || p.rx || {}) },
      product: it.product,
    })),
  };
}

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * Printable lens order sheet. variant 'vendor' is what goes to the lab (order reference only,
 * unless showCustomerOnVendor); 'internal' adds customer, patient code, sales order and receiving.
 * Laid out like an invoice: lenses in sequence, rate / amount per lens line and the totals
 * (showPrices false prints a price-less order sheet).
 */
export function buildOrderSheetHtml(po, { variant = 'vendor', store = {}, showCustomerOnVendor = false, showPrices = true } = {}) {
  const internal = variant === 'internal';
  const showCustomer = internal || showCustomerOnVendor;
  const items = po?.items || [];
  const storeName = store.display_name || store.name || '';
  const address = store.document_address || [store.address, store.city, store.state, store.pin_code].filter(Boolean).join(', ');
  const prismCol = items.some((x) => (x.pieces || []).some((q) => !blank(q.rx?.prism)));
  const contact = [store.phone && `Ph: ${store.phone}`, store.email, store.gstin && `GSTIN: ${store.gstin}`].filter(Boolean).join(' · ');

  // One invoice-style table: lenses numbered 1..N in order, each lens line's model, type,
  // quantity and money cells spanning its pieces, then the totals.
  const money = (n) => (Number(n) || 0).toFixed(2);
  const piecesOf = (it) => (it.pieces || []).length || ORDER_TYPES[it.order_type]?.pieces || 1;
  const taxableOf = (it) => {
    const billed = piecesOf(it) / (it.pricing_unit === 'PIECE' ? 1 : 2);
    return Math.max(0, (Number(it.unit_price) || 0) * billed - (Number(it.discount_amount) || 0));
  };
  const amountOf = (it) => (it.line_total !== undefined && it.line_total !== null && it.line_total !== ''
    ? Number(it.line_total) || 0 : taxableOf(it) * (1 + (Number(it.tax_percent) || 0) / 100));
  let serial = 0;
  const rows = items.map((it) => {
    const span = (it.pieces || []).length || 1;
    const specs = [it.lens_type, it.lens_index && `Index ${it.lens_index}`, it.lens_coating].filter(Boolean).join(' · ');
    return (it.pieces || []).map((p, k) => {
      serial += 1;
      const c = rxCells(p.rx);
      const first = k === 0;
      return `<tr${first ? ' class="first"' : ''}>
        <td class="c">${serial}</td>
        ${first ? `<td rowspan="${span}"><b>${esc(it.lens_model || it.product_name)}</b>${specs ? `<div class="sub">${esc(specs)}</div>` : ''}</td>
        <td rowspan="${span}">${esc(ORDER_TYPES[it.order_type]?.short || it.order_type)}</td>` : ''}
        <td class="c">${k + 1} of ${span}</td>
        <td class="c"><b>${esc(eyeShort(p.eye))}</b></td>
        <td class="c">${esc(c.sph)}</td><td class="c">${esc(c.cyl)}</td><td class="c">${esc(c.axis)}</td><td class="c">${esc(c.add)}</td>
        ${prismCol ? `<td class="c">${esc(c.prism || '—')}</td>` : ''}
        <td>${esc(p.sales_order_number || '')}${showCustomer && p.customer_name ? `<div class="sub">${esc(p.customer_name)}${internal && p.patient_code ? ` · ${esc(p.patient_code)}` : ''}</div>` : ''}</td>
        ${internal ? `<td class="c">${esc(RECEIVING_STATUSES[p.receiving_status]?.label || p.receiving_status || '')}${p.piece_reference ? `<div class="sub">${esc(p.piece_reference)}</div>` : ''}</td>` : ''}
        ${first ? `<td rowspan="${span}" class="c nowrap">${esc(lpoQtyLabel(it.order_type, it.commercial_quantity || 1))}</td>` : ''}
        ${showPrices && first ? `<td rowspan="${span}" class="r nowrap">${money(it.unit_price)}<div class="sub">per ${it.pricing_unit === 'PIECE' ? 'piece' : 'pair'}</div></td>
        <td rowspan="${span}" class="r nowrap">${money(amountOf(it))}${Number(it.tax_percent) ? `<div class="sub">incl. GST ${esc(it.tax_percent)}%</div>` : ''}</td>` : ''}
      </tr>`;
    }).join('');
  }).join('');
  const subtotal = items.reduce((t, it) => t + taxableOf(it), 0);
  const grand = items.reduce((t, it) => t + amountOf(it), 0);
  const colCount = 11 + (prismCol ? 1 : 0) + (internal ? 1 : 0) + (showPrices ? 2 : 0);
  const blocks = items.length ? `<table>
    <thead><tr><th class="c">S.No</th><th>Lens Model</th><th>Order Type</th><th class="c">Piece</th><th class="c">Eye</th>
      <th class="c">SPH</th><th class="c">CYL</th><th class="c">AXIS</th><th class="c">ADD</th>${prismCol ? '<th class="c">Prism</th>' : ''}
      <th>${showCustomer ? 'Order Ref / Customer' : 'Order Ref'}</th>${internal ? '<th class="c">Receiving</th>' : ''}
      <th class="c">Quantity</th>${showPrices ? '<th class="r">Rate</th><th class="r">Amount</th>' : ''}</tr></thead>
    <tbody>${rows}</tbody>
    <tfoot>
      <tr><td colspan="${colCount - (showPrices ? 2 : 0)}" class="r"><b>Total: ${esc(poQtyLabel(items))}</b></td>${showPrices ? `<td class="r">Sub total</td><td class="r">${money(subtotal)}</td>` : ''}</tr>
      ${showPrices && grand - subtotal > 0.004 ? `<tr><td colspan="${colCount - 2}"></td><td class="r">GST</td><td class="r">${money(grand - subtotal)}</td></tr>` : ''}
      ${showPrices ? `<tr class="grand"><td colspan="${colCount - 2}"></td><td class="r">Grand Total</td><td class="r">${money(grand)}</td></tr>` : ''}
    </tfoot>
  </table>` : '';

  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(po?.po_number || 'Lens PO')}</title>
<style>
  *{box-sizing:border-box} body{font-family:Arial,Helvetica,sans-serif;color:#111;margin:24px;font-size:12px}
  .top{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #111;padding-bottom:8px;margin-bottom:12px}
  .store{font-size:18px;font-weight:800} .sub{color:#555;font-size:11px}
  .title{font-size:16px;font-weight:800;text-align:right} .meta{display:grid;grid-template-columns:repeat(2,1fr);gap:4px 24px;margin-bottom:12px}
  tr.first td{border-top:2px solid #555} td.r,th.r{text-align:right} .nowrap{white-space:nowrap}
  tfoot td{border:none;padding:4px 6px} tfoot tr.grand td{font-size:14px;font-weight:800;border-top:2px solid #111}
  table{width:100%;border-collapse:collapse} th,td{border:1px solid #999;padding:5px 6px;text-align:left;vertical-align:top} th{background:#f1f5f9;font-size:11px}
  td.c,th.c{text-align:center} .total{margin-top:8px;font-weight:800;font-size:13px} .remarks{margin-top:10px}
  .sign{display:flex;justify-content:space-between;margin-top:48px} .sign div{border-top:1px solid #111;padding-top:4px;width:200px;text-align:center}
  @media print{body{margin:10mm}}
</style></head><body>
<div class="top">
  <div><div class="store">${esc(storeName)}</div>${address ? `<div class="sub">${esc(address)}</div>` : ''}${contact ? `<div class="sub">${esc(contact)}</div>` : ''}</div>
  <div class="title">LENS PURCHASE ORDER${internal ? '<div class="sub">Internal copy</div>' : ''}</div>
</div>
<div class="meta">
  <div><b>Purchase Order:</b> ${esc(po?.po_number)}</div>
  <div><b>Order Date:</b> ${esc(po?.order_date || '')}</div>
  <div><b>Vendor:</b> ${esc(po?.supplier_name || '')}</div>
  <div><b>Expected Delivery:</b> ${esc(po?.expected_delivery_date || '—')}</div>
  ${internal ? `<div><b>Status:</b> ${esc(statusMeta(po?.status).label)}</div><div><b>Purchase Invoice:</b> ${esc(po?.purchase_invoice_number || '—')}</div>` : ''}
</div>
${blocks || '<p>No lenses on this order.</p>'}
${po?.remarks ? `<div class="remarks"><b>Remarks:</b> ${esc(po.remarks)}</div>` : ''}
<div class="sign"><div>Prepared by</div><div>Authorised signatory</div></div>
</body></html>`;
}

/**
 * Lens PO lines for one customer order's outstanding lenses (pending-requirements rows, as
 * "Create Purchase Entry / Order from Supplier" in Sales > Orders > Lenses sends them): both eyes
 * of one lens model become Pairs, a lone eye a Single Lens. Priced at the
 * product's cost (per its pricing unit, so a single lens on a pair price costs half a pair).
 */
export function lensItemsFromRequirements(reqs = [], products = []) {
  const all = [...products, ...(products.allProducts || [])];
  const groups = new Map();
  reqs.forEach((r) => {
    const key = r.product || `line:${r.sales_order_item}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  });
  const items = [];
  groups.forEach((rows) => {
    const base = rows[0];
    const byEye = { RE: rows.find((r) => r.eye === 'RE'), LE: rows.find((r) => r.eye === 'LE') };
    const left = { RE: byEye.RE?.outstanding || 0, LE: byEye.LE?.outstanding || 0 };
    const product = base.product ? all.find((p) => String(p.id) === String(base.product)) : null;
    const pricingUnit = String(product?.extra_data?.lens_price_unit || '').toUpperCase() === 'PIECE' ? 'PIECE' : 'PAIR';
    const make = (orderType, pieces) => ({
      key: `${Date.now()}-${Math.random()}`,
      product: base.product || '',
      product_name: base.product_name || '',
      lens_model: product?.name || base.product_name || '',
      // As sold (the server reads the line's specs, then the product master) — never re-asked.
      lens_type: base.lens_type || product?.extra_data?.lens_design || '',
      lens_index: base.lens_index || product?.extra_data?.refractive_index || '',
      lens_coating: base.lens_coating || product?.extra_data?.coating || '',
      order_type: orderType,
      unit_price: product ? (parseFloat(product.cost_price) || '') : '',
      pricing_unit: pricingUnit,
      discount_amount: 0,
      tax_percent: parseFloat(product?.tax_rate) || 0,
      pieces,
    });
    while (left.RE > 0 && left.LE > 0) {
      items.push(make(SINGLE_PAIR, [pieceFromRequirement(byEye.RE, 'RE'), pieceFromRequirement(byEye.LE, 'LE')]));
      left.RE -= 1;
      left.LE -= 1;
    }
    ['RE', 'LE'].forEach((eye) => {
      for (; left[eye] > 0; left[eye] -= 1) items.push(make(SINGLE_PIECE, [pieceFromRequirement(byEye[eye], eye)]));
    });
  });
  return items;
}

const sortRE = (a, b) => (a.eye === b.eye ? 0 : a.eye === 'RE' ? -1 : 1);
const cents = (n) => Math.round((parseFloat(n) || 0) * 100) / 100;

/**
 * Pair → Single: a pair line's two eyes become two Single Lens lines so each can get its own
 * supplier (RE from Supplier A, LE from Supplier B). Both keep the customer order reference;
 * `pair_group` lets them be joined back into one Pair. A pair price is split in half.
 */
export function splitPairItem(item) {
  if (!item || item.order_type !== SINGLE_PAIR || (item.pieces || []).length !== 2) return [item];
  const group = item.pair_group || item.key || `${Date.now()}-${Math.random()}`;
  const perPair = item.pricing_unit !== 'PIECE';
  return [...item.pieces].sort(sortRE).map((p) => ({
    ...item,
    key: `${group}-${p.eye}`,
    pair_group: group,
    order_type: SINGLE_PIECE,
    unit_price: item.unit_price === '' || !perPair ? item.unit_price : cents((parseFloat(item.unit_price) || 0) / 2),
    pricing_unit: 'PIECE',
    discount_amount: cents((parseFloat(item.discount_amount) || 0) / 2),
    supplier: item.supplier || '',
    pieces: [p],
  }));
}

/** Single → Pair: joins the line at `index` with its other eye (same pair_group) back into one Pair. */
export function joinPairItems(items, index) {
  const it = items[index];
  if (!it?.pair_group) return items;
  const j = items.findIndex((x, k) => k !== index && x.pair_group === it.pair_group && x.order_type === SINGLE_PIECE);
  if (j < 0) return items;
  const lo = Math.min(index, j);
  const first = items[lo];
  const second = items[lo === index ? j : index];
  const merged = {
    ...first,
    key: first.pair_group,
    order_type: SINGLE_PAIR,
    pricing_unit: 'PAIR',
    unit_price: first.unit_price === '' ? '' : cents((parseFloat(first.unit_price) || 0) + (parseFloat(second.unit_price) || 0)),
    discount_amount: cents((parseFloat(first.discount_amount) || 0) + (parseFloat(second.discount_amount) || 0)),
    supplier: first.supplier || '',
    pieces: [...first.pieces, ...second.pieces].sort(sortRE),
  };
  return items.flatMap((x, k) => (k === lo ? [merged] : k === index || k === j ? [] : [x]));
}

/** The supplier a line is ordered from: its own pick, else the PO header's supplier. */
export const lineSupplier = (item, headerSupplier) => String(item?.supplier || headerSupplier || '');

/**
 * Gives one eye of a line its own supplier, straight from the grid. An eye of a Pair is split off
 * (RE from Supplier A, LE from Supplier B → two Single Lens lines, two POs); when both eyes of a
 * pair split this way end up with the same supplier again they are joined back into the Pair.
 * `supplier` '' = the PO header's supplier.
 */
export function setEyeSupplier(items, index, eye, supplier, headerSupplier = '') {
  const it = items[index];
  if (!it) return items;
  const sup = String(supplier || '') === String(headerSupplier || '') ? '' : String(supplier || '');
  if (it.order_type === SINGLE_PAIR) {
    if (sup === String(it.supplier || '')) return items;
    const parts = splitPairItem(it).map((p) => ({
      ...p, split_by_supplier: true, supplier: p.pieces[0].eye === eye ? sup : String(it.supplier || ''),
    }));
    return items.flatMap((x, j) => (j === index ? parts : [x]));
  }
  const next = items.map((x, j) => (j === index ? { ...x, supplier: sup } : x));
  if (!it.split_by_supplier || !it.pair_group) return next;
  const other = next.findIndex((x, j) => j !== index && x.pair_group === it.pair_group && x.order_type === SINGLE_PIECE);
  if (other < 0 || lineSupplier(next[other], headerSupplier) !== lineSupplier(next[index], headerSupplier)) return next;
  return joinPairItems(next, index).map((x) => (x.key === it.pair_group ? { ...x, split_by_supplier: false } : x));
}

/** [{ supplier, items }] in first-seen order — each group is saved as its own Lens PO. */
export function groupItemsBySupplier(items = [], headerSupplier = '') {
  const groups = new Map();
  items.forEach((it) => {
    const sup = lineSupplier(it, headerSupplier);
    if (!groups.has(sup)) groups.set(sup, []);
    groups.get(sup).push(it);
  });
  return [...groups.entries()].map(([supplier, list]) => ({ supplier, items: list }));
}
