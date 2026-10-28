from decimal import Decimal
from django.db import models
from django.db.models.functions import Lower
from apps.common.models import BaseUUIDModel


class SupplierCodeSequence(models.Model):
    """Per-prefix atomic counter for human-readable Supplier.supplier_code values
    (see supplier_utils.reserve_supplier_codes). Mirrors apps.sales.PatientCodeSequence."""
    prefix = models.CharField(max_length=10, unique=True)
    last_number = models.BigIntegerField(default=1000)

    def __str__(self):
        return f"{self.prefix} (last: {self.last_number})"


class Supplier(BaseUUIDModel):
    # blank=True: SupplierViewSet.perform_create auto-generates one via reserve_supplier_codes
    # when omitted, but DRF's required-field validation runs before perform_create, so without
    # blank=True that auto-generation would be unreachable (same lesson as Invoice.invoice_number).
    supplier_code = models.CharField(max_length=30, unique=True, blank=True, null=True, db_index=True)
    name = models.CharField(max_length=150)
    company_name = models.CharField(max_length=150, blank=True, null=True)
    contact_person = models.CharField(max_length=150, blank=True, null=True)
    email = models.EmailField(blank=True, null=True)
    phone = models.CharField(max_length=20, blank=True, null=True)
    gstin = models.CharField(max_length=15, blank=True, null=True)
    address = models.TextField(blank=True, null=True)
    city = models.CharField(max_length=100, blank=True, null=True)
    payment_terms = models.CharField(max_length=50, blank=True, null=True, default='Net 30')
    # Bank account the supplier is paid into — distinct from `ledger_account` below, which is
    # the internal Chart of Accounts sub-ledger tracking what we owe them.
    account_number = models.CharField(max_length=50, blank=True, null=True)
    outstanding_balance = models.DecimalField(max_digits=12, decimal_places=2, default=Decimal('0.0'))
    # Auto-provisioned per-supplier Accounts Payable sub-ledger (see
    # supplier_utils.get_or_create_supplier_ledger_account, called from SupplierViewSet on
    # create) so each supplier appears individually in Chart of Accounts / General Ledger
    # instead of every supplier's dues being lumped into one shared "2001" account.
    ledger_account = models.ForeignKey(
        'financial.ChartOfAccount', on_delete=models.SET_NULL, null=True, blank=True, related_name='suppliers'
    )

    class Meta:
        constraints = [
            # One live supplier per company name (case-insensitive). SupplierSerializer.validate_name
            # gives the friendly error; this index closes the race between two concurrent saves.
            # Soft-deleted rows are excluded so a deleted supplier's name can be registered again.
            models.UniqueConstraint(
                Lower('name'), condition=models.Q(is_deleted=False),
                name='uniq_live_supplier_name_ci',
            ),
        ]

    def __str__(self):
        return self.name


class PurchaseOrder(BaseUUIDModel):
    STATUS_CHOICES = [
        ('DRAFT', 'Draft'),
        ('SENT', 'Sent to Supplier'),
        ('RECEIVED', 'Received'),
        ('CANCELLED', 'Cancelled'),
    ]

    order_number = models.CharField(max_length=50, unique=True)
    supplier = models.ForeignKey(Supplier, on_delete=models.CASCADE, related_name='purchase_orders')
    branch = models.ForeignKey('company.Branch', on_delete=models.SET_NULL, null=True, blank=True, db_index=True, related_name='+')
    order_date = models.DateField()
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default='DRAFT')
    total_amount = models.DecimalField(max_digits=12, decimal_places=2, default=Decimal('0.0'))
    tax_amount = models.DecimalField(max_digits=12, decimal_places=2, default=Decimal('0.0'))
    net_amount = models.DecimalField(max_digits=12, decimal_places=2, default=Decimal('0.0'))

    def __str__(self):
        return f"PO: {self.order_number}"


