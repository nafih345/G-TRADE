'use strict';
// The ONLY bridge between pages and the desktop shell. Pages get no Node, no ipcRenderer, no fs:
// just these functions. The main process re-checks who is calling on every request
// (connection management is refused for server content).
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);
// The app's own print preview for THIS window (see lib/printPreview.js). Resolves when the preview
// closes: { outcome: 'printed' | 'saved' | 'cancelled', printer, path }.
const openPrintPreview = () => invoke('print:preview');

contextBridge.exposeInMainWorld('gtradeDesktop', Object.freeze({
  getInfo: () => invoke('app:getInfo'),
  getStatus: () => invoke('app:getStatus'),
  onConnectionStatus: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('gtrade:status', listener);
    invoke('app:getStatus').then(callback).catch(() => {});
    return () => ipcRenderer.removeListener('gtrade:status', listener);
  },
  openConnectionSettings: () => invoke('app:openConnectionSettings'),
  print: (options) => invoke('app:print', options),
  printPreview: () => openPrintPreview(),
  listPrinters: () => invoke('app:listPrinters'),
  // Interface size of this window (75 / 80 / 90 / 100 %); the shell validates and remembers it.
  uiScale: Object.freeze({
    get: () => invoke('ui:getScale'),
    set: (scale) => invoke('ui:setScale', Number(scale)),
    onChange: (callback) => {
      if (typeof callback !== 'function') return () => {};
      const listener = (_event, info) => callback(info);
      ipcRenderer.on('gtrade:uiScale', listener);
      return () => ipcRenderer.removeListener('gtrade:uiScale', listener);
    },
  }),
  window: Object.freeze({
    minimize: () => invoke('win:minimize'),
    toggleMaximize: () => invoke('win:toggleMaximize'),
    close: () => invoke('win:close'),
  }),
  connection: Object.freeze({
    probe: (serverUrl) => invoke('conn:probe', String(serverUrl || '')),
    pair: (serverUrl, code) => invoke('conn:pair', { serverUrl: String(serverUrl || ''), code: String(code || '') }),
    useMachineDefault: () => invoke('conn:useMachineDefault'),
    retry: () => invoke('conn:retry'),
  }),
}));

// window.print() opens the app's print preview instead of going straight to the Windows print
// dialog (which has no preview for Electron apps: "This app doesn't support print preview").
// This runs before any page script, in the main window and in every print pop-up (the pop-up's
// about:blank document keeps it through document.open/write), so existing print buttons need no
// change. If the shell ever refuses, the page falls back to the native print path.
if (location.protocol !== 'file:') {
  try {
    contextBridge.executeInMainWorld({
      func: (open) => {
        const nativePrint = window.print;
        const print = function print() {
          return open().catch(() => { try { nativePrint.call(window); } catch (e) { /* nothing else to try */ } });
        };
        Object.defineProperty(window, 'print', { value: print, configurable: true, enumerable: true, writable: true });
      },
      args: [openPrintPreview],
    });
  } catch { /* window.print stays native */ }
}
