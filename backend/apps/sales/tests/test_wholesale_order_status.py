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


def staff_user(username='os_staff', allowed=True):
    from django.contrib.auth import get_user_model
    return get_user_model().objects.create_user(username=username, password='x', role='ADMINISTRATOR',
                                                can_use_wholesale_order_status=allowed)


class OrderStatusFlowTests(APITestCase):
    def setUp(self):
        switch_feature(True)
        self.client.force_authenticate(staff_user())
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

    def test_stored_off_switch_is_ignored_it_is_built_in(self):
        """Built into Wholesale: a stored "off" (older consoles) changes nothing."""
        switch_feature(False)
        self.assertEqual(self.client.get(f'{STATUS}dealers/').status_code, 200)
        inv = self._bill(self._order())
        self.assertEqual((inv.delivery_status, inv.is_posted_to_accounts), ('PENDING_DELIVERY', False))

    def test_user_without_the_permission_is_refused(self):
        self.client.force_authenticate(staff_user('os_blocked', allowed=False))
        for res in (self.client.get(f'{STATUS}dealers/'),
                    self.client.post(f'{STATUS}00000000-0000-0000-0000-000000000000/deliver/')):
            self.assertEqual(res.status_code, 403)
            self.assertEqual(res.data['code'], 'feature_not_permitted')
        self.assertNotIn('wholesale_order_status', self.client.get('/api/auth/profile/').data['module_features'])
        self.client.force_authenticate(None)
        self.assertEqual(self.client.get(f'{STATUS}dealers/').status_code, 401)


class ModuleFeatureRulesTests(APITestCase):
    def test_built_in_features_follow_their_module_only(self):
        for stored in ({'wholesale_order_status': False, 'bill_settlement': False}, {}, None):
            cfg = {'modules': ['wholesale', 'accounts'], 'module_features': stored}
            self.assertEqual(module_access.enabled_module_features(cfg), ['wholesale_order_status', 'bill_settlement'])
        self.assertEqual(module_access.enabled_module_features({'modules': ['sales'], 'module_features': {}}), [])
        self.assertEqual(module_access.enabled_module_features({'modules': ['financial'], 'module_features': {}}),
                         ['bill_settlement'])

    def test_every_business_has_them_on(self):
        from apps.common import tenancy
        from apps.common.models import Tenant
        Tenant.objects.filter(pk=tenancy.DEFAULT_TENANT_ID).update(module_features={})
        self.assertTrue(module_access.tenant_has_feature('wholesale_order_status', tenancy.DEFAULT_TENANT_ID))
        self.assertTrue(module_access.tenant_has_feature('bill_settlement', tenancy.DEFAULT_TENANT_ID))

    def test_normalize_keeps_built_in_on_and_refuses_unknown_keys(self):
        self.assertEqual(module_access.normalize_module_features({'wholesale_order_status': 0}), {'wholesale_order_status': True})
        with self.assertRaises(ValueError):
            module_access.normalize_module_features({'nope': True})
        with self.assertRaises(ValueError):
            module_access.normalize_module_features(['wholesale_order_status'])

    def test_consoles_have_no_switch_for_built_in_features(self):
        self.assertEqual(module_access.catalog()['module_features'], [])
        self.assertEqual([f['key'] for f in module_access.module_feature_catalog(include_fixed=True)],
                         ['wholesale_order_status', 'bill_settlement'])

    def test_migration_stores_both_on_for_existing_businesses(self):
        import importlib
        from django.apps import apps as django_apps
        from apps.common import tenancy
        from apps.common.models import Tenant
        Tenant.objects.filter(pk=tenancy.DEFAULT_TENANT_ID).update(module_features={'wholesale_order_status': False})
        importlib.import_module('apps.common.migrations.0014_builtin_module_features').switch_on(django_apps, None)
        self.assertEqual(Tenant.objects.get(pk=tenancy.DEFAULT_TENANT_ID).module_features,
                         {'wholesale_order_status': True, 'bill_settlement': True})


class UserFeaturePermissionTests(APITestCase):
    """Administration → Users: the per-user Wholesale Order Status permission."""

    def test_admin_grants_and_revokes_it(self):
        from django.contrib.auth import get_user_model
        owner = get_user_model().objects.create_user(username='os_owner', password='x', role='SUPER_ADMIN')
        self.client.force_authenticate(owner)
        res = self.client.post('/api/auth/users/', {'username': 'os_clerk', 'password': 'Clerk-Pass-2026!x',
                                                    'role': 'SALES_EXECUTIVE', 'access_all_branches': True,
                                                    'can_use_wholesale_order_status': False}, format='json')
        self.assertEqual(res.status_code, 201, res.content)
        clerk = get_user_model().objects.get(username='os_clerk')
        self.assertFalse(clerk.can_use_wholesale_order_status)
        row = next(u for u in res.data['users'] if u['username'] == 'os_clerk')
        self.assertFalse(row['can_use_wholesale_order_status'])
        res = self.client.patch(f'/api/auth/users/{clerk.pk}/', {'can_use_wholesale_order_status': True}, format='json')
        self.assertEqual(res.status_code, 200, res.content)
        clerk.refresh_from_db()
        self.assertTrue(clerk.can_use_wholesale_order_status)
