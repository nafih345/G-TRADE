"""Frame / Lens mode of Category and Brand masters (Add New Product dialog isolation)."""
from rest_framework.test import APITestCase

from apps.masters.models import Brand, ProductCategory
from apps.products.models import Product


class ProductModeTests(APITestCase):
    def _modes(self, url):
        res = self.client.get(url)
        rows = res.data.get('results', res.data) if isinstance(res.data, dict) else res.data
        return {r['name']: (r['product_mode'], r['resolved_mode']) for r in rows}

    def test_category_mode_from_tag_or_name(self):
        ProductCategory.objects.create(name='Frames', code='PM-FRA')
        ProductCategory.objects.create(name='Prescription Lenses', code='PM-LNS')
        ProductCategory.objects.create(name='Contact Lenses', code='PM-CLN')
        ProductCategory.objects.create(name='RX Stock', code='PM-RX', product_mode='LENS')
        modes = self._modes('/api/masters/categories/')
        self.assertEqual(modes['Frames'], ('', 'FRAME'))
        self.assertEqual(modes['Prescription Lenses'], ('', 'LENS'))
        self.assertEqual(modes['Contact Lenses'], ('', 'FRAME'))
        self.assertEqual(modes['RX Stock'], ('LENS', 'LENS'))

    def test_brand_mode_from_products_then_name(self):
        prime = Brand.objects.create(name='Prime', code='PM-PRI')
        both = Brand.objects.create(name='DualCo', code='PM-DUO')
        Brand.objects.create(name='Hoya', code='PM-HOY')
        Brand.objects.create(name='Fastrack', code='PM-FST')
        Brand.objects.create(name='Tagged', code='PM-TAG', product_mode='BOTH')
        Product.objects.create(name='Prime 1.56', sku='PM-1', category_name='Prescription Lenses', brand=prime)
        Product.objects.create(name='Duo Lens', sku='PM-2', category_name='Prescription Lenses', brand_name='DualCo')
        Product.objects.create(name='Duo Frame', sku='PM-3', category_name='Frames', brand=both)
        modes = self._modes('/api/masters/brands/')
        self.assertEqual(modes['Prime'][1], 'LENS')     # only lens products use it
        self.assertEqual(modes['DualCo'][1], 'BOTH')    # lens + frame products
        self.assertEqual(modes['Hoya'][1], 'LENS')      # unused: lens brand name
        self.assertEqual(modes['Fastrack'][1], 'FRAME') # unused: anything else
        self.assertEqual(modes['Tagged'], ('BOTH', 'BOTH'))

    def test_create_with_mode(self):
        res = self.client.post('/api/masters/brands/', {'name': 'NewLens', 'code': 'PM-NEW', 'product_mode': 'LENS'})
        self.assertEqual(res.status_code, 201, res.data)
        self.assertEqual(Brand.objects.get(code='PM-NEW').product_mode, 'LENS')
