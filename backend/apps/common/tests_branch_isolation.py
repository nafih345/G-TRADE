"""Branch authorization across every branch-scoped module (P1 Task 2: B-4 and N4).

Every request goes through the real stack (/api/auth/login/ → signed JWT → TenantContextMiddleware
→ BranchContextMiddleware → DRF) with TENANCY_ANONYMOUS_TENANT_ID off, as in production. Branch
identity therefore comes from the token, never from X-User-* headers.

Fixture (tenant "Client A", Multi-Branch ON), branches HO (default) and North:
    one document per module in HO, one in North, and (where the model allows it) one with no branch.
Tenant "Client B" has its own branch and documents.

Users: clienta (Super Admin, every branch) · mona (Manager, North only) ·
       nemo (Manager, North only, but UserBranchAccess.default_branch left empty).

Rules under test:
  * Reads: a restricted user sees only their branch's rows. Another branch's row (and an
    unassigned one, P1-Q2) answers 404, exactly like a row that does not exist.
  * Writes: a client-supplied branch (or a warehouse / parent document that belongs to a branch)
    outside the caller's branches answers 403 and writes nothing. A missing branch is stamped
    from the caller's active branch, never left to the client.
  * Unrestricted users and single-branch installs behave as before.
"""
import datetime
from decimal import Decimal

from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.test import TestCase, override_settings
from rest_framework.test import APIClient

from apps.common import tenancy
from apps.common.tenant_onboarding import onboard_tenant

PW = 'Str0ng-pass-123'
D = Decimal
TODAY = datetime.date(2026, 1, 10)


def rows(data):
    if isinstance(data, dict):
        for key in ('results', 'rows'):
            if key in data:
                return data[key]
    return data


def ids(res):
    return {str(r['id']) for r in rows(res.data)}


