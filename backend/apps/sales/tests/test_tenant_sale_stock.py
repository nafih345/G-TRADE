"""A client (non-default tenant) selling through New Sale / POS / Wholesale must reduce its stock.

Reported 2026-11-09 on the hosted multi-tenant install: the bill saved, but Inventory's Current
Stock never moved. The pickers offered browser-cached products the server didn't have (e.g. a
copy left by another account on the same browser); a line carrying such an id was saved as a
stock-less description. Now it is re-linked by its code, or the save is refused.
"""
from django.test import override_settings
from rest_framework.test import APIClient, APITestCase

from apps.common import tenancy
from apps.common.models import Tenant
from apps.common.tenant_onboarding import ensure_tenant_defaults, onboard_tenant
from apps.inventory.stock_utils import adjust_branch_stock, adjust_branch_stock_many
from apps.products.models import Product
from apps.sales.models import Invoice

PASSWORD = 'Str0ng-pass-123'
URL = '/api/sales/invoices/'


@override_settings(HOT_CACHE_SECONDS=30)  # as hosted: tenant-keyed per-process cache on
class TenantSaleStockTests(APITestCase):
    def setUp(self):
        # The platform tenant (#1) has its own branch and a product with the SAME code — like a
        # browser that was used by the platform account before this client signed in.
        with tenancy.use_tenant(tenancy.DEFAULT_TENANT_ID):
            ensure_tenant_defaults(Tenant.objects.get(pk=tenancy.DEFAULT_TENANT_ID), fresh=True)
            self.foreign = Product.objects.create(name='Platform Frame', sku='CL-1', barcode='BC-CL-1', stock=50)
        self.tenant, _admin = onboard_tenant(name='Client Shop', admin_username='clientadmin', password=PASSWORD)
        self.api = APIClient()
        res = self.api.post('/api/auth/login/', {'username': 'clientadmin', 'password': PASSWORD}, format='json')
        self.assertEqual(res.status_code, 200, res.content)
        self.api.credentials(HTTP_AUTHORIZATION=f"Bearer {res.data['access']}")
        res = self.api.post('/api/products/items/', {'name': 'Client Frame', 'sku': 'CL-1', 'barcode': 'BC-CL-1',
                                                     'stock': 10, 'opening_stock': 10, 'retail_price': 100,
                                                     'cost_price': 50}, format='json')
        self.assertIn(res.status_code, (200, 201), res.content)
        self.product_id = res.data['id']

    def _stock(self, pk=None):
        res = self.api.get(f'/api/products/products/{pk or self.product_id}/')
        self.assertEqual(res.status_code, 200, res.content)
        return res.data['stock']

    def _line(self, qty=2, product=None, **codes):
        return {'product': str(product or self.product_id), 'item_type': 'PRODUCT', 'description': 'Client Frame',
                'quantity': qty, 'unit_price': 100, 'tax_rate': 0, 'tax_amount': 0, 'subtotal': qty * 100, **codes}

    def _sell(self, items, expect=201, **headers):
        res = self.api.post(URL, {
            'document_type': 'INVOICE', 'invoice_date': '2026-11-09', 'status': 'PAID',
            'total_amount': 200, 'net_amount': 200, 'paid_amount': 200, 'customer_name': 'Walk In',
            'items': items, 'payment_splits': {'cash': 200},
        }, format='json', **headers)
        self.assertEqual(res.status_code, expect, res.content)
        return res

    def test_sale_reduces_only_this_clients_stock(self):
        self._sell([self._line(2)])
        self.assertEqual(self._stock(), 8)
        with tenancy.unscoped():
            self.foreign.refresh_from_db()
        self.assertEqual(self.foreign.stock, 50)

    def test_stale_branch_header_still_deducts(self):
        with tenancy.use_tenant(tenancy.DEFAULT_TENANT_ID):
            from apps.company.models import Branch
            other = Branch.objects.first()
        self._sell([self._line(2)], HTTP_X_BRANCH_ID=str(other.pk))
        self.assertEqual(self._stock(), 8)

    def test_multi_branch_on(self):
        res = self.api.patch('/api/company/business-settings/', {'multi_branch_enabled': True}, format='json')
        self.assertIn(res.status_code, (200, 201), res.content)
        self._sell([self._line(2)])
        self.assertEqual(self._stock(), 8)

    def test_out_of_date_product_id_is_relinked_by_code(self):
        # The picker offered the other account's cached copy (same code, other id).
        res = self._sell([self._line(3, product=self.foreign.pk, sku='CL-1', barcode='BC-CL-1')])
        self.assertEqual(self._stock(), 7)
        with tenancy.use_tenant(self.tenant.pk):
            item = Invoice.objects.get(pk=res.data['id']).items.get()
        self.assertEqual(str(item.product_id), str(self.product_id))

    def test_unknown_product_without_a_match_refuses_the_whole_sale(self):
        res = self._sell([self._line(1), self._line(1, product='1731150000000', sku='NOPE')], expect=400)
        self.assertEqual(res.data['code'], 'unknown_product')
        self.assertEqual(self._stock(), 10)                      # nothing moved
        with tenancy.use_tenant(self.tenant.pk):
            self.assertFalse(Invoice.objects.exists())          # nothing saved

    def test_custom_and_service_lines_still_save(self):
        self._sell([self._line(1), {**self._line(1), 'product': None, 'description': 'Fitting'},
                    {**self._line(1, product='svc-x'), 'item_type': 'SERVICE'}])
        self.assertEqual(self._stock(), 9)

    def test_wholesale_sale_reduces_tenant_stock(self):
        res = self.api.post('/api/sales/wholesale/dealers/', {'dealer_code': 'DL-1', 'business_name': 'D',
                                                             'phone': '9999999990'}, format='json')
        self.assertEqual(res.status_code, 201, res.content)
        res = self.api.post('/api/sales/wholesale/invoices/', {
            'invoice_number': 'WINV-1', 'dealer': res.data['id'], 'invoice_date': '2026-11-09',
            'due_date': '2026-11-22', 'grand_total': 300, 'paid_amount': 0, 'due_amount': 300,
            'status': 'Partial', 'details': {'items': [{'id': str(self.product_id), 'qty': 3, 'rate': 100}],
                                             'orderStatus': 'Confirmed'}}, format='json')
        self.assertEqual(res.status_code, 201, res.content)
        self.assertEqual(self._stock(), 7)


