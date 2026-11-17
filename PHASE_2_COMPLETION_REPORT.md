# Phase 2 — Multi-Company Architecture: Completion Report

**Date:** 2026-11-12 · **Branch:** `main`, uncommitted working tree (on top of the uncommitted P1 work)
**Status:** Implemented and tested locally. **Not committed, not deployed. Waiting for approval.**

No connection was made to Neon. Nothing was deployed to Render or Vercel. No production data or
permissions were changed. Phase 3 and installer work were not started.

---

## 1. Summary

| Area | Result |
|---|---|
| Architecture | Organization → Companies (each company = one `common.Tenant`) → Branches → users and records, as approved in decision D1 |
| Company isolation | Reuses the proven tenant enforcement (ORM scoping and write checks). No `company_id` column was added to business models. |
| Company switching | Post-login picker plus a header switcher. The server checks membership and issues a **new session and token** per company. The active company is only ever the signed token claim. |
| Company creation | Organization admins create companies, each with independent default masters. Copying master data is explicit and one-way. |
| Consolidated reports | Read-only sales summary and stock summary, with CSV export. Accounting books are never combined or touched. |
| Migration | Additive. Each existing tenant becomes its own one-company organization with `max_companies = 1`. No business row is touched. Rehearsed on a copy of real data: forward, rollback and re-apply all passed. |
| Tests | Full backend suite **1,105 tests OK**. Phase 2 suite 58 tests. Frontend 23 test files / 195 tests OK. Production build OK. Browser e2e **13/13** |
| Security fixes found on the way | (1) Any signed-in user could change their own `role` through `PATCH /api/auth/profile/` (pre-existing privilege escalation). Fixed. (2) Member sessions were reported as a platform "workspace". Found by the e2e run and fixed. |

## 2. Architecture implemented

```
Organization            common.Organization        NEW  the customer (holds no business data)
 └── Company            common.Tenant              EXISTS  + organization FK (new, nullable)
      ├── Branch        company.Branch             EXISTS  (unchanged; per company)
      └── Users / records  TenantOwnedModel rows   EXISTS  (unchanged; isolated per company)

UserCompanyMembership   common                     NEW  user's access + role in a company other than home
OrganizationAdmin       common                     NEW  who administers the organization
```

* **Home company.** `User.tenant` is unchanged. A user's own `role` applies there, exactly as before.
* **Other companies.** A user can only enter them through an active `UserCompanyMembership`, which
  carries the role they hold **in that company**. Branch access there is that company's own
  `UserBranchAccess` row. It fails closed when missing (P1 decision 1 is unchanged).
* **Organization boundary.** A membership is valid only when the company and the user's home company
  belong to the same, active organization. This is checked in `save()` and in the service layer, and
  re-checked on **every request**. A row forged around `save()` therefore grants nothing (tested).
* **Organization admin.** Explicit `OrganizationAdmin` rows. Existing owners (role `SUPER_ADMIN`)
  were backfilled. Org admins can create companies (up to `Organization.max_companies`), grant or
  revoke memberships, rename companies, copy master data, and read the group summaries. Company
  deactivation stays in the platform console (a billing and retention decision).
* **Platform admin.** Unchanged. The platform console now also shows each client's organization and
  sets its company limit (`PATCH /api/superadmin/tenants/<id>/ {"max_companies": n}`).
* **No `tenancy.unscoped()`** is used anywhere in Phase 2. Work that spans companies runs per company
  under `tenancy.use_tenant(<company>)`, and only over companies the caller is entitled to.

### Request flow

1. Sign-in issues tokens for the **home company**. Claims: `tenant_id`, new `org_id`, `sid`.
   The response lists the companies the user can enter.
2. `TenantContextMiddleware` scopes the ORM to the token's `tenant_id` (unchanged).
3. `check_user_tenant` accepts the token only for the home company, a platform workspace, or a
   company with an active same-organization membership. It also checks the `org_id` claim against
   the company's organization.
4. `token_identity` (used by branch middleware before DRF runs) and `LenientJWTAuthentication`
   apply the **membership role** inside a non-home company. DRF's `request.user` there is a
   read-only copy of the user whose `role` is the membership role. Its `save()` raises, so the role
   can never be written onto the account.

## 3. Database migrations

| Migration | Type | Content | Reversible |
|---|---|---|---|
| `common.0009_organizations` | Schema, additive | `common_organization`, `common_organizationadmin`, `common_usercompanymembership`. Nullable `common_tenant.organization_id` | Yes (drops the new tables and column) |
| `common.0010_backfill_organizations` | Data | For each tenant without an organization: one `Organization` (same name, unique code, `max_companies = 1`), plus `OrganizationAdmin` for that tenant's `SUPER_ADMIN` / superuser accounts. Idempotent. | Yes (clears `organization_id`, deletes organizations and admin rows) |

