# G OPTICALS for Windows: Production Release Report

Date: 13 Nov 2026. Supersedes the verdicts in `G_OPTICALS_UPGRADE_FAILURE_ROOT_CAUSE_AND_FIX.md`,
`G_OPTICALS_WINDOWS_CUSTOMER_READY_RELEASE.md` and `G_OPTICALS_URGENT_CUSTOMER_INSTALLATION_READINESS.md`.

Every result below is labelled as one of:

- **SOURCE FIX**: code changed.
- **AUTOMATED**: a test ran on this development PC and passed.
- **REAL-WORLD**: done on a real Windows installation.
- **NOT VERIFIED**: not done. The reason is given.

## Verdicts

| Area | Verdict | Why |
|---|---|---|
| Existing PC Upgrade | **NO-GO, ready for your approved run** | Mechanism fixed and tested (automated). Not yet run on this PC; it waits for your approval (section 4). |
| Windows Restart | **NO-GO** | NOT VERIFIED. A real shutdown and restart has not been done with this build. Procedure in section 5. |
| Windows Installer | **NO-GO for customers** | Built and checked (section 3). Unsigned, with no real elevated install of this build yet. |
| Clean Customer Standalone | **NO-GO** | NOT VERIFIED. No clean PC or VM is available: Windows 11 Home has no Hyper-V or Sandbox, and this PC has 7.2 GB RAM. |
| LAN Installation | **NO-GO** | NOT VERIFIED. No second PC was available. |
| Service Account Security | **NO-GO until the elevated self-test passes** | Design, source and policy tests pass. Enforcement under the real service tokens needs one Administrator run (section 4, step 1). |
| Application Performance | **NO-GO for catalogues above about 2,000 products; GO for the other screens** | Measured (section 6). |

## Final installer

| | |
|---|---|
| File | `windows\out\installer\G-OPTICALS-Setup-1.0.0.exe` |
| SHA-256 | `2A713CC2D01AE9C9FB4DDF0DD0472C4345A9175D3481955BBA229FE3A886AD74` |
| Size | 206,092,593 bytes, built 13 Nov 2026 21:02 IST |
| BUILD_ID | `1.0.0-20261113T152522Z-10a96609` |
| Superseded | `0E4E3308…` (the `refresh` defect) moved to `windows\out\superseded-installers\` as `SUPERSEDED-DEFECTIVE-WINSW-REFRESH-…-0E4E3308.exe.do-not-run`. Every earlier build is already there. |

## 1. The 18:42 update failure ("Unknown command: refresh")

### What happened (from the logs on this PC)

`C:\ProgramData\G-TRADE\logs\update\update-20261113-184200.jsonl`:

```
step database  failed  ServiceError: GTrade-App.exe refresh failed (4294967295) ...
                       System.Exception: Unknown command: refresh
