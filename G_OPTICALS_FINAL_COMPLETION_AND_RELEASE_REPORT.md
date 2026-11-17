# G OPTICALS ERP: Final Completion and Release Report

**Date:** 2026-11-13
**Final installer:** `windows\out\installer\G-OPTICALS-Setup-1.0.0.exe`
**Size:** 205,916,846 bytes (196.38 MB). Built 2026-11-13 09:06:44 IST.
**SHA-256:** `9EBA8BEB7C84C40DB9182AC49583593E454508DA9AE2278C63CEF9B534C4435C`

Nothing was installed, committed, pushed or deployed. Neon, Render, Vercel, the development database and the PC's PostgreSQL 17/18, pgAgent and MySQL services were not touched. Every database test ran on throwaway clusters that were deleted afterwards.

| Verdict | Result |
|---|---|
| **DEVELOPMENT COMPLETION** | **GO**: all in-repository work that can be done without owner decisions is done, and every automated suite passes (§5). |
| **INTERNAL WINDOWS INSTALLATION** | **GO**, on your approval and with the conditions in §11. |
| **COMMERCIAL CUSTOMER RELEASE** | **NO-GO**: blocked only by external items (code signing, legal text and publisher identity, production licence keys, clean-VM and two-PC LAN tests, product icon). See §13. |

---

## 1. Audit: scope and method

This session built on the audits and work of Phases 1–9 (`MASTER_IMPLEMENTATION_STATUS.md`, `G_OPTICALS_WINDOWS_INSTALLER_FINAL_REPORT.md`). Their open items were re-checked, and then:

| Area | How it was checked |
|---|---|
| Whole backend (Django/DRF, PostgreSQL, multi-tenancy, multi-company, branches, inventory, purchase, sales/POS, accounting, cashbook, customers/suppliers, optical, barcodes, reports, backups, licensing) | Full suite of 1,119 tests on a disposable PG17 cluster. The test list was diffed against the previous run, which caught 2 tests that had silently dropped out (§2, item 7). |
| Frontend (React) | 25 unit suites; production builds for both editions; source scan for vendor or sample identities on customer documents |
| Desktop (Electron), installer (NSIS), engine (gtrade-ctl), LAN pairing, backup/update/rollback | Full Windows suite with real-stack end-to-end tests: Electron with pinned TLS, workstation pairing, backup, update and rollback |
| Branding | Every "Greensol" string in `frontend/src`, `backend` and `windows`, sorted into customer-facing vs internal |
| Security | Secret scan of tracked and untracked files; Windows-edition settings review; payload guard; Defender |
| Installer flow vs. the requested features | Read `installer.nsh` page by page (§3) |

**Limit of this audit:** module code was not reviewed line by line beyond what the test suites and these targeted checks cover. ESLint was not run: the repo's legacy config is incompatible with the installed ESLint, which was already the case before this work.

## 2. Fixes implemented in this session

