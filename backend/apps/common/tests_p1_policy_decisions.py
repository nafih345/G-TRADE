"""P1 final verification — the approved policy decisions (P1_FINAL_RELEASE_READINESS.md §2).

Decision 1: a user with no branch assignment is denied branch-scoped access in Multi-Branch mode;
            only explicitly unrestricted users (admin role or an all-branches access row) see
            every branch. Single-branch mode is unchanged.
Decision 2: Stock Overview quantities (grid, status, ordering, summary, export, lifecycle columns,
            adjustments) and history follow the user's permitted branches.

Fixture (P1Fixture): tenant "Client A", Multi-Branch ON, branches HO (default) and North; a
product with 10 units in HO. mona (Manager) and nina (Accountant) are North-only.
"""
import csv
import io
import os
import subprocess
import sys
from unittest import mock

from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.test import SimpleTestCase

from apps.common.tests_p1_completion import D, PW, TODAY, P1Fixture, ids, rows


class UnassignedUserFailClosedTests(P1Fixture):
    """Decision 1."""

    def setUp(self):
        super().setUp()
        User = get_user_model()
        self.u_ursula = User.objects.create_user('ursula', password=PW, role='MANAGER', tenant=self.ta)
        cache.clear()
        self.ursula = self.login('ursula')

    def test_branch_context_offers_no_branch(self):
        res = self.ursula.get('/api/company/branch-context/')
        self.assertEqual(res.status_code, 200, res.data)
        self.assertTrue(res.data['multi_branch_enabled'])
        self.assertTrue(res.data['no_branch_access'])
        self.assertEqual(res.data['branches'], [])
        self.assertIsNone(res.data['active_branch'])   # never the client's default branch
        self.assertFalse(self.mona.get('/api/company/branch-context/').data['no_branch_access'])

    def test_sees_no_branch_scoped_records_and_cannot_create(self):
        from apps.sales.models import Dealer, WholesaleInvoice
        with self.in_a():
            dealer = Dealer.objects.create(business_name='D', dealer_code='DD', phone='3')
            for n, b in (('U-HO', self.ho), ('U-N', self.north), ('U-X', None)):
                WholesaleInvoice.objects.create(invoice_number=n, dealer=dealer, branch=b, invoice_date=TODAY,
                                                due_date=TODAY, grand_total=D('1'))
        self.assertEqual(ids(self.ursula.get('/api/sales/wholesale/invoices/')), set())
        # The admin's working view (HO + Unassigned) is not empty.
        self.assertEqual(len(ids(self.admin.get('/api/sales/wholesale/invoices/'))), 2)
        res = self.ursula.post('/api/sales/eye-examinations/', {'patient_name': 'X', 'patient_id': 'P-U1'},
                               format='json')
        self.assertIn(res.status_code, (400, 403), res.data)
        # Asking for a branch explicitly does not help.
        res = self.ursula.get('/api/sales/wholesale/invoices/', HTTP_X_BRANCH_ID=str(self.ho.pk))
        self.assertEqual(res.status_code, 403)

    def test_company_wide_accounting_tools_refused(self):
        self.assertEqual(self.ursula.get('/api/financial/integration/failures/').status_code, 403)

    def test_stock_overview_shows_no_quantity_and_no_history(self):
        from apps.inventory.stock_utils import adjust_branch_stock
        with self.in_a():
            adjust_branch_stock(self.product, self.ho, 1, ledger={'transaction_type': 'IN', 'notes': 'ho'})
        res = self.ursula.get('/api/inventory/stock-overview/')
        self.assertEqual(res.status_code, 200, res.data)
        row = next(r for r in rows(res.data) if r['id'] == str(self.product.pk))
        self.assertEqual(row['stock'], 0)
        hist = self.ursula.get(f'/api/inventory/stock-overview/{self.product.pk}/history/')
        self.assertEqual(rows(hist.data), [])

    def test_signed_download_rule_matches(self):
        from apps.common.branch_context import user_branch_permitted
        with self.in_a():
            cache.clear()
            self.assertFalse(user_branch_permitted(self.u_ursula, self.ho.pk))
            self.assertFalse(user_branch_permitted(self.u_ursula, None))
            self.assertTrue(user_branch_permitted(self.u_mona, self.north.pk))
            self.assertFalse(user_branch_permitted(self.u_mona, self.ho.pk))

    def test_explicit_all_branches_row_is_unrestricted(self):
        from apps.company.models import UserBranchAccess
        with self.in_a():
            UserBranchAccess.objects.create(username='ursula', user=self.u_ursula, access_all_branches=True)
        cache.clear()
        ursula = self.login('ursula')
        ctx = ursula.get('/api/company/branch-context/').data
        self.assertFalse(ctx['no_branch_access'])
        self.assertEqual({b['id'] for b in ctx['branches']}, {str(self.ho.pk), str(self.north.pk)})
        row = next(r for r in rows(ursula.get('/api/inventory/stock-overview/').data) if r['id'] == str(self.product.pk))
        self.assertEqual(row['stock'], 10)

    def test_admin_role_without_row_stays_unrestricted(self):
        from apps.company.models import UserBranchAccess
        User = get_user_model()
        User.objects.create_user('adam', password=PW, role='ADMINISTRATOR', tenant=self.ta)
        with self.in_a():
            self.assertFalse(UserBranchAccess.objects.filter(username__iexact='adam').exists())
        cache.clear()
        ctx = self.login('adam').get('/api/company/branch-context/').data
        self.assertTrue(ctx['is_admin'])
        self.assertFalse(ctx['no_branch_access'])
        self.assertEqual(len(ctx['branches']), 2)

    def test_single_branch_mode_unaffected(self):
        from apps.company.models import BusinessSettings
        with self.in_a():
            s = BusinessSettings.load()
            s.multi_branch_enabled = False
            s.save()
        cache.clear()
        ursula = self.login('ursula')
        self.assertFalse(ursula.get('/api/company/branch-context/').data['no_branch_access'])
        res = ursula.post('/api/sales/eye-examinations/', {'patient_name': 'Single', 'patient_id': 'P-U2'},
                          format='json')
        self.assertEqual(res.status_code, 201, res.data)
        row = next(r for r in rows(ursula.get('/api/inventory/stock-overview/').data) if r['id'] == str(self.product.pk))
        self.assertEqual(row['stock'], 10)


