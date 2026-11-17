# G-TRADE ERP — Universal Windows Installer Implementation Plan

**Date:** 2026-11-11 · **Status:** Plan for review. Nothing implemented.
**Deliverable:** one signed `G-TRADE-Setup-<version>.exe` built with **Electron Builder (NSIS target)**
that installs **Standalone**, **LAN Server** or **LAN Workstation**.
Parent document: `COMMERCIAL_WINDOWS_ARCHITECTURE.md`. Runtime details (ports, PG tuning, nginx) are in
`LOCAL_DEPLOYMENT_ARCHITECTURE.md` §4–8. This plan replaces that document's Inno Setup §9.

---

## 1. Current state

| Item | State | Verdict |
|---|---|---|
| `package.json` `build` | `appId com.opticalerp.app`, `productName "Optical ERP"`, `win.target: "dir"` (no installer), ships the whole `config/` folder (shared secret, demo licence) | Rewrite: `com.gtrade.erp`, `nsis` target, no `config/` |
| Electron | `^33.2.0` (out of support) | Upgrade to a current supported major at implementation time |
| `public/electron.js` | Spawns `backend.exe`, trusts anything on :8000, loads `file://` | Rewrite as thin client (§6) |
| `public/preload.js` | Print bridge | Keep and extend (narrow API surface) |
| `installer.iss`, `build_all.py`, `backend/backend.spec`, `backend/launcher.py` | Stale Inno/PyInstaller pipeline | Retire after the new pipeline is proven; leave untouched until then |
| Signing, auto-update, logging, silent install | None | New |

## 2. Why Electron Builder + NSIS, and its limits

| Need | electron-builder NSIS support | Approach |
|---|---|---|
| Assisted installer with directory choice | `oneClick: false`, `allowToChangeInstallationDirectory` | ✅ |
| Per-machine install, elevation | `perMachine: true` | ✅ Required (services, firewall, ProgramData) |
| Custom wizard pages (mode, server address, admin, company) | `nsis.include` → `installer.nsh` macros `customPageAfterChangeDir`, `customInit`, `customInstall`, `customUnInstall`, `customUnWelcomePage` + **nsDialogs** | ✅ Wizard pages written in NSIS script |
| Running setup logic | `ExecWait` / `nsExec::ExecToLog` calling `gtrade-ctl.exe` | ✅ All real logic lives in `gtrade-ctl` (testable without the installer) |
| Large server payload only in server modes | All `extraResources` go into the main app archive, which is always extracted | Ship the server runtime as a **separate LZMA 7z inside the installer** (`File` in `customInstall`, extracted with `Nsis7z` only for Standalone/Server) |
| Auto-update | `electron-updater` supports NSIS targets | ✅ (`BACKUP_UPDATE_RECOVERY_PLAN.md`) |
| Code signing | `win.signtoolOptions` / `azureSignOptions`, signs installer, uninstaller and app exe | ✅ Also sign our own extra exes in a `sign` hook |
| MSI for enterprise GPO | `msi` target exists but has no custom pages | Out of scope for v1 |

Rule: **NSIS script only collects choices and calls `gtrade-ctl`.** No business logic, SQL or
service XML is generated inside NSIS.

## 3. Package layout (build output)

```
G-TRADE-Setup-1.0.0.exe   (signed)
 ├─ app-64.7z                         Electron client + preload + icons      (all modes)
 ├─ server-runtime-1.0.0.7z           (custom File; extracted only for Standalone / Server)
 │    runtime\python\                 embedded CPython 3.12 x64 + site-packages (.pyc)
 │    runtime\pgsql\                  PostgreSQL 17.x binaries (no pgAdmin, docs, StackBuilder)
 │    runtime\nginx\  runtime\winsw\  vc_redist.x64.exe
 │    server\1.0.0\backend\           Django app (.pyc), gtrade_server, gtrade_ctl, gtrade_agent
 │    server\1.0.0\frontend\dist\     SPA built with VITE_EDITION=local
 │    manifest.json + manifest.sig    SHA-256 of every file, Ed25519 signature
 └─ uninstaller (signed)
```

