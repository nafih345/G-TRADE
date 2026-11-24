"""Wholesale Order Status (sales.wholesale_delivery): stock at billing, Accounts on delivery.

    Order billed (feature on)  -> stock out at once, invoice PENDING_DELIVERY, nothing posted
    Delivered / Post           -> invoice journal + COGS posted once, stock not moved again
    Not Delivered / Cancel     -> invoice voided, stock back, order UNDELIVERED, nothing posted
    Feature off / direct sale  -> posted on billing, exactly as before
"""
from datetime import timedelta
from decimal import Decimal
from unittest import mock

from rest_framework.test import APITestCase

from apps.common import module_access
from apps.financial.models import JournalEntry
from apps.financial.tests.helpers import TODAY, ledger_is_balanced, lines_of, live, make_product, make_warehouse
from apps.inventory.models import StockAdjustment
from apps.sales.models import Dealer, WholesaleInvoice, WholesaleOrder

ORDERS = '/api/sales/wholesale/orders/'
INVOICES = '/api/sales/wholesale/invoices/'
STATUS = '/api/sales/wholesale/order-status/'
D = Decimal


def switch_feature(on=True):
    from apps.common import tenancy
    from apps.common.models import Tenant
    Tenant.objects.filter(pk=tenancy.DEFAULT_TENANT_ID).update(module_features={'wholesale_order_status': on})


