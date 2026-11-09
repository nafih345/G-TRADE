import secrets
import time
import uuid
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP

from django.db import IntegrityError, transaction
from django.db.models import DecimalField as ModelDecimalField, Prefetch, Q, prefetch_related_objects
from django.utils import timezone
from django.utils.dateparse import parse_datetime
from apps.authentication.edit_permissions import EditApprovalMixin
from apps.common.pagination import PageSizePagination
from rest_framework import viewsets, permissions, serializers
from rest_framework.decorators import action
from rest_framework.pagination import PageNumberPagination
from rest_framework.response import Response
from rest_framework.serializers import ModelSerializer, SerializerMethodField
from .models import (
    Customer, Invoice, InvoiceItem, Payment, EyeExamination, Appointment, Service,
    Dealer, WholesalePriceList, WholesaleQuotation, WholesaleOrder,
    WholesaleDeliveryChallan, WholesaleInvoice, WholesalePaymentCollection, WholesaleReturn,
    derive_payment_status, settle_payment_status, is_real_customer_name,
)
from .lens_units import (
    PAIR, SELLING_UNITS, clean_lens_line, incomplete_lens_lines, stock_units_by_product,
)
from .patient_utils import (
    reserve_patient_codes, peek_next_patient_code, peek_next_test_no, is_auto_patient_code,
    reserve_unused_test_numbers, sync_test_no_sequence,
    find_duplicate_customer, find_duplicate_exam,
)
from .eye_test_fees import derive_fee_fields, fee_exam_ids, sync_invoice_eye_test_fees
from .sales_report import build_sales_report, report_queryset
from .eye_test_report import build_billing_reference
from .eye_test_lookup import LOOKUP_LIMIT, discard_blockers, lookup_rows
from apps.inventory.models import StockLedger
from apps.inventory.stock_utils import adjust_branch_stock_many
from apps.common.branch_mixins import BranchScopedViewSetMixin
from apps.financial.banks import validate_bank_account

class SalesListPagination(PageSizePagination):
    """The site-wide page (settings PAGE_SIZE = 20) unless a screen asks for more with ?page_size=
    (up to 1000). The Sales screens read these lists whole; taking just the first page meant any
    bill, patient or receipt past the first 20 never appeared there — as if it had never saved."""
    page_size_query_param = 'page_size'
    max_page_size = 1000


class CustomerSerializer(ModelSerializer):
    # No auto UniqueValidator: a client's patient_code is only its on-screen preview, and
    # CustomerViewSet.perform_create/perform_update replace a taken one with a fresh code.
    # Rejecting it with 400 here made the Eye Test save silently skip creating the Customer and
    # file the exam under the stale preview — several patients ended up as P-1001.
    patient_code = serializers.CharField(required=False, allow_blank=True, allow_null=True,
                                         max_length=20, validators=[])

    class Meta:
        model = Customer
        fields = '__all__'

class EyeExaminationSerializer(ModelSerializer):
    # The partial UNIQUE constraint on test_no makes DRF auto-attach a UniqueValidator, but
    # that validator isn't condition-aware (it would reject a blank '' against legacy blank
    # rows) and, more to the point, uniqueness here is enforced server-side by
    # EyeExaminationViewSet.perform_create, which assigns the number itself and re-rolls on
    # the DB IntegrityError. A 400 from the serializer would just turn that graceful re-roll
    # into a failed save. Drop the auto validator.
    test_no = serializers.CharField(required=False, allow_blank=True, allow_null=True, max_length=20, validators=[])
    # "Pay during frame/lens purchase": the fee waits for the patient's next New Sale bill.
    # Input only — the stored outcome is fee_status (see eye_test_fees.derive_fee_fields).
    fee_deferred = serializers.BooleanField(write_only=True, required=False)
    fee_invoice_number = SerializerMethodField()
    fee_bank_account_name = serializers.CharField(source='fee_bank_account.name', read_only=True, default=None)

    class Meta:
        model = EyeExamination
        fields = '__all__'
        read_only_fields = ('fee_amount', 'fee_status', 'fee_invoice')

    def validate_fee_bank_account(self, value):
        return validate_bank_account(value)

    def get_fee_invoice_number(self, obj):
        return obj.fee_invoice.invoice_number if obj.fee_invoice_id and obj.fee_invoice else None

    def validate(self, attrs):
        attrs = super().validate(attrs)
        fee = derive_fee_fields(attrs, self.instance)
        attrs.pop('fee_deferred', None)
        attrs.update(fee)
        return attrs

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
    # The line's product, joined in by InvoiceViewSet.get_queryset (select_related), so a list can
    # show what was sold — `product` itself is just the FK UUID.
    product_name = SerializerMethodField()
    color = SerializerMethodField()
    brand = SerializerMethodField()
    category_name = SerializerMethodField()
    # What the Orders list / Sales dashboard call this line: colour + name ("Sky Blue Frame").
    display_name = SerializerMethodField()

    class Meta:
        model = InvoiceItem
        fields = '__all__'

    @staticmethod
    def _product(it):
        return it.product if it.product_id else None

    def get_product_name(self, it):
        product = self._product(it)
        return product.name if product is not None else None

    def get_color(self, it):
        return _product_colour(self._product(it)) or None

    def get_brand(self, it):
        product = self._product(it)
        if product is None:
            return None
        return product.brand_name or (product.brand.name if product.brand_id and product.brand else None)

    def get_category_name(self, it):
        product = self._product(it)
        if product is None:
            return None
        return (product.category.name if product.category_id and product.category else None) or product.category_name

    def get_display_name(self, it):
        return _item_display_name(it) or None


# Pay modes a bill can be split across at the counter: payment_splits key, Payment.method
# label, receipt-number code.
BILLING_PAY_MODES = (
    ('cash', 'Cash', 'CASH'),
    ('card', 'Card', 'CARD'),
    ('upi', 'UPI', 'UPI'),
    ('bank', 'Bank Transfer', 'BANK'),
)
BILLING_SOURCE = 'BILLING'
# Split modes whose money lands in a bank the cashier picks (see financial/banks.py).
# Digital / transfer modes: each must name the bank ledger the money lands in.
BANK_PAY_MODES = ('card', 'upi', 'bank')
_CENT = Decimal('0.01')


def _pay_mode_key(method):
    """payment_splits key for a Payment.method label. 'cash' is checked first (and blank counts
    as cash) to match how signals.py picks the Cash vs Bank account for the receipt."""
    m = (method or '').lower()
    if not m or 'cash' in m:
        return 'cash'
    if 'upi' in m or 'gpay' in m:
        return 'upi'
    if 'bank' in m or 'transfer' in m:
        return 'bank'
    if 'card' in m:
        return 'card'
    return 'cash'


def _is_uuid(value):
    try:
        uuid.UUID(str(value))
        return True
    except (ValueError, TypeError, AttributeError):
        return False


def _void_receipt(payment):
    # CANCELLED first: BaseUUIDModel.delete() is a soft delete that just re-saves the row, and
    # the receipt signal only reverses the journal entry of a cancelled (or zero) receipt.
    payment.status = 'CANCELLED'
    payment.delete()


# Receipt statuses that mean the money was never kept (the same ones signals.py reverses).
VOID_RECEIPT_STATUSES = ('CANCELLED', 'VOID', 'VOIDED', 'FAILED', 'REVERSED')


def _collected_later_total(invoice_id):
    """Money collected against a bill after it was made (Payments tab / Record Payment): every
    live receipt linked to it except the BILLING ones, which are already inside paid_amount."""
    total = Decimal('0')
    for p in Payment.objects.filter(invoice_id=invoice_id).exclude(source=BILLING_SOURCE):
        if (p.status or '').upper() not in VOID_RECEIPT_STATUSES:
            total += p.amount or 0
    return total


def _later_receipt_share(payment):
    """(invoice_id, amount) this receipt adds to its bill's Total Paid (Invoice.paid_amount)."""
    if (not payment.invoice_id or payment.source == BILLING_SOURCE or payment.is_deleted
            or (payment.status or '').upper() in VOID_RECEIPT_STATUSES):
        return payment.invoice_id, Decimal('0')
    return payment.invoice_id, Decimal(str(payment.amount or 0))


def _shift_invoice_paid(invoice_id, delta):
    """Move a bill's Total Paid by `delta` and re-derive its PAID / PARTIAL / UNPAID status.
    update() rather than save(): only the running total and its status change, so the bill's own
    sales journal entry needs no re-posting — the receipt posts its own."""
    if not invoice_id or not delta:
        return
    invoice = Invoice.all_objects.select_for_update().filter(pk=invoice_id).first()
    if invoice is None:
        return
    paid = max(Decimal(str(invoice.paid_amount or 0)) + delta, Decimal('0'))
    Invoice.all_objects.filter(pk=invoice_id).update(
        paid_amount=paid,
        status=settle_payment_status(invoice.status, invoice.net_amount, paid),
        updated_at=timezone.now(),
    )


def _looks_like_uuid(value):
    try:
        uuid.UUID(str(value))
    except (ValueError, TypeError, AttributeError):
        return False
    return True