class StaleProductCopyTests(APITestCase):
    """Two tills selling the same product: the second request loaded `product` before the first
    committed. Its stale Product.stock must not overwrite the first sale's deduction."""

    def setUp(self):
        from apps.company.models import Branch
        self.branch = Branch.get_default()
        self.product = Product.objects.create(name='Race Frame', sku='RACE-1', stock=10)

    def _stale_copy(self):
        return Product.objects.get(pk=self.product.pk)

    def _now(self):
        return Product.objects.get(pk=self.product.pk).stock

    def test_batched_path(self):
        stale = self._stale_copy()                       # till B reads 10
        adjust_branch_stock_many({self._stale_copy(): -2}, self.branch)   # till A sells 2 → 8
        adjust_branch_stock_many({stale: -3}, self.branch)                # till B sells 3
        self.assertEqual(self._now(), 5)

    def test_single_path(self):
        stale = self._stale_copy()
        adjust_branch_stock(self._stale_copy(), self.branch, -2)
        adjust_branch_stock(stale, self.branch, -3)
        self.assertEqual(self._now(), 5)

    def test_no_branch_fallback(self):
        stale = self._stale_copy()
        from apps.company.models import Branch
        Branch.objects.all().delete()
        adjust_branch_stock(self._stale_copy(), None, -2)
        adjust_branch_stock(stale, None, -3)
        self.assertEqual(self._now(), 5)
