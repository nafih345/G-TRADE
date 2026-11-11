# G-TRADE ERP — Local Installation Audit (Phase 1)

**Date:** 2026-11-10 · **Scope:** read-only technical audit of the existing codebase for a Windows
local-installation edition (Single PC and LAN). No source, database, deployment or git state was
changed. Companion documents: `LOCAL_DEPLOYMENT_ARCHITECTURE.md`, `WINDOWS_COMPATIBILITY_REPORT.md`,
`IMPLEMENTATION_ROADMAP.md`.

Legend: ✅ exists and is usable · ⚠️ exists but needs work · ❌ missing

---

## 1. Executive summary

G-TRADE is a React 19 + Vite SPA talking to a Django 5 / DRF API with JWT auth, row-level
multi-tenancy and PostgreSQL. It is currently built and tuned for a **cloud** deployment
(Vercel + Render + Neon). An earlier **desktop** packaging attempt exists (Electron shell +
PyInstaller `backend.exe` + Inno Setup script, last touched August 2026). It predates
multi-tenancy, the security/backup app and most of the current modules, and it is not a
usable base for the new edition as it stands.

The application logic itself is portable: no Linux-only dependencies, no Celery/Redis, no
object-storage dependency, and backups already work at the ORM level. The work needed is mostly
**packaging, configuration and process management**. A small number of **source changes** will
also be needed in Phase 2. Each one can be additive and gated behind a local-edition flag, so
the cloud deployment does not change.

### The blockers (must be resolved before any customer install)

| # | Finding | Impact |
|---|---------|--------|
| B1 | The frontend's API resolver sends every non-`localhost` origin to the **Render cloud backend** (`frontend/src/utils/backendStatus.js` → `DEFAULT_DEPLOYED_API_URL`). | A LAN client opening `http://SHOP-SERVER:8080` would silently read and write **cloud data**, or fail. |
| B2 | Excel import/export loads `xlsx` from `cdn.jsdelivr.net` at runtime (`ExcelStockImporter.jsx`, `AccountsCOA.jsx`, `Purchases.jsx`). | These features break on an offline shop PC. |
| B3 | With no env vars, `DEBUG` defaults to **True** off-cloud and `SECRET_KEY` falls back to a hard-coded insecure value. `config/settings.json` holds a shared key that `settings.py` never reads. | Every install would share a forgeable JWT signing key and expose tracebacks. |
| B4 | `MEDIA_ROOT`, `STATIC_ROOT` and the SQLite path are anchored to the executable's folder. Media is **not served** when `DEBUG=False` off-cloud (`config/urls.py`). | Logos and product images would 404, and writes into `Program Files` fail under a service account. |
| B5 | Migrations run **automatically on every start** (`launcher.py` + `AUTO_MIGRATE` in `apps/common/startup.py`), and nothing takes a backup first. | An update could apply an irreversible migration with no restore point. |
| B6 | The installer, Electron shell and PyInstaller spec are stale (see §3). | Builds would be missing `apps.billing`, `apps.security` and `whitenoise`, and would fail or misbehave. |

---

## 2. Component-by-component audit

### 2.1 React frontend — `frontend/`

