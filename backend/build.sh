#!/usr/bin/env bash
# Render build step for the Django backend (see ../render.yaml).
#
# Everything the deployed database needs to be correct happens here, on the release that
# ships the code — not lazily on the first request. `migrate` in particular used to be
# nobody's job, which is how the deploy repeatedly ended up with code ahead of the schema.
set -o errexit
set -o pipefail
set -o nounset

pip install --upgrade pip
pip install -r requirements.txt

# WhiteNoise serves these; with DEBUG=False Django itself will not. This one stays fatal:
# it needs no database, so a failure here is a genuine code/asset fault.
python manage.py collectstatic --no-input

# The two database steps below are deliberately NOT allowed to fail the build.
#
# They talk to Postgres, and a database outage must not be able to freeze the code. That is
# not hypothetical on this service: when the old Render Postgres was deleted, `migrate`
# failed on every build, so Render kept serving a months-old release — the one release that
# still ran DEBUG=True and whose /api/health/ could not report what was wrong. The deploy
# could not be repaired by deploying, which is how the outage lasted weeks.
#
# Shipping anyway is both recoverable and visible: AUTO_MIGRATE retries the migration when
# the process boots (apps/common/startup.py), /api/health/ reports `"migrations": "pending"`
# with the migration names and echoes the database host it actually resolved, and the
# frontend's red BackendStatusBanner quotes that reason to the user. A refused deploy
# provides none of those, and silently preserves the broken release.
run_db_step() {
  if python manage.py "$@"; then
    return 0
  fi
  echo "=============================================================================="
  echo "WARNING: 'manage.py $*' FAILED — continuing the deploy anyway."
  echo "The database was unreachable or refused the change."
  echo "  * Check DATABASE_URL on this service (Render Dashboard > Environment)."
  echo "  * The app will retry on boot (AUTO_MIGRATE) and report the state at"
  echo "    /api/health/ — check \"database\", \"db_target\" and \"migrations\" there."
  echo "This step is non-fatal on purpose: a database outage must not be able to pin"
  echo "the service to an older release."
  echo "=============================================================================="
  return 0
}

run_db_step migrate --no-input

# Idempotent: creates the admin login only if DJANGO_SUPERUSER_* are set and no such user
# exists yet. A brand-new empty database has no users at all, so without this there is no
# way to log in.
run_db_step bootstrap_admin
