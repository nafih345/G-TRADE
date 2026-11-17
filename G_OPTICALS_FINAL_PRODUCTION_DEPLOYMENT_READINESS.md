# G OPTICALS — Final Production Deployment Readiness

Date: 2026-11-13 · Scope: cloud edition (Render + Neon + Vercel), Super Admin / Client Management / compact UI, plus everything else still uncommitted that a deploy would carry · Status: **audited locally. Nothing committed, pushed or deployed. Production was not contacted.**

| Area | Verdict |
|---|---|
| **Security** | **GO** |
| **Migration** | **GO** for the code and migrations (proven on a fresh DB and a full copy of the dev data). Production itself must still be rehearsed on a Neon branch (§8, step 2). |
| **Super Admin** | **GO** |
| **Client Management** | **GO** |
| **Production Deployment** | **NO-GO — pending owner actions**, not code defects: the release also carries P1 + Phase 2, which are still unapproved and un-rehearsed on production data. See §9. |

---

## 1. Module role "none" — read exposure (found and fixed)

**Finding (confirmed).** Before this audit, API *reads* were checked only against the client's **subscription**. A role's level was applied to writes only. So any signed-in user whose role is "none" on a module could still read that module's data with a direct API call, as long as the client was subscribed to it. Examples, all now refused:
- A **cashier** could GET the ledger and journals (`/api/financial/journals/`), the trial balance, purchase bills including cost prices (`/api/purchase/invoices/`), wholesale bills and the appointment book.
- A **doctor** could GET suppliers, services and the books.

**Fix** (`apps/common/module_access.py`, `_check_read`). A read of a module-owned endpoint now needs both:
1. the client has at least one module that reads there (as before, `403 module_disabled`); and
2. the user's role is **not "none" on every one of those modules** (`403 module_forbidden`). "View" is enough to read.

Reader lists come from mapping every frontend file that calls each endpoint, so legitimate cross-module reads keep working:
- New Sale reads eye tests.
- Patient history reads bills and payments.
- Sales returns read suppliers.
- Sales orders read the lens-order queue.
- The books read purchase and wholesale bills and parties.
- The bill-designer preview reads sales documents.

New read rules were added for customers, sales invoices, payments, returns and services.

**Effect per default role** (computed from the rules; "refused" = 403 via direct API):

| Role | Can open | Now refused through the API |
|---|---|---|
| Super Admin / Administrator / Branch Admin / Manager | everything the client has | nothing |
| Accountant | sales, wholesale, purchase, books, reports | appointments |
| Optometrist / Sales Staff | optical, sales, inventory, reports | the books, purchase bills/orders, wholesale |
| Cashier | sales, reports | the books, purchase bills/orders, wholesale, appointments |
| Doctor | optical, reports | the books, purchase (incl. suppliers, lens orders), wholesale, services |
| Inventory Manager / Purchase Executive | inventory, purchase, reports | the books, wholesale, appointments, services |

**Verified:**
- 5 new backend tests (`RoleReadGateTests`), including a custom "none" override set from Client Management.
- In the browser, a Cashier and a Doctor each walked through all of their own screens. **No 403 or 5xx occurred on any of them**, while the direct API probes above were refused.