@override_settings(TENANCY_ANONYMOUS_TENANT_ID=None)
class BranchIsolationFixture(TestCase):
    def setUp(self):
        cache.clear()
        self.addCleanup(cache.clear)
        User = get_user_model()
        self.ta, _ = onboard_tenant(name='Client A', admin_username='clienta', password=PW)
        self.tb, _ = onboard_tenant(name='Client B', admin_username='clientb', password=PW)
        User.objects.create_user('mona', password=PW, role='MANAGER', tenant=self.ta)
        User.objects.create_user('nemo', password=PW, role='MANAGER', tenant=self.ta)

        from apps.company.models import Branch, BusinessSettings, UserBranchAccess, Warehouse
        with tenancy.use_tenant(self.ta.pk):
            self.ho = Branch.objects.get(is_default=True)
            self.north = Branch.objects.create(company=self.ho.company, name='North', code='NTH', is_active=True)
            self.ho_wh = Warehouse.objects.filter(branch=self.ho).first() or \
                Warehouse.objects.create(branch=self.ho, name='HO Store', code='HOW')
            self.north_wh = Warehouse.objects.create(branch=self.north, name='North Store', code='NTW')
            settings_obj = BusinessSettings.load()
            settings_obj.multi_branch_enabled = True
            settings_obj.save()
            UserBranchAccess.objects.create(username='mona', default_branch=self.north).branches.set([self.north])
            UserBranchAccess.objects.create(username='nemo', default_branch=None).branches.set([self.north])
            self._build_documents()
        with tenancy.use_tenant(self.tb.pk):
            self.tb_branch = Branch.objects.get(is_default=True)
            self.tb_wh = Warehouse.objects.filter(branch=self.tb_branch).first() or \
                Warehouse.objects.create(branch=self.tb_branch, name='B Store', code='BW')
            self.tb_supplier = self._supplier('B Supplier')
            self.tb_invoice = self._invoice('B-INV-1', self.tb_branch)

        self.admin = self.login('clienta')
        self.mona = self.login('mona')
        self.nemo = self.login('nemo')
        self.b_admin = self.login('clientb')

    # ---- fixture builders (ORM, inside the tenant) ------------------------------------------

    def _supplier(self, name):
        from apps.purchasing.models import Supplier
        return Supplier.objects.create(name=name)

    def _invoice(self, number, branch, **extra):
        from apps.sales.models import Invoice
        return Invoice.objects.create(invoice_number=number, branch=branch, invoice_date=TODAY,
                                      customer_name='Walk In', document_type='ORDER', status='UNPAID',
                                      total_amount=D('100'), net_amount=D('100'), **extra)

    def _build_documents(self):
        from apps.company.models import StockTransfer
        from apps.inventory.models import StockAdjustment, StockLedger
        from apps.products.models import Product
        from apps.purchasing.lens_orders import LensPurchaseOrder
        from apps.purchasing.models import PurchaseInvoice, PurchaseOrder
        from apps.sales.models import Payment

        self.supplier = self._supplier('Lens Lab')
        self.product = Product.objects.create(name='Test Frame', sku='TF-1', stock=0)
        self.inv = {k: self._invoice(f'ORD-{k}', b) for k, b in (('ho', self.ho), ('north', self.north), ('none', None))}
        self.pay = {k: Payment.objects.create(receipt_no=f'RCP-{k}', branch=b, amount=D('10'), payment_date=TODAY,
                                              customer_name='Walk In')
                    for k, b in (('ho', self.ho), ('north', self.north), ('none', None))}
        self.po = {k: PurchaseOrder.objects.create(order_number=f'PO-{k}', supplier=self.supplier, branch=b,
                                                   order_date=TODAY, status='DRAFT')
                   for k, b in (('ho', self.ho), ('north', self.north), ('none', None))}
        self.pinv = {k: PurchaseInvoice.objects.create(invoice_number=f'PI-{k}', supplier=self.supplier, branch=b,
                                                       purchase_date=TODAY, status='DRAFT')
                     for k, b in (('ho', self.ho), ('north', self.north), ('none', None))}
        self.lpo = {k: LensPurchaseOrder.objects.create(po_number=f'LPO-{k}', supplier=self.supplier, branch=b,
                                                        order_date=TODAY, status='DRAFT')
                    for k, b in (('ho', self.ho), ('north', self.north), ('none', None))}
        self.adj = {k: StockAdjustment.objects.create(product=self.product, warehouse=w, branch=b, quantity=1,
                                                      adjustment_type='ADD', reason=f'count {k}')
                    for k, b, w in (('ho', self.ho, self.ho_wh), ('north', self.north, self.north_wh))}
        self.ledger = {k: StockLedger.objects.create(product=self.product, warehouse=w, branch=b, quantity=1,
                                                     transaction_type='IN', notes=f'ledger {k}')
                       for k, b, w in (('ho', self.ho, self.ho_wh), ('north', self.north, self.north_wh))}
        self.transfer = {
            'ho_out': StockTransfer.objects.create(transfer_number='TRF-HO', from_branch=self.ho, to_branch=self.ho),
            'north_out': StockTransfer.objects.create(transfer_number='TRF-N', from_branch=self.north, to_branch=self.ho),
            'north_in': StockTransfer.objects.create(transfer_number='TRF-IN', from_branch=self.ho, to_branch=self.north),
        }

    # ---- helpers -----------------------------------------------------------------------------

    def login(self, username):
        client = APIClient()
        res = client.post('/api/auth/login/', {'username': username, 'password': PW}, format='json')
        self.assertEqual(res.status_code, 200, res.content)
        client.credentials(HTTP_AUTHORIZATION=f"Bearer {res.data['access']}")
        client.post('/api/security/reauth/', {'password': PW}, format='json')
        return client

    def fresh(self, obj):
        with tenancy.use_tenant(self.ta.pk):
            return type(obj).all_objects.get(pk=obj.pk)

    def count(self, model, **filters):
        with tenancy.use_tenant(self.ta.pk):
            return model.all_objects.filter(**filters).count()

    def set_multi_branch(self, on):
        from apps.company.models import BusinessSettings
        with tenancy.use_tenant(self.ta.pk):
            settings_obj = BusinessSettings.load()
            settings_obj.multi_branch_enabled = on
            settings_obj.save()
        cache.clear()


# The branch-scoped document viewsets that share BranchScopedViewSetMixin:
# (name, list URL, fixture attribute, updatable field for a harmless PATCH)
SCOPED = (
    ('sales invoices', '/api/sales/invoices/', 'inv', {'notes': 'x'}),
    ('payments', '/api/sales/payments/', 'pay', {'notes': 'x'}),
    ('purchase orders', '/api/purchase/orders/', 'po', {'status': 'SENT'}),
    ('purchase invoices', '/api/purchase/invoices/', 'pinv', {'notes': 'x'}),
    ('lens purchase orders', '/api/purchase/lens-orders/', 'lpo', {'remarks': 'x'}),
    ('stock adjustments', '/api/inventory/adjustments/', 'adj', {'reason': 'x'}),
    ('stock ledger', '/api/inventory/ledger/', 'ledger', None),
)