class PurchaseOrderItem(BaseUUIDModel):
    purchase_order = models.ForeignKey(PurchaseOrder, on_delete=models.CASCADE, related_name='items')
    product = models.ForeignKey('products.Product', on_delete=models.CASCADE)
    quantity = models.IntegerField()
    unit_price = models.DecimalField(max_digits=12, decimal_places=2)
    tax_rate = models.DecimalField(max_digits=5, decimal_places=2, default=Decimal('0.0'))  # Percentage
    tax_amount = models.DecimalField(max_digits=12, decimal_places=2, default=Decimal('0.0'))
    subtotal = models.DecimalField(max_digits=12, decimal_places=2)

    def __str__(self):
        return f"{self.product.name} ({self.quantity}pcs)"


class PurchaseInvoice(BaseUUIDModel):
    """Single-page ERP-style Purchase Entry: one full purchase transaction (header + items)."""

    PURCHASE_TYPE_CHOICES = [
        ('CASH', 'Cash'),
        ('CREDIT', 'Credit'),
    ]
    GST_TYPE_CHOICES = [
        ('EXCLUSIVE', 'Exclusive'),
        ('INCLUSIVE', 'Inclusive'),
        ('NO_GST', 'No GST'),
    ]
    STATUS_CHOICES = [
        ('DRAFT', 'Draft'),
        ('CONFIRMED', 'Confirmed'),
        ('CANCELLED', 'Cancelled'),
    ]
    PAYMENT_METHOD_CHOICES = [
        ('CASH', 'Cash'),
        ('BANK', 'Bank'),
        ('UPI', 'UPI'),
        ('CARD', 'Card'),
        ('CREDIT', 'Credit'),
    ]

    invoice_number = models.CharField(max_length=50, unique=True)
    supplier_invoice_number = models.CharField(max_length=100, blank=True, null=True)
    supplier = models.ForeignKey(Supplier, on_delete=models.CASCADE, related_name='purchase_invoices')

    purchase_date = models.DateField()
    due_date = models.DateField(blank=True, null=True)

    purchase_type = models.CharField(max_length=10, choices=PURCHASE_TYPE_CHOICES, default='CASH')
    warehouse = models.ForeignKey('company.Warehouse', on_delete=models.SET_NULL, null=True, blank=True, related_name='purchase_invoices')
    branch = models.ForeignKey('company.Branch', on_delete=models.SET_NULL, null=True, blank=True, related_name='purchase_invoices')
    gst_type = models.CharField(max_length=10, choices=GST_TYPE_CHOICES, default='EXCLUSIVE')
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default='CONFIRMED')

    # GST break-down (Indian GST compliance): interstate purchases are taxed as a single
    # IGST slab, intra-state ones are split evenly across CGST+SGST. Derived automatically
    # from the supplier's GSTIN state code vs the company's, at save time on the frontend.
    is_interstate = models.BooleanField(default=False)
    company_gstin = models.CharField(max_length=15, blank=True, null=True)
    supplier_gstin = models.CharField(max_length=15, blank=True, null=True)
    cgst_amount = models.DecimalField(max_digits=14, decimal_places=2, default=Decimal('0.0'))
    sgst_amount = models.DecimalField(max_digits=14, decimal_places=2, default=Decimal('0.0'))
    igst_amount = models.DecimalField(max_digits=14, decimal_places=2, default=Decimal('0.0'))
    cess_amount = models.DecimalField(max_digits=14, decimal_places=2, default=Decimal('0.0'))

    # VAT (Value Added Tax): still applicable to a handful of goods excluded from GST
    # (e.g. petroleum, alcohol). Tracked as a separate additive tax alongside GST/Cess.
    supplier_vat_number = models.CharField(max_length=30, blank=True, null=True)
    vat_amount = models.DecimalField(max_digits=14, decimal_places=2, default=Decimal('0.0'))

    purchase_order_ref = models.CharField(max_length=100, blank=True, null=True)
    purchase_return_ref = models.CharField(max_length=100, blank=True, null=True)
    notes = models.TextField(blank=True, null=True)

    gross_amount = models.DecimalField(max_digits=14, decimal_places=2, default=Decimal('0.0'))
    discount_amount = models.DecimalField(max_digits=14, decimal_places=2, default=Decimal('0.0'))
    tax_amount = models.DecimalField(max_digits=14, decimal_places=2, default=Decimal('0.0'))
    other_charges = models.DecimalField(max_digits=14, decimal_places=2, default=Decimal('0.0'))
    round_off = models.DecimalField(max_digits=8, decimal_places=2, default=Decimal('0.0'))
    grand_total = models.DecimalField(max_digits=14, decimal_places=2, default=Decimal('0.0'))

    payment_method = models.CharField(max_length=10, choices=PAYMENT_METHOD_CHOICES, default='CASH')
    paid_amount = models.DecimalField(max_digits=14, decimal_places=2, default=Decimal('0.0'))
    balance_amount = models.DecimalField(max_digits=14, decimal_places=2, default=Decimal('0.0'))
    # BANK / UPI payments: which bank ledger (a BANK-subtype Chart of Accounts row) the money
    # went to or came from. Blank = the generic Bank / UPI role mapping (see financial/banks.py).
    bank_account = models.ForeignKey('financial.ChartOfAccount', on_delete=models.SET_NULL, null=True, blank=True, related_name='+')
    # CASH payments: whether the cash was actually handed over ('PAID') or is still owed
    # ('UNPAID'). Blank = saved before this existed (a CASH purchase then counts as paid).
    PAYMENT_STATUS_CHOICES = [('PAID', 'Paid'), ('UNPAID', 'Unpaid')]
    payment_status = models.CharField(max_length=10, choices=PAYMENT_STATUS_CHOICES, blank=True, default='')

    attachment = models.FileField(upload_to='purchase_attachments/', blank=True, null=True)

    def __str__(self):
        return f"Purchase Entry: {self.invoice_number}"


