from django.db import models
from apps.common.models import BaseUUIDModel


class PatientCodeSequence(models.Model):
    """Per-prefix atomic counter for human-readable Customer.patient_code values
    (see patient_utils.reserve_patient_code). Mirrors apps.products.BarcodeSequence."""
    prefix = models.CharField(max_length=10, unique=True)
    last_number = models.BigIntegerField(default=1000)

    def __str__(self):
        return f"{self.prefix} -> {self.last_number}"


class TestNoSequence(models.Model):
    """Single global atomic counter for Test Number, shared across Appointment and
    EyeExamination so it stays one continuous sequence regardless of which screen a test
    was first registered from (see patient_utils.reserve_test_numbers)."""
    prefix = models.CharField(max_length=10, unique=True)
    last_number = models.BigIntegerField(default=1000)

    def __str__(self):
        return f"{self.prefix} -> {self.last_number}"


class Customer(BaseUUIDModel):
    # Human-readable id (e.g. "P-1001") assigned atomically on first save — this is the id
    # every frontend page (Eye Test, Appointments, Patient History) actually matches patients
    # on, since the real primary key is an opaque UUID. Previously each page independently
    # guessed the "next" P-xxxx number from whatever local data it happened to have loaded,
    # which let two different patients collide on the same code; this field/sequence makes
    # that guess a single, backend-guaranteed-unique source of truth instead.
    patient_code = models.CharField(max_length=20, unique=True, blank=True, null=True, db_index=True)
    name = models.CharField(max_length=150)
    email = models.EmailField(blank=True, null=True)
    phone = models.CharField(max_length=20, blank=True, null=True)
    age = models.CharField(max_length=10, blank=True, null=True)
    gender = models.CharField(max_length=20, blank=True, null=True)
    address = models.TextField(blank=True, null=True)
    place = models.CharField(max_length=150, blank=True, null=True)
    # Identity document — id_type is free text (Passport, Aadhaar, Omang, National ID, ...)
    # rather than a choices= enum since acceptable ID documents vary by country/branch.
    id_type = models.CharField(max_length=50, blank=True, null=True)
    id_number = models.CharField(max_length=100, blank=True, null=True)
    medical_aid_name = models.CharField(max_length=150, blank=True, null=True)
    medical_aid_scheme = models.CharField(max_length=150, blank=True, null=True)
    medical_aid_member_number = models.CharField(max_length=100, blank=True, null=True)
    outstanding_balance = models.DecimalField(max_digits=12, decimal_places=2, default=0.0)
    credit_limit = models.DecimalField(max_digits=12, decimal_places=2, default=5000.0)

    def __str__(self):
        return self.name


class Service(BaseUUIDModel):
    """Service Master — dispensable optical services (frame repair, fitting, adjustment,
    cleaning, parts replacement, ...) billed on the same Invoice as products and lenses.
    Managed from Administration -> Service Master."""
    # Human-readable code (SRV001, SRV002, ...) assigned atomically on create by
    # ServiceViewSet.perform_create when the client doesn't send one.
    service_code = models.CharField(max_length=20, unique=True, blank=True, db_index=True)
    name = models.CharField(max_length=150)
    description = models.TextField(blank=True, null=True)
    default_price = models.DecimalField(max_digits=12, decimal_places=2, default=0.0)
    tax_percentage = models.DecimalField(max_digits=5, decimal_places=2, default=0.0)  # Percentage
    is_active = models.BooleanField(default=True)

    class Meta:
        ordering = ['service_code']

    def __str__(self):
        return f"{self.service_code} - {self.name}"


