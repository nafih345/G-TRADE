// Barcode label designer — the ONE renderer. The designer canvas, the live preview, the
// print dialog preview and the actual print job all call renderLabelHtml(), so what the
// user sees is exactly what prints. Output is absolutely-positioned HTML in millimetres;
// every user-supplied string is escaped and every style value comes from the validated
// whitelist in the template (no template can inject markup / CSS).
//
// Barcodes are drawn as SVG from JsBarcode's module pattern and stretched to an exact mm
// width; with a printer DPI configured, the bar (module) width is snapped to whole printer
// dots so every bar prints evenly — the main reason thermal barcodes fail to scan.
import JsBarcode from 'jsbarcode';
import QRCode from 'qrcode';
import { resolveFieldElement, rawFieldValue, fieldLabel } from './labelFields.js';
import { PT_TO_MM, MM_PER_INCH, elementTitle, geometryWarnings, r2, num } from './labelModel.js';

export const escapeHtml = (str) => String(str ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const SAFE_COLOR = /^#[0-9a-fA-F]{6}$/;
const color = (c, d = '#000000') => (SAFE_COLOR.test(String(c || '')) ? c : d);
const FONT_STACKS = {
  Arial: 'Arial, Helvetica, sans-serif',
  Helvetica: 'Helvetica, Arial, sans-serif',
  Verdana: 'Verdana, Geneva, sans-serif',
  Tahoma: 'Tahoma, Verdana, sans-serif',
  'Courier New': '"Courier New", Courier, monospace',
  'Times New Roman': '"Times New Roman", Times, serif',
};
const LINE_HEIGHT = 1.15;
const mm = (n) => `${r2(n)}mm`;

// ---------------------------------------------------------------------------
// Barcode validation + encoding
// ---------------------------------------------------------------------------
function gtinCheckDigit(digits) {
  // digits without check digit; weights 3,1 from the right
  let sum = 0;
  for (let i = digits.length - 1, w = 3; i >= 0; i -= 1, w = w === 3 ? 1 : 3) sum += Number(digits[i]) * w;
  return (10 - (sum % 10)) % 10;
}

// null = encodable, otherwise a human-readable reason.
export function barcodeProblem(format, value) {
  const v = String(value ?? '').trim();
  if (!v) return 'No barcode value on this product.';
  const digits = /^\d+$/.test(v);
  switch (format) {
    case 'EAN13':
      if (!digits || (v.length !== 12 && v.length !== 13)) return `EAN-13 needs 12 or 13 digits — “${v}” is ${v.length} character(s). Use Code 128 for this product.`;
      if (v.length === 13 && gtinCheckDigit(v.slice(0, 12)) !== Number(v[12])) return `“${v}” has a wrong EAN-13 check digit (should end in ${gtinCheckDigit(v.slice(0, 12))}).`;
      return null;
    case 'EAN8':
      if (!digits || (v.length !== 7 && v.length !== 8)) return `EAN-8 needs 7 or 8 digits — “${v}” is ${v.length} character(s).`;
      if (v.length === 8 && gtinCheckDigit(v.slice(0, 7)) !== Number(v[7])) return `“${v}” has a wrong EAN-8 check digit.`;
      return null;
    case 'UPC':
      if (!digits || (v.length !== 11 && v.length !== 12)) return `UPC-A needs 11 or 12 digits — “${v}” is ${v.length} character(s).`;
      if (v.length === 12 && gtinCheckDigit(v.slice(0, 11)) !== Number(v[11])) return `“${v}” has a wrong UPC-A check digit.`;
      return null;
    case 'UPCE':
      if (!digits || v.length < 6 || v.length > 8) return `UPC-E needs 6 to 8 digits — “${v}” is ${v.length} character(s).`;
      return null;
    case 'CODE39':
      if (!/^[0-9A-Z\-. $/+%]+$/.test(v)) return `Code 39 allows only A–Z, 0–9 and - . $ / + % space — “${v}” has other characters. Use Code 128.`;
      return null;
    case 'CODE128':
      // eslint-disable-next-line no-control-regex
      if (!/^[\x00-\x7F]+$/.test(v)) return 'Code 128 can only encode plain ASCII characters.';
      return null;
    default:
      return null;
  }
}

const encodeCache = new Map();
// Bar runs from a JsBarcode module pattern ("1101001…", one char per module): [[x, w], …]
export function patternToRuns(pattern) {
  const runs = [];
  for (let i = 0; i < pattern.length;) {
    if (pattern[i] !== '1') { i += 1; continue; }
    let j = i;
    while (pattern[j] === '1') j += 1;
    runs.push([i, j - i]);
    i = j;
  }
  return runs;
}

// -> { modules, pattern, path } | { error }. Uses JsBarcode's DOM-free object renderer to
// get the exact module pattern, then draws every bar ourselves with an explicit black fill
// (see barcodeHtml). Never falls back to a placeholder: a failure is an { error }.
export function encodeBarcode(format, value) {
  const key = `${format}|${value}`;
  if (encodeCache.has(key)) return encodeCache.get(key);
  const problem = barcodeProblem(format, value);
  let result;
  if (problem) {
    result = { error: problem };
  } else {
    try {
      const out = {};
      JsBarcode(out, String(value).trim(), { format, width: 1, margin: 0, displayValue: false });
      const pattern = (out.encodings || []).map((e) => e.data || '').join('');
      const runs = patternToRuns(pattern);
      result = /^[01]+$/.test(pattern) && runs.length >= 10
        ? { modules: pattern.length, pattern, path: runs.map(([x, w]) => `M${x} 0h${w}v1h-${w}z`).join('') }
        : { error: `Could not encode “${value}” as ${format}.` };
    } catch (e) {
      result = { error: `This value can't be encoded as ${format}.` };
    }
  }
  if (encodeCache.size > 2000) encodeCache.clear();
  encodeCache.set(key, result);
  return result;
}

function qrSvg(value, sizeMm) {
  const v = String(value ?? '').trim();
  if (!v) return { error: 'No value for the QR code.' };
  try {
    const qr = QRCode.create(v, { errorCorrectionLevel: 'M' });
    const n = qr.modules.size;
    const data = qr.modules.data;
    let path = '';
    for (let y = 0; y < n; y += 1) {
      for (let x = 0; x < n; x += 1) {
        if (data[y * n + x]) path += `M${x} ${y}h1v1h-1z`;
      }
    }
    const q = 2; // quiet zone, modules
    return {
      html: `<svg xmlns="http://www.w3.org/2000/svg" width="${mm(sizeMm)}" height="${mm(sizeMm)}" viewBox="${-q} ${-q} ${n + 2 * q} ${n + 2 * q}" shape-rendering="crispEdges"><path d="${path}" fill="#000"/></svg>`,
    };
  } catch (e) {
    return { error: 'Value too long for a QR code.' };
  }
}

// ---------------------------------------------------------------------------
// Text measurement (canvas — same fonts in the preview and in the print window)
// ---------------------------------------------------------------------------
let measureCtx = null;
function textWidthMm(text, style) {
  if (typeof document === 'undefined') return 0;
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
  if (!measureCtx) return 0;
  const sizeMm = style.fontSizePt * PT_TO_MM;
  measureCtx.font = `${style.italic ? 'italic ' : ''}${style.fontWeight || 400} 100px ${FONT_STACKS[style.fontFamily] || FONT_STACKS.Arial}`;
  const w = measureCtx.measureText(text).width / 100 * sizeMm;
  return w + Math.max(0, text.length - 1) * num(style.letterSpacingMm);
}

function wrapLineCount(text, style, widthMm) {
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return 0;
  let lines = 1;
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (textWidthMm(next, style) <= widthMm || !line) {
      line = next;
      // a single word wider than the box breaks across lines (overflow-wrap:anywhere)
      if (!line.includes(' ') && textWidthMm(line, style) > widthMm) {
        lines += Math.ceil(textWidthMm(line, style) / widthMm) - 1;
      }
    } else {
      lines += 1;
      line = word;
    }
  }
  return lines;
}