class UrlSanity(BranchIsolationFixture):
    def test_scoped_urls_exist(self):
        for name, url, _attr, _patch in SCOPED:
            with self.subTest(name=name):
                self.assertEqual(self.admin.get(url).status_code, 200, url)


# ---------------------------------------------------------------------------------------------
# Reads: list + retrieve
# ---------------------------------------------------------------------------------------------

class ScopedReadTests(BranchIsolationFixture):
    def test_restricted_list_shows_only_own_branch(self):
        for name, url, attr, _patch in SCOPED:
            docs = getattr(self, attr)
            with self.subTest(name=name):
                self.assertEqual(ids(self.mona.get(url)), {str(docs['north'].pk)})

    def test_restricted_detail_of_other_branch_or_unassigned_is_404(self):
        for name, url, attr, _patch in SCOPED:
            docs = getattr(self, attr)
            with self.subTest(name=name):
                self.assertEqual(self.mona.get(f"{url}{docs['north'].pk}/").status_code, 200)
                self.assertEqual(self.mona.get(f"{url}{docs['ho'].pk}/").status_code, 404)
                if 'none' in docs:
                    self.assertEqual(self.mona.get(f"{url}{docs['none'].pk}/").status_code, 404)

    def test_restricted_user_cannot_widen_scope_by_parameter_or_header(self):
        for name, url, attr, _patch in SCOPED:
            with self.subTest(name=name):
                self.assertEqual(rows(self.mona.get(url, {'branch': str(self.ho.pk)}).data), [])
                self.assertNotIn(str(getattr(self, attr)['ho'].pk), ids(self.mona.get(url, {'branches': 'all'})))
                self.assertEqual(self.mona.get(url, HTTP_X_BRANCH_ID=str(self.ho.pk)).status_code, 403)

    def test_missing_default_branch_falls_back_inside_permitted_branches(self):
        """nemo has North only but no default branch. The tenant's default (HO) must not become
        his working branch: he sees North, never HO or unassigned rows."""
        for name, url, attr, _patch in SCOPED:
            docs = getattr(self, attr)
            with self.subTest(name=name):
                self.assertEqual(ids(self.nemo.get(url)), {str(docs['north'].pk)})
                self.assertEqual(self.nemo.get(f"{url}{docs['ho'].pk}/").status_code, 404)

    def test_restricted_user_with_no_branches_sees_nothing(self):
        from apps.company.models import UserBranchAccess
        with tenancy.use_tenant(self.ta.pk):
            UserBranchAccess.objects.get(username='nemo').branches.clear()
        cache.clear()
        for name, url, _attr, _patch in SCOPED:
            with self.subTest(name=name):
                self.assertEqual(rows(self.nemo.get(url).data), [])

    def test_admin_sees_all_branches_including_unassigned_with_branches_all(self):
        for name, url, attr, _patch in SCOPED:
            with self.subTest(name=name):
                self.assertEqual(ids(self.admin.get(url, {'branches': 'all'})),
                                 {str(d.pk) for d in getattr(self, attr).values()})
                self.assertEqual(self.admin.get(f"{url}{getattr(self, attr)['north'].pk}/",
                                                HTTP_X_BRANCH_ID=str(self.north.pk)).status_code, 200)

    def test_branch_stock_is_branch_restricted(self):
        from apps.company.models import BranchStock
        with tenancy.use_tenant(self.ta.pk):
            ho_row = BranchStock.objects.create(product=self.product, branch=self.ho, quantity=5)
            north_row = BranchStock.objects.create(product=self.product, branch=self.north, quantity=2)
        url = '/api/company/branch-stock/'
        self.assertEqual(ids(self.mona.get(url)), {str(north_row.pk)})
        self.assertEqual(self.mona.get(url, {'branch': str(self.ho.pk)}).status_code, 403)
        self.assertEqual(self.mona.get(f'{url}{ho_row.pk}/').status_code, 404)
        self.assertEqual(ids(self.admin.get(url)), {str(ho_row.pk), str(north_row.pk)})

    def test_stock_transfers_visible_only_when_a_side_is_permitted(self):
        url = '/api/company/stock-transfers/'
        t = self.transfer
        self.assertEqual(ids(self.mona.get(url)), {str(t['north_out'].pk), str(t['north_in'].pk)})
        self.assertEqual(self.mona.get(f"{url}{t['ho_out'].pk}/").status_code, 404)
        self.assertEqual(ids(self.admin.get(url)), {str(x.pk) for x in t.values()})


# ---------------------------------------------------------------------------------------------
# Writes: create
# ---------------------------------------------------------------------------------------------

