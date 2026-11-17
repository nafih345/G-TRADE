# G-TRADE ERP — Multi-Client (Customer) Isolation Audit

**Date:** 2026-11-11 · **Scope:** read-only review of how one customer's data is kept away from
another's, in the cloud today and in the planned Windows editions. No code, migrations or data
were changed. Parent document: `COMMERCIAL_WINDOWS_ARCHITECTURE.md`.

Legend: ✅ in place · ⚠️ partial / needs work · ❌ missing

Terminology used throughout:
- **Customer** = the paying organisation that buys a licence (new `Organization` concept).
- **Company** = a legal entity with its own books. In the proposed model, one company = one `common.Tenant`.
- **Tenant** = the existing isolation unit (`common.Tenant`, `tenant_id` on rows).

---

## 1. Summary

The existing cloud isolation is **row-level, enforced in the ORM**, and is the strongest part of
the codebase for this project. It covers views, services, signals, background threads, raw-SQL
counters and caches. It was built after a real incident (two test clients saw each other's data,
2026-11-02) and has dedicated test modules (`apps/common/tests_tenancy.py`, `tests_tenant_crud.py`).

For Windows installs, the recommendation is **physical isolation by installation**: one customer per
installation and one PostgreSQL database per installation. The row-level layer is kept switched on
inside it as defence in depth, and to separate that customer's companies (see the company audit).

Issues found:

| # | Finding | Severity | Applies to |
|---|---|---|---|
| I1 | `/media/` files (company logos, product images, **purchase attachments**, import files) are stored in shared, un-prefixed folders and served **without authentication or tenant check** | High (cloud) / Medium (LAN) | Cloud + LAN |
| I2 | Server-wide backup, restore, security settings and audit log are disabled once >1 tenant exists (`SingleTenantInstall`, `apps/security/views.py:49`). Multi-company-as-tenant would switch them off for every multi-company customer. | High (functional) | Local multi-company |
| I3 | `User` is global with a single `tenant` FK; username is globally unique | Medium | Multi-company memberships, cloud username collisions between customers |
| I4 | 79 `AllowAny` permission declarations. Data stays safe because the tenant scope is strict without a token (empty querysets, refused writes), but each one is a place where a future change could expose data. | Medium (latent) | Cloud + local |
| I5 | `tenancy.unscoped()` is used in 4 modules (`tenant_data.py` ×4, `superadmin_views.py`, `ensure_tenant_defaults`, `import_engine.py`) | Low (reviewed: platform-only or explicit tenant) | Cloud |
| I6 | No automated test asserting isolation for **every** registered model and every list endpoint | Medium | Cloud + local |
| I7 | `config/database.json` on the dev PC holds a real Postgres password in plaintext (git-ignored) | Low | Dev |

## 2. Existing isolation mechanisms (verified)

| Mechanism | Location | Status | Notes |
|---|---|---|---|
| `tenant` FK on business rows | `TenantOwnedModel`, `BaseUUIDModel` (`apps/common/models.py`) | ✅ | Global by design: `User`, `Tenant`, `DataResetMarker`, `apps.security` models |
| Signed tenant claim | `security.policy.issue_tokens` → `tenant_id` | ✅ | Pre-tenancy tokens fall back to `user.tenant` and cannot be refreshed |
| Request scoping | `TenantContextMiddleware` (`apps/common/tenant_context.py`) | ✅ | Runs before branch middleware; inactive/deactivated tenants get no scope |
| ORM auto-filter | `TenantQuerySet` (`apps/common/tenancy.py:171`) | ✅ | Filters at clone/execution time, so class-level `queryset=` attributes are safe |
| Write guard | `tenancy.check_write` | ✅ | Stamps the tenant; refuses cross-tenant saves and cached FKs to other tenants |
| Unscoped requests | strict mode | ✅ | `/api/` without a token sees nothing and cannot write |
| Per-tenant uniqueness | `UniqueConstraint(['tenant', X])` + `tenant_serializers.install()` | ✅ | |
| Raw SQL counters | `common/sequences.py` (adds `tenant_id`), `barcode_utils.py:208`, `patient_utils.py:145` (update by PK of a tenant-scoped row) | ✅ | Verified in this audit |
| Caches | `hot_cache` keys prefixed with `tenancy.cache_prefix()` | ✅ | |
| Threads / jobs | `tenancy.run_in_thread`, `use_tenant()` | ✅ | Import engine runs as the batch's tenant |
| Module write gate | `install_api_gate` + `WRITE_RULES` (`module_access.py`) | ✅ | Gating only; not isolation |
| Per-client export backups | client data & audit tooling | ✅ | Export-only, not restorable |
| Frontend caches | `utils/masterDataCache.js`, `localDataReset.js` | ✅ | Tenant-scoped keys; reset on scope change |

## 3. Gaps in detail

### I1 — Media files are not tenant-isolated
- Upload paths: `company_logos/`, `product_images/`, `import_batches/`, `purchase_attachments/`
  (no tenant prefix). `/media/` is served by Django/nginx as plain static files.
- Effect: anyone who obtains or guesses a URL can download another customer's file without signing in.
  Purchase attachments (supplier bills) are commercially sensitive. File names are user-chosen, so they are not unguessable.
