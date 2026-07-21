from django.urls import path, include
from rest_framework.routers import DefaultRouter
from .views import (
    ProductCategoryViewSet, BrandViewSet, UnitViewSet,
    TaxViewSet, StorageRackViewSet
)

router = DefaultRouter()
router.register('categories', ProductCategoryViewSet)
router.register('brands', BrandViewSet)
router.register('units', UnitViewSet)
router.register('taxes', TaxViewSet)
router.register('racks', StorageRackViewSet)

urlpatterns = [
    path('', include(router.urls)),
]
