from django.urls import path, include
from rest_framework.routers import DefaultRouter
from .views import CompanyViewSet, BranchViewSet, WarehouseViewSet, NotificationViewSet

router = DefaultRouter()
router.register('profile', CompanyViewSet, basename='company')
router.register('branches', BranchViewSet, basename='branch')
router.register('warehouses', WarehouseViewSet, basename='warehouse')
router.register('notifications', NotificationViewSet, basename='notification')


urlpatterns = [
    path('', include(router.urls)),
]