class PurchaseInvoiceItem(BaseUUIDModel):
    purchase_invoice = models.ForeignKey(PurchaseInvoice, on_delete=models.CASCADE, related_name='items')
    product = models.ForeignKey('products.Product', on_delete=models.CASCADE, related_name='purchase_invoice_items')

    barcode = models.CharField(max_length=150, blank=True, null=True)
    batch_number = models.CharField(max_length=100, blank=True, null=True)
    expiry_date = models.DateField(blank=True, null=True)

    quantity = models.DecimalField(max_digits=10, decimal_places=2, default=Decimal('0.0'))
    free_quantity = models.DecimalField(max_digits=10, decimal_places=2, default=Decimal('0.0'))
    purchase_rate = models.DecimalField(max_digits=12, decimal_places=2, default=Decimal('0.0'))

    discount_percent = models.DecimalField(max_digits=5, decimal_places=2, default=Decimal('0.0'))
    discount_amount = models.DecimalField(max_digits=12, decimal_places=2, default=Decimal('0.0'))

    gst_percent = models.DecimalField(max_digits=5, decimal_places=2, default=Decimal('0.0'))
    gst_amount = models.DecimalField(max_digits=12, decimal_places=2, default=Decimal('0.0'))

    hsn_code = models.CharField(max_length=15, blank=True, null=True)
    cgst_percent = models.DecimalField(max_digits=5, decimal_places=2, default=Decimal('0.0'))
    cgst_amount = models.DecimalField(max_digits=12, decimal_places=2, default=Decimal('0.0'))
    sgst_percent = models.DecimalField(max_digits=5, decimal_places=2, default=Decimal('0.0'))
    sgst_amount = models.DecimalField(max_digits=12, decimal_places=2, default=Decimal('0.0'))
    igst_percent = models.DecimalField(max_digits=5, decimal_places=2, default=Decimal('0.0'))
    igst_amount = models.DecimalField(max_digits=12, decimal_places=2, default=Decimal('0.0'))
    cess_percent = models.DecimalField(max_digits=5, decimal_places=2, default=Decimal('0.0'))
    cess_amount = models.DecimalField(max_digits=12, decimal_places=2, default=Decimal('0.0'))
    vat_percent = models.DecimalField(max_digits=5, decimal_places=2, default=Decimal('0.0'))
    vat_amount = models.DecimalField(max_digits=12, decimal_places=2, default=Decimal('0.0'))

    mrp = models.DecimalField(max_digits=12, decimal_places=2, default=Decimal('0.0'))
    selling_price = models.DecimalField(max_digits=12, decimal_places=2, default=Decimal('0.0'))
    margin_percent = models.DecimalField(max_digits=6, decimal_places=2, default=Decimal('0.0'))

    line_total = models.DecimalField(max_digits=14, decimal_places=2, default=Decimal('0.0'))

    def __str__(self):
        return f"{self.product.name} ({self.quantity}pcs) - Inv {self.purchase_invoice.invoice_number}"