class StockOverviewBranchQuantityTests(P1Fixture):
    """Decision 2: HO holds 10, North 3; mona/nina are North-only, clienta sees every branch."""

    URL = '/api/inventory/stock-overview/'

    def setUp(self):
        super().setUp()
        from apps.inventory.stock_utils import adjust_branch_stock
        from apps.products.models import Product
        with self.in_a():
            adjust_branch_stock(self.product, self.north, 3, ledger={'transaction_type': 'IN', 'notes': 'north'})
            Product.all_objects.filter(pk=self.product.pk).update(minimum_stock=5)

    def row(self, client, **params):
        res = client.get(self.URL, params)
        self.assertEqual(res.status_code, 200, res.data)
        return next((r for r in rows(res.data) if r['id'] == str(self.product.pk)), None)

    def test_grid_quantity_and_status_follow_permitted_branches(self):
        self.assertEqual(self.product_stock(), 13)
        mine, admin = self.row(self.mona), self.row(self.admin)
        self.assertEqual((mine['stock'], mine['status']), (3, 'low'))
        self.assertEqual((admin['stock'], admin['status']), (13, 'in'))
        self.assertEqual(mine['lifecycle']['on_hand'], 3)
        self.assertEqual(mine['lifecycle']['available'], 3)
        # Status filters use the same figure.
        self.assertIsNotNone(self.row(self.mona, status='low'))
        self.assertIsNone(self.row(self.mona, status='in'))
        self.assertIsNone(self.row(self.admin, status='low'))
        self.assertIsNotNone(self.row(self.admin, status='in'))
        # Ordering by quantity works on the scoped figure.
        self.assertEqual(self.mona.get(self.URL, {'ordering': '-stock'}).status_code, 200)

    def test_summary_and_facets(self):
        mine = self.mona.get(f'{self.URL}summary/').data
        admin = self.admin.get(f'{self.URL}summary/').data
        self.assertEqual((mine['total_quantity'], mine['low_stock'], mine['quantity_scope']), (3, 1, 'branches'))
        self.assertEqual((admin['total_quantity'], admin['low_stock'], admin['quantity_scope']), (13, 0, 'company'))
        self.assertEqual(self.mona.get(f'{self.URL}facets/').data['quantity_scope'], 'branches')

    def test_lookup_and_export(self):
        found = self.mona.get(f'{self.URL}lookup/', {'code': 'FX-1'}).data['results']
        self.assertEqual(found[0]['stock'], 3)
        res = self.mona.get(f'{self.URL}export/', {'export_format': 'csv'})
        self.assertEqual(res.status_code, 200)
        table = list(csv.reader(io.StringIO(res.content.decode('utf-8-sig'))))
        col = table[0].index('On Hand (Physical)')
        self.assertEqual([r[col] for r in table[1:] if 'FX-1' in r], ['3'])

    def test_lifecycle_documents_are_branch_scoped(self):
        from apps.purchasing.models import PurchaseInvoice, PurchaseInvoiceItem, Supplier
        from apps.sales.models import Dealer, WholesaleOrder
        from apps.sales.wholesale_orders import ORDER_CONFIRMED
        with self.in_a():
            sup = Supplier.objects.create(name='Lab')
            for n, b, q in (('PI-H', self.ho, 7), ('PI-N', self.north, 2)):
                inv = PurchaseInvoice.objects.create(invoice_number=n, supplier=sup, branch=b, purchase_date=TODAY,
                                                     status='DRAFT')
                PurchaseInvoiceItem.objects.bulk_create([PurchaseInvoiceItem(
                    purchase_invoice=inv, product=self.product, quantity=D(q), purchase_rate=D('50'),
                    tenant_id=self.ta.pk)])
                PurchaseInvoice.all_objects.filter(pk=inv.pk).update(status='RECEIVED')
            dealer = Dealer.objects.create(business_name='D', dealer_code='DD', phone='3')
            WholesaleOrder.objects.create(order_number='WO-H', dealer=dealer, order_date=TODAY, branch=self.ho,
                                          status=ORDER_CONFIRMED, reserved_items={str(self.product.pk): 4})
        mine, admin = self.row(self.mona)['lifecycle'], self.row(self.admin)['lifecycle']
        self.assertEqual((mine['purchased'], mine['ordered']), (2, 0))
        self.assertEqual((admin['purchased'], admin['ordered']), (9, 4))

    def test_adjustment_counts_the_users_branch_only(self):
        url = f'{self.URL}{self.product.pk}/adjust/'
        res = self.mona.post(url, {'new_quantity': 5, 'expected_stock': 3, 'reason': 'Physical stock count'},
                             format='json', HTTP_X_BRANCH_ID=str(self.north.pk))
        self.assertEqual(res.status_code, 201, res.data)
        self.assertEqual(res.data['row']['stock'], 5)
        self.assertEqual((self.branch_stock(self.north), self.branch_stock(self.ho), self.product_stock()), (5, 10, 15))
        # The company-wide figure is not what a restricted user counts against.
        res = self.mona.post(url, {'new_quantity': 1, 'expected_stock': 15, 'reason': 'Physical stock count'},
                             format='json', HTTP_X_BRANCH_ID=str(self.north.pk))
        self.assertEqual(res.status_code, 409, res.data)
        self.assertEqual(res.data['current_stock'], 5)
        # Another branch cannot be adjusted.
        res = self.mona.post(url, {'new_quantity': 1, 'reason': 'x'}, format='json', HTTP_X_BRANCH_ID=str(self.ho.pk))
        self.assertEqual(res.status_code, 403)
        self.assertEqual(self.branch_stock(self.ho), 10)
        # Unrestricted adjustment keeps the company-wide meaning.
        res = self.admin.post(url, {'new_quantity': 20, 'expected_stock': 15, 'reason': 'Physical stock count'},
                              format='json', HTTP_X_BRANCH_ID=str(self.ho.pk))
        self.assertEqual(res.status_code, 201, res.data)
        self.assertEqual((self.branch_stock(self.ho), self.branch_stock(self.north), self.product_stock()), (15, 5, 20))

    def test_import_review_needs_every_branch(self):
        self.assertEqual(self.mona.get(f'{self.URL}import-batches/').status_code, 403)
        self.assertEqual(self.admin.get(f'{self.URL}import-batches/').status_code, 200)

    def test_single_branch_mode_shows_company_figures(self):
        from apps.company.models import BusinessSettings
        with self.in_a():
            s = BusinessSettings.load()
            s.multi_branch_enabled = False
            s.save()
        cache.clear()
        self.assertEqual(self.row(self.login('mona'))['stock'], 13)


