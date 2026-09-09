import axios from 'axios';
import JsBarcode from 'jsbarcode';
import QRCode from 'qrcode';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Resolves `qty` distinct barcodes for one product. The first is always the
// product's own barcode; the rest come from a persisted EAN-13 series on the
// backend (ProductBarcode) so no two printed labels carry the same code, yet
// every code still scans back to this product. Falls back to repeating the
// primary barcode for local-only products (no backend UUID) or on any error.
async function resolveLabelSeries(product, qty) {
  const primary = product?.barcode || '';
  if (qty <= 1 || !UUID_RE.test(String(product?.id || ''))) {
    return Array(Math.max(0, qty)).fill(primary);
  }
  try {
    const res = await axios.post(
      `/api/products/items/${product.id}/label_barcode_series/`,
      { count: qty }
    );
    const codes = Array.isArray(res.data?.barcodes) ? res.data.barcodes : [];
    if (codes.length >= qty) return codes.slice(0, qty);
    return [...codes, ...Array(qty - codes.length).fill(primary)];
  } catch (e) {
    return Array(qty).fill(primary);
  }
}

// Thermal roll = ONE label across the roll, each label its own physical print
// page (see buildThermalLabelCss / printThermalLabels). `cols` is always 1 —
// there is no "labels across" for a thermal roll. `gapMm` is the die-cut liner
// gap between labels on gap/mark media; it is added to the @page height so the
// printer's gap sensor lands on the next label, never an A4 canvas.
export const THERMAL_SIZES = [
  { id: 'roll_38x25', label: '38 × 25 mm', widthMm: 38, heightMm: 25, cols: 1, gapMm: 0 },
  { id: 'roll_40x30', label: '40 × 30 mm', widthMm: 40, heightMm: 30, cols: 1, gapMm: 0 },
  { id: 'roll_50x25', label: '50 × 25 mm', widthMm: 50, heightMm: 25, cols: 1, gapMm: 0 },
  { id: 'roll_50x30', label: '50 × 30 mm', widthMm: 50, heightMm: 30, cols: 1, gapMm: 0 },
  { id: 'roll_60x40', label: '60 × 40 mm', widthMm: 60, heightMm: 40, cols: 1, gapMm: 0 },
  // Jewellery "rat-tail" tags (the physical tag the shop uses). Three sections
  // in strip order: [ barcode panel ][ price + product details panel ][ blank
  // tail ] — printed borderless as one continuous strip. The two printed panels
  // fold back-to-back at the crease between them; the blank tail threads through
  // the ring / chain / spectacle hinge. `tailMm` = blank tail, `scanMm` = barcode
  // panel; the rest of the width is the details panel.
  { id: 'roll_rattail_54x13', label: 'Jewellery Rat-Tail Tag 90 x 13mm (barcode + details + blank tail)', widthMm: 90, heightMm: 13, cols: 1, gapMm: 0, tag: 'rattail', tailMm: 40, scanMm: 22 },
  { id: 'roll_rattail_75x10', label: 'Jewellery Rat-Tail Tag 75 x 12mm (shorter tail)', widthMm: 75, heightMm: 12, cols: 1, gapMm: 0, tag: 'rattail', tailMm: 30, scanMm: 20 },
  { id: 'custom', label: 'Custom roll size…', custom: true },
];

export const A4_SHEET_LAYOUTS = [
  { id: 'a4_24up', label: 'A4 - 24 Labels/Sheet (63.5 x 33.9mm)', cols: 3, rows: 8, widthMm: 63.5, heightMm: 33.9, marginTopMm: 10.7, marginLeftMm: 7.2, colGapMm: 2.5, rowGapMm: 0 },
  { id: 'a4_65up', label: 'A4 - 65 Labels/Sheet (38.1 x 21.2mm)', cols: 5, rows: 13, widthMm: 38.1, heightMm: 21.2, marginTopMm: 10.7, marginLeftMm: 4.8, colGapMm: 2.5, rowGapMm: 0 },
  { id: 'a4_80up', label: 'A4 - 80 Labels/Sheet (~48.5 x 13.5mm, verify against your sheet)', cols: 4, rows: 20, widthMm: 48.5, heightMm: 13.5, marginTopMm: 12.5, marginLeftMm: 6.5, colGapMm: 2, rowGapMm: 0 },
  // Jewellery / optical "dumbbell" tags: two printable wings joined by a narrow
  // centre tie-bridge. The bridge is the non-adhesive (partial-gum) zone that
  // wraps around a ring, chain or spectacle temple; the gummed wings fold back
  // and stick to each other, never to the item. Barcode on one wing, price on
  // the other so both faces stay readable once folded.
  { id: 'a4_jewellery_38up', label: 'A4 - Jewellery / Optical Tags 38/Sheet (dumbbell 92 x 14.5mm)', cols: 2, rows: 19, widthMm: 92, heightMm: 14.5, marginTopMm: 10, marginLeftMm: 12, colGapMm: 6, rowGapMm: 0, tag: 'jewellery' },
  // Rat-tail jewellery tags on an A4 carrier sheet: barcode panel + price /
  // details panel + blank tail (see the thermal rat-tail entries above). Tuned
  // to fill the full A4 sheet — 2 columns x 21 rows, near-edge margins.
  { id: 'a4_rattail_38up', label: 'A4 - Jewellery Rat-Tail Tags 42/Sheet (97 x 13mm, fills the sheet)', cols: 2, rows: 21, widthMm: 97, heightMm: 13, marginTopMm: 9, marginLeftMm: 6, colGapMm: 4, rowGapMm: 0, tag: 'rattail', tailMm: 44, scanMm: 24 },
  { id: 'custom', label: 'Custom sheet layout…', custom: true },
];

// Default dimensions (mm) seeded into the "Custom" size editor the first time
// it's opened — the fields for each are shown in BarcodePrintDialog.
export const CUSTOM_THERMAL_DEFAULTS = { widthMm: 38, heightMm: 25, gapMm: 0 };

// Presets surfaced in the Thermal Roll size picker (plus a "Custom roll size…"
// entry the dialog appends). Kept in sync with the first entries of THERMAL_SIZES.
export const THERMAL_PRESETS = THERMAL_SIZES.filter((s) => !s.custom && !s.tag);
export const CUSTOM_A4_DEFAULTS = {
  widthMm: 63.5, heightMm: 33.9, cols: 3, rows: 8,
  marginTopMm: 10, marginLeftMm: 7, colGapMm: 2.5, rowGapMm: 0,
};

