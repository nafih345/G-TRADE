'use strict';
// Print preview policy for the desktop shell. Pure functions only (no Electron imports), so every
// rule here is unit-tested with `node --test`.
//
// Why the shell has its own preview: Electron does not include Chromium's print-preview UI, so
// window.print() / webContents.print() go straight to the Windows print dialog, and the Windows 11
// dialog says "This app doesn't support print preview". The shell renders the document with
// printToPDF (the same print engine that produces the paper copy), shows those pages, and prints
// with exactly the page size it previewed.
//
// Facts verified on Electron 44 / Windows 11 (see windows/desktop/test/print-*.test.js and the
// print self-test): a valid CSS @page size wins over the requested paper only with
// preferCSSPageSize; CSS @page MARGINS always win over the margins option, in printToPDF AND in
// webContents.print (even marginType 'none'), so margin overrides are injected as CSS;
// `size: 80mm auto` is invalid CSS (Chromium drops it), so receipt length is measured.

const MM_PER_IN = 25.4;
const PT_PER_IN = 72;
const PX_PER_IN = 96;

/** Sheet sizes in portrait mm. Names are what webContents.print() accepts. */
const SHEETS = {
  A3: { w: 297, h: 420 },
  A4: { w: 210, h: 297 },
  A5: { w: 148, h: 210 },
  A6: { w: 105, h: 148 },
  Letter: { w: 215.9, h: 279.4 },
  Legal: { w: 215.9, h: 355.6 },
};

/** Paper choices offered in the preview. 'document' = the size the document was designed for. */
const PAPER_CHOICES = ['document', 'A4', 'A5', 'Letter'];
const MARGIN_CHOICES = { document: null, none: 0, narrow: 5, normal: 10 };
const ORIENTATIONS = ['portrait', 'landscape'];
const PDF_DESTINATION = '__save_as_pdf__';
const MAX_COPIES = 99;
const ROLL_MAX_MM = 3000; // longest receipt the shell will lay out on one page
const ROLL_MIN_MM = 20;
const NARROW_MAX_MM = 100; // receipt rolls (58 / 80 mm) are at most this wide
const LABEL_MAX_MM = 110; // 4-inch label printers take stock up to ~104 mm

const round1 = (n) => Math.round(n * 10) / 10;

// ---- CSS parsing -----------------------------------------------------------------------------

/** "8mm" / "0.5in" / "12pt" / "30px" / "1cm" / "0" -> millimetres, or null. */
function cssLengthToMm(text) {
  const m = /^\s*(-?\d*\.?\d+)\s*(mm|cm|in|pt|pc|px|q)?\s*$/i.exec(String(text ?? ''));
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = (m[2] || (n === 0 ? 'mm' : '')).toLowerCase();
  const factor = { mm: 1, cm: 10, in: MM_PER_IN, pt: MM_PER_IN / PT_PER_IN, pc: (MM_PER_IN / PT_PER_IN) * 12,
    px: MM_PER_IN / PX_PER_IN, q: 0.25 }[unit];
  return factor ? n * factor : null;
}

/**
 * A CSS @page `size` value -> { widthMm, heightMm, roll, named, orientation } or null.
 * `heightMm: null, roll: true` for "80mm auto" (continuous receipt roll; invalid CSS that the
 * frontend's thermal templates use, so the shell measures the length instead).
 */
function parsePageSize(text) {
  const raw = String(text ?? '').trim().replace(/\s*!important\s*$/i, '');
  if (!raw || /^auto$/i.test(raw)) return null;
  const parts = raw.split(/\s+/);
  let orientation = null;
  const rest = [];
  for (const p of parts) {
    if (/^(portrait|landscape)$/i.test(p)) orientation = p.toLowerCase();
    else rest.push(p);
  }
  if (rest.length === 0) return orientation ? { widthMm: null, heightMm: null, roll: false, named: null, orientation } : null;
  const named = Object.keys(SHEETS).find((k) => k.toLowerCase() === rest[0].toLowerCase());
  if (named && rest.length === 1) {
    const s = SHEETS[named];
    const land = orientation === 'landscape';
    return { widthMm: land ? s.h : s.w, heightMm: land ? s.w : s.h, roll: false, named, orientation: orientation || 'portrait' };
  }
  const w = cssLengthToMm(rest[0]);
  if (w === null || w <= 0) return null;
  if (rest.length === 1) return { widthMm: w, heightMm: w, roll: false, named: null, orientation }; // CSS: one length = square
  if (/^auto$/i.test(rest[1])) return { widthMm: w, heightMm: null, roll: true, named: null, orientation: null };
  const h = cssLengthToMm(rest[1]);
  if (h === null || h <= 0) return null;
  let width = w;
  let height = h;
  if (orientation === 'landscape' && height > width) [width, height] = [height, width];
  if (orientation === 'portrait' && width > height) [width, height] = [height, width];
  return { widthMm: width, heightMm: height, roll: false, named: null, orientation };
}

