from django.urls import path, include
from rest_framework.routers import DefaultRouter
from .barcode_config_views import BarcodeSeriesConfigView
from .views import ProductViewSet
from .variant_views import ProductVariantGroupViewSet, ProductVariantTemplateViewSet
from .label_views import (
    LabelTemplateViewSet, LabelPrintSettingsView, LabelLegacyImportView, LabelFieldsView, LabelDataView,
)

router = DefaultRouter()
router.register('items', ProductViewSet, basename='product-item')
router.register('products', ProductViewSet, basename='product')
router.register('variant-groups', ProductVariantGroupViewSet, basename='variant-group')
router.register('variant-templates', ProductVariantTemplateViewSet, basename='variant-template')
router.register('label-templates', LabelTemplateViewSet, basename='label-template')

urlpatterns = [
    path('barcode-config/', BarcodeSeriesConfigView.as_view(), name='barcode-config'),
    path('label-settings/', LabelPrintSettingsView.as_view(), name='label-settings'),
    path('label-settings/import-legacy/', LabelLegacyImportView.as_view(), name='label-settings-import-legacy'),
    path('label-fields/', LabelFieldsView.as_view(), name='label-fields'),
    path('label-data/', LabelDataView.as_view(), name='label-data'),
    path('', include(router.urls)),
]
