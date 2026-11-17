# P1 — Test Results

**Date:** 2026-11-11 · Local PostgreSQL 17.10, fresh test database (`--noinput`), Windows 11.
`OPENBLAS_NUM_THREADS=1` was needed (numpy's OpenBLAS could not allocate memory on this machine).

## Final run (all P1 work in place)

| Check | Result |
|---|---|
| `manage.py check` | No issues |
| `manage.py makemigrations --check --dry-run` | No changes detected (models and migrations in sync) |
| `manage.py test apps` | **1027 tests, OK** (0 failures, 0 errors), 2192 s |

1027 = 958 existing tests + 69 new P1 tests. The "705" quoted for the previous cycle was a subset run;
this run is the entire backend.

## New P1 tests (69)

| Module | Tests | Covers |
|---|---|---|
| `apps/common/tests_p1_completion.py` | 51 | Tasks 1, 2, 4, 5, 6, 7, 8 and single-branch regression |
| `apps/security/tests/test_backup_tenant_gate.py` | 18 | Task 3 (see `P1_BACKUP_AND_RESTORE_VERIFICATION.md`) |

| Class | Task | What is asserted |
|---|---|---|
| `AccountingSecurityTests` (7) | 1 | 13 company-wide accounting endpoints → 403 for a restricted user, allowed for the admin; policy/mappings still readable; mapping roles for another branch 403; COA `current_balance` scoped (30 vs 130); expense quick-add allowed; settlements list and settle only permitted-branch bills |
| `AttachmentSecurityTests` (8) | 2 | private random path, API never returns `/media/`; other branch 404, other tenant 404, anonymous refused; signed link works, tampered/expired/deactivated refused, branch re-checked at download; HTML/SVG/fake-PDF refused; legacy attachment served; public media route refuses private paths and traversal; `relocate_media` dry-run/apply/idempotent |
| `UserIdBranchAccessTests` (7) | 4 | rows linked by id; rename keeps permissions; case-variant user does not inherit; deleted user's access goes, namesake starts unconfigured; API upserts per user; restricted user sees only own row; backfill links the old-rule row, clones case-variants, reports orphans, verifies, idempotent; `verify_branch_access` passes |
| `WholesaleBranchTests` (10) | 5 | list/detail/update/delete scoped (unassigned hidden from restricted, shown to admin); create stamps branch, foreign branch 403; collections/returns follow invoice branch; POS sale from another branch's warehouse 403 with no stock moved; POS sale stamped with stock branch; journal plan carries the branch; dealer directory scoped; backfill W1–W4, evidence-only, never overwrites, idempotent; single-branch tenant |
| `ExamAppointmentBranchTests` (5) | 6 | exams/appointments scoped incl. report; create stamps `branch_ref` + label, foreign branch 403; text-matching rules (case, space, code, `Main Branch`, ambiguous); backfill keeps text, reports unmatched, idempotent |
| `StockTransferWorkflowTests` (10) | 7 | full cycle with partial receive (stock 10 → 6/0 → 6/4, Product.stock restored); no double dispatch/receive (409); over-receive refused; cancel returns in-transit (CANCELLED / CLOSED); negative-stock block; drafts-only edit/delete; sender/receiver authorization; cross-tenant 404; validation; Goods-in-Transit journals balanced and branch-tagged; in-transit summary; N10 warehouse transfer moves once, immutable, cross-branch refused |
| `RemainingBranchGapTests` (4) | 8 | stock history scoped; warehouse master scoped; branch master writes need every branch; single-branch mode unchanged |

## Failures found during the cycle and fixed

| Found | Cause | Fix |
|---|---|---|
| Transfer dispatch 500 | `SELECT … FOR UPDATE` over nullable warehouse join (Postgres) | `select_for_update(of=('self',))` |
| Signed link 500 | User primary keys are UUIDs | `str(user.pk)`; UUID checks in `user-branch-access` |
| 8 existing exam-numbering tests errored | They call `EyeExaminationViewSet().perform_create()` without a request | Stamping skipped when there is no request (pre-P1 behaviour) |
| 1 existing isolation test (400 instead of 403) | Transfer update validated before authorizing | `update()` authorizes the stored and requested sending branch first |
| Several new-test mistakes | URLs, payloads, UUID vs string comparisons | Test fixes only |

## Environment notes

- The first baseline run had 1 failure (`test_health_reports_real_storage`): a `MemoryError` hashing a
  backup while the machine had < 1 GB RAM free. It passes in the final run.
- One full run aborted at test-DB creation (`could not create file … Invalid argument`) while a frontend
  build ran at the same time (Node also ran out of heap). Rerun alone: passed.
- **Frontend build not verified**: `vite build` aborted with "JavaScript heap out of memory" (machine
  RAM). Changed files: `pages/BranchTransfers.jsx` (new), `App.jsx`, `Sidebar.jsx`,
  `PurchaseEntryView.jsx`, `Appointments.jsx`. Run `npm run build` once memory is free.
- Not run: PostgreSQL concurrency test for parallel receives (correctness relies on the row lock +
  status guard, the same pattern as the existing stock code). Not run against a Neon branch (needs approval).
