# G-TRADE ERP — Windows Local Edition: Implementation Roadmap

**Date:** 2026-11-10 · **Status:** Phase 1 (audit) complete. **Phase 2 starts only after approval.**
References: `LOCAL_INSTALLATION_AUDIT.md` (findings B1–B6, risks R1–R17),
`LOCAL_DEPLOYMENT_ARCHITECTURE.md`, `WINDOWS_COMPATIBILITY_REPORT.md`.

**Guiding rule for every phase:** the cloud deployment (Vercel + Render + Neon) must behave exactly as
today. Every source change is **additive** and switched on only by `GTRADE_EDITION=local` (backend)
or a local build flag (frontend). The existing test suites must pass unchanged at the end of every phase.

---

## Decisions needed before Phase 2

| # | Decision | Recommendation |
|---|---|---|
| D1 | Shop identity in the local DB: the shop **is tenant #1** (platform console hidden), or a hidden platform tenant #1 with the shop as tenant #2? | **Shop = tenant #1.** This keeps server-wide backup and restore enabled and avoids a dormant super-admin. |
| D2 | Client UI: Electron thin client (silent printing) vs Edge app-mode shortcut only | **Electron thin client**, with Edge as a documented fallback |
| D3 | Licensing / activation for local installs (none, offline key, online activation, module packages) | Decide the business model. Technically the modules already map to `Tenant` packages (`module_access.py`). |
| D4 | Code-signing certificate (OV/EV, or a cloud signing service) | Procure now, because issuance and identity validation take time |
| D5 | Product name and publisher for the installer ("G-TRADE ERP" vs the current "Optical ERP" / "GreenSol Optical ERP" strings) | One name everywhere |
| D6 | Default ports (app 8080, DB 5544) and data root (`C:\ProgramData\G-TRADE`) | Accept the defaults. All are changeable in the wizard. |
| D7 | Windows 10 policy: supported best-effort (recommended) vs block for the LAN-server role | Supported with a warning |
| D8 | Updates: manual installer download vs in-app "update available" check | Manual for v1. Auto-check later. |

---

## Phase 2: Local-edition configuration layer (source changes, additive only)

**Goal:** the existing app runs correctly from a local Postgres on Windows, same-origin, offline,
with no change to cloud behaviour.

| Task | Fixes | Notes |
|---|---|---|
| 2.1 New `backend/config/settings_local.py` overlay: required `SECRET_KEY`, `DEBUG=False`, DB from env with the Postgres tuning, `MEDIA_ROOT`/`STATIC_ROOT`/`LOGS_DIR`/`BACKUP_DIR` from env, pinned `ALLOWED_HOSTS`, CORS off, `AUTO_MIGRATE=False`, refuse SQLite | B3, B4, B5, R2, R15 | New file. `config/settings.py` is untouched. |
| 2.2 New local server entry point (Waitress, explicit bind/port/threads, wait-for-DB, **no migrate**, refuse to serve if the schema is behind) | B5, B6 | Replaces `launcher.py` for the local edition. `launcher.py` itself is left alone. |
| 2.3 Guard destructive commands (`wipe_database`, `clear_all_database.py`) under the local edition, and exclude them from the build | R13 | |
| 2.4 Management commands for the wizard: `local_create_shop` (wraps `onboard_tenant` + Store Profile, reads secrets from stdin or a file and never from argv), `local_health` (JSON), `local_migrate --plan/--apply` | — | Reuses `tenant_onboarding.py`. |
| 2.5 Frontend local build flag (for example `VITE_EDITION=local`): `resolveApiBaseUrl()` returns `''` for any host, and keep-awake, onrender preconnect and Render 429 handling are disabled | **B1**, R1 | Cloud build output must be byte-identical when the flag is off. |
| 2.6 Bundle `xlsx` as an npm dependency (lazy-imported chunk) instead of loading it from jsDelivr. Self-host the Outfit and Plus Jakarta Sans fonts. | **B2**, R11 | Benefits the cloud too, but gate it if a byte-identical cloud build is required. |
| 2.7 Health endpoint: add `edition`, `origin` and clock-skew fields (additive keys) | R1, R12 | |
| 2.8 Tests: settings-overlay tests, a frontend resolver test for the local flag, and a full backend suite run against **Postgres 17 on Windows** | — | |

**Exit criteria:** on a dev PC, a local Postgres 17 + Waitress + nginx started by hand serves the
app at `http://<lan-ip>:8080`. A second PC can log in, sell, print and scan. Excel import works with
the network cable unplugged. All existing tests pass. The cloud build is unchanged.

## Phase 3: Runtime packaging and service control

