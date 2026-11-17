'use strict';
// Interface size (application-level scale) for the desktop shell.
//
// ONE mechanism: Chromium's native page zoom on the MAIN window only (webContents.setZoomFactor).
// Unlike CSS zoom/transform it keeps vh layouts, popover/menu positioning, media queries and hit
// testing consistent, and printing / printToPDF ignore it (bills, thermal receipts, labels and PDFs
// keep their physical size — verified in test/uiScale.test.js and the release report).
// Never set a zoom factor on popups: Chromium's zoom map is per-origin, so changing a same-origin
// popup changes the main window too. about:blank print popups always open at 100%.
//
// The choice is a per-Windows-user display convenience stored in userData\ui-settings.json; it
// never touches Windows display scaling or resolution.

const fs = require('node:fs');
const path = require('node:path');

const SCALES = Object.freeze([0.75, 0.8, 0.9, 1]);
// 100 %: the application's own size. 75 / 80 / 90 % stay available for anyone who wants it smaller.
const DEFAULT_SCALE = 1;
const FILE_NAME = 'ui-settings.json';

// Accepts 0.8, "0.8", 80 or "80%" — anything else (NaN, 0.5, 3, objects) is not a valid scale.
function normalizeScale(value) {
  let n = typeof value === 'string' ? parseFloat(value.replace('%', '')) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  if (n > 2) n /= 100;
  const hit = SCALES.find((s) => Math.abs(s - n) < 0.001);
  return hit === undefined ? null : hit;
}

function readScale(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return normalizeScale(raw && raw.scale) ?? DEFAULT_SCALE;
  } catch {
    return DEFAULT_SCALE; // first run, unreadable or corrupt file: the default, never a crash
  }
}

function writeScale(file, value) {
  const scale = normalizeScale(value);
  if (scale === null) throw new Error(`Interface size must be one of ${SCALES.map(label).join(', ')}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ scale, updatedAt: new Date().toISOString() }, null, 2));
  fs.renameSync(tmp, file);
  return scale;
}

const label = (scale) => `${Math.round(scale * 100)}%`;

function stepScale(current, direction) {
  const i = SCALES.indexOf(normalizeScale(current) ?? DEFAULT_SCALE);
  return SCALES[Math.max(0, Math.min(SCALES.length - 1, i + (direction > 0 ? 1 : -1)))];
}

const describe = (scale) => ({ scale, defaultScale: DEFAULT_SCALE, options: [...SCALES] });

module.exports = { SCALES, DEFAULT_SCALE, FILE_NAME, normalizeScale, readScale, writeScale, stepScale, label, describe };