class ProductionMigrationPolicyTests(SimpleTestCase):
    """Decision 5: production never migrates on its own."""

    BACKEND = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

    def test_boot_hook_is_off_on_a_managed_host_unless_explicitly_enabled(self):
        from apps.common import startup
        clean = {k: v for k, v in os.environ.items()
                 if k not in ('AUTO_MIGRATE', 'RENDER', 'VERCEL', 'AWS_LAMBDA_FUNCTION_NAME')}
        with mock.patch.dict(os.environ, {**clean, 'RENDER': 'true'}, clear=True):
            self.assertFalse(startup._enabled())
            with mock.patch.dict(os.environ, {'AUTO_MIGRATE': 'True'}):
                self.assertTrue(startup._enabled())     # only an explicit opt-in turns it on
        with mock.patch.dict(os.environ, clean, clear=True):
            self.assertTrue(startup._enabled())          # local / desktop default unchanged
            with mock.patch.dict(os.environ, {'AUTO_MIGRATE': 'False'}):
                self.assertFalse(startup._enabled())

    def test_run_migrations_now_honours_the_policy(self):
        from apps.common import startup
        with mock.patch.dict(os.environ, {'AUTO_MIGRATE': 'False'}), \
                mock.patch('django.core.management.call_command') as call:
            self.assertFalse(startup.run_migrations_now('test'))
            call.assert_not_called()

    def _settings_in_render_env(self, extra):
        env = {k: v for k, v in os.environ.items()
               if k not in ('DEBUG', 'AUTO_MIGRATE', 'DATABASE_URL', 'POSTGRES_URL', 'POSTGRES_URL_NON_POOLING')}
        env.update({'RENDER': '1', 'SECRET_KEY': 'x' * 50, **extra})
        code = ("import os;os.environ['DJANGO_SETTINGS_MODULE']='config.settings';"
                "from django.conf import settings as s;from apps.common import startup;"
                "d=s.DATABASES['default'];"
                "print(s.DEBUG, startup._enabled(), d['ENGINE'].rsplit('.',1)[-1], s.DATABASE_SOURCE, d['HOST'], d['NAME'])")
        return subprocess.run([sys.executable, '-c', code], env=env, capture_output=True, text=True, timeout=120,
                              cwd=self.BACKEND)

    def test_render_defaults_debug_off_no_auto_migrate_and_explicit_database(self):
        # A local config/database.json (git-ignored, absent on Render) must not decide the target.
        out = self._settings_in_render_env(
            {'DATABASE_URL': 'postgresql://u:p@ep-x.c-6.us-east-2.aws.neon.tech/neondb?sslmode=require'})
        self.assertEqual(out.stdout.split(),
                         ['False', 'False', 'postgresql', 'DATABASE_URL', 'ep-x.c-6.us-east-2.aws.neon.tech', 'neondb'],
                         out.stderr[-500:])


