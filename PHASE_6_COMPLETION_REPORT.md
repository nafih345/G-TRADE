# Phase 6: Universal Windows EXE Installer (Completion Report)

**Date:** 2026-11-12 · **Status:**
- The installer is **built** (`windows/out/installer/G-TRADE-Setup-1.0.0.exe`, 206 MB, **unsigned**).
- The installation engine (`gtrade-ctl install` / `pair` / `repair` / `uninstall`) is **verified on Windows 11** for every step that does not need Administrator rights.
- An elevated end-to-end run of the `.exe` (services, firewall, Program Files) has **not** been done in this session: the session is not elevated and a UAC prompt cannot be answered unattended. The exact script for it is ready (§6).

## 1. Build

| Item | Value |
|---|---|
| Tooling | electron-builder 26.18.0 (NSIS 3.0.4.1 downloaded by electron-builder), Electron 44.9.3 |
| Config | `windows/desktop/package.json` → `build`. appId `com.gtrade.erp` (D8), `perMachine`, assisted wizard (`oneClick: false`), change-directory page, EULA page (draft placeholder text), `include: windows/installer/installer.nsh`, fixed NSIS GUID (stable identity for upgrades) |
| Payload | `extraResources` → `resources\server` = the staged runtime (embedded Python 3.12.10 + hash-locked packages, PostgreSQL 17.10, nginx 1.30.6, WinSW 2.12.0) plus `app\1.0.0` (backend, gtrade_ctl, gtrade_server, local SPA) |
| Output | `G-TRADE-Setup-1.0.0.exe` (206,149,199 bytes) + `.blockmap`; unpacked tree 671 MB, of which the server runtime is 351 MB |
| Signing | Skipped: no certificate (D6). electron-builder signs every exe/dll automatically once `win.signtoolOptions` / `azureSignOptions` are set. |
| Commands | `python windows/tooling/build_frontend.py` → `python windows/tooling/build_runtime.py --version 1.0.0` → `cd windows/desktop && npx electron-builder --win nsis` (with `ELECTRON_RUN_AS_NODE` unset) |

## 2. Wizard (installer.nsh)

The NSIS script only collects answers and calls `gtrade-ctl`.

| Page | Modes | Content |
|---|---|---|
| Welcome, EULA, install folder | all | Standard electron-builder assisted pages |
| **Installation mode** | new installs | Standalone, LAN Server or LAN Workstation. **Locked on upgrade or repair**: read from `ProgramData\G-TRADE\config\install.mode`, and a `/MODE` that differs is refused. |
| Server settings | Standalone, Server (new) | Data folder (default `C:\ProgramData\G-TRADE`; the engine refuses folders inside Program Files) and HTTPS port. Server mode explains the firewall rule. |
| Connect to server | Workstation | Server address + pairing code |
| Company + administrator | Standalone, Server (new) | Company, first branch, admin name, e-mail, user name, password ×2 (≥10 characters, must match). Django's validators run again during install. |
| Progress | all | `nsExec::ExecToLog` output of `gtrade-ctl install` |
| Finish | Server | Opens the **workstation connection sheet** (addresses, pairing code, CA fingerprint) |

