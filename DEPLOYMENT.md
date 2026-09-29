# Deployment — Vercel (frontend) + Render (backend) + Neon (Postgres)

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
3. Nothing in the *app* said so either. Every request returned 500 and the UI still rendered
   a complete, calm dashboard: "₹0.00", "System Operations Normal", empty tables. That is
   indistinguishable from a business that has not traded yet, so the outage went unnoticed
   for weeks. `BackendStatusBanner` now puts a red bar across the top instead.

The fix is to keep the database off Render's free tier entirely — see
[§1a](#1a-create-the-database-on-neon).

---

## Why production showed an older Wholesale POS

Two separate faults, often mistaken for one:

**1. The live frontend is a build from before 29 Sep.** The complete Wholesale POS —
Packing & Dispatch, Scheme Discount, Bulk Add, Excel Import, the delivery modes — landed in
`846215f1` on 2026-09-29, which grew `WholesaleSales.jsx` from 1305 to 2278 lines. Measured
against the live site:

| | live bundle | build from this commit |
| --- | --- | --- |
| `WholesaleSales` chunk | 33.0 kB | 98.9 kB |
| `Packing & Dispatch`, `Scheme Discount`, `Bulk Add`, `Shipping Address`, `Transport`… | absent | present |

So the code was never the problem and there is no second/simplified Wholesale component —
`WholesaleSales.jsx` is the only one, and `App.jsx` lazy-loads it for every `/wholesale/*`
route. Vercel simply had not built the 29 Sep commits. Nothing in the repo can fix that;
it is a project setting (see §2).

**2. `1e7a82c9` pointed the frontend at a backend that does not exist.** That commit —
itself a deploy fix — changed `main.jsx` and `vercel.json` from `g-trade-backend` to
`g-opticals-backend`:

```
-  (isLocalhost ? '' : 'https://g-trade-backend.onrender.com')
+  (isLocalhost ? '' : 'https://g-opticals-backend.onrender.com')
```

`g-opticals-backend.onrender.com` returns 404 (`x-render-routing: no-server`);
`g-trade-backend.onrender.com` is the service that is actually running. Because the live
site was stale it was still serving the *older*, correct URL — so the regression was
invisible, and would have taken the API down the moment the stale deployment was fixed.
Both files are now back on `g-trade-backend`, and `resolveApiBaseUrl()` is the single place
that decides.

The remaining fault is the database: `/api/health/` on the live backend still reports

```
"database": "error: could not translate host name \"dpg-da23a7j7uimc73dpqo70-a\" …"
```

— the deleted Render Postgres. The service is up; its `DATABASE_URL` is stale. That is
§1b, and it is the one thing here that can only be fixed in the Render dashboard.

---

## 1. Backend → Render

The backend service **`g-trade-backend`** already exists and is already reachable at
`https://g-trade-backend.onrender.com`. It does not need re-creating — it needs a database.
[`render.yaml`](render.yaml) is the written-down version of the settings below; it describes
that same service name so the two cannot drift, but applying it as a Blueprint while the
hand-made service exists would create a *second* service rather than adopt the first. So
either mirror these settings onto the existing service by hand (quickest), or delete it and
apply the Blueprint.

### 1a. Create the database on Neon

Render's free Postgres deletes itself after 30 days, which is what destroyed the last one.
The database therefore lives outside Render:

1. [neon.tech](https://neon.tech) → sign up → **Create project** (pick the region nearest
   Singapore/Mumbai to keep latency to Render low).
2. Copy the **connection string**. It looks like:

   ```
   postgresql://user:pass@ep-xxxx-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require
   ```

   Keep the `?sslmode=require` on the end. `settings.py` would require TLS anyway (it does
   that for any host with a dot in it), but an explicit `sslmode=` in the URL wins, so
   leaving it there is both correct and self-documenting.

Neon's free tier has no 30-day expiry. It does suspend an idle database, which costs a
second or two on the first query — far cheaper than losing the data again.

### 1b. Point Render at it

On the **`g-trade-backend`** service → *Environment*, set:

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | the Neon connection string from 1a |
| `DEBUG` | `False` |
| `FRONTEND_ORIGINS` | `https://g-trade-pi.vercel.app` |
| `DJANGO_SUPERUSER_USERNAME` | your admin login |
| `DJANGO_SUPERUSER_PASSWORD` | a strong password |
| `AUTO_MIGRATE` | `True` |
| `SECRET_KEY` | any long random string, if not already set |

Confirm under *Settings* that **Root Directory** is `backend` and **Build Command** is
`bash ./build.sh` — that script runs `collectstatic`, `migrate`, then `bootstrap_admin`.
**A brand-new Neon database has no users at all, so without those two `DJANGO_SUPERUSER_*`
variables there is no way to sign in.**

Then **Manual Deploy → Deploy latest commit**.

### 1c. Verify

This is the check that would have caught the original outage:

```
curl https://g-trade-backend.onrender.com/api/health/
```

Expect all four of:

- `"status": "ok"` — not `"degraded"`
- `"debug": false` — must be false
- `"db_target": { "host": "ep-….neon.tech" }` — the Neon host, not a `dpg-…` one
- `"migrations": "up_to_date"`

If `"database"` still reports `could not translate host name "dpg-…"`, `DATABASE_URL` did
not take — it is still the deleted Render instance.

> First request after ~15 minutes idle takes ~50s on the free plan — the instance spins
> down. That is why the frontend calls Render directly instead of through Vercel's proxy,
> which would time out first.

**Delete the old `g-opticals-backend` service if you ever created one.** As of this writing
that hostname resolves to nothing (`x-render-routing: no-server`), which is why the
`/api/*` rewrite in `vercel.json` and `DEFAULT_DEPLOYED_API_URL` in
[`frontend/src/utils/backendStatus.js`](frontend/src/utils/backendStatus.js) both name
`g-trade-backend` instead.

## 2. Frontend → Vercel

The live frontend is **`https://g-trade-pi.vercel.app`**. Note that `.vercel/project.json`
in this repo names a different project (`g-trade-3o94`), whose `.vercel.app` hostname no
longer resolves — so a `vercel` CLI deploy from this checkout would publish somewhere the
users are not looking. Deploy through the dashboard/Git integration, or re-link the CLI
first.

1. Vercel → **Add New → Project** → import `G-TRADE` (only if starting fresh).
2. **Root Directory: leave at the repository root**, not `frontend`.
   [`vercel.json`](vercel.json) supplies the build itself:
   `buildCommand: cd frontend && npm install && npm run build`, `outputDirectory: frontend/dist`.
   If Root Directory is `frontend`, Vercel never reads `vercel.json` and both rewrites are
   silently lost.
3. **Do not set `VITE_API_URL`.** Leaving it unset is what makes the build target Render —
   `resolveApiBaseUrl()` in `frontend/src/utils/backendStatus.js` falls back to
   `DEFAULT_DEPLOYED_API_URL` for any non-localhost host. `frontend/.env` sets it to
   `http://localhost:8000` for local dev and for the Electron build; that file is git-ignored
   so it never reaches Vercel, and `vite.config.js` prints a warning if a build ever does
   inline a localhost URL.
4. **Check Deployment Protection.** If *Vercel Authentication* is on, every request
   302-redirects to `vercel.com/sso-api`, so only people logged into the Vercel team can open
   the app — staff and customers get a login wall, not the ERP. Turn it off at
   *Settings → Deployment Protection → Vercel Authentication → Disabled*.
5. Framework Preset: *Other* (the build is driven by `vercel.json`, not auto-detection).
6. Deploy, then make sure `FRONTEND_ORIGINS` on Render matches the resulting URL. Without it,
   Django (now `DEBUG=False`) rejects admin logins from that origin.

### Confirm the deployment is not stale

Production has been observed serving a build older than `origin/main` even with the commits
pushed — so check what is actually live rather than what was committed:

```
curl -s https://g-trade-pi.vercel.app/ | grep -o 'assets/index-[^"]*\.js'
curl -s https://g-trade-pi.vercel.app/assets/index-<hash>.js | grep -o 'https://[a-z0-9.-]*onrender\.com'
```

The second command must print `https://g-trade-backend.onrender.com`. If it prints a
different host — or nothing — the live bundle is not built from this commit: check
*Deployments* for a failed build, and that the project is connected to the `main` branch of
`nafih345/G-TRADE`.

### Repointing a deployed frontend without rebuilding

Because the backend URL is baked into the bundle at build time, a stuck or stale deployment
cannot normally be aimed somewhere else. The escape hatch is a `localStorage` override read
by `resolveApiBaseUrl()` — in the browser console on the live site:

```js
localStorage.setItem('api_base_url', 'https://some-other-backend.onrender.com')
location.reload()
// localStorage.removeItem('api_base_url') to go back to the built-in default
```

It is per-browser, so it is a diagnostic and a stopgap, not a deployment mechanism.

### If the backend is down, the app now says so

A red bar across the top of every screen reports an unreachable or database-less backend,
quoting the API address and `/api/health/`'s own explanation. Before it existed, a total
outage looked exactly like a business with no data yet: the dashboard read "₹0.00" and
"System Operations Normal" while every request behind it returned 500.

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

**Render's free plan has no shell**, so run it from your own machine against the same Neon
connection string the service uses:

```
# PowerShell
$env:DATABASE_URL = "postgresql://user:pass@ep-xxxx.ap-southeast-1.aws.neon.tech/neondb?sslmode=require"
cd backend; python manage.py wipe_database
```

`settings.py` honours an explicit `sslmode=` in the URL, and enables `sslmode=require` by
itself for any host with a dot in it — which every Neon host has.

A freshly provisioned database is already empty, so you only need this to re-clear later.

---

## Known limitations

- **Never move the database back onto Render's free tier.** It is deleted 30 days after
  creation and takes the data with it. `render.yaml` deliberately declares no `databases:`
  block so that timer cannot be restarted by accident; `DATABASE_URL` points at Neon.
- **Neon suspends an idle free database**, so the first query after a quiet spell costs a
  second or two. That is latency, not data loss.
- **The backend URL is baked into the frontend bundle at build time.** Changing it means a
  rebuild *and* a successful deploy; the `api_base_url` localStorage override is the
  stopgap when that is not possible.
- **Uploaded files are ephemeral.** `MEDIA_ROOT` is on the container filesystem, so product
  images and the company logo used on printed bills survive only until the next deploy or
  restart. Object storage (S3/Cloudinary) is the durable fix.
- `AUTO_MIGRATE=True` stays on as a safety net, but `build.sh` already migrates on release —
  the schema should never trail the code again.
