import time

from rest_framework import viewsets, permissions
from rest_framework.serializers import ModelSerializer, SerializerMethodField
from .models import (
    Customer, Invoice, InvoiceItem, Payment, EyeExamination, Appointment,
    Dealer, WholesalePriceList, WholesaleQuotation, WholesaleOrder,
    WholesaleDeliveryChallan, WholesaleInvoice, WholesalePaymentCollection, WholesaleReturn
)
from .patient_utils import reserve_patient_codes
from apps.inventory.models import StockLedger

class CustomerSerializer(ModelSerializer):
    class Meta:
        model = Customer
        fields = '__all__'

class EyeExaminationSerializer(ModelSerializer):
    class Meta:
        model = EyeExamination
        fields = '__all__'

class AppointmentSerializer(ModelSerializer):
    # Read-only convenience field so the frontend doesn't have to separately look up the
    # linked Customer just to show its human-readable Patient ID (e.g. in the booking dialog
    # and appointment list) — the `customer` field itself is just the FK's UUID.
    patient_code = SerializerMethodField()

    class Meta:
        model = Appointment
        fields = '__all__'

    def get_patient_code(self, obj):
        return obj.customer.patient_code if obj.customer_id and obj.customer else None

class InvoiceItemSerializer(ModelSerializer):
    class Meta:
        model = InvoiceItem
        fields = '__all__'

class InvoiceSerializer(ModelSerializer):
    # Read-only here — `items` is a reverse FK relation, and ModelSerializer can't write nested
    # relations without a custom create()/update(). InvoiceViewSet.perform_create/perform_update
    # handle the nested item list manually instead, reading it straight from request.data.
    items = InvoiceItemSerializer(many=True, read_only=True)

    class Meta:
        model = Invoice
        fields = '__all__'

class PaymentSerializer(ModelSerializer):
    class Meta:
        model = Payment
        fields = '__all__'

class CustomerViewSet(viewsets.ModelViewSet):
    queryset = Customer.objects.all()
    serializer_class = CustomerSerializer
    # AllowAny to match every other ViewSet in this app (Product, PurchaseInvoice,
    # EyeExamination, ...) — this was previously IsAuthenticated while nothing else was,
    # which meant a request with a not-quite-valid token failed with 401 and, because the
    # frontend's save call swallows that error, silently dropped the patient record entirely.
    permission_classes = [permissions.AllowAny]

    def perform_create(self, serializer):
        # Assign a real, backend-guaranteed-unique "P-xxxx" code if the client didn't send
        # one (or sent a placeholder that collides with someone else's) — this is the single
        # source of truth every page should now defer to instead of each guessing locally.
        #
        # Collision check must use all_objects, not the default soft-delete-filtered manager:
        # BaseUUIDModel.delete() only sets is_deleted=True, it never removes the row, so a
        # soft-deleted Customer's patient_code still occupies the column's real DB-level UNIQUE
        # constraint even though Customer.objects (and therefore .exists()) no longer sees it.
        # Checking only the active manager let a client-previewed code that collided with a
        # soft-deleted row sail past this check and then hit an unhandled IntegrityError (500)
        # on the actual INSERT.
        patient_code = serializer.validated_data.get('patient_code')
        if not patient_code or Customer.all_objects.filter(patient_code=patient_code).exists():
            patient_code = reserve_patient_codes()[0]
        serializer.save(patient_code=patient_code)

class EyeExaminationViewSet(viewsets.ModelViewSet):
    queryset = EyeExamination.objects.all().order_by('-examination_date')
    serializer_class = EyeExaminationSerializer
    permission_classes = [permissions.AllowAny]

class AppointmentViewSet(viewsets.ModelViewSet):
    queryset = Appointment.objects.all()
    serializer_class = AppointmentSerializer
    permission_classes = [permissions.AllowAny]

    def perform_create(self, serializer):
        appointment_code = serializer.validated_data.get('appointment_code')
        if not appointment_code:
            import time
            appointment_code = f"APT-{int(time.time()) % 1000000}"
        serializer.save(appointment_code=appointment_code)

class InvoiceViewSet(viewsets.ModelViewSet):
    queryset = Invoice.objects.all()
    serializer_class = InvoiceSerializer
    # AllowAny to match every other ViewSet in this app — was previously the one exception left
    # on IsAuthenticated, which combined with the frontend's demo-login mock token (see
    # apps.common.authentication.LenientJWTAuthentication) meant every "complete sale" POST from
    # New Sale / POS Billing failed with 401 and silently fell back to localStorage-only,
    # so retail sales never actually reached the database at all.
    permission_classes = [permissions.AllowAny]

    def perform_create(self, serializer):
        invoice_number = serializer.validated_data.get('invoice_number')
        if not invoice_number:
            invoice_number = f"INV-{int(time.time()) % 1000000}"
        invoice = serializer.save(invoice_number=invoice_number)
        self._save_items(invoice)
        if invoice.status not in ('DRAFT', 'CANCELLED'):
            self._update_inventory(invoice)

    def perform_update(self, serializer):
        invoice = serializer.save()
        # Item list is optional on update (e.g. a status-only PATCH from the Orders tab won't
        # include it) — only replace items when the client actually sent a new list.
        if 'items' in self.request.data:
            invoice.items.all().delete()
            self._save_items(invoice)
        if invoice.status not in ('DRAFT', 'CANCELLED'):
            self._update_inventory(invoice)

    def _save_items(self, invoice):
        # `items` is read-only on the serializer (see InvoiceSerializer) since ModelSerializer
        # can't write a reverse-FK nested list on its own — read the raw list straight from the
        # request body instead.
        for raw in self.request.data.get('items', []):
            InvoiceItem.objects.create(
                invoice=invoice,
                product_id=raw.get('product') or None,
                description=raw.get('description') or raw.get('name') or '',
                quantity=raw.get('quantity') or raw.get('qty') or 1,
                unit_price=raw.get('unit_price') or raw.get('price') or 0,
                tax_rate=raw.get('tax_rate') or raw.get('taxPercent') or 0,
                tax_amount=raw.get('tax_amount') or raw.get('tax') or 0,
                subtotal=raw.get('subtotal') or raw.get('total') or 0,
            )

    def _update_inventory(self, invoice):
        # Subtract stock from default warehouse
        from apps.company.models import Warehouse
        warehouse = Warehouse.objects.first()
        if not warehouse:
            return

        for item in invoice.items.all():
            # Custom/ad-hoc line items (no matching Product row) have nothing to deduct stock
            # from — only real catalog items move inventory.
            if not item.product_id:
                continue
            if not StockLedger.objects.filter(reference_id=invoice.id, product=item.product).exists():
                StockLedger.objects.create(
                    product=item.product,
                    warehouse=warehouse,
                    quantity=-item.quantity,
                    transaction_type='OUT',
                    reference_id=invoice.id,
                    notes=f"Sold via Invoice {invoice.invoice_number}"
                )

class PaymentViewSet(viewsets.ModelViewSet):
    queryset = Payment.objects.all()
    serializer_class = PaymentSerializer
    permission_classes = [permissions.AllowAny]

    def perform_create(self, serializer):
        receipt_no = serializer.validated_data.get('receipt_no')
        if not receipt_no:
            receipt_no = f"RCP-{int(time.time()) % 1000000}"
        serializer.save(receipt_no=receipt_no)

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

