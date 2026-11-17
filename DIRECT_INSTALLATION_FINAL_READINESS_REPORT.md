# G-TRADE ERP 1.0.0: Direct Installation Final Readiness Report

**Date:** 2026-11-12
**PC:** LAPTOP-M79GGMU7. Windows 11 Home 10.0.26200, Ryzen 5 7535HS (6 cores / 12 threads), 7.21 GB usable RAM.
**Supersedes:** `DIRECT_INSTALLATION_READINESS_REPORT.md`, which covered the `92B5EE8F…` build.

**Scope.** Nothing was installed, and the installer was never executed. No PostgreSQL, MySQL or pgAgent service was stopped, reconfigured or connected to. `G OPTICALS` was not touched. No Windows setting, firewall rule, certificate store or environment variable was changed. Neon, Render and Vercel were not contacted. Nothing was committed or pushed.

---

## 0. Summary

| Question | Answer |
|---|---|
| Was the reported `92B5EE8F…` installer genuine? | **Yes.** The hash and size matched exactly, and it was built from the current source. |
| Why did a browser show "This domain is for use in documentation examples"? | The **desktop app's automated smoke test** navigated to `https://example.com/` to prove that navigation is blocked. The block worked, but the guard then passed the URL to Windows, which opened it in the real browser. The **installer has no browser launch at all.** |
| `.env` / secret fix | **Holds.** No env files, keys or developer secret values are in the stage, in `win-unpacked` or in the extracted `.exe`. |
| Second defect found during review | A failed first install **could not be resumed** through the wizard. Re-running it skipped the company/administrator page and ran an "update" instead. **Fixed.** |
| New installer | **`A92A8EBCAE1F07B02631480BFAA452B9C5C8B9B72D035A17B15E39DB91F2F9AE`** (205,918,872 bytes). Use only this one. |
| Can it coexist with the dev environment? | **Yes.** It uses its own database cluster on 127.0.0.1:5544 and its own services, folders and ports. All three ports are free, and nothing is shared with PG17, PG18, MySQL or `G OPTICALS`. |
| Can it be installed on this PC **right now**? | **Not in the current memory state.** About 1 GB was available, with paging bursts up to about 2,100 pages/sec. **GO after a restart with apps closed**, once Available memory is at least 2 GB (§5). |

---

## 1. Installer verification

| Check | Result |
|---|---|
| File | `windows\out\installer\G-TRADE-Setup-1.0.0.exe` |
| Reported build `92B5EE8F…` | SHA-256 `92B5EE8F5FD4C2BB6FE1B09A0B39C88AD453573ABD8EFCF66A74B4E478B1E9A8`, 205,917,942 bytes, 21:02:50. **Matched the report exactly.** |
| Signature | `NotSigned` (expected; code signing is release gate A10) |
| Built from current source? | **Yes.** All 503 backend and engine source files in the stage manifest matched the working tree byte for byte. All 10,625 manifest entries matched the files inside the `.exe`. The Electron archive matched `windows/desktop` (only `package.json` differs, because electron-builder strips its build section). The only file edited after staging was a test. |
| Withdrawn `E0B3CB64…` build | **Not present anywhere.** It was overwritten in place. A search of Downloads, Desktop, Documents, OneDrive, `D:\` and `C:\Temp` found only the current file. |
| **Current build (after the fixes below)** | **SHA-256 `A92A8EBCAE1F07B02631480BFAA452B9C5C8B9B72D035A17B15E39DB91F2F9AE`**, 205,918,872 bytes, built 2026-11-12 22:15:02. Unsigned. |

Superseded builds, **do not use**:
- `84223EE8…` (21:48): intermediate build of this session, desktop fix only.
- `92B5EE8F…`: not unsafe, but it carries the example.com smoke-test behaviour (§2) and the install-resume defect (§6.1).
- `E0B3CB64…`: withdrawn because it shipped `backend/.env`.

---

## 2. Example-domain root cause

| Item | Finding |
|---|---|
| URL opened | `https://example.com/` (IANA's reserved documentation domain; its page reads "This domain is for use in documentation examples") |
| Launched by | `windows/desktop/main.js` line 294 (old), inside `runSmoke()`: `location.href = 'https://example.com/'`. The navigation guard at line 64 (`will-navigate`) correctly blocked the in-app navigation, then called `shell.openExternal(url)` for any `https:` URL. That opened the user's default browser. |
| When it happens | **Only when `G-TRADE.exe` runs with `--smoke-test=…`**, which only the automated e2e test `windows/tests/test_desktop_install_e2e.py` does (3 smoke runs per test run). Those runs happened at 15:05, 18:03 and **21:11–21:14**, right after the 21:02 rebuild. That is when you were about to launch the installer. |
| Installer startup / installation? | **No.** `installer.nsh` contains no URL. Its only `ExecShell` opens the local `connection-sheet.txt`, and only in LAN Server mode. `runAfterFinish` is `false`, so the app is not started after setup. The NSIS pages never start `G-TRADE.exe`. |
| Intentional or accidental? | The **probe** was intentional (it proves server content cannot navigate the window away). Sending it to the real browser was **accidental**. |
| Effect on the application | **None on installation or normal use.** It only happens in smoke-test mode. In normal use, links that pages open (for example WhatsApp or Maps) still open in the browser, as designed. |

