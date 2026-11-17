# P1 — Completion Report

**Date:** 2026-11-11 · **State:** implemented and tested in the working tree. **Not committed, not pushed,
not deployed.** Production (Render + Neon) was not touched. P2 and Electron/installer work not started.

Companion documents: `P1_MIGRATION_REPORT.md`, `P1_BACKUP_AND_RESTORE_VERIFICATION.md`,
`P1_TEST_RESULTS.md`, `P1_REMAINING_SECURITY_GAPS.md`, `P1_DEPLOYMENT_REHEARSAL_PLAN.md`.

**Result:** backend suite **1027 tests OK**, `check` clean, migrations in sync, migration rehearsal
(reverse → forward → idempotent) clean on a disposable copy. Previously completed P1 work (report /
journal / voucher authorization, branch mixin, sales/purchase/returns/inventory, warehouse transfer
authorization, working-branch fallback, unassigned visibility) is preserved; its tests still pass.

---

## Task 1 — Accounting security ✅

- `CompanyWideAccountingMixin`: in Multi-Branch mode a branch-restricted user cannot **write** the chart
  of accounts, groups, voucher types, posting mappings or fiscal periods, and cannot **read or act on**
  the posting-failure queue (list, retry, retry-all, ignore) or the financial audit log.
- Function views refused for restricted users: posting preview, backfill, opening balances, recompute
  balances, policy PATCH (GET still allowed). Reconciliation / status were already done.
- COA `current_balance` (company-wide cache) is replaced by the permitted-branch balance for restricted
  users (list and detail). Mapping list limited to company-wide + own-branch mappings; `roles?branch=`
  validated.
- **Settlements** (bill-to-bill RV/PV): parties, due bills and the posting itself only see / settle bills
  of permitted branches (`open_bills(branch_ids=…)`); another branch's bill is "not outstanding" (400).
- Unrestricted admins and single-branch installs unchanged. Expense-category quick-add still allowed.

## Task 2 — Purchase attachment security ✅

- Uploads stored at `private/t<tenant>/purchase_attachments/<uuid><ext>` (import files under
  `private/…/import_batches/`, images/logos under `public/…`). The user's file name goes to the new
  `attachment_name` field, never into the path.
- `/media/` serves only public images (new `public_media_view`, DEBUG and cloud); private and legacy
  private folders, traversal and non-image types → 404.
- `GET /api/purchase/invoices/<id>/attachment/` (signed-in, tenant + branch scoped through `get_object`)
  and `…/attachment-link/` → 60-second signed URL bound to tenant + invoice + user; the download view
  re-checks user active, tenant and branch access. `nosniff`, sandbox CSP, `no-store`.
- Upload validation: ≤ 10 MB; PDF/PNG/JPEG/WebP by extension **and** file signature.
- Serializer never exposes a media URL (`attachment`/`attachment_url` = API path, `has_attachment`).
- Existing attachments keep working through the endpoint; `manage.py relocate_media` (dry run default,
  copy + SHA-256 verify, `--delete-old` separate).
- Frontend: "View" button in Purchase Entry (edit) opens the signed link.

## Task 3 — Backup & restore isolation ✅ (interim rule, D1 pending)

Central `backup/policy.py`; enforced in the service, `_produce`, `restore_archive`, scheduler, CLI and
upload; second-tenant onboarding switches the whole-DB schedule off; archive ownership checked before the
safety backup and inside `restore_archive`. Policy unchanged (≤ 1 tenant), now explicit. Details:
`P1_BACKUP_AND_RESTORE_VERIFICATION.md`.

## Task 4 — Stable user-ID branch access ✅

- `UserBranchAccess.user` FK (CASCADE) + conditional unique `(tenant, user)` on live rows.
- Signed-in requests resolve access **by the token's user id only**; username lookup kept only for
  token-less requests (which see no tenant data). Rename keeps access; case variants and deleted users'
  namesakes no longer inherit rows.
- Backfill links exactly the row the old `iexact … .first()` rule gave each user (permissions preserved
  bit-for-bit), copies it for case-variant pairs, reports orphans/duplicates, deletes nothing.
- `manage.py verify_branch_access [--apply]` compares old vs new effective access per user (exit 1 on
  any mismatch). Writers (API upsert per user, Super Admin console, onboarding, Administration) use ids.
- Restricted users see only their own access row and cannot write any.

## Task 5 — Wholesale branch relationships ✅

- `branch` FK on quotations, orders, challans, invoices, collections, returns; all six viewsets use
  `BranchScopedViewSetMixin` (list/retrieve/create/update/delete), stamping server-side; challans follow
  their order, collections/returns their invoice, orders converted from quotations keep its branch.
- POS: invoice belongs to the branch its stock left from; another branch's warehouse 403 (N5); linked
  orders/quotations must be in permitted branches.
- Journals (N6): wholesale invoice / collection / return postings carry the document branch.
  Dealer-settlement collections take their bill's branch.
- Reports: outstanding report includes dealers under a branch filter; dealer directory scoped.
- Backfill W1–W4, evidence only, Unassigned otherwise (P1-Q3). Opt-in historic journal tagging:
  `branch_backfill_report --wholesale-journals` (writes a FinancialAuditLog per journal).
- Unrestricted users still see legacy Unassigned rows in their working view; restricted users never.

## Task 6 — Eye exams and appointments ✅

