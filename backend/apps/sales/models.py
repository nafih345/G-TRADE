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
        return f"Exam for {self.patient_name} on {self.examination_date.date()}"