Size targets: Workstation ≈ 110–130 MB installed; Server ≈ 450–550 MB installed; installer ≈ 250–300 MB.

## 4. Wizard flow

| # | Page | Modes | Content | Validation |
|---|---|---|---|---|
| 1 | Welcome + EULA | all | Version, publisher | — |
| 2 | Pre-flight (custom) | all | Windows 10 22H2 (19045)+ / 11, x64, admin, RAM (server: warn < 8 GB, block < 4 GB), disk (server ≥ 10 GB free on the data drive), pending reboot, existing install detection, VC++ runtime | Blocking failures shown with reasons |
| 3 | **Installation mode** (custom) | — | ◉ Standalone · ○ LAN Server · ○ LAN Workstation. Pre-selected from `install.json` on upgrade (the mode **cannot be changed by an upgrade**; use "Change mode" in Server Manager) | — |
| 4 | Install folder | all | `C:\Program Files\G-TRADE` | — |
| 5a | Server settings | Standalone/Server | HTTPS port (8443, probed), DB port (5544, probed), data folder (`C:\ProgramData\G-TRADE` or a second drive). Server: hostname + IPs shown, "Add firewall rule (Private networks)" ☑ | Ports free; folder writable; folder not inside Program Files |
| 5b | Connect to server | Workstation | Server address + **pairing code** (6–8 characters shown in Server Manager) → `gtrade-ctl pair` fetches the CA and verifies the fingerprint (security checklist §4) | Health `/api/health/live/` over pinned TLS; version compatibility |
| 6 | Database | Standalone/Server | No cluster: "Create new". Existing G-TRADE cluster: "Use existing data (recommended)". Optional: "Restore from backup file…". **No overwrite option exists.** | `PG_VERSION` detection |
| 7 | Licence | Standalone/Server | Online activation (licence key + email) **or** offline (export request file / import `.lic`) **or** 30-day trial | Signature, machine binding (licence design) |
| 8 | Organization admin | Standalone/Server, new DB only | Full name, username, password ×2, recovery email | Django password validators via `gtrade-ctl validate-password` |
| 9 | First company + branch | Standalone/Server, new DB only | Company name, legal name, tax reg no, country (fills currency/time zone/date format), address, first branch name, optional logo | Licence limits |
| 10 | Progress | all | Steps below, each logged | Abort shows the reason and "Save diagnostics" |
| 11 | Finish | all | Shortcuts; Server: "Print client connection sheet" (address, CA fingerprint, pairing code); "Launch G-TRADE" | — |

Secrets typed in pages 7–8 are passed to `gtrade-ctl` through a **temporary file in a folder ACL'd to
SYSTEM/Administrators, deleted immediately after**. They are never passed on a command line (visible in process lists and logs).

## 5. Install steps per mode (all via `gtrade-ctl`)

### Standalone and LAN Server
1. Extract `server-runtime` → `resources\server\<ver>`, `resources\runtime`; verify `manifest.sig`.
2. Install the VC++ runtime if missing (`/install /quiet /norestart`).
3. `gtrade-ctl prepare-data --root <data>`: create the folder tree, set ACLs.
4. `gtrade-ctl init-db` **only when no cluster exists**: `initdb` (scram, UTF8), tuned `postgresql.conf`,
   loopback `pg_hba.conf`, `pg_ctl register -N GTrade-DB -S auto` (NetworkService), start, create the `gtrade` role and DB.
   An existing cluster → `gtrade-ctl verify-db` (version, owner, connectivity) instead.