Why this is safe for existing customers:
* No business table changes. Every existing record stays with exactly the company (tenant) it already
  belongs to. Nothing is split, merged, deleted, truncated or reset.
* `max_companies = 1` means no customer can create a second company until the platform admin (or,
  in P6, the licence) raises the limit. Cloud behaviour is unchanged after the deploy.
* The only change to an existing table is a **nullable** column with no default, so code from before
  Phase 2 keeps inserting tenants (the P1 rehearsal's N2 lesson). Such tenants get an organization
  lazily (`organizations.ensure_organization`) the first time a token is issued for them.
* No other migration in the working tree depends on `common.0009`/`0010`.

## 4. Files changed (Phase 2 only)

**New, backend**
- `backend/apps/common/organizations.py`: membership and role resolution, company-scoped user, org admin, company creation, membership service, copy-master-data, consolidated summaries
- `backend/apps/common/organization_views.py`, `backend/apps/common/organization_urls.py`: `/api/organization/…`
- `backend/apps/authentication/company_views.py`: `GET /api/auth/companies/`, `POST /api/auth/switch-company/`
- `backend/apps/common/migrations/0009_organizations.py`, `0010_backfill_organizations.py`
- `backend/apps/common/tests_multi_company.py`: 58 tests
- `backend/scripts/p2_migration_rehearsal.py`: guarded local rehearsal tool (localhost only, scratch DB only)

**Modified, backend**
- `apps/common/models.py`: `Organization`, `OrganizationAdmin`, `UserCompanyMembership`, `Tenant.organization`
- `apps/common/tenant_context.py`: `company_access_allowed`, `org_id` claim check, membership role in `token_identity`
- `apps/common/authentication.py`: member copy of the user inside a non-home company
- `apps/common/permissions.py`: `request_tenant_id` honours a verified membership
- `apps/common/apps.py`: hot-cache invalidation for the three new models
- `apps/common/tenant_onboarding.py`: each onboarded client gets its own organization. Seats count active memberships.
- `apps/common/superadmin_views.py`, `superadmin_serializers.py`: organization fields and company limit
- `apps/security/policy.py`: `issue_tokens(company_tenant_id=…)` re-verifies membership. `org_id` claim. `/api/organization/` added to sensitive writes.
- `apps/security/backup/policy.py`: final single-**organization** backup rule and organization-aware archive check
- `apps/security/views.py`: with several companies, server-wide backup and security endpoints require an org admin (signed download links included)
- `apps/authentication/serializers.py`: `active_company`, `organization`, `is_org_admin`, `company_count` in the profile. Membership-aware login payload and refresh. `ProfileSerializer` (role read-only). Workspace flag only for the platform owner.
- `apps/authentication/views.py`, `urls.py`: login returns `companies`. Profile update of a member writes contact fields only.
- `apps/purchasing/attachments.py`: signed attachment links follow membership and use the company role
- `apps/company/pricing_rules.py`: below-cost approval uses the approver's role in the current company
- `config/urls.py`: mounts `/api/organization/`

**New, frontend**
- `src/utils/companies.js` and `src/utils/__tests__/companies.test.js` (10 tests)
- `src/pages/CompanySelect.jsx` (post-login picker), `src/components/CompanySwitcher.jsx` (header)
- `src/pages/OrganizationCompanies.jsx` (companies, members, copy masters)
- `src/pages/ConsolidatedSummary.jsx` (group summary + CSV)

**Modified, frontend**
- `src/context/AuthContext.jsx` (`companies`, `pickCompany`, `switchCompany`, `continueInCurrentCompany`)
- `src/App.jsx` (picker gate, `/organization/*` routes), `src/components/Header.jsx`, `src/components/Sidebar.jsx` (Organization menu), `package.json` (`test:companies`)

## 5. Company isolation coverage

A company is a tenant, so every `TenantOwnedModel` / `BaseUUIDModel` row is isolated by the existing
ORM layer. Phase 2 verifies this through the real stack (login → JWT → middleware → DRF) using **the
same user** working in two companies:

| Area | How it is enforced | Verified by |
|---|---|---|
| Products, categories, brands | Tenant-scoped ORM. Per-company uniques. | Lists, direct IDs (GET/PATCH/DELETE → 404), search by name and barcode, same codes allowed per company |
| Customers / patients, suppliers | Same | Lists and direct IDs. Patients are never copied between companies. |
| Inventory, warehouses, stock ledger | Same. Each new company gets its own branch and warehouse. | Ledger lists. Another company's product cannot be sold (stock unchanged). |
| Sales, purchases, returns, payments | Same | Lists and direct IDs. Cross-company FK references refused. |
| Vouchers, journals, chart of accounts | Same. Each company has its own CoA (disjoint IDs). | Journal lists disjoint. Default masters independent. |
| Financial reports and exports | Same | Day Book `?export=xlsx` parsed: other company's names absent. Sales Report by id and customer. |
| Appointments, eye exams, wholesale | Same tenant layer (P1 branch FKs kept) | Covered by the generic tenant tests plus P1 suites (all green) |
| Attachments / files | P1 private storage `private/t<tenant>/…` + authenticated download | Stored under the right company. Other company gets 404. Signed link dies when membership is revoked. |
| Request body `tenant` / `tenant_id` | `editable=False` + ORM stamping | Spoofed body ignored |
| Forged token claims | Signed claim + membership + `org_id` check | Forged `tenant_id` → 401 (AllowAny views too). Wrong `org_id` → 401. |
| Consolidated reports | Loop over the caller's companies under `use_tenant` | Other organization never included. Branch-restricted company excluded. Cost value hidden without the cost right. |
| Branch permissions inside a company (P1) | Unchanged middleware with the **membership role** | Restricted member sees only their branch. Off-limits `X-Branch-Id` → 403. Missing access row → nothing. Home-company access untouched. |

Stock-transfer security (P1 Task 7) is untouched. Its 51 P1 completion tests and 39 branch-isolation
tests pass in the full run.

## 6. Company switching behaviour

* **One company:** no picker and no switcher menu. The header shows the company name. Behaviour is
  otherwise unchanged (tested by API and in the browser).
* **Several companies:** after sign-in a picker lists the home company and active memberships, each
  with the role held there. "Continue in …" keeps the home session. The header chip re-reads the list
  from the server each time it opens.
* **Switch:** `POST /api/auth/switch-company/ {tenant_id}`. The server requires an active user, an
  active same-organization membership, an active company, and a role allowed to sign in. It then
  **ends the current session** (old tokens get 401 at once), opens a new session (2FA state carried),
  and returns new tokens with `tenant_id` + `org_id`. Both companies are audited
  (`COMPANY_SWITCHED`, `COMPANY_SWITCH_IN`). Refusals return the same 403 whether the company does
  not exist or belongs to someone else, and are audited (`COMPANY_SWITCH_DENIED`). Workspace tokens
  cannot switch.
* **Frontend:** stores only what the server returns, drops `active_branch_id`, clears all cached
  business data for the previous company (`clearLocalDataIfScopeChanged`), then reloads.
* **Revocation:** revoking a membership refuses that company's tokens and refresh on the next request
  (immediately in the same worker, within `HOT_CACHE_SECONDS` = 30 s in other workers).
* **Refresh:** keeps the company while the membership holds.

## 7. Migration safety results

**Rehearsal on a disposable copy of the local dev database** (`scripts/p2_migration_rehearsal.py
--copy dump`, via `pg_dump | pg_restore`; the source was only read; the copy was dropped afterwards):

| Step | Result |
|---|---|
| Copy rolled back to `common 0008` (pre-Phase-2 state) | Baseline: 121 tables, 5 tenants, 1,676 rows |
| `migrate --plan` | Exactly `common.0009_organizations`, `common.0010_backfill_organizations` |
| Forward | All 121 pre-existing tables keep their row counts. 5 tenants → 5 organizations, 5 org admins, 0 memberships, `max_companies = 1` |
| Rollback to `common 0008` | New tables gone. All 121 tables keep their row counts. |
| Re-apply | Identical to forward. `migrate --check` clean. |

Also tested in the suite (`OrganizationMigrationTests`): reverse and re-apply on the test database,
with business rows of two tenants kept and still isolated.

**⚠ Local dev database already migrated.** When the backend dev server was restarted at 10:36, its
`AUTO_MIGRATE` boot hook applied `common 0009`/`0010` to the **local** dev DB "G OPTICALS" (never
Neon). I checked it read-only: 5 tenants → 5 organizations, `max_companies = 1`, 5 org admins, 0
memberships. That is the expected state. To undo it: `manage.py migrate common 0008_tenant_defaults_version`
(verified reversible above).

**Other local traces:** one failed-login row for a non-existent username `e2eowner` in the dev DB's
`security_loginattempt`, left by the first browser run before its API override took effect. It is
harmless. I left it because it is an audit record. The scratch databases `gtrade_p2_rehearsal` and
`gtrade_p2_e2e` were dropped. The four `test_G OPTICALS_1..4` databases on the server predate this
work and were left alone.

**Production (Neon) rollback plan:** `migrate common 0008_tenant_defaults_version`. Caveat: companies
**created after** go-live through "New company" have no home users. After a rollback they remain intact
(data kept) but are reachable only through the platform console workspace until Phase 2 is re-applied.

## 8. Test results

| Suite | Result |
|---|---|
| **Full backend suite** (`manage.py test`, local PostgreSQL test DB) | **1,105 tests, OK** (4,136 s). Includes all P1 suites: `tests_p1_completion` 51, `tests_branch_isolation` 39, `tests_tenant_crud` 24, `tests_tenancy` 20, `test_backup_tenant_gate` 18 |
| Phase 2 backend (`apps.common.tests_multi_company`) | **58 tests OK**: model and boundary rules, login and switching, token forgery, revocation, refresh, profile role fix, cross-company read/write/delete, search, reports and xlsx export, branch permissions inside a company, org-admin authorization, other organization blocked, company limit, copy masters, consolidated summaries and CSV, attachments and signed links, backup gate and schedule, migration backfill and rollback |
| After the final workspace-flag fix | `tests_multi_company` + `tests_tenant_crud` (incl. platform workspace tests): **85 OK**. The full suite was **not** re-run after this one-line serializer change. |
| Frontend unit tests (`node --test`, 23 files) | **195 tests OK**, incl. new `test:companies` (10) |
| Frontend production build (`vite build`) | OK |
| Browser e2e (headless Chrome over CDP, dev frontend + scratch backend on its own DB) | **13/13**: picker, switch, header shows company, old token revoked, header switch back, organization pages, button state, single-company user without picker or menu, non-admin redirected |
| Lint | Frontend has no ESLint config (P1 R8). New Python files checked for unused imports. |

## 9. Remaining security gaps

| # | Gap | Severity | Note |
|---|---|---|---|
| G1 | Membership revocation and org-admin removal reach other gunicorn workers within 30 s (`HOT_CACHE_SECONDS`) | Low | Same window as user deactivation and branch access today |
| G2 | Direct Edit switches (`can_edit_*`) are per **user**, not per company | Medium | A user's edit rights apply in every company they enter. Per-company switches need a model change. |
| G3 | Tokens issued before Phase 2 carry no `org_id` and are accepted until they expire (refresh ≤ 7 days) | Low | Company check still applies |
| G4 | Company names are unique server-wide (`Tenant.name`). On the cloud an org admin with a limit > 1 can learn that a name is taken. | Low | Only once a platform admin raises a limit |
| G5 | Usernames remain globally unique (isolation audit I3) | Low | Unchanged |
| G6 | `request.user` is a read-only copy inside a non-home company. Future code that saves `request.user` raises (500) there. | Low (fail-safe) | Documented in `organizations.company_user` |
| G7 | No UI to add or remove organization admins (backfill + DB only) | Functional | |
| G8 | Single-organization guard for local installs (refuse a second organization when `GTRADE_EDITION=local`) | Deferred to P3 | Backup rule already needs ≤ 1 organization |
| G9 | Company limit comes from the platform admin, not a licence | Deferred to P6 | |
| G10 | Archive ownership still cannot tell two installs apart that share the same ids and codes (P1 R2) | Low | Needs an installation id (P8) |
| G11 | Platform console UI does not show the organization or company limit yet (API only) | Functional | |

## 10. Production blockers

| # | Blocker | Owner |
|---|---|---|
| B1 | **Approve Phase 2** (this report) and record D1–D3 in `ARCHITECTURE_DECISION_REGISTER.md` (its approval table is still blank) | Owner |
| B2 | **P1 is not deployed yet.** Its blockers (P1 final approval, Render dashboard values, Neon-branch rehearsal, assigning unassigned users) come first. Phase 2 sits on top of the uncommitted P1 tree. | Owner / admin |
| B3 | Neon-**branch** rehearsal of P1 + `common 0009/0010` (never production itself): `migrate --plan` → `migrate` → organization checks as in §7 → reverse → re-apply | Admin (needs approval to connect to a Neon branch) |
| B4 | Commit (none made) | Owner |
| B5 | Deploy order: backend first. Old and new frontends are compatible both ways (new fields are optional; without them the picker and switcher simply do not appear). | Admin |
| B6 | Decide which customers, if any, get `max_companies > 1`. Everyone stays at 1 after migration. | Owner |
| B7 | Optional: re-run the full backend suite once after the final serializer fix (§8) | Developer |

**Stopped here. Waiting for approval before any commit, deploy, Neon rehearsal or Phase 3 work.**