class Invoice(BaseUUIDModel):
    STATUS_CHOICES = [
        ('DRAFT', 'Draft'),
        ('PAID', 'Paid'),
        ('PARTIAL', 'Partially Paid'),
        ('UNPAID', 'Unpaid'),
        ('CANCELLED', 'Cancelled'),
    ]

    # blank=True: the serializer must not require this upfront — InvoiceViewSet.perform_create
    # auto-generates one when omitted, but DRF's own required-field validation runs before
    # perform_create is ever reached, so without blank=True that auto-generation was unreachable.
    invoice_number = models.CharField(max_length=50, unique=True, blank=True)
    # Nullable: POS Billing genuinely supports anonymous walk-in sales (buy sunglasses, no
    # patient record needed) — a required FK here would force fabricating a fake Customer row
    # for every such sale just to satisfy the constraint. SET_NULL (not CASCADE) so deleting a
    # Customer later doesn't wipe out their purchase history.
    customer = models.ForeignKey(Customer, on_delete=models.SET_NULL, null=True, blank=True, related_name='invoices')
    invoice_date = models.DateField()
    # Branch this sale belongs to. Nullable + SET_NULL for backward compatibility with rows
    # created before Multi-Branch existed (a data migration backfills them to the default
    # branch). Stamped automatically by BranchScopedViewSetMixin from the active branch.
    branch = models.ForeignKey('company.Branch', on_delete=models.SET_NULL, null=True, blank=True, db_index=True, related_name='+')
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default='UNPAID')
    # Separate from `status` on purpose: `status` tracks PAYMENT state (choice-restricted to
    # DRAFT/PAID/PARTIAL/UNPAID/CANCELLED) while the Orders tab tracks LAB/FULFILLMENT progress
    # (Order Received -> In Lab Processing -> ... -> Delivered) — an unrelated axis. No choices=
    # restriction here since OrdersManagerView.jsx owns and can extend this workflow's stage list.
    fulfillment_status = models.CharField(max_length=30, blank=True, null=True)

    total_amount = models.DecimalField(max_digits=12, decimal_places=2, default=0.0)
    tax_amount = models.DecimalField(max_digits=12, decimal_places=2, default=0.0)
    discount_amount = models.DecimalField(max_digits=12, decimal_places=2, default=0.0)
    net_amount = models.DecimalField(max_digits=12, decimal_places=2, default=0.0)
    
    paid_amount = models.DecimalField(max_digits=12, decimal_places=2, default=0.0)
    payment_method = models.CharField(max_length=50, blank=True, null=True)  # Cash, Card, Bank, UPI

    def __str__(self):
        return f"Inv: {self.invoice_number}"


class InvoiceItem(BaseUUIDModel):
    invoice = models.ForeignKey(Invoice, on_delete=models.CASCADE, related_name='items')
    # Nullable + SET_NULL (not the original required CASCADE): POS/New Sale both support ad-hoc
    # "custom charge" line items (frame repair, one-off service, ...) that were never in the
    # Product catalog, so there's no Product row to point at. `description` snapshots the name
    # either way, so the line item still reads correctly even when product is None or later
    # deleted from the catalog.
    product = models.ForeignKey('products.Product', on_delete=models.SET_NULL, null=True, blank=True)
    # 'PRODUCT' | 'LENS' | 'SERVICE' — lets the billing grid, invoice print and reports tell a
    # dispensed service (frame repair, fitting) apart from a stocked product without having to
    # infer it from whether `product` is null. Plain CharField (no choices=) so the frontend
    # stays free to extend the vocabulary, same rationale as Invoice.fulfillment_status.
    item_type = models.CharField(max_length=20, default='PRODUCT')
    # Set for SERVICE lines that came from the Service Master (null for ad-hoc / custom services).
    service = models.ForeignKey('sales.Service', on_delete=models.SET_NULL, null=True, blank=True, related_name='+')
    # Optional repair job-card details for SERVICE lines — customer_item, problem_description,
    # estimated_delivery, technician, service_status. Free-form JSON so simple services
    # (fitting, adjustment) can be added without filling any of it.
    service_details = models.JSONField(blank=True, null=True)
    description = models.CharField(max_length=255, blank=True, null=True)
    quantity = models.IntegerField()
    unit_price = models.DecimalField(max_digits=12, decimal_places=2)
    tax_rate = models.DecimalField(max_digits=5, decimal_places=2, default=0.0)  # Percentage
    tax_amount = models.DecimalField(max_digits=12, decimal_places=2, default=0.0)
    subtotal = models.DecimalField(max_digits=12, decimal_places=2)

    def __str__(self):
        return f"{self.description or (self.product.name if self.product else 'Item')} ({self.quantity}pcs)"


