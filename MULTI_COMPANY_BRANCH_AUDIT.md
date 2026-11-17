# G-TRADE ERP — Multi-Company & Branch Isolation Audit

**Date:** 2026-11-11 · **Scope:** read-only review of company and branch support across inventory,
sales, purchase, accounting and billing, and a design for several companies per customer. Nothing was
changed. Parent document: `COMMERCIAL_WINDOWS_ARCHITECTURE.md`.

Legend: ✅ in place · ⚠️ partial · ❌ missing

---

## 1. Summary

| Level | Today | Verdict |
|---|---|---|
| **Company** | `company.Company` exists, but it is treated as a **singleton per tenant**: `store_profile.get_company()` uses "the oldest Company row", and `tenant_onboarding` creates exactly one. No business table references `Company`; only `Branch.company` does. Chart of accounts, sequences, products, customers, tax and every settings singleton are tenant-wide. | ❌ Multi-company is **not supported**. Adding a second `Company` row would mix both companies' books, stock and numbering. |
| **Branch** | Toggleable multi-branch mode (`BusinessSettings.multi_branch_enabled`), `BranchContextMiddleware` (identity from the signed token), `BranchScopedViewSetMixin`, per-branch stock (`BranchStock`), branch FK on the main transactional documents | ⚠️ Solid core with gaps (§3) |

**Recommendation:** implement companies as tenants under a new `Organization` (§5). Branch gaps are fixed
in phase P1 regardless, because they affect the cloud product today.

## 2. Company-level inventory of tenant-wide state

Everything below is per tenant today. Under "Company = Tenant" each company gets its own copy
automatically, which is the correct behaviour for separate legal entities.

| State | Where | Per-company needed? | Company = Tenant handles it? |
|---|---|---|---|
| Store identity, logo, GSTIN/VAT, address | `Company`, `billing.BillingSettings` | Yes | ✅ |
| Chart of accounts, journals, account mappings, failure queue | `apps/financial` | Yes (separate books) | ✅ |
| Fiscal year, currency | `Company.fiscal_year_*`, localization prefs | Yes | ✅ |
| Document numbering (invoice, PO, vouchers, Test No, Patient ID, barcodes) | `DocumentSequence*`, `PatientCodeSequence`, `TestNoSequence`, `BarcodeSeriesConfig` | Yes (statutory) | ✅ |
| Tax master and terminology, tax switch | products/company localization | Yes | ✅ |
| Products, categories, brands, units, variants | `apps/products`, `apps/masters` | Usually separate (decision D2) | ✅ (separate); "copy masters" tool needed |
| Customers / patients, eye exams | `apps/sales` | Separate by default | ✅ |
| Suppliers, dealers + party sub-ledgers | purchasing / sales / financial | Separate | ✅ |
| Bill/label templates, pricing rules, business settings, security policy | singletons via `.load()` | Yes | ✅ (`load()` is tenant-scoped through `TenantOwnedModel`) |
| Users and roles | `authentication.User.tenant` (one) | Users must reach several companies | ❌ needs `UserCompanyMembership` |
| Licence limits (companies, branches, users) | `Tenant.max_users` only | Org-level counting | ❌ needs `Organization` |

## 3. Branch isolation — module-by-module verification

`BranchScopedViewSetMixin` applies only when multi-branch is **on**. It filters to the active branch,
stamps `branch` on create, rejects off-limits `X-Branch-Id` with 403, and lets admins use `?branches=all`.

