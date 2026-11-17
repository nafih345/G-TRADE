# G OPTICALS for Windows: Administrator Guide

For the shop's IT person or reseller technician who looks after a Standalone PC or LAN Server.

Some folder, service and command names still say **G-TRADE** or **GTrade**. They are internal names, kept so that updates find the existing installation and its data. The product is G OPTICALS.

## 1. What is installed where

| Item | Location |
|---|---|
| Program (read-only) | `C:\Program Files\G-TRADE\` (desktop app `G-TRADE.exe`); server runtime in `resources\server\`; these guides in `resources\docs\` |
| **Business data** | `C:\ProgramData\G-TRADE\` (or the folder chosen in setup): `pgsql\data` (database), `media` (uploaded files), `backups`, `logs`, `config` |
| Services | `GTrade-DB` (PostgreSQL 17, this PC only, port 5544), `GTrade-App` (application, this PC only, port 8001), `GTrade-Web` (HTTPS 8443, the only network port). All three start automatically and restart themselves after a failure (after 5 s, 10 s, 30 s). |
| Secrets | `config\secrets.dpapi`, encrypted with Windows DPAPI and readable only on this PC by Administrators, SYSTEM and the services. Never copy it to another PC; it will not work there. |
| Certificates | `config\tls\` (a private CA for this installation, plus the server certificate). The server certificate renews itself. The CA stays the same, so workstations keep trusting it. |
| Firewall (LAN Server) | One inbound rule for the HTTPS port, Private profile, local subnet only |

G OPTICALS never uses, stops or reconfigures another PostgreSQL, MySQL or pgAgent service on the PC.

## 2. The admin tool: gtrade-ctl

Open an **elevated** Command Prompt (*Run as administrator*) and run:

```
cd "C:\Program Files\G-TRADE\resources\server"
gtrade-ctl <command>
```

`gtrade-ctl.cmd` runs the bundled Python with the active application version. You don't need to install Python separately. Every command prints JSON.

**Elevated means "Run as administrator".** The window title must start with `Administrator:`. A normal Command Prompt, PowerShell or VS Code terminal is *not* elevated, even when your Windows account is an administrator. The settings and encrypted secrets in `C:\ProgramData\G-TRADE\config` can be read only by Administrators (elevated), SYSTEM and the `GTrade-App` service. Commands that need them refuse a prompt that is not elevated before asking anything, with "must be run from an elevated Command Prompt … Nothing was changed". Open an elevated prompt and run the same command again. **Never change the permissions of the `config` folder to get around this.**

| Command | Purpose |
|---|---|
| `health` | End-to-end check: HTTPS → application → database |
| `services status` / `start` / `stop` | The three Windows services |
| `services verify` | Reads back each service's account, start type, dependencies and recovery actions and lists anything that is wrong (exit 1). Changes nothing. |
| `repair-permissions` | Re-apply the data-folder permissions for the three service accounts. Never deletes or resets data. |
| `verify-db` | Database version, connectivity, least privilege, loopback only |
| `backup run` / `list` / `status` / `verify --name X [--deep]` | Backups. `--deep` test-restores into a throwaway database. |
| `backup offsite --name X --target E:\G-OPTICALS-Backups` | Copy a backup to a USB disk or second drive, and verify the copy |
| `backup restore --name X --confirm` | Restore. The current database is kept under another name, and a safety backup is taken first. |
| `reset-password --list-admins` | Show the administrator user names (no passwords) |
| `reset-password --user NAME` | Set a new password for a user who cannot sign in. It asks for the password twice and doesn't show it. |
| `create-superadmin --user NAME [--email E] [--full-name N]` | Create the **Local Super Admin** (Client Management). Asks for the password twice and doesn't show it. Running it again never creates a second one. |
| `create-superadmin --status` / `create-superadmin --user NAME --reset-password` | Show the Local Super Admin (no passwords) / set a new password for it |
| `cert info` / `cert ensure` | Certificate status / renewal (also adds new host names) |
| `connection-sheet` | Re-create the workstation connection sheet |
| `license status` / `license import --file X.lic` / `license request --out req.gtr` (key on stdin) / `license checkin` | Licence |
| `update status` | Show an interrupted update, if any, and recent update logs |
| `repair` | Re-apply configuration, services, certificates and permissions. Never touches data. |
| `preflight --mode server` | Re-run the installation requirement checks |
| `diagnostics --out C:\Temp\gopticals-diag.zip` | Support bundle: logs and configuration **without** secrets, keys or business data |

Exit codes: 0 OK · 1 check failed · 2 configuration · 10 requirements · 20 database · 30 licence · 40 services · 50 health · 60 backup · 70 update failed, previous version proven running · 71 update failed, previous version NOT proven running.

### Windows services and their accounts

| Service | Runs | Account | Starts after | May write to (data folder) |
|---|---|---|---|---|
| `GTrade-DB` | PostgreSQL 17, port 5544, this PC only | `NT SERVICE\GTrade-DB` | (boot) | `pgsql\`, `logs\db\` |
| `GTrade-App` | Application server, this PC only | `NT SERVICE\GTrade-App` | `GTrade-DB` | `media\`, `backups\`, `logs\`, `run\`, `temp\` (reads `config\`) |
| `GTrade-Web` | HTTPS (nginx) | `NT SERVICE\GTrade-Web` | `GTrade-App` | `logs\web\`, `run\nginx\`, `temp\nginx\` (reads only its certificate files and nginx.conf) |

All three start automatically at boot (not delayed) and restart by themselves after a crash (5 s, 10 s, 30 s). These are Windows *virtual service accounts*: they have no password, are not administrators and cannot sign in. The certificate authority's private key (`config\tls\ca.key`) is readable only by Administrators. Do not change the services' "Log On" account in *Services*: `gtrade-ctl services verify` reports it, and `gtrade-ctl repair` puts it back.

## 3. Backups

See the **Backup and Recovery Guide** for the full procedure. In short:

- A verified backup runs every day at 21:30. If the PC was off at that time, it runs at the next start-up.
- Setup takes a backup before every update.
- Copy a backup off the PC at least weekly with `backup offsite`.

## 4. Users, companies, branches

These are managed inside the app:
- users: **Administration → Users**;
- companies: **Organization → Companies**;
- branches: **Administration → Branch Management** (shown when multi-branch is turned on).

The **licence** sets the maximum number of named users, companies and branches. The app explains when a limit is reached.

Each company's data is kept separate. A user sees only the companies they are a member of. Additional, unrelated client businesses on the same installation are created only by the **Local Super Admin** in Client Management (section 4a); each is its own organization and never sees another's data.

If the licence expires or is revoked, G OPTICALS becomes **read-only** after the grace period. Data can still be viewed, printed, exported and backed up.

### Lost administrator password

If another administrator can sign in, they reset the password in **Administration → Users**.

If nobody can sign in, recover it on the **server PC**:

1. Open an elevated Command Prompt and go to the `resources\server` folder shown in section 2.
2. Run `gtrade-ctl reset-password --list-admins` to see the administrator user names.
3. Run `gtrade-ctl reset-password --user <name>` and type the new password twice.

The password must meet the normal rules. All of that user's open sessions are ended. The reset is recorded in **Administration → Audit Logs**. Nothing else about the account changes. Only a Windows administrator on the server PC can do this, because it needs the installation's encrypted secrets.

## 4a. Local Super Admin and Client Management

The Local Super Admin is the installation's own platform administrator. It signs in against **this server's database** (no internet, no cloud account) and opens **Client Management**: create, edit, suspend/deactivate and reactivate clients; each client's users, branches, modules, subscription dates and history; and the licence status (how many clients the licence allows).

It is separate from the company owner created during installation; that account cannot open Client Management, and client administrators cannot change the installation licence or server backups.

**Create it once (server PC):**

1. Open an elevated Command Prompt (right-click **Command Prompt** → **Run as administrator**; the title starts with `Administrator:`) and go to the `resources\server` folder (section 2). A VS Code terminal or a normal prompt will not work.
2. Run `gtrade-ctl create-superadmin --user <name> --full-name "<your name>"`.
3. Type a strong password twice (it is not shown, never put on the command line, and stored only as a salted hash). Normal password rules apply.
4. Check with `gtrade-ctl create-superadmin --status`.

**Sign in:** open G OPTICALS (or `https://<server>:<port>/#/super-admin/login` on a workstation), choose **Local Super Admin? Sign in here** under the sign-in form, and sign in. You land on **Client Management** (also in the sidebar).

