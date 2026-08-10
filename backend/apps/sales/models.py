from django.db import models
from apps.common.models import BaseUUIDModel

class Customer(BaseUUIDModel):
    name = models.CharField(max_length=150)
    email = models.EmailField(blank=True, null=True)
    phone = models.CharField(max_length=20, blank=True, null=True)
    address = models.TextField(blank=True, null=True)
    outstanding_balance = models.DecimalField(max_digits=12, decimal_places=2, default=0.0)
    credit_limit = models.DecimalField(max_digits=12, decimal_places=2, default=5000.0)

    def __str__(self):
        return self.name


class Invoice(BaseUUIDModel):
    STATUS_CHOICES = [
        ('DRAFT', 'Draft'),
        ('PAID', 'Paid'),
        ('PARTIAL', 'Partially Paid'),
        ('UNPAID', 'Unpaid'),
        ('CANCELLED', 'Cancelled'),
    ]

    invoice_number = models.CharField(max_length=50, unique=True)
    customer = models.ForeignKey(Customer, on_delete=models.CASCADE, related_name='invoices')
    invoice_date = models.DateField()
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default='UNPAID')
    
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
    product = models.ForeignKey('products.Product', on_delete=models.CASCADE)
    quantity = models.IntegerField()
    unit_price = models.DecimalField(max_digits=12, decimal_places=2)
    tax_rate = models.DecimalField(max_digits=5, decimal_places=2, default=0.0)  # Percentage
    tax_amount = models.DecimalField(max_digits=12, decimal_places=2, default=0.0)
    subtotal = models.DecimalField(max_digits=12, decimal_places=2)

    def __str__(self):
        return f"{self.product.name} ({self.quantity}pcs)"


class EyeExamination(BaseUUIDModel):
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