| Module / document | Branch FK | Scoped viewset | Stock per branch | Finding |
|---|---|---|---|---|
| Sales invoices / orders / quotations (`sales.Invoice`) | ✅ | ✅ `InvoiceViewSet` | ✅ via `adjust_branch_stock` | OK |
| Payments / receipts (`sales.Payment`) | ✅ | ✅ | n/a | OK |
| Sales returns, purchase returns | ✅ (`return_models.py`) | ✅ `_ReturnViewSet` | ✅ | OK |
| Purchase orders / invoices | ✅ | ✅ | ✅ | OK |
| Lens purchase orders | ✅ | ✅ | n/a until received | OK |
| Stock ledger / adjustments | ✅ | ✅ | ✅ | OK |
| Sales dashboard | via scoped base | ✅ | — | OK |
| **Wholesale** quotation / order / challan / invoice / collection / return | ❌ | ❌ (plain `ModelViewSet`, `apps/sales/views.py:1730–1905`) | ⚠️ `stock_applied` records a branch, but the document does not | **B-1** Branch-restricted users see and edit every branch's wholesale documents |
| **Eye examinations / appointments** | ⚠️ `branch` is a free-text `CharField` (`sales/models.py:319, 525`) | ❌ | n/a | **B-2** Not enforceable; text drifts when branches are renamed |
| Customers, services, dealers, price lists | ❌ (shared within company by design) | ❌ | — | Acceptable: masters are company-wide |
| Products / masters | ❌ (shared) | ❌ | ✅ `BranchStock` | Acceptable |
| **Financial reports** (trial balance, P&L, balance sheet, ledger) | journals ✅ | report views accept `?branch=` and pass it straight to `reports.posted_lines` (`financial/reports.py:27`) **without checking allowed branches** | — | **B-3** A branch-limited user can read another branch's financials. Cashbook/Day/Bank books check correctly (`_cashbook_branches`). |
| Journal / voucher create | ✅ | `_branch(data.get('branch'))` (`financial/views.py:371`) accepts **any branch id in the company** | — | **B-4** A user can post into an unauthorised branch |
| `LedgerEntryViewSet` | via journal | ❌ not branch-filtered | — | **B-5** |
| Chart of accounts (`branch` FK, nullable) | ⚠️ | Deliberately global | — | Acceptable; document it |
| **Stock transfers** (`StockTransfer`, `StockTransferItem`) | ✅ from/to | CRUD only | ❌ **no apply logic** (no call to `adjust_branch_stock`) | **B-6** Transfers do not move stock |
| `UserBranchAccess` | keyed by **username string**, not FK | — | — | **B-7** Renaming a user silently drops their branch restrictions (they become unrestricted, because `access is None` ⇒ all branches) |
| Branch default when access is unconfigured | `access is None ⇒ allowed = all` (`branch_context.py`) | — | — | **B-8** Fail-open default. Acceptable for the single-branch upgrade path, but needs a setting for "deny until assigned" in multi-company/commercial installs. |
| `Account.branch_name` (`apps/accounts/models.py:25`, default `'Main Branch'`) | legacy text | — | — | Legacy; verify unused before reporting on it |

### Billing / printing
- Bill templates and assignments are company-wide. Per-branch logo override exists (invoice branding). ✅
- Printed branch details come from `Branch` rows. ✅

### Accounting integration
- Postings carry `branch` from the source document (journals have a branch FK). Wholesale postings
  cannot carry one until **B-1** is fixed, so branch P&L under-reports wholesale. ⚠️

## 4. Branch fixes (phase P1, additive, cloud benefits too)

| ID | Fix | Migration? |
|---|---|---|
| B-1 | Nullable `branch` FK on the six wholesale documents; backfill from `stock_applied.branch`, otherwise the default branch; add `BranchScopedViewSetMixin` | Yes (additive, nullable) |
| B-2 | New nullable `branch_ref` FK on `EyeExamination`/`Appointment`, backfilled by matching name/code; keep the text field for history | Yes (additive) |
| B-3 | One helper `resolve_report_branches(request)` (generalise `_cashbook_branches`) used by every financial report | No |
| B-4 | Validate the journal/voucher `branch` against `allowed_branch_ids`; default to the active branch | No |
| B-5 | Filter `LedgerEntryViewSet` via `journal_entry__branch_id__in` | No |
| B-6 | Implement transfer dispatch/receive with `adjust_branch_stock` (out at dispatch, in at receipt, in-transit state, ledger rows both sides, idempotent) | Possibly a status field |
| B-7 | Add a nullable `user` FK to `UserBranchAccess`, backfilled from username; resolve by user id from the token | Yes (additive) |
| B-8 | `BusinessSettings.branch_access_default = ALL / NONE`; commercial installs default to `NONE` for non-admins | Yes (additive) |

Test plan: a parametrised test that creates two branches and a user limited to branch A, then calls every
branch-aware list/detail/report endpoint with `X-Branch-Id`=B and `?branch=B` and expects 403 or no rows.

## 5. Multi-company design: Company = Tenant + Organization

### 5.1 Model (additive)