- Fix (P1, additive):
  1. New uploads go to `t<tenant_id>/<kind>/<uuid>.<ext>` (random names).
  2. Serve **private** kinds (purchase attachments, import files) only through an authenticated
     view that checks tenant and branch, using nginx `X-Accel-Redirect` to `internal` locations.
  3. Logos and product images can stay public but get random names.
  4. A management command moves existing files (copy, verify, then switch the path; never delete first).

### I2 — Backups switched off for multi-tenant databases
- Today "more than one tenant" means "more than one customer", so whole-DB backup/restore would leak data on restore. In the new model, one local database = **one organization** with several companies (tenants).
- Fix (P2): replace the rule with "**more than one organization**". Local installs always pass.
  The cloud keeps today's behaviour (each tenant is its own org).

### I3 — Global users
- `authentication.User` has one `tenant` FK, and `username` is unique across the whole cloud DB.
- Fix (P2): add `UserCompanyMembership(user, tenant, role, is_default, is_active)`, all within one
  organization. `User.tenant` stays as the **home company**, so all existing code and tokens keep working.
  Membership must never cross organizations (DB check via trigger or `clean()` + service-layer guard + test).

### I4 — `AllowAny` surface
- Recommendation: an automated test that enumerates the URL resolver, calls every `GET` without a token
  on a DB with two seeded tenants, and asserts no tenant data appears. Add an allow-list of endpoints that are
  intentionally public (health, login, store branding for the login page).

### I6 — No exhaustive isolation test
- Add a parametrised test over `apps.get_models()` that, for every `TenantOwnedModel`: creates a row in tenant A,
  activates tenant B, and asserts the row is invisible and that saving or updating it is refused.
  This guards future models that forget the base class.

## 4. Local installations: database strategy (requirement A)

| Option | Description | Isolation | Ops cost | Verdict |
|---|---|---|---|---|
| **L-A One DB per installation, one customer per installation** | Each customer's server/PC has its own PostgreSQL cluster and DB. Inside it: one `Organization`, N companies as tenants. | Physical between customers; row-level between companies | Lowest. One backup, one migration run. | ✅ **Recommended** |
| L-B One DB per company | Separate databases per company on the same server | Physical between companies | N migrations per update, N backups, cross-company switching needs DB routing, memberships span DBs | ❌ |
| L-C Several customers on one local server | e.g. an accountant hosting clients | Row-level only | Licence and support complexity | ❌ Not supported. Enforced by the licence (one `org_id` per installation). |

Rules for L-A:
1. `gtrade-ctl init-db` creates exactly one Organization and binds it to the licence `org_id`.
2. The backend refuses to create a second Organization when `GTRADE_EDITION=local`.
3. A restore is refused if the archive's `org_id` differs from the installation's, unless the admin
   explicitly re-keys it (for example a hardware move with a transferred licence).
4. The platform Super Admin console (`/#/superadmin/tenants`) is **not available** locally.
   Company management moves to an org-admin screen (company audit §5).
5. The database role used by the app is not a superuser and owns only the `gtrade` database.

## 5. LAN-specific isolation concerns

| Concern | Status | Action |
|---|---|---|
| DB reachable from workstations | Prevented by design (loopback bind, no firewall rule) | Installer check asserts that `5544` is not listening on a non-loopback address |
| Waitress reachable directly (bypassing nginx) | Loopback bind | Same assertion for `8001` |
| JWT intercepted on the LAN | Plain HTTP was the Phase 1 plan | **HTTPS mandatory** (security checklist §4) |
| Shared Windows user on a till PC | Tokens in `localStorage` | Electron: tokens kept in memory plus a `safeStorage`-encrypted refresh token; idle timeout already exists |
| Media (I1) on the LAN | Unauthenticated | Fix I1 before GA |

## 6. Cloud preservation (requirement A)

- No change to `TenantQuerySet`, the middleware or token issuance, apart from the **additive** `org_id` claim.
- Data migration: one `Organization` per existing tenant (`name = tenant.name`), and `Tenant.organization`
  is set. It is reversible (drop the column). Rehearse it on a **Neon branch copy** of production before applying.
- Platform admin stays `is_superuser AND tenant #1`. Organization-level admins get a new
  `IsOrgAdmin` permission; they never get `unscoped()`.
- Existing cloud tests must pass unchanged. The new isolation tests (I4, I6) run on both SQLite and Postgres.

## 7. Implementation steps (isolation only)

| Step | Phase | Dependency |
|---|---|---|
| 1. Exhaustive model isolation test (I6) and anonymous-endpoint sweep (I4) | P1 | — |
| 2. Media relocation + authenticated private media (I1) | P1 | — |
| 3. `Organization` + `Tenant.organization` + cloud data migration | P2 | 1 |
| 4. `UserCompanyMembership` + cross-org guard + tests (I3) | P2 | 3 |
| 5. Backup rule "single organization" (I2) | P2 | 3 |
| 6. Local guards: single org, restore org check, no platform console | P3/P8 | 3 |
| 7. LAN listener assertions in `gtrade-ctl health` | P4 | — |
