# G-TRADE ERP — P1 Isolation Hardening: Implementation Plan

**Date:** 2026-11-11 · **Status:** Plan for review. Nothing implemented. No code, migrations, data or git state
were changed while preparing it. Companion to `ARCHITECTURE_DECISION_REGISTER.md`.

**Scope.** These are the eight P1 items requested. P2 (Organization, memberships, company switching) is out of scope. Where an
item's documented final fix needs P2, this plan delivers a P1 interim fix and says so.

| # | Item | Audit ref | Migration |
|---|---|---|---|
| 1 | Protect uploaded media and purchase attachments | I1 | State-only (`upload_to`) |
| 2 | Whole-database backup behaviour with several tenants | I2 | None |
| 3 | Branch authorization in financial reports | B-3, B-5 | None |
| 4 | Branch authorization in journal entries | B-4 | None |
| 5 | Branch relation on wholesale documents | B-1 | Additive + backfill |
| 6 | Relational branch on eye exams and appointments | B-2 | Additive + backfill |
| 7 | Real stock transfer between branches | B-6 | Additive |
| 8 | User-ID-based branch access | B-7 | Additive + backfill |

---

## 0. What the code inspection found

### 0.1 Confirmed audit findings
B-1…B-7 and I1/I2 are confirmed in the current code (`main` @ `d5379f68`).

### 0.2 Additional gaps not in the audit (all fall inside the eight items)

| ID | Finding | Location | Item |
|---|---|---|---|
| N1 | Financial reports with **no** `?branch=` return **every** branch's figures to a branch-restricted user. The audit only covered an explicit off-limits `?branch=`. | `financial/views.py` `trial_balance_view`, `profit_loss_view`, `balance_sheet_view`, `general_ledger_view`, `ledger_register_view`, `account_balances_view`, `source_breakdown_view`, `ChartOfAccountViewSet.ledger` | 3 |
| N2 | `ChartOfAccountViewSet.list?with_balances=1` calls `reports.account_balances()` with no branch, so a restricted user sees all-branch balances. | `financial/views.py:112` | 3 |
| N3 | `JournalEntryViewSet.get_queryset` has **no branch filter**. A restricted user can list, open, post, reverse, correct and delete drafts of other branches' journals. | `financial/views.py:187` | 4 |
| N4 | `BranchScopedViewSetMixin._branch_stamp_kwargs` accepts a **client-supplied** `branch` on create without checking it against allowed branches. Updates can move a document to another branch. This affects every scoped viewset, not just wholesale. | `common/branch_mixins.py:86` | 4/5 |
| N5 | Wholesale stock location uses a client-supplied warehouse id and takes **its** branch with no access check. | `sales/wholesale_stock.py:116-129` | 5 |
| N6 | Wholesale accounting postings hardcode `'branch': None`, so branch P&L never includes wholesale. | `financial/posting_rules.py:205, 222` (and the return builder) | 5 |
| N7 | The whole-DB **scheduler** (`scheduler.run_due`) and `manage.py create_backup` call `service.start_backup` directly. `SingleTenantInstall` is enforced **only** on HTTP views. A schedule enabled before a second tenant was onboarded keeps producing all-tenant archives. `start_restore` has no service-level guard either. | `security/backup/scheduler.py:101`, `security/management/commands/create_backup.py` | 2 |
| N8 | Purchase attachments are returned as a plain `/media/purchase_attachments/<user filename>` URL (`fields='__all__'`). On the cloud, `/media/` is served by `django.views.static.serve` with no authentication. | `purchasing/views.py:203`, `config/urls.py:221-226` | 1 |
| N9 | Stock transfer numbers come from `TRF-{int(time.time()) % 1000000}`, which collides against the `(tenant, transfer_number)` unique constraint. | `company/views.py:313` | 7 |
| N10 | `WarehouseTransferViewSet` re-applies stock on **every** update while `status == 'COMPLETED'` (double movement). | `inventory/views.py:75-90` | 7 (fix or retire) |
| N11 | `UserBranchAccess` username matching is `iexact` and survives user deletion, so a new user created with a deleted user's name inherits the old restrictions or grants. | `common/branch_context.py:55` | 8 |

### 0.3 Checked and not a gap
- Views with `authentication_classes = []` do **not** run anonymously when a token is present: `tenant_context.install_drf_hook.perform_authentication` authenticates any valid token, so role gates, session checks and tenant matching all apply. `/api/company/user-branch-access/` writes require the `admin` module at FULL for the caller's role (`module_access.WRITE_RULES`).
- Usernames cannot be renamed through Administration → Users or the Super Admin console (`user_admin.py`). B-7's practical risks are therefore N11 and Django admin renames, not in-app renames.
- Cashbook, Day Book, Bank Book, Statements, P&L statement, voucher/expense/outstanding reports already use `_cashbook_branches()` correctly. That helper is the model for item 3.