| Item | Status | Detail |
|---|---|---|
| Stack | ✅ | React 19, Vite 7, MUI 5, React Query 5, axios, react-router 6, jsbarcode, qrcode, recharts. |
| Routing | ✅ | `HashRouter` (`App.jsx`), so it works from `file://`, from any sub-path and behind any static server with no rewrite rules. |
| Build base | ✅ | `base: './'` in `vite.config.js`, so assets are relative and portable. |
| API base URL | ❌ **B1** | `resolveApiBaseUrl()` checks in this order: localStorage `api_base_url`, then build-time `VITE_API_URL`, then `''` if the hostname is localhost, otherwise **Render**. A LAN hostname therefore resolves to the cloud. An Electron `file://` page has an empty hostname, which also resolves to the cloud unless `VITE_API_URL` was baked in. |
| CDN dependencies | ❌ **B2** | `xlsx@0.18.5` comes from jsDelivr at runtime. Google Fonts (Outfit, Plus Jakarta Sans) come from `fonts.googleapis.com`. Offline, fonts fall back to system fonts (cosmetic) but Excel features fail (functional). |
| Cloud-specific code | ⚠️ | `index.html` preconnects to `g-trade-backend.onrender.com`. Keep-awake pings and the Render-hibernation 429 handling are harmless locally but should be disabled in a local build. |
| Auth storage | ⚠️ | JWT access and refresh tokens are kept in `localStorage` (`AuthContext.jsx`). This is acceptable on a trusted LAN. Each client PC keeps its own session. |
| Local caches | ⚠️ | 61 files use `localStorage`: master-data cache, wholesale offline queue, drafts. Caches are tenant-scoped and reset-aware (`localDataReset.js`). Pointing a client at a different server needs the scope-change reset, which already exists. |
| Printing | ⚠️ | Everything is HTML printed through the browser (`printInvoice.js`, `printBarcodeLabels.js`, `printEyeTestBill.js`, etc.), so the print dialog appears every time. Silent printing to a named printer is only possible in Electron, and `config/printer.json` exists but **no code reads it**. |
| Barcode scanning | ✅ | Keyboard-wedge (HID) scanners already work. There is a shared matcher (`utils/barcodeMatch.js`) and a scanner guard based on `event.timeStamp` in the POS, New Sale and Purchase Entry screens. No driver work is needed. |

### 2.2 Django backend — `backend/`

| Item | Status | Detail |
|---|---|---|
| Stack | ✅ | Django 5.x, DRF 3.14–3.15, SimpleJWT 5.3, corsheaders, WhiteNoise, Pillow, pandas, openpyxl, psycopg2-binary, dj-database-url, requests. Python **3.12.5** (`.python-version`). |
| Apps | ✅ | `common, authentication, company, billing, masters, products, inventory, purchasing, sales, accounts, financial, security`, with 126 migrations in total (sales 35, products 23, purchasing 14, …). |
| Windows-hostile deps | ✅ none | No Celery, Redis, uWSGI, `fcntl`, or `os.fork` in app code. `gunicorn` is Linux-only but is used only on Render. Waitress is already wired into `launcher.py`. |
| DB config | ⚠️ | There are three sources: `config/database.json`, then the `DB_*` env vars, then `DATABASE_URL`. If none is set it falls back to SQLite. Postgres tuning (keepalives, connect_timeout, the health-check backend `apps.common.db_backends.postgresql`) only applies on the `DATABASE_URL` path. |
| DEBUG / SECRET_KEY | ❌ **B3** | `DEBUG = env('DEBUG', 'False' if IS_CLOUD else 'True')`. `SECRET_KEY` has an insecure default. `SIMPLE_JWT.SIGNING_KEY = SECRET_KEY`, so the key must be unique per install and **must never change on update** (changing it logs everyone out). |
| Host/CORS | ⚠️ | `ALLOWED_HOSTS=['*']` and CORS allow-all when not on cloud. This is fine when the SPA is same-origin behind a proxy, but should be tightened to the server's names/IPs. |
| Paths | ❌ **B4** | `BASE_DIR` is the folder containing the executable (when frozen). `MEDIA_ROOT`, `STATIC_ROOT` and the SQLite path hang off it, and only `BACKUP_DIR` and `BACKUP_TEMP_DIR` are env-overridable. `LOGS_DIR` is `ROOT_DIR/logs` if that folder exists. |
| Media serving | ❌ **B4** | `/media/` is served only when `DEBUG` is on or on cloud. A local `DEBUG=False` build would 404 every uploaded logo and product image, unless a reverse proxy serves `/media/` (which the recommended architecture does). |
| Static | ✅ | WhiteNoise middleware is always on. Hashed manifest storage is cloud-only, so a local build just needs `collectstatic` at build time. |
| Time zone | ✅ | `TIME_ZONE='UTC'`, `USE_TZ=True`, with per-tenant business time zone in preferences. On Windows `zoneinfo` needs the `tzdata` package. Django installs it automatically on win32, but it **must be bundled** into any frozen build. |
| Health | ✅ | `/api/health/live/` (no DB) and `/api/health/` (DB, migrations, version) are ideal for the installer's post-install check and service monitoring. |
| Dangerous tools | ⚠️ | `backend/clear_all_database.py` and `manage.py wipe_database` exist. They **must not ship** in a customer build, or must be disabled behind the edition flag. |

