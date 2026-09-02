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

export const THERMAL_SIZES = [
  { id: 'roll_50x25_1up', label: '50 x 25mm (1-Up)', widthMm: 50, heightMm: 25, cols: 1, gapMm: 0 },
  { id: 'roll_38x25_1up', label: '38 x 25mm (1-Up)', widthMm: 38, heightMm: 25, cols: 1, gapMm: 0 },
  { id: 'roll_50x25_2up', label: '50 x 25mm (2-Up)', widthMm: 50, heightMm: 25, cols: 2, gapMm: 2 },
  { id: 'roll_38x25_2up', label: '38 x 25mm (2-Up)', widthMm: 38, heightMm: 25, cols: 2, gapMm: 2 },
  { id: 'roll_38x25_3up', label: '38 x 25mm (3-Up)', widthMm: 38, heightMm: 25, cols: 3, gapMm: 2 },
  // Jewellery "rat-tail" tags (the physical tag the shop uses). Three sections
  // in strip order: [ barcode panel ][ price + product details panel ][ blank
  // tail ] — printed borderless as one continuous strip. The two printed panels
  // fold back-to-back at the crease between them; the blank tail threads through
  // the ring / chain / spectacle hinge. `tailMm` = blank tail, `scanMm` = barcode
  // panel; the rest of the width is the details panel.
  { id: 'roll_rattail_54x13', label: 'Jewellery Rat-Tail Tag 90 x 13mm (barcode + details + blank tail)', widthMm: 90, heightMm: 13, cols: 1, gapMm: 0, tag: 'rattail', tailMm: 40, scanMm: 22 },
  { id: 'roll_rattail_75x10', label: 'Jewellery Rat-Tail Tag 75 x 12mm (shorter tail)', widthMm: 75, heightMm: 12, cols: 1, gapMm: 0, tag: 'rattail', tailMm: 30, scanMm: 20 },
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
];

export const BARCODE_TYPES = [
  { id: 'CODE128', label: 'Code 128' },
  { id: 'CODE39', label: 'Code 39' },
  { id: 'EAN13', label: 'EAN-13' },
  { id: 'EAN8', label: 'EAN-8' },
  { id: 'UPC', label: 'UPC-A' },
  { id: 'UPCE', label: 'UPC-E' },
  { id: 'QRCODE', label: 'QR Code' },
];

export const LABEL_STYLES = [
  { id: 'jewel', label: 'Jewellery Card (sectioned)' },
  { id: 'standard', label: 'Standard (stacked)' },
];

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
    return { markup: '', error: `Invalid value for ${barcodeType}` };
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
export function buildStyleBlock(layout, printerType) {
  if (printerType === 'a4') {
    const pageWidthMm = layout.cols * layout.widthMm + layout.colGapMm * (layout.cols - 1) + layout.marginLeftMm;
    const pageHeightMm = layout.rows * layout.heightMm + layout.rowGapMm * (layout.rows - 1) + layout.marginTopMm;
    return `
      @page { size: A4 portrait; margin: 0; }
      ${LABEL_BASE_CSS}
      ${JEWEL_CARD_CSS}
      ${layout.tag === 'jewellery' ? JEWELLERY_TAG_CSS : ''}
      ${layout.tag === 'rattail' ? ratTailCss(layout) : ''}
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

  const rowWidthMm = layout.cols * layout.widthMm + layout.gapMm * (layout.cols - 1);
  return `
    @page { size: ${rowWidthMm}mm ${layout.heightMm}mm; margin: 0; }
    ${LABEL_BASE_CSS}
    ${JEWEL_CARD_CSS}
    ${layout.tag === 'rattail' ? ratTailCss(layout) : ''}
    .sheet {
      display: flex; flex-direction: row; gap: ${layout.gapMm}mm;
      page-break-after: always;
    }
    .sheet:last-child { page-break-after: auto; }
    .label { width: ${layout.widthMm}mm; height: ${layout.heightMm}mm; }
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

  const layout = getLayout(settings.printerType, settings.sizeId);

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

  const labelHtmlList = flatEntries.map((p) => {
    const { markup, error } = symbolCache.get(p.barcode) || {};
    return buildLabelInnerHtml(p, settings, businessName, markup, error, layout);
  });

  const perPage = settings.printerType === 'a4' ? layout.cols * layout.rows : layout.cols;
  const sheetsHtml = chunk(labelHtmlList, perPage)
    .map((pageLabels) => `<div class="sheet">${pageLabels.join('')}</div>`)
    .join('');

  const printWindow = window.open('', '_blank', 'width=900,height=700');
  if (!printWindow) {
    window.alert('Popup blocked — please allow popups for this site to print barcode labels.');
    return { printed: 0, skipped };
  }

  const htmlContent = `
    <!DOCTYPE html>
    <html>
      <head>
        <title>Barcode Labels</title>
        <style>${buildStyleBlock(layout, settings.printerType)}</style>
      </head>
      <body>${sheetsHtml}</body>
    </html>
  `;

  printWindow.document.open();
  printWindow.document.write(htmlContent);
  printWindow.document.close();
  setTimeout(() => {
    try {
      printWindow.focus();
      printWindow.print();
    } catch (e) {}
  }, 300);

  return { printed: flatEntries.length, skipped };
}
