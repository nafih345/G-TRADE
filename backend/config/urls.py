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
    
    return JsonResponse({
        "status": "ok",
        "database": db_status,
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

