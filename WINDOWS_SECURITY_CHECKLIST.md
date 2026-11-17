# G-TRADE ERP — Windows Security Checklist

**Date:** 2026-11-11 · **Status:** Checklist for review and the release gate. Nothing implemented.
Parent document: `COMMERCIAL_WINDOWS_ARCHITECTURE.md`. Each item has an owner phase; **all P0/P1 items
must pass before a customer install.**

Legend: ✅ exists today · ⚠️ partial · ❌ missing. Priority: **P0** blocker · **P1** before GA · **P2** after GA.

---

## 1. Data isolation (backend-enforced)

| # | Item | Today | Priority | Reference |
|---|---|---|---|---|
| 1.1 | Tenant (company) isolation enforced in the ORM, not views | ✅ | — | Isolation audit §2 |
| 1.2 | Exhaustive per-model + anonymous-endpoint isolation tests | ❌ | P0 | Isolation audit I4, I6 |
| 1.3 | Company switch only through a membership-checked token re-issue; audit-logged | ❌ | P0 | Company audit §5.2 |
| 1.4 | Branch checks on every financial report/journal `branch` input | ❌ (B-3, B-4, B-5) | P0 | Company audit §3 |
| 1.5 | Wholesale, eye-exam, appointment branch scoping | ❌ (B-1, B-2) | P1 | Company audit §3 |
| 1.6 | `UserBranchAccess` keyed by user id; fail-closed option | ❌ (B-7, B-8) | P1 | Company audit §3 |
| 1.7 | Private media served through an authenticated, tenant-checked path | ❌ (I1) | P0 | Isolation audit I1 |
| 1.8 | Identity from the signed token only; `X-User-*` headers ignored when a token is present | ✅ (`branch_context._resolve`) | — | |
| 1.9 | One organization per local database; restore refuses a foreign `org_id` | ❌ | P0 | Isolation audit §4 |

## 2. Secrets and credentials

| # | Item | Today | Priority |
|---|---|---|---|
| 2.1 | Unique `SECRET_KEY` per installation, generated with a CSPRNG, never regenerated on update | ❌ (insecure default, B3) | P0 |
| 2.2 | `DEBUG=False` forced in the local edition | ❌ (defaults True off-cloud) | P0 |
| 2.3 | DB superuser (`postgres`) and app role (`gtrade`, not superuser) with separate 32+ char random passwords | ❌ | P0 |
| 2.4 | Secrets stored DPAPI-protected (machine scope, with optional entropy) in `ProgramData\G-TRADE\config\gtrade.env.dpapi`; decrypted only by the service process at start | ❌ | P0 |
| 2.5 | Config folder ACL: SYSTEM + Administrators full; service virtual accounts (`NT SERVICE\GTrade-App`, etc.) read; **Users: none** | ❌ | P0 |
| 2.6 | Secrets never on command lines, never in logs (redaction filter in Django logging + `gtrade-ctl log`) | ❌ | P0 |
| 2.7 | `config/database.json`, `config/settings.json`, `config/license.json` excluded from every build (`package.json` currently ships `config/`) | ❌ | P0 |
| 2.8 | Rotate the dev PC's Postgres password found in `config/database.json` before the folder is ever shared | — | P1 |
| 2.9 | TLS private keys ACL'd to `NT SERVICE\GTrade-Web` + Administrators | ❌ | P0 |

## 3. Service accounts and processes

| # | Item | Priority |
|---|---|---|
| 3.1 | PostgreSQL runs as `NT AUTHORITY\NetworkService` (refuses admin), data dir ACL denies Users | P0 |
| 3.2 | `GTrade-App`, `GTrade-Web`, `GTrade-Agent` run as **virtual service accounts** (`NT SERVICE\<name>`), not LocalSystem; Agent gets only the extra rights it needs (stop/start services via a scoped SDDL on our services) | P0 |
| 3.3 | Program Files read-only for service accounts; writable data only under ProgramData | P0 |
| 3.4 | WinSW recovery: restart 5 s / 10 s / 30 s; failure count reset 1 day; Event Log entries | P1 |
| 3.5 | Destructive commands (`wipe_database`, `clear_all_database.py`) excluded from the build and refused under `GTRADE_EDITION=local` | P0 |
| 3.6 | Django admin (`/admin/`) disabled locally, or limited to loopback | P1 |

## 4. LAN communication — HTTPS

**Design: per-installation private CA, pinned by the client through pairing.**

