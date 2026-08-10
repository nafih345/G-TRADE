from rest_framework import viewsets, permissions
from rest_framework.serializers import ModelSerializer, SerializerMethodField
from .models import ProductCategory, Brand, Unit, Tax, StorageRack

class ProductCategorySerializer(ModelSerializer):
    products_count = SerializerMethodField()

    class Meta:
        model = ProductCategory
        fields = '__all__'

    def get_products_count(self, obj):
        try:
            from apps.products.models import Product
            from django.db.models import Q
            name_str = (obj.name or '').strip()
            code_str = (obj.code or '').strip()

            return Product.objects.filter(
                Q(category=obj) |
                Q(category_name__iexact=name_str) |
                Q(category_name__icontains=name_str) |
                Q(category_name__icontains=code_str)
            ).count()
        except Exception:
            try:
                return obj.products.count()
            except Exception:
                return 0

class BrandSerializer(ModelSerializer):
    products_count = SerializerMethodField()

    class Meta:
        model = Brand
        fields = '__all__'

    def get_products_count(self, obj):
        try:
            from apps.products.models import Product
            from django.db.models import Q
            name_str = (obj.name or '').strip()
            code_str = (obj.code or '').strip()

            return Product.objects.filter(
                Q(brand=obj) |
                Q(brand_name__iexact=name_str) |
                Q(brand_name__icontains=name_str) |
                Q(brand_name__icontains=code_str)
            ).count()
        except Exception:
            try:
                return obj.products.count()
            except Exception:
                return 0

class UnitSerializer(ModelSerializer):
    class Meta:
        model = Unit
        fields = '__all__'

class TaxSerializer(ModelSerializer):
    class Meta:
        model = Tax
        fields = '__all__'

class StorageRackSerializer(ModelSerializer):
    class Meta:
        model = StorageRack
        fields = '__all__'

DEFAULT_CATEGORIES = [
    {'name': 'Frames', 'code': 'FRA', 'description': 'Spectacle frames (Full Rim, Supra / Semi-Rimless, Rimless, Titanium & Acetate)', 'hsn_code': '90031100', 'gst_percentage': '18%'},
    {'name': 'Sunglasses', 'code': 'SUN', 'description': 'Sunglasses & UV Protection Eyewear (Polarized, Aviator, Wayfarer, Sports)', 'hsn_code': '90041000', 'gst_percentage': '18%'},
    {'name': 'Prescription Lenses', 'code': 'LNS', 'description': 'Ophthalmic Prescription Lenses (Single Vision, Bifocal, Progressive Digital, Blue Cut)', 'hsn_code': '90014010', 'gst_percentage': '12%'},
    {'name': 'Contact Lenses', 'code': 'CLN', 'description': 'Contact Lenses & Lens Care (Daily Disposable, Monthly, Toric, Color Cosmetic)', 'hsn_code': '90013000', 'gst_percentage': '12%'},
    {'name': 'Reading Glasses', 'code': 'RDG', 'description': 'Ready Readers (+1.00 to +3.50), Folding Readers & Anti-Blue Light Reading Glasses', 'hsn_code': '90049090', 'gst_percentage': '18%'},
    {'name': 'Accessories', 'code': 'ACC', 'description': 'Spectacle Chains & Cords, Microfiber Cloths, Nose Pads, Screws & Optical Tools', 'hsn_code': '90039000', 'gst_percentage': '18%'},
    {'name': 'Lens Solutions', 'code': 'SOL', 'description': 'Multi-Purpose Contact Lens Solutions, Saline Rinsing Liquids & Disinfecting Cleaners', 'hsn_code': '33079090', 'gst_percentage': '18%'},
    {'name': 'Cleaning Kits', 'code': 'CLK', 'description': 'Lens Cleaning Sprays, Anti-Fog Microfiber Wipes & Lens Care Maintenance Fluid', 'hsn_code': '34022090', 'gst_percentage': '18%'},
    {'name': 'Cases', 'code': 'CAS', 'description': 'Hard Shell Eyeglass Cases, Soft Leather Pouches & Contact Lens Storage Boxes', 'hsn_code': '42029200', 'gst_percentage': '18%'},
    {'name': 'Eye Drops', 'code': 'EYD', 'description': 'Lubricating Artificial Tears, Anti-Allergy Eye Drops & Contact Lens Relief Drops', 'hsn_code': '30049099', 'gst_percentage': '12%'}
]

class ProductCategoryViewSet(viewsets.ModelViewSet):
    queryset = ProductCategory.objects.all().order_by('name')
    serializer_class = ProductCategorySerializer
    authentication_classes = []
    permission_classes = [permissions.AllowAny]

    def get_queryset(self):
        try:
            if not ProductCategory.objects.exists():
                for cat in DEFAULT_CATEGORIES:
                    ProductCategory.objects.get_or_create(code=cat['code'], defaults=cat)
        except Exception:
            pass
        return ProductCategory.objects.all().order_by('name')

class BrandViewSet(viewsets.ModelViewSet):
    queryset = Brand.objects.all().order_by('name')
    serializer_class = BrandSerializer
    authentication_classes = []
    permission_classes = [permissions.AllowAny]

class UnitViewSet(viewsets.ModelViewSet):
    queryset = Unit.objects.all()
    serializer_class = UnitSerializer
    authentication_classes = []
    permission_classes = [permissions.AllowAny]

class TaxViewSet(viewsets.ModelViewSet):
    queryset = Tax.objects.all()
    serializer_class = TaxSerializer
    authentication_classes = []
    permission_classes = [permissions.AllowAny]

class StorageRackViewSet(viewsets.ModelViewSet):
    queryset = StorageRack.objects.all()
    serializer_class = StorageRackSerializer
    authentication_classes = []
    permission_classes = [permissions.AllowAny]
