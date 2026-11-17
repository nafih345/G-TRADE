# G-TRADE ERP: Master Implementation Status

Last updated: 2026-11-12. Nothing has been committed, pushed or deployed. Neon, Render and Vercel were not contacted. The dev database got no new migrations.

| Phase | Scope | Status | Report |
|---|---|---|---|
| P1 | Isolation hardening | Done, verified (earlier) | `P1_COMPLETION_REPORT.md` |
| P2 | Multi-company (Company = Tenant + Organization) | Done, verified (earlier) | `PHASE_2_FINAL_VERIFICATION_REPORT.md` |
| P3 | Windows local production runtime (embedded Python, Waitress, WinSW, nginx TLS, DPAPI secrets) | **Done**; real-stack e2e 10/10 on Windows 11. Service registration needs an elevated test. | `PHASE_3_COMPLETION_REPORT.md` |
| P4 | PostgreSQL 17 runtime (init, least privilege, verify, modes, upgrade guard) | **Done**; 10/10 cluster tests | `PHASE_4_COMPLETION_REPORT.md` |
| P5 | Electron desktop app (thin client, pinned TLS, secure IPC, pairing) | **Done**; real Electron e2e on Windows 11 | `PHASE_5_COMPLETION_REPORT.md` |
| P6 | Electron Builder + NSIS installer (3 modes, repair, upgrade, uninstall-keeps-data) | **Built** (unsigned). Engine verified non-elevated; elevated `.exe` run outstanding. | `PHASE_6_COMPLETION_REPORT.md` |
| P7 | Licensing (vendor service + verify-only client, limits, grace, revocation) | **Done with development keys**; production key = owner action | `PHASE_7_COMPLETION_REPORT.md` |
| P8 | Backups, restore, safe updates, auto-rollback | **Done**; e2e 10/10 including three failure scenarios | `PHASE_8_COMPLETION_REPORT.md` |
| P9 | Final QA and release | **Release candidate built** (`windows/out/installer/G-TRADE-Setup-1.0.0.exe`, unsigned). All automated gates green: backend 1,119 ×2, frontend 195, Windows e2e 24 on the final payload. **Not releasable** until the owner/QA gates are done (signing, production licence key, elevated Win10/Win11 VM runs, LAN test, EULA). | `PHASE_9_FINAL_RELEASE_REPORT.md` |

## Where things are

| Path | What |
|---|---|
| `backend/config/settings_local.py` | Windows-edition settings (fail-closed) |
| `backend/apps/licensing/` | Licence verification, enforcement, API (local edition only) |
| `backend/apps/common/edition.py`, `local_views.py`, `management/commands/local_create_admin.py` | Edition hooks, backup API, first admin |
| `windows/gtrade_ctl/` | Installer, maintenance and update engine (`gtrade-ctl`) |
| `windows/gtrade_server/` | GTrade-App service entry point (Waitress) |
| `windows/desktop/` | Electron app + electron-builder config |
| `windows/installer/` | NSIS wizard (`installer.nsh`), EULA placeholder |
| `windows/tooling/` | Pinned runtime (`runtime_pins.json`), `build_runtime.py`, `build_frontend.py` |
| `windows/tests/` | Engine tests, real-stack e2e harness, elevated smoke script |
| `licensing_service/` | Vendor licensing service (separate deployable) |
| `windows/out/` (git-ignored) | Build cache, stage, installer, evidence, logs |

## Open owner decisions

Decision IDs are as in `ARCHITECTURE_DECISION_REGISTER.md`.

| ID | Decision | Needed for |
|---|---|---|
| D4 | Licensing service hosting, KMS/HSM, key owner, recovery | Production licences |
| D5 | Final pricing dimensions (defaults implemented) | Licence keys |
| D6 | Code-signing route (Azure Trusted Signing vs OV/EV) | Any distribution |
| D8 | Legal publisher name, icon, EULA | Signing certificate, installer |
| D9 | Update channels / cadence (`stable` only implemented) | Post-v1 |
| New | Adopt the patched dependency set for the **cloud** `requirements.txt` too (same advisories affect production) | Security |