// Turns the user's typed custom dimensions into a full layout object shaped like
// the preset entries, coercing every field to a sane number so the mm-arithmetic
// in buildStyleBlock never sees a string or a non-positive size.
export function buildCustomLayout(printerType, dims = {}) {
  const pos = (v, d) => {
    const n = parseFloat(v);
    return Number.isFinite(n) && n > 0 ? n : d;
  };
  const nonNeg = (v, d) => {
    const n = parseFloat(v);
    return Number.isFinite(n) && n >= 0 ? n : d;
  };

  if (printerType === 'a4') {
    const d = CUSTOM_A4_DEFAULTS;
    const cols = Math.max(1, Math.round(pos(dims.cols, d.cols)));
    const rows = Math.max(1, Math.round(pos(dims.rows, d.rows)));
    const widthMm = pos(dims.widthMm, d.widthMm);
    const heightMm = pos(dims.heightMm, d.heightMm);
    return {
      id: 'custom', custom: true,
      label: `Custom — ${cols} × ${rows} labels, ${widthMm} × ${heightMm} mm`,
      cols, rows, widthMm, heightMm,
      marginTopMm: nonNeg(dims.marginTopMm, d.marginTopMm),
      marginLeftMm: nonNeg(dims.marginLeftMm, d.marginLeftMm),
      colGapMm: nonNeg(dims.colGapMm, d.colGapMm),
      rowGapMm: nonNeg(dims.rowGapMm, d.rowGapMm),
    };
  }

  const d = CUSTOM_THERMAL_DEFAULTS;
  const widthMm = pos(dims.widthMm, d.widthMm);
  const heightMm = pos(dims.heightMm, d.heightMm);
  return {
    id: 'custom', custom: true,
    label: `Custom — ${widthMm} × ${heightMm} mm`,
    cols: 1, widthMm, heightMm,
    gapMm: nonNeg(dims.gapMm, d.gapMm),
  };
}

// Thermal printer calibration — nudges where the whole label prints on the
// physical stock (to correct a printer that feeds a mm or two off) WITHOUT
// altering the label design itself. Lives at the top level of settings so it
// stays put no matter which roll size / preset is picked.
export const THERMAL_CALIBRATION_DEFAULTS = {
  hOffsetMm: 0,
  vOffsetMm: 0,
  barcodeHeightMm: 0,
};

export function resolveThermalCalibration(settings = {}) {
  const num = (v, d = 0) => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : d;
  };
  return {
    hOffsetMm: num(settings.thermalHOffsetMm),
    vOffsetMm: num(settings.thermalVOffsetMm),
    barcodeHeightMm: Math.max(0, num(settings.thermalBarcodeHeightMm)),
  };
}

// Single entry point the dialog and the print job both use to get the active
// layout: a preset from the lists, a saved template ('tpl:<id>'), or a
// synthesised custom one. Templates and 'custom' both resolve from the typed
// dimensions in settings.customA4 / settings.customThermal — picking a template
// in the dialog just loads its saved dimensions into that bucket.
export function resolveLayout(settings) {
  const sizeId = String(settings?.sizeId || '');
  if (sizeId === 'custom' || sizeId.startsWith('tpl:')) {
    const dims = settings.printerType === 'a4' ? settings.customA4 : settings.customThermal;
    return buildCustomLayout(settings.printerType, dims);
  }
  return getLayout(settings?.printerType, settings?.sizeId);
}

// ---------------------------------------------------------------------------
// Saved custom sheet templates
// ---------------------------------------------------------------------------
// Reusable named snapshots of the "Custom" dimensions, kept in localStorage so
// they persist across sessions and every product's print dialog. Each entry:
//   { id, name, printerType: 'a4' | 'thermal', dims: { ...same keys as
//     CUSTOM_A4_DEFAULTS / CUSTOM_THERMAL_DEFAULTS } }
export const CUSTOM_LAYOUTS_STORAGE_KEY = 'optical_barcode_custom_layouts';

export function loadCustomLayouts() {
  try {
    const arr = JSON.parse(localStorage.getItem(CUSTOM_LAYOUTS_STORAGE_KEY) || '[]');
    return Array.isArray(arr)
      ? arr.filter((t) => t && t.id && t.name && t.dims)
      : [];
  } catch {
    return [];
  }
}

export function saveCustomLayout(template) {
  const list = loadCustomLayouts();
  const idx = list.findIndex((t) => t.id === template.id);
  if (idx >= 0) list[idx] = template;
  else list.push(template);
  try {
    localStorage.setItem(CUSTOM_LAYOUTS_STORAGE_KEY, JSON.stringify(list));
  } catch {}
  return list;
}

export function deleteCustomLayout(id) {
  const list = loadCustomLayouts().filter((t) => t.id !== id);
  try {
    localStorage.setItem(CUSTOM_LAYOUTS_STORAGE_KEY, JSON.stringify(list));
  } catch {}
  return list;
}

// How many label slots to leave blank before the first real barcode, so a
// print run can resume on a partially-used sheet. Off unless the user turns on
// `startPositionEnabled`. For A4 the user picks a start row + column; for a
// thermal roll they give a flat count.
export function getStartSkip(layout, settings, printerType) {
  if (!settings?.startPositionEnabled) return 0;
  if (printerType === 'a4') {
    const cols = Math.max(1, layout?.cols || 1);
    const rows = Math.max(1, layout?.rows || 1);
    const r = Math.min(Math.max(1, parseInt(settings?.startRow, 10) || 1), rows);
    const c = Math.min(Math.max(1, parseInt(settings?.startCol, 10) || 1), cols);
    return (r - 1) * cols + (c - 1);
  }
  return Math.max(0, parseInt(settings?.skipLabels, 10) || 0);
}

