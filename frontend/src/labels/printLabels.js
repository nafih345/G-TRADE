// Barcode label designer — print job assembly. Turns (template + products + quantities)
// into a print document that preserves physical size:
//   Thermal roll: every label is its own @page of exactly W × (H + gap) mm.
//   A4 sheet:     210 × 297 mm pages with the template's grid (margins / gaps / start cell).
// Printer calibration (offset, scale) moves / scales the print, never the design.
import axios from 'axios';
import { renderLabelHtml, labelCss, hasUsableLogo, escapeHtml } from './renderLabel.js';
import { num, r2, sheetUsage } from './labelModel.js';
import { UUID_RE } from './labelApi.js';

const mm = (n) => `${r2(n)}mm`;

export function resolveCalibration(settings = {}) {
  return {
    hOffsetMm: Math.max(-20, Math.min(20, num(settings.h_offset_mm))),
    vOffsetMm: Math.max(-20, Math.min(20, num(settings.v_offset_mm))),
    scale: Math.max(0.5, Math.min(1.5, num(settings.print_scale_percent, 100) / 100)),
    dpi: num(settings.printer_dpi, 203),
  };
}

// Browsers print the window <title> in the page header when "Headers and footers" is on —
// on a 25 mm sticker that header ate half the label and pushed the barcode off the
// bottom. Printed jobs therefore carry a blank title (zero-width space: an empty title
// makes Chrome fall back to printing the URL instead). Preview windows keep their title.
const BLANK_TITLE = '​';

export function openPrintWindow(title, css, bodyHtml, { autoPrint = true } = {}) {
  const w = window.open('', '_blank', 'width=760,height=600');
  if (!w) return false;
  const shownTitle = autoPrint ? BLANK_TITLE : title;
  w.document.open();
  w.document.write(
    `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(shownTitle)}</title>` +
    `<style>${css}</style></head><body>${bodyHtml}</body></html>`
  );
  w.document.close();
  if (!autoPrint) return true;
  // Give the browser a moment to lay out SVG / fonts before the dialog snapshots the page.
  setTimeout(() => {
    try { w.document.title = BLANK_TITLE; w.focus(); w.print(); } catch { /* user can print from the window */ }
  }, 400);
  return true;
}

function thermalCss(template, cal) {
  const W = num(template.width_mm);
  const H = num(template.height_mm);
  const pageH = H + Math.max(0, num(template.layout?.gapMm));
  // Each sticker is one page that starts at the very top edge: zero page margins (no room
  // for browser headers/footers), no body margin/padding, and nothing but labels printed.
  return `
    @page { size: ${mm(W)} ${mm(pageH)}; margin: 0 !important; }
    html, body { margin: 0 !important; padding: 0 !important; background: #fff; width: ${mm(W)}; }
    @media print {
      html, body { margin: 0 !important; padding: 0 !important; width: ${mm(W)}; }
      body > :not(.gl-page), h1, h2, h3, h4, header, .gl-noprint { display: none !important; }
    }
    .gl-page { width: ${mm(W)}; height: ${mm(pageH)}; position: relative; overflow: hidden; box-sizing: border-box; margin: 0;
      page-break-after: always; break-after: page; page-break-inside: avoid; break-inside: avoid; }
    .gl-page:last-child { page-break-after: auto; break-after: auto; }
    .gl-shift { position: absolute; left: ${mm(cal.hOffsetMm)}; top: ${mm(cal.vOffsetMm)};
      transform: scale(${cal.scale}); transform-origin: 0 0; }
  `;
}

function a4Css(template, cal) {
  const s = template.layout?.sheet || {};
  return `
    @page { size: A4 portrait; margin: 0 !important; }
    html, body { margin: 0 !important; padding: 0 !important; background: #fff; }
    @media print { body > :not(.gl-sheet) { display: none !important; } }
    .gl-sheet { width: 210mm; height: 297mm; position: relative; overflow: hidden;
      page-break-after: always; break-after: page; }
    .gl-sheet:last-child { page-break-after: auto; break-after: auto; }
    .gl-grid { position: absolute; left: ${mm(num(s.marginLeftMm) + cal.hOffsetMm)}; top: ${mm(num(s.marginTopMm) + cal.vOffsetMm)};
      display: grid; grid-template-columns: repeat(${s.cols || 1}, ${mm(template.width_mm)});
      grid-auto-rows: ${mm(template.height_mm)}; column-gap: ${mm(num(s.colGapMm))}; row-gap: ${mm(num(s.rowGapMm))};
      transform: scale(${cal.scale}); transform-origin: 0 0; }
    .gl-cell { width: ${mm(template.width_mm)}; height: ${mm(template.height_mm)}; overflow: hidden; position: relative; }
    .gl-cell--outline { outline: 0.2mm dashed #94a3b8; outline-offset: -0.1mm; }
    .gl-cellno { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
      font: 600 7pt Arial, sans-serif; color: #64748b; }
  `;
}

export function buildPrintDocument(template, labelHtmls, { settings, logo = '', startSkip = 0 } = {}) {
  const cal = resolveCalibration(settings);
  const css = labelCss({ logo });
  if (template.printer_type !== 'a4') {
    const body = labelHtmls.map((h) => `<div class="gl-page"><div class="gl-shift">${h}</div></div>`).join('');
    return { css: css + thermalCss(template, cal), body };
  }
  const per = sheetUsage(template).perSheet || 1;
  const cells = [
    ...Array(Math.max(0, startSkip)).fill('<div class="gl-cell"></div>'),
    ...labelHtmls.map((h) => `<div class="gl-cell">${h}</div>`),
  ];
  const sheets = [];
  for (let i = 0; i < cells.length; i += per) {
    sheets.push(`<div class="gl-sheet"><div class="gl-grid">${cells.slice(i, i + per).join('')}</div></div>`);
  }
  return { css: css + a4Css(template, cal), body: sheets.join('') };
}

