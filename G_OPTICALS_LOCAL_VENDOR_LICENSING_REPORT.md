# G-OPTICALS — Local Super Admin permanent licence + customer subscriptions (2026-11-19)

## What you get

| You (GREENSOL SOLUTION, Local Super Admin) | Your customer (e.g. CLEAR OPTICS) |
|---|---|
| **PERMANENT** platform-owner licence: plan *Platform Owner / Lifetime*, edition **ENTERPRISE**, expiry **NEVER**, days remaining **UNLIMITED**, clients / companies / users / branches **UNLIMITED**, modules **ALL ENABLED** | Monthly / Quarterly / Half-Yearly / Yearly / Lifetime subscription with its own users, companies, branches, branches-per-company, modules and Settings sections |
| Issues customer licence keys **offline**: *Customer Licences* → New licence → Copy key / Download .lic | Licence Details → paste key → **Activate** (offline), or Import licence file (same rules) |
| Renew / New subscription / Upgrade / Suspend / Revoke / Replacement key, all audited | After expiry: **EXPIRED**, read-only, data kept; paste the renewal key → active again |

## How it works (one licence system, reused)

* **Same signed key format** as before (`GTL1.…`, Ed25519). Customer installations verify it with the
  public key embedded in the build — signature, product, edition, client, installation ID, machine,
  start/expiry, status, revision. Nothing new to trust.
* **Your installation issues keys** with the existing vendor licence console (`apps.vendor_licensing`),
  which now also runs in the Windows edition. It can sign only where **your vendor signing key** exists:
  `C:\ProgramData\G-TRADE\config\license\vendor-signing.dpapi` (DPAPI-encrypted for this PC, readable only by
  SYSTEM, Administrators and the G-TRADE service). Customer installations never have this file, so their
  console can never issue anything (tested). A key is used for signing only if this build trusts its public
  half, so you can never issue keys that customers would reject.
* **Platform owner = a signed licence**, not a hidden banner: *Licence Details → Activate permanent
  platform-owner licence* signs a lifetime licence with role `PLATFORM_OWNER`, every limit unlimited, all
  modules, bound to **your** Installation ID and computer. Only the holder of the vendor key can create one,
  and it is refused on any other installation (tested), so a customer cannot become the platform owner.
  The limits engine reads it like any licence: Client Management shows *Local licence: PERMANENT (platform
  owner) · Clients N (unlimited)*.
* **Dates**: a subscription runs in calendar months to the same date — Monthly 19 Nov 2026 → **19 Dec 2026**,
  Quarterly → 19 Feb 2027, Half-Yearly → 19 May 2027, Yearly → 19 Nov 2027. The customer can use the
  application until the end of the expiry day. The standard plans have no grace days: the next day the
  status is **EXPIRED** (read-only; reading, printing, backups and licence activation keep working; no data,
  account, user or transaction is deleted or deactivated).
* **Renewal**: *Renew* re-signs the same licence (revision + 1) from the current expiry date — or from today if
  it already lapsed — keeping the customer's own limits unless you change them in the same dialog.
  *New subscription* issues a new licence for the same customer and Installation ID (e.g. switch Monthly →
  Quarterly). Pasting either on the customer PC replaces the expired licence; the Installation ID, data and
  audit history are kept; an older revision can never be re-installed.

## Files changed

Backend: `apps/vendor_licensing/{signing,tokens,service,views,serializers}.py`,
`apps/licensing/{state,service,views,urls,enforcement}.py`, `config/settings_local.py`, `config/urls.py`.
Windows: `gtrade_ctl/vendor_key.py` (new), `gtrade_ctl/license_cmds.py` (`vendor-key` command),
`gtrade_ctl/secrets_store.py`, `tooling/{build_runtime,verify_package,embed_licence_public_key,finalize_release}.py`,
`tooling/provision_vendor_key.ps1` (new).
Frontend: `pages/LicensePage.jsx`, `pages/LicenceManagement.jsx`, `pages/TenantManagement.jsx`, `App.jsx`,
`components/Sidebar.jsx`, `components/superadmin/licensing/{CustomerTermsFields (new),PlanLicenceStep,NewLicenceDialog,LicenceDetailDialog}.jsx`.
Tests: `apps/licensing/tests_local_vendor_workflow.py` (new), `windows/tests/test_local_vendor_licensing_e2e.py` +
`lic_timetravel.py` (new), `windows/tests/test_embed_licence_key.py` (+2), date expectations in
`apps/vendor_licensing/tests.py` and `apps/licensing/tests_vendor_keys.py` (calendar-month rule).
No database table was changed. On upgrade, the installer applies the existing `vendor_licensing 0001` (5 new,
empty tables) **after its automatic verified backup** (database + media); existing clients, data and the
Installation ID are untouched.

