"""Database round trips per create, through the whole stack (middleware + DRF + signals).

On the hosted setup every query is a network round trip to Postgres (~250 ms Render Singapore ↔
Neon us-east-2), so a save's latency is roughly queries x round trip. These budgets keep the
common creates from creeping back up. Measured as a live worker runs: per-process caches on
(HOT_CACHE_SECONDS), and not the business's very first document of a kind (that one also
creates its numbering sequence).
"""
from django.db import connection
from django.test import override_settings
from django.test.utils import CaptureQueriesContext

from apps.common import hot_cache
from apps.common.tests_tenant_crud import TenantFixture
from apps.common.tenant_onboarding import onboard_tenant

CASES = [
    ('supplier', '/api/purchase/suppliers/', lambda i: {'name': f'Hoya Lens {i}', 'phone': '9876500000'}, 11),
    ('customer', '/api/sales/customers/', lambda i: {'name': f'Ravi {i}', 'phone': '9876543210'}, 5),
    ('brand', '/api/masters/brands/', lambda i: {'name': f'Ray-Ban {i}', 'code': f'RB{i}'}, 4),
    ('category', '/api/masters/categories/', lambda i: {'name': f'Sunglass {i}', 'code': f'SG{i}'}, 3),
    ('product', '/api/products/items/', lambda i: {'name': f'Frame {i}', 'sku': f'FX-{i}', 'cost_price': 100,
                                                   'retail_price': 250, 'stock': 0}, 3),
]


@override_settings(HOT_CACHE_SECONDS=30)
class CreateQueryBudgetTests(TenantFixture):
    def setUp(self):
        hot_cache.clear()
        super().setUp()

    def post(self, client, url, body):
        with CaptureQueriesContext(connection) as ctx:
            with self.captureOnCommitCallbacks(execute=True):
                res = client.post(url, body, format='json')
        self.assertIn(res.status_code, (200, 201), res.content[:300])
        return ctx.captured_queries

    def test_steady_state_creates_stay_within_budget(self):
        report = {}
        for name, url, body, budget in CASES:
            self.post(self.a, url, body(1))          # first of its kind: creates the sequence
            queries = self.post(self.a, url, body(2))
            report[name] = len(queries)
            self.assertLessEqual(len(queries), budget,
                                 f'{name}: {len(queries)} queries\n' + '\n'.join(q['sql'][:140] for q in queries))
        print('\n[queries per create, warm worker]', report)

    def test_new_clients_first_supplier_is_cheap(self):
        """A new client's first Supplier save used to build the whole chart of accounts:
        185 queries (~45 s hosted). Onboarding now seeds it; what remains is one-time (its
        supplier-number sequence, cold per-process caches)."""
        queries = self.post(self.b, '/api/purchase/suppliers/', {'name': 'First supplier'})
        print(f'\n[first supplier of a new client: {len(queries)} queries]')
        self.assertLessEqual(len(queries), 30)

    def test_client_onboarded_without_accounts_heals_in_bulk(self):
        """Clients created before onboarding seeded accounts pay once — in a few bulk writes."""
        from apps.common import tenancy
        from apps.financial.models import AccountGroup, AccountMapping, ChartOfAccount
        tenant, _ = onboard_tenant(name='Legacy Client', admin_username='legacy', password='Str0ng-pass-123')
        with tenancy.use_tenant(tenant.pk):
            AccountMapping._base_manager.filter(tenant=tenant).delete()
            ChartOfAccount._base_manager.filter(tenant=tenant).delete()
            AccountGroup._base_manager.filter(tenant=tenant).delete()
        client = self.login('legacy')
        queries = self.post(client, '/api/purchase/suppliers/', {'name': 'Legacy first supplier'})
        print(f'\n[first supplier, no chart of accounts yet: {len(queries)} queries]')
        self.assertLessEqual(len(queries), 50)  # was ~185
        with tenancy.use_tenant(tenant.pk):
            self.assertTrue(AccountMapping.objects.filter(role='INVENTORY').exists())
            self.assertTrue(ChartOfAccount.objects.filter(code='1003').exists())
