from django.urls import path, include
from rest_framework.routers import DefaultRouter
from .views import AccountGroupViewSet, ChartOfAccountViewSet, VoucherTypeViewSet, JournalEntryViewSet, LedgerEntryViewSet

router = DefaultRouter()
router.register(r'groups', AccountGroupViewSet, basename='account-group')
router.register(r'accounts', ChartOfAccountViewSet, basename='chart-of-account')
router.register(r'vouchers', VoucherTypeViewSet, basename='voucher-type')
router.register(r'journals', JournalEntryViewSet, basename='journal-entry')
router.register(r'ledger', LedgerEntryViewSet, basename='ledger-entry')

urlpatterns = [
    path('', include(router.urls)),
]
