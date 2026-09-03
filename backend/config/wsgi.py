import os
from django.core.wsgi import get_wsgi_application

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')

application = get_wsgi_application()

# Cloud deploys (Vercel) ship code only — nothing else runs `migrate` against the
# production database. Apply any pending migrations on boot so a release can't leave the
# code ahead of the schema (see apps/common/startup.py). No-op when already migrated or
# when AUTO_MIGRATE is disabled.
try:
    from apps.common.startup import run_startup_migrations
    run_startup_migrations()
except Exception:  # never let migration bootstrap break serving
    pass
