from django.db import models
from apps.common.models import BaseUUIDModel

class Product(BaseUUIDModel):
    name = models.CharField(max_length=150)
    sku = models.CharField(max_length=50, unique=True)
    barcode = models.CharField(max_length=100, unique=True, blank=True, null=True)
    description = models.TextField(blank=True, null=True)
    
    category = models.ForeignKey('masters.ProductCategory', on_delete=models.SET_NULL, null=True, blank=True, related_name='products')
    brand = models.ForeignKey('masters.Brand', on_delete=models.SET_NULL, null=True, blank=True, related_name='products')
    unit = models.ForeignKey('masters.Unit', on_delete=models.SET_NULL, null=True, blank=True, related_name='products')
    tax = models.ForeignKey('masters.Tax', on_delete=models.SET_NULL, null=True, blank=True, related_name='products')

    cost_price = models.DecimalField(max_digits=12, decimal_places=2, default=0.0)
    retail_price = models.DecimalField(max_digits=12, decimal_places=2, default=0.0)
    wholesale_price = models.DecimalField(max_digits=12, decimal_places=2, default=0.0)
    
    minimum_stock = models.IntegerField(default=5)
    maximum_stock = models.IntegerField(default=100)
    opening_stock = models.IntegerField(default=0)
    
    image = models.ImageField(upload_to='product_images/', blank=True, null=True)

    def __str__(self):
        return f"{self.name} ({self.sku})"
