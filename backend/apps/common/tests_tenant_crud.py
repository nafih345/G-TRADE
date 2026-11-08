"""End-to-end CRUD and isolation for clients created the way Client Management creates them.

Every request here goes through the real stack: /api/auth/login/ → signed JWT with tenant_id →
TenantContextMiddleware → BranchContextMiddleware → DRF. Nothing uses force_authenticate, and
TENANCY_ANONYMOUS_TENANT_ID is off, exactly as in production (the test default scopes anonymous
requests to tenant #1, which hides missing-tenant bugs).
"""
import datetime
import importlib
import uuid

from django.apps import apps as django_apps
from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.db import connection
from django.test import TestCase, override_settings
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APIClient

from apps.common import tenancy
from apps.common.models import IdempotencyRecord, Tenant, TenantAuditLog
from apps.common.tenant_onboarding import onboard_tenant

PW = 'Str0ng-pass-123'
TODAY = datetime.date.today().isoformat()


def rows(data):
    return data['results'] if isinstance(data, dict) and 'results' in data else data


@override_settings(TENANCY_ANONYMOUS_TENANT_ID=None)
class TenantFixture(TestCase):
    def setUp(self):
        cache.clear()
        self.addCleanup(cache.clear)
        User = get_user_model()
        self.platform_tenant = Tenant.objects.get(pk=tenancy.DEFAULT_TENANT_ID)
        User.objects.create_superuser('platform', password=PW, tenant=self.platform_tenant)
        self.ta, _ = onboard_tenant(name='Client A', admin_username='clienta', password=PW)
        self.tb, _ = onboard_tenant(name='Client B', admin_username='clientb', password=PW)
        self.a = self.login('clienta')
        self.b = self.login('clientb')

    def login(self, username, reauth=False):
        client = APIClient()
        res = client.post('/api/auth/login/', {'username': username, 'password': PW}, format='json')
        self.assertEqual(res.status_code, 200, res.content)
        client.credentials(HTTP_AUTHORIZATION=f"Bearer {res.data['access']}")
        client.tokens = res.data
        if reauth:
            client.post('/api/security/reauth/', {'password': PW}, format='json')
        return client

    def call(self, client, method, url, body=None, **extra):
        # Accounting posts when the save commits; run those callbacks the way a live request does.
        with self.captureOnCommitCallbacks(execute=True):
            return getattr(client, method)(url, body, format='json', **extra) if body is not None \
                else getattr(client, method)(url, **extra)

    # ---- the documents a client creates on day one ----------------------------------------

    def create_set(self, client, tag):
        """Category, brand, product, customer, supplier, purchase, sale. Returns their ids."""
        ids = {}
        res = self.call(client, 'post', '/api/masters/categories/', {'name': f'Test Frames {tag}', 'code': f'TFR{tag}'})
        self.assertEqual(res.status_code, 201, res.data)
        ids['category'] = res.data['id']
        res = self.call(client, 'post', '/api/masters/brands/', {'name': f'Brand {tag}', 'code': f'BR{tag}'})
        self.assertEqual(res.status_code, 201, res.data)
        ids['brand'] = res.data['id']
        res = self.call(client, 'post', '/api/products/items/', {
            'name': f'Frame {tag}', 'sku': f'FR-{tag}', 'category': ids['category'], 'brand': ids['brand'],
            'cost_price': 250, 'retail_price': 1000, 'stock': 0})
        self.assertEqual(res.status_code, 201, res.data)
        ids['product'] = res.data['id']
        res = self.call(client, 'post', '/api/sales/customers/', {'name': f'Customer {tag}', 'phone': '9876543210'})
        self.assertEqual(res.status_code, 201, res.data)
        ids['customer'] = res.data['id']
        res = self.call(client, 'post', '/api/purchase/suppliers/', {'name': f'Supplier {tag}', 'phone': '9876500000'})
        self.assertEqual(res.status_code, 201, res.data)
        ids['supplier'] = res.data['id']
        res = self.call(client, 'post', '/api/purchase/invoices/', {
            'invoice_number': f'PE-{tag}', 'supplier': ids['supplier'], 'purchase_date': TODAY,
            'purchase_type': 'CREDIT', 'payment_method': 'CREDIT', 'status': 'CONFIRMED', 'grand_total': 500,
            'balance_amount': 500, 'items': [{'product': ids['product'], 'quantity': 2, 'purchase_rate': 250,
                                              'line_total': 500}]})
        self.assertEqual(res.status_code, 201, res.data)
        ids['purchase'] = res.data['id']
        res = self.call(client, 'post', '/api/sales/invoices/', {
            'customer_name': f'Customer {tag}', 'customer': ids['customer'], 'invoice_date': TODAY,
            'document_type': 'INVOICE', 'total_amount': '1000', 'net_amount': '1000', 'paid_amount': '1000',
            'payment_mode': 'CASH',
            'items': [{'product': ids['product'], 'quantity': 1, 'unit_price': '1000', 'total': '1000'}]})
        self.assertEqual(res.status_code, 201, res.data)
        ids['sale'] = res.data['id']
        return ids


