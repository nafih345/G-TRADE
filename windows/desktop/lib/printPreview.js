'use strict';
// Print preview controller (main process).
//
// Every page of the app reaches this through window.print() (preload.js replaces it), so bills,
// receipts, labels, prescriptions, eye-test reports and accounting reports — main window or
// print pop-up — all get the same preview:
//   1. read the document's own @page size / margins (isolated world, read-only),
//   2. render it with printToPDF (Chromium's print engine; what Windows receives is laid out the
//      same way) and show those pages in a preview window,
//   3. print with webContents.print({silent:true}) on the chosen printer, asking for exactly the
//      paper the preview showed — or save the previewed PDF.
// The Windows print dialog is only opened when the user asks for it ("Windows print dialog…").

const fs = require('node:fs');
const path = require('node:path');
const P = require('./printing');

const PROBE_WORLD = 1771; // isolated world for the probe; never the preload's (999)
const ROLL_GROW_MM = 15;

function createPrintPreview({
  electron, pagePath, preloadPath, basePrefs, prefs, inventory, isPackaged = false,
  chooseSavePath = null, log = () => {}, showWindows = true,
}) {
  const { BrowserWindow, dialog, shell, screen, app } = electron;
  const jobs = new Map(); // preview webContents id -> job
  const bySource = new Map(); // source webContents id -> job
  const listeners = new Set();
  let seq = 0;

  const emit = (event, job, data = {}) => {
    for (const fn of listeners) { try { fn(event, job, data); } catch { /* observer only */ } }
  };

  // ---- serialisation: one render/print at a time per document (insertCSS is shared state) ----
  const exclusive = (job, fn) => {
    const run = job.chain.then(fn, fn);
    job.chain = run.catch(() => {});
    return run;
  };

  function previewBounds(parent) {
    let area = { x: 0, y: 0, width: 1280, height: 800 };
    try {
      area = (parent && !parent.isDestroyed() ? screen.getDisplayMatching(parent.getBounds()) : screen.getPrimaryDisplay()).workArea;
    } catch { /* defaults */ }
    const width = Math.min(1180, Math.round(area.width * 0.94));
    const height = Math.min(880, Math.round(area.height * 0.94));
    return { width, height, x: Math.round(area.x + (area.width - width) / 2), y: Math.round(area.y + (area.height - height) / 2) };
  }

  async function probe(source) {
    try {
      return await source.executeJavaScriptInIsolatedWorld(PROBE_WORLD, [{ code: P.PROBE_SCRIPT }]);
    } catch (err) {
      log('print probe failed', String(err && err.message || err));
      return {};
    }
  }

  /**
   * Open (or focus) the preview for `source`. Resolves when the preview closes:
   * {outcome: 'printed'|'saved'|'cancelled', printer, path}. Rejects only if the preview could not
   * be set up, so the page falls back to the native print path (preload.js).
   */
  function open(source) {
    if (!source || source.isDestroyed()) return Promise.reject(new Error('There is nothing to print.'));
    // One preview per window: a double-click on Print (two print() calls a few ms apart) or a
    // second print() while the preview is up just brings the same preview forward.
    const existing = bySource.get(source.id);
    if (existing) {
      if (existing.win && !existing.win.isDestroyed()) existing.win.focus();
      return existing.done;
    }
    const job = { id: (seq += 1), source, parent: BrowserWindow.fromWebContents(source), doc: null, chain: Promise.resolve(),
      last: null, sourceGone: false, outcome: 'cancelled', printer: '', savedPath: '', renders: 0, win: null };
    job.done = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
    bySource.set(source.id, job);
    setup(job).catch((err) => {
      log('print preview could not open', String(err && err.stack || err));
      bySource.delete(source.id);
      if (job.win && !job.win.isDestroyed()) job.win.destroy();
      job.reject(err);
    });
    return job.done;
  }

  async function setup(job) {
    const { source, parent } = job;
    job.doc = P.describeDocument(await probe(source));
    const { doc } = job;
    job.win = new BrowserWindow({
      ...previewBounds(parent), parent: parent || undefined, modal: Boolean(parent), show: false,
      minWidth: 760, minHeight: 520, minimizable: false, autoHideMenuBar: true, backgroundColor: '#525659',
      title: `Print preview${doc.title ? ` — ${doc.title}` : ''}`,
      webPreferences: { ...basePrefs, preload: preloadPath, plugins: true, spellcheck: false, devTools: !isPackaged },
    });
    job.win.removeMenu();
    const previewId = job.win.webContents.id;
    jobs.set(previewId, job);
    bySource.set(source.id, job);

    const onSourceGone = () => {
      job.sourceGone = true;
      if (!job.win.isDestroyed()) job.win.webContents.send('preview:source-gone');
    };
    source.once('destroyed', onSourceGone);
    if (showWindows) {
      const show = () => { if (!job.win.isDestroyed() && !job.win.isVisible()) job.win.show(); };
      job.win.once('ready-to-show', show);
      setTimeout(show, 3000); // never leave an invisible modal window behind
    }
    job.win.on('closed', () => {
      jobs.delete(previewId);
      bySource.delete(source.id);
      if (!source.isDestroyed()) source.removeListener('destroyed', onSourceGone);
      if (parent && !parent.isDestroyed()) parent.focus();
      emit('closed', job);
      job.resolve({ outcome: job.outcome, printer: job.printer, path: job.savedPath ? path.basename(job.savedPath) : '' });
    });
    emit('opened', job);
    job.win.loadFile(pagePath).catch((err) => log('print preview page failed to load', String(err)));
  }

  // ---- render ----------------------------------------------------------------------------------
  const geometryKey = (s) => `${s.paper}|${s.orientation}|${s.margins}`;

  async function renderLocked(job, settings) {
    const s = P.sanitizeSettings(settings);
    if (job.last && job.last.key === geometryKey(s)) return job.last;
    const { source, doc } = job;
    if (job.sourceGone || source.isDestroyed()) throw new Error('The document window was closed, so it can no longer be printed.');
    let plan = P.buildRenderPlan(s, doc);
    let cssKey = null;
    let rollLength = null;
    try {
      if (plan.css) cssKey = await source.insertCSS(plan.css, { cssOrigin: 'author' });
      if (plan.needsRollLength) {
        const m = P.effectiveMarginsMm(s, doc);
        const contentMm = Number(await source.executeJavaScriptInIsolatedWorld(PROBE_WORLD,
          [{ code: P.measureScript(doc.size.widthMm - m.left - m.right) }])) || 0;
        rollLength = P.rollLengthMm(contentMm, m);
        plan = P.buildRenderPlan(s, doc, rollLength);
      }
      let pdf = await source.printToPDF(plan.pdfOptions);
      let info = P.pdfInfo(pdf);
      // A receipt roll must come out as ONE page: if the measurement fell short, lengthen a little
      // at a time (paper is wasted by over-long receipts), then jump if it is still split.
      for (let i = 0; plan.needsRollLength && info.pages > 1 && i < 8 && rollLength < P.ROLL_MAX_MM; i += 1) {
        rollLength = Math.min(P.ROLL_MAX_MM, i < 6 ? rollLength + ROLL_GROW_MM : rollLength * info.pages);
        plan = P.buildRenderPlan(s, doc, rollLength);
        pdf = await source.printToPDF(plan.pdfOptions);
        info = P.pdfInfo(pdf);
      }
      job.renders += 1;
      job.last = { key: geometryKey(s), plan, pdf, info, rollLength };
      return job.last;
    } finally {
      if (cssKey) await source.removeInsertedCSS(cssKey).catch(() => {});
    }
  }

  async function render(job, settings) {
    const r = await exclusive(job, () => renderLocked(job, settings));
    const out = {
      pdf: new Uint8Array(r.pdf.buffer, r.pdf.byteOffset, r.pdf.byteLength), pages: r.info.pages,
      widthMm: r.info.widthMm, heightMm: r.info.heightMm, paper: P.describePaper(r.info.widthMm, r.info.heightMm, job.doc.kind),
      rollLengthMm: r.rollLength,
    };
    emit('rendered', job, { pages: out.pages, widthMm: out.widthMm, heightMm: out.heightMm });
    return out;
  }

  // ---- printers --------------------------------------------------------------------------------
  async function printers(job, { refresh = false } = {}) {
    const [list, inv] = await Promise.all([
      job.win.webContents.getPrintersAsync().catch(() => []),
      inventory ? inventory.get({ refresh }) : Promise.resolve(null),
    ]);
    const merged = P.mergePrinters(list, inv);
    merged.selected = P.chooseDestination(merged.printers, job.doc.kind, prefs.lastDestination(job.doc.kind));
    return merged;
  }

  // ---- print / save ----------------------------------------------------------------------------
  async function print(job, settings, { silent = true } = {}) {
    const s = P.sanitizeSettings(settings);
    if (silent && s.destination === P.PDF_DESTINATION) throw new Error('Choose a printer, or use Save as PDF.');
    return exclusive(job, async () => {
      const r = await renderLocked(job, s);
      const opts = P.buildPrintOptions(s, r.info, { silent });
      const { source } = job;
      let cssKey = null;
      let result;
      try {
        if (r.plan.css) cssKey = await source.insertCSS(r.plan.css, { cssOrigin: 'author' });
        result = await new Promise((resolve) => {
          source.print(opts, (ok, reason) => resolve({ ok: Boolean(ok), reason: ok ? '' : String(reason || '') }));
        });
      } finally {
        if (cssKey && !source.isDestroyed()) await source.removeInsertedCSS(cssKey).catch(() => {});
      }
      emit('printed', job, { ...result, options: opts });
      if (!result.ok) {
        return { ok: false, cancelled: /cancel/i.test(result.reason), reason: result.reason, message: P.printFailureMessage(result.reason) };
      }
      job.outcome = 'printed';
      job.printer = opts.deviceName || '';
      if (silent && opts.deviceName) prefs.remember(job.doc.kind, opts.deviceName);
      const copies = opts.copies > 1 ? `${opts.copies} copies` : '1 copy';
      return { ok: true, message: silent ? `Sent ${copies} to ${opts.deviceName}.` : 'Sent to the printer chosen in the Windows dialog.' };
    });
  }

  async function savePdf(job, settings) {
    const s = P.sanitizeSettings(settings);
    const r = await exclusive(job, () => renderLocked(job, s));
    const defaultPath = path.join(app.getPath('documents'), P.pdfFileName(job.doc.title));
    let target;
    if (chooseSavePath) {
      target = await chooseSavePath(job, defaultPath);
    } else {
      const res = await dialog.showSaveDialog(job.win, {
        title: 'Save as PDF', defaultPath, buttonLabel: 'Save',
        filters: [{ name: 'PDF document', extensions: ['pdf'] }], properties: ['showOverwriteConfirmation'],
      });
      target = res.canceled ? null : res.filePath;
    }
    if (!target) return { ok: false, cancelled: true };
    if (!/\.pdf$/i.test(target)) target = `${target}.pdf`;
    await fs.promises.writeFile(target, r.pdf);
    job.savedPath = target;
    if (job.outcome !== 'printed') job.outcome = 'saved';
    if (s.destination === P.PDF_DESTINATION) prefs.remember(job.doc.kind, P.PDF_DESTINATION);
    emit('saved', job, { path: target, bytes: r.pdf.length });
    return { ok: true, name: path.basename(target), folder: path.dirname(target) };
  }

  function info(job) {
    const { doc } = job;
    // Short enough for the dropdown; the exact size in mm is shown under the title.
    const sheet = doc.cssSize ? P.matchSheet(doc.size.widthMm, doc.size.heightMm) : null;
    let designed = '';
    if (doc.roll) designed = `${Math.round(doc.size.widthMm)} mm receipt roll`;
    else if (sheet) designed = `${sheet.name} ${sheet.landscape ? 'landscape' : 'portrait'}`;
    else if (doc.cssSize) designed = P.describePaper(doc.size.widthMm, doc.size.heightMm, doc.kind);
    const m = doc.marginsMm;
    return {
      title: doc.title, kind: doc.kind, designed, cssSize: doc.cssSize, roll: doc.roll,
      margins: m ? `${[m.top, m.right, m.bottom, m.left].map((x) => Math.round(x * 10) / 10).join(' / ')} mm` : '',
      orientationFixed: doc.cssSize || doc.roll,
      defaults: { paper: 'document', orientation: doc.orientation || 'portrait', margins: 'document', copies: 1 },
      sourceGone: job.sourceGone,
    };
  }

  // ---- IPC (the preview page only; every call is bound to that page's own job) -----------------
  function jobFor(event) {
    const job = jobs.get(event.sender.id);
    if (!job) throw new Error('Not allowed');
    return job;
  }

  function registerIpc(handle) {
    handle('preview:init', (e) => info(jobFor(e)));
    handle('preview:render', (e, s) => render(jobFor(e), s));
    handle('preview:printers', (e, o) => printers(jobFor(e), { refresh: Boolean(o && o.refresh) }));
    handle('preview:print', (e, s) => print(jobFor(e), s, { silent: true }));
    handle('preview:systemDialog', (e, s) => print(jobFor(e), s, { silent: false }));
    handle('preview:savePdf', (e, s) => savePdf(jobFor(e), s));
    handle('preview:reveal', (e, how) => {
      const job = jobFor(e);
      if (!job.savedPath) return false;
      if (how === 'open') return shell.openPath(job.savedPath).then((err) => !err);
      shell.showItemInFolder(job.savedPath);
      return true;
    });
    handle('preview:close', (e) => { const job = jobFor(e); setImmediate(() => { if (!job.win.isDestroyed()) job.win.close(); }); return true; });
  }

  return {
    open, registerIpc, jobs, bySource,
    on: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    // for the self-test / smoke: drive a job without the UI
    _render: render, _print: print, _savePdf: savePdf, _printers: printers, _info: info,
  };
}

/** Remembers the destination last used per kind of document (receipt / label / sheet / screen). */
function createPrintPrefs({ file, readJson, writeJsonAtomic, persist = true }) {
  let data = (persist && file && readJson(file)) || {};
  if (typeof data !== 'object' || Array.isArray(data)) data = {};
  const last = data.lastDestination && typeof data.lastDestination === 'object' ? { ...data.lastDestination } : {};
  return {
    lastDestination: (kind) => (typeof last[kind] === 'string' ? last[kind] : ''),
    remember(kind, destination) {
      if (!kind || typeof destination !== 'string' || destination.length > 256) return;
      if (last[kind] === destination) return;
      last[kind] = destination;
      if (!persist || !file) return;
      try { writeJsonAtomic(file, { version: 1, lastDestination: last }); } catch { /* best effort */ }
    },
  };
}

module.exports = { createPrintPreview, createPrintPrefs, PROBE_WORLD };
