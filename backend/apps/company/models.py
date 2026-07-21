from django.db import models
from apps.common.models import BaseUUIDModel

class Company(BaseUUIDModel):
    name = models.CharField(max_length=150)
    logo = models.ImageField(upload_to='company_logos/', blank=True, null=True)
    gstin = models.CharField(max_length=15, blank=True, null=True)
    currency = models.CharField(max_length=10, default='USD')
    fiscal_year_start = models.DateField()
    fiscal_year_end = models.DateField()
    address = models.TextField(blank=True, null=True)
    email = models.EmailField(blank=True, null=True)
    phone = models.CharField(max_length=20, blank=True, null=True)

    def __str__(self):
        return self.name


class Branch(BaseUUIDModel):
    company = models.ForeignKey(Company, on_delete=models.CASCADE, related_name='branches')
    name = models.CharField(max_length=100)
    code = models.CharField(max_length=20, unique=True)
    address = models.TextField(blank=True, null=True)
    phone = models.CharField(max_length=20, blank=True, null=True)

    def __str__(self):
        return f"{self.name} ({self.code})"


class Warehouse(BaseUUIDModel):
    branch = models.ForeignKey(Branch, on_delete=models.CASCADE, related_name='warehouses')
    name = models.CharField(max_length=100)
    code = models.CharField(max_length=20, unique=True)
    address = models.TextField(blank=True, null=True)

    def __str__(self):
        return self.name
