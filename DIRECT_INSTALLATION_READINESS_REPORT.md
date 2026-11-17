# G-TRADE ERP 1.0.0: Direct Windows Installation Readiness Report

**Date:** 2026-11-12
**Target PC:** LAPTOP-M79GGMU7 (the development PC), Windows 11 Home 10.0.26200, x64
**Installer:** `windows\out\installer\G-TRADE-Setup-1.0.0.exe`
**Scope:** read-only inspection. Nothing was installed. No database, project file, environment variable, service or firewall rule was changed. No connection was made to Neon, Render or Vercel.

> **Superseded 2026-11-12 22:15.** Use `DIRECT_INSTALLATION_FINAL_READINESS_REPORT.md`. The current installer is SHA-256 `A92A8EBCAE1F07B02631480BFAA452B9C5C8B9B72D035A17B15E39DB91F2F9AE`. The `92B5EE8F…` build below was replaced (example.com smoke-test fix + install-resume fix).
>
> **Update 2026-11-12 21:10: B1 resolved, installer rebuilt.**
> - **New installer:** 205,917,942 bytes, SHA-256 **`92B5EE8F5FD4C2BB6FE1B09A0B39C88AD453573ABD8EFCF66A74B4E478B1E9A8`**. The `E0B3CB64…` build below is withdrawn.
> - **Secret scan:** `payload_guard` is OK on the stage, on `win-unpacked` and on the contents extracted from the `.exe`. There is no `.env`, no key file and none of the developer secret values. Details are in `PHASE_9_FINAL_RELEASE_REPORT.md` §1a.
> - **Tests:** 64 Windows engine and e2e tests passed against the rebuilt payload.
> - **Pre-install re-check at 21:10, unchanged from §4–§5:**
>   - PostgreSQL 17 (:5432), PostgreSQL 18 (:9961), pgAgent and MySQL are running and untouched.
>   - Ports 5544, 8001 and 8443 are free.
>   - `C:\Program Files\G-TRADE ERP`, `C:\ProgramData\G-TRADE` and `%APPDATA%\G-TRADE ERP` do not exist.
>   - There is no G-TRADE firewall rule, service or root certificate.
>   - The network is still Public.
>   - RAM is 7.2 GB with 0.7 GB free. C: has 58.6 GB free.
> - **Launch** from the Start menu entry named exactly **G-TRADE ERP**, not GreenSol's "G-TRADE".

---

## 1. Verdict

| Question | Answer |
|---|---|
| Is the installer the expected file? | **Yes.** The SHA-256 matches exactly (see §2). |
| Safest mode for this PC | **Standalone.** |
| Can it coexist with PostgreSQL 17/18, MySQL and the dev environment? | **Yes.** It uses its own binaries, data folder, ports and service names, so none of them overlap (§4, §5). |
| Will a separate Windows user help? | **No.** It is a per-machine install. Services, `C:\Program Files` and `C:\ProgramData` are shared by every account, so a second user isolates nothing. |
| Is direct installation safe? | **Yes, in Standalone mode, with conditions.** Fix blocker **B1** first (strongly recommended), close heavy apps because RAM is tight (**R1**), and follow the run-book in §8. |
| Is another test PC required? | Not for a Standalone functional test. It **is** still required for LAN Server/Workstation tests and for the release gates (clean Windows 10/11 VMs). |

### Blocker found during inspection (RESOLVED 2026-11-12 21:02, see the update at the top)

**B1. The installer contains the developer `backend\.env`, which includes the Neon production owner password.**

