from django.urls import path, include
from rest_framework.routers import DefaultRouter
from .views import CustomerViewSet, InvoiceViewSet, EyeExaminationViewSet

router = DefaultRouter()
router.register('customers', CustomerViewSet)
router.register('eye-examinations', EyeExaminationViewSet)
router.register('invoices', InvoiceViewSet)

urlpatterns = [
    path('', include(router.urls)),
]
