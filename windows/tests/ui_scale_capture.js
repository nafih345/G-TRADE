'use strict';
// Interface-size visual validation (driven by tests/ui_scale_visual.py; not part of the unit suite).
// Loads the REAL staged SPA from a disposable test server in an Electron window sized like a
// maximised window on a given physical resolution / Windows display scaling, applies each interface
// size with the same native zoom the desktop shell uses, and measures every screen:
//   page-level horizontal overflow, controls pushed off-screen, clipped button labels,
//   overlapping input fields, smallest effective text (CSS px x scale x Windows DPI),
//   dropdown + dialog placement, and print/PDF size independence.
// Run with --force-device-scale-factor=<dpi> (Windows display scaling) and --config=<json>.
// Trusts the test server's certificate for localhost ONLY inside this scratch harness.

const { app, BrowserWindow, ipcMain, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const cfgArg = process.argv.find((a) => a.startsWith('--config='));
const CFG = JSON.parse(fs.readFileSync(cfgArg.slice('--config='.length), 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MEASURE = `(() => {
  const vw = innerWidth, vh = innerHeight, de = document.documentElement;
  const visible = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && r.bottom > 0 && r.top < vh; };
  const main = document.querySelector('main') || document.body;
  const buttons = [...document.querySelectorAll('button, [role=button], .MuiTab-root')].filter(visible);
  // A control is unreachable when it lies past the window edge and is NOT inside a horizontally
  // scrollable container that offers a way to scroll to it (scrollable tab bar with arrows, etc.).
  const reachableByScroll = (b) => { for (let p = b.parentElement; p && p !== document.body; p = p.parentElement) {
    const ox = getComputedStyle(p).overflowX;
    if ((ox === 'auto' || ox === 'scroll') && p.scrollWidth > p.clientWidth + 1) return true;
    if (p.classList.contains('MuiTabs-scrollableX')) return true; } return false; };
  const offscreen = buttons.filter((b) => { const r = b.getBoundingClientRect(); return (r.right > vw + 1 || r.left < -1) && !reachableByScroll(b); })
    .map((b) => (b.innerText || b.getAttribute('aria-label') || '').trim().slice(0, 40));
  const clipped = buttons.filter((b) => b.scrollWidth > b.clientWidth + 2 && (b.innerText || '').trim().length > 0
      && getComputedStyle(b).overflow !== 'visible')
    .map((b) => (b.innerText || '').trim().slice(0, 40));
  const inputs = [...document.querySelectorAll('.MuiInputBase-root')].filter(visible).slice(0, 120)
    .map((el) => el.getBoundingClientRect());
  let overlaps = 0;
  for (let i = 0; i < inputs.length; i++) for (let j = i + 1; j < inputs.length; j++) {
    const a = inputs[i], b = inputs[j];
    const ix = Math.min(a.right, b.right) - Math.max(a.left, b.left), iy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    if (ix > 4 && iy > 4) overlaps++;
  }
  const sizes = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n && sizes.length < 4000; n = walker.nextNode()) {
    if (!n.textContent.trim() || !n.parentElement || !visible(n.parentElement)) continue;
    sizes.push(parseFloat(getComputedStyle(n.parentElement).fontSize));
  }
  sizes.sort((a, b) => a - b);
  const pct = (p) => sizes.length ? sizes[Math.min(sizes.length - 1, Math.floor(p * sizes.length))] : null;
  const tables = [...document.querySelectorAll('table')].filter(visible).map((t) => {
    const wrap = t.parentElement; return { cols: t.querySelectorAll('thead th').length,
      scrollsInside: wrap ? wrap.scrollWidth > wrap.clientWidth + 1 : false };
  });
  return { innerWidth: vw, innerHeight: vh, pageOverflowX: de.scrollWidth > de.clientWidth + 1,
    mainOverflowX: main.scrollWidth > main.clientWidth + 1, offscreenControls: offscreen, clippedButtons: clipped,
    inputOverlaps: overlaps, textCssPx: { min: pct(0), p10: pct(0.1), median: pct(0.5) }, tables,
    appShell: Boolean(document.querySelector('header')) && !document.querySelector('input[type=password]'),
    hasError: /something went wrong|unexpected application error/i.test(document.body.innerText) };
})()`;

// Opens the first visible Select and returns where its list appeared relative to the field.
const DROPDOWN = `(async () => {
  const sel = [...document.querySelectorAll('.MuiSelect-select[role=combobox], .MuiSelect-select')]
    .find((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.top > 0 && r.bottom < innerHeight; });
  if (!sel) return null;
  sel.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
  await new Promise((r) => setTimeout(r, 500));
  const list = document.querySelector('[role=listbox]');
  const a = sel.getBoundingClientRect(), b = list ? list.getBoundingClientRect() : null;
  const out = b ? { fieldBottom: Math.round(a.bottom), listTop: Math.round(b.top), listLeft: Math.round(b.left), fieldLeft: Math.round(a.left),
    insideViewport: b.left >= 0 && b.right <= innerWidth + 1 && b.top >= 0 && b.bottom <= innerHeight + 1,
    anchored: Math.abs(b.left - a.left) < 40 && (Math.abs(b.top - a.bottom) < 80 || Math.abs(a.top - b.bottom) < 80 || (b.top <= a.top && b.bottom >= a.bottom)) } : { opened: false };
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  if (list) list.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await new Promise((r) => setTimeout(r, 300));
  return out;
})()`;

// Opens the header Interface-size menu (desktop control) and checks it is on screen and correct.
const HEADER_MENU = `(async () => {
  const btn = document.querySelector('[data-testid=header-ui-scale]');
  if (!btn) return { present: false };
  btn.click();
  await new Promise((r) => setTimeout(r, 400));
  const items = [...document.querySelectorAll('[data-testid^=ui-scale-]')].map((e) => ({ id: e.dataset.testid, text: e.innerText.trim(),
    selected: e.classList.contains('Mui-selected'), inView: (() => { const r = e.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1; })() }));
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  const menu = document.querySelector('[role=menu]'); if (menu) menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await new Promise((r) => setTimeout(r, 300));
  return { present: true, items };
})()`;

const PRINT_PAGE = `<!doctype html><html><head><style>@page{size:80mm 120mm;margin:0} body{margin:0}</style></head>
<body><div style="width:72mm;height:10mm;background:#000"></div></body></html>`;

async function printPdf(win, file) {
  // Thermal-receipt style page through the same print pipeline bills use (about:blank + document.write).
  await win.webContents.executeJavaScript(`document.open(); document.write(${JSON.stringify(PRINT_PAGE)}); document.close(); true`);
  const pdf = await win.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true });
  fs.writeFileSync(file, pdf); // compared by geometry in ui_scale_visual.py (bytes carry timestamps)
  return path.basename(file);
}

app.whenReady().then(async () => {
  session.defaultSession.setCertificateVerifyProc((req, cb) => cb(req.hostname === 'localhost' ? 0 : -3));
  // Same bridge contract as the shipped preload.js / main.js (only what the pages ask for here).
  let current = CFG.scales[0];
  const info = () => ({ scale: current, defaultScale: 0.8, options: [0.75, 0.8, 0.9, 1] });
  ipcMain.handle('ui:getScale', () => info());
  ipcMain.handle('ui:setScale', (_e, v) => { current = v; return info(); });
  ipcMain.handle('app:getStatus', () => ({ state: 'online', detail: '' }));
  ipcMain.handle('app:getInfo', () => ({ appVersion: '1.0.0' }));
  const results = { dpi: CFG.dpi, runs: [] };
  const win = new BrowserWindow({ show: false, useContentSize: true, width: 800, height: 600,
    webPreferences: { sandbox: true, contextIsolation: true, preload: CFG.preload } });
  await win.loadURL(CFG.baseUrl + '/');
  // Real sign-in through the login form (a seeded token is discarded by the app on load).
  await sleep(2500);
  results.login = await win.webContents.executeJavaScript(`(async () => {
    const set = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true })); };
    const user = document.querySelector('input[placeholder*="username" i]'), pass = document.querySelector('input[type=password]');
    if (!user || !pass) return { form: false };
    set(user, ${JSON.stringify(CFG.username)}); set(pass, ${JSON.stringify(CFG.password)});
    [...document.querySelectorAll('button')].find((b) => /sign in/i.test(b.innerText) && b.type === 'submit' || /^sign in/i.test(b.innerText.trim())).click();
    for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 500)); if (localStorage.getItem('access_token') && document.querySelector('header')) break; }
    return { form: true, token: Boolean(localStorage.getItem('access_token')), header: Boolean(document.querySelector('header')) };
  })()`, true);
  if (!results.login.header) { fs.writeFileSync(CFG.out, JSON.stringify(results, null, 1)); app.exit(2); return; }
  for (const res of CFG.resolutions) {
    // Maximised window on that screen: physical pixels / Windows scaling, minus taskbar + title + menu.
    const w = Math.round(res[0] / CFG.dpi), h = Math.round(res[1] / CFG.dpi) - 100;
    win.setContentSize(w, h);
    for (const scale of CFG.scales) {
      win.webContents.setZoomFactor(scale);
      current = scale;
      for (const route of CFG.routes) {
        await win.loadURL(`${CFG.baseUrl}/#${route}`);
        win.webContents.setZoomFactor(scale);
        await sleep(CFG.settleMs);
        const run = { res: `${res[0]}x${res[1]}`, scale, route, window: [w, h] };
        try {
          run.m = await win.webContents.executeJavaScript(MEASURE, true);
          if (CFG.dropdownRoutes.includes(route)) run.dropdown = await win.webContents.executeJavaScript(DROPDOWN, true);
          if (route === CFG.routes[0]) run.headerMenu = await win.webContents.executeJavaScript(HEADER_MENU, true);
        } catch (e) { run.error = String(e); }
        const shotKey = `${res[0]}x${res[1]}@${CFG.dpi}`;
        if ((CFG.shots[shotKey] || []).includes(scale) && CFG.shotRoutes.includes(route)) {
          const img = await win.webContents.capturePage();
          const file = path.join(CFG.outDir, `${route.replace(/\W+/g, '_') || 'home'}_${res[0]}x${res[1]}_dpi${CFG.dpi}_s${Math.round(scale * 100)}.png`);
          fs.writeFileSync(file, img.toPNG());
          run.shot = path.basename(file);
        }
        results.runs.push(run);
      }
    }
  }
  // Print independence: the same receipt page printed at every scale must give the identical PDF.
  results.print = {};
  for (const scale of CFG.scales) {
    await win.loadURL(`${CFG.baseUrl}/#/`);
    win.webContents.setZoomFactor(scale);
    await sleep(800);
    results.print[scale] = await printPdf(win, path.join(CFG.outDir, `receipt_dpi${CFG.dpi}_s${Math.round(scale * 100)}.pdf`));
  }
  fs.writeFileSync(CFG.out, JSON.stringify(results, null, 1));
  app.exit(0);
});
