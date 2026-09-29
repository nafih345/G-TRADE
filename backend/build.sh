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

# WhiteNoise serves these; with DEBUG=False Django itself will not.
python manage.py collectstatic --no-input

python manage.py migrate --no-input

# Idempotent: creates the admin login only if DJANGO_SUPERUSER_* are set and no such user
# exists yet. A brand-new empty database has no users at all, so without this there is no
# way to log in.
python manage.py bootstrap_admin