/** "4mm" | "3mm 5mm" | "1mm 2mm 3mm" | "1mm 2mm 3mm 4mm" -> {top,right,bottom,left} in mm, or null. */
function parseMarginShorthand(text) {
  const parts = String(text ?? '').replace(/!important/i, '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length || parts.length > 4) return null;
  const v = parts.map(cssLengthToMm);
  if (v.some((x) => x === null)) return null;
  const [t, r = t, b = t, l = r] = v;
  return { top: t, right: r, bottom: b, left: l };
}

/** Last plain `@page { ... }` size declaration in raw stylesheet text (catches invalid ones like "80mm auto"). */
function findRawPageSize(cssText) {
  let found = null;
  const re = /@page\s*(?::[a-z-]+\s*)?\{([^}]*)\}/gi;
  let m;
  while ((m = re.exec(String(cssText ?? '')))) {
    if (/^@page\s*:/i.test(m[0])) continue; // :first / :left / :right
    const size = /(?:^|[;{\s])size\s*:\s*([^;}]+)/i.exec(m[1]);
    if (size) found = size[1].trim();
  }
  return found;
}

// ---- the document being printed ----------------------------------------------------------------

/**
 * Turn the in-page probe (see PROBE_SCRIPT) into what the preview needs:
 *   { title, kind: 'sheet'|'receipt'|'label'|'screen', size: parsePageSize()|null, cssSize: bool,
 *     roll: bool, marginsMm: {top,right,bottom,left}|null }
 * kind: 'screen' = no @page size (an app screen printed as-is), 'receipt' = narrow or roll,
 * 'label' = sticker stock (hinted by the page, or small fixed pages), 'sheet' otherwise.
 */
function describeDocument(probe = {}) {
  const title = String(probe.title || '').replace(/[​\s]+/g, ' ').trim();
  let size = probe.cssSize ? parsePageSize(probe.cssSize) : null;
  // `size: landscape` alone: no paper size, but Chromium still turns the page.
  const orientation = (size && size.orientation) || 'portrait';
  const cssSize = Boolean(size && size.widthMm && size.heightMm);
  if (!cssSize) {
    const raw = probe.rawSize ? parsePageSize(probe.rawSize) : null;
    size = raw && raw.roll ? raw : null;
  }
  const marginsMm = probe.margin ? parseMarginShorthand(probe.margin) : null;
  const hint = String(probe.hint || '').toLowerCase();
  let kind = 'screen';
  if (size && size.roll) kind = 'receipt';
  else if (cssSize) {
    // A "label" hint on an A4 sheet of labels still means a sheet printer.
    if (hint === 'label' && size.widthMm <= LABEL_MAX_MM) kind = 'label';
    else if (hint === 'receipt' && size.widthMm <= NARROW_MAX_MM) kind = 'receipt';
    else if (!hint && size.widthMm <= NARROW_MAX_MM && size.heightMm <= 60) kind = 'label';
    else if (size.widthMm <= NARROW_MAX_MM) kind = 'receipt';
    else kind = 'sheet';
  }
  return { title, kind, size, cssSize, roll: Boolean(size && size.roll), marginsMm, orientation };
}

/** Receipt-roll page length for a measured content height (mm), clamped. */
function rollLengthMm(contentMm, marginsMm) {
  const m = marginsMm || { top: 10, bottom: 10 };
  const len = Math.ceil((Number(contentMm) || 0) + m.top + m.bottom + 3);
  return Math.min(ROLL_MAX_MM, Math.max(ROLL_MIN_MM, len));
}

/** The page margins in force (mm): an override, the document's own @page margin, or Chromium's 1 cm default. */
function effectiveMarginsMm(settings, doc) {
  const o = MARGIN_CHOICES[settings.margins];
  if (o !== null && o !== undefined) return { top: o, right: o, bottom: o, left: o };
  return doc.marginsMm || { top: 10, right: 10, bottom: 10, left: 10 };
}