class ScopedCreateTests(BranchIsolationFixture):
    def sale(self, **extra):
        return {'document_type': 'QUOTATION', 'invoice_date': '2026-01-10', 'status': 'DRAFT',
                'total_amount': 50, 'net_amount': 50, 'paid_amount': 0, 'customer_name': 'Walk In',
                'items': [{'product': None, 'item_type': 'PRODUCT', 'description': 'Fitting', 'quantity': 1,
                           'unit_price': 50, 'tax_rate': 0, 'tax_amount': 0, 'subtotal': 50}], **extra}

    def payloads(self):
        """(name, url, model, valid payload without a branch)"""
        from apps.inventory.models import StockAdjustment
        from apps.purchasing.lens_orders import LensPurchaseOrder
        from apps.purchasing.models import PurchaseOrder
        from apps.sales.models import Invoice, Payment
        return (
            ('sales invoice', '/api/sales/invoices/', Invoice, self.sale()),
            ('payment', '/api/sales/payments/', Payment,
             {'amount': '5', 'payment_date': '2026-01-10', 'customer_name': 'Walk In', 'method': 'Cash'}),
            ('purchase order', '/api/purchase/orders/', PurchaseOrder,
             {'order_number': 'PO-NEW', 'supplier': str(self.supplier.pk), 'order_date': '2026-01-10',
              'status': 'DRAFT'}),
            ('lens purchase order', '/api/purchase/lens-orders/', LensPurchaseOrder,
             {'supplier': str(self.supplier.pk), 'order_date': '2026-01-10', 'status': 'DRAFT'}),
            ('stock adjustment', '/api/inventory/adjustments/', StockAdjustment,
             {'product': str(self.product.pk), 'quantity': 1, 'adjustment_type': 'ADD', 'reason': 'recount'}),
        )

    def test_unauthorized_branch_on_create_is_403_and_saves_nothing(self):
        for name, url, model, body in self.payloads():
            with self.subTest(name=name):
                before = self.count(model)
                res = self.mona.post(url, {**body, 'branch': str(self.ho.pk)}, format='json')
                self.assertEqual(res.status_code, 403, f'{name}: {res.status_code} {res.data}')
                self.assertEqual(self.count(model), before)

    def test_create_without_branch_is_stamped_with_the_permitted_branch(self):
        for name, url, model, body in self.payloads():
            for client in (self.mona, self.nemo):
                with self.subTest(name=name, user=client is self.mona and 'mona' or 'nemo'):
                    res = client.post(url, body if model.__name__ != 'PurchaseOrder'
                                      else {**body, 'order_number': f"PO-{id(client)}"}, format='json')
                    self.assertIn(res.status_code, (200, 201), f'{name}: {res.data}')
                    with tenancy.use_tenant(self.ta.pk):
                        self.assertEqual(model.all_objects.get(pk=res.data['id']).branch_id, self.north.pk)

    def test_own_branch_explicitly_is_accepted(self):
        for name, url, model, body in self.payloads()[:1]:
            res = self.mona.post(url, {**body, 'branch': str(self.north.pk)}, format='json')
            self.assertEqual(res.status_code, 201, res.data)

    def test_admin_may_create_in_any_branch(self):
        for name, url, model, body in self.payloads():
            with self.subTest(name=name):
                if model.__name__ == 'PurchaseOrder':
                    body = {**body, 'order_number': 'PO-ADMIN'}
                res = self.admin.post(url, {**body, 'branch': str(self.north.pk)}, format='json')
                self.assertIn(res.status_code, (200, 201), f'{name}: {res.data}')
                # Lens POs never take a branch from the client (read-only field): the server stamps
                # the admin's working branch (HO). Everywhere else an admin may pick a branch.
                expected = self.ho.pk if name == 'lens purchase order' else self.north.pk
                with tenancy.use_tenant(self.ta.pk):
                    self.assertEqual(model.all_objects.get(pk=res.data['id']).branch_id, expected)

    def test_cross_tenant_branch_id_is_rejected(self):
        for name, url, model, body in self.payloads():
            with self.subTest(name=name):
                before = self.count(model)
                for client in (self.admin, self.mona):
                    res = client.post(url, {**body, 'branch': str(self.tb_branch.pk)}, format='json')
                    self.assertIn(res.status_code, (400, 403), f'{name}: {res.status_code} {res.data}')
                self.assertEqual(self.count(model), before)

    def test_unknown_branch_id_is_rejected(self):
        from apps.sales.models import Invoice
        before = self.count(Invoice)
        res = self.admin.post('/api/sales/invoices/', self.sale(branch='00000000-0000-0000-0000-000000000000'),
                              format='json')
        self.assertEqual(res.status_code, 400, res.data)
        self.assertEqual(self.count(Invoice), before)

    def test_warehouse_of_another_branch_is_rejected(self):
        from apps.inventory.models import StockAdjustment
        before = self.count(StockAdjustment)
        res = self.mona.post('/api/inventory/adjustments/',
                             {'product': str(self.product.pk), 'quantity': 1, 'adjustment_type': 'ADD',
                              'reason': 'recount', 'warehouse': str(self.ho_wh.pk)}, format='json')
        self.assertEqual(res.status_code, 403, res.data)
        self.assertEqual(self.count(StockAdjustment), before)
        res = self.mona.post('/api/inventory/adjustments/',
                             {'product': str(self.product.pk), 'quantity': 1, 'adjustment_type': 'ADD',
                              'reason': 'recount', 'warehouse': str(self.north_wh.pk)}, format='json')
        self.assertEqual(res.status_code, 201, res.data)

    def test_payment_against_another_branchs_bill_is_rejected(self):
        from apps.sales.models import Payment
        before = self.count(Payment)
        for target in ('ho', 'none'):
            res = self.mona.post('/api/sales/payments/', {
                'amount': '5', 'payment_date': '2026-01-10', 'customer_name': 'Walk In', 'method': 'Cash',
                'invoice': str(self.inv[target].pk)}, format='json')
            self.assertEqual(res.status_code, 403, res.data)
        self.assertEqual(self.count(Payment), before)
        self.assertEqual(self.fresh(self.inv['ho']).paid_amount, D('0'))

    def test_stock_transfer_needs_the_origin_branch(self):
        from apps.company.models import StockTransfer
        url = '/api/company/stock-transfers/'
        before = self.count(StockTransfer)
        body = {'items': [{'product': str(self.product.pk), 'quantity': 1}]}
        res = self.mona.post(url, {**body, 'from_branch': str(self.ho.pk), 'to_branch': str(self.north.pk)},
                             format='json')
        self.assertEqual(res.status_code, 403, res.data)
        self.assertEqual(self.count(StockTransfer), before)
        res = self.mona.post(url, {**body, 'from_branch': str(self.north.pk), 'to_branch': str(self.ho.pk)},
                             format='json')
        self.assertEqual(res.status_code, 201, res.data)
        res = self.mona.post(url, {**body, 'from_branch': str(self.north.pk), 'to_branch': str(self.tb_branch.pk)},
                             format='json')
        self.assertEqual(res.status_code, 400, res.data)


