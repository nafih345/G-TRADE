# Phase 7: Licence Management (Completion Report)

**Date:** 2026-11-12 · **Status:** implemented and tested with **development keys only**.

Production signing needs an owner-provisioned KMS/HSM key (D4), so no production key exists anywhere: none was hardcoded, generated or used. No external account, certificate or paid service was created.

## 1. Architecture

```
Vendor side (separate deployable)                      Customer installation (Windows edition)
licensing_service/gtrade_licensing                     backend/apps/licensing (config.settings_local only)
  WSGI: /v1/activate /v1/checkin /v1/deactivate          verify-only: embedded PUBLIC keys
        /v1/crl /v1/health                                state.evaluate(): one verdict for the install
  admin CLI only (create-key/extend/revoke/respond)      enforcement hooks: users, companies, branches, modules
  KeyProvider: devfile (dev only) | kms (production)     middleware: read-only (402) when the verdict says so
  SQLite store, key hashes only                         /api/licensing/ status, activate, import, checkin, request
```

- **Signing:** Ed25519.
  - Licence: `GTL1.<b64url payload>.<b64url sig>`. CRL: `GTC1…`.
  - The prefix is part of the signed bytes, so a CRL cannot be replayed as a licence or the other way round (tested).
  - The two sides use separate code (`format.py` signs, `licfmt.py` verifies); the tests sign with one and verify with the other.
- **Keys:**
  - `apps/licensing/keys.py PRODUCTION_KEYS = {}` until the key ceremony.
  - Development keys (`gtl-dev-*`) are loaded from a file only when `GTRADE_LICENSE_DEV_MODE=1`.
  - Dev mode raises `ImproperlyConfigured` in a release build (`RELEASE` marker).
  - The vendor's `DevFileKeyProvider` refuses to run when `GTRADE_LICENSING_ENV=production`.
  - `KmsKeyProvider` is a stub that raises with the exact owner steps.
- **Separation from the cloud:** the app is in `INSTALLED_APPS` only in `config.settings_local`. `manage.py makemigrations --check` under the cloud settings gives "No changes detected". The cloud URLs, middleware and test runs are unaffected; the test module skips itself on cloud settings.

## 2. Requirements → implementation

| Requirement | Implementation |
|---|---|
| Customer activation | Online: `POST /api/licensing/activate/ {key}` or `gtrade-ctl license activate` (key on stdin) → vendor `/v1/activate` → signed licence, **re-verified locally**. Offline: `license request` writes a request file; the vendor runs `respond`; the customer runs `license import`. |
| Unique installation identity | `install_id` (UUIDv4 created by `gtrade-ctl configure`, never changed by upgrade or repair) plus the machine fingerprint v1: 5 salted SHA-256 component hashes (MachineGuid, system volume serial, BIOS UUID, CPU, MAC). Raw values never leave the PC. |
| Key validation | Vendor side: the key format `GTxx-xxxxx-…` is stored as a SHA-256 hash only. Activation caps (default 2 active installs), idempotent per install, deactivate frees a slot, rate limit 30/min per IP, 32 KB body limit, no admin HTTP surface. |
| Expiry | `valid_until` + `grace_days` → `GRACE` (full use) → `EXPIRED` (read-only). |
| Editions | `edition` (STANDARD, PROFESSIONAL, ENTERPRISE) and `deployment` in the payload; shown in status. |
| Named-user limit | `check_seat_available` → `enforcement.check_users`: active users across the organization against `limits.users` |
| Company limit | `organizations.create_company` uses the **licence** limit instead of `Organization.max_companies` in the local edition |
| Branch limit | `BranchViewSet.perform_create` / `activate` → `branches_per_company` and `branches_total` (403 with the reason) |
| Module entitlement | `module_access.tenant_access_config` / `subscribed_modules`: licence modules ∩ company modules. In the local edition tenant #1 is the customer company, not a platform account. |
| Update entitlement | `updates_until` vs the release date (`manage.py license update-allowed`; used by the Phase 8 updater). The current version keeps working forever. |
| Status display | `/api/licensing/status/` (verdict, limits, usage, install id). `LicenseBanner` (evaluation, grace, read-only, revoked, invalid). `/#/license` page with Activate online, Import file and Check now. `/api/health/` → `license.status`. |
| Offline grace | Perpetual: no check-in needed. Subscription: `checkin_days` (default 30), then `grace_days`. Machine change beyond tolerance: 14-day grace. Revocation: 7-day notice. |
| Revocation and renewal | Check-in returns a signed CRL plus a renewed licence. Revoked → `REVOKED` (notice period, then read-only). An **older CRL cannot lift** a revocation, and an older licence cannot replace a newer one (replay guard). |
| Secure server-side validation | All decisions are made in the backend. The frontend and Electron only display. Limits are re-read from the signed licence on every check, never from DB columns. |
| Clock tampering | Every date is evaluated against max(now, highest time ever seen). Setting the clock back cannot extend validity (tested), and it raises a warning. |
| Read-only mode | `LicenseEnforcementMiddleware`: `/api/` writes get 402 `license_read_only`. Sign-in, licensing, backups, security and health stay writable, and **all reads stay available** (data is never locked away). |
| Evaluation | No licence → 30-day `EVALUATION` (1 company, 1 branch, 2 users), then read-only until activation. |
| Dev/test mode | Dev keys, the vendor devfile provider, and `GTRADE_FP_OVERRIDE` (honoured only in tests or dev mode) to simulate other machines. |