- **Secrets:** the admin password is written to `$PLUGINSDIR\answers.ini` (the elevated user's temp folder). gtrade-ctl reads it once, **overwrites and deletes** it, and passes the password to Django on stdin. It never appears on a command line or in a log (tested: the answers file is gone and no password appears in the install logs).
- **Silent and technician installs:**
  - `G-TRADE-Setup-1.0.0.exe /S /MODE=standalone|server|workstation [/DATA=…] [/PORT=…] [/ANSWERS=answers.ini] [/SERVER=host:port /PAIRCODE=XXXX-XXXX]`
  - Exit codes are documented in `cli.py`: 10 preflight, 20 DB, 30 licence, 40 services, 50 health, 60 backup, 70 update.

## 3. Installation modes (gtrade-ctl install)

| Mode | Steps |
|---|---|
| **Standalone** | preflight (Win10 22H2+/11, x64, admin, RAM, disk, ports) → configure (install id, ports, host names) → data folders + ACL → DPAPI secrets → PostgreSQL init + least-privilege role/DB → migrate (verified backup first if a cluster already existed) → collectstatic → create company + admin → TLS CA + certificate → nginx.conf → licence (evaluation / key / file) → services (GTrade-DB, GTrade-App, GTrade-Web) → client config → HTTPS health gate → connection info |
| **LAN Server** | Same as Standalone, plus nginx binds all interfaces, a firewall rule (TCP port, **Private** profile, **LocalSubnet** only), and the connection sheet |
| **LAN Workstation** | `pair`: fetch the CA the server publishes, check the server's TLS leaf was issued by it, compare the **pairing code**, pinned health check, write `ProgramData\G-TRADE\client\client.json` for all users. **No PostgreSQL, no database, no services, no secrets.** The installer deletes the unused server runtime folders (pgsql, nginx, winsw). |

- **Per-customer uniqueness:** the master installer carries no customer data. These are all generated during each installation: install id, `SECRET_KEY`, DB passwords, licence store key, CA and certificate, company and admin, licence binding.
- **Repair:** `gtrade-ctl repair` re-runs every idempotent step for the recorded mode and version. It never initialises an existing cluster, never regenerates secrets, never changes data, and refuses to run when migrations are pending (an interrupted update).
- **Upgrade:**
  - NSIS `customInit` keeps a copy of the running version's code (`ProgramData\G-TRADE\rollback\app-<old>`) before electron-builder removes the old program files.
  - `customInstall` then runs `gtrade-ctl update apply --version X --previous-app-dir …` (Phase 8): a verified backup first, then migrate, health check, and automatic rollback on failure.
  - The old uninstaller runs with `--updated` and is told never to touch services or data.
- **Uninstall:**
  - The options page **keeps data by default**.
  - Deleting needs the box ticked **and** the exact company name typed. A **verified final backup** is then written to the Desktop before anything is deleted, and keys and secrets are overwritten before deletion.
  - A silent uninstall always keeps data.

## 4. Tests run on this Windows 11 PC (non-elevated)

| Test | Result |
|---|---|
| NSIS script compiled by electron-builder; installer built | **OK**, no warnings |
| `test_desktop_install_e2e` (4 tests; evidence `windows/out/evidence/desktop_install_e2e.json`) | **4/4** |
| What the e2e run covered | **Standalone** `install --no-services`: all 14 steps in 124 s (company + admin created, answers file deleted, no password in logs, health OK). **Workstation** pairing: wrong code refused, right code paired, no `pgsql` / `secrets.dpapi` / `gtrade.env` created. **Electron** loaded the result and logged in. |
| `test_backup_update_e2e.test_99`: uninstall keeps data; wrong confirmation refused; correct confirmation → verified final backup, then data removed | **OK** |
| Preflight blocks a busy port (seen in practice: a leftover test cluster held 15564) | **OK** |
| Upgrade mode lock (`configure` refuses a mode change; install id kept) | **OK** (`test_postgres.ModeAndUpgradeGuards`) |

## 5. Bugs found and fixed in this phase

- The install engine assumed `app\current.json` existed (true only in the staged payload). It now writes it, and update and rollback maintain it.
- Python 3.12 has no `SSLSocket.get_unverified_chain()`. Pairing now fetches `/gtrade-ca.crt` from nginx and verifies the leaf against it with `cryptography`.

## 6. Not verified here: exact remaining actions

| # | Action | Who |
|---|---|---|
| 1 | Run `windows/tests/elevated_smoke.ps1 -Installer G-TRADE-Setup-1.0.0.exe -Mode standalone` and `-Mode server` **in an elevated PowerShell on clean Windows 10 22H2 and Windows 11 VMs**. It checks: services Automatic and running; HTTPS health; restart and crash recovery by WinSW; firewall rule scope; ACLs; silent uninstall keeps data; reinstall reuses data. | Owner / QA (needs admin + VMs) |
| 2 | Interactive wizard walk-through (pages, validation messages, progress, finish page, uninstall options page) on the same VMs | Owner / QA |
| 3 | LAN test with two machines: server + workstation pairing over a real network, firewall Private vs Public profile | Owner / QA |
| 4 | Code-signing certificate (D6), then rebuild (signs the installer, uninstaller, `G-TRADE.exe` and the WinSW/nginx copies) and a SmartScreen / Smart App Control check | Owner |
| 5 | Replace the EULA placeholder with legal text; set the publisher name (D8) and icon | Owner |