---

## 1. Cross-cutting rules (apply to every item)

1. **Tenant isolation is untouched.** No change to `TenantQuerySet`, `check_write`, `TenantContextMiddleware` or token issuance. No new `unscoped()` call. Backfills run per tenant inside `tenancy.use_tenant(t.pk)`.
2. **Additive schema only.** New columns are nullable. No column is dropped, renamed or narrowed. Legacy text columns (`EyeExamination.branch`, `Appointment.branch`, `UserBranchAccess.username`) stay and keep being written.
3. **Schema migration and data migration are separate files.** Schema first, then a `RunPython` backfill with a reverse function, so `migrate <app> <prev>` always works.
4. **Backfills only use unambiguous evidence.** Otherwise they leave `NULL` and report the row. They never guess, never overwrite a non-null value, and are idempotent (re-running changes nothing).
5. **Single-branch installs behave exactly as today.** Every new check is a no-op when `multi_branch_enabled` is off (the existing pattern), so most cloud tenants see no change.
6. **Fail closed on new checks.** An off-limits branch gets 403. Rows a restricted user may not see are left out of lists. Admins (`is_branch_admin`) keep `?branches=all`.
7. **Expand → migrate → enforce.** Each item ships so that code N-1 still runs against schema N (Render can restart old workers mid-deploy, and `BranchScopedViewSetMixin` already falls back when columns are missing).
8. **Deploy rule (cloud):** run `migrate` and restart together. Rehearse every migration first on a **Neon branch copy** of production (architecture C8).

---

## 2. Item plans

### Item 1 — Protect uploaded media and purchase attachments (I1, N8)

**Affected:** `purchasing.PurchaseInvoice.attachment`, `products.ImportBatch.file`, `products.Product.image`,
`company.Company.logo`; `config/urls.py` media routes; `purchasing/views.py` serializer; frontend `PurchaseEntryView.jsx`
(upload only today; there is no viewer).

**Design**
- New `apps/common/media_paths.py`: `upload_to` callables that write `t<tenant_id>/<kind>/<uuid4><ext>`. The extension is taken from an allow-list. The original name is kept in a model field or in metadata, never in the path.
  - Private kinds: `purchase_attachments`, `import_batches` → `private/t<id>/…`
  - Public kinds: `product_images`, `company_logos` → `public/t<id>/…` (random names; `<img src>` cannot send a JWT)
- New authenticated endpoint `GET /api/purchase/invoices/<id>/attachment/` (and `/api/import/batches/<id>/file/`):
  normal token auth → the tenant ORM scope applies automatically → the branch check uses `PurchaseInvoice.branch` against
  `allowed_branch_ids` → the module read check applies. For browser download, copy the backup **signed-link** pattern
  (`BackupDownloadLinkView`): `POST …/attachment/link/` returns a 60-second `signing.dumps({tenant, invoice, user})` URL. The
  token-blind download view re-activates the tenant from the signed claim with `use_tenant()` and re-checks that the user is active.
- Response: `FileResponse` with `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff` and the stored content type. Locally (P4), the same view returns `X-Accel-Redirect: /_protected/<path>` to an nginx `internal` location. That switch is selected by a setting (`MEDIA_ACCEL_REDIRECT`), not by the edition, so cloud behaviour can be tested.
- `/media/` route on the cloud (`config/urls.py:221`): replace the blanket `serve` with a view that serves only `public/` and the legacy public prefixes (`product_images/`, `company_logos/`), and returns 404 for `private/`, `purchase_attachments/` and `import_batches/`. Same rule for the `DEBUG` route.
- Serializer: `attachment` becomes write-only. Add read-only `attachment_name`, `has_attachment` and `attachment_url` (the API path, not `/media/`).
- Upload validation: size cap (10 MB), extension and MIME allow-list (pdf, png, jpg, jpeg, webp), and a reject list for active content (svg, html).

**Existing files.** Management command `relocate_media --dry-run|--apply`, run per tenant: copy → verify SHA-256 → update the
`FieldFile.name` in a transaction → delete the old file **only** with `--delete-old`, as a separate later run. Idempotent.
Cloud note: Render's filesystem is ephemeral (`config/urls.py:218`), so most historic cloud attachments are probably already
gone. The command reports missing files and never errors on them. Durable object storage is **not** in P1 scope.

**Migrations:** `AlterField` on four fields, changing `upload_to` to callables. Django state-only, no SQL.

**Rollback:** revert the code. Relocated files keep working because `FieldFile.name` holds the full relative path. Old files are kept until `--delete-old`.

