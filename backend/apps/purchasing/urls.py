from django.urls import path, include
from rest_framework.routers import DefaultRouter
from .views import SupplierViewSet, PurchaseOrderViewSet, PurchaseInvoiceViewSet

router = DefaultRouter()
router.register('suppliers', SupplierViewSet)
router.register('orders', PurchaseOrderViewSet)
router.register('invoices', PurchaseInvoiceViewSet, basename='purchase-invoice')

urlpatterns = [
    path('', include(router.urls)),
]
