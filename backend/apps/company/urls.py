from django.urls import path, include
from rest_framework.routers import DefaultRouter
from .views import CompanyViewSet, BranchViewSet, WarehouseViewSet

router = DefaultRouter()
router.register('profile', CompanyViewSet)
router.register('branches', BranchViewSet)
router.register('warehouses', WarehouseViewSet)

urlpatterns = [
    path('', include(router.urls)),
]
