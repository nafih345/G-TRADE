# Phase 9: Final QA and Commercial Release Report

**Date:** 2026-11-12

**Verdict: RELEASE CANDIDATE built and verified on Windows 11. NOT approved for commercial distribution yet.** These mandatory gates need owner action or hardware this session did not have:
- code signing (D6);
- production licence key (D4);
- elevated installer runs on clean Windows 10 and Windows 11 VMs;
- a two-PC LAN test;
- EULA and publisher name (D8).

Following the rule "produce a final release package only after all mandatory checks pass", the installer below is a **release candidate**, not a release.

Nothing was committed, pushed or deployed. Neon, Render and Vercel were not contacted. The dev database was not migrated or changed.

## 1. Release candidate

| Item | Value |
|---|---|
| Installer | `windows/out/installer/G-TRADE-Setup-1.0.0.exe` (205,918,872 bytes, built 2026-11-12 22:15, **unsigned**) |
| SHA-256 | `a92a8ebcae1f07b02631480bfaa452b9c5c8b9b72d035a17b15e39db91f2f9ae` (adds the example.com smoke-test fix and the install-resume fix; superseded intermediate `84223ee8…` at 21:48) |
| Superseded build | `92b5ee8f…b1e9a8` (205,917,942 bytes, 21:02). Not unsafe: identical server payload, but its desktop smoke-test mode opened `https://example.com/` in the real browser. Replaced so the shipped desktop code matches the fixed source. See `DIRECT_INSTALLATION_FINAL_READINESS_REPORT.md` §2. |
| Withdrawn build | `e0b3cb64…a0e165` (205,887,450 bytes, 18:31). **Withdrawn: it shipped the developer `backend/.env` with the hosted database URL and password (§1a). Do not use or distribute it.** |
| Payload manifest | `windows/out/stage/manifest.json` (10,625 files, SHA-256 each). The previous manifest (9,795) was written before the e2e runs added 903 `.pyc` caches to `runtime/python/Lib`, so it did not list everything that shipped. It now matches the payload exactly. |
| Secret scan | `windows/tooling/payload_guard.py`: **OK** on `stage`, `win-unpacked` and the contents extracted from the `.exe` (10,645 files). It found 0 forbidden files and 0 of the 4 developer secret values. |
| Runtime | Python 3.12.10 embed + 28 hash-locked packages (security-patched, §4) · PostgreSQL 17.10 · nginx 1.30.6 · WinSW 2.12.0 · Electron 44.9.3 |
| Unpacked tree | `windows/out/installer/win-unpacked/` |

### 1a. Rebuild 2026-11-12: developer secrets removed from the payload

**Defect.** `build_runtime.py` copied `backend/` without excluding env files. The 18:31 installer therefore contained `backend/.env`, byte-identical to the developer file, including `DATABASE_URL` for the hosted (Neon) database with the owner password, plus `.env.example`.

**Runtime impact: none.** Nothing in the backend loads `.env`. `settings_local.py` refuses a `DATABASE_URL` and allows a loopback database only.

**Exposure impact: yes, for anyone given that installer.**

**Fix**

- **Exclusions.** `BACKEND_EXCLUDE_FILES` now excludes `.env`, `.env.*` and `*.env`, plus the cloud-only operations scripts `copy_database.py` and `p1_neon_rehearsal.py`. The local edition is configured only by `gtrade.env` and DPAPI secrets that `gtrade-ctl` writes at install time, so cloud and local configuration stay separate.
- **New guard.** `windows/tooling/payload_guard.py` fails the build on:
  - forbidden files: env files, keys, `*.pem` outside the third-party `runtime/` tree, SQLite, DPAPI and dumps;
  - any secret value from the repo's developer env files (`backend/.env`, `.env.local`, `frontend/.env*`, …), searched byte for byte in every shipped file including `app.asar`.

  Findings name the file and env key and never print the value.
- **Where the guard runs.** `build_runtime.py` runs it on the app tree and again on the whole stage before writing the manifest. Run it manually on `win-unpacked` after electron-builder (checklist B.5a).

**Tests after the rebuild:** `test_payload_guard` 7 (new), `test_runtime` 23, `test_postgres` 10, `test_e2e_stack` 10, `test_desktop_install_e2e` 4 and `test_backup_update_e2e` 10. All **OK**, none skipped, all against the rebuilt payload. Logs: `windows/out/rebuild_tests.*.log`.

