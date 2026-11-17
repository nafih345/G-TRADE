# G-TRADE ERP — Commercial Windows Distribution Architecture

**Date:** 2026-11-11 · **Status:** Proposal for review. Nothing here is implemented. No source code,
migrations, database or git state was changed while preparing it.

**Document set**

| Document | Purpose |
|---|---|
| `COMMERCIAL_WINDOWS_ARCHITECTURE.md` (this) | Target architecture, decisions, how the parts fit, and the phased roadmap |
| `MULTI_CLIENT_ISOLATION_AUDIT.md` | Customer (tenant) isolation: what exists, gaps, local-DB strategy |
| `MULTI_COMPANY_BRANCH_AUDIT.md` | Company and branch isolation, module by module, and the multi-company design |
| `WINDOWS_INSTALLER_IMPLEMENTATION_PLAN.md` | One `G-TRADE-Setup.exe` (Electron Builder + NSIS) for all three modes |
| `LICENSE_MANAGEMENT_DESIGN.md` | Registration, activation, limits, verification |
| `WINDOWS_SECURITY_CHECKLIST.md` | Credentials, firewall, LAN HTTPS, signing, hardening |
| `BACKUP_UPDATE_RECOVERY_PLAN.md` | Backups, automatic updates, rollback, disaster recovery |

It supersedes parts of the 2026-11-10 Phase 1 set (`LOCAL_INSTALLATION_AUDIT.md`,
`LOCAL_DEPLOYMENT_ARCHITECTURE.md`, `WINDOWS_COMPATIBILITY_REPORT.md`, `IMPLEMENTATION_ROADMAP.md`).
Those findings (blockers **B1–B6**, risks **R1–R17**) still stand and are referenced, not repeated.
What changes: the installer is now **Electron Builder + NSIS** (was Inno Setup), the product is
**commercial** (licensing, auto-update, LAN HTTPS are in scope for v1), and the data model must
support **several companies per customer**.

---

## 1. Executive summary

The application logic is portable to Windows, and its **customer isolation is already strong**: every
business row carries a `tenant` FK and isolation is enforced in the ORM (`apps/common/tenancy.py`),
not just in views. Branch support exists and is partly enforced. Packaging, licensing and updates do
not exist yet.

The single largest gap is **multi-company**. Today `company.Company` is a per-tenant singleton
("the oldest Company row is the store profile", `apps/company/store_profile.py`). No business table
has a `company_id`. Chart of accounts, numbering sequences, products, customers, tax and every
settings singleton are tenant-wide.

**Key recommendation (decision A1):** model **each company as a tenant**, and add a new
**Organization** (the paying customer) above tenants. Company isolation then reuses the whole
existing, tested tenant-enforcement machinery: separate books, sequences, settings, uniques and
caches per company, with no `company_id` column added to ~100 models. Company switching becomes
"re-issue the token for another tenant the user is a member of".

```
Organization (customer / licence holder)            ← NEW
 └── Company  = common.Tenant  (books, masters, settings, sequences)   ← EXISTS
      └── Branch = company.Branch  (stock, documents, cash)            ← EXISTS
           └── Warehouse                                               ← EXISTS
```

## 2. Decision summary