export const BARCODE_TYPES = [
  { id: 'CODE128', label: 'Code 128', hint: 'Any letters, digits or symbols — works with every barcode value.' },
  { id: 'CODE39', label: 'Code 39', hint: 'Uppercase A–Z, digits and - . $ / + % and space.' },
  { id: 'EAN13', label: 'EAN-13', hint: 'Numbers only — exactly 12 or 13 digits.' },
  { id: 'EAN8', label: 'EAN-8', hint: 'Numbers only — exactly 7 or 8 digits.' },
  { id: 'UPC', label: 'UPC-A', hint: 'Numbers only — exactly 11 or 12 digits.' },
  { id: 'UPCE', label: 'UPC-E', hint: 'Numbers only — exactly 6, 7 or 8 digits.' },
  { id: 'QRCODE', label: 'QR Code', hint: 'Any text.' },
];

export function getBarcodeTypeHint(id) {
  const found = BARCODE_TYPES.find((t) => t.id === id);
  return found ? found.hint || '' : '';
}

// Quick client-side check of whether `value` can be encoded as `barcodeType`,
// mirroring JsBarcode's own rules. Used to warn (and block the Print button)
// before the user sends a batch of un-scannable "Invalid value" labels to the
// printer. `null` = fine, otherwise a short human-readable reason.
export function barcodeValueProblem(barcodeType, value) {
  const v = String(value ?? '').trim();
  if (!v) return 'No barcode value.';
  const digits = /^\d+$/.test(v);
  switch (barcodeType) {
    case 'EAN13':
      if (!digits || (v.length !== 12 && v.length !== 13)) return 'EAN-13 needs exactly 12 or 13 digits.';
      break;
    case 'EAN8':
      if (!digits || (v.length !== 7 && v.length !== 8)) return 'EAN-8 needs exactly 7 or 8 digits.';
      break;
    case 'UPC':
      if (!digits || (v.length !== 11 && v.length !== 12)) return 'UPC-A needs exactly 11 or 12 digits.';
      break;
    case 'UPCE':
      if (!digits || v.length < 6 || v.length > 8) return 'UPC-E needs 6 to 8 digits.';
      break;
    case 'CODE39':
      if (!/^[0-9A-Z\-. $/+%]+$/.test(v)) return 'Code 39 allows only A–Z, 0–9 and - . $ / + % space.';
      break;
    default:
      break;
  }
  return null;
}

export const LABEL_STYLES = [
  { id: 'jewel', label: 'Jewellery Card (sectioned)' },
  { id: 'standard', label: 'Standard (stacked)' },
];

// User-selectable barcode symbol size. `scale` multiplies the printed height of
// the barcode / QR image on every label style (taller bars scan more reliably;
// smaller frees room for text on tiny tags). Applied as a CSS override appended
// after the base label CSS in buildStyleBlock.
export const BARCODE_SIZES = [
  { id: 'S', label: 'Small', scale: 0.8 },
  { id: 'M', label: 'Medium (default)', scale: 1 },
  { id: 'L', label: 'Large', scale: 1.25 },
  { id: 'XL', label: 'Extra Large', scale: 1.55 },
];

// The custom ("+") option lets the user type an exact percentage instead of
// picking a preset. Clamped so the symbol can't collapse to nothing or blow far
// past the label box.
export const BARCODE_CUSTOM_MIN = 40;
export const BARCODE_CUSTOM_MAX = 300;

export function clampBarcodeCustomPercent(value) {
  const n = parseFloat(value);
  if (!Number.isFinite(n)) return 100;
  return Math.min(BARCODE_CUSTOM_MAX, Math.max(BARCODE_CUSTOM_MIN, n));
}

// Resolves the height multiplier for the barcode symbol. `sizeId` is a preset id
// ('S'/'M'/'L'/'XL') or 'custom', in which case `customPercent` (a number like
// 130 = 130%) is used instead.
export function getBarcodeScale(sizeId, customPercent) {
  if (sizeId === 'custom') {
    return clampBarcodeCustomPercent(customPercent) / 100;
  }
  const found = BARCODE_SIZES.find((s) => s.id === sizeId);
  return found ? found.scale : 1;
}

// CSS that resizes the rendered barcode/QR SVG for each label renderer. Emitted
// last in the style block so it overrides the per-renderer defaults by source
// order. Width stays auto / clamped to the label so the symbol never overflows
// the (overflow:hidden) label box.
function barcodeSizeOverrideCss(scale) {
  if (!scale || Math.abs(scale - 1) < 0.001) return '';
  const mm = (base) => `${(base * scale).toFixed(2)}mm`;
  return `
    .lbl-symbol svg { height: ${mm(11)}; width: auto; max-width: 100%; }
    .jc-symbol svg { height: ${mm(8)}; width: auto; max-width: 100%; }
    .jtag-symbol svg { height: ${mm(6.5)}; width: auto; max-width: 100%; }
    .rt-symbol svg { height: ${mm(9)}; max-width: 100%; }
  `;
}

export function getLayout(printerType, sizeId) {
  const list = printerType === 'a4' ? A4_SHEET_LAYOUTS : THERMAL_SIZES;
  return list.find((l) => l.id === sizeId) || list[0];
}

// Product objects reach the print pipeline in a few shapes (Products page row,
// serializer payload, BarcodeSection preview stub). Read a field from any of
// its likely keys and return '' when genuinely absent so the label layout
// never renders an empty "COLOUR:" row.
export function productField(product, ...keys) {
  if (!product) return '';
  for (const key of keys) {
    const val = product[key];
    if (val !== undefined && val !== null && String(val).trim() !== '') {
      return String(val).trim();
    }
  }
  return '';
}

export function labelPrice(product) {
  return parseFloat(product?.sellingPrice ?? product?.selling_price ?? product?.retail_price ?? product?.price ?? 0) || 0;
}

