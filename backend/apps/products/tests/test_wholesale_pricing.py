"""Wholesale pricing hierarchy on the product API: cost price, MRP, the wholesale sale
tier, and zero-tax (0%) rates that must stay 0 rather than fall back to a default slab."""
from decimal import Decimal

from django.test import TestCase

from apps.masters.models import Tax
from apps.products.label_fields import resolve_product_fields
from apps.products.models import Product
from apps.products.views import ProductSerializer


def ser(p):
    return ProductSerializer(p).data


class WholesalePricingTests(TestCase):
    def test_price_tiers_exposed(self):
        p = Product.objects.create(name='Frame', sku='F-1', cost_price='400', retail_price='900',
                                   wholesale_price='1000', wholesale_sale_price='650')
        d = ser(p)
        self.assertEqual(Decimal(d['cost_price']), Decimal('400'))
        self.assertEqual(d['mrp'], 1000.0)
        self.assertEqual(Decimal(d['wholesale_sale_price']), Decimal('650'))
        self.assertEqual(d['selling_price'], 900.0)

    def test_wholesale_sale_price_optional_and_writable(self):
        p = Product.objects.create(name='Case', sku='C-1', retail_price='150')
        self.assertIsNone(ser(p)['wholesale_sale_price'])
        s = ProductSerializer(p, data={'wholesale_sale_price': '120.50'}, partial=True)
        self.assertTrue(s.is_valid(), s.errors)
        s.save()
        p.refresh_from_db()
        self.assertEqual(p.wholesale_sale_price, Decimal('120.50'))
        s = ProductSerializer(p, data={'wholesale_sale_price': None}, partial=True)
        self.assertTrue(s.is_valid(), s.errors)
        s.save()
        p.refresh_from_db()
        self.assertIsNone(p.wholesale_sale_price)

    def test_mrp_prefers_extra_data_and_is_never_guessed(self):
        p = Product.objects.create(name='A', sku='A-1', retail_price='500', wholesale_price='800',
                                   extra_data={'mrp': 850})
        self.assertEqual(ser(p)['mrp'], 850.0)
        p2 = Product.objects.create(name='B', sku='B-1', retail_price='500')
        self.assertIsNone(ser(p2)['mrp'])

    def test_zero_tax_rate_is_zero_not_default(self):
        zero = Tax.objects.create(name='GST 0%', rate=Decimal('0'))
        p = Product.objects.create(name='Exempt', sku='E-1', retail_price='100', tax=zero)
        self.assertEqual(ser(p)['tax_rate'], 0.0)
        self.assertEqual(ser(p)['gst'], '0%')
        self.assertEqual((ser(p)['tax_treatment'], ser(p)['tax_category']), ('EXCLUSIVE', 'STANDARD'))
        exempt = Tax.objects.create(name='Exempt', rate=Decimal('0'), category='EXEMPT', treatment='INCLUSIVE')
        p.tax = exempt
        p.save()
        self.assertEqual((ser(p)['tax_rate'], ser(p)['tax_treatment'], ser(p)['tax_category']), (0.0, 'INCLUSIVE', 'EXEMPT'))
        p2 = Product.objects.create(name='Exempt2', sku='E-2', retail_price='100', extra_data={'gst': '0%'})
        self.assertEqual(ser(p2)['tax_rate'], 0.0)
        self.assertIsNone(ser(p2)['tax_treatment'])

    def test_label_wholesale_price_uses_new_tier(self):
        p = Product.objects.create(name='L', sku='L-1', retail_price='900', wholesale_price='1000',
                                   wholesale_sale_price='700')
        self.assertEqual(resolve_product_fields(p, include_restricted=True)['wholesale_price'], '700.00')
        p.wholesale_sale_price = None
        p.save()
        self.assertEqual(resolve_product_fields(p, include_restricted=True)['wholesale_price'], '1000.00')