// Fits text into its box per the overflow mode. -> { fontSizePt, overflow: bool }
function fitText(text, style, boxW, boxH) {
  const lineMm = (pt) => pt * PT_TO_MM * LINE_HEIGHT;
  if (!text) return { fontSizePt: style.fontSizePt, overflow: false };
  const width = textWidthMm(text, style);
  if (style.overflow === 'shrink') {
    let scale = 1;
    if (width > boxW) scale = Math.min(scale, boxW / width);
    if (lineMm(style.fontSizePt) > boxH) scale = Math.min(scale, boxH / lineMm(style.fontSizePt));
    const minScale = 0.4;
    return { fontSizePt: r2(style.fontSizePt * Math.max(scale, minScale)), overflow: scale < minScale };
  }
  if (style.overflow === 'wrap') {
    const lines = wrapLineCount(text, style, boxW);
    const fitLines = Math.max(1, Math.min(style.maxLines || 2, Math.floor((boxH + 0.01) / lineMm(style.fontSizePt))));
    return { fontSizePt: style.fontSizePt, overflow: lines > fitLines, lines: fitLines };
  }
  return { fontSizePt: style.fontSizePt, overflow: width > boxW + 0.05 || lineMm(style.fontSizePt) > boxH + 0.3 };
}

// ---------------------------------------------------------------------------
// Elements
// ---------------------------------------------------------------------------
function textHtml(text, style, fit) {
  const s = style;
  const justify = { left: 'flex-start', center: 'center', right: 'flex-end' }[s.align] || 'flex-start';
  const alignItems = { top: 'flex-start', middle: 'center', bottom: 'flex-end' }[s.vAlign] || 'center';
  const fg = s.invert ? '#ffffff' : color(s.color);
  const bg = s.invert ? color(s.color) : 'transparent';
  const cls = s.overflow === 'wrap' ? 'gl-wrap' : s.overflow === 'clip' ? 'gl-nowrap' : 'gl-nowrap gl-ell';
  const clamp = s.overflow === 'wrap' ? `-webkit-line-clamp:${fit.lines || s.maxLines || 2};` : '';
  return (
    `<div class="gl-t" style="justify-content:${justify};align-items:${alignItems};color:${fg};background:${bg};` +
    `font-family:${FONT_STACKS[s.fontFamily] || FONT_STACKS.Arial};font-size:${r2(fit.fontSizePt)}pt;font-weight:${Number(s.fontWeight) || 400};` +
    `font-style:${s.italic ? 'italic' : 'normal'};letter-spacing:${r2(num(s.letterSpacingMm))}mm;${s.uppercase ? 'text-transform:uppercase;' : ''}">` +
    `<span class="gl-s ${cls}" style="text-align:${s.align || 'left'};${clamp}">${escapeHtml(text)}</span></div>`
  );
}

