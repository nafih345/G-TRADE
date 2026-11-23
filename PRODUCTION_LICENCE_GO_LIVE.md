# G OPTICALS — Production licence go-live (status 2026-11-19)

## Done and verified
| Item | Evidence |
|---|---|
| Licence system re-verified | vendor 24/24 (cloud settings), Windows licensing 51/51, real-server E2E PASS |
| Production DB backup | `backend/backups/prod/prod_UaeClient_before_vendorlicensing_20261119.dump` (pg_dump 18, SHA-256 `e3649c44…64bd1`, git-ignored); restored completely into a throwaway PG18 cluster (124 tables, 6 tenants, 166 migrations) |
| Rehearsal on that copy | `vendor_licensing 0001` applied; new code served all 6 existing clients (list, detail, edit), licence console, plan, Cloud licence for an existing client, Windows lifetime licence, CRL |
| **Production migration applied** | `Uae client` (Neon): `vendor_licensing 0001_initial` → 5 new empty tables, nothing else touched; plan empty; live site healthy on its current commit `8d49a0b` |
| Windows → production URL | default `https://g-trade-backend.onrender.com/api/licence-authority` (config/settings_local.py; gtrade.env can override, empty disables); online timeout 75 s (Render cold start ≈ 43 s); embedded Python reaches the host with verified TLS |
| Key-proof tool | `windows/tooling/embed_licence_public_key.py`: embeds a public key only if the LIVE production CRL signature verifies with it (refuses dev / wrong / private keys) |
| One-command final build | `windows/tooling/finalize_release.py` (embed + prove → build → payload guard → `verify_package --require-production-key` → SHA-256) |
| Production E2E ready | `windows/tests/test_licence_activation_e2e.py` production mode (real authority, shipped app, "ZZ TEST" records revoked afterwards) |

## Blocked — owner action needed (in this order)
1. **Deploy the code** (not done: pushing was not permitted, and Render/Vercel deploy only from a push to `main`).
   Approve "commit + push", or push yourself. Render installs the new `cryptography` requirement; the DB is already migrated.
   Check: `https://g-trade-backend.onrender.com/api/health/` shows the new commit, and `…/api/licence-authority/v1/health` answers 200.
2. **Generate the production signing key ON the vendor server.** Render Free has no Shell; temporarily switch
   `g-trade-backend` to a paid instance type (Shell is per-second billed) or use a trusted offline PC that is not this
   developer machine. In the Render Shell:
   ```
   python manage.py licence_signing_key generate --key-id gtl-prod-2026a --out /tmp/gtl-prod-2026a.pem
   cat /tmp/gtl-prod-2026a.pem        # copy into the Secret File below, nowhere else
   rm /tmp/gtl-prod-2026a.pem
   ```
   Keep the printed **public_key** (safe to share).
   Render → g-trade-backend → Environment: Secret File `gtl-prod-2026a.pem` = the PEM; env vars
   `GTRADE_LICENSE_SIGNING_KEY_ID=gtl-prod-2026a`, `GTRADE_LICENSE_SIGNING_KEY_FILE=/etc/secrets/gtl-prod-2026a.pem`; Save.
   Check: `…/api/licence-authority/v1/health` → `"signing": true, "key_id": "gtl-prod-2026a"`.
3. **Build the final installer** on this PC (PowerShell, repo root) — send me the public key or run:
   ```
   windows\out\venv-candidate\Scripts\python.exe windows\tooling\finalize_release.py --key-id gtl-prod-2026a --public-key <public_key>
   ```
4. **Production end-to-end** (PowerShell, `windows\`):
   ```
   $env:GTRADE_E2E='1'; $env:GTRADE_LIC_E2E_VENDOR_URL='https://g-trade-backend.onrender.com'
   $env:GTRADE_LIC_E2E_VENDOR_USER='<vendor console user>'; $env:GTRADE_LIC_E2E_VENDOR_PASSWORD='<password>'
   .\out\venv-candidate\Scripts\python.exe -m unittest -v tests.test_licence_activation_e2e
   ```

Rollback of the DB step if ever needed: `manage.py migrate vendor_licensing zero` (drops only the 5 new tables).
Restore note: Neon dumps contain `ALTER … SET (pg_attver=…)` lines that stock PostgreSQL rejects (the whole table is
then skipped); drop those lines (`pg_restore -f` → filter → `psql`) when restoring outside Neon.
