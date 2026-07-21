from django.contrib import admin
from django.urls import path, include
from django.http import JsonResponse, HttpResponse

def home_api_status(request):
    return JsonResponse({
        "status": "online",
        "message": "VisionERP Django Backend API Server is running successfully."
    })

def favicon_silent_view(request):
    return HttpResponse(status=204) # No Content to silence the warning log

from django.conf import settings
from django.conf.urls.static import static

urlpatterns = [
    path('', home_api_status),
    path('favicon.ico', favicon_silent_view),
    path('admin/', admin.site.urls),
    path('api/auth/', include('apps.authentication.urls')),
    path('api/company/', include('apps.company.urls')),
    path('api/masters/', include('apps.masters.urls')),
    path('api/products/', include('apps.products.urls')),
    path('api/inventory/', include('apps.inventory.urls')),
    path('api/purchase/', include('apps.purchasing.urls')),
    path('api/sales/', include('apps.sales.urls')),
    path('api/accounts/', include('apps.accounts.urls')),
]

if settings.DEBUG:
    urlpatterns += static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)