# Line-item wording that marks a product as neither the frame nor the lens (so "Lens Cleaning
# Solution" isn't shown as the prescribed lens).
_ACCESSORY_WORDS = ('accessor', 'solution', 'cleaner', 'cleaning', 'cloth', 'spray', 'service', 'repair')
_FRAME_WORDS = ('frame', 'sunglass', 'goggle', 'spectacle')


def _classify_words(text):
    t = (text or '').lower()
    if any(w in t for w in _ACCESSORY_WORDS):
        return 'OTHER'
    if 'lens' in t:
        return 'LENS'
    if any(w in t for w in _FRAME_WORDS):
        return 'FRAME'
    return None


_COLOUR_KEYS = ('color', 'colour', 'color_code', 'colorcode')


def _product_colour(product):
    """The product's colour — its column, or for older imported rows extra_data (the same fallback
    ProductSerializer.get_colour uses)."""
    if product is None:
        return ''
    colour = (product.color or '').strip()
    if not colour and isinstance(product.extra_data, dict):
        colour = next((str(product.extra_data[k]).strip() for k in _COLOUR_KEYS
                       if product.extra_data.get(k) not in (None, '')), '')
    return colour


def _item_display_name(it):
    """What a line is called in lists: its billed description (or the product's name when that's
    blank or just an id), led by the product's colour. A shop's stock is often named just "Frame"
    or "Lens", so the colour is what tells one bill's frame from another's ("Sky Blue Frame")."""
    product = it.product if it.product_id else None
    name = ' '.join((it.description or '').split())
    if not name or _looks_like_uuid(name):
        name = ' '.join((product.name or '').split()) if product is not None else ''
    colour = _product_colour(product)
    if name and colour and colour.lower() not in name.lower():
        name = f'{colour} {name}'
    return name


class RoundedDecimalField(serializers.DecimalField):
    """Rounds extra decimal places instead of refusing them. Bill totals are summed in JS floats
    (0.1 + 0.2 = 0.30000000000000004); the stock DecimalField rejects those with a 400, and New
    Sale / POS Billing then kept the bill in the browser only — it never reached the database."""

    def validate_precision(self, value):
        if self.decimal_places is not None:
            try:
                value = value.quantize(Decimal(1).scaleb(-self.decimal_places), rounding=ROUND_HALF_UP)
            except InvalidOperation:
                pass  # too large to round — the max_digits check below reports it
        return super().validate_precision(value)


class InvoiceSerializer(ModelSerializer):
    # Money fields round to 2 places instead of 400-ing the whole bill (see RoundedDecimalField).
    serializer_field_mapping = {
        **ModelSerializer.serializer_field_mapping,
        ModelDecimalField: RoundedDecimalField,
    }

    # Read-only here — `items` is a reverse FK relation, and ModelSerializer can't write nested
    # relations without a custom create()/update(). InvoiceViewSet.perform_create/perform_update
    # handle the nested item list manually instead, reading it straight from request.data.
    items = InvoiceItemSerializer(many=True, read_only=True)

    # No auto UniqueValidator: InvoiceViewSet keeps the requested number when it's free and assigns
    # a fresh one when it isn't. New Sale predicts its number in the browser (4 random digits), so a
    # repeat used to fail the whole save with "invoice with this invoice number already exists".
    invoice_number = serializers.CharField(max_length=50, required=False, allow_blank=True, validators=[])

    # all_objects so a soft-deleted patient still resolves: editing a document from New Sale
    # re-sends its own customer, and a patient deleted after the bill was made used to fail that
    # update with "Invalid pk". validate_customer still refuses a deleted patient as a NEW link.
    customer = serializers.PrimaryKeyRelatedField(
        queryset=Customer.all_objects.all(), allow_null=True, required=False
    )

    # Read-only convenience fields so the Orders section list (and its Update dialog) can show
    # the real customer and frame/lens without a second lookup — `customer` itself is just the
    # FK UUID. (customer_name is the stored snapshot, Invoice.customer_name.)
    customer_phone = SerializerMethodField()
    customer_code = SerializerMethodField()
    frame_name = SerializerMethodField()
    lens_name = SerializerMethodField()
    # What was taken per pay mode at billing ({cash, card, upi, bank}, from the bill's BILLING
    # receipts) — New Sale's edit mode restores its Cash / Card / UPI / Bank boxes from this.
    payment_splits = SerializerMethodField()
    # Bank picked for the UPI / Bank Transfer boxes ({upi, bank}: ChartOfAccount id or None).
    payment_banks = SerializerMethodField()
    payment_references = SerializerMethodField()
    # Derived from paid_amount (Total Paid) vs net_amount on every read, so the badge can't
    # disagree with the figures: PAID (paid covers net) / PARTIAL / UNPAID (nothing paid).
    payment_status = SerializerMethodField()
    balance_due = SerializerMethodField()

    class Meta:
        model = Invoice
        fields = '__all__'

    def to_representation(self, instance):
        data = super().to_representation(instance)
        # Bills saved before the snapshot existed (or written outside this API) fall back to the
        # linked patient's name.
        if not is_real_customer_name(data.get('customer_name')):
            customer = instance.customer if instance.customer_id else None
            data['customer_name'] = customer.name if customer is not None and customer.name else ''
        return data

    def validate(self, attrs):
        attrs = super().validate(attrs)
        # A payment / delivery-status PATCH that doesn't touch the customer is left alone, so an
        # older bill saved without a name can still be updated.
        if self.instance is not None and 'customer' not in attrs and 'customer_name' not in attrs:
            return attrs
        customer = attrs['customer'] if 'customer' in attrs else self.instance.customer if self.instance else None
        # A typed name wins; without one (or when the bill is re-linked) the patient's own name.
        name = ' '.join(str(attrs.get('customer_name') or '').split())
        if not is_real_customer_name(name) and customer is not None:
            name = ' '.join(str(customer.name or '').split())
        if not is_real_customer_name(name):
            raise serializers.ValidationError({
                'customer_name': "Customer name is required. Select the patient or enter the customer's name.",
            })
        attrs['customer_name'] = name[:150]
        return attrs

    def get_payment_status(self, obj):
        return derive_payment_status(obj.net_amount, obj.paid_amount)

    def get_balance_due(self, obj):
        due = Decimal(str(obj.net_amount or 0)) - Decimal(str(obj.paid_amount or 0))
        return str(max(due, Decimal('0')).quantize(_CENT))

    def get_payment_splits(self, obj):
        totals = {key: Decimal('0') for key, _, _ in BILLING_PAY_MODES}
        for p in obj.payments.all():
            if p.source == BILLING_SOURCE and (p.status or '').upper() != 'CANCELLED':
                totals[_pay_mode_key(p.method)] += p.amount or 0
        return {key: str(val.quantize(_CENT)) for key, val in totals.items()}

    def get_payment_references(self, obj):
        refs = {key: '' for key in BANK_PAY_MODES}
        for p in obj.payments.all():
            key = _pay_mode_key(p.method)
            if (p.source == BILLING_SOURCE and key in refs and p.reference_no
                    and (p.status or '').upper() != 'CANCELLED'):
                refs[key] = p.reference_no
        return refs

    def get_payment_banks(self, obj):
        banks = {key: None for key in BANK_PAY_MODES}
        for p in obj.payments.all():
            key = _pay_mode_key(p.method)
            if (p.source == BILLING_SOURCE and key in banks and p.bank_account_id
                    and (p.status or '').upper() != 'CANCELLED'):
                banks[key] = str(p.bank_account_id)
        return banks

    def validate_customer(self, value):
        if value is not None and value.is_deleted and (
            self.instance is None or self.instance.customer_id != value.pk
        ):
            raise serializers.ValidationError('This customer has been deleted.')
        return value

    def get_customer_phone(self, obj):
        return obj.customer.phone if obj.customer_id and obj.customer else None

    def get_customer_code(self, obj):
        return obj.customer.patient_code if obj.customer_id and obj.customer else None

    @staticmethod
    def _line_kind(it):
        """FRAME / LENS / SERVICE / OTHER for one line: its item_type, then the product's category,
        then the wording of the line itself."""
        kind = (it.item_type or '').upper()
        if kind in ('SERVICE', 'LENS'):
            return kind
        product = it.product if it.product_id else None
        if product is not None:
            category = (product.category.name if product.category_id and product.category else '') \
                or product.category_name or ''
            found = _classify_words(category)
            if found:
                return found
        return _classify_words(f"{it.description or ''} {product.name if product else ''}") or 'FRAME'

    def _names_of_kind(self, obj, kind):
        names = []
        for it in obj.items.all():
            if self._line_kind(it) == kind:
                name = _item_display_name(it)
                if name and name not in names:
                    names.append(name)
        return ', '.join(names) or None

    def get_frame_name(self, obj):
        return self._names_of_kind(obj, 'FRAME')

    def get_lens_name(self, obj):
        return self._names_of_kind(obj, 'LENS')

class PaymentSerializer(ModelSerializer):
    bank_account_name = serializers.CharField(source='bank_account.name', read_only=True, default=None)

    class Meta:
        model = Payment
        fields = '__all__'

    def validate_bank_account(self, value):
        return validate_bank_account(value)

class ServiceSerializer(ModelSerializer):
    class Meta:
        model = Service
        fields = '__all__'
        # Auto-assigned in perform_create when omitted (same lesson as Invoice.invoice_number:
        # DRF required-field validation runs before perform_create, so it must be optional here).
        extra_kwargs = {'service_code': {'required': False}}

