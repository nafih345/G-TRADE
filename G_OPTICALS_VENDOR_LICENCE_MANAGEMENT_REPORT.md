# G OPTICALS — Vendor Licence Management (Plans, Signed Keys, Activation)

Date: 2026-11-18 · Status: implemented, tested, **not committed, not deployed** (cloud deploy and the
production key ceremony need the owner's approval).

## 1. Architecture (one licence system, extended)

| Layer | Where | Role |
|---|---|---|
| Wire format | `backend/apps/licensing/licfmt.py` | `GTL1.<payload>.<Ed25519 sig>` licence, `GTC1` revocation list (unchanged format; signing helper added) |
| Licence content | `backend/apps/vendor_licensing/tokens.py` | Payload v2: licence ID + revision, client ID/name, edition, plan (code, name, cycle, duration), issue/start/expiry dates or lifetime, limits + explicit `unlimited` list, modules, Settings sections, status, installation binding (install ID, optional machine fingerprint), cloud workspace ID |
| Vendor authority (cloud only) | `backend/apps/vendor_licensing/` | Plans, licensed clients, licences, issuance history, audit; signing; online activation/check-in/CRL. In `config.settings` only — `settings_local` removes it and the Windows build leaves the folder out |
| Customer verification (Windows) | `backend/apps/licensing/` | Verifies with the embedded public key; same rules for pasted key and licence file; evaluation unchanged |
| Cloud enforcement | `apps/common` (existing) | A cloud licence writes the client's subscription fields (expiry, seats, branches, modules, companies) that the existing middleware/seat/branch/module gates already enforce |

A **licence key is the signed licence itself**, so a key works offline. A key issued before the vendor
knows the installation ("first activation") is bound by one online call to the vendor authority, which
refuses any second installation; offline customers send their Installation ID / installation request
code instead and get an installation-bound key or `.lic` file.

## 2. What the Vendor Super Admin can do

*Client Management → New client* starts with **Cloud Edition / Windows Local Edition**:

* **Cloud:** the existing wizard; last step *Plan & Licence* (Monthly / Yearly / Lifetime → plan → start
  date → server-computed expiry + limits review). Creating the client creates the workspace and the signed
  licence in one transaction and shows the key with **Copy**. "Custom terms (no licence)" keeps the old path.
* **Windows Local:** client details → plan & licence (+ optional Installation ID / request code) → one
  POST saves client + licence → key shown with **Copy** and **Download .lic**. No cloud workspace is made.

*Licences & Plans* (new, cloud console only):

* **Plans:** create / edit / activate / deactivate; name, code, edition, billing (monthly/yearly/lifetime),
  duration, price + currency, clients / companies / branches / named users (each a number or an explicit
  *Unlimited* tick), modules, feature permissions (Settings sections), grace days. Sold licences keep their
  terms when a plan is edited.
* **Licences:** client, licence ID, plan, edition, masked key + Copy, start, expiry, status, activation
  status, installation binding; filters and paging. Detail: signature check, issuance history, audit,
  cloud usage. Actions: **Copy key, Renew, Upgrade/Change plan, Suspend, Reactivate, Revoke, Replacement key**.
  Renew and plan changes show the server's diff (and usage above new limits) and need confirmation; lower
  limits never delete or deactivate anything.
* **Audit:** every plan / client / licence action, key copy, activation, refusal and check-in.

## 3. Customer (Windows) Licence Details

Status, plan, edition, licensed client, licence ID + revision, start, expiry, days remaining, limits with
usage, modules, Installation ID (copy). **Licence key** box + **Activate**, **Import licence file**,
**Check with vendor**, **installation request code** for offline binding. Clear errors for: invalid
signature / unknown key, partial key, Cloud key, another installation, another client, suspended, revoked,
expired, not started, older revision, unbound key while offline. Customers cannot change plan, dates,
limits or modules. Evaluation (30 days) is unchanged and never converted.

## 4. Security

* Ed25519; private key only on the vendor server (`GTRADE_LICENSE_SIGNING_KEY` or `_FILE` + `_KEY_ID`),
  never generated automatically, never returned by any API or command output; dev keys (`gtl-dev-*`)
  refused unless DEBUG/tests.
* Public keys only in installations: `backend/apps/licensing/vendor_public_keys.json` (validated, dev ids
  ignored). Rotation by key id (publish new public key → switch signer; `GTRADE_LICENSE_VERIFY_KEYS` keeps
  retired keys verifiable on the vendor side).
* **Fixed gap:** the Windows build never wrote the `RELEASE` marker, so dev-mode licensing could be switched
  on with an environment variable. `build_runtime.py` now writes it; `verify_package.py` asserts it.
* Replay guard (issued_at + revision), client identity pinned per installation, per-revision CRL when a
  licence moves to another PC, rate-limited public endpoints, every action audited, console writes need
  the password re-check.

## 5. Test results

| Suite | Result |
|---|---|
| **Real end-to-end** `windows/tests/test_licence_activation_e2e.py` — real cloud vendor server (`runserver`, disposable PostgreSQL, throwaway dev Ed25519 key) issuing keys through the API; real staged Windows stack (installed by `gtrade-ctl install`, HTTPS via nginx) activating them | **PASS** (alone and inside the Windows suite). Evaluation → other-installation key and tampered key refused → unbound key pasted (wrapped) → VALID, bound online, hardware-bound → same key on a 2nd installation refused (409) → renewal + plan upgrade delivered by *Check with vendor* → suspension = read-only (write 402, reads OK) → reactivation → another client's key refused → offline `.lic` import with the vendor server stopped → revocation = read-only; all 10 audit actions recorded. Evidence: `windows/out/evidence/licence_activation_e2e.json` |
| Vendor authority (cloud settings) `apps.vendor_licensing` | 24/24: monthly/yearly/lifetime plans + explicit unlimited, unique keys + masking + audited copy, valid/tampered/foreign signatures, no-key = nothing issued, dev key refused in production, installation request binding, Cloud client with plan (terms applied, licence-managed fields locked, rollback), suspend/reactivate/revoke (tenant blocked/unblocked, nothing deleted), renew preview→confirm, expired renew, upgrade/downgrade preview + warnings, first-activation binding, check-in delivers status, replacement key + per-revision CRL, refusals, rate limit, permission enforcement, cross-client isolation, key-ceremony command |
| Windows edition `apps.licensing` (incl. new `tests_vendor_keys`) | 51/51: copy/paste activation, lifetime, file = same rules, 10 refusal cases with clear messages, unbound key offline, client identity + replay, admin-only, suspension via check-in, CRL below_rev, zero clients / settings sections, request code round trip, existing evaluation installation, online first activation |
| Full cloud backend suite | 1,195 run: 2 failures were the leak sweep flagging `GET …/v1/crl` → 503 without a signing key (fixed: 200 `crl: null`, test added); 1 pre-existing order-dependent test (`test_settlements`, same-date bills) passed on rerun. Affected modules rerun: 49/49 OK |
| Frontend unit (all 28 `test:*` scripts, incl. new `test:vendor-licensing`) | all pass; cloud and Windows Vite builds compile; Windows SPA contains no vendor console |
| Windows suite with E2E (`GTRADE_E2E=1`) | 273 OK, 5 skipped (elevated-only / opt-in spooler) |
| Desktop unit | 40/40 |
| Desktop + print preview E2E on the new package | 9 OK, 1 skipped (opt-in spooler) |
| Package verification on the built `.exe` | 38/38 + payload guard OK; 1 warning: no production public key embedded |

New release candidate: `windows/out/installer/G-OPTICALS-Setup-1.0.0.exe`, SHA-256
`C0CFFA38E483C536657CACF8D0CB2A26AD206F055F1116F1C7D37B592D253B46`, 206,315,616 bytes, BUILD_ID
`1.0.0-20261118T184559Z-c81cfeb2`, unsigned, **not installed anywhere**. Previous RC 7E559196 archived in
`windows/out/archive/pre-vendor-licence-20261119`.

## 6. Remaining production configuration (owner actions)

1. **Key ceremony (required before any real licence works).** On the vendor server (not a shop PC, not the
   repository): `manage.py licence_signing_key generate --key-id gtl-prod-2026a --out <secure path>`. Store the
   PEM in the host secret store as `GTRADE_LICENSE_SIGNING_KEY` (or a secret file + `GTRADE_LICENSE_SIGNING_KEY_FILE`)
   and set `GTRADE_LICENSE_SIGNING_KEY_ID`; delete the local copy.
2. **Embed the public key:** add the printed `{key_id: public_key}` entry to
   `backend/apps/licensing/vendor_public_keys.json`, rebuild the Windows installer (verify_package then shows no warning).
   Until then installations stay in the 30-day evaluation. The owner PC's evaluation started at its first install
   (~2026-11-13), so it ends around **2026-12-13**.
3. **Cloud deployment (approval needed):** deploy the backend with the new requirement `cryptography`, run
   migration `vendor_licensing 0001` (additive, new tables only), deploy the frontend. Nothing was deployed and no
   production database was touched.
4. **Online activation for Windows customers:** set `GTRADE_LICENSE_SERVICE_URL=https://<render backend host>/api/licence-authority`
   in the installation's `gtrade.env` (or ship it as the default). Point it at the backend host directly, not the
   Vercel proxy; the first call after Render sleeps can take up to ~45 s. Without it, use installation-bound keys or
   files (the "First activation" option needs this URL).
5. **Plans:** create the real plans in *Licences & Plans → Plans*; existing cloud clients can be licensed from
   *New Windows licence* / the API with `tenant_id` (their current terms are kept until then).
6. **Key rotation later:** publish the new public key in a release, then switch the signer; keep the old public key
   in `GTRADE_LICENSE_VERIFY_KEYS` (vendor) and in `vendor_public_keys.json` until all customers hold re-signed licences.
7. Still open from before: code signing, elevated self-test on a clean PC, LAN two-PC test.

**Limitations (by design):** an offline installation learns about a suspension or revocation only when it next
checks in or imports a new file. A first-activation key can be bound by whoever activates it first, so send those
only to the intended customer, or bind keys to the Installation ID up front. An installation stays pinned to its
first vendor client; a change of owner needs a licence for the same client account.

## 7. Changed files

Backend (new): `apps/vendor_licensing/` (models, tokens, signing, service, serializers, views, authority views/urls,
onboarding, `licence_signing_key` command, migration 0001, tests), `apps/licensing/tests_vendor_keys.py`,
`apps/licensing/migrations/0002_licensestate_client_rev.py`, `apps/licensing/vendor_public_keys.json` (empty).
Backend (changed): `apps/licensing/{licfmt,keys,state,service,enforcement,views,models}.py`,
`apps/licensing/management/commands/license.py`, `apps/common/{superadmin_views,edition,module_access}.py`,
`config/{settings,settings_local,urls}.py`, `requirements.txt`.
Frontend (new): `pages/LicenceManagement.jsx`, `components/superadmin/licensing/{licenceApi.js,PlanDialog,PlanLicenceStep,
NewLicenceDialog,LicenceDetailDialog,KeyReveal}.jsx`, `utils/__tests__/vendorLicensing.test.js`.
Frontend (changed): `pages/{LicensePage,TenantManagement}.jsx`, `components/superadmin/{OnboardClientWizard,ClientWorkspaceDialog}.jsx`,
`components/{Sidebar,LicenseBanner}.jsx`, `App.jsx`, `package.json`.
Windows: `tooling/build_runtime.py` (RELEASE marker, vendor app excluded), `tooling/verify_package.py` (5 licence
checks + warnings), `tests/test_licence_activation_e2e.py`, `docs/{INSTALLATION,ADMINISTRATOR,TROUBLESHOOTING}_GUIDE.md`.
