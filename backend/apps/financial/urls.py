from django.urls import path, include
from rest_framework.routers import DefaultRouter

from . import views

router = DefaultRouter()
router.register(r'groups', views.AccountGroupViewSet, basename='account-group')
router.register(r'accounts', views.ChartOfAccountViewSet, basename='chart-of-account')
router.register(r'vouchers', views.VoucherTypeViewSet, basename='voucher-type')
router.register(r'journals', views.JournalEntryViewSet, basename='journal-entry')
router.register(r'ledger', views.LedgerEntryViewSet, basename='ledger-entry')
router.register(r'integration/mappings', views.AccountMappingViewSet, basename='account-mapping')
router.register(r'integration/failures', views.PostingFailureViewSet, basename='posting-failure')
router.register(r'integration/periods', views.FiscalPeriodViewSet, basename='fiscal-period')
router.register(r'integration/audit-log', views.FinancialAuditLogViewSet, basename='financial-audit-log')

urlpatterns = [
    path('reports/trial-balance/', views.trial_balance_view),
    path('reports/profit-loss/', views.profit_loss_view),
    path('reports/balance-sheet/', views.balance_sheet_view),
    path('reports/general-ledger/', views.general_ledger_view),
    path('reports/account-balances/', views.account_balances_view),
    path('reports/source-breakdown/', views.source_breakdown_view),
    path('integration/status/', views.integration_status_view),
    path('integration/catalog/', views.catalog_view),
    path('integration/preview/', views.preview_view),
    path('integration/reconciliation/', views.reconciliation_view),
    path('integration/backfill/', views.backfill_view),
    path('integration/opening-balances/', views.opening_balances_view),
    path('integration/recompute-balances/', views.recompute_balances_view),
    path('integration/policy/', views.policy_view),
    path('', include(router.urls)),
]