| # | Concern | Decision | Rejected alternatives | Detail |
|---|---|---|---|---|
| A1 | Multi-company model | **Company = Tenant**, plus new `Organization` grouping tenants and `UserCompanyMembership` | `company_id` FK on every business model with a second ORM scoping layer (≈100 models, every unique/sequence/singleton/raw-SQL path to redo, high regression risk) | Company audit §5 |
| A2 | Customer isolation on local installs | **One customer per installation, one PostgreSQL database per installation.** Row-level tenant isolation stays on as defence in depth. | Database-per-company (breaks memberships, consolidated reports, one backup); shared multi-customer local server | Isolation audit §4 |
| A3 | Cloud | **Unchanged.** Each existing cloud tenant gets its own one-company Organization in a data migration. | — | Isolation audit §6 |
| A4 | Desktop shell | **Electron** (current supported major) as a thin client in every mode | Edge `--app` (kept as support fallback only) | §4 |
| A5 | Installer | **Electron Builder → NSIS** one-click-off ("assisted") installer with custom nsDialogs mode pages; one `G-TRADE-Setup-x.y.z.exe` | Inno Setup (Phase 1 choice, now replaced by requirement); MSI (only for future GPO customers) | Installer plan |
| A6 | Server runtime | Embedded **Python 3.12** + **Waitress** behind **nginx**, **PostgreSQL 17**, all as **WinSW** services | PyInstaller onefile (AV false positives, current spec broken); Docker | Phase 1 architecture §1–6 |
| A7 | LAN transport | **HTTPS only**, per-installation private CA on the server, certificate **pinned in Electron** via a pairing code | Plain HTTP (Phase 1 v1 plan, now rejected for commercial release); public CA (shops have no domain) | Security checklist §4 |
| A8 | Licensing | **Ed25519-signed licence file**, online activation with offline fallback, bound to the **server** machine; limits for companies, branches, users, modules | Unsigned key strings (current `config/license.json` demo); per-workstation activation | Licence design |
| A9 | Updates | `electron-updater` (generic provider). Internet → LAN server only; **workstations update from the LAN server**. Server updates are gated by a mandatory pre-update `pg_dump` and automatic rollback. | Updating each PC from the internet; silent unattended server migrations | Backup/update plan |
| A10 | Edition switch | `GTRADE_EDITION=local` (backend) and `VITE_EDITION=local` (frontend). Every change is additive and gated so the cloud build stays the same. | Forking the code base | — |

## 3. Deployment topologies

### 3.1 Standalone (single PC)

```
┌──────────────────────────── Shop PC ────────────────────────────┐
│  G-TRADE.exe (Electron) ──► https://127.0.0.1:8443 (pinned CA)  │
│                                  │                               │
│  GTrade-Web   nginx 127.0.0.1:8443  /→SPA  /api→:8001  /media   │
│  GTrade-App   Waitress+Django 127.0.0.1:8001  (+ scheduler)     │
│  GTrade-DB    PostgreSQL 17 127.0.0.1:5544                       │
│  GTrade-Agent licence + update + backup orchestrator (SYSTEM)   │
│  C:\ProgramData\G-TRADE\  pgsql\data media backups logs config  │
└──────────────────────────────────────────────────────────────────┘
```

Loopback-only, no firewall rule. TLS on loopback is optional (decision O3). It is
recommended so the client code path is the same in every mode.

### 3.2 LAN server + workstations

```
 Workstation 1 ─┐   https://GTRADE-SRV:8443        ┌──────── LAN Server PC ────────┐
 Workstation 2 ─┼─────────────────────────────────►│ nginx 0.0.0.0:8443 (TLS)      │
 Workstation n ─┘  Electron, CA pinned at pairing  │  firewall: TCP 8443, Private, │
  local printers / HID scanners                    │  remote = LocalSubnet         │
  update feed: https://GTRADE-SRV:8443/updates/    │  └► Waitress 127.0.0.1:8001   │
                                                   │      └► Postgres 127.0.0.1    │
                                                   │  GTrade-Agent (licence, update│
                                                   │   mirror, backups)            │
                                                   └───────────────────────────────┘
```

- Only nginx is reachable on the network. PostgreSQL and Waitress never are.
- The server can also be used as a till (it gets the Electron client too).
- Workstations hold no authoritative data and no licence. Users are counted on the server.

## 4. Components

