# G-TRADE ERP — Architecture Decision Register (P0)

**Date:** 2026-11-11 · **Status:** Awaiting owner approval. Nothing in this register is implemented.
No code, migrations, data or git state were changed while preparing it.

**Sources.** The nine decisions D1–D9 are taken **word for word** from
`COMMERCIAL_WINDOWS_ARCHITECTURE.md` §10 ("Decisions required before implementation"). No other report
defines new D-numbers. Three reports refer back to them:

| Decision | Also referenced in |
|---|---|
| D2 | `MULTI_COMPANY_BRANCH_AUDIT.md` §2 (products/masters row) |
| D3 | `MULTI_COMPANY_BRANCH_AUDIT.md` §5.4 |
| D5 | `LICENSE_MANAGEMENT_DESIGN.md` §5 (Users row) |
| D7 | `WINDOWS_SECURITY_CHECKLIST.md` 4.9; `COMMERCIAL_WINDOWS_ARCHITECTURE.md` §3.1 (as "decision O3") |

**How options are labelled.** Each option is marked by where it comes from:
- **[doc]**: the option is stated in the reports, either as the recommendation or as a named alternative.
- **[implied]**: the reports do not name it, but it is the obvious other answer to the question, such as "no" or
  "keep today's behaviour". It is listed so that the risks can be compared. It is **not** a new decision.

---

## Summary table

| # | Decision (as documented) | Documented recommendation | My recommendation | Blocks |
|---|---|---|---|---|
| D1 | Approve **Company = Tenant + Organization** (A1) | Approve | **Approve** | P2, and P1 item 2 (backup rule) |
| D2 | Can companies under one customer **share** masters (products, customers, suppliers)? | No in v1; "copy masters from company X" at creation; shared masters later, opt-in | **Agree: no sharing in v1, copy at creation** | P2 |
| D3 | Consolidated (cross-company) reports in v1? | Read-only consolidated sales and stock summary only; full consolidated financials later | **Agree** | P2/P9 |
| D4 | Licensing service hosting and ownership | Small separate service, own DB, signing key in KMS/HSM | **Agree**, and name an owner and a recovery plan for the key | P6a |
| D5 | Pricing dimensions: companies, branches, users (named vs concurrent), modules, edition, update entitlement period | Named active users | **Named active users, plus limits on companies, branches and modules, edition, and update entitlement** | P6 |
| D6 | Code-signing route: EV certificate vs Azure Trusted Signing | Azure Trusted Signing if eligible; otherwise OV/EV on an HSM token | **Agree. Check eligibility this week; order OV on HSM as the fallback if not eligible** | P5 (lead time) |
| D7 | TLS on standalone loopback (O3) | Yes, same code path | **Yes** | P4 |
| D8 | Product/publisher naming (still "Optical ERP"/`com.opticalerp.app`) | "G-TRADE ERP", new appId `com.gtrade.erp` | **Agree. Fix the legal publisher name before ordering the certificate (D6)** | P5, D6 |
| D9 | Update cadence and channels | `stable` + `beta`; server updates only by an admin, never silently mid-business-day | **Agree** | P7 |

**Dependencies between decisions**
- **D1 → D2, D3, D5.** Sharing masters, consolidating reports and counting companies all assume companies are tenants.
- **D8 → D6.** The Authenticode certificate subject is the publisher's legal name. It must be fixed before the certificate is ordered, or the certificate is re-issued.
- **D4 → D5.** The licence payload (`limits`, `modules`, `edition`, `updates_until`) is the format the pricing dimensions are written into.
- **D9 → A9.** The update flow in `BACKUP_UPDATE_RECOVERY_PLAN.md` §4 assumes admin-approved server updates.

---

## D1 — Company = Tenant + Organization

**1. Decision question (as documented).** Approve **Company = Tenant + Organization** (A1).

Context: `company.Company` is a per-tenant singleton today, and no business table has a `company_id`.
A1 models each company as an existing `common.Tenant` and adds a new `Organization` (the paying customer) above
tenants, plus `UserCompanyMembership` (architecture §1, company audit §5).