// Smallest bar (module) width treated as reliably scannable: 2 printer dots on a thermal
// head (0.25 mm at 203 dpi), 0.19 mm on laser / A4 (no dpi). Recommended: 0.25–0.375 mm.
export const RECOMMENDED_MODULE_MM = [0.25, 0.375];
export const minSafeModuleMm = (dpi) => (dpi > 0 ? 2 * (MM_PER_INCH / dpi) : 0.19);
const QZ_MODULES = 10;
const fmtMm = (n) => `${(Math.round(n * 100) / 100).toFixed(2)} mm`;

// Bar-width choices offered in the designer: whole printer dots from 2 dots to 0.5 mm.
export function moduleWidthOptions(dpi) {
  if (!(dpi > 0)) return [0.25, 0.3, 0.33, 0.375];
  const dot = MM_PER_INCH / dpi;
  const out = [];
  for (let d = 2; d * dot <= 0.5 + 1e-6; d += 1) out.push(Math.round(d * dot * 1000) / 1000);
  return out;
}

// Physical layout of one barcode in a box — the single source for the designer readout,
// warnings, preview and print. Never silently shrinks below what was asked.
//   -> { error } | { modules, path, moduleMm, dots, barsW, quietEach, safe, fits,
//                    needAtMinMm, minModuleMm, requestedMm }
export function planBarcode({ value, format, boxW, barcode = {}, dpi = 0 }) {
  const enc = encodeBarcode(format, value);
  if (enc.error) return { error: enc.error };
  const dot = dpi > 0 ? MM_PER_INCH / dpi : 0;
  const minModuleMm = minSafeModuleMm(dpi);
  const minQuiet = Math.max(num(barcode.quietZoneMm, 1.5), 1);
  const requestedMm = num(barcode.moduleMm, 0) > 0 ? num(barcode.moduleMm) : 0;
  const snap = (m) => (dot ? Math.max(1, Math.round(m / dot)) * dot : m);
  // widest module that still leaves the minimum quiet zone on both sides
  const maxFit = Math.max(0, (boxW - 2 * minQuiet) / enc.modules);
  const maxFitSnapped = dot ? Math.floor((maxFit + 1e-6) / dot) * dot : maxFit;
  let moduleMm;
  let fits = true;
  if (requestedMm) {
    moduleMm = snap(requestedMm);
    if (moduleMm > maxFit + 1e-6) {
      fits = false;
      moduleMm = maxFitSnapped >= minModuleMm - 1e-6 ? maxFitSnapped : maxFit;
    }
  } else {
    // Auto: ideally 10-module quiet zones; else the widest whole-dot width that fits.
    const ideal = boxW / (enc.modules + 2 * QZ_MODULES);
    const idealSnapped = dot ? Math.round(ideal / dot) * dot : ideal;
    if (idealSnapped >= minModuleMm - 1e-6 && idealSnapped <= maxFit + 1e-6) moduleMm = idealSnapped;
    else if (maxFitSnapped >= minModuleMm - 1e-6) moduleMm = maxFitSnapped;
    else moduleMm = maxFit; // can't reach a safe width: fractional beats collapsing to 1 dot
  }
  const barsW = enc.modules * moduleMm;
  return {
    modules: enc.modules, path: enc.path, moduleMm, dots: dot ? moduleMm / dot : 0,
    barsW, quietEach: Math.max(0, (boxW - barsW) / 2), safe: moduleMm >= minModuleMm - 1e-6, fits,
    needAtMinMm: enc.modules * minModuleMm + 2 * minQuiet, minModuleMm, requestedMm,
  };
}

