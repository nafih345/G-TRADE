# Phase 3: Windows Local Production Runtime (Completion Report)

**Date:** 2026-11-12 · **Status:** complete for everything that can run without Administrator rights.
Registering Windows services needs an elevated test run (§7). Nothing was committed, pushed or deployed.
Neon, Render and Vercel were not contacted. The dev database was not touched: every test used a disposable cluster in a temp folder.

## 1. What was built

| Requirement | Implementation | File(s) |
|---|---|---|
| Embedded Python 3.12 | CPython **3.12.10** embeddable zip (the last 3.12 release with Windows binaries; PSF Authenticode signature checked). Packages are installed from a **hash-pinned lock** that matches the tested venv exactly. `._pth` isolates `sys.path`. The `gtrade_app.pth` hook adds the active app version from `GTRADE_APP_DIR` (embedded Python ignores `PYTHONPATH`, which was verified). | `windows/tooling/build_runtime.py`, `runtime_pins.json`, `backend/requirements-local.txt`, `backend/requirements-local.lock` |
| Django production configuration | `config.settings_local` overlay. It is **fail-closed**: DEBUG is forced off; it refuses a missing, weak or `django-insecure` SECRET_KEY; it refuses SQLite, `DATABASE_URL` and non-loopback DB hosts; it refuses `runserver`. Other settings: AUTO_MIGRATE off, secure cookies, proxy SSL header, CORS same-origin, data/log/backup paths under the data root, rotating logs, manifest static. The cloud `config.settings` is unchanged. | `backend/config/settings_local.py` |
| Waitress WSGI server | `python -m gtrade_server`. Loads `gtrade.env` and the DPAPI secrets, waits for the DB with backoff, and **never migrates**. A schema gate answers 503 `schema_out_of_date` while migrations are pending, and a maintenance gate answers 503 during updates and restores. Health endpoints stay open. Waitress binds loopback only, trusts X-Forwarded-* only from 127.0.0.1, uses 16 threads and handles graceful shutdown on Ctrl+C/Ctrl+Break. | `windows/gtrade_server/` |
| WinSW services | XML generator for `GTrade-App` (depends on `GTrade-DB`) and `GTrade-Web` (depends on `GTrade-App`). Both run as NETWORK SERVICE, restart after 5/10/30 s with the counter reset after 1 h, and roll their logs by size. `GTrade-DB` is registered with `pg_ctl register -S auto`. Commands are planned first (dry run), then run elevated. | `windows/gtrade_ctl/services.py` |
| nginx reverse proxy | Generated config: TLS 1.2/1.3 only, no port-80 listener, `server_tokens off`. Security headers: CSP, X-Frame-Options, nosniff, Referrer-Policy, HSTS, Permissions-Policy. `/api`, `/admin` and `/media` are proxied to Django (so media keeps the P1 public-only rule). SPA plus `/static`. The writable prefix is in the data root. | `windows/gtrade_ctl/nginx.py` |
| Localhost and LAN HTTPS | A per-install ECDSA P-256 CA (10 y) and a server certificate (397 d). SAN = localhost, 127.0.0.1, ::1, hostnames and IPs. Renewal happens under 30 days left or when the host list changes, and **keeps the CA**, so workstation pins survive. Standalone binds 127.0.0.1; LAN Server binds 0.0.0.0 behind one Private-profile firewall rule. | `windows/gtrade_ctl/certs.py`, `firewall.py` |
| Environment-based configuration | `install.json` (mode, version, ports, install id, history) and `gtrade.env` (non-secret only). An upgrade cannot change the mode or the install id. | `windows/gtrade_ctl/install_config.py` |
| Secret generation and storage | CSPRNG: SECRET_KEY (86 chars), DB app and superuser passwords (32 chars, connection-string safe), licence store key. Stored with **DPAPI machine scope plus app entropy**, ACL'd, never overwritten on repair or update, never on a command line or in logs. | `windows/gtrade_ctl/secrets_store.py`, `winacl.py` |
| Health check | `/api/health/` gains additive fields: `edition`, `mode`, `server_version`, `min_client_version`, `install_id`, `maintenance`. The cloud only gains `"edition": "cloud"`. `gtrade-ctl health` checks over pinned TLS through nginx. | `backend/config/urls.py`, `backend/apps/common/edition.py`, `windows/gtrade_ctl/health.py` |
| Logs | App: `logs\app\backend.log` and `error.log` (10 MB × 10). nginx: `logs\web`. PostgreSQL: `logs\db` (daily rotation). WinSW: `logs\services`. gtrade-ctl uses JSONL step logs with **secret redaction** (key names, `password=` pairs, URL credentials, licence keys). | `settings_local.py`, `windows/gtrade_ctl/log.py` |
| Support bundle | `gtrade-ctl diagnostics` zips logs and config with redaction. It excludes keys, secrets, licences, dumps and media. | `windows/gtrade_ctl/diagnostics.py` |
| CLI | `gtrade-ctl` commands: configure, prepare-data, secrets, cert, nginx-conf, init-db, verify-db, migrate --plan/--apply, collectstatic, services, firewall, health, diagnostics. Each prints JSON and returns a documented exit code. | `windows/gtrade_ctl/cli.py` |

