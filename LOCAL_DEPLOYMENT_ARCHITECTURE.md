# G-TRADE ERP — Local Deployment Architecture (proposed)

**Status:** Proposal for approval. Nothing here is implemented yet. Findings it relies on are in
`LOCAL_INSTALLATION_AUDIT.md`. Ports, names and paths are defaults the installer can change.

---

## 1. Decision summary

| Concern | Decision | Rejected alternatives |
|---|---|---|
| Process model | **Native Windows services** | Docker Compose (see §3), Electron-spawned child process (current scaffold) |
| Service wrapper | **WinSW** (MIT, maintained, XML config, log rotation, restart policies) | NSSM (unmaintained since 2017), `pywin32` service (more code, harder to debug), Task Scheduler (no proper restart semantics) |
| Database | **Private PostgreSQL 17.x instance** bundled with the installer | SQLite (unsafe with concurrent writers), the customer's existing Postgres (unknown version and credentials, port 5432 conflicts) |
| App server | **Waitress** (pure Python, Windows-native, already used in `launcher.py`) | gunicorn (no Windows support), uvicorn (the app is WSGI), `runserver` (dev only) |
| Python runtime | **Embedded CPython 3.12 x64 + vendored site-packages**, compiled to `.pyc` | PyInstaller onefile (extracts to `%TEMP%` on every start, AV false positives, current spec is broken). PyInstaller onedir is acceptable as a fallback. |
| Web front door | **nginx for Windows (stable)** serving the SPA, `/static` and `/media`, and proxying `/api` and `/admin` | Django serving the SPA (needs code + WhiteNoise index fallback), IIS (heavy, not on Home editions). Caddy is the documented fallback. |
| Client UI | **G-TRADE Desktop**: thin Electron client (silent printing, kiosk-style window). Fallback: an **Edge app-mode** shortcut with zero install. | Full Electron bundle with backend (current scaffold) |
| Installer | **Inno Setup 6** (see §9) | WiX (kept as the option for MSI/GPO enterprise rollout) |

---

## 2. Topologies

### 2.1 Single PC

```
┌───────────────────────── Shop PC (Windows 10/11) ─────────────────────────┐
│                                                                           │
│  G-TRADE Desktop (or Edge --app) ──► http://127.0.0.1:8080                │
│                                            │                              │
│                          ┌─────────────────▼───────────────┐              │
│   service: GTrade-Web    │ nginx  :8080 (bind 127.0.0.1)   │              │
│                          │  /            → frontend\dist   │              │
│                          │  /static,/media → files         │              │
│                          │  /api,/admin  → 127.0.0.1:8001  │              │
│                          └─────────────────┬───────────────┘              │
│   service: GTrade-App    ┌─────────────────▼───────────────┐              │
│                          │ Waitress + Django  127.0.0.1:8001│  scheduler  │
│                          └─────────────────┬───────────────┘   thread    │
│   service: GTrade-DB     ┌─────────────────▼───────────────┐              │
│                          │ PostgreSQL 17  127.0.0.1:5544   │              │
│                          └─────────────────────────────────┘              │
│  C:\ProgramData\G-TRADE\  pgsql\data · media · backups · logs · config    │
└───────────────────────────────────────────────────────────────────────────┘
```

### 2.2 LAN (one server, many clients)

```
 Client PC 1 ─┐                       ┌──────────── LAN Server PC ────────────┐
 Client PC 2 ─┼── http://GTRADE-SRV:8080 ──► nginx :8080 (bind 0.0.0.0,      │
 Client PC n ─┘    (Private network,  │     firewall: Private profile only)   │
   thin client     inbound TCP 8080)  │       └► Waitress 127.0.0.1:8001      │
   + local                            │            └► Postgres 127.0.0.1:5544 │
   printers/scanner                   │  (Postgres and Waitress are never      │
                                      │   reachable from the LAN)              │
                                      └────────────────────────────────────────┘
```

Rules:
- **Only nginx listens on the LAN.** Postgres and Waitress bind to loopback, so only one firewall
  rule is needed and the DB stays protected.
- The server PC can also be used as a till: it gets the client shortcut too.
- Clients store nothing authoritative. Printers and scanners attach to the client PC.
- Clients find the server by **hostname** (NetBIOS/LLMNR works on a flat shop LAN), with the
  last-known IP as fallback. The installer recommends a DHCP reservation for the server.

---

## 3. Docker Compose vs Windows services