class CustomerViewSet(viewsets.ModelViewSet):
    # Ordered so paging through the list can't skip or repeat patients.
    queryset = Customer.objects.all().order_by('-created_at')
    serializer_class = CustomerSerializer
    pagination_class = SalesListPagination
    # AllowAny to match every other ViewSet in this app (Product, PurchaseInvoice,
    # EyeExamination, ...) — this was previously IsAuthenticated while nothing else was,
    # which meant a request with a not-quite-valid token failed with 401 and, because the
    # frontend's save call swallows that error, silently dropped the patient record entirely.
    permission_classes = [permissions.AllowAny]

    def create(self, request, *args, **kwargs):
        # Duplicate guard: the same patient (same name + same mobile number) registered twice —
        # a double-clicked Save, a retry after a timed-out request, or the front desk re-typing
        # a returning patient — answers with the existing record instead of a second Customer
        # row. 200 (not an error) so every caller just links to that row via res.data.id.
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        existing = find_duplicate_customer(
            serializer.validated_data.get('name'), serializer.validated_data.get('phone'),
        )
        if existing is not None:
            return Response(self.get_serializer(existing).data, status=200)
        self.perform_create(serializer)
        return Response(serializer.data, status=201, headers=self.get_success_headers(serializer.data))

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
        #
        # A code in the auto series ("P-1004") from the client is only ever its on-screen
        # preview — possibly stale (another device saved meanwhile) or guessed from an
        # incomplete patient list, which is how several patients ended up as P-1001. It is
        # never trusted: the next number always comes from the server's sequence. Only a
        # custom, non-series code (e.g. a legacy card number typed in) is kept when free.
        patient_code = (serializer.validated_data.get('patient_code') or '').strip()
        if (not patient_code or is_auto_patient_code(patient_code)
                or Customer.all_objects.filter(patient_code__iexact=patient_code).exists()):
            patient_code = reserve_patient_codes()[0]

        # The exists()-then-insert check above still has a TOCTOU race window: two requests
        # (e.g. the same "Save" fired twice back-to-back, or two front-desk tabs) can both pass
        # the check for the same code before either commits, and the loser's INSERT then hits
        # the column's real UNIQUE constraint as a raw, unhandled IntegrityError (500). Retry
        # with a freshly reserved code instead of letting that surface as a server error.
        attempts_left = 3
        while True:
            try:
                with transaction.atomic():
                    serializer.save(patient_code=patient_code)
                return
            except IntegrityError:
                attempts_left -= 1
                if attempts_left <= 0:
                    raise
                patient_code = reserve_patient_codes(heal=True)[0]

    def perform_update(self, serializer):
        # A patient's code is their permanent ID: an edit can never move it onto another
        # patient's code (or a guessed series number). A legacy row with no code gets one.
        instance = serializer.instance
        requested = (serializer.validated_data.get('patient_code') or '').strip()
        current = instance.patient_code
        if current:
            keep = (not requested or requested == current or is_auto_patient_code(requested)
                    or Customer.all_objects.filter(patient_code__iexact=requested)
                    .exclude(pk=instance.pk).exists())
            code = current if keep else requested
        else:
            code = requested if (requested and not is_auto_patient_code(requested) and not
                                 Customer.all_objects.filter(patient_code__iexact=requested).exists()) \
                else reserve_patient_codes()[0]
        serializer.save(patient_code=code)

    @action(detail=False, methods=['get'], url_path='next-patient-code')
    def next_patient_code(self, request):
        return Response({'patient_code': peek_next_patient_code()})

class EyeExaminationViewSet(EditApprovalMixin, viewsets.ModelViewSet):
    # Direct Edit switch 'eye_test' (Administration → Edit Permissions): with it OFF a saved visit
    # is changed only through an approved edit request.
    edit_module = 'eye_test'
    edit_ref_fields = ('test_no', 'patient_id')
    queryset = EyeExamination.objects.all().order_by('-examination_date')
    serializer_class = EyeExaminationSerializer
    permission_classes = [permissions.AllowAny]

    def get_queryset(self):
        # ?test_no=1003 — exact lookup (New Sale's Test No field), so a single visit can be found
        # without paging through every exam.
        qs = super().get_queryset().select_related('fee_invoice', 'fee_bank_account')
        params = self.request.query_params
        test_no = (params.get('test_no') or '').strip()
        if test_no:
            qs = qs.filter(test_no=test_no)
        # ?fee_status=PENDING&customer=<uuid>&patient_id=<code> — New Sale's lookup of a
        # patient's deferred eye test fees. Either identity matches: older exams may only
        # carry the patient code, not the Customer link.
        fee_status = (params.get('fee_status') or '').strip().upper()
        if fee_status:
            qs = qs.filter(fee_status=fee_status)
        customer = (params.get('customer') or '').strip()
        patient_id = (params.get('patient_id') or '').strip()
        who = Q()
        if _is_uuid(customer):
            who |= Q(customer_id=customer)
        if patient_id:
            who |= Q(patient_id=patient_id)
        if who:
            qs = qs.filter(who)
        elif customer:
            qs = qs.none()
        return qs

    def create(self, request, *args, **kwargs):
        # Duplicate guard for one test session: the same patient's identical exam submitted
        # again on the same day (a retry after a failed/slow sync, a double submit) returns the
        # visit already on file instead of persisting a second copy under a new Test No. A real
        # second visit with different findings is still created — visits are never merged.
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        existing = find_duplicate_exam(serializer.validated_data)
        if existing is not None:
            return Response(self.get_serializer(existing).data, status=200)
        self.perform_create(serializer)
        return Response(serializer.data, status=201, headers=self.get_success_headers(serializer.data))

    def perform_create(self, serializer):
        # Test No is assigned HERE, on the server, at submit time — never taken from the
        # client's on-screen value. That field is only a preview (peek_next_test_no, which
        # doesn't consume the sequence), so every device that has the Eye Test page open
        # is showing the *same* "next" number; if we saved whatever the client sent, two
        # of them submitting before either commits would both write that number. Assigning
        # from the shared atomic counter (reserve_unused_test_numbers -> TestNoSequence via
        # a single UPDATE ... RETURNING) gives every save its own number regardless of how
        # many sessions are connected to the shared database:
        #     Device A saves -> 1001    Device B saves -> 1002    Device A saves -> 1003
        #
        # The one value we honour from the request is a Test No that already belongs to the
        # Appointment this exam was started from (Appointments.jsx "Start Eye Test") and is
        # not yet used by any exam — that number was itself minted by the backend for the
        # appointment, so keeping it preserves one continuous series rather than burning a
        # number. all_objects (not the soft-delete-filtered manager) so a soft-deleted
        # exam/appointment still counts as "using" its number.
        requested = (serializer.validated_data.get('test_no') or '').strip()
        carried_over = (
            bool(requested)
            and Appointment.all_objects.filter(test_no=requested).exists()
            and not EyeExamination.all_objects.filter(test_no=requested).exists()
        )
        if carried_over:
            test_no = requested
            # Keep the shared counter ahead of this directly-accepted number so the next
            # reservation can't hand out the same one.
            sync_test_no_sequence(test_no)
        else:
            test_no = reserve_unused_test_numbers()[0]

        # DB-level backstop: EyeExamination.test_no carries a partial UNIQUE constraint
        # (migration 0016). If two requests race past the checks above onto the same number
        # the loser lands here instead of persisting a duplicate — re-roll and retry, the
        # same recovery CustomerViewSet.perform_create uses for patient_code.
        patient_id = self._resolve_patient_id(serializer)
        for attempts_left in (2, 1, 0):
            try:
                with transaction.atomic():
                    serializer.save(test_no=test_no, **patient_id)
                return
            except IntegrityError:
                if attempts_left <= 0:
                    raise
                test_no = reserve_unused_test_numbers()[0]

    def perform_update(self, serializer):
        # An edit must never change the visit's identity. If the client omits or blanks
        # test_no / patient_id (e.g. it loaded an older snapshot that never stored them),
        # keep whatever is already on the row instead of wiping it or minting a new number.
        instance = serializer.instance
        data = serializer.validated_data
        preserved = {}
        if not data.get('test_no'):
            preserved['test_no'] = instance.test_no
        if 'patient_id' in data and not data.get('patient_id'):
            preserved['patient_id'] = instance.patient_id
        customer = data.get('customer', instance.customer)
        if customer is not None and customer.patient_code:
            # The linked patient's permanent code wins over whatever the form held.
            preserved['patient_id'] = customer.patient_code
        serializer.save(**preserved)

    @staticmethod
    def _resolve_patient_id(serializer):
        """Patient ID for a new exam. The client's value is its on-screen preview and can be a
        stale guess (that is how several exams ended up as P-1001), so: a linked Customer's
        patient_code always wins; an auto-series code with no linked Customer is only kept when
        it already belongs to a Customer of the same name (then the exam is linked to them),
        otherwise a fresh code is reserved from the sequence. Custom codes pass through."""
        data = serializer.validated_data
        customer = data.get('customer')
        if customer is not None and customer.patient_code:
            return {'patient_id': customer.patient_code}
        requested = (data.get('patient_id') or '').strip()
        if customer is not None or not is_auto_patient_code(requested):
            return {}
        owner = Customer.objects.filter(patient_code__iexact=requested).first()
        name = ' '.join(str(data.get('patient_name') or '').split()).lower()
        if owner is not None and ' '.join(owner.name.split()).lower() == name:
            return {'patient_id': owner.patient_code, 'customer': owner}
        if owner is None and name and EyeExamination.objects.filter(
                patient_id__iexact=requested, patient_name__iexact=data.get('patient_name', '').strip()).exists():
            return {}  # a returning patient whose earlier visits carry this code
        return {'patient_id': reserve_patient_codes()[0]}

    @action(detail=False, methods=['get'], url_path='next-test-no')
    def next_test_no(self, request):
        return Response({'test_no': peek_next_test_no()})

    @action(detail=True, methods=['get'])
    def report(self, request, pk=None):
        # Eye Test Report: the visit plus its billing references (fee receipt / the bill the fee
        # went onto / spectacle bills dispensed against this Test No).
        exam = self.get_object()
        data = dict(self.get_serializer(exam).data)
        # The linked Customer's code is the patient's permanent ID; the exam's own patient_id is
        # whatever the form held at the time and can be stale.
        data['patient_code'] = exam.customer.patient_code if exam.customer_id and exam.customer else None
        return Response({'exam': data, 'billing': build_billing_reference(exam)})

    @action(detail=False, methods=['get'])
    def lookup(self, request):
        # New Sale's Test No lookup: the tests taken in [from, to) — the client sends its own
        # local-day bounds as ISO datetimes, since the server runs on UTC — with each one's
        # sale status (eye_test_lookup.py).
        params = request.query_params
        start = parse_datetime((params.get('from') or '').strip())
        end = parse_datetime((params.get('to') or '').strip())
        if not start or not end:
            return Response({'detail': 'from and to (ISO datetimes) are required.'}, status=400)
        exams = (EyeExamination.objects.filter(examination_date__gte=start, examination_date__lt=end)
                 .select_related('customer').order_by('-examination_date')[:LOOKUP_LIMIT + 1])
        exams = list(exams)
        return Response({'results': lookup_rows(exams[:LOOKUP_LIMIT]), 'truncated': len(exams) > LOOKUP_LIMIT})

    @action(detail=True, methods=['delete'])
    def discard(self, request, pk=None):
        # Remove a test the patient never bought against (New Sale's lookup). Unlike a plain
        # DELETE it refuses a test that a bill depends on or whose fee was collected — deleting
        # that one would orphan the bill's link or reverse real cash out of the books.
        exam = self.get_object()
        reasons = discard_blockers(exam)
        if reasons:
            return Response({'detail': f"Test No {exam.test_no} can't be deleted: " + '; '.join(reasons) + '.'},
                            status=409)
        exam.delete()  # soft delete; the Test No stays used, so the series never repeats it
        return Response(status=204)