class OrderStatusFlowTests(APITestCase):
    def setUp(self):
        switch_feature(True)
        self.wh = make_warehouse()
        self.dealer = Dealer.objects.create(dealer_code='DL-OS1', business_name='Status Optics', phone='9000000001')
        self.product = make_product('Frame OS', cost='40.00', stock=100)

    # -- helpers -------------------------------------------------------------------------------
    def booked(self):
        return self.captureOnCommitCallbacks(execute=True)

    def _stock(self):
        self.product.refresh_from_db()
        return self.product.stock

    def _items(self, qty=10):
        return [{'id': str(self.product.id), 'name': 'Frame OS', 'qty': qty, 'rate': 100}]

    def _order(self, qty=10):
        with self.booked():
            res = self.client.post(ORDERS, {'dealer': str(self.dealer.id), 'total_amount': 1000,
                                            'details': {'items': self._items(qty)}}, format='json')
        self.assertEqual(res.status_code, 201, res.content)
        return res.data

    def _bill(self, order=None, number='WINV-700001', qty=10, paid=0):
        details = {'items': self._items(qty), 'orderStatus': 'Confirmed',
                   'summary': {'subtotal': 1000, 'totalGst': 0, 'grandTotal': 1000}}
        if order:
            details['linkedOrder'] = {'id': order['id'], 'orderNumber': order['order_number']}
        with self.booked():
            res = self.client.post(INVOICES, {
                'invoice_number': number, 'dealer': str(self.dealer.id), 'invoice_date': str(TODAY),
                'due_date': str(TODAY + timedelta(days=30)), 'grand_total': 1000, 'paid_amount': paid,
                'due_amount': 1000 - paid, 'status': 'Unpaid', 'details': details}, format='json')
        self.assertEqual(res.status_code, 201, res.content)
        return WholesaleInvoice.objects.get(invoice_number=number)

    def _deliver(self, order, **body):
        with self.booked():
            return self.client.post(f"{STATUS}{order['id']}/deliver/", body, format='json')

    def _cancel(self, order, **body):
        with self.booked():
            return self.client.post(f"{STATUS}{order['id']}/cancel-delivery/", body, format='json')

    def _adjustments(self, inv):
        return StockAdjustment.objects.filter(reference=inv.invoice_number).order_by('created_at')

    def _journals(self, inv):
        adj_ids = list(self._adjustments(inv).values_list('pk', flat=True))
        return JournalEntry.objects.filter(reference_id__in=[inv.pk, *adj_ids])

    # -- billing holds Accounts ----------------------------------------------------------------
    def test_billing_an_order_deducts_stock_and_holds_accounts(self):
        order = self._order()
        inv = self._bill(order)
        self.assertEqual((inv.delivery_status, inv.is_posted_to_accounts), ('PENDING_DELIVERY', False))
        self.assertEqual(self._stock(), 90)
        reasons = list(self._adjustments(inv).values_list('reason', flat=True))
        self.assertEqual(reasons, [f'Wholesale Invoice - Pending Delivery {inv.invoice_number}'])
        self.assertFalse(self._journals(inv).exists(), 'nothing may reach Accounts before delivery')
        self.assertEqual(WholesaleOrder.objects.get(pk=order['id']).status, 'BILLED')

        rows = self.client.get(f'{STATUS}orders/', {'dealer': str(self.dealer.id)}).data
        self.assertEqual([(r['order_number'], r['stage']) for r in rows], [(order['order_number'], 'INVOICED_PENDING_DELIVERY')])
        dealers = self.client.get(f'{STATUS}dealers/').data
        self.assertEqual((dealers[0]['dealer_name'], dealers[0]['confirmed'], dealers[0]['pending_delivery'],
                          dealers[0]['pending_orders']), ('Status Optics', 0, 1, 1))
        # The order list shows where the bill stands.
        self.assertEqual(self.client.get(f"{ORDERS}{order['id']}/").data['invoice_delivery_status'], 'PENDING_DELIVERY')

    def test_dealer_grouping_counts_confirmed_and_pending(self):
        a = self._order()
        self._order(qty=3)
        self._bill(a)
        other = Dealer.objects.create(dealer_code='DL-OS2', business_name='Idle Optics', phone='9000000002')
        self.assertTrue(other.pk)
        rows = {r['dealer_name']: r for r in self.client.get(f'{STATUS}dealers/').data}
        self.assertEqual(set(rows), {'Status Optics'})  # dealers without orders never show
        r = rows['Status Optics']
        self.assertEqual((r['confirmed'], r['pending_delivery'], r['pending_orders'], r['total_orders']), (1, 1, 2, 2))
        confirmed = self.client.get(f'{STATUS}orders/', {'dealer': str(self.dealer.id), 'stage': 'CONFIRMED'}).data
        self.assertEqual(len(confirmed), 1)
        self.assertEqual(confirmed[0]['units'], 3)
        self.assertEqual(self.client.get(f'{STATUS}orders/', {'stage': 'NOPE'}).status_code, 400)

    # -- Delivered / Post ----------------------------------------------------------------------
    def test_delivered_posts_invoice_and_cogs_once_without_moving_stock(self):
        order = self._order()
        inv = self._bill(order)
        res = self._deliver(order, note='Received by Ravi')
        self.assertEqual(res.status_code, 200, res.content)
        self.assertTrue(res.data['changed'])
        self.assertEqual(res.data['order']['stage'], 'DELIVERED_POSTED')
        inv.refresh_from_db()
        self.assertEqual((inv.delivery_status, inv.is_posted_to_accounts, inv.delivered_on, inv.delivery_note),
                         ('DELIVERED', True, TODAY, 'Received by Ravi'))
        self.assertEqual(self._stock(), 90, 'delivery must not deduct stock again')
        self.assertEqual(self._adjustments(inv).count(), 1)

        self.assertEqual(lines_of(live('sales', 'wholesale_invoice', inv.pk).get()), {'AR-DL-OS1': D('1000'), '4002': D('-1000')})
        adj = self._adjustments(inv).get()
        self.assertEqual(lines_of(live('inventory', 'stock_adjustment', adj.pk).get()), {'5001': D('400'), '1003': D('-400')})
        self.dealer.refresh_from_db()
        self.assertEqual(self.dealer.outstanding_balance, D('1000'))

        # Idempotent: a second Delivered posts nothing more and moves nothing.
        again = self._deliver(order)
        self.assertEqual(again.status_code, 200, again.content)
        self.assertFalse(again.data['changed'])
        self.assertEqual(live('sales', 'wholesale_invoice', inv.pk).count(), 1)
        self.assertEqual(self._stock(), 90)
        self.dealer.refresh_from_db()
        self.assertEqual(self.dealer.outstanding_balance, D('1000'))
        self.assertTrue(ledger_is_balanced())
        # A delivered bill can no longer be cancelled as undelivered.
        self.assertEqual(self._cancel(order).status_code, 400)

    def test_delivery_date_is_validated(self):
        order = self._order()
        self._bill(order)
        res = self._deliver(order, delivery_date=str(TODAY + timedelta(days=1)))
        self.assertEqual(res.status_code, 400)
        res = self._deliver(order, delivery_date=str(TODAY - timedelta(days=5)))
        self.assertEqual(res.status_code, 400)  # before the invoice date
        self.assertEqual(WholesaleInvoice.objects.get().delivery_status, 'PENDING_DELIVERY')

    def test_confirmed_order_cannot_be_delivered(self):
        order = self._order()
        self.assertEqual(self._deliver(order).status_code, 400)
        self.assertEqual(self._cancel(order).status_code, 400)

    # -- Not Delivered / Cancel ----------------------------------------------------------------
    def test_not_delivered_restores_stock_and_voids_the_bill(self):
        order = self._order()
        inv = self._bill(order)
        res = self._cancel(order, reason='Shop closed')
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(res.data['order']['stage'], 'UNDELIVERED')
        inv.refresh_from_db()
        self.assertEqual((inv.status, inv.delivery_status, inv.is_posted_to_accounts, inv.delivery_note),
                         ('Cancelled', 'UNDELIVERED', False, 'Shop closed'))
        self.assertEqual(self._stock(), 100)
        self.assertEqual(list(self._adjustments(inv).values_list('reason', flat=True)), [
            f'Wholesale Invoice - Pending Delivery {inv.invoice_number}',
            f'Wholesale Delivery Cancelled - Stock Reversed {inv.invoice_number}'])
        self.assertFalse(self._journals(inv).exists(), 'an undelivered bill never posts — nothing to reverse')
        o = WholesaleOrder.objects.get(pk=order['id'])
        self.assertEqual((o.status, o.reserved_items, o.invoice_id), ('UNDELIVERED', {}, inv.pk))

        # Final: it can't be posted, edited, deleted, cancelled again or re-billed.
        self.assertEqual(self._deliver(order).status_code, 400)
        self.assertFalse(self._cancel(order).data['changed'])
        res = self.client.patch(f'{INVOICES}{inv.pk}/', {'status': 'Unpaid', 'details': {**inv.details, 'orderStatus': 'Confirmed'}}, format='json')
        self.assertEqual(res.status_code, 400)
        self.assertEqual(self.client.delete(f'{INVOICES}{inv.pk}/').status_code, 400)
        self.assertEqual(self.client.post(f"{ORDERS}{order['id']}/cancel/").status_code, 400)
        res = self.client.post(INVOICES, {
            'invoice_number': 'WINV-700009', 'dealer': str(self.dealer.id), 'invoice_date': str(TODAY),
            'due_date': str(TODAY), 'grand_total': 1000, 'status': 'Unpaid',
            'details': {'items': self._items(), 'orderStatus': 'Confirmed',
                        'linkedOrder': {'id': order['id'], 'orderNumber': order['order_number']}}}, format='json')
        self.assertEqual(res.status_code, 400)
        self.assertEqual(self._stock(), 100)

    def test_cancelling_a_held_bill_in_the_pos_voids_it_and_reopens_the_order(self):
        order = self._order()
        inv = self._bill(order)
        with self.booked():
            res = self.client.patch(f'{INVOICES}{inv.pk}/', {'status': 'Cancelled',
                                                             'details': {**inv.details, 'orderStatus': 'Cancelled'}}, format='json')
        self.assertEqual(res.status_code, 200, res.content)
        inv.refresh_from_db()
        self.assertEqual((inv.delivery_status, inv.is_posted_to_accounts), ('UNDELIVERED', False))
        self.assertEqual(self._stock(), 100)
        o = WholesaleOrder.objects.get(pk=order['id'])
        self.assertEqual((o.status, o.invoice_id), ('CONFIRMED', None))
        self.assertFalse(self._journals(inv).exists())
        # The re-opened order bills again, held again.
        again = self._bill(order, number='WINV-700003')
        self.assertEqual(again.delivery_status, 'PENDING_DELIVERY')
        self.assertEqual(self._stock(), 90)

    def test_editing_a_held_bill_moves_only_the_difference_and_posts_nothing(self):
        order = self._order()
        inv = self._bill(order)
        with self.booked():
            res = self.client.patch(f'{INVOICES}{inv.pk}/', {'details': {**inv.details, 'items': self._items(7)}}, format='json')
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(self._stock(), 93)
        self.assertFalse(self._journals(inv).exists())
        self.assertEqual(self._deliver(order).status_code, 200)
        # COGS for exactly the 7 units that left: 10 out − 3 back.
        cogs = sum((lines_of(e).get('5001', D('0')) for e in JournalEntry.objects.filter(
            source_event='stock_adjustment', status='POSTED', is_reversal=False)), D('0'))
        self.assertEqual(cogs, D('280'))
        self.assertTrue(ledger_is_balanced())

    # -- unchanged paths -----------------------------------------------------------------------
    def test_direct_sale_posts_on_billing(self):
        inv = self._bill(None, number='WINV-700002')
        self.assertEqual((inv.delivery_status, inv.is_posted_to_accounts), (None, True))
        self.assertEqual(live('sales', 'wholesale_invoice', inv.pk).count(), 1)
        self.assertEqual(self._adjustments(inv).get().reason, f'Wholesale POS sale {inv.invoice_number}')

    def test_feature_off_bills_orders_the_old_way(self):
        order = self._order()
        with mock.patch('apps.sales.wholesale_delivery.feature_enabled', return_value=False):
            inv = self._bill(order)
        self.assertEqual((inv.delivery_status, inv.is_posted_to_accounts), (None, True))
        self.assertEqual(live('sales', 'wholesale_invoice', inv.pk).count(), 1)
        self.assertEqual(self._stock(), 90)

    def test_switch_off_refuses_endpoints_and_stops_holding(self):
        switch_feature(False)
        for res in (self.client.get(f'{STATUS}dealers/'), self.client.post(f'{STATUS}00000000-0000-0000-0000-000000000000/deliver/')):
            self.assertEqual(res.status_code, 403)
            self.assertEqual(res.data['code'], 'feature_disabled')
        order = self._order()
        inv = self._bill(order)
        self.assertEqual((inv.delivery_status, inv.is_posted_to_accounts), (None, True))
        self.assertEqual(live('sales', 'wholesale_invoice', inv.pk).count(), 1)


