# G OPTICALS — Customer Installation Guide (operator checklist)

For the technician who installs G OPTICALS at a customer's shop. G OPTICALS is the software (vendor) name. Every business name you enter belongs to the **customer**.

Installer: `G-OPTICALS-Setup-1.0.0.exe` · 206,058,076 bytes · SHA-256 `AC9551B3738CA3616D7BA6C7B699F75B0A3F6526B161892F0F98DAEEC651E4D0`

Full reference guides are installed with the app in `C:\Program Files\G-TRADE\resources\docs\`: Installation, Administrator, Backup & Recovery, Troubleshooting, User.

## Requirements

| | Standalone / LAN Server | LAN Workstation |
|---|---|---|
| Windows | 10 22H2 (build 19045+) or 11, **64-bit** | same |
| RAM | 8 GB recommended. 4 GB minimum (setup stops below 4 GB and warns below 8 GB). | 4 GB |
| Free disk | ≥ 10 GB on the data drive | 1 GB |
| Account | Local Administrator, to install | same |
| Ports | 8443 (HTTPS). 8001 and 5544 are used on this PC only. All three must be free. | outbound TCP 8443 to the server |
| Firewall | Standalone: none opened. LAN Server: setup adds one inbound rule for 8443, Private profile. | none |

Existing PostgreSQL or MySQL on the PC is fine. G OPTICALS runs its **own** PostgreSQL 17 on port 5544, on this PC only, and never stops, changes or uses another database server.

## Steps

1. **Prepare the PC.**
   - Restart it once. Install pending Windows updates first.
   - Close other heavy programs. Task Manager should show at least 2 GB of memory available.
   - Set the network to **Private** (LAN Server only).
   - Do not install on a PC whose data you cannot afford to lose until a backup is made.
2. **Transfer the installer** on a USB stick or by download, to e.g. `C:\Users\<you>\Downloads`.
3. **Verify the SHA-256.** In PowerShell, run `Get-FileHash .\G-OPTICALS-Setup-1.0.0.exe`. It must equal `AC9551B3738CA3616D7BA6C7B699F75B0A3F6526B161892F0F98DAEEC651E4D0`. **If it differs, stop.**
4. **Run as Administrator.**
   - Right-click → *Run as administrator* → accept UAC.
   - SmartScreen may say "Windows protected your PC" because the installer is not code-signed yet. Choose *More info → Run anyway* only after step 3 matched.
   - Never disable Defender or SmartScreen.
5. **Complete the installation.**
   1. Welcome.
   2. Licence.
   3. **Mode:** *Standalone*, or *LAN Server* on the main PC.
   4. Keep the program folder.
   5. **Server settings:** data folder `C:\ProgramData\G-TRADE` (or e.g. `D:\G-OPTICALS-Data`) and HTTPS port 8443.
   6. **Company + administrator:** the **customer's** company name and first branch name, the administrator's name, e-mail, user name and a strong password (10+ characters). Write the user name down and hand the password to the owner in private.
   7. Install. This takes about 2–5 minutes. Setup:
      - checks Windows, RAM, disk and ports;
      - creates the private database and protected folders;
      - runs migrations;
      - creates the company and administrator;
      - registers the services `GTrade-DB`, `GTrade-App` and `GTrade-Web` (automatic start, restart on failure);
      - creates the shortcuts;
      - runs a health check.

      A failure shows a message and the log path.
6. **Open G OPTICALS** from the desktop shortcut.
7. **Configure the customer's organisation.** After signing in:
   - *Settings → Store & Clinic Profile:* legal name, address, phone, tax/registration number, **logo upload**.
   - *Settings → Business & Localization:* country, currency, tax terms and rates, language/number formats.
   - *Administration → Branch Management:* check the branch name.
8. **Administrator account.** Sign in with the account from step 5. Add staff users under *Administration → Users* (each with their own password).
9. **Verify the PostgreSQL connection.** In a browser on the same PC, open `https://localhost:8443/api/health/`. It must show `"database": "connected"` and `"migrations": "up_to_date"`. Alternatively, in an elevated prompt: `"C:\Program Files\G-TRADE\resources\server\gtrade-ctl.cmd" health`.
10. **Test product, customer and invoice.**
    - Create a test product (with barcode) and a test customer.
    - Make a purchase entry for 2 units, then a sale of 1 unit.
    - Print or preview the invoice and receipt. They must show the **customer's** business name and logo.
    - Check the stock shows 1.
    - Afterwards cancel or delete the test documents according to the shop's procedure.
11. **Restart Windows.**
12. **Verify again.** Open G OPTICALS without starting anything by hand, sign in, and check that the test records and the stock are unchanged.
13. **Configure backup.**
    - *Settings → System Security & Backup:* confirm the daily backup time.
    - Click **Back up now** and check that it succeeds.
    - Set up a copy **off the PC** (external drive or second PC) as described in the Backup & Recovery Guide.

**LAN Workstation** (after the server passes steps 1–13):
1. Print the connection sheet that opened at the end of the server setup.
2. On each workstation, run setup → *LAN Workstation* → enter a server address from the sheet and the pairing code.
3. Sign in with a user the administrator created, and check that a bill made on the workstation appears on the server.

## Troubleshooting (most common)

| Symptom | What to do |
|---|---|
| Setup stops: Windows version / RAM / disk / port | Fix the cause it names (free disk, close the program using the port, or choose another HTTPS port). Nothing was installed. |
| Setup stops part-way ("setup did not complete (error N)") | **Delete nothing.** Read the last line of `C:\ProgramData\G-TRADE\logs\install\install-*.jsonl`, fix the cause and run the **same** setup again. It resumes. |
| "…holds an INCOMPLETE database…" | Setup never deletes it. If the PC has never held business data: as Administrator, rename `C:\ProgramData\G-TRADE\pgsql\data` to `data.incomplete-<date>`, delete `pgsql\initdb.in-progress`, and run setup again. Otherwise contact support first. |
| App says "server is not available" | In *Services*, start `GTrade-DB`, then `GTrade-App`, then `GTrade-Web`, or run `gtrade-ctl services start`. Read `C:\ProgramData\G-TRADE\logs\services\*.err.log`. |
| Bills show "Main Company" / "Head Office" | Installs made with builds before 13 Nov 2026 evening: rename them in Store & Clinic Profile and Branch Management. |
| Lost administrator password | On the server PC, elevated: `gtrade-ctl reset-password --list-admins`, then `gtrade-ctl reset-password --user <name>`. |
| Workstation cannot connect | Server on, network profile Private, correct address and current pairing code (`gtrade-ctl connection-sheet` on the server). |

The full table is in the bundled Troubleshooting Guide.

## Uninstall and recovery

- **Uninstall:** *Settings → Apps → G OPTICALS → Uninstall*. Program files and services are removed. **Business data in `C:\ProgramData\G-TRADE` is kept.** It is deleted only if you tick "Also permanently delete ALL business data and backups" **and** type the company name; a final backup is attempted first. Silent uninstall always keeps data. Reinstalling over the kept data reuses it.
- **Restore a backup:** elevated `gtrade-ctl backup list`, then `gtrade-ctl backup restore` (exact steps in the Backup & Recovery Guide). A restore first makes a safety backup of the current state.
- **Failed update:** setup restores the pre-update backup and the previous version automatically. Logs are in `C:\ProgramData\G-TRADE\logs\update\`.
- **Never** delete `C:\ProgramData\G-TRADE\pgsql` by hand on a PC that has held business data.
