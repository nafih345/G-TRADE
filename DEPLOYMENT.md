# Deployment — Vercel (frontend) + Render (backend + Postgres)

## Why the hosted database kept emptying itself

The old Render service was running with a `DATABASE_URL` pointing at Postgres instance
`dpg-da23a7j7uimc73dpqo70-a`, which **no longer exists**. Its health endpoint reported:

```
"database": "error: could not translate host name \"dpg-da23a7j7uimc73dpqo70-a\" to address"
```

Render's **free Postgres is deleted 30 days after creation**. When it expired, the web
service kept serving with a dead database handle, so entered data had nowhere to land.
Two things made that invisible instead of loud:

1. `DEBUG` defaulted to `True` on Render, because `settings.py` inferred "am I deployed?"
   from `$VERCEL`, which Render does not set. Production was serving full tracebacks and
   the entire URL map on any 404.
2. Nothing in the repo described the backend deployment, so the service was hand-configured
   and unreproducible — `render.yaml` now fixes that.

Read the persistence warning at the top of [`render.yaml`](render.yaml) **before** you pick
a database plan, or this recurs in 30 days.

---

## 1. Backend → Render

1. Push this branch to GitHub (`origin/main`).
2. Render dashboard → **New → Blueprint** → pick the `G-TRADE` repo → **Apply**.
   Render reads [`render.yaml`](render.yaml) and creates both resources, wiring
   `DATABASE_URL` from the database into the web service. That link is the whole point:
   the service can no longer boot against a database that does not exist.
3. On the **`g-opticals-backend`** service → *Environment*, set the three values marked
   `sync: false` (deliberately not committed):

   | Variable | Value |
   | --- | --- |
   | `DJANGO_SUPERUSER_USERNAME` | your admin login |
   | `DJANGO_SUPERUSER_PASSWORD` | a strong password |
   | `FRONTEND_ORIGINS` | your Vercel URL, e.g. `https://g-opticals.vercel.app` (fill in after step 2 of the Vercel section) |

4. Deploy. [`backend/build.sh`](backend/build.sh) runs `collectstatic`, `migrate`, then
   `bootstrap_admin` — which creates that login. **A brand-new Postgres has no users, so
   without those two variables set there is no way to sign in.**
5. Verify — this is the check that would have caught the original outage:

   ```
   curl https://g-opticals-backend.onrender.com/api/health/
   ```

   Expect all four of:
   - `"status": "ok"`
   - `"debug": false`  ← must be false
   - `"db_target": { "host": "dpg-…" }`  ← a real, current host
   - `"migrations": "up_to_date"`

6. **Delete the old `g-trade-backend` service.** It is still live, still has `DEBUG=True`,
   and still points at the deleted database.

> First request after ~15 minutes idle takes ~50s on the free plan — the instance spins
> down. That is why the frontend calls Render directly instead of through Vercel's proxy,
> which would time out first.

## 2. Frontend → Vercel

1. Vercel → **Add New → Project** → import `G-TRADE`.
2. **Root Directory: leave at the repository root**, not `frontend`.
   [`vercel.json`](vercel.json) supplies the build itself:
   `buildCommand: cd frontend && npm install && npm run build`, `outputDirectory: frontend/dist`.
3. **Do not set `VITE_API_URL`.** Leaving it unset is what makes the build target Render —
   `frontend/src/main.jsx` falls back to the Render URL for any non-localhost host.
   `frontend/.env` sets it to `http://localhost:8000` for local dev; that file is
   git-ignored so it never reaches Vercel, and `vite.config.js` now prints a warning if a
   build ever does inline a localhost URL.
4. Deploy, then copy the resulting URL into `FRONTEND_ORIGINS` on Render and redeploy the
   backend. Without it, Django (now `DEBUG=False`) rejects admin logins from that origin.

### If Render gives the service a different hostname

Service names are global, so `g-opticals-backend` may be taken. If the real URL differs,
update it in exactly two places:

- [`vercel.json`](vercel.json) → the `/api/:path*` rewrite destination
- either [`frontend/src/main.jsx`](frontend/src/main.jsx)'s fallback, **or** just set
  `VITE_API_URL` to the real URL in the Vercel project (no code change needed)

---

## 3. Clearing all data on demand

```
python manage.py wipe_database                  # dry run — prints target DB + row counts
python manage.py wipe_database --yes-i-am-sure  # actually wipes
```

Empties every business table (sales, purchasing, inventory, products, accounts, financial,
masters, billing, company) while leaving the schema, migrations and **your login** intact.
On PostgreSQL it uses a single `TRUNCATE … RESTART IDENTITY CASCADE`, so foreign-key order
cannot leave rows behind and invoice numbers / Test No / patient codes restart from one.

Flags: `--keep-settings` (preserve company/branch/business settings), `--include-users`
(also drop non-superuser accounts; superusers are always kept).

**Render's free plan has no shell**, so run it from your own machine against the database's
**External** connection string:

```
# PowerShell
$env:DATABASE_URL = "postgresql://…@dpg-….oregon-postgres.render.com/…"
cd backend; python manage.py wipe_database
```

`settings.py` detects that the host is public (it contains a dot) and enables
`sslmode=require` automatically; Render's internal `dpg-…-a` hostnames get no SSL, which is
what they require.

A freshly provisioned database is already empty, so you only need this to re-clear later.

---

## Known limitations

- **Free Postgres expires after 30 days and is deleted.** Move the database `plan` to
  `basic-256mb`, or point `DATABASE_URL` at a free-forever Neon/Supabase Postgres. This is
  the single thing most likely to lose your data again.
- **Uploaded files are ephemeral.** `MEDIA_ROOT` is on the container filesystem, so product
  images and the company logo used on printed bills survive only until the next deploy or
  restart. Object storage (S3/Cloudinary) is the durable fix.
- `AUTO_MIGRATE=True` stays on as a safety net, but `build.sh` already migrates on release —
  the schema should never trail the code again.