class AppointmentViewSet(viewsets.ModelViewSet):
    queryset = Appointment.objects.all()
    serializer_class = AppointmentSerializer
    permission_classes = [permissions.AllowAny]

    def perform_create(self, serializer):
        appointment_code = serializer.validated_data.get('appointment_code')
        if not appointment_code:
            import time
            appointment_code = f"APT-{int(time.time()) % 1000000}"
        # Every new appointment is a distinct visit, so it always gets a fresh Test No —
        # even when booked for a returning patient, rather than reusing their last visit's.
        # reserve_unused_test_numbers so a sequence lagging behind directly-assigned numbers
        # can't collide with an existing exam/appointment.
        test_no = reserve_unused_test_numbers()[0]
        serializer.save(appointment_code=appointment_code, test_no=test_no)

class InvoiceViewSet(EditApprovalMixin, BranchScopedViewSetMixin, viewsets.ModelViewSet):
    edit_module = 'sales'
    edit_ref_fields = ('invoice_number',)
    # Orders' "Update payment / delivery status" dialog and Mark Delivered aren't bill edits.
    edit_exempt_fields = ('fulfillment_status', 'delivered_at', 'fulfillment_notes', 'paid_amount', 'payment_method')
    queryset = Invoice.objects.all()
    serializer_class = InvoiceSerializer
    pagination_class = SalesListPagination
    # AllowAny to match every other ViewSet in this app — was previously the one exception left
    # on IsAuthenticated, which combined with the frontend's demo-login mock token (see
    # apps.common.authentication.LenientJWTAuthentication) meant every "complete sale" POST from
    # New Sale / POS Billing failed with 401 and silently fell back to localStorage-only,
    # so retail sales never actually reached the database at all.
    permission_classes = [permissions.AllowAny]

    _READ_PREFETCH = (
        'payments',
        Prefetch('items', queryset=InvoiceItem.objects.select_related('product__category', 'product__brand')),
    )

    def _prefetch_for_response(self, invoice):
        """Load the saved bill's lines (with products) and receipts once for the response —
        otherwise `items`, frame_name, lens_name, payment_splits and payment_banks each re-read
        them, a query (a network round trip when hosted) per field and per line."""
        invoice._prefetched_objects_cache = {}
        prefetch_related_objects([invoice], *self._READ_PREFETCH)

    def get_queryset(self):
        # One table backs Quotations, Orders and Invoices (see Invoice.document_type). Callers
        # that only want real tax invoices — the Sales dashboard, Accounts, patient billing
        # history — pass ?document_type=INVOICE; the Orders section omits it to get all three.
        # Customer + items + their products/categories are fetched in a few joined queries up
        # front, so the list's customer_name / frame_name / lens_name don't cost a query per row.
        # Newest first — and a stable order, so paging through the list can't skip or repeat bills.
        qs = super().get_queryset().select_related('customer').prefetch_related(*self._READ_PREFETCH)             .order_by('-invoice_date', '-created_at')
        doc_type = self.request.query_params.get('document_type')
        if doc_type and doc_type.lower() != 'all':
            qs = qs.filter(document_type=doc_type.upper())
        # ?search= — bill number or customer name (the bill designer's "preview a real bill" picker).
        search = (self.request.query_params.get('search') or '').strip()
        if search:
            qs = qs.filter(Q(invoice_number__icontains=search) | Q(customer_name__icontains=search))
        return qs

    # QUOTATION -> QTN, ORDER -> ORD, INVOICE (and anything else) -> INV, so an auto-generated
    # number reads correctly for whichever of the three documents this row currently is.
    _DOC_PREFIX = {'QUOTATION': 'QTN', 'ORDER': 'ORD', 'INVOICE': 'INV'}

    def _doc_prefix(self, doc_type):
        return self._DOC_PREFIX.get((doc_type or 'INVOICE').upper(), 'INV')

    def _commits_stock(self, invoice):
        # Only a real INVOICE moves inventory + feeds accounting — a quotation is just an
        # estimate and an order isn't a sale until it's converted/billed.
        return invoice.document_type == 'INVOICE' and invoice.status not in ('DRAFT', 'CANCELLED')

    @transaction.atomic
    def perform_create(self, serializer):
        splits = self._payment_splits(serializer)
        banks, refs = self._payment_banks(splits)
        data = serializer.validated_data
        doc_type = data.get('document_type') or 'INVOICE'
        # With a split, the bill's paid_amount IS its sum — never a separately typed figure.
        paid = sum(splits.values(), Decimal('0')) if splits is not None else data.get('paid_amount') or Decimal('0')
        extra = {
            **self._branch_stamp_kwargs(serializer),
            'paid_amount': paid,
            'status': settle_payment_status(data.get('status') or 'UNPAID', data.get('net_amount'), paid),
        }
        # Settings → Numbering Sequences: with auto-generation on, the system numbers new
        # documents itself (the number New Sale showed was only a preview).
        invoice_number = self._sequence_number(doc_type)             or self._free_invoice_number(data.get('invoice_number'), doc_type)
        # The free-number check above can still race another till onto the same number; the
        # UNIQUE column then refuses one of them — take a fresh number and retry rather than
        # losing the sale.
        for attempts_left in (2, 1, 0):
            try:
                with transaction.atomic():
                    invoice = serializer.save(invoice_number=invoice_number, **extra)
                break
            except IntegrityError:
                if attempts_left <= 0:
                    raise
                invoice_number = self._mint_invoice_number(doc_type)
        self._save_items(invoice)
        self._enforce_prices(invoice)
        self._enforce_offers(invoice)
        if fee_exam_ids(self.request.data.get('items') or []):
            sync_invoice_eye_test_fees(invoice)
        if self._commits_stock(invoice):
            self._update_inventory(invoice)
        if splits is not None:
            self._sync_billing_receipts(invoice, splits, banks, refs)
        self._prefetch_for_response(invoice)

    @transaction.atomic
    def perform_update(self, serializer):
        instance = serializer.instance
        splits = self._payment_splits(serializer)
        banks, refs = self._payment_banks(splits)
        # Snapshot what this document had already taken out of stock BEFORE the save changes
        # its type/status or the item list is replaced (serializer.instance is still the
        # pre-edit row here).
        was_committed = self._commits_stock(instance)
        stock_before = self._stock_quantities(instance)
        # Read from the prefetched lines (no query) before they're replaced below.
        had_eye_fees = bool(fee_exam_ids(instance.items.all()))
        # Offer units this document already carried — an edit only re-checks units it adds.
        from apps.company.pricing_rules import document_offer_units
        offers_before = document_offer_units(instance.items.all())
        # Items / receipts change from here on — drop get_queryset's prefetched copies so every
        # read below sees the new rows.
        instance._prefetched_objects_cache = {}

        data = serializer.validated_data
        # Order → Invoice settlement (New Sale's payment pop-up): the balance collected at delivery,
        # recorded below as today's receipts in the same transaction as the conversion.
        balance = self._balance_receipts(serializer, splits)
        balance_total = sum((amount for amount, _, _ in balance.values()), Decimal('0'))
        extra = {}
        if splits is not None:
            # Total Paid = what was taken at billing (the split) + anything collected against the
            # bill later from the Payments tab, which an edit must not wipe out.
            extra['paid_amount'] = sum(splits.values(), Decimal('0')) + _collected_later_total(instance.pk)
        if balance_total:
            extra['paid_amount'] = extra.get('paid_amount', Decimal(str(instance.paid_amount or 0))) + balance_total
        paid = extra.get('paid_amount', data.get('paid_amount', instance.paid_amount))
        extra['status'] = settle_payment_status(
            data.get('status', instance.status), data.get('net_amount', instance.net_amount), paid
        )
        if 'invoice_number' in data:
            # Blank keeps the current number; one another document already has gets a fresh one.
            extra['invoice_number'] = self._free_invoice_number(
                data['invoice_number'] or instance.invoice_number,
                data.get('document_type', instance.document_type),
                exclude_pk=instance.pk,
            )

        invoice = serializer.save(**extra)
        if splits is not None:
            self._sync_billing_receipts(invoice, splits, banks, refs)
        if balance:
            self._record_balance_receipts(invoice, balance)
        # Item list is optional on update (e.g. a status-only PATCH from the Orders tab won't
        # include it) — only replace items when the client actually sent a new list.
        if 'items' in self.request.data:
            # Full edit from New Sale: lines may have been added, removed, re-quantified or
            # swapped for another product, and the document type may have changed. Move stock
            # by the net difference, so an edit never double-deducts or strands stock.
            invoice.items.all().delete()
            self._save_items(invoice)
            self._enforce_prices(invoice)
            self._enforce_offers(invoice, offers_before)
            self._reconcile_inventory(invoice, stock_before)
        elif not was_committed and self._commits_stock(invoice):
            # Status-only PATCH that turns this into a committed sale (e.g. DRAFT -> PAID).
            # Only on that transition: re-running on every PATCH relied on StockLedger rows for
            # idempotency, and those aren't written when no Warehouse exists, so each payment/
            # delivery update used to deduct the same invoice's stock again.
            self._update_inventory(invoice)
        # Lines added / removed, or the bill cancelled or turned into a quotation: claim or
        # release the deferred eye test fees it carries.
        if had_eye_fees or fee_exam_ids(self.request.data.get('items') or []):
            sync_invoice_eye_test_fees(invoice)
        self._prefetch_for_response(invoice)

    @transaction.atomic
    def perform_destroy(self, instance):
        # A deleted bill's deferred eye test fees go back to pending for the next sale.
        sync_invoice_eye_test_fees(instance, released=True)
        super().perform_destroy(instance)

    @action(detail=False, methods=['get'], url_path='report')
    def report(self, request):
        """Reports → Sales Report: ?date_from=&date_to=&document_type= — every bill in range with
        its customer, linked eye test, line details, payment and staff (see sales_report.py).
        Unpaged: the client always asks for a bounded date range."""
        # The mixin's branch-scoped rows, without get_queryset's read prefetches (the report
        # prefetches its own, with bank accounts and variant groups joined in).
        base = super().get_queryset()
        return Response({'results': build_sales_report(report_queryset(base, request.query_params))})

    @action(detail=True, methods=['post'], url_path='convert')
    def convert(self, request, pk=None):
        """Convert this document in place: Quotation -> Order -> Invoice (or back).

        Keeps the same row/items/history; only re-labels it and, when the target is INVOICE,
        commits stock. Pass {"document_type": "ORDER", "renumber": true} to also mint a fresh
        prefix-matching number.
        """
        invoice = self.get_object()
        target = (request.data.get('document_type') or '').upper()
        if target not in ('QUOTATION', 'ORDER', 'INVOICE'):
            return Response(
                {'detail': 'document_type must be QUOTATION, ORDER or INVOICE'}, status=400
            )
        if target in ('ORDER', 'INVOICE'):
            # A lens can't go to the lab or be billed without its prescription.
            missing = incomplete_lens_lines(invoice)
            if missing:
                return Response({'detail': 'Complete the lens prescription in New Sale first. ' + ' '.join(missing)},
                                status=400)
        invoice.document_type = target
        if request.data.get('renumber'):
            invoice.invoice_number = self._mint_invoice_number(target)
        if target == 'ORDER' and not invoice.fulfillment_status:
            invoice.fulfillment_status = 'Order Received'
        # A quotation is saved as DRAFT. Once it's an order or invoice it is a live bill whose
        # status follows what has been paid — and left as DRAFT, a converted invoice would never
        # commit its stock or reach the books.
        if target != 'QUOTATION' and invoice.status == 'DRAFT':
            invoice.status = derive_payment_status(invoice.net_amount, invoice.paid_amount)
        with transaction.atomic():
            invoice.save()
            # A quotation never holds a deferred eye test fee; converting it claims (or, back to
            # a quotation, releases) the fees its lines carry.
            sync_invoice_eye_test_fees(invoice)
        if self._commits_stock(invoice):
            self._update_inventory(invoice)
        return Response(self.get_serializer(invoice).data)

    def _payment_splits(self, serializer):
        """Validated {mode: Decimal} from the request's `payment_splits` (New Sale's Cash / Card /
        UPI / Bank boxes), or None when the client didn't send one (POS Billing, status-only
        PATCHes). Refuses a split that adds up to more than the bill's net payable: change handed
        back is not money the shop keeps."""
        raw = self.request.data.get('payment_splits')
        if raw is None:
            return None
        if not isinstance(raw, dict):
            raise serializers.ValidationError({'payment_splits': 'Expected {cash, card, upi, bank} amounts.'})
        splits = {}
        for key, label, _ in BILLING_PAY_MODES:
            try:
                amount = Decimal(str(raw.get(key) or 0)).quantize(_CENT)
            except (InvalidOperation, TypeError, ValueError):
                raise serializers.ValidationError({'payment_splits': f'{label} amount is not a number.'})
            if amount < 0:
                raise serializers.ValidationError({'payment_splits': f'{label} amount cannot be negative.'})
            splits[key] = amount

        net = serializer.validated_data.get('net_amount')
        if net is None:
            net = serializer.instance.net_amount if serializer.instance is not None else 0
        net = Decimal(str(net or 0))
        total = sum(splits.values(), Decimal('0'))
        if total > net + _CENT:
            raise serializers.ValidationError({
                'payment_splits': f'Total paid ₹{total} is more than the net payable ₹{net.quantize(_CENT)}. '
                                  'Record only what the shop keeps; hand the rest back as change.'
            })
        return splits

    def _payment_banks(self, splits=None):
        """({card, upi, bank}: validated bank ledger, {card, upi, bank}: Reference / UTR no.).

        A bank of None posts to the mode's default role mapping. When the screen sends
        `payment_banks` (New Sale, POS Billing), every Card / UPI / Bank Transfer amount must name
        its bank: the debit goes straight to that ledger in Accounts / Financial reports."""
        from apps.financial.models import ChartOfAccount
        sent = 'payment_banks' in self.request.data
        raw = self.request.data.get('payment_banks') or {}
        if not isinstance(raw, dict):
            raise serializers.ValidationError({'payment_banks': 'Expected {card, upi, bank} bank account ids.'})
        raw_refs = self.request.data.get('payment_references') or {}
        if not isinstance(raw_refs, dict):
            raise serializers.ValidationError({'payment_references': 'Expected {card, upi, bank} reference numbers.'})
        labels = {key: label for key, label, _ in BILLING_PAY_MODES}
        banks, refs = {}, {}
        for key in BANK_PAY_MODES:
            ref = str(raw_refs.get(key) or '').strip()
            if len(ref) > 80:
                raise serializers.ValidationError({'payment_references': f'{labels[key]} reference is longer than 80 characters.'})
            refs[key] = ref
            value = raw.get(key)
            if not value:
                if sent and splits is not None and splits.get(key, Decimal('0')) > 0:
                    raise serializers.ValidationError({
                        'payment_banks': f'Select the bank account the {labels[key]} payment was deposited into.'
                    })
                banks[key] = None
                continue
            acc = ChartOfAccount.objects.filter(pk=value).first() if _is_uuid(value) else None
            if acc is None:
                raise serializers.ValidationError({'payment_banks': f'Unknown bank account for {labels[key]}.'})
            try:
                banks[key] = validate_bank_account(acc)
            except serializers.ValidationError as exc:
                raise serializers.ValidationError({'payment_banks': exc.detail})
        return banks, refs

    def _balance_receipts(self, serializer, splits):
        """{mode: (amount, bank ledger, reference)} from the request's `balance_receipts` — the
        balance collected when an Order is billed (New Sale's settlement pop-up). Empty when not
        sent. Shape: {"cash": 100, "upi": {"amount": 50, "bank_account": id, "reference": "UTR"}}.

        These are real receipts dated today, kept apart from the BILLING split so the advance
        taken at booking keeps its own date and bank. Card / UPI / Bank need a bank, and the
        advance + earlier receipts + this balance may not exceed the net payable."""
        from apps.financial.models import ChartOfAccount
        raw = self.request.data.get('balance_receipts')
        if not raw:
            return {}
        if not isinstance(raw, dict):
            raise serializers.ValidationError({'balance_receipts': 'Expected {cash, card, upi, bank} amounts.'})
        labels = {key: label for key, label, _ in BILLING_PAY_MODES}
        out = {}
        for key, label, _ in BILLING_PAY_MODES:
            entry = raw.get(key)
            if entry in (None, '', 0):
                continue
            if not isinstance(entry, dict):
                entry = {'amount': entry}
            try:
                amount = Decimal(str(entry.get('amount') or 0)).quantize(_CENT)
            except (InvalidOperation, TypeError, ValueError):
                raise serializers.ValidationError({'balance_receipts': f'{label} amount is not a number.'})
            if amount < 0:
                raise serializers.ValidationError({'balance_receipts': f'{label} amount cannot be negative.'})
            if amount == 0:
                continue
            bank = None
            ref = ''
            if key in BANK_PAY_MODES:
                value = entry.get('bank_account')
                acc = ChartOfAccount.objects.filter(pk=value).first() if _is_uuid(value) else None
                if acc is None:
                    raise serializers.ValidationError({
                        'balance_receipts': f'Select the bank account the {labels[key]} payment was deposited into.'
                    })
                try:
                    bank = validate_bank_account(acc)
                except serializers.ValidationError as exc:
                    raise serializers.ValidationError({'balance_receipts': exc.detail})
                ref = str(entry.get('reference') or '').strip()
                if len(ref) > 80:
                    raise serializers.ValidationError({'balance_receipts': f'{label} reference is longer than 80 characters.'})
            out[key] = (amount, bank, ref)
        if not out:
            return {}

        instance = serializer.instance
        net = serializer.validated_data.get('net_amount', instance.net_amount)
        net = Decimal(str(net or 0))
        already = (sum(splits.values(), Decimal('0')) + _collected_later_total(instance.pk)
                   if splits is not None else Decimal(str(instance.paid_amount or 0)))
        total = sum((a for a, _, _ in out.values()), Decimal('0'))
        if already + total > net + _CENT:
            raise serializers.ValidationError({
                'balance_receipts': f'Collecting ₹{total} would take Total Paid to ₹{(already + total).quantize(_CENT)}, '
                                    f'more than the net payable ₹{net.quantize(_CENT)}.'
            })
        return out

    def _record_balance_receipts(self, invoice, balance):
        """One receipt per mode for the balance collected at delivery. Blank source = "collected
        later", so it counts in Total Paid on top of the BILLING split (already added to
        paid_amount by perform_update) and a later New Sale edit leaves it alone."""
        customer = invoice.customer
        customer_name = invoice.customer_name or (customer.name if customer else '') or 'Walk-in Customer'
        labels = {key: (label, code) for key, label, code in BILLING_PAY_MODES}
        for key, (amount, bank, ref) in balance.items():
            label, code = labels[key]
            Payment.objects.create(
                invoice=invoice, customer=customer, customer_name=customer_name,
                amount=amount, method=label, bank_account=bank, reference_no=ref,
                receipt_no=self._billing_receipt_no(invoice, f'{code}-BAL'),
                payment_date=timezone.localdate(), status='Completed', branch=invoice.branch,
            )

    _SEQUENCE_TYPE = {'INVOICE': 'SALES_INVOICE', 'ORDER': 'SALES_ORDER', 'QUOTATION': 'QUOTATION'}

    def _sequence_number(self, doc_type):
        """The configured sequence's next number, or None when the type isn't system-numbered."""
        from apps.company.numbering import issue_number
        return issue_number(self._SEQUENCE_TYPE.get((doc_type or 'INVOICE').upper(), 'SALES_INVOICE'),
                            lambda n: Invoice.all_objects.filter(invoice_number=n).exists())

    def _mint_invoice_number(self, doc_type):
        """The configured sequence's next number; without one, a free PREFIX-YYYY-NNNN number (the
        shape New Sale shows), widening the random part if the year's 4-digit space is getting
        crowded. all_objects: a soft-deleted document still holds its number in the UNIQUE column."""
        seq = self._sequence_number(doc_type)
        if seq:
            return seq
        prefix = self._doc_prefix(doc_type)
        year = time.localtime().tm_year
        for digits in (4, 4, 4, 5, 5, 6, 6, 6):
            low = 10 ** (digits - 1)
            candidate = f"{prefix}-{year}-{low + secrets.randbelow(9 * low)}"
            if not Invoice.all_objects.filter(invoice_number=candidate).exists():
                return candidate
        return f"{prefix}-{uuid.uuid4().hex[:12].upper()}"

    def _free_invoice_number(self, requested, doc_type, exclude_pk=None):
        """The requested number when no other document has it, otherwise a freshly minted one."""
        requested = (requested or '').strip()
        if requested:
            taken = Invoice.all_objects.filter(invoice_number=requested)
            if exclude_pk is not None:
                taken = taken.exclude(pk=exclude_pk)
            if not taken.exists():
                return requested
        return self._mint_invoice_number(doc_type)

    def _billing_receipt_no(self, invoice, code):
        receipt_no = f"RCP-{invoice.invoice_number}-{code}"
        # all_objects: a voided (soft-deleted) receipt still holds its number in the UNIQUE column.
        if len(receipt_no) > 50 or Payment.all_objects.filter(receipt_no=receipt_no).exists():
            receipt_no = f"RCP-{uuid.uuid4().hex[:10].upper()}"
        return receipt_no

    def _sync_billing_receipts(self, invoice, splits, banks=None, refs=None):
        """Keep one BILLING receipt per pay mode in step with the bill's split. Each receipt posts
        its own Dr Cash-or-Bank / Cr Receivable entry (signals.py), so cash and card/UPI/bank
        takings land in the right account. Receipts recorded later from the Payments tab (no
        source) are left alone."""
        existing = {}
        for p in invoice.payments.filter(source=BILLING_SOURCE):
            existing.setdefault(_pay_mode_key(p.method), []).append(p)

        customer = invoice.customer
        customer_name = invoice.customer_name or (customer.name if customer else '') or 'Walk-in Customer'
        for key, label, code in BILLING_PAY_MODES:
            amount = splits.get(key, Decimal('0'))
            rows = existing.get(key, [])
            # Only a row already carrying the exact label is updated in place; anything else is
            # voided and re-issued, so a changed label can't leave its journal entry on the
            # wrong (Cash vs Bank) account.
            keep = next((p for p in rows if p.method == label), None) if amount > 0 else None
            for p in rows:
                if p is not keep:
                    _void_receipt(p)
            if amount <= 0:
                continue
            if keep is None:
                keep = Payment(
                    invoice=invoice, source=BILLING_SOURCE, method=label,
                    receipt_no=self._billing_receipt_no(invoice, code),
                    payment_date=invoice.invoice_date, branch=invoice.branch,
                )
            keep.amount = amount
            keep.bank_account = (banks or {}).get(key)
            keep.reference_no = (refs or {}).get(key, '') if key in BANK_PAY_MODES else ''
            keep.status = 'Completed'
            keep.customer = customer
            keep.customer_name = customer_name
            keep.save()

    def _save_items(self, invoice):
        # `items` is read-only on the serializer (see InvoiceSerializer) since ModelSerializer
        # can't write a reverse-FK nested list on its own — read the raw list straight from the
        # request body instead.
        from apps.products.models import Product

        raw_items = self.request.data.get('items') or []
        # The product pickers can still surface legacy localStorage-only items whose id is not a
        # real Product UUID (see the "local vs backend product ids" gotcha). Passing one straight
        # to product_id raises and 500s the whole sale. One query checks every line's product
        # (each lookup is a network round trip on the hosted database); an unknown one is re-linked
        # by its code or the save is refused — never kept as a stock-less description line.
        wanted = {str(raw.get('product')) for raw in raw_items if _is_uuid(raw.get('product'))}
        known = {str(pk): extra for pk, extra in Product.objects.filter(pk__in=wanted).values_list('pk', 'extra_data')} \
            if wanted else {}
        raw_items = _relink_unknown_products(raw_items, known)
        # Pricing offer each line was sold under (offer barcode scanned / offer price applied).
        # Only real offers are linked; _enforce_offers then checks they fit the line's product.
        from apps.company.models import PricingOffer

        def offer_of(raw):
            return str(raw.get('pricing_offer') or raw.get('pricingOffer') or '')
        wanted_offers = {offer_of(raw) for raw in raw_items if _is_uuid(offer_of(raw))}
        known_offers = {str(pk) for pk in PricingOffer.all_objects.filter(pk__in=wanted_offers)
                        .values_list('pk', flat=True)} if wanted_offers else set()

        # Spectacle-lens lines carry a selling unit (Pair / Piece) and a per-eye prescription. An
        # Order or Invoice needs the prescription complete; a Quotation only needs what was entered
        # to be valid. Raising here rolls the whole save back (both callers are atomic).
        requires_complete = invoice.document_type in ('ORDER', 'INVOICE')
        lens = []
        for raw in raw_items:
            cleaned = clean_lens_line(raw, requires_complete)
            if cleaned is not None:
                key = str(raw.get('product'))
                unit = str((known.get(key) or {}).get('lens_stock_unit') or '').upper()
                cleaned['lens_details'] = {**cleaned['lens_details'],
                                           'stock_unit': unit if unit in SELLING_UNITS else PAIR}
            lens.append(cleaned or {})

        # bulk_create skips InvoiceItem's post_save, which only re-queues the invoice's journal —
        # already queued by the invoice's own save, and booked after commit with these lines.
        InvoiceItem.objects.bulk_create([
            InvoiceItem(
                invoice=invoice,
                product_id=str(raw.get('product')) if str(raw.get('product')) in known else None,
                service_id=raw.get('service') or None,
                item_type=raw.get('item_type') or raw.get('itemType') or 'PRODUCT',
                service_details=raw.get('service_details') or raw.get('serviceDetails') or None,
                description=raw.get('description') or raw.get('name') or '',
                power=raw.get('power') or '',
                quantity=raw.get('quantity') or raw.get('qty') or 1,
                unit_price=raw.get('unit_price') or raw.get('price') or 0,
                tax_rate=raw.get('tax_rate') or raw.get('taxPercent') or 0,
                tax_amount=raw.get('tax_amount') or raw.get('tax') or 0,
                subtotal=raw.get('subtotal') or raw.get('total') or 0,
                pricing_offer_id=offer_of(raw) if offer_of(raw) in known_offers else None,
                **lens_fields,
            )
            for raw, lens_fields in zip(raw_items, lens)
        ])

    def _enforce_prices(self, invoice):
        """Settings → Pricing Rules & Offers: refuse (400 `below_cost`, whole save rolled back) a
        line sold under its cost / minimum-margin floor, unless a manager approved it."""
        from apps.company.pricing_rules import enforce_line_prices
        enforce_line_prices(self.request, self.request.data.get('items') or [],
                            invoice.net_amount, invoice.tax_amount, invoice.invoice_number)

    def _enforce_offers(self, invoice, before=None):
        """Settings → Pricing Rules & Offers: offer-tagged lines may not sell more offer units than
        the offer has left (400 `offer_exhausted`; whole save rolled back)."""
        from apps.company.pricing_rules import enforce_offer_lines
        enforce_offer_lines(invoice, before)

    def _update_inventory(self, invoice):
        # Deduct stock from the invoice's branch (falls back to the default branch for rows
        # created before Multi-Branch existed). adjust_branch_stock_many keeps BranchStock,
        # Product.stock and the StockLedger audit row consistent in a fixed handful of queries
        # however many lines the bill has.
        from apps.company.models import Branch
        from apps.products.models import Product
        branch = invoice.branch or Branch.get_default()

        # Custom/ad-hoc lines (no matching Product row) have nothing to deduct stock from. A
        # product on several lines is deducted once for their combined quantity — the same total
        # _stock_quantities later reconciles an edit against.
        totals = self._stock_quantities(invoice, force=True)
        already = set(StockLedger.objects.filter(reference_id=invoice.id, product_id__in=totals)
                      .values_list('product_id', flat=True)) if totals else set()
        products = Product.objects.in_bulk([pk for pk in totals if pk not in already])
        adjust_branch_stock_many(
            {product: -totals[pk] for pk, product in products.items()},
            branch,
            enforce_stock=self._enforce_stock(),
            ledger={
                'transaction_type': 'OUT',
                'reference_id': invoice.id,
                'notes': f"Sold via Invoice {invoice.invoice_number}",
                'reference_number': invoice.invoice_number,
            },
        )

    def _enforce_stock(self):
        """Refuse a sale that would take stock below zero (when Settings disallows negative
        stock) — unless a Super Admin / Administrator explicitly overrides it for this request."""
        from apps.billing.views import user_role
        from apps.company.store_profile import STORE_SETTINGS_ROLES
        data = self.request.data if isinstance(self.request.data, dict) else {}
        return not (data.get('override_negative_stock') is True
                    and user_role(self.request.user) in STORE_SETTINGS_ROLES)

    def _stock_quantities(self, invoice, force=False):
        """{product_id: total qty} this document currently holds out of stock — empty when it
        doesn't commit stock (quotation, order, draft, cancelled) unless `force`."""
        if not force and not self._commits_stock(invoice):
            return {}
        # Lens lines count in the product's stock unit (pairs or pieces) — see lens_units.
        return stock_units_by_product(invoice.items.all())

    def _reconcile_inventory(self, invoice, before):
        """After an edit, move stock by the difference between what the document held before
        (`before`, from _stock_quantities) and what it holds now: added qty / new products are
        deducted, reduced qty / removed products go back on the shelf. Also covers a type change
        made while editing (an Invoice re-saved as an Order returns its stock, and vice versa)."""
        from apps.company.models import Branch
        from apps.products.models import Product

        after = self._stock_quantities(invoice)
        deltas = {pk: after.get(pk, 0) - before.get(pk, 0) for pk in set(before) | set(after)}
        deltas = {pk: d for pk, d in deltas.items() if d}
        if not deltas:
            return
        branch = invoice.branch or Branch.get_default()
        products = Product.objects.in_bulk(list(deltas))
        # Batched per direction: the ledger row's transaction type differs for stock going out
        # (added / raised lines) and coming back (removed / reduced lines).
        for direction, keep in (('OUT', lambda d: d > 0), ('IN', lambda d: d < 0)):
            adjust_branch_stock_many(
                {product: -deltas[pk] for pk, product in products.items() if keep(deltas[pk])},
                branch,
                enforce_stock=direction == 'OUT' and self._enforce_stock(),
                ledger={
                    'transaction_type': direction,
                    'reference_id': invoice.id,
                    'notes': f"Invoice {invoice.invoice_number} edited",
                    'reference_number': invoice.invoice_number,
                },
            )

