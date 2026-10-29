from django.urls import path, include
from rest_framework.routers import DefaultRouter

from . import views
from .banks import bank_accounts_view, bank_master_detail_view, bank_master_list_view

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
    path('bank-accounts/', bank_accounts_view),
    path('banks/', bank_master_list_view),
    path('banks/<uuid:pk>/', bank_master_detail_view),
    path('reports/trial-balance/', views.trial_balance_view),
    path('reports/profit-loss/', views.profit_loss_view),
    path('reports/balance-sheet/', views.balance_sheet_view),
    path('reports/general-ledger/', views.general_ledger_view),
    path('reports/ledger-register/', views.ledger_register_view),
    path('reports/cashbook/', views.cashbook_view),
    path('reports/cashbook/accounts/', views.cashbook_accounts_view),
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
    path('settlements/parties/', views.settlement_parties_view),
    path('settlements/due-bills/', views.settlement_due_bills_view),
    path('settlements/receipt/', views.settlement_receipt_view),
    path('settlements/payment/', views.settlement_payment_view),
    path('settlements/batch/<str:voucher>/', views.settlement_batch_view),
    path('cheques/', views.cheque_register_view),
    path('cheques/<uuid:pk>/', views.cheque_detail_view),
    path('', include(router.urls)),
]
