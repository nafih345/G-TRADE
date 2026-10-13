from django.urls import path, include
from rest_framework.routers import DefaultRouter
from .views import ProductViewSet
from .variant_views import ProductVariantGroupViewSet, ProductVariantTemplateViewSet

router = DefaultRouter()
router.register('items', ProductViewSet, basename='product-item')
router.register('products', ProductViewSet, basename='product')
router.register('variant-groups', ProductVariantGroupViewSet, basename='variant-group')
router.register('variant-templates', ProductVariantTemplateViewSet, basename='variant-template')

urlpatterns = [
    path('', include(router.urls)),
]
