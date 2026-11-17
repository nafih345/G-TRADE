# P1 — Deployment Rehearsal Plan

**Status:** plan only. Nothing is committed, pushed or deployed. Production (Render + Neon) has not been
touched. Every step below needs your approval before it runs.

## 0. Prerequisites

1. Review and approve the P1 diff, then commit on a release branch (not `main` directly).
2. Confirm the open decisions in `P1_REMAINING_SECURITY_GAPS.md` §2 (B-8 fail-open default, Stock
   Overview quantities, wholesale journal backfill run).
3. Set `AUTO_MIGRATE=False` on Render **for this release** so the schema is applied deliberately, by a
   reviewed `migrate` step, rather than by whichever worker boots first (see `P1_MIGRATION_REPORT.md` §4).
4. Frontend build from the same commit (Branch Transfers page, attachment link, appointments default).

## 1. Rehearsal on a Neon branch copy of production

1. Create a Neon branch from production (`p1-rehearsal-YYYYMMDD`). Record its name.
2. Point a **local** shell at it (`DATABASE_URL=…branch…`, `EXPECTED_DATABASE_NAME=<branch db>`).
   Print `connection.settings_dict['NAME']/HOST` and confirm it is the branch, not production.
3. Run the pre-flight queries (`P1_MIGRATION_REPORT.md` §6) and save the output.
4. `manage.py migrate --plan` → expect exactly the 10 P1 migrations.
5. `manage.py migrate` → save the backfill lines it prints.
6. `manage.py verify_branch_access` → must print "Every user keeps the same branch access." (exit 0).
   Any `MISMATCH` line = stop.
7. `manage.py branch_backfill_report` (dry run) → zero further changes; review every Unassigned count and
   every unmatched exam text. Optional manual mapping: `--tenant N --map-exam "Text=<branch id>"`.
8. `manage.py relocate_media` (dry run) → note `missing` (Render's disk is ephemeral; old cloud
   attachments are probably gone already).
9. `manage.py branch_backfill_report --wholesale-journals` (dry run) → number of historic wholesale
   journals that would get a branch. Apply only if approved.
10. Run the backend test suite against a fresh test database on the same PostgreSQL version.
11. Rollback drill on the branch: the reverse commands in `P1_MIGRATION_REPORT.md` §5, compare row
    counts, then migrate forward again (must be idempotent).
12. Delete the Neon branch when done.

## 2. Production deploy (after the rehearsal is signed off)

1. Take a Neon branch / snapshot of production immediately before. Record it in the release note.
2. Deploy the backend with `AUTO_MIGRATE=False`; run `migrate` once, as a release step; restart
   (migrate and restart together, rule C8).
3. Run `verify_branch_access` and `branch_backfill_report` (dry run) on production; compare with the
   rehearsal numbers.
4. Deploy the frontend.
5. Smoke tests (one restricted user, one admin, per tenant with Multi-Branch on):
   - reports / journals / settlements show only permitted branches; integration tools 403 for the
     restricted user;
   - purchase attachment opens via "View" (signed link) and `/media/purchase_attachments/...` is 404;
   - wholesale lists scoped; POS sale from another branch's warehouse refused;
   - eye test create stamps the branch;
   - Branch Transfers: draft → dispatch → receive on a test product, stock and two journals correct;
   - Settings → Backup still disabled on the multi-tenant cloud; per-client backup still works.
6. `relocate_media --apply` later, separately, after the app is verified; `--delete-old` later still.

## 3. Rollback

- Code only: redeploy the previous build. Safe **only with** `company.0018` / `purchasing.0017` applied (N2, 2026-11-12):
  without them pre-P1 code cannot INSERT purchase entries or stock transfers (NOT NULL columns with no DB
  default). Verified: d5379f6's own 157 purchasing/company/inventory tests pass on the 12-migration schema.
  Before rolling code back, cancel or receive every DISPATCHED / PARTIALLY_RECEIVED transfer: old code can
  soft-delete an in-transit transfer through its unauthenticated transfer API.
- Schema: `P1_MIGRATION_REPORT.md` §5 (cancel in-transit transfers first).
- Last resort: the pre-deploy Neon snapshot (loses writes since the deploy).

## 4. Windows / local edition

No P1-specific installer work (Electron / installer are out of scope). The same migrations ship in the
future updater path (pre-update dump, `migrate --plan` gate, rollback).
