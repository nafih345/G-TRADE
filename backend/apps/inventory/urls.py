from django.urls import path, include
from rest_framework.routers import DefaultRouter
from .views import StockLedgerViewSet, StockAdjustmentViewSet, WarehouseTransferViewSet

router = DefaultRouter()
router.register('ledger', StockLedgerViewSet)
router.register('adjustments', StockAdjustmentViewSet)
router.register('transfers', WarehouseTransferViewSet)

urlpatterns = [
    path('', include(router.urls)),
]