| Component | Role | Ships in | Notes |
|---|---|---|---|
| **Electron client** (`G-TRADE.exe`) | Window, login UI, silent printing, cert pinning, server pairing, update UI | Every mode | Loads the SPA **from the server origin** (not `file://`), so the client and server versions cannot drift. `contextIsolation`, `sandbox`, no `nodeIntegration`. Re-uses `public/preload.js` `electronAPI.printInvoice`. |
| **React SPA** (`frontend/dist`) | UI | Server/Standalone (served by nginx) | Local build flag fixes B1 (cloud API resolver) and B2 (CDN `xlsx`). |
| **Django API** | All business logic and enforcement | Server/Standalone | `config.settings_local` overlay (Phase 1 §5). |
| **Waitress** | WSGI server | Server/Standalone | 16 threads, loopback bind. |
| **nginx** | TLS termination, static/media, `/updates/` mirror, proxy | Server/Standalone | Caddy is the documented fallback. |
| **PostgreSQL 17** | Data | Server/Standalone | Private cluster, port 5544, `scram-sha-256`, loopback. |
| **WinSW** | Service wrapper for App, Web, Agent | Server/Standalone | Postgres registers itself with `pg_ctl register`. |
| **GTrade-Agent** (new) | Runs as a service: licence heartbeat, update download/apply, backup copy (L2/L3), certificate renewal | Server/Standalone | A Python module run by the embedded runtime. It is the only component with internet access needs. |
| **`gtrade-ctl`** (new) | CLI engine used by the installer, agent and tray: `init-db`, `create-org`, `migrate`, `backup`, `restore`, `cert`, `license`, `firewall`, `diagnostics` | Server/Standalone | All logic testable without the installer. |
| **Server Manager** (tray, new) | Status, backup now, restore, pairing code, client sheet, licence info | Server/Standalone | Can be a second window of the Electron app (`--server-manager`), so no extra toolkit is needed. |
| **G-TRADE Licensing Service** (new, cloud) | Registration, activation, renewal, revocation list, update channel metadata | Hosted by the vendor | Separate from the ERP cloud. See the licence design. |

## 5. Identity, scoping and request flow

1. The user signs in. The server issues JWTs with claims `tenant_id` (the **active company**), `org_id` (new),
   `sid`, role. `TenantContextMiddleware` scopes the ORM to `tenant_id`, as today.
2. `BranchContextMiddleware` resolves the active branch from `X-Branch-Id`, as today, within that company.
3. **Switch company:** `POST /api/auth/switch-company/ {tenant_id}` checks a
   `UserCompanyMembership` row (same org, active company, licence allows it), revokes the old `sid`,
   and returns a new token pair. The frontend already resets tenant-scoped caches when the scope
   changes (`utils/localDataReset.js`). The page reloads as the branch switcher already does.
4. Platform-level views (`unscoped()`) stay limited to `IsPlatformAdmin`. That is the cloud only; the role does not exist locally.

## 6. Data and file layout

```
C:\Program Files\G-TRADE\                 (read-only, signed binaries)
  G-TRADE.exe, resources\app.asar         Electron client
  resources\server\<version>\             backend .pyc, frontend dist   (side-by-side versions)
  resources\runtime\python|pgsql|nginx|winsw
C:\ProgramData\G-TRADE\                   (ACL: SYSTEM, Administrators, service SIDs)
  config\  gtrade.env (DPAPI-wrapped secrets), license.lic, install.json, tls\
  pgsql\data\   media\   static\   backups\{app,db,pre-update}\   logs\{install,app,web,agent,db}\
  updates\ (downloaded, signature-verified packages; LAN mirror)
%LOCALAPPDATA%\G-TRADE\                   per Windows user: Electron profile, printer map, server pairing
```

## 7. Existing capabilities reused

| Capability | Where | Reuse |
|---|---|---|
| Row-level tenant isolation, per-tenant uniques/sequences/caches | `apps/common/tenancy.py`, `tenant_context.py` | Becomes **company** isolation (A1) |
| Tenant onboarding with default masters | `apps/common/tenant_onboarding.py`, `ensure_tenant_defaults` | "Create company" in the wizard and in-app |
| Packages, modules, seats (`max_users`) | `apps/common/module_access.py`, `Tenant` | Licence entitlements feed these |
| Branch context, branch stock, scoped viewsets | `branch_context.py`, `branch_mixins.py`, `BranchStock` | Kept; gaps listed in the company audit |
| Security: sid sessions, re-auth, 2FA, lockout, audit | `apps/security` | Kept unchanged |
| ORM logical backup + transactional restore + scheduler | `apps/security/backup` | L1 layer; `SingleTenantInstall` rule must become "single-organization install" |
| Health + API version | `/api/health/`, `config/urls.py` `API_VERSION = 2` | Installer checks, update compatibility handshake |
| Idempotency, write guard, maintenance middleware | `apps/common`, `RestoreMaintenanceMiddleware` | Update maintenance window |
| Electron preload print bridge | `public/preload.js`, `public/electron.js` | Thin client base (rewrite the main process) |