export function formatPrice(value) {
  return `₹${Number(value || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function resolveQuantity(product, settings) {
  if (settings.quantityMode === 'stock') {
    return Math.max(0, parseInt(product?.stock, 10) || 0);
  }
  return Math.max(1, parseInt(settings.customQuantity, 10) || 1);
}

export function getTotalLabelCount(products, settings) {
  return (products || [])
    .filter((p) => p && p.barcode)
    .reduce((sum, p) => sum + resolveQuantity(p, settings), 0);
}

export function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

let sandboxEl = null;
function getSandbox() {
  if (!sandboxEl || !document.body.contains(sandboxEl)) {
    sandboxEl = document.createElement('div');
    sandboxEl.style.position = 'absolute';
    sandboxEl.style.left = '-99999px';
    sandboxEl.style.top = '-99999px';
    sandboxEl.setAttribute('aria-hidden', 'true');
    document.body.appendChild(sandboxEl);
  }
  return sandboxEl;
}

// Renders one barcode/QR value to inline SVG markup. Never throws — invalid
// values (e.g. a non-numeric SKU selected as EAN-13) resolve to { error }
// so a single bad label can't abort an entire batch print job.
export async function renderBarcodeMarkup(barcodeType, value) {
  const safeValue = String(value ?? '').trim();
  if (!safeValue) {
    return { markup: '', error: 'Empty barcode value' };
  }

  if (barcodeType === 'QRCODE') {
    try {
      const svg = await QRCode.toString(safeValue, { type: 'svg', margin: 0, width: 90 });
      return { markup: svg, error: null };
    } catch (e) {
      return { markup: '', error: 'Invalid value for QR Code' };
    }
  }

  const preCheck = barcodeValueProblem(barcodeType, safeValue);
  if (preCheck) {
    return { markup: '', error: preCheck };
  }

  const box = getSandbox();
  const svgEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  box.appendChild(svgEl);
  try {
    JsBarcode(svgEl, safeValue, {
      format: barcodeType,
      displayValue: false,
      margin: 0,
      height: 40,
    });
    const markup = new XMLSerializer().serializeToString(svgEl);
    return { markup, error: null };
  } catch (e) {
    return { markup: '', error: `This barcode value can't be printed as ${barcodeType}.` };
  } finally {
    box.removeChild(svgEl);
  }
}

// Colour / Size / Product Code — the jewellery-tag variant attributes. Each row
// is emitted only when the field actually has a value, so an item with no colour
// or size never leaves a dangling "COLOUR:" label on the printed tag.
function variantRows(product, settings, rowClass) {
  const rows = [];
  const colour = productField(product, 'colour', 'color');
  const size = productField(product, 'size');
  const code = productField(product, 'code', 'product_code', 'sku');
  if (settings.showColour && colour) {
    rows.push(`<div class="${rowClass}"><b>COLOUR</b> ${escapeHtml(colour)}</div>`);
  }
  if (settings.showSize && size) {
    rows.push(`<div class="${rowClass}"><b>SIZE</b> ${escapeHtml(size)}</div>`);
  }
  if (settings.showProductCode && code) {
    rows.push(`<div class="${rowClass}"><b>CODE</b> ${escapeHtml(code)}</div>`);
  }
  return rows;
}

// Jewellery / optical dumbbell tag: [ scan wing ][ tie bridge ][ info wing ].
// Fold at the bridge and the two adhesive wings meet back-to-back around the
// item, leaving the barcode readable on one side and the price on the other.
function buildJewelleryTagHtml(product, settings, businessName, symbolMarkup, symbolError) {
  const price = labelPrice(product);

  const scanParts = [];
  if (symbolError) {
    scanParts.push(`<div class="lbl-error">&#9888; ${escapeHtml(symbolError)}</div>`);
  } else {
    scanParts.push(`<div class="jtag-symbol">${symbolMarkup || ''}</div>`);
    if (settings.showBarcodeText) {
      scanParts.push(`<div class="jtag-code">${escapeHtml(product?.barcode || '')}</div>`);
    }
  }

  const infoParts = [];
  if (settings.showBusinessName && businessName) {
    infoParts.push(`<div class="jtag-shop">${escapeHtml(businessName)}</div>`);
  }
  if (settings.showProductName) {
    infoParts.push(`<div class="jtag-name">${escapeHtml(product?.name || '')}</div>`);
  }
  if (settings.showPrice) {
    infoParts.push(`<div class="jtag-price">&#8377;${price.toFixed(2)}</div>`);
  }
  if (settings.showDiscountPrice && settings.discountPriceValue) {
    infoParts.push(`<div class="jtag-offer">Offer &#8377;${escapeHtml(settings.discountPriceValue)}</div>`);
  }
  infoParts.push(...variantRows(product, settings, 'jtag-attr'));
  if (settings.showExpiryBatch && (settings.expiryDate || settings.batchNo)) {
    const bits = [];
    if (settings.expiryDate) bits.push(`Exp ${escapeHtml(settings.expiryDate)}`);
    if (settings.batchNo) bits.push(`B# ${escapeHtml(settings.batchNo)}`);
    infoParts.push(`<div class="jtag-meta">${bits.join(' | ')}</div>`);
  }
  if (infoParts.length === 0) {
    infoParts.push(`<div class="jtag-code">${escapeHtml(product?.barcode || '')}</div>`);
  }

  return (
    `<div class="label jlabel"><div class="jtag">` +
    `<div class="jtag-panel jtag-panel--scan">${scanParts.join('')}</div>` +
    `<div class="jtag-bridge"><span>TIE &#183; NON-ADHESIVE</span></div>` +
    `<div class="jtag-panel jtag-panel--info">${infoParts.join('')}</div>` +
    `</div></div>`
  );
}

// Sectioned jewellery-style card: an upper DETAILS block (name + PRICE / COLOUR /
// SIZE / CODE key-value rows) sitting over a lower SCAN block (barcode image with
// its human-readable number beneath). Mirrors a physical jewellery price tag and
// stays readable on small thermal labels. Empty fields are skipped entirely.
function buildJewelCardHtml(product, settings, businessName, symbolMarkup, symbolError) {
  const detail = [];
  if (settings.showBusinessName && businessName) {
    detail.push(`<div class="jc-shop">${escapeHtml(businessName)}</div>`);
  }
  if (settings.showProductName && productField(product, 'name')) {
    detail.push(`<div class="jc-name">${escapeHtml(productField(product, 'name'))}</div>`);
  }
  if (settings.showPrice) {
    detail.push(`<div class="jc-price"><b>PRICE</b> ${formatPrice(labelPrice(product))}</div>`);
  }
  if (settings.showDiscountPrice && settings.discountPriceValue) {
    detail.push(`<div class="jc-offer"><b>OFFER</b> &#8377;${escapeHtml(settings.discountPriceValue)}</div>`);
  }
  detail.push(...variantRows(product, settings, 'jc-attr'));
  if (settings.showExpiryBatch && (settings.expiryDate || settings.batchNo)) {
    const bits = [];
    if (settings.expiryDate) bits.push(`Exp ${escapeHtml(settings.expiryDate)}`);
    if (settings.batchNo) bits.push(`B# ${escapeHtml(settings.batchNo)}`);
    detail.push(`<div class="jc-attr">${bits.join(' &#183; ')}</div>`);
  }

  const scan = [];
  if (symbolError) {
    scan.push(`<div class="lbl-error">&#9888; ${escapeHtml(symbolError)}</div>`);
  } else {
    scan.push(`<div class="jc-symbol">${symbolMarkup || ''}</div>`);
    if (settings.showBarcodeText && product?.barcode) {
      scan.push(`<div class="jc-code">${escapeHtml(product.barcode)}</div>`);
    }
  }

  return (
    `<div class="label jcard">` +
    `<div class="jc-detail">${detail.join('')}</div>` +
    `<div class="jc-scan">${scan.join('')}</div>` +
    `</div>`
  );
}

