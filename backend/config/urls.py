from django.contrib import admin
from django.urls import path, include
from django.http import JsonResponse, HttpResponse

def home_api_status(request):
    return JsonResponse({
        "status": "online",
        "message": "Greensol Optical ERP Django Backend API Server is running successfully."
    })

def favicon_silent_view(request):
    return HttpResponse(status=204) # No Content to silence the warning log

from django.conf import settings
from django.conf.urls.static import static

def health_check_view(request):
    from django.db import connection
    db_status = "connected"
    try:
        connection.ensure_connection()
    except Exception as e:
        db_status = f"error: {str(e)}"

    # Pending migrations are the usual reason the deployed app breaks after a release
    # (code ahead of schema — e.g. the Multi-Branch columns/tables). Surface them here so
    # the state is checkable without server-log access.
    pending_migrations = []
    migrations_status = "up_to_date"
    try:
        from django.db import connections, DEFAULT_DB_ALIAS
        from django.db.migrations.executor import MigrationExecutor
        executor = MigrationExecutor(connections[DEFAULT_DB_ALIAS])
        plan = executor.migration_plan(executor.loader.graph.leaf_nodes())
        pending_migrations = [f"{m.app_label}.{m.name}" for m, _ in plan]
        if pending_migrations:
            migrations_status = "pending"
    except Exception as e:
        migrations_status = f"error: {str(e)}"

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
        "app": "Optical ERP Backend",
        "version": "1.0.0"
    })

urlpatterns = [
    path('', home_api_status),
    path('favicon.ico', favicon_silent_view),
    path('admin/', admin.site.urls),
    path('api/health/', health_check_view),
    path('api/auth/', include('apps.authentication.urls')),
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
]

if settings.DEBUG:
    urlpatterns += static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)
elif getattr(settings, 'IS_CLOUD', False):
    # `static()` above is a no-op once DEBUG=False, and there is no nginx in front of the
    # app on Render/Vercel — so uploaded files (product images, the company logo used on
    # every printed bill) would 404 in production with nothing serving them. WhiteNoise only
    # covers STATIC_ROOT, so wire MEDIA_ROOT up explicitly.
    #
    # NOTE: the filesystem on these hosts is ephemeral — files uploaded at runtime are lost
    # on the next deploy or restart. Moving MEDIA to object storage (S3/Cloudinary) is the
    # durable fix; this only makes uploads work for the life of a deploy.
    from django.views.static import serve as _serve
    from django.urls import re_path as _re_path

    urlpatterns += [
        _re_path(r'^media/(?P<path>.*)$', _serve, {'document_root': settings.MEDIA_ROOT}),
    ]

