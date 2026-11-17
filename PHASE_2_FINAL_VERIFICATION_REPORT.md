# Phase 2: Final Verification Report

**Date:** 2026-11-12
**Scope:** final checks on the Phase 2 multi-company work (Company = Tenant + Organization) before any Phase 3 work. The design and the original results are in `PHASE_2_COMPLETION_REPORT.md`.

**Status:** all ten checks passed, and one new issue was found and fixed (Direct Edit switches shared across companies, §8). Nothing has been committed, pushed or deployed. Neon and production were not contacted. No business data was reset or changed.

---

## 1. Results at a glance

| # | Check | Result |
|---|---|---|
| 1 | Full backend test suite (after the last security fix) | **PASS**: 1,110 tests, OK, 0 failures, 0 errors (2,779.7 s) |
| 2 | All frontend unit tests | **PASS**: 195 of 195 (22 `test:*` scripts plus `inventoryCache`) |
| 3 | Production frontend build | **PASS**: `vite build`, 12,696 modules, 33.8 s, no errors |
| 4 | Browser end-to-end tests | **PASS**: 17 of 17 checks |
| 5 | Role-escalation fix in `PATCH /api/auth/profile/` | **PASS**: backend test and browser test |
| 6 | Company switching and the platform-workspace banner | **PASS**: 14 switching tests, 7 browser checks |
| 7 | Review of the remaining security gaps (§9 of the completion report) | Done. G2 is fixed now; G6 is confirmed fail-safe. The rest are unchanged (§7). |
| 8 | Direct Edit preferences shared across companies | **Fixed**: switches are now per company. Migration `common 0011`, 5 new tests. |
| 9 | Phase 1 branch restrictions inside a second company | **PASS**: 8 new tests |
| 10 | Migrations and rollback on a disposable database | **PASS**: forward, roll back to `common 0008` and re-apply, with no row lost |

Targeted re-run after the full suite (`apps.common.tests_multi_company` + `apps.authentication`): **83 tests, OK** (881 s). This run includes the 8 Phase 1 branch tests that were added after the full suite had started.

Across both runs, **1,118 distinct backend tests passed** and none failed.

---

## 2. Backend test suite (check 1)

- Command: `manage.py test --noinput -v 2` against the local throwaway test database (`OPENBLAS_NUM_THREADS=1`).
- Result: `Ran 1110 tests in 2779.690s` / `OK` / exit code 0.
- The run includes:
  - the role-escalation fix (profile `role` and `username` are read-only);
  - the workspace-banner fix (`get_workspace`);
  - the per-company Direct Edit change (§8);
  - all Phase 1 suites.
- The 8 tests in `P1BranchControlsInSecondCompanyTests` were written while this run was in progress, so they ran separately (§1, targeted re-run).
- The previous full run (before the last fix) was 1,105 tests, OK.

## 3. Frontend (checks 2 and 3)

**Unit tests:** every `npm run test:*` script exited 0. Exact counts from the TAP reporter:

| Set | Tests | Pass | Fail |
|---|---|---|---|
| 20 plain test files (includes `companies` with 10 tests and `inventoryCache` with 3, which has no npm script) | 180 | 180 | 0 |
| `apiWriteGuard` + `networkResilience` (need the `viteResolve` loader) | 15 | 15 | 0 |
| **Total** | **195** | **195** | **0** |

**Production build:**
- Command: `vite build`, written to a scratch folder so the repository's `dist/` was not touched.
- Result: exit code 0, 12,696 modules, built in 33.8 s, output 4.2 MB.
- The build includes the changed `EditPermissionsManager.jsx`.

## 4. Browser end-to-end tests (check 4)

**Setup:**
- Headless Chrome drove the dev frontend (Vite on port 5173).
- The frontend was pointed at a scratch backend on port 8010 with its own throwaway database, `gtrade_p2_e2e`. That database was created, migrated through `common 0011` and seeded with:
  - an owner whose organization has 2 companies;
  - a single-company cashier.
- The server and database were removed afterwards.

**Traffic check:** the login rows appeared in the scratch database (2 rows). The local dev database got no new rows during the run.

**Result: 17 of 17 checks passed:**

