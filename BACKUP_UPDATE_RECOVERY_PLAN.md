# G-TRADE ERP — Backup, Update & Recovery Plan

**Date:** 2026-11-11 · **Status:** Plan for review. Nothing implemented.
Parent document: `COMMERCIAL_WINDOWS_ARCHITECTURE.md`. Builds on `LOCAL_DEPLOYMENT_ARCHITECTURE.md` §10.

---

## 1. Current capabilities

| Capability | Location | Status |
|---|---|---|
| Logical ORM backup (zip: manifest, applied migrations, row data, checksums) | `apps/security/backup` | ✅ |
| Deep validation + schema compatibility check | same | ✅ |
| Transactional restore behind a maintenance gate (`RestoreMaintenanceMiddleware`) | same | ✅ |
| Scheduler (daily/weekly/monthly, business time, catch-up, multi-process safe) | `config/wsgi.py` thread | ✅ |
| `manage.py create_backup`, `run_scheduled_backups` | management commands | ✅ |
| Per-client export backups (cloud, export-only) | client data tools | ✅ |
| Whole-DB backup with >1 tenant | `SingleTenantInstall` | ❌ blocked; must become "single organization" (isolation audit I2) |
| Physical `pg_dump` layer, off-machine copies, pre-update gate, restore when the app is down | — | ❌ |
| Auto-migrate on boot with no backup | `launcher.py`, `AUTO_MIGRATE` | ❌ risk (B5) |
| Update mechanism of any kind | — | ❌ |
| `config/backup.json` | not read by code | ❌ unused |

## 2. Backup layers

| Layer | Content | Trigger | Location | Retention |
|---|---|---|---|---|
| **L1** Logical (existing) | ORM archive of the whole organization (all companies) | In-app schedule (default daily 21:00) + manual | `ProgramData\G-TRADE\backups\app\` | Existing settings |
| **L2** Physical (new) | `pg_dump -Fc` of `gtrade` + `media\` zip + encrypted `config\` bundle (secrets, CA key, licence) + `install.json`; one `.gtb` container with manifest and SHA-256 | Nightly (Agent, 23:30), **before every update** (mandatory), before restore, manual (Server Manager) | `backups\db\`, `backups\pre-update\` | 14 daily, 8 weekly, 12 monthly; pre-update: last 3 |
| **L3** Off-machine (new) | Copy of the newest L2 (+ L1) | After every L2 | USB drive (by volume id), second disk, SMB share (stored credentials via DPAPI), optional vendor cloud (paid add-on, encrypted client-side) | Same as L2 at the target |

Rules:
- The `config\` bundle inside L2/L3 is encrypted with an **admin backup passphrase** (AES-256-GCM, scrypt KDF) set in the
  wizard. Without it, a stolen backup does not expose secrets or the CA key. Business data encryption for L3 is optional (P1).
- Each L2 is verified after writing: `pg_restore --list` succeeds, checksums match, size is sane.
- **Protection status** in Server Manager and the app header for admins: green (L3 < 24 h), amber (< 72 h), red (no L3 or > 72 h).
- Monthly automatic **restore test**: the Agent restores the latest L2 into a temporary database `gtrade_verify`, runs `manage.py check` and row-count sanity checks, then drops it. The result is logged and shown.

## 3. Update architecture

### 3.1 Channels and artefacts

```
https://updates.<vendor>/gtrade/<channel>/            (stable | beta)
  latest.yml                     electron-updater metadata (version, sha512, release date)
  G-TRADE-Setup-1.1.0.exe        signed full installer (+ .blockmap for differential download)
  server-runtime-1.1.0.7z        + manifest.json + manifest.sig (Ed25519)
  release.json                   {version, api_version, min_client_version, min_server_upgrade_from,
                                  migrations: [...], irreversible: bool, requires_pg_major: 17,
                                  release_date, notes_url}            + release.json.sig
```

### 3.2 Who updates what

| Role | Source | Trigger |
|---|---|---|
| **LAN Server / Standalone** | Internet channel, via the Agent | Agent checks daily; downloads in the background; **applies only when an admin approves** (Server Manager or an in-app banner), or at a scheduled maintenance window the admin configured (e.g. Sunday 02:00) |
| **Workstations** | **The LAN server's mirror** `https://GTRADE-SRV:8443/updates/` (generic provider, pinned TLS) | On client start + every 4 h; applied at next app restart. A workstation is **never** newer than its server. |
| Browser/Edge fallback | Nothing to update (SPA served by the server) | — |

The Agent publishes to the LAN mirror only **after** the server update succeeds, so workstations cannot get ahead.

### 3.3 Compatibility handshake

- `/api/health/` returns `version`, `api_version` (exists: `config/urls.py` `API_VERSION = 2`), `min_client_version`.
- Electron client: if its version < `min_client_version` → blocks login and updates from the mirror.
- The SPA is always served by the server, so the UI always matches the API. Only the Electron shell can drift, and its preload API is kept backward-compatible.

## 4. Server update procedure (Agent / `gtrade-ctl update`)