def _relink_unknown_products(raw_items, known):
    """Lines whose `product` is not one of this client's products (`known` = {id: extra_data},
    updated in place).

    The pickers used to merge a browser-cached product list into the server's, so a line could
    carry an id from a stale cache: a product deleted since, a copy left by another account signed
    in on the same browser, or a browser-only import. Such a line used to be saved as a plain
    description — the bill went through and stock silently never moved. Re-link it by its barcode
    / item code when exactly one of this client's products matches (the ORM scopes the lookup to
    the tenant); otherwise refuse the save (400 `unknown_product`) so the user refreshes and
    re-picks it."""
    from apps.products.models import Product

    def ref(raw):
        value = raw.get('product')
        return '' if value in (None, '') else str(value).strip()

    code_keys = ('barcode', 'sku', 'product_code')
    stale = [i for i, raw in enumerate(raw_items)
             if ref(raw) and ref(raw) not in known
             and str(raw.get('item_type') or raw.get('itemType') or 'PRODUCT').upper() != 'SERVICE']
    if not stale:
        return raw_items
    codes = {str(raw_items[i].get(k) or '').strip() for i in stale for k in code_keys} - {''}
    matches = {}
    if codes:
        for pk, sku, barcode, second, extra in Product.objects.filter(
                Q(sku__in=codes) | Q(barcode__in=codes) | Q(secondary_barcode__in=codes)
        ).values_list('pk', 'sku', 'barcode', 'secondary_barcode', 'extra_data'):
            for code in {sku, barcode, second} & codes:
                matches.setdefault(code, {})[str(pk)] = extra
    out, unresolved = list(raw_items), []
    for i in stale:
        raw, found = raw_items[i], {}
        for k in code_keys:
            found.update(matches.get(str(raw.get(k) or '').strip(), {}))
        if len(found) == 1:
            (pk, extra), = found.items()
            known[pk] = extra
            out[i] = {**raw, 'product': pk}
        else:
            unresolved.append(str(raw.get('description') or raw.get('name') or ref(raw)))
    if unresolved:
        raise serializers.ValidationError({
            'detail': "These items are not in this store's product list (the screen showed an "
                      'out-of-date copy), so their stock could not be updated: '
                      + ', '.join(unresolved) + '. Refresh the page and add them again.',
            'code': 'unknown_product',
            'items': unresolved,
        })
    return out


