// Which build this is. `VITE_EDITION=local` is set only by the Windows local-edition build
// (windows/tooling/build_frontend.py); the hosted cloud build leaves it unset.
// __GTRADE_EDITION__ is a Vite `define` constant (vite.config.js), so the minifier folds this to a
// literal and drops the other edition's code paths. Under node --test it is undefined.
// eslint-disable-next-line no-undef
export const IS_LOCAL_EDITION = typeof __GTRADE_EDITION__ !== 'undefined' && __GTRADE_EDITION__ === 'local';

// SheetJS for Excel import. The cloud build keeps loading it from the CDN as before; the local
// edition serves a pinned copy from its own origin so imports work on an offline shop LAN.
export const XLSX_SCRIPT_URL = IS_LOCAL_EDITION
  ? './vendor/xlsx.full.min.js'
  : 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';

// The Electron desktop shell (windows/desktop/preload.js) exposes this bridge; plain browsers don't.
export const desktopBridge = () => (typeof window !== 'undefined' ? window.gtradeDesktop || null : null);
