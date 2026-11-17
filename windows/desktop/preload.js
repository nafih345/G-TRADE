'use strict';
// The ONLY bridge between pages and the desktop shell. Pages get no Node, no ipcRenderer, no fs:
// just these functions. The main process re-checks who is calling on every request
// (connection management is refused for server content).
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

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
