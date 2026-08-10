from rest_framework import viewsets, permissions
from rest_framework.serializers import ModelSerializer
from .models import (
    Customer, Invoice, InvoiceItem, EyeExamination,
    Dealer, WholesalePriceList, WholesaleQuotation, WholesaleOrder,
    WholesaleDeliveryChallan, WholesaleInvoice, WholesalePaymentCollection, WholesaleReturn
)
from apps.inventory.models import StockLedger

class CustomerSerializer(ModelSerializer):
    class Meta:
        model = Customer
        fields = '__all__'

class EyeExaminationSerializer(ModelSerializer):
    class Meta:
        model = EyeExamination
        fields = '__all__'

class InvoiceItemSerializer(ModelSerializer):
    class Meta:
        model = InvoiceItem
        fields = '__all__'

class InvoiceSerializer(ModelSerializer):
    items = InvoiceItemSerializer(many=True, read_only=True)

    class Meta:
        model = Invoice
        fields = '__all__'

class CustomerViewSet(viewsets.ModelViewSet):
    queryset = Customer.objects.all()
    serializer_class = CustomerSerializer
    permission_classes = [permissions.IsAuthenticated]

class EyeExaminationViewSet(viewsets.ModelViewSet):
    queryset = EyeExamination.objects.all().order_by('-examination_date')
    serializer_class = EyeExaminationSerializer
    permission_classes = [permissions.AllowAny]

class InvoiceViewSet(viewsets.ModelViewSet):
    queryset = Invoice.objects.all()
    serializer_class = InvoiceSerializer
    permission_classes = [permissions.IsAuthenticated]

    def perform_create(self, serializer):
        invoice = serializer.save()
        if invoice.status != 'DRAFT' and invoice.status != 'CANCELLED':
            self._update_inventory(invoice)

    def perform_update(self, serializer):
        invoice = serializer.save()
        if invoice.status != 'DRAFT' and invoice.status != 'CANCELLED':
            self._update_inventory(invoice)

    def _update_inventory(self, invoice):
        # Subtract stock from default warehouse
        from apps.company.models import Warehouse
        warehouse = Warehouse.objects.first()
        if not warehouse:
            return

        for item in invoice.items.all():
            if not StockLedger.objects.filter(reference_id=invoice.id, product=item.product).exists():
                StockLedger.objects.create(
                    product=item.product,
                    warehouse=warehouse,
                    quantity=-item.quantity,
                    transaction_type='OUT',
                    reference_id=invoice.id,
                    notes=f"Sold via Invoice {invoice.invoice_number}"
                )

import os
import requests
from rest_framework.decorators import api_view, permission_classes
from rest_framework.response import Response

@api_view(['POST'])
@permission_classes([permissions.AllowAny])
def send_whatsapp_automated_bg(request):
    """
    Automated Background WhatsApp Dispatch Gateway.
    Supports Meta WhatsApp Cloud API and Twilio API for direct phone delivery.
    """
    phone = request.data.get('phone', '')
    message = request.data.get('message', '')
    patient_name = request.data.get('patient', '')
    msg_type = request.data.get('type', 'confirmation')

    meta_token = os.environ.get('WHATSAPP_CLOUD_API_TOKEN', '')
    meta_phone_id = os.environ.get('WHATSAPP_PHONE_ID', '')
    
    twilio_sid = os.environ.get('TWILIO_ACCOUNT_SID', '')
    twilio_auth = os.environ.get('TWILIO_AUTH_TOKEN', '')
    twilio_phone = os.environ.get('TWILIO_WHATSAPP_NUMBER', '')

    api_sent = False
    api_provider = "System Dispatcher"

    # Meta Cloud API Integration
    if meta_token and meta_phone_id:
        try:
            url = f"https://graph.facebook.com/v18.0/{meta_phone_id}/messages"
            headers = {
                "Authorization": f"Bearer {meta_token}",
                "Content-Type": "application/json"
            }
            payload = {
                "messaging_product": "whatsapp",
                "to": phone,
                "type": "text",
                "text": { "body": message }
            }
            res = requests.post(url, json=payload, headers=headers, timeout=5)
            if res.status_code == 200:
                api_sent = True
                api_provider = "Meta WhatsApp Cloud API"
        except Exception as e:
            print(f"[WHATSAPP META API ERROR]: {e}")

    # Twilio WhatsApp API Integration
    elif twilio_sid and twilio_auth and twilio_phone:
        try:
            url = f"https://api.twilio.com/2010-04-01/Accounts/{twilio_sid}/Messages.json"
            data = {
                "From": f"whatsapp:{twilio_phone}",
                "To": f"whatsapp:+{phone}",
                "Body": message
            }
            res = requests.post(url, data=data, auth=(twilio_sid, twilio_auth), timeout=5)
            if res.status_code in [200, 201]:
                api_sent = True
                api_provider = "Twilio WhatsApp API"
        except Exception as e:
            print(f"[TWILIO WHATSAPP API ERROR]: {e}")

    print(f"[WHATSAPP DISPATCH] ({api_provider}) Dispatched {msg_type} to {phone} for {patient_name}")
    
    return Response({
        "status": "success",
        "api_sent": api_sent,
        "provider": api_provider,
        "message": f"WhatsApp {msg_type} processed for +{phone}",
        "phone": phone,
        "patient": patient_name
    })


