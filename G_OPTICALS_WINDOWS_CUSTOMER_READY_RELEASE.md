# G OPTICALS — Windows Customer-Ready Release Report

Date: 2026-11-13 (16:44–17:25 IST) · Build: `G-OPTICALS-Setup-1.0.0.exe` SHA-256 `AC9551B3738CA3616D7BA6C7B699F75B0A3F6526B161892F0F98DAEEC651E4D0` · Nothing installed, committed, pushed or deployed in this pass. Neon, Render and Vercel were not contacted.

## Verdicts

| # | Area | Verdict | Evidence / what is missing |
|---|---|---|---|
| 1 | **Application Performance** | **GO** | Fixed a ~2 s per-connection delay on every `localhost` request (§3). No N+1 on the 10 main screens. All screens answer in 12–205 ms on a fresh install. The data set was small: large-catalogue timings are not measured. |
| 2 | **Windows Installer** | **NO-GO, one test away** | Its predecessor (`1ACEFB53`, same NSIS script) completed a **real elevated install** on this Windows 11 PC. **This exact build has not yet run elevated.** It passed every automated harness, including real PostgreSQL, real nginx/TLS, upgrade and Electron. |
| 3 | **Customer Standalone Installation** | **NO-GO, not verified** | Never tested on a **clean** PC. Never tested after a **Windows restart**: this PC has not rebooted since the 11:55 install. A login, product, customer and invoice through the real installed GUI has not been done. |
| 4 | **LAN Installation** | **NO-GO** | No second PC or VM. Workstation pairing is covered only by an automated test on one machine. |

**What is missing to change 2 and 3 to GO** is in §7. It is about 30 minutes of your time with UAC clicks, plus one spare PC for the clean test.

## 1. Installation blockers found and fixed in this pass

| # | Problem (confirmed) | Impact on a customer | Fix | Proof |
|---|---|---|---|---|
| A | **Customer's company and branch names were ignored.** The wizard saved them on the tenant and organisation, but migration `company 0003` had already seeded the store profile **"Main Company"** with branch **"Head Office"**. `ensure_tenant_defaults` only fills missing rows, so the placeholders stayed. | Every bill, receipt and the header would show "Main Company / Head Office" instead of the customer's business. | `local_create_admin._apply_customer_names`: on a brand-new installation, the untouched seed names take the typed names. A name someone already set is never overwritten. | Licensing test now asserts the store profile and branch names (23/23 OK). **Mutation check:** with the fix removed, the test fails with `'Main Company' != 'Sunrise Opticals'`. The e2e store profile returns `Lakeview Eye Care / Town Centre`. |
| B | **~2 s added to new connections.** nginx listened on `127.0.0.1` only. Windows resolves `localhost` to `::1` first, and a closed `::1` port is refused only after ~2.05 s (SYN retries). | Python/.NET clients waited 2 s per request. Chromium/Electron races to IPv4 after ~0.2 s, so desktop users paid ~0.2 s on every new connection. | `nginx.ipv6_loopback_available()` probes `::1`. When bindable, nginx also listens on `[::1]:<port>` (**loopback only, never `[::]`**). PCs without IPv6 keep the IPv4-only config, so nginx always starts. Updates rewrite nginx.conf, so existing installs get it too. | Unit test (both branches, no `[::]`). Stack e2e `lan_exposure` still OK. Bundled nginx 1.30.6 verified to serve `[::1]`. |
| C | **Stale installer.** RC `1ACEFB53` was built before ~40 source changes (role gate, migration `common 0012`, Client Management). | Customer would get older code than tested. | Rebuilt from the current tree. The payload is byte-checked against the source. | §5 |

Earlier fixes still present and re-tested: NSIS ProgramData path, config ACL (no `/T`), PostgreSQL password file and initdb/data/logs permissions under the restricted token, `initdb.in-progress` → `partial` (never auto-deleted), and resume after a partial install.

**Correction to my previous report** (`G_OPTICALS_URGENT_CUSTOMER_INSTALLATION_READINESS.md`): it said no install had got past PostgreSQL setup on real hardware. **That was wrong.** The logs in `C:\ProgramData\G-TRADE\logs\install\` show the owner's elevated install of `1ACEFB53` at 11:52–11:55 completed all 16 steps:

- preflight → permissions → configure → prepare-data → secrets → **database 13 s** → **migrate 108 s** → collectstatic → create-org → tls → nginx → license → **services** → firewall → client-config → **health** → connection-info.
- It ran on the same PC after three failed attempts, with no manual cleanup, so a retry after a partial install works on real hardware.

## 2. Real Windows evidence (this PC, Windows 11 Home build 26200, x64, 7.2 GB RAM)

This is not a clean PC. It already runs PostgreSQL 17 (:5432), PostgreSQL 18 and MySQL 8 (:3306), which makes it a real coexistence test.

| Check | Result | Source |
|---|---|---|
| Elevated install (`1ACEFB53`) | **All 16 steps OK**, 2 min 46 s | `install-20261113-115218.jsonl` |
| Retry after 3 failed installs | Resumed, no manual cleanup | same folder, 09:27 / 09:34 / 10:50 logs |
| Services | `GTrade-DB` (NetworkService), `GTrade-App`, `GTrade-Web`: Running, **Automatic**, restart on failure after 5 s / 10 s / 30 s | `sc qfailure` |
| Health | `https://127.0.0.1:8443/api/health/` → 200, database connected, **migrations up_to_date** | live probe 16:47 |
| Isolation | G OPTICALS PostgreSQL on **127.0.0.1/::1:5544 only**. Existing PG :5432 and MySQL :3306 untouched and still running. | `Get-NetTCPConnection` |
| Shortcuts | Desktop + Start-menu `G OPTICALS.lnk` | present |
| Windows restart | **Not tested.** Last boot 11:39, before the install. | — |
| GUI login + business data | **Not tested on the installed app.** The admin password is the owner's; I did not reset it. | — |

