# P1 — Production Safety Rehearsal Report

**Updated:** 2026-11-12 (N1 decided, N2 implemented and verified). **Nothing was committed, pushed or
deployed. Production, the production database and Render were not modified. No user permission was
changed. All tests ran on disposable databases.**

## Status

| Item | Status |
|---|---|
| **N1: production database** | ✅ **Decided: `Uae client`.** Exact name verified (see §1). Recorded in `render.yaml`, `DEPLOYMENT.md` and the readiness report. The rehearsal script now refuses to migrate any other database on Neon. |
| **N2: old code vs new NOT NULL columns** | ✅ **Fixed and verified.** Two new migrations keep PostgreSQL defaults on all 7 columns. The real production code (`d5379f6`) passes its own 157 purchase, company and inventory tests on the new schema (§4). |
| **Neon-branch rehearsal (Tasks 1–2 on production data)** | ⏳ **Waiting for you** to create the disposable branch and provide `REHEARSAL_DATABASE_URL` in the environment. The script is ready and proven (§3). |
| Render configuration (Task 3) | ⏳ Dashboard values to set by the admin at deploy time (§5). Nothing changed. |
| Media storage (Task 4) | Design ready (§6). Needs approval and an R2 account. |

## 1. Production database and Neon branch identification

| Item | Value |
|---|---|
| Production endpoint | `ep-purple-unit-b4mlt53f` (pooler host `…c-6.us-east-2.aws.neon.tech`), from the public `GET /api/health/` |
| Production database | **`Uae client`**: exact bytes `55 61 65 20 63 6c 69 65 6e 74` (one ASCII space, no surrounding whitespace). In the URL it is `/Uae%20client`. |
| How it was verified | Production's own `/api/health/` → `db_target.name`, which is the name Django resolves from Render's `DATABASE_URL`. Neon's own console and configuration are not reachable from this machine. On the branch, the script additionally records `current_database()`. |
| `EXPECTED_DATABASE_NAME` | Must be exactly `Uae client`. Recorded in `render.yaml` (comment, `sync: false`) and `DEPLOYMENT.md`. **The admin sets it in the Render dashboard at deploy time**, because Render was not to be modified. |
| `neondb` on the same host | **Not production.** Not to be migrated or modified. The script refuses any Neon database other than `Uae client`. |
| Disposable branch | Not yet created (waiting for you). |

Rehearsal guards, all tested:

1. The production endpoint is refused before any connection is made.
2. Non-Neon hosts are refused.
3. Any Neon database other than `Uae client` is refused.
4. After connecting, the script refuses if Django resolved a different host or database, or if the
   server reports the production endpoint id.
5. The password is masked in all output.

## 2. Exact production migration sequence (12 migrations)

Production is at `d5379f6` with no pending migrations. P1 now consists of 12 migrations. The script
stops unless `migrate --plan` lists exactly these, in this order:

1. `company.0013_private_media_paths`
2. `company.0014_userbranchaccess_user`
3. `company.0015_backfill_userbranchaccess_user` (data)
4. `company.0016_userbranchaccess_unique_user`
5. `company.0017_stock_transfer_workflow`
6. **`company.0018_stock_transfer_db_defaults`** (N2)
7. `products.0026_private_media_paths`
8. `purchasing.0016_private_attachment`
9. **`purchasing.0017_attachment_name_db_default`** (N2)
10. `sales.0037_wholesale_exam_branch`
11. `sales.0038_backfill_wholesale_branch` (data)
12. `sales.0039_backfill_exam_appointment_branch_ref` (data)

## 3. Migration results and before/after counts

**On the Neon branch:** pending (B1).

**Proof run of the 12-migration sequence** on a scratch copy restored from the local backup and rolled
back to production's state (pre-P1):

| Check | Before | After |
|---|---|---|
| Tables | 120 | 121 (+ `company_stocktransferevent`, 0 rows) |
| Rows, all tables | 1,803 | 1,815 (the +12 are only the new `django_migrations` rows) |
| Business tables with changed row counts | — | **none** |
| P1 migrations applied | 0/12 | 12/12, in the order above |
| Unbalanced posted/reversed journals | 0 | 0 |
| Journal debit / credit totals | 30,725.00 / 30,725.00 | identical |
| Product stock / branch stock totals | 36 / 32 | identical. Products whose stock ≠ the sum of branch stock: 0 before and after. |
| `check`, `makemigrations --check`, `migrate --plan` afterwards | — | all exit 0; no changes; nothing planned |
| `verify_branch_access` | — | "Every user keeps the same branch access." |
| `branch_backfill_report`, `--wholesale-journals`, `relocate_media` (all dry run) | — | exit 0; no further changes; 0 journals; 0 files |
| **Result** | | **PASS.** The scratch copy was dropped. |

## 4. N2: database defaults for the 7 required columns

**Change:**

- `db_default` added to the 7 fields:
  - `PurchaseInvoice.attachment_name`
  - `StockTransfer.cancel_reason`, `cancelled_by`, `dispatched_by`, `received_by`
  - `StockTransferItem.received_quantity`, `returned_quantity`
