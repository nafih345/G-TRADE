from rest_framework.routers import DefaultRouter

from apps.common.superadmin_views import TenantAdminViewSet

router = DefaultRouter()
router.register(r'tenants', TenantAdminViewSet, basename='superadmin-tenant')

urlpatterns = router.urls