## 3. Additional local-edition guards (from Phase 2 gaps)

| Gap | Fix |
|---|---|
| **G8**: a second organization on a local install | `pre_save` guard: a Windows installation holds exactly one organization (tested) |
| **G9**: company limit set by the platform admin | Now taken from the licence (local edition) |
| `wipe_database` on a customer PC | Disabled in the local edition (tested) |
| Initial administrator | `local_create_admin`: input on stdin, Django password validators, only on a DB with no users. The admin is SUPER_ADMIN plus org admin, **never `is_superuser`**, so no platform-owner powers exist on a customer install (tested). |

## 4. Migrations

| App | Migration | Contents | Where applied |
|---|---|---|---|
| `licensing` (new, local only) | `0001_initial` | `LicenseState` (singleton), `LicenseEvent` (audit) | Only on Windows-edition databases, by `gtrade-ctl migrate`. Applied to disposable test clusters. **Not** applied to the dev DB or Neon, and invisible to the cloud. |

## 5. Tests

| Suite | Result |
|---|---|
| `licensing_service/tests/test_service.py` (8 tests) | **8/8 OK**: key hashed, signed and bound, idempotent, activation cap, check-in renewal, `extend` keeps untouched fields (a bug found and fixed), revocation → CRL, deactivation frees a slot, WSGI limits (405/413/400/429, no admin route), dev key refused in production, CRL/licence not interchangeable |
| `apps/licensing/tests.py` under `config.settings_local` on a **disposable PostgreSQL 17 cluster** (`windows/tests/run_local_django_tests.py`), 21 tests | **21/21 OK**: evaluation → ended → 402 on writes, reads OK, recovery by import; tampered, foreign-key, other-install, unknown-key and wrong-format licences refused; dev keys refused without dev mode and in release builds; API admin-only; replay refused; grace/expired; clock rollback; subscription check-in; 2 hardware changes tolerated, another machine → grace → read-only; revocation notice and old CRL; named-user limit; branch limit through the real API (403 with the licence message); company and module limits from the licence; update entitlement; health; **real HTTP activation, check-in and revocation against the vendor service**; HTTPS required outside dev loopback; single organization; wipe disabled; admin creation |

## 6. Owner decisions and actions remaining

| # | Action |
|---|---|
| D4 | Choose the hosting and KMS/HSM for the licensing service and name the key owner. Create the Ed25519 key **inside** the KMS. Implement `KmsKeyProvider.sign` with that provider's SDK. Paste the public key into `PRODUCTION_KEYS` with a new key id. |
| D5 | Confirm the pricing dimensions (defaults implemented: named users, companies, branches, modules, edition, update period). |
| — | Host the service behind HTTPS with a public certificate. Set `GTRADE_LICENSE_SERVICE_URL` (and optionally a pinned CA) in the release build's `gtrade.env` template. |
| — | Privacy notice for the activation data (install id, fingerprint hashes, IP for fraud review) and its retention period. |
