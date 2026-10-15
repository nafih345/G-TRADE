// Barcode label designer — template model: element factories, geometry, snapping,
// auto-layout (beginner mode), legacy conversion and print-job arithmetic.
//
// A template is { id, name, printer_type, width_mm, height_mm, version, layout } where
// layout = { schema, paddingMm, gapMm, defaultBarcodeFormat, sheet?, elements[] }.
// Every position / size is millimetres from the label's top-left; font sizes are pt.
// The backend (apps/products/label_fields.py) validates the same shape. Pure module.
import { FIELD_BY_ID, RESTRICTED_FIELD_IDS } from './labelFields.js';

export const PT_TO_MM = 25.4 / 72;
export const MM_PER_INCH = 25.4;
export const A4_MM = { w: 210, h: 297 };

export const BARCODE_FORMATS = [
  { id: 'CODE128', label: 'Code 128', hint: 'Any letters, digits or symbols — works with every barcode value.' },
  { id: 'CODE39', label: 'Code 39', hint: 'Uppercase A–Z, digits and - . $ / + % space.' },
  { id: 'EAN13', label: 'EAN-13', hint: '12 or 13 digits (13th is the check digit).' },
  { id: 'EAN8', label: 'EAN-8', hint: '7 or 8 digits.' },
  { id: 'UPC', label: 'UPC-A', hint: '11 or 12 digits.' },
  { id: 'UPCE', label: 'UPC-E', hint: '6 to 8 digits.' },
];

export const FONT_FAMILIES = ['Arial', 'Helvetica', 'Verdana', 'Tahoma', 'Courier New', 'Times New Roman'];

export const THERMAL_PRESET_SIZES = [
  { w: 38, h: 25 }, { w: 50, h: 25 }, { w: 50, h: 30 }, { w: 40, h: 30 }, { w: 60, h: 40 }, { w: 90, h: 13 },
];

export const A4_SHEET_PRESETS = [
  { id: 'a4_24', label: '24 / sheet (3 × 8, 63.5 × 33.9 mm)', w: 63.5, h: 33.9, sheet: { cols: 3, rows: 8, marginTopMm: 10.7, marginLeftMm: 7.2, colGapMm: 2.5, rowGapMm: 0 } },
  { id: 'a4_40', label: '40 / sheet (4 × 10, 48.5 × 25.4 mm)', w: 48.5, h: 25.4, sheet: { cols: 4, rows: 10, marginTopMm: 21.5, marginLeftMm: 8, colGapMm: 0, rowGapMm: 0 } },
  { id: 'a4_65', label: '65 / sheet (5 × 13, 38.1 × 21.2 mm)', w: 38.1, h: 21.2, sheet: { cols: 5, rows: 13, marginTopMm: 10.7, marginLeftMm: 4.8, colGapMm: 2.5, rowGapMm: 0 } },
  { id: 'a4_dumbbell', label: 'Dumbbell tags 38 / sheet (2 × 19, 92 × 14.5 mm)', w: 92, h: 14.5, sheet: { cols: 2, rows: 19, marginTopMm: 10, marginLeftMm: 12, colGapMm: 6, rowGapMm: 0 } },
];

export const DEFAULT_SHEET = { cols: 3, rows: 8, marginTopMm: 10, marginLeftMm: 7, colGapMm: 2.5, rowGapMm: 0 };

export const round = (n, step = 0.1) => Math.round((Number(n) || 0) / step) * step;
export const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
export const num = (v, d = 0) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : d;
};

let idSeq = 0;
export function newElementId(prefix = 'el') {
  idSeq += 1;
  return `${prefix}${Date.now().toString(36).slice(-4)}${idSeq.toString(36)}${Math.floor(Math.random() * 36 ** 2).toString(36)}`.slice(0, 40);
}

export const defaultTextStyle = (over = {}) => ({
  fontFamily: 'Arial', fontSizePt: 7, fontWeight: 400, italic: false, uppercase: false,
  align: 'left', vAlign: 'middle', overflow: 'ellipsis', maxLines: 2, letterSpacingMm: 0,
  color: '#000000', invert: false, ...over,
});