- `win-unpacked\resources\server\app\1.0.0\backend\.env` is byte-identical to `backend\.env` (same SHA-256). Its keys are `DB_NAME DB_USER DB_PASSWORD DB_HOST DB_PORT DATABASE_URL`, and `DATABASE_URL` points to `ep-purple-unit-…us-east-2.aws.neon.tech/neondb` as `neondb_owner`.
- **Runtime risk on this PC: none found.** The backend has no dotenv loader. `settings_local.py` refuses to start if `DATABASE_URL` is set and forces the database onto loopback. The installed app will not connect to Neon.
- **Exposure risk: real.** Installing copies the file into `C:\Program Files\G-TRADE ERP\…`, where every local user can read it. Anyone who receives this `.exe` also receives the production database password.
- **Cause:** `windows\tooling\build_runtime.py` excludes `db.sqlite3*`, `*.bak*`, `database.json`, `settings.json` and similar files, but not `.env` / `.env.*`.
- **Recommended fix (needs your approval, not done):**
  1. Add `.env` and `.env.*`, keeping `.env.example`, to `BACKEND_EXCLUDE_FILES`.
  2. Add a build-time assertion that no `.env` exists in the staged app.
  3. Restage, rebuild and record the new SHA-256.
  4. **Rotate the Neon `neondb_owner` password** if this `.exe` or the `windows\out` folder has ever left this PC.
- If you choose to test the current `.exe` anyway, the runtime is still safe. Delete the copied `.env` from Program Files after the test, and never distribute this build.

---

## 2. Installer inspection

| Check | Result |
|---|---|
| SHA-256 (current) | **`92B5EE8F5FD4C2BB6FE1B09A0B39C88AD453573ABD8EFCF66A74B4E478B1E9A8`**, 205,917,942 bytes, built 2026-11-12 21:02 |
| SHA-256 (withdrawn) | `E0B3CB644A9C36278AC1FDEAF82E194F2B40501E53AE167DEBB1748729A0E165`, 205,887,450 bytes, 18:31. It matched the expected hash, but it contained B1. |
| Authenticode | **NotSigned.** SmartScreen will warn ("Windows protected your PC" → More info → Run anyway). This is expected for the RC (owner gate D6). |
| Type | electron-builder NSIS, `perMachine: true`, `oneClick: false`, appId `com.gtrade.erp`, NSIS GUID `7d0f5a52-6a0e-4c63-9b3e-0b8f6b4e2c11` |
| Elevation | Needs Administrator (UAC prompt). The current session is **not** elevated. User `Nafih` is in Administrators. |
| Auto-update / publish | None configured (`publish: null`, no electron-updater). It never phones home. |
| Licence | With no key/file in the answers, it starts in **offline evaluation mode**. No network call. |
| Cloud hosts in shipped code | None. The SPA, `gtrade_ctl`, `gtrade_server` and `app.asar` contain no `onrender.com`, `vercel.app` or `neon.tech`. |
| Pages | Licence (EULA) → install folder → **mode** → data folder + HTTPS port → company + admin → install. Mode is locked on later upgrades. |
| Silent switches | `/S /MODE=standalone\|server\|workstation [/DATA=] [/PORT=] [/ANSWERS=]` |

## 3. Installation modes and the choice for this PC

| Mode | What it does on this PC | Suitable? |
|---|---|---|
| **Standalone** | Own PostgreSQL 17 cluster plus app and web services. nginx binds **127.0.0.1** only. **No firewall rule.** | **Yes, recommended.** Nothing is reachable from the network. |
| LAN Server | The same, but nginx binds **0.0.0.0** and a firewall rule is added (Private profile, local subnet). | **No.** Your only network ("Nothing Phone (4a)" Wi-Fi hotspot) is **Public**, so the rule would not apply, workstations could not connect, and listening on all interfaces is unnecessary for a single-PC test. |
| LAN Workstation | Needs an existing G-TRADE server and pairing code. No database. | **No.** There is no server to pair with. |

The mode **cannot be changed by reinstalling**. To switch later you must uninstall and delete `C:\ProgramData\G-TRADE`.

## 4. Existing PostgreSQL and databases

