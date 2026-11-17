import os
from django.contrib import admin
from django.urls import path, include
from django.http import JsonResponse, HttpResponse

from apps.common.edition import product_name

def home_api_status(request):
    return JsonResponse({
        "status": "online",
        "message": f"{product_name()} backend API server is running."
    })

def favicon_silent_view(request):
    return HttpResponse(status=204) # No Content to silence the warning log

from django.conf import settings
from django.conf.urls.static import static
from apps.security.urls import security_urlpatterns, backup_urlpatterns

_migrations_known_current = False
_db_instance = None
API_VERSION = 2


def _database_instance_id():
    """Stable identity of the database's *contents*, for browsers to key their caches on.

    Browsers mirror sales, patients, suppliers… into localStorage and merge those copies back
    into API results. When the service is repointed at a different database (DATABASE_URL
    swapped from `neondb` to `Uae client` on 2026-10-30) the old copies kept resurfacing.
    Host + name can't be the identity: copying the database to another region
    (scripts/copy_database.py) changes the host but not the data. The first row of
    django_migrations is written when a database is born and travels with a dump/restore, so
    it tells a copy (same id) from a different database (new id). One query per process.
    """
    global _db_instance
    if _db_instance is None:
        import hashlib
        from django.db.migrations.recorder import MigrationRecorder
        first = MigrationRecorder.Migration.objects.order_by('applied', 'id').first()
        if first is not None:
            _db_instance = hashlib.sha256(f'{first.id}:{first.applied.isoformat()}'.encode()).hexdigest()[:16]
    return _db_instance


def health_live_view(request):
    """Liveness only: "this process is up and serving". Touches no database, on purpose.

    Render's health checker calls its healthCheckPath every few seconds for as long as the
    service runs. Pointed at /api/health/ (≈10 queries, each a cross-region round trip) that
    meant: Neon could never suspend while Render was awake (burning the free compute quota),
    and whenever the database answered slowly — Neon waking, a network blip — the *web*
    service failed its health check and Render pulled it from routing or restarted it, turning
    a slow database into "Cannot reach the server". Restarting the web process never fixes a
    database problem, so the database is not part of liveness. /api/health/ keeps reporting
    database, migrations and the rest for people and the frontend banner.
    """
    response = JsonResponse({"status": "ok", "commit": (os.environ.get('RENDER_GIT_COMMIT') or '')[:7] or None})
    response['Cache-Control'] = 'no-store'
    return response


def _edition_health():
    """Extra /api/health/ fields for the Windows local edition (nothing secret, no install paths)."""
    if getattr(settings, 'GTRADE_EDITION', 'cloud') != 'local':
        return {"edition": "cloud"}
    out = {
        "edition": "local",
        "mode": getattr(settings, 'GTRADE_MODE', ''),
        "server_version": getattr(settings, 'GTRADE_VERSION', ''),
        "min_client_version": getattr(settings, 'GTRADE_MIN_CLIENT_VERSION', ''),
        "install_id": getattr(settings, 'GTRADE_INSTALL_ID', ''),
    }
    try:
        from apps.common.edition import local_health_extras
        out.update(local_health_extras())
    except Exception as exc:  # never break the health endpoint
        out["extras_error"] = type(exc).__name__
    return out