# ---------------------------------------------------------------------------------------------
# Writes: update + delete
# ---------------------------------------------------------------------------------------------

class ScopedUpdateDeleteTests(BranchIsolationFixture):
    def test_update_of_another_branchs_row_is_404_and_changes_nothing(self):
        for name, url, attr, patch in SCOPED:
            if patch is None:
                continue
            doc = getattr(self, attr)['ho']
            with self.subTest(name=name):
                before = self.fresh(doc).updated_at
                self.assertEqual(self.mona.patch(f'{url}{doc.pk}/', patch, format='json').status_code, 404)
                self.assertEqual(self.fresh(doc).updated_at, before)

    def test_moving_a_row_to_another_branch_is_403(self):
        for name, url, attr, patch in SCOPED:
            if patch is None:
                continue
            doc = getattr(self, attr)['north']
            with self.subTest(name=name):
                res = self.mona.patch(f'{url}{doc.pk}/', {'branch': str(self.ho.pk)}, format='json')
                self.assertEqual(res.status_code, 403, f'{name}: {res.status_code} {res.data}')
                self.assertEqual(self.fresh(doc).branch_id, self.north.pk)
                res = self.mona.patch(f'{url}{doc.pk}/', {'branch': None}, format='json')
                self.assertEqual(res.status_code, 403, f'{name} (unassign): {res.status_code} {res.data}')
                self.assertEqual(self.fresh(doc).branch_id, self.north.pk)

    def test_authorized_update_still_works(self):
        for name, url, attr, patch in SCOPED:
            if patch is None:
                continue
            doc = getattr(self, attr)['north']
            with self.subTest(name=name):
                res = self.mona.patch(f'{url}{doc.pk}/', patch, format='json')
                self.assertEqual(res.status_code, 200, f'{name}: {res.data}')
                self.assertEqual(self.fresh(doc).branch_id, self.north.pk)

    def test_admin_may_move_a_row_between_branches(self):
        doc = self.po['north']
        res = self.admin.patch(f'/api/purchase/orders/{doc.pk}/', {'branch': str(self.ho.pk)}, format='json',
                               HTTP_X_BRANCH_ID=str(self.north.pk))
        self.assertEqual(res.status_code, 200, res.data)
        self.assertEqual(self.fresh(doc).branch_id, self.ho.pk)

    def test_delete_of_another_branchs_or_unassigned_row_is_404(self):
        for name, url, attr, patch in SCOPED:
            if patch is None:
                continue
            docs = getattr(self, attr)
            for key in ('ho', 'none'):
                if key not in docs:
                    continue
                with self.subTest(name=name, row=key):
                    self.assertEqual(self.mona.delete(f'{url}{docs[key].pk}/').status_code, 404)
                    self.assertFalse(self.fresh(docs[key]).is_deleted)

    def test_stock_transfer_update_and_delete_need_the_origin_branch(self):
        url = '/api/company/stock-transfers/'
        incoming = self.transfer['north_in']        # HO → North: visible, but not hers to change
        self.assertEqual(self.mona.patch(f'{url}{incoming.pk}/', {'notes': 'x'}, format='json').status_code, 403)
        self.assertEqual(self.mona.delete(f'{url}{incoming.pk}/').status_code, 403)
        self.assertFalse(self.fresh(incoming).is_deleted)
        own = self.transfer['north_out']
        res = self.mona.patch(f'{url}{own.pk}/', {'from_branch': str(self.ho.pk)}, format='json')
        self.assertEqual(res.status_code, 403, res.data)
        self.assertEqual(self.fresh(own).from_branch_id, self.north.pk)
        self.assertEqual(self.mona.patch(f'{url}{own.pk}/', {'notes': 'ok'}, format='json').status_code, 200)

    def test_document_action_on_another_branch_is_404(self):
        res = self.mona.post(f"/api/sales/invoices/{self.inv['ho'].pk}/convert/", {'document_type': 'QUOTATION'},
                             format='json')
        self.assertEqual(res.status_code, 404)
        self.assertEqual(self.fresh(self.inv['ho']).document_type, 'ORDER')
        res = self.mona.post(f"/api/purchase/lens-orders/{self.lpo['ho'].pk}/cancel/", {}, format='json')
        self.assertEqual(res.status_code, 404)
        self.assertEqual(self.fresh(self.lpo['ho']).status, 'DRAFT')


