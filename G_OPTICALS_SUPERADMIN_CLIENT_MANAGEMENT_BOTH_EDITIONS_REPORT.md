# G OPTICALS: Super Admin and Client Management in the Cloud and Windows Editions

**Date:** 2026-11-14
**Result:** The cloud edition already had a working Super Admin console, so it is preserved. The Windows edition now has its own **Local Super Admin**, who signs in against the installation's own database and needs no internet. Client Management works the same way in both editions.
**New release candidate:** `windows\out\installer\G-OPTICALS-Setup-1.0.0.exe`
- SHA-256 `F73F8C4162B98C0BB6B3057313F6E2BBA33E5939697722D3E9C6C3902D0E8E04`
- Size 206,154,864 B
- BUILD_ID `1.0.0-20261114T064958Z-384875ad`
- Unsigned. Not installed on any PC.
- The previous RC (`CDC57C71…`) was moved, not deleted, to `windows\out\archive\pre-superadmin-20261114`.

No database migrations. Nothing was committed or deployed. Neither the production database nor this PC's installation was touched.

## 1. Architecture inspection summary

| Area | Before this change |
|---|---|
| Cloud Super Admin | Complete. Sign-in at `/#/super-admin/login` (`portal: platform`). The platform owner is a Django superuser in tenant #1. `bootstrap_admin` creates it from `DJANGO_SUPERUSER_*`, and `platform_admin_status` diagnoses it. |
| Cloud Client Management | Complete. It runs at `/api/superadmin/tenants/` and `TenantManagement.jsx`. It covers list, search, filters, pagination, the create wizard, edit, deactivate/schedule/reactivate, users, branches, modules and roles, subscription, data, per-client backups, audit and "open workspace". |
| Tenant isolation | Done in the ORM: every row is stamped and filtered by tenant, and the token carries the tenant claim. Each client is its own Organization. |
| Windows edition | **Had no platform owner, by design.** `bootstrap_admin` skipped, a guard refused a second organization, and the SPA sent `/super-admin/login` to the staff sign-in. Licence and server-backup administration allowed **any** owner or administrator. With several clients, a client's admin could therefore have replaced the installation licence. |

## 2. Cloud: what changed

The cloud behaviour is kept, with these small additions:
- `summary/` and `catalog/` now report `edition` (and the licence status on Windows).
- The platform owner no longer takes one of tenant #1's user seats.
- Shared code (onboarding, login page labels) works for both editions.

## 3. Windows Local: what was implemented

- **Bootstrap:** `manage.py local_superadmin` reads JSON on stdin. `gtrade-ctl create-superadmin` asks for the password twice without showing it, or reads it from a pipe. The password is never passed on the command line.
  - Running it again changes nothing. There is only ever one Local Super Admin.
  - It never promotes an existing account.
  - The password must pass Django's validators and is stored as a hash with the configured hasher.
  - Options: `--status` shows the account, and `--reset-password` sets a new password and ends its open sessions.
  - Every creation and reset is written to the security audit log.
- **Sign-in:** the local SPA's `/#/super-admin/login` now opens the "Local Super Admin" page. A successful sign-in goes straight to Client Management. The company owner and client admins are refused there with `not_platform_admin`.
- **Clients:** each client is its own organization and tenant. The one-organization guard still refuses any other way of creating an organization; only Client Management onboarding (`edition.client_onboarding()`) may add one.
- **Licence limit:** the number of clients is limited by a new licence field, `clients`. If the licence has no `clients` value, there is no limit. The evaluation licence allows 1 client. A read-only licence refuses new clients.
- **Branch limit:** the console's branch writes now also check the licence's branch limits.
- **Installation administration:** `edition.installation_admin` allows the Local Super Admin and the administrators of the installation owner's organization.
  - Only they can manage the licence (`can_manage`) and server backups. Only they see installation-wide usage figures.
  - Client admins are refused (HTTP 403).
- **Licence enforcement:** even the Local Super Admin only gets the modules the licence includes. The Local Super Admin does not use a licensed user seat.
- **Django `/admin/` is switched off** in the Windows edition, because it is neither tenant-scoped nor audited.
- **Interface:**
  - Client Management shows a "Local edition" chip and a licence banner (clients used and allowed, and read-only state).
  - The Licence page has a Clients row. Its activation card is shown only to installation admins.

## 4. Changed files

**New files:**
- `backend/apps/common/management/commands/local_superadmin.py`
- `backend/apps/licensing/tests_local_client_management.py`
- `windows/tests/test_create_superadmin_cmd.py`
- `windows/tests/test_superadmin_e2e.py`

**Modified files:**
- Backend `apps/common`:
  - `edition.py`
  - `tenant_onboarding.py`
  - `superadmin_views.py`
  - `module_access.py`
  - `local_views.py`
  - `management/commands/{local_create_admin,bootstrap_admin,platform_admin_status}.py`