def health_check_view(request):
    from django.db import connection
    db_status = "connected"
    try:
        connection.ensure_connection()
    except Exception as e:
        db_status = f"error: {str(e)}"
    expected_name = getattr(settings, 'EXPECTED_DATABASE_NAME', None)
    actual_name = str(settings.DATABASES.get('default', {}).get('NAME', ''))
    wrong_database = bool(expected_name) and actual_name != expected_name

    # Pending migrations are the usual reason the deployed app breaks after a release
    # (code ahead of schema — e.g. the Multi-Branch columns/tables). Surface them here so
    # the state is checkable without server-log access.
    # Building the migration graph is the heaviest thing this endpoint does (CPU on a 0.1-vCPU
    # host, plus queries), and it is hit constantly by Render's health probe and the frontend's
    # keep-awake ping. Migrations only change when the process is (re)deployed or migrates on
    # boot, so once this process has seen them up to date that answer stands for its lifetime.
    global _migrations_known_current
    pending_migrations = []
    migrations_status = "up_to_date"
    if not _migrations_known_current and db_status == "connected":
        try:
            from django.db import connections, DEFAULT_DB_ALIAS
            from django.db.migrations.executor import MigrationExecutor
            executor = MigrationExecutor(connections[DEFAULT_DB_ALIAS])
            plan = executor.migration_plan(executor.loader.graph.leaf_nodes())
            pending_migrations = [f"{m.app_label}.{m.name}" for m, _ in plan]
            if pending_migrations:
                migrations_status = "pending"
            else:
                _migrations_known_current = True
        except Exception as e:
            migrations_status = f"error: {str(e)}"
    elif db_status != "connected":
        migrations_status = "unknown (database unreachable)"

    multi_branch = None
    try:
        from apps.company.models import BusinessSettings, Branch
        multi_branch = {
            "enabled": bool(BusinessSettings.load().multi_branch_enabled),
            "branch_count": Branch.objects.count(),
            "has_default_branch": Branch.objects.filter(is_default=True).exists(),
        }
    except Exception as e:
        multi_branch = {"error": str(e)}

    data_reset_epoch = None
    try:
        from apps.common.models import DataResetMarker
        reset_at = DataResetMarker.current()
        data_reset_epoch = reset_at.isoformat() if reset_at else None
    except Exception:
        pass  # table not migrated yet — no wipe to report

    db_instance = None
    if db_status == "connected":
        try:
            db_instance = _database_instance_id()
        except Exception:
            pass  # not migrated at all yet

    # Which database the process actually resolved. Host, port, database name and TLS state
    # only — never the user, never the password. The outage this endpoint exists to catch was
    # the service booting against a DATABASE_URL whose Postgres had been deleted; without the
    # host echoed back there was no way to tell that from a transient connection failure.
    #
    # `source` names the environment variable the connection string came from, which
    # separates the two failures that look identical from outside: a DATABASE_URL that is
    # set but wrong, versus one the service never received at all.
    db_conf = settings.DATABASES.get('default', {})
    db_options = db_conf.get('OPTIONS') or {}
    db_target = {
        "engine": db_conf.get('ENGINE', '').rsplit('.', 1)[-1],
        "name": str(db_conf.get('NAME', '')),
        "host": db_conf.get('HOST') or '(local file)',
        "port": str(db_conf.get('PORT') or ''),
        "source": getattr(settings, 'DATABASE_SOURCE', None) or '(none - local config)',
        # Encryption state of the link. A public (dotted) host answering "disabled" means
        # credentials are crossing the internet in the clear — visible here rather than never.
        "sslmode": db_options.get('sslmode') or 'disabled',
        # Connection reuse. Pooling a connection to a provider that suspends when idle needs
        # conn_health_checks true, or the first request after a quiet spell fails.
        "conn_max_age": db_conf.get('CONN_MAX_AGE') or 0,
        "conn_health_checks": bool(db_conf.get('CONN_HEALTH_CHECKS', False)),
    }

    if wrong_database and db_status == "connected":
        # Starts with "error" so the frontend banner quotes it (utils/backendStatus.js).
        db_status = (f"error: connected to database '{actual_name}', but this deployment expects "
                     f"'{expected_name}' (EXPECTED_DATABASE_NAME) - check DATABASE_URL on the service")

    return JsonResponse({
        "status": "ok" if db_status == "connected" and migrations_status == "up_to_date" else "degraded",
        "database": db_status,
        "db_target": db_target,
        # DEBUG must be false on any deployed instance; surfaced so a misconfigured
        # deploy is visible from outside instead of only via a leaked traceback page.
        "debug": settings.DEBUG,
        "migrations": migrations_status,
        "pending_migrations": pending_migrations,
        # Whether this instance is answering every Origin or only the configured
        # frontends. Origins are public information (the browser sends them in the clear);
        # no credential is exposed by naming them, and a deploy that silently fell back to
        # allow-all because FRONTEND_ORIGINS was unset is otherwise invisible from outside.
        "cors": getattr(settings, 'CORS_POLICY', 'unknown'),
        "allowed_origins": list(getattr(settings, 'CORS_ALLOWED_ORIGINS', [])),
        "multi_branch": multi_branch,
        # Last wipe_database run; browsers clear their cached records when this changes.
        "data_reset_epoch": data_reset_epoch,
        # Which database this is (see _database_instance_id); browsers drop their cached
        # records when it changes.
        "db_instance": db_instance,
        "app":"Optical ERP Backend",
        "version": "1.0.0",
        # Bumped whenever the frontend starts depending on new endpoints. The frontend compares
        # it with its own REQUIRED_API_VERSION (utils/backendStatus.js) and says "the backend is
        # an older release" instead of failing screen by screen with 404s when only one of the
        # two hosts redeployed. 2 = store profile, localization, stock overview, security/backups.
        "api_version": API_VERSION,
        # The commit this process was built from (Render / Vercel set these), so which build is
        # live can be checked from outside without dashboard access.
        "commit": (os.environ.get('RENDER_GIT_COMMIT') or os.environ.get('VERCEL_GIT_COMMIT_SHA') or '')[:7] or None,
        # "cloud" or "local" (Windows edition). Additive; the cloud frontend ignores it.
        **_edition_health(),
    })