- Migrations `company.0018_stock_transfer_db_defaults` and `purchasing.0017_attachment_name_db_default`.
- Generated SQL: only `ALTER COLUMN … SET DEFAULT` (reverse: `DROP DEFAULT`). This is metadata only:
  no table rewrite, no data change, a near-instant lock.
- `makemigrations --dry-run` showed exactly these 7 fields and nothing else.

**1. Each default is semantically correct.** At `d5379f6` the transfer API is plain create/read/update
and soft delete. Its own docstring says "Stock-moving apply logic is delivered in Phase 2". The old
frontend never calls it. So any row the old code writes is correctly described by these defaults:

| Column | Default | Meaning for a row written by old code |
|---|---|---|
| `attachment_name` | `''` | No original file name recorded. New code already falls back to the stored file's name (existing legacy-attachment test). |
| `dispatched_by`, `received_by`, `cancelled_by` | `''` | The action never happened. Old code cannot dispatch, receive or cancel through the workflow. Their `*_at` columns are nullable and stay NULL. |
| `cancel_reason` | `''` | Not cancelled through the workflow. |
| `received_quantity`, `returned_quantity` | `0` | Nothing was received or returned. Old code never moves stock, which matches new code's reading of old rows: `PENDING` = "legacy draft", `COMPLETED` = "legacy, no stock moved". |

All other columns P1 added are nullable, which the new regression test also checks.

**2. Purchase entry and stock transfer with the old production code after the migrations.** The real
`d5379f6` code ran from a temporary git worktree against disposable databases:

| Test | Without N2 (10 migrations) | With N2 (12 migrations) |
|---|---|---|
| Old code creates a purchase entry | ❌ `null value in column "attachment_name" … violates not-null constraint` | ✅ |
| Old code edits / deletes the purchase entry | (no row) | ✅ / ✅ |
| Old code creates a stock transfer with items (old serializer) | ❌ `null value in column "cancel_reason" …` | ✅ |
| Old code edits the transfer (deletes and re-creates items) / deletes it | (no row) | ✅ / ✅ |
| Product stock | unchanged | unchanged |
| **Old code's own test suites** (`apps.purchasing`, `apps.company`, `apps.inventory`: 157 tests) | baseline on its own schema: **157 OK** | on the new 12-migration schema: **157 OK** |

**3. Rollback to the old code without reversing the migrations: works.** This is the second column
above: the old code runs, writes and passes its own suites on the fully migrated schema. Rows that the
**new** code wrote behave as follows under old code:

- A transfer the new code had **DISPATCHED** (stock already out of the sending branch, with a
  dispatch event):
  - Old code reads it fine.
  - Old code refuses to edit it ("DISPATCHED is not a valid choice").
  - Old code **can soft-delete it** (`is_deleted = true`; the event row survives).
- Old code reaches transfers only through its unauthenticated transfer API, because there is no
  screen for them. That API is closed by P1, but it is reopened by rolling back.
- The rollback procedure therefore keeps the rule: **cancel or receive every DISPATCHED /
  PARTIALLY_RECEIVED transfer before rolling code back.**

**4. Reversibility and data integrity.**

- The two N2 migrations reverse (defaults removed, verified in `information_schema`) and re-apply
  (defaults restored).
- Row counts and an MD5 of the full `company_stocktransfer` content were identical at all three
  points. A second `migrate` reports "No migrations to apply".
- The full 12-migration reverse → forward run in §3 passed.

**5. Disposable databases only.** These were used and then dropped:

- `gtrade_n2_compat`, `gtrade_p1_neon_dryrun` (scratch restores)
- `test_gtrade_oldbase`, `test_gtrade_oldsuite` (old-code test runs)
- the Django test database for the new suite

The dev database `G OPTICALS` was only read; the N2 migrations are **not** applied to it.

**New-code tests:**

- New regression tests `PreP1CodeInsertCompatibilityTests` (2) in
  `apps/common/tests_p1_policy_decisions.py`:
  - all 7 columns are NOT NULL and keep a DB default;
  - other P1 columns are nullable;
  - an INSERT with exactly the pre-P1 column list succeeds for purchase entries, transfers and items;
  - new code reads the old-style transfer as a legacy draft with stock unchanged.
- Full backend suite: **1,047 tests, OK** in 2,241 s, on a disposable test database (1,045 earlier plus the 2 new tests). Log: `backups/p1-final/full_suite_n2.log`.

## 5. Render production configuration checklist (no changes made)

| Setting | Required | Evidence | Status |
|---|---|---|---|
| `DEBUG` | `False` | health → `"debug": false` | ✅ verified |
| `DATABASE_URL` | production DB `Uae client` | health → `ep-purple-unit-b4mlt53f` / `Uae client`, `sslmode: require` | ✅ matches N1 |
| `EXPECTED_DATABASE_NAME` | `Uae client` | health is `ok` (unset, or already `Uae client`) | ⚠️ admin sets it explicitly at deploy |
| `AUTO_MIGRATE` | `False` | not visible; the deployed code defaults to True | ⚠️ admin sets it explicitly |
| `RUN_MIGRATIONS` | `False`; `True` for the one release build | new variable | ⚠️ admin adds it |
| `SECRET_KEY` | set, long and random | not observable; a missing key silently falls back to a public dev key | ⚠️ admin confirms it exists (never paste the value) |
| Build / start | `bash ./build.sh` / `gunicorn config.wsgi:application` | `render.yaml` | ✅ in repo |