5. `gtrade-ctl secrets init` (first install only): `SECRET_KEY`, DB passwords, licence store key, DPAPI-protected (machine scope).
6. `gtrade-ctl migrate --apply` (fresh) or the **update path** (backup/update plan §4) for an existing DB.
7. `gtrade-ctl create-org` (new DB): Organization + first company (via `onboard_tenant`) + admin user.
8. `gtrade-ctl license activate|import|trial`.
9. `gtrade-ctl cert init --hosts <hostname,FQDN,IPs,localhost>`: local CA (10 y) + server cert (≤ 397 d), private keys ACL'd.
10. `gtrade-ctl collectstatic`; generate `nginx.conf` (TLS, bind 127.0.0.1 for Standalone / 0.0.0.0 for Server).
11. Register WinSW services `GTrade-App` (depends DB), `GTrade-Web` (depends App), `GTrade-Agent`; set recovery actions; start.
12. Server only: `gtrade-ctl firewall add` (TCP 8443 inbound, Private profile, remote LocalSubnet); power plan "never sleep" on AC; warn if the active network profile is Public.
13. `gtrade-ctl health --expect-local --tls`: DB ok, migrations ok, edition = local, origin = this host, licence valid.
14. Write `install.json` (mode, version, ports, data root, install id, timestamps).
15. Electron client: write the per-machine default server = `https://127.0.0.1:8443` and the CA fingerprint.

### LAN Workstation
1. Install the Electron client only.
2. `gtrade-ctl pair` (a small bundled helper, or Electron itself on first run): store server URL + pinned CA fingerprint in
   `%ProgramData%\G-TRADE\client.json` (machine default) and allow a per-user override.
3. No services, no firewall rule, no database, no licence.

## 6. Electron thin client (main process rewrite)

- Single-instance lock, window state, splash (with `contextIsolation`).
- Loads `https://<server>:<port>/` with **certificate pinning**: `session.setCertificateVerifyProc` accepts only
  certificates chaining to the pinned CA fingerprint; every other host uses normal verification. Navigation is restricted
  to the server origin (`will-navigate`, `setWindowOpenHandler`).
- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, strict CSP from nginx.
- Preload exposes only: `print({html|url, printerRole, copies})`, `listPrinters()`, `getAppInfo()`,
  `checkForUpdates()`, `openServerManager()` (server/standalone).
- Silent printing per role (receipt / A4 / label) mapped per PC in `%LOCALAPPDATA%\G-TRADE\printers.json`.
- Version handshake on startup: `/api/health/` → `api_version`, `min_client_version`. Too old → update from the server mirror before login.
- Server Manager as a second window (`--server-manager`), present only when `install.json.mode != workstation`.

## 7. Upgrade, repair and change-mode

| Scenario | Behaviour |
|---|---|
| Same AppId, newer version | `customInit` reads `install.json`, forces the same mode, skips pages 5–9, runs the **update path** (backup → side-by-side install → migrate gate → health → rollback on failure) |
| Same version again | "Repair": re-verifies files and services and re-registers missing services. Never touches data. |
| Older version over newer | Refused (downgrade only through Server Manager → Roll back, which also restores the DB) |
| Change Workstation → Server | Not through the installer; Server Manager "Convert to server" (rare, technician-led) |
| Moving the server to new hardware | Backup → install Server on the new PC with "Restore from backup file" → licence transfer (licence design §7) → re-pair workstations (same CA is restored, so pins stay valid) |

## 8. Uninstall (secure)

1. Confirmation page: what will be removed and what will be **kept**.
2. Stop and delete services `GTrade-Web`, `GTrade-App`, `GTrade-Agent`, `GTrade-DB` (`pg_ctl unregister`).
3. Remove the firewall rule, shortcuts, program files, scheduled tasks.
4. **Data is kept by default** (`C:\ProgramData\G-TRADE`). To delete it, the user ticks "Delete all business data" **and**
   types the organization name. A final backup (`pg_dump` + media) is then written to `Desktop\G-TRADE-final-backup-<ts>`
   before deletion. Secrets and private keys are overwritten before deletion.
5. Licence: an online deactivation attempt (frees the activation slot), or an offline deactivation receipt is generated.
6. Workstation uninstall removes only the client and its pairing.
7. Uninstall logs to `%TEMP%\G-TRADE-uninstall-<ts>.log` (the logs folder may be deleted).