### 2.3 PostgreSQL / database

| Item | Status | Detail |
|---|---|---|
| Engine support | ✅ | Postgres is the production engine. SQLite still works for dev (`backend/db.sqlite3` exists locally). |
| Postgres-only behaviour | ⚠️ | About 40 modules use `select_for_update()` (numbering sequences, Test No, patient codes, stock under lock, `F()` updates). On SQLite `select_for_update` is a **no-op** and writers serialize on a file lock. That is acceptable for one user and **unsafe for concurrent LAN users**, so **PostgreSQL is mandatory for LAN and recommended for Single PC.** No `RunSQL` and no `django.contrib.postgres` are used, so portability stays intact. |
| This dev machine | ℹ️ | PostgreSQL **17 and 18** services are running on this PC (`postgresql-x64-17`, `postgresql-x64-18`, both Automatic). `config/database.json` holds this machine's real Postgres password **in plaintext**. It is git-ignored and excluded by the installer, which is correct, but it should be rotated if this folder is ever shared. |
| Customer PCs | ❌ | No Postgres provisioning exists: no initdb, role or database creation, port selection, or detection of existing data. See the architecture doc. |
| Migrations | ⚠️ **B5** | Migrations are forward-only Django migrations, applied automatically on boot by two separate mechanisms. There is no pre-migration backup, no `--plan` gate and no rollback path. |

### 2.4 API architecture

- REST under `/api/*` with these prefixes: `auth, superadmin, company, billing, masters, products, import,
  inventory, purchase, sales, accounts, financial, security, backups`, plus `/admin/` and the health routes.
- Default pagination is 20 rows. The frontend fetches across pages (`fetchAllPages.js`).
- An `Idempotency-Key` middleware replays re-sent writes. This is valuable on flaky Wi-Fi LANs.
- `X-Branch-Id`, `X-User-Name` and `X-User-Role` headers carry branch context and are whitelisted in CORS.
- `RestoreMaintenanceMiddleware` pauses writes while a restore runs.
- ✅ The whole API is same-origin-friendly: a reverse proxy serving `/` (SPA) and `/api` (Django) on one
  port needs no CORS at all.

### 2.5 Multi-tenant architecture

- There is a tenant FK on every business row, a tenant claim in the JWT, `TenantContextMiddleware`, and
  ORM auto-scoping and stamping (`apps/common/tenancy.py`). Uniqueness is per tenant.
- The platform admin is `is_superuser` plus tenant #1, which gets the Super Admin console (packages, modules,
  seats, deactivation). `manage.py create_tenant` and `tenant_onboarding.onboard_tenant()` create a
  tenant, its Super Admin and its default masters. **The setup wizard can reuse these.**
- Server-wide backups switch off when there is more than one tenant (per-client export-only backups take their place).
- **Local edition implication:** one shop is one tenant. A **decision is required** (see the roadmap):
  either the shop *is* tenant #1, with the platform console hidden by an edition flag, or a hidden
  platform tenant #1 stays and the shop becomes tenant #2. The first keeps full server-wide backups
  and restore, so it is the recommended option.

### 2.6 Environment variables (all currently read by the code)

