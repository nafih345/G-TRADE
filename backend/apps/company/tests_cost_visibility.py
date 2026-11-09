"""Settings → Pricing Rules → Show Cost Price (apps/company/cost_visibility.py): the Main Admin and
the users they pick see cost; everyone else gets no cost key at all, on every product API. Run
through real tenant logins (JWT), since the product APIs skip DRF authentication."""
from django.contrib.auth import get_user_model
from django.test import override_settings
from rest_framework.test import APIClient, APITestCase

from apps.common import tenancy
from apps.common.tenant_onboarding import onboard_tenant
from apps.products.models import Product

PASSWORD = 'Str0ng-pass-123'
RULES = '/api/company/pricing-rules/'


@override_settings(HOT_CACHE_SECONDS=30)
class CostVisibilityTests(APITestCase):
    def setUp(self):
        from django.core.cache import cache
        cache.clear()   # login throttle
        self.tenant, self.owner = onboard_tenant(name='Cost Shop', admin_username='owner', password=PASSWORD)
        User = get_user_model()
        self.manager = User.objects.create_user(username='mgr', password=PASSWORD, role='MANAGER', tenant=self.tenant)
        self.clerk = User.objects.create_user(username='clerk', password=PASSWORD, role='INVENTORY_MANAGER',
                                              tenant=self.tenant)
        User.objects.create_user(username='till', password=PASSWORD, role='CASHIER', tenant=self.tenant)
        self.api = {name: self._login(name) for name in ('owner', 'mgr', 'clerk')}
        self.api['cashier'] = self._login('till')
        res = self.api['owner'].post('/api/products/items/', {
            'name': 'Cost Frame', 'sku': 'CF-1', 'stock': 5, 'opening_stock': 5,
            'retail_price': 300, 'cost_price': 120}, format='json')
        self.assertIn(res.status_code, (200, 201), res.content)
        self.pid = res.data['id']

    def _login(self, username):
        api = APIClient()
        res = api.post('/api/auth/login/', {'username': username, 'password': PASSWORD}, format='json')
        self.assertEqual(res.status_code, 200, res.content)
        api.credentials(HTTP_AUTHORIZATION=f"Bearer {res.data['access']}")
        api.login_payload = res.data['user']
        return api

    def _rules(self, api='owner', expect=200, **settings):
        res = self.api[api].put(RULES, settings, format='json')
        self.assertEqual(res.status_code, expect, res.content)
        return res

    def _product(self, api):
        res = self.api[api].get(f'/api/products/items/{self.pid}/')
        self.assertEqual(res.status_code, 200, res.content)
        return res.data

    def _overview_row(self, api):
        res = self.api[api].get('/api/inventory/stock-overview/', {'search': 'CF-1'})
        self.assertEqual(res.status_code, 200, res.content)
        return res.data['results'][0]

    # --- defaults ------------------------------------------------------------------------------

    def test_default_only_main_admin_sees_cost(self):
        self.assertTrue(self.api['owner'].login_payload['can_view_cost'])
        self.assertFalse(self.api['mgr'].login_payload['can_view_cost'])
        self.assertEqual(float(self._product('owner')['cost_price']), 120)
        self.assertNotIn('cost_price', self._product('mgr'))
        self.assertNotIn('cost_price', self._product('clerk'))
        row = self._overview_row('mgr')
        self.assertNotIn('cost_price', row)
        self.assertNotIn('purchase_value', row['lifecycle'] or {})
        self.assertIn('cost_price', self._overview_row('owner'))
        summary = self.api['mgr'].get('/api/inventory/stock-overview/summary/').data
        self.assertNotIn('purchase_value', summary)

    def test_profile_carries_flag(self):
        res = self.api['mgr'].get('/api/auth/profile/')
        self.assertIs(res.data['can_view_cost'], False)

    # --- authorized users ----------------------------------------------------------------------

    def test_main_admin_grants_and_revokes_a_user(self):
        res = self.api['owner'].get(RULES)
        users = {u['username']: u for u in res.data['cost_users']}
        self.assertEqual(set(users), {'owner', 'mgr', 'clerk', 'till'})
        self.assertTrue(users['owner']['main_admin'])
        self._rules(cost_viewers=[users['mgr']['id']])
        self.assertEqual(float(self._product('mgr')['cost_price']), 120)
        self.assertIn('cost_price', self._overview_row('mgr'))
        self.assertTrue(self.api['mgr'].get('/api/auth/profile/').data['can_view_cost'])
        self.assertNotIn('cost_price', self._product('clerk'))
        self._rules(cost_viewers=[])
        self.assertNotIn('cost_price', self._product('mgr'))

    def test_master_switch_off_hides_from_everyone(self):
        mgr_id = str(self.manager.pk)
        self._rules(cost_viewers=[mgr_id])
        self._rules(show_cost_price=False)
        for api in ('owner', 'mgr', 'clerk'):
            self.assertNotIn('cost_price', self._product(api), api)
        self.assertNotIn('cost_price', self._overview_row('owner'))
        self.assertFalse(self.api['owner'].get('/api/auth/profile/').data['can_view_cost'])

    def test_only_main_admin_changes_visibility(self):
        # A manager may edit the other pricing rules but not who sees cost.
        self._rules('mgr', expect=403, cost_viewers=[str(self.manager.pk)])
        self._rules('mgr', expect=403, show_cost_price=False)
        self._rules('mgr', cost_lock_enabled=True)
        body = self.api['mgr'].get(RULES).data
        self.assertNotIn('cost_users', body)
        self.assertNotIn('cost_viewers', body['settings'])

    def test_unknown_user_refused(self):
        res = self._rules(expect=400, cost_viewers=['00000000-0000-0000-0000-000000000000'])
        self.assertIn('cost_viewers', res.data['errors'])

    def test_other_tenant_users_not_listed(self):
        onboard_tenant(name='Other Shop', admin_username='other', password=PASSWORD)
        names = {u['username'] for u in self.api['owner'].get(RULES).data['cost_users']}
        self.assertNotIn('other', names)

    def test_settings_are_per_tenant(self):
        _t2, _a2 = onboard_tenant(name='Second Shop', admin_username='second', password=PASSWORD)
        self._rules(show_cost_price=False)
        second = self._login('second')
        self.assertTrue(second.login_payload['can_view_cost'])

    # --- writes --------------------------------------------------------------------------------

    def test_hidden_user_edit_keeps_cost(self):
        # A form that never received the cost sends 0 back: the saved cost must survive.
        res = self.api['clerk'].patch(f'/api/products/items/{self.pid}/', {'name': 'Cost Frame 2', 'cost_price': 0},
                                      format='json')
        self.assertEqual(res.status_code, 200, res.content)
        with tenancy.use_tenant(self.tenant.pk):
            self.assertEqual(float(Product.objects.get(pk=self.pid).cost_price), 120)

    def test_product_edit_never_overwrites_stock(self):
        res = self.api['owner'].patch(f'/api/products/items/{self.pid}/', {'stock': 999}, format='json')
        self.assertEqual(res.status_code, 200, res.content)
        with tenancy.use_tenant(self.tenant.pk):
            self.assertEqual(Product.objects.get(pk=self.pid).stock, 5)

    # --- pricing screens -----------------------------------------------------------------------

    def test_floors_and_offers_hide_cost(self):
        self._rules(cost_lock_enabled=True, offers_enabled=True)
        res = self.api['mgr'].post(f'{RULES}floors/', {'products': [self.pid]}, format='json')
        self.assertEqual(res.status_code, 200, res.content)
        self.assertNotIn('cost', res.data['floors'][self.pid])
        self.assertEqual(res.data['floors'][self.pid]['floor'], 120.0)
        res = self.api['owner'].post(f'{RULES}floors/', {'products': [self.pid]}, format='json')
        self.assertEqual(res.data['floors'][self.pid]['cost'], 120.0)
        res = self.api['mgr'].post(f'{RULES}offers/', {'scope': 'PRODUCT', 'products': [self.pid],
                                                       'offer_price': 100, 'tag': 'Clearance Stock'}, format='json')
        self.assertEqual(res.status_code, 201, res.content)
        self.assertNotIn('cost_price', res.data[0])
        self.assertNotIn('cost_price', self.api['mgr'].get(f'{RULES}offers/').data[0])
        self.assertIn('cost_price', self.api['owner'].get(f'{RULES}offers/').data[0])

    def test_below_cost_refusal_does_not_name_cost(self):
        self._rules(cost_lock_enabled=True, min_margin_percent=10)
        res = self.api['cashier'].post('/api/sales/invoices/', {
            'document_type': 'INVOICE', 'invoice_date': '2026-11-09', 'status': 'PAID',
            'customer_name': 'Walk In', 'total_amount': 50, 'net_amount': 50, 'paid_amount': 0,
            'items': [{'product': self.pid, 'description': 'Cost Frame', 'quantity': 1, 'unit_price': 50,
                       'tax_rate': 0, 'tax_amount': 0, 'subtotal': 50}],
        }, format='json')
        self.assertEqual(res.status_code, 400, res.content)
        self.assertEqual(res.data['code'], 'below_cost')
        self.assertNotIn('120.00', str(res.data['detail']))
        self.assertNotIn('cost_unit', res.data['violations'][0])