class ClientCrudTests(TenantFixture):
    def test_onboarding_gives_the_client_a_warehouse(self):
        for client in (self.a, self.b):
            res = client.get('/api/company/warehouses/')
            self.assertEqual([w['code'] for w in rows(res.data)], ['WH-MAIN'])

    def test_each_client_creates_its_day_one_records(self):
        for client, tag in ((self.a, 'A'), (self.b, 'B')):
            ids = self.create_set(client, tag)
            # Stock: +2 purchased, -1 sold — and both movements are in the ledger.
            product = client.get(f"/api/products/items/{ids['product']}/").data
            self.assertEqual(product['stock'], 1)
            ledger = rows(client.get('/api/inventory/ledger/').data)
            self.assertEqual(sorted(r['quantity'] for r in ledger), [-1, 2])
            # Accounting: both documents posted, books balanced, nothing in the failure queue.
            status = client.get('/api/financial/integration/status/').data
            self.assertEqual(status['open_failures'], 0, status)
            self.assertTrue(status['ledger_balanced'])
            self.assertEqual(rows(client.get('/api/financial/integration/failures/').data), [])
            # The new records are listed.
            self.assertIn(ids['customer'], {r['id'] for r in rows(client.get('/api/sales/customers/').data)})
            self.assertIn(ids['sale'], {r['id'] for r in rows(client.get('/api/sales/invoices/').data)})

    def test_update_and_delete_own_records(self):
        ids = self.create_set(self.a, 'A')
        res = self.call(self.a, 'patch', f"/api/sales/customers/{ids['customer']}/", {'name': 'Renamed'})
        self.assertEqual(res.status_code, 200, res.data)
        self.assertEqual(res.data['name'], 'Renamed')
        res = self.call(self.a, 'patch', f"/api/purchase/suppliers/{ids['supplier']}/", {'phone': '9000000009'})
        self.assertEqual(res.status_code, 200, res.data)
        res = self.call(self.a, 'delete', f"/api/masters/brands/{ids['brand']}/")
        self.assertIn(res.status_code, (200, 204), getattr(res, 'data', None))
        self.assertNotIn(ids['brand'], {r['id'] for r in rows(self.a.get('/api/masters/brands/').data)})

    def test_duplicate_names_are_per_client(self):
        body = {'name': 'Ray-Ban', 'code': 'RB'}
        self.assertEqual(self.call(self.a, 'post', '/api/masters/brands/', body).status_code, 201)
        self.assertEqual(self.call(self.a, 'post', '/api/masters/brands/', body).status_code, 400)
        self.assertEqual(self.call(self.b, 'post', '/api/masters/brands/', body).status_code, 201)

    def test_new_client_profile_reports_its_own_tenant(self):
        profile = self.a.get('/api/auth/profile/').data
        self.assertEqual(profile['tenant'], self.ta.pk)
        self.assertFalse(profile['is_platform_admin'])
        self.assertIsNone(profile['workspace'])


