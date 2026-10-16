# Accounting integration (apps.financial)

Every operational document that moves money or stock is booked into the double-entry ledger
by one engine. The Financial screens (COA, vouchers, GL, TB, P&L, Balance Sheet, reports) read
only the posted ledger.

## How a document reaches the ledger

```
post_save / post_delete (financial/signals.py)
  -> integration.schedule(source_key, id)            queued until the DB transaction commits
  -> integration.book_source()                       policy checks (enabled? historical?)
  -> posting_rules.build_*(document)                 the journal the document should have, in ROLES
  -> integration.materialize()                       roles -> accounts via AccountMapping
  -> services.sync_source_entry()                    post / leave unchanged / reverse + re-post
```

* Posting runs **after commit**, so a sale is never rolled back by an accounting problem. A
  failure is written to `PostingFailure` (never swallowed) and retried from
  *Financial → Accounting Integration → Failed postings* once fixed.
* **Exactly once:** a partial unique index allows one live (POSTED, non-reversal) entry per
  `(source_module, source_event, reference_id)`. Repeated saves compare the net effect per
  account (`lines_fingerprint`) and do nothing when it hasn't changed.
* **Corrections never edit a posted entry.** A changed document gets its old entry reversed
  (dated on the original date if that period is open, otherwise today) and a new one posted.
  Cancel / draft / soft-delete / convert-to-order reverses.

## Posting rules

| Source key | Posts when | Journal |
|---|---|---|
| `sales.invoice` | `document_type=INVOICE`, status not DRAFT/CANCELLED, not deleted | Dr Receivable (net), Dr Discount allowed; Cr Retail/Wholesale sales + Service revenue (split by line subtotal), Cr GST output. Stocked lines: Dr COGS / Cr Inventory at cost (cost snapshot kept in `metadata.unit_costs`) |
| `sales.payment` | not voided/deleted, amount ≠ 0 | Dr Cash / Bank / Card / UPI (by method); Cr Receivable when its bill is a live invoice, else **Customer advances**. Negative amount = refund (sides swap). Re-checked whenever its invoice changes. |
| `sales.wholesale_invoice` | not cancelled/draft/deleted | Dr Wholesale receivable; Cr Wholesale sales + GST output (`details.summary.totalGst`) |
| `sales.wholesale_collection` | amount > 0, method not "Credit Sale" | Dr Cash/Bank; Cr Wholesale receivable |
| `sales.wholesale_return` | not a "Replacement" | Dr Sales returns + GST output (pro-rata of the original invoice); Cr Wholesale receivable |
| `purchasing.purchase_invoice` | status CONFIRMED | Dr Inventory (total − tax − round off), Dr GST input, ± Round off; Cr supplier's own sub-ledger (`Supplier.ledger_account`, else Supplier payables) |
| `purchasing.purchase_payment` | paid amount > 0 (cash purchase = fully paid) | Dr Supplier payable; Cr Cash/Bank |
| `purchasing.purchase_order` | RECEIVED **and** the PO itself moved stock | Dr Inventory + GST input; Cr Supplier payable. A PO marked converted is booked by its Purchase Entry instead. |
| `inventory.stock_adjustment` | value (qty × cost) > 0 | ADD: Dr Inventory / Cr Stock gain. SUB: Dr Stock loss / Cr Inventory — or Dr **COGS** when the reason starts with "Wholesale POS sale" (that is how the Wholesale POS removes sold stock) |
| `financial.voucher` | manual RV / PV / CV / JV | as entered; RV must debit cash/bank, PV credit cash/bank, CV cash/bank only |
| `financial.opening_balance` | *Post opening balances* tool | account vs Opening balance equity |

Orders and quotations never recognise revenue; money taken against them sits in Customer
advances until the bill becomes an invoice. Inventory valuation is **last purchase cost**
(`Product.cost_price`, refreshed by every Purchase Entry).

## Configuration

