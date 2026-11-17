"""N+1 guard for the screens customers open all day.

Each list/report endpoint is read with a small data set and again after 3x more rows were saved
through the real APIs. The number of SQL queries must not grow with the number of rows: a growing
count is an N+1 (one extra query per row), which on a busy shop turns a screen into seconds.
"""

import json
from datetime import date

from django.db import connection
from django.test import override_settings
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APIClient, APITestCase

from apps.common import tenancy
from apps.common.models import Tenant
from apps.common.tenant_onboarding import ensure_tenant_defaults, onboard_tenant

PASSWORD = 'Str0ng-pass-123'
TODAY = date.today().isoformat()

SCREENS = [
    ('dashboard', '/api/sales/dashboard-summary/'),
    ('products', '/api/products/items/'),
    ('product_search', '/api/products/items/?search=Frame'),
    ('customers', '/api/sales/customers/'),
    ('suppliers', '/api/purchase/suppliers/'),
    ('purchases', '/api/purchase/invoices/'),
    ('sales', '/api/sales/invoices/'),
    ('payments', '/api/sales/payments/'),
    ('sales_report', f'/api/sales/invoices/report/?date_from={TODAY}&date_to={TODAY}'),
    ('stock_overview', '/api/inventory/stock-overview/'),
]


@override_settings(HOT_CACHE_SECONDS=30)
class QueryScalingTests(APITestCase):
    maxDiff = None

    def setUp(self):
        with tenancy.use_tenant(tenancy.DEFAULT_TENANT_ID):
            ensure_tenant_defaults(Tenant.objects.get(pk=tenancy.DEFAULT_TENANT_ID), fresh=True)
        self.tenant, _admin = onboard_tenant(name='Scaling Shop', admin_username='scaleadmin', password=PASSWORD)
        self.api = APIClient()
        res = self.api.post('/api/auth/login/', {'username': 'scaleadmin', 'password': PASSWORD}, format='json')
        self.assertEqual(res.status_code, 200, res.content)
        self.api.credentials(HTTP_AUTHORIZATION=f"Bearer {res.data['access']}")
        self.n = 0

    def post(self, path, body):
        with self.captureOnCommitCallbacks(execute=True):
            res = self.api.post(path, body, format='json')
        self.assertEqual(res.status_code, 201, f'{path}: {res.content[:400]}')
        return res.data

    def seed(self, count):
        for _ in range(count):
            self.n += 1
            i = self.n
            product = self.post('/api/products/items/', {
                'name': f'Frame {i}', 'sku': f'FR-{i}', 'barcode': f'BCSC{i:05d}', 'cost_price': 250,
                'retail_price': 1000, 'stock': 0})['id']
            customer = self.post('/api/sales/customers/', {'name': f'Customer {i}', 'phone': f'98765{i:05d}'})['id']
            supplier = self.post('/api/purchase/suppliers/', {'name': f'Supplier {i}', 'phone': f'90000{i:05d}'})['id']
            self.post('/api/purchase/invoices/', {
                'invoice_number': f'PE-{i}', 'supplier': supplier, 'purchase_date': TODAY, 'purchase_type': 'CREDIT',
                'payment_method': 'CREDIT', 'status': 'CONFIRMED', 'grand_total': 500, 'balance_amount': 500,
                'items': [{'product': product, 'quantity': 2, 'purchase_rate': 250, 'line_total': 500}]})
            self.post('/api/sales/invoices/', {
                'customer_name': f'Customer {i}', 'customer': customer, 'invoice_date': TODAY,
                'document_type': 'INVOICE', 'total_amount': '1000', 'net_amount': '1000', 'paid_amount': '1000',
                'payment_mode': 'CASH',
                'items': [{'product': product, 'quantity': 1, 'unit_price': '1000', 'total': '1000'}]})

    def measure(self):
        counts = {}
        for name, path in SCREENS:
            self.api.get(path)  # warm per-process caches the same way a second visit would
            with CaptureQueriesContext(connection) as ctx:
                res = self.api.get(path)
            self.assertEqual(res.status_code, 200, f'{name}: {res.status_code} {res.content[:300]}')
            counts[name] = len(ctx.captured_queries)
        return counts

    def test_query_count_does_not_grow_with_rows(self):
        self.seed(3)
        small = self.measure()
        self.seed(6)
        large = self.measure()
        report = {name: {'rows_3': small[name], 'rows_9': large[name]} for name, _ in SCREENS}
        print('\nQUERY_SCALING ' + json.dumps(report))
        grew = {k: v for k, v in report.items() if v['rows_9'] > v['rows_3']}
        self.assertEqual(grew, {}, 'query count grows with rows (N+1)')
