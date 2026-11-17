# P1 — Backup & Restore Isolation: Verification

**Date:** 2026-11-11 · Task 3 of P1 · Code: `backend/apps/security/backup/policy.py` (new), `service.py`,
`archive.py`, `scheduler.py`, `management/commands/create_backup.py`, `security/views.py`, `security/apps.py`.

## 1. Interim policy (explicit, pending D1)

D1 (Organization) is not approved, so the final "single organization" rule cannot be built. P1 enforces
this **interim rule, unchanged from what the UI already did**, now in the service layer itself:

> A whole-database backup, an uploaded whole-database archive and a whole-database restore are allowed
> only while the server hosts **at most one tenant**. A restore is allowed only for an archive of
> **this install's own customer**.

The rule was not widened or narrowed. The HTTP permission `SingleTenantInstall` now calls the same
predicate (`policy.whole_db_allowed()`), so the UI, the API and the service cannot disagree. In P2, only
the bodies of `whole_db_allowed()` and `archive_owner_problem()` change (to the organization rule).

Per-client exports (`start_client_backup`, `TenantScope`, platform console) are unchanged. They remain
the backup path on the multi-tenant cloud and are never restorable.

## 2. Where the rule is enforced

| Path | Before P1 | After P1 |
|---|---|---|
| Settings → Backup (HTTP) | `SingleTenantInstall` (tenant count ≤ 1) | Same, via `policy.whole_db_allowed()` |
| `service.start_backup` (any caller) | No check | `WholeDatabaseBlocked`, audit `BACKUP_REFUSED` |
| `service._produce` (writes the archive) | No check | Refuses any whole-DB record, even one queued directly |
| `scheduler.run_due` (in-process thread, `run_scheduled_backups`) | No check: all-tenant archives kept being produced | Skips, switches the schedule off (`BLOCKED`), audit `BACKUP_SCHEDULE_SKIPPED` |
| `manage.py create_backup` | No check | `CommandError` with the reason |
| `service.import_upload` | Per-client archives refused | Also refused on a multi-tenant server; another customer's archive refused before it is stored (`BACKUP_UPLOAD_REFUSED`) |
| `service.start_restore` | Per-client archives refused | Also refused on a multi-tenant server (`RESTORE_REFUSED`) |
| Restore job (`_run_restore_job`) | Validation only | Ownership checked before the safety backup is taken |
| `archive.restore_archive` (lowest layer) | Per-client archives refused | Ownership + multi-tenant check inside, before any table is cleared |
| Second tenant onboarded | Nothing | `post_save(Tenant)` switches the whole-DB schedule off at once (`BACKUP_SCHEDULE_DISABLED`) |

## 3. Archive ownership rule

Read from the archive's own `data/common.tenant.jsonl` (works for every archive ever produced):

1. More than one tenant row → refused ("taken on a multi-business server").
2. The tenant's `id` **and** `code` must equal this install's single tenant.
3. While the code is the generic `default` that every fresh install starts with, the tenant **name**
   must match too (two different shops both start as tenant 1 / `default`).
4. No tenant table at all (made before multi-tenancy) → allowed only onto an install whose single tenant
   is the default tenant #1.

**Limit:** two installs that both kept tenant 1 / `default` / the same name cannot be told apart from
the database alone. A per-installation identity (licence / installation id, D4/D6) closes that gap.
It is listed in `P1_REMAINING_SECURITY_GAPS.md`.

## 4. Existing customer backup data

Nothing was deleted or rewritten. Existing `BackupRecord` rows and files are untouched. On a
multi-tenant server, existing whole-DB archives stay listed but cannot be downloaded (as before) or
restored. Retention still runs.

## 5. Tests

`backend/apps/security/tests/test_backup_tenant_gate.py` (18 tests), on top of the existing
`test_backups.py` suite:

| Test | Verifies |
|---|---|
| `test_single_tenant_backup_still_works` | Single-tenant behaviour unchanged |
| `test_backup_refused_by_the_service_with_two_tenants` | Service refuses; no record; audit event |
| `test_create_backup_command_refused_with_two_tenants` | CLI refuses |
| `test_produce_refuses_even_a_record_queued_directly` | Lowest backup layer refuses |
| `test_restore_refused_by_the_service_with_two_tenants` | No RestoreJob created |
| `test_restore_archive_itself_refuses_with_two_tenants` | `restore_archive` refuses; nothing replaced |
| `test_upload_refused_with_two_tenants` | Upload refused |
| `test_http_gate_uses_the_same_rule` | 403 from the API |
| `test_onboarding_a_second_tenant_switches_the_schedule_off` | Schedule disabled + audit |
| `test_a_schedule_still_enabled_never_produces_an_all_tenant_archive` | Scheduler never writes an all-tenant archive |
| `test_single_tenant_schedule_runs` | Scheduler unchanged with one tenant |
| `test_own_archive_is_restorable` | Own archive accepted |
| `test_another_customers_archive_is_refused_at_upload` | Cross-customer upload refused, nothing stored |
| `test_same_id_other_code_is_refused` | id match is not enough |
| `test_generic_default_tenant_with_another_name_is_refused` | `default` code + different name refused |
| `test_multi_tenant_archive_is_refused` | Multi-tenant archive refused |
| `test_restore_job_fails_before_safety_backup_for_foreign_archive` | Fails before the safety copy; no data changed |
| `test_per_client_backup_unaffected_by_multi_tenant_rule` | Per-client exports still work |

Results: see `P1_TEST_RESULTS.md`.