class Payment(BaseUUIDModel):
    # Retail payment receipts — distinct from Invoice.paid_amount (a running total on the
    # invoice itself) since a single invoice can be settled across multiple receipts over time
    # (advance at booking, balance on collection, etc.), and the Payments tab needs to list each
    # one individually.
    receipt_no = models.CharField(max_length=50, unique=True, blank=True, null=True, db_index=True)
    branch = models.ForeignKey('company.Branch', on_delete=models.SET_NULL, null=True, blank=True, db_index=True, related_name='+')
    invoice = models.ForeignKey(Invoice, on_delete=models.SET_NULL, null=True, blank=True, related_name='payments')
    customer = models.ForeignKey(Customer, on_delete=models.SET_NULL, null=True, blank=True, related_name='payments')
    # Denormalized snapshot so the receipt still displays correctly even if the Customer is
    # later edited/removed, same rationale as Appointment.patient_name.
    customer_name = models.CharField(max_length=150, blank=True, null=True)
    amount = models.DecimalField(max_digits=12, decimal_places=2, default=0.0)
    method = models.CharField(max_length=50, blank=True, null=True)
    payment_date = models.DateField()
    status = models.CharField(max_length=20, default='Completed')
    notes = models.TextField(blank=True, null=True)

    class Meta:
        ordering = ['-payment_date', '-created_at']

    def __str__(self):
        return f"{self.receipt_no or self.id} - {self.customer_name} (₹{self.amount})"


