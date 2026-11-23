'use strict';
// G OPTICALS desktop shell (thin client). It loads the SPA from the installation's own HTTPS
// server (Standalone: https://localhost:8443, LAN: https://<server>:8443) and trusts that server
// only through the pinned per-installation CA. It holds no database credentials or server secrets:
// all it stores is the server address and the CA certificate (public).

const { app, BrowserWindow, Menu, dialog, ipcMain, screen, session, shell } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sec = require('./lib/security');
const conn = require('./lib/connection');
const uiScale = require('./lib/uiScale');
const { mergePrinters } = require('./lib/printing');
const { createPrintPreview, createPrintPrefs } = require('./lib/printPreview');
const { createPrinterInventory } = require('./lib/printerInventory');
const { runPrintSelfTest, exercisePreview } = require('./lib/printSelfTest');
const { PRODUCT_NAME, LEGACY_USER_DATA_DIRNAME } = require('./lib/brand');

const APP_ID = 'com.gtrade.erp';
const PAGES = path.join(__dirname, 'pages');
const PRELOAD = path.join(__dirname, 'preload.js');
const STATUS_INTERVAL_MS = 20000;
const argValue = (name) => {
  const a = process.argv.find((x) => x.startsWith(`${name}=`));
  return a ? a.slice(name.length + 1) : null;
};
const SMOKE_OUT = argValue('--smoke-test');
// Print self-test of this build (lib/printSelfTest.js): no server connection, sample documents only.
const PRINT_SELFTEST_OUT = argValue('--print-selftest');
const PRINT_SELFTEST_PRINTER = argValue('--print-selftest-printer') || '';
// Every "open in the user's browser" goes through this; a smoke run never opens a real browser.
const openExternal = sec.createExternalOpener({ open: (url) => shell.openExternal(url), smoke: Boolean(SMOKE_OUT) });
// Reserved TLD (RFC 2606): can never resolve, so even a regression could not load a real site.
const NAV_PROBE_URL = 'https://gtrade-navigation-probe.invalid/';

let current = null; // { serverUrl, caPem, caFingerprint, mode, source }
let mainWindow = null;
let connectWindow = null;
let lastStatus = { state: 'checking', detail: '' };
let statusTimer = null;
let warnedTooOld = false;
let currentScale = uiScale.DEFAULT_SCALE; // read from userData once the app is ready
let printPreview = null; // lib/printPreview.js controller, created once the app is ready
let testSavePath = null; // Save as PDF target in smoke / self-test runs (no file dialog)
const printerInventory = createPrinterInventory();

const userConnFile = () => path.join(app.getPath('userData'), 'connection.json');
const windowStateFile = () => path.join(app.getPath('userData'), 'window-state.json');
const uiSettingsFile = () => path.join(app.getPath('userData'), uiScale.FILE_NAME);
const machineConfigFile = () => process.env.GTRADE_CLIENT_CONFIG || conn.MACHINE_CONFIG;

app.setAppUserModelId(APP_ID);
// Keep the pre-rename userData folder (saved server connection + window state) unless a caller
// chose one explicitly with --user-data-dir (tests do). The print self-test never touches it.
if (PRINT_SELFTEST_OUT && !process.argv.some((a) => a.startsWith('--user-data-dir'))) {
  app.setPath('userData', path.join(os.tmpdir(), 'gtrade-print-selftest'));
} else if (!process.argv.some((a) => a.startsWith('--user-data-dir'))) {
  app.setPath('userData', path.join(app.getPath('appData'), LEGACY_USER_DATA_DIRNAME));
}
app.enableSandbox(); // every renderer sandboxed, including popups

// ---- security wiring that applies to every webContents ----------------------------------------
function isLocalPage(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'file:') return false;
    const p = path.normalize(decodeURIComponent(u.pathname.replace(/^\/([A-Za-z]:)/, '$1')));
    return p.toLowerCase().startsWith(path.normalize(PAGES).toLowerCase());
  } catch {
    return false;
  }
}

const securePopupPrefs = {
  contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true,
  allowRunningInsecureContent: false, devTools: !app.isPackaged,
};