| # | Item | Priority |
|---|---|---|
| 4.1 | `gtrade-ctl cert init` creates an ECDSA P-256 **local CA** (10 years, `pathlen:0`, name constraints limited to the server's names/IPs where feasible) and a **server certificate** (≤ 397 days, SAN = hostname, FQDN, all LAN IPv4, `localhost`, `127.0.0.1`) | P0 |
| 4.2 | Agent renews the server certificate 30 days before expiry and reloads nginx; IP change detected → re-issue with new SANs | P0 |
| 4.3 | nginx: TLS 1.2+1.3 only, modern ciphers, HSTS (`max-age` short at first), OCSP off (private CA), HTTP port closed (no plaintext listener at all) | P0 |
| 4.4 | **Pairing:** Server Manager shows a short-lived pairing code (8 characters, 10 minutes, single use, 5 attempts). The workstation fetches the CA from `/pair` and computes `HMAC(code, CA fingerprint)`; the server proves knowledge of the same code. Match → the CA fingerprint is pinned. Prevents a rogue LAN host impersonating the server at first contact. | P0 |
| 4.5 | Electron accepts the server only if the chain ends at the pinned CA (`setCertificateVerifyProc`); no "proceed anyway" button | P0 |
| 4.6 | The CA is **not** added to the Windows trust store by default (limits blast radius if the CA key leaks). Optional "trust for browsers" toggle for Edge fallback users, installing it into the *CurrentUser* store only. | P1 |
| 4.7 | CA private key encrypted (DPAPI) and included in backups so a server restore keeps workstation pins valid | P0 |
| 4.8 | Re-key procedure (compromise): new CA → all workstations re-pair; documented runbook | P1 |
| 4.9 | Standalone uses the same TLS on loopback (decision D7) | P1 |

## 5. Firewall and network exposure

| # | Item | Priority |
|---|---|---|
| 5.1 | One inbound rule: `G-TRADE Server (HTTPS)`, TCP 8443, program-scoped to nginx.exe, **Private + Domain profiles**, `RemoteAddress=LocalSubnet` | P0 |
| 5.2 | No rule for PostgreSQL (5544) or Waitress (8001); `gtrade-ctl health` asserts both bind only to loopback | P0 |
| 5.3 | Installer warns when the active network profile is Public; Server Manager shows it continuously | P1 |
| 5.4 | Uninstall removes the rule | P0 |
| 5.5 | Rule is created with `New-NetFirewallRule` / `netsh advfirewall` from `gtrade-ctl` and logged; no blanket "allow program" | P0 |
| 5.6 | Outbound: only the Agent needs internet (licence, updates); document hostnames for corporate proxies; proxy support via WinHTTP settings | P1 |

## 6. Application security (existing, keep)

| # | Item | Today |
|---|---|---|
| 6.1 | JWT HS256, 1-day access / 7-day rotating refresh, sid-bound sessions, revocation on logout | ✅ |
| 6.2 | Idle timeout, password re-auth for sensitive writes, TOTP 2FA, lockout, login/re-auth throttles | ✅ |
| 6.3 | Module write gate, edit-approval workflow, audit logs | ✅ |
| 6.4 | `ALLOWED_HOSTS` pinned to server names/IPs; CORS off (same origin) | ❌ P0 |
| 6.5 | Strict CSP, `X-Frame-Options DENY`, `Referrer-Policy`, `X-Content-Type-Options` from nginx | ❌ P1 |
| 6.6 | Electron: tokens in memory; refresh token in `safeStorage` (DPAPI per user) instead of `localStorage` | ❌ P1 |
| 6.7 | Server clock: NTP check in health; TOTP and licence depend on it | ❌ P1 |

## 7. Code signing and supply chain

| # | Item | Priority |
|---|---|---|
| 7.1 | Authenticode certificate (Azure Trusted Signing, or OV/EV on HSM). Order in P0; issuance takes time | P0 |
| 7.2 | Sign: installer, uninstaller, `G-TRADE.exe`, `gtrade-ctl.exe`, renamed WinSW exes, our DLLs. SHA-256 + RFC 3161 timestamp | P0 |
| 7.3 | Update packages: Authenticode-signed (electron-updater verifies the publisher name on Windows) **and** `server-runtime` manifest Ed25519-signed and verified by the Agent before applying | P0 |
| 7.4 | Separate keys: Authenticode, update-manifest Ed25519, licence Ed25519 — each in KMS/HSM, with documented rotation (`key_id`) | P0 |
| 7.5 | Locked dependencies with hashes (`pip --require-hashes`, `npm ci`); upstream checksum verification of PG/nginx/WinSW/Python | P0 |
| 7.6 | SBOM (CycloneDX) per release; vulnerability scan (pip-audit, npm audit) as a CI gate | P1 |
| 7.7 | No UPX, no onefile packers (antivirus false positives); submit releases to Microsoft Defender / major AV vendors | P1 |
| 7.8 | Test with Smart App Control ON on clean Windows 11 | P0 |

## 8. Updates and integrity at rest

| # | Item | Priority |
|---|---|---|
| 8.1 | Agent verifies the signed integrity manifest of `resources\server\<ver>` at start; mismatch → refuse to start + Event Log | P1 |
| 8.2 | Downgrade only through the managed rollback (prevents replaying old vulnerable builds) | P1 |
| 8.3 | Update channel over TLS with pinned vendor CA; LAN mirror served over the pinned LAN TLS | P0 |

## 9. Logging, privacy, uninstall

| # | Item | Priority |
|---|---|---|
| 9.1 | Logs rotated by size; no tokens, passwords, licence keys or card/UPI references (redaction filter) | P0 |
| 9.2 | Diagnostics zip excludes secrets and business data | P0 |
| 9.3 | Uninstall keeps data by default; deletion needs typed confirmation; secrets overwritten before delete | P0 |
| 9.4 | Backups: optional AES-256 encryption with an admin passphrase for L3 (off-machine) copies | P1 |

## 10. Release gate summary

A release may ship to customers only when: all **P0** items are ✅; an external penetration test of the
LAN server (TLS, pairing, API isolation, file exposure) has no open High/Critical findings; and the
installer passes the test matrix with Smart App Control on.
