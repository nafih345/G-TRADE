# G OPTICALS for Windows: Troubleshooting Guide

For the person supporting a shop installation.

Start with `gtrade-ctl health`, `gtrade-ctl services status` and `gtrade-ctl services verify` (the last one reads back each service's account, start type, dependencies and recovery actions and names anything wrong). The Administrator Guide explains how to run gtrade-ctl. When asking for help, attach the zip from `gtrade-ctl diagnostics --out C:\Temp\gopticals-diag.zip`. It contains no passwords, keys or business data.

Folder, service and command names that say G-TRADE or GTrade are internal names of G OPTICALS.

## Logs

All under `<data folder>\logs\` (default `C:\ProgramData\G-TRADE\logs\`):

| What | Where |
|---|---|
| Setup / repair | `install\install-<time>.jsonl` (one line per step, with the error) |
| Updates / rollbacks | `update\update-<time>.jsonl` |
| Application | `app\backend.log`, `app\error.log` |
| Service wrapper (start/stop/crash) | `services\GTrade-App.*.log`, `services\GTrade-Web.*.log` |
| HTTPS front door | `web\error.log`, `web\access.log` |
| Database | `db\postgresql-<day>.log` |

## Setup problems

| Symptom | Likely cause | Fix |
|---|---|---|
| "Windows protected your PC" (SmartScreen) | The installer is not code-signed yet | Check that the file's SHA-256 matches the release notes, then *More info → Run anyway* |
| "G OPTICALS needs Windows 10 22H2 … / at least 4 GB of RAM / 10 GB of free disk space" | The PC does not meet the requirements | Use a PC that does, or free disk space on the data drive. Nothing was installed. |
| "Port(s) [...] are already used" | Another program uses 8443, 8001 or 5544 | Choose another HTTPS port in setup, or stop that program. Setup never stops it for you. |
| "Enter a full folder path" / "The data folder cannot be inside Program Files" | Relative path, or a folder under Program Files | Use a full path such as `C:\ProgramData\G-TRADE` or `D:\G-OPTICALS-Data` |
| "…is not empty and is not a PostgreSQL cluster" | The chosen data folder contains other files | Choose an empty folder. Setup never deletes those files. |
| "initdb: could not open file …gtrade-pw-… for reading: Permission denied" | Setup 1.0.0 builds before 13 Nov 2026: PostgreSQL drops Administrator rights, and the one-time password file was readable only by Administrators | Use the current setup (it gives the database program its own access and deletes any leftover password file). The empty database folder from the failed try is reused; nothing needs deleting. |
| "…holds an INCOMPLETE database from an interrupted first setup" | Setup was interrupted while it was creating the database | Setup does not delete or overwrite it. If this PC has never held business data in that folder: as Administrator, rename `pgsql\data` (for example `data.incomplete-<date>`), delete `pgsql\initdb.in-progress`, and run setup again. Otherwise contact support first. |
| "This computer is already installed as …" | Reinstalling with a different mode | Keep the mode; or uninstall (data is kept), then install with the new mode |
| "setup did not complete (error N)" | A step failed (see the exit codes in the Installation Guide) | Read the last line of `logs\install\install-<time>.jsonl`, fix the cause and run the **same** setup again. It resumes and shows the company and administrator pages again. |
| Update log: "GTrade-App.exe refresh failed … Unknown command: refresh" | Setups built before 13 Nov 2026 20:00 called a service-wrapper command that the bundled WinSW 2.12 does not have | Run the current setup. Your data is not affected (that failure happens before any database change). |
| "The update did not complete (error 70)" | The update failed and the previous version was started again **and checked** | Keep working. Send `logs\update\update-<time>.jsonl` to support. |
| "The update did not complete (error 71)" | The update failed and setup could **not** prove the previous version is running | Run `gtrade-ctl services verify` and `gtrade-ctl health`. Then run the same setup again. No business data is deleted, and a verified backup was taken before any database change. |
| "GTrade-DB did not stop within … Nothing was changed" | PostgreSQL did not finish its clean shutdown in time | Setup never force-closes the database. Wait a minute, restart the PC and run setup again. |
| `services verify`: "runs as 'LocalSystem', expected 'NT SERVICE\GTrade-App'" (or similar) | An installation from before 13 Nov 2026 whose update has not completed yet | Run the current setup (or `gtrade-ctl repair` as Administrator). It moves each service to its own account and verifies it; if a service cannot run under it, the previous account is put back and the error is shown. |
| Workstation: "Could not connect to the G OPTICALS server" | Wrong address or pairing code, server off, firewall, Public network profile on the server | Check the server is on and its network profile is Private. Use an address and the code from the **current** connection sheet. You can also connect later from *File → Server connection…*. |

## Daily-use problems

| Symptom | Likely cause | Fix |
|---|---|---|
| Desktop app shows **"server is not available"** | Server PC off or asleep, services stopped, or a network problem | Switch on the server. In *Services*, start `GTrade-DB`, then `GTrade-App`, then `GTrade-Web` (or run `gtrade-ctl services start`). Ping the server from the workstation. |
| "Security check failed: … certificate …" | The workstation's saved server certificate does not match. Either the server was reinstalled without restoring its data, or something on the network intercepts traffic. | Make sure you are on the right network. Re-pair with *File → Server connection…*, using the address and pairing code from the **current** connection sheet (`gtrade-ctl connection-sheet`). |
| App shows **"being updated or restored"** | An update or restore is running, or one was interrupted | Wait 5 minutes. If it stays, run `gtrade-ctl update status`. If that shows an interrupted update, run `gtrade-ctl repair`, which reports what to do. As a last resort, restore the pre-update backup it names. |
| API answers **503 schema_out_of_date** | New program files but the database was not upgraded (an interrupted update) | Run `gtrade-ctl migrate --plan`, then `gtrade-ctl update apply --version <new>`, or re-run the setup |
| Saving is refused with **402 / "read-only"** | Licence expired or revoked, or the evaluation is over | Open *Licence details*: activate online, import a renewal file, or click *Check now*. Data stays readable. |
| "Licence belongs to another computer" | The server's hardware changed beyond tolerance, or the data was moved | Click *Check now* while online (this re-binds the licence), or ask the provider for a transfer. Full use continues for 14 days. |
| "The computer clock is earlier than … last saw it" | Wrong Windows date or time | Fix the date and time (turn on automatic time) |
| Nobody can sign in as administrator | Lost password | On the server PC: `gtrade-ctl reset-password --list-admins`, then `gtrade-ctl reset-password --user <name>`. See the Administrator Guide. |
| "Too many failed sign-in attempts. Try again in N minutes" | Temporary lockout after repeated wrong passwords | Wait the minutes shown; the lock lifts by itself. The lockout length is set in Settings → System Security & Backup. |
| Backup screen: "No database backup exists" / "older than 2 days" / an error | The scheduler couldn't run (app down at 21:30 and since), or the disk is full | Free disk space, click **Back up now**, check `app\error.log` |
| `GTrade-App` keeps restarting | Configuration or database error at start-up | Read `services\GTrade-App.err.log` and `app\error.log`. Run `gtrade-ctl verify-db` and `gtrade-ctl repair`. |
| `GTrade-DB` will not start | Data folder permissions, disk full, or a damaged database | Read `db\postgresql-*.log`. Run `gtrade-ctl repair`, which resets permissions. If the database is damaged, restore the latest verified backup. |
| `gtrade-ctl` says "must be run from an elevated Command Prompt", or (older builds) `PermissionError: [WinError 5] Access is denied: …\config\install.json` | The Command Prompt is not elevated. A normal prompt, PowerShell or VS Code terminal is not elevated, even for an administrator account, so Windows lets it read nothing in `config` (by design). | Right-click **Command Prompt** → **Run as administrator** (title starts with `Administrator:`), `cd /d "C:\Program Files\G-TRADE\resources\server"`, and run the same command again. Do not change the folder permissions. |
| A service log says "Access is denied" for a file under the data folder | The file's permissions were changed by hand or by another tool. Each service runs under its own restricted account and can only use its own folders. | As Administrator: `gtrade-ctl repair-permissions`, then `gtrade-ctl services start`. Do not give "Everyone" or "Users" access to the data folder: it holds the database password and backups. |
| Bills show the wrong shop name or address | Store profile not filled in | Settings → Store & Clinic Profile. The software name never prints on customer documents. |
| Bills or the header show **"Main Company"** / **"Head Office"** although other names were typed in setup | Installed with a 1.0.0 setup built before 13 Nov 2026 evening: the wizard's company and branch names did not reach the store profile | Settings → Store & Clinic Profile: enter the shop's name. Administration → Branch Management: rename "Head Office". Current setups apply the typed names automatically. |
| Every screen waits a moment before loading; `https://127.0.0.1:8443` is fast but `https://localhost:8443` is slower | Builds before 13 Nov 2026 evening listened on IPv4 only, while Windows tries `localhost` over IPv6 (::1) first | Install the current setup over it (an update rewrites the web configuration with an IPv6 loopback listener). Data is kept. |
| Barcode scanner types into the wrong field, or nothing happens | Scanner not in USB-HID keyboard mode, or no Enter suffix | Configure the scanner for HID keyboard with a CR suffix |
| Printing goes to the wrong printer | Windows default printer | Choose the printer in the print dialog. Set the paper or label size in the printer driver. |
| Excel import does nothing | Old cached app | Reload (F5). The Windows edition loads the Excel library from the server, not the internet. |

## Recovery recipes

- **A service won't start after a Windows update:** `gtrade-ctl repair`, then `gtrade-ctl health`.
- **Undo a wrong restore:** see the Backup and Recovery Guide, section 7.
- **Failed update:** setup restores the previous state automatically. The failed database is kept for support. Send the `update\*.jsonl` log and the diagnostics zip.
- **Setup failed part-way on a new PC:** run the same setup again. It resumes. Nothing was written to any other database.