| Item found | Detail | Effect of the installer |
|---|---|---|
| PostgreSQL 17.10 (EDB) | Service `postgresql-x64-17`, Running/Auto, NetworkService, data `C:\Program Files\PostgreSQL\17\data`, `listen_addresses='*'`, **port 5432** | **None.** G-TRADE ships its own PG 17 binaries (`…\resources\server\runtime\pgsql`). It never calls the system `psql`/`pg_ctl`, never reads the EDB registry keys, and creates a separate cluster. |
| PostgreSQL 18.4 (EDB) + Bluefin, PostGIS | Service `postgresql-x64-18`, Running/Auto, **port 9961** | None |
| pgAgent | `pgagent-pg17` → localhost:5432 | None |
| PostgreSQL 14 folder | `C:\Program Files\PostgreSQL\14` (no service) | None |
| MySQL 8.0 | `MySQL80`, Running/Auto | None |

How the G-TRADE cluster is kept separate:

- Data goes to `C:\ProgramData\G-TRADE\pgsql\data` on **127.0.0.1:5544**, with `pg_hba` allowing scram-sha-256 from loopback only.
- The service is named `GTrade-DB`, registered with `pg_ctl register -N GTrade-DB`. No service name is reused.
- The install aborts with "Nothing was changed" if the data folder contains a non-G-TRADE cluster (`cluster_state() == 'foreign'`).
- The app role is least-privilege (not superuser, no CREATEDB/CREATEROLE). `verify()` fails the install otherwise.

**Conclusion: existing databases cannot be affected.** The only shared resources are CPU, RAM and disk.

Pre-existing observation, unrelated to G-TRADE and not changed: PG17 and PG18 both listen on all interfaces (`'*'`) while the PC is on a Public network.

## 5. Services, ports, firewall, folders and other system changes

**Ports.** All three ports the installer needs are free. Preflight blocks the install if any is in use. It does not silently move ports.

| Port | Used by G-TRADE | Currently |
|---|---|---|
| 5544 | GTrade-DB (loopback) | free |
| 8001 | Waitress / GTrade-App (loopback) | free |
| 8443 | nginx / GTrade-Web (loopback in Standalone) | free |
| 5432 / 9961 | system PG17 / PG18 | in use, not touched |
| 8000 / 5173 | dev runserver / Vite | not touched |
| 18443/18001/15544, 57440+ | `windows\tests` harnesses | do not collide |

**Windows services added (Automatic start):** `GTrade-DB` (postgres.exe), `GTrade-App` (python -m gtrade_server via WinSW) and `GTrade-Web` (nginx via WinSW). All run as NETWORK SERVICE, restart on failure after 5 s, 10 s and 30 s, and are removed on uninstall. None of the names exist today.

**Firewall:** Standalone adds **no rule**. The only rule the product ever creates is `G-TRADE ERP HTTPS (LAN)`, and only in Server mode. The two existing `python.exe` inbound rules belong to your system Python and are not touched. The embedded Python binds loopback only, so Windows will not prompt for a new rule.

**Folders created:**

