# G OPTICALS Windows Installer: Final Report

**Date:** 2026-11-12
**Installer:** `windows\out\installer\G-OPTICALS-Setup-1.0.0.exe`
**Verdict:** **GO** for the next installation attempt on this PC, subject to the conditions in §8. Installation has **not** been run. It waits for your approval.

---

## 1. Summary

| Item | Result |
|---|---|
| Root cause of "error 2" | **Confirmed.** `installer.nsh` used `$COMMONPROGRAMDATA`, which is not an NSIS constant. |
| Fix | NSIS default data folder now comes from `%ProgramData%`. gtrade-ctl refuses relative or unexpanded paths before it writes anything. |
| Regression tests | 15 new installer tests plus 4 desktop and 4 frontend branding tests. They fail on the old script and pass on the fix. |
| Re-run after the partial failure | Verified. The full wizard (mode, server settings, company + administrator) is shown again. |
| Branding | Customer-facing names are **G OPTICALS**. Install and upgrade identifiers are unchanged. |
| Tests | Windows 87/87 with e2e (0 skipped) + 3 runtime harness. Desktop 16/16. Frontend 202/202. Backend: licensing 21/21 (`settings_local`); full cloud suite 1,117/1,119, with 2 unrelated failures (one flaky, one a midnight timezone test). See §6. |
| Security | Payload guard OK on stage, `win-unpacked` and the extracted `.exe`. No `.env` files. Defender: no threats. |
| SHA-256 | `E4B776C575E49EC3D5518E35D59D9E54E3674399D3FA8EC6F4249F4131271BA5` |
| Size | 205,884,867 bytes (196.35 MB). Built 2026-11-12 23:33:22. Not code-signed. |

---

## 2. Task 1: Error 2 root cause

### Evidence

The failed run did write its install log, but into the wrong place:

```
C:\Program Files\G-TRADE\$COMMONPROGRAMDATA\G-TRADE\
    config\gtrade.env, install.json, install.mode, install.version
    logs\install\install-20261112-224752.jsonl
```

The last line of that log:

```
{"step": "prepare-data", "status": "failed",
 "error": "ValueError: The data folder cannot be inside Program Files.", "ts": "2026-11-12T22:47:54+0530"}
```

`install.json` recorded `"data_root": "$COMMONPROGRAMDATA\\G-TRADE"`. Preflight had passed: admin, x64, build 26200, 7.2 GB RAM, 51.6 GB free, no busy ports.

The SHA-256 of the installer that failed (`G-TRADE-Setup-1.0.0.exe`) is `A92A8EBC…`. That is the RC from the previous readiness report.

Windows event logs (Application and System, 22:40–22:55) show nothing from the installer. The only services installed in that window were Microsoft Defender drivers (`WdAiNisDrv`, `KslD`) from a Defender update. No G-TRADE or G OPTICALS service exists.