**Not re-run:** the backend Django suites. No backend, frontend or engine source changed; only the build exclusions and the new guard did.

**Owner action:** if the 18:31 installer or `windows/out/` ever left the development PC, rotate the hosted database owner password.

## 2. Test results (all runs on this PC: Windows 11 Home 10.0.26200, x64, **not elevated**)

| Suite | Tests | Result |
|---|---|---|
| **Backend, full suite, cloud settings, current packages** | 1,119 (1 module skipped by design) | **OK** (2,615 s) |
| **Backend, full suite, security-patched packages** (Django 5.2.18, DRF 3.18.3, simplejwt 5.5.1, PyJWT 2.15.1, Pillow 13.0.0, …) | 1,119 | **OK** (2,741 s) after a one-line compatibility fix (§3) |
| Compatibility fix re-checked on the current packages (DRF 3.15) | 67 | OK |
| Local-edition Django tests on a disposable PostgreSQL 17 cluster (licensing, single-org guard, wipe disabled, first admin), patched packages | 21 | OK |
| Frontend unit tests (22 scripts + inventoryCache) | 195 | **195/195** |
| Frontend production builds | cloud + local | OK. The local bundle contains no external hosts. |
| Vendor licensing service | 8 | OK |
| Desktop (Electron) unit tests | 9 | OK |
| Windows engine `test_runtime` | 23 | OK |
| Windows engine `test_postgres` (real clusters) | 10 | OK |
| **Real stack e2e** (`test_e2e_stack`) against the final payload | 10 | OK |
| **Electron + installer engine e2e** (`test_desktop_install_e2e`) against the final payload | 4 | OK |
| **Backup / restore / update / rollback e2e** (`test_backup_update_e2e`) against the final payload | 10 | OK |
| NSIS installer build | — | OK, no warnings |

Evidence: `windows/out/evidence/*.json`; logs: `windows/out/full_suite_*.log`, `windows/out/final_tests.*.log`.

**Interrupted and repeated runs.** One earlier full-suite run was cut off by a session restart while it shared memory and PostgreSQL with the end-to-end tests. It reported setup errors in `tests_multi_company`. A clean, isolated re-run passed all 70 tests in that module, and the full suite passed twice. Nothing was skipped silently.

## 3. Defects found during Phase 9 and fixed

| # | Defect | Fix |
|---|---|---|
| 1 | `apps/common/tenant_serializers.py` assumed DRF's `get_unique_together_constraints` yields pairs. DRF ≥ 3.16 yields 6-tuples, so the security upgrade broke every serializer of a tenant-owned model (500s). | Rewrite only the field list and pass the rest through. The tenant-scoping rule is unchanged. Verified on DRF 3.15 and 3.18. |
| 2 | `gtrade-ctl.cmd` wrapper failed for paths with spaces (`for /f` quoting) | The bundled Python resolves the active version itself |
| 3 | `npm audit fix --omit=dev` pruned dev dependencies from `node_modules` | Reinstalled from the lock (lock contents unaffected). Use plain `npm audit fix` in future. |

## 4. Security and dependency checks

| Area | Before | After |
|---|---|---|
| Windows runtime Python packages (`pip-audit`) | **84 known vulnerabilities in 9 packages** (Pillow 10.4, DRF 3.15.2, simplejwt 5.3.1, PyJWT 2.13, Django 5.2.16, sqlparse, urllib3, certifi, cryptography) | **0**: `backend/requirements-local.lock` now pins the patched set, and the full suite is green with it |
| **Cloud** `backend/requirements.txt` | Same 84 advisories (caps `Pillow<11`, `djangorestframework<3.16`, `djangorestframework-simplejwt<5.4`) | **Unchanged: owner decision.** Changing it ships to production on the next deploy. The patched set and fix #1 are proven by the full suite, so the recommendation is to adopt them. |
| Desktop app runtime npm deps | — | 0 |
| Desktop build tooling (not shipped) | 6 moderate | Unchanged (build-time only) |
| Frontend (shipped in both editions) | 2 high (axios, follow-redirects), 2 moderate (react-router) | **0 high.** 2 moderate remain (react-router: open-redirect/SSR advisories) that need a v6 → v7 major upgrade, recorded as an open item. The lock changed within the declared ranges (axios 1.21.1, follow-redirects 1.16.3, react-router 6.30.6). |
| Upstream binaries | — | Python: Authenticode valid (PSF). nginx: PGP signature good. **WinSW and nginx.exe are unsigned upstream** and must be signed by us (D6). |
| Secrets | — | DPAPI-encrypted, never on a command line, redacted from logs and diagnostics. Verified by scanning every log/config file in the e2e runs for secret values. |
| Network exposure | — | Standalone: nothing on the LAN IP (tested). Server: only 8443 via the firewall rule (Private, LocalSubnet). PostgreSQL and Waitress on loopback only. |

