from rest_framework import viewsets, permissions
from rest_framework.decorators import action
from rest_framework.serializers import ModelSerializer, SerializerMethodField
from rest_framework.pagination import PageNumberPagination
from django.db.models import Q
from .models import Product


class ProductPagination(PageNumberPagination):
    page_size = 100
    page_size_query_param = 'page_size'
    max_page_size = 500

def infer_category_name(category_name, product_name):
    cat = (category_name or '').strip()
    name = (product_name or '').strip().lower()
    
    if cat and cat.lower() not in ('frames', 'general', 'all', 'none', ''):
        lower_cat = cat.lower()
        if 'sunglass' in lower_cat:
            return 'Sunglasses'
        if 'lens' in lower_cat or 'ophthalmic' in lower_cat:
            return 'Prescription Lenses'
        if 'contact' in lower_cat:
            return 'Contact Lenses'
        if 'reading' in lower_cat or 'reader' in lower_cat:
            return 'Reading Glasses'
        if 'accessori' in lower_cat:
            return 'Accessories'
        if 'solution' in lower_cat:
            return 'Lens Solutions'
        if 'clean' in lower_cat or 'kit' in lower_cat:
            return 'Cleaning Kits'
        if 'case' in lower_cat:
            return 'Cases'
        if 'drop' in lower_cat:
            return 'Eye Drops'
        return cat

    if 'sunglass' in name:
        return 'Sunglasses'
    if any(k in name for k in ['lens', 'crizal', 'essilor', 'hoya', 'zeiss', 'kodak', 'progressive', 'bifocal', 'single vision', 'arc', 'blue cut', 'photochromic']):
        return 'Prescription Lenses'
    if any(k in name for k in ['contact', 'bausch', 'freshlook', 'acuvue', 'air optix']):
        return 'Contact Lenses'
    if any(k in name for k in ['reading', 'reader']):
        return 'Reading Glasses'
    if 'solution' in name:
        return 'Lens Solutions'
    if any(k in name for k in ['clean', 'cloth', 'spray', 'kit']):
        return 'Cleaning Kits'
    if any(k in name for k in ['case', 'cover', 'pouch', 'box']):
        return 'Cases'
    if any(k in name for k in ['drop', 'tear', 'lubricant']):
        return 'Eye Drops'
    if any(k in name for k in ['chain', 'cord', 'screw', 'pad']):
        return 'Accessories'

    return cat or 'Frames'


class ProductSerializer(ModelSerializer):
    category = SerializerMethodField()
    brand = SerializerMethodField()
    price = SerializerMethodField()
    selling_price = SerializerMethodField()
    supplier = SerializerMethodField()
    rack = SerializerMethodField()

    class Meta:
        model = Product
        fields = '__all__'

    def get_category(self, obj):
        cat_val = obj.category_name or (obj.category.name if obj.category else None)
        return infer_category_name(cat_val, obj.name)

    def get_brand(self, obj):
        return obj.brand_name or (obj.brand.name if obj.brand else None) or 'Generic'

    def get_price(self, obj):
        return float(obj.retail_price or 0.0)

    def get_selling_price(self, obj):
        return float(obj.retail_price or 0.0)

    def get_supplier(self, obj):
        return obj.supplier_name or ''

    def get_rack(self, obj):
        return obj.rack_location or 'A1'

    def create(self, validated_data):
        request = self.context.get('request')
        input_data = request.data if request else {}
        cat_val = input_data.get('category') or input_data.get('category_name') or validated_data.get('category_name')
        name_val = input_data.get('name') or validated_data.get('name')
        validated_data['category_name'] = infer_category_name(cat_val, name_val)

        brand_val = input_data.get('brand') or input_data.get('brand_name') or validated_data.get('brand_name')
        if brand_val:
            validated_data['brand_name'] = str(brand_val)
        return super().create(validated_data)

    def update(self, instance, validated_data):
        request = self.context.get('request')
        input_data = request.data if request else {}
        cat_val = input_data.get('category') or input_data.get('category_name') or validated_data.get('category_name') or instance.category_name
        name_val = input_data.get('name') or validated_data.get('name') or instance.name
        validated_data['category_name'] = infer_category_name(cat_val, name_val)

        brand_val = input_data.get('brand') or input_data.get('brand_name') or validated_data.get('brand_name') or instance.brand_name
        if brand_val:
            validated_data['brand_name'] = str(brand_val)
        return super().update(instance, validated_data)


class ProductViewSet(viewsets.ModelViewSet):
    queryset = Product.objects.all().order_by('-created_at')
    serializer_class = ProductSerializer
    authentication_classes = []
    permission_classes = [permissions.AllowAny]
    pagination_class = ProductPagination

    def get_queryset(self):
        qs = super().get_queryset()
        search = self.request.query_params.get('search', '').strip()
        if search:
            qs = qs.filter(
                Q(name__icontains=search) | Q(sku__icontains=search) |
                Q(barcode__icontains=search) | Q(brand_name__icontains=search) |
                Q(category_name__icontains=search) | Q(supplier_name__icontains=search)
            )
        return qs

    def paginate_queryset(self, queryset):
        if self.request.query_params.get('page') is None and self.request.query_params.get('page_size') is None:
            return None
        return super().paginate_queryset(queryset)

    def destroy(self, request, *args, **kwargs):
        from rest_framework import status
        from rest_framework.response import Response
        instance = self.get_object()
        instance.hard_delete()
        return Response(status=status.HTTP_204_NO_CONTENT)

    @action(detail=False, methods=['delete', 'post'], url_path='clear-all')
    def clear_all(self, request):
        from rest_framework.response import Response
        from rest_framework import status
        from django.apps import apps
        
        target_apps = [
            'products', 'inventory', 'purchasing', 'sales', 
            'accounts', 'financial', 'masters', 'company'
        ]

        for app_name in target_apps:
            try:
                app_config = apps.get_app_config(app_name)
                for model in app_config.get_models():
                    try:
                        if hasattr(model, 'all_objects'):
                            try:
                                model.all_objects.all().hard_delete()
                            except Exception:
                                model.all_objects.all().delete()
                        else:
                            model.objects.all().delete()
                    except Exception:
                        pass
            except Exception:
                pass

        return Response({
            'message': 'All project database records cleared successfully across all modules.'
        }, status=status.HTTP_200_OK)
