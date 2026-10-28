from django.urls import path, include
from rest_framework.routers import DefaultRouter
from .views import SupplierViewSet, PurchaseOrderViewSet, PurchaseInvoiceViewSet
from .lens_orders import LensPurchaseOrderViewSet

router = DefaultRouter()
router.register('suppliers', SupplierViewSet)
router.register('orders', PurchaseOrderViewSet)
router.register('invoices', PurchaseInvoiceViewSet, basename='purchase-invoice')
router.register('lens-orders', LensPurchaseOrderViewSet, basename='lens-purchase-order')

urlpatterns = [
    path('', include(router.urls)),
]