class CrossTenantSecurityTests(TenantFixture):
    def setUp(self):
        super().setUp()
        self.ids_a = self.create_set(self.a, 'A')

    def test_other_client_cannot_read_update_or_delete(self):
        for path in (f"/api/products/items/{self.ids_a['product']}/", f"/api/sales/customers/{self.ids_a['customer']}/",
                     f"/api/purchase/suppliers/{self.ids_a['supplier']}/", f"/api/sales/invoices/{self.ids_a['sale']}/",
                     f"/api/purchase/invoices/{self.ids_a['purchase']}/", f"/api/masters/categories/{self.ids_a['category']}/"):
            self.assertEqual(self.b.get(path).status_code, 404, path)
            self.assertEqual(self.call(self.b, 'patch', path, {'name': 'hijacked'}).status_code, 404, path)
            self.assertEqual(self.call(self.b, 'delete', path).status_code, 404, path)
            self.assertEqual(self.a.get(path).status_code, 200, path)

    def test_lists_never_show_other_clients_rows(self):
        for path in ('/api/products/items/', '/api/sales/customers/', '/api/purchase/suppliers/',
                     '/api/sales/invoices/', '/api/purchase/invoices/', '/api/masters/categories/',
                     '/api/inventory/ledger/', '/api/financial/journals/'):
            a_ids = {r['id'] for r in rows(self.a.get(path).data)}
            b_ids = {r['id'] for r in rows(self.b.get(path).data)}
            self.assertTrue(a_ids, path)
            # B may have rows of its own (seeded default categories), never A's.
            self.assertFalse(a_ids & b_ids, path)

    def test_signed_out_session_is_refused_on_allowany_views(self):
        """Views declared without authentication used to keep serving a signed-out token."""
        self.assertEqual(self.a.get('/api/masters/brands/').status_code, 200)
        self.a.post('/api/auth/logout/', {'refresh': self.a.tokens['refresh']}, format='json')
        self.assertEqual(self.a.get('/api/masters/brands/').status_code, 401)
        self.assertEqual(self.a.post('/api/masters/brands/', {'name': 'Late', 'code': 'LT'},
                                     format='json').status_code, 401)

    def test_tenant_in_body_is_ignored(self):
        res = self.call(self.b, 'post', '/api/sales/customers/', {'name': 'Spoof', 'tenant': self.ta.pk,
                                                                    'tenant_id': self.ta.pk})
        self.assertEqual(res.status_code, 201, res.data)
        with tenancy.unscoped():
            from apps.sales.models import Customer
            self.assertEqual(Customer.objects.get(pk=res.data['id']).tenant_id, self.tb.pk)
        self.assertNotIn(res.data['id'], {r['id'] for r in rows(self.a.get('/api/sales/customers/').data)})

    def test_cannot_reference_another_clients_records(self):
        """A sale or purchase line pointing at Client A's product is refused for Client B."""
        sup = self.call(self.b, 'post', '/api/purchase/suppliers/', {'name': 'B supplier'}).data
        res = self.call(self.b, 'post', '/api/purchase/invoices/', {
            'invoice_number': 'PE-X', 'supplier': sup['id'], 'purchase_date': TODAY, 'status': 'CONFIRMED',
            'purchase_type': 'CREDIT', 'payment_method': 'CREDIT', 'grand_total': 1, 'balance_amount': 1,
            'items': [{'product': self.ids_a['product'], 'quantity': 1, 'purchase_rate': 1, 'line_total': 1}]})
        self.assertEqual(res.status_code, 400, res.data)
        res = self.call(self.b, 'post', '/api/sales/invoices/', {
            'customer_name': 'X', 'customer': self.ids_a['customer'], 'invoice_date': TODAY,
            'document_type': 'INVOICE', 'total_amount': '1', 'net_amount': '1', 'items': []})
        self.assertEqual(res.status_code, 400, res.data)
        with tenancy.unscoped():
            from apps.products.models import Product
            self.assertEqual(Product.objects.get(pk=self.ids_a['product']).stock, 1)  # untouched

    def test_forged_tenant_claim_is_rejected(self):
        from rest_framework_simplejwt.tokens import AccessToken
        token = AccessToken(self.b.tokens['access'])
        token['tenant_id'] = self.ta.pk           # re-signed, but no workspace grant
        forged = APIClient()
        forged.credentials(HTTP_AUTHORIZATION=f'Bearer {token}')
        self.assertEqual(forged.get('/api/sales/customers/').status_code, 401)
        token['workspace'] = True                  # a client admin can't grant themselves one either
        forged.credentials(HTTP_AUTHORIZATION=f'Bearer {token}')
        self.assertEqual(forged.get('/api/sales/customers/').status_code, 401)

    def test_anonymous_requests_see_and_write_nothing(self):
        anon = APIClient()
        self.assertEqual(rows(anon.get('/api/masters/brands/').data or []), [])
        res = anon.post('/api/masters/brands/', {'name': 'Anon', 'code': 'AN'}, format='json')
        self.assertIn(res.status_code, (401, 403))

    def test_role_header_does_not_grant_branch_access(self):
        """Branch access comes from the signed-in user, not the X-User-Role / X-User-Name headers."""
        from apps.company.models import Branch, BusinessSettings, UserBranchAccess
        User = get_user_model()
        User.objects.create_user('cashier', password=PW, role='CASHIER', tenant=self.ta)
        with tenancy.use_tenant(self.ta.pk):
            ho = Branch.objects.get(is_default=True)
            other = Branch.objects.create(company=ho.company, name='Second', code='B2', is_active=True)
            settings_obj = BusinessSettings.load()
            settings_obj.multi_branch_enabled = True
            settings_obj.save()
            access = UserBranchAccess.objects.create(username='cashier', default_branch=ho)
            access.branches.set([ho])
        cashier = self.login('cashier')
        res = cashier.get('/api/company/branch-context/', HTTP_X_USER_ROLE='SUPER_ADMIN',
                          HTTP_X_USER_NAME='clienta', HTTP_X_BRANCH_ID=str(other.pk))
        self.assertNotEqual(str((res.data.get('active_branch') or {}).get('id')), str(other.pk), res.data)


