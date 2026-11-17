# G OPTICALS – Windows upgrade "error 70": root cause and fix

**Date:** 2026-11-17 · **New installer:** `windows\out\installer\G-OPTICALS-Setup-1.0.0.exe`
**SHA-256:** `51D84F8C62DD1C4E083361ABFAC27B14CEF4794689DC19E8CD315FA25B2C730C` · **Size:** 206,214,785 bytes
**BUILD_ID:** `1.0.0-20261117T064119Z-39ea00e3` · **Unsigned** · **Not installed on any PC**

## 1. What failed

Source: `C:\ProgramData\G-TRADE\logs\update\update-20261117-114427.jsonl` (installer F73F8C41…, built 2026-11-14).

| Step | Result |
|---|---|
| database (services prepared for their own accounts, PostgreSQL started, `SELECT 1`) | ok, 31.8 s |
| compatibility, prechecks, stop | ok |
| pre-update-backup `gtrade-pre-update-20261117-114531` | ok, verified |
| migrate (1 migration) | ok, 5.8 s |
| collectstatic | ok |
| **switch** | **FAILED**: "GTrade-Web did not start (state STOPPED)" |
| rollback: restore-database, switch-back to the previous code, health | all ok, so setup reported **error 70** |

The update log only captured SCM's status text. The real reason is in `logs\services\GTrade-Web.err.log` (three start attempts by SCM recovery):

```
nginx: [emerg] CreateDirectory() "C:/ProgramData/G-TRADE/temp/nginx/client_body" failed (5: Access is denied)
```

Error 70 means "failed, previous version restarted and health-checked". This PC has had three failed update attempts, each with a different cause:

| Attempt | Cause | Status |
|---|---|---|
| 2026-11-13 17:40 (AC9551B3) | PostgreSQL not running at prechecks | Fixed 2026-11-13. Today's log shows `database` and `prechecks` passing. |
| 2026-11-13 18:42 (0E4E3308) | WinSW 2.12 "Unknown command: refresh" | Fixed 2026-11-13. Today's `database` step re-created the wrappers without error. |
| **2026-11-17 11:44 (F73F8C41)** | **nginx denied listing parent folders (below)** | **Fixed in this build** |

## 2. Root cause

1. Since 2026-11-13 the update moves the services from LocalSystem to their own virtual accounts (`NT SERVICE\GTrade-DB/App/Web`). The data-folder policy gave `GTrade-Web` Modify on `temp\nginx`, `logs\web` and `run\nginx`, but **nothing on the parent folders** `temp`, `logs` and `run` (those are protected for SYSTEM, Administrators and the App only).
2. nginx for Windows checks every path it opens or creates by calling `GetLongPathNameW` (`ngx_win32_check_filename`). That call resolves path components by **listing the parent folder**. Listing `temp` was denied, so `CreateDirectory` failed with error 5 even though `temp\nginx` itself allowed the write.
3. **Proof:** the real bundled nginx 1.30.6 was run as a normal user against a scratch tree with the same per-folder access. Without List on the parents it prints the identical message. With List (this folder only) on `temp`, `logs` and `run`, `nginx -t` passes, including with the real TLS config.
4. **Why the tests missed it:** the real-stack E2E tests run with `--no-services --no-acl`. The elevated self-test does run probes *as* the service account, but they write files through .NET APIs, which never call `GetLongPathNameW`, so they passed 70/70.
5. **Why it cost a database restore:** the Web service first ran under its new account at `switch`, after the migration. The rollback then restored the pre-update backup, which worked.
6. **Also affected:** a *fresh* Standalone or LAN Server install with F73F8C41 applies the same policy and starts Web under its virtual account in the `services` step, so it would fail the same way. Workstation installs run no services and are not affected.

## 3. Fix

| File | Change |
|---|---|
| `windows/gtrade_ctl/winacl.py` | `service_access_plan()` is the single declarative list of Web and DB grants. It now adds **List, this folder only (no inheritance)** on every folder between the data root and each path a service uses: for Web that is `temp`, `logs`, `run`, `config` and `config\tls`; for DB it is `logs`. The service can see entry *names* in those folders, never the contents: `ca.key`, `secrets.dpapi`, `media`, `backups` and `pgsql` stay closed. New `effective_rights()` evaluates the real on-disk ACL for a service SID plus the groups a service token carries (Win32 `AuthzAccessCheck`, by SID, so it works before the service is registered). New `service_access_problems()` / `require_service_access()` check every plan entry and every existing sub-folder under a Modify grant. |
| `windows/gtrade_ctl/services.py` | `ensure_service_files()` (the one path used by both install and update) proves access **before** any service is reconfigured or started. In an update this is step 0, so an access defect now ends as "failed before changes": no backup or migration needed, previous accounts restored, previous version restarted and health-checked. `start_service()` now quotes the program's own new stderr lines (for example nginx's `[emerg]` line) instead of SCM's status dump. |
| `windows/tests/test_nginx_service_access.py` (new, 11 tests) | Plan covers every path in the real rendered `nginx.conf`. Parent grants never inherit and never reach private folders. **Real nginx.exe** passes with the fixed access. A **negative control** reproduces the exact 2026-11-17 message and the pre-start check flags `temp`, `logs` and `run`. A protected leftover sub-folder is detected. Authz allow/deny/group semantics. The start error quotes nginx's reason. The access check runs before any registration change. |
| `windows/tests/test_backup_update_e2e.py` | New `test_06c`: an access defect stops the update in step 0, with no backup, no migration, unchanged data, previous accounts restored and health proven. |
| `windows/tests/elevated_service_selftest.py` | New stage: the disposable web service runs the **real nginx** with the real config and TLS under its virtual account. It must stay running, log no `[emerg]` and answer HTTPS. Needs Administrator; **not run yet**. |