1. The company picker appears after login for a multi-company user.
2. The picker lists both companies.
3. The header shows the chosen company after switching.
4. The server session is scoped to the chosen company (`tenant_id 3`, `is_home: false`).
5. The previous company's token is revoked after switching (401).
6. A company member sees no platform-workspace banner.
7. The profile has no workspace flag after switching (`null`).
8. The header menu lists the other company.
9. Switching back from the header works.
10. The Organization → Companies page lists the companies.
11. The New company button is enabled while under the company limit.
12. The group summary shows both companies.
13. A single-company user goes straight into the app, with no picker.
14. A single-company user has no Organization menu.
15. A non-admin is redirected away from the organization pages.
16. A profile `PATCH` cannot change the role (`{"role":"ADMIN"}` sent, the user stays `CASHIER`).
17. After that attempt, the cashier is still refused by the organization API (403).

Screenshots are in the session scratchpad under `e2e/final/`.

## 5. Role-escalation fix (check 5)

**The fix:** `ProfileSerializer` lists `role` and `username` as read-only, so `PATCH /api/auth/profile/` ignores them.

**Evidence:**
- **Backend test `test_profile_cannot_change_role`:** a user sends a new role and the stored role is unchanged.
- **Backend test `test_member_profile_edit_saves_contact_details_only`:** inside a second company, contact details are saved on the real account, and the role stays as before.
- **Browser checks 16 and 17:** the request returns 200, the role stays `CASHIER`, and the organization API still answers 403.
- **The path that sets roles is still guarded:**
  - Roles can only be set through Administration → Users (`StaffUsersView` and `StaffUserDetailView`), which check `can_manage_role`.
  - `test_admin_cannot_hand_out_or_edit_higher_roles` passes.

## 6. Company switching and the workspace banner (check 6)

**What is verified:**
- Switching checks membership on the server.
- A switch ends the old session and issues new tokens carrying `tenant_id` and `org_id`.
- A company id or organization claim that doesn't match is refused on every request.

Passing tests:
- `test_switch_issues_new_scoped_tokens_and_ends_old_session`
- `test_switch_refused_without_membership`
- `test_switch_rejects_garbage_and_workspace`
- `test_forged_company_claim_is_rejected`
- `test_mismatched_org_claim_is_rejected`
- `test_refresh_keeps_the_company`
- `test_revoked_membership_locks_the_member_out_at_once`
- `test_switch_is_audited`
- `test_login_lists_accessible_companies`
- `test_login_starts_in_home_company_with_org_claim`

**Banner:** the platform-workspace banner now appears only for the platform owner's "Open workspace" session, never for an ordinary member who switches company. This is tested in two places:
- `tests_multi_company`: `profile['workspace']` and the token's `user.workspace` are both `None` for a member.
- The browser tests: checks 6 and 7 above.

The platform owner's real workspace still works: `tests_tenant_crud` (`test_workspace_profile_and_audit` and four related tests) passed in the full suite.

## 7. Remaining security gaps (check 7)

| # | Gap | Severity | Status after verification |
|---|---|---|---|
| G1 | When membership is revoked or an org admin is removed, other server workers can keep the old answer for up to 30 s (the cache lifetime) | Low | **Open, accepted.** Code confirmed: the cache is cleared at once on the worker that made the change, and other workers expire within the 30 s cache lifetime. This is the same window as user deactivation today. |
| G2 | Direct Edit switches were per user, not per company | Medium | **Fixed** (§8) |
| G3 | Tokens issued before Phase 2 carry no `org_id` and are accepted until they expire (refresh tokens last at most 7 days) | Low | **Open, accepted.** Code confirmed: the organization claim is checked only when present. The company check always applies. The gap closes itself 7 days after deploy. |
| G4 | Company names are unique server-wide, so an org admin can learn that a name is already taken | Low | **Open, accepted.** The only message is "A company named … already exists"; no other data leaks. It only matters once a platform admin raises a company limit above 1. |
| G5 | Usernames are unique across all customers | Low | Unchanged. |
| G6 | `request.user` is a read-only copy inside a second company, so code that saves it fails with a server error | Low (fail-safe) | **Verified latent only.** No current code path saves `request.user`: profile edits go to the real account (tested), user administration saves database rows, edit requests save the request row, and the security views save no user. |
| G7 | No screen for adding or removing organization admins | Functional | Open. |
| G8 | Guard against a second organization on local installs | Deferred to Phase 3 | Not started, as instructed. |
| G9 | Company limit is set by the platform admin, not by a licence | Deferred to Phase 6 | Open. |
| G10 | A backup archive cannot tell apart two installs that share the same ids and codes | Low | Open; needs an installation id (Phase 8). |
| G11 | Platform console doesn't show the organization or company limit yet (API only) | Functional | Open. |