- Backend `apps/licensing`:
  - `enforcement.py`
  - `state.py`
  - `service.py`
  - `views.py`
- Backend: `config/urls.py`
- Frontend:
  - `src/App.jsx`
  - `src/pages/Login.jsx`
  - `src/pages/TenantManagement.jsx`
  - `src/pages/LicensePage.jsx`
- Windows:
  - `gtrade_ctl/installer_cmds.py`
  - `docs/ADMINISTRATOR_GUIDE.md` (new section 4a, bundled in the installer)

## 5. Migrations

None. The new licence limit is a field inside the signed licence, and the Local Super Admin is an ordinary user row. Existing tenants, the Default tenant (#1) and its data are not moved or changed.

## 6. Test evidence

| Suite | Result |
|---|---|
| Windows-edition Django tests (`apps.licensing`, throwaway PostgreSQL 17) | **38 / 38 OK**, including 15 new tests. The new tests cover: bootstrap (hashing, audit, repeat runs, refusals, reset), portal sign-in **with all network access blocked**, client create/edit/suspend/reactivate offline, client users and branches, licence limits on clients and branches, seat exclusion, the stray-organization guard, console access, licence and backup refusals, isolation (list/read/edit/delete) and `/admin/` returning 404. |
| Cloud Django tests: `apps.common`, `apps.authentication`, `apps.security` | **416 run, OK** (1 skipped before this change). Includes the existing Client Management, tenant isolation and module-sweep tests. |
| Frontend unit tests | **211 / 211** |
| Windows suite with real-stack e2e (`GTRADE_E2E=1`) | **226 / 226 OK**. Includes the new real-stack Local Super Admin flow (details below the table) and all existing Standalone, LAN Server, Workstation pairing, desktop, backup, update and upgrade tests. |
| `verify_package.py` on the extracted `.exe` | **29 / 29 checks** |
| `payload_guard` | OK |
| Inside the extracted payload | `local_superadmin.py`, `create-superadmin`, the guarded onboarding, the Local Super Admin interface and the guide are all present. BUILD_ID matches. |

The real-stack flow starts from the same install that the installer wizard runs. Each step goes over HTTPS through nginx:
1. `create-superadmin`, then a repeat run and `--status`.
2. Platform sign-in.
3. Create, edit, suspend and reactivate a client, and add a client user.
4. Client admin refused at installation level.
5. Isolation between the owner's company and the client.
6. `/admin/` returns 404.
7. A **cold stop and start of PostgreSQL, the app and nginx**, after which everyone still signs in.

Evidence: `windows\out\evidence\superadmin_e2e.json`.

**Not run:**
- The full cloud suite (about 1,160 tests, about 42 minutes). Only the three related apps above were run.
- ESLint, because the repository has no ESLint configuration (an existing gap).

## 7. How to sign in

**Cloud**
1. In the Render environment, set `DJANGO_SUPERUSER_USERNAME` and `DJANGO_SUPERUSER_PASSWORD`, choosing a strong password. `DJANGO_SUPERUSER_EMAIL` is optional.
2. Deploy. `build.sh` runs `bootstrap_admin`, which creates the account once and never again. The build log also prints `platform_admin_status`.
3. To repair a lost password, set `BOOTSTRAP_ADMIN_RESET=True` for one deploy, then set it back to `False`.
4. Open `https://<frontend>/#/super-admin/login` and sign in with that username. You land on **Client Management**, which is also in the sidebar.

**Windows Local (offline)**
1. Install or upgrade with the new RC.
2. On the server PC, open an **elevated** Command Prompt in `<install folder>\resources\server`. On this PC that is `C:\Program Files\G-TRADE\resources\server`.
3. Run `gtrade-ctl create-superadmin --user <name> --full-name "<your name>"` and type the password twice.
4. Check with `gtrade-ctl create-superadmin --status`.
5. Open G OPTICALS. On a workstation, use `https://<server>:<port>/#/super-admin/login`.
6. Click **Local Super Admin? Sign in here** and sign in. **Client Management** opens.

## 8. Remaining blockers (owner actions)

1. **Install the new RC on this PC.** This needs your approval and administrator rights. The last preflight here failed: only 0.9 GB of RAM was free and the run was not elevated. After the install, run `create-superadmin`.
2. **Physical tests.** A Windows restart test with the real services, a clean-PC install, and a two-PC LAN Server and Workstation test. The automated suite covers these paths with real processes, but not with Windows services or real reboots.
3. **Code signing.** The installer is still unsigned.
4. **Cloud deploy.** Commit and deploy these changes when you approve them. No production change is required for the cloud Super Admin, which already exists.
5. **Licence decision.** Licences without a `clients` value allow unlimited clients. Vendor licences should include `clients` if you want to charge per client.
6. **Backups with several clients.** Once a Windows installation holds more than one client, **in-app** full-database backups are disabled (an existing safety rule). The daily `gtrade-ctl` server backups keep covering everything.