## 8. Missing components (summary)

| Area | Missing | Doc |
|---|---|---|
| Data model | `Organization`, `UserCompanyMembership`, org claim, switch-company API, company switcher UI, consolidated reports | Company audit |
| Branch isolation | Branch checks on financial report/journal `branch` parameters, branch FK on wholesale/eye-exam/appointment documents, stock-transfer apply logic | Company audit §3 |
| Local config | `settings_local.py`, local server entry point, local frontend flag (B1–B5) | Phase 1 roadmap Phase 2 |
| Packaging | Embedded runtime build, WinSW XML, nginx/TLS generator, NSIS scripts, signing pipeline | Installer plan |
| Commercial | Licensing service, licence verifier, limit enforcement, registration UI | Licence design |
| Operations | Agent, `gtrade-ctl`, update channel and LAN mirror, L2/L3 backups, rollback | Backup/update plan |
| Security | LAN PKI + pairing, DPAPI secret storage, firewall rules, signing, log redaction | Security checklist |

## 9. Top risks

| ID | Risk | Severity | Mitigation |
|---|---|---|---|
| C1 | A multi-company implementation leaks data between companies | Critical | Company = Tenant re-uses proven enforcement; membership-checked token switch; cross-company tests in CI |
| C2 | LAN client talks to the cloud backend (B1) | Critical | Local build flag + installer smoke test |
| C3 | Update migrates and fails with no restore point | Critical | Mandatory pre-update `pg_dump`, side-by-side versions, automatic rollback |
| C4 | Licence bypass by editing Python source on the customer PC | High | Accept residual risk; signed licence + server-side checks + `.pyc`-only + integrity manifest; do not over-invest in DRM |
| C5 | Workstation/server version skew after partial update | High | SPA served by the server; Electron shell checks `api_version` + `min_client_version`; workstations update from the server mirror |
| C6 | Unsigned binaries blocked by SmartScreen / Smart App Control | High | Code-signing certificate procured before Phase 5 |
| C7 | Installer size (PG + Python + Electron ≈ 350–450 MB) | Medium | Workstation mode skips extracting the server payload; LZMA solid compression; trimmed PG (no pgAdmin, docs, StackBuilder) |
| C8 | Cloud regression from shared-code changes | High | Edition gating; cloud test suite on every phase; Organization migration tested on a Neon branch copy first |
| C9 | Windows 10 out of support | Medium | Supported best-effort; Win11 recommended for servers |

## 10. Decisions required before implementation

| # | Decision | Recommendation |
|---|---|---|
| D1 | Approve **Company = Tenant + Organization** (A1) | Approve |
| D2 | Can companies under one customer **share** masters (products, customers, suppliers)? | **No in v1** (separate books, Tally-style). Offer "copy masters from company X" at creation. Shared masters are a later, opt-in feature. |
| D3 | Consolidated (cross-company) reports in v1? | Read-only consolidated **sales and stock summary** only; full consolidated financials later |
| D4 | Licensing service hosting and ownership | Small separate service (not the ERP Render app), with its own DB and signing key in a KMS/HSM |
| D5 | Pricing dimensions: companies, branches, users (named vs concurrent), modules, edition, update entitlement period | Named active users (matches existing `max_users`) |
| D6 | Code-signing route: EV certificate vs Azure Trusted Signing | Azure Trusted Signing if eligible (cheaper, cloud HSM, CI friendly); otherwise OV/EV on an HSM token |
| D7 | TLS on standalone loopback (O3) | Yes, same code path |
| D8 | Product/publisher naming (still "Optical ERP"/`com.opticalerp.app` in `package.json`) | "G-TRADE ERP", new appId `com.gtrade.erp` (fresh install base) |
| D9 | Update cadence and channels | `stable` + `beta`; server updates only by an admin, never silently mid-business-day |

---

## 11. Prioritized implementation roadmap

Each phase lists its **hard dependencies**. Phases on separate rows of the graph can run in parallel
if there are two developers. Cloud behaviour must stay unchanged at the end of every phase, and the
existing test suites must pass.