None of the open gaps is a release blocker for the cloud edition while every organization stays at `max_companies = 1`, which is the post-migration default.

## 8. Direct Edit preferences across companies (check 8)

### Finding

**Before this fix:**
- The Direct Edit switches (`can_edit_eye_test`, `can_edit_sales`, `can_edit_wholesale`, `can_edit_inventory`, `can_edit_purchase`, `can_edit_accounts`) lived on the user account, so one setting applied in every company the user could enter.
- The admin screen for these switches (Administration → Edit Permissions) only listed a company's own users.

**The consequences:**
- The admin of the member's **home** company decided whether that person could edit directly in **another** company.
- The admin of the other company could neither see nor change the switch for that person.

### Classification

This is an **authorization-control isolation issue (Medium)**. It is not a data leak, and it is not only a settings mix-up:
- No data crosses companies.
- Both companies' module permissions and branch rules still applied.
- However, the maker-checker approval in company B could be switched off by company A's admin, which weakens B's own control.

So it is a security control that crossed the company boundary, and it needed fixing before multi-company could be enabled for anyone.

### Fix

**Data model:**
- `UserCompanyMembership` (the row that lets a user into a second company) gains the six switches.
- Migration `common 0011_membership_edit_permissions` adds six columns with a database default of on, which matches the user-level defaults.
- No data migration is needed: there are no membership rows yet (5 companies, 0 memberships), and the home company keeps using the switches on the user account.

**Server:**
- Inside a second company, the switches come from that company's membership.
- The read-only copy of the user (`organizations.company_user`) now carries the membership's switches. The existing gates (`EditPermissionMixin`, `ensureEditAccess`) therefore read the right values without any change.
- The cache entry for a membership now holds the role and the switches together. It is cleared when the membership is saved.

**Admin screen and API:**
- Administration → Edit Permissions now lists that company's own users **plus** members from other companies. Members are labelled "member from another company (switches apply here only)".
- Editing a switch saves it to the membership for **this** company only, and the change is logged with its scope.
- The admin of one company can't change switches for any other company: a user who is not in this company returns 404.

**Tests (`PerCompanyEditPermissionTests`, 5 tests, all pass):**
- `test_company_b_admin_controls_the_member_in_b_only`
- `test_admin_of_one_company_cannot_set_switches_for_another`
- `test_home_switch_does_not_leak_into_another_company`
- `test_edit_request_and_approval_stay_in_the_company`
- `test_new_membership_starts_with_switches_on_and_revoked_member_is_not_listed`

The full suite, the 83-test targeted run and the rehearsal (§10) all include this migration.

**Files changed for this fix:**
- `backend/apps/common/models.py`
- `backend/apps/common/organizations.py`
- `backend/apps/common/migrations/0011_membership_edit_permissions.py` (new)
- `backend/apps/authentication/edit_permissions.py`
- `backend/apps/common/tests_multi_company.py`
- `frontend/src/components/admin/EditPermissionsManager.jsx`

## 9. Phase 1 branch restrictions inside a second company (check 9)

New class `P1BranchControlsInSecondCompanyTests`, 8 tests, all pass. The scenario is a member working in company B, which has two branches:

| Test | What it proves |
|---|---|
| `test_restricted_member_sees_only_assigned_branch` | Branch access lists apply per company. |
| `test_member_without_branch_row_has_no_branch` | Having no branch row in B gives no branch (the default is to deny), even if the user has full access in their home company. |
| `test_branch_context_reports_only_permitted_branches` | The branch picker only offers B's permitted branches. |
| `test_branch_of_the_other_company_in_header_is_refused` | A company A branch id sent in the `X-Branch-Id` header is refused (403). |
| `test_financial_report_for_another_branch_is_refused` | A financial report for a branch not in the user's list (`?branch=`) is refused (403). |
| `test_voucher_into_another_branch_is_refused` | A voucher into a non-permitted branch is refused (403); a voucher into the user's own branch is created (201). |
| `test_stock_transfer_branch_authorization` | Stock-transfer branch rules hold inside B. |
| `test_home_company_branch_access_is_untouched` | The member's home-company branch access is unchanged. |

