from django.urls import path, include
from rest_framework.routers import DefaultRouter
from .views import (
    CompanyViewSet, BranchViewSet, WarehouseViewSet, NotificationViewSet,
    BusinessSettingsView, UserBranchAccessViewSet, BranchStockViewSet,
    StockTransferViewSet, branch_context,
)
from .store_profile import StoreProfileView
from .localization import LocalizationSettingsView, LocalizationCatalogView, SettingsAuditView
from .numbering import DocumentSequenceListView, DocumentSequenceDetailView, DocumentSequencePeekView
from .tax_config import TaxConfigListView, TaxConfigDetailView
from .custom_fields import CustomFieldListView, CustomFieldDetailView

router = DefaultRouter()
router.register('profile', CompanyViewSet, basename='company')
router.register('branches', BranchViewSet, basename='branch')
router.register('warehouses', WarehouseViewSet, basename='warehouse')
router.register('notifications', NotificationViewSet, basename='notification')
router.register('user-branch-access', UserBranchAccessViewSet, basename='user-branch-access')
router.register('branch-stock', BranchStockViewSet, basename='branch-stock')
router.register('stock-transfers', StockTransferViewSet, basename='stock-transfer')


urlpatterns = [
    path('store-profile/', StoreProfileView.as_view(), name='store-profile'),
    path('localization/', LocalizationSettingsView.as_view(), name='localization'),
    path('localization/catalog/', LocalizationCatalogView.as_view(), name='localization-catalog'),
    path('settings-audit/', SettingsAuditView.as_view(), name='settings-audit'),
    path('document-sequences/', DocumentSequenceListView.as_view(), name='document-sequences'),
    path('document-sequences/<str:doc_type>/', DocumentSequenceDetailView.as_view(), name='document-sequence'),
    path('document-sequences/<str:doc_type>/peek/', DocumentSequencePeekView.as_view(), name='document-sequence-peek'),
    path('tax-config/', TaxConfigListView.as_view(), name='tax-config'),
    path('tax-config/<uuid:pk>/', TaxConfigDetailView.as_view(), name='tax-config-detail'),
    path('custom-fields/', CustomFieldListView.as_view(), name='custom-fields'),
    path('custom-fields/<int:pk>/', CustomFieldDetailView.as_view(), name='custom-field-detail'),
    path('branch-context/', branch_context, name='branch-context'),
    path('business-settings/', BusinessSettingsView.as_view(), name='business-settings'),
    path('', include(router.urls)),
]