**2. Options**

| Option | Source |
|---|---|
| **A. Company = Tenant**, new `Organization` grouping tenants, `UserCompanyMembership` for users who work in several companies | [doc] recommended (A1) |
| B. `company_id` FK on every business model, with a second ORM scoping layer | [doc] rejected alternative (A1; company audit §5.5) |
| C. Database per company | [doc] rejected for local installs (A2; isolation audit §4, L-B) |

**3. Recommendation: A (approve).**

**4. Technical consequences of A**
- About three new or changed models (`Organization`, `Tenant.organization`, `UserCompanyMembership`) instead of about 100.
- Per-company books, numbering, settings, unique constraints and caches come from the existing `TenantQuerySet`,
  `check_write`, `tenant_serializers.install()` and `hot_cache` prefixing, with no new scoping code.
- Switching company means issuing a new token for another tenant (`POST /api/auth/switch-company/`) and resetting the existing frontend scope.
- The JWT gains an additive `org_id` claim. Old tokens fall back to `tenant.organization`.
- Cloud: a data migration creates one Organization per existing tenant. It is reversible by dropping the column.
- The backup rule changes from "one tenant" to "one organization" (isolation audit I2). This is why **P1 item 2 can only be finished in full after D1** (see the P1 plan, item 2).
- Consolidated reports loop over tenants with `use_tenant()`. No `unscoped()` is needed.

**5. Risks of each option**

| Option | Risks |
|---|---|
| A | A membership bug could grant a company outside the organization. Mitigations: service guard, DB test, audit log, licence org check at token issue. Masters are not shared, so D2 needs a copy tool. Usernames stay globally unique (I3), so two customers on the cloud cannot both use `admin`. Old tokens without `org_id` need the fallback. |
| B | About 100 models, every unique constraint, sequence, singleton, raw-SQL counter and cache would need re-keying. A second isolation layer would have to be built and proven. There would be a large migration on live cloud data. Highest regression and leak risk (C1). |
| C | N migrations per update and N backups. Cross-company switching needs DB routing. Memberships span databases. Consolidation needs cross-DB queries. |

---

## D2 — Sharing masters between companies

**1. Decision question (as documented).** Can companies under one customer **share** masters (products, customers, suppliers)?

**2. Options**

| Option | Source |
|---|---|
| **A. No sharing in v1** (separate books, Tally-style), plus a one-time "copy masters from company X" when a company is created | [doc] recommended |
| B. Shared masters as a later, opt-in feature | [doc] deferred |
| C. Shared masters in v1 | [implied] the "yes" answer |

**3. Recommendation: A for v1, with B on the roadmap.** Copy scope as documented: categories, brands, units, tax, products without stock.

**4. Technical consequences**
- A: no model change. A "copy masters" service runs inside `use_tenant(target)` and reads the source through `use_tenant(source)`. New UUIDs are created, so the two companies' masters then diverge.
- Products in company A and company B are unrelated rows. Inter-company transfers (later) need a product mapping, for example by barcode or SKU.
- C: needs either cross-tenant FKs, which break the `check_write` rule that refuses FKs into another tenant, or an org-level master table outside tenant scope. Both weaken the isolation the whole design relies on.

**5. Risks of each option**

| Option | Risks |
|---|---|
| A | Duplicate data entry for groups that really do sell the same catalogue. Copies drift over time (price changes in one company only). Barcode clashes if both companies print the same series (`BarcodeSeriesConfig` is per tenant). |
| B | Must be designed later without breaking A's data. A product-mapping layer is the likely route. |
| C | Creates exactly the cross-company path the isolation design is meant to prevent. Every master-reading view would need an org-level exception. Stock and pricing would still have to stay per company. High leak and regression risk. |

---

## D3 — Consolidated reports in v1

**1. Decision question (as documented).** Consolidated (cross-company) reports in v1?

**2. Options**