// Jewellery "rat-tail" tag — three sections in strip order, printed borderless
// as one continuous strip:
//   [ barcode panel ][ price + product details panel ][ blank tail ]
// Matches the physical tag the shop uses. The barcode panel and the details
// panel fold back-to-back at the crease between them; the blank tail threads
// through the ring / chain / spectacle hinge.
function buildRatTailTagHtml(product, settings, businessName, symbolMarkup, symbolError) {
  const info = [];
  if (settings.showBusinessName && businessName) {
    info.push(`<div class="rt-shop">${escapeHtml(businessName)}</div>`);
  }
  if (settings.showProductName && productField(product, 'name')) {
    info.push(`<div class="rt-name">${escapeHtml(productField(product, 'name'))}</div>`);
  }
  if (settings.showPrice) {
    info.push(`<div class="rt-price"><b>PRICE</b> ${formatPrice(labelPrice(product))}</div>`);
  }
  if (settings.showDiscountPrice && settings.discountPriceValue) {
    info.push(`<div class="rt-attr"><b>OFFER</b> &#8377;${escapeHtml(settings.discountPriceValue)}</div>`);
  }
  info.push(...variantRows(product, settings, 'rt-attr'));
  if (settings.showExpiryBatch && (settings.expiryDate || settings.batchNo)) {
    const bits = [];
    if (settings.expiryDate) bits.push(`Exp ${escapeHtml(settings.expiryDate)}`);
    if (settings.batchNo) bits.push(`B# ${escapeHtml(settings.batchNo)}`);
    info.push(`<div class="rt-attr">${bits.join(' &#183; ')}</div>`);
  }
  if (settings.showBarcodeText && product?.barcode) {
    info.push(`<div class="rt-code">${escapeHtml(product.barcode)}</div>`);
  }
  if (info.length === 0 && product?.barcode) {
    info.push(`<div class="rt-code">${escapeHtml(product.barcode)}</div>`);
  }

  const scan = symbolError
    ? `<div class="lbl-error">&#9888; ${escapeHtml(symbolError)}</div>`
    : `<div class="rt-symbol">${symbolMarkup || ''}</div>`;

  return (
    `<div class="label rtlabel"><div class="rttag">` +
    `<div class="rt-panel rt-panel--scan">${scan}</div>` +
    `<div class="rt-panel rt-panel--info"><div class="rt-rot">${info.join('')}</div></div>` +
    `<div class="rt-tail"></div>` +
    `</div></div>`
  );
}