// A typed override must still scan back to this product at billing — register it first
// (as primary if the product has none, else as an extra scan-in code).
async function registerOverride(product, code) {
  if (!UUID_RE.test(String(product?.id || ''))) return null;
  try {
    await axios.post(`/api/products/items/${product.id}/register_barcode/`, { code });
    return null;
  } catch (e) {
    if (e?.response?.status === 409) return e.response.data?.detail || 'That barcode already belongs to another product.';
    return null;
  }
}

// rows: [{ product, qty, data: { fields }, job: { batch_no, expiry_date } }]
// -> { printed, failed: [{ name, reason }], error? }
export async function printLabelJob({ template, rows, settings = {}, store = {}, logo = '', job = {}, manualBarcode = '', startSkip = 0 }) {
  const cal = resolveCalibration(settings);
  const ctx = { dpi: template.printer_type === 'a4' ? 0 : cal.dpi, hasLogo: hasUsableLogo(logo) };
  const active = rows.filter((r) => !r.skipReason && (parseInt(r.qty, 10) || 0) > 0);
  const failed = [];
  const html = [];

  const override = String(manualBarcode || '').trim();
  const useOverride = override && active.length === 1;
  if (useOverride) {
    const problem = await registerOverride(active[0].product, override);
    if (problem) return { printed: 0, failed: [], error: problem };
  }

  for (const r of active) {
    const qty = parseInt(r.qty, 10) || 0;
    // Every copy carries the same number: the product's saved barcode or the typed override.
    const code = useOverride ? override : (r.data?.fields?.barcode || '');
    for (let i = 0; i < qty; i += 1) {
      const data = {
        fields: { ...(r.data?.fields || {}), barcode: code },
        store,
        job: { ...job, ...Object.fromEntries(Object.entries(r.job || {}).filter(([, v]) => v)) },
        barcodeOverride: code,
      };
      const out = renderLabelHtml(template, data, ctx);
      const blocking = out.warnings.find((w) => w.level === 'error' && (w.kind === 'barcode' || w.kind === 'required'));
      if (blocking) {
        failed.push({ name: r.data?.fields?.product_name || r.product?.name || 'Product', reason: blocking.message });
        continue;
      }
      html.push(out.html);
    }
  }

  if (!html.length) return { printed: 0, failed, error: failed[0]?.reason || 'Nothing to print.' };
  const doc = buildPrintDocument(template, html, { settings, logo, startSkip: template.printer_type === 'a4' ? startSkip : 0 });
  if (!openPrintWindow(`Barcode Labels — ${template.name || ''}`, doc.css, doc.body)) {
    return { printed: 0, failed, error: 'Pop-up blocked — allow pop-ups for this site to print labels.' };
  }
  return { printed: html.length, failed };
}

// Calibration aids --------------------------------------------------------------
// Thermal: one label with an edge border, centre cross-hair and 5 mm ticks — measure it
// with a ruler to set offset / scale. A4: a full sheet of numbered cell outlines to lay
// over (or print onto) a label sheet and check alignment.
export function printCalibration(template, settings = {}) {
  const cal = resolveCalibration(settings);
  const W = num(template.width_mm);
  const H = num(template.height_mm);
  const ticks = [];
  for (let x = 5; x < W; x += 5) ticks.push(`<div style="position:absolute;left:${mm(x)};top:0;width:0.2mm;height:${x % 10 ? 1.2 : 2.2}mm;background:#000"></div>`);
  for (let y = 5; y < H; y += 5) ticks.push(`<div style="position:absolute;top:${mm(y)};left:0;height:0.2mm;width:${y % 10 ? 1.2 : 2.2}mm;background:#000"></div>`);
  const label = `<div class="gl-label" style="width:${mm(W)};height:${mm(H)};border:0.25mm solid #000">${ticks.join('')}` +
    `<div style="position:absolute;left:${mm(W / 2 - 3)};top:${mm(H / 2)};width:6mm;height:0.2mm;background:#000"></div>` +
    `<div style="position:absolute;top:${mm(H / 2 - 3)};left:${mm(W / 2)};height:6mm;width:0.2mm;background:#000"></div>` +
    `<div style="position:absolute;left:0;right:0;bottom:${mm(Math.min(2, H * 0.08))};text-align:center;font:600 ${Math.max(4, Math.min(7, H / 4))}pt Arial">${r2(W)} × ${r2(H)} mm</div></div>`;
  if (template.printer_type !== 'a4') {
    const doc = buildPrintDocument(template, [label], { settings });
    return openPrintWindow('Label calibration', doc.css, doc.body);
  }
  const per = sheetUsage(template).perSheet;
  const s = template.layout?.sheet || {};
  const cells = Array.from({ length: per }, (_, i) => `<div class="gl-cell gl-cell--outline"><div class="gl-cellno">R${Math.floor(i / s.cols) + 1} C${(i % s.cols) + 1}</div></div>`);
  const css = labelCss() + a4Css(template, cal);
  return openPrintWindow('A4 sheet calibration', css, `<div class="gl-sheet"><div class="gl-grid">${cells.join('')}</div></div>`);
}

// Advances the thermal roll by exactly one label pitch (blank page of the label size).
export function feedOneLabel(template, settings = {}) {
  const cal = resolveCalibration(settings);
  return openPrintWindow('Feed label', thermalCss(template, cal), '<div class="gl-page"><div class="gl-shift"></div></div>');
}