## 5. Phase 9 test matrix

| Area | Status | How |
|---|---|---|
| Windows 11 compatibility | **Partly verified**: every non-elevated path on Windows 11 Home 26200 | e2e suites |
| Windows 10 compatibility | **Not verified** (no Windows 10 machine) | `elevated_smoke.ps1` on a Win10 22H2 VM |
| Standalone installation | Engine verified (`install --no-services`); service registration not verified | e2e + elevated smoke |
| LAN server installation | Engine verified for nginx bind and firewall *plan*; the real firewall rule needs elevation | elevated smoke `-Mode server` |
| LAN workstation installation | Verified: pairing, wrong-code refusal, no database, Electron connects | e2e |
| Fresh installation | Verified (engine) | e2e |
| Upgrade from previous version | Engine verified (1.0.0 → 1.0.1, plus failure rollbacks). The NSIS-to-NSIS upgrade needs two released builds. | Checklist A15 |
| Uninstall and reinstall | Uninstall keep/delete verified (engine). Reinstall over kept data covered by the engine; the elevated `.exe` path is in the smoke script. | e2e + smoke |
| Database connectivity | Verified | e2e, `verify-db` |
| Backup and restore | Verified (deep verification, tamper detection, restore, offsite) | e2e |
| Licence activation and expiry | Verified with dev keys, including real HTTP activation, check-in and revocation | licensing tests |
| Multiple companies, multiple branches, user permissions, cross-company and cross-branch isolation | Verified by the full backend suite (P1/P2 suites included) on both package sets. The local-edition single-org and licence limits are verified separately. | full suite + licensing tests |
| Sales, purchases, inventory, accounting, reports | Verified by the full backend suite | full suite |
| Printing and barcode printing | Backend and frontend logic tests pass (`test:labels`, `test:billing`, …). **Physical printer output not verified.** Printing in Electron uses the Windows print dialog. | Manual QA with real printers |
| File attachments | Backend attachment tests pass. In the local edition `/media` is proxied through Django (public-only rule kept). | full suite |
| Offline and reconnect | Verified: the desktop shows the offline page, reconnects, and the status goes `offline` → `online`. Stop/start of the app tested. | e2e |
| Service restart and recovery | Graceful stop (exit 0, 1.3 s) and crash restart verified as processes. WinSW-driven restart needs elevation. | e2e + smoke |
| Security and dependency checks | §4 | |

## 6. Migrations

| App | Migration | Edition | Applied where |
|---|---|---|---|
| `licensing` | `0001_initial` (LicenseState, LicenseEvent) | **Windows only** (`INSTALLED_APPS` in `settings_local`) | Disposable test clusters and e2e installs only. Cloud `makemigrations --check`: no changes. |

No cloud-edition migrations were added in Phases 3–9.

## 7. Remaining owner decisions and actions

The full list is in `COMMERCIAL_RELEASE_CHECKLIST.md`. In short:
1. **D6:** code-signing certificate, then rebuild.
2. **D4:** licensing-service hosting and KMS key ceremony; publish the public key in `PRODUCTION_KEYS`.
3. **D8:** legal publisher name, EULA text, icon.
4. QA on clean **Windows 10 22H2 and Windows 11** VMs with `windows/tests/elevated_smoke.ps1` (Standalone + Server), plus a two-PC LAN test and the interactive wizard walk-through.
5. Adopt the patched Python set for the **cloud** `requirements.txt` (recommended; tested).
6. Plan the react-router v7 upgrade (2 moderate advisories).
7. Sign off the checklist.