| Variable | Purpose | Local edition value |
|---|---|---|
| `SECRET_KEY` | Django and JWT signing | Generated per install, stored in an ACL-protected config |
| `DEBUG` | Debug mode | `False` |
| `DATABASE_URL` / `DB_NAME`,`DB_USER`,`DB_PASSWORD`,`DB_HOST`,`DB_PORT` | DB | `postgresql://gtrade:<generated>@127.0.0.1:<port>/gtrade` |
| `AUTO_MIGRATE` | boot-time migrate | `False` (the updater migrates after a backup) |
| `BACKUP_STORAGE`, `BACKUP_DIR`, `BACKUP_TEMP_DIR`, `BACKUP_*_MB` | backups | `filesystem`, `C:\ProgramData\G-TRADE\backups` |
| `BACKUP_SCHEDULER` | in-process scheduler | `True` (Waitress is one process, so exactly one scheduler) |
| `LOGIN_ENABLED_ROLES`, `LOGIN_RATE_LIMIT`, `REAUTH_RATE_LIMIT` | auth | defaults |
| `HOT_CACHE_SECONDS` | per-process cache | default 30 |
| `DJANGO_SUPERUSER_*` | `bootstrap_admin` | **Not used.** The wizard creates the admin through onboarding instead. |
| `FRONTEND_ORIGINS`, `EXPECTED_DATABASE_NAME`, `RENDER*`, `VERCEL`, `DB_TRANSACTION_POOLER`, `GUNICORN_*`, `WEB_CONCURRENCY` | cloud only | unset |
| `VITE_API_URL` (frontend, build time) | API base | must **not** point at the cloud (see B1) |

Missing for the local edition: `MEDIA_ROOT`, `STATIC_ROOT`, `LOGS_DIR`, an edition flag (`GTRADE_EDITION=local`),
and a bind address/port for Waitress.

### 2.7 Authentication

- Real JWT login: 1-day access token, 7-day rotating refresh, HS256 signed with `SECRET_KEY`.
- `apps/security` adds sid-bound sessions, idle timeout, password re-auth for sensitive actions,
  TOTP 2FA (`totp.py`), per-account lockout and throttles.
- `LOGIN_ENABLED_ROLES` defaults to every staff role. Users are created in Administration → Users.
- ✅ Nothing needs the internet. ⚠️ TOTP requires the server clock to be correct, so NTP must be on
  for the LAN server. Windows Time does this by default when the PC is online, but an offline shop PC
  will drift.

### 2.8 File storage

- `FileSystemStorage` only, under `MEDIA_ROOT`: `company_logos/`, `product_images/`,
  `import_batches/`, `purchase_attachments/`. No S3 or Cloudinary.
- ✅ This is simple to relocate to `C:\ProgramData\G-TRADE\media` once `MEDIA_ROOT` is configurable,
  and simple to back up.

### 2.9 Background workers

- **Backup scheduler**: a daemon thread started from `config/wsgi.py`. It ticks every 60 s, claims runs
  with a conditional UPDATE (safe with more than one process) and catches up once after sleep.
- **Excel import engine**: background threads with resumable state in the DB.
- No queue broker. ✅ Waitress (one process, many threads) runs both correctly. **The server process
  must run whether or not anyone is logged in**, so it must be a Windows service and not a child of a
  desktop app.

### 2.10 External integrations (all optional)

| Integration | Where | Local behaviour |
|---|---|---|
| WhatsApp (Meta Cloud API / Twilio) | `apps/sales/views.py` `send_whatsapp_automated_bg`, `utils/whatsappInvoice.js` | Needs internet. Has a 5 s timeout and fails gracefully. |
| Google Fonts | `index.html` | Cosmetic. Should be self-hosted. |
| jsDelivr `xlsx` | 3 components | **Functional**. Must be bundled (B2). |
| Render / Vercel / Neon / GitHub keep-awake cron | deploy files | Not part of the local edition. |

### 2.11 Backup and recovery