# ---------------------------------------------------------------------------------------------
# Returns: the original bill must be one the caller may use
# ---------------------------------------------------------------------------------------------

class ReturnBranchTests(BranchIsolationFixture):
    def setUp(self):
        super().setUp()
        from apps.sales.models import InvoiceItem
        with tenancy.use_tenant(self.ta.pk):
            for key in ('ho', 'north'):
                inv = self.inv[key]
                inv.document_type, inv.status = 'INVOICE', 'PAID'
                inv.save()
                InvoiceItem.objects.create(invoice=inv, product=self.product, description='Test Frame', quantity=1,
                                           unit_price=D('100'), subtotal=D('100'))

    def test_return_against_another_branchs_bill_is_refused(self):
        from apps.sales.models import SalesReturn
        res = self.mona.post('/api/sales/returns/', {
            'original_document': str(self.inv['ho'].pk), 'return_date': '2026-01-10', 'payment_mode': 'CASH',
            'reason': 'DAMAGED', 'items': [{'product': str(self.product.pk), 'quantity': 1, 'rate': 100}],
        }, format='json')
        self.assertIn(res.status_code, (403, 404), res.data)
        self.assertEqual(self.count(SalesReturn), 0)

    def test_return_lookups_hide_other_branches_bills(self):
        url = '/api/sales/returns/'
        found = {r['id'] for r in self.mona.get(f'{url}source-documents/').data}
        self.assertIn(str(self.inv['north'].pk), found)
        self.assertNotIn(str(self.inv['ho'].pk), found)
        self.assertEqual(self.mona.get(f'{url}returnable/', {'document': str(self.inv['ho'].pk)}).status_code, 404)
        self.assertEqual(self.mona.get(f'{url}returnable/', {'document': str(self.inv['north'].pk)}).status_code, 200)
        found = {r['id'] for r in self.admin.get(f'{url}source-documents/').data}
        self.assertTrue({str(self.inv['ho'].pk), str(self.inv['north'].pk)} <= found)


# ---------------------------------------------------------------------------------------------
# Wholesale stock location (N5): the POS warehouse must be in a permitted branch
# ---------------------------------------------------------------------------------------------

