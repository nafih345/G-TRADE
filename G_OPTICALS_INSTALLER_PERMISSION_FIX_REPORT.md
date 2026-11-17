# G OPTICALS — Installer Error 1: Configuration File Permission Fix

**Date:** 2026-11-13  **Verdict:** **GO for a retry with the new installer, after the owner approves.** Nothing has been installed, uninstalled, deleted or committed.

---

## 1. Exact root cause

The bug is in the installer engine, not in Windows and not in the owner's PC.

`windows/gtrade_ctl/winacl.py` → `protect()` hardened each data folder with **one** icacls call:

```
icacls <folder> /inheritance:r /grant:r <SID>:(OI)(CI)F ... /T /C /Q
```

With `/T`, icacls applies the same arguments to every **file** underneath. On a file:

- `/inheritance:r` removes all inherited entries.
- The `(OI)(CI)` grants only describe inheritance to child objects, so they give the file itself nothing.

Each file therefore ends up with an **empty DACL**. Nobody can open it: not SYSTEM, not an elevated Administrator, not the owner. icacls still **exits 0**, so nothing reported a failure. Folders look correct, which is why the defect was hard to see.

**Sequence on the owner's PC:**

| Time | Run | What happened |
|---|---|---|
| 09:27:31 | 1st setup | `configure` wrote `install.json`, `install.mode`, `install.version`, `gtrade.env` → `prepare-data` ran `protect(... /T)` over `C:\ProgramData\G-TRADE`. Every file that existed by then (those config files and this run's own step log) got an empty DACL. The next step that read `install.json` failed. |
| 09:34:52 | 2nd setup | Preflight OK (elevated, 7.2 GB, 46.9 GB free, no busy ports, existing install). `configure` → `install.json.read_text()` → **`PermissionError: [Errno 13]`** after 0.0 s. |

**Why tests didn't catch it:** every test sets `GTRADE_SKIP_ACL=1`, so the ACL code had never run against real files. The elevated VM test (`elevated_smoke.ps1`) is still an outstanding owner action.

**Ruled out:**
- **Different identity:** the log shows `elevated: true` (`IsUserAnAdmin`).
- **Atomic replace:** the failure is the *read* `open()` (single-path `Errno 13`), not `os.replace`, which reports `WinError 5` with two paths.
- **File locking:** a lock wouldn't fail identically and instantly on every retry; the empty DACL was reproduced exactly (§4).

## 2. Actual ACL findings (read-only; my shell was not elevated)

| Path | Finding |
|---|---|
| `C:\ProgramData\G-TRADE` | Owner `BUILTIN\Administrators`. Explicit, protected: SYSTEM F, Administrators F, NETWORK SERVICE RX, **plus `LAPTOP-M79GGMU7\Nafih` F**. No current G-TRADE code adds a per-user entry; it most likely came from an earlier manual or support step. It is left in place and listed here for the owner to decide. |
| `config\`, `run\`, `temp\`, `backups\`, `pgsql\`, `media\`, `static\`, `updates\`, `logs\app` … | Access denied to the non-elevated user. That is expected: the policy deliberately gives normal users nothing here. |
| `config\install.json` | Access denied, even for `Get-Acl`. Its exact ACL can only be read from an elevated prompt. That fits the empty-DACL state, which was reproduced exactly with the same icacls call (§4). |
| `logs\install\install-20261113-092731.jsonl` (1st run) | **Unreadable.** It existed when `protect(/T)` ran, so it has the same empty-DACL damage. This is direct on-disk evidence. |
| `logs\install\install-20261113-093452.jsonl` (2nd run) | Readable. It was created after the damage and inherited a normal ACL. It contains the failure quoted above. |
| Read-only attribute / other owner | Couldn't be checked on `install.json` without elevation. Owner of the root is Administrators, which is what lets the repair work without `takeown`. |

The 09:27 failure is inferred, not read: its log is unreadable. The step order and the 09:34 failure mean the first run failed at the first step after `prepare-data` that read `install.json`. That is `database`, which reads the config before `initdb`. So **no database cluster was most likely ever created**. The engine is safe either way (§5).

## 3. Source files changed

| File | Change |
|---|---|
| `windows/gtrade_ctl/winacl.py` | `protect()` no longer combines `/T` with `/inheritance:r`. It does two things: **(1)** sets the folder's own protected, inheritable ACL (no `/T`); **(2)** `inherit_below()` runs `icacls <child> /inheritance:e /T` on each child. That only **adds** the parent's entries, keeps all explicit ones, and never removes access, so it also repairs files damaged by the old code. Missing folders are skipped. The root pass excludes the separately managed sub-folders. New `access_problem()` gives a clear message: path, elevated or not, "empty ACL" detection, the current ACL, and the fix. The new `client\` folder (server URL + **public** CA only) gets Users **read** so the desktop app, running as a normal user, can find its server. Nowhere gets Everyone, and Users get nothing anywhere else. |
| `windows/gtrade_ctl/install_config.py` | `atomic_write_text()`: unique temp file in the same folder, so it inherits the folder's ACL → `fsync` → `os.replace`. Clears a read-only attribute on our own file. Retries a transient lock (antivirus) 3 times. The temp file is always cleaned up, and the previous file stays intact on failure. Used for `install.json`, `install.mode`, `install.version`, `gtrade.env`. Read and write access errors become `ConfigAccessError` with the clear message instead of a bare `PermissionError`. |
| `windows/gtrade_ctl/installer_cmds.py` | New first install step **`permissions`**: when the data folder already exists, it re-applies the policy **before** `configure` reads anything, then verifies that `install.json`, `gtrade.env` and `secrets.dpapi` open for read/write. If not, it stops with a clear error and changes nothing. `prepare-data` doesn't repeat the policy when nothing new was created. `repair` repairs before reading the config. New command **`gtrade-ctl repair-permissions`** (Administrator only). |
| `windows/gtrade_ctl/cli.py` | `ConfigAccessError` / `PermissionError` → exit code 2 (config) with a JSON error, not a generic failure. |
| `windows/tests/test_config_permissions.py` | New, 19 tests (§4). |

Not touched: `installer.nsh` (its retry path was already correct: no `install.complete` → full wizard → `gtrade-ctl install`), the backend, PostgreSQL 17/18, MySQL, pgAgent, and any G OPTICALS database.

## 4. Tests and results

The new tests use the **real `icacls`**, only on throw-away folders under `%TEMP%`, never ProgramData.

| Requirement | Test(s) |
|---|---|
| Defect reproduced | `test_old_protect_leaves_files_with_empty_dacl`: the old call exits 0; the file has no entries and is unreadable; the folder looks fine. |
| Existing config file with restricted permissions | `test_existing_config_file_with_restricted_permissions_is_repaired`, `test_readonly_config_file_is_still_updated` |
| Config directory with incorrect ACL | `test_config_directory_with_incorrect_acl_is_repaired`; new files inherit |
| Administrator installation | `test_permissions_run_before_configure`, `test_fresh_install_applies_policy_in_prepare_only`, `test_repair_permissions_command_requires_admin`, `test_policy_is_narrow` (no Everyone or Users except read on `client\`; parent folder ACL unchanged) |
| Safe configuration updates | `test_failed_replace_keeps_previous_file_and_leaves_no_temp`, `test_transient_lock_is_retried`, `test_write_produces_complete_json_and_mode_markers`, `test_unrepairable_config_gives_clear_error_not_traceback` |
| Failed installation followed by retry | `test_failed_install_followed_by_retry_with_real_acls`: the owner-PC sequence on real ACLs; old step log kept and made readable. `test_unrepairable_state_stops_with_clear_message`: nothing deleted. |
| Preservation of configuration and database data | `test_retry_preserves_existing_configuration` (same `install_id`, mode, `created_at`; history appended; database, backup and secrets bytes identical), `test_policy_repairs_damaged_install_and_preserves_every_byte`, `test_policy_on_healthy_install_changes_no_content` (run twice, idempotent) |

| Suite | Result | Log |
|---|---|---|
| New permission tests | **19 / 19 OK** | — |
| Windows suite, non-e2e | **112 run, OK** (25 e2e skipped) | — |
| Windows suite with real-stack e2e (`GTRADE_E2E=1`, restaged app) | **112 / 112 OK, 0 skipped** (692 s) | `windows/out/permfix_windows_e2e.log` |
| Desktop security tests (`npm test`) | **16 / 16 pass** | — |
| `makensis /WX` installer compile + `customInit` and requirements harnesses | Included in the Windows suite, OK | — |

Not run: `elevated_smoke.ps1`. It kills every Python process, so it must not run on the dev PC. Full elevated installs on clean VMs are still owner gates.

## 5. Existing data and configuration preservation

- Nothing under `C:\ProgramData\G-TRADE` was changed, deleted or re-permissioned by this work. All inspection was read-only, and the installer was not run.
- On retry, the new engine **reads and keeps** the existing `install.json`: same installation id, mode and creation date, with a `reinstall` entry appended. `secrets.dpapi` is kept (`secrets init` never regenerates existing secrets).
- **Database:** `init-db` runs `initdb` only when `pgsql\data` is absent or empty. An existing cluster is kept and only re-configured. Files that aren't a G-TRADE cluster are refused with "Nothing was changed." Migrating an existing cluster is preceded by a verified backup, as before.
- The repair never runs `takeown`, `icacls /reset`, or anything outside `C:\ProgramData\G-TRADE`. It only adds entries for SYSTEM, Administrators and NETWORK SERVICE, and gives Users read on `client\`.
- Install logs and evidence are kept. The unreadable 09:27 log becomes readable after the repair.

## 6. Is a new installer required?

**Yes.** The fix is in the installer engine (`gtrade_ctl`), which ships inside the setup. **Do not run the old installer again:** each run re-applies the bad ACLs. It has been moved, not deleted, to `windows\out\superseded-installers\SUPERSEDED-DEFECTIVE-G-OPTICALS-Setup-1.0.0-9EBA8BEB.exe.do-not-run`, and `README.txt` there is updated.

## 7. New installer

| Item | Value |
|---|---|
| File | `windows\out\installer\G-OPTICALS-Setup-1.0.0.exe` |
| Size | 205,975,203 bytes |
| **SHA-256** | **`21015170335D17B1D44E91396D2420218FEEEB47B942781E98BA4DFCDD848460`** |
| Build | `electron-builder --win nsis` exit 0 (`windows/out/permfix_installer_build.log`); app restaged (`permfix_stage_app.log`) |
| `payload_guard` on `win-unpacked` | OK: 0 forbidden files, 0 `.env` |
| Shipped fix present | `inherit_below`, the `permissions` step and `atomic_write_text` were all found in `win-unpacked\resources\server\app\1.0.0\windows\gtrade_ctl` |
| Defender (`-ScanType 3 -DisableRemediation`) | No threats |
| Authenticode | NotSigned (unchanged; code signing is still an owner decision) |

## 8. Exact retry instructions (only after owner approval)

1. Make sure the earlier setup window is closed.
2. Optional, gives the full picture first. In an **elevated** PowerShell, read-only:
   `icacls "C:\ProgramData\G-TRADE\config" ; icacls "C:\ProgramData\G-TRADE\config\install.json"`
   Expected: the folder lists SYSTEM, Administrators and NETWORK SERVICE; the file line shows **no entries**. That confirms the diagnosis.
3. Check the hash of the new file. It must be `21015170…848460`:
   `Get-FileHash "D:\G OPTICALS\windows\out\installer\G-OPTICALS-Setup-1.0.0.exe"`
4. Right-click → **Run as administrator**. The wizard shows all pages again because the first install never completed. Choose **the same installation type as before** (Standalone). A different type is refused, because `install.json` records the mode.
5. Expected: the `permissions` step repairs the folder in a few seconds, `configure` succeeds (same installation id), and the install continues. If anything can't be repaired, setup stops with a message naming the file and its ACL, and nothing is deleted.
6. If it fails, don't re-run it repeatedly. Send `C:\ProgramData\G-TRADE\logs\install\` (newest `.jsonl`) for review.

If the owner wants the repair applied without running setup, the same engine command is available. In an elevated prompt:
`"C:\Program Files\G-TRADE\resources\server\runtime\python\python.exe" -m gtrade_ctl --install-root "C:\Program Files\G-TRADE\resources\server" --data-root "C:\ProgramData\G-TRADE" repair-permissions`
This works only after the new installer's files are on disk. It is normally unnecessary, because setup does it automatically.

---

## GO / NO-GO

| Decision | Verdict |
|---|---|
| Fix implemented and tested (unit + real-ACL + full e2e) | **GO** |
| Retry the internal install on the owner's PC with the **new** installer `21015170…848460` | **GO, waiting for owner approval.** Not installed. |
| Re-running the **old** installer `9EBA8BEB…` | **NO-GO**: defective, retired |
| Commercial release | **NO-GO**, unchanged: code signing, EULA, icon, production licence keys, clean-VM elevated and LAN tests |

Nothing was committed, pushed or deployed.