# =============================================================================================
# N2 — pre-P1 code must still INSERT after the P1 migrations (deploy window + code-only rollback)
# =============================================================================================
OLD_CODE_MISSING = {
    'purchasing.PurchaseInvoice': {'attachment_name': ''},
    'company.StockTransfer': {'cancel_reason': '', 'cancelled_by': '', 'dispatched_by': '', 'received_by': ''},
    'company.StockTransferItem': {'received_quantity': 0, 'returned_quantity': 0},
}
# Every other column added by a P1 migration is nullable, so old code may omit it too.
OLD_CODE_NULLABLE = {
    'purchasing.PurchaseInvoice': (),
    'company.StockTransfer': ('cancelled_at', 'dispatched_at', 'received_at', 'from_warehouse', 'to_warehouse'),
    'company.StockTransferItem': ('unit_cost',),
}


class PreP1CodeInsertCompatibilityTests(P1Fixture):
    """Code at d5379f6 does not know the 7 NOT NULL columns P1 added. Without a PostgreSQL DEFAULT
    its INSERTs fail; migrations company.0018 / purchasing.0017 keep one (Django db_default)."""

    def column_defaults(self, table):
        from django.db import connection
        with connection.cursor() as cur:
            cur.execute("SELECT column_name, column_default, is_nullable FROM information_schema.columns "
                        "WHERE table_schema = current_schema() AND table_name = %s", [table])
            return {r[0]: (r[1], r[2]) for r in cur.fetchall()}

    def test_the_seven_columns_keep_a_database_default(self):
        from django.apps import apps
        for label, cols in OLD_CODE_MISSING.items():
            model = apps.get_model(label)
            found = self.column_defaults(model._meta.db_table)
            for col, value in cols.items():
                default, nullable = found[col]
                self.assertEqual(nullable, 'NO', (label, col))
                self.assertIsNotNone(default, f'{label}.{col} has no DB default: pre-P1 INSERTs would fail')
                self.assertTrue(default.startswith("''") if value == '' else default == str(value), (label, col, default))
            for col in OLD_CODE_NULLABLE[label]:
                column = model._meta.get_field(col).column
                self.assertEqual(found[column][1], 'YES', (label, col))

    def old_style_insert(self, obj):
        """INSERT exactly the columns the pre-P1 model had (what d5379f6's ORM sends)."""
        model = type(obj)
        skip = set(OLD_CODE_MISSING[model._meta.label]) | set(OLD_CODE_NULLABLE[model._meta.label])
        fields = [f for f in model._meta.concrete_fields if f.name not in skip]
        model._base_manager._insert([obj], fields=fields)
        return model._base_manager.get(pk=obj.pk)

    def test_old_code_can_create_purchase_entries_and_transfers(self):
        from apps.company.models import StockTransfer, StockTransferItem
        from apps.purchasing.models import PurchaseInvoice, Supplier
        stock_before = self.product_stock()
        with self.in_a():
            sup = Supplier.objects.create(name='Old Code Supplier')
            inv = self.old_style_insert(PurchaseInvoice(invoice_number='PI-OLD-1', supplier=sup, branch=self.ho,
                                                        purchase_date=TODAY, status='DRAFT', tenant_id=self.ta.pk))
            self.assertEqual(inv.attachment_name, '')
            t = self.old_style_insert(StockTransfer(transfer_number='TRF-OLD-1', from_branch=self.ho,
                                                    to_branch=self.north, status='PENDING', tenant_id=self.ta.pk))
            self.assertEqual((t.dispatched_by, t.received_by, t.cancelled_by, t.cancel_reason), ('', '', '', ''))
            item = self.old_style_insert(StockTransferItem(transfer=t, product=self.product, quantity=3,
                                                           tenant_id=self.ta.pk))
            self.assertEqual((item.received_quantity, item.returned_quantity, item.unit_cost), (0, 0, None))
        # New code reads the old-code transfer as a legacy draft that moved no stock.
        res = self.admin.get(f'/api/company/stock-transfers/{t.pk}/')
        self.assertEqual(res.status_code, 200, res.data)
        self.assertEqual(res.data['status'], 'PENDING')
        self.assertEqual(self.product_stock(), stock_before)