class PaymentViewSet(BranchScopedViewSetMixin, viewsets.ModelViewSet):
    queryset = Payment.objects.all()
    serializer_class = PaymentSerializer
    pagination_class = SalesListPagination
    permission_classes = [permissions.AllowAny]

    @transaction.atomic
    def perform_create(self, serializer):
        receipt_no = serializer.validated_data.get('receipt_no')
        if not receipt_no:
            receipt_no = f"RCP-{int(time.time()) % 1000000}"
            # The time-based number repeats (same second / wrap-around) and the UNIQUE column then
            # refused the receipt. all_objects: a voided receipt still holds its number.
            if Payment.all_objects.filter(receipt_no=receipt_no).exists():
                receipt_no = f"RCP-{uuid.uuid4().hex[:10].upper()}"
        payment = serializer.save(receipt_no=receipt_no, **self._branch_stamp_kwargs(serializer))
        # Money collected against a bill raises that bill's Total Paid.
        _shift_invoice_paid(*_later_receipt_share(payment))

    @transaction.atomic
    def perform_update(self, serializer):
        old_invoice, old_amount = _later_receipt_share(serializer.instance)
        payment = serializer.save()
        new_invoice, new_amount = _later_receipt_share(payment)
        if old_invoice == new_invoice:
            _shift_invoice_paid(new_invoice, new_amount - old_amount)
        else:
            _shift_invoice_paid(old_invoice, -old_amount)
            _shift_invoice_paid(new_invoice, new_amount)

    @transaction.atomic
    def perform_destroy(self, instance):
        invoice_id, amount = _later_receipt_share(instance)
        instance.delete()
        _shift_invoice_paid(invoice_id, -amount)

