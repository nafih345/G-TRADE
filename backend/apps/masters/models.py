from django.db import models
from apps.common.models import BaseUUIDModel

class ProductCategory(BaseUUIDModel):
    name = models.CharField(max_length=100)
    code = models.CharField(max_length=50, unique=True)
    description = models.TextField(blank=True, null=True)

    def __str__(self):
        return self.name


class Brand(BaseUUIDModel):
    name = models.CharField(max_length=100)
    code = models.CharField(max_length=50, unique=True)

    def __str__(self):
        return self.name


class Unit(BaseUUIDModel):
    name = models.CharField(max_length=50)
    code = models.CharField(max_length=20, unique=True)  # PCS, KG, LTR, etc.

    def __str__(self):
        return self.name


class Tax(BaseUUIDModel):
    name = models.CharField(max_length=50)
    rate = models.DecimalField(max_digits=5, decimal_places=2)  # Percentage, e.g. 18.00

    def __str__(self):
        return f"{self.name} ({self.rate}%)"


class StorageRack(BaseUUIDModel):
    warehouse = models.ForeignKey('company.Warehouse', on_delete=models.CASCADE, related_name='racks')
    name = models.CharField(max_length=100)  # e.g., Rack A, Shelf 1

    def __str__(self):
        return f"{self.name} - {self.warehouse.name}"