class EyeExamination(BaseUUIDModel):
    # Real link to the Customer record (in addition to the legacy patient_id/patient_name
    # snapshot fields below, kept for backward compatibility with already-saved exams and for
    # walk-ins examined before a Customer row exists yet).
    customer = models.ForeignKey(Customer, on_delete=models.SET_NULL, null=True, blank=True, related_name='eye_examinations')

    # Patient Profile
    patient_id = models.CharField(max_length=50)
    patient_name = models.CharField(max_length=150)
    age = models.CharField(max_length=10, blank=True, null=True)
    gender = models.CharField(max_length=20, blank=True, null=True)
    phone = models.CharField(max_length=50, blank=True, null=True)
    email = models.CharField(max_length=100, blank=True, null=True)
    address = models.TextField(blank=True, null=True)
    occupation = models.CharField(max_length=100, blank=True, null=True)
    
    # Metadata
    # blank=True: EyeExaminationViewSet.perform_create auto-generates one via
    # reserve_test_numbers when omitted (same lesson as Invoice.invoice_number).
    test_no = models.CharField(max_length=20, blank=True, null=True)
    appointment_id = models.CharField(max_length=50, blank=True, null=True)
    visit_number = models.CharField(max_length=50, blank=True, null=True)
    branch = models.CharField(max_length=100, blank=True, null=True)
    optometrist = models.CharField(max_length=100, blank=True, null=True)
    examination_date = models.DateTimeField(auto_now_add=True)

    # Tab 2: Complaints & History
    complaints = models.TextField(blank=True, null=True) # Comma-separated or JSON list
    complaint_duration = models.CharField(max_length=50, blank=True, null=True)
    glasses_usage = models.CharField(max_length=50, blank=True, null=True)
    medical_history = models.TextField(blank=True, null=True)
    allergies = models.TextField(blank=True, null=True)
    family_history = models.TextField(blank=True, null=True)

    # Tab 3: Visual Acuity
    va_od_distance_unaided = models.CharField(max_length=50, blank=True, null=True)
    va_od_distance_corrected = models.CharField(max_length=50, blank=True, null=True)
    va_od_pinhole = models.CharField(max_length=50, blank=True, null=True)
    va_od_near = models.CharField(max_length=50, blank=True, null=True)

    va_os_distance_unaided = models.CharField(max_length=50, blank=True, null=True)
    va_os_distance_corrected = models.CharField(max_length=50, blank=True, null=True)
    va_os_pinhole = models.CharField(max_length=50, blank=True, null=True)
    va_os_near = models.CharField(max_length=50, blank=True, null=True)

    va_ou_binocular = models.CharField(max_length=50, blank=True, null=True)
    va_ou_stereo = models.CharField(max_length=50, blank=True, null=True)
    va_ou_dominant = models.CharField(max_length=50, blank=True, null=True)
    va_ou_fusion = models.CharField(max_length=50, blank=True, null=True)

    # Tab 4: Objective Refraction
    ar_sph_od = models.CharField(max_length=20, blank=True, null=True)
    ar_cyl_od = models.CharField(max_length=20, blank=True, null=True)
    ar_axis_od = models.CharField(max_length=20, blank=True, null=True)
    ar_vertex_od = models.CharField(max_length=20, blank=True, null=True)
    ar_pupil_od = models.CharField(max_length=20, blank=True, null=True)

    ar_sph_os = models.CharField(max_length=20, blank=True, null=True)
    ar_cyl_os = models.CharField(max_length=20, blank=True, null=True)
    ar_axis_os = models.CharField(max_length=20, blank=True, null=True)
    ar_vertex_os = models.CharField(max_length=20, blank=True, null=True)
    ar_pupil_os = models.CharField(max_length=20, blank=True, null=True)

    k1_od = models.CharField(max_length=20, blank=True, null=True)
    k2_od = models.CharField(max_length=20, blank=True, null=True)
    k_axis_od = models.CharField(max_length=20, blank=True, null=True)
    k1_os = models.CharField(max_length=20, blank=True, null=True)
    k2_os = models.CharField(max_length=20, blank=True, null=True)
    k_axis_os = models.CharField(max_length=20, blank=True, null=True)

    distance_pd = models.CharField(max_length=20, blank=True, null=True)
    near_pd = models.CharField(max_length=20, blank=True, null=True)
    iop_od = models.CharField(max_length=20, blank=True, null=True)
    iop_os = models.CharField(max_length=20, blank=True, null=True)

    # Tab 5: Subjective Refraction
    sub_sph_od = models.CharField(max_length=20, blank=True, null=True)
    sub_cyl_od = models.CharField(max_length=20, blank=True, null=True)
    sub_axis_od = models.CharField(max_length=20, blank=True, null=True)
    sub_va_od = models.CharField(max_length=20, blank=True, null=True)
    sub_add_od = models.CharField(max_length=20, blank=True, null=True)
    sub_prism_od = models.CharField(max_length=20, blank=True, null=True)

    sub_sph_os = models.CharField(max_length=20, blank=True, null=True)
    sub_cyl_os = models.CharField(max_length=20, blank=True, null=True)
    sub_axis_os = models.CharField(max_length=20, blank=True, null=True)
    sub_va_os = models.CharField(max_length=20, blank=True, null=True)
    sub_add_os = models.CharField(max_length=20, blank=True, null=True)
    sub_prism_os = models.CharField(max_length=20, blank=True, null=True)

    binocular_balance = models.CharField(max_length=100, blank=True, null=True)
    phoria_test = models.CharField(max_length=100, blank=True, null=True)
    npc = models.CharField(max_length=50, blank=True, null=True)

    # Tab 6: Eye Health
    eyelids = models.CharField(max_length=50, blank=True, null=True)
    conjunctiva = models.CharField(max_length=50, blank=True, null=True)
    cornea = models.CharField(max_length=50, blank=True, null=True)
    anterior_chamber = models.CharField(max_length=50, blank=True, null=True)
    lens_state = models.CharField(max_length=50, blank=True, null=True)
    optic_disc = models.CharField(max_length=150, blank=True, null=True)
    retina = models.CharField(max_length=150, blank=True, null=True)
    pupillary_reflex = models.CharField(max_length=100, blank=True, null=True)
    tear_film = models.CharField(max_length=100, blank=True, null=True)

    # PGP (Previous Glasses Prescription)
    pgp_od_sph = models.CharField(max_length=20, blank=True, null=True)
    pgp_od_cyl = models.CharField(max_length=20, blank=True, null=True)
    pgp_od_axis = models.CharField(max_length=20, blank=True, null=True)
    pgp_od_va = models.CharField(max_length=20, blank=True, null=True)
    pgp_od_add = models.CharField(max_length=20, blank=True, null=True)
    pgp_od_add_va = models.CharField(max_length=20, blank=True, null=True)

    pgp_os_sph = models.CharField(max_length=20, blank=True, null=True)
    pgp_os_cyl = models.CharField(max_length=20, blank=True, null=True)
    pgp_os_axis = models.CharField(max_length=20, blank=True, null=True)
    pgp_os_va = models.CharField(max_length=20, blank=True, null=True)
    pgp_os_add = models.CharField(max_length=20, blank=True, null=True)
    pgp_os_add_va = models.CharField(max_length=20, blank=True, null=True)
    previous_glasses_date = models.CharField(max_length=50, blank=True, null=True)

    # Near VA for Subjective Refraction
    sub_add_va_od = models.CharField(max_length=20, blank=True, null=True)
    sub_add_va_os = models.CharField(max_length=20, blank=True, null=True)

    # Diagnosis & Rx Summary
    primary_diagnosis = models.CharField(max_length=255, blank=True, null=True)
    rx_summary = models.TextField(blank=True, null=True)

    # Complete raw state payload for single-screen form
    raw_data = models.JSONField(blank=True, null=True)

    # Tab 7: Contact Lens Trial
    cl_brand = models.CharField(max_length=100, blank=True, null=True)
    cl_type = models.CharField(max_length=100, blank=True, null=True)
    cl_power = models.CharField(max_length=50, blank=True, null=True)
    cl_bc = models.CharField(max_length=50, blank=True, null=True)
    cl_dia = models.CharField(max_length=50, blank=True, null=True)
    cl_wear_time = models.CharField(max_length=50, blank=True, null=True)
    cl_comfort = models.CharField(max_length=50, blank=True, null=True)
    cl_recommend = models.TextField(blank=True, null=True)

    # Tab 9: Recommendations
    rec_lens_type = models.CharField(max_length=100, blank=True, null=True)
    rec_lens_brand = models.CharField(max_length=100, blank=True, null=True)
    rec_lens_coating = models.CharField(max_length=150, blank=True, null=True)
    rec_frame_shape = models.CharField(max_length=100, blank=True, null=True)
    rec_frame_brand = models.CharField(max_length=100, blank=True, null=True)
    rec_frame_color = models.CharField(max_length=100, blank=True, null=True)
    rec_frame_size = models.CharField(max_length=50, blank=True, null=True)
    follow_up_date = models.CharField(max_length=50, blank=True, null=True)
    follow_up_interval = models.CharField(max_length=50, blank=True, null=True)

    def __str__(self):
        return f"Exam for {self.patient_name} on {self.examination_date.date() if self.examination_date else 'N/A'}"


