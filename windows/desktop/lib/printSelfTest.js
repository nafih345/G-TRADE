'use strict';
// Print self-test of the desktop build itself:
//   G-TRADE.exe --print-selftest=C:\path\result.json [--print-selftest-printer="Printer name"]
// Serves the bundled sample documents (pages/print-selftest) from 127.0.0.1, prints each one the
// way the app does (window.print() in a window, and from an about:blank pop-up), and drives the
// real preview window: render, paper / orientation / margin changes, Save as PDF, and — only when
// a printer is named — a real print job on that printer. Writes JSON + a screenshot per preview.
// No server, database or user data is touched.

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const P = require('./printing');

// Expected geometry of each sample (mm). `change` is applied through the preview's own controls.
const DOCS = [
  // double: print() twice in a row (a double-click on Print) must open ONE preview.
  { file: 'a4-invoice.html', kind: 'sheet', size: [210, 297], pages: 1, change: ['paper', 'A5'], changed: [148, 210], print: true, double: true },
  { file: 'a5-prescription.html', kind: 'sheet', size: [148, 210], pages: 1, print: true },
  { file: 'receipt-roll.html', kind: 'receipt', width: 80, height: [45, 160], pages: 1, change: ['margins', 'none'], print: true },
  { file: 'receipt-fixed.html', kind: 'receipt', size: [80, 130], pages: 1 },
  { file: 'labels.html', kind: 'label', size: [38, 25], pages: 3, print: true },
  { file: 'report-screen.html', kind: 'screen', size: [210, 297], minPages: 1, change: ['orientation', 'landscape'], changed: [297, 210] },
  { file: 'a4-landscape.html', kind: 'sheet', size: [297, 210], pages: 1 },
];
const RESULT_MESSAGE = /^(Sent|Printing was cancelled|The printer|Windows could not|That printer)/;

const near = (a, b, tol = 1.5) => Math.abs(Number(a) - Number(b)) <= tol;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, test, { timeout = 30000, every = 150, what = 'condition' } = {}) {
  const until = Date.now() + timeout;
  let last;
  while (Date.now() < until) {
    try { last = await fn(); if (test(last)) return last; } catch (err) { last = { error: String(err && err.message || err) }; }
    await sleep(every);
  }
  throw new Error(`Timed out waiting for ${what}: ${JSON.stringify(last)}`);
}

// ---- driving one preview window through its own UI ---------------------------------------------
const state = async (job) => (job.win.isDestroyed() ? { closed: true }
  : job.win.webContents.executeJavaScript('window.__printPreviewState ? window.__printPreviewState() : null').catch(() => ({ closed: true })));
const ui = (job, code) => job.win.webContents.executeJavaScript(`(() => { ${code} })()`, true);
const setControl = (job, id, value) => ui(job, `const n = document.getElementById(${JSON.stringify(id)}); n.value = ${JSON.stringify(value)};
  n.dispatchEvent(new Event('change', { bubbles: true })); return n.value;`);
const waitReady = (job, minRenders, what) => waitFor(() => state(job),
  (s) => s && s.state === 'ready' && !s.busy && s.renders >= minRenders && s.frameIsPdfBlob && s.destinationOptions.length >= 1
    && !s.destinationOptions.includes('Looking for printers…'), { what });
async function closePreview(job) {
  if (job.win.isDestroyed()) return;
  await ui(job, 'document.getElementById("cancel").click(); return true;').catch(() => {});
  await waitFor(async () => job.win.isDestroyed(), (x) => x === true, { what: 'preview closed', timeout: 10000 });
}
function nextJob(preview, pred, timeout = 15000) {
  return new Promise((resolve) => {
    let off = () => {};
    const timer = setTimeout(() => { off(); resolve(null); }, timeout);
    off = preview.on((event, job) => { if (event === 'opened' && pred(job)) { clearTimeout(timer); off(); resolve(job); } });
  });
}
async function saveThroughUi(job, setSavePath, target) {
  try { fs.unlinkSync(target); } catch { /* none */ }
  setSavePath(target);
  await ui(job, 'document.getElementById("save").click(); return true;');
  await waitFor(() => state(job), (x) => x && /^Saved /.test(x.message || ''), { what: 'PDF saved' });
  return fs.existsSync(target) ? P.pdfInfo(fs.readFileSync(target)) : null;
}

/**
 * Smoke check on a live app window (the e2e smoke run): window.print() -> preview -> render ->
 * Save as PDF -> close. Returns what the preview showed.
 */
