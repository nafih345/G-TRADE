from rest_framework import viewsets, permissions
from rest_framework.serializers import ModelSerializer
from .models import Company, Branch, Warehouse

class CompanySerializer(ModelSerializer):
    class Meta:
        model = Company
        fields = '__all__'


class BranchSerializer(ModelSerializer):
    class Meta:
        model = Branch
        fields = '__all__'


class WarehouseSerializer(ModelSerializer):
    class Meta:
        model = Warehouse
        fields = '__all__'


class CompanyViewSet(viewsets.ModelViewSet):
    queryset = Company.objects.all()
    serializer_class = CompanySerializer
    permission_classes = [permissions.IsAuthenticated]


class BranchViewSet(viewsets.ModelViewSet):
    queryset = Branch.objects.all()
    serializer_class = BranchSerializer
    permission_classes = [permissions.IsAuthenticated]


class WarehouseViewSet(viewsets.ModelViewSet):
    queryset = Warehouse.objects.all()
    serializer_class = WarehouseSerializer
    permission_classes = [permissions.IsAuthenticated]
