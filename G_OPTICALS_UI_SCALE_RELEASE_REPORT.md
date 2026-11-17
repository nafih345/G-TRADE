# G OPTICALS for Windows: Interface Size, Preflight and Release Candidate Report

**Date:** 2026-11-14 (IST)
**New release candidate:** `windows\out\installer\G-OPTICALS-Setup-1.0.0.exe`
**SHA-256:** `FF30E85B04C54B291CE4D113214E0E5ABF2428ECF271AABB966E95BF05FC099C`
**Size:** 206,117,069 bytes · **BUILD_ID** `1.0.0-20261113T211052Z-13c9ec76` · **Unsigned**
**Replaces:** `AB37EFAC…4D81`. That build is not defective, but it has no interface size. A copy is in `windows\out\superseded-installers\`.

Nothing was installed, upgraded, restarted or distributed. The installed G OPTICALS, PostgreSQL 17/18, MySQL and pgAgent on this PC were not touched.

## 1. Existing-PC preflight (Part 2): FAILED, upgrade not attempted

| Check | Result |
|---|---|
| Available RAM | **FAIL**: 0.91 GB free of 7.21 GB (setup needs at least 2 GB available) |
| Disk space | OK: C: 49.8 GB free, D: 87.4 GB free |
| Installer SHA-256 | OK: the file on disk matched AB37EFAC at preflight time. It is now superseded by FF30E85B. |
| Administrator privileges | **FAIL**: this session is not elevated |
| Existing installation | Present: `C:\Program Files\G-TRADE` (files dated 13-11 18:29/18:40) and `C:\ProgramData\G-TRADE`. **GTrade-DB is running; GTrade-App and GTrade-Web are stopped** (the state left by the 13-11 18:42 failed update). |
| Database and configuration backup | **NOT VERIFIABLE**: `config`, `backups` and `pgsql` cannot be read without elevation. No backup or restore could be checked. |
| Other database services | Untouched and running: postgresql-x64-17 (:5432), postgresql-x64-18 (:9961), MySQL80 (:3306), pgagent-pg17 |

**What the owner needs to do before the upgrade:** restart the PC, or close programs, until at least 2 GB is available. Then, from an elevated prompt, run `gtrade-ctl backup run` and confirm that the backup verifies. Then approve the upgrade.

## 2. Interface size (Part 1)

**How it works.** The desktop shell applies Chromium's native zoom to the main window only. It is set from **View → Interface size**, from the **Interface size** button in the header, or with **Ctrl + Plus / Ctrl + Minus / Ctrl + 0** (reset to default).

- Sizes: 75 / 80 / 90 / 100 %. Default: **80 %**.
- The choice is saved per Windows user in `%APPDATA%\G-TRADE ERP\ui-settings.json`. A missing or corrupt file falls back to 80 %.
- There is one mechanism only. There is no CSS zoom or transform, and the stock Electron zoom roles were removed.
- The cloud web app is unchanged. The header control appears only inside the desktop app.
- Windows display scaling and resolution are never changed.

**Why native zoom.** It scales the sidebar, header, forms, tables, dialogs, menus and charts together. It keeps full-height layouts, dropdown and dialog positioning, and click targets correct. It was tested against printing:

- PDF and print output is **byte-geometry identical at 75/80/90/100 %**, under Windows scaling 100/125/150 %.
- Bill, receipt and label popups always open at 100 %.

**Visual validation.** 432 page loads of the real packaged app, after a real sign-in, on 12 screens: Dashboard, Products, Stock Overview, Purchase Entry, Suppliers, New Sale, Orders, Customers, Sales Report, Eye Test, Accounts Reports and Settings. Matrix: 1366×768 / 1440×900 / 1920×1080 × Windows 100/125/150 % × 75/80/90/100 %.

| Check | Result |
|---|---|
| Page-level horizontal scroll | 0 |
| Controls past the window edge and unreachable | 0 |
| Button labels clipped | 0 |
| Overlapping input fields | 0 |
| Error screens | 0 |
| Header Interface size menu (5 items, current size ticked, on screen) | 36 / 36 |
| Dropdowns opened inside the window | 104 / 104 |
| Print/PDF size identical at every scale | yes (all 3 Windows scalings) |

Two existing layout defects were found by this run. Both also occurred at 100 %, and both were fixed:

1. **Tab bars clipped tabs that could not be clicked.** For example, Purchase → Barcode Printing, Lens Purchase Order and Purchase Return on smaller screens. All tab bars now scroll, with arrows.
2. **Purchase Entry Warehouse and Branch fields drew the label over the value.**

**Readability.** Effective on-screen text size in physical pixels at the 80 % default:

| Windows scaling | Typical text | Smallest text (field labels, captions) |
|---|---|---|
| 150 % | 15.6 px | 11.2 px |
| 125 % | 13.0 px | 9.4 px |
| 100 % | 10.4 px | 7.5 px |

80 % is a good default on laptops at 125–150 % Windows scaling. On a 1366×768 laptop at 150 %, it is what makes Inventory's header buttons and its 9-column product table fit; at 90–100 % they need scrolling. On monitors at **100 % Windows scaling**, 80 % is readable but small. Staff who find it small should choose **90 %**, which takes one click and is remembered.

## 3. Tests (Part 7)

| Suite | Result |
|---|---|
| Windows suite with real-stack e2e (`GTRADE_E2E=1`) | **199 / 199 OK**, 0 skipped. Includes new Electron tests: 80 % first run, 90 % kept after restart, corrupt or unsupported file falls back to 80 %, workstation 80 %. |
| Desktop unit tests | 22 / 22 (6 new) |
| Frontend unit tests | 26 scripts, 207 tests, 0 failures (3 new) |
| Django cloud suite (throwaway PG17) | 1,158 run: 16 failures, all caused by a **test-fixture date bug** (see below). Fixed; `apps.financial` + `apps.inventory` rerun **282 / 282 OK** inside the failing time window. |
| Django local-edition suite | 23 / 23 OK |
| `makemigrations --check` | No changes detected (run against an unreachable dummy DB, never Neon) |

**About the 16 failures.** The test helper took "today" from this PC's clock (IST). The server's business date is UTC. Between 00:00 and 05:30 IST the tests created bills dated "tomorrow". The fixture now uses the server date. No product code changed, and no test was skipped or weakened.

**Not re-run:** the elevated service self-test needs administrator rights. The service and permission code is unchanged since its 70 / 70 pass on 13-11 at 23:05.

## 4. Package, secrets and Defender

- `windows\tooling\verify_package.py` (new) extracts the built .exe and runs **26 / 26 checks**. These cover:
  - The server tree is identical to the stage manifest, and all 148 migrations are present.
  - PostgreSQL 17, the embedded Python 3.12 imports, nginx and WinSW are present.
  - The SPA and desktop shell contain the interface size feature.
  - The bundled guides match the source.
  - There are no secrets, private keys or vendor licence keys.
- `payload_guard`: OK on `win-unpacked` and on the extracted payload.
- 7-Zip integrity: OK. The outer installer has 10 files, the app payload 10,667.
- **Microsoft Defender custom scan: no threats** in the installer or the extracted payload (signatures 1.463.279.0). Real-time protection was left on.
- Authenticode: not signed (same as before).

## 5. Performance (Part 6)

There were no performance changes in this pass, so there is no "after" improvement to report. Same API flow on a small dataset, fastest of two runs:

| Request | Previous RC | This run |
|---|---|---|
| Login | 603 ms | 863 ms |
| Dashboard | 78 ms | 93 ms |
| Products list | 62 ms | 64 ms |
| Product search | 35 ms | 54 ms |
| Sales report | 67 ms | 117 ms |
| Stock overview | 129 ms | 150 ms |

No backend code changed between the two runs. The slower figures match this PC having under 1 GB of free RAM throughout. Login time is mostly deliberate password hashing and is not reduced.

Known open item: the product list without `?page=` returns everything (about 2.4 s / 5.4 MB at 5,000 products). The New Sale and POS pickers depend on that list, so it was left unchanged rather than risk billing or stock.

## 6. Still open (owner actions, in order)

1. **Upgrade this PC:** free RAM, take and verify an elevated backup, then approve the upgrade. After that, the restart test (Part 3).
2. **Clean Windows PC install** (Part 4). This PC can't host a VM.
3. **Two-PC LAN Server + Workstation** (Part 5).
4. To repeat the screen checks on any PC: `cd windows` then `python -m tests.ui_scale_visual` (self-contained; it never touches the installed system).
