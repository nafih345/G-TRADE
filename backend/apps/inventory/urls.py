from django.urls import path, include
from rest_framework.routers import DefaultRouter
from .views import StockLedgerViewSet, StockAdjustmentViewSet, WarehouseTransferViewSet
from .stock_overview import StockOverviewViewSet

router = DefaultRouter()
router.register('ledger', StockLedgerViewSet)
router.register('adjustments', StockAdjustmentViewSet)
router.register('transfers', WarehouseTransferViewSet)
router.register('stock-overview', StockOverviewViewSet, basename='stock-overview')

urlpatterns = [
    path('', include(router.urls)),
]