app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', (ev) => ev.preventDefault());
  contents.setWindowOpenHandler(({ url }) => {
    // Bill/label/report printing opens a blank same-origin window and writes into it. The pop-up
    // gets the same preload as the main window, so its window.print() opens the app's preview.
    if (url === 'about:blank' || url === '' || (current && sec.sameOrigin(url, current.serverUrl))) {
      return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, webPreferences: { ...securePopupPrefs, preload: PRELOAD } } };
    }
    openExternal(url);
    return { action: 'deny' };
  });
  const guard = (ev, url) => {
    if (isLocalPage(url)) return;
    if (current && sec.isAllowedNavigation(url, current.serverUrl)) return;
    ev.preventDefault();
    openExternal(url);
  };
  contents.on('will-navigate', guard);
  contents.on('will-redirect', guard);
});

function configureSession(ses) {
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(sec.isPermissionAllowed(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => sec.isPermissionAllowed(permission));
  ses.setCertificateVerifyProc((req, cb) => {
    if (!current) return cb(-3);
    let host;
    try { ({ host } = sec.normalizeServerUrl(current.serverUrl)); } catch { return cb(-2); }
    if (req.hostname !== host) return cb(-3); // anything else: Chromium's normal verification
    const r = sec.verifyPinnedLeaf({ hostname: req.hostname, leafPem: req.certificate.data, caPem: current.caPem,
      pinnedFingerprint: current.caFingerprint });
    if (!r.ok) lastStatus = { state: 'offline', detail: `Security check failed: ${r.reason}`, tlsError: true };
    return cb(r.ok ? 0 : -2);
  });
}

// ---- IPC (every handler checks who is calling) --------------------------------------------------
function senderKind(event) {
  const frame = event.senderFrame;
  const url = frame ? frame.url : '';
  if (isLocalPage(url)) return 'local';
  // A print pop-up is an about:blank document that inherited the server's origin from its opener.
  const where = !url || url === 'about:blank' ? (frame ? frame.origin : '') : url;
  if (current && sec.sameOrigin(where, current.serverUrl)) return 'server';
  return null;
}

function handle(channel, allowed, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    const kind = senderKind(event);
    if (!kind || !allowed.includes(kind)) throw new Error('Not allowed');
    return fn(event, ...args);
  });
}

function appInfo() {
  return { appVersion: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome,
    serverUrl: current ? current.serverUrl : '', mode: current ? current.mode : '', connectionSource: current ? current.source : '',
    caFingerprint: current ? current.caFingerprint : '', packaged: app.isPackaged };
}

