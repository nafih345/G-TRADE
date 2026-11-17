# G-TRADE ERP for Windows: Commercial Release Checklist

Status legend: ✅ done and verified in this repository · ⏳ owner / QA action outstanding · ❌ blocking issue

Last updated: 2026-11-12. Each gate links to its evidence. A release ships only when **every mandatory gate is ✅**.

## A. Mandatory gates

| # | Gate | Status | Evidence / action |
|---|---|---|---|
| A1 | Full backend test suite passes (current and patched packages) | ✅ 1,119 OK on both | `windows/out/full_suite_cloud.log`, `full_suite_candidate.log` |
| A2 | Local-edition Django tests (licensing, guards) pass on PostgreSQL 17 | ✅ 21/21 | `windows/tests/run_local_django_tests.py` |
| A3 | Frontend unit tests pass; cloud and local builds succeed | ✅ 195/195; both builds OK | Phase 9 §2 |
| A4 | Windows engine tests (runtime, PostgreSQL, desktop, licensing service) pass | ✅ 23 + 10 + 9 + 8 | Phase 9 §2 |
| A5 | Real-stack end-to-end on Windows 11 (runtime, desktop + installer engine, backup/update/rollback) | ✅ 10 + 4 + 10 on the final payload | `windows/out/evidence/*.json` |
| A6 | **No known vulnerabilities in shipped Python packages** | ✅ Windows lock: 0 (patched set adopted, full suite green). ⏳ Cloud `requirements.txt` still has the 84 advisories: owner decision. | Phase 9 §4 |
| A7 | No known high/critical vulnerabilities in shipped JavaScript | ✅ 0 high/critical. ⏳ 2 moderate (react-router v7 upgrade). | Phase 9 §4 |
| A8 | **Elevated installer smoke test on clean Windows 10 22H2 and Windows 11** (Standalone + LAN Server) | ⏳ | `windows/tests/elevated_smoke.ps1` in an elevated PowerShell on VMs |
| A9 | Two-PC LAN test (server + workstation pairing over a real network, firewall Private profile) | ⏳ | Manual QA with the guides |
| A10 | **Code signing** of installer, uninstaller, `G-TRADE.exe`, WinSW and nginx copies (SHA-256, RFC 3161 timestamp); SmartScreen / Smart App Control check | ⏳ | Owner: certificate (D6), then rebuild |
| A11 | **Production licence public key** in `backend/apps/licensing/keys.py PRODUCTION_KEYS`; licensing service hosted over HTTPS with a KMS signer | ⏳ | Owner: D4 key ceremony + hosting |
| A12 | Release build marker: `RELEASE` file next to the backend (disables dev licensing) | ⏳ | Release pipeline step (`echo > app\<ver>\RELEASE` before electron-builder) |
| A13 | EULA legal text, publisher legal name (D8), product icon | ⏳ | Owner |
| A14 | Interactive wizard walk-through (all pages and error messages) on VMs | ⏳ | QA |
| A15 | Upgrade test from the previous **released** installer to the new one (real NSIS upgrade path) | ⏳ | Needs two signed released builds; engine path verified (Phase 8) |

## B. Release procedure (once A is green)

1. Bump the version in `windows/desktop/package.json` and pass `--version` to the build.
2. `python windows/tooling/build_frontend.py`
3. `python windows/tooling/build_runtime.py --version X.Y.Z` (verifies every pinned SHA-256 and installs the hash-locked packages)
4. Write `windows/out/stage/app/X.Y.Z/release.json`: `version`, `release_date`, `min_upgrade_from`, `irreversible_migrations`, `requires_pg_major`. Add the `RELEASE` marker.
5. `cd windows/desktop && npx electron-builder --win nsis` with signing configured.
   5a. `python windows/tooling/payload_guard.py windows/out/installer/win-unpacked`: must print OK (no env files, keys or developer secret values in the shipped tree). `build_runtime.py` already enforces it on the stage.
   5b. `node --test windows/desktop/test/*.test.js` and `python -m unittest tests.test_placeholder_urls tests.test_coexistence` (from `windows/`): no placeholder domains (example.com/.org/.net) in shipped code, external links only through the smoke-aware opener, and preflight refuses busy ports.
6. Run the gates A4, A5, A8, A9 and A14 against **that** installer.
7. Archive the installer, `.blockmap`, `manifest.json`, the test evidence and this checklist with sign-offs.

## C. Sign-off

| Role | Name | Date | Signature |
|---|---|---|---|
| Engineering | | | |
| QA | | | |
| Owner / publisher | | | |