| Criterion | Docker Desktop + Compose | Native services (chosen) |
|---|---|---|
| Prerequisites | Hardware virtualization enabled in BIOS (often off on shop PCs), WSL2 kernel, ~2–4 GB RAM for the VM | None beyond Windows and the VC++ runtime |
| Runs without a logged-in user | **No.** Docker Desktop is a per-user app. Containers start only after login. | Yes. Services start at boot. |
| Startup time after boot | 30–90 s (VM + engine) | ~5–10 s |
| Licensing | Docker Desktop requires a paid subscription for larger organisations. Distributing it to customers needs review. | PostgreSQL (PostgreSQL License), nginx (BSD-2), WinSW (MIT), Python (PSF). All redistributable. |
| Windows Home | Works via WSL2, with the caveats above | Works |
| Support burden at the shop | High (WSL updates, VM disk growth, network NAT quirks) | Low (Services console, Event Log) |
| Printers / USB | Irrelevant (printing is client-side) | Irrelevant |
| Dev/CI usefulness | Good | — |

**Verdict:** no Docker on customer machines. A `docker-compose.yml` can still be added later for
developers and CI to mirror the local stack, but it is not part of the product.

---

## 4. PostgreSQL — installation and persistence

| Item | Specification |
|---|---|
| Version | PostgreSQL **17.x** x64 (Windows binaries ZIP, not the EDB GUI installer, so the install is silent and controlled). Pin the minor version per G-TRADE release. |
| Location | Binaries in `C:\Program Files\G-TRADE ERP\runtime\pgsql\` (read-only). **Data in `C:\ProgramData\G-TRADE\pgsql\data`**, outside the app folder, so it survives reinstall and uninstall. |
| Service | `GTrade-DB`, registered with `pg_ctl register -N GTrade-DB -S auto`, runs as `NT AUTHORITY\NetworkService` (Postgres refuses to run as an administrator). The data folder ACL grants that account full control and denies the Users group. |
| Network | `listen_addresses = 'localhost'`, port **5544** by default (the wizard probes for a free port). `pg_hba.conf`: `scram-sha-256` for `127.0.0.1/32` and `::1/128` only. |
| Roles | Superuser `postgres` with a generated password, kept only for maintenance and never used by the app. App role `gtrade` owns database `gtrade` (UTF8, `C` collation / `en-US` ctype, ICU optional). Passwords are generated with a CSPRNG and stored DPAPI-encrypted, or in an ACL-restricted file in `C:\ProgramData\G-TRADE\config\`. |
| Tuning (defaults by RAM) | `shared_buffers` 25% of RAM (max 2 GB), `effective_cache_size` 50%, `work_mem` 16 MB, `max_connections` 50 (Waitress 16 threads + headroom), `wal_level=replica`, `max_wal_size` 2 GB, `checkpoint_timeout` 15 min, `log_min_duration_statement` 1000 ms. |
| Init (fresh only) | `initdb -U postgres -E UTF8 --auth=scram-sha-256 --pwfile=<tmp>` runs **only if the data folder has no `PG_VERSION`**. If one exists, the installer takes the upgrade path. If the folder is non-empty and not a cluster, it stops and asks. **There is no code path that deletes or re-initialises an existing cluster.** |
| Major upgrades | Never in place automatically. A G-TRADE release that moves to a new PG major ships both binaries and runs `pg_upgrade --check`, then `pg_upgrade` into a new data folder. The old folder is kept until the user confirms. As an alternative: dump, restore, then switch. |
| Coexistence | A customer's own Postgres on 5432 is left untouched. Ours has its own service name, port and data folder. |

---

## 5. Application runtime (Django under Waitress)

- **Layout:** `C:\Program Files\G-TRADE ERP\` contains `app\<version>\backend\` (source compiled to
  `.pyc`), `runtime\python\` (embedded CPython 3.12 + `Lib\site-packages`), `runtime\pgsql\`,
  `runtime\nginx\`, `runtime\winsw\`, `frontend\<version>\dist\` and `bin\gtrade-ctl.exe`.
- **Versioned folders.** An update installs `app\1.5.0\` next to `app\1.4.2\`, and a small
  `current.json` names the active one. Rollback is a pointer switch plus a DB restore, which is fast
  and needs no reinstall.
- **Service `GTrade-App`** (WinSW) runs
  `python.exe -m gtrade_server --bind 127.0.0.1 --port 8001 --threads 16` with the environment from
  `C:\ProgramData\G-TRADE\config\gtrade.env`. It restarts on failure (5 s, 10 s, 30 s), logs to
  `ProgramData\G-TRADE\logs\app\` with size rotation, and has a service dependency on `GTrade-DB`.
- **New entry point (Phase 2, additive):** a local server module that waits for the DB, **does not
  migrate**, serves via Waitress, and exits non-zero if the schema is behind the code, so the updater
  must migrate explicitly.
- **Settings overlay (Phase 2, additive):** a new `config/settings_local.py` that imports the base
  settings and overrides `DEBUG=False`, `SECRET_KEY` from env (required), DB from env with the same
  Postgres tuning the `DATABASE_URL` path gets, `MEDIA_ROOT`/`STATIC_ROOT`/`LOGS_DIR`/`BACKUP_DIR`
  under ProgramData, `ALLOWED_HOSTS` = server hostname + IPs + localhost, `AUTO_MIGRATE=False`,
  refuses SQLite, and disables `wipe_database`. `DJANGO_SETTINGS_MODULE=config.settings_local`.
  The cloud keeps `config.settings` untouched.
- **Background work:** one Waitress process runs exactly one backup-scheduler thread plus the
  import threads. No broker is needed.

---

## 6. nginx (front door)

```nginx
# C:\ProgramData\G-TRADE\config\nginx.conf  (generated by the installer)
worker_processes  1;
events { worker_connections 1024; }          # nginx/Windows uses select(): ~1024 sockets max
http {
  include       mime.types;
  sendfile      on;
  gzip          on;  gzip_types text/css application/javascript application/json image/svg+xml;
  client_max_body_size 1100m;                # BACKUP_MAX_UPLOAD_MB=1024 + Excel imports
  proxy_read_timeout  300s;                  # heavy reports / restores
  server {
    listen      8080;                        # 127.0.0.1:8080 on Single PC
    server_name _;
    root        "C:/Program Files/G-TRADE ERP/frontend/current/dist";
    location = /index.html { add_header Cache-Control "no-cache"; }
    location /assets/  { expires 1y; add_header Cache-Control "public, immutable"; }
    location /static/  { alias "C:/ProgramData/G-TRADE/static/"; expires 7d; }
    location /media/   { alias "C:/ProgramData/G-TRADE/media/"; }
    location ~ ^/(api|admin)/ {
      proxy_pass http://127.0.0.1:8001;
      proxy_set_header Host $host;
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
      proxy_set_header X-Forwarded-Proto $scheme;
    }
    location / { try_files $uri /index.html; }
  }
}
```

- Because the app uses `HashRouter`, the `try_files` fallback is only a safety net.
- Serving `/media/` from nginx removes audit blocker B4 without changing Django's URL config.
- nginx-for-Windows limits (the `select()` model, one effective worker, documented as lower
  performance than Unix) do not matter at shop scale (≤ 25 clients, mostly API calls). It runs as
  service `GTrade-Web` under WinSW and depends on `GTrade-App`.
- **Caddy fallback:** if nginx on Windows causes problems in testing, Caddy is one Go binary with an
  equivalent ~15-line Caddyfile and native Windows behaviour. Swapping it in changes only the `GTrade-Web` service.
- **HTTPS on the LAN** is optional and deferred to a later phase. The plan for it is a per-install
  local CA whose certificate the client installer trusts. Plain HTTP on a private shop LAN is
  acceptable for v1, with the risk documented (JWTs travel unencrypted on the LAN).

---

## 7. Client UI and "no terminals"

**G-TRADE Desktop (recommended)** is the existing Electron shell reduced to a thin client:
- It loads `http://<server>:8080/` (a real origin, not `file://`), keeps the single-instance lock,
  window state and splash screen, and removes all backend spawning and `taskkill` logic.
