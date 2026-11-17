# P1 — Final Release Readiness

**Date:** 2026-11-11 · **Branch:** `main`, uncommitted working tree · **Verdict:** see §9.

Nothing was committed, pushed or deployed. Production (Render + Neon) was not connected to. The local
development database was backed up before any database work and was not reset or modified by this
verification (§5). P2, Electron and the Windows installer were not started.

Companion documents: `P1_COMPLETION_REPORT.md`, `P1_MIGRATION_REPORT.md`, `P1_TEST_RESULTS.md`,
`P1_REMAINING_SECURITY_GAPS.md`, `P1_BACKUP_AND_RESTORE_VERIFICATION.md`, `P1_DEPLOYMENT_REHEARSAL_PLAN.md`,
`DEPLOYMENT.md` (new section "Database migrations (release procedure)").

---

## 1. Final status of the nine P1 tasks

| # | Task | Status | Notes |
|---|---|---|---|
| 1 | Accounting security | ✅ Done | Company-wide accounting tools refused to branch-restricted users; settlements scoped. |
| 2 | Purchase attachment security | ✅ Done | Private random paths, signed 60 s links, signature checks. Render disk is still ephemeral (G7). |
| 3 | Backup & restore isolation | ✅ Done (interim rule) | Whole-DB backup only while ≤ 1 tenant; final rule waits for D1 (P2). |
| 4 | Stable user-ID branch access | ✅ Done | Plus decision 1 (fail-closed) applied in this verification. |
| 5 | Wholesale branch relationships | ✅ Done | Historic journals stay Unassigned unless evidence exists (decision 3). |
| 6 | Eye exams and appointments | ✅ Done | Patients stay company-wide within one company (decision 4). |
| 7 | Stock transfer workflow | ✅ Done | `company.0017` now applied locally (§5). |
| 8 | Remaining branch gaps | ✅ Done | G2/G10 (Stock Overview quantities) closed by decision 2 in this verification. |
| 9 | Testing | ✅ Done | 1027 → **1045** backend tests, all passing (§4). |

## 2. Approved policy decisions and their technical implications

### Decision 1 — Users without a branch assignment are denied branch-scoped access

*Rule:* in Multi-Branch mode, only **explicitly unrestricted** users see every branch: an admin role
(`SUPER_ADMIN`, `ADMINISTRATOR`, superusers) or a `UserBranchAccess` row with "all branches". A user
with no row has **no** branch.

*Implemented (this verification):*
- `apps/common/branch_context.py` — `_resolve()`: no row → `allowed_branch_ids = set()` (was `None` =
  all). `user_branch_permitted()` (signed download links) follows the same rule.
- `apps/company/views.py` — branch-context endpoint never reports a branch the caller cannot use as
  "active", and returns `no_branch_access: true` for an unassigned user.
- Frontend `BranchContext.jsx` does not fall back to the default branch for such a user and clears
  the stored branch; `Header.jsx` shows a red "No branch assigned" chip.

*Implications:*
- An unassigned staff user signs in but sees no branch-scoped records (sales, wholesale, exams,
  stock quantities, branch-filtered reports), cannot create branch-scoped documents (403), and cannot
  use company-wide accounting tools. Asking for a branch with `X-Branch-Id` is refused (403).
- **Single-branch mode is unchanged** (everyone uses the default branch, as before).
- Admin roles without a row stay unrestricted (by role, which is explicit).
- **Deploy impact:** any existing non-admin user in a Multi-Branch tenant without an access row loses
  access on deploy until an admin assigns branches. Local data: **0 such users**. Run this on a Neon
  branch before deploying and assign those users first:

```sql
SELECT u.tenant_id, u.username, u.role FROM authentication_user u
 WHERE u.is_active AND NOT u.is_superuser
   AND upper(coalesce(u.role,'')) NOT IN ('SUPER_ADMIN','ADMINISTRATOR')
   AND EXISTS (SELECT 1 FROM company_businesssettings s WHERE s.tenant_id=u.tenant_id AND s.multi_branch_enabled)
   AND NOT EXISTS (SELECT 1 FROM company_userbranchaccess a WHERE a.user_id=u.id AND NOT a.is_deleted);
```

- New staff created in a Multi-Branch tenant must be given branch access as part of creation; until
  then they see nothing. This closes G1 / P1-Q1 (the earlier "option (b)" setting is not needed).

