# G-TRADE ERP — Windows Compatibility Report

**Date:** 2026-11-10 · **Applies to:** the proposed local edition in `LOCAL_DEPLOYMENT_ARCHITECTURE.md`
(PostgreSQL 17, embedded Python 3.12, Waitress, nginx, WinSW, Electron thin client / Edge app mode).
Status of each row is **planned support**. It must be confirmed by the Phase 7 test matrix on clean VMs.

---

## 1. Compatibility matrix

| Scenario | Status | Installed components | Minimum hardware | Recommended | Key notes |
|---|---|---|---|---|---|
| **Windows 11 — Single PC** | ✅ Supported (primary target) | PostgreSQL, App, nginx services · Server Manager · G-TRADE Desktop | 4-core x64, 8 GB RAM, SSD with 10 GB free | 16 GB RAM, NVMe | Smart App Control on clean installs blocks unsigned apps, so **signing is mandatory**. |
| **Windows 11 — LAN Server** | ✅ Supported (recommended server OS) | As Single PC, plus binding to all adapters and a firewall rule | 4-core, 8 GB, SSD with 20 GB free, **wired Ethernet** | 6–8 cores, 16 GB, a second disk/USB for backups, UPS | Disable sleep, set a DHCP reservation, use the Private network profile, and set Active Hours so updates don't reboot during trading. |
| **Windows 11 — LAN Client** | ✅ Supported | G-TRADE Desktop (or Edge shortcut) · local printer and scanner drivers | 2-core, 4 GB RAM | 8 GB RAM | Nothing server-side is installed. Wi-Fi is acceptable. Idempotent writes protect against retries. |
| **Windows 10 22H2 — Single PC** | ⚠️ Supported, best effort | Same as Win11 Single PC | 4-core, 8 GB, SSD | — | Windows 10 left mainstream support on **2025-10-14**. The consumer ESU year has now also ended, so many shop PCs will be unpatched. We support it but recommend upgrading. Builds older than **19045 (22H2)** are blocked by the installer. |
| **Windows 10 22H2 — LAN Server** | ⚠️ Supported, not recommended | Same as Win11 LAN Server | 4-core, 8 GB, SSD, wired | — | An unpatched OS holding all shop data is a security risk. The installer shows a one-time warning recommending Win11 for the server role. |
| **Windows 10 22H2 — LAN Client** | ✅ Supported | Same as Win11 LAN Client | 2-core, 4 GB | — | A client holds no data, so the end-of-support risk is lower. The Edge fallback also works. |

### Not supported (installer blocks or warns)

| Configuration | Reason |
|---|---|
| Windows 7 / 8 / 8.1, Windows 10 before 22H2 | Python 3.12 / current Electron / PostgreSQL 17 baseline and no security updates |
| 32-bit Windows (x86) | PostgreSQL 17 and our runtime are x64 only |
| Windows 10/11 **S mode** | Only Store apps can run |
| Windows on **ARM64** | x64 emulation may work but is untested. Planned as a later "experimental" row. |
| Windows Server 2016/2019/2022/2025 | Expected to work (same components) but **not in the v1 test matrix**. Can be added on demand. |
| Mixed mode: a LAN Server with SQLite | Refused by design (concurrency safety) |

---

## 2. Component support baseline