urlpatterns = [
    path('', home_api_status),
    path('favicon.ico', favicon_silent_view),
    path('admin/', admin.site.urls),
    path('api/health/live/', health_live_view),
    path('api/health/', health_check_view),
    path('api/auth/', include('apps.authentication.urls')),
    path('api/superadmin/', include('apps.common.superadmin_urls')),
    path('api/organization/', include('apps.common.organization_urls')),  # Phase 2 multi-company
    path('api/company/', include('apps.company.urls')),
    path('api/billing/', include('apps.billing.urls')),
    path('api/masters/', include('apps.masters.urls')),
    path('api/products/', include('apps.products.urls')),
    path('api/import/', include('apps.products.import_urls')),
    path('api/inventory/', include('apps.inventory.urls')),
    path('api/purchase/', include('apps.purchasing.urls')),
    path('api/sales/', include('apps.sales.urls')),
    path('api/accounts/', include('apps.accounts.urls')),
    path('api/financial/', include('apps.financial.urls')),
    path('api/security/', include(security_urlpatterns)),
    path('api/backups/', include(backup_urlpatterns)),
]

if getattr(settings, 'GTRADE_EDITION', '') == 'local':
    # Django admin is neither tenant-scoped nor audited. The Windows edition's only superuser is the
    # Local Super Admin, who works through Client Management (scoped, audited), so /admin/ is off.
    urlpatterns = [p for p in urlpatterns if str(p.pattern) != 'admin/']
    from apps.common.local_views import ServerBackupsView
    urlpatterns += [path('api/licensing/', include('apps.licensing.urls')),
                    path('api/local/backups/', ServerBackupsView.as_view())]

# The Windows local edition (config/settings_local.py) has DEBUG off and no cloud flag, but nginx
# proxies /media/ here so the same public-only rule applies.
if settings.DEBUG or getattr(settings, 'IS_CLOUD', False) or getattr(settings, 'GTRADE_EDITION', '') == 'local':
    # Uploaded files. On Render/Vercel there is no nginx in front of the app and `static()` is a
    # no-op once DEBUG=False, so MEDIA_ROOT is wired up here for both cases.
    #
    # P1 Task 2: only *public* images (product images, company logos) are served from /media/.
    # Supplier bills and import spreadsheets live under private/ (or the legacy private
    # folders) and answer 404 here; they are downloaded through authenticated, object-checked
    # endpoints (e.g. /api/purchase/invoices/<id>/attachment/) or a 60-second signed link.
    #
    # NOTE: the filesystem on these hosts is ephemeral: files uploaded at runtime are lost on
    # the next deploy or restart. Moving MEDIA to object storage is the durable fix.
    from django.urls import re_path as _re_path
    from apps.common.media_paths import public_media_view as _public_media

    urlpatterns += [
        _re_path(r'^media/(?P<path>.*)$', _public_media),
    ]

