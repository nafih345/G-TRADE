# Phase 4: PostgreSQL 17 Windows Runtime (Completion Report)

**Date:** 2026-11-12 · **Status:** complete. Windows-service registration is ready but untested pending an elevated run (§5).
All database tests used disposable clusters in temp folders on free ports. The dev database and Neon were not touched.

## 1. What was built (`windows/gtrade_ctl/pg.py`, CLI `init-db`, `verify-db`, `migrate`)

| Requirement | Implementation |
|---|---|
| PostgreSQL 17 installation | Bundled 17.10 binaries (`runtime\pgsql`). The build refuses a non-17 source. |
| Automated initialisation | `initdb -E UTF8 --locale=C --data-checksums --auth=scram-sha-256` with the superuser password in a temporary file that is overwritten and deleted. A managed block in `postgresql.conf` sets: `listen_addresses='localhost'`, port 5544, SCRAM, 60 connections, memory sized from RAM, WAL/checkpoints, a log collector into `logs\db`, and a 1 s slow-query log. |
| **Never re-initialise** | `cluster_state()` returns absent, empty, cluster or foreign. A `PG_VERSION` folder is never re-initialised; a non-empty foreign folder stops the installer untouched. There is no delete or truncate path. |
| Dedicated app user | Role `gtrade`: LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS, connection limit 50. It owns DB `gtrade` and schema `public`. |
| Secure generated password | 32-char CSPRNG values (Phase 3 secret store). The app and superuser passwords are distinct. |
| Correct permissions | `REVOKE ALL ON DATABASE … FROM PUBLIC`, `REVOKE CREATE ON SCHEMA public FROM PUBLIC`. `pg_hba.conf` allows loopback SCRAM only: no `trust`, no LAN ranges. The data folder ACL is SYSTEM + Administrators + NETWORK SERVICE (`winacl.py`). |
| Connection verification | `verify-db` reports binary and cluster major, running and ready state, the app role's privileges (`least_privilege`), `listen_addresses` (`loopback_only`) and DB size. It exits 20 on failure. |
| Migrations controlled by installer/release | `gtrade-ctl migrate --plan` / `--apply` only. The app server never migrates (Phase 3 schema gate), and `AUTO_MIGRATE` is forced off. |
| DB health monitoring | `/api/health/` (database + migrations), `gtrade-ctl verify-db`, and the PostgreSQL slow-query log. The Phase 8 status screen surfaces backup and DB state. |
| Backup/restore integration | `pg_dump`/`pg_restore` come from the same bundled `bin`. The workflow is in Phase 8. |
| Windows service | `GTrade-DB` via `pg_ctl register -N GTrade-DB -U "NT AUTHORITY\NetworkService" -S auto -w`. App and Web depend on it. |
| Safe upgrade handling | A major mismatch (cluster ≠ binaries) is reported as "pg_upgrade is required" and nothing starts. Minor upgrades (17.x) swap binaries only. `provision()` is idempotent for repair (it re-applies grants and keeps data). |

## 2. Modes

| Mode | Database | Enforcement |
|---|---|---|
| Standalone | Local cluster, app and nginx on 127.0.0.1 | `bind_address` = 127.0.0.1 |
| LAN Server | Local cluster on loopback; only nginx is on the LAN | One firewall rule (Private, LocalSubnet, the HTTPS port) |
| LAN Workstation | **None** | `init-db` exits 2 ("a LAN workstation never hosts a database"). No env file is written and no services are planned. Covered by tests. |

## 3. Tests

| Suite | Result |
|---|---|
| `test_postgres.ClusterTests`: real `initdb`, start, provision, verify (7 tests) | **7/7 OK** (68 s) |
| `test_postgres.ModeAndUpgradeGuards` (3 tests): workstation refusal, mode immutable on upgrade, PG16 cluster with PG17 binaries refused | **3/3 OK** |
| Phase 3 end-to-end with the bundled binaries: 164 migrations from empty, then a verify-db with least_privilege and loopback_only both true | **OK** |

Key assertions:
- A wrong password is rejected.
- A new role without CONNECT cannot enter the database.
- An identifier injection is refused.
- Customer data survives a refused re-initialisation, a repair re-provision and a restart.
- The managed config block is idempotent.

## 4. Security and data-integrity review

- PostgreSQL is never reachable from the LAN: `listen_addresses` and pg_hba both restrict it to loopback.
- The superuser credential is used only by gtrade-ctl (provision, verify, backup). The app never holds it: `gtrade_server` loads only `db_app_password`.
- No SQL is built from user input except validated identifiers (`[a-z_][a-z0-9_]{0,62}`). The password literal is quote-escaped and generated from a safe alphabet.

## 5. Open items

| Item | Exact remaining action |
|---|---|
| `pg_ctl register` as a real service under NETWORK SERVICE, plus the data-folder ACL on a real `C:\ProgramData` | Elevated smoke test (Phase 6 script) on Win10 and Win11 |
| Major upgrade 17 → 18 (`pg_upgrade --check` then upgrade into a new folder) | Not needed for v1. Design is in `BACKUP_UPDATE_RECOVERY_PLAN.md`. Implement when a release changes the PG major. |
