# P1 — Remaining Security Gaps and Open Decisions

> **Update 2026-11-11 (final verification):** the five decisions in §2 were approved and applied.
> G1 (fail-closed), G2 + G10 for Stock Overview, and G12 (`AUTO_MIGRATE=False` in production) are
> closed; G3 and G8 are confirmed as implemented. See `P1_FINAL_RELEASE_READINESS.md` §2 and §8 for
> what remains.

**Date:** 2026-11-11. What P1 did **not** close, why, and what is needed. Nothing here was skipped
silently. Each gap is either outside P1 scope, needs an approval, or is a known limit of the interim rule.

## 1. Known gaps

| # | Gap | Impact | Why not closed in P1 | Needed |
|---|---|---|---|---|
| G1 | **B-8 fail-open default.** A user with no `UserBranchAccess` row gets every branch. After Task 4 this also applies to a *new* user created with a deleted user's name, and to a case-variant username. | A newly created staff user in a Multi-Branch tenant sees all branches until an admin assigns them. | P1-Q1 (fail-closed default) was not approved; changing it would lock out every unconfigured user on the cloud. | Approve P1-Q1 option (b): `BusinessSettings.branch_access_default` (ALL on cloud, NONE for new commercial installs). |
| G2 | **Stock Overview quantity / value columns** show `Product.stock` (sum of all branches) to branch-restricted users. Product history is now scoped (Task 8). | A restricted user can see company-wide on-hand totals per product. | Changing the grid to per-branch figures is a functional change to Stock Overview (sorting, filters, export, low-stock rules). | Decide: per-branch figures for restricted users (recommended) vs keep company totals. ~1 day. |
| G3 | **Historic wholesale journals** (posted before P1) still have `branch = NULL`, so restricted users' financial reports exclude them and unrestricted users see them as unassigned. | Branch P&L excludes old wholesale business. | P1-Q3: tagging posted journals is opt-in after a dry-run review, never automatic. | Review `branch_backfill_report --wholesale-journals` (dry run) per tenant, then approve `--apply`. |
| G4 | **Unassigned legacy records** (wholesale docs, exams without unambiguous evidence) are visible to unrestricted users only. | A restricted user cannot see their own branch's old records that could not be proven. | Never guess (task rule). | Manual mapping: `branch_backfill_report --tenant N --map-exam "Text=<branch id>"`; wholesale mapping can be added the same way if needed. |
| G5 | **Archive ownership** cannot distinguish two installs that both kept tenant 1 / `default` / the same name. | One such customer could restore the other's archive if they obtained it (it must still be uploaded by an Owner). | No per-installation identity exists before the licence work (D4/D6). | Add an installation id to the manifest and compare it (P2/P8). |
| G6 | **Whole-DB backup policy is the interim single-tenant rule** (unchanged). | Cloud recovery relies on Neon PITR / branching and per-client exports. | D1 (Organization) not approved. | D1 → P2 replaces `policy.whole_db_allowed()` with the organization rule. |
| G7 | **Media on Render is ephemeral**; existing cloud attachments may already be lost. | Missing files answer 410 (reported by `relocate_media`). | Durable object storage is outside P1. | Object storage (S3-compatible) decision. |
| G8 | **Patients (`Customer`) are company-wide** (P1-Q5 recommendation). Exam visits are branch-scoped. | A restricted user can open any patient record (not other branches' visits). | Restricting patients is a P2-level change. | Confirm P1-Q5. |
| G9 | **Sales-report exam linking / exam billing references** may name a bill from another branch on a visit's report. | Minor: invoice number only. | Low risk; report code paths not refactored. | Scope `build_billing_reference` by branch in a later pass. |
| G10 | **Wholesale order reservations** ("Ordered" figure in Stock Overview / POS availability) are company-wide quantities. | Quantities only, no amounts or parties. | Same functional question as G2. | Decide with G2. |
| G11 | **Company isolation (P2).** All P1 rules assume one company per tenant: branches, accounts and documents are scoped by tenant + branch only. A tenant with two companies would share chart of accounts, sequences and reports. | None today (one company per tenant is how every tenant is onboarded). | P2 scope (do not start). | P2 Organization / multi-company design. |
| G12 | **`AUTO_MIGRATE` boot hook** applies migrations whenever a process boots (it applied P1 migrations to the local dev DB during this work). | A deploy could apply schema before review if the env flag is left on. | Behaviour change to deploy tooling needs your approval. | Set `AUTO_MIGRATE=False` for P1 deploy and local dev (see rehearsal plan). |

## 2. Decisions needed before deploy

1. **P1-Q1 / G1** fail-closed default for unconfigured users — recommended (b).
2. **G2 / G10** Stock Overview per-branch quantities for restricted users — recommended yes, as a P1.1 item.
3. **G3** run the historic wholesale journal tagging after the dry-run review — recommended yes.
4. **P1-Q5 / G8** patients stay company-wide — recommended yes.
5. **G12** `AUTO_MIGRATE=False` for the P1 production deploy — recommended yes.

## 3. Security risks introduced or changed by P1 (for review)

- Restricted users lose access to company-wide accounting tools (posting failures, audit log, preview,
  backfill, opening balances, recompute, policy edits, fiscal periods, mappings, voucher types, groups,
  account create/edit). Expense-category quick-add remains available. **Behaviour change** for any
  branch-restricted accountant who used those screens.
- Restricted users' financial totals exclude unassigned (legacy) journals (P1-Q2, already in Task 1/2).
- `user-branch-access` list shows a restricted user only their own row; writes need every-branch access.
- Branch and warehouse masters: restricted users cannot change branches, and only manage warehouses
  in their own branches.
- Cross-branch `WarehouseTransfer` is refused (must use Branch Transfers); completed warehouse transfers
  are immutable.