class Appointment(BaseUUIDModel):
    # Free-text, not an enforced choices= enum: the Appointments.jsx UI already has its own
    # richer status/priority vocabulary ("Booked", "Standard Booking", "VIP Patient", ...) and
    # a DRF ChoiceField would 400-reject anything outside a fixed enum. Kept as plain CharFields
    # so the frontend stays the single source of truth for these labels.
    appointment_code = models.CharField(max_length=30, unique=True, blank=True, null=True, db_index=True)
    token = models.CharField(max_length=20, blank=True, null=True)

    # Real link to the patient record — the primary purpose of this model existing at all is
    # so Eye Test / Appointments / Patient History can all resolve back to the SAME Customer
    # row instead of three independent, drifting copies of the same person's details.
    customer = models.ForeignKey(Customer, on_delete=models.SET_NULL, null=True, blank=True, related_name='appointments')
    # Denormalized snapshot, kept in sync with customer at booking time — lets the appointment
    # keep showing correctly even if the linked Customer is later edited or removed, and covers
    # walk-in bookings taken before a full Customer record exists.
    patient_name = models.CharField(max_length=150)
    # Assigned at booking time (front-desk can tell the patient their number right away) and
    # carried through to the Eye Test form when "Start Eye Test" is clicked from this
    # appointment, so it doesn't need to be re-derived/re-typed there.
    test_no = models.CharField(max_length=20, blank=True, null=True)
    phone = models.CharField(max_length=20, blank=True, null=True)
    email = models.CharField(max_length=100, blank=True, null=True)
    age = models.CharField(max_length=10, blank=True, null=True)
    gender = models.CharField(max_length=20, blank=True, null=True)
    id_type = models.CharField(max_length=50, blank=True, null=True)
    id_number = models.CharField(max_length=100, blank=True, null=True)
    medical_aid_name = models.CharField(max_length=150, blank=True, null=True)
    medical_aid_scheme = models.CharField(max_length=150, blank=True, null=True)
    medical_aid_member_number = models.CharField(max_length=100, blank=True, null=True)

    doctor = models.CharField(max_length=150, blank=True, null=True)
    appointment_date = models.DateField()
    appointment_time = models.CharField(max_length=20, blank=True, null=True)
    appointment_type = models.CharField(max_length=50, blank=True, null=True)
    branch = models.CharField(max_length=100, blank=True, null=True)
    room = models.CharField(max_length=50, blank=True, null=True)
    priority = models.CharField(max_length=40, default='Standard Booking')
    status = models.CharField(max_length=20, default='Booked')
    send_whatsapp = models.BooleanField(default=False)
    notes = models.TextField(blank=True, null=True)

    class Meta:
        ordering = ['-appointment_date', '-created_at']

    def __str__(self):
        return f"{self.patient_name} - {self.appointment_date} ({self.status})"


