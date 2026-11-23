# G OPTICALS for Windows 1.0.0: Release Notes

**Installer:** `G-OPTICALS-Setup-1.0.0.exe`
**SHA-256:** `FF30E85B04C54B291CE4D113214E0E5ABF2428ECF271AABB966E95BF05FC099C`
**Size:** 206,117,069 bytes
**Status:** internal release candidate. Not code-signed. The licence agreement is a draft. See "Before commercial release" below.

Check the file before running it. In PowerShell:

```
Get-FileHash .\G-OPTICALS-Setup-1.0.0.exe -Algorithm SHA256
```

The result must equal the SHA-256 above.

## What is in 1.0.0

- **Three installation modes:** Standalone, LAN Server and LAN Workstation. A workstation pairs with the server using a pairing code and a pinned certificate. It never creates its own database or company.
- **First-launch setup inside the installer:** your company, first branch and administrator account. Your business identity, not the software's, appears on bills, receipts, prescriptions and reports (Settings → Store & Clinic Profile).
- **Private database:** a bundled PostgreSQL 17 that listens on this PC only (port 5544). Existing PostgreSQL or MySQL installations are never touched.
- **Windows services** for the database, application and HTTPS front end. They start automatically and restart after failures. A health check runs at the end of setup.
- **Up-front requirement checks:** Windows version, RAM and free disk space are checked before any file is copied.
- **Backups:** verified daily backups with retention, a backup before every update, one-command off-PC copies, restore with an automatic safety backup, and automatic rollback of a failed update.
- **Upgrade, repair and data-preserving uninstall.** Deleting the data needs an explicit tick plus the company name, and a final backup is taken first.
- **Print preview:** Print opens the app's own preview with the real pages (paper size, margins, logo, tables), a printer list that separates paper printers from virtual ones, A4 / A5 / Letter fitting, receipt rolls cut to length, copies and **Save as PDF**. It replaces the Windows dialog that said "This app doesn't support print preview".
- **Interface size:** the desktop app opens at 100 %; 75 / 80 / 90 / 100 % from the header or View menu, remembered per Windows user, with Reset to default. Printed bills, receipts, labels and PDFs keep their real size.
- **Recovery tools:** `gtrade-ctl reset-password` for a lost administrator password, run on the server PC only; `gtrade-ctl repair`; and a diagnostics bundle without secrets.
- **Licensing:** a 30-day evaluation, online or offline activation, and read-only mode, never lockout, when a licence lapses.
- **Guides** are installed in `C:\Program Files\G-TRADE\resources\docs\`: Installation, User, Administrator, Backup and Recovery, and Troubleshooting.

## Changes since the previous internal build (E4B776C5…)

- Customer documents now carry the customer's identity:
  - The WhatsApp receipt is signed with the store's own name and phone. The fixed sample phone number has been removed.
  - Appointment messages, the prescription card and the eye-examination screen no longer name the old product.
  - The prescription card no longer prints a sample doctor's name or a "Digitally Signed & Verified" badge.
  - The UPI dialog no longer shows a sample UPI ID.
- Administration → Audit Logs now shows the real security audit trail instead of fixed sample rows.
- Backup file names, backup messages and the authenticator-app label (two-factor sign-in) use the product name G OPTICALS in the Windows edition.
- The installer checks Windows build, RAM and free disk space before copying files.
- New `gtrade-ctl reset-password` command.
- The guides are bundled with the installer.

## Known limitations

- **Unsigned installer:** Windows SmartScreen warns on first run.
- **No product icon:** the installer and shortcuts use the default Electron icon until an official G OPTICALS icon is supplied.
- **Internal names:** some folder, service and tool names still read G-TRADE / GTrade (`C:\Program Files\G-TRADE`, `C:\ProgramData\G-TRADE`, `GTrade-DB/App/Web`, `gtrade-ctl`). They are internal identifiers, kept so that upgrades find existing installations.
- **One customer per installation:** a second, unrelated business needs its own installation. Several companies of the same owner are supported, within the licence.
- **Development licence keys:** this build verifies licences with development keys. Production keys and the hosted licence service are not set up yet.
- **Not yet tested on clean machines:** the elevated install has been exercised by automated tests on the development PC, but not yet on clean Windows 10 / 11 virtual machines or a real two-PC network.

## Before commercial release (owner actions)

1. Code-signing certificate, then sign and rebuild.
2. Publisher legal name, product icon, and an approved licence agreement (`windows/docs/LICENSE_AGREEMENT_DRAFT.md`).
3. Production licence key ceremony and a hosted licence service, then add the `RELEASE` marker to the build.
4. Clean-VM install tests (Windows 10 22H2 and Windows 11) and a two-PC LAN test.