## 9. Installation logging

- NSIS: `LogSet on` is unavailable in standard builds, so each step writes through `gtrade-ctl log` to
  `C:\ProgramData\G-TRADE\logs\install\install-<ts>.log` (and `%TEMP%` until the data root exists).
- Each `gtrade-ctl` step logs: step id, start/end, exit code, **redacted** arguments (secret patterns masked), stderr tail.
- On failure: a "Save diagnostics" button → `gtrade-ctl diagnostics` zip (logs, `install.json`, service states, port probes,
  `pg_controldata` summary, Windows version). **No secrets, no business data.**
- Windows Event Log source `G-TRADE` registered for service start/stop/failure events.

## 10. Silent / technician install

```
G-TRADE-Setup-1.0.0.exe /S /MODE=workstation /SERVER=https://GTRADE-SRV:8443 /PAIRCODE=7Q4K-29
G-TRADE-Setup-1.0.0.exe /S /MODE=server /ANSWERS=C:\setup\answers.json   (secrets file deleted after read)
```

Exit codes are documented (0 ok, 10 pre-flight failed, 20 DB, 30 licence, 40 services, 50 health).

## 11. Build pipeline (CI, reproducible)

1. Lock dependencies: `requirements.lock` (hashes), `package-lock.json`.
2. Build the SPA with `VITE_EDITION=local`; run frontend tests.
3. Assemble embedded Python: official embeddable zip + `pip install --target --require-hashes`; `compileall -b`; strip tests and `.py` from our packages.
4. Fetch pinned PG 17.x / nginx / WinSW binaries; verify upstream checksums.
5. Run backend tests against **PostgreSQL 17 on Windows** using the embedded runtime.
6. Build `server-runtime.7z`, `manifest.json`, sign the manifest (Ed25519, key in KMS).
7. electron-builder `--win nsis` with the signing configuration (Authenticode, SHA-256, RFC 3161 timestamp).
8. Sign every exe/dll we produce (`gtrade-ctl.exe` launcher, WinSW renamed exes). Third-party binaries keep their vendor signatures.
9. Publish `latest.yml` + blockmap + installer to the update channel (backup/update plan §3).
10. Smoke test in CI on Windows VMs: silent Standalone install → health → uninstall (keep data) → reinstall → data present.

## 12. Test matrix (gate for release)

| | Win11 Pro | Win11 Home | Win10 22H2 Pro | Win Server 2022 (optional) |
|---|---|---|---|---|
| Standalone fresh / upgrade / uninstall-keep / uninstall-delete | ✓ | ✓ | ✓ | — |
| LAN Server fresh / upgrade | ✓ | ✓ | ✓ | ✓ |
| Workstation pair / update from mirror | ✓ | ✓ | ✓ | — |
| Smart App Control ON, Defender default | ✓ | ✓ | — | — |
| Existing PostgreSQL on 5432 present | ✓ | — | ✓ | — |
| Non-ASCII Windows username / data path on D: | ✓ | — | ✓ | — |

## 13. Implementation steps

| # | Step | Depends on |
|---|---|---|
| 1 | `gtrade-ctl` commands: prepare-data, init-db, verify-db, secrets, migrate, create-org, cert, firewall, health, diagnostics, log | P3/P4 config layer |
| 2 | WinSW XML templates + service registration and recovery | 1 |
| 3 | Embedded runtime build script + manifest signing | — |
| 4 | Electron main-process rewrite (thin client, pinning, print, handshake) | — |
| 5 | electron-builder config (nsis, perMachine, include `installer.nsh`, signing) | 4 |
| 6 | `installer.nsh` pages (pre-flight, mode, server, connect/pair, DB, licence, admin, company) | 1, 5 |
| 7 | Upgrade/repair/uninstall macros | 6, update path |
| 8 | Silent install answers + exit codes | 6 |
| 9 | CI pipeline + VM smoke tests | all |