// Concrete ways out when a barcode can't print at a safe bar width: a denser format that
// fits, a wider box, or the short internal code. The designer applies these fix ids.
function barcodeFitHints(el, value, format, boxW, ctx) {
  const plan = planBarcode({ value, format, boxW, barcode: el.barcode, dpi: ctx.dpi });
  if (plan.error || plan.safe) return { unsafe: false };
  const fixes = [];
  const tips = [];
  if (format !== 'CODE128') {
    const alt = planBarcode({ value, format: 'CODE128', boxW, barcode: { ...el.barcode, moduleMm: 0 }, dpi: ctx.dpi });
    if (!alt.error && alt.safe) {
      fixes.push({ id: 'format128', label: `Switch to Code 128 (${fmtMm(alt.moduleMm)} bars fit)` });
      tips.push(`Code 128 needs ${alt.modules} bar-widths for it instead of ${plan.modules}.`);
    }
  }
  const usable = (ctx.labelW || boxW) - 2 * (ctx.padding || 0);
  if (usable > boxW + 0.5) {
    const wider = planBarcode({ value, format, boxW: usable, barcode: { ...el.barcode, moduleMm: 0 }, dpi: ctx.dpi });
    if (!wider.error && wider.safe) fixes.push({ id: 'widen', label: 'Widen the barcode to the label width' });
  }
  if (el.barcode?.whenTooLong !== 'internal' && el.field !== 'sku') {
    fixes.push({ id: 'internal', label: 'Print a short internal code when a barcode is too long' });
    tips.push('Or print a short internal code mapped to the product — its SKU / barcode is never changed.');
  }
  return { unsafe: true, fixes, suggestion: tips.join(' ') };
}

