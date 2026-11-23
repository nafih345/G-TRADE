'use strict';
// Bridge for the print preview window (pages/print-preview.html) only. The main process binds
// every call to the preview's own document: a page cannot reach any other window's print job.
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('gtradePrintPreview', Object.freeze({
  init: () => invoke('preview:init'),
  render: (settings) => invoke('preview:render', settings),
  printers: (refresh) => invoke('preview:printers', { refresh: Boolean(refresh) }),
  print: (settings) => invoke('preview:print', settings),
  systemDialog: (settings) => invoke('preview:systemDialog', settings),
  savePdf: (settings) => invoke('preview:savePdf', settings),
  reveal: (how) => invoke('preview:reveal', how === 'open' ? 'open' : 'folder'),
  close: () => invoke('preview:close'),
  onSourceGone: (callback) => {
    if (typeof callback === 'function') ipcRenderer.on('preview:source-gone', () => callback());
  },
}));
