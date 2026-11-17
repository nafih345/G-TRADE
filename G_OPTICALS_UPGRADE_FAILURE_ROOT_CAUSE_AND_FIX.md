# G OPTICALS: upgrade failure on 2026-11-13 17:37: root cause and fix

**Symptom.** Upgrading over the 11:55 Standalone install (with RC AC9551B3) failed with
`psql failed (2): connection to server at "127.0.0.1", port 5544 failed: Connection refused (10061)`.
GTrade-DB, GTrade-App and GTrade-Web were all stopped. SCM logged *"The system cannot find the file specified."*
The installer then said *"Your data was restored … the previous version is running again"*. **That message was false.**

## 1. Evidence (this PC, read-only inspection)

| Time | Source | Event |
|---|---|---|
| 17:36:34–52 | `rollback\app-1.0.0` | customInit snapshot of the *old* (11:55) code. This is the code that matches the database. |
| 17:37:16, 17:37:31 | System log 7034 | GTrade-DB *terminated unexpectedly* (×2) |
| 17:37:21–25 | `logs\db\postgresql-Fri.log` | *"database system was not properly shut down; automatic recovery in progress"*. There was no shutdown request, so this was a hard kill. |
| 17:37:41, 17:37:46, 17:38:01 | System log 7000/7001 | GTrade-DB *failed to start: The system cannot find the file specified* (restart triggered by GTrade-App's failure action through its dependency) |
| 17:38:53–17:40:27 | Program Files timestamps | New program files copied |
| 17:40:28–56 | `logs\update\update-20261113-174028.jsonl` | `compatibility` ok → `prechecks` **failed**: psql to 5544 refused |
| now | `Test-Path` | `pg_ctl.exe` ✔, `pgsql\data\PG_VERSION` ✔, **`resources\server\services\` missing** (GTrade-App.exe / GTrade-Web.exe / XML) |

The data directory is intact. Its last log entry is a clean end-of-recovery checkpoint (17:37:25). Nothing in the database was changed: migrate never ran.

## 2. Root causes (all confirmed in code)

1. **electron-builder killed PostgreSQL.** `app-builder-lib 26.18.0` `allowOnlyOneInstallerInstance.nsh` `KILL_PROCESS` runs
   `Get-CimInstance Win32_Process | ? Path.StartsWith($INSTDIR) | Stop-Process -Force`.
   PostgreSQL runs from `$INSTDIR\resources\server\runtime\pgsql\bin`, so it was force-killed. SCM's restart then
   ran after the old uninstaller had deleted `pg_ctl.exe` ("file not found"), and the recovery attempts ran out.
2. **Service wrappers deleted on every upgrade.** `Layout.services_dir = install_root\services` sits inside Program Files.
   The old uninstaller removes it, and nothing re-created it: `switch_version` wrote only the XML, `winsw refresh` ran with `check=False`, and the
   WinSW exe was never copied back. App and Web could not start after *any* upgrade. The rollback path had the same defect.
3. **`update apply` never started or verified PostgreSQL.** The `prechecks` step queried `database_size` against whatever state
   the installer had left behind.
4. **Failures before the backup gate restarted nothing.** In addition, the installer showed the same "restored … running again" text for every non-zero exit code.
5. **A rerun would have destroyed the good rollback copy.** customInit always re-copied `Program Files\…\app\1.0.0`
   into `rollback\app-1.0.0`. After this failure, that folder holds the new, never-migrated code.
6. **GTrade-DB had no SCM failure actions** (`pg_ctl register` sets none). A crashed PostgreSQL stayed down.

"Error 20" from the earlier reports is `EXIT['db']`: the same family of failure (database unreachable or partial cluster).

## 3. Fixes

| File | Change |
|---|---|
| `windows/installer/installer.nsh` | New `customCheckAppRunning` → `gtStopServer`. It closes only `$INSTDIR\G-TRADE.exe`, then stops services through SCM (Web → App → DB) so PostgreSQL shuts down cleanly. It waits for every process under `resources\server` to exit. It **never kills `postgres.exe`**: if PostgreSQL is still alive, setup quits before changing anything. Processes outside `$INSTDIR` (the customer's own PG 17/18, MySQL) are never touched. |
| same | customInit refreshes `rollback\app-<v>` **only** when `app\<v>\BUILD_ID == config\verified-build`. Otherwise the existing snapshot is kept. |
| same | Update result messages: exit **70** means "failed, previous version started again *and health-checked*". Any other code means "could NOT confirm it is running; no data deleted; run setup again / send logs". |
| `windows/gtrade_ctl/update.py` | New step 0 `database`: re-create the wrappers (pointing at the *previous* code), start GTrade-DB, `pg_isready`, then a real `SELECT 1` as the app role. Any failure before the backup gate runs `restore_previous` (switch back, start, health check), and `rolled_back` is true only if health proves it. Rollback also proves the database first. A success writes `config\verified-build`. |
| `windows/gtrade_ctl/services.py` | `ensure_service_files` (wrappers + XML + `winsw refresh`, checked). `start_all` starts DB → App → Web, each confirmed RUNNING before the next. `plan_db_recovery` sets GTrade-DB restart 5 s/10 s/30 s, reset after 1 h (applied at install and repair). The docstring is corrected: App/Web actually run as LocalSystem. |
| `windows/gtrade_ctl/update_cmds.py`, `cli.py` | Exit code 71 = failed and not verified running. An uncaught `UpdateError` also maps to 71. |
| `windows/gtrade_ctl/installer_cmds.py` | `repair` re-creates the wrappers and starts and verifies PostgreSQL before asking for the migration plan. A fresh install writes `verified-build` after its health step. The stale "update resume" hint is removed. |
| `windows/tooling/build_runtime.py` | Writes `app\<v>\BUILD_ID` (version + UTC time + random suffix). |

The existing startup safety is unchanged and has been verified: `gtrade_server` waits up to 120 s for SQL connectivity (`wait_for_database`) and
refuses to serve with pending migrations. Boot order comes from SCM dependencies (App depends on DB, Web depends on App).

## 4. Tests

- `windows/tests/test_upgrade_stop.py` (new, 13 tests, **pass**). They run the *real* compiled `gtStopServer` against a
  scratch install folder holding stand-in processes. Results: the desktop and server helpers are stopped, a `postgres.exe` outside the folder
  stays alive, and an in-folder `postgres.exe` makes the macro return 3 and is **not** killed. Other coverage: rollback-snapshot rules (failed update keeps the old copy, legacy keeps it, verified refreshes it, first upgrade takes one),
  `customCheckAppRunning` compiles with `/WX` in installer and uninstaller, `ensure_database` call order and refusal on a missing cluster, and the 70/71 exit codes.
- `windows/tests/test_backup_update_e2e.py`: two new real-PostgreSQL tests. `test_03b` stops PG, App and Web, then runs the update (the incident). `test_06b` causes an early failure with everything stopped, then checks that the previous version is restarted **and** health-checked.
- Full Windows unit suite: **144 tests OK** (32 skipped = opt-in e2e).

## 5. Recovering this PC

Nothing has been run against the installed system. The services are stopped and the data is intact.
Recovery means running the **new** installer elevated. Its flow: graceful stop (already stopped) → old uninstaller → copy → `update apply 1.0.0`.
That apply re-creates the wrappers, starts PG and proves SQL, keeps the 17:36 rollback snapshot (no `verified-build` exists on
this PC), takes a verified backup, migrates and health-checks. If anything fails, it restores and states the outcome honestly.
**This elevated run has not been executed yet. It is the owner's step.**

## 6. Release candidate built from this source

| | |
|---|---|
| Path | `D:\G OPTICALS\windows\out\installer\G-OPTICALS-Setup-1.0.0.exe` |
| Size | 206,066,499 bytes |
| Built | 2026-11-13 18:29:14 IST (app BUILD_ID `1.0.0-20261113T124246Z-3666c257`) |
| SHA-256 | `0E4E3308560200E965DAC9C0C8F6D6789F403129ABFD8D9B2AE04C9E55D833CC` |
| Payload guard | OK: 0 forbidden files (.env, keys, database.json), 4 secret values checked |
| Shipped engine | `gtrade_ctl` + `gtrade_server` byte-identical to the tested source. Backend apps identical. 148 migration files identical to source. |
| PostgreSQL | 17.10 runtime (`pg_ctl.exe`, `postgres.exe` present) |
| Defender | `MpCmdRun -Scan -ScanType 3`: no threats |
| Superseded | AC9551B3 → `windows\out\superseded-installers\SUPERSEDED-DEFECTIVE-UPGRADE-…AC9551B3.exe.do-not-run` |

The first electron-builder build failed with `!define "APP_EXECUTABLE_FILENAME" already defined`. The custom include is
processed before electron-builder's `common.nsh`. I fixed it and added a guard test (`NoElectronBuilderDefineCollisions`).

## 7. What is verified and what is not

| Test | Status |
|---|---|
| Root cause from live logs (SCM, PG, update log, file system) | VERIFIED |
| Installer stop macro (real compiled NSIS, stand-in processes) | VERIFIED (automated) |
| Update with PG stopped / early failure restore / migration failure rollback / unhealthy release rollback, real PG 17 | VERIFIED (automated, disposable cluster) |
| Windows unit suite | 144 OK + new 14 OK |
| **Elevated upgrade of THIS PC with the new RC** (the real recovery) | **NOT VERIFIED**: owner action, needs elevation and approval |
| Windows restart with services auto-starting | NOT VERIFIED |
| Clean Windows 10/11 PC or VM fresh install | NOT VERIFIED (no VM on this PC) |
| Two-PC LAN server + workstation | NOT VERIFIED (no second PC) |
| Least-privilege service accounts | **NOT MET**: App/Web run as LocalSystem (WinSW 2.x ignores `<username>`). The fix needs NetworkService ACLs on the data folders. Planned, not done. |
| Code signing | NOT DONE: the installer is unsigned, so SmartScreen will warn ("More info → Run anyway"). Needs an OV/EV code-signing certificate. |
| Performance pass | NOT DONE in this pass |