# ==========================================
# WHOLESALE SALES MODULE MODELS
# ==========================================

class Dealer(BaseUUIDModel):
    dealer_code = models.CharField(max_length=50, unique=True)
    business_name = models.CharField(max_length=200)
    owner_name = models.CharField(max_length=150, blank=True, null=True)
    gstin = models.CharField(max_length=20, blank=True, null=True)
    license_number = models.CharField(max_length=100, blank=True, null=True)
    contact_person = models.CharField(max_length=150, blank=True, null=True)
    phone = models.CharField(max_length=20)
    whatsapp_number = models.CharField(max_length=20, blank=True, null=True)
    email = models.EmailField(blank=True, null=True)
    address = models.TextField(blank=True, null=True)
    city = models.CharField(max_length=100, blank=True, null=True)
    state = models.CharField(max_length=100, blank=True, null=True)
    pincode = models.CharField(max_length=20, blank=True, null=True)
    credit_limit = models.DecimalField(max_digits=12, decimal_places=2, default=50000.00)
    credit_days = models.IntegerField(default=30)
    opening_balance = models.DecimalField(max_digits=12, decimal_places=2, default=0.00)
    outstanding_balance = models.DecimalField(max_digits=12, decimal_places=2, default=0.00)
    category = models.CharField(max_length=50, default='Optical Shop')
    sales_executive = models.CharField(max_length=100, blank=True, null=True)
    status = models.CharField(max_length=20, default='Active')

    def __str__(self):
        return f"{self.business_name} ({self.dealer_code})"

WholesaleCustomer = Dealer


class WholesalePriceList(BaseUUIDModel):
    dealer = models.ForeignKey(Dealer, on_delete=models.CASCADE, related_name='price_overrides', blank=True, null=True)
    dealer_category = models.CharField(max_length=50, blank=True, null=True)
    product_name = models.CharField(max_length=200)
    brand = models.CharField(max_length=100, blank=True, null=True)
    category = models.CharField(max_length=100, blank=True, null=True)
    min_quantity = models.IntegerField(default=1)
    wholesale_price = models.DecimalField(max_digits=12, decimal_places=2)
    discount_percentage = models.DecimalField(max_digits=5, decimal_places=2, default=0.00)

    def __str__(self):
        return f"{self.product_name} - ₹{self.wholesale_price}"