class SuperAdminWorkspaceTests(TenantFixture):
    def setUp(self):
        super().setUp()
        self.platform = self.login('platform', reauth=True)

    def open_workspace(self, tenant):
        res = self.platform.post(f'/api/superadmin/tenants/{tenant.pk}/workspace/', {}, format='json')
        self.assertEqual(res.status_code, 200, res.data)
        client = APIClient()
        client.credentials(HTTP_AUTHORIZATION=f"Bearer {res.data['access']}")
        client.tokens = res.data
        return client

    def test_platform_admin_creates_records_in_selected_clients(self):
        ws_a = self.open_workspace(self.ta)
        ids_a = self.create_set(ws_a, 'PA')
        ws_b = self.open_workspace(self.tb)
        ids_b = self.create_set(ws_b, 'PB')
        # Each client's own admin sees the records made for them, and only those.
        a_products = {r['id'] for r in rows(self.a.get('/api/products/items/').data)}
        b_products = {r['id'] for r in rows(self.b.get('/api/products/items/').data)}
        self.assertEqual(a_products, {ids_a['product']})
        self.assertEqual(b_products, {ids_b['product']})
        # ...and the platform's own tenant got none of them.
        self.assertEqual(rows(self.platform.get('/api/products/items/').data), [])
        with tenancy.unscoped():
            from apps.sales.models import Invoice
            self.assertEqual(Invoice.objects.get(pk=ids_a['sale']).tenant_id, self.ta.pk)
            self.assertEqual(Invoice.objects.get(pk=ids_b['sale']).tenant_id, self.tb.pk)

    def test_workspace_profile_and_audit(self):
        ws = self.open_workspace(self.ta)
        profile = ws.get('/api/auth/profile/').data
        self.assertEqual(profile['workspace']['tenant_id'], self.ta.pk)
        self.assertEqual(profile['workspace']['tenant_name'], 'Client A')
        self.assertFalse(profile['is_platform_admin'])
        self.assertTrue(TenantAuditLog.objects.filter(tenant=self.ta, action='WORKSPACE_OPENED',
                                                      actor='platform').exists())

    def test_platform_console_is_closed_inside_a_workspace(self):
        ws = self.open_workspace(self.ta)
        self.assertEqual(ws.get('/api/superadmin/tenants/').status_code, 403)
        self.assertEqual(ws.post(f'/api/superadmin/tenants/{self.tb.pk}/workspace/', {}, format='json').status_code, 403)
        # The platform session itself keeps working.
        self.assertEqual(self.platform.get('/api/superadmin/tenants/').status_code, 200)

    def test_workspace_token_refreshes_within_the_same_client(self):
        ws = self.open_workspace(self.ta)
        res = APIClient().post('/api/auth/token/refresh/', {'refresh': ws.tokens['refresh']}, format='json')
        self.assertEqual(res.status_code, 200, res.data)
        from rest_framework_simplejwt.tokens import AccessToken
        self.assertEqual(AccessToken(res.data['access'])['tenant_id'], self.ta.pk)

    def test_only_the_platform_owner_can_open_workspaces(self):
        res = self.a.post(f'/api/superadmin/tenants/{self.tb.pk}/workspace/', {}, format='json')
        self.assertEqual(res.status_code, 403)

    def test_deactivated_client_workspace_is_refused_and_closed(self):
        ws = self.open_workspace(self.tb)
        Tenant.objects.filter(pk=self.tb.pk).update(is_active=False)
        cache.clear()
        from apps.common import hot_cache
        hot_cache.clear()
        res = self.platform.post(f'/api/superadmin/tenants/{self.tb.pk}/workspace/', {}, format='json')
        self.assertEqual(res.status_code, 400)
        self.assertNotEqual(ws.get('/api/sales/customers/').status_code, 200)
        res = APIClient().post('/api/auth/token/refresh/', {'refresh': ws.tokens['refresh']}, format='json')
        self.assertEqual(res.status_code, 401)