## 2. Changes to shared (cloud) code

These are additive only:
- `backend/config/urls.py`:
  - `/api/health/` returns an extra `edition` block. The cloud gets only `"edition": "cloud"`.
  - The public media route is now also wired when `GTRADE_EDITION == 'local'`.
- `backend/apps/common/edition.py` (new): edition helpers plus a health-hook registry.

Cloud regression checks:
- `manage.py check` under `config.settings`: no issues.
- `apps.common.tests` health test: OK.
- The full suite runs in Phase 9.

## 3. Tests

| Suite | Tests | Result |
|---|---|---|
| `windows/tests/test_runtime.py` | 23 tests: redaction, layout, DPAPI round-trip and tamper, never-overwrite, config validation, env without secrets, CA/cert chain verification, renewal keeps the CA, nginx bind and headers, WinSW XML, elevation refusal, firewall scope | **23/23 OK** |
| `windows/tests/test_e2e_stack.py` (real stack, `GTRADE_E2E=1`) | 10 tests | **10/10 OK** (152 s) |

What the end-to-end run did on this PC (Windows 11 Home 10.0.26200, not elevated):
1. Used the staged runtime: the embedded Python and the **bundled** PostgreSQL 17.10 copy.
2. Created a fresh cluster.
3. Applied 164 migrations from empty (107 s provisioning).
4. Ran collectstatic, created certificates and generated `nginx.conf`.
5. Started the app server and nginx 1.30.6 exactly as the services would.

Checks performed:
- Health is OK over pinned TLS: `edition=local`, `debug=false`, `cors=same-origin`.
- Security headers are present, and the API answers 401 without a token.
- The system trust store rejects the certificate (it is pinned to our CA only).
- Plain HTTP on the TLS port gets 400.
- Nothing is reachable on the LAN IP in Standalone mode.
- The maintenance flag gives 503 on the API while health stays up.
- **Graceful stop: exit 0 in 1.3 s.** nginx answers 502 while the app is down, and health is restored after restart.
- **Hard-kill crash:** the app restarted to healthy.
- No secret value appears in any log, `gtrade.env`, `install.json` or `nginx.conf`.
- `runserver` is refused, DEBUG=True is ignored, and a `django-insecure` key is refused.

Evidence: `windows/out/evidence/stack_e2e.json`.

## 4. Supply chain (third-party runtime)

| Component | Version | Verification |
|---|---|---|
| Python embeddable | 3.12.10 | SHA-256 pinned; Authenticode **valid** (Python Software Foundation) |
| Python packages | 28, exact | `--require-hashes --no-deps` from `requirements-local.lock`. In Phase 9 this was replaced by the security-patched set: 0 known vulnerabilities, full suite green. |
| nginx | 1.30.6 (stable) | SHA-256 pinned; **PGP signature good** (key D6786CE3…5C0A). The exe is **not** Authenticode-signed upstream. |
| WinSW | 2.12.0 | SHA-256 pinned. **Unsigned** upstream. |
| PostgreSQL | 17.10 | Copied from the EDB install, without pgAdmin, docs, headers or symbols. |

Payload size: Python 152 MB, PostgreSQL 141 MB, WinSW 18 MB, nginx 6 MB.

## 5. Security and data-integrity review

- Secrets never leave DPAPI except into the child process environment.
- Only nginx listens beyond loopback, and only in LAN Server mode.
- DB passwords reach libpq through `PGPASSWORD` in the child environment. The `initdb` password file is overwritten and deleted.
- There is no code path that migrates on start. Schema changes happen only through `gtrade-ctl migrate --apply` (Phase 8 wraps that with a pre-update backup).
- CSP keeps `script-src 'unsafe-inline'`. This is deliberate: print previews render inline scripts in same-origin popups that inherit the policy. The rest of the policy still blocks plugins, foreign framing, base-tag hijack and off-site form posts. Removing it needs the print code to move to external scripts (open item).

## 6. Decisions taken in this phase

- **D7** (TLS on loopback): implemented as recommended. The same TLS code path is used in every mode.
- **D8** (naming): product name "G-TRADE ERP" and appId `com.gtrade.erp` are used in new code. The legal publisher name stays a placeholder (owner decision).
- Licensing is registered only in `config.settings_local`, so cloud deploys never see its migrations. A running dev `runserver` would otherwise auto-apply them to the dev DB.

## 7. Not verifiable here / open items

| Item | Why | Exact remaining action |
|---|---|---|
| `winsw install` / `pg_ctl register` / `sc start` as real services | Needs Administrator; this session is not elevated | Run `windows/tests/elevated_smoke.ps1` (Phase 6) in an elevated prompt on Win10 and Win11 |
| Authenticode signing of nginx.exe, WinSW copies, our exes | Needs the code-signing certificate (D6) | Owner procures the certificate; the sign step is wired in Phase 6 |
| CSP without `unsafe-inline` scripts | Print code uses inline scripts | Refactor print templates (post-v1) |
| Bundled Google Fonts in the local SPA | Offline shops fall back to system fonts | Handled in Phase 5 (font links stripped in the local build) |