- First run shows "Connect to server": the wizard has already written `localhost` for a single PC or
  the server host for a LAN client. It tests `/api/health/live/` and offers retry and change-server.
- **Silent printing:** `webContents.print({ silent: true, deviceName })` through the existing
  `electronAPI.printInvoice` bridge, with per-PC printer mapping (receipt, A4, label) stored locally
  on that client. The current `config/printer.json` fields become this mapping.
- It must be on a supported Electron major, with `contextIsolation` on everywhere (fix the splash).

**Zero-install fallback:** a shortcut to
`msedge.exe --app=http://GTRADE-SRV:8080/ --user-data-dir=%LOCALAPPDATA%\G-TRADE\edge`.
Edge ships with Windows 10 and 11. The print dialog appears on every print.

**Frontend requirement (Phase 2, additive):** a local-edition build flag that makes
`resolveApiBaseUrl()` return `''` (same origin) for any host and disables the cloud keep-awake,
preconnect and Render-specific handling. It also bundles `xlsx` and the two font families.
Without this, audit blocker B1 sends LAN traffic to the cloud.

**No terminals, ever:**
- All three services start automatically at boot.
- **G-TRADE Server Manager** is a small tray app on the server or single PC. It shows service status
  (green, amber or red), offers Start/Stop/Restart, "Back up now", "Open backups folder", "Open logs",
  "Restore…" and "Copy client connection address", and warns when the network is Public.
