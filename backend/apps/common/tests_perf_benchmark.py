"""Performance benchmark for the screens a shop uses all day (opt-in: GTRADE_PERF=1).

    python windows/tests/run_local_django_tests.py apps.common.tests_perf_benchmark   (with GTRADE_PERF=1)

1. Seeds a small shop through the REAL APIs (products, customers, suppliers, purchases, sales: stock,
   accounting and numbering all run), and times every screen (median of 5 warm requests) + counts SQL.
2. Grows the catalogue to thousands of products and customers (bulk copies of API-created rows) and
   times again. Timings are reported for the release report; SQL query counts (no N+1) are proven
   by tests_query_scaling, which should be run in the same command.

Timings are wall-clock inside the Django test client on the machine that runs it (no network, no
nginx): they show relative cost and scaling, not the end-user figure on a customer's PC.
"""

import copy
import json
import os
import statistics
import time
import unittest
import uuid

from apps.common import tenancy
from apps.common.tests_query_scaling import PASSWORD, SCREENS, QueryScalingTests

EXTRA_PRODUCTS = int(os.environ.get('GTRADE_PERF_PRODUCTS', '5000'))
EXTRA_CUSTOMERS = int(os.environ.get('GTRADE_PERF_CUSTOMERS', '3000'))
API_CYCLES = int(os.environ.get('GTRADE_PERF_CYCLES', '30'))


@unittest.skipUnless(os.environ.get('GTRADE_PERF') == '1', 'performance benchmark: set GTRADE_PERF=1')
class PerfBenchmark(QueryScalingTests):
    test_query_count_does_not_grow_with_rows = None  # inherited N+1 test runs in its own module

    def timed(self, runs=5) -> dict:
        out = {}
        for name, path in SCREENS:
            res = self.api.get(path)  # warm
            self.assertEqual(res.status_code, 200, f'{name}: {res.status_code}')
            samples = []
            for _ in range(runs):
                t0 = time.perf_counter()
                self.api.get(path)
                samples.append((time.perf_counter() - t0) * 1000)
            out[name] = {'median_ms': round(statistics.median(samples), 1), 'max_ms': round(max(samples), 1),
                         'bytes': len(res.content)}
        return out

    def clone(self, model, template, n, mutate):
        objs = []
        for i in range(n):
            o = copy.copy(template)
            o.pk = uuid.uuid4()
            mutate(o, i)
            objs.append(o)
        model.objects.bulk_create(objs, batch_size=1000)

    def test_benchmark(self):
        from apps.products.models import Product
        from apps.sales.models import Customer
        t0 = time.perf_counter()
        self.seed(API_CYCLES)
        seed_api_s = time.perf_counter() - t0
        small = self.timed()
        with tenancy.use_tenant(self.tenant.pk):
            p = Product.objects.filter(sku='FR-1').first()
            c = Customer.objects.filter(name='Customer 1').first()
            self.clone(Product, p, EXTRA_PRODUCTS, lambda o, i: (
                setattr(o, 'name', f'Bulk Frame {i}'), setattr(o, 'sku', f'BULK-{i}'),
                setattr(o, 'barcode', f'BULKBC{i:07d}'), setattr(o, 'secondary_barcode', None),
                setattr(o, 'variant_group_id', None), setattr(o, 'variant_key', None) if hasattr(o, 'variant_key') else None))
            self.clone(Customer, c, EXTRA_CUSTOMERS, lambda o, i: (
                setattr(o, 'name', f'Bulk Customer {i}'), setattr(o, 'phone', f'7{i:09d}'),
                setattr(o, 'patient_code', f'PB-{i:06d}')))
        large = self.timed()
        logins = []
        for _ in range(5):
            t1 = time.perf_counter()
            res = self.api.post('/api/auth/login/', {'username': 'scaleadmin', 'password': PASSWORD}, format='json')
            logins.append((time.perf_counter() - t1) * 1000)
            self.assertEqual(res.status_code, 200)
        report = {
            'rows': {'api_cycles': API_CYCLES, 'extra_products': EXTRA_PRODUCTS, 'extra_customers': EXTRA_CUSTOMERS},
            'seed_seconds_per_api_cycle': round(seed_api_s / API_CYCLES, 3),
            'login_median_ms': round(statistics.median(logins), 1),
            'screens': {name: {'small': small[name], 'large': large[name]} for name, _ in SCREENS},
        }
        print('\nPERF_BENCHMARK ' + json.dumps(report))
        # Query counts (N+1) are asserted by tests_query_scaling, run in the same command.
