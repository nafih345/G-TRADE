import os
from django.core.wsgi import get_wsgi_application

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')

application = get_wsgi_application()

# Import every URLconf (and with it every app's views and serializers) now, at boot. Django does
# this lazily on the first request, so the first user after each wake-from-sleep paid for it —
# ~1.8 s on a desktop core, 15-20 s on the 0.1 vCPU host — on top of the boot itself. Under
# gunicorn's preload_app this runs once in the master and every worker inherits the result.
try:
    from django.urls import get_resolver
    get_resolver().reverse_dict  # populates the whole tree of include()d URL modules
except Exception:  # a broken URLconf will raise on the first request as it always did
    pass

# Cloud deploys (Vercel) ship code only — nothing else runs `migrate` against the
# production database. Apply any pending migrations on boot so a release can't leave the
# code ahead of the schema (see apps/common/startup.py). No-op when already migrated or
# when AUTO_MIGRATE is disabled.
try:
    from apps.common.startup import run_startup_migrations
    run_startup_migrations()
except Exception:  # never let migration bootstrap break serving
    pass

# Automatic database backups (apps/security/backup/scheduler.py): one daemon thread per server
# process; overlapping workers are safe because each run is claimed in the database first.
#
# Under gunicorn with preload_app (backend/gunicorn.conf.py) this module is imported in the master
# process, where a thread would be lost at fork — the config's post_fork hook starts it in each
# worker instead.
if not os.environ.get('GTRADE_GUNICORN_MASTER'):
    try:
        from apps.security.backup.scheduler import start_scheduler
        start_scheduler()
    except Exception:  # never let the scheduler break serving
        pass