class ModuleFeatureRulesTests(APITestCase):
    def test_feature_needs_switch_and_parent_module(self):
        on = {'modules': ['wholesale'], 'module_features': {'wholesale_order_status': True}}
        self.assertEqual(module_access.enabled_module_features(on), ['wholesale_order_status'])
        self.assertEqual(module_access.enabled_module_features({**on, 'modules': ['sales']}), [])
        self.assertEqual(module_access.enabled_module_features({**on, 'module_features': {}}), [])
        self.assertEqual(module_access.enabled_module_features({**on, 'module_features': None}), ['wholesale_order_status'])

    def test_platform_account_is_opt_in_too(self):
        from apps.common import tenancy
        from apps.common.models import Tenant
        Tenant.objects.filter(pk=tenancy.DEFAULT_TENANT_ID).update(module_features={})
        self.assertFalse(module_access.tenant_has_feature('wholesale_order_status', tenancy.DEFAULT_TENANT_ID))
        switch_feature(True)
        self.assertTrue(module_access.tenant_has_feature('wholesale_order_status', tenancy.DEFAULT_TENANT_ID))

    def test_normalize_refuses_unknown_keys(self):
        self.assertEqual(module_access.normalize_module_features({'wholesale_order_status': 1}), {'wholesale_order_status': True})
        with self.assertRaises(ValueError):
            module_access.normalize_module_features({'nope': True})
        with self.assertRaises(ValueError):
            module_access.normalize_module_features(['wholesale_order_status'])

    def test_catalog_lists_module_features(self):
        keys = [f['key'] for f in module_access.catalog()['module_features']]
        self.assertEqual(keys, ['wholesale_order_status', 'bill_settlement'])