- **`gtrade-ctl.exe`**, the engine behind the installer, updater and tray app, has these commands:
  `init-db`, `create-shop`, `migrate --plan|--apply`, `backup`, `restore`, `health`,
  `set-port`, `firewall`, `diagnostics` (zips logs and config with secrets removed for support).

---

## 8. Printers and barcode scanners

| Device | Requirement | Notes |
|---|---|---|
| 80 mm / 58 mm thermal receipt printer (Epson TM, TVS, Rongta, Xprinter…) | Vendor Windows driver installed on the **client** PC, with paper size set in the driver | HTML bills already have thermal layouts (Bill Designer). In Electron, map "Receipt printer" to a device name for silent printing. ESC/POS raw printing is **not** needed. |
| A4/A5 laser/inkjet | Normal Windows driver | Invoices, reports, eye-test reports. |
| Label printer (TSC, Zebra, Godex, Argox) | Windows driver with a **custom label stock defined in the driver** matching the LabelTemplate size | Labels render as HTML with JsBarcode at exact mm sizes. Driver margins and DPI must be calibrated once per printer, and the onboarding checklist includes a test-label print. Raw ZPL/TSPL is out of scope for v1. |
| Barcode scanner | **USB HID keyboard-wedge** mode, suffix **Enter (CR)**, no prefix, keyboard layout matching Windows (US) | Already supported in the POS, New Sale and Purchase screens. Serial/COM-port and "USB virtual COM" modes are not supported, so scanners must be switched to HID mode. Bluetooth HID scanners work. |
| Cash drawer | Driver-kicked via the receipt printer (RJ11) | Configured in the printer driver ("open drawer before/after printing"). |
| Network printers | Shared on the LAN and added on each client | Printing is always from the client PC. The server never prints. |

---

## 9. Installer technology

| Criterion | Inno Setup 6 | WiX Toolset (v4+/MSI) |
|---|---|---|
| Custom wizard pages (mode, server, admin, shop) | Easy: Pascal Script `CreateInputQueryPage` / custom pages | Hard: custom WiX UI dialogs plus C# custom actions, and a Burn bundle for prerequisites |
| Running our init steps (initdb, services, firewall) | `[Run]` plus script, with exit-code checking | Deferred custom actions with rollback semantics (powerful but complex) |
| Upgrades | Same AppId → in-place, with full script control over what is preserved | MSI major upgrade. File-versioning rules can surprise you. |
| Enterprise deployment (GPO/Intune) | Silent switches (`/VERYSILENT /LOADINF=`), not MSI | Native MSI. Best for managed fleets. |
| Existing assets | `installer.iss` already exists, and the team knows it | None |
| Licence | Free, including commercial use | Open source. Recent major versions carry a maintenance-fee model for commercial users, so check the current terms before adopting. |
| Output | One signed `G-TRADE-Setup-x.y.z.exe` | `.msi` (+ `.exe` bundle) |

**Recommendation:** Inno Setup 6 for the product installer. Revisit WiX only if a customer requires
MSI/GPO deployment. If that happens, the same `gtrade-ctl` steps are reused, because the installer
only orchestrates and all logic lives in `gtrade-ctl`.

### 9.1 Setup wizard flow

1. **Welcome / licence agreement.**
2. **Pre-flight checks.** Windows 10 22H2 (build 19045) or later, or Windows 11. x64. ≥ 8 GB RAM for
   server/single PC (warn under 8 GB, block under 4 GB). ≥ 10 GB free on the data drive. Admin rights.
   Pending reboot. VC++ 2015–2022 x64 runtime (install if missing). Existing G-TRADE install detected,
   which switches to the **Upgrade** flow.
3. **Installation mode:** ◉ Single Computer · ○ LAN Server · ○ LAN Client.
4. **Server configuration** (Single/Server): app port (8080, probed), DB port (5544, probed), data
   folder (default `C:\ProgramData\G-TRADE`, may be a second drive), and for LAN Server the bind to all
   adapters plus a firewall rule (Private profile). Shows the server's hostname and IPs to give to clients.
   **Client:** server address field with a **Test connection** button against `/api/health/live/`.
   Client mode then skips to step 8.
5. **Database:** if no cluster exists, choose "Create new database". If one is detected, choose
   "Use existing G-TRADE data (recommended)". **There is no "overwrite" option.** Restoring from a
   backup file is offered as a separate, explicit choice.