| Component | Version (planned) | Windows support | Licence (redistribution) |
|---|---|---|---|
| PostgreSQL | 17.x x64 | Windows 10+ / Server 2016+ (x64) | PostgreSQL License: permissive |
| Python (embedded) | 3.12.x x64 (matches `.python-version` 3.12.5) | Windows 8.1+ (we require 10 22H2+) | PSF: permissive |
| Django / DRF / deps | as in `backend/requirements.txt` | Pure Python + wheels (psycopg2-binary, Pillow, pandas: win_amd64 wheels available) | BSD/MIT-style |
| `tzdata` (PyPI) | latest | Required on Windows for `zoneinfo` (Windows has no IANA tz database). Pulled in by Django on win32 and must be vendored. | Apache-2.0 |
| Waitress | 3.x | Pure Python | ZPL 2.1 |
| nginx | stable 1.2x Windows build | Works on Windows. Official docs note `select()`-based, limited performance (fine at shop scale). | BSD-2 |
| WinSW | 2.x / 3.x | .NET-based. Win10/11 include .NET Framework 4.8. | MIT |
| Electron (thin client) | a currently-supported major at build time (today's repo pins **33**, which must be upgraded) | Windows 10+ x64 | MIT (+ Chromium notices) |
| Microsoft Edge (fallback client) | inbox | Windows 10 & 11 | — |
| VC++ 2015–2022 x64 runtime | latest | Required by PostgreSQL, Python wheels and nginx | Microsoft redistributable |

---

## 3. Windows-specific behaviours to handle

| Area | Windows 11 | Windows 10 22H2 | Handling |
|---|---|---|---|
| Unsigned installer | SmartScreen warning. **Smart App Control (clean installs, if On) blocks it outright.** | SmartScreen warning | Authenticode-sign the installer, every `.exe`/`.dll` we build, and the PowerShell helpers. |
| Antivirus / Defender | Frozen-Python heuristics | Same | No PyInstaller onefile, no UPX. Signed binaries. Defender exclusion for `ProgramData\G-TRADE\pgsql\data` is **optional** (performance), never required. |
| Firewall | Prompt suppressed by an explicit rule | Same | `netsh advfirewall` / `New-NetFirewallRule` with **Private** profile only, app port only. Warn if the active network is Public. |
| Network profile | New Wi-Fi defaults to Public | Same | The wizard detects this and links to the settings page. |
| Power / sleep | Modern Standby laptops sleep aggressively | Same | Server role: power plan with no sleep or hibernate on AC. Single-PC role: a sleep only pauses the shop; the scheduler catches up missed backups once. |
| Windows Update reboots | Active Hours (max 18 h) | Same | Set Active Hours to shop hours on server install. Services restart automatically after reboot. |
| Fast Startup | Hybrid shutdown keeps services' state odd at times | Same | Services are set to Automatic (Delayed for App/Web) and Postgres recovers cleanly. Document disabling Fast Startup on the server. |
| Long paths | MAX_PATH 260 by default | Same | Install root is short (`C:\Program Files\G-TRADE ERP`). Vendored site-packages are checked against the 260 limit at build time. |
| Locale / code page | Mixed | Mixed | Postgres `UTF8` encoding, `initdb --locale=C` (or ICU) to avoid Windows collation surprises. Python runs with `PYTHONUTF8=1`. |
| Clock | NTP on by default | Same | `/api/health/` reports skew. TOTP 2FA needs ±30 s. |
| User accounts | Standard users can run the client | Same | Install requires admin once. Daily use does not. Services run as NetworkService / a virtual account. |
| Display scaling | 125–150% common on laptops | Same | The SPA is responsive. The Electron client respects OS scaling. Minimum window 1024×600 (existing). |
| Printing | Print spooler and drivers per client | Same | See architecture §8. Silent print is Electron only. |
| Scanners | HID keyboard | HID keyboard | Scanner keyboard layout must match the OS layout (US). Enter suffix. |

---

## 4. Network requirements (LAN)

| Item | Requirement |
|---|---|
| Topology | Clients and server on the same subnet (flat shop LAN). Routed/VPN access is possible by IP but not in v1 scope. |
| Ports | Inbound **TCP 8080** (configurable) on the server only. Postgres 5544 and Waitress 8001 are **loopback only**. |
| Name resolution | Server hostname (NetBIOS/LLMNR), with the IP saved as fallback by the client wizard. DHCP reservation recommended. |
| Bandwidth | 100 Mbit wired or decent Wi-Fi. Typical API payloads are small, and the first load of the SPA is about 2–4 MB (cached afterwards). |
| Clients | Designed for ≤ 25 concurrent clients on a desktop-class server. (The Windows client-OS limit of 20 inbound connections applies to SMB file sharing and IIS, not to our nginx service, but desktop hardware is still the practical ceiling.) |
| Internet | **Not required** for operation once B2 (CDN `xlsx`) is fixed. Needed only for WhatsApp messaging, Windows/NTP updates and future online licence checks. |
| Security | Plain HTTP on the private LAN in v1. Optional local-CA HTTPS later. |

---

## 5. Test matrix (to execute in Phase 7)

For each OS image — Win11 24H2/25H2 Home & Pro, Win10 22H2 Home & Pro (clean VMs, plus one real low-spec PC each):

1. Fresh install in every mode (Single, Server, Client) → wizard → health check → first sale, print, scan.
2. Install while a third-party PostgreSQL already uses 5432 → no conflict, theirs untouched.
3. Reboot with no user logged on → a client can still connect (LAN server).
4. Upgrade N-1 → N with real data → data intact, migrations applied, a pre-update dump exists.
5. Forced migration failure → automatic rollback → app back on N-1 with data intact.
6. Uninstall (default) → data folder remains. Reinstall → "Use existing data" → everything is back.
7. Restore from L2 dump when the app will not start.
8. Network: server IP change, Public profile, server offline → clients show the offline banner and recover.
9. Smart App Control On (Win11 clean) → the signed installer runs.
10. Printers: one 80 mm thermal, one A4, one label printer (silent and dialog paths). Scanner in HID mode.