export function buildLabelInnerHtml(product, settings, businessName, symbolMarkup, symbolError, layout) {
  if (layout && layout.tag === 'jewellery') {
    return buildJewelleryTagHtml(product, settings, businessName, symbolMarkup, symbolError);
  }
  if (layout && layout.tag === 'rattail') {
    return buildRatTailTagHtml(product, settings, businessName, symbolMarkup, symbolError);
  }
  if ((settings.labelStyle || 'jewel') === 'jewel') {
    return buildJewelCardHtml(product, settings, businessName, symbolMarkup, symbolError);
  }

  const parts = [];

  if (settings.showBusinessName && businessName) {
    parts.push(`<div class="lbl-business">${escapeHtml(businessName)}</div>`);
  }
  if (settings.showProductName) {
    parts.push(`<div class="lbl-name">${escapeHtml(product?.name || '')}</div>`);
  }
  if (symbolError) {
    parts.push(`<div class="lbl-error">&#9888; ${escapeHtml(symbolError)}</div>`);
  } else {
    parts.push(`<div class="lbl-symbol">${symbolMarkup || ''}</div>`);
  }
  if (settings.showBarcodeText) {
    parts.push(`<div class="lbl-code">${escapeHtml(product?.barcode || '')}</div>`);
  }
  if (settings.showPrice) {
    parts.push(`<div class="lbl-price">MRP: &#8377;${labelPrice(product).toFixed(2)}</div>`);
  }
  if (settings.showDiscountPrice && settings.discountPriceValue) {
    parts.push(`<div class="lbl-discount">Offer: &#8377;${escapeHtml(settings.discountPriceValue)}</div>`);
  }
  variantRows(product, settings, 'lbl-attr').forEach((r) => parts.push(r));
  if (settings.showExpiryBatch && (settings.expiryDate || settings.batchNo)) {
    const bits = [];
    if (settings.expiryDate) bits.push(`Exp: ${escapeHtml(settings.expiryDate)}`);
    if (settings.batchNo) bits.push(`Batch: ${escapeHtml(settings.batchNo)}`);
    parts.push(`<div class="lbl-expiry">${bits.join(' | ')}</div>`);
  }

  return `<div class="label">${parts.join('')}</div>`;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

const LABEL_BASE_CSS = `
  * { box-sizing: border-box; }
  body { margin: 0; padding: 0; font-family: Arial, Helvetica, sans-serif; }
  .label {
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    overflow: hidden; text-align: center; padding: 1mm;
    border: 0.2mm dashed #ccc;
  }
  .lbl-business, .lbl-name {
    font-size: 2.6mm; font-weight: 700; line-height: 1.15;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%;
  }
  .lbl-symbol { display: flex; justify-content: center; align-items: center; width: 100%; }
  .lbl-symbol svg { max-width: 92%; }
  .lbl-code { font-size: 2.3mm; letter-spacing: 0.3px; }
  .lbl-price { font-size: 2.6mm; font-weight: 700; }
  .lbl-discount { font-size: 2.3mm; font-weight: 700; color: #b91c1c; }
  .lbl-attr { font-size: 2mm; letter-spacing: 0.1px; }
  .lbl-attr b { font-weight: 800; }
  .lbl-expiry { font-size: 2mm; color: #475569; }
  .lbl-error { font-size: 2.1mm; color: #b91c1c; padding: 1mm; }
  /* Spacer cells that hold the grid/row position on a partially-used sheet —
     take up a label slot but print nothing. */
  .label.label--blank { border-color: transparent !important; }
`;

// Sectioned jewellery price-tag card. Pure black-on-white, no fills, tight
// spacing so it holds up on 25mm thermal stock and prints cleanly in mono.
const JEWEL_CARD_CSS = `
  .label.jcard {
    flex-direction: column; align-items: stretch; justify-content: space-between;
    text-align: left; padding: 1mm 1.4mm; border: 0.2mm solid #000;
  }
  .jc-detail { display: flex; flex-direction: column; gap: 0.4mm; min-height: 0; overflow: hidden; }
  .jc-shop {
    font-size: 1.8mm; font-weight: 800; text-transform: uppercase; letter-spacing: 0.2px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    border-bottom: 0.2mm solid #000; padding-bottom: 0.3mm; margin-bottom: 0.3mm;
  }
  .jc-name {
    font-size: 2.3mm; font-weight: 800; line-height: 1.05;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  }
  .jc-price { font-size: 2.5mm; font-weight: 800; }
  .jc-offer { font-size: 2mm; font-weight: 700; }
  .jc-attr { font-size: 1.9mm; line-height: 1.1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .jc-price b, .jc-offer b, .jc-attr b { font-weight: 800; letter-spacing: 0.2px; }
  .jc-scan {
    display: flex; flex-direction: column; align-items: center; justify-content: flex-end;
    width: 100%; border-top: 0.2mm solid #000; padding-top: 0.5mm; margin-top: 0.5mm;
  }
  .jc-symbol { width: 100%; display: flex; justify-content: center; }
  .jc-symbol svg { max-width: 100%; height: 8mm; }
  .jc-code { font-size: 2.2mm; font-weight: 700; letter-spacing: 0.5px; }
`;

const JEWELLERY_TAG_CSS = `
  .label.jlabel { padding: 0; border: none; display: block; }
  .jtag {
    display: flex; flex-direction: row; align-items: stretch;
    width: 100%; height: 100%; overflow: hidden;
    border: 0.2mm dashed #d0d0d0;
  }
  .jtag-panel {
    flex: 1 1 41%; min-width: 0;
    display: flex; flex-direction: column;
    align-items: center; justify-content: center;
    text-align: center; padding: 0.3mm 1mm; overflow: hidden;
  }
  .jtag-panel--info { align-items: flex-start; text-align: left; }
  .jtag-symbol { width: 100%; display: flex; justify-content: center; }
  .jtag-symbol svg { max-width: 100%; height: 6.5mm; }
  .jtag-code { font-size: 1.9mm; letter-spacing: 0.2px; }
  .jtag-shop {
    font-size: 1.7mm; font-weight: 700; max-width: 100%;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .jtag-name {
    font-size: 2mm; font-weight: 700; line-height: 1.05; max-width: 100%;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  }
  .jtag-price { font-size: 2.4mm; font-weight: 800; }
  .jtag-offer { font-size: 1.9mm; font-weight: 700; color: #b91c1c; }
  .jtag-attr { font-size: 1.7mm; line-height: 1.15; max-width: 100%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .jtag-attr b { font-weight: 800; }
  .jtag-meta { font-size: 1.6mm; color: #475569; }
  .jtag-bridge {
    flex: 0 0 18%;
    border-left: 0.3mm dashed #9aa3af;
    border-right: 0.3mm dashed #9aa3af;
    display: flex; align-items: center; justify-content: center;
  }
  .jtag-bridge span {
    font-size: 1.3mm; color: #b0b7c3; letter-spacing: 0.2px;
    transform: rotate(-90deg); white-space: nowrap;
  }
`;

// Rat-tail jewellery tag: [ barcode panel ][ price + details panel ][ blank tail ].
// Borderless — one clean continuous strip. `tailMm` = blank tail, `scanMm` =
// barcode panel; the details panel takes the rest.
function ratTailCss(layout) {
  const heightMm = (layout && layout.heightMm) || 13;
  const tailMm = layout && layout.tailMm ? layout.tailMm : 40;
  const scanMm = layout && layout.scanMm ? layout.scanMm : 22;
  return `
    .label.rtlabel { padding: 0; border: none; display: block; }
    .rttag {
      display: flex; flex-direction: row; align-items: stretch;
      width: 100%; height: 100%; overflow: hidden;
    }
    .rt-panel {
      min-width: 0; height: 100%; overflow: hidden;
      display: flex; flex-direction: column; justify-content: center;
      padding: 0.3mm 1mm;
    }
    .rt-panel--scan { flex: 0 0 ${scanMm}mm; align-items: center; padding: 0.3mm 0.6mm; }
    .rt-panel--info { flex: 1 1 auto; align-items: flex-start; }
    .rt-tail { flex: 0 0 ${tailMm}mm; height: 100%; }
    /* Price + product details — left-aligned rows, vertically centred, sized to
       sit inside the strip height without clipping. */
    .rt-rot {
      display: flex; flex-direction: column; align-items: flex-start; justify-content: center;
      gap: 0; max-width: 100%; max-height: 100%; text-align: left; line-height: 1.06;
    }
    .rt-rot > div {
      max-width: 100%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .rt-shop { font-size: 1.4mm; font-weight: 800; text-transform: uppercase; letter-spacing: 0.2px; }
    .rt-name { font-size: 1.5mm; font-weight: 700; }
    .rt-price { font-size: 1.9mm; font-weight: 800; }
    .rt-attr { font-size: 1.5mm; }
    .rt-price b, .rt-attr b { font-weight: 800; letter-spacing: 0.2px; }
    .rt-code { font-size: 1.5mm; font-weight: 700; letter-spacing: 0.3px; }
    /* Barcode panel: bars fill the panel width so they stay long enough to scan. */
    .rt-symbol {
      width: 100%; height: 100%;
      display: flex; align-items: center; justify-content: center;
    }
    .rt-symbol svg { width: 100%; height: ${Math.max(6, heightMm - 2)}mm; max-width: 100%; }
  `;
}

// Pagination is chunked in JS (not left to CSS fragmentation) because CSS
// Grid does not reliably split across @page boundaries in Chromium print.
export function buildStyleBlock(layout, printerType, barcodeScale = 1) {
  const sizeOverride = barcodeSizeOverrideCss(barcodeScale);
  if (printerType === 'a4') {
    const pageWidthMm = layout.cols * layout.widthMm + layout.colGapMm * (layout.cols - 1) + layout.marginLeftMm;
    const pageHeightMm = layout.rows * layout.heightMm + layout.rowGapMm * (layout.rows - 1) + layout.marginTopMm;
    return `
      @page { size: A4 portrait; margin: 0; }
      ${LABEL_BASE_CSS}
      ${JEWEL_CARD_CSS}
      ${layout.tag === 'jewellery' ? JEWELLERY_TAG_CSS : ''}
      ${layout.tag === 'rattail' ? ratTailCss(layout) : ''}
      ${sizeOverride}
      .sheet {
        box-sizing: border-box;
        width: ${Math.max(210, pageWidthMm)}mm;
        height: ${Math.max(297, pageHeightMm)}mm;
        padding-top: ${layout.marginTopMm}mm;
        padding-left: ${layout.marginLeftMm}mm;
        display: grid;
        grid-template-columns: repeat(${layout.cols}, ${layout.widthMm}mm);
        grid-auto-rows: ${layout.heightMm}mm;
        column-gap: ${layout.colGapMm}mm;
        row-gap: ${layout.rowGapMm}mm;
        page-break-after: always;
      }
      .sheet:last-child { page-break-after: auto; }
      .label { width: ${layout.widthMm}mm; height: ${layout.heightMm}mm; }
    `;
  }

  // Thermal Roll — delegated to the dedicated true-label-page builder. No A4
  // canvas, no grid, one label = one physical page.
  return buildThermalLabelCss(layout, { barcodeScale });
}

function trimNum(n) {
  return String(Math.round((Number(n) || 0) * 1000) / 1000);
}

// ---------------------------------------------------------------------------
// THERMAL ROLL print CSS — completely independent of the A4 path.
// ---------------------------------------------------------------------------
// Every label is its own physical print page. The @page box is generated
// dynamically from the label's mm dimensions (never hard-coded, never A4).
// `gapMm` (die-cut liner gap) is added to the @page HEIGHT so the printer's
// gap/black-mark sensor advances to the next label — it does NOT create a
// bigger canvas. Calibration offsets shift the printed content inside the
// label without changing the design.
//
//   width = 38, height = 25  ->  @page { size: 38mm 25mm; margin: 0; }
//
export function buildThermalLabelCss(layout, opts = {}) {
  const {
    barcodeScale = 1,
    calibration = THERMAL_CALIBRATION_DEFAULTS,
    preview = false,
  } = opts;

  const w = Math.max(1, Number(layout.widthMm) || 38);
  const h = Math.max(1, Number(layout.heightMm) || 25);
  const gap = Math.max(0, Number(layout.gapMm) || 0);
  const pageH = h + gap; // liner gap lives in the page, not the label box
  const hOff = Number(calibration.hOffsetMm) || 0;
  const vOff = Number(calibration.vOffsetMm) || 0;
  const barcodeHeightMm = Math.max(0, Number(calibration.barcodeHeightMm) || 0);

  const sizeOverride = barcodeSizeOverrideCss(barcodeScale);
  const barcodeHeightCss = barcodeHeightMm
    ? `.thermal-label .lbl-symbol svg,
       .thermal-label .jc-symbol svg,
       .thermal-label .jtag-symbol svg,
       .thermal-label .rt-symbol svg {
         height: ${trimNum(barcodeHeightMm)}mm !important; width: auto; max-width: 100%;
       }`
    : '';

  return `
    ${preview ? '' : `
      @page { size: ${trimNum(w)}mm ${trimNum(pageH)}mm; margin: 0; }
      html, body { margin: 0; padding: 0; background: #fff; }
      * { box-sizing: border-box; }
    `}
    ${LABEL_BASE_CSS}
    ${JEWEL_CARD_CSS}
    ${layout.tag === 'jewellery' ? JEWELLERY_TAG_CSS : ''}
    ${layout.tag === 'rattail' ? ratTailCss(layout) : ''}
    ${sizeOverride}
    ${barcodeHeightCss}
    .thermal-label {
      width: ${trimNum(w)}mm;
      height: ${trimNum(h)}mm;
      margin: 0;
      padding: 0;
      box-sizing: border-box;
      overflow: hidden;
      position: relative;
      background: #fff;
      page-break-after: always;
      break-after: page;
      page-break-inside: avoid;
      break-inside: avoid;
    }
    /* No trailing blank page after the last label. */
    .thermal-label:last-child { page-break-after: auto; break-after: auto; }
    .thermal-label .tl-shift {
      position: absolute;
      top: ${trimNum(vOff)}mm;
      left: ${trimNum(hOff)}mm;
      width: 100%;
      height: 100%;
    }
    .thermal-label .label {
      width: 100%;
      height: 100%;
      border: ${preview ? '0.2mm dashed #cbd5e1' : '0'};
    }
    /* jcard / jlabel / rtlabel keep their own design borders. */
  `;
}

// Orchestrates a full print job: resolves per-product quantities, renders
// each unique barcode value once, builds paginated label sheets, and opens
// the browser print dialog — following the same window.open/document.write
// pattern as printInvoice.js / printPurchase.js.
export async function printBarcodeLabels(products, settings, businessName) {
  const valid = (products || []).filter((p) => p && p.barcode);
  const skipped = (products || []).filter((p) => !p || !p.barcode);

  if (valid.length === 0) {
    window.alert('No products with a barcode to print.');
    return { printed: 0, skipped };
  }

  const layout = resolveLayout(settings);

  // Manual override (single-product print only): the exact value the user typed
  // in the dialog prints on every label, and the per-label auto series is skipped.
  const manualBarcode = String(settings.customBarcode || '').trim();
  const useManual = manualBarcode !== '' && valid.length === 1;

  // A manually typed barcode must still resolve to this product when it's later
  // scanned at billing, so persist it (as primary if the product has none, else
  // as an extra scan-in code) before printing the tags.
  if (useManual && UUID_RE.test(String(valid[0]?.id || ''))) {
    try {
      await axios.post(`/api/products/items/${valid[0].id}/register_barcode/`, { code: manualBarcode });
    } catch (e) {
      const msg = e?.response?.data?.detail;
      if (e?.response?.status === 409 && msg) {
        window.alert(msg);
        return { printed: 0, skipped };
      }
      // other failures: fall through and still print — worst case the code just
      // won't resolve at POS, which is the pre-existing behaviour anyway.
    }
  }

  const flatEntries = [];
  for (const p of valid) {
    const qty = resolveQuantity(p, settings);
    // eslint-disable-next-line no-await-in-loop
    const codes = useManual ? Array(qty).fill(manualBarcode) : await resolveLabelSeries(p, qty);
    for (let i = 0; i < qty; i++) {
      flatEntries.push({ ...p, barcode: codes[i] || p.barcode });
    }
  }

  if (flatEntries.length === 0) {
    window.alert('Nothing to print — resolved quantity is 0 for every selected product.');
    return { printed: 0, skipped };
  }

  const uniqueValues = [...new Set(flatEntries.map((p) => p.barcode))];
  const symbolCache = new Map();
  for (const val of uniqueValues) {
    symbolCache.set(val, await renderBarcodeMarkup(settings.barcodeType, val));
  }

  // Don't send a batch of un-scannable "invalid value" labels to the printer.
  const failed = uniqueValues.filter((v) => symbolCache.get(v)?.error);
  if (failed.length === uniqueValues.length) {
    const reason = symbolCache.get(uniqueValues[0])?.error || 'the values are not compatible with it';
    window.alert(
      `Can't print with the "${settings.barcodeType}" barcode type — ${reason}\n\n` +
      'Pick a different Barcode Type (Code 128 accepts any value) or fix the product barcode.'
    );
    return { printed: 0, skipped };
  }

  const labelHtmlList = flatEntries.map((p) => {
    const { markup, error } = symbolCache.get(p.barcode) || {};
    return buildLabelInnerHtml(p, settings, businessName, markup, error, layout);
  });

  const barcodeScale = getBarcodeScale(settings.barcodeSize, settings.barcodeCustomScale);

  // ---- THERMAL ROLL: one label = one physical page. No A4 canvas, no grid,
  // no start-position skipping (that is an A4-sheet concept only). --------------
  if (settings.printerType !== 'a4') {
    const css = buildThermalLabelCss(layout, {
      barcodeScale,
      calibration: resolveThermalCalibration(settings),
    });
    const body = labelHtmlList
      .map((inner) => `<div class="thermal-label"><div class="tl-shift">${inner}</div></div>`)
      .join('');
    const ok = openPrintDocument('Barcode Labels', css, body);
    if (!ok) {
      window.alert('Popup blocked — please allow popups for this site to print barcode labels.');
      return { printed: 0, skipped };
    }
    return { printed: flatEntries.length, skipped };
  }

  // ---- A4 SHEET: grid of labels on A4 pages, with optional partial-sheet
  // resume (start row / column). Kept entirely separate from the thermal path.
  const startSkip = getStartSkip(layout, settings, 'a4');
  const paddedHtmlList = startSkip > 0
    ? [...Array(startSkip).fill('<div class="label label--blank"></div>'), ...labelHtmlList]
    : labelHtmlList;

  const perPage = layout.cols * layout.rows;
  const sheetsHtml = chunk(paddedHtmlList, perPage)
    .map((pageLabels) => `<div class="sheet">${pageLabels.join('')}</div>`)
    .join('');

  const ok = openPrintDocument(
    'Barcode Labels',
    buildStyleBlock(layout, 'a4', barcodeScale),
    sheetsHtml
  );
  if (!ok) {
    window.alert('Popup blocked — please allow popups for this site to print barcode labels.');
    return { printed: 0, skipped };
  }

  return { printed: flatEntries.length, skipped };
}

// Opens a detached window, writes a minimal print document and fires the browser
// print dialog. Shared by the real print job, the test label and the feed. The
// @page rule inside `css` is the single source of truth for the paper size —
// nothing here imposes A4.
function openPrintDocument(title, css, bodyHtml) {
  const printWindow = window.open('', '_blank', 'width=720,height=560');
  if (!printWindow) return false;
  printWindow.document.open();
  printWindow.document.write(
    `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>` +
    `<style>${css}</style></head><body>${bodyHtml}</body></html>`
  );
  printWindow.document.close();
  setTimeout(() => {
    try {
      printWindow.focus();
      printWindow.print();
    } catch (e) { /* user can still print from the window */ }
  }, 350);
  return true;
}

// Prints exactly ONE label at the currently selected thermal dimensions — the
// calibration aid. Uses a real product when one is supplied, otherwise a dummy
// so the operator can check registration / offsets without wasting a live tag.
export async function printThermalTestLabel(settings, businessName, product = null) {
  const layout = resolveLayout({ ...settings, printerType: 'thermal' });
  const sample = product && product.barcode
    ? product
    : { name: 'TEST LABEL', barcode: '1234567890128', sellingPrice: 0, colour: 'Black', size: 'M', code: 'TEST' };

  const { markup, error } = await renderBarcodeMarkup(settings.barcodeType, sample.barcode);
  const inner = buildLabelInnerHtml(sample, settings, businessName, markup, error, layout);
  const css = buildThermalLabelCss(layout, {
    barcodeScale: getBarcodeScale(settings.barcodeSize, settings.barcodeCustomScale),
    calibration: resolveThermalCalibration(settings),
  });
  const ok = openPrintDocument(
    'Thermal Test Label',
    css,
    `<div class="thermal-label"><div class="tl-shift">${inner}</div></div>`
  );
  if (!ok) window.alert('Popup blocked — allow popups to print a test label.');
  return ok;
}

// Feeds a single blank label (advances the roll by exactly one label pitch).
export function feedOneThermalLabel(settings) {
  const layout = resolveLayout({ ...settings, printerType: 'thermal' });
  const css = buildThermalLabelCss(layout, { calibration: resolveThermalCalibration(settings) });
  const ok = openPrintDocument('Feed Label', css, '<div class="thermal-label"><div class="tl-shift"></div></div>');
  if (!ok) window.alert('Popup blocked — allow popups to feed a label.');
  return ok;
}