function registerIpc() {
  handle('app:getInfo', ['server', 'local'], () => appInfo());
  handle('app:getStatus', ['server', 'local'], () => lastStatus);
  handle('app:openConnectionSettings', ['server', 'local'], () => { openConnectWindow(); return true; });
  handle('app:print', ['server'], (event, opts) => new Promise((resolve) => {
    event.sender.print(sec.sanitizePrintOptions(opts), (ok, reason) => resolve({ ok, reason: ok ? '' : String(reason || '') }));
  }));
  // window.print() in any app window (preload.js) -> the app's print preview for that window.
  handle('print:preview', ['server'], (event) => printPreview.open(event.sender));
  printPreview.registerIpc((channel, fn) => handle(channel, ['local'], fn));
  // Electron 44 no longer reports the default printer; Windows' own inventory does.
  handle('app:listPrinters', ['server', 'local'], async (event) => {
    const [list, inventory] = await Promise.all([event.sender.getPrintersAsync(), printerInventory.get()]);
    return mergePrinters(list, inventory).printers.map((p) => ({ name: p.name, displayName: p.displayName, isDefault: p.isDefault,
      virtual: p.virtual, offline: p.offline }));
  });
  // Interface size (lib/uiScale.js): the page may read and change its own window's scale only.
  handle('ui:getScale', ['server', 'local'], () => uiScale.describe(currentScale));
  handle('ui:setScale', ['server', 'local'], (_e, value) => uiScale.describe(setScale(value)));
  handle('win:minimize', ['server', 'local'], (event) => BrowserWindow.fromWebContents(event.sender)?.minimize());
  handle('win:toggleMaximize', ['server', 'local'], (event) => {
    const w = BrowserWindow.fromWebContents(event.sender);
    if (!w) return false;
    if (w.isMaximized()) w.unmaximize(); else w.maximize();
    return w.isMaximized();
  });
  handle('win:close', ['server', 'local'], (event) => BrowserWindow.fromWebContents(event.sender)?.close());
  // Connection management: only from the app's own local pages, never from server content.
  handle('conn:probe', ['local'], async (_e, serverUrl) => {
    const { origin } = sec.normalizeServerUrl(serverUrl);
    const ca = await conn.probeServerCa(origin);
    return { serverUrl: origin, caFingerprint: ca.caFingerprint, subject: ca.subject };
  });
  handle('conn:pair', ['local'], async (_e, { serverUrl, code }) => {
    const { origin } = sec.normalizeServerUrl(serverUrl);
    const ca = await conn.probeServerCa(origin);
    if (!sec.pairingCodeMatches(code, ca.caFingerprint)) {
      throw new Error('The pairing code does not match this server. Check the code on the server\'s connection sheet.');
    }
    const candidate = { serverUrl: origin, caPem: ca.caPem, caFingerprint: ca.caFingerprint, mode: 'workstation' };
    const status = await conn.checkServer(candidate, app.getVersion());
    if (status.state === 'offline') throw new Error(status.detail || 'The server did not answer.');
    if (status.detail && status.detail.startsWith(conn.NOT_LOCAL_SERVER)) throw new Error(status.detail);
    conn.saveUserConnection(userConnFile(), candidate);
    await useConnection(conn.loadConnection(userConnFile(), machineConfigFile()));
    return { ok: true, status };
  });
  handle('conn:useMachineDefault', ['local'], async () => {
    try { fs.unlinkSync(userConnFile()); } catch { /* none */ }
    const c = conn.loadConnection(userConnFile(), machineConfigFile());
    if (!c) throw new Error(`This computer has no default ${PRODUCT_NAME} server configured.`);
    await useConnection(c);
    return { ok: true };
  });
  handle('conn:retry', ['local'], async () => { if (current) await useConnection(current); return lastStatus; });
}

// ---- printing ----------------------------------------------------------------------------------
// window.print() everywhere -> lib/printPreview.js. Test runs answer "Save as PDF" with a fixed
// path instead of a file dialog and never write the remembered-printer file.
function setupPrinting() {
  const testRun = Boolean(SMOKE_OUT || PRINT_SELFTEST_OUT);
  printPreview = createPrintPreview({
    electron: { BrowserWindow, dialog, shell, screen, app },
    pagePath: path.join(PAGES, 'print-preview.html'),
    preloadPath: path.join(__dirname, 'preload-preview.js'),
    basePrefs: securePopupPrefs,
    prefs: createPrintPrefs({ file: path.join(app.getPath('userData'), 'print-settings.json'), readJson: conn.readJson,
      writeJsonAtomic: conn.writeJsonAtomic, persist: !testRun }),
    inventory: printerInventory,
    isPackaged: app.isPackaged,
    chooseSavePath: testRun ? async () => testSavePath : null,
    log: (...a) => console.warn('[print]', ...a),
  });
}

// ---- status ------------------------------------------------------------------------------------
function broadcast(status) {
  lastStatus = status;
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('gtrade:status', status);
  }
}

async function refreshStatus() {
  if (!current) return broadcast({ state: 'offline', detail: 'No server configured' });
  const status = await conn.checkServer(current, app.getVersion());
  broadcast(status);
  if (status.clientTooOld && !warnedTooOld && !SMOKE_OUT) {
    warnedTooOld = true;
    dialog.showMessageBox({ type: 'warning', title: PRODUCT_NAME, message: 'Desktop app update required', detail: status.detail });
  }
  return status;
}