* **Account roles** (`accounting_catalog.ROLES`): rules ask for a role, `AccountMapping` says
  which account. Mappings can be per branch and from an effective date; a mapping to an
  inactive account, or to the wrong account type, is refused before it is saved. A role with
  no valid mapping makes postings fail loudly (kind `MAPPING`), never silently.
* **AccountingPolicy** (singleton): master switch, per-source on/off, per-source go-live date
  (earlier documents are *historical* and are not auto-posted), backdating limit for manual
  vouchers.
* **FiscalPeriod**: a CLOSED period refuses every posting dated inside it. Only
  Administrators re-open.
* System accounts (`is_system`) can be renamed but not deleted, deactivated or re-typed.

## API (all under `/api/financial/`, JWT required)

Read: Super Admin, Administrator, Accountant, Manager. Write: Super Admin, Administrator, Accountant.

* `accounts/` (`?with_balances=1&search=&account_type=&status=`; `accounts/{id}/ledger/`), `groups/`
* `journals/` — register (`?status=&voucher_type=&source_module=&manual=1&search=&date_from=&date_to=&page=`);
  POST creates a voucher `{voucher_type_code, date, narration, reference_no, status: DRAFT|POSTED, idempotency_key, lines:[{account, debit, credit, memo}]}`;
  `journals/{id}/post/`, `journals/{id}/reverse/` (`{reason}`); PATCH/DELETE drafts only
* `reports/trial-balance/?as_of=`, `reports/profit-loss/?date_from=&date_to=`,
  `reports/balance-sheet/?as_of=`, `reports/general-ledger/?account=`, `reports/source-breakdown/`
* `integration/status/`, `integration/catalog/`, `integration/mappings/` (+ `roles/`, `validate/`),
  `integration/failures/` (+ `{id}/retry/`, `retry-all/`, `{id}/ignore/`), `integration/preview/?source_key=&id=`,
  `integration/reconciliation/`, `integration/backfill/`, `integration/periods/` (+ `close/`, `reopen/`),
  `integration/policy/`, `integration/opening-balances/`, `integration/recompute-balances/`, `integration/audit-log/`

## Migrations

* `0004_accounting_engine` — new columns (COA subtype / system flag / opening date; journal
  source fields, status DRAFT & PENDING_APPROVAL, idempotency key, branch, metadata) and new
  tables (AccountMapping, PostingFailure, FiscalPeriod, AccountingPolicy, JournalSequence,
  FinancialAuditLog).
* `0005_seed_accounting_integration` — default COA (existing accounts matched by code, then
  name, never renamed), one mapping per role, go-live date = migration day for sources that
  were never posted before, and adoption of entries written by the old sales/purchasing
  signal handlers. Old double-postings are re-tagged `legacy_duplicate_*` (still on the books,
  listed as duplicate alerts) so the unique index can be built.
* `0006_unique_live_journal` — the exactly-once index.

Rollback: `manage.py migrate financial 0003` drops the new columns/tables (the seeded accounts
and mappings stay as ordinary rows; journals posted meanwhile keep their lines).

## Deploying

1. `manage.py migrate` (runs on boot via `apps/common/startup.py`).
2. Restart every app server — a server still running the old code cannot insert journals
   into the new schema.
3. *Financial → Accounting Integration*: check Mappings are all valid; set Fiscal periods.
4. *Reconciliation & backfill*: review historical documents per source (dry run first), then
   either backfill them or record the history as opening balances (enter opening balances on
   the accounts, then *Policy & tools → Post opening balances*). Never both for the same history.
5. CLI equivalents: `manage.py accounting status|reconcile|backfill --source … [--commit]|retry-failures|recompute-balances`.

## Known gaps

* No retail sales-return / credit-note document exists; a retail return is booked by cancelling
  or editing the invoice, or as a refund receipt (negative Payment).
* Wholesale returns don't restock, so they reverse revenue/GST/receivable but not COGS.
* Wholesale invoices carry no branch; retail discount is booked at bill level, not per line.
* Expenses and fixed-asset purchases are entered as Payment / Journal vouchers (no expense module).
* `PENDING_APPROVAL` exists in the model; the UI offers Draft → Post, not a separate approver step.
