# G OPTICALS for Windows: Installation Guide

For the person installing G OPTICALS at a shop: an IT technician, reseller or shop owner.

G OPTICALS is the software. Your shop's own name, logo, address and tax number are entered during setup and in **Settings → Store & Clinic Profile**, and they are what appears on bills, receipts, prescriptions and reports.

## 1. Choose the setup

| Shop | Install | On which PCs | Procedure |
|---|---|---|---|
| One billing PC | **Standalone** | That PC | Section 4 |
| Several PCs sharing one set of data | **LAN Server** on one PC, then **LAN Workstation** on every other PC | Server first, then workstations | Sections 5 and 6 |

The **LAN Server** PC holds the database. Choose a PC that:
- is switched on during business hours;
- has 8 GB of RAM or more;
- has a fixed address on the network (ask whoever manages the router for a DHCP reservation);
- is on a network that Windows treats as **Private**, not Public (see section 5).

Workstations never hold data. If a workstation breaks, nothing is lost.

## 2. Requirements

| | Standalone / LAN Server | LAN Workstation |
|---|---|---|
| Windows | Windows 10 22H2 (build 19045) or Windows 11, 64-bit | same |
| RAM | 8 GB recommended, 4 GB minimum | 4 GB |
| Free disk | 10 GB or more on the data drive | 1 GB |
| Rights | Administrator, to install | Administrator, to install |
| Network | LAN Server: Private network profile | Same network as the server; TCP 8443 (or the server's chosen port) to the server |

Setup checks the Windows version, RAM and free disk space **before it copies any files**. With less than 8 GB of RAM it warns and asks whether to continue. Below the minimum, it stops and says why.

Setup installs its **own private** PostgreSQL 17 database on port 5544, listening on this PC only. It never changes, stops or uses any other PostgreSQL or MySQL server that is already installed.

## 3. Before you start (every PC)

1. **Check the installer file.** Open PowerShell in the folder that holds the installer and run:

   ```
   Get-FileHash .\G-OPTICALS-Setup-1.0.0.exe -Algorithm SHA256
   ```

   The result must match the SHA-256 in the release notes or release manifest **exactly**. If it doesn't, don't run the file.
2. The installer is not code-signed yet. Windows SmartScreen may show "Windows protected your PC". Choose *More info → Run anyway* only after the SHA-256 check above has passed.
3. Close G OPTICALS on this PC if an older version is open.
4. Do the installation outside business hours. A first install takes about 2–5 minutes; an update also takes a backup first.

## 4. Standalone (one PC)

1. Run `G-OPTICALS-Setup-1.0.0.exe` and accept the Windows administrator prompt.
2. Accept the licence agreement. Keep the default program folder (`C:\Program Files\G-TRADE`) unless you have a reason to change it.
3. **Installation mode:** choose **Standalone**.
4. **Server settings:**
   - **Data folder:** the default is `C:\ProgramData\G-TRADE`. A second drive such as `D:\G-OPTICALS-Data` is fine. Program Files and relative paths are refused.
   - **HTTPS port:** the default is 8443. Change it only if setup reports that the port is in use.
5. **Company and administrator:**
   - Your company name and first branch. These are **your** business details, not the software's name.
   - The administrator's name, e-mail, user name and a password of at least 10 characters. Common or all-number passwords are refused.
   - **Write the user name down. The password is never shown again.**
6. Click **Install**. Setup:
   - creates the private database, which only this PC can reach;
   - generates the passwords and keys for this installation, encrypted with Windows DPAPI;
   - creates the company and the administrator;
   - creates the security certificate;
   - registers and starts three Windows services: `GTrade-DB`, `GTrade-App` and `GTrade-Web`. They run under their own limited Windows accounts (`NT SERVICE\GTrade-DB` and so on), not as Administrator;
   - runs a health check (HTTPS → application → database).

   A Standalone install adds **no** firewall rule. Other PCs can't reach it.
7. Start **G OPTICALS** from the desktop or Start Menu shortcut and sign in as the administrator.
8. Open **Settings → Store & Clinic Profile** and enter your shop's legal name, address, phone, tax number and logo. These print on every document.
9. Do the checks in section 7.

## 5. LAN Server (the PC that holds the data)

1. **Set the network profile to Private.** Open *Settings → Network & internet →* your connection, and set *Network profile type* to **Private network**. The firewall rule that setup adds works only on the Private profile. On a Public network, workstations can't connect.
2. Give the server a fixed address: ask whoever manages the router for a DHCP reservation for this PC.
3. Run `G-OPTICALS-Setup-1.0.0.exe` and accept the Windows administrator prompt.
4. Accept the licence agreement and keep the default program folder.
5. **Installation mode:** choose **LAN Server**.
6. **Server settings, company and administrator:** the same as Standalone, steps 4 and 5 in section 4.
7. Click **Install**. Setup does everything a Standalone install does, and also:
   - adds one inbound firewall rule for the HTTPS port only: TCP, **Private** profile, **local subnet** only. The database (5544) and the application server are never opened to the network;
   - writes the **workstation connection sheet**.
8. At the end, Notepad opens the **connection sheet**. **Print it and keep it with the server.** It lists:
   - the server's addresses;
   - the **pairing code** (for example `7Q4K-29AB`);
   - the certificate fingerprint.

   It contains no passwords. To print it again later, run `gtrade-ctl connection-sheet` (see the Administrator Guide).
9. Start **G OPTICALS** on the server, sign in as the administrator and fill in **Settings → Store & Clinic Profile**.
10. In **Administration → Users**, create a user for each person who will work on a workstation.
11. Do the checks in section 7, then install the workstations (section 6).

## 6. LAN Workstation (every other PC)

A workstation installs only the desktop app. It **never** creates a company, database or administrator, and it holds no business data.

1. Make sure the LAN Server is installed, switched on and running, and you have its **current** connection sheet.
2. From the workstation, check that it can reach the server. In PowerShell:

   ```
   Test-NetConnection SHOP-SERVER -Port 8443
   ```

   Use the server name or address and port from the sheet. `TcpTestSucceeded : True` means you can continue. If it is `False`, see "If something goes wrong" in section 8.
3. Run `G-OPTICALS-Setup-1.0.0.exe` on the workstation and accept the Windows administrator prompt.
4. Accept the licence agreement and choose **LAN Workstation**.
5. Enter **one** server address from the sheet (for example `SHOP-SERVER` or `192.168.1.20:8443`) and the **pairing code**.
6. Setup checks that the server really is the one on the sheet. A wrong code is refused, which protects against connecting to an impostor. Setup then installs the desktop app and saves the connection for every Windows user on this PC.
7. Start G OPTICALS and sign in with a user that the administrator created.
8. Do the workstation checks in section 7.

To change the server later, use *File → Server connection…* in the app and enter the address and pairing code again.

## 7. Check the installation

### Standalone and LAN Server

Open an **elevated** Command Prompt (*Run as administrator*):

```
cd "C:\Program Files\G-TRADE\resources\server"
gtrade-ctl health
gtrade-ctl services verify
```

- `health` must report `"ok": true`.
- `services verify` must list no problems.
- In the app, create a test sale and print it. Check that your shop's name and logo, not the software's name, appear on the bill.
- **Restart the PC.** After Windows starts, wait one minute, open G OPTICALS and sign in. The three services start by themselves at boot. Check that the test sale is still there.
- Check the screen size: the app opens at **100 %** interface size (the **Interface size** button in the header, or **View → Interface size**). Choose another size, restart the app, and check that your choice is kept. Print a test bill at 80 % and at 100 %: the printout must be the same size.
- Take a first backup: `gtrade-ctl backup run`, then copy it to a USB disk with `gtrade-ctl backup offsite --name <name> --target E:\G-OPTICALS-Backups`. The Backup and Recovery Guide explains this.

### LAN Server, extra checks

- `gtrade-ctl firewall status` must show `"rule_present": true`, and the network profile must be Private.

### LAN Workstation

- Sign in as a normal user and open a few screens.
- Create a sale on the workstation and check that it appears on the server, and the other way round.
- Restart the workstation, then sign in again.
- The interface size is set separately on each PC and each Windows user (default 100 %).
- Restart the **server** while a workstation is open. The workstation should reconnect after the server is back, without reinstalling.

## 8. If something goes wrong

### Setup stops with an error

- Nothing in an existing database is changed.
- Read the message and fix the cause. It is usually a busy port, too little disk space or a wrong data folder.
- Run the **same** setup again. It continues from where it stopped and shows the company and administrator pages again.
- Logs are in `<data folder>\logs\install\`, one line per step with the error.
- For support, run `gtrade-ctl diagnostics --out C:\Temp\gopticals-diag.zip` and send the zip. It contains no passwords, keys or business data.

### A workstation can't connect

- Check that the server is switched on and that `gtrade-ctl health` on the server reports `"ok": true`.
- Check that the server's network profile is **Private** and that `gtrade-ctl firewall status` shows the rule.
- Check that both PCs are on the same network (same router, same subnet).
- Use an address and pairing code from the **current** connection sheet. If the server's certificate was renewed or the server was reinstalled, print a new sheet with `gtrade-ctl connection-sheet` and pair again.

The Troubleshooting Guide covers more cases.

## 9. Licence

- A new installation runs a **30-day evaluation** (1 company, 1 branch, 2 users).
- Your provider sends you a **licence key** (a long text that starts with `GTL1.`). To activate, sign in as the
  Local Super Admin or the owner's administrator and open *Licence details* (in the banner, or `/#/license`):
  1. paste the whole key into **Licence key** (line breaks from e-mail are fine);
  2. click **Activate**.
  G OPTICALS checks the key on this computer (vendor signature, client, edition, installation, start and
  expiry). If the key was issued before your provider knew this installation, it is bound to it once
  online; that needs internet on this server for a moment.
- **No internet?** Click *Show installation request code* on the same page and send the code (or the
  Installation ID) to your provider. They send back a key or a `.lic` file bound to this computer: paste it,
  or use **Import licence file**. Both are checked exactly the same way.
- Renewals and plan changes arrive as a new key or file, or automatically with **Check with vendor**
  when the server is online.
- A key for another installation, another client, a suspended, revoked or expired licence is refused with
  the reason. You can never change the plan, period, limits or modules yourself.
- The licence belongs to the **server** (or the Standalone PC). Workstations don't need their own licence.

## 10. Silent installation (technicians)

```
G-OPTICALS-Setup-1.0.0.exe /S /MODE=standalone /ANSWERS=C:\setup\answers.ini
G-OPTICALS-Setup-1.0.0.exe /S /MODE=server /PORT=8443 /ANSWERS=C:\setup\answers.ini
G-OPTICALS-Setup-1.0.0.exe /S /MODE=workstation /SERVER=SHOP-SERVER:8443 /PAIRCODE=7Q4K-29AB
```

Optional: `/DATA=D:\G-OPTICALS-Data`.

`answers.ini` is **deleted after it is read**, because it contains the administrator password:

```ini
[answers]
company_name=<your company>
branch_name=<first branch>
admin_full_name=<name>
admin_email=<e-mail>
admin_username=<user name>
admin_password=<strong password>
```

Silent installs skip the wizard's requirement page, but `gtrade-ctl` runs the same checks before installing and stops with exit code 10 if the PC does not meet them.

Exit codes: 0 OK · 2 bad configuration (for example the data folder) · 10 PC does not meet the requirements · 20 database · 30 licence · 40 services · 50 health check · 60 backup · 70 update failed, previous version restored and running · 71 update failed, previous version **not** confirmed running (call support).

## 11. Updating

Run the new setup on the **server first**, then on each workstation. On the server, setup:
1. stops the G OPTICALS services cleanly (it never force-closes the database);
2. takes a verified backup;
3. upgrades the database;
4. checks that the new version works.

If anything fails, setup **automatically restores the backup and the previous version** and tells you. Do updates outside business hours.

Running the same version's setup again is a **repair**. It keeps the mode, data and settings, and re-applies the program files.

## 12. Uninstalling

- Uninstalling removes the program, its services and its firewall rule. **Your data and backups are kept** in the data folder.
- To delete the data as well, tick *Also delete ALL business data* **and** type the exact company name. A final backup is saved to the Desktop first. If that backup fails, nothing is deleted.
- A silent uninstall (`/S`) always keeps the data.
