from django.urls import path
from rest_framework.routers import DefaultRouter

from apps.common.superadmin_data_views import ClientBackupDownloadView
from apps.common.superadmin_views import TenantAdminViewSet

router = DefaultRouter()
router.register(r'tenants', TenantAdminViewSet, basename='superadmin-tenant')

urlpatterns = router.urls + [
    path('backup-download/<uuid:pk>/', ClientBackupDownloadView.as_view(), name='superadmin-backup-download'),
]