The existing branch-within-company tests (4) and the full Phase 1 branch suites (for example `tests_branch_isolation` and `financial.tests.test_branch_authorization`) passed in the full run.

## 10. Migrations and rollback (check 10)

**Command:**
```
python scripts/p2_migration_rehearsal.py --source "G OPTICALS" --copy dump
```

**Safety guards:**
- The script only runs against localhost.
- It reads the source database through `pg_dump` and does nothing else to it.
- All steps run on a throwaway copy, `gtrade_p2_rehearsal`, which is dropped at the end.

**Steps and results:**
1. The source was already at Phase 2, so the copy was first rolled back to `common 0008` to recreate the Phase 1 state.
   - Baseline: 121 tables, 5 companies, 1,686 rows.
2. `migrate --plan` listed exactly `common 0009`, `0010` and `0011`.
3. Forward `migrate`:
   - all 121 existing tables kept their row counts;
   - 5 companies became 5 organizations with 5 org-admin rows, 0 memberships and `max_companies = 1`.
4. Rollback to `common 0008`: all 121 tables kept their row counts.
5. Re-apply: row counts unchanged, and the organization checks passed again.
6. `migrate --check`: exit code 0.
7. **REHEARSAL PASSED.** The copy was dropped.

`makemigrations --check --dry-run` reports "No changes detected", so no model change is missing a migration.

**Limitation:** the rollback of `0011` was exercised with no membership rows. If memberships exist, rolling back `0011` drops their per-company switches, and `0010` → `0009` drops the memberships themselves. A rollback after go-live therefore needs a backup first.

## 11. State of the local dev database

- The dev server's auto-migrate setting applied migrations to the local `G OPTICALS` database:
  - `common 0009` and `0010` were applied when the dev server was restarted earlier in Phase 2;
  - `common 0011` was applied at 12:23:40 today, with approval.
- The database now has 5 companies, 5 organizations (limit 1 each), 5 org admins and 0 memberships.
- No business rows were changed.
- One leftover from the first browser test run earlier in Phase 2: a single failed-login row for `e2eowner` in `security_loginattempt`. It was left in place, because removing it would be a data change. It is harmless and can be deleted if you want.
- The tenant "E2E Probe" (id 5) predates Phase 2 (created 2026-11-07) and was not touched.
- Old test databases `test_G OPTICALS_1` to `_4` predate this work and were left as they were.

## 12. Unresolved issues

1. G1, G3, G4 and G5: low severity, accepted (§7).
2. G7 and G11: no screen for organization admins or for the company limit; only the API exists.
3. G8, G9 and G10: deferred to Phases 3, 6 and 8 by design.
4. **A rollback after go-live loses membership data** (§10). Take a backup before any rollback.
5. **The real platform workspace is only partly covered in the browser.** Its banner is covered by backend tests, but the browser tests only cover members (no banner).

## 13. Release blockers

| # | Blocker | Owner |
|---|---|---|
| B1 | Approve Phase 2 together with this verification. Record decisions D1–D3 in `ARCHITECTURE_DECISION_REGISTER.md`, whose approval table is still blank. | Owner |
| B2 | **Phase 1 is not deployed.** Its blockers come first: final P1 approval, Render dashboard values, a Neon-branch rehearsal, and assigning unassigned users. Phase 2 sits on top of the uncommitted Phase 1 work. | Owner / admin |
| B3 | A rehearsal on a **Neon branch** (never production itself) of Phase 1 plus `common 0009`–`0011`: `migrate --plan`, then `migrate`, then the organization checks, then rollback, then re-apply. This needs approval to connect to a Neon branch. | Admin |
| B4 | Commit. None has been made; the working tree holds Phase 1 and Phase 2 uncommitted together. | Owner |
| B5 | Deploy in this order: backend and migrations first, then the frontend. | Admin |
| B6 | Decide which customers, if any, get `max_companies > 1`. Keep everyone at 1 until B1–B5 are done. | Owner |

The former blocker B7 (re-run the full backend suite after the last fix) is **closed** by §2.

---

**Stopped here.** Waiting for approval. No commit, push, deploy, Neon connection or Phase 3 work has been done.
