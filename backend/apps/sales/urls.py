from django.urls import path, include
from rest_framework.routers import DefaultRouter
from .dashboard import DashboardSummaryView
from .views import (
    CustomerViewSet, InvoiceViewSet, PaymentViewSet, EyeExaminationViewSet, AppointmentViewSet,
    ServiceViewSet, send_whatsapp_automated_bg,
    DealerViewSet, WholesalePriceListViewSet, WholesaleQuotationViewSet, WholesaleOrderViewSet,
    WholesaleDeliveryChallanViewSet, WholesaleInvoiceViewSet, WholesalePaymentCollectionViewSet, WholesaleReturnViewSet
)

router = DefaultRouter()
router.register('customers', CustomerViewSet)
router.register('eye-examinations', EyeExaminationViewSet)
router.register('appointments', AppointmentViewSet)
router.register('invoices', InvoiceViewSet)
router.register('payments', PaymentViewSet)
router.register('services', ServiceViewSet)
# Sales → Sales Return (apps/inventory/returns.py)
from apps.inventory.returns import SalesReturnViewSet  # noqa: E402
router.register('returns', SalesReturnViewSet, basename='sales-return')

# Wholesale endpoints
router.register('wholesale/customers', DealerViewSet, basename='wholesale-customer')
router.register('wholesale/dealers', DealerViewSet, basename='wholesale-dealer')
router.register('wholesale/price-lists', WholesalePriceListViewSet)
router.register('wholesale/quotations', WholesaleQuotationViewSet)
router.register('wholesale/orders', WholesaleOrderViewSet)
router.register('wholesale/challans', WholesaleDeliveryChallanViewSet)
router.register('wholesale/invoices', WholesaleInvoiceViewSet)
router.register('wholesale/collections', WholesalePaymentCollectionViewSet)
router.register('wholesale/returns', WholesaleReturnViewSet)

urlpatterns = [
    path('', include(router.urls)),
    path('whatsapp/send-automated/', send_whatsapp_automated_bg, name='send_whatsapp_automated'),
    path('dashboard-summary/', DashboardSummaryView.as_view(), name='dashboard-summary'),
]