Lost password: `gtrade-ctl create-superadmin --user <name> --reset-password` on the server PC (ends its open sessions; recorded in the audit log). In-app full-database backups are disabled once the server holds more than one client; the daily server backups (`gtrade-ctl backup`) keep running and cover every client.

## 5. Updates

- Install the new version **on the server first**, outside business hours.
- What setup does: verified backup → database upgrade → health check. On failure it **restores the backup and the previous version automatically**.
- Never undo database upgrades by hand. To go back after a *successful* update, restore the pre-update backup with `update rollback ... --i-understand-data-entered-after-the-backup-is-lost`.
- Then update each workstation. A workstation older than the server's minimum version shows "update required".

## 6. Security checklist for the server PC

- The Windows network profile must be **Private** (Settings → Network). The firewall rule opens the HTTPS port only to the local network, and only on Private networks.
- Keep Windows Update on. Don't install unrelated software on the server.
- Give every staff member their own G OPTICALS user. Don't share the administrator account. Turn on two-factor sign-in for administrators (Settings → System Security & Backup).
- Only the HTTPS service (8443) listens on the network. PostgreSQL and the application listen on this PC only.
- Lock the server PC's Windows account. Anyone with Windows Administrator rights on the server can read the business data and reset passwords.
- Keep at least one recent backup off the PC.
