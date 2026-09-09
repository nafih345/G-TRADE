from django.urls import path, include
from rest_framework.routers import DefaultRouter

from .views import (
    BillTemplateViewSet, DocumentTemplateAssignmentViewSet,
    BillingSettingsView, DocumentTypeListView,
)

router = DefaultRouter()
router.register('templates', BillTemplateViewSet, basename='bill-template')
router.register('assignments', DocumentTemplateAssignmentViewSet, basename='bill-assignment')

urlpatterns = [
    path('settings/', BillingSettingsView.as_view(), name='billing-settings'),
    path('document-types/', DocumentTypeListView.as_view(), name='billing-document-types'),
    path('', include(router.urls)),
]