async function exercisePreview({ preview, source, setSavePath, savePath }) {
  const out = { opened: false };
  const opened = nextJob(preview, (j) => j.source === source);
  const done = source.executeJavaScript('window.print()', true).catch((e) => ({ error: String(e) }));
  const job = await opened;
  if (!job) return out;
  out.opened = true;
  out.kind = job.doc.kind;
  const s = await waitReady(job, 1, 'smoke preview');
  Object.assign(out, { pages: s.pages, widthMm: s.widthMm, heightMm: s.heightMm, paper: s.paper, frameIsPdfBlob: s.frameIsPdfBlob,
    destination: s.destination, notice: s.notice });
  const pr = await preview._printers(job);
  out.printers = { count: pr.printers.length, hasPhysical: pr.hasPhysical, inventoryAvailable: pr.inventoryAvailable,
    names: pr.printers.map((p) => `${p.name}${p.virtual ? ` [${p.type}]` : ''}${p.isDefault ? ' (default)' : ''}`) };
  out.saved = await saveThroughUi(job, setSavePath, savePath);
  await closePreview(job);
  out.outcome = await Promise.race([done, sleep(10000).then(() => ({ timeout: true }))]);
  return out;
}

// The local server's own Content-Security-Policy (windows/gtrade_ctl/nginx.py), so the samples
// run under the policy the app's pages and print pop-ups really get.
const APP_CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; "
  + "font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'";