## Test results

All run on 2026-11-19 on this PC; nothing was weakened to pass.

| Suite | Result |
|---|---|
| **Real two-installation E2E** (`windows/tests/test_local_vendor_licensing_e2e.py`): two staged release-build installations, vendor key made by the real `gtrade-ctl vendor-key generate`, customer licence server pointed at a closed port | **PASS** (255 s) |
| Local Django: `apps.licensing` incl. new workflow tests A–F (release build, non-dev key, DPAPI key file) | **60 / 60** |
| Cloud Django: `apps.vendor_licensing` (cloud console unchanged apart from the date rule) | **24 / 24** |
| Release tooling: key embedding incl. vendor-installation proof | **6 / 6** |
| Frontend vendor-licensing helpers; Windows SPA build | **5 / 5**; built |

E2E evidence (`windows/out/evidence/local_vendor_licensing_e2e.json`):

* **A – platform owner**: `VALID`, platform_owner, `GOL-OWNER-BFF7EA90`, *Platform Owner / Lifetime*, ENTERPRISE,
  lifetime, days_left none, valid_until none, modules all; 3 hosted clients created (evaluation allowed 1).
  The customer installation got **403** when it tried to make itself platform owner.
* **B – monthly**: CLEAR OPTICS `CL-000001`, `GOL-2026-5AAFEE09`, start 2026-11-19 → expiry **2026-12-19**,
  PROFESSIONAL, users 4 / companies 1 / branches 2 / per company 2, bound to the customer Installation ID;
  activated offline in < 30 s with no licence server reachable: `VALID`, 31 days. On 19 Dec: `VALID`.
  On 21 Dec: **`EXPIRED`**, read-only, write **402**, read **200**, the customer's data still there.
* **C – renewal**: renewed on the vendor (revision 2, expiry **2027-01-19**, users raised to 6), pasted on the
  customer: `VALID`, same licence ID and Installation ID; 21 Dec is now `VALID`; the old key is refused;
  data intact.
* **D – other plans** on the same customer: Quarterly → 2027-02-19, Half-Yearly → 2027-05-19,
  Yearly → 2027-11-19, each activated `VALID`.
* **E – offline**: every customer activation above ran with the licence server unreachable; an *unbound* key
  is refused with an explanation instead of silently going online.
* **F – security** (customer installation): wrong-PC key 400, expired key 400, tampered key 400, wrong-client
  key 400 ("issued to a different client"); unit tests additionally cover an untrusted signing key, an unknown
  key id, a development key in a release build, a forged platform-owner licence, a missing vendor key
  (customer console cannot issue: 503) and an untrusted vendor key (never signs).

Time after the expiry date is checked inside the customer installation's own Python and database with the
clock pinned (`windows/tests/lic_timetravel.py`); that check is rolled back, so the installation's real
clock guard is untouched. The servers' system clock itself was not changed.

## Honest limits

* **Clock tampering**: an offline installation can only trust its own clock. G-OPTICALS remembers the latest
  time it has seen; moving the clock back more than 48 h is detected, shown as a warning, and licence dates are
  evaluated against the latest time seen, so turning the clock back does not extend a subscription. Someone
  who sets the clock back *before* the first use, or keeps it frozen, can delay expiry; only an online
  check-in can prove the real date.
* **Offline revocation**: a key you suspend or revoke stops working on an offline customer PC only when that PC
  receives newer information (a newer key / licence file from you, or an online check-in). An already
  activated offline licence keeps working until its expiry date. Use short subscriptions (monthly) for
  customers you may need to stop.
* A customer with full administrator rights on their own PC could in principle modify the program files; the
  signature stops anyone from *forging or editing licence keys*, not from patching software they control.
* **Your vendor key is the master key.** If this PC is lost without the encrypted backup, you cannot renew
  existing customers' keys; a new key needs a new release trusted by every customer. Keep the encrypted backup
  (`gtrade-ctl vendor-key export`) and its passphrase in two separate safe places.
