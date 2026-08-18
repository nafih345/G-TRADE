import JsBarcode from 'jsbarcode';
import QRCode from 'qrcode';

export const THERMAL_SIZES = [
  { id: 'roll_50x25_1up', label: '50 x 25mm (1-Up)', widthMm: 50, heightMm: 25, cols: 1, gapMm: 0 },
  { id: 'roll_38x25_1up', label: '38 x 25mm (1-Up)', widthMm: 38, heightMm: 25, cols: 1, gapMm: 0 },
  { id: 'roll_50x25_2up', label: '50 x 25mm (2-Up)', widthMm: 50, heightMm: 25, cols: 2, gapMm: 2 },
  { id: 'roll_38x25_2up', label: '38 x 25mm (2-Up)', widthMm: 38, heightMm: 25, cols: 2, gapMm: 2 },
  { id: 'roll_38x25_3up', label: '38 x 25mm (3-Up)', widthMm: 38, heightMm: 25, cols: 3, gapMm: 2 },
];

export const A4_SHEET_LAYOUTS = [
  { id: 'a4_24up', label: 'A4 - 24 Labels/Sheet (63.5 x 33.9mm)', cols: 3, rows: 8, widthMm: 63.5, heightMm: 33.9, marginTopMm: 10.7, marginLeftMm: 7.2, colGapMm: 2.5, rowGapMm: 0 },
  { id: 'a4_65up', label: 'A4 - 65 Labels/Sheet (38.1 x 21.2mm)', cols: 5, rows: 13, widthMm: 38.1, heightMm: 21.2, marginTopMm: 10.7, marginLeftMm: 4.8, colGapMm: 2.5, rowGapMm: 0 },
  { id: 'a4_80up', label: 'A4 - 80 Labels/Sheet (~48.5 x 13.5mm, verify against your sheet)', cols: 4, rows: 20, widthMm: 48.5, heightMm: 13.5, marginTopMm: 12.5, marginLeftMm: 6.5, colGapMm: 2, rowGapMm: 0 },
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

export function getLayout(printerType, sizeId) {
  const list = printerType === 'a4' ? A4_SHEET_LAYOUTS : THERMAL_SIZES;
  return list.find((l) => l.id === sizeId) || list[0];
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

export function buildLabelInnerHtml(product, settings, businessName, symbolMarkup, symbolError) {
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
    const price = parseFloat(product?.sellingPrice ?? product?.retail_price ?? 0) || 0;
    parts.push(`<div class="lbl-price">MRP: &#8377;${price.toFixed(2)}</div>`);
  }
  if (settings.showDiscountPrice && settings.discountPriceValue) {
    parts.push(`<div class="lbl-discount">Offer: &#8377;${escapeHtml(settings.discountPriceValue)}</div>`);
  }
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
  .lbl-expiry { font-size: 2mm; color: #475569; }
  .lbl-error { font-size: 2.1mm; color: #b91c1c; padding: 1mm; }
`;

// Pagination is chunked in JS (not left to CSS fragmentation) because CSS
// Grid does not reliably split across @page boundaries in Chromium print.
export function buildStyleBlock(layout, printerType) {
  if (printerType === 'a4') {
    const pageWidthMm = layout.cols * layout.widthMm + layout.colGapMm * (layout.cols - 1) + layout.marginLeftMm;
    const pageHeightMm = layout.rows * layout.heightMm + layout.rowGapMm * (layout.rows - 1) + layout.marginTopMm;
    return `
      @page { size: A4 portrait; margin: 0; }
      ${LABEL_BASE_CSS}
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

  const flatEntries = [];
  valid.forEach((p) => {
    const qty = resolveQuantity(p, settings);
    for (let i = 0; i < qty; i++) flatEntries.push(p);
  });

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
    return buildLabelInnerHtml(p, settings, businessName, markup, error);
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
