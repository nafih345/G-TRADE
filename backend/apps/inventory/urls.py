from django.urls import path, include
from rest_framework.routers import DefaultRouter
from .views import StockLedgerViewSet, StockAdjustmentViewSet, WarehouseTransferViewSet
from .stock_overview import StockOverviewViewSet
from .opening_stock import OpeningStockViewSet

router = DefaultRouter()
router.register('ledger', StockLedgerViewSet)
router.register('adjustments', StockAdjustmentViewSet)
router.register('transfers', WarehouseTransferViewSet)
router.register('stock-overview', StockOverviewViewSet, basename='stock-overview')
router.register('opening-stock', OpeningStockViewSet, basename='opening-stock')

urlpatterns = [
    path('', include(router.urls)),
]