class WholesaleWarehouseTests(BranchIsolationFixture):
    def bill(self, client, warehouse, number):
        res = client.post('/api/sales/wholesale/dealers/', {'dealer_code': f'DL-{number}', 'business_name': 'D',
                                                           'phone': f'99999{number:05d}'}, format='json')
        self.assertEqual(res.status_code, 201, res.content)
        return client.post('/api/sales/wholesale/invoices/', {
            'invoice_number': f'WINV-{number}', 'dealer': res.data['id'], 'invoice_date': '2026-01-10',
            'due_date': '2026-01-20', 'grand_total': 100, 'paid_amount': 0, 'due_amount': 100, 'status': 'Partial',
            'override_negative_stock': True,
            'details': {'items': [{'id': str(self.product.pk), 'qty': 1, 'rate': 100}], 'orderStatus': 'Confirmed',
                        'warehouseId': str(warehouse.pk)}}, format='json')

    def test_wholesale_sale_from_another_branchs_warehouse_is_refused(self):
        from apps.inventory.models import StockAdjustment
        from apps.sales.models import WholesaleInvoice
        before = (self.count(WholesaleInvoice), self.count(StockAdjustment))
        res = self.bill(self.mona, self.ho_wh, 1)
        self.assertEqual(res.status_code, 403, res.data)
        self.assertEqual((self.count(WholesaleInvoice), self.count(StockAdjustment)), before)

    def test_wholesale_sale_from_own_warehouse_works(self):
        from apps.sales.models import WholesaleInvoice
        res = self.bill(self.mona, self.north_wh, 2)
        self.assertEqual(res.status_code, 201, res.data)
        with tenancy.use_tenant(self.ta.pk):
            applied = WholesaleInvoice.all_objects.get(pk=res.data['id']).stock_applied
        self.assertEqual(applied['branch'], str(self.north.pk))
        self.assertEqual(applied['warehouse'], str(self.north_wh.pk))

    def test_admin_may_use_any_warehouse(self):
        res = self.bill(self.admin, self.ho_wh, 3)
        self.assertEqual(res.status_code, 201, res.data)


# ---------------------------------------------------------------------------------------------
# B-4 — voucher creation
# ---------------------------------------------------------------------------------------------

class VoucherCreateBranchTests(BranchIsolationFixture):
    F = '/api/financial/journals/'

    def body(self, **extra):
        return {'voucher_type_code': 'RV', 'date': '2026-01-10', 'status': 'POSTED', 'narration': 'Receipt',
                'lines': [{'account': '1001', 'debit': '25'}, {'account': '4001', 'credit': '25'}], **extra}

    def journals(self):
        from apps.financial.models import JournalEntry
        return self.count(JournalEntry)

    def login(self, username):
        client = super().login(username)
        return client

    def setUp(self):
        super().setUp()
        User = get_user_model()
        User.objects.create_user('nina', password=PW, role='ACCOUNTANT', tenant=self.ta)
        from apps.company.models import UserBranchAccess
        with tenancy.use_tenant(self.ta.pk):
            UserBranchAccess.objects.create(username='nina', default_branch=self.north).branches.set([self.north])
        cache.clear()
        self.nina = self.login('nina')

    def test_voucher_into_another_branch_is_403_and_writes_nothing(self):
        from apps.financial.models import JournalEntry
        before = self.journals()
        key = 'idem-b4-1'
        with self.captureOnCommitCallbacks(execute=True):
            res = self.nina.post(self.F, self.body(branch=str(self.ho.pk), idempotency_key=key), format='json')
        self.assertEqual(res.status_code, 403, res.data)
        self.assertEqual(self.journals(), before)
        self.assertEqual(self.count(JournalEntry, idempotency_key=key), 0)
        # The key was not consumed: the same key on a valid request posts normally.
        with self.captureOnCommitCallbacks(execute=True):
            res = self.nina.post(self.F, self.body(idempotency_key=key), format='json')
        self.assertEqual(res.status_code, 201, res.data)

    def test_voucher_with_cheque_into_another_branch_saves_no_cheque(self):
        from apps.financial.models import Cheque
        body = self.body(branch=str(self.ho.pk))
        body['lines'][0]['cheque'] = {'cheque_number': '000123', 'cheque_date': '2026-01-10', 'bank_name': 'SBI'}
        with self.captureOnCommitCallbacks(execute=True):
            res = self.nina.post(self.F, body, format='json')
        self.assertEqual(res.status_code, 403, res.data)
        self.assertEqual(self.count(Cheque), 0)

    def test_voucher_without_branch_is_stamped_with_the_active_branch(self):
        with self.captureOnCommitCallbacks(execute=True):
            res = self.nina.post(self.F, self.body(), format='json')
        self.assertEqual(res.status_code, 201, res.data)
        self.assertEqual(res.data['branch'], self.north.pk if not isinstance(res.data['branch'], str)
                         else str(self.north.pk))
        # …so she can still see what she just posted.
        self.assertEqual(self.nina.get(f"{self.F}{res.data['id']}/").status_code, 200)

    def test_voucher_into_own_branch_works(self):
        with self.captureOnCommitCallbacks(execute=True):
            res = self.nina.post(self.F, self.body(branch=str(self.north.pk)), format='json')
        self.assertEqual(res.status_code, 201, res.data)

    def test_unknown_or_foreign_branch_is_400(self):
        before = self.journals()
        for client in (self.admin, self.nina):
            for bad in (str(self.tb_branch.pk), 'not-a-branch'):
                with self.subTest(bad=bad):
                    res = client.post(self.F, self.body(branch=bad), format='json')
                    self.assertEqual(res.status_code, 400, res.data)
        self.assertEqual(self.journals(), before)

    def test_admin_may_post_into_any_branch(self):
        with self.captureOnCommitCallbacks(execute=True):
            res = self.admin.post(self.F, self.body(branch=str(self.north.pk)), format='json')
        self.assertEqual(res.status_code, 201, res.data)

    def test_single_branch_mode_keeps_vouchers_unassigned(self):
        self.set_multi_branch(False)
        with self.captureOnCommitCallbacks(execute=True):
            res = self.nina.post(self.F, self.body(), format='json')
        self.assertEqual(res.status_code, 201, res.data)
        self.assertIsNone(res.data['branch'])