// Factory for each element type, sized sensibly for the label it is dropped on.
export function createElement(type, { field, x = 1, y = 1, labelW = 38, labelH = 25 } = {}) {
  const base = { id: newElementId(type.slice(0, 2)), type, name: '', x, y, rotation: 0, hidden: false, locked: false };
  const fitW = (w) => Math.max(2, Math.min(w, labelW - x - 0.5));
  switch (type) {
    case 'field': {
      const def = FIELD_BY_ID[field] || FIELD_BY_ID.product_name;
      const isPrice = def.kind === 'price';
      return {
        ...base, field: def.id, w: fitW(labelW * 0.6), h: isPrice ? 3.4 : 2.8,
        prefix: '', suffix: '', priceFormat: 'currency', required: false, fallback: { mode: 'hide' },
        style: defaultTextStyle({ fontSizePt: isPrice ? 8 : 6.5, fontWeight: isPrice || def.id === 'product_name' ? 700 : 400 }),
      };
    }
    case 'text':
      return { ...base, text: 'Text', w: fitW(15), h: 2.8, style: defaultTextStyle() };
    case 'barcode':
      return {
        ...base, field: 'barcode', w: fitW(labelW - 2), h: Math.min(10, Math.max(5, labelH * 0.4)),
        barcode: { format: 'inherit', showText: true, textSizePt: 6, quietZoneMm: 1.5, moduleMm: 0, align: 'center' },
      };
    case 'qr':
      return { ...base, field: 'barcode', w: Math.min(12, labelH - 2), h: Math.min(12, labelH - 2) };
    case 'line':
      return { ...base, w: fitW(labelW - 2), h: 0.3, strokeMm: 0.25, color: '#000000' };
    case 'rect':
      return { ...base, w: fitW(labelW - 2), h: Math.max(2, labelH - y - 1), strokeMm: 0.25, color: '#000000', fill: false, radiusMm: 0 };
    case 'logo':
      return { ...base, w: 8, h: 6, fit: 'contain' };
    default:
      throw new Error(`Unknown element type ${type}`);
  }
}

export function elementTitle(el) {
  if (el.name) return el.name;
  switch (el.type) {
    case 'field': return FIELD_BY_ID[el.field]?.label || el.field;
    case 'text': return `“${String(el.text || '').slice(0, 18)}”`;
    case 'barcode': return el.field === 'sku' ? 'Barcode (SKU)' : 'Barcode';
    case 'qr': return 'QR code';
    case 'line': return 'Line';
    case 'rect': return 'Box';
    case 'logo': return 'Store logo';
    default: return el.type;
  }
}

export function blankTemplate(printerType = 'thermal') {
  const isA4 = printerType === 'a4';
  return {
    id: null, name: '', description: '', printer_type: printerType,
    width_mm: isA4 ? 63.5 : 38, height_mm: isA4 ? 33.9 : 25, version: 0, is_default: false,
    layout: {
      schema: 1, paddingMm: 1, gapMm: 0, defaultBarcodeFormat: 'CODE128', elements: [],
      ...(isA4 ? { sheet: { ...A4_SHEET_PRESETS[0].sheet } } : {}),
    },
  };
}

// Templates come back from the API with decimal strings; normalise once at load.
export function normalizeTemplate(t) {
  if (!t) return t;
  const layout = t.layout && typeof t.layout === 'object' ? t.layout : {};
  return {
    ...t,
    width_mm: num(t.width_mm, 38),
    height_mm: num(t.height_mm, 25),
    layout: {
      schema: 1,
      paddingMm: num(layout.paddingMm, 1),
      gapMm: num(layout.gapMm, 0),
      defaultBarcodeFormat: layout.defaultBarcodeFormat || 'CODE128',
      ...(t.printer_type === 'a4' ? { sheet: { ...DEFAULT_SHEET, ...(layout.sheet || {}) } } : {}),
      elements: Array.isArray(layout.elements) ? layout.elements : [],
    },
  };
}

export const templateUsesRestricted = (t) =>
  (t?.layout?.elements || []).some((el) => RESTRICTED_FIELD_IDS.has(el.field) || RESTRICTED_FIELD_IDS.has(el.fallback?.field));

