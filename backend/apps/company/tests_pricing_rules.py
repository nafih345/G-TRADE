"""Settings → Pricing Rules & Offers: the selling-below-cost lock, clearance offers and the
manager override (apps/company/pricing_rules.py, enforced by InvoiceViewSet)."""
import datetime

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from apps.company.models import PricingOffer, SettingsAuditLog
from apps.masters.models import ProductCategory
from apps.products.models import Product


def user(role, name=None):
    return get_user_model().objects.create_user(username=name or role.lower(), password='pw-123', role=role)


class PricingRulesTests(APITestCase):
    RULES = '/api/company/pricing-rules/'
    OFFERS = '/api/company/pricing-rules/offers/'
    INVOICES = '/api/sales/invoices/'

    def setUp(self):
        self.admin = user('ADMINISTRATOR')
        self.cashier = user('CASHIER')
        self.cat = ProductCategory.objects.create(name='Frames', code='FRM')
        self.frame = Product.objects.create(name='Cost Frame', sku='CL-1', stock=10, cost_price=100,
                                            retail_price=150, category=self.cat)
        self.lens = Product.objects.create(name='Pair Lens', sku='CL-2', stock=10, cost_price=400,
                                           extra_data={'lens_stock_unit': 'PAIR'})

    def _rules(self, **settings):
        self.client.force_authenticate(self.admin)
        res = self.client.put(self.RULES, settings, format='json')
        self.assertEqual(res.status_code, 200, res.content)
        return res.data['settings']

    def _sell(self, price, qty=1, discount=None, product=None, as_user=None, net=None, **extra):
        product = product or self.frame
        self.client.force_authenticate(as_user or self.cashier)
        line = {'product': str(product.id), 'description': product.name, 'quantity': qty,
                'unit_price': price, 'tax_rate': 0, 'tax_amount': 0, 'subtotal': qty * price - (discount or 0)}
        if discount is not None:
            line['discount'] = discount
        total = qty * price - (discount or 0)
        return self.client.post(self.INVOICES, {
            'document_type': 'INVOICE', 'invoice_date': '2026-11-04', 'status': 'PAID',
            'customer_name': 'Walk In', 'total_amount': qty * price, 'net_amount': total if net is None else net,
            'paid_amount': 0, 'items': [line], **extra,
        }, format='json')

    # --- settings ---------------------------------------------------------------------------

    def test_lock_off_by_default_allows_any_price(self):
        res = self._sell(10)
        self.assertEqual(res.status_code, 201, res.content)

    def test_only_admins_and_managers_change_rules(self):
        self.client.force_authenticate(self.cashier)
        self.assertEqual(self.client.put(self.RULES, {'cost_lock_enabled': True}, format='json').status_code, 403)
        self.client.force_authenticate(user('MANAGER'))
        self.assertEqual(self.client.put(self.RULES, {'cost_lock_enabled': True}, format='json').status_code, 200)
        self.assertTrue(SettingsAuditLog.objects.filter(section='PRICING').exists())

    def test_invalid_margin_is_refused(self):
        self.client.force_authenticate(self.admin)
        res = self.client.put(self.RULES, {'min_margin_percent': -5}, format='json')
        self.assertEqual(res.status_code, 400)
        self.assertIn('min_margin_percent', res.data['errors'])

    # --- the lock ---------------------------------------------------------------------------

    def test_below_cost_is_refused_and_nothing_saved(self):
        self._rules(cost_lock_enabled=True)
        res = self._sell(80)
        self.assertEqual(res.status_code, 400)
        self.assertEqual(res.data['code'], 'below_cost')
        self.assertIn('100.00', str(res.data['detail']))
        self.frame.refresh_from_db()
        self.assertEqual(self.frame.stock, 10)
        self.assertEqual(self._sell(100).status_code, 201)

    def test_line_discount_and_bill_discount_count(self):
        self._rules(cost_lock_enabled=True)
        self.assertEqual(self._sell(120, discount=30).status_code, 400)       # 90 net
        self.assertEqual(self._sell(120, net=95).status_code, 400)            # overall discount 25
        self.assertEqual(self._sell(120, discount=20).status_code, 201)       # 100 net

    def test_minimum_margin_and_profit_floor(self):
        self._rules(cost_lock_enabled=True, min_margin_percent=10, min_profit_amount=25)
        self.assertEqual(self._sell(120).status_code, 400)   # floor = max(110, 125)
        self.assertEqual(self._sell(125).status_code, 201)

    def test_lens_single_piece_costs_half_a_pair(self):
        self._rules(cost_lock_enabled=True)
        self.client.force_authenticate(self.cashier)
        base = {'document_type': 'INVOICE', 'invoice_date': '2026-11-04', 'status': 'PAID',
                'customer_name': 'Walk In', 'paid_amount': 0}
        line = {'product': str(self.lens.id), 'description': 'Pair Lens', 'quantity': 1, 'tax_amount': 0,
                'selling_unit': 'PIECE', 'lens_eye': 'RE', 'physical_quantity': 1,
                'lens_details': {'rx': {'re': {'sph': '-1.00'}}}}
        ok = self.client.post(self.INVOICES, {**base, 'net_amount': 200, 'total_amount': 200,
                                              'items': [{**line, 'unit_price': 200, 'subtotal': 200}]}, format='json')
        self.assertNotEqual(ok.data.get('code'), 'below_cost', ok.content)
        low = self.client.post(self.INVOICES, {**base, 'net_amount': 150, 'total_amount': 150,
                                               'items': [{**line, 'unit_price': 150, 'subtotal': 150}]}, format='json')
        self.assertEqual(low.data.get('code'), 'below_cost', low.content)

    # --- overrides --------------------------------------------------------------------------

    def test_admin_can_override_but_cashier_flag_is_ignored(self):
        self._rules(cost_lock_enabled=True)
        self.assertEqual(self._sell(80, override_price_floor=True).status_code, 400)
        self.assertEqual(self._sell(80, override_price_floor=True, as_user=self.admin).status_code, 201)
        self.assertTrue(SettingsAuditLog.objects.filter(section='PRICING', action='OVERRIDE').exists())

    def test_manager_approval_token_at_the_till(self):
        self._rules(cost_lock_enabled=True)
        manager = user('MANAGER', 'floor.manager')
        self.client.force_authenticate(self.cashier)
        bad = self.client.post('/api/company/pricing-rules/approve/',
                               {'username': 'floor.manager', 'password': 'nope'}, format='json')
        self.assertEqual(bad.status_code, 400)
        denied = self.client.post('/api/company/pricing-rules/approve/',
                                  {'username': 'cashier', 'password': 'pw-123'}, format='json')
        self.assertEqual(denied.status_code, 403)
        ok = self.client.post('/api/company/pricing-rules/approve/',
                              {'username': manager.username, 'password': 'pw-123'}, format='json')
        self.assertEqual(ok.status_code, 200, ok.content)
        self.assertEqual(self._sell(80, price_override_token=ok.data['token']).status_code, 201)
        self.assertEqual(self._sell(80, price_override_token='forged').status_code, 400)

    # --- offers -----------------------------------------------------------------------------

    def _offer(self, **body):
        self.client.force_authenticate(self.admin)
        res = self.client.post(self.OFFERS, body, format='json')
        self.assertEqual(res.status_code, 201, res.content)
        return res.data

    def test_clearance_offer_lowers_floor_only_when_module_on(self):
        self._rules(cost_lock_enabled=True)
        self._offer(products=[str(self.frame.id)], offer_price=60, tag='Clearance Stock')
        self.assertEqual(self._sell(70).status_code, 400)          # module off → offer ignored
        self._rules(offers_enabled=True)
        self.assertEqual(self._sell(70).status_code, 201)
        self.assertEqual(self._sell(50).status_code, 400)          # still not under the offer price

    def test_offer_without_price_allows_any_price_and_dates_apply(self):
        self._rules(cost_lock_enabled=True, offers_enabled=True)
        yesterday = (datetime.date.today() - datetime.timedelta(days=1)).isoformat()
        self._offer(categories=[str(self.cat.id)], offer_price=None, tag='Festival Offer', end_date=yesterday,
                    start_date='2026-01-01')
        self.assertEqual(self._sell(10).status_code, 400)          # expired
        offer = PricingOffer.objects.get()
        self.client.force_authenticate(self.admin)
        self.client.patch(f'{self.OFFERS}{offer.pk}/', {'end_date': None}, format='json')
        self.assertEqual(self._sell(10).status_code, 201)

    def test_readding_a_product_updates_its_offer(self):
        self._offer(products=[str(self.frame.id)], offer_price=60, tag='A')
        self._offer(products=[str(self.frame.id)], offer_price=40, tag='B')
        self.assertEqual(PricingOffer.objects.count(), 1)
        self.assertEqual(PricingOffer.objects.get().tag, 'B')

    def test_cashier_cannot_add_offers_and_floors_endpoint(self):
        self.client.force_authenticate(self.cashier)
        self.assertEqual(self.client.post(self.OFFERS, {'products': [str(self.frame.id)], 'tag': 'x'},
                                          format='json').status_code, 403)
        self._rules(cost_lock_enabled=True, min_margin_percent=10)
        self.client.force_authenticate(self.cashier)
        res = self.client.post('/api/company/pricing-rules/floors/', {'products': [str(self.frame.id)]}, format='json')
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.data['floors'][str(self.frame.id)]['floor'], 110.0)
        self.assertFalse(res.data['can_override'])

    def test_floors_report_offer_status_with_lock_off(self):
        # Offers on, lock off: New Sale still needs each line's On Offer / Not on Offer state.
        self._rules(offers_enabled=True)
        self._offer(products=[str(self.frame.id)], offer_price=None, tag='Clearance Stock')
        self.client.force_authenticate(self.cashier)
        res = self.client.post('/api/company/pricing-rules/floors/',
                               {'products': [str(self.frame.id), str(self.lens.id)]}, format='json')
        self.assertEqual(res.status_code, 200)
        frame, lens = res.data['floors'][str(self.frame.id)], res.data['floors'][str(self.lens.id)]
        self.assertEqual(frame['offer']['tag'], 'Clearance Stock')
        self.assertIsNone(frame['floor'])
        self.assertIsNone(lens['offer'])
        # Offers switched off → no product info at all (nothing to badge).
        self._rules(offers_enabled=False)
        self.client.force_authenticate(self.cashier)
        res = self.client.post('/api/company/pricing-rules/floors/', {'products': [str(self.frame.id)]}, format='json')
        self.assertEqual(res.data['floors'], {})
