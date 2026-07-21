from django.urls import path, include
from rest_framework.routers import DefaultRouter
from .views import AccountViewSet, JournalEntryViewSet

router = DefaultRouter()
router.register('chart-of-accounts', AccountViewSet)
router.register('journal-entries', JournalEntryViewSet)

urlpatterns = [
    path('', include(router.urls)),
]