| # | Defect (confirmed) | Fix |
|---|---|---|
| 1 | The **WhatsApp receipt** sent to customers said "GREENSOL OPTICALS … Greensol Super Speciality Eye Care" and gave a **hard-coded phone number** (+91 98470 12345) for support | It is now signed with the customer's own store name and phone from the Store & Clinic Profile. With no profile, it names nobody and gives no number. `frontend/src/utils/whatsappInvoice.js` |
| 2 | The **prescription card** printed a fictional doctor's name ("Dr. Sarah Connor, M.Optom"), the old product's name, and a **"Digitally Signed & Verified"** badge, although no digital signature exists | It now shows a blank signature line or the real optometrist, the store's name, and no signature claim. `PrintPrescriptionCard.jsx` |
| 3 | New patients and Rx entries were **pre-filled with "Dr. Sarah Connor"**, which got saved into real records | The default is now empty. `PatientSearchModal.jsx`, `SalesInvoice.jsx` |
| 4 | Appointment WhatsApp confirmations and cancellations said "Greensol Optical" | They now use the store's name, plus the branch if there is one. `Appointments.jsx` |
| 5 | The **UPI QR dialog showed a fake UPI ID** (`greensol@bank`), so a customer could pay the wrong account | Removed. The dialog now tells staff to use the store's own QR and confirm in their UPI app. `PaymentsManagerView.jsx` |
| 6 | **Administration → Audit Logs showed fixed sample rows** ("Greensol Admin", admin@greensol.com) | It now shows the real security audit trail (existing `SecurityAuditPanel` and API). `Administration.jsx` |
| 7 | Backup files, backup error messages, the **two-factor authenticator label** and the API status message said "Greensol" in the Windows edition | New `edition.product_name()`: G OPTICALS on Windows, unchanged on cloud. The backup format id is kept for compatibility. `apps/common/edition.py`, `security/backup/*`, `security/totp.py`, `config/urls.py` |
| 8 | Eye-exam screen header "Powered by Greensol ERP"; backup card "another Greensol installation"; sample data in the designer and CSV template | Made neutral |
| 9 | **System requirements were only checked after files were copied** | New up-front NSIS check of Windows build, RAM and free disk space when the server-settings page is left. Thresholds mirror `gtrade-ctl` and are enforced by a test. `installer.nsh` (`gtProbeSystem`, `gtCheckRequirements`) |
| 10 | **No way to recover a lost administrator password** (the guide said "contact support") | New `gtrade-ctl reset-password [--list-admins] --user NAME`:<br>• server PC only (needs the DPAPI secrets);<br>• password via stdin or hidden prompt, never argv;<br>• password validators apply;<br>• ends that user's sessions;<br>• audit-logged;<br>• refused in the cloud edition.<br>`local_reset_password.py`, `installer_cmds.py` |
| 11 | **Day Book test failed every night 00:00–05:30 IST**: it compared the PC's date with the server's UTC date | Test fixed to use `timezone.localdate()`. The view was already correct. |
| 12 | The purchase "query count" test failed once, order-dependent (71 vs 72) | Could not be reproduced: not by the date (tested with a next-day document), and not in isolation. The test now reports the exact differing SQL if it ever fails again. Its assertion is unchanged. |
| 13 | **Found by this session's own check:** my edit for #12 had put a helper in the middle of the test class, which silently removed 2 purchase tests (1,119 → 1,117) | Found by diffing test lists between runs, fixed, and re-run: all 3 tests in that file pass (purchasing 44/44). |
| 14 | `frontend/src/utils/__tests__/inventoryCache.test.js` was never wired into any test script | Added `test:inventory-cache` (3/3) |
| 15 | `SyntaxWarning` (invalid escape) in `gtrade_ctl/django_bridge.py`. It becomes an error in a future Python. | Raw docstring. The stage now compiles warning-free. |
| 16 | Guides branded "G-TRADE", wrong installer file name, **wrong program folder** (`G-TRADE ERP` vs the real `C:\Program Files\G-TRADE`), and claims that weren't true (a manual unlock, "sessions end after restore", pre-restore retention) | Rewritten, with every claim checked against the code (§8) |
| 17 | Old installers sitting next to the new one | Moved, not deleted, to `windows\out\superseded-installers\` with `.do-not-run` names and a README |

**Test tooling added:**
- `run_local_django_tests.py --cloud` runs the full cloud suite on a throwaway cluster. It strips `DATABASE_URL`, `POSTGRES_*` and `DB_*`, so it can never reach Neon or the dev DB.
- New tests: `customerBranding.test.js` (5), `RequirementsProbeRuntimeTests` (2: the compiled NSIS probe reads the same build and RAM as gtrade-ctl), backend reset-password tests (2), and an e2e reset → HTTPS sign-in test (1).

## 3. Features verified

| Requirement | Status | Evidence |
|---|---|---|
| Standalone / LAN Server / LAN Workstation | ✅ | Wizard pages; e2e install + pairing |
| First-launch organization: company, first branch, administrator | ✅ | `create-org` step; e2e logs in as SUPER_ADMIN |
| Workstation connects without creating an organization or database | ✅ | e2e: no `pgsql`, `secrets.dpapi` or `gtrade.env` on the workstation; wrong pairing code refused |
| Customer data isolation (tenant, company, branch) | ✅ | Backend isolation suites (`tests_multi_company`, tenant and branch tests) in the 1,119 |
| Customer branding on documents; G OPTICALS as vendor | ✅ | Fixes 1–8; branding tests; local bundle has 0 "Greensol" |
| Welcome, licence, directory, mode, server settings / PostgreSQL port, company + admin, progress, completion, shortcuts | ✅ | electron-builder pages + `installer.nsh`. PostgreSQL is a private bundled cluster; its port (5544) is set by the engine, not shown in the wizard (§12). |
| System requirement checks | ✅ | Up-front NSIS check + `gtrade-ctl preflight` |
| Service registration, health checks | ✅ engine / ⏳ elevated | The engine path is tested; real service registration needs an elevated run (§12) |
| Fresh install / upgrade / repair / resume after failure / backup before upgrade / rollback / data-preserving uninstall | ✅ | `test_install_resume`, `test_backup_update_e2e` (including failure scenarios), runtime harness for `customInit` |
| Installer Error 2 (`$COMMONPROGRAMDATA`) | ✅ fixed (previous session), regression-locked | 17 installer tests, `makensis /WX` |
| Never modifies unrelated PostgreSQL/MySQL | ✅ | `test_coexistence`; services confirmed unchanged after all runs |

## 4. Remaining incomplete features (honest list)

- Real Windows-service registration, firewall rule and ACLs have not been exercised **elevated** on this PC. `elevated_smoke.ps1` stops every Python process, so it is not safe on the dev PC. It needs a VM.
- No two-PC LAN test over a real network.
- No product icon. No production licence keys or hosted licence service. No code signing. EULA still a draft.
- Not done this session (pre-existing, unchanged): the 2 moderate npm advisories (react-router v7 upgrade), the cloud `requirements.txt` still on the older package set (owner decision), the ESLint config migration, and the wizard does not offer a custom PostgreSQL port (silent `/DATA` and `/PORT` exist; a busy 5544 is reported by preflight).

## 5. Test results (all on the final code)

| Suite | Result | Log (`windows\out\`) |
|---|---|---|
| Backend, full cloud suite, disposable PG17 | **1,117 / 1,117 OK**, 1 skipped (2,498 s) | `final_full_suite_cloud.log` |
| … plus the 2 tests restored after that run (fix #13) | purchasing **44 / 44 OK** | `final_purchasing_rerun.log` |
| Backend, Windows edition (`settings_local`) | **23 / 23 OK** (21 + 2 new) | `final_local_licensing.log` |
| Targeted re-run (purchasing, Day Book, security, authentication) | **139 / 139 OK** | `final_targeted.log` |
| Frontend unit, all 25 suites (2 newly wired) | **204 / 204 OK** (196 + 3 inventory-cache + 5 customer-branding) | `final_frontend_tests.log` |
| Frontend builds | Local ✅ (title G OPTICALS, no external hosts) · Cloud ✅ (to scratch; `dist/` untouched) | `final_build_frontend.log`, `final_cloud_build.log` |
| Desktop (Electron) unit | **16 / 16 OK** | `final_desktop_tests.log` |
| Windows suite with real-stack e2e (`GTRADE_E2E=1`) | **93 / 93 OK, 0 skipped** (722 s) | `final_windows_e2e.log` |

**Failures investigated:**
- Day Book: a test-side timezone bug, now fixed.
- Purchase query count: not reproducible; diagnostics added.
- The 2 dropped tests: my own error, caught and fixed.

No test was skipped, weakened or deleted to get a pass. None is failing.

## 6. Security audit

| Check | Result |
|---|---|
| Secrets in git-tracked files | None. Only `.env.example` files with placeholders. |
| Secrets in untracked (to-be-committed) files | None real. Hits are fake test values, redaction tests and rogue-CA test fixtures. |
| Windows settings | DEBUG forced off; strong SECRET_KEY required; DB loopback only; `DATABASE_URL` refused; same-origin CORS; secure, HttpOnly cookies; nosniff; frame and referrer policy; runserver refused (e2e-tested) |
| `/media` | Public images only (P1 fix still in place) |
| Passwords | Django validators everywhere, including the installer and the new reset tool; never in argv; answers file deleted (e2e-checked); not in logs (e2e-checked) |
| Roles and isolation | Covered by the backend suite (tenant, company and branch tests) |
| TLS / LAN | Per-install CA, pinned in the desktop app; rogue CA refused (e2e); firewall rule Private profile + local subnet |
| Licence | Ed25519 verification; read-only, not lockout. **Development keys in this build.** |
| Backups | Checksummed and verified; deep test-restore; pre-restore safety copy |
| Installer payload | `payload_guard` OK on the stage, `win-unpacked` and the **extracted `.exe`**; 0 `.env` files; Defender: no threats |

## 7. Database safety verification

- Every test database was a throwaway PostgreSQL 17 cluster in a temp folder on its own port, deleted after the run.
- The cloud-mode harness strips every `DATABASE_URL`/`POSTGRES_*`/`DB_*` variable before pointing at loopback. The backend has no dotenv loader, so `backend/.env` is never read.
- After all runs: `postgresql-x64-17`, `postgresql-x64-18`, `pgagent-pg17` and `MySQL80` were still running and unchanged. No GTrade services exist. `C:\ProgramData\G-TRADE` does not exist. No test ports were left listening.
- No migrations were added. The dev database got nothing new.

## 8. Documentation

All guides are in `windows\docs\`. The first five are also installed to `C:\Program Files\G-TRADE\resources\docs\`.

| Document | File |
|---|---|
| User guide | `USER_GUIDE.md` |
| Installation guide | `INSTALLATION_GUIDE.md` |
| Administrator guide | `ADMINISTRATOR_GUIDE.md` |
| Backup and recovery guide | `BACKUP_AND_RECOVERY_GUIDE.md` |
| Troubleshooting guide | `TROUBLESHOOTING_GUIDE.md` |
| Release notes (not bundled: they contain the installer's hash) | `RELEASE_NOTES_1.0.0.md` |
| Licence agreement **draft** for legal review (not bundled) | `LICENSE_AGREEMENT_DRAFT.md` |

The root `WINDOWS_*_GUIDE.md` files now point to these. No legal company details or publisher information were invented: all of them are `[BRACKETED]` placeholders.

## 9. Windows compatibility

| Item | Result |
|---|---|
| Dev PC | Windows 11 build 26200, x64. All tests pass. |
| Minimum | Windows 10 22H2 (19045), enforced by the installer and `gtrade-ctl` |
| Version info | ProductName and Company "G OPTICALS", FileVersion 1.0.0 |
| Internal ids kept for upgrades | appId `com.gtrade.erp`, NSIS GUID, `G-TRADE.exe`, `C:\Program Files\G-TRADE`, `C:\ProgramData\G-TRADE`, `GTrade-*` services |
| Not yet run | Windows 10 22H2 clean VM; elevated Windows 11 clean VM |

## 10. Installer validation

| Check | Result |
|---|---|
| `electron-builder --win nsis` | exit 0 (`final_installer_build.log`) |
| `makensis /WX` compile (installer + uninstaller) and the `customInit` + requirements runtime harnesses | 17 / 17 |
| `payload_guard`: `win-unpacked` | OK |
| `.exe` extracted with 7-Zip (`app-64.7z`) | 10,653 files, **byte-identical** to `win-unpacked`; `payload_guard` OK; 0 `.env` |
| Shipped content | reset command, error-2 guard and edition product name present; SPA title G OPTICALS; 0 "Greensol" in the SPA; 5 guides present |
| Defender (`MpCmdRun -ScanType 3`, no remediation) | No threats |
| Authenticode | **NotSigned** |
| **Final file** | `G-OPTICALS-Setup-1.0.0.exe` · **205,916,846 bytes** · SHA-256 **`9EBA8BEB7C84C40DB9182AC49583593E454508DA9AE2278C63CEF9B534C4435C`** |
| Superseded (moved, not deleted) | `windows\out\superseded-installers\`: `A92A8EBC…` (defective, error 2) and `E4B776C5…` (previous build, never installed) |

## 11. Installation steps (internal, on your approval)

1. Restart the PC. Before you start, check Task Manager → Memory shows **at least 2 GB available**. This PC has 7.2 GB, so the installer will warn about less than 8 GB; click OK to continue.
2. In PowerShell, check the hash: `Get-FileHash "D:\G OPTICALS\windows\out\installer\G-OPTICALS-Setup-1.0.0.exe"` must give `9EBA8BEB…4435C`.
3. Run it. If SmartScreen appears: *More info → Run anyway*. Accept the UAC prompt.
4. Accept the licence draft. Keep the folder `C:\Program Files\G-TRADE`.
5. Mode: **Standalone**, or LAN Server if other PCs will connect.
6. Data folder: it must show **`C:\ProgramData\G-TRADE`**. If it shows anything else, cancel. Keep port 8443.
7. Enter **your** company, first branch and administrator, with a password of at least 10 characters. Write down the user name.
8. Install, which takes 2–5 minutes. Expect setup to remove the old stray `C:\Program Files\G-TRADE\$COMMONPROGRAMDATA` folder during its normal upgrade step. The evidence copy is kept in `windows\out\evidence\`.
9. Start **G OPTICALS**, sign in, then open **Settings → Store & Clinic Profile** and enter your shop's details and logo.
10. If anything fails, send `C:\ProgramData\G-TRADE\logs\install\*.jsonl`. Re-running the same setup resumes safely.

## 12. Known limitations

- The installer is unsigned, so SmartScreen warns.
- Default Electron icon (no official icon exists).
- Internal G-TRADE names are visible in folders, services and the tool name.
- One customer organization per installation.
- Licensing uses development keys.
- The PostgreSQL port is fixed at 5544 in the wizard (5544 is not used on this PC).
- In the Windows edition, the sidebar still shows the green eye emblem originally designed for Greensol, with the G OPTICALS wordmark. It is reused as-is until you supply your own mark; no new logo was invented.

## 13. External requirements for commercial release

| # | Owner action |
|---|---|
| 1 | Code-signing certificate (decision D6), then sign and rebuild |
| 2 | Publisher legal name and address (D8); legal review of `LICENSE_AGREEMENT_DRAFT.md` → replace `windows/installer/EULA.txt` |
| 3 | Official G OPTICALS logo and `.ico` |
| 4 | Production licence key ceremony, hosted licence service, then the `RELEASE` marker (D4/D5) |
| 5 | Elevated installs on clean Windows 10 22H2 and Windows 11 VMs (`elevated_smoke.ps1`), and the interactive wizard walk-through |
| 6 | Two-PC LAN test (server + workstation, Private network) |
| 7 | Upgrade test from one signed release to the next |
| 8 | Decide whether the cloud `requirements.txt` adopts the patched package set |
| 9 | Approve and commit this work (currently uncommitted) |