No change to NSIS, the database engine, migrations, the backup format, licensing or the application code.

## 4. Database safety

- Nothing on this PC was installed, upgraded or modified. The live database (port 5544) was never connected to. All tests used disposable PostgreSQL clusters on other ports and scratch folders under `%TEMP%`.
- The update never deletes or re-creates the cluster or the database. The bundled PostgreSQL 17 runtime and its data folder are kept, and the port and credentials come from the existing `config`. Migrations run only after a verified backup. On failure the backup is restored into a new database and swapped in; the replaced database is kept as `gtrade_pre_restore_<time>`, never dropped.
- Today's rollback on this PC left `gtrade_pre_restore_20261117114700` (the migrated copy) and `C:\ProgramData\G-TRADE\media.pre_restore_20261117114700`. This is by design. Keep them until the new version is confirmed working.
- The new build contains **the same 148 migrations** as F73F8C41, so on this PC the update will apply the single migration that already ran successfully at 11:45 today (5.8 s).

## 5. Backup and rollback

- Pre-update backup: `pg_dump -Fc` of the **whole** `gtrade` database (every client/tenant, since tenants are rows in one database) plus `media.zip`. It uses the bundled PostgreSQL 17 tools (pre-checked before anything else), a unique timestamped name (never overwrites), and SHA-256 per file in `manifest.json`. It is verified (checksums + `pg_restore --list`) before the update may continue; if verification fails, nothing has changed.
- The full E2E suite passed on a disposable stack: backup verification and tamper detection, restore, failed migration rolled back (half-applied table gone), unhealthy new version rolled back, refusals before any change, the early-failure restart, and the new access-defect case.

## 6. Test results (2026-11-17)

| Suite | Result |
|---|---|
| Windows suite with real-stack E2E (`GTRADE_E2E=1`): Standalone, LAN Server, Workstation pairing, desktop, backup/update/rollback, business flow, Super Admin | **238 / 238 OK, 0 skipped** (was 226; +12 new) |
| Windows-edition Django tests (`apps.licensing`, disposable PG 17) | **38 / 38 OK** |
| Frontend unit tests (26 scripts + `uiDensity.test.js`) | **211 / 211** |
| Full cloud Django suite (disposable PG 17) | **1,159 OK** (3 skipped), 41 min |
| Elevated self-test incl. the new real-nginx stage | **Not run** (needs an elevated prompt) |

## 7. Package verification

`windows\tooling\verify_package.py` on the 7-Zip-extracted `.exe`: **29 / 29**. Highlights:
- The packaged app is identical to the current source.
- All 148 migrations are packaged.
- PostgreSQL is 17.x; `pg_dump`, `pg_restore` and `psql` run, and `gtrade_ctl` finds its own `pg_dump`.
- nginx, WinSW and the embedded Python imports are present.
- No forbidden files or secret values, no private keys, no vendor licensing keys.

`payload_guard`: OK. Also confirmed inside the extracted payload: the Error 70 fix, `cmd_create_superadmin`, `local_superadmin.py`, the Super Admin / Client Management backend, and the `TenantManagement` / `ClientUsersPanel` / `/super-admin/login` frontend.

The previous installer (F73F8C41…) is kept in `windows\out\archive\pre-error70-20261117\` with a DEFECTIVE note.

## 8. Upgrading the existing PC

1. Pick a time when nobody is billing. Restart the PC, then close other heavy programs. Free RAM was under 1 GB during this work; the setup itself only checks total RAM.
2. Check the file: `Get-FileHash "D:\G OPTICALS\windows\out\installer\G-OPTICALS-Setup-1.0.0.exe"` must print `51D84F8C62DD1C4E083361ABFAC27B14CEF4794689DC19E8CD315FA25B2C730C`.
3. Optional extra safety: in the app, take a manual backup first. The update also takes its own verified backup.
4. Run the setup and accept the Administrator prompt. Keep the existing mode (it is detected). Do not uninstall anything first.
5. Afterwards, from an **elevated** PowerShell:
   - `Get-CimInstance Win32_Service -Filter "Name like 'GTrade-%'" | Select Name,StartName,State`: all three Running, as `NT SERVICE\GTrade-DB/App/Web`.
   - The newest `C:\ProgramData\G-TRADE\logs\update\update-*.jsonl` ends with `"step": "update", "status": "complete"`.
   - Open G OPTICALS, sign in, open a recent invoice and Client Management.
6. If setup reports an error again, the data is safe (same rollback). Send the folder `C:\ProgramData\G-TRADE\logs`; the update log now contains the service's own error text.

## 9. Still open (needs you or physical hardware)

- Run the elevated self-test, including its new real-nginx stage, from an Administrator prompt: `cd "D:\G OPTICALS\windows"` then `.\out\venv-candidate\Scripts\python.exe -m tests.elevated_service_selftest`.
- The real upgrade on this PC (never performed by me). Also a reboot test, a fresh install on a clean PC, and a two-PC LAN Server + Workstation test.
- An *available*-RAM gate before the update: not added, because no minimum has been measured (the setup blocks below 4 GB *total* RAM).
- The installer is unsigned. Leftover temp folders from older test runs (`%TEMP%\gtrade-coexist-*` and similar) can be deleted.