- ✅ `apps/security/backup`: logical ORM-level zip archives (manifest, applied migrations, row
  data with checksums), deep validation, compatibility check against the current schema, and a
  **transactional restore** behind a maintenance gate. Schedules can be daily, weekly or monthly in
  business time, with audit logging. Filesystem or DB storage is supported, and `manage.py create_backup`
  and `run_scheduled_backups` exist.
- ⚠️ `config/backup.json` (auto-backup on exit, retention) is **not read by any code**.
- ❌ Missing for local: a **physical** `pg_dump -Fc` layer (faster, independent of app code, the
  right tool for update rollback), **off-machine copies** (USB drive, second disk, network share),
  a pre-update backup gate, and a restore that works when the app itself will not start.

---

## 3. The existing desktop scaffold — what to keep and what to drop

| File | State | Verdict |
|---|---|---|
| `installer.iss` (Inno Setup 6) | Copies Electron output plus `backend.exe` into `{app}` and creates data folders **inside `Program Files`**. Copies `config\*` (including a shared `settings.json`). Has no wizard pages, no services, no DB, no firewall rule, no upgrade or data-preservation logic. | **Rewrite.** Keep the AppId GUID `{A821E310-…}` only if earlier test installs must upgrade in place. Otherwise mint a new G-TRADE AppId. |
| `build_all.py` | Pipeline: Vite build → collectstatic → PyInstaller → electron-builder → ISCC. Uses npmmirror mirrors. | Keep the idea. Replace with a reproducible build script that is version-stamped and checksummed. |
| `backend/backend.spec` | **onefile** build (it extracts to `%TEMP%` on every start: slow, and a classic antivirus false-positive trigger), `upx=True` (also an AV trigger), `console=True`. The hidden-import list **omits `apps.billing`, `apps.security`, `whitenoise`, `dj_database_url`, `apps.common.db_backends`, `tzdata`.** | Replace (see the architecture doc §5). |
| `backend/launcher.py` | Migrates on every launch, binds **127.0.0.1 only** (so no LAN), port from `settings.json`, Waitress with 6 threads. | Replace with a service entry point that has an explicit bind/port and no automatic migrate. |
| `public/electron.js` | Spawns `backend.exe` as a child, treats *anything* answering on :8000 as its backend, restart loop, `taskkill /T /F` on quit, loads the SPA from `file://`. Electron **33** is past its support window. Splash uses `nodeIntegration: true`. | Re-purpose as a **thin client** only (see the architecture doc §7). |
| `backend_dist/backend.exe`, `dist/win-unpacked` | Built 2026-08-19, before multi-tenancy, security and backups. | Stale. Never ship. |
| `config/*.json` | `database.json` (real local password, ignored), `settings.json` (shared secret, unused by settings), `license.json` (demo, **unused**), `printer.json`, `company.json`, `backup.json` (all **unused**). | Replace with one generated `gtrade.ini` / `.env` per install. Store shop identity in the DB (Store Profile already does this). |

---

## 4. Answers to the eight audit questions (summary — detail in the architecture doc)

1. **Best architecture for Windows 10/11:** native Windows services with no Docker: a private
   PostgreSQL 17 instance, the Django API under Waitress, and nginx serving the SPA and proxying
   `/api`. All three run as services, with WinSW as the service wrapper. Clients use a browser in app
   mode or a thin Electron client.
2. **Single PC:** the same stack bound to `127.0.0.1`, with the desktop shortcut opening the app window.
3. **LAN:** one PC runs the services bound to the LAN. Clients install only a shortcut or thin client
   that points at `http://<server>:<port>`. The DB is never exposed on the network.
4. **Docker Compose vs services:** Docker is rejected for customer sites. It needs virtualization in
   the BIOS, runs WSL2 VM overhead and only starts with a user login, and Docker Desktop has licensing
   terms. Native services are chosen instead.