**Tests** (`apps/purchasing/tests/test_private_media.py`, `apps/common/tests_media_paths.py`):
- Anonymous GET of the old `/media/purchase_attachments/x.pdf` and of new `private/…` returns 404.
- Tenant B's token fetching tenant A's invoice attachment returns 404, not 403 (no existence leak).
- A branch-restricted user requesting another branch's invoice attachment returns 403 or 404.
- A signed link that is expired, tampered with, issued for another user, or used after the user is deactivated is refused.
- A new upload path matches `private/t<id>/purchase_attachments/<uuid>.pdf` and contains no user filename.
- `relocate_media` dry run changes nothing. Apply is idempotent. A missing source is reported, not fatal.
- Public product image still renders (200, no auth).

---

### Item 2 — Whole-database backup with several tenants (I2, N7)

**Constraint.** The documented fix ("single organization", backup plan step 1) needs P2's `Organization` (D1). P1 delivers
an **interim fix** that closes the leak paths now and turns into the org rule in P2 by changing one predicate.

**Design**
- Move the rule into the service layer: `apps/security/backup/policy.py` → `whole_db_allowed()` and
  `assert_whole_db_allowed()` (raises `BackupError` with the existing message). P1 implementation: `Tenant.objects.count() <= 1`, the same predicate as today. P2 replaces the body with the organization rule.
- Call it from `service.start_backup`, `service.import_upload`, `service.start_restore`, `scheduler.run_due` (mark the run `SKIPPED` and log `BACKUP_SCHEDULE_SKIPPED` with the reason), and `create_backup` / `run_scheduled_backups` commands (`CommandError`).
- `SingleTenantInstall` permission calls the same function, so there is one source of truth.
- **Restore tenant check:** before applying, read the archive's `common.Tenant` rows. Refuse when the archive has more than one tenant, or when its single tenant id differs from this database's single tenant (prevents restoring customer X's archive over customer Y's install). An explicit `--allow-tenant-rekey` is left for the P8 hardware-move runbook, not exposed in the UI.
- When a second tenant is onboarded (`tenant_onboarding.onboard_tenant`) and a whole-DB `BackupSchedule` is enabled: disable it, record `last_run_status='DISABLED_MULTI_TENANT'`, and write a security audit event. Existing whole-DB archives stay listed for deletion only (download is already gated).
- Per-client backups (`start_client_backup`, `TenantScope`) are unchanged. They are the cloud's backup path.

**Migrations:** none.

**Cloud impact.** Whole-DB backups are already refused through the UI on the multi-tenant cloud. This closes the scheduler and CLI paths. Cloud database recovery remains Neon's responsibility (branching/PITR) and is out of scope.

**Rollback:** code revert only.

**Tests** (`apps/security/tests/test_backup_tenant_gate.py`):
- With two tenants: `run_due` with an enabled schedule produces no `BackupRecord` and the status is `SKIPPED`. `call_command('create_backup')` raises `CommandError`. `start_restore` raises.
- With one tenant: the existing backup and restore tests pass unchanged.
- A restore archive whose tenant id differs from the DB's is refused before any row is touched. An archive with more than one tenant is refused.
- Onboarding a second tenant disables the whole-DB schedule and writes the audit event.
- The per-client backup still works with N tenants.

---

### Item 3 — Branch authorization in financial reports (B-3, B-5, N1, N2)

**Design**
- Extract `_cashbook_branches()` into `apps/financial/branch_scope.py` → `resolve_report_branches(request)` returning
  `(branch_ids | None, label)`. Unchanged semantics: single-branch mode returns `None`; `?branch=all` or no parameter returns `None` for unrestricted users and the **allowed set** for restricted users; an off-limits branch returns 403; an unknown branch returns 400.
- `reports.posted_lines`, `_totals`, `account_balances`, `trial_balance`, `profit_and_loss`, `balance_sheet`,
  `general_ledger`, `ledger_register` and `source_breakdown` gain `branch_ids=None` (a list) next to the existing `branch` argument. `branch` stays for compatibility and maps to `[branch]`.
- Every view listed in N1, plus `ChartOfAccountViewSet.list(with_balances)` (N2) and `ChartOfAccountViewSet.ledger`, goes through the resolver.
- `LedgerEntryViewSet.get_queryset`: filter `journal_entry__branch_id__in=allowed` when restricted (B-5).
- Response adds `branch: {id, label}` to the older reports too (same shape as the Cashbook) so the UI can show "All permitted branches". This is additive JSON.
- Journals with `branch = NULL` (legacy, and wholesale before item 5): visible to unrestricted users and admins only. Restricted users do not see them. **This changes the figures restricted users see.** See approval question P1-Q2.

**Migrations:** none.

**Tests** (`apps/financial/tests/test_report_branch_authorization.py`): build two branches with posted journals in each and a
user limited to branch A. For **each** report URL in `financial/urls.py` (parametrised from one list):
`?branch=B` returns 403; no parameter gives figures equal to branch A only; `?branch=all` gives A only; an admin with no parameter gets A+B; single-branch mode is unchanged from the current snapshot.
Plus `ledger-entries` list and `chart-of-accounts?with_balances=1` totals.