## 6. Media storage recommendation

Unchanged from the previous version of this report:

- **Recommendation:** Cloudflare R2, one private bucket per environment, with files streamed through
  Django. R2 has no egress fees; 10 GB-month plus 1M Class A and 10M Class B operations are free per
  month ([pricing](https://developers.cloudflare.com/r2/pricing/)).
- **Already verified:** signed short-lived attachment downloads are storage-independent (5/5 attachment
  tests pass on non-disk `InMemoryStorage`).
- **Still needed:**
  - `public_media_view` must stream from storage (small code change);
  - env-gated `django-storages` settings;
  - a bucket and scoped token.
- **Data loss on Render:** every deploy, including P1's, wipes purchase attachments, product images
  and the company logo. Bill and branch logos are stored in the database and survive. Nothing is
  deleted from the database.

## 7. Remaining blockers

| # | Blocker | Owner |
|---|---|---|
| **B1** | Disposable Neon branch from production with current data. Provide `REHEARSAL_DATABASE_URL` (the branch's URL ending in `/Uae%20client`) in the environment. Then the full rehearsal runs and this report is updated with the real numbers. | You |
| B2 | `users_losing_access.csv` from the branch run: admin assigns branches before the deploy. Nothing automatic. | Admin |
| B3 | Render dashboard values (§5). | Admin, at deploy time |
| B4 | Media storage decision (§6). | Owner |
| B5 | Commit (none made). | Owner |

N1 and N2 are closed.

## 8. Exact production deployment procedure

1. **Snapshot:** create Neon branch `pre-p1-YYYYMMDD` from production (the rollback point). Record its
   name and time.
2. **Rehearse** on a separate disposable branch:
   - Command (from `backend/`):

     ```
     python scripts/p1_neon_rehearsal.py --out ../backups/p1-rehearsal
     ```

   - Required: `RESULT: PASS` and exactly the 12 migrations of §2.
   - Review `users_losing_access.csv`, then delete the branch.
3. **Assign branch access** to every listed user (admin, in the app).
4. **Render dashboard:**
   - `AUTO_MIGRATE=False`
   - `RUN_MIGRATIONS=True` (this release only)
   - `EXPECTED_DATABASE_NAME=Uae client`
   - confirm `DEBUG=False` and that `SECRET_KEY` is set
5. **Commit and push** the approved tree. Render's build applies the 12 migrations, then the new code
   starts.
   - With N2, the old code that is still serving during the build keeps working, so **no write freeze
     is required**.
   - A short quiet period is still sensible.
6. **Set `RUN_MIGRATIONS=False`** immediately afterwards.
7. **Verify:**
   - `/api/health/` → `status: ok`, `migrations: up_to_date`, `commit` = the new sha,
     `db_target.name = "Uae client"`, `debug: false`.
   - Re-run the impact query: expect 0 users.
   - `verify_branch_access`: expect "Every user keeps the same branch access".
8. **Smoke test** (`P1_DEPLOYMENT_REHEARSAL_PLAN.md` §2.5); then check the Vercel bundle hash.
9. **Rollback:**
   - Code only: redeploy `d5379f6` **without reversing migrations** (verified safe with N2). First
     cancel or receive every in-transit transfer.
   - Schema rollback: `P1_MIGRATION_REPORT.md` §5.
   - Last resort: the `pre-p1-YYYYMMDD` branch (loses writes made since).

## 9. Files changed

- New migrations:
  - `backend/apps/company/migrations/0018_stock_transfer_db_defaults.py`
  - `backend/apps/purchasing/migrations/0017_attachment_name_db_default.py`
- Models: `db_default` added to the 7 fields, with comments, in `apps/company/models.py` and
  `apps/purchasing/models.py`.
- Tests: `PreP1CodeInsertCompatibilityTests` in `apps/common/tests_p1_policy_decisions.py`.
- Script: `backend/scripts/p1_neon_rehearsal.py`.
  - The plan is now 12 migrations.
  - It allows only `Uae client` on Neon.
- Docs and config:
  - `render.yaml`: `EXPECTED_DATABASE_NAME` comment set to `Uae client`.
  - `DEPLOYMENT.md`: N1 decision recorded, and the health and env-table text updated.
  - `P1_FINAL_RELEASE_READINESS.md`: `neondb` replaced with `Uae client`.
  - `P1_MIGRATION_REPORT.md`: inventory gains the 2 migrations.
  - `P1_DEPLOYMENT_REHEARSAL_PLAN.md`: code-only rollback statement corrected.
  - This report.

**Waiting for the disposable Neon branch (`REHEARSAL_DATABASE_URL` in the environment) to run the real
rehearsal.**
