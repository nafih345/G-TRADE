# Elevated self-test: clean-shutdown check + program-files write access (2026-11-13)

Source report: `windows\out\selftest\elevated-selftest-20261113-220236.json` (2 failed checks).

## 1. "db: graceful stop = clean shutdown checkpoint" — false negative in the test, and the old check was also unsound

**What happened.** The shutdown was clean. The log shows the shutdown checkpoint completing. The restart that followed logged
`database system was shut down at 22:01:56`, which comes from pg_control and means no crash recovery was needed.
The assertion required the line `database system is shut down` to be in the log right after SCM reported STOPPED.

**Why that line is unreliable (PostgreSQL 17 source and observed behaviour):**
- `UnlinkLockFiles` logs it as the postmaster's very last act, after `postmaster.pid` is removed. With
  `logging_collector = on`, it reaches the file only through the syslogger child, which is never signalled. The
  syslogger drains its pipe after the postmaster has already exited.
- `pg_ctl runservice` reports SERVICE_STOPPED as soon as the postmaster handle signals. It also reports STOPPED
  after its own 12 × 5 s wait when the postmaster did **not** exit. So SCM STOPPED proves nothing on its own.
- Live evidence on this PC: the `GTrade-DB` log at 17:25:08 shows a clean shutdown checkpoint, and the next start
  says "was shut down at 17:25:08". The final line is absent.
- The line is also logged after an **immediate** shutdown, which skips the checkpoint and needs crash recovery.
  This is proven by `test_immediate_stop_is_not_clean_although_it_logs_the_old_success_line`. The old check
  would therefore have passed a dirty stop.
- `checkpoint starting: shutdown immediate` is normal. Every shutdown checkpoint logs its flags
  (CHECKPOINT_IS_SHUTDOWN | CHECKPOINT_IMMEDIATE) that way. It does not mean "immediate shutdown mode".

**Fix.** `pg.assess_shutdown` / `PgRuntime.shutdown_report` (in `windows\gtrade_ctl\pg.py`) judge a stop clean
only when **all** of the following hold:
- pg_control reports `shut down` (via `pg_controldata`);
- `postmaster.pid` has been removed;
- no process of *this* cluster is still alive. Processes are matched by postmaster PID and its children through
  a Toolhelp snapshot, never by name alone. The check waits for the syslogger to drain before reading the log;
- the SCM exit code is 0 (`services.query_exit_codes`);
- the log since the stop shows no unclean markers (immediate request, terminated/PANIC, non-zero child exit).

The final log line is recorded as `final_line_logged` but is not used as proof.

**Self-test changes:**
- Per-file log offsets replace slicing a concatenation of every `*.log`.
- The restart must log `was shut down at` with no redo.
- Negative control: the disposable service's own postmaster is force-killed. The stop must be judged NOT clean,
  and the next start must run crash recovery.
- A second clean stop is checked afterwards.

## 2. "app: write program files -> denied" got "ok" — real defect

**Root cause.** The install root (`$INSTDIR\resources\server`: Python, PostgreSQL, nginx, WinSW wrappers, app
code) only ever received **additive** Read & execute grants for the service SIDs. Otherwise it inherited its
parent's ACL. Every service token (virtual account) contains BUILTIN\Users and Authenticated Users.
- In the self-test, the root sits under `C:\ProgramData`, which grants `BUILTIN\Users:(CI)(WD,AD,WEA,WA)`.
  So every service, and any local user, could create files there.
- The wizard allows a custom install folder (`allowToChangeInstallationDirectory: true`). A folder on D:\
  inherits `Authenticated Users: Modify`, which allows replacing `postgres.exe`, `python.exe` and the WinSW
  wrappers that run as services.
- A read-only scan of the staged tree on D:\ found 17,379 writable entries.
- The default location is not affected. A read-only scan of the live `C:\Program Files\G-TRADE\resources\server`
  on this PC found no effective non-admin write access; the only entries flagged were inherit-only CREATOR OWNER.

**Fix (in `windows\gtrade_ctl\winacl.py`).** `protect_install_root` gives the install root its own protected ACL:
- SYSTEM and Administrators: Full control;
- Users, ALL APPLICATION PACKAGES, ALL RESTRICTED APPLICATION PACKAGES and each service SID: Read & execute;
- nothing else. Explicit Everyone, Authenticated Users, Interactive and CREATOR OWNER entries are removed.

It then:
- repairs any explicit write grant found below the root;
- requires `write_exposure` (a full-tree scan by SID) to come back empty. Inherit-only entries are ignored.
  Folders that cannot be listed are **reported**, not skipped.

`apply_data_root_policy` and `apply_service_access` call it during prepare-data, repair-permissions and update.
Data-root writes (media, logs, backups, run, temp) are unchanged; a regression test asserts this. Runtime writes
into program files were already disabled (`PYTHONDONTWRITEBYTECODE`; the nginx prefix is in the data root).

**Self-test changes:**
- Static checks: the root's ACL is protected; no broad or per-user entries; zero write exposure across the
  whole tree; each service has RX.
- As both App and Web, the test attempts: create, modify, delete, mkdir, plant a DLL in `runtime\pgsql\bin`,
  replace `postgres.exe`, and plant into `services\`. Every attempt must be denied.

## Regression tests (non-elevated, real Windows mechanisms, no services)
- `windows\tests\test_clean_shutdown.py` (7 tests): replays the 22:02 log; checks the evidence matrix and
  `sc query` parsing; uses real disposable PG17 clusters for fast stop (clean even without the final line),
  immediate stop (unclean despite the final line) and a killed postmaster (unclean, followed by crash recovery).
- `windows\tests\test_program_files_acl.py` (5 tests): uses real ACLs that copy ProgramData and a drive root,
  and makes real write attempts with this process's token. It covers the defect reproduction, the fix, repair
  of explicit grants, the policy entry point and the scanner's edge cases.

## Results
- Windows suite, standard pass: 197 tests OK (32 e2e skipped).
- After restaging, full suite with `GTRADE_E2E=1`: **198 tests OK, 0 skipped**.
  - An earlier e2e pass had one failure, `test_desktop_install_e2e.test_03_rogue_ca_is_refused`
    ("no smoke output" from Electron). That module does not touch this code, and it passed on the rerun.
- Elevated self-test: **pending** (run by the owner, see below).
- Installer: **not rebuilt yet**. It will be rebuilt only after the elevated self-test passes with `cleaned_up=true`.

## Housekeeping
- `C:\ProgramData\GTradeSelfTest-cda504` is left over from an aborted run at 21:35. The self-test now fails
  `cleaned_up` while any `GTradeST-*` service or `GTradeSelfTest-*` folder exists.
- `--remove-stale` removes such folders. It deletes only folders that strictly match the name pattern, and only
  when no `GTradeST-*` service is registered.