def _next_service_code():
    """Next 'SRVnnn' code, derived from the highest existing one (checks all_objects so a
    soft-deleted service's code isn't reused). Good enough for a single-till optical shop;
    ServiceViewSet.perform_create still retries on the unique constraint if two collide."""
    from django.db.models import Max
    last = Service.all_objects.aggregate(m=Max('service_code'))['m']
    n = 0
    if last and str(last).upper().startswith('SRV'):
        try:
            n = int(str(last)[3:])
        except (TypeError, ValueError):
            n = 0
    return f"SRV{n + 1:03d}"


DEFAULT_SERVICES = (
    ('SRV001', 'Frame Repair', 'Repair of broken hinge, temple or frame front', 250, 18),
    ('SRV002', 'Frame Fitting', 'Fitting and alignment of new spectacles', 100, 18),
    ('SRV003', 'Frame Adjustment', 'Re-adjustment of frame for comfortable fit', 50, 18),
    ('SRV004', 'Cleaning Service', 'Ultrasonic cleaning of frame and lenses', 50, 18),
    ('SRV005', 'Parts Replacement', 'Replacement of nose pads, screws or temple tips', 0, 18),
)


def seed_default_services():
    """The common optical services, for the current tenant, when it has none (one bulk insert).
    Called by client onboarding and lazily by the service list."""
    if Service.all_objects.exists():
        return 0
    Service.objects.bulk_create([
        Service(service_code=code, name=name, description=desc, default_price=price, tax_percentage=tax)
        for code, name, desc, price, tax in DEFAULT_SERVICES])
    return len(DEFAULT_SERVICES)


