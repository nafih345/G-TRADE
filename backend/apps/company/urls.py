from django.urls import path, include
from rest_framework.routers import DefaultRouter
from .views import (
    CompanyViewSet, BranchViewSet, WarehouseViewSet, NotificationViewSet,
    BusinessSettingsView, UserBranchAccessViewSet, BranchStockViewSet,
    StockTransferViewSet, branch_context,
)

router = DefaultRouter()
router.register('profile', CompanyViewSet, basename='company')
router.register('branches', BranchViewSet, basename='branch')
router.register('warehouses', WarehouseViewSet, basename='warehouse')
router.register('notifications', NotificationViewSet, basename='notification')
router.register('user-branch-access', UserBranchAccessViewSet, basename='user-branch-access')
router.register('branch-stock', BranchStockViewSet, basename='branch-stock')
router.register('stock-transfers', StockTransferViewSet, basename='stock-transfer')


urlpatterns = [
    path('branch-context/', branch_context, name='branch-context'),
    path('business-settings/', BusinessSettingsView.as_view(), name='business-settings'),
    path('', include(router.urls)),
]
