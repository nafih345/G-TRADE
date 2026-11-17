# P1 — Migration Report

**Date:** 2026-11-11 (N2 migrations added 2026-11-12) · **Branch:** `main` (uncommitted working tree) · **Production (Neon):** not touched.

All P1 schema changes are additive: new nullable columns, one new table, one conditional unique
constraint, and state-only `upload_to` / `choices` changes. No column is dropped, renamed or narrowed.
Every data migration only fills `NULL`s, never overwrites a value, and is idempotent.

---

## 1. Migration inventory

| App | Migration | Kind | What it does | Reverse |
|---|---|---|---|---|
| company | `0013_private_media_paths` | State only | `Company.logo` → `TenantUploadPath('company_logos', public)` | Yes |
| products | `0026_private_media_paths` | State only | `ImportBatch.file` (private) and `Product.image` (public) upload paths | Yes |
| purchasing | `0016_private_attachment` | Additive + state | `PurchaseInvoice.attachment_name` (varchar 255, default `''`); attachment path → private | Yes |
| purchasing | `0017_attachment_name_db_default` | DB default (N2) | `SET DEFAULT ''` on `attachment_name`. Lets pre-P1 code INSERT purchase entries. | `DROP DEFAULT` |
| company | `0014_userbranchaccess_user` | Additive | `UserBranchAccess.user` FK (nullable, CASCADE) | `RemoveField` |
| company | `0015_backfill_userbranchaccess_user` | Data | Links each user to exactly the row the old username rule gave them | Unlink (`user = NULL`) |
| company | `0016_userbranchaccess_unique_user` | Constraint | `UNIQUE (tenant, user) WHERE user IS NOT NULL AND NOT is_deleted` | `RemoveConstraint` |
| company | `0017_stock_transfer_workflow` | Additive | Transfer warehouses / actors / timestamps, item received/returned qty + unit cost, new `StockTransferEvent` table, new status choices (state only) | Yes |
| company | `0018_stock_transfer_db_defaults` | DB default (N2) | `SET DEFAULT ''` on `cancel_reason`, `cancelled_by`, `dispatched_by`, `received_by`; `SET DEFAULT 0` on item `received_quantity`, `returned_quantity`. Metadata only, no rewrite, no data change. Lets pre-P1 code INSERT transfers. | `DROP DEFAULT` |
| sales | `0037_wholesale_exam_branch` | Additive | `branch` FK on 6 wholesale models; `branch_ref` FK on `EyeExamination` and `Appointment` | `RemoveField` |
| sales | `0038_backfill_wholesale_branch` | Data | Evidence-only wholesale branch (rules W1–W4) | No-op (0037 reverse drops the column) |
| sales | `0039_backfill_exam_appointment_branch_ref` | Data | Unambiguous text match (rules E1–E2) | No-op |

Dependencies were kept minimal so each task can be rolled back on its own: `sales.0037` depends on
`company.0012`, not on the Task 4 migrations.

No financial migration: the `GOODS_IN_TRANSIT` role and account `1030 Goods in Transit` are created by
`ensure_accounting_defaults()` (it heals missing defaults the first time a posting needs them).

## 2. Backfill rules

**UserBranchAccess (Task 4).** Old rule: `filter(username__iexact=<token username>).first()` (lowest pk,
live rows, per tenant). The backfill links every user to that exact row. Two users whose names differ
only in case both resolved to one row; the second gets an identical copy (`cloned`). Rows nobody
resolves to stay unlinked: `orphan` (no such user) or `superseded` (a duplicate). Nothing is deleted.

**Wholesale (Task 5, P1-Q3 = Unassigned unless proven).** W1 `stock_applied['branch']` → W2 a single
StockLedger branch → W3 source document (order ← invoice, challan ← order, collection/return ← invoice by
number, quotation ← order/invoice) → W4 the tenant has exactly one branch row ever → else `NULL`.
The default branch is never used as a guess.

**Eye exams / appointments (Task 6, P1-Q4).** E1 the legacy text equals exactly one branch's name or
code after trim / space-collapse / case-fold → E2 the UI default `Main Branch` only in a one-branch
tenant → else `NULL`, reported. The text column is never modified.

## 3. Rehearsal on a disposable database

Performed on `gtrade_p1_rehearsal`, a `createdb -T` copy of the **local** dev database `G OPTICALS`
(localhost, PostgreSQL 17.10). `EXPECTED_DATABASE_NAME` was set to the scratch name and Django's target
was printed before migrating. The scratch database was dropped afterwards.