class ServiceViewSet(viewsets.ModelViewSet):
    queryset = Service.objects.all()
    serializer_class = ServiceSerializer
    permission_classes = [permissions.AllowAny]

    def get_queryset(self):
        # Seed the common optical services once so the New Sale service picker and the
        # Service Master both open with a usable list instead of a blank table.
        if not Service.objects.exists():
            seed_default_services()
        return Service.objects.all()

    def perform_create(self, serializer):
        service_code = serializer.validated_data.get('service_code')
        if not service_code or Service.all_objects.filter(service_code=service_code).exists():
            service_code = _next_service_code()
        attempts_left = 3
        while True:
            try:
                with transaction.atomic():
                    serializer.save(service_code=service_code)
                return
            except IntegrityError:
                attempts_left -= 1
                if attempts_left <= 0:
                    raise
                service_code = _next_service_code()


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
    bank_account_name = serializers.CharField(source='bank_account.name', read_only=True, default=None)

    class Meta:
        model = WholesalePaymentCollection
        fields = '__all__'

    def validate_bank_account(self, value):
        return validate_bank_account(value)

class WholesaleReturnSerializer(ModelSerializer):
    class Meta:
        model = WholesaleReturn
        fields = '__all__'


class DealerViewSet(viewsets.ModelViewSet):
    queryset = Dealer.objects.all()
    serializer_class = DealerSerializer
    permission_classes = [permissions.AllowAny]

    def perform_destroy(self, instance):
        """Only a dealer nothing was ever billed / received / returned against can go: its
        invoices, receipts and returns all point at it (and its receivable ledger). Those
        dealers are set Inactive instead."""
        used = []
        if WholesaleInvoice.all_objects.filter(dealer=instance, is_deleted=False).exists():
            used.append('invoices')
        if WholesalePaymentCollection.all_objects.filter(dealer=instance, is_deleted=False).exists():
            used.append('payments')
        if WholesaleReturn.all_objects.filter(dealer=instance, is_deleted=False).exists():
            used.append('returns / credit notes')
        if used:
            raise serializers.ValidationError({'detail': (
                f"{instance.business_name} has {', '.join(used)} on record, so it can't be deleted. "
                "Set its status to Inactive instead.")})
        instance.delete()

    @action(detail=False, methods=['get'])
    def directory(self, request):
        """Every dealer with its billed business and what it still owes, for the Wholesale
        Dealers / Customers master. `bills_due` is worked out from the invoices themselves
        (grand total − paid − credit notes, per open bill: financial.settlements.open_bills), so it
        cannot drift the way the POS-maintained `outstanding_balance` column can."""
        from django.db.models import Count, Max, Sum
        from apps.financial.settlements import open_bills

        dealers = list(self.get_queryset().order_by('business_name'))
        ids = [d.pk for d in dealers]
        live = WholesaleInvoice.objects.filter(dealer_id__in=ids).exclude(
            status__in=('Draft', 'Cancelled', 'draft', 'cancelled'))
        stats = {row['dealer_id']: row for row in live.values('dealer_id').annotate(
            invoices=Count('id'), business=Sum('grand_total'), last=Max('invoice_date'))}
        bills_by_dealer = open_bills('dealer', party_ids=ids) if ids else {}
        due = {pid: sum((Decimal(str(b['due'])) for b in bills), Decimal('0')) for pid, bills in bills_by_dealer.items()}
        open_count = {pid: len(bills) for pid, bills in bills_by_dealer.items()}

        rows = []
        for d in dealers:
            s = stats.get(d.pk, {})
            row = DealerSerializer(d).data
            row.update({
                'invoice_count': s.get('invoices') or 0,
                'total_business': str(s.get('business') or Decimal('0.00')),
                'last_invoice_date': s.get('last'),
                'bills_due': str(due.get(d.pk, Decimal('0.00'))),
                'open_bill_count': open_count.get(d.pk, 0),
            })
            rows.append(row)
        return Response(rows)

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

class WholesaleInvoiceViewSet(EditApprovalMixin, viewsets.ModelViewSet):
    edit_module = 'wholesale'
    edit_ref_fields = ('invoice_number',)
    edit_draft_statuses = ('Draft',)
    edit_exempt_fields = ('details',)

    def edit_is_exempt(self, request, row):
        # The sync's one-off backfill of `details` onto a row posted before details existed.
        return set(request.data or {}) == {'details'} and not row.get('details')

    queryset = WholesaleInvoice.objects.select_related('dealer').order_by('-invoice_date', '-created_at')
    serializer_class = WholesaleInvoiceSerializer
    permission_classes = [permissions.AllowAny]

    # Every save deducts / restores stock to match the invoice (sales.wholesale_stock), in the
    # same transaction — a refused shortfall leaves neither the invoice nor the stock changed.
    def _sync_stock(self, invoice):
        from .wholesale_stock import sync_wholesale_invoice_stock
        invoice = WholesaleInvoice.all_objects.select_for_update().get(pk=invoice.pk)
        sync_wholesale_invoice_stock(invoice, self.request, enforce_stock=self._enforce_stock())

    def _enforce_stock(self):
        from apps.billing.views import user_role
        from apps.company.store_profile import STORE_SETTINGS_ROLES
        data = self.request.data if isinstance(self.request.data, dict) else {}
        return not (data.get('override_negative_stock') is True
                    and user_role(self.request.user) in STORE_SETTINGS_ROLES)

    def perform_create(self, serializer):
        with transaction.atomic():
            self._sync_stock(serializer.save())

    def perform_update(self, serializer):
        with transaction.atomic():
            self._sync_stock(serializer.save())

    def perform_destroy(self, instance):
        with transaction.atomic():
            invoice = WholesaleInvoice.all_objects.select_for_update().get(pk=instance.pk)
            invoice.is_deleted = True   # nothing held any more: restore it all
            from .wholesale_stock import sync_wholesale_invoice_stock
            sync_wholesale_invoice_stock(invoice, self.request, enforce_stock=False)
            invoice.delete()

    def get_queryset(self):
        qs = super().get_queryset()
        dealer = self.request.query_params.get('dealer')
        if dealer:
            qs = qs.filter(dealer_id=dealer)
        invoice_number = self.request.query_params.get('invoice_number')
        if invoice_number:
            qs = qs.filter(invoice_number=invoice_number)
        return qs

class WholesalePaymentCollectionViewSet(viewsets.ModelViewSet):
    queryset = WholesalePaymentCollection.objects.all()
    serializer_class = WholesalePaymentCollectionSerializer
    permission_classes = [permissions.AllowAny]

class WholesaleReturnViewSet(viewsets.ModelViewSet):
    queryset = WholesaleReturn.objects.all()
    serializer_class = WholesaleReturnSerializer
    permission_classes = [permissions.AllowAny]