# ==========================================
# LENS PURCHASE ORDER (Purchase → Lens Purchase Order)
# ==========================================
# A request to a lab for prescription lenses, each physical lens mapped to the customer order it
# was made for. Creating / receiving one never moves stock or posts accounting: the goods come in
# through the ordinary Purchase Entry (PurchaseInvoice) the PO is converted into, which links back
# here through `purchase_invoice` (one-to-one, so a PO can never be billed twice).
# Workflow and validation live in apps/purchasing/lens_orders.py.

class LensPurchaseOrder(BaseUUIDModel):
    STATUS_CHOICES = [
        ('DRAFT', 'Draft'),
        ('PENDING', 'Pending'),
        ('ORDERED', 'Ordered'),
        ('PARTIALLY_RECEIVED', 'Partially Received'),
        ('RECEIVED', 'Received'),
        ('CANCELLED', 'Cancelled'),
    ]

    po_number = models.CharField(max_length=50, unique=True)
    supplier = models.ForeignKey(Supplier, on_delete=models.PROTECT, related_name='lens_purchase_orders')
    branch = models.ForeignKey('company.Branch', on_delete=models.SET_NULL, null=True, blank=True, db_index=True, related_name='+')
    order_date = models.DateField()
    expected_delivery_date = models.DateField(null=True, blank=True)
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default='DRAFT', db_index=True)
    remarks = models.TextField(blank=True, default='')
    # Who raised it (request actor — same identity the stock ledger records).
    created_by_name = models.CharField(max_length=150, blank=True, default='')
    purchase_invoice = models.OneToOneField(
        PurchaseInvoice, on_delete=models.SET_NULL, null=True, blank=True, related_name='lens_purchase_order')
    # Append-only audit trail: [{at, by, action, detail}] — creation, submission, vendor /
    # assignment / prescription changes, receipts, discrepancies, conversion, cancellation and
    # every sales-order status this PO moved (with the status it moved from).
    history = models.JSONField(default=list, blank=True)

    class Meta:
        ordering = ['-order_date', '-created_at']

    def __str__(self):
        return f"Lens PO: {self.po_number}"