| Option | Source |
|---|---|
| **A. Read-only consolidated sales and stock summary** (organization dashboard) | [doc] recommended |
| B. Full consolidated financial statements | [doc] deferred ("later") |
| C. No consolidation in v1 | [implied] |

**3. Recommendation: A.**

**4. Technical consequences**
- A: an organization dashboard (sales, stock value, receivables per company) built by looping `tenancy.use_tenant(t)` over the companies the user is a member of. It is never built with `unscoped()`. Cost grows with the number of companies × queries per company. This is acceptable on a local DB. Hosted latency (about 250 ms per query between Render Singapore and Neon us-east-2) makes it slow on the cloud unless it is cached or batched.
- B: needs inter-company elimination, currency alignment and a common chart-of-accounts mapping. That is a separate project.
- C: nothing to build, but users must switch company to see each figure.

**5. Risks of each option**

| Option | Risks |
|---|---|
| A | The dashboard must check membership for **each** tenant it loops over. One missing check would leak a whole company. Needs its own isolation test. Totals may be mistaken for consolidated accounts; label them "summary, not consolidated accounts". |
| B | Large scope. Wrong eliminations give wrong group figures. Delays v1. |
| C | Multi-company customers, the main reason for D1, get no group view at all. Weak selling point. |

---

## D4 — Licensing service hosting and ownership

**1. Decision question (as documented).** Licensing service hosting and ownership.

**2. Options**

| Option | Source |
|---|---|
| **A. Small separate service with its own DB, signing key in KMS/HSM** | [doc] recommended (A8; licence design §9) |
| B. Inside the ERP cloud app (Render) and its DB | [doc] explicitly rejected ("not the ERP Render app") |

**3. Recommendation: A.** In the same decision, also name: (a) the owner of the service and the key ceremony,
(b) where the Ed25519 private key lives (KMS/HSM), (c) the key-rotation policy (`key_id`, current and next public keys in each build), and
(d) a documented recovery path if the KMS account is lost.

**4. Technical consequences**
- A: a new deployable (FastAPI or Django) with its own database, backups and uptime target. Endpoints are listed in licence design §9. Activation must work offline (§6.2), so an outage only blocks **new online** activations. Installed shops keep running.
- The private key never touches the ERP codebase or the customer PC. Only public keys are embedded in the backend build.
- B: shares the free-tier Render/Neon limits and hibernation behaviour (a sleeping Render service answers 429 through the Vercel proxy). A compromise of the ERP app would also compromise licence issuance.

**5. Risks of each option**

| Option | Risks |
|---|---|
| A | Another service to run and pay for. Loss of the signing key means no new licences can be issued, which is why the recovery plan is part of this decision. Personal data (contact email, IP at activation) must follow the stated minimisation and retention. |
| B | Shared blast radius with the ERP. The cloud app's hibernation would block activations. The signing key would sit next to customer business data. |

---

## D5 — Pricing dimensions

**1. Decision question (as documented).** Pricing dimensions: companies, branches, users (named vs concurrent), modules,
edition, update entitlement period.

**2. Options**

| Dimension | Options | Source |
|---|---|---|
| Users | **Named active users** vs concurrent users | [doc] named recommended |
| Companies | Limit per organization (`limits.companies`) | [doc] licence payload |
| Branches | Per company and/or total (`branches_per_company`, `branches_total`) | [doc] licence payload |
| Modules | Licence module list ∩ tenant modules; the licence wins | [doc] licence design §5 |
| Edition | `STANDARD` / `PROFESSIONAL` / `ENTERPRISE` | [doc] licence payload |
| Update entitlement | `updates_until` (perpetual licence plus a paid update period) and/or subscription `valid_until` | [doc] licence payload |

**3. Recommendation:** named active users (as documented), **plus** company, branch and module limits and edition, all
as defined in the licence payload; a perpetual licence with a 12-month `updates_until`, renewable.
Concurrent users are not recommended (see risks).