class WholesaleQuotation(BaseUUIDModel):
    quotation_number = models.CharField(max_length=50, unique=True)
    dealer = models.ForeignKey(Dealer, on_delete=models.CASCADE, related_name='quotations')
    date = models.DateField()
    expiry_date = models.DateField()
    subtotal = models.DecimalField(max_digits=12, decimal_places=2, default=0.00)
    tax_amount = models.DecimalField(max_digits=12, decimal_places=2, default=0.00)
    transport_charges = models.DecimalField(max_digits=12, decimal_places=2, default=0.00)
    grand_total = models.DecimalField(max_digits=12, decimal_places=2, default=0.00)
    status = models.CharField(max_length=20, default='Draft')
    terms = models.TextField(blank=True, null=True)

    def __str__(self):
        return f"Quote {self.quotation_number} - {self.dealer.business_name}"


class WholesaleOrder(BaseUUIDModel):
    order_number = models.CharField(max_length=50, unique=True)
    dealer = models.ForeignKey(Dealer, on_delete=models.CASCADE, related_name='wholesale_orders')
    quotation_ref = models.CharField(max_length=50, blank=True, null=True)
    order_date = models.DateField()
    expected_delivery = models.DateField(blank=True, null=True)
    total_amount = models.DecimalField(max_digits=12, decimal_places=2, default=0.00)
    paid_amount = models.DecimalField(max_digits=12, decimal_places=2, default=0.00)
    status = models.CharField(max_length=30, default='Draft')
    payment_terms = models.CharField(max_length=50, default='Credit Net 30')

    def __str__(self):
        return f"WO {self.order_number} - {self.dealer.business_name}"


class WholesaleDeliveryChallan(BaseUUIDModel):
    challan_number = models.CharField(max_length=50, unique=True)
    order = models.ForeignKey(WholesaleOrder, on_delete=models.CASCADE, related_name='challans')
    dealer = models.ForeignKey(Dealer, on_delete=models.CASCADE, related_name='challans')
    dispatch_date = models.DateField()
    vehicle_number = models.CharField(max_length=50, blank=True, null=True)
    driver_name = models.CharField(max_length=100, blank=True, null=True)
    driver_phone = models.CharField(max_length=20, blank=True, null=True)
    delivery_status = models.CharField(max_length=30, default='In Transit')

    def __str__(self):
        return f"Challan {self.challan_number}"


class WholesaleInvoice(BaseUUIDModel):
    invoice_number = models.CharField(max_length=50, unique=True)
    dealer = models.ForeignKey(Dealer, on_delete=models.CASCADE, related_name='wholesale_invoices')
    order_ref = models.CharField(max_length=50, blank=True, null=True)
    invoice_date = models.DateField()
    due_date = models.DateField()
    grand_total = models.DecimalField(max_digits=12, decimal_places=2)
    paid_amount = models.DecimalField(max_digits=12, decimal_places=2, default=0.00)
    due_amount = models.DecimalField(max_digits=12, decimal_places=2, default=0.00)
    status = models.CharField(max_length=20, default='Unpaid')

    def __str__(self):
        return f"W-Inv {self.invoice_number} - {self.dealer.business_name}"


class WholesalePaymentCollection(BaseUUIDModel):
    receipt_number = models.CharField(max_length=50, unique=True)
    dealer = models.ForeignKey(Dealer, on_delete=models.CASCADE, related_name='payments')
    invoice_number = models.CharField(max_length=50, blank=True, null=True)
    payment_date = models.DateField()
    payment_method = models.CharField(max_length=50)
    amount_paid = models.DecimalField(max_digits=12, decimal_places=2)
    reference_note = models.CharField(max_length=200, blank=True, null=True)

    def __str__(self):
        return f"Coll {self.receipt_number} - ₹{self.amount_paid}"


class WholesaleReturn(BaseUUIDModel):
    return_number = models.CharField(max_length=50, unique=True)
    invoice_number = models.CharField(max_length=50)
    dealer = models.ForeignKey(Dealer, on_delete=models.CASCADE, related_name='returns')
    return_date = models.DateField()
    reason = models.CharField(max_length=200)
    return_amount = models.DecimalField(max_digits=12, decimal_places=2)
    action_taken = models.CharField(max_length=50, default='Credit Note Issued')

    def __str__(self):
        return f"Return {self.return_number} - {self.dealer.business_name}"