### Decision 2 — Stock Overview quantities and history respect the user's branch scope

*Implemented (this verification), for branch-restricted users only; unrestricted users and
single-branch installs see exactly what they saw before:*
- `on_hand` = the product's `BranchStock` summed over the user's permitted branches (0 where they
  hold none). Used by the grid's quantity, stock status, status filters, ordering, summary cards
  (quantity, low/out counts, purchase/selling value), scan lookup, CSV/XLSX export and history's
  product row. Responses carry `quantity_scope: "branches" | "company"`.
- Lifecycle columns (purchased, ordered/reserved incl. wholesale orders, sold, available, return
  stock) count only documents of permitted branches. This closes G10 for Stock Overview.
- **Adjustments:** a restricted user counts *their* figure. The difference is applied to their
  active branch, which must be one of theirs (no fallback to the client's default branch). A count
  that would take that branch below zero is refused, and the stale-figure check (409) compares
  against the branch figure.
- Excel import review (`import-batches`, `import-review`) compares sheet quantities with
  company-wide totals, so it now needs every-branch access (403 for restricted users).
- History was already scoped (Task 8).

*Implications:*
- Stock held only as a legacy company-wide `Product.stock` total with no `BranchStock` row belongs to
  no branch and shows as 0 to restricted users (consistent with "Unassigned" elsewhere). The first
  stock movement seeds `BranchStock` (existing `adjust_branch_stock` behaviour).
- Documents with no branch (legacy, Unassigned) are left out of restricted users' lifecycle figures.
- Not changed: POS / New Sale availability and the "Ordered" reservation figure outside Stock
  Overview still use company-wide quantities (see §8, R4).

### Decision 3 — Historic wholesale journals: branch only on reliable evidence

Already the implemented behaviour: migrations `sales.0038` / `0039` assign a branch only by the
evidence rules W1–W4 / E1–E2 and never use the default branch as a guess. Posted journals are never
tagged automatically. `branch_backfill_report --wholesale-journals` is a dry run unless `--apply` is
given, and writes a `FinancialAuditLog` per journal it tags. Anything without evidence stays
**Unassigned** (`branch = NULL`): unrestricted users see it, restricted users do not, and branch P&L
excludes it. No code change was needed.

### Decision 4 — Patients shared between branches of the same company only

Already the implemented behaviour: `Customer` (patient master) rows are tenant-scoped (one company
per tenant), not branch-scoped. Every branch of that company can open the patient, subject to role
and module permissions; eye-exam visits and appointments are branch-scoped (Task 6). Tenant row
isolation (`tenant` FK + ORM auto-scope + JWT tenant claim) prevents any cross-company access.
*Implication for P2:* when a tenant can hold more than one company (D1 / G11), `Customer` needs a
company key and the patient queries must filter on it. The rule "never share between companies" must
then be enforced by company, not only by tenant.

### Decision 5 — `AUTO_MIGRATE=False` in production; migrations controlled by an administrator

*Implemented (this verification):*
- `apps/common/startup.py`: on a managed host (Render / Vercel / Lambda) the boot hook defaults to
  **off** when `AUTO_MIGRATE` is unset. Only an explicit `AUTO_MIGRATE=True` turns it on. Local and
  desktop defaults are unchanged. The on-demand `run_migrations_now()` honours the same switch.
- `backend/build.sh`: `migrate` runs only when `RUN_MIGRATIONS=True`. Otherwise the build prints
  the pending migrations and continues.
- `render.yaml`: `AUTO_MIGRATE: "False"`, `RUN_MIGRATIONS: "False"`.
- `DEPLOYMENT.md`: env table updated and a new **Database migrations (release procedure)** section
  (backup → Neon-branch rehearsal → approval → apply → reset → verify → rollback).

*Implications:* code that needs a new schema must not go live before an administrator applies its
migrations. Until then `/api/health/` reports `"migrations": "pending"` and the app shows the red
banner. The live Render service was created by hand, so **its dashboard values must be changed by
hand** (`AUTO_MIGRATE=False`, `RUN_MIGRATIONS=False`): `render.yaml` is not applied automatically.

## 3. Frontend production build

| Item | Result |
|---|---|
| Machine memory at start | 7.2 GB total RAM; **~0.4 GB free / ~0.8 GB available**; commit 23.5 of 31.3 GB (pagefile absorbing load) |
| Node / heap limit | Node 24.18.0; V8 default heap limit 2,240 MB. **Not increased.** |
| Build dependencies | `node_modules` present; Vite 7.3.6, React 19 |
| Concurrency | Run alone, with no backend test run in parallel (the earlier OOM happened while the backend suite was running) |
| Run 1 (P1 code as reported) | `npm run build` **exit 0**, built in 58.9 s, no errors |
| Run 2 (final, after this verification's frontend edits) | `npm run build` **exit 0**, built in 38.6 s, 0 errors / 0 warnings in the log (~0.5 GB available at the time). `dist/` 4.1 MB; contains the Branch Transfers chunk and the new no-branch notice. Log: `backups/p1-final/build_final.log`. |
| Note | The local build picks up the git-ignored `frontend/.env` (`VITE_API_URL=http://localhost:8000`; Vite prints a notice). That is correct for local/desktop. Vercel builds without it, as `DEPLOYMENT.md` §2 describes. |

The earlier failure was the combination of low free memory and a parallel backend test run, not the
code. No memory-limit flag was needed.

## 4. Backend and frontend test results

| Check | Result |
|---|---|
| Full backend suite `manage.py test apps` (fresh test DB) | **Final run: 1045 tests, OK** (0 failures, 0 errors; 2,742 s). Log: `backups/p1-final/full_suite_final.log`. First run of this verification: 1045 run, **2 failures** (see below), fixed, then the whole suite re-run. |
| First-run failures | `financial.tests.test_cashbook.CashbookBranchTests.test_branch_filter_scopes_rows_and_opening` (403) and `financial.tests.test_daybook.DayBookBranchTests.test_branch_scope_is_enforced` (0 rows instead of 2). Cause: their "sees every branch" caller was an Accountant **with no access row** in Multi-Branch mode, which is the fail-open default that decision 1 removes. Fix (tests only): that caller now has an explicit all-branches access row. The restricted-user assertions in both tests are unchanged and pass. |
| New tests this verification (`apps/common/tests_p1_policy_decisions.py`) | 18 tests, all pass: decision 1 (8), decision 2 (7), decision 5 / production config (3) |
| Existing P1 security regression tests (`tests_p1_completion`, `tests_branch_isolation`, `financial/tests/test_branch_authorization`, `security/tests/test_backup_tenant_gate`) | Included in the full run all pass |
| `manage.py check` | No issues |
| `manage.py check --deploy` (simulated Render env, no DB access) | 2 warnings: `security.W004` (HSTS) and `security.W008` (SSL redirect). Advisory: Render terminates TLS and redirects HTTP at its edge. See R6. |
| `makemigrations --check --dry-run` | No changes detected |
| `migrate --plan` (local) | No planned operations |
| Frontend unit tests (`node --test`, all 22 files incl. the unwired `inventoryCache.test.js`) | **185 / 185 pass** |
| Frontend lint | **Not run:** the project has no `eslint.config.*` (ESLint 9+ needs one). Pre-existing; not added here. |

## 5. Local database (`G OPTICALS` on localhost, PostgreSQL 17.10)

**Backup first:** `backups/p1-final/G_OPTICALS_pre_p1_final_20261111_215615.dump` (pg_dump custom
format, 780,022 bytes, SHA-256 `4f05b999bf801a26d840eeb74b0b4e2556d4d25f4c373bf58c13ef064d788d29`;
`backups/` is git-ignored). **Restore verified:** restored into a scratch database with identical
per-table row counts (121 tables, 1,813 rows).

**Applied P1 migrations: all ten.**

| Migration | Applied (local time) | By |
|---|---|---|
| company 0013, products 0026, purchasing 0016 | 18:01 | AUTO_MIGRATE boot hook (dev server reload) |
| company 0014–0016 | 18:03 | AUTO_MIGRATE boot hook |
| sales 0037–0039 | 18:13 | AUTO_MIGRATE boot hook (logged) |
| **company 0017_stock_transfer_workflow** | **21:54:17** | a manual `python manage.py migrate` (shell history), run just before `runserver` started at 21:54:25 |

*Why the earlier report said 0017 was unapplied:* it was true when that report was written. No dev
server had restarted since the file was created. It has since been applied by the manual `migrate`
above, not by this verification. `company_stocktransfer` and `company_stocktransferevent` are empty,
so nothing depends on it yet.

**Migration graph:** consistent: no conflicts, no unapplied migrations, models in sync.

**Reversibility (as documented in `P1_MIGRATION_REPORT.md` §5):** confirmed statically (schema
operations are auto-reversible; `company.0015` has an explicit reverse; `sales.0038`/`0039` reverse as
no-ops because reversing `0037` drops their columns). Confirmed live on a **scratch copy restored from
the backup**, never on the dev database: all 10 unapplied (`sales→0036`, `company→0012`,
`purchasing→0015`, `products→0025`) → all 10 re-applied → `verify_branch_access` "Every user keeps the
same branch access" → `branch_backfill_report` 0 further changes → `relocate_media` 0 to move →
`makemigrations --check` clean → `check` clean → second `migrate` "No migrations to apply". Business
rows were identical at every step (1,074; only `django_migrations` changed). The backfills re-derived
exactly the same assignments as the dev database (access links, wholesale branch, exam/appointment
branch). The scratch database was then dropped.

**Data intact (read-only checks on the dev database):** 121 tables / 1,813 rows (equal to the
rehearsal's post-migration state); 0 unbalanced journals; 0 products whose `stock` differs from the sum
of their `BranchStock`; 4/4 access rows linked to users; 1 wholesale invoice assigned; 2 of 3 exams
and 1 of 1 appointment assigned (1 exam Unassigned by design: "Main Branch" text in a 2-branch tenant).
*Observation, not P1:* tenant 2 has two `BusinessSettings` rows (created 2026-11-02, 43 ms apart).
Harmless while both have Multi-Branch off; worth a dedupe later.

## 6. Production configuration

| Item | Status |
|---|---|
| `AUTO_MIGRATE=False` in production | ✅ in `render.yaml` and as the code default on managed hosts. ⚠️ **Must also be set on the hand-made Render service** (dashboard). |
| Migrations under administrator control | ✅ `build.sh` gated by `RUN_MIGRATIONS`; release procedure in `DEPLOYMENT.md`. |
| `DEBUG=False` | ✅ `render.yaml` sets it; `settings.py` defaults to False on managed hosts (tested in a simulated Render env). |
| Secrets not committed | ✅ Only `backend/.env.example` / `frontend/.env.example` are tracked (placeholders). `backend/.env`, `frontend/.env`, `config/database.json` are git-ignored. No connection string with a real password, Neon password, API key or private key in tracked files or in git history (pattern scan). Docs only use `user:pass@ep-xxxx` placeholders. |
| Explicit production database | ✅ A managed host refuses to start on SQLite. With `DATABASE_URL` set, the URL alone decides the target, even if a local `database.json` exists (tested). `EXPECTED_DATABASE_NAME` makes `/api/health/` flag a wrong database. ⚠️ `EXPECTED_DATABASE_NAME` is optional; set it to exactly `Uae client` (N1, decided 2026-11-12). |
| `SECRET_KEY` | ⚠️ `render.yaml` generates one, but `settings.py` silently falls back to a public development key if the variable is missing. Confirm it is set on the service (R5). |
| Media storage | ⚠️ Local filesystem. On Render that disk is **ephemeral**, so uploads (attachments, logos) are lost on each deploy (G7, existing). Private files are never served from `/media/` (Task 2). |
| Backups | ✅ Cloud default `BACKUP_STORAGE=database` (archives in Postgres, survive deploys; capacity 400 MB); whole-DB backups disabled automatically when more than one tenant exists (Task 3); per-client exports remain. Neon PITR / branching is the primary cloud recovery path. |

## 7. Files changed by this verification

- Backend: `apps/common/branch_context.py`, `apps/company/views.py` (branch-context payload),
  `apps/inventory/stock_overview.py`, `apps/inventory/stock_lifecycle.py`, `apps/inventory/returns.py`
  (`return_stock_by_product` branch filter), `apps/sales/wholesale_orders.py` (`reserved_by_product`
  branch filter), `apps/common/startup.py`, `build.sh`; new `apps/common/tests_p1_policy_decisions.py`; test fixtures in `apps/financial/tests/test_cashbook.py` and `test_daybook.py` (explicit all-branches caller, see §4).
- Frontend: `src/context/BranchContext.jsx`, `src/components/Header.jsx`.
- Config / docs: `render.yaml`, `DEPLOYMENT.md`, this report, a pointer in
  `P1_REMAINING_SECURITY_GAPS.md`.
- Local only (git-ignored): `backups/p1-final/` (DB dump, build log, suite log).

## 8. Remaining blockers and open items

**Before a production deploy (blockers):**

| # | Item | Owner action |
|---|---|---|
| B1 | **Final P1 approval** of this report and of the behaviour changes in §2 (decisions 1 and 2 change what restricted and unassigned users see). | Owner sign-off. |
| B2 | Render dashboard still configured by hand: set `AUTO_MIGRATE=False`, `RUN_MIGRATIONS=False`, confirm `DEBUG=False`, `SECRET_KEY`, `EXPECTED_DATABASE_NAME=Uae client` (N1, decided 2026-11-12). | Admin, in the Render dashboard. |
| B3 | Neon-branch rehearsal of the 10 P1 migrations + the decision 1 impact query (§2) + the pre-flight queries in `P1_MIGRATION_REPORT.md` §6. Never on production itself. | Admin, needs approval to connect to a Neon branch. |
| B4 | Assign branch access to any user the decision 1 query lists **before** deploying, or they lose access. | Admin. |
| B5 | Commit (none made yet). | Owner decides. |

**Known, not blocking (documented, accepted for P1):**

| # | Item |
|---|---|
| R1 | Ephemeral media on Render (G7); object storage needed. Existing cloud attachments may already be gone (`relocate_media` reports them). |
| R2 | Archive ownership cannot tell two installs that share tenant 1 / name apart (G5); needs installation id (P2/P8). |
| R3 | Whole-DB backup rule is the interim single-tenant rule (G6) until D1. |
| R4 | POS / New Sale availability and reservation checks outside Stock Overview still use company-wide quantities. Decision 2 is scoped to Stock Overview. Extending it to sale-time availability is a separate functional change. |
| R5 | `SECRET_KEY` fallback to a known dev key when unset; recommend a startup guard on managed hosts (not added here: it could stop the live service if the dashboard lacks the key). |
| R6 | `check --deploy` HSTS / SSL-redirect warnings: decide on `SECURE_HSTS_SECONDS` once all hosts are HTTPS-only. |
| R7 | Exam report billing references may name another branch's bill number (G9). |
| R8 | Frontend has no ESLint configuration, so lint cannot run. |
| R9 | No PostgreSQL concurrency test for parallel transfer receives (row lock + status guard, same pattern as existing stock code). |
| R10 | Company isolation for multi-company tenants is P2 (G11, decision 4 implication). |

## 9. Safe deployment recommendation

**Readiness: ready for final P1 approval. Not yet ready to deploy.** All verification passes locally. Production deploy waits on B1–B4 (approval, Render dashboard values, Neon-branch rehearsal, assigning unassigned users).

1. Approve this report (B1).
2. On a **Neon branch** (not production): run the decision 1 impact query and the
   `P1_MIGRATION_REPORT.md` §6 pre-flight queries; rehearse `migrate --plan` → `migrate` →
   `verify_branch_access` → `branch_backfill_report` (dry run) → `relocate_media` (dry run) → full test
   suite against the branch → reverse and re-apply (B3).
3. Assign branches to every user the impact query lists (B4).
4. Set the Render dashboard values (B2). Take a Neon branch / `pg_dump` of production and record its
   hash.
5. Commit, then deploy with `RUN_MIGRATIONS=True` for this one release (build.sh migrates, then the
   new code starts). Set `RUN_MIGRATIONS=False` immediately afterwards.
6. Verify `/api/health/`: `"migrations": "up_to_date"`, `db_target.name = "Uae client"`, `"debug": false`.
   Sign in as a restricted user and an unassigned user and check §2's behaviour.
7. Deploy the frontend (Vercel) after the backend is healthy. The new `no_branch_access` field is
   optional for older frontends.
8. Rollback: per-task reverse commands in `P1_MIGRATION_REPORT.md` §5, or the step 4 Neon branch.
9. Optional, after review only: `branch_backfill_report --wholesale-journals` dry run per tenant;
   `--apply` only where evidence is reliable (decision 3).

**Stopped here. Waiting for final P1 approval before any commit, deploy, or P2 work.**