class IdempotencyTests(TenantFixture):
    BODY = {'name': 'Walk-in Ravi', 'phone': '9800000000'}

    def test_resent_create_is_saved_once(self):
        key = str(uuid.uuid4())
        first = self.call(self.a, 'post', '/api/sales/customers/', self.BODY, HTTP_IDEMPOTENCY_KEY=key)
        again = self.call(self.a, 'post', '/api/sales/customers/', self.BODY, HTTP_IDEMPOTENCY_KEY=key)
        self.assertEqual((first.status_code, again.status_code), (201, 201))
        self.assertEqual(again['Idempotent-Replayed'], 'true')
        self.assertEqual(again.json()['id'], first.data['id'])
        names = [r['name'] for r in rows(self.a.get('/api/sales/customers/').data)]
        self.assertEqual(names.count('Walk-in Ravi'), 1)

    def test_key_is_per_client(self):
        key = str(uuid.uuid4())
        self.call(self.a, 'post', '/api/sales/customers/', self.BODY, HTTP_IDEMPOTENCY_KEY=key)
        res = self.call(self.b, 'post', '/api/sales/customers/', self.BODY, HTTP_IDEMPOTENCY_KEY=key)
        self.assertEqual(res.status_code, 201)
        self.assertFalse(res.has_header('Idempotent-Replayed'))

    def test_refusals_are_not_stored_and_changed_bodies_are_rejected(self):
        key = str(uuid.uuid4())
        bad = self.call(self.a, 'post', '/api/sales/customers/', {'phone': '1'}, HTTP_IDEMPOTENCY_KEY=key)
        self.assertEqual(bad.status_code, 400)
        self.assertFalse(IdempotencyRecord.objects.filter(key=key).exists())
        ok = self.call(self.a, 'post', '/api/sales/customers/', self.BODY, HTTP_IDEMPOTENCY_KEY=key)
        self.assertEqual(ok.status_code, 201)
        other = self.call(self.a, 'post', '/api/sales/customers/', {'name': 'Someone else'}, HTTP_IDEMPOTENCY_KEY=key)
        self.assertEqual(other.status_code, 422)


