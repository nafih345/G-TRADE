# G OPTICALS: PostgreSQL initdb Permission Failure, Root Cause and Fix

Date: 2026-11-13 · Scope: Windows installer engine (`windows/gtrade_ctl`) · Status: fixed, tested, new installer built, **not installed**

Failure on the owner's PC (installer `21015170…848460`):

```
step: database
PgError: initdb failed (1): initdb: error: could not open file
"C:\ProgramData\G-TRADE\pgsql\gtrade-pw-844piyy_" for reading: Permission denied
```

---

## 1. Exact root cause

**PostgreSQL never runs with an Administrator token, but the password file was readable only by Administrators, SYSTEM and NETWORK SERVICE.**

1. The elevated installer (`gtrade-ctl install`, running as the owner's account with Administrators **enabled**) created the one-time password file with `tempfile.mkstemp(dir=C:\ProgramData\G-TRADE\pgsql)`.
2. `pgsql\` carries the G-TRADE data-folder policy: **SYSTEM, Administrators and NETWORK SERVICE only**, inheritable. The new file therefore inherited exactly those three entries and nothing else.
3. `initdb.exe` (and `pg_ctl.exe` and `postgres.exe`) always re-launch themselves with a **restricted token** before doing any work (PostgreSQL `src/common/restricted_token.c`). The user SID stays. **BUILTIN\Administrators becomes "deny only"**, and every privilege except traverse is removed. That is how PostgreSQL avoids its own "must not run as administrator" check.
4. The restricted initdb is therefore *the owner's user SID without Administrators*. None of the file's three entries applies to it, so it got **Permission denied**.

Answers to the specific questions:

| Question | Finding |
|---|---|
| Who creates the password file? | `PgRuntime.initdb()` in `gtrade_ctl/pg.py` (old: `tempfile.mkstemp`), inside the elevated `gtrade-ctl install`. |
| Which account owns it? | The elevated installer's token. Its default owner is BUILTIN\Administrators; as the owner it gets only READ_CONTROL/WRITE_DAC, never read-data. |
| Which account launches initdb? | The same elevated installer process. initdb then **re-spawns itself** with the restricted token: owner's SID, Administrators deny-only. |
| ACLs on the file and its folder | `pgsql\`: `SYSTEM:(OI)(CI)F, Administrators:(OI)(CI)F, NETWORK SERVICE:(OI)(CI)F`, protected. The file inherited exactly these three entries. |
| Can the PostgreSQL process read it? | **No.** No entry matches the restricted token. |
| Locked, removed or modified early? | No. The handle was closed before initdb started, and the file was shredded only in `finally`, after initdb exited. |
| Incompatible ACL inheritance? | Yes, in effect: the inherited entries were correct for the folder's policy but useless for the restricted token. |
| Different security identity? | Yes: same user SID, but with Administrators deny-only. |

**A second failure was waiting behind the first.** With only the password file fixed, initdb fails next on `pgsql\data` (`could not change permissions of directory … Permission denied`; reproduced, see §4). After that, `pg_ctl start` would fail on `logs\db`. All three paths have the same cause, and the fix covers all three.

**Why earlier tests missed it.** The e2e tests set `GTRADE_SKIP_ACL=1`. The real-ACL tests (`test_config_permissions.py`) stood the test user in for Administrators with an inheritable Full grant everywhere, and that grant is exactly the access the restricted token lacks.

## 2. Process identities and ACL findings

- **Exact reproduction** in a throwaway `%TEMP%` folder, using the bundled PostgreSQL 17 `initdb.exe` and the production `pgsql` ACL. The script is at `C:\Users\nasih\AppData\Local\Temp\claude\f3b742a30a9a591c\d9fbc8ea-acef-4bbf-a41c-3c4ece7821bb\scratchpad\repro_initdb.py`. It printed:
  `initdb: error: could not open file "…\pgsql\gtrade-pw-5m04ef5w" for reading: Permission denied` (exit 1), and the data folder was **empty** afterwards (initdb reads the password file before it creates anything).
- The dev shell is non-elevated: `whoami /groups` shows `BUILTIN\Administrators … Group used for deny only`. That is the same token class as the restricted initdb. This is why the reproduction is exact without elevation.
- **Owner PC (read-only, nothing changed):** `C:\ProgramData\G-TRADE` root ACL = NETWORK SERVICE RX, Administrators F, SYSTEM F, plus the stray explicit `Nafih` entry noted in the previous report (not created by the code). `C:\ProgramData\G-TRADE\pgsql` gives **Access is denied** to this non-elevated shell. That is direct evidence that a user token without Administrators, which is what initdb has, cannot open it.
- **Postmaster identity test** (`test_postgres_runs_as_the_granted_sid_without_administrators`): it reads the running postmaster's token through `OpenProcessToken`/`GetTokenInformation`. The token user is the **exact SID the fix grants**, and Administrators is not enabled in it (deny-only).

## 3. Source files changed

| File | Change |
|---|---|
| `windows/gtrade_ctl/winacl.py` | `create_private_file()`: creates the file with `CreateFileW(CREATE_NEW)` and a **protected** DACL from SDDL, so there is never a moment with inherited access. SIDs are validated, which blocks SDDL injection. `grant_operator()`: **adds** one inheritable Modify entry for the SID this process runs as (`icacls /grant`; it never uses `/grant:r` or `/inheritance:r` and never removes anything). It is skipped for SYSTEM, LOCAL SERVICE and NETWORK SERVICE, which are already covered. Policy docstring updated. |
| `windows/gtrade_ctl/pg.py` | `initdb()`: (1) sweeps stale `gtrade-pw-*` files; (2) grants the operator SID on **`pgsql\data` and `logs\db` only** (`pgsql\` itself is not widened); (3) writes an `initdb.in-progress` marker; (4) creates the password file with DACL = **Administrators + own SID only** and a random name; (5) runs initdb; (6) always shreds the password file (with retries in case an antivirus holds it); (7) removes the password from any error text (`[REDACTED]`). `cluster_state()` gains **`partial`**: a non-empty folder plus the marker, or `PG_VERSION` without `global/pg_control`. `start()` and `is_running()` make sure of the operator access (best effort, cached). `_shred()` now fsyncs, falls back to deleting, and reports whether it succeeded. `tempfile` is no longer used. |
| `windows/gtrade_ctl/installer_cmds.py` | `database` step: sweeps stale password files on **every** install and repair; `partial` stops the install with recovery text; the number of files removed is reported. |
| `windows/gtrade_ctl/cli.py` | `init-db`: same sweep and `partial` refusal. |
| `windows/tests/test_initdb_permissions.py` | **New:** 11 regression tests (§4). |
| `windows/docs/TROUBLESHOOTING_GUIDE.md` | Two new rows: this error, and the "INCOMPLETE database" recovery. |

Security properties of the password file: only Administrators (the installer) and the installer's own SID (the restricted initdb) can access it, never Everyone, Users or NETWORK SERVICE. Its name is random, the password never appears on a command line, and it is not written to logs or error messages. It is shredded right after initdb, after both success and failure, and any leftover from an interrupted run is shredded on the next install or repair. The overall data-folder policy is unchanged. The only added access is one Modify entry, for the installing administrator's own SID, on `pgsql\data` and `logs\db`; that administrator already has full control through Administrators. The EnterpriseDB installer grants this same kind of access.

## 4. Test results

| Run | Result |
|---|---|
| `tests.test_initdb_permissions` (new, real `icacls` and the real bundled PG 17 under the production ACL) | **11/11 OK** (74 s) |
| Full Windows suite, `GTRADE_E2E=1`, on the restaged app (includes `test_installer_nsh` with `makensis /WX`, the install/resume/backup/update e2e tests and the earlier ACL tests) | **123 tests OK, 0 skipped** (942 s) |
| Full Windows suite without e2e | 123 run, OK, 25 skipped (the e2e tests) |
| Mutation check: operator grant disabled | Test **fails**: `could not change permissions of directory …\pgsql\data: Permission denied` |
| Mutation check: password file DACL = Administrators only | Test **fails** with the owner's exact message: `could not open file "…\gtrade-pw-…" for reading: Permission denied` |
| bandit 1.9.4 on the changed modules | 0 High. 2 Medium + 9 Low are older patterns that were already there (SQL from validated identifiers; `icacls`/`whoami` called by name). Nothing in the new code. |
| `payload_guard` on `win-unpacked` | OK: 0 forbidden files, 4 developer secret values checked, none found |
| Dependencies | Unchanged, so the earlier pip-audit result (0 known vulnerabilities) still applies |

Requirement coverage: password file creation and ACL (`test_password_file_is_private…`, `test_private_file_has_exactly…`); ACL inheritance and minimal grant (`test_fixed_initdb…`, `test_grant_operator_only_adds…`); initdb identity (`test_postgres_runs_as_the_granted_sid…`); successful init (`test_fixed_initdb…`, which also starts the server and logs in with the password from the file); permission-denied recovery and retry (`test_old_code_reproduces…`, then `test_fixed_initdb…` in the same folder, which sweeps the stale password file); secrecy and cleanup on failure (`test_failed_initdb_cleans_up_and_never_leaks…`); partial clusters (`test_interrupted_initdb_is_partial…`, `test_pg_version_without_pg_control…`, `test_stale_marker…`); existing-database preservation (`test_existing_database_is_preserved_byte_for_byte`, plus the existing `test_existing_cluster_is_never_reinitialised…`).

**Not run:** an **elevated** install on a clean VM. The model is exact (same token class), but this remains an owner gate.

## 5. Existing database preservation evidence

- **No partial cluster exists on the owner PC (by analysis).** initdb reads the password file *before* it creates any file, and it failed there; the reproduction confirms an empty data folder. `pgsql\data` is therefore empty, and the new setup's `cluster_state` = `empty` lets it initialise in place. Nothing needs to be deleted.
- A leftover `gtrade-pw-844piyy_` would contain the real superuser password. The old code shredded it in `finally` with Administrator rights, so it is most likely gone. In any case, the new setup shreds any `gtrade-pw-*` before it does anything else in the database step.
- Code guarantees: `cluster` → never re-initialised; `partial` and `foreign` → refused, and every file stays byte-for-byte identical (tested with SHA-256 trees). No code path deletes or overwrites data.
- I did **not** run any installer, did not touch `C:\ProgramData\G-TRADE` (read-only listing only; folder timestamps unchanged: `pgsql` 10:50:30, `config` 10:50:28), and did not touch the dev or production databases, Neon or Render. `postgresql-x64-17`, `postgresql-x64-18`, `MySQL80` and `pgagent-pg17` are all still **Running**. Tests used only free ports and throwaway `%TEMP%` clusters.

**If a partial cluster is ever found** (setup interrupted mid-initdb), setup stops with "INCOMPLETE database … Nothing was changed or deleted". Recovery, to do by hand only if the folder never held business data: as Administrator, rename `pgsql\data` to `data.incomplete-<date>`, delete `pgsql\initdb.in-progress`, then run setup again. Otherwise contact support. This is also in `TROUBLESHOOTING_GUIDE.md`.

## 6. Is a new installer required?

**Yes.** The fix is in `gtrade_ctl`, which ships inside the setup. The installer that failed (`21015170…848460`) is **retired as DEFECTIVE**. It was moved, not deleted, to `windows\out\superseded-installers\SUPERSEDED-DEFECTIVE-G-OPTICALS-Setup-1.0.0-21015170.exe.do-not-run`, and `README.txt` there is updated.

## 7. New installer

| Item | Value |
|---|---|
| File | `D:\G OPTICALS\windows\out\installer\G-OPTICALS-Setup-1.0.0.exe` |
| Size | 205,985,507 bytes |
| **SHA-256** | **`1ACEFB530DCDEE5869670A72E3A9DAACFB8886499818E85D76514A94FEC5A616`** |
| Build | app restaged (`windows\out\initdbfix_stage_app.log`), then `electron-builder --win nsis` exit 0 (`windows\out\initdbfix_installer_build.log`) |
| Fix present in the payload | `grant_operator`, `create_private_file`, `sweep_stale_pwfiles` and `INITDB_MARKER` found in `win-unpacked\resources\server\app\1.0.0\windows\gtrade_ctl`; no `mkstemp` in the shipped `pg.py`; the troubleshooting row is in `resources\docs` |
| payload_guard | OK |
| Defender | Custom scan requested, and no detections were recorded in the last hour. That call may need elevation, so treat this as weak evidence. |
| Authenticode | NotSigned (unchanged; code signing is still an owner decision) |

## 8. Exact next installation instructions (only after owner approval)

1. Close any open setup window. Make sure the PC has at least 2 GB of RAM free.
2. Verify the file. The hash must be `1ACEFB53…5A616`:
   `Get-FileHash "D:\G OPTICALS\windows\out\installer\G-OPTICALS-Setup-1.0.0.exe"`
3. Optional, read-only, in an **elevated** PowerShell: `Get-ChildItem -Force C:\ProgramData\G-TRADE\pgsql, C:\ProgramData\G-TRADE\pgsql\data`. Expected: `data` is empty, and there may be a leftover `gtrade-pw-*` file. **Do not delete anything by hand**; setup handles both.
4. Right-click the installer → **Run as administrator**. Choose **Standalone** again (the same type as before).
5. Expected: `permissions`, `configure`, `prepare-data` and `secrets` pass as before. `database` then sweeps any leftover password file, gives the database program access to `pgsql\data` and `logs\db`, initialises the empty folder, and continues with `migrate` → … → `health`.
6. If setup stops, do not re-run it repeatedly. Send the newest `C:\ProgramData\G-TRADE\logs\install\*.jsonl` (it contains no passwords). If the message says **INCOMPLETE database**, follow §5 or contact support. Setup never deletes it.

---

## GO / NO-GO

| Decision | Verdict |
|---|---|
| Fix implemented and tested (unit, real-ACL + real PG 17, mutation checks, full e2e) | **GO** |
| Retry the internal install on the owner's PC with the **new** installer `1ACEFB53…5A616` | **GO, waiting for owner approval.** Not installed. |
| Re-running installer `21015170…` (or any older one) | **NO-GO**: defective, retired |
| Commercial release | **NO-GO**, unchanged: code signing, EULA, icon, production licence keys, clean-VM elevated and LAN tests |

Nothing was installed, committed, pushed or deployed.