5. **PostgreSQL:** bundle the binaries, run `initdb` into `C:\ProgramData\G-TRADE\pgsql\data`, use a
   dedicated port (not 5432) and service name, listen on localhost only, and use a generated password.
   An existing data directory is never re-initialised.
6. **Nginx:** suitable at shop scale (tens of clients) despite nginx-for-Windows' `select()`
   limits. It serves the SPA, `/static`, `/media` and large uploads, and proxies `/api` and `/admin`.
   Caddy is the documented fallback.
7. **Printers and scanners:** printing happens on the client PC through its own Windows drivers.
   Silent printing to a named thermal or label printer requires the Electron thin client. Scanners must
   be USB HID keyboard mode with an Enter suffix.
8. **No terminals:** services start automatically at boot, the desktop shortcut opens the app window,
   and a tray "G-TRADE Server Manager" provides start, stop, status, backup and logs.

---

## 5. Risk register

| ID | Risk | Likelihood | Severity | Mitigation |
|---|---|---|---|---|
| R1 | LAN client writes to cloud backend (B1) | High (certain without a fix) | Critical | Local build flag forces same-origin `''`, plus an installer smoke test that asserts `/api/health/` comes from the local host. |
| R2 | Shared or default `SECRET_KEY` (B3) | High | Critical | Generate per install. Never regenerate on upgrade. |
| R3 | Update migrates with no restore point (B5) | Medium | Critical | `AUTO_MIGRATE=False`. Updater: stop → `pg_dump` → migrate → health check → roll back on failure. |
| R4 | Installer re-initialises or overwrites an existing DB | Low | Critical | Detect `PG_VERSION` / existing service / existing DB. Initialise only an empty folder. Upgrade otherwise. |
| R5 | Uninstall deletes customer data | Medium | Critical | Data lives in `ProgramData`, outside `{app}`. The uninstaller keeps it by default and needs a typed confirmation to delete. |
| R6 | Port clash with an existing Postgres (this PC has 17 and 18 on 5432) or a web server | High | Medium | Private instance on a configurable port (default 5544). The wizard probes ports. |
| R7 | SmartScreen / **Smart App Control** blocks an unsigned installer (Win11 clean installs) | High | High | Code-sign the installer and every exe/dll we ship. |
| R8 | Antivirus quarantines the frozen Python exe | Medium | High | Use onedir or embedded Python (no onefile, no UPX), sign the files, and submit to AV vendors. |
| R9 | Server PC sleeps, gets a new DHCP IP, or Windows Update reboots it mid-day | High | Medium | Installer sets the power plan, the wizard recommends a DHCP reservation, clients connect by hostname with an IP fallback, and Active Hours are set. |
| R10 | Firewall / "Public" network profile blocks clients | High | Medium | Add an inbound rule (Private profile) for the app port only. The wizard warns when the network is Public. |
| R11 | Offline features fail (B2, fonts, WhatsApp) | High | Medium | Bundle `xlsx` and the fonts. WhatsApp is shown as an "internet required" feature. |
| R12 | Clock drift breaks 2FA and the backup schedule | Medium | Low | Health check reports clock skew. Document NTP. |
| R13 | `wipe_database` / `clear_all_database.py` reachable on a customer PC | Low | Critical | Exclude from the build and refuse them under `GTRADE_EDITION=local`. |
| R14 | Windows 10 is out of mainstream support (ended 2025-10-14) | Certain | Medium | Supported on a best-effort basis. Win11 recommended for the LAN server. See the compatibility report. |
| R15 | SQLite used for LAN by mistake | Low | High | Local edition refuses SQLite outside dev, similar to the existing `IS_CLOUD` guard. |
| R16 | Cloud behaviour regresses because of local-edition changes | Medium | High | Every change is gated on `GTRADE_EDITION=local`, and the cloud test suite runs unchanged. |
| R17 | Disk failure loses everything (single server) | Medium | Critical | Nightly `pg_dump` plus media zip, copied to a second drive / USB / share, with a restore drill in the onboarding checklist. |