function barcodeHtml(el, value, format, boxW, boxH, dpi, warn, hints = {}) {
  const b = el.barcode || {};
  const plan = planBarcode({ value, format, boxW, barcode: b, dpi });
  if (plan.error) {
    warn({ level: 'error', elementId: el.id, kind: 'barcode', message: plan.error });
    return `<div class="gl-err">&#9888; ${escapeHtml(plan.error)}</div>`;
  }
  const minQuiet = Math.max(num(b.quietZoneMm, 1.5), 1);
  const dotTxt = dpi > 0 ? ` (${r2(plan.dots)} printer dots at ${dpi} dpi)` : '';
  if (!plan.fits) {
    warn({ level: 'warning', elementId: el.id, kind: 'barcode-fit', fixes: hints.fixes,
      message: `${elementTitle(el)}: at ${fmtMm(plan.requestedMm)} bars, “${value}” needs ${fmtMm(plan.modules * plan.requestedMm + 2 * minQuiet)} but the box is ${fmtMm(boxW)} — printing ${fmtMm(plan.moduleMm)} bars instead.` });
  }
  if (!plan.safe) {
    warn({ level: 'warning', elementId: el.id, kind: 'barcode-fit', fixes: hints.fixes,
      message: `${elementTitle(el)}: bars are only ${fmtMm(plan.moduleMm)}${dotTxt} for “${value}” (${format}, ${plan.modules} bar-widths) — below the ${fmtMm(plan.minModuleMm)} minimum for reliable scanning. It needs ${fmtMm(plan.needAtMinMm)}; this box is ${fmtMm(boxW)}.${hints.suggestion ? ` ${hints.suggestion}` : ''}` });
  } else if (plan.moduleMm < RECOMMENDED_MODULE_MM[0] - 1e-6) {
    warn({ level: 'info', elementId: el.id, kind: 'barcode', message: `${elementTitle(el)}: bars are ${fmtMm(plan.moduleMm)} — scannable, but 0.25–0.375 mm reads faster.` });
  }
  if (plan.quietEach < QZ_MODULES * plan.moduleMm - 0.01) {
    warn({ level: 'info', elementId: el.id, kind: 'barcode', message: `${elementTitle(el)}: ${fmtMm(plan.quietEach)} blank space beside the bars (10 bar-widths = ${fmtMm(QZ_MODULES * plan.moduleMm)} is ideal).` });
  }
  // Human-readable digits never wider than the box: shrink to fit, 4 pt minimum.
  const setPt = num(b.textSizePt, 6);
  let textPt = setPt;
  if (b.showText) {
    const w = textWidthMm(value, { fontFamily: 'Arial', fontSizePt: setPt, fontWeight: 400, letterSpacingMm: 0 }) * 1.06;
    if (w > boxW) {
      textPt = Math.max(4, r2(setPt * (boxW / w)));
      if (w * (textPt / setPt) > boxW + 0.1) warn({ level: 'info', elementId: el.id, kind: 'barcode', message: `${elementTitle(el)}: the digits under the bars don’t fit even at 4 pt.` });
    }
  }
  const textMm = b.showText ? textPt * PT_TO_MM * LINE_HEIGHT : 0;
  const barsH = Math.max(1, boxH - textMm);
  if (barsH < 4) {
    warn({ level: 'info', elementId: el.id, kind: 'barcode', message: `${elementTitle(el)}: bars are ${r2(barsH)} mm tall — 5 mm or more scans more reliably.` });
  }
  const sideGap = Math.min(plan.quietEach, Math.max(num(b.quietZoneMm, 1.5), QZ_MODULES * plan.moduleMm));
  const left = b.align === 'left' ? sideGap : b.align === 'right' ? boxW - plan.barsW - sideGap : plan.quietEach;
  // Exact physical size in mm; viewBox = modules × 1 so every module is exactly moduleMm
  // wide (no distortion) and only the bar height follows the box.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" class="gl-bars" style="left:${mm(left)};width:${mm(plan.barsW)};height:${mm(barsH)}" ` +
    `width="${mm(plan.barsW)}" height="${mm(barsH)}" viewBox="0 0 ${plan.modules} 1" preserveAspectRatio="none" shape-rendering="crispEdges" ` +
    `data-value="${escapeHtml(value)}" data-module-mm="${Math.round(plan.moduleMm * 10000) / 10000}"><path d="${plan.path}" fill="#000000"/></svg>`;
  const text = b.showText
    ? `<div class="gl-bctext" style="left:0;width:${mm(boxW)};height:${mm(textMm)};font-size:${r2(textPt)}pt">${escapeHtml(value)}</div>`
    : '';
  return `<div class="gl-bc">${svg}${text}</div>`;
}

// True when this template would substitute the short internal code for this product (some
// barcode element opted in and the product's barcode can't print at a safe bar width).
export function needsInternalCode(template, fields, ctx = {}) {
  const fullCtx = { dpi: 0, labelW: num(template.width_mm), padding: num(template.layout?.paddingMm, 0), ...ctx };
  return (template.layout?.elements || []).some((el) => {
    if (el.hidden || el.type !== 'barcode' || el.field === 'sku' || el.barcode?.whenTooLong !== 'internal') return false;
    const fmt = !el.barcode?.format || el.barcode.format === 'inherit' ? template.layout?.defaultBarcodeFormat || 'CODE128' : el.barcode.format;
    const rotated = el.rotation === 90 || el.rotation === 270;
    return barcodeFitHints(el, fields?.barcode || '', fmt, rotated ? el.h : el.w, fullCtx).unsafe;
  });
}