Copies of the log and the secret-free config files are kept in `windows\out\evidence\error2-20261112\`. The originals were **not** moved or deleted.

### Chain of failure

1. `installer.nsh` had `!define GT_DATA_DEFAULT "$COMMONPROGRAMDATA\G-TRADE"`. NSIS has no `$COMMONPROGRAMDATA` constant. makensis keeps unknown `$NAME` text literally and only prints a warning:
   ```
   warning 6000: unknown variable/constant "COMMONPROGRAMDATA\G-TRADE" detected, ignoring (macro:gtReadMode:2)
   ```
   electron-builder does not show makensis warnings, and `warningsAsErrors` is false, so every build passed.
2. The wizard passed `--data-root "$COMMONPROGRAMDATA\G-TRADE"` to gtrade-ctl. That is a **relative** path, so Python resolved it against the installer's working directory, `C:\Program Files\G-TRADE`.
3. The `configure` step wrote config files and the step log there, before any path check.
4. The `prepare-data` step's Program Files guard rejected the folder. `ValueError` maps to `EXIT['config'] = 2`, which produced the "error 2" message box.
5. The message box pointed to `$GtDataRoot\logs\install`. That expanded to the same literal relative text, so `C:\ProgramData\G-TRADE\logs\install` was never created.

The bug was never caught because every automated install test passes an explicit `/DATA=` or `--data-root`. Nothing exercised the wizard's default value.

### Fix

| Layer | Change |
|---|---|
| `windows/installer/installer.nsh` | New `gtDefaultDataRoot` macro: `ReadEnvStr ProgramData` plus `\G-TRADE`, falling back to `$APPDATA` in all-users context. The data-folder page now refuses a path that is not `X:\…` or `\\server\…`. Removed a dead `StrCpy`. |
| `windows/gtrade_ctl/paths.py` | New `check_root_path()`. It refuses relative paths and unexpanded `$NAME`, `${NAME}`, `$(NAME)` and `%NAME%` tokens. Admin shares such as `\\srv\D$\…` are still allowed. Called from `validate_data_root()`. |
| `windows/gtrade_ctl/cli.py` | `_layout()` checks both roots for every command, so a bad root exits 2 with a clear message before any file is written. |
| `windows/gtrade_ctl/installer_cmds.py` | `install` validates the data root **before** creating the step log or running `configure`. A refused folder now gets no files at all. |

The data folder **name** `G-TRADE` is unchanged. It is an internal identifier, kept so existing data and upgrades stay compatible.

### Regression tests (`windows/tests/test_installer_nsh.py`, 15 tests)

| Group | What it proves |
|---|---|
| Static (4) | No `$COMMONPROGRAMDATA`. Every `$token` in `installer.nsh` is a declared `Var`, a register or a real NSIS constant. The default comes from `ProgramData`. The data page rejects relative paths. |
| Compile (2) | The include compiles with **`makensis /WX`** (warnings are errors) as both installer and uninstaller. Only 6001 "unused variable" is allowed. |
| Runtime harness (3) | A tiny compiled NSIS program (not the installer) runs the **real** `customInit`/`gtReadMode` with `%ProgramData%` pointed at a scratch folder. **Fresh:** absolute `<ProgramData>\G-TRADE`, `upgrade=0`. **Partial install** (`install.mode` without `install.complete`): `upgrade=0`, so the full wizard is shown. **Completed install:** `upgrade=1`. |
| gtrade-ctl (6) | Bad roots are refused and good roots accepted. Program Files is still refused. The **exact failed command line** run from a scratch "Program Files" exits 2 and creates **nothing**. A data root inside the program folder is refused before any write. |

**Proof the tests catch the bug.** Against a copy of the old include, 4 static/compile tests fail and the runtime harness cannot even compile, all with makensis warning 6000. All 15 pass on the fix.

---

## 3. Re-running setup after the partial failure

What is on this PC now:

- the uninstall entry "G-TRADE ERP" (GUID `7d0f5a52-…`);
- the program files in `C:\Program Files\G-TRADE`, including the stray `$COMMONPROGRAMDATA` folder;
- **nothing** in `C:\ProgramData\G-TRADE`.

No database, secrets, services or firewall rule were created: the failure came before the secrets step.

What the new installer does:

1. **`customInit`** looks for `C:\ProgramData\G-TRADE\config\install.mode`. It isn't there, so the run is treated as a **new install**, and the mode, server settings and **company + administrator** pages are all shown. The runtime harness test proves this.
2. **electron-builder** finds the old uninstall entry and silently runs the old uninstaller with `--updated`. Our `customUnInstall` skips gtrade-ctl when `--updated` is set, so no services or data are touched. electron-builder then **moves aside and removes the old program files in `C:\Program Files\G-TRADE`**. That includes the stray `$COMMONPROGRAMDATA` folder. This is electron-builder's normal upgrade step, not something I did. The evidence copy in `windows\out\evidence\error2-20261112\` survives it.
3. Files are installed into the same folder, and gtrade-ctl creates `C:\ProgramData\G-TRADE`.
4. If a **later** step fails, the run is resumable. The existing `test_install_resume.py` tests (now part of the 87) prove the wizard shows the company and administrator pages again until `install.complete` exists.

The old desktop/Start-menu shortcuts named "G-TRADE ERP" are replaced by "G OPTICALS". electron-builder migrates them by the stored shortcut name.

---

## 4. Task 2: G OPTICALS branding

### Changed (customer-facing)

| Surface | Where | Now |
|---|---|---|
| Installer title, welcome and finish pages | `package.json` `productName` (NSIS `$(^Name)`) | G OPTICALS |
| Installer file | `nsis.artifactName` | `G-OPTICALS-Setup-1.0.0.exe` |
| Installer and app version info | `productName`, `description`, `author`, `copyright` | ProductName / Company **G OPTICALS** (checked on the built `.exe`) |
| Desktop and Start Menu shortcut | `nsis.shortcutName` | G OPTICALS |
| Installed-apps display name | `nsis.uninstallDisplayName` | G OPTICALS |
| Wizard pages, progress lines, error and uninstall messages | `installer.nsh` | "G OPTICALS …" |
| EULA heading and summary | `installer/EULA.txt` | G OPTICALS (still a draft placeholder) |
| Electron app name, window title, About dialog | `desktop/lib/brand.js` → `main.js` | G OPTICALS, "About G OPTICALS" + version |
| Connect and offline pages | `desktop/pages/*.html` | G OPTICALS |
| Connection sheet text | `gtrade_ctl/installer_cmds.py` | "G OPTICALS - workstation connection sheet" |
| Login screen, sidebar/dashboard wordmark, 2FA prompt | `frontend/src/utils/brand.js` | G OPTICALS (**Windows build only**) |
| Browser tab title, app-name meta tags | `vite.config.js` local-edition HTML transform | `<title>G OPTICALS</title>` (verified inside the built `.exe`) |

**Logo.** There is no separate G OPTICALS logo file in the repository: no PNG, ICO or SVG logo asset. The only official mark is the green eye emblem used by `GreensolLogo` and the favicon. It is **reused unchanged**; only the wordmark text changes. **No new logo was created.**

**Cloud is unchanged.** A cloud build (to scratch, not `dist/`) still shows "GreenSol Optical ERP" and GREENSOL. Branding switches only when `VITE_EDITION=local`.

### Deliberately unchanged (internal identifiers kept for install and upgrade compatibility)

| Identifier | Value | Why it stays |
|---|---|---|
| appId / AppUserModelID | `com.gtrade.erp` | Taskbar identity and upgrade detection |
| NSIS GUID / uninstall key | `7d0f5a52-6a0e-4c63-9b3e-0b8f6b4e2c11` | Upgrade finds the existing install |
| Executable / install folder / uninstaller | `G-TRADE.exe`, `C:\Program Files\G-TRADE`, `Uninstall G-TRADE.exe` | Set by `executableName`. Renaming it would create a second install folder |
| Data folder | `C:\ProgramData\G-TRADE` | Customer data location |
| Electron userData | `%APPDATA%\G-TRADE ERP` (pinned in `main.js`) | Holds the workstation's saved server connection and pinned CA, which would otherwise be lost |
| Windows services, firewall rule, cert O= | `G-TRADE ERP Application/Web`, `G-TRADE ERP HTTPS (LAN)` | Changing these would orphan existing rules and services. You asked not to touch services |
| `gtrade_ctl`, `gtrade_server`, DB `gtrade`, `GTRADE_*` env vars, User-Agent `G-TRADE-Desktop` | — | Internal |

---

## 5. Build and payload verification

| Check | Result |
|---|---|
| `build_frontend.py` (local SPA) | OK. Tab title is G OPTICALS. No external hosts in the bundle. |
| `build_runtime.py` (stage) | OK. `payload_guard`: 4 secret values checked, none found. |
| `electron-builder --win nsis` | OK, exit 0 (log: `windows\out\installer_brand_build.log`) |
| `payload_guard` on `win-unpacked` | **OK** (0 forbidden files) |
| `.exe` extracted with 7-Zip (`app-64.7z`) | 10,645 files, the same count as `win-unpacked`. `payload_guard` **OK**. **0** `.env*` files. |
| Fix present in the shipped payload | `check_root_path` and the pre-log validation are both in `resources\server\app\1.0.0\windows\gtrade_ctl` |
| Branding present in the shipped payload | `app.asar` has `productName` G OPTICALS, `lib/brand.js`, the About dialog and the userData pin. Connect and offline pages say G OPTICALS. SPA title is G OPTICALS. |
| Microsoft Defender (`MpCmdRun -Scan -ScanType 3`, no remediation) | **No threats found** |
| Authenticode | **Not signed** (signing is an open owner decision, as before) |

---

## 6. Test results

| Suite | Result |
|---|---|
| `windows/tests` with `GTRADE_E2E=1` (install e2e, desktop smoke, backup/update e2e, Postgres, runtime, coexistence, payload guard, placeholder URLs, install resume, new installer tests) | **87 / 87 OK, 0 skipped** (701 s, on the restaged app). Log: `windows\out\brand_fix_full_e2e.log` |
| New runtime-harness tests (added after that run started) | **3 / 3 OK**. `test_installer_nsh` total **15 / 15 OK** |
| Desktop `npm test` | **16 / 16 OK** (4 new branding/compatibility tests) |
| Frontend `test:*` (23 suites, including new `test:brand`) | **202 / 202 OK** |
| Backend: Windows-edition suite (`apps.licensing`) under `config.settings_local`, disposable PG17 | **21 / 21 OK** |
| Backend: full suite under cloud `config.settings`, disposable PG17 (`DATABASE_URL` → throwaway cluster; dev DB, Neon and Render untouched) | **1,117 / 1,119 OK**, 1 skipped, **2 failures, both unrelated to this work** (see below). Log: `windows\out\full_suite_cloud_brand_fix.log` |

**The 2 backend failures.** No backend code was changed in this work.

- `purchasing.test_save_perf.test_query_count_does_not_grow_with_lines` (71 vs 72 queries): **passes when re-run on its own**. It is order-dependent cache warm-up, so it is flaky, not a defect.
- `financial.test_daybook.DayBookFilterTests.test_dates`: **fails every night between 00:00 and 05:30 IST**. The run crossed midnight. The test compares the PC's local date (`2026-11-13`) with the server's UTC "today" (`2026-11-12`). It is a test-side timezone bug in the uncommitted Day Book work. It does not affect the installer. Re-run it after 05:30 IST, or fix it to use `timezone.localdate()`.

**Why the full suite is not run under `settings_local`.** I tried it: 303 errors and 1 failure, all by design. The Windows build allows **one organization per installation** (`LocalEditionGuardError`), and the cloud suite's multi-tenant tests create several. The health test also compares the database name with `EXPECTED_DATABASE_NAME`, which Django's `test_` prefix changes. The earlier "1,119 OK" baseline was a cloud-settings run, which is the configuration repeated above. Log: `windows\out\full_suite_brand_fix.log`.
| Cloud frontend build (to scratch) | OK. Branding unchanged. |
| ESLint | Not run: the repo's ESLint config is the legacy format and the installed ESLint needs a flat config (pre-existing). The Vite builds compile every changed file. |

Every test used scratch folders, scratch ports (18443/18001/15544) and disposable clusters. **Not touched:** PostgreSQL 17 (:5432), PostgreSQL 18 (:9961), MySQL, pgAgent, the G OPTICALS development database, Neon, Render and Vercel. `elevated_smoke.ps1` was **not** run, because it stops every Python process. Nothing was installed, committed, pushed or deployed.

---

## 7. Files changed

- `windows/installer/installer.nsh`: data-root fix, path validation, branding text
- `windows/installer/EULA.txt`: branding
- `windows/gtrade_ctl/paths.py`, `cli.py`, `installer_cmds.py`: root-path guard, validate-before-write, connection-sheet text
- `windows/desktop/package.json`: display names and artifact name
- `windows/desktop/lib/brand.js` (new), `main.js`, `lib/connection.js`, `lib/security.js`, `pages/connect.html`, `pages/offline.html`
- `windows/tests/test_installer_nsh.py` (new), `windows/desktop/test/brand.test.js` (new)
- `frontend/src/utils/brand.js` (new), `frontend/src/utils/__tests__/brand.test.js` (new), `frontend/src/pages/Login.jsx`, `frontend/src/components/GreensolLogo.jsx`, `frontend/src/components/security/TwoFactorLoginStep.jsx`, `frontend/vite.config.js`, `frontend/package.json` (`test:brand` script)

---

## 8. GO / NO-GO

### **GO.** Use `G-OPTICALS-Setup-1.0.0.exe` (SHA-256 `E4B776C5…71BA5`) for the next attempt, once you approve.

Conditions and notes:

1. **Use only the new file.** The defective `G-TRADE-Setup-1.0.0.exe` (`A92A8EBC…`) is still in `windows\out\installer\`. I did not delete it. **Do not run it.**
2. **RAM.** As in the previous report, install after a restart, with at least 2 GB available. Preflight warned "less than 8 GB".
3. **Expect** that setup removes the old program files, including the stray `$COMMONPROGRAMDATA` folder, during its normal upgrade step. The evidence copy is kept.
4. In the wizard, the data folder should show **`C:\ProgramData\G-TRADE`**. If it shows anything else, cancel.
5. **Still open, unchanged by this work:** the installer is unsigned (SmartScreen will warn), the EULA is a draft placeholder, and there is no G OPTICALS `.ico`. Shortcuts and the installer use the default Electron icon, because no official icon asset exists and a new logo was not to be invented. Some in-app pages, which were not on the requested list, still use Greensol text in both editions: the WhatsApp receipt, the prescription card footer, the Eye Examination header and the Appointments print.

Waiting for your approval before any installation.