```
P0 Decisions & procurement ──┬──────────────────────────────────────────────┐
                             │                                              │
P1 Isolation hardening ──► P2 Organization & multi-company ──► P6 Licence enforcement
        │                                  │                         ▲
P3 Local edition config (B1–B5) ──► P4 Runtime + services + TLS ──► P5 NSIS installer ──► P7 Updates & rollback ──► P9 Pilot & GA
                                                   │                         │
                                                   └──► P8 Backup L2/L3 ─────┘
P6a Licensing service (cloud) ── independent, needed by P6 ───┘
```

| Phase | Scope | Depends on | Exit criteria | Effort* |
|---|---|---|---|---|
| **P0** Decisions & procurement | Answer D1–D9; order the code-signing certificate (lead time); set up release signing keys (Ed25519 licence key, update key) in a KMS | — | Signed-off decisions; certificate ordered | 1 wk (calendar) |
| **P1** Isolation hardening (cloud benefits too) | Fix branch-parameter checks in financial reports/journals; branch-scope ledger lines; add branch FK to wholesale docs, eye exams, appointments (nullable, backfilled); cross-tenant and cross-branch regression test suite | — | New isolation tests pass on cloud + Postgres 17 Windows | 1.5 wk |
| **P2** Organization & multi-company | `Organization` model, `Tenant.organization`, `UserCompanyMembership`, `org_id` claim, switch-company API, company switcher UI, "create company" in-app, single-organization backup rule, cloud data migration (one org per tenant) | P1 | A user with two memberships switches companies; no data from company A visible in B (automated test) | 2.5 wk |
| **P3** Local-edition config layer | Phase 1 roadmap Phase 2 (settings overlay, local server entry, local frontend flag, bundled `xlsx`/fonts, destructive-command guards) | — | App runs from local PG 17 + Waitress + nginx, offline | 1.5 wk |
| **P4** Runtime, services, TLS | Reproducible build of embedded Python 3.12/PG 17/nginx/WinSW; `gtrade-ctl` core; WinSW XML; local CA + server cert; nginx TLS config; Agent skeleton | P3 | Clean Win11 VM: services up after reboot, HTTPS verified with pinned CA | 2 wk |
| **P5** Universal NSIS installer + Electron thin client | Electron Builder NSIS with mode pages, server pairing, firewall, shortcuts, uninstaller, install logging, silent mode | P4 | One signed exe installs all 3 modes on Win10 22H2/Win11; uninstall keeps data | 2.5 wk |
| **P6a** Licensing service | Registration, activation, renewal, revocation, admin portal | P0 | Issues signed licence files | 2 wk (parallel) |
| **P6** Licence enforcement | Verifier, entitlement mapping to orgs/companies/branches/users/modules, grace period, clock-tamper guard, activation UI in wizard and app | P2, P5, P6a | Over-limit creates refused server-side; offline activation works | 1.5 wk |
| **P8** Backup L2/L3 | `pg_dump` + media archive, retention, off-machine copy, restore-to-new-DB-and-swap, restore when app is down | P4 | Restore drill passes on VM | 1.5 wk |
| **P7** Updates & rollback | Update feed + signature check; Agent applies server update with maintenance mode, pre-update dump, `migrate --plan` gate, health check, auto-rollback; LAN mirror for workstations; version handshake | P5, P8 | Deliberately broken release rolls back with zero data loss | 2 wk |
| **P9** Hardening & pilot | Full test matrix, perf (25 clients), AV vendor submissions, docs/runbooks, 2 pilot customers (1 standalone, 1 LAN multi-company) for 4 weeks | all | Pilot sign-off → GA | 2 wk + pilot |

\*One developer, indicative. Total ≈ **18–20 weeks** of work, plus the pilot; ≈ 12–13 weeks with two developers running P1→P2→P6 and P3→P4→P5 in parallel.

**Ordering rationale**

- P1 and P2 come first because **data isolation is the one thing that cannot be patched after customers have data**; changing the company model after go-live means migrating live customer databases.
- P3/P4 can start in parallel with P1/P2: they touch configuration and packaging, not the data model.
- Licence enforcement (P6) needs the org/company model (P2) to know what to count.
- Updates (P7) must not ship before backups (P8), because a server update without a guaranteed restore point is the highest-severity operational risk.

**Awaiting review and approval of this document set and decisions D1–D9 before any implementation.**