- `branch_ref` FK on both; text `branch` kept as the printed label and filled from the FK when empty.
- Viewsets scoped on `branch_ref` (list, detail, report, lookup, duplicate guard never returns another
  branch's visit); dashboard counts scoped; eye-test fee journal carries the branch.
- Backfill only on an unambiguous name/code match; `Main Branch` only in one-branch tenants; unmatched
  texts reported; `--map-exam` for manual mapping. Appointments UI no longer hardcodes "Main Branch".

## Task 7 — Stock transfer workflow ✅

- `DRAFT → DISPATCHED → (PARTIALLY_RECEIVED) → RECEIVED`, cancel → `CANCELLED` / `CLOSED`.
  Partial receiving supported per line; over-receive refused.
- Dispatch reduces sending-branch stock (negative-stock rule enforced) and records Goods in Transit;
  receive increases receiving-branch stock and records user + time; cancel returns what is in transit.
- Every step is a `StockTransferEvent` under a row lock + status guard → no duplicate dispatch/receive;
  ledger rows reference the event; Product.stock = sum of branches throughout.
- Accounting: new role `GOODS_IN_TRANSIT` / account `1030`; Dr GIT / Cr Inventory (sender) and
  Dr Inventory / Cr GIT (receiver or sender on return), at dispatch cost, via the posting engine.
- Authorization: sender creates/edits/dispatches/cancels; receiver receives; drafts only editable.
- Numbers from Numbering Sequences (`TRF-YYYY-`), fixing N9.
- **N10 fixed**: warehouse transfers move once on the transition into COMPLETED, then are immutable;
  cross-branch warehouse transfers must use Branch Transfers.
- New **Inventory → Branch Transfers** screen (All / Outgoing / Incoming / In transit, create/edit draft,
  dispatch, partial receive, cancel, history, print note). In-transit summary endpoint.

## Task 8 — Remaining branch gaps ✅ (with documented exceptions)

Wholesale visibility (Task 5), wholesale journal branch (Task 5), Stock Overview product history scoped,
warehouse master scoped (read + write), branch master writes need every branch, `user-branch-access`
scoped, dashboard exam/appointment counts scoped. A resolver sweep of every router viewset over a
branch-bearing model shows none unscoped. Not closed: Stock Overview quantity columns (G2) and
reservations (G10) — decision needed.

## Task 9 — Testing ✅

69 new tests; full suite 1027 OK; rehearsal clean. See `P1_TEST_RESULTS.md`. Company-isolation
assumptions for P2 are documented as G11.

---

## Migrations

company `0013`–`0017`, products `0026`, purchasing `0016`, sales `0037`–`0039` (inventory in
`P1_MIGRATION_REPORT.md`). Backfill results (dev data): 4 access rows linked, 1 wholesale invoice +
1 order + 1 collection assigned, 2 exams + 1 appointment assigned, 1 exam left Unassigned.

## Changed files

**Backend (modified):** `authentication/edit_permissions.py`, `common/{branch_context,branch_mixins,
superadmin_views,tenant_context,tenant_onboarding}.py`, `company/{models,numbering,views}.py`,
`financial/{accounting_catalog,accounts_reports,integration,posting_rules,reports,settlements,signals,
views}.py`, `inventory/{returns,stock_overview,views}.py`, `products/models.py`,
`purchasing/{models,urls,views}.py`, `sales/{dashboard,models,views,wholesale_orders,wholesale_stock}.py`,
`security/{apps,views}.py`, `security/backup/{archive,scheduler,service}.py`,
`security/management/commands/create_backup.py`, `config/urls.py`.

**Backend (new):** `common/media_paths.py`, `common/management/commands/{relocate_media,
verify_branch_access}.py`, `company/branch_access_backfill.py`, `inventory/branch_transfer.py`,
`purchasing/attachments.py`, `sales/branch_backfill.py`, `sales/management/commands/
branch_backfill_report.py`, `security/backup/policy.py`, the 10 migrations, tests
`common/tests_p1_completion.py`, `security/tests/test_backup_tenant_gate.py` (plus the earlier
`common/tests_branch_isolation.py`, `financial/tests/test_branch_authorization.py`).

**Frontend:** `pages/BranchTransfers.jsx` (new), `App.jsx`, `components/Sidebar.jsx`,
`components/purchasing/PurchaseEntryView.jsx`, `pages/Appointments.jsx`.

## Production data / environment confirmation

- **Production Neon database: not connected to, not migrated, not changed.**
- **Local dev database "G OPTICALS" (localhost): migrations were auto-applied** by the running dev
  server's `AUTO_MIGRATE` boot hook as the files appeared (all P1 migrations except `company.0017`).
  Additive and reversible; details and rollback in `P1_MIGRATION_REPORT.md` §4–5.
- Rehearsal used a disposable copy (`gtrade_p1_rehearsal`), since dropped.

## Remaining known issues and approvals needed

See `P1_REMAINING_SECURITY_GAPS.md`: B-8 fail-open default (P1-Q1), Stock Overview per-branch figures,
historic wholesale journal tagging, `AUTO_MIGRATE=False` for the deploy, P1-Q5 patients company-wide,
archive ownership limit until an installation id exists, frontend build to be re-run (machine was out of
memory).

**P1 is complete pending your review. Waiting for approval before any commit, deploy, or P2 work.**