# ==========================================
# WHOLESALE MODULE SERIALIZERS & VIEWSETS
# ==========================================

class DealerSerializer(ModelSerializer):
    class Meta:
        model = Dealer
        fields = '__all__'

class WholesalePriceListSerializer(ModelSerializer):
    class Meta:
        model = WholesalePriceList
        fields = '__all__'

class WholesaleQuotationSerializer(ModelSerializer):
    class Meta:
        model = WholesaleQuotation
        fields = '__all__'

class WholesaleOrderSerializer(ModelSerializer):
    class Meta:
        model = WholesaleOrder
        fields = '__all__'

class WholesaleDeliveryChallanSerializer(ModelSerializer):
    class Meta:
        model = WholesaleDeliveryChallan
        fields = '__all__'

class WholesaleInvoiceSerializer(ModelSerializer):
    class Meta:
        model = WholesaleInvoice
        fields = '__all__'

class WholesalePaymentCollectionSerializer(ModelSerializer):
    class Meta:
        model = WholesalePaymentCollection
        fields = '__all__'

class WholesaleReturnSerializer(ModelSerializer):
    class Meta:
        model = WholesaleReturn
        fields = '__all__'


class DealerViewSet(viewsets.ModelViewSet):
    queryset = Dealer.objects.all()
    serializer_class = DealerSerializer
    permission_classes = [permissions.AllowAny]

class WholesalePriceListViewSet(viewsets.ModelViewSet):
    queryset = WholesalePriceList.objects.all()
    serializer_class = WholesalePriceListSerializer
    permission_classes = [permissions.AllowAny]

class WholesaleQuotationViewSet(viewsets.ModelViewSet):
    queryset = WholesaleQuotation.objects.all()
    serializer_class = WholesaleQuotationSerializer
    permission_classes = [permissions.AllowAny]

class WholesaleOrderViewSet(viewsets.ModelViewSet):
    queryset = WholesaleOrder.objects.all()
    serializer_class = WholesaleOrderSerializer
    permission_classes = [permissions.AllowAny]

class WholesaleDeliveryChallanViewSet(viewsets.ModelViewSet):
    queryset = WholesaleDeliveryChallan.objects.all()
    serializer_class = WholesaleDeliveryChallanSerializer
    permission_classes = [permissions.AllowAny]

class WholesaleInvoiceViewSet(viewsets.ModelViewSet):
    queryset = WholesaleInvoice.objects.all()
    serializer_class = WholesaleInvoiceSerializer
    permission_classes = [permissions.AllowAny]

class WholesalePaymentCollectionViewSet(viewsets.ModelViewSet):
    queryset = WholesalePaymentCollection.objects.all()
    serializer_class = WholesalePaymentCollectionSerializer
    permission_classes = [permissions.AllowAny]

class WholesaleReturnViewSet(viewsets.ModelViewSet):
    queryset = WholesaleReturn.objects.all()
    serializer_class = WholesaleReturnSerializer
    permission_classes = [permissions.AllowAny]