| Task | Notes |
|---|---|
| 3.1 Reproducible build script: Vite build (local flag), embedded CPython 3.12 + `pip install --target` of locked wheels (`requirements.txt` + waitress + tzdata), `compileall`, `collectstatic`, PostgreSQL 17 ZIP binaries, nginx, WinSW. Output is a versioned staging folder with SHA-256 manifest. | Replaces `build_all.py` / `backend.spec` for this edition. The old files are left in place until retired. |
| 3.2 `gtrade-ctl` (Python, run by the embedded runtime, with a signed launcher exe): `init-db`, `create-shop`, `migrate`, `backup`, `restore`, `health`, `set-port`, `firewall`, `diagnostics` | All installer and updater logic lives here, so it is testable without the installer. |
| 3.3 WinSW service definitions: `GTrade-DB` (pg_ctl), `GTrade-App` (depends on DB), `GTrade-Web` (depends on App). Restart policies and log rotation. | |
| 3.4 nginx config generator (single vs LAN bind) | Template in the architecture doc §6 |
| 3.5 Postgres init: safe `initdb` guarded by a `PG_VERSION` check, role and DB creation, tuned `postgresql.conf`, loopback-only `pg_hba.conf`, ACLs | R4, R6 |

**Exit criteria:** on a clean Windows 11 VM, running the staging folder's `gtrade-ctl` (by hand, as
admin) brings up all three services. They survive a reboot with no user logged on. Running
`init-db` against an existing cluster refuses.

## Phase 4: Inno Setup installer and wizard

| Task | Notes |
|---|---|
| 4.1 New `.iss`: pre-flight checks, mode page, server/client config, database page (new vs existing, with no overwrite option), admin page, shop page, progress, health check, finish | Wizard spec in the architecture doc §9.1 |
| 4.2 Firewall rule (Private profile), power plan (server role), Active Hours, shortcuts (G-TRADE ERP, Server Manager) | R9, R10 |
| 4.3 Upgrade detection (same AppId), which routes to the Phase 6 updater flow | |
| 4.4 Uninstaller: remove services and binaries, **keep ProgramData** by default, and delete data only after a typed confirmation and a final backup | R5 |
| 4.5 Silent install support (`/VERYSILENT /LOADINF=`) for technicians installing many clients | |

**Exit criteria:** one `G-TRADE-Setup-x.y.z.exe` installs every mode on Win11 and Win10 22H2 VMs with
no terminal shown, and the uninstall/reinstall round trip keeps all data.

## Phase 5: Desktop client and Server Manager

| Task | Notes |
|---|---|
| 5.1 Re-purpose `public/electron.js` as a thin client: load `http://<server>:<port>/`, connect/retry screen, no backend spawning, on a current Electron major, `contextIsolation` on everywhere | B6, D2 |
| 5.2 Silent printing: per-PC printer mapping (receipt, A4, label) through the existing `electronAPI.printInvoice` bridge. A new frontend hook uses it when present and falls back to the browser dialog. | Architecture doc §8 |
| 5.3 Server Manager tray app: service status, start/stop, backup now, backup-destination setup and warning, logs, restore, client connection sheet | "No terminals" |
| 5.4 Edge app-mode shortcut option in the client installer | Fallback |

## Phase 6: Backup, update and rollback

| Task | Notes |
|---|---|
| 6.1 L2 nightly `pg_dump -Fc` + media zip, with retention | Alongside the existing L1 ORM backups |
| 6.2 L3 off-machine copy (USB, second disk or share), with a "not protected" warning | R17 |
| 6.3 Updater: maintenance mode → stop → **mandatory pre-update dump** → side-by-side install → `migrate --plan` gate → apply → health check → **automatic rollback** on any failure | R3 |
| 6.4 `gtrade-ctl restore` into a new DB, verify, then swap (the old DB is kept until confirmed). Works when the app cannot start. | |
| 6.5 Release policy: expand/contract migrations, an irreversible-migration flag, and API version bump rules | |

**Exit criteria:** tests 4–7 in the compatibility report §5 pass. A deliberately broken release rolls
itself back with no data loss.

## Phase 7: Hardening, signing and pilot

| Task | Notes |
|---|---|
| 7.1 Authenticode-sign the installer and all shipped binaries. Test with Smart App Control On. | R7, R8, D4 |
| 7.2 Run the full compatibility test matrix (Win11/Win10 × Home/Pro × Single/Server/Client) plus the printer and scanner checks | Compatibility report §5 |
| 7.3 Performance check: 10–25 simulated clients against a desktop-class server | |
| 7.4 Documentation: installation guide, technician LAN checklist, backup/restore runbook, troubleshooting (with a diagnostics zip) | |
| 7.5 Pilot at 1–2 real shops (one Single PC, one LAN) for 2–4 weeks before general release | |

---

## What will not be touched

- The production database (Neon), the Render service, the Vercel project and the GitHub workflow.
- `config/settings.py` behaviour for cloud runs, `render.yaml`, `vercel.json` and `DEPLOYMENT.md`.
- No commits or pushes without explicit instruction.

## Estimated effort (one developer, indicative)

| Phase | Effort |
|---|---|
| 2: Config layer | 1–1.5 weeks |
| 3: Runtime and services | 1.5–2 weeks |
| 4: Installer and wizard | 1.5 weeks |
| 5: Desktop client and tray | 1.5 weeks |
| 6: Backup, update and rollback | 1.5 weeks |
| 7: Hardening and pilot | 2 weeks plus pilot time |
| **Total** | **~9–10 weeks plus pilot** |

**Awaiting approval of this roadmap and decisions D1–D8 before starting Phase 2.**