class BackfillMigrationTests(TestCase):
    def test_branches_without_a_warehouse_get_one(self):
        from apps.company.models import Branch, Company, Warehouse
        tenant = Tenant.objects.create(name='Legacy', code='legacy')
        with tenancy.use_tenant(tenant.pk):
            company = Company.objects.create(name='Legacy', fiscal_year_start=datetime.date(2026, 4, 1),
                                             fiscal_year_end=datetime.date(2027, 3, 31))
            branch = Branch.objects.create(company=company, name='HO', code='HO', is_default=True)
            Warehouse.objects.create(branch=branch, name='Taken', code='WH-MAIN', is_deleted=True)
        module = importlib.import_module('apps.company.migrations.0010_backfill_branch_warehouses')
        module.add_missing_warehouses(django_apps, None)
        module.add_missing_warehouses(django_apps, None)  # re-run is a no-op
        with tenancy.use_tenant(tenant.pk):
            live = list(Warehouse.objects.filter(branch=branch))
        self.assertEqual(len(live), 1)
        self.assertNotEqual(live[0].code, 'WH-MAIN')


class QueryCountTests(TenantFixture):
    """List endpoints must cost a fixed number of queries, not one (or more) per row: on the hosted
    database every query is a cross-region round trip."""

    def count(self, client, url):
        with CaptureQueriesContext(connection) as ctx:
            res = client.get(url)
        self.assertEqual(res.status_code, 200, url)
        return len(ctx.captured_queries)

    def test_lists_do_not_grow_with_rows(self):
        self.create_set(self.a, 'A0')
        urls = ('/api/products/items/', '/api/sales/customers/', '/api/purchase/suppliers/',
                '/api/sales/invoices/', '/api/purchase/invoices/', '/api/inventory/ledger/',
                '/api/masters/categories/', '/api/masters/brands/')
        self.count(self.a, '/api/auth/profile/')  # warm per-process caches
        small = {u: self.count(self.a, u) for u in urls}
        for i in range(1, 6):
            self.create_set(self.a, f'A{i}')
        large = {u: self.count(self.a, u) for u in urls}
        report = {u: (small[u], large[u]) for u in urls}
        print('\n[query counts: 1 set -> 6 sets]', report)
        for u in urls:
            self.assertLessEqual(large[u], small[u] + 2, f'{u} grows with rows: {report[u]}')


class DashboardSummaryTests(TenantFixture):
    URL = f'/api/sales/dashboard-summary/?date={TODAY}'

    def test_numbers_are_the_clients_own(self):
        self.create_set(self.a, 'A')
        data = self.a.get(self.URL).data
        self.assertEqual(data['today']['sales_count'], 1)
        self.assertEqual(data['today']['revenue'], '1000.00')
        this_month = data['monthly'][-1]
        self.assertEqual((this_month['sales'], this_month['purchases']), (1000, 500))
        self.assertEqual(len(data['monthly']), 6)
        self.assertEqual([r['invoice_number'] for r in data['recent_invoices']],
                         [rows(self.a.get('/api/sales/invoices/').data)[0]['invoice_number']])
        other = self.b.get(self.URL).data
        self.assertEqual((other['today']['sales_count'], other['today']['revenue']), (0, '0.00'))
        self.assertEqual(other['recent_invoices'], [])

    def test_fixed_query_count(self):
        self.create_set(self.a, 'A0')
        self.a.get(self.URL)
        with CaptureQueriesContext(connection) as small:
            self.a.get(self.URL)
        for i in range(1, 5):
            self.create_set(self.a, f'A{i}')
        with CaptureQueriesContext(connection) as large:
            self.a.get(self.URL)
        print(f'\n[dashboard-summary queries: {len(small)} -> {len(large)}]')
        self.assertEqual(len(small), len(large))

    def test_requires_sign_in(self):
        self.assertIn(APIClient().get(self.URL).status_code, (401, 403))
