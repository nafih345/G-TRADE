// Interface size (75 / 80 / 90 / 100 %) — desktop edition only.
//
// The scale is applied by the desktop shell as Chromium's native page zoom on the main window
// (windows/desktop/lib/uiScale.js), which the shell also persists across restarts. The web app
// itself applies NO CSS zoom/transform: one mechanism only, so popovers, vh layouts and printed
// bills / receipts / labels / PDFs keep their real dimensions. In a plain browser (cloud) the
// control is hidden and the browser's own zoom applies as before.
import { desktopBridge } from './edition.js';

export const UI_SCALE_OPTIONS = Object.freeze([0.75, 0.8, 0.9, 1]);
export const DEFAULT_UI_SCALE = 1;    // the application's own size; must match windows/desktop/lib/uiScale.js

// The bridge exists only in a desktop shell new enough to support interface size.
export const scaleBridge = (bridge = desktopBridge()) => {
  const b = bridge && bridge.uiScale;
  return b && typeof b.get === 'function' && typeof b.set === 'function' ? b : null;
};

export const formatScale = (scale) => `${Math.round(Number(scale) * 100)}%`;

export const isSupportedScale = (scale) => UI_SCALE_OPTIONS.some((s) => Math.abs(s - Number(scale)) < 0.001);

// Menu rows for the header control: label, whether it is the active and/or default choice.
export const scaleMenuItems = (current, options = UI_SCALE_OPTIONS, defaultScale = DEFAULT_UI_SCALE) =>
  options.map((scale) => ({
    scale,
    label: formatScale(scale) + (Math.abs(scale - defaultScale) < 0.001 ? ' (default)' : ''),
    selected: Math.abs(scale - Number(current)) < 0.001,
  }));