1. **Verify**: Authenticode on the installer, Ed25519 on `release.json` and the runtime manifest; licence `updates_until` ≥ `release_date`; `min_server_upgrade_from` ≤ current version.
2. **Pre-flight**: free disk ≥ 2.5 × (DB size + media); all services healthy; no restore/import running; PG major matches `requires_pg_major`.
3. **Announce**: an in-app banner to logged-in users ("Update in 5 minutes, save your work"), unless it is an off-hours window.
4. **Maintenance mode**: block new writes (same mechanism as `RestoreMaintenanceMiddleware`); wait for in-flight requests; stop `GTrade-Web` then `GTrade-App`.
5. **Mandatory L2 pre-update backup**. Failure → abort; services restarted; nothing changed.
6. **Side-by-side install** into `resources\server\<new>\` (the old version stays). Verify the manifest.
7. **Migration gate**: `migrate --plan` with the new code; record the plan. If `irreversible: true`, require the explicit
   admin acknowledgement captured in step 3 (the pre-update dump is then the only rollback path, and it is stated).
8. **Apply**: `migrate --apply`, `collectstatic`, regenerate nginx config, switch `current.json` → new version, start services.
9. **Health check**: DB, migrations complete, `version` = new, licence valid, smoke API calls (login page config, list endpoints of each module return 200 for a service account).
10. **On any failure in 6–9 → automatic rollback**:
    stop services → restore the step-5 dump into **a new database** `gtrade_rb_<ts>` → rename databases (failed DB kept as `gtrade_failed_<ts>` for support) → `current.json` → old version → start → health → report.
11. **Success**: publish workstation artefacts to the LAN mirror; prune old versions (keep N-1 folder and the last 3 pre-update dumps); record in `update-history.json` and the Event Log.

Rules that are never broken:
- No code path runs `initdb` on, drops, or truncates an existing data directory or database.
- `SECRET_KEY`, DB passwords, CA and licence are never regenerated by an update.
- `AUTO_MIGRATE=False` in the local edition; only the updater migrates.
- Migrations follow **expand → migrate → contract** across releases, so N-1 code runs against an N schema wherever practical.

## 5. PostgreSQL maintenance

| Task | Approach |
|---|---|
| Minor upgrades (17.x → 17.y) | Shipped in `server-runtime`; binaries swapped during the update window (data format is compatible) |
| Major upgrade (17 → 18+) | A dedicated release: ships both majors, runs `pg_upgrade --check`, then `pg_upgrade --link` into a new data folder **after** an L2 dump; the old folder is kept until the admin confirms. Fallback: dump/restore. Not before PG 17 nears end of life (Nov 2029). |
| Vacuum/analyze | Autovacuum on; weekly `vacuumdb --analyze-in-stages` by the Agent |
| Disk-full protection | Agent warns at 80% and blocks updates/backups that would cross 90% |

## 6. Recovery scenarios (runbooks)

| Scenario | Procedure | Target RPO / RTO |
|---|---|---|
| User deleted/edited data wrongly | In-app audit + edit history; restore one company? **Not supported** in v1 (restore is whole-org). Use L1 restore to a **side instance** (`gtrade-ctl restore --to-sidecar`) to look up and re-enter data. | — |
| Failed update | Automatic rollback (§4 step 10) | RPO 0 / RTO < 15 min |
| App will not start | Server Manager → Diagnostics; `gtrade-ctl restore <L2>` works without Django running (uses `pg_restore` directly) | RPO ≤ 24 h / RTO < 30 min |
| Database corruption | Restore the latest L2 into a new DB → verify → swap | RPO ≤ 24 h |
| Server disk failure / PC stolen | New PC: install **Server** → "Restore from backup file" (L3) → enter the backup passphrase → licence transfer → workstations reconnect (same CA restored, so no re-pair) | RPO ≤ 24 h / RTO < 2 h |
| Ransomware | L3 on a **disconnected** USB or versioned share; documented guidance to rotate two USB drives | RPO per rotation |
| Lost backup passphrase | Data in L2 remains restorable (the passphrase protects only the `config\` bundle). Secrets are regenerated, users must log in again, workstations re-pair, licence re-activates. | — |

Optional (P2): continuous WAL archiving to the second disk for point-in-time recovery (RPO minutes) for larger customers.

## 7. Uninstall and data retention

- Uninstall never deletes `ProgramData\G-TRADE` unless explicitly confirmed (installer plan §8); a final L2 is written to the Desktop first.
- Reinstall detects existing data and offers "Use existing data" (no overwrite option).

## 8. Version management

- Semantic versioning `MAJOR.MINOR.PATCH`. `api_version` increases on breaking API changes; `min_client_version` moves only when the preload contract changes.
- One version string, stamped at build into: `package.json`, the backend (`/api/health/ version`), `release.json`, the installer file name, and `install.json`.
- `update-history.json` on the server: from/to, timestamps, backup file, migration plan hash, result.
- Support matrix: the current and previous minor receive security fixes; customers without update entitlement keep running their installed version.

## 9. Implementation steps

| # | Step | Phase | Depends on |
|---|---|---|---|
| 1 | `SingleTenantInstall` → single-organization rule | P2 | Organization model |
| 2 | `gtrade-ctl backup` (L2 container, verify, retention) + `restore` (new DB + swap, app-down capable) | P8 | runtime (P4) |
| 3 | L3 targets (USB by volume id, folder, SMB) + protection status + monthly restore test | P8 | 2 |
| 4 | Release packaging: `release.json`, manifests, signatures, channel layout | P7 | installer pipeline |
| 5 | Agent update flow (§4) with automatic rollback | P7 | 2, 4 |
| 6 | LAN mirror + Electron `electron-updater` generic provider + version handshake | P7 | 5 |
| 7 | Failure-injection tests: kill during migrate, failing migration, health failure, disk full | P7 | 5 |
| 8 | Runbooks + Server Manager restore UI | P8/P9 | 2, 3 |