**Still readable by design (not exposure):**
- **Shared masters** (products, categories, brands, units, stock) are not role-gated. Every role reaches them through at least one screen: Reports, Settings barcode labels, Administration import, New Sale.
- **With a module disabled**, its data stays readable when another enabled module legitimately reads it. Example: Wholesale off but Financial on, and Financial vouchers and "show bill" read wholesale bills. Its menu is hidden and **all its writes are refused** (verified: `POST /api/sales/wholesale/invoices/` → `403 module_disabled`).
- **The dashboard summary** (today's revenue, tests, appointments, pickups) is shown to every role, as before. If revenue should be hidden from clinical-only roles, that is a product decision.

## 2. Tenant, company and branch isolation; Super Admin cross-client access

| Check | Evidence | Result |
|---|---|---|
| Tenant from server-side context only | Body `tenant`/`tenant_id` + `X-Tenant-Id` header pointing at another client are ignored; row lands in the caller's tenant | PASS (test) |
| Cross-client leak sweep | `tests_tenant_modules`: 161 GET endpoints probed as client B for client A's data; 165 cross-client detail/PATCH/DELETE refused | PASS |
| Cross-client in the browser | Client B cannot list (0 rows), open (404) or change (404) client A's new customer; each client sees only its own branches | PASS (e2e) |
| Company isolation (Phase 2 multi-company) | `tests_multi_company` (memberships, switch-company re-verification, per-company edit rights, org admin APIs) | PASS |
| Branch permissions | `tests_branch_isolation` (restricted users see/write only their branches, stock transfers) | PASS |
| Platform endpoints refused to client admins | list, summary, detail, PATCH, workspace, data → 403 (test) and 403 from a real client token (e2e) | PASS |
| Super Admin cross-client access is explicit + audited | Opening a client workspace writes `WORKSPACE_OPENED` (actor); data views/exports, invitations, module/subscription/seat/profile/user/branch changes all in `TenantAuditLog` | PASS |
| Inside a workspace the owner follows the client's plan | owner reads what the client's plan allows; platform powers are off in that session | PASS (test) |
| Signed-out reads of tenant data | `GET /api/company/localization/` from the login page → 403 "Sign in to access this data" (strict tenancy, since 2026-11-02; the page uses defaults) | Expected |

Full backend suite on a fresh test database: see §7.

## 3. Migration `common 0012`

| Rehearsal | Result |
|---|---|
| `sqlmigrate common 0012` | Only `ALTER TABLE "common_tenant" ADD COLUMN …` and `ALTER COLUMN` (drop of the temporary default). No drops, no data statements. |
| Fresh throwaway DB | migrate all ✓ · reverse 0012 ✓ · re-apply ✓ · `makemigrations --check`: no drift |
| Copy of the dev DB (`pg_dump`, dev only read) | rolled back to 0011 → snapshot of **123 tables / 1,593 rows** (row count + md5 over every pre-existing column) → apply 0012 → **identical** → roll back → **identical** → re-apply ✓ |
| Columns added | `common_tenant`: owner_name, country, address, subscription_plan, subscription_starts_on, subscription_expires_on, max_branches. Nothing removed, no new tables. |
| Existing tenants after 0012 | all 5: `PERPETUAL`, no dates, no branch limit, blank profile, so **no client's access changes** |
| **Whole pending release** (what production would actually receive) | Copy of dev data rolled back to production's committed state, then the updated rehearsal script applied all **16 pending migrations** (12 P1 + 3 Phase 2 + 0012): **RESULT: PASS** (details below) |

Whole-release rehearsal details:
- 120 → 124 tables (the 4 expected new ones).
- 1,732 → 1,758 rows; the +26 are exactly 16 migration records, 5 organizations and 5 organization admins.
- 0 unbalanced journals before and after; stock consistency 0 → 0.
- `check`, `makemigrations --check` and an empty plan afterwards.
- Nobody loses branch access. Backfill and media dry runs move nothing.

**Incident to note (dev DB, not production).** At 12:12:05 today, your own auto-reloading dev server (`manage.py runserver`, started 12:08) restarted when the new migration file appeared. Its `AUTO_MIGRATE` boot hook applied `0012` to the dev database "G OPTICALS"; the backend log says "AUTO_MIGRATE: applying 1 pending migration(s): common.0012…". I did not run `migrate` on the dev DB. I verified the result read-only: all 5 tenants carry the safe defaults, and nothing else changed. That dev server is still running, so **any new migration file is applied to the dev DB the moment it is written.** For that reason no further migrations were written in this audit (see R1).

`backend/scripts/p1_neon_rehearsal.py` was updated to expect the full pending release (RELEASE_PLAN = P1 + Phase 2 + 0012, matched as a set since Django orders by dependency) and the 3 new Phase 2 tables. Its production-endpoint guard is unchanged.

## 4. Platform administrator setup

- **`platform_admin_status` against the intended environment.** Production could not be checked: connecting was forbidden. Results elsewhere:
  - Dev DB (read-only): `superadmin  OK — can open Client Management`.
  - Copy of the dev data: same result.
  - Fresh throwaway DB: "No account can open Client Management" (exit 1) → `bootstrap_admin` with env vars → OK.

  For production the status is now **printed in every Render build log** (new read-only line in `build.sh`), so no shell is needed.
- **Never promotes a client admin.** On the copy of real data, `bootstrap_admin --reset-password` naming a real client administrator (`client2admin`, tenant #2) was **refused** ("belongs to client #2 … cannot become the platform owner"). It stayed non-superuser and its password hash was unchanged. The same behaviour is covered by tests.
- **Recovery instructions (verified paths):**

  | Situation (from the build log's status) | Action |
  |---|---|
  | No account can open Client Management | Set `DJANGO_SUPERUSER_USERNAME` to a **new** name + a strong `DJANGO_SUPERUSER_PASSWORD`, redeploy: `bootstrap_admin` creates the owner in tenant #1. |
  | Owner account exists but "not a superuser" / "deactivated" / password lost | Set `BOOTSTRAP_ADMIN_RESET=True` + the owner's username/password env, deploy once, set back to `False`. |
  | The named account "belongs to client #N" | Choose a different username. That account is a client's and is never promoted. |

  `BOOTSTRAP_ADMIN_RESET` is new (`build.sh`, `render.yaml` default `False`, documented in `DEPLOYMENT.md`). There is no default account or password in any mode.

## 5. Complete workflow (real browser, scratch stack, headless Chrome) — 54/54 PASS

| Step | Result |
|---|---|
| Super Admin login | `/#/super-admin/login` → lands on Client Management |
| Create client (wizard) | Country India, owner, email |
| Create company and branch | company "Readiness Eyecare Pvt Ltd" + reg. no.; main branch "Kochi Main" + phone; verified through the API |
| Assign modules | Modules tab → Wholesale switched off → saved (package becomes Custom, 8 modules) |
| Configure subscription and limits | Overview → users 7, branches 3 saved; plan Annual with expiry; History shows "Modules changed" and "Subscription changed" |
| One-time admin setup link | generated at creation, shown once |
| Client admin completes setup and logs in | link → password set → main login → app; Wholesale hidden in the menu; wholesale writes 403 `module_disabled` |
| Client isolation | second client cannot list/open/change the first client's customer; branches separate; platform API 403 |
| Role gate | Cashier and Doctor use all of their screens with zero 403/5xx; their "none" modules refused via API |

0 browser console errors. The earlier run (48/48) also covered the portal refusal of client owners, single use of the link, setup-pending status, logout and the density switch.

## 6. Responsive UI — 1366×768, 1440×900, 1920×1080

At all three sizes:
- **Client Management:** no page-level horizontal scroll, and the client table fits its card (0 px overflow).
- **Create Client wizard:** fits inside the window.
- **Client workspace dialog:** fits, with no sideways scroll.
- **10 main client screens** (Dashboard, New Sale, Orders, Products, Stock Overview, Purchase Entry, Eye Test, Reports, Settings, Users): no page-level horizontal scroll (**30/30**).

Screenshots were reviewed for the console, wizard, workspace, dashboard and New Sale.

## 7. Test results and skipped tests

| Suite | Result |
|---|---|
| Backend, complete, fresh test DB (after the role-gate change) | **1,156 run: 1,155 OK, 1 skipped, 1 error.** The error is a flake in `security.test_backups` (4 backups created in the same second collided on a random 4-hex suffix, see R4). The class re-run 3×: 4/4 OK each time. Unrelated to this release's changes. |
| `tests_client_management` (Super Admin, invitations, subscription, isolation, role gate) | **37/37 OK** |
| Licensing, under Windows local-edition settings (disposable PG17 cluster) | **23/23 OK** |
| Frontend `node --test` (26 suites) | **208/208 OK** (no frontend change since) |
| Desktop shell | **16/16 OK** |
| Windows engine suite | **123 run, OK, 25 skipped** |
| Browser e2e | **54/54** (readiness) + **48/48** (earlier run) |

**Skipped tests — not counted as coverage:**

| Skipped | Count | Why | Covered elsewhere? |
|---|---|---|---|
| `apps.licensing.tests` (whole module) in the cloud suite | 1 module | It raises `SkipTest` at import: licensing exists only in the Windows local edition (`config.settings_local`). | **Yes**: run separately under local settings, 23/23 OK. |
| `windows/tests/test_backup_update_e2e.py` | 10 | Opt-in (`GTRADE_E2E=1` + a freshly **staged** Windows build): real backup/restore/update/rollback/uninstall on a provisioned stack. | **No.** Not run: the staged app predates today's code, and restaging is a full Windows build. Not part of the cloud release. Last recorded pass: 2026-11-13 installer reports. |
| `windows/tests/test_desktop_install_e2e.py` | 5 | Opt-in: the Electron client against an installed engine (pairing, TLS pinning, admin reset). | **No.** Same reason. |
| `windows/tests/test_e2e_stack.py` | 10 | Opt-in: full Windows stack from an empty DB (TLS, headers, maintenance, crash recovery, log secrets). | **No.** Same reason. |

The other conditional skips (missing PG17 binaries, `icacls`, `makensis`, a staged payload, non-Windows DPAPI) **did not trigger** here; those tests ran. The two `skipTest` guards in `billing` and `business_localization` did not skip either.

## 8. Safe Render deployment sequence (for the owner to run, after approval)

Prerequisites:
- **(a)** Owner approval of P1, Phase 2 and this release.
- **(b)** The P1 Render dashboard values (`P1_FINAL_RELEASE_READINESS.md` B2).
- **(c)** Unassigned users assigned (P1 B4).
- **(d)** The working tree committed to a release branch and reviewed.
- **(e)** A maintenance window.

1. **Backup and recovery point (production untouched):**
   - In Neon, create branch **`pre-release-YYYYMMDD`** from production (`Uae client`). This is the instant rollback point. Do not delete it until the release has been stable for a week.
   - Also take an offline `pg_dump -Fc` of production with read-only credentials and keep it off the server.
   - Confirm your Neon plan's history retention covers the window.
   - The app's own backup endpoints are disabled once more than one tenant exists, so they are **not** the backup.
2. **Rehearsal on a disposable Neon branch:**
   - Create `rehearsal-YYYYMMDD` from production, set `REHEARSAL_DATABASE_URL` (the branch URL ending `/Uae%20client`) and run `python scripts/p1_neon_rehearsal.py --out ../backups/release-rehearsal`.
   - Require `RESULT: PASS`, `planned` = the 16 migrations, 0 unexpected tables, and review `users_losing_access.csv`.
   - Delete the branch. **Stop here if anything differs.**
3. **Backend deploy and migration:**
   - On the Render service set `RUN_MIGRATIONS=True` (keep `AUTO_MIGRATE=False`, `BOOTSTRAP_ADMIN_RESET=False`) and deploy the release commit.
   - The build log must show the 16 `Applying … OK` lines, then the `platform_admin_status` block.
   - Immediately set `RUN_MIGRATIONS=False` again. The redeploy this triggers lists no pending migrations.
4. **Health and platform admin verification:**
   - `GET /api/health/` must report `"migrations"` up to date and the expected `db_target` host.
   - In the build log, `platform_admin_status` must say "1 account(s) can open Client Management" for the intended owner. If not, apply §4's table and redeploy.
   - Never point `DJANGO_SUPERUSER_USERNAME` at a client's account (the command refuses it anyway).
5. **Frontend deploy:**
   - Only after step 4, deploy the same commit on Vercel and confirm the served bundle hash changed.
   - Order matters: the new UI calls the new endpoints (`summary/`, `invitation/`). The old UI keeps working against the new backend, because the list endpoint still returns a plain list without `?page=`.
6. **Post-deployment smoke tests (production, by the owner):**
   - Platform login on `/#/super-admin/login` → Client Management with summary tiles; existing clients show **Active · Perpetual**.
   - A client owner on `/#/super-admin/login` is refused; the same owner signs in on the main page.
   - A client Cashier signs in, New Sale opens and saves a test bill (then cancel it per your usual procedure). `GET /api/financial/journals/` with that token → 403.
   - Optionally create a clearly named test client with a setup link, complete it, then deactivate it.
   - Check the History tab of a client shows the change records.
7. **Rollback:**

   | Problem | Action |
   |---|---|
   | UI problem only | Vercel → promote the previous deployment. Backend stays. |
   | Backend code problem, schema fine | Render → "Rollback" to the previous deploy. **Caveat:** that code predates `0012` and cannot *create new clients* (`common_tenant` columns are NOT NULL without database defaults) until R1 is done or 0012 is reversed. Everything else works. |
   | Need the old schema | Reverse with a `RUN_MIGRATIONS`-style one-off: `migrate common 0011` drops the 7 subscription columns (subscription terms entered after the deploy are lost). Going further back (Phase 2 → `common 0008`, P1 → per `P1_MIGRATION_REPORT.md`) loses memberships and stock-transfer events created since. |
   | Data damage | Restore from Neon branch `pre-release-YYYYMMDD` (point `DATABASE_URL` at it or reset production from it), then redeploy the previous commit on Render and Vercel. |

## 9. Why Production Deployment is NO-GO today, and what turns it GO

None of the blockers is a defect found in this audit; all are owner actions or approvals:

| # | Blocker | Owner of the action |
|---|---|---|
| B1 | **P1 and Phase 2 are unapproved and undeployed.** This release cannot ship without them (its migrations follow theirs); approve all three together. | Owner |
| B2 | **Neon-branch rehearsal on production data** (§8 step 2). Proven here only on a copy of the dev data. | Owner (creates the branch) |
| B3 | Render dashboard values from P1 (B2 there) and assignment of unassigned users (P1 B4); the rehearsal on dev data still shows 1 eye exam whose branch text "Main Branch" matches no branch. | Owner |
| B4 | Commit and review the working tree (it also contains the Windows edition, which does not affect the cloud build). | Owner |

Recommended before deploy (not blockers):

| # | Recommendation |
|---|---|
| R1 | Add database defaults for 0012's NOT NULL columns, as P1 did in `company 0018` / `purchasing 0017`, so a code-only rollback can still create clients. This needs a new migration, so **stop the auto-reloading dev server first** or it will be applied to the dev DB the moment the file is written. |
| R2 | Decide whether the dashboard summary's revenue should be hidden from clinical-only roles. |
| R3 | Run the 25 opt-in Windows e2e tests on a freshly staged build before the next Windows release. |
| R4 | Backup identifiers are `BKP-<date>-<time to the second>-<4 random hex>`, so two backups started in the same second collide about once in 65,536 (it produced the one test error). Widen the random suffix in `apps/security/backup/service.py` (both identifier builders). |

## Changes made in this audit

| File | Change |
|---|---|
| `backend/apps/common/module_access.py` | Role-level read gate; read rules for customers, invoices, payments, returns, services |
| `backend/apps/common/tests_client_management.py` | +5 tests (`RoleReadGateTests`) → 37 |
| `backend/scripts/p1_neon_rehearsal.py` | Expects the full pending release (16 migrations) and the Phase 2 tables |
| `backend/build.sh` | `platform_admin_status` in every build log; `BOOTSTRAP_ADMIN_RESET` one-deploy recovery |
| `render.yaml`, `DEPLOYMENT.md` | `BOOTSTRAP_ADMIN_RESET=False` + documentation |

All throwaway databases (`gopt_e2e_cm`, `gopt_rehearsal_fresh`, `gopt_rehearsal_copy`, `gopt_release_rehearsal`) were dropped. The dev database was only read, apart from the auto-migration by the running dev server described in §3.

**Stopping here for owner approval.** No commit, push, deployment or production access has been made.