Confirmation you can do: your browser history should show `example.com` visits at about 15:05, 18:03 and 21:11–21:14 on 2026-11-12. If a browser ever opens when you **only** double-click the installer, with no tests running, stop and report it, because that would contradict this finding.

**Fix:**
- `lib/security.js` adds `createExternalOpener()`. It is now the only route to the OS browser: it allows only https and mailto, and in smoke mode it opens nothing (requests are only recorded).
- `main.js` uses it at both call sites.
- The probe URL is now `https://gtrade-navigation-probe.invalid/`. The `.invalid` top-level domain is reserved by RFC 2606 and can never resolve, so even a future regression could not load a real site.
- The smoke report now includes `externalOpenSuppressed`.

**Regression tests:**
- `desktop/test/desktop.test.js` gains 3 tests: the opener's behaviour; no example.com/.org/.net in shipped desktop code; `shell.openExternal` called only through the opener.
- `windows/tests/test_placeholder_urls.py` (3 tests) scans the desktop code, `installer/`, `gtrade_ctl/`, `gtrade_server/` and `templates/`, checks that the installer has no URL `ExecShell`, and checks that `runAfterFinish` is false.
- The e2e test now asserts `externalOpenSuppressed`.

---

## 3. `.env` and secret verification

| Check | Result |
|---|---|
| `payload_guard.py` on `windows/out/stage` | **OK.** 0 forbidden files, 0 of 4 developer secret values. |
| On `win-unpacked` | **OK** |
| On the contents **extracted from the `.exe`** (7-Zip → `app-64.7z`, 10,645 files, identical file list to `win-unpacked`) | **OK**, for both the `92B5EE8F…` build and the new build |
| Independent wider scan of the extracted `.exe` (not limited to the guard's 4 values) | No `.env*` files anywhere. No Neon password prefixes. No private keys outside `cryptography`'s own source code. |
| Neon host names found | Only in two backend **unit-test fixtures**, with user `u`, host `ep-x…` and a **1-character placeholder password**. A check that printed only true/false confirmed it matches no real value in any developer env file. |
| Credential URLs found | `scripts/p2_migration_rehearsal.py` builds a URL from variables at run time. There is no literal secret. |
| Render / Vercel names | Only in cloud `settings.py` comments and CORS patterns. `settings_local.py` is used on Windows. |
| Logs and manifests | The stage manifest contains paths and hashes only. Install step logs are redacted (tested in `test_runtime`), and the e2e test asserts the admin password is absent from install logs. |
| Credential rotation | **Not needed for the `92B5EE8F…` or new builds.** The **Neon `neondb_owner` password** must be rotated **only if the withdrawn `E0B3CB64…` installer, or the `windows\out` folder from 18:31–21:02, ever left this PC** (USB, chat, cloud drive, e-mail). That build contained `backend/.env` with the hosted `DATABASE_URL`. I did not contact Neon or rotate anything. |

Hygiene note, not a secret: the payload still ships backend unit tests and cloud-only scripts such as `p2_migration_rehearsal.py`. They are harmless, but excluding them would shrink the payload. This is left for a later release decision.

---

## 4. Database and service compatibility (read-only inspection)

| Existing item | State | G-TRADE interaction |
|---|---|---|
| `postgresql-x64-17` | Running/Auto, listens on 0.0.0.0/:: **5432** | **None.** G-TRADE ships its own PostgreSQL 17.10 binaries and never uses the system `psql`/`pg_ctl` or the EDB registry. |
| `postgresql-x64-18` | Running/Auto, **9961** | None |
| `pgagent-pg17` | Running/Auto (→ 5432) | None |
| `MySQL80` | Running/Auto, **3306 / 33060** | None |
| PostgreSQL 14 folder | `C:\Program Files\PostgreSQL\14`, no service | None |
| `G OPTICALS` dev database | On the existing PG cluster | **Never connected to.** The local edition's settings refuse `DATABASE_URL`, force a loopback host, and default to port 5544 (tested). |
| GreenSol "GTRADE" (unrelated product) | `D:\Program Files (x86)\GreenSol Technologies LLP\GTRADE\`, Start-menu `GreenSol…\GTRADE\G-TRADE.lnk` | Different name ("G-TRADE ERP"), install folder, NSIS GUID and shortcut. **Uninstall "G-TRADE ERP" only.** |
| Ports **5544 / 8001 / 8443** | **Free** | Used by `GTrade-DB` / `GTrade-App` / `GTrade-Web`, **all bound to 127.0.0.1 in Standalone** |
| Services named `GTrade-*` | None exist | Created new; no name collision |
| `C:\ProgramData\G-TRADE`, `C:\Program Files\G-TRADE ERP`, `%APPDATA%\G-TRADE ERP` | **Do not exist** | Created new |
| Firewall rules / certificates mentioning G-TRADE | None | Standalone creates **no** firewall rule. The per-install CA is pinned inside the app and is **not** added to any Windows certificate store. |
| Environment variables `GTRADE*`, `DATABASE_URL`, `POSTGRES*`, `PG*`, `DJANGO*`, `ELECTRON*` (Machine/User) | **None** | The app service starts cleanly. A machine-wide `DATABASE_URL` would make it **refuse to start**, which is the safe failure. |
| Network profile | "Kerala Vision": **Public** | Fine for Standalone, which is loopback only. Unchanged pre-existing note: PG17 and PG18 listen on all interfaces on a Public network. |

**Collision refusals (tested):**
- Preflight blocks any busy port. This is a new test, `test_coexistence`.
- A data folder holding a non-G-TRADE cluster is refused and left untouched (`test_postgres`).
- An existing cluster is never re-initialised.
- The mode cannot be changed on reinstall.
- A data folder inside Program Files or the install folder is refused.

---

## 5. RAM and performance

| Measurement | Start of session | After build/tests |
|---|---|---|
| Available memory | 0.74 GB | 1.05 GB |
| Hard page faults (pages/sec, 3 × 2 s) | ~175 | **~2,100** (bursts) |
| Committed memory | 77.5 % of a 24.3 GB limit | 80.2 % |
| Installed modules | **One 8 GB DDR5-4800 module** ("Bottom – Slot 1"). The second module is **not detected**. | |
| CPU / disk | 9 % load, 6C/12T. C: 57.9 GB free, D: 89.2 GB free. | Fine |

What G-TRADE adds when running:
- PostgreSQL: about 100–250 MB actually used for a small database. Its configuration reserves `shared_buffers` = 25 % of RAM (~1.8 GB), but Windows only uses that memory as it is touched.
- Waitress/Django: about 150–300 MB.
- nginx: about 10 MB.
- Electron window: about 250–350 MB.
- **Total: roughly 0.6–0.9 GB.**
- During setup, migrations and `collectstatic` briefly add about 300 MB more.

**Verdict:**
- **Feasible for installation and basic testing, but only from a clean start.**
- Don't install in today's state: at ~1 GB available with paging bursts, the 120-second health check at the end of setup could time out.
- Thanks to fix §6.1, such a failure is now recoverable by simply running setup again.

Recommendations:
1. **Restart Windows** before installing. This clears memory compression and leftover build/test processes.
2. Before installing, close **VS Code (including this Claude Code session), ChatGPT, WhatsApp, Phone Link, Chrome/Edge and Omen Command Center**. Leave PG17, PG18, MySQL and pgAgent **running**; they are not in the way and you have not approved stopping them.
3. Start setup only when Task Manager → Performance → Memory shows **Available ≥ 2 GB**.
4. **A separate Windows user does not help.** The install is per-machine (services, Program Files and ProgramData are shared), and a restart achieves the same memory clean-up.
5. **A RAM upgrade or another PC is not needed for this Standalone test.** They are needed for daily use of this PC as a shop server while it also runs two other PostgreSQL servers and MySQL, and for the LAN Server/Workstation and clean-VM release gates. Have the missing second module checked (re-seat or replace). I made no BIOS or VM changes.

---

## 6. Installer configuration review (Standalone, default folder, `C:\ProgramData\G-TRADE`, port 8443, fake company)

| Area | Behaviour (from `installer.nsh` + `gtrade_ctl`) | Status |
|---|---|---|
| Program folder | `C:\Program Files\G-TRADE ERP` (perMachine, elevation via UAC) | OK |
| Data folder | `C:\ProgramData\G-TRADE`. 57.9 GB free on C:. Program Files and the install folder are refused. | OK. Don't put it inside `D:\G OPTICALS`: the check does not block the repo path. |
| Database isolation | Fresh `initdb` in `…\pgsql\data`. `listen_addresses='localhost'`. `pg_hba` allows scram-sha-256 from 127.0.0.1/::1 only. Least-privilege app role. Port 5544. A foreign folder is refused. | OK, tested |
| Services | `GTrade-DB` (pg_ctl register), `GTrade-App` and `GTrade-Web` (WinSW). All run as NETWORK SERVICE, Automatic, restart on failure. | Logic tested. **Real registration not yet run on any PC.** |
| HTTPS | Per-install CA + server certificate in `config\tls`. nginx on **127.0.0.1:8443** (Standalone). No plain HTTP listener. | OK, tested |
| Firewall | **None in Standalone.** LAN Server only: one rule, Private profile, local subnet. | OK |
| Initial administrator | Wizard page → temporary answers file in the installer's temp folder. It is deleted (and shredded by the engine) after use. Password: 10+ characters on the page, then Django's validators during install (no common, all-number or username-like passwords). | OK. **Fixed in 6.1:** a rejection is now resumable. |
| DPAPI | `secrets.dpapi`: machine-scope DPAPI + application entropy. No plaintext on disk. Tampering is rejected. Existing secrets are never overwritten. | OK, tested |
| ACLs | `config`: SYSTEM + Administrators full, service read, **no Users**. `backups`: no Users. | OK (applied by the real install) |
| Repair | `gtrade-ctl repair`: re-applies configuration, services and certificates. Never touches business data. Refuses if migrations are pending. | OK |
| Upgrade | Mode locked. The previous app is copied to `rollback\`. A verified pre-update backup is taken, then migrate and health check, with automatic rollback on failure. | OK, e2e tested |
| Uninstall | **Data kept by default.** Deletion requires ticking the box **and** typing the exact company name. A verified final backup goes to the Desktop first. Silent uninstall always keeps data. | OK, e2e tested |
| Licence | 30-day evaluation (1 company, 1 branch, 2 users) | OK for a test |

### 6.1 Defect fixed: a failed first install could not be resumed through the wizard

- **Cause.** The engine's first step (`configure`) writes `config\install.mode`. The wizard treated **any** `install.mode` as an existing installation.
- **Effect.** If a fresh install failed later (for example a password rejected at `create-org`, or a health-check timeout on this low-memory PC), the setup message said to run setup again. Doing so:
  - skipped the mode, data-folder and **company/administrator** pages;
  - ran `update apply` instead of the install.
- **Outcome.** An installation **with no administrator** and a misleading "data restored" message.
- **Fix.**
  - `gtrade_ctl` writes `config\install.complete` only after **every** install step succeeds.
  - `installer.nsh` treats a server installation as an upgrade only when that file exists.
  - Workstations are unchanged, because their `install.mode` is written only after pairing succeeds.
- **Result.** Re-running setup after a failure shows the full wizard, and `gtrade-ctl install` resumes. It keeps the cluster and secrets, skips completed migrations, and creates the administrator if it is missing.
- **Tests.**
  - `windows/tests/test_install_resume.py` (3): no marker after a failure, marker after success, and the wizard's upgrade check requires the marker.
  - The e2e test asserts the marker after a real install.
  - Limit: the NSIS side was compiled into the new installer without errors, but the wizard pages have not been clicked through yet. It is a 6-line LogicLib change, checked statically by the test above.

---

## 7. Test results (this session, on this PC, non-elevated)

| Suite | Result |
|---|---|
| Desktop unit tests (`node --test`), including 3 new regression tests | **12 / 12 OK** |
| `test_placeholder_urls` (new) | **3 / 3 OK** |
| `test_coexistence` (new): busy-port refusal, default ports, `DATABASE_URL` stripped/refused | **5 / 5 OK** |
| `test_install_resume` (new) | **3 / 3 OK** |
| `test_runtime`: DPAPI, TLS, nginx, service XML, firewall plan, data-root refusal, redaction | **23 / 23 OK** |
| `test_payload_guard` | **7 / 7 OK** |
| `test_postgres` (`GTRADE_E2E=1`): real disposable clusters, foreign folder refused, loopback-only, no re-init | **10 / 10 OK** |
| `test_desktop_install_e2e` (`GTRADE_E2E=1`): real engine install + **real Electron**: pinned TLS, sandbox, blocked navigation **with external open suppressed**, real login, rogue CA refused, workstation pairing | **4 / 4 OK** (run before and after the re-stage) |
| `test_backup_update_e2e` + `test_e2e_stack` (`GTRADE_E2E=1`): backup/verify/tamper, restore, update, failed-migration rollback, unhealthy-version rollback, downgrade refused, retention, uninstall keeps data | **20 / 20 OK** (10 backup/update + 10 stack), on the re-staged payload |
| `payload_guard` on stage / win-unpacked / extracted `.exe` | **OK / OK / OK** |

**Not performed, and not claimed:**
- The real elevated `.exe` run (`elevated_smoke.ps1`): Windows service registration, UAC, ACLs on real ProgramData, and the NSIS pages themselves.
- That script is written for a clean VM and **force-stops every `python` process**, so it must not run on this dev PC.
- Your Standalone install would be the **first real elevated run** of this installer on any machine (release gate A8 is still open).

---

## 8. Files changed

| File | Change |
|---|---|
| `windows/desktop/lib/security.js` | `createExternalOpener()`: the single OS-browser path; smoke mode opens nothing |
| `windows/desktop/main.js` | Uses the opener at both call sites. Probe URL → `https://gtrade-navigation-probe.invalid/`. Smoke report gains `externalOpenSuppressed`. |
| `windows/desktop/test/desktop.test.js` | +3 regression tests |
| `windows/gtrade_ctl/paths.py` | `Layout.install_complete` |
| `windows/gtrade_ctl/installer_cmds.py` | Writes `install.complete` after every step has succeeded |
| `windows/installer/installer.nsh` | `gtReadMode`: a server upgrade requires `install.complete` |
| `windows/tests/test_placeholder_urls.py` | New |
| `windows/tests/test_coexistence.py` | New |
| `windows/tests/test_install_resume.py` | New |
| `windows/tests/test_desktop_install_e2e.py` | Asserts `externalOpenSuppressed` and `install.complete` |
| `PHASE_9_FINAL_RELEASE_REPORT.md`, `DIRECT_INSTALLATION_READINESS_REPORT.md`, `COMMERCIAL_RELEASE_CHECKLIST.md` | New hash, superseded-build notes, new checklist step 5b |
| Build outputs (git-ignored) | `windows/out/stage` (app + manifest re-staged), `windows/out/installer/*` (rebuilt). Logs: `stage_fix.log`, `installer_fix_rebuild*.log`, `fix_tests.*.log`. |

Two rebuilds were made in this session, each for a code change in shipped files. The first (`84223EE8…`, desktop fix) was superseded by the second (desktop fix + resume fix).

## 9. New installer

| Item | Value |
|---|---|
| File | `D:\G OPTICALS\windows\out\installer\G-TRADE-Setup-1.0.0.exe` |
| **SHA-256** | **`A92A8EBCAE1F07B02631480BFAA452B9C5C8B9B72D035A17B15E39DB91F2F9AE`** |
| Size / built | 205,918,872 bytes / 2026-11-12 22:15:02 |
| Signature | Not signed |
| Secret scan | `payload_guard` OK on win-unpacked and on the extracted `.exe` |
| Provenance | Desktop archive = current `windows/desktop` source. Server payload = re-staged manifest (all entries match the `.exe`). |

---

## 10. Remaining risks

| ID | Risk | Severity | Mitigation |
|---|---|---|---|
| R1 | Low memory: one 8 GB module, about 1 GB available while in use | **Medium** | Restart, close apps, start only when Available ≥ 2 GB. A failed health check is now resumable (§6.1). |
| R2 | First-ever elevated run (services, ACLs, NSIS pages untested for real) | Medium | Keep the install log (`C:\ProgramData\G-TRADE\logs\install`). Rollback in §11.4 is clean. Clean-VM gate A8 is still required before release. |
| R3 | Unsigned installer and binaries (SmartScreen / Smart App Control) | Low here, because the hash is verified | Check the hash first. Signing remains gate A10. |
| R4 | Services auto-start at every boot and take RAM until uninstalled | Low | Uninstall after testing, or (your decision) set the three `GTrade-*` services to Manual |
| R5 | Choosing the wrong product when uninstalling (GreenSol "GTRADE") | Low | Uninstall **"G-TRADE ERP"** only |
| R6 | Neon password exposure from the withdrawn `E0B3CB64…` build, if it ever left this PC | **High if it did** | Rotate the Neon owner password (your action) |
| R7 | A data folder inside the repo is not blocked | Low | Keep `C:\ProgramData\G-TRADE` |
| R8 | Launching `G-TRADE.exe` from a VS Code terminal (`ELECTRON_RUN_AS_NODE` set there) runs it as Node | Low | Start it from the Start menu or desktop shortcut |
| R9 | Pre-existing: PG17 and PG18 listen on all interfaces on a Public network | Not G-TRADE | Your decision; unchanged |

---

## 11. Exact installation steps (only after you approve)

### 11.1 Before installing
1. Decide on R6: if the withdrawn installer or `windows\out` was ever shared, rotate the Neon password (separately, yourself).
2. *(Recommended, your choice)* Create a System Restore point: Start → "Create a restore point" → **Create…** → name it "Before G-TRADE test" → **Create**.
3. *(Optional)* Back up the dev database yourself with `pg_dump` on port 5432. G-TRADE never touches it; this is only extra safety.
4. **Restart Windows.** Then close VS Code/Claude Code, ChatGPT, WhatsApp, Phone Link, browsers and Omen Command Center.
5. Open Task Manager → Performance → Memory. Continue only if **Available ≥ 2 GB**.
6. In PowerShell, check the hash. The output must be `A92A8EBCAE1F07B02631480BFAA452B9C5C8B9B72D035A17B15E39DB91F2F9AE`:
   ```powershell
   (Get-FileHash 'D:\G OPTICALS\windows\out\installer\G-TRADE-Setup-1.0.0.exe' -Algorithm SHA256).Hash
   ```
   If it differs, **stop**.

### 11.2 Installer: what to click
1. In **File Explorer**, open `D:\G OPTICALS\windows\out\installer` and **double-click `G-TRADE-Setup-1.0.0.exe`**. Do not start it from a VS Code terminal.
2. If **"Windows protected your PC"** (SmartScreen) appears: click **More info**, then **Run anyway**.
3. At **User Account Control** ("unknown publisher"): click **Yes**.
4. **License Agreement**: click **I Agree**.
5. **Choose Install Location**: keep `C:\Program Files\G-TRADE ERP`, then click the button at the bottom right. It may be labelled **Next** or **Install**; either way the G-TRADE pages follow, and nothing is installed yet.
6. **"How will this computer be used?"**: **Standalone** is preselected. Keep it and click **Next**.
7. **Business data folder / Secure (HTTPS) port**: keep **`C:\ProgramData\G-TRADE`** and **`8443`**, then click **Next**.
8. **Company / administrator**:
   - Company name: `Test Opticals Demo`. First branch: `Test Branch`.
   - Administrator full name: `Test Admin`. E-mail: leave **blank** (it is optional).
   - User name: e.g. `testadmin`.
   - Password: **12 or more characters**, mixed letters, digits and a symbol, **not similar to the user name**. Type it twice, and write the user name and password down.
   - Click **Install** (or **Next**).
9. Installation runs. Click **Show details** if you want to watch. It can take **5–15 minutes** on this PC. Don't use the PC heavily meanwhile. **No browser should open.**
10. On the final page, click **Finish**. The app does not start automatically.

**If setup shows an error:**
- Note the message and click **OK**.
- Don't delete anything. Make memory available if that was the cause.
- **Run the same setup again.** Thanks to §6.1 it shows all pages again and resumes; re-enter the same company and administrator details.
- Logs: `C:\ProgramData\G-TRADE\logs\install\`.

### 11.3 After installing: checks
1. Start **G-TRADE ERP** from the desktop or Start menu. **Not** the GreenSol "G-TRADE" shortcut. Sign in with the test administrator.
2. In an **Administrator** PowerShell:
   ```powershell
   Get-Service GTrade-*, postgresql-x64-17, postgresql-x64-18, MySQL80, pgagent-pg17 | ft Name,Status,StartType
   Get-NetTCPConnection -State Listen -LocalPort 5544,8001,8443,5432,9961,3306 | ft LocalAddress,LocalPort
   $r = 'C:\Program Files\G-TRADE ERP\resources\server'
   & "$r\gtrade-ctl.cmd" health
   & "$r\gtrade-ctl.cmd" backup run
   & "$r\gtrade-ctl.cmd" backup list
   ```
   Expected results:
   - The three `GTrade-*` services are Running/Automatic, and the five existing services are **unchanged** (Running/Automatic).
   - 5544, 8001 and 8443 listen on **127.0.0.1 only**, and 5432, 9961 and 3306 are as before.
   - Health is OK and the backup is created.

### 11.4 Rolling back the test
1. Settings → Apps → Installed apps → **G-TRADE ERP** → **Uninstall**. Leave **"Also permanently delete ALL business data"** unticked, then confirm.
2. `Get-Service GTrade-*` should return nothing.
3. Once you no longer need the test data, delete `C:\ProgramData\G-TRADE` and `%APPDATA%\G-TRADE ERP`.
4. If anything else looks wrong, use the System Restore point.

---

## 12. Recommendation

| Item | Verdict |
|---|---|
| Installer `A92A8EBCAE1F07B02631480BFAA452B9C5C8B9B72D035A17B15E39DB91F2F9AE` (security, provenance, configuration) | **GO** |
| Coexistence with PG17 / PG18 / MySQL / pgAgent / `G OPTICALS` | **GO.** Fully isolated. |
| Installing on this PC **in its current memory state** | **NO-GO** |
| Installing on this PC **after a restart, with apps closed and Available ≥ 2 GB** | **GO (conditional)** for a Standalone functional test |
| Commercial release | **NO-GO** until the gates are done: code signing, elevated clean-VM runs (Windows 10/11), LAN test, production licence key, EULA/publisher |

**Nothing has been installed. Waiting for your explicit approval before any installation step.**