function serve(dir) {
  const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript' };
  const server = http.createServer((req, res) => {
    const name = path.basename(decodeURIComponent(String(req.url || '/').split('?')[0]));
    const file = path.join(dir, name);
    if (req.method !== 'GET' || !types[path.extname(name)] || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': types[path.extname(name)], 'Cache-Control': 'no-store', 'Content-Security-Policy': APP_CSP });
    res.end(fs.readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function runPrintSelfTest({ electron, preview, setSavePath, setServerOrigin, pagesDir, preloadPath, basePrefs, outFile, printer = '' }) {
  const { BrowserWindow, app } = electron;
  const shots = `${outFile}.shots`;
  fs.mkdirSync(shots, { recursive: true });
  const result = { ok: false, startedAt: new Date().toISOString(), appVersion: app.getVersion(), electron: process.versions.electron,
    chrome: process.versions.chrome, packaged: app.isPackaged, printer: printer || null, printers: null, docs: [], popup: null, failures: [] };
  const fail = (where, msg) => result.failures.push(`${where}: ${msg}`);
  const server = await serve(path.join(pagesDir, 'print-selftest'));
  const origin = `http://127.0.0.1:${server.address().port}`;
  setServerOrigin(origin);
  const appWindow = (opts) => new BrowserWindow({ show: true, ...opts, webPreferences: { ...basePrefs, preload: preloadPath } });

  try {
    for (const spec of DOCS) {
      const r = { file: spec.file, pass: false };
      result.docs.push(r);
      const narrow = spec.kind === 'receipt' || spec.kind === 'label';
      const src = appWindow({ width: narrow ? 420 : 940, height: 760, title: spec.file });
      try {
        await src.loadURL(`${origin}/${spec.file}`);
        const opened = nextJob(preview, (j) => j.source === src.webContents);
        // Exactly what the app's print buttons do.
        const printDone = src.webContents.executeJavaScript(spec.double
          ? 'Promise.all([window.print(), window.print()]).then((all) => ({ ...all[0], both: all }))' : 'window.print()', true)
          .catch((e) => ({ error: String(e) }));
        const job = await opened;
        if (!job) { fail(spec.file, 'window.print() did not open the preview'); continue; }
        let s = await waitReady(job, 1, `${spec.file} first render`);
        r.kind = job.doc.kind;
        const previewsForThisWindow = BrowserWindow.getAllWindows().filter((w) => w.getParentWindow() === src).length;
        r.first = { pages: s.pages, widthMm: s.widthMm, heightMm: s.heightMm, paper: s.paper, destination: s.destination };
        Object.assign(r, { printLabel: s.printLabel, notice: s.notice, destNote: s.destNote, paperOptions: s.paperOptions,
          orientationDisabled: s.orientationDisabled });
        if (!result.printers) result.printers = await preview._printers(job);
        await sleep(700); // let the PDF viewer paint before the evidence screenshot
        fs.writeFileSync(path.join(shots, `${spec.file.replace(/\.html$/, '')}.png`), (await job.win.webContents.capturePage()).toPNG());

        const ok = [];
        ok.push(['kind', r.kind === spec.kind]);
        ok.push(['one preview window', previewsForThisWindow === 1]);
        if (spec.size) ok.push(['size', near(s.widthMm, spec.size[0]) && near(s.heightMm, spec.size[1])]);
        if (spec.width) ok.push(['roll width', near(s.widthMm, spec.width)]);
        if (spec.height) ok.push(['roll length', s.heightMm >= spec.height[0] && s.heightMm <= spec.height[1]]);
        if (spec.pages) ok.push(['pages', s.pages === spec.pages]);
        if (spec.minPages) ok.push(['pages', s.pages >= spec.minPages]);

        if (spec.change) {
          const [control, value] = spec.change;
          const original = await ui(job, `return document.getElementById(${JSON.stringify(control)}).value;`);
          await setControl(job, control, value);
          s = await waitReady(job, s.renders + 1, `${spec.file} ${control}=${value}`);
          r.changed = { [control]: value, pages: s.pages, widthMm: s.widthMm, heightMm: s.heightMm, paper: s.paper };
          if (spec.changed) ok.push([`${control}=${value}`, near(s.widthMm, spec.changed[0]) && near(s.heightMm, spec.changed[1])]);
          if (control === 'margins') ok.push(['margins=none shortens the roll', s.heightMm < r.first.heightMm && s.pages === 1]);
          await setControl(job, control, original);
          s = await waitReady(job, s.renders + 1, `${spec.file} ${control} restored`);
          ok.push(['restored', near(s.widthMm, r.first.widthMm) && near(s.heightMm, r.first.heightMm)]);
        }

        // Save as PDF through the preview's own button (the file name dialog is answered by the test).
        const saved = await saveThroughUi(job, setSavePath, path.join(shots, `${spec.file.replace(/\.html$/, '')}.pdf`));
        r.saved = saved;
        ok.push(['saved PDF', Boolean(saved && saved.pages === s.pages && near(saved.widthMm, s.widthMm) && near(saved.heightMm, s.heightMm))]);

        if (printer && spec.print) {
          await setControl(job, 'destination', printer);
          r.print = { options: P.buildPrintOptions({ destination: printer, copies: 1 }, { widthMm: s.widthMm, heightMm: s.heightMm }) };
          const t0 = Date.now();
          await ui(job, 'document.getElementById("print").click(); return true;');
          const after = await waitFor(() => state(job), (x) => x && (x.closed || RESULT_MESSAGE.test(x.message || '')),
            { timeout: 180000, what: `${spec.file} print` });
          Object.assign(r.print, { message: after.message || '', closedAfterPrint: Boolean(after.closed), ms: Date.now() - t0 });
          ok.push(['printed', Boolean(after.closed || /^Sent /.test(after.message || ''))]);
        }
        await closePreview(job);
        const outcome = await Promise.race([printDone, sleep(10000).then(() => ({ timeout: true }))]);
        r.outcome = outcome;
        ok.push(['window.print() resolved', Boolean(outcome && outcome.outcome)]);
        if (spec.double) ok.push(['double print() -> same preview, both resolved', Array.isArray(outcome.both) && outcome.both.length === 2
          && outcome.both.every((o) => o && o.outcome === outcome.outcome)]);
        r.checks = Object.fromEntries(ok);
        r.pass = ok.every(([, v]) => v);
        if (!r.pass) fail(spec.file, `checks failed: ${ok.filter(([, v]) => !v).map(([k]) => k).join(', ')}`);
      } catch (err) {
        r.error = String(err && err.stack || err);
        fail(spec.file, r.error.split('\n')[0]);
      } finally {
        if (!src.isDestroyed()) src.destroy();
      }
    }

    // Bills print from an about:blank pop-up that the bill's own script calls print() in.
    const pr = { pass: false };
    result.popup = pr;
    const opener = appWindow({ width: 600, height: 400, title: 'pop-up opener' });
    try {
      await opener.loadURL(`${origin}/popup-opener.html`);
      const opened = nextJob(preview, (j) => j.source !== opener.webContents);
      await opener.webContents.executeJavaScript('window.openBillPopup()', true);
      const job = await opened;
      if (!job) throw new Error('the pop-up\'s window.print() did not open the preview');
      const s = await waitReady(job, 1, 'pop-up first render');
      Object.assign(pr, { title: job.doc.title, kind: job.doc.kind, page: { widthMm: s.widthMm, heightMm: s.heightMm, pages: s.pages },
        sourceIsPopup: job.source !== opener.webContents && Boolean(job.parent) && job.parent !== opener });
      await sleep(700);
      fs.writeFileSync(path.join(shots, 'popup-bill.png'), (await job.win.webContents.capturePage()).toPNG());
      await closePreview(job);
      pr.pass = pr.title === 'Bill POPUP-001' && near(s.widthMm, 148) && near(s.heightMm, 210) && pr.sourceIsPopup;
      if (!pr.pass) fail('pop-up', JSON.stringify(pr));
    } catch (err) {
      pr.error = String(err && err.stack || err);
      fail('pop-up', pr.error.split('\n')[0]);
    } finally {
      for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.destroy();
    }
  } finally {
    server.close();
  }
  result.ok = result.failures.length === 0;
  result.finishedAt = new Date().toISOString();
  fs.writeFileSync(outFile, JSON.stringify(result, null, 2));
  return result;
}

module.exports = { runPrintSelfTest, exercisePreview, DOCS };