class LensPurchaseOrderItem(BaseUUIDModel):
    """One lens model line: a pair for one customer, a pair split between two customers, or a
    single lens. Its physical lenses are the `pieces` below."""
    SINGLE_PAIR, SPLIT_PAIR, SINGLE_PIECE = 'SINGLE_PAIR', 'SPLIT_PAIR', 'SINGLE_PIECE'
    ORDER_TYPE_CHOICES = [
        (SINGLE_PAIR, 'Single Customer — 1 Pair'),
        (SPLIT_PAIR, 'Split Pair — 2 Customers'),
        (SINGLE_PIECE, 'Single Lens — 1 Piece'),
    ]

    order = models.ForeignKey(LensPurchaseOrder, on_delete=models.CASCADE, related_name='items')
    product = models.ForeignKey('products.Product', on_delete=models.PROTECT, related_name='lens_po_items')
    # Snapshot of the lens as ordered (the product master can be renamed later).
    lens_model = models.CharField(max_length=255, blank=True, default='')
    lens_type = models.CharField(max_length=100, blank=True, default='')
    lens_index = models.CharField(max_length=30, blank=True, default='')
    lens_coating = models.CharField(max_length=100, blank=True, default='')
    order_type = models.CharField(max_length=20, choices=ORDER_TYPE_CHOICES)
    # Commercial (what the lab prices: 1 PAIR / 1 PIECE) vs physical (lenses, always pieces).
    commercial_quantity = models.PositiveIntegerField(default=1)
    commercial_unit = models.CharField(max_length=10, default='PAIR')
    physical_quantity = models.PositiveIntegerField(default=2)
    physical_unit = models.CharField(max_length=10, default='PIECE')
    unit_price = models.DecimalField(max_digits=12, decimal_places=2, default=Decimal('0.0'))
    pricing_unit = models.CharField(max_length=10, default='PAIR')
    discount_amount = models.DecimalField(max_digits=12, decimal_places=2, default=Decimal('0.0'))
    tax_percent = models.DecimalField(max_digits=5, decimal_places=2, default=Decimal('0.0'))
    line_total = models.DecimalField(max_digits=14, decimal_places=2, default=Decimal('0.0'))
    status = models.CharField(max_length=20, default='PENDING')  # PENDING | PARTIALLY_RECEIVED | RECEIVED | CANCELLED

    class Meta:
        ordering = ['created_at']


class LensPurchaseOrderPiece(BaseUUIDModel):
    """One physical lens and the customer order it is for."""
    RECEIVING_CHOICES = [
        ('PENDING', 'Pending'),
        ('RECEIVED', 'Received'),
        ('DAMAGED', 'Damaged'),
        ('MISSING', 'Missing'),
        ('INCORRECT', 'Incorrect'),
    ]

    item = models.ForeignKey(LensPurchaseOrderItem, on_delete=models.CASCADE, related_name='pieces')
    piece_number = models.PositiveSmallIntegerField(default=1)
    customer = models.ForeignKey('sales.Customer', on_delete=models.SET_NULL, null=True, blank=True, related_name='+')
    customer_name = models.CharField(max_length=150, blank=True, default='')
    sales_order = models.ForeignKey('sales.Invoice', on_delete=models.PROTECT, related_name='lens_po_pieces')
    # New Sale edits recreate the order's lines, so this is a convenience link only; the
    # requirement a piece fills is identified by (sales_order, product, eye).
    sales_order_item = models.ForeignKey('sales.InvoiceItem', on_delete=models.SET_NULL, null=True, blank=True, related_name='+')
    eye = models.CharField(max_length=2)  # RE (OD) | LE (OS)
    # {sph, cyl, axis, add, prism, base} sent to the lab, and the order's prescription it was
    # taken from. They differ only with an rx_change_reason; the sales order is never rewritten.
    rx = models.JSONField(default=dict, blank=True)
    original_rx = models.JSONField(default=dict, blank=True)
    rx_change_reason = models.CharField(max_length=255, blank=True, default='')
    piece_reference = models.CharField(max_length=100, blank=True, default='')
    receiving_status = models.CharField(max_length=12, choices=RECEIVING_CHOICES, default='PENDING')
    received_at = models.DateTimeField(null=True, blank=True)
    received_by = models.CharField(max_length=150, blank=True, default='')
    discrepancy_notes = models.CharField(max_length=255, blank=True, default='')
    # Mirrors the linked order's readiness: WAITING until every lens it needs has arrived.
    fitting_status = models.CharField(max_length=20, default='PENDING')  # PENDING | WAITING | READY_FOR_FITTING

    class Meta:
        ordering = ['piece_number']