---

### Item 4 — Branch authorization in journal entries (B-4, N3, N4)

**Design**
- `JournalEntryViewSet.get_queryset`: when restricted, filter `branch_id__in=allowed`. The detail-route actions (`post`, `reverse`, `correct`, `correction`, `destroy`, `update`) inherit it, so other branches' journals give 404.
- `create` / `correct`: replace `_branch(data.get('branch'))` with `resolve_write_branch(request, requested_id)`:
  multi-branch off → `None` (today's behaviour); no id → the request's active branch; an id outside `allowed` → 403; an unknown id → 400.
- `BranchScopedViewSetMixin` (N4): validate a client-supplied `branch` in `_branch_stamp_kwargs` against `allowed_branch_ids` (403). Add `perform_update`, which refuses moving a row into a branch the caller cannot access. This hardens every scoped viewset (sales, purchase, returns, stock). It is a no-op for unrestricted users and in single-branch mode.
- Settlement, cheque and pending-bank endpoints already use `_request_branch` or `_check_branch_access`. Re-verify them in the test sweep.

**Migrations:** none.

**Tests** (`apps/financial/tests/test_journal_branch_authorization.py`, `apps/common/tests_branch_isolation.py`):
a restricted user posting a voucher with `branch=B` gets 403 and nothing is saved (including no cheque rows and no idempotency key consumed). With no branch, the voucher is stamped with the active branch. Reverse, correct, post or delete of a branch-B journal returns 404. An admin can do all of them. A generic test over every `BranchScopedViewSetMixin` viewset: create with `branch=B` returns 403; PATCH moving to B returns 403.

---

### Item 5 — Branch relationship on wholesale documents (B-1, N5, N6)

**Models:** `WholesaleQuotation`, `WholesaleOrder`, `WholesaleDeliveryChallan`, `WholesaleInvoice`,
`WholesalePaymentCollection`, `WholesaleReturn` each get
`branch = ForeignKey('company.Branch', SET_NULL, null=True, blank=True, db_index=True, related_name='+')`. This is the same
definition `Invoice.branch` uses, so `BranchScopedViewSetMixin._model_has_branch` picks it up. `Dealer` and
`WholesalePriceList` stay company-wide, as the audit decided.

**Migrations**
- `sales/0037_wholesale_branch.py`: six `AddField` operations (nullable, indexed). Reverse is `RemoveField`.
- `sales/0038_backfill_wholesale_branch.py`: `RunPython(forward, reverse)`, per tenant. Precedence, using only unambiguous evidence:
  1. Invoice: `stock_applied['branch']` if that branch still exists in the tenant.
  2. Invoice: the branch of `StockLedger` rows with `reference_id = invoice.id`, if there is exactly one distinct branch.
  3. Order: its billed `invoice.branch`. Challan: `order.branch`. Collection: the invoice matched by `invoice_number` → its branch. Return: the original invoice by `invoice_number` → its branch.
  4. The tenant has **exactly one** branch → that branch.
  5. Otherwise `NULL` (shown to admins as "Unassigned"). The audit's "otherwise the default branch" is **not** used, because it would assign another branch's documents to head office. See P1-Q3.
  Reverse: set `branch = NULL` only on rows the forward run set. The migration records the ids in a temporary table, or reverse is a documented no-op because the column is dropped by the schema reverse anyway.
  Prints a per-tenant summary (assigned by rule 1…4 and unassigned).

**Views:** add `BranchScopedViewSetMixin` first in the bases of the six viewsets (`sales/views.py:1730-1910`). Their existing
`perform_create` / `perform_update` must merge `_branch_stamp_kwargs(serializer)`. `wholesale_stock._location` (N5): validate
the warehouse's branch against `allowed_branch_ids`, and prefer `inv.branch` when set. `wholesale_orders` reservation and
POS order-to-sale linking: the order and the invoice must share a branch, or the caller must be an admin.

**Accounting (N6):** `build_wholesale_invoice`, `build_wholesale_collection` and `build_wholesale_return` set `'branch': inv.branch`
(or col/ret). This applies to **new and re-posted** documents only. Existing journals keep `branch = NULL` unless P1-Q3 approves the
optional `backfill_wholesale_journal_branch` command (per tenant, dry run first, updates `JournalEntry.branch` only where the
source document's branch is now known, writes a `FinancialAuditLog` row per change).

**Frontend:** `WholesaleSales.jsx` and the order/quotation screens send nothing new (the server stamps the branch). Reports and lists
show the branch column. The localStorage offline queue is unaffected: the server stamps on replay. Cross-branch POS edit of a
held invoice is refused with a clear message.

**Rollback:** reverse 0038, then 0037. Code before this item ignores the column.

**Tests** (`apps/sales/tests/test_wholesale_branch.py`): each of the six endpoints in multi-branch mode: a list as a branch-A user shows only A; detail of a B document returns 404; create stamps A; create with `branch=B` returns 403. A POS sale with a branch-B warehouse id returns 403 and moves no stock. The posted journal carries the branch. Backfill unit tests for every rule 1–5, idempotency (second run changes 0), and rows already set are never overwritten. Single-branch tenant: behaviour and JSON unchanged apart from the new `branch` key.

---

### Item 6 — Relational branch on eye exams and appointments (B-2)

**Models:** `EyeExamination.branch_ref` and `Appointment.branch_ref`, each
`ForeignKey('company.Branch', SET_NULL, null=True, blank=True, db_index=True, related_name='+')`. The text `branch` stays as
a historical, printed label.

**Migrations**
- `sales/0039_exam_appointment_branch_ref.py`: two `AddField` operations.
- `sales/0040_backfill_exam_appointment_branch_ref.py`, per tenant: normalise the text (trim, collapse spaces, casefold) and match
  **exactly one** active or inactive branch by `name` or `code`. The literal default `'Main Branch'` maps to the tenant's branch only when
  the tenant has exactly one branch (P1-Q4). Anything else stays `NULL`. Reverse is a no-op. Prints unmatched distinct values with counts for manual mapping.
- Optional management command `map_exam_branches --map "City Clinic=<branch uuid>"` for the unmatched values, dry run by default.

**Views:** `EyeExaminationViewSet` and `AppointmentViewSet` set `branch_field = 'branch_ref'` and add `BranchScopedViewSetMixin`.
`_model_has_branch` already rejects the text field and accepts the FK. On create, stamp `branch_ref` from the active branch **and**
fill the text `branch` from `branch_ref.name` when it is empty, so prints and `eyeTestReport.js` keep working. The serializer exposes
`branch_ref` and `branch_name` (read-only, from the FK, else the text). The Eye Test lookup (`eye_test_lookup.py`), report (`eye_test_report.py`),
sales-report exam linking and the multi-branch dashboard filter by `branch_ref` where they currently ignore the branch.

**Frontend:** `Step1PatientInfo.jsx` keeps its editable text box for display. The server decides `branch_ref`.
`Appointments.jsx` stops hardcoding `'Main Branch'` and uses the active branch name.

**Patient records (`Customer`) stay company-wide.** A restricted user can still open a patient. They see only their branch's visits.
P1-Q5 confirms this.

**Rollback:** reverse 0040 (no-op), then 0039.

**Tests** (`apps/sales/tests/test_exam_branch_ref.py`): the backfill matches by name, by code, ignoring case and spacing; leaves
ambiguous and unknown values `NULL`; maps `'Main Branch'` only for one-branch tenants; is idempotent. Restricted-user list and detail
return 404 for a branch-B visit. Create stamps both fields. Test No sequencing and the "each visit = new row" rule are unaffected
(existing test suites must stay green).

---

### Item 7 — Real stock transfer between branches (B-6, N9, N10)

**Current state:** `StockTransfer` + `StockTransferItem` CRUD exists (`/api/company/stock-transfers/`), with **no** stock movement
and **no frontend**. Production row count must be checked before deploy (pre-flight query below). It is expected to be 0.

**Workflow (two-step, recommended; see P1-Q6):**
`DRAFT → DISPATCHED (stock out of the source branch, in transit) → RECEIVED (stock into the destination branch)`, plus `CANCELLED`
(from DRAFT: nothing to undo; from DISPATCHED: stock returns to the source). One-step "Complete" = dispatch and receive in one transaction.
Partial receipt is **not** in P1 (received quantity = dispatched quantity).

**Model changes** (`company/0013_stock_transfer_apply.py`, all additive):
- `StockTransfer`: status choices gain `DRAFT`, `DISPATCHED`, `RECEIVED`. Existing `PENDING` is treated as `DRAFT` and `COMPLETED` as already applied (legacy, no stock effect). Choice changes are state-only. Add `from_warehouse`/`to_warehouse` (nullable FK), `dispatched_at`, `received_at`, `dispatched_by`, `received_by` (CharField actor, like `StockLedger.performed_by`), and `stock_applied` JSON (`{'out': {pid: qty}, 'in': {pid: qty}}`) as the idempotency record.
- `StockTransferItem`: `unit_cost` (nullable decimal, captured at dispatch for valuation).
- `transfer_number` from the tenant `DocumentSequence` (`TRF-` prefix) instead of a time-based number (N9).

**Service** `apps/inventory/branch_transfer.py`:
- `dispatch(transfer, user)`: `select_for_update` on the transfer → refuse unless DRAFT → for each line, `adjust_branch_stock_many({p: -q}, from_branch, ledger={'transaction_type': 'TRANSFER', 'reference_id': transfer.id, 'reference_number': transfer.transfer_number, 'warehouse': from_wh}, enforce_stock=True)` → record `stock_applied['out']` → status DISPATCHED. One transaction.
- `receive(transfer, user)`: refuse unless DISPATCHED → `adjust_branch_stock_many({p: +q}, to_branch, …)` → `stock_applied['in']` → RECEIVED.
- `cancel(transfer, user)`: a DISPATCHED transfer reverses `stock_applied['out']` back into the source branch.
- Product.stock (the sum across branches) is unchanged by a completed transfer. While a transfer is in transit, the sum is lower by the in-transit quantity. Stock Overview shows an "In transit" figure from DISPATCHED transfers, the same way it shows "Ordered (Reserved)".
- Re-calling any step is a no-op through the status guard and `stock_applied`. Double-click and retry safe, with the existing Idempotency-Key middleware.

**Authorization:** dispatch needs access to `from_branch`; receive needs access to `to_branch`; admins can do both.
`from_branch != to_branch` is validated. Both branches must be active. Lines must be stock-tracked products (services excluded). Quantities must be > 0.
Endpoints: `POST /api/company/stock-transfers/<id>/dispatch|receive|cancel/`. Generic PUT/PATCH is allowed only while DRAFT. DELETE only while DRAFT.

**Accounting** (P1-Q6): inventory value moves between branches. Without a journal, branch balance sheets show stock at the wrong
branch. Recommended: dispatch posts `Dr Goods in Transit / Cr Inventory` (branch = from); receive posts
`Dr Inventory / Cr Goods in Transit` (branch = to), at `unit_cost × qty`, through the accounting engine (`source_module='inventory', source_event='branch_transfer'`)
with a new `GOODS_IN_TRANSIT` role in `accounting_catalog` and default mappings created by `ensure_tenant_defaults`. A failure goes to the existing failure
queue and never blocks the stock movement. Alternative: stock only, no journal (simpler; branch inventory figures stay approximate).

**N10 `WarehouseTransfer`:** make `_apply_transfer` run only on the transition into COMPLETED (compare with the previous status under lock), or
retire the endpoint if no UI uses it (none found in `frontend/src`). Recommend fixing it in P1 because it is a live double-count path.

**Frontend:** new Inventory → **Branch Transfers** screen (list with status chips, create/edit draft, Dispatch / Receive / Cancel buttons,
print transfer note). Follows `useBranch()`. The destination-branch user sees "Incoming" transfers to receive.

**Rollback:** reverse 0013 (state-only choices plus nullable columns). Any already-applied transfers must be reversed with `cancel` before
the code is rolled back. The runbook gives the query to find them.

**Tests** (`apps/inventory/tests/test_branch_transfer.py`): dispatch reduces `BranchStock[from]` and leaves `[to]` unchanged; receive increases `[to]`;
Product.stock is the same before and after the full cycle; ledger rows on both sides carry the reference. Dispatch twice gives one movement.
Cancel after dispatch restores. Negative-stock block refuses dispatch and saves nothing. A restricted user cannot dispatch from, or receive into,
a branch they lack. Cross-tenant: a transfer id from tenant B returns 404. Concurrency: two parallel receives give one movement
(Postgres-only test, skipped on SQLite). Journal pair balances and is branch-tagged (if approved). `WarehouseTransfer` repeated PATCH
gives one movement.

---

### Item 8 — User-ID-based branch access (B-7, N11)

**Model:** `UserBranchAccess.user = ForeignKey(settings.AUTH_USER_MODEL, CASCADE, null=True, blank=True, related_name='branch_access')`.
`username` is kept and kept in sync for display and backward compatibility.

**Migrations**
- `company/0014_userbranchaccess_user.py`: `AddField`.
- `company/0015_backfill_userbranchaccess_user.py`, per tenant: match `User` with `tenant_id = row.tenant_id AND username = row.username` (**exact** first, then `iexact` only when exactly one user matches). Never match across tenants. Unmatched rows (orphans of deleted users, or legacy localStorage-only users) stay `user = NULL` and are listed in the output. Duplicate rows for one user: keep the newest, report the others, delete nothing.
- `company/0016_userbranchaccess_unique_user.py`: `UniqueConstraint(fields=['tenant','user'], condition=Q(user__isnull=False))`. Ship it only after the backfill reports zero duplicates in production. It is a separate deploy step.

**Resolution** (`common/branch_context.py`): read the `user_id` claim from the token (already decoded by `token_identity`). Look up `UserBranchAccess` by
`user_id` first and fall back to `username__iexact` **only** for rows with `user IS NULL`. On fallback, self-heal by stamping `user`. Cache key
becomes `branch:access:u<user_id>`. The cache clear on save (`apps/common/apps.py` hot-cache list) already covers `UserBranchAccess`. Add a clear on user delete.
Requests without a token (no tenant scope, so they see nothing) keep the header path unchanged.

**Writers:** `UserBranchAccessViewSet` (accepts `user` id; derives `username`), `superadmin_views._save_branch_access`,
`tenant_onboarding` (owner gets all-branch access), Administration → Users (`user_admin.py`). All write `user` and `username`.
User deletion cascades its access row, which fixes N11. `Administration.jsx` keeps sending `username`; the server resolves it to `user`.

**Behaviour change to flag:** a row whose user cannot be matched no longer applies to a **new** user created later with the same name.
That user starts unconfigured, which today means all branches (B-8 fail-open). See P1-Q1.

**Rollback:** reverse 0016, 0015 (no-op), 0014. Resolution code falls back to username.

**Tests** (`apps/company/tests/test_user_branch_access_id.py`, extending `apps/common/tests_tenant_crud.py`): backfill exact, iexact-unique and ambiguous
cases. A cross-tenant same username never links. Delete a user and re-create the same username: no inherited access. Self-heal stamps
`user`. A token for user X with an `X-User-Name: admin` header still resolves X's access (regression for the header-spoof fix). Cache is invalidated on access
edit and user delete.

---

## 3. Isolation and regression test programme

| Suite | New file | Purpose |
|---|---|---|
| Branch isolation sweep | `apps/common/tests_branch_isolation.py` | Parametrised over every branch-aware list/detail/report URL (collected from the URL resolver + an explicit list for function views). Two branches, a user limited to A. `X-Branch-Id: B` and `?branch=B` return 403 or no rows. **Written first; it fails on today's code for B-1…B-5 and N1–N4** and goes green as items land. |
| Model tenant isolation (I6) | `apps/common/tests_model_isolation.py` | For every concrete `TenantOwnedModel`/`BaseUUIDModel`: a row in tenant A is invisible and unwritable in tenant B. Covers the new fields automatically. |
| Anonymous sweep (I4) | `apps/common/tests_anonymous_endpoints.py` | Every GET without a token on two seeded tenants returns no tenant data. Allow-list: health, login, store branding. Catches a regression of item 1. |
| Per-item suites | listed under each item | Behaviour + backfill + rollback. |
| Migration round-trip | `apps/common/tests_p1_migrations.py` | `MigrationExecutor`: migrate to the pre-P1 state, seed rows, migrate forward (backfill assertions), migrate back, migrate forward again (idempotent). |
| Existing suites | all | Must stay green on SQLite and on Postgres 17 (Neon branch for the cloud; local PG 17 for the Windows edition). |

Single-branch regression guard: snapshot the JSON of key endpoints (sales list, reports, wholesale list) for a single-branch tenant
before and after. The only allowed difference is new keys.

---

## 4. Migration and rollback strategy

**Migration inventory (proposed numbering; recheck against `main` at implementation time)**

| App | File | Type | Reversible |
|---|---|---|---|
| purchasing / products / company | `AlterField upload_to` ×4 | State only | Yes |
| sales | 0037 wholesale `branch` ×6 | Additive schema | Yes (`RemoveField`) |
| sales | 0038 backfill wholesale branch | Data | Yes |
| sales | 0039 exam/appointment `branch_ref` ×2 | Additive schema | Yes |
| sales | 0040 backfill `branch_ref` | Data | Yes (no-op) |
| company | 0013 stock transfer fields + choices | Additive schema | Yes |
| company | 0014 `UserBranchAccess.user` | Additive schema | Yes |
| company | 0015 backfill access user | Data | Yes (no-op) |
| company | 0016 conditional unique (tenant, user) | Constraint | Yes; deployed separately after duplicate check |
| financial | `GOODS_IN_TRANSIT` role default (if P1-Q6 = journal) | Data via `ensure_tenant_defaults` (bumps `defaults_version`) | Yes |

**Pre-deploy (cloud)**
1. Whole-DB backups are disabled on the multi-tenant cloud, so the restore point is a **Neon branch** (or `pg_dump`) taken immediately before migrating. Record its name in the release note.
2. Rehearse on a Neon branch copy of production: `migrate --plan`, then `migrate`, then run the backfill dry-run reports, then the full test suite against that branch.
3. Pre-flight read-only queries (run on the rehearsal branch, not production): row counts per tenant for wholesale documents, exams, appointments, `StockTransfer` (expected 0), `UserBranchAccess` rows with no exact username match, distinct exam `branch` texts.
4. Review the backfill reports (unassigned counts) before the production run.

**Deploy order (each step is a separate, reversible release)**
1. Test harness + items 3, 4 (no migrations).
2. Item 2 (no migrations).
3. Item 1 code + `upload_to` state migrations; then `relocate_media --dry-run`, then `--apply`.
4. Item 8 schema + backfill + resolver; 0016 constraint later.
5. Item 5 schema; then backfill; then viewset enforcement.
6. Item 6 schema; then backfill; then enforcement.
7. Item 7 schema + service + UI.

**Rollback**
- Code-only items (2, 3, 4): redeploy the previous build.
- Migration items: `migrate <app> <previous>` (schema reverse drops only the new nullable columns, whose content can be re-derived), then redeploy the previous build. The backfills never modify existing columns, so no customer data is lost by a rollback.
- Last resort: restore the Neon branch from step 1 (this loses writes made since the deploy; use only for corruption).
- Transfers already DISPATCHED/RECEIVED must be cancelled through the service before rolling back item 7.

**Local / Windows edition:** the same migrations ship in the P7 updater path (pre-update `pg_dump`, `migrate --plan` gate, rollback). No P1-specific local work.

---

## 5. Prioritized execution plan

| Order | Work | Why this position | Est. (1 dev) |
|---|---|---|---|
| 1 | Branch isolation sweep + model/anonymous isolation tests (failing first) | Safety net. Measures every later fix. | 1.5 d |
| 2 | **Items 3 + 4** (report and journal branch checks, N1–N4, mixin hardening) | Live data exposure and unauthorised writes today; no migration; lowest deploy risk | 2 d |
| 3 | **Item 1** private media | Unauthenticated download of supplier bills on the cloud (High) | 1.5 d |
| 4 | **Item 2** backup service-layer gate + restore tenant check | Small; closes the scheduler/CLI all-tenant archive path | 0.5 d |
| 5 | **Item 8** user-ID access | Every branch check depends on correct access resolution; do before adding more branch-scoped documents | 1.5 d |
| 6 | **Item 5** wholesale branch FK + backfill + posting branch | Largest functional gap (B-1); needs the mixin hardening (order 2) and item 8 in place | 2 d |
| 7 | **Item 6** exam/appointment `branch_ref` | Same pattern as 6, lower risk | 1 d |
| 8 | **Item 7** stock transfer service + UI (+ N10 fix) | New feature; depends on the authorization helpers (order 2) and item 8 | 3 d |
| 9 | Neon rehearsal, backfill review, staged production deploy, monitoring | Release gate | 1 d |
| | **Total** | | **≈ 14 dev days** (the roadmap's 1.5 wk estimate did not include the transfer UI or N1–N11) |

Exit criteria (from architecture §11, P1): the new isolation suites pass on the cloud stack and on PostgreSQL 17 on Windows; the existing suites
pass unchanged; no single-branch tenant sees a behaviour change other than new response keys.

---

## 6. P1 implementation questions for approval

These are **not** architecture decisions D1–D9. They are implementation choices this plan needs before coding. Each has a recommendation.

| # | Question | Options | Recommendation |
|---|---|---|---|
| P1-Q1 | Include **B-8** (fail-closed default for users with no access row) in P1? It is in the audit's P1 list but not in the eight items requested. | (a) Leave fail-open as today; (b) add `BusinessSettings.branch_access_default` (ALL/NONE), default ALL on the cloud and NONE for new commercial installs | **(b)**. Small additive field. Keeps cloud behaviour unchanged. Closes the gap item 8 leaves for unmatched users. |
| P1-Q2 | Who sees journals with **no branch** (legacy, pre-item-5 wholesale) in financial reports? | (a) Restricted users see them; (b) only admins/unrestricted users | **(b)**. Fail closed. Restricted users' totals then exclude unassigned postings, and the report says so. |
| P1-Q3 | Wholesale backfill fallback and historic journals | (a) Default branch when unknown (audit text); (b) `NULL` "Unassigned" unless the tenant has one branch. And: backfill old wholesale journals' branch? yes/no | **(b)**, and **yes, as an opt-in command run per tenant after a dry-run review**, not automatically in the migration. |
| P1-Q4 | Exam/appointment text `'Main Branch'` with several branches | (a) Map to the default branch; (b) leave `NULL` | **(b)**. The text was a hardcoded UI default, not evidence of where the exam happened. |
| P1-Q5 | Should a branch-restricted user still open **patients** (`Customer`) from other branches? | (a) Yes, patients are company-wide (audit position); visits are branch-scoped; (b) restrict patients too | **(a)**. Patients move between branches. Restricting them is a larger P2-level change. |
| P1-Q6 | Stock transfer: workflow and accounting | Workflow: two-step with in-transit / one-step only. Accounting: Goods-in-Transit journal pair / stock only | **Two-step (one-step "Complete" also offered) + Goods-in-Transit journals** |
| P1-Q7 | Purchase attachment and import-file access: signed short-lived link vs header-authenticated fetch (blob) | Signed link (60 s) / blob download in the SPA | **Signed link**. It reuses the backup download pattern and works with the browser's native viewer. |
