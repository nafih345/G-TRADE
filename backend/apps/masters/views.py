from rest_framework import viewsets, permissions
from rest_framework.serializers import ModelSerializer
from .models import ProductCategory, Brand, Unit, Tax, StorageRack

class ProductCategorySerializer(ModelSerializer):
    class Meta:
        model = ProductCategory
        fields = '__all__'

class BrandSerializer(ModelSerializer):
    class Meta:
        model = Brand
        fields = '__all__'

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

class ProductCategoryViewSet(viewsets.ModelViewSet):
    queryset = ProductCategory.objects.all()
    serializer_class = ProductCategorySerializer
    permission_classes = [permissions.IsAuthenticated]

class BrandViewSet(viewsets.ModelViewSet):
    queryset = Brand.objects.all()
    serializer_class = BrandSerializer
    permission_classes = [permissions.IsAuthenticated]

class UnitViewSet(viewsets.ModelViewSet):
    queryset = Unit.objects.all()
    serializer_class = UnitSerializer
    permission_classes = [permissions.IsAuthenticated]

class TaxViewSet(viewsets.ModelViewSet):
    queryset = Tax.objects.all()
    serializer_class = TaxSerializer
    permission_classes = [permissions.IsAuthenticated]

class StorageRackViewSet(viewsets.ModelViewSet):
    queryset = StorageRack.objects.all()
    serializer_class = StorageRackSerializer
    permission_classes = [permissions.IsAuthenticated]
