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

    return JsonResponse({
        "status": "ok" if db_status == "connected" and migrations_status == "up_to_date" else "degraded",
        "database": db_status,
        "migrations": migrations_status,
        "pending_migrations": pending_migrations,
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