**4. Technical consequences**
- Named users reuse the existing seat check (`Tenant.max_users`, enforced at user creation and `/api/auth/register/`), counted **across the organization** (needs D1).
- Company and branch limits need new hooks at `onboard_tenant` call sites and `BranchViewSet.create`/`activate`.
- Limits are always read from the verified licence at check time and never trusted from DB columns (licence design §8).
- Concurrent users would need a live session counter, which `apps.security` `AuthSession` partly provides, plus a rule for stale sessions.

**5. Risks of each option**

| Option | Risks |
|---|---|
| Named users | Shops that share one login across staff to save seats lose the per-user audit trail. Mitigate with clear pricing and a cheap seat price. |
| Concurrent users | Needs session counting that survives crashed tills and offline periods. Users can be locked out at peak hours. Harder to enforce in a LAN install. Disputes over "ghost" sessions. |
| Branch/company limits | Need the D1 model to count companies. Too strict a limit pushes customers to run several installs (one customer per install is the rule, so that is a licence breach). |
| Update entitlement | Customers on old versions miss security fixes. The support matrix (backup plan §8) must say what is supported. |

---

## D6 — Code-signing route

**1. Decision question (as documented).** Code-signing route: EV certificate vs Azure Trusted Signing.

**2. Options**

| Option | Source |
|---|---|
| **A. Azure Trusted Signing** (cloud HSM, CI-friendly) if eligible | [doc] recommended |
| B. OV certificate on an HSM token | [doc] fallback |
| C. EV certificate on an HSM token | [doc] fallback |

**3. Recommendation: A if the business passes Microsoft's eligibility and identity checks. Otherwise B.**
Start the eligibility check now: P0 exists partly for this lead time (C6).

**4. Technical consequences**
- A: signing runs in CI through `azureSignOptions` in electron-builder. There is no physical token, and certificates are short-lived and renewed automatically. Eligibility is set by Microsoft (organization verification, region and business-history rules) and must be confirmed at procurement time.
- B/C: a USB HSM token or cloud HSM. CI signing needs the token reachable from the build machine. `win.signtoolOptions` is used. SHA-256 with an RFC 3161 timestamp in all cases (checklist 7.2).
- In all cases, sign the installer, uninstaller, `G-TRADE.exe`, `gtrade-ctl.exe` and renamed WinSW exes. Smart App Control testing is a release gate (7.8).

**5. Risks of each option**

| Option | Risks |
|---|---|
| A | May not be available for the business's entity, country or age. Depends on an Azure subscription. Policies may change. |
| B | Builds SmartScreen reputation slowly, so early downloads show warnings. Token handling in CI is awkward. |
| C | Costs more. Microsoft has said EV no longer gives an immediate SmartScreen reputation advantage, so the extra cost may buy little. Verify this at procurement. Same token handling issues as B. |
| Any, ordered late | Unsigned binaries are blocked by Smart App Control and flagged by SmartScreen (C6), so P5 cannot ship. |

---

## D7 — TLS on standalone loopback (O3)

**1. Decision question (as documented).** TLS on standalone loopback (O3).

**2. Options**

| Option | Source |
|---|---|
| **A. Yes: the same TLS stack (local CA, nginx 8443, pinned in Electron) on `127.0.0.1`** | [doc] recommended |
| B. No: plain HTTP on loopback for Standalone only | [doc] "optional" in architecture §3.1 |

**3. Recommendation: A.**

**4. Technical consequences**
- A: one client code path for every mode (pinning, `https://` origin, secure cookies, service-worker rules). `gtrade-ctl cert init` runs for Standalone too. Certificate renewal (checklist 4.2) applies to Standalone.
- A Standalone can be turned into a LAN server later without changing the client's origin or scheme. Only the SAN list and bind address change.
- B: a second origin (`http://127.0.0.1`) to test. Electron pinning code is skipped in one mode.

**5. Risks of each option**

| Option | Risks |
|---|---|
| A | Certificate expiry or renewal failure takes a single-PC shop offline. Needs Agent renewal plus a health warning 30 days ahead. Slightly larger first-run setup. |
| B | Two code paths, so mode-specific bugs. Any local process can read loopback traffic (low risk). Converting to a LAN server changes the origin, so stored client state and pins break. Mixed-content issues if any asset is loaded over HTTPS. |