function startStatusLoop() {
  clearInterval(statusTimer);
  statusTimer = setInterval(() => refreshStatus().catch(() => {}), STATUS_INTERVAL_MS);
}

// ---- interface size ------------------------------------------------------------------------------
// Only the MAIN window is zoomed (see lib/uiScale.js for why popups are never touched).
function applyScale() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.setZoomFactor(currentScale);
}

function setScale(value) {
  const scale = uiScale.normalizeScale(value);
  if (scale === null) throw new Error('Unsupported interface size');
  currentScale = uiScale.writeScale(uiSettingsFile(), scale);
  applyScale();
  buildMenu();
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('gtrade:uiScale', uiScale.describe(currentScale));
  }
  return currentScale;
}

function scaleMenu() {
  return [
    ...uiScale.SCALES.map((s) => ({ label: uiScale.label(s) + (s === uiScale.DEFAULT_SCALE ? ' (default)' : ''), type: 'radio',
      checked: s === currentScale, click: () => setScale(s) })),
    { type: 'separator' },
    { label: 'Larger', accelerator: 'CmdOrCtrl+Plus', click: () => setScale(uiScale.stepScale(currentScale, 1)) },
    { label: 'Smaller', accelerator: 'CmdOrCtrl+-', click: () => setScale(uiScale.stepScale(currentScale, -1)) },
    { label: `Reset to default (${uiScale.label(uiScale.DEFAULT_SCALE)})`, accelerator: 'CmdOrCtrl+0', click: () => setScale(uiScale.DEFAULT_SCALE) },
  ];
}

// ---- windows -----------------------------------------------------------------------------------
function loadWindowState() {
  const s = conn.readJson(windowStateFile()) || {};
  return { width: s.width || 1366, height: s.height || 820, x: s.x, y: s.y, maximized: s.maximized !== false };
}

function saveWindowState(win) {
  if (!win || win.isDestroyed()) return;
  const b = win.getNormalBounds();
  try { conn.writeJsonAtomic(windowStateFile(), { ...b, maximized: win.isMaximized() }); } catch { /* best effort */ }
}

function createMainWindow() {
  const st = loadWindowState();
  mainWindow = new BrowserWindow({
    width: st.width, height: st.height, x: st.x, y: st.y, minWidth: 1024, minHeight: 640, show: false,
    title: PRODUCT_NAME, backgroundColor: '#0b0f19', autoHideMenuBar: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), ...securePopupPrefs, spellcheck: false, zoomFactor: currentScale },
  });
  // Chromium keys zoom by origin, so a navigation (offline page -> server, server change) would
  // fall back to 100%: re-apply the chosen scale on every main-frame navigation.
  mainWindow.webContents.on('did-navigate', applyScale);
  mainWindow.webContents.on('dom-ready', applyScale);
  if (st.maximized) mainWindow.maximize();
  mainWindow.once('ready-to-show', () => { if (!SMOKE_OUT) mainWindow.show(); });
  mainWindow.on('close', () => saveWindowState(mainWindow));
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (isMainFrame && code !== -3 && !isLocalPage(url)) showOffline(lastStatus.detail || desc);
  });
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    if (details.reason !== 'clean-exit') showOffline(`The window stopped unexpectedly (${details.reason}).`);
  });
  return mainWindow;
}

function showOffline(detail) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.loadFile(path.join(PAGES, 'offline.html'), { query: { detail: String(detail || '').slice(0, 300) } });
}

async function useConnection(c) {
  current = c;
  configureSession(session.defaultSession);
  await session.defaultSession.closeAllConnections();
  if (!mainWindow) createMainWindow();
  const status = await refreshStatus();
  if (status.state === 'offline') showOffline(status.detail);
  else await mainWindow.loadURL(`${current.serverUrl}/`).catch(() => {});
  if (connectWindow && !connectWindow.isDestroyed()) connectWindow.close();
  startStatusLoop();
}