## 3. Performance

**Method:**
- **Timings:** the same installed stack (engine install from the staged payload, PostgreSQL 17 → Waitress → nginx TLS), measured over HTTPS exactly as the desktop app calls it. Each screen was read twice (cold, then warm), before and after a full cold restart. Evidence: `windows\out\evidence\business_flow_e2e.json`.
- **N+1 probe:** SQL query counts per screen with 3 rows, then with 9 rows saved through the real APIs.

| Screen | Before fix B (ms) | After fix B (ms) | Queries (3 rows → 9 rows) |
|---|---|---|---|
| Login | 2,742–3,008 | 612–846 ¹ | — |
| Dashboard | 2,081–2,179 | 90–127 | 10 → 10 |
| Product list | 2,096–2,153 | 49–114 | 2 → 2 |
| Product search | 2,078–2,248 | 49–94 | 2 → 2 |
| Barcode lookup | 2,043–2,140 | 23–205 | — |
| Customers | 2,047–2,126 | 18–71 | 2 → 2 |
| Suppliers | 2,043–2,104 | 12–37 | 1 → 1 |
| Purchases | 2,077–2,162 | 44–102 | 3 → 3 |
| Sales list | 2,070–2,123 | 42–79 | 4 → 4 |
| Sales report | 2,115–2,165 | 63–115 | 4 → 4 |
| Stock overview | 2,162–2,184 | 103–128 | 11 → 11 |
| Trial balance | 2,100–2,121 | 39–64 | — |
| Payments | — | — | 1 → 1 |

¹ Login time is password hashing, a deliberate security cost, and was left alone.

**Honest scale of the gain for desktop users:**
- The "before" column comes from a Python client that waits the full 2 s.
- Electron/Chromium paid about 0.2 s per *new* connection (curl: `localhost` 0.23 s vs `127.0.0.1` 0.04 s), and nothing once a connection is reused.
- With the fix, nginx answers `localhost` in 1.7 ms.

**Not changed, on purpose:**
- **No ORM, index or caching changes.** No screen showed query growth, and changes there would touch stock, accounting and tenant code without a measured reason.
- **The React bundle is already split.** Largest chunks: MUI 477 kB (145 kB gzip) and charts 420 kB (113 kB gzip). It is served locally, so download time is negligible.

**Not measured:** a large catalogue (10k+ products) or a year of invoices. The query counts are constant, so time should grow with page size only, but no timings were taken at that volume.

**Regression guard added:** `backend/apps/common/tests_query_scaling.py` fails if any of the 10 screens starts issuing more queries as rows grow.

## 4. Test results (this pass)

| Suite | Kind | Result |
|---|---|---|
| Windows engine suite (`unittest discover`) | automated | **129 run, OK** (30 skipped = the opt-in e2e below, run separately) |
| `test_business_flow_e2e` (new): engine install with customer names → HTTPS login → category, brand, product, customer, supplier, purchase (+2 stock), sale (−1 stock) → read back → **full cold stop/start of PostgreSQL + app + nginx** → data, stock and numbering intact, second sale numbers and deducts | automated, real PG 17 + nginx + Waitress | **5/5 OK**. Before fix A: 4/5 (the customer-name check failed). |
| `test_e2e_stack` (TLS pinning, headers, LAN exposure, maintenance, graceful restart, crash recovery, log secrets, debug refused) | automated, real stack | **10/10 OK** |
| `test_backup_update_e2e` (backup + tamper detection, restore, update, failed-update rollback, downgrade refused, retention, scheduler, uninstall keeps data) | automated, real stack | **10/10 OK** |
| `test_desktop_install_e2e` (engine install → **Electron** loads pinned server and logs in, rogue CA refused, **workstation pairing**, admin password reset) | automated, real Electron | **5/5 OK** |
| `apps.licensing` under local-edition settings, fresh PG 17 (all 148 migrations incl. `common 0012`) | automated | **23/23 OK** |
| `tests_query_scaling` (new), cloud settings, fresh PG 17 | automated | **1/1 OK**, no N+1 |
| Full backend suite (1,156) | automated | **Not re-run in this pass** (45 min). It passed earlier today: 1,155 OK + 1 known flake. Since then, only `local_create_admin` (local-only command, covered above) and a new test file changed. |
| Frontend (208) / desktop shell (16) | automated | **Not re-run.** No frontend or desktop source changed since they passed today. |

