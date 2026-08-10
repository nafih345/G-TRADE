from django.urls import path, include
from rest_framework.routers import DefaultRouter
from .views import (
    CustomerViewSet, InvoiceViewSet, EyeExaminationViewSet, send_whatsapp_automated_bg,
    DealerViewSet, WholesalePriceListViewSet, WholesaleQuotationViewSet, WholesaleOrderViewSet,
    WholesaleDeliveryChallanViewSet, WholesaleInvoiceViewSet, WholesalePaymentCollectionViewSet, WholesaleReturnViewSet
)

router = DefaultRouter()
router.register('customers', CustomerViewSet)
router.register('eye-examinations', EyeExaminationViewSet)
router.register('invoices', InvoiceViewSet)

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
]