---

## D8 — Product and publisher naming

**1. Decision question (as documented).** Product/publisher naming (still "Optical ERP"/`com.opticalerp.app` in `package.json`).

**2. Options**

| Option | Source |
|---|---|
| **A. "G-TRADE ERP", new appId `com.gtrade.erp`** (fresh install base) | [doc] recommended |
| B. Keep "Optical ERP" / `com.opticalerp.app` | [implied] the current state |

**3. Recommendation: A.** In the same decision, record the **legal publisher name** that will appear on the code-signing
certificate (D6) and in Windows "Apps & features".

**4. Technical consequences**
- A: `package.json` `build.appId`, `productName`, NSIS GUID and Start-menu names all change. The appId is the identity electron-updater and NSIS use to find an existing install. **Changing it later breaks in-place upgrades**, so it must be fixed once, before the first customer install.
- Today `win.target` is `"dir"` (no installer), so no customer install base exists to migrate. A fresh appId costs nothing now.
- Visible strings in the product ("Optical ERP", "Greensol Optical" in `Appointments.jsx` print headers, for example) are a separate rebrand sweep. They are not part of the appId.

**5. Risks of each option**

| Option | Risks |
|---|---|
| A | Must be settled before D6 or the certificate subject will not match. Trademark check on "G-TRADE" is not covered in the reports and is worth doing. |
| B | Branding does not match the commercial product. Renaming after release forces a new appId and breaks auto-update for every installed customer. |

---

## D9 — Update cadence and channels

**1. Decision question (as documented).** Update cadence and channels.

**2. Options**

| Option | Source |
|---|---|
| **A. `stable` + `beta` channels; server updates applied only by an admin (or in an admin-configured maintenance window), never silently mid-business-day** | [doc] recommended (A9; backup plan §3.2) |
| B. Silent, unattended server updates | [doc] rejected in A9 ("silent unattended server migrations") |
| C. Each PC updates from the internet | [doc] rejected in A9 |

**3. Recommendation: A.**

**4. Technical consequences**
- A: the Agent downloads in the background. An admin approves in Server Manager or an in-app banner, or a maintenance window applies it. A mandatory L2 `pg_dump` is taken before the update, with automatic rollback (backup plan §4). Workstations update only from the LAN mirror, and only after the server has updated (they are never newer than the server).
- `release.json` carries `irreversible`, `min_server_upgrade_from` and `requires_pg_major`. Irreversible migrations need explicit admin acknowledgement.
- A `beta` channel needs a customer opt-in flag and its own release pipeline lane.

**5. Risks of each option**

| Option | Risks |
|---|---|
| A | Admins who never approve stay on old versions, so the security patch backlog grows. Mitigate with a banner that escalates and a maximum deferral for security releases. Beta customers can hit bugs, so keep beta opt-in and limited. |
| B | Migrations run during trading hours. A failed migration without supervision stops the shop's business. Highest operational risk (C3). |
| C | Version skew between the server and workstations (C5). Every PC needs internet. Bandwidth multiplies. |

---

## What P1 needs from P0

P1 (isolation hardening) has **no hard dependency on D1–D9**, as the roadmap in architecture §11 states ("P1 Depends on: —").
One exception: **P1 item 2 (whole-database backup with several tenants)**. The documented final fix is the
"single **organization**" rule, which only exists once D1 is approved and P2 builds `Organization`. The P1 plan
therefore delivers an interim fix that does not depend on D1 and is compatible with it (see `P1_IMPLEMENTATION_PLAN.md`, item 2).

## Approval record

| # | Approved option | Approved by | Date | Notes |
|---|---|---|---|---|
| D1 | | | | |
| D2 | | | | |
| D3 | | | | |
| D4 | | | | Owner of service and key: |
| D5 | | | | |
| D6 | | | | Eligibility result: |
| D7 | | | | |
| D8 | | | | Legal publisher name: |
| D9 | | | | |
