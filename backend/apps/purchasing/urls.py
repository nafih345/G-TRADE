from django.urls import path, include
from rest_framework.routers import DefaultRouter
from .views import SupplierViewSet, PurchaseOrderViewSet

router = DefaultRouter()
router.register('suppliers', SupplierViewSet)
router.register('orders', PurchaseOrderViewSet)

urlpatterns = [
    path('', include(router.urls)),
]