// ---- settings coming from the preview page -----------------------------------------------------

/** Only these settings ever reach printToPDF / print(); everything else is dropped. */
function sanitizeSettings(input = {}) {
  const s = input && typeof input === 'object' ? input : {};
  const destination = typeof s.destination === 'string' && s.destination.length > 0 && s.destination.length <= 256
    && !/[\u0000-\u001f]/.test(s.destination) ? s.destination : PDF_DESTINATION;
  const paper = PAPER_CHOICES.includes(s.paper) ? s.paper : 'document';
  const orientation = ORIENTATIONS.includes(s.orientation) ? s.orientation : 'portrait';
  const margins = Object.prototype.hasOwnProperty.call(MARGIN_CHOICES, s.margins) ? s.margins : 'document';
  const copies = Number(s.copies);
  return { destination, paper, orientation, margins,
    copies: Number.isInteger(copies) && copies >= 1 ? Math.min(copies, MAX_COPIES) : 1 };
}

/** True when the orientation choice can change anything: the document does not fix its own page size. */
function orientationApplies(doc, settings) {
  return !doc.cssSize && !doc.roll && (settings.paper !== 'document' || doc.kind === 'screen');
}

/**
 * The render plan for one set of settings:
 *   { pdfOptions, css (string injected into the page while rendering/printing, or ''), needsRollLength }
 * `rollLengthMm` (measured) is required when needsRollLength is true.
 */
function buildRenderPlan(settings, doc, rollLength = null) {
  const s = sanitizeSettings(settings);
  const css = [];
  const margin = MARGIN_CHOICES[s.margins];
  if (margin !== null && margin !== undefined) css.push(`@page { margin: ${margin}mm !important; }`);
  const pdfOptions = { printBackground: true, preferCSSPageSize: false, landscape: false };
  let needsRollLength = false;
  if (s.paper === 'document') {
    if (doc.roll) {
      needsRollLength = true;
      const h = rollLength || rollLengthMm(0, effectiveMarginsMm(s, doc));
      pdfOptions.pageSize = { width: doc.size.widthMm / MM_PER_IN, height: h / MM_PER_IN };
    } else if (doc.cssSize) {
      pdfOptions.preferCSSPageSize = true;
      pdfOptions.pageSize = 'A4';
    } else {
      pdfOptions.pageSize = 'A4';
      pdfOptions.landscape = s.orientation === 'landscape';
    }
  } else {
    pdfOptions.pageSize = s.paper;
    if (orientationApplies(doc, s)) pdfOptions.landscape = s.orientation === 'landscape';
  }
  return { settings: s, pdfOptions, css: css.join('\n'), needsRollLength };
}

/**
 * webContents.print() options that reproduce a rendered preview page on paper. The page size is
 * taken from the PDF the user just looked at, so the printer is asked for exactly that paper:
 * standard sheets by name (rotated ones as landscape), anything else (receipts, labels) as an
 * exact size in microns.
 */
function buildPrintOptions(settings, pageMm, { silent = true } = {}) {
  const s = sanitizeSettings(settings);
  const out = { silent: Boolean(silent), printBackground: true, margins: { marginType: 'default' }, copies: s.copies };
  if (s.destination !== PDF_DESTINATION) out.deviceName = s.destination;
  const match = matchSheet(pageMm.widthMm, pageMm.heightMm);
  if (match) {
    out.pageSize = match.name;
    if (match.landscape) out.landscape = true;
  } else {
    out.pageSize = { width: Math.round(pageMm.widthMm * 1000), height: Math.round(pageMm.heightMm * 1000) };
  }
  return out;
}

/** {name, landscape} when (w, h) is a standard sheet within 1.5 mm, else null. */
function matchSheet(widthMm, heightMm, tol = 1.5) {
  for (const [name, s] of Object.entries(SHEETS)) {
    if (Math.abs(widthMm - s.w) <= tol && Math.abs(heightMm - s.h) <= tol) return { name, landscape: false };
    if (Math.abs(widthMm - s.h) <= tol && Math.abs(heightMm - s.w) <= tol) return { name, landscape: true };
  }
  return null;
}