function openConnectWindow() {
  if (connectWindow && !connectWindow.isDestroyed()) { connectWindow.focus(); return connectWindow; }
  connectWindow = new BrowserWindow({
    width: 560, height: 620, resizable: false, minimizable: false, maximizable: false, title: `Connect to ${PRODUCT_NAME} server`,
    parent: mainWindow || undefined, modal: Boolean(mainWindow), show: !SMOKE_OUT, autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), ...securePopupPrefs },
  });
  connectWindow.loadFile(path.join(PAGES, 'connect.html'));
  connectWindow.on('closed', () => { connectWindow = null; });
  return connectWindow;
}

function buildMenu() {
  const template = [
    { label: 'File', submenu: [
      { label: 'Reload', accelerator: 'F5', click: () => mainWindow && current && mainWindow.loadURL(`${current.serverUrl}/`) },
      { label: 'Server connection…', click: () => openConnectWindow() },
      { type: 'separator' }, { role: 'quit' } ] },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [{ label: 'Interface size', submenu: scaleMenu() }, { type: 'separator' }, { role: 'togglefullscreen' },
      ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' }])] },
    { label: 'Window', submenu: [{ role: 'minimize' }, { label: 'Maximize / Restore', click: () => mainWindow && (mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize()) }, { role: 'close' }] },
    { label: 'Help', submenu: [{ label: `About ${PRODUCT_NAME}`, click: () => {
      const i = appInfo();
      dialog.showMessageBox({ type: 'info', title: `About ${PRODUCT_NAME}`, message: `${PRODUCT_NAME} ${i.appVersion}`,
        detail: `Server: ${i.serverUrl || 'not connected'}${lastStatus.serverVersion ? ` (version ${lastStatus.serverVersion})` : ''}\n`
          + `Status: ${lastStatus.state}\nCertificate authority: ${i.caFingerprint ? i.caFingerprint.slice(0, 23) + '…' : '-'}\n`
          + `Electron ${i.electron} · Chromium ${i.chrome}` });
    } }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---- smoke test (automated verification on a real Windows desktop) ---------------------------------
async function runSmoke() {
  const result = { ok: false, appVersion: app.getVersion(), electron: process.versions.electron };
  try {
    await new Promise((r) => setTimeout(r, 4000));
    const wc = mainWindow.webContents;
    const prefs = wc.getLastWebPreferences ? wc.getLastWebPreferences() : {};
    result.webPreferences = { contextIsolation: prefs.contextIsolation, sandbox: prefs.sandbox, nodeIntegration: prefs.nodeIntegration,
      webSecurity: prefs.webSecurity };
    result.url = wc.getURL();
    result.uiScale = { configured: currentScale, zoomFactor: wc.getZoomFactor() };
    result.status = lastStatus;
    result.page = await wc.executeJavaScript(`(async () => ({
      requireType: typeof require, processType: typeof process, bridge: typeof window.gtradeDesktop,
      bridgeKeys: window.gtradeDesktop ? Object.keys(window.gtradeDesktop).sort() : [],
      uiScale: window.gtradeDesktop && window.gtradeDesktop.uiScale ? await window.gtradeDesktop.uiScale.get() : null,
      innerWidth: window.innerWidth,
      info: window.gtradeDesktop ? await window.gtradeDesktop.getInfo() : null,
      connProbeBlocked: window.gtradeDesktop ? await window.gtradeDesktop.connection.probe('https://localhost:1').then(() => false, (e) => /Not allowed/.test(e.message)) : null,
      title: document.title
    }))()`, true);
    if (process.env.GTRADE_SMOKE_USER && process.env.GTRADE_SMOKE_PASS && result.url.startsWith('https://')) {
      // Real sign-in through the page's own origin (same path the SPA uses); only status codes are kept.
      result.login = await wc.executeJavaScript(`(async () => {
        const r = await fetch('/api/auth/login/', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: ${JSON.stringify(process.env.GTRADE_SMOKE_USER)}, password: ${JSON.stringify(process.env.GTRADE_SMOKE_PASS)} }) });
        const j = await r.json().catch(() => ({}));
        const token = j.access || (j.tokens && j.tokens.access);
        const p = token ? await fetch('/api/auth/profile/', { headers: { Authorization: 'Bearer ' + token } }) : null;
        const prof = p ? await p.json().catch(() => ({})) : {};
        const bad = await fetch('/api/auth/login/', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: ${JSON.stringify(process.env.GTRADE_SMOKE_USER)}, password: 'wrong-password' }) });
        return { loginStatus: r.status, gotToken: Boolean(token), profileStatus: p ? p.status : null, role: prof.role || null,
          wrongPasswordStatus: bad.status };
      })()`, true);
    }
    // Print: window.print() on the live server page must open the app's preview (not the Windows
    // dialog), render real pages and save them as a PDF. Only on the server's page: the shell's own
    // offline/connect pages never print, and their print() is the native one.
    if (current && sec.sameOrigin(result.url, current.serverUrl)) {
      try {
        result.print = await exercisePreview({ preview: printPreview, source: wc, setSavePath: (p) => { testSavePath = p; },
          savePath: `${SMOKE_OUT}.print.pdf` });
      } catch (err) {
        result.print = { error: String(err && err.message || err) };
      }
    } else {
      result.print = { skipped: 'not the server page' };
    }
    const before = wc.getURL();
    await wc.executeJavaScript(`location.href = ${JSON.stringify(NAV_PROBE_URL)}`, true).catch(() => {});
    await new Promise((r) => setTimeout(r, 1500));
    result.externalNavigationBlocked = wc.getURL() === before;
    // The blocked link was routed to the external opener, which in smoke mode opens nothing.
    result.externalOpenSuppressed = openExternal.suppressed.includes(NAV_PROBE_URL);
    result.externalOpenRequests = openExternal.suppressed.length;
    result.ok = true;
  } catch (err) {
    result.error = String(err && err.stack || err);
  }
  fs.writeFileSync(SMOKE_OUT, JSON.stringify(result, null, 2));
  app.exit(0);
}

// ---- print self-test (G-TRADE.exe --print-selftest=<out.json> [--print-selftest-printer=<name>]) ---
async function runPrintSelfTestMode() {
  let code = 1;
  try {
    const r = await runPrintSelfTest({
      electron: { BrowserWindow, app }, preview: printPreview, pagesDir: PAGES, preloadPath: PRELOAD, basePrefs: securePopupPrefs,
      outFile: PRINT_SELFTEST_OUT, printer: PRINT_SELFTEST_PRINTER,
      setSavePath: (p) => { testSavePath = p; },
      // Sample documents are served from 127.0.0.1; treat that origin as "the server" for this run.
      setServerOrigin: (origin) => { current = { serverUrl: origin, caPem: '', caFingerprint: '', mode: 'selftest', source: 'selftest' }; },
    });
    code = r.ok ? 0 : 1;
  } catch (err) {
    try { fs.writeFileSync(PRINT_SELFTEST_OUT, JSON.stringify({ ok: false, error: String(err && err.stack || err) }, null, 2)); } catch { /* none */ }
  }
  app.exit(code);
}

// ---- lifecycle ---------------------------------------------------------------------------------
if (PRINT_SELFTEST_OUT) {
  app.on('window-all-closed', () => { /* the self-test opens and closes windows; it exits itself */ });
  app.whenReady().then(() => {
    setupPrinting();
    registerIpc();
    configureSession(session.defaultSession);
    return runPrintSelfTestMode();
  });
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const w = mainWindow || connectWindow;
    if (w) { if (w.isMinimized()) w.restore(); w.show(); w.focus(); }
  });
  app.whenReady().then(async () => {
    currentScale = uiScale.readScale(uiSettingsFile());
    setupPrinting();
    registerIpc();
    buildMenu();
    configureSession(session.defaultSession);
    const c = conn.loadConnection(userConnFile(), machineConfigFile());
    if (c) await useConnection(c);
    else { createMainWindow(); showOffline(`No ${PRODUCT_NAME} server is configured on this computer yet.`); openConnectWindow(); }
    if (SMOKE_OUT) runSmoke();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => { clearInterval(statusTimer); saveWindowState(mainWindow); });
}