export const templateFieldIds = (t) => new Set((t?.layout?.elements || []).filter((el) => !el.hidden && el.field).map((el) => el.field));

export function sheetUsage(template) {
  const s = template?.layout?.sheet || DEFAULT_SHEET;
  const w = num(template?.width_mm);
  const h = num(template?.height_mm);
  return {
    usedW: num(s.marginLeftMm) + s.cols * w + (s.cols - 1) * num(s.colGapMm),
    usedH: num(s.marginTopMm) + s.rows * h + (s.rows - 1) * num(s.rowGapMm),
    perSheet: s.cols * s.rows,
  };
}

// ---------------------------------------------------------------------------
// Geometry warnings (no DOM): elements beyond the label / outside the safe margin.
// ---------------------------------------------------------------------------
export function geometryWarnings(template) {
  const W = num(template.width_mm);
  const H = num(template.height_mm);
  const pad = num(template.layout?.paddingMm, 0);
  const out = [];
  for (const el of template.layout?.elements || []) {
    if (el.hidden) continue;
    const eps = 0.05;
    if (el.x < -eps || el.y < -eps || el.x + el.w > W + eps || el.y + el.h > H + eps) {
      out.push({ level: 'error', elementId: el.id, message: `${elementTitle(el)} extends beyond the ${W} × ${H} mm label and will be cut off.` });
    } else if (pad > 0 && el.type !== 'rect' && (el.x < pad - eps || el.y < pad - eps || el.x + el.w > W - pad + eps || el.y + el.h > H - pad + eps)) {
      out.push({ level: 'info', elementId: el.id, message: `${elementTitle(el)} is inside the ${pad} mm safe margin — thermal printers may clip the edge.` });
    }
  }
  if (template.printer_type === 'a4') {
    const { usedW, usedH } = sheetUsage(template);
    if (usedW > A4_MM.w + 0.5 || usedH > A4_MM.h + 0.5) {
      out.push({ level: 'error', message: `Sheet layout needs ${r2(usedW)} × ${r2(usedH)} mm but A4 is 210 × 297 mm.` });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Snapping (editor): grid + alignment guides to label edges/centre and other elements.
// ---------------------------------------------------------------------------
export function snapPosition(box, { others = [], W, H, grid = 0.5, snapGrid = true, threshold = 0.8 }) {
  const guides = [];
  let { x, y } = box;
  const xs = [0, W / 2, W];
  const ys = [0, H / 2, H];
  for (const o of others) {
    xs.push(o.x, o.x + o.w / 2, o.x + o.w);
    ys.push(o.y, o.y + o.h / 2, o.y + o.h);
  }
  const bestSnap = (pos, size, targets) => {
    let best = null;
    for (const [offset] of [[0], [size / 2], [size]]) {
      for (const t of targets) {
        const d = Math.abs(pos + offset - t);
        if (d <= threshold && (!best || d < best.d)) best = { d, value: t - offset, line: t };
      }
    }
    return best;
  };
  const sx = bestSnap(x, box.w, xs);
  const sy = bestSnap(y, box.h, ys);
  if (sx) { x = sx.value; guides.push({ axis: 'x', at: sx.line }); } else if (snapGrid) x = round(x, grid);
  if (sy) { y = sy.value; guides.push({ axis: 'y', at: sy.line }); } else if (snapGrid) y = round(y, grid);
  return { x: r2(x), y: r2(y), guides };
}

export function alignElements(elements, ids, mode, W, H) {
  const sel = elements.filter((e) => ids.includes(e.id));
  if (!sel.length) return elements;
  // One element aligns to the label; several align to their shared bounding box.
  const box = sel.length === 1
    ? { x0: 0, y0: 0, x1: W, y1: H }
    : {
      x0: Math.min(...sel.map((e) => e.x)), y0: Math.min(...sel.map((e) => e.y)),
      x1: Math.max(...sel.map((e) => e.x + e.w)), y1: Math.max(...sel.map((e) => e.y + e.h)),
    };
  return elements.map((e) => {
    if (!ids.includes(e.id) || e.locked) return e;
    switch (mode) {
      case 'left': return { ...e, x: r2(box.x0) };
      case 'right': return { ...e, x: r2(box.x1 - e.w) };
      case 'hcenter': return { ...e, x: r2((box.x0 + box.x1) / 2 - e.w / 2) };
      case 'top': return { ...e, y: r2(box.y0) };
      case 'bottom': return { ...e, y: r2(box.y1 - e.h) };
      case 'vcenter': return { ...e, y: r2((box.y0 + box.y1) / 2 - e.h / 2) };
      default: return e;
    }
  });
}

// Scales every element proportionally when the label size changes (or "Fit to canvas").
export function scaleElements(elements, fromW, fromH, toW, toH) {
  const sx = toW / (fromW || toW);
  const sy = toH / (fromH || toH);
  const sf = Math.min(sx, sy);
  return elements.map((e) => {
    const out = { ...e, x: r2(e.x * sx), y: r2(e.y * sy), w: r2(e.w * sx), h: r2(e.h * sy) };
    if (e.style) out.style = { ...e.style, fontSizePt: Math.max(3, r2(e.style.fontSizePt * sf)) };
    if (e.barcode) out.barcode = { ...e.barcode, textSizePt: Math.max(3, r2(e.barcode.textSizePt * sf)) };
    return out;
  });
}

// Pulls every element back inside the printable area (shrinking those too large to fit).
export function fitElementsToLabel(elements, W, H, pad = 0) {
  return elements.map((e) => {
    const w = Math.min(e.w, W - 2 * pad);
    const h = Math.min(e.h, H - 2 * pad);
    return {
      ...e, w: r2(w), h: r2(h),
      x: r2(Math.min(Math.max(e.x, pad), W - pad - w)),
      y: r2(Math.min(Math.max(e.y, pad), H - pad - h)),
    };
  });
}

// ---------------------------------------------------------------------------
// Beginner mode: tick the fields you want, get a balanced layout for the label size.
// ---------------------------------------------------------------------------
export const AUTO_LAYOUT_FIELDS = ['store_name', 'product_name', 'brand', 'model_number', 'selling_price', 'mrp', 'colour', 'size', 'sku', 'barcode_text'];

export function autoLayout({ W, H, fields = [], barcode = true, style = 'card', pad = 1 }) {
  const want = new Set(fields);
  const innerW = W - 2 * pad;
  const els = [];
  // Rows of [fieldId, relative height, opts]. Colour/size share one row.
  const rows = [];
  if (want.has('store_name')) rows.push({ items: [['store_name', { weight: 800, upper: true, align: style === 'card' ? 'left' : 'center' }]], rel: 0.8 });
  if (want.has('brand')) rows.push({ items: [['brand', { weight: 800, upper: true }]], rel: 1 });
  if (want.has('product_name')) rows.push({ items: [['product_name', { weight: 700, overflow: 'wrap', maxLines: 2 }]], rel: H >= 22 ? 1.7 : 1 });
  if (want.has('model_number')) rows.push({ items: [['model_number', { prefix: 'Model ' }]], rel: 0.85 });
  const prices = [['selling_price', { weight: 800, prefix: style === 'card' ? 'PRICE ' : 'Price ' }], ['mrp', { weight: 700, prefix: 'MRP ' }]].filter(([f]) => want.has(f));
  if (prices.length) rows.push({ items: prices, rel: 1.15 });
  const attrs = [['colour', { prefix: 'Colour ' }], ['size', { prefix: 'Size ' }]].filter(([f]) => want.has(f));
  if (attrs.length) rows.push({ items: attrs, rel: 0.85 });
  if (want.has('sku')) rows.push({ items: [['sku', { prefix: 'SKU ' }]], rel: 0.85 });

  const barcodeH = barcode ? Math.max(5, Math.min(H * 0.42, 16)) : 0;
  const textH = H - 2 * pad - barcodeH - (barcode ? 0.6 : 0);
  const totalRel = rows.reduce((s, r) => s + r.rel, 0) || 1;
  const unit = Math.min(textH / totalRel, 4.2);
  let y = pad;
  for (const row of rows) {
    const h = r2(unit * row.rel);
    const colW = innerW / row.items.length;
    row.items.forEach(([field, o], i) => {
      const align = o.align || (style === 'card' ? (row.items.length > 1 && i === row.items.length - 1 ? 'right' : 'left') : 'center');
      const lines = o.overflow === 'wrap' ? o.maxLines || 2 : 1;
      els.push({
        ...createElement('field', { field, x: pad, y, labelW: W, labelH: H }),
        x: r2(pad + colW * i), y: r2(y), w: r2(colW), h,
        prefix: o.prefix || '',
        style: defaultTextStyle({
          fontSizePt: Math.max(4, Math.min(12, r2((h / lines) / PT_TO_MM / 1.2))),
          fontWeight: o.weight || 400, uppercase: !!o.upper, align,
          overflow: o.overflow || 'ellipsis', maxLines: lines,
        }),
      });
    });
    y += h;
  }
  if (barcode) {
    const textOn = want.has('barcode_text');
    els.push({
      ...createElement('barcode', { labelW: W, labelH: H }),
      x: pad, y: r2(H - pad - barcodeH), w: r2(innerW), h: r2(barcodeH),
      barcode: { format: 'inherit', showText: textOn, textSizePt: Math.max(4, Math.min(8, r2(barcodeH * 0.55))), quietZoneMm: Math.min(1.5, innerW * 0.04), moduleMm: 0, align: 'center' },
    });
  }
  return els;
}

// ---------------------------------------------------------------------------
// Legacy: the pre-designer settings lived in localStorage (`optical_barcode_print_settings`
// + `optical_barcode_custom_layouts`). Convert them to templates once, so nothing a shop
// had configured is lost when templates move to the database.
// ---------------------------------------------------------------------------
const LEGACY_THERMAL = {
  roll_38x25: [38, 25], roll_40x30: [40, 30], roll_50x25: [50, 25], roll_50x30: [50, 30], roll_60x40: [60, 40],
  roll_rattail_54x13: [90, 13], roll_rattail_75x10: [75, 12],
};
const LEGACY_A4 = {
  a4_24up: [63.5, 33.9, { cols: 3, rows: 8, marginTopMm: 10.7, marginLeftMm: 7.2, colGapMm: 2.5, rowGapMm: 0 }],
  a4_65up: [38.1, 21.2, { cols: 5, rows: 13, marginTopMm: 10.7, marginLeftMm: 4.8, colGapMm: 2.5, rowGapMm: 0 }],
  a4_80up: [48.5, 13.5, { cols: 4, rows: 20, marginTopMm: 12.5, marginLeftMm: 6.5, colGapMm: 2, rowGapMm: 0 }],
  a4_jewellery_38up: [92, 14.5, { cols: 2, rows: 19, marginTopMm: 10, marginLeftMm: 12, colGapMm: 6, rowGapMm: 0 }],
  a4_rattail_38up: [97, 13, { cols: 2, rows: 21, marginTopMm: 9, marginLeftMm: 6, colGapMm: 4, rowGapMm: 0 }],
};

function legacyFieldList(s) {
  const f = [];
  if (s.showBusinessName) f.push('store_name');
  if (s.showProductName) f.push('product_name');
  if (s.showPrice) f.push('selling_price');
  if (s.showColour) f.push('colour');
  if (s.showSize) f.push('size');
  if (s.showProductCode) f.push('sku');
  if (s.showBarcodeText) f.push('barcode_text');
  return f;
}

function legacyFormat(type) {
  return BARCODE_FORMATS.some((b) => b.id === type) ? type : 'CODE128';
}

function legacyTemplate(name, printerType, W, H, s, sheet, gapMm = 0) {
  const fields = legacyFieldList(s);
  const elements = autoLayout({ W, H, fields, barcode: true, style: s.labelStyle === 'standard' ? 'stacked' : 'card', pad: H < 15 ? 0.5 : 1 });
  const extras = [];
  if (s.showDiscountPrice) extras.push('offer_price');
  if (s.showExpiryBatch) extras.push('batch_no', 'expiry_date');
  // Per-batch fields go in a slim row above the barcode, hidden when not typed.
  extras.forEach((field, i) => {
    const bc = elements.find((e) => e.type === 'barcode');
    const y = bc ? Math.max(0, bc.y - 2.2) : H - 2.4;
    elements.push({
      ...createElement('field', { field, labelW: W, labelH: H }),
      x: r2(1 + i * ((W - 2) / extras.length)), y: r2(y), w: r2((W - 2) / extras.length), h: 2,
      prefix: field === 'offer_price' ? 'Offer ' : field === 'batch_no' ? 'B# ' : 'Exp ',
      style: defaultTextStyle({ fontSizePt: 5 }),
    });
  });
  if (s.barcodeType === 'QRCODE') {
    const i = elements.findIndex((e) => e.type === 'barcode');
    if (i >= 0) {
      const bc = elements[i];
      const side = Math.min(bc.h, bc.w);
      elements[i] = { ...createElement('qr', { labelW: W, labelH: H }), x: r2(bc.x + (bc.w - side) / 2), y: bc.y, w: side, h: side };
    }
  }
  return {
    name, printer_type: printerType, width_mm: W, height_mm: H,
    layout: {
      schema: 1, paddingMm: 1, gapMm, defaultBarcodeFormat: legacyFormat(s.barcodeType), elements,
      ...(printerType === 'a4' ? { sheet: { ...DEFAULT_SHEET, ...sheet } } : {}),
    },
  };
}

// Returns [] when there is nothing to import (fresh browser).
export function convertLegacySettings(settings, customLayouts = []) {
  if (!settings && !customLayouts.length) return [];
  const s = { showBusinessName: true, showProductName: true, showBarcodeText: true, showPrice: true, showColour: true, showSize: true, ...(settings || {}) };
  const out = [];
  if (settings) {
    const isA4 = s.printerType === 'a4';
    let dims = null;
    if (String(s.sizeId).startsWith('tpl:') || s.sizeId === 'custom') {
      const c = isA4 ? s.customA4 || {} : s.customThermal || {};
      dims = isA4
        ? [num(c.widthMm, 63.5), num(c.heightMm, 33.9), { cols: num(c.cols, 3), rows: num(c.rows, 8), marginTopMm: num(c.marginTopMm, 10), marginLeftMm: num(c.marginLeftMm, 7), colGapMm: num(c.colGapMm, 2.5), rowGapMm: num(c.rowGapMm, 0) }]
        : [num(c.widthMm, 38), num(c.heightMm, 25), null, num(c.gapMm, 0)];
    } else {
      dims = isA4 ? LEGACY_A4[s.sizeId] || LEGACY_A4.a4_24up : [...(LEGACY_THERMAL[s.sizeId] || [38, 25])];
    }
    const [W, H, sheet, gap] = dims;
    out.push({ ...legacyTemplate('My Saved Label Design', isA4 ? 'a4' : 'thermal', W, H, s, sheet || {}, gap || 0), make_default: true });
  }
  for (const t of customLayouts) {
    const isA4 = t.printerType === 'a4';
    const d = t.dims || {};
    const W = num(d.widthMm, isA4 ? 63.5 : 38);
    const H = num(d.heightMm, isA4 ? 33.9 : 25);
    const sheet = isA4 ? { cols: num(d.cols, 3), rows: num(d.rows, 8), marginTopMm: num(d.marginTopMm, 10), marginLeftMm: num(d.marginLeftMm, 7), colGapMm: num(d.colGapMm, 2.5), rowGapMm: num(d.rowGapMm, 0) } : {};
    out.push(legacyTemplate(String(t.name || 'Saved layout').slice(0, 100), isA4 ? 'a4' : 'thermal', W, H, s, sheet, isA4 ? 0 : num(d.gapMm, 0)));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Print-job arithmetic
// ---------------------------------------------------------------------------
export function jobTotals(rows) {
  const active = rows.filter((r) => !r.skipReason && (parseInt(r.qty, 10) || 0) > 0);
  const products = new Set(active.map((r) => r.variantGroup || r.key));
  return {
    labels: active.reduce((s, r) => s + (parseInt(r.qty, 10) || 0), 0),
    lines: active.length,
    products: products.size,
    variants: active.filter((r) => r.variantGroup).length,
    skipped: rows.filter((r) => r.skipReason).length,
  };
}

export function a4SheetCount(labelCount, template, startSkip = 0) {
  const per = sheetUsage(template).perSheet || 1;
  return Math.ceil((labelCount + startSkip) / per);
}