6. **Admin account:** full name, username, password plus confirmation (validated against Django's
   validators), and an optional recovery email. This becomes the shop's Super Admin. The password is
   handed to `gtrade-ctl` through a temporary ACL-protected file or stdin, **never on a command line**.
7. **Shop configuration:** shop name, legal name, GSTIN/VAT number, phone, WhatsApp, address,
   country, then time zone, currency and date format (pre-filled from the existing localization
   country table), first branch name, and optional logo. This is written through the existing
   onboarding and Store Profile code.
8. **Ready / install.** Copy files, then (server/single) `initdb`, register and start `GTrade-DB`,
   create role and DB, `migrate --apply`, `create-shop`, `collectstatic`, register and start
   `GTrade-App` and `GTrade-Web`, set the power plan (no sleep, server only), and add the firewall rule.
9. **Health check:** `/api/health/` must report database ok, migrations ok, and the **local origin**.
   On failure the wizard shows the reason and a "Save diagnostics" button. It never leaves a
   half-configured install silently.
10. **Finish:** desktop and Start-menu shortcuts (G-TRADE ERP, plus Server Manager on server and single
    PC), a "Launch G-TRADE" checkbox, and an option to print a one-page "client connection sheet"
    (LAN server).

---

## 10. Data safety: backups, updates and rollback

### 10.1 Backup layers

| Layer | What | When | Where |
|---|---|---|---|
| L1 (existing) | ORM logical archive (`apps/security/backup`): portable, validated, restorable in-app | Schedule set in Settings (default daily 21:00 business time) | `ProgramData\G-TRADE\backups\app\` |
| L2 (new) | `pg_dump -Fc` of the `gtrade` DB, plus a zip of `media\` | Nightly, **before every update**, and on demand from the tray | `ProgramData\G-TRADE\backups\db\`, retention 14 daily, 8 weekly, 12 monthly |
| L3 (new) | Copy of the latest L1 and L2 to a **second location** (USB drive, second disk, or network share) | After each L2 | Configured in Server Manager. Shows a red warning when not configured or not reached for 3 days. |

Restore paths:
- In-app restore (L1) when the app runs.
- `gtrade-ctl restore <dump>` (L2) when it does not. This restores into a **new** database
  `gtrade_restore_<ts>`, verifies it, then swaps names, so the old DB is kept until the user confirms.

### 10.2 Update procedure (an updater run by the new installer)

1. Pre-flight: free disk space ≥ 2× DB size, services healthy, no restore running.
2. Put the app in maintenance mode (existing `RestoreMaintenanceMiddleware` pattern) and stop `GTrade-Web` and `GTrade-App`.
3. **L2 backup** (a mandatory gate: a failure aborts the update with nothing changed).
4. Install the new version into `app\<new>\` and `frontend\<new>\`. The old version is left intact.
5. `migrate --plan` with the new code. Show the list. Refuse if it contains a migration marked
   irreversible without the "data migration acknowledged" release flag.
6. `migrate --apply`. Point `current` at the new version. Start the services.
7. Health check (DB, migrations, API version matching the frontend's `REQUIRED_API_VERSION`).
8. **On failure:** stop, restore the step 3 dump into a new DB and swap, point `current` back to the
   old version, start, and report. The customer ends up exactly where they started.
9. Keep the last two versions' folders and dumps. Prune older ones.

Rules that are never broken:
- No installer, updater or uninstaller code path runs `initdb` on, deletes, or truncates an
  existing data directory or database.
- `SECRET_KEY`, DB passwords and `config\` are never regenerated on update.
- **Uninstall** removes program files and services only. `ProgramData\G-TRADE` is kept unless the
  user ticks "Also delete all shop data" **and** types the shop name. Even then, a final L2 backup
  is written to the Desktop first.
- Django migrations in future releases follow expand/contract (add nullable, then backfill, then
  enforce in a later release), so a rollback to N-1 code against an N schema stays safe where
  practical.

---

## 11. Security posture (local)

- Unique `SECRET_KEY` per install. `DEBUG=False`. `ALLOWED_HOSTS` pinned. CORS off (same origin).
- Postgres on loopback with SCRAM. The app role is not a superuser.
- One inbound firewall rule (Private profile, app port). No rule for Postgres.
- Config and secret files ACL'd to Administrators + SYSTEM + the service accounts.
- Existing lockout, throttles, 2FA, sid-bound sessions and audit logging carry over unchanged.
- Code signing of the installer and all shipped binaries (needed for SmartScreen and Smart App Control).
- Licence enforcement: **not designed yet** (`config/license.json` is an unused demo). This is a decision for the roadmap.