## 5. Final installer

| | |
|---|---|
| File | `D:\G OPTICALS\windows\out\installer\G-OPTICALS-Setup-1.0.0.exe` |
| Size | **206,058,076 bytes** |
| Built | 2026-11-13 17:16:50 IST |
| SHA-256 | **`AC9551B3738CA3616D7BA6C7B699F75B0A3F6526B161892F0F98DAEEC651E4D0`** (also in `G-OPTICALS-Setup-1.0.0.exe.sha256.txt`) |
| Contents verified | Both fixes plus `module_access.py`, byte-identical to the source. PostgreSQL **17.10** (initdb, pg_ctl, postgres, pg_dump, pg_restore). **148/148 migrations**. Bundled guides incl. the updated troubleshooting guide. |
| Excluded | 0 `.env*` files, 0 database dumps. `payload_guard`: 0 forbidden files, no secret values. Frontend bundle has no external hosts. |
| Security | Microsoft Defender custom scan: **no threats**. Not code-signed (SmartScreen will warn). No multi-engine scan: uploading would publish the binary. |
| Previous builds | Kept in `windows\out\superseded-installers\` as `.do-not-run`: `DF494236` (before fixes A/B) and `1ACEFB53` (stale). |
| Supported | Windows 10 22H2 (build 19045+) and Windows 11, x64 only |

## 6. LAN status

- **Design:**
  - The LAN Server runs nginx on `0.0.0.0:8443` plus `[::1]` loopback. PostgreSQL (5544) and the app (8001) stay on loopback, so the database is **never** reachable from the network.
  - The firewall rule opens only the HTTPS port.
  - A workstation install with `--server` and `--code` only pairs: it never creates a database, company or admin.
- **Automated evidence:** pairing with the pinned CA, rogue CA refused, LAN exposure checks (above).
- **Missing:** a real second PC. Not verified: name resolution across the LAN, Private vs Public network profile, firewall on a real router, latency with several users. One open question for that test: if a workstation resolves the server's name to an IPv6 address first, it may see the same per-connection delay as fix B. Measure it during the LAN test (§7 step C).

## 7. What is missing, and the shortest safe procedure

**Missing:** a clean Windows PC. This PC is Windows 11 **Home**, so it has no Hyper-V and no Windows Sandbox. No VMware or VirtualBox is installed. With 7.2 GB RAM (one stick detected), it cannot host a 4 GB Windows guest. A spare PC or laptop is the practical option.

**A. Upgrade + restart test on this PC** (about 20 minutes; it changes only the existing G OPTICALS test install; data is kept)
1. `Get-FileHash D:\G OPTICALS\windows\out\installer\G-OPTICALS-Setup-1.0.0.exe`: it must equal `AC9551B3…E4D0`.
2. Right-click → Run as administrator. Setup detects the existing install (`install.complete`) and runs `update apply`:
   - a verified pre-update backup;
   - migrations (this applies `common 0012`, which the 11:55 install lacks);
   - the new nginx config with `[::1]`;
   - a health gate, with **automatic rollback** if anything fails.

   Same version number, so the log notes "same version: repair only", but every step runs.
3. Open G OPTICALS, sign in, create a product, a customer and a bill, and print or preview it.
4. Restart Windows. Open G OPTICALS without starting anything by hand. The three records must still be there.
5. Send me `C:\ProgramData\G-TRADE\logs\install\` and `logs\update\`.

→ If this passes, **Windows Installer** becomes GO.

**B. Clean Standalone test** (spare PC or laptop with nothing you need on it, Windows 10 22H2+/11 x64, ≥8 GB RAM): follow `G_OPTICALS_CUSTOMER_INSTALLATION_GUIDE.md` steps 1–13 exactly.

→ If this passes, **Customer Standalone** becomes GO.

**C. LAN test** (needs the PC from B as the server plus one more PC on the same router):
1. Install LAN Server on PC 1. Install LAN Workstation on PC 2 with the pairing code.
2. Create a bill on PC 2 and see it on PC 1.
3. Restart PC 1, then check that PC 2 reconnects.

→ If this passes, **LAN** becomes GO.

## 8. Known limitations

- Not code-signed. There is no product icon yet. The EULA is a draft. Licence keys are development keys.
- The installer collects company, branch and administrator only. Logo, currency, country, tax and language are set after the first login (Settings → Store & Clinic Profile, Business & Localization). The default currency is INR.
- Internal names still read G-TRADE: services, `C:\ProgramData\G-TRADE`, program folder. Only the display name is G OPTICALS.
- **Installs made before this build** (including the owner's 11:55 test install) may show "Main Company / Head Office": rename both in Settings (see the troubleshooting guide). Updating with this build adds the `[::1]` listener but does not rename existing companies, by design.
- Printer layouts were not tested on a real receipt or label printer.