step restore-previous  (same error again)
update failed-before-changes, previous_running: false
```

`logs\services\GTrade-App.wrapper.log` shows the same at 18:42:01 and 18:42:09.

### Root cause

The bundled wrapper is **WinSW 2.12.0**. This is verified: the SHA-256 `05b82d46…a0da` matches
`runtime_pins.json`, and it is the same file in the stage folder, the download cache and Program Files.
Its own `help` lists these commands only:

`install, uninstall, start, stop, stopwait, restart, restart!, status, test, testwait, version, help`

`refresh` exists only in **WinSW 3.x**. The fix written the same evening (installer 0E4E3308) re-created
the wrapper files and then called `GTrade-App.exe refresh` on every update and repair of an existing
installation. Two places did this:

- `services.ensure_service_files`, which is update step 0.
- `services.install_all`, which is the repair and re-install path.

The rollback (`restore_previous`) re-creates the wrappers through the same function, so it failed the
same way. That is why the previous version was not started again (exit 71).

No test ever ran the planned commands against the binary we ship. The update tests replace the service
controller with a fake one.

### Further defects found in the same investigation

All of these were read from SCM on this PC with `sc qc` / `sc qfailure`:

| Service | Found | Effect |
|---|---|---|
| GTrade-DB | **No recovery actions** (reset 0, no actions) | A crashed PostgreSQL stays down until someone restarts it. The earlier fix to add them sat after the failing `refresh` call, so it never ran. |
| GTrade-App / Web | `AUTO_START (DELAYED)` | WinSW 2.x treats *any* `<delayedAutoStart>` element as "delayed", even `false`. The application started about 2 minutes after boot. |
| GTrade-App / Web | Run as **LocalSystem** | WinSW 2.12 ignores `<serviceaccount><username>`, so the intended account was never applied. |
| all three | Recovery not applied to non-crash failures | A wrapper or pg_ctl that exits with an error code was not restarted. |
| GTrade-DB | NETWORK SERVICE, a shared account | Any other service running as NETWORK SERVICE could read the database files. |

The PostgreSQL log also shows "database system was not properly shut down" at 18:42:02. This is the
force-kill from about 17:40, by the older electron-builder check that the 0E4E3308 installer replaced
(`customCheckAppRunning`). It is not a new failure. Crash recovery completed ("redo is not required") and
the database has been RUNNING since.

## 2. What changed

### 2.1 Service management (`windows/gtrade_ctl/services.py`): SOURCE FIX

- The WinSW commands in use are declared in `WINSW_VERBS`
  (`install, uninstall, start, stop, stopwait, restart, status`), and `plan_winsw` refuses anything
  else. `refresh` is gone.
- **How a configuration change is applied with WinSW 2.12:**
  - WinSW reads `<id>.xml` at every service start. Executable, arguments, environment and log paths
    therefore only need the XML rewritten.
  - What SCM stores (start type, account, dependencies, recovery) is set with `sc.exe config` /
    `sc.exe failure` / `sc.exe failureflag`. The delayed-start flag is cleared with
    `ChangeServiceConfig2`.
  - Everything is then **read back** and compared (`verify_registration`). Any mismatch raises an
    error that names it.
  - Existing services are never deleted and re-created to change them, so the recovery settings and
    the registration survive.
- `install_all` registers only what is missing, then goes through the same configure path.
- A service whose account must change while it is running is stopped through SCM and waited for. If it
  does not stop in time, nothing is changed and the step fails. No process is ever killed.
- The XML no longer contains `<delayedAutoStart>` or `<serviceaccount>`. The App gets its own TEMP folder.
- Uninstall falls back to `sc delete` when an older uninstaller has already removed the wrapper EXE.
- `stop_all` waits until the services report STOPPED.
- New command: `gtrade-ctl services verify`. It is read-only and checks the account, start type,
  dependencies, recovery actions and program files of each service. `diagnostics` now includes the same
  data.

### 2.2 Least-privilege service accounts (`services.py`, `winacl.py`): SOURCE FIX

| Service | Before | Now |
|---|---|---|
| GTrade-DB | NT AUTHORITY\NetworkService (shared) | `NT SERVICE\GTrade-DB` |
| GTrade-App | LocalSystem | `NT SERVICE\GTrade-App` |
| GTrade-Web | LocalSystem | `NT SERVICE\GTrade-Web` |

These are Windows virtual service accounts. They have no password to store or leak, are not
administrators, cannot sign in interactively, and each has its own SID
(`S-1-5-80-<SHA-1 of the service name>`). That SID is computed the same way as `sc showsid`, so the
data-folder ACLs can be granted before the service exists.

Data-folder policy (`winacl.apply_data_root_policy`). SYSTEM and Administrators always have Full control.

| Folder / file | App | Web | DB |
|---|---|---|---|
| data root, `rollback\` | read | read | none |
| `config\` (install.json, gtrade.env, **secrets.dpapi**) | read | none | none |
| `config\nginx.conf`, `mime.types` | read | read (file only) | none |
| `config\tls\server.crt`, `server.key`, `ca.crt` | none | read (file only) | none |
| `config\tls\ca.key` (installation CA private key) | **none** | **none** | **none** |
| `pgsql\` | none | none | full |
| `media\`, `backups\` | modify | none | none |
| `static\` | read | read | none |
| `logs\` | modify | `logs\web`, `logs\services` | `logs\db` |
| `run\`, `temp\` | modify | `run\nginx`, `temp\nginx` | none |
| `updates\` | none | none | none |
| `client\` | (Users: read, public CA cert + server URL only) | | |
| Program Files (`resources\server`) | read & execute | read & execute | read & execute |

No grant to Everyone anywhere. Users get `client\` only. The secrets stay DPAPI machine-scope encrypted
(`CRYPTPROTECT_LOCAL_MACHINE`), so the App account can decrypt them and the ACL decides who may read the file.

**Upgrade of an existing installation (the order matters):**

1. The update records the accounts the services run as now (`previous_accounts`, also saved in
   `run\update-state.json`).
2. Step 0 applies the ACLs for the new accounts **first**. NETWORK SERVICE keeps its access to
   `pgsql\` and `logs\db` while the database may still need it.
3. The services are moved to their virtual accounts. A running PostgreSQL is stopped through SCM first,
   which means a clean shutdown.
4. PostgreSQL is started and must answer a real `SELECT 1` as the application role.
5. After migrate, App and Web start under their new accounts and must pass the HTTPS health gate.
6. Only after the health gate passes are NETWORK SERVICE's old grants removed (`finalize-accounts`).
7. **Every failure path restores the recorded previous accounts** together with the previous code (and,
   after a database change, the pre-update backup), then proves health:
   - an early failure (`restore_previous`)
   - a failure after the backup (`rollback`)
   - a manual `gtrade-ctl update rollback`
   - `gtrade-ctl repair`

   An account change is never silently ignored. If a service cannot run under its new account, the
   error says so and the previous working state comes back.

### 2.3 Documentation: SOURCE FIX

`windows/docs/TROUBLESHOOTING_GUIDE.md` and `ADMINISTRATOR_GUIDE.md` (both shipped inside the installer)
now cover:

- the `refresh` error, and exit codes 70 and 71;
- "did not stop … Nothing was changed";
- `services verify` and `repair-permissions`;
- access-denied symptoms;
- a table of the services, their accounts and what each may write.

## 3. Test results

### 3.1 AUTOMATED (this PC, 13 Nov 2026)

| Suite | Result | What it proves |
|---|---|---|
| `tests.test_winsw_compat` (new) | **22/22 pass** | See the list below this table. |
| `tests.test_service_account_acl` (new) | **10/10 pass** | See the list below this table. |
| All earlier Windows suites, run together with the two new ones (`test_runtime`, `test_upgrade_stop`, `test_config_permissions`, `test_initdb_permissions`, `test_installer_nsh`, `test_install_resume`, `test_payload_guard`, `test_placeholder_urls`, `test_coexistence`) | **135/135 pass** | Three existing tests had to be updated for the new design (the ignored `<serviceaccount>` element, the old NETWORK SERVICE policy, a machine-dependent `install` assertion). One of them exposed a real defect, now fixed: a dry run wrote files. |
| E2E `test_backup_update_e2e` + `test_upgrade_stop` (`GTRADE_E2E=1`, staged build, disposable PostgreSQL 17) | **26/26 pass** | Real backup, verify, restore, migrate, update, failed-migration rollback, unhealthy-version rollback, early-failure restart. **New assertions:** success moves the services to the hardened accounts and drops the legacy grants; every failure path restores the recorded previous accounts. |
| `apps.common.tests_query_scaling` (PostgreSQL 17) | **pass** | No N+1 on 10 screens: the query count is identical at 3 and 9 rows. |
| `apps.common.tests_perf_benchmark` (new, opt-in) | **ran** | Timings in section 6. |
| Read-only `services.verify_all` against **this PC's live services** | 9 defects found | All match the defect table in section 1, which shows the parsers read real `sc` output correctly. |

`test_winsw_compat` proves, against the **real pinned WinSW 2.12.0 binary** (SHA-256 checked):

- The binary parses our generated App and Web XML.
- Every verb we send is in its own `help` list, and `refresh` is not.
- Unsupported verbs are refused.
- No source file uses another verb.
- The service SID formula matches `sc showsid`.
- The update path issues `sc config` / `failure` / `failureflag` and nothing else. It never reinstalls, deletes or refreshes.
- A running DB is stopped through SCM before its account changes. A DB that will not stop is left unchanged.
- A setting SCM silently ignores is reported as an error.
- Rollback restores the previous accounts.

`test_service_account_acl` applies the real policy with the real `icacls` to a scratch data root and reads it back as SDDL, checking by SID:

- secrets readable by the App only;
- `ca.key` closed to every service;
- Web gets exactly its 5 files;
- `pgsql` for the DB only;
- Program Files read-only for the services;
- no Everyone, and Users on `client\` only;
- NETWORK SERVICE kept on the database folders only until verified, then removed;
- re-applying the policy is idempotent.

### 3.2 REAL-WORLD

| Test | Status |
|---|---|
| Elevated self-test of real services under virtual accounts (`tests\elevated_service_selftest.py`) | **NOT VERIFIED**. Needs an Administrator prompt (section 4, step 1). |
| Upgrade of this PC's installation | **NOT DONE**. Waiting for your approval. |
| Full Windows shutdown and restart | **NOT VERIFIED** |
| Clean Windows 10/11 PC or VM | **NOT VERIFIED**. No clean machine available. |
| Two-PC LAN | **NOT VERIFIED**. No second PC available. |
| Code signing, SmartScreen | Not done (no certificate). |

## 4. Your PC: the approval request

**Current state, read-only checks at about 20:15:**

- GTrade-DB is RUNNING (NETWORK SERVICE), and the database is intact.
- GTrade-App and GTrade-Web are STOPPED (LocalSystem, delayed).
- `rollback\app-1.0.0` holds the last good code. The installer keeps it, because `verified-build` is absent and does not match the installed build.
- 51 GB is free on C:.
- Nothing has been changed on this PC in this session.

**Step 1: elevated self-test (disposable).** In an **Administrator** PowerShell:

```
cd "D:\G OPTICALS\windows"
.\out\venv-candidate\Scripts\python.exe -m tests.elevated_service_selftest
```

What it does:

- Creates throw-away services `GTradeST-App/Web/DB-<random>` and a folder `C:\ProgramData\GTradeSelfTest-<random>`.
- Runs PostgreSQL on a free port that is never 5544.
- Checks real access as each service account (about 40 checks).
- Crashes its own probe once to prove SCM restarts it.
- Removes everything at the end.

It refuses any GTrade-DB/App/Web name and never stops a process it did not start. The result is written to `windows\out\selftest\elevated-selftest-<time>.json`. **Continue only if it ends "N/N checks passed; cleaned up: True".**

**Step 2: extra safety copy (recommended).** In the same Administrator prompt:

```
cd "C:\Program Files\G-TRADE\resources\server"
gtrade-ctl backup run
gtrade-ctl backup offsite --name <name printed above> --target E:\G-OPTICALS-Backups
```

Use a USB disk or another drive as the target. The update also takes its own verified pre-update backup and stops if that backup fails.

**Step 3: upgrade.**

1. Check the hash: `Get-FileHash "D:\G OPTICALS\windows\out\installer\G-OPTICALS-Setup-1.0.0.exe"` must equal `2A713CC2…AD74`.
2. Right-click the installer → *Run as administrator*.

What it will do:

1. Stop the services through SCM. If PostgreSQL does not stop, it aborts before copying any file.
2. Replace the program files and keep `rollback\app-1.0.0`.
3. Run `update apply`:
   - Re-create the wrappers.
   - Apply the account ACLs.
   - Move the services to `NT SERVICE\GTrade-*` and set non-delayed start and recovery.
   - Start PostgreSQL and run `SELECT 1`.
   - Take a verified backup.
   - Migrate (the pending 0012).
   - Start App and Web.
   - Pass the HTTPS health gate.
   - Remove the old NETWORK SERVICE grants.

If any step fails, the previous code, accounts and (after the backup) database come back and are health-checked: error 70. Error 71 means it could not prove that; the report and logs say why.

**Step 4: after-checks.** Run `gtrade-ctl services verify` and expect `"ok": true`. Run `gtrade-ctl health`. Open the desktop app, log in, and confirm that products, customers, purchases, invoices and stock are as before.

Send me the self-test JSON and `logs\update\update-<time>.jsonl` and I will check them.

## 5. Procedures prepared but NOT VERIFIED

These are prepared, not done. Each verdict stays NO-GO until the procedure is carried out.

**Windows restart test (after step 4):**

1. Note 3 products, 3 customers, the last invoice number and one stock figure.
2. Use *Start → Shut down*. Do not use Restart; Fast Startup should not hide a real cold boot. Power on.
3. Do not touch anything for 3 minutes, then check:
   - `Get-Service GTrade-*`: all three Running.
   - `gtrade-ctl services verify`: ok.
   - `gtrade-ctl health`: ok.
   - `logs\db\postgresql-*.log` contains no "not properly shut down".
4. Log in and compare the noted data.

**Clean customer PC** (Windows 10 22H2+ or 11, x64, 8 GB RAM or more, never had G OPTICALS): follow
`G_OPTICALS_CUSTOMER_INSTALLATION_GUIDE.md`, steps 1–23 of your brief. In addition, run
`gtrade-ctl services verify` after setup and again after a cold restart.

**Two-PC LAN:**

- Server: setup → *LAN Server*. Set the network profile to Private and keep the connection sheet.
- Workstation: setup → *LAN Workstation* with the server address and pairing code.
- Verify:
  - login;
  - product, customer, purchase and sale created on the workstation are visible on the server;
  - two users working at the same time;
  - pull the network cable for 60 s, then reconnect;
  - restart the server and confirm the workstation reconnects;
  - from the workstation, `Test-NetConnection <server> -Port 5544` must FAIL (PostgreSQL is loopback-only) and port 8443 must succeed.

## 6. Performance (AUTOMATED, measured)

Measured with `apps.common.tests_perf_benchmark` on PostgreSQL 17 on this development PC, using the Django
test client, so there is no network and no nginx. Values are the median of 5 warm requests.

The shop was seeded through the real APIs with 30 full cycles (product, customer, supplier, purchase and
sale each), then grown by 5,000 products and 3,000 customers.

| Screen | Small shop | +5,000 products / +3,000 customers |
|---|---|---|
| Dashboard | 18 ms | 23 ms |
| **Products list** | 22 ms (31 KB) | **2,399 ms (5.4 MB)** |
| **Product search** | 27 ms | **2,461 ms** (the search matched all rows) |
| Customers | 8 ms | 12 ms |
| Suppliers | 10 ms | 8 ms |
| Purchases | 30 ms | 29 ms |
| Sales | 36 ms | 33 ms |
| Sales report | 32 ms | 28 ms |
| Stock overview | 38 ms | 52 ms |
| Login | 723 ms | (password hashing cost, by design) |
| One full API cycle (5 creates incl. accounting) | 0.24 s | |

**Finding:** without `?page=`, `/api/products/items/` deliberately returns the **whole catalogue**. The
product pickers in 18 frontend places load everything for instant offline search. Cost grows linearly:
about 0.5 ms per product on the server, plus transfer and rendering in the desktop app.

- Below about 2,000 products this is under 1 s.
- At 5,000 products it is about 2.5 s for each full load.

Fixing it needs server-side search in the pickers (New Sale, POS, Purchase Entry, Inventory). That
changes the billing and stock screens, so it was **not** changed in this release pass. It is the top
performance item for the next release.

**What was not measured:** Electron start-up, memory under a long session, concurrent users over a
LAN, and timings on a customer's hardware.

No query counts grow with data (query-scaling test). No financial, stock, accounting or tenant code
was changed in this pass.

## 7. Limitations that remain

- **Unsigned installer:** SmartScreen will warn. A code-signing certificate is an owner purchase.
- **Operator ACE:** the Windows account that ran setup keeps one Modify entry on `pgsql\data` and
  `logs\db`. It is required because PostgreSQL runs initdb with a restricted token (see
  `G_OPTICALS_POSTGRESQL_INITDB_PERMISSION_FIX_REPORT.md`). That account is an administrator anyway.
- **Shared wrapper log folder:** Web may write `logs\services`, which it shares with the App wrapper
  logs. It cannot read secrets or the database.
- **Web service file grants:** if an administrator re-creates nginx's TLS files by hand, the Web
  service cannot read them until `gtrade-ctl repair-permissions` runs (`repair` and every update do
  this automatically).

## 8. Files changed in this pass (uncommitted)

- `windows/gtrade_ctl/services.py`: rewritten. WinSW 2.12 command set, SCM configuration and
  verification, virtual accounts, graceful stop.
- `windows/gtrade_ctl/winacl.py`: per-service policy, `apply_service_access`, `drop_legacy_grants`.
- `windows/gtrade_ctl/update.py`: account snapshot and restore on every path, `finalize-accounts` step.
- `windows/gtrade_ctl/update_cmds.py`: manual rollback restores the recorded accounts.
- `windows/gtrade_ctl/installer_cmds.py`: repair falls back to the previous accounts; legacy grants
  dropped after a healthy install.
- `windows/gtrade_ctl/cli.py`: `services verify`.
- `windows/gtrade_ctl/diagnostics.py`: service configuration added to the support bundle.
- `windows/tests/test_winsw_compat.py`, `windows/tests/test_service_account_acl.py`,
  `windows/tests/elevated_service_selftest.py`: new.
- `windows/tests/test_backup_update_e2e.py`, `test_runtime.py`, `test_config_permissions.py`: updated.
- `windows/tests/run_local_django_tests.py`: passes only the `GTRADE_PERF*` switches through.
- `backend/apps/common/tests_perf_benchmark.py`: new, opt-in.
- `windows/docs/TROUBLESHOOTING_GUIDE.md`, `ADMINISTRATOR_GUIDE.md`: updated.