function elementInner(el, data, ctx, boxW, boxH, warn) {
  switch (el.type) {
    case 'field': {
      const r = resolveFieldElement(el, data);
      if (el.required && r.missing) {
        warn({ level: 'error', elementId: el.id, kind: 'required', message: `Required field “${fieldLabel(el.field)}” is empty for this product.` });
      }
      if (r.hidden) return null;
      const fit = fitText(r.text, el.style, boxW, boxH);
      if (fit.overflow) warn({ level: 'warning', elementId: el.id, kind: 'overflow', message: `${elementTitle(el)} doesn’t fit: “${r.text.slice(0, 40)}${r.text.length > 40 ? '…' : ''}” is cut off.` });
      return textHtml(r.text, el.style, fit);
    }
    case 'text': {
      const fit = fitText(el.text || '', el.style, boxW, boxH);
      if (fit.overflow) warn({ level: 'warning', elementId: el.id, kind: 'overflow', message: `Text “${String(el.text).slice(0, 30)}” doesn’t fit its box.` });
      return textHtml(el.text || '', el.style, fit);
    }
    case 'barcode': {
      const fmt = !el.barcode?.format || el.barcode.format === 'inherit' ? ctx.defaultFormat : el.barcode.format;
      let value = el.field === 'sku' ? rawFieldValue('sku', data) : (data.barcodeOverride || rawFieldValue('barcode', data));
      const hints = barcodeFitHints(el, value, fmt, boxW, ctx);
      // Too long to scan at this size: print the product's short internal code (a scan code
      // already mapped to this product) — only when the template opts in.
      const internalCode = data.internalCode || data.fields?.internal_code || '';
      if (hints.unsafe && el.barcode?.whenTooLong === 'internal' && el.field !== 'sku') {
        if (internalCode && internalCode !== value) {
          warn({ level: 'info', elementId: el.id, kind: 'barcode', message: `“${value}” is too long for a scannable barcode here — printing this product’s short internal code ${internalCode} (it scans back to the same product).` });
          value = internalCode;
          return barcodeHtml(el, value, fmt, boxW, boxH, ctx.dpi, warn, barcodeFitHints(el, value, fmt, boxW, ctx));
        }
        warn({ level: 'info', elementId: el.id, kind: 'barcode', message: `“${value}” is too long for a scannable barcode here. A short internal code linked to this product is created when the label is printed.` });
      }
      return barcodeHtml(el, value, fmt, boxW, boxH, ctx.dpi, warn, hints);
    }
    case 'qr': {
      const value = el.field === 'barcode' ? (data.barcodeOverride || rawFieldValue('barcode', data)) : rawFieldValue(el.field, data);
      const side = Math.min(boxW, boxH);
      const q = qrSvg(value, side);
      if (q.error) {
        warn({ level: 'error', elementId: el.id, kind: 'barcode', message: q.error });
        return `<div class="gl-err">&#9888; ${escapeHtml(q.error)}</div>`;
      }
      return `<div class="gl-qr">${q.html}</div>`;
    }
    case 'line': {
      const s = Math.max(0.05, num(el.strokeMm, 0.25));
      const horizontal = boxW >= boxH;
      const pos = horizontal
        ? `left:0;right:0;top:${mm((boxH - s) / 2)};height:${mm(s)}`
        : `top:0;bottom:0;left:${mm((boxW - s) / 2)};width:${mm(s)}`;
      return `<div class="gl-line" style="${pos};background:${color(el.color)}"></div>`;
    }
    case 'rect':
      return `<div class="gl-rect" style="border:${mm(Math.max(0.05, num(el.strokeMm, 0.25)))} solid ${color(el.color)};border-radius:${mm(num(el.radiusMm))};background:${el.fill ? color(el.color) : 'transparent'}"></div>`;
    case 'logo':
      if (!ctx.hasLogo) {
        warn({ level: 'info', elementId: el.id, kind: 'logo', message: 'No store logo uploaded yet (Settings → Bill & Invoice Designer → Branding). The logo box prints blank.' });
        return '';
      }
      return `<div class="gl-logo" style="background-size:${el.fit === 'cover' ? 'cover' : 'contain'}"></div>`;
    default:
      return null;
  }
}