class ModuleFeaturesSettingsTests(APITestCase):
    """Settings → Business Settings → Optional features (/api/company/business-settings/module-features/)."""
    URL = '/api/company/business-settings/module-features/'

    def setUp(self):
        switch_feature(False)

    def test_platform_admin_switches_the_platform_accounts_feature(self):
        from django.contrib.auth import get_user_model
        admin = get_user_model().objects.create_superuser(username='plat_os', password='x', email='p@example.com')
        self.client.force_authenticate(admin)
        res = self.client.get(self.URL)
        self.assertEqual(res.status_code, 200, res.content)
        self.assertTrue(res.data['can_edit'])
        self.assertEqual([(f['key'], f['enabled']) for f in res.data['features']],
                         [('wholesale_order_status', False), ('bill_settlement', True)])
        res = self.client.patch(self.URL, {'wholesale_order_status': True}, format='json')
        self.assertEqual(res.status_code, 200, res.content)
        self.assertTrue(res.data['features'][0]['enabled'])
        self.assertTrue(module_access.tenant_has_feature('wholesale_order_status', 1))
        self.assertIn('wholesale_order_status', self.client.get('/api/auth/profile/').data['module_features'])
        self.assertEqual(self.client.patch(self.URL, {'nope': True}, format='json').status_code, 400)

    def test_ordinary_admin_cannot_switch_it(self):
        from django.contrib.auth import get_user_model
        user = get_user_model().objects.create_user(username='shop_admin_os', password='x', role='ADMINISTRATOR')
        self.client.force_authenticate(user)
        res = self.client.get(self.URL)
        self.assertEqual(res.status_code, 200, res.content)
        self.assertFalse(res.data['can_edit'])
        self.assertEqual(self.client.patch(self.URL, {'wholesale_order_status': True}, format='json').status_code, 403)
        self.assertFalse(module_access.tenant_has_feature('wholesale_order_status', 1))
