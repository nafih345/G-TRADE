'use strict';
// Windows' own view of the installed printers (default, port, driver, offline), which Electron 44's
// getPrintersAsync() no longer reports. Read with one fixed PowerShell CIM query, cached briefly.
// Never fatal: on any failure the preview falls back to Electron's list and name-based rules.

const { execFile } = require('node:child_process');
const path = require('node:path');
const { parsePrinterInventory } = require('./printing');

const CACHE_MS = 30000;
const TIMEOUT_MS = 12000;
const QUERY = 'Get-CimInstance -ClassName Win32_Printer | Select-Object Name,Default,PortName,DriverName,WorkOffline,'
  + 'PrinterStatus,Network,Local,Shared,PrinterPaperNames | ConvertTo-Json -Depth 3 -Compress';

function powershellPath() {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  return path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function createPrinterInventory({ run = defaultRun, now = () => Date.now(), platform = process.platform } = {}) {
  let cache = null; // { at, list }
  let inFlight = null;

  async function get({ refresh = false } = {}) {
    if (platform !== 'win32') return null;
    if (!refresh && cache && now() - cache.at < CACHE_MS) return cache.list;
    if (inFlight) return inFlight;
    inFlight = run().then((text) => {
      const list = parsePrinterInventory(text);
      if (list) cache = { at: now(), list };
      return list;
    }).catch(() => null).finally(() => { inFlight = null; });
    return inFlight;
  }
  return { get, clear: () => { cache = null; } };
}

function defaultRun() {
  return new Promise((resolve, reject) => {
    execFile(powershellPath(), ['-NoProfile', '-NonInteractive', '-Command', QUERY],
      { windowsHide: true, timeout: TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(String(stdout || ''))));
  });
}

module.exports = { createPrinterInventory, QUERY, powershellPath };