// One label. -> { html, warnings }. `data` = { fields, store, job, barcodeOverride? }.
// ctx: { dpi, hasLogo, editor } — `editor` tags elements with data-el-id for the canvas.
export function renderLabelHtml(template, data, ctx = {}) {
  const W = num(template.width_mm);
  const H = num(template.height_mm);
  const warnings = [];
  const warn = (w) => warnings.push(w);
  const fullCtx = { dpi: 0, hasLogo: false, defaultFormat: template.layout?.defaultBarcodeFormat || 'CODE128', labelW: W, padding: num(template.layout?.paddingMm, 0), ...ctx };
  const parts = [];
  for (const el of template.layout?.elements || []) {
    if (el.hidden) continue;
    const rotated = el.rotation === 90 || el.rotation === 270;
    const boxW = rotated ? el.h : el.w;
    const boxH = rotated ? el.w : el.h;
    const inner = elementInner(el, data || {}, fullCtx, boxW, boxH, warn);
    if (inner === null) continue;
    const innerStyle = el.rotation
      ? `width:${mm(boxW)};height:${mm(boxH)};left:${mm((el.w - boxW) / 2)};top:${mm((el.h - boxH) / 2)};transform:rotate(${el.rotation}deg)`
      : 'left:0;top:0;width:100%;height:100%';
    parts.push(
      `<div class="gl-el"${fullCtx.editor ? ` data-el-id="${escapeHtml(el.id)}"` : ''} style="left:${mm(el.x)};top:${mm(el.y)};width:${mm(el.w)};height:${mm(el.h)}">` +
      `<div class="gl-in" style="${innerStyle}">${inner}</div></div>`
    );
  }
  return {
    html: `<div class="gl-label" style="width:${mm(W)};height:${mm(H)}">${parts.join('')}</div>`,
    warnings: [...geometryWarnings(template), ...warnings],
  };
}

// Shared element CSS (preview + print). The logo is defined ONCE as a CSS background so a
// 500-label job doesn't repeat a base64 image 500 times.
export function labelCss({ logo = '' } = {}) {
  const safeLogo = /^data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(logo) ? logo : '';
  return `
    .gl-label { position: relative; overflow: hidden; background: #fff; color: #000; box-sizing: border-box;
      -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .gl-label * { box-sizing: border-box; }
    .gl-el { position: absolute; }
    .gl-in { position: absolute; transform-origin: center center; }
    .gl-t { display: flex; width: 100%; height: 100%; overflow: hidden; line-height: ${LINE_HEIGHT}; }
    .gl-s { display: block; max-width: 100%; min-width: 0; }
    .gl-nowrap { white-space: nowrap; overflow: hidden; }
    .gl-ell { text-overflow: ellipsis; }
    .gl-wrap { white-space: normal; overflow-wrap: anywhere; display: -webkit-box; -webkit-box-orient: vertical; overflow: hidden; }
    /* White behind the bars and quiet zones — scanners need light spaces, even over a box. */
    .gl-bc { position: relative; width: 100%; height: 100%; background: #fff; }
    .gl-bars { position: absolute; top: 0; display: block; overflow: visible; }
    .gl-bctext { position: absolute; bottom: 0; text-align: center; font-family: Arial, Helvetica, sans-serif;
      line-height: ${LINE_HEIGHT}; white-space: nowrap; overflow: hidden; letter-spacing: 0.04em; }
    .gl-qr { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; }
    .gl-qr svg { display: block; }
    .gl-line { position: absolute; }
    .gl-rect { width: 100%; height: 100%; }
    .gl-logo { width: 100%; height: 100%; background-repeat: no-repeat; background-position: center;
      ${safeLogo ? `background-image: url("${safeLogo}");` : ''} }
    .gl-err { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; text-align: center;
      font: 600 5pt Arial, sans-serif; color: #b91c1c; border: 0.2mm dashed #b91c1c; padding: 0.3mm; overflow: hidden; }
  `;
}

export function hasUsableLogo(logo) {
  return /^data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,/.test(String(logo || ''));
}

// De-duplicated, most severe first.
export function summarizeWarnings(list) {
  const order = { error: 0, warning: 1, info: 2 };
  const seen = new Set();
  return list
    .filter((w) => {
      const k = `${w.level}|${w.message}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => order[a.level] - order[b.level]);
}
