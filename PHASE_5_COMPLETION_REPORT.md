# Phase 5: Electron Desktop Application (Completion Report)

**Date:** 2026-11-12 · **Status:** complete and verified on a real Windows 11 desktop (non-elevated). Nothing committed, pushed or deployed.

## 1. Architecture

The desktop app (`windows/desktop/`) is a **thin client**:
- It never starts a backend and never holds DB credentials or server secrets.
- It loads the SPA from the installation's own HTTPS server. Standalone uses `https://localhost:8443`; LAN uses `https://<server>:8443`.
- It trusts that server **only** through the pinned per-installation CA.
- The old scaffold (`public/electron.js`) is left untouched. It spawned `backend.exe` and trusted anything on :8000. It is retired from the commercial build.

| Requirement | Implementation |
|---|---|
| Electron shell | **Electron 44.9.3** (a supported major; released 2026-10-21). App id `com.gtrade.erp`, product "G-TRADE ERP" (D8). `main.js`. |
| React frontend integration | The existing SPA is built with `VITE_EDITION=local` (`windows/tooling/build_frontend.py`, output `frontend/dist-local`). The edition is a Vite `define` constant folded at build time, so the cloud bundle is unchanged apart from dead code removal. The local build has: same-origin API (the localStorage override is ignored); no Google Fonts or Render preconnect; SheetJS vendored at `/vendor/xlsx.full.min.js` (SHA-256 pinned, identical to the npm tarball). A build-time scan confirms no external hosts in the HTML or bundle. |
| Secure configuration | `contextIsolation: true`, `sandbox: true` (plus `app.enableSandbox()` for every renderer), `nodeIntegration: false`, `webSecurity: true`, no `allowRunningInsecureContent`, `<webview>` blocked, DevTools only in unpacked builds. Every web permission is denied except clipboard write. |
| Secure IPC | One preload bridge (`window.gtradeDesktop`, frozen). The main process checks **the calling frame's origin** on every call. Server pages may call `getInfo`, `getStatus`, `print` (options whitelisted), `listPrinters` and the window controls. Only the app's own local pages may call **connection management** (`probe`, `pair`, `useMachineDefault`, `retry`). |
| TLS pinning | `session.setCertificateVerifyProc` checks four things for the server host: CA PEM == stored fingerprint, leaf issued **and signed** by that CA, validity dates, and hostname/IP in the SAN. Any other host gets Chromium's normal verification. |
| Navigation | `will-navigate`/`will-redirect` allow only the server origin and the app's own pages. Popups are allowed only for `about:blank` and same-origin (bill, label and report printing), with the same locked-down preferences. `https:`/`mailto:` links go to the system browser; anything else (`file:`, `javascript:`) is dropped. |
| Startup / shutdown | Single-instance lock (a second launch focuses the window). Window position and maximised state persist. `before-quit` stops the status loop and saves the state. A renderer crash shows the offline page. |
| Server connection management | Machine default `%ProgramData%\G-TRADE\client\client.json` (written by the installer). A per-user override lives in `userData\connection.json`. A stored connection is rejected if the CA PEM does not match its fingerprint (tamper check). |
| Standalone and LAN server | The installer writes `https://localhost:<port>` and the local CA. |
| LAN workstation | First run or *File → Server connection…* opens the connect window: address → probe the CA → show the fingerprint → **pairing code** (first 4 bytes of the CA fingerprint, constant-time compare) → pinned health check → save. |
| Login and session | The existing JWT login and server sessions (sid-bound, timeout, 2FA) run unchanged on the server origin. The token stays in that origin's storage inside Electron's profile. |
| Version display | `DesktopStatus` badge (bottom right, desktop only) shows the app and server versions. *Help → About* shows app, server, CA fingerprint, Electron and Chromium versions. |
| Connection status | A pinned `/api/health/` check every 20 s, giving `online`, `degraded` (maintenance, migrations, client too old) or `offline`. The status is pushed to every window. The offline page has Retry and Connection settings, and reconnects automatically. |
| Version compatibility | A client older than the server's `min_client_version` gets a one-time warning and a `degraded` badge. |
| Min/max/close | Native frame. Menu *Window → Minimize / Maximize-Restore / Close*. Bridge `window.minimize / toggleMaximize / close`. Closing the last window quits the app. |

## 2. Shared frontend changes (cloud-safe)

| File | Change |
|---|---|
| `src/utils/edition.js` (new) | `IS_LOCAL_EDITION`, `XLSX_SCRIPT_URL` (cloud: the same CDN URL as before), `desktopBridge()` |
| `src/utils/backendStatus.js` | `resolveApiBaseUrl()` returns `''` only in the local edition |
| `ExcelStockImporter.jsx`, `AccountsCOA.jsx`, `Purchases.jsx` | Use `XLSX_SCRIPT_URL` instead of the hard-coded CDN string |
| `src/components/DesktopStatus.jsx` (new), `App.jsx` | Badge rendered next to `NotificationHost`. It returns `null` outside Electron. |
| `vite.config.js` | `define __GTRADE_EDITION__`; local build output goes to `dist-local` and strips the external `<link>` lines. The cloud build output folder is unchanged (`dist`). |

## 3. Tests

| Suite | Result |
|---|---|
| `windows/desktop/test/desktop.test.js` (9 tests): URL normalisation, navigation policy, pairing code, pinned-leaf verification (right CA, rogue CA, wrong host, expiry), version compare, print/permission whitelist, config tamper check, real TLS probe and pinned health, client-too-old, unreachable | **9/9 pass** |
| Frontend unit suites (22 scripts + inventoryCache) | **195/195 pass** (same as the Phase 2 baseline) |
| Local SPA production build | OK; no external hosts in the HTML or bundle |
| `windows/tests/test_desktop_install_e2e.py` (real Electron on Windows 11 against the real stack) | **4/4 pass** (171 s) |

Real-desktop evidence (`windows/out/evidence/desktop_install_e2e.json`):
- **Window and preferences:** URL `https://localhost:18453/`, status `online` (server 1.0.0). webPreferences: `contextIsolation true`, `sandbox true`, `nodeIntegration false`, `webSecurity true`.
- **Page isolation:** `typeof require` and `typeof process` are `undefined` in the page. Bridge keys: connection, getInfo, getStatus, listPrinters, onConnectionStatus, openConnectionSettings, print, window. A connection call from server content is refused ("Not allowed"), and the info returned contains no CA PEM.
- **Navigation:** navigating to `https://example.com` was blocked.
- **Real login through the page:** 200 with a token; profile 200, role `SUPER_ADMIN`; wrong password 401.
- **Rogue CA in client.json:** the window refuses the server and shows the offline page ("Security check failed: self signed certificate in certificate chain").

## 4. Open items

| Item | Action |
|---|---|
| Visible "GreenSol Optical ERP" strings (page title, print headers) | Rebrand sweep (D8 follow-up; content, not security) |
| Silent printing per printer role (receipt, A4, label) | The bridge already exposes `print({silent, deviceName})` and `listPrinters()`. Wiring the Bill/Label designers to a per-PC printer map is a feature follow-up; today printing uses the normal Windows print dialog, which works in Electron. |
| Code signing of `G-TRADE.exe` | Needs the certificate (D6). electron-builder signs automatically once it is configured. |
| Electron auto-update | Workstations update via the installer from the LAN server mirror (Phase 8 design); `electron-updater` is not wired in v1. |