| Step | Result |
|---|---|
| A. Snapshot of the copy | 120 tables, 1,807 rows |
| B. Reverse every P1 migration (sales → 0036, company → 0012, purchasing → 0015, products → 0025) | All `Unapplying … OK`; 120 tables, 1,798 rows (−9 = `django_migrations` rows only) |
| C. `migrate --plan`, then `migrate` | All 10 migrations `OK`; 121 tables (+`company_stocktransferevent`), 1,813 rows |
| D. `verify_branch_access` | "Every user keeps the same branch access." (exit 0) |
| D. `branch_backfill_report` (dry run) | 0 further changes (idempotent) |
| D. `relocate_media` (dry run) | 0 files to move, 0 missing |
| D. `makemigrations --check`, `check` | No changes; no issues |
| E. Second `migrate` | "No migrations to apply." |

**Row counts A → B → C:** every business table is identical at every step. The only differences are
`django_migrations` (bookkeeping), `auth_permission` +4 and `django_content_type` +1 (the new
`StockTransferEvent` model) and the new empty `company_stocktransferevent` table.

**Backfill results (rehearsal = same as the dev database):**

| Tenant | UserBranchAccess | Wholesale | Exams / appointments |
|---|---|---|---|
| 1 (1 branch) | 1 row → linked 1 | invoice 1 (W4), order 1 (W4), collection 1 (W3) | 2 exams + 1 appointment matched |
| 2 | 0 rows (1 user unconfigured) | — | — |
| 3 | 1 linked (1 user unconfigured) | — | — |
| 4 | 0 rows (1 user unconfigured) | — | — |
| 5 (2 branches) | 2 linked | — | 1 exam **Unassigned** (`"Main Branch"` with two branches) |

No orphans, no superseded duplicates, no clones in this data set.

## 4. Incident: migrations auto-applied to the local dev database

The project's WSGI boot hook (`config/wsgi.py` → `apps/common/startup.py`, `AUTO_MIGRATE` default on)
applies pending migrations whenever the app process starts. A local `runserver` with the auto-reloader
was running during this work; each time a new migration file appeared, it reloaded and applied it to the
**local** dev database `G OPTICALS` on localhost (`backend/logs/backend.log`, 18:01, 18:03 and 18:13
local time):

- `company.0013`, `products.0026`, `purchasing.0016`, `company.0014`–`0016`, `sales.0037`–`0039` are
  applied there.
- `company.0017_stock_transfer_workflow` is **not** applied there yet. It will be applied the next time
  that server starts.
- The resulting data is the same as in the rehearsal above (§3): 4 access rows linked, 1 wholesale
  invoice / order / collection assigned, 2 of 3 exams and 1 appointment assigned.

This was not production and no data was lost. Every change is reversible with the commands in §5.
Neon was never connected to: `config/database.json` points at localhost and no `DATABASE_URL` is set in
the shell. `backend/.env` holds a Neon URL, but `settings.py` does not load `.env`.

**Recommendation:** set `AUTO_MIGRATE=False` for local development, and in any environment where
migrations must be reviewed before they run (the production deploy rule, C8 / `migrate` + restart
together, still applies).

## 5. Rollback

Per task, newest first. Each command is reversible, and the forward run re-derives the same data.

```
# Task 5 + 6 (drops the new branch / branch_ref columns; text labels untouched)
manage.py migrate sales 0036_returns_modules
# Task 7 (cancel or receive any DISPATCHED / PARTIALLY_RECEIVED transfer first)
manage.py migrate company 0016_userbranchaccess_unique_user
# Task 4 (unlinks, then drops user FK; old code resolves by username again)
manage.py migrate company 0013_private_media_paths
# Task 2 (state only + attachment_name column)
manage.py migrate company 0012_branch_logo
manage.py migrate purchasing 0015_returns_modules
manage.py migrate products 0025_label_template_type_visibility
```

Before rolling back Task 7, find stock in transit:
`SELECT transfer_number, status FROM company_stocktransfer WHERE status IN ('DISPATCHED','PARTIALLY_RECEIVED');`
Cancel them through the API so their stock returns to the sending branch.

Last resort: restore the Neon branch / `pg_dump` taken immediately before the deploy (loses writes
made since).

## 6. Pre-flight queries for production (run on a Neon branch copy, never on production)

```sql
SELECT tenant_id, count(*) FROM company_userbranchaccess WHERE NOT is_deleted GROUP BY 1;
SELECT tenant_id, lower(username), count(*) FROM company_userbranchaccess WHERE NOT is_deleted
  GROUP BY 1, 2 HAVING count(*) > 1;                                   -- superseded duplicates
SELECT tenant_id, count(*) FROM sales_wholesaleinvoice GROUP BY 1;
SELECT tenant_id, branch, count(*) FROM sales_eyeexamination GROUP BY 1, 2 ORDER BY 1, 3 DESC;
SELECT count(*) FROM company_stocktransfer;                            -- expected 0
SELECT count(*) FROM purchasing_purchaseinvoice WHERE coalesce(attachment, '') <> '';
```

Then on the Neon branch: `migrate --plan` → `migrate` → `verify_branch_access` →
`branch_backfill_report` → `relocate_media` (dry run) → full test suite against it.
