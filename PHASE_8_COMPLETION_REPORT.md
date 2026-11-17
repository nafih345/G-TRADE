# Phase 8: Backup, Restore, Updates and Recovery (Completion Report)

**Date:** 2026-11-12 · **Status:** complete and verified end to end on Windows 11 against the real stack: bundled PostgreSQL 17.10, embedded Python, Waitress, nginx TLS.

All tests used disposable install and data roots. The dev database and Neon were not touched.

## 1. Data protection layers

| Layer | What | When | Where |
|---|---|---|---|
| L1 (existing, unchanged) | ORM archive (`apps/security/backup`), restorable in-app | In-app schedule | `backups\app` |
| **L2 (new)** | `pg_dump -Fc` + `media.zip` + `manifest.json` (SHA-256, sizes, app version, install id, per-app migration state) | **Daily** (default 21:30, `GTRADE_BACKUP_TIME`) with catch-up after downtime; **manual** (app or CLI); **pre-update**; **pre-install** (reinstall over kept data); **pre-restore**; **final** (before a confirmed data deletion) | `backups\db\<name>\` and `index.json` |
| L3 | Verified copy to a second location (USB disk, second drive or share): `gtrade-ctl backup offsite --target …` | On demand. The status screen warns while no copy exists. | Customer media |

The scheduler runs **inside GTrade-App** (`gtrade_server._db_backup_loop`), so no Task Scheduler entry or extra privilege is needed. Backups use the application role, which owns the database.

## 2. Requirements → implementation (`windows/gtrade_ctl/backup.py`, `update.py`, `*_cmds.py`)

| Requirement | Implementation |
|---|---|
| Scheduled / manual backups | See §1. In the app: `/#/server-backups` (**Back up now**); API `POST /api/local/backups/` (owner/admin); CLI `gtrade-ctl backup run`. |
| Upload / media backups | `media.zip` of `MEDIA_ROOT` in every L2 backup |
| Integrity verification | After every backup: SHA-256 of every file + `pg_restore --list` + zip test. A failure marks the backup unverified and raises. |
| Restore verification | `backup verify --deep` restores into a throwaway database, compares the migration state with the manifest, then drops it |
| Restore workflow | `gtrade-ctl backup restore --name … --confirm` (Administrator): verify → **safety backup of the current state** → restore into a **new** DB → check its migrations match → maintenance flag → stop the app → end remaining sessions → swap names → swap the media folder (zip-slip guarded) → start. **The previous DB and media are kept** (`gtrade_pre_restore_<ts>`, `media.pre_restore_<ts>`). |
| Retention | Scheduled backups: 14 daily, 8 weekly, 12 monthly. Pre-update / pre-install: last 5. **Manual and final backups are never deleted automatically**, and the newest verified backup is always kept. |
| Backup status screen | `/#/server-backups`: last success, age warning (> 48 h), last error, schedule, second-copy status, list with a verified/not-verified badge. Server paths are never sent to the browser. |
| Safe updates | `gtrade-ctl update apply` (called by the installer on upgrade): compatibility → pre-checks → maintenance + stop → **verified pre-update backup (a mandatory gate)** → migrate with the new code → collectstatic → switch the services → start → **HTTPS health gate (server_version == new)** |
| Version compatibility | No downgrade. `min_upgrade_from`. `requires_pg_major`. Payload integrity against the build `manifest.json`. Licence update entitlement (`updates_until`). |
| Migration pre-checks | The plan is computed with the **new** code. Migrations the release marks irreversible need `--acknowledge-irreversible`. Free disk must be ≥ 2 × (DB + media) + 512 MB. |
| Failed-update recovery | Any failure after the backup → restore the pre-update backup into a new DB and swap (the failed DB is **kept**) → switch the services back to the previous code (the installer's rollback copy) → start → health. `run\update-state.json` records the phase so an interrupted update is detected (`repair` refuses; `update status` shows it). |
| Application rollback | `gtrade-ctl update rollback --backup … --app-dir … --to-version …` requires `--i-understand-data-entered-after-the-backup-is-lost` |
| Database rollback restrictions | **Migrations are never reversed.** The only way back across a schema change is the verified pre-update backup. Data is never deleted: databases that failed are renamed and kept. |
| Update logs | JSONL per run in `logs\update\` (every step with status and duration, secrets redacted), plus the `install.json` history (update, rollback, create-org, …) |
| Standalone and LAN Server | Same engine. Workstations hold no data; their installer only replaces the client. |

## 3. End-to-end test (`windows/tests/test_backup_update_e2e.py`): **10/10 OK** (368 s)

Evidence is in `windows/out/evidence/backup_update_e2e.json`.

| # | Scenario | Result |
|---|---|---|
| 1 | Manual backup (722 KB) verified. Deep verification restored 126 tables. A byte-flipped copy is detected ("checksum mismatch"). | OK |
| 2 | Restore: a brand added after the backup is gone, the earlier brand is present, the media file is back to v1, the previous DB is kept as `gtrade_pre_restore_…`. Health OK. | OK |
| 3 | Update 1.0.0 → 1.0.1 with one new migration: applied, health reports 1.0.1, data intact, pre-update backup taken | OK |
| 4 | Update to 1.0.2 where migration 1 succeeds and migration 2 fails (`1/0`): **automatic rollback**. The half-applied table is gone, the version is back to 1.0.1, data identical, the failed DB is kept. | OK |
| 5 | Update to 1.0.3 whose server code fails to start after migrating: health gate fails → **automatic rollback** (its table is gone, 1.0.1 serving again) | OK |
| 6 | Downgrade refused; an irreversible migration without acknowledgement refused. **No backup taken, nothing changed**, health OK. | OK |
| 7 | In-app `POST /api/local/backups/` → 201, verified; GET lists it newest first, without paths; anonymous → 401 | OK |
| 8 | Retention over 40 fake scheduled backups: 22 deleted, 18 kept, manual backups untouched | OK |
| 9 | Scheduler slot and catch-up logic | OK |
| 10 | Uninstall keeps data; a wrong company name is refused; the correct name → verified final backup, then deletion | OK |

## 4. Bugs found by these tests and fixed

1. Restoring a backup whose `media.zip` is empty failed at the folder swap. The rollback **stopped safely** and said nothing was deleted; the staging folder is now always created.
2. The backup list was ordered by name instead of time, so "latest backup" could be wrong. It is now sorted by `created_at`.
3. The install engine depended on a pre-existing `app\current.json`. The engine now owns it (Phase 6).

## 5. Open items

| Item | Action |
|---|---|
| Signed update manifests | Payload integrity (SHA-256 manifest) is implemented. Signing `manifest.json`/`release.json` with a release key (Ed25519, like licences) is wired in design but needs the owner's release key in the KMS (D4/D6). Until then the trust anchor for updates is the Authenticode-signed installer. |
| Workstation auto-update from the LAN server | Workstations are updated by running the new installer. Serving the installer from the server for workstations is a post-v1 feature. |
| PostgreSQL major upgrade (17 → 18) | Refused with "pg_upgrade required". Implement when a release needs it. |
| Restore from the browser | Deliberately not offered (it needs Administrator rights). Done with `gtrade-ctl backup restore` / Server Manager. |