/** "A4 portrait · 210 × 297 mm", "Receipt · 80 × 142 mm", "Label · 38 × 25 mm", "100.5 × 50.5 mm". */
function describePaper(widthMm, heightMm, kind = '') {
  const dims = `${fmtMm(widthMm)} × ${fmtMm(heightMm)} mm`;
  const sheet = matchSheet(widthMm, heightMm);
  if (sheet) return `${sheet.name} ${sheet.landscape ? 'landscape' : 'portrait'} · ${dims}`;
  if (kind === 'receipt') return `Receipt · ${dims}`;
  if (kind === 'label') return `Label · ${dims}`;
  return dims;
}

// PDF sizes are whole points, so A4 comes back as 209.9 x 297 mm: show whole millimetres when close.
const fmtMm = (n) => (Math.abs(n - Math.round(n)) <= 0.35 ? String(Math.round(n)) : String(round1(n)));

// ---- the PDF that printToPDF returns -------------------------------------------------------------

/** { pages, widthMm, heightMm } of a Chromium (Skia) PDF: page count + first page MediaBox. */
function pdfInfo(buf) {
  const s = Buffer.isBuffer(buf) ? buf.toString('latin1') : Buffer.from(buf || []).toString('latin1');
  if (!s.startsWith('%PDF-')) return { pages: 0, widthMm: 0, heightMm: 0 };
  const box = /\/MediaBox\s*\[\s*([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s*\]/.exec(s);
  const toMm = (pt) => round1((pt * MM_PER_IN) / PT_PER_IN);
  // Skia writes every page object uncompressed: count them; /Count of the page tree is the fallback.
  let pages = (s.match(/\/Type\s*\/Page(?![a-zA-Z])/g) || []).length;
  if (!pages) {
    const counts = [...s.matchAll(/\/Count\s+(\d+)/g)].map((m) => Number(m[1]));
    pages = counts.length ? Math.max(...counts) : 0;
  }
  return {
    pages,
    widthMm: box ? toMm(Number(box[3]) - Number(box[1])) : 0,
    heightMm: box ? toMm(Number(box[4]) - Number(box[2])) : 0,
  };
}

// ---- printers ------------------------------------------------------------------------------------

const VIRTUAL_PORTS = /^(portprompt:|file:|nul:?|xpsport:|shrfax:|ne\d+:)$/i;
const VIRTUAL_DRIVER = /(print to pdf|xps document writer|onenote|\bfax\b|pdf|virtual printer|anydesk|image writer|send to|document writer|snagit|cutepdf|bullzip|dopdf|novapdf|pdfcreator)/i;

/**
 * Physical (makes paper) or virtual (makes a file / sends it elsewhere). Windows' own inventory
 * (port + driver) decides when available; otherwise the name alone.
 */
function classifyPrinter({ name = '', driverName = '', portName = '' } = {}) {
  const text = `${name} ${driverName}`;
  let type = 'physical';
  if (/onenote/i.test(text)) type = 'onenote';
  else if (/\bfax\b/i.test(text) || /^shrfax:/i.test(portName)) type = 'fax';
  else if (/xps/i.test(text)) type = 'xps';
  else if (/pdf/i.test(text)) type = 'pdf';
  else if (/anydesk|teamviewer|remote desktop easy print/i.test(text)) type = 'remote';
  else if (VIRTUAL_DRIVER.test(text) || (portName && VIRTUAL_PORTS.test(portName.trim()))) type = 'virtual';
  // A redirected printer from a Remote Desktop session (port TS001...) still prints on paper.
  return { type, virtual: type !== 'physical' };
}

const PRINTER_STATUS = { 1: 'Other', 2: 'Unknown', 3: 'Ready', 4: 'Printing', 5: 'Warming up', 6: 'Stopped', 7: 'Offline' };

/** Parse `Get-CimInstance Win32_Printer | ConvertTo-Json` output (object or array) -> normalized list. */
function parsePrinterInventory(jsonText) {
  let data;
  try { data = JSON.parse(String(jsonText || '').replace(/^﻿/, '')); } catch { return null; }
  if (!data) return [];
  const rows = Array.isArray(data) ? data : [data];
  return rows.filter((r) => r && typeof r.Name === 'string' && r.Name).map((r) => {
    const offline = r.WorkOffline === true || r.PrinterStatus === 7;
    return {
      name: r.Name,
      isDefault: r.Default === true,
      portName: String(r.PortName || ''),
      driverName: String(r.DriverName || ''),
      network: r.Network === true,
      offline,
      status: offline ? 'Offline' : (PRINTER_STATUS[r.PrinterStatus] || ''),
      paperNames: Array.isArray(r.PrinterPaperNames) ? r.PrinterPaperNames.filter((p) => typeof p === 'string').slice(0, 200) : [],
    };
  });
}

/**
 * Electron's printer list (names the print backend accepts) merged with Windows' inventory.
 * Electron's list is authoritative for WHICH printers exist; the inventory adds default / port /
 * driver / status. Sorted: physical first (default first), then virtual.
 */
function mergePrinters(electronList = [], inventory = null) {
  const inv = new Map((inventory || []).map((p) => [p.name.toLowerCase(), p]));
  const list = (electronList || []).filter((p) => p && typeof p.name === 'string' && p.name).map((p) => {
    const w = inv.get(p.name.toLowerCase()) || {};
    const cls = classifyPrinter({ name: p.name, driverName: w.driverName || '', portName: w.portName || '' });
    return {
      name: p.name,
      displayName: p.displayName || p.name,
      isDefault: Boolean(w.isDefault || p.isDefault),
      type: cls.type,
      virtual: cls.virtual,
      offline: Boolean(w.offline),
      status: w.status || '',
      driverName: w.driverName || '',
      portName: w.portName || '',
      paperNames: w.paperNames || [],
    };
  });
  list.sort((a, b) => (a.virtual - b.virtual) || (b.isDefault - a.isDefault) || a.displayName.localeCompare(b.displayName));
  return { printers: list, hasPhysical: list.some((p) => !p.virtual), inventoryAvailable: Array.isArray(inventory) };
}

const KIND_NAME_HINTS = {
  receipt: /(thermal|receipt|\bpos\b|tm-?[tmu]\d|xp-?\d|rp-?\d|80\s?mm|58\s?mm|epson tm|bixolon|citizen ct|star tsp|xprinter|rongta|sewoo|tvs rp)/i,
  label: /(label|zebra|\btsc\b|godex|argox|\bte\d{3}\b|\bttp\b|brother ql|dymo|honeywell pc|sato)/i,
};

/**
 * Which destination the preview starts on: the printer last used for this kind of document,
 * else Windows' default if it makes paper, else a physical printer whose name suits the document,
 * else any physical printer, else Save as PDF.
 */
function chooseDestination(printers, kind, remembered) {
  const list = printers || [];
  // The user's own last choice for this kind of document wins (a deliberate "Save as PDF" too).
  if (remembered === PDF_DESTINATION) return PDF_DESTINATION;
  if (remembered && list.some((p) => p.name === remembered)) return remembered;
  const usable = list.filter((p) => !p.virtual);
  if (!usable.length) return PDF_DESTINATION;
  const def = usable.find((p) => p.isDefault);
  const hint = KIND_NAME_HINTS[kind];
  if (hint) {
    const byName = usable.find((p) => hint.test(`${p.name} ${p.driverName}`));
    if (byName) return byName.name;
  } else {
    if (def) return def.name;
    const sheetPrinter = usable.find((p) => !KIND_NAME_HINTS.receipt.test(`${p.name} ${p.driverName}`)
      && !KIND_NAME_HINTS.label.test(`${p.name} ${p.driverName}`));
    if (sheetPrinter) return sheetPrinter.name;
  }
  return (def || usable[0]).name;
}

/** Warnings shown next to the destination before printing. */
function destinationWarnings(printer, pageMm, kind) {
  const out = [];
  if (!printer) return out;
  if (printer.offline) out.push(`${printer.displayName} is offline. Check that it is switched on and connected, or choose another printer.`);
  const sheet = matchSheet(pageMm.widthMm, pageMm.heightMm);
  if (printer.virtual && !sheet && pageMm.widthMm > 0) {
    out.push(`${printer.displayName} makes a file, not paper, and supports standard sheet sizes only — this ${kind === 'label' ? 'label' : 'receipt'} would be placed on a full sheet. Use “Save as PDF” for an exact-size PDF.`);
  }
  return out;
}

/** Human text for webContents.print()'s failure reason. */
function printFailureMessage(reason) {
  const r = String(reason || '').trim();
  if (!r) return 'The printer did not accept the job.';
  if (/cancel/i.test(r)) return 'Printing was cancelled.';
  if (/invalid deviceName|no printer|printer.*not.*found/i.test(r)) return 'That printer is no longer available. Refresh the printer list and choose another printer.';
  if (/failed/i.test(r)) return 'Windows could not print to this printer. Check that it is switched on, connected and has paper, then try again.';
  return `The printer reported: ${r.slice(0, 200)}`;
}

/** A safe default file name for Save as PDF. */
function pdfFileName(title, now = new Date()) {
  const clean = String(title || '').replace(/[​]/g, '').replace(/[<>:"/\\|?*\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '').slice(0, 120);
  const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const base = clean && !/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(clean) ? clean : `Document ${stamp}`;
  return `${base}.pdf`;
}

// ---- in-page scripts (run in an isolated world of the page being printed) -------------------------

/** Reads the document's own @page rules, title and print-kind hint. No side effects. */
const PROBE_SCRIPT = `(() => {
  const out = { title: document.title || '', cssSize: null, rawSize: null, margin: null, hint: '' };
  const mediaOk = (m) => { const t = String(m && m.mediaText || '').toLowerCase(); return !t || /\\b(print|all)\\b/.test(t); };
  const visit = (rules) => {
    for (const r of Array.from(rules || [])) {
      if (r.type === 6 && !r.selectorText) {
        const size = r.style.getPropertyValue('size');
        if (size) out.cssSize = size.trim();
        const mt = r.style.getPropertyValue('margin-top');
        if (mt) out.margin = [mt, r.style.getPropertyValue('margin-right'), r.style.getPropertyValue('margin-bottom'), r.style.getPropertyValue('margin-left')].map((x) => x || mt).join(' ');
      } else if (r.cssRules && (r.type !== 4 || mediaOk(r.media))) {
        visit(r.cssRules);
      }
    }
  };
  for (const sheet of Array.from(document.styleSheets)) {
    try { if (mediaOk(sheet.media)) visit(sheet.cssRules); } catch (e) { /* cross-origin sheet */ }
  }
  const raw = Array.from(document.querySelectorAll('style')).map((s) => s.textContent || '').join('\\n');
  const re = /@page\\s*\\{([^}]*)\\}/gi; let m;
  while ((m = re.exec(raw))) { const s = /(?:^|[;{\\s])size\\s*:\\s*([^;}]+)/i.exec(m[1]); if (s) out.rawSize = s[1].trim(); }
  const meta = document.querySelector('meta[name="gtrade-print-kind"]');
  if (meta) out.hint = String(meta.getAttribute('content') || '').trim().toLowerCase().slice(0, 20);
  return out;
})()`;

/**
 * Content height (mm) when laid out at `contentWidthMm` — for receipt rolls. The width is set,
 * measured and restored inside one synchronous script, so nothing is ever painted in between.
 */
function measureScript(contentWidthMm) {
  const w = Math.max(10, Math.min(400, Number(contentWidthMm) || 72));
  return `(() => {
    const de = document.documentElement; const body = document.body;
    if (!body) return 0;
    const prev = de.style.width;
    de.style.width = '${w}mm';
    let bottom = 0; let n = 0;
    const all = body.getElementsByTagName('*');
    for (let i = 0; i < all.length && n < 8000; i += 1, n += 1) {
      const r = all[i].getBoundingClientRect();
      if (r.width > 0 || r.height > 0) bottom = Math.max(bottom, r.bottom);
    }
    const cs = getComputedStyle(body);
    bottom = Math.max(bottom, body.getBoundingClientRect().bottom + (parseFloat(cs.marginBottom) || 0) + (parseFloat(cs.paddingBottom) || 0));
    bottom += window.scrollY || 0;
    de.style.width = prev;
    return Math.round(bottom * 25.4 / 96 * 10) / 10;
  })()`;
}

module.exports = {
  SHEETS, PAPER_CHOICES, MARGIN_CHOICES, PDF_DESTINATION, MAX_COPIES, ROLL_MAX_MM,
  cssLengthToMm, parsePageSize, parseMarginShorthand, findRawPageSize, describeDocument, rollLengthMm,
  effectiveMarginsMm, sanitizeSettings, orientationApplies, buildRenderPlan, buildPrintOptions, matchSheet,
  describePaper, pdfInfo, classifyPrinter, parsePrinterInventory, mergePrinters, chooseDestination,
  destinationWarnings, printFailureMessage, pdfFileName, PROBE_SCRIPT, measureScript,
};