# ---------------------------------------------------------------------------------------------
# Single-branch installs and tenant isolation
# ---------------------------------------------------------------------------------------------

class SingleBranchModeTests(BranchIsolationFixture):
    def test_single_branch_mode_is_unchanged(self):
        """Multi-Branch OFF: no branch restriction applies; lists are not filtered by branch."""
        self.set_multi_branch(False)
        for name, url, attr, _patch in SCOPED:
            with self.subTest(name=name):
                self.assertEqual(ids(self.mona.get(url)), {str(d.pk) for d in getattr(self, attr).values()})
        res = self.mona.patch(f"/api/purchase/orders/{self.po['ho'].pk}/", {'status': 'SENT'}, format='json')
        self.assertEqual(res.status_code, 200, res.data)
        res = self.mona.post('/api/inventory/adjustments/',
                             {'product': str(self.product.pk), 'quantity': 1, 'adjustment_type': 'ADD',
                              'reason': 'recount', 'warehouse': str(self.ho_wh.pk)}, format='json')
        self.assertEqual(res.status_code, 201, res.data)


class TenantIsolationTests(BranchIsolationFixture):
    def test_other_tenant_rows_are_invisible_to_everyone(self):
        for client in (self.admin, self.mona):
            self.assertNotIn(str(self.tb_invoice.pk), ids(client.get('/api/sales/invoices/', {'branches': 'all'})))
            self.assertEqual(client.get(f'/api/sales/invoices/{self.tb_invoice.pk}/').status_code, 404)
            self.assertEqual(client.delete(f'/api/sales/invoices/{self.tb_invoice.pk}/').status_code, 404)
        with tenancy.unscoped():
            from apps.sales.models import Invoice
            self.assertFalse(Invoice.all_objects.get(pk=self.tb_invoice.pk).is_deleted)

    def test_other_tenant_cannot_reach_client_a_rows(self):
        self.assertEqual(self.b_admin.get(f"/api/sales/invoices/{self.inv['ho'].pk}/").status_code, 404)
        self.assertEqual(self.b_admin.patch(f"/api/purchase/orders/{self.po['ho'].pk}/", {'status': 'SENT'},
                                            format='json').status_code, 404)
        self.assertEqual(self.fresh(self.po['ho']).status, 'DRAFT')

    def test_foreign_tenant_branch_header_is_not_honoured(self):
        res = self.mona.get('/api/sales/invoices/', HTTP_X_BRANCH_ID=str(self.tb_branch.pk))
        self.assertEqual(res.status_code, 403)
        res = self.admin.get('/api/sales/invoices/', HTTP_X_BRANCH_ID=str(self.tb_branch.pk))
        self.assertEqual(res.status_code, 200)
        self.assertNotIn(str(self.tb_invoice.pk), ids(res))