| Path | Contents | On uninstall |
|---|---|---|
| `C:\Program Files\G-TRADE ERP\` | Electron app, `resources\server\` (embedded Python 3.12, PG17, nginx, WinSW, app\1.0.0), `services\` | Removed |
| `C:\ProgramData\G-TRADE\` | config (install.json, gtrade.env, DPAPI secrets, TLS CA, licence), pgsql\data, media, static, backups, logs, run, updates | **Kept** unless you tick delete **and** type the company name |
| `C:\ProgramData\G-TRADE\client\client.json` | desktop client connection + pinned CA | Removed |
| `%APPDATA%\G-TRADE ERP\` | Electron user profile | Kept (`deleteAppDataOnUninstall: false`) |
| Start menu + Desktop shortcut "G-TRADE ERP" | | Removed |

None of these exist today. ACLs are tightened only on `C:\ProgramData\G-TRADE`. Free space is fine: C: has 29.7 GB, and the minimum is 10 GB.

**Not changed by the installer.** The source shows no `setx`, PATH or environment writes, no registry edits outside the NSIS uninstall key, no certificate-store import (the per-install CA lives in the data folder and is pinned by Electron, not trusted machine-wide), and no hosts-file edits.

**Name clash, cosmetic only.** An unrelated product **"GTRADE" by GreenSol Technologies LLP** (MSI `{E2BD3C35-…}`, `D:\Program Files (x86)\GreenSol Technologies LLP\GTRADE\`) is installed. G-TRADE ERP uses a different GUID, display name and folder, so there is no technical conflict. When uninstalling, pick **"G-TRADE ERP"**, not "GTRADE". GreenSol also has a Start menu shortcut called **`G-TRADE.lnk`** (folder `GreenSol Technologies LLP\GTRADE`), so in Start search launch **"G-TRADE ERP"**, not "G-TRADE".

## 6. Coexistence with the development environment

| Dev asset | Interaction |
|---|---|
| `D:\G OPTICALS` repo | Not read or written. The data folder must stay **outside** the repo. Keep the default `C:\ProgramData\G-TRADE`, because the data-folder check does not block a path inside the repo. |
| System Python 3.12 (`%LOCALAPPDATA%\Programs\Python\Python312`) | Not used. The embedded Python ignores PYTHONPATH and gets its code via `gtrade_app.pth` + `GTRADE_APP_DIR`. |
| `backend\.env` (Neon URL) | Not read by the installed app (see B1 for the copy inside the installer). |
| Dev ports 8000/5173, PG 5432 | No overlap |
| `windows\tests` suites | Use temp folders, their own ports and `GTRADE_CLIENT_DIR` overrides, so they can run alongside an installed copy. |
| `ELECTRON_RUN_AS_NODE` | Set in VS Code terminals. **Run the installer and the app from Explorer or the Start menu, not from a VS Code terminal.** Otherwise Electron starts as plain Node. The installer clears it for `gtrade_ctl`, but not for the app you launch afterwards. |
| `windows\tests\elevated_smoke.ps1` | **Do not run it on this PC.** It runs `Stop-Process -Name python -Force`, which kills *every* Python process, including your dev backend and tools. It is written for clean VMs. |

**Conclusion: a Standalone install can coexist with the dev environment.**

## 7. Risks specific to this PC

| ID | Risk | Severity | Mitigation |
|---|---|---|---|
| B1 | Neon credentials shipped inside the installer | **High (distribution)**, none at runtime | Rebuild without `.env`; rotate the password if it was shared (§1) |
| R1 | **RAM: 7.2 GB total, 0.8 GB free** at inspection. Preflight warns below 8 GB. PG17, PG18, MySQL, pgAgent and VS Code are already resident, and G-TRADE adds a third PostgreSQL plus Waitress (16 threads), nginx and Electron. | Medium | Close other apps and browsers during the test. Expect slowness, not data risk. After testing, uninstall, or set the three GTrade services to Manual (your choice; not done). |
| R2 | Unsigned installer and binaries (WinSW, nginx unsigned upstream) | Low here, because the hash is verified | Accept the SmartScreen prompt. Signing remains a release gate. |
| R3 | Services auto-start on every boot until uninstalled | Low | Uninstall after the test, or switch the services to Manual |
| R4 | First install over real elevation has never been run on any machine (Phase 9: "service registration not verified") | Medium | This PC would be the first elevated run. Keep the install log, and the rollback in §8.4 is clean. |
| R5 | Choosing the wrong mode or data folder (inside the repo or on D:) | Low | Use defaults: Standalone, `C:\ProgramData\G-TRADE`, port 8443 |
| R6 | Picking the GreenSol "GTRADE" entry when uninstalling | Low | Uninstall "G-TRADE ERP" only |

## 8. Backup and recovery

### 8.1 What protects your existing system

Your existing data is not in G-TRADE's path. Before the first install, these steps are recommended (all are your actions; none were done):

1. Create a **System Restore point** (Control Panel → System → System Protection → Create). It covers the services, registry and Program Files.
2. *Optional:* take a fresh dump of anything valuable in the local PG17/PG18 clusters (`pg_dumpall` as `postgres`). This is a read-only operation on those clusters.
3. Commit or stash your uncommitted repo work. The installer does not touch it, but there is a large uncommitted change set.
4. Do not install while a local dev server is writing to a database you care about.

### 8.2 What G-TRADE does for its own data (from `gtrade_ctl\backup.py` and the install flow)

- **Backup format:** `pg_dump -Fc` plus `media.zip` plus `manifest.json` with SHA-256 and size per file, version, install id and applied migrations. Stored under `C:\ProgramData\G-TRADE\backups\db\<name>\`.
- **Scheduled daily backup** at 21:30 by default (`GTRADE_BACKUP_TIME`). Retention keeps 14 daily, 8 weekly, 12 monthly, 5 pre-update and 5 pre-install, and always keeps the newest verified backup.
- **Reinstall or repair over kept data:** a verified pre-install backup is taken before any migration.
- **Update:** a mandatory pre-update backup, the previous app copied to `…\rollback\app-<ver>`, and automatic rollback on failure.
- **Restore** (`gtrade-ctl backup restore --name … --confirm`, Administrator): it takes a pre-restore safety backup, restores into a **new** database, verifies it, then swaps. The old database is kept as `<name>_pre_restore_<ts>`.
- **Uninstall:** data is kept by default. Deletion needs the tick box **and** the exact company name, and a verified final backup is written to the Desktop first. A silent uninstall always keeps data.
- **Evidence:** the Phase 9 e2e suite (`test_backup_update_e2e`, 10 tests) passed for backup, deep verify, tamper detection, restore, offsite copy, update and rollback, **non-elevated only**. Restore and rollback under real services have not been exercised yet. This test would be the first.

### 8.3 How to verify backups during the test (after approval)

From an elevated PowerShell (not VS Code):

```
$r = "C:\Program Files\G-TRADE ERP\resources\server"; $env:ELECTRON_RUN_AS_NODE = ""
& "$r\gtrade-ctl.cmd" backup run
& "$r\gtrade-ctl.cmd" backup list
& "$r\gtrade-ctl.cmd" backup verify --name <name>
& "$r\gtrade-ctl.cmd" health
```

### 8.4 Full rollback of the test (returns the PC to today's state)

1. Settings → Apps → **G-TRADE ERP** → Uninstall. Keep the data box unticked. This removes the services, the shortcuts, Program Files and `client.json`.
2. Confirm `Get-Service GTrade-*` returns nothing, and that no `G-TRADE ERP HTTPS (LAN)` firewall rule exists (none is created in Standalone).
3. Delete `C:\ProgramData\G-TRADE` and `%APPDATA%\G-TRADE ERP` once you no longer need the test data.
4. If anything else looks wrong, use the System Restore point from §8.1.

## 9. Proposed installation run-book (awaiting your approval)

1. *(Recommended)* Approve fix **B1**, then rebuild and re-hash the installer.
2. Create a System Restore point. Close browsers and heavy apps.
3. Start the installer from **File Explorer** (double-click), accept UAC, and at SmartScreen choose More info → Run anyway.
4. Install folder: default. Mode: **Standalone**. Data folder: **`C:\ProgramData\G-TRADE`**. Port: **8443**.
5. Company: a clearly fake name (e.g. "Test Opticals"). Admin password: 10+ characters, kept somewhere safe.
6. Afterwards check:
   - `Get-Service GTrade-*` shows all three Running/Automatic.
   - `postgresql-x64-17`, `postgresql-x64-18` and `MySQL80` are unchanged.
   - Port 5544 is listening on 127.0.0.1 only.
   - The app opens from the Start menu.
   - Run `backup run` + `verify`.
7. Keep `C:\ProgramData\G-TRADE\logs\install\*.jsonl` as evidence.

**Nothing has been installed.** B1 is fixed (see the update at the top). **Waiting for your approval** to run the Standalone install of the `92B5EE8F…` installer using the run-book above.