```
common.Organization                     NEW   id, name, licence_org_id, created_at, is_active,
                                              max_companies, max_branches, max_users (from licence)
common.Tenant  + organization FK        NEW column (nullable → backfilled → required)
authentication.UserCompanyMembership    NEW   user, tenant, role, is_default, is_active,
                                              branch access stays in UserBranchAccess (per tenant)
```

- `User.tenant` remains the **home company**, so existing code is untouched.
- A membership's tenant must belong to the user's home organization (enforced in the service and checked by tests).
- Role is **per company** (a user may be Admin in company A and Cashier in B). The token carries the role for the active company.

### 5.2 Company switching

```
POST /api/auth/switch-company/  {tenant_id}
  → membership exists, active; tenant active; same org; licence permits
  → revoke current sid, issue new access+refresh with tenant_id, org_id, role(membership)
  → audit (SettingsAuditLog / TenantAuditLog: who, from, to, when, IP)
GET  /api/auth/my-companies/   → [{tenant_id, name, role, is_default, branches_count}]
```

Frontend: a company picker in `Header.jsx` (next to the branch switcher), plus a picker after login when the
user has more than one membership. On switch: store the new tokens, clear `active_branch_id`, run the
existing tenant scope-change reset (`localDataReset.js`) and the master-data cache invalidation, then reload.

### 5.3 Creating companies

- Org admin screen **Settings → Companies**: list, create, deactivate. Create calls the existing
  `tenant_onboarding.onboard_tenant()` (default branch, warehouse, chart of accounts, templates) with
  `organization = current org`. Optional "copy masters from company X" (categories, brands, units, tax, products without stock).
- The licence check counts companies per organization (licence design §5).
- Deleting a company is not offered; only deactivation (data retention for statutory reasons).

### 5.4 Consolidated views (decision D3)

- v1: read-only **organization dashboard** (sales, stock value, receivables per company) built by
  looping `tenancy.use_tenant(t)` for each tenant the user is a member of. No `unscoped()`.
- Later: inter-company transfers (a sale in A plus a purchase in B, generated as a pair) and consolidated financial statements.

### 5.5 Why not `company_id` on every row

| Factor | Company = Tenant | `company_id` everywhere |
|---|---|---|
| Models to change | 3 new/changed | ~100 models plus all uniques, sequences, singletons, raw SQL, caches, serializers |
| Isolation proof | Re-uses tested `TenantQuerySet` and `check_write` | A second, parallel scoping layer to build and prove |
| Per-company numbering, CoA, settings | Automatic | Each must be re-keyed |
| Shared masters across companies | Needs an explicit copy/sync feature | Natural |
| Consolidation | Loop over tenants | Single query |
| Cloud impact | Additive column + org table | Large migration on live data |

Shared masters are the only real loss, and they are usually **not wanted** between separate legal entities.

## 6. Risks

| Risk | Mitigation |
|---|---|
| Membership bug grants a company outside the org | Service guard, DB test, audit log, licence org check at token issue |
| Old tokens without `org_id` | Fall back to `tenant.organization`; refresh re-issues with the claim |
| Branch backfill guesses wrong (B-1, B-2) | Backfill only from unambiguous data; leave `NULL` otherwise and show "Unassigned" to admins |
| Users with branch restrictions lose access after B-7 | Backfill by exact username match; report unmatched rows |
| Cloud regressions | All additive; existing suites plus new isolation suites |

## 7. Implementation steps

| # | Step | Phase | Depends on |
|---|---|---|---|
| 1 | Branch isolation test suite (fails on B-1…B-5 today) | P1 | — |
| 2 | Fix B-3, B-4, B-5 (no migrations) | P1 | 1 |
| 3 | Fix B-1, B-2, B-7, B-8 (additive migrations + backfills) | P1 | 1 |
| 4 | Implement stock transfer apply (B-6) | P1 | 3 |
| 5 | `Organization` + `Tenant.organization` + cloud backfill | P2 | — |
| 6 | `UserCompanyMembership`, switch-company API, `org_id` claim | P2 | 5 |
| 7 | Company picker UI, scope reset, post-login picker | P2 | 6 |
| 8 | Settings → Companies (create via onboarding, copy masters) | P2 | 6 |
| 9 | Organization dashboard (read-only consolidation) | P2/P9 | 7 |
| 10 | Licence counting hooks (companies, branches, users) | P6 | 5, 8 |
