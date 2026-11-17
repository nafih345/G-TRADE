# G OPTICALS — Urgent Customer Installation Readiness

> **SUPERSEDED (17:25 IST): see `G_OPTICALS_WINDOWS_CUSTOMER_READY_RELEASE.md`.** Corrections:
> - (1) The statement that no install had got past PostgreSQL setup was **wrong**. The owner's elevated install of `1ACEFB53` at 11:52 completed all 16 steps (logs in `C:\ProgramData\G-TRADE\logs\install\`).
> - (2) Installer `DF494236…` below is **superseded**. It still had two defects, fixed in `AC9551B3…`: the customer's company and branch names were not applied, and there was a ~2 s IPv6 `localhost` delay.

Date: 2026-11-13, prepared 16:21–16:42 IST against a 17:00 deadline · Nothing installed, committed, pushed or deployed · No production database, Render, Vercel or Neon was contacted.

## Verdicts

| Area | Verdict | Why |
|---|---|---|
| **APPLICATION PERFORMANCE** | **NO-GO (not assessed today)** | No performance work or measurement was done in the time available. Behaviour is unchanged from the last tested build. See §2. |
| **WINDOWS INSTALLER** | **NO-GO** | The installer has never completed a real elevated installation on a clean Windows PC. It was rebuilt today with the current code, but it was tested only by automated harnesses. See §5. |
| **CUSTOMER STANDALONE INSTALLATION** | **NO-GO for today** | Same reason. The last three real installs (on the owner's PC) failed at successive steps. Each was fixed and modelled in tests, but no install has yet got past PostgreSQL initialisation on real hardware. |
| **LAN INSTALLATION** | **NO-GO** | Never tested on two real PCs. |

**Recommendation:** do not install at the customer today. First do one elevated Standalone install on a clean PC or VM that you can wipe (steps in §7). If it reaches the health check and you can log in, the Standalone verdict can be changed to GO the same day.

## 1. Installation bugs — status in the current build

All five earlier failures have a fix in the source, and each one is covered by a test that ran today (§4):

| # | Earlier failure | Fix (source) | Test |
|---|---|---|---|
| 1 | NSIS used `$COMMONPROGRAMDATA`, which is not an NSIS constant, so the data folder became a relative path under Program Files (exit 2) | `installer.nsh` reads the `ProgramData` environment variable. `gtrade-ctl` refuses relative or unexpanded roots before it writes anything. | `test_installer_nsh` (compiles with `makensis /WX`) |
| 2 | `icacls … /T` left every config file with an empty DACL, so setup could not read `install.json` | `winacl.protect` sets the folder ACL without `/T`, then `inherit_below`. A `repair-permissions` command is also available. | `test_config_permissions` (real icacls) |
| 3 | PostgreSQL temporary password file unreadable by initdb (restricted token) | `winacl.create_private_file` (owner SID + Administrators) | `test_initdb_permissions` |
| 4 | initdb could not write `pgsql\data` | `winacl.grant_operator` gives the installing account Modify on the data folder only | `test_initdb_permissions` (real PG 17) |
| 5 | PostgreSQL could not write `logs\db` | Same grant, on `logs\db` | `test_initdb_permissions` |
| — | Safe retry after a failed install | `initdb.in-progress` marker → state `partial`. Setup never deletes a cluster on its own. `install.complete` is written only after the last step. | `test_install_resume` |

**Found today:** the previous installer (`1ACEFB53…5A616`, built 11:34) **did not contain the latest code**. About 40 source files changed after it was built: the module-access role gate, migration `common 0012`, Client Management/invitations, and the compact UI. It has been moved to `windows\out\superseded-installers\` as *STALE* (not defective), and a new build was made from the current tree (§8).

## 2. Performance improvements

**None were made today.** With 39 minutes left at the start and 0.7 GB of free RAM on the build PC, profiling, optimising and re-testing 10 areas safely was not possible. A rushed change to queries or caching in a billing/stock system would have put data integrity at risk, so I made none.

What already exists from earlier work (unchanged, for reference): hot caches and batched lookups for saves; parallel paged list fetching; a master-data SWR cache scoped per tenant; a reconciliation N+1 fix; vendor-split frontend bundles (largest chunks: MUI 475 kB / charts 420 kB, 145 kB / 113 kB gzipped). On a local install, the main cloud latency cause disappears: the cloud server and its database are in different regions, about 250 ms per query. On the local edition, the database runs on the same PC (loopback).

## 3. Before/after measurements

None were taken. No performance change was made, so there is no "after". A proper baseline on a staged local install (login, dashboard, product search, barcode lookup, sale save, reports) is the first task for the performance pass.

## 4. Test results (run today, on the rebuilt payload)

| Suite (run 16:26–16:39) | Result |
|---|---|
| `test_installer_nsh`, `test_config_permissions` (real icacls), `test_install_resume`, `test_coexistence`, `test_placeholder_urls` | **47/47 OK**, 0 skipped |
| `test_initdb_permissions` (real PG 17, restricted token), `test_postgres` | **21/21 OK** |
| `test_payload_guard`, `test_runtime` (against the **new** staged payload) | **30/30 OK** |
| `payload_guard` on `win-unpacked` + `stage` | **OK**: 0 forbidden files, 4 secret values checked, none found |
| Payload contents | Contains `common/migrations/0012_tenant_subscription_profile.py` and the current `module_access.py` (SHA match with the source). No `.env*` files. Frontend bundle: "external hosts in bundle: none". |
| `apps.licensing` under **local-edition settings** on a throwaway PG 17 (fresh migrate incl. `common.0012 … OK`) | **23/23 OK** |
| Microsoft Defender custom scan of the installer | **No threats** |

**Wrong test I ran, recorded here:** I also ran `apps.common.tests_client_management` under local-edition settings, and 32 of 60 failed. That module tests the **cloud** multi-client Super Admin console. The Windows edition refuses it by design: "a second organization cannot be created here", and "there is no platform owner here by design". Under the cloud settings it passes 37/37 (earlier today). This is not a regression, but it shows that no local-edition test covers the new Client Management code. That is correct, because the feature is cloud-only.

Not run today, and why:
- **Full backend suite** (~1,156 tests, 40–50 min). It last ran today on the same backend code, after the role-gate change: 1,155 OK, 1 skipped, 1 known flake (`security.test_backups`, same-second backup filename collision; passed 3/3 on re-run). Source: `G_OPTICALS_FINAL_PRODUCTION_DEPLOYMENT_READINESS.md` §7. It did not fit before 17:00.
- **Licensing under local-edition settings on a throwaway PG 17**: 23/23 OK, earlier today (same report).
- **Frontend 208/208 and desktop 16/16**: earlier today (same report). The frontend changes since then are UI only.
- **Opt-in Windows stack e2e** (`GTRADE_E2E=1`: backup/restore/update/rollback, desktop pairing, full stack from an empty DB). These start real services and need several GB of free RAM. The build PC had 0.7 GB free. Last pass: the 11:34 RC (initdb fix report).
- **Tenant isolation**: covered in the backend suite above (161 cross-client GET probes, 165 cross-client writes refused).

## 5. Clean Windows installation test evidence

**There is none.** No clean VM was available or running: the VMware VM from `VM_SETUP_REPORT.md` was planned but is not running on this PC. An elevated install on the development PC would collide with its own PostgreSQL 17/18 and MySQL, and there was 0.7 GB of free RAM, so I did not run one. The automated harnesses reproduce the restricted-token conditions that caused failures 3–5, but they are not a substitute for a real installation.

## 6. Known limitations

- Installer **not code-signed**: Windows SmartScreen will warn ("Unknown publisher" → *More info → Run anyway*). There is no product icon yet. The EULA is a draft.
- Licence keys are development keys.
- Real elevated installs: never completed on a clean PC. LAN: never tested on real hardware.
- Requirements enforced by the installer: Windows 10 22H2 (build 19045)+ x64 or Windows 11 · ≥4 GB RAM (blocks), <8 GB warns · ≥10 GB free on the data drive · ports 8443 (HTTPS, LAN), 8001 and 5544 (loopback only) must be free.
- Coexistence: the bundled PostgreSQL runs as its own service on port 5544, with data in `C:\ProgramData\G-TRADE\pgsql`. It does not touch an existing PostgreSQL (5432) or MySQL (`test_coexistence`). Firewall: one inbound rule for 8443, only in Server mode.
- Printing uses the Windows print dialog from the desktop app, so any printer installed in Windows works. Label and receipt layouts were not tested on the customer's printer.
- Internal identifiers still say G-TRADE (service names, `C:\ProgramData\G-TRADE`, `G-TRADE.exe`). Only the display name is G OPTICALS.

## 7. Exact customer installation steps (for the test PC first, then the customer)

Before you start: the PC runs Windows 10 22H2+/11 x64, has ≥8 GB RAM (4 GB minimum), ≥10 GB free on C:, and has been restarted recently. Sign in with an account that is a local Administrator. Check that the installer's SHA-256 matches §8: `Get-FileHash .\G-OPTICALS-Setup-1.0.0.exe`.

1. Right-click `G-OPTICALS-Setup-1.0.0.exe` → **Run as administrator**. If SmartScreen warns: *More info → Run anyway*. Accept UAC.
2. **Welcome** → Next.
3. **Installation mode** → *Standalone (this PC only)*.
4. **Installation directory**: keep the default (Program Files).
5. **Server settings**: keep the data folder `C:\ProgramData\G-TRADE` and HTTPS port 8443 (change the port only if setup says it is in use).
6. **Company + administrator**: enter the **customer's** organisation, company and branch name, then the administrator's username, name, email and a strong password (written down and handed to the owner). Do not enter "G OPTICALS" as the business.
7. **Install**: wait. This step creates the database, writes the configuration, registers the services, runs migrations, creates the administrator and runs the health check. Do not close the window.
8. **Finish**: the desktop app opens. Log in with the administrator account.
9. Restart the PC. Open G OPTICALS from the Start menu and confirm it logs in without any manual service start.
10. If a step fails: **do not delete anything**. Take a screenshot and collect `C:\ProgramData\G-TRADE\logs`. Running the same installer again resumes safely (a partial database is detected, never auto-deleted).

LAN (after Standalone is proven): install **LAN Server** on the main PC (same steps; it opens firewall port 8443 and shows a pairing code). Then install **LAN Workstation** on each other PC and enter `server-name:8443` and the pairing code.

## 8. Final installer

| | |
|---|---|
| File | `D:\G OPTICALS\windows\out\installer\G-OPTICALS-Setup-1.0.0.exe` |
| Built | 2026-11-13 16:32:50 IST from the current (uncommitted) working tree |
| Size | **206,055,475 bytes** |
| SHA-256 | **`DF494236695DB91B629B530FB0863020D0778C0CB1407599697B9BF044E930E4`** |
| Signing | Unsigned (SmartScreen warning expected) |
| Supported Windows | Windows 10 22H2 (build 19045+) x64, Windows 11 x64 |
| Requirements | Local Administrator · 4 GB RAM minimum (8 GB recommended) · 10 GB free · ports 8443/8001/5544 free |
| Previous RC | `1ACEFB53…5A616`. **Stale**: built 11:34, before today's code changes. Moved to `windows\out\superseded-installers\` (`.do-not-run`). |
| Build logs | `windows\out\urgent_rebuild.log`, `urgent_build_frontend.log`, `urgent_stage_app.log`, `urgent_installer_build.log` |

Security scan: Microsoft Defender (`MpCmdRun -ScanType 3`) found **no threats**. `payload_guard` found no secrets and no forbidden files. Not done: VirusTotal / multi-engine upload. Uploading would publish the binary.

**Do not distribute or install until you approve**, and until the clean-PC test in §7 passes.
