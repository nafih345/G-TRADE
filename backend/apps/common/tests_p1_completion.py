"""P1 completion — regression and isolation tests for Tasks 1, 2, 4, 5, 6, 7 and 8
(Task 3, backups: apps/security/tests/test_backup_tenant_gate.py).

Every API request goes through the real stack (login → signed JWT → TenantContextMiddleware →
BranchContextMiddleware → DRF) with TENANCY_ANONYMOUS_TENANT_ID off, as in production.

Fixture: tenant "Client A" (Multi-Branch ON) with branches HO (default) and North, a warehouse in
each, a product with 10 units in HO. Tenant "Client B" has one branch.
Users (Client A): clienta (Super Admin, every branch) · nina (Accountant, North only) ·
mona (Manager, North only). Client B: clientb (Super Admin).
"""
import datetime
import os
import shutil
import tempfile
from decimal import Decimal
from unittest import mock

from django.apps import apps as django_apps
from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.core.files.uploadedfile import SimpleUploadedFile
from django.core.management import call_command
from django.test import TestCase, override_settings
from rest_framework.test import APIClient

from apps.common import tenancy
from apps.common.tenant_onboarding import onboard_tenant

PW = 'Str0ng-pass-123'
D = Decimal
TODAY = datetime.date(2026, 1, 10)
PDF = b'%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n'


def rows(data):
    if isinstance(data, dict):
        for key in ('results', 'rows'):
            if key in data:
                return data[key]
    return data


def ids(res):
    return {str(r['id']) for r in rows(res.data)}


@override_settings(TENANCY_ANONYMOUS_TENANT_ID=None)
class P1Fixture(TestCase):
    def setUp(self):
        cache.clear()
        self.addCleanup(cache.clear)
        User = get_user_model()
        self.ta, _ = onboard_tenant(name='Client A', admin_username='clienta', password=PW)
        self.tb, _ = onboard_tenant(name='Client B', admin_username='clientb', password=PW)
        self.u_nina = User.objects.create_user('nina', password=PW, role='ACCOUNTANT', tenant=self.ta)
        self.u_mona = User.objects.create_user('mona', password=PW, role='MANAGER', tenant=self.ta)

        from apps.company.models import Branch, BusinessSettings, UserBranchAccess, Warehouse
        from apps.inventory.stock_utils import adjust_branch_stock
        from apps.products.models import Product
        with tenancy.use_tenant(self.ta.pk):
            self.ho = Branch.objects.get(is_default=True)
            self.north = Branch.objects.create(company=self.ho.company, name='North', code='NTH', is_active=True)
            self.ho_wh = Warehouse.objects.filter(branch=self.ho).first() or \
                Warehouse.objects.create(branch=self.ho, name='HO Store', code='HOW')
            self.north_wh = Warehouse.objects.create(branch=self.north, name='North Store', code='NTW')
            s = BusinessSettings.load()
            s.multi_branch_enabled = True
            s.save()
            for name in ('nina', 'mona'):
                UserBranchAccess.objects.create(username=name, default_branch=self.north).branches.set([self.north])
            self.product = Product.objects.create(name='Frame X', sku='FX-1', stock=0, cost_price=D('50'))
            adjust_branch_stock(self.product, self.ho, 10)
        with tenancy.use_tenant(self.tb.pk):
            self.tb_branch = Branch.objects.get(is_default=True)
        cache.clear()
        self.admin = self.login('clienta')
        self.nina = self.login('nina')
        self.mona = self.login('mona')
        self.b_admin = self.login('clientb')

    def login(self, username):
        client = APIClient()
        res = client.post('/api/auth/login/', {'username': username, 'password': PW}, format='json')
        self.assertEqual(res.status_code, 200, res.content)
        client.credentials(HTTP_AUTHORIZATION=f"Bearer {res.data['access']}")
        client.post('/api/security/reauth/', {'password': PW}, format='json')
        return client

    def in_a(self):
        return tenancy.use_tenant(self.ta.pk)

    def branch_stock(self, branch):
        from apps.company.models import BranchStock
        with self.in_a():
            row = BranchStock.objects.filter(product=self.product, branch=branch).first()
            return row.quantity if row else 0

    def product_stock(self):
        from apps.products.models import Product
        with self.in_a():
            return Product.all_objects.get(pk=self.product.pk).stock

    def set_pref(self, **prefs):
        from apps.company.models import BusinessSettings
        with self.in_a():
            s = BusinessSettings.load()
            s.preferences = {**(s.preferences or {}), **prefs}
            s.save()
        cache.clear()


# =============================================================================================
# Task 1 — accounting security
# =============================================================================================

class AccountingSecurityTests(P1Fixture):
    def setUp(self):
        super().setUp()
        from apps.financial.models import ChartOfAccount
        from apps.financial.services import create_journal
        with self.in_a():
            cash, sales = ChartOfAccount.objects.get(code='1001'), ChartOfAccount.objects.get(code='4001')
            self.cash_id = str(cash.pk)
            for amount, branch in (('100', self.ho), ('30', self.north)):
                create_journal(lines=[{'account': cash, 'debit': D(amount)}, {'account': sales, 'credit': D(amount)}],
                               date=TODAY, voucher_type_code='RV', narration='r', source_module='financial',
                               source_event='voucher', branch=branch)

    COMPANY_WIDE = (
        ('get', '/api/financial/integration/failures/', None),
        ('get', '/api/financial/integration/audit-log/', None),
        ('get', '/api/financial/integration/preview/?source_key=sales.invoice&id=00000000-0000-0000-0000-000000000000', None),
        ('post', '/api/financial/integration/backfill/', {'source_key': 'sales.invoice', 'dry_run': True}),
        ('post', '/api/financial/integration/opening-balances/', {}),
        ('post', '/api/financial/integration/recompute-balances/', {}),
        ('patch', '/api/financial/integration/policy/', {}),
        ('post', '/api/financial/integration/periods/', {'name': 'FY', 'start_date': '2026-04-01', 'end_date': '2027-03-31'}),
        ('post', '/api/financial/integration/mappings/', {'role': 'CASH'}),
        ('post', '/api/financial/integration/failures/retry-all/', {}),
        ('post', '/api/financial/vouchers/', {'code': 'ZZ', 'name': 'Z'}),
        ('post', '/api/financial/groups/', {'name': 'G', 'account_type': 'Asset'}),
        ('post', '/api/financial/accounts/', {'code': '9999', 'name': 'X'}),
    )

    def test_company_wide_tools_are_refused_to_a_branch_restricted_user(self):
        for method, url, body in self.COMPANY_WIDE:
            res = getattr(self.nina, method)(url, body or {}, format='json')
            self.assertEqual(res.status_code, 403, f'{method} {url}: {res.status_code} {getattr(res, "data", "")}')

    def test_unrestricted_admin_keeps_the_tools(self):
        for method, url, body in self.COMPANY_WIDE[:3] + (self.COMPANY_WIDE[5],):
            res = getattr(self.admin, method)(url, body or {}, format='json')
            self.assertNotEqual(res.status_code, 403, f'{method} {url}: {getattr(res, "data", "")}')

    def test_policy_and_mappings_still_readable(self):
        self.assertEqual(self.nina.get('/api/financial/integration/policy/').status_code, 200)
        self.assertEqual(self.nina.get('/api/financial/integration/mappings/').status_code, 200)

    def test_mapping_roles_for_another_branch_refused(self):
        res = self.nina.get('/api/financial/integration/mappings/roles/', {'branch': str(self.ho.pk)})
        self.assertEqual(res.status_code, 403)

    def test_chart_of_accounts_cached_balance_is_scoped(self):
        def cash_balance(client):
            data = rows(client.get('/api/financial/accounts/', {'page_size': 500}).data)
            return D(next(r['current_balance'] for r in data if r['code'] == '1001'))
        self.assertEqual(cash_balance(self.nina), D('30.00'))
        self.assertEqual(cash_balance(self.admin), D('130.00'))
        detail = self.nina.get(f'/api/financial/accounts/{self.cash_id}/')
        self.assertEqual(D(detail.data['current_balance']), D('30.00'))

    def test_expense_category_quick_add_is_not_blocked(self):
        res = self.nina.post('/api/financial/accounts/expense-category/', {'name': 'Tea'}, format='json')
        self.assertNotEqual(res.status_code, 403, res.data)

    def test_settlement_lists_and_settles_only_permitted_branch_bills(self):
        from apps.sales.models import Customer, Invoice
        with self.in_a():
            cust = Customer.objects.create(name='Due Customer', phone='5550001')
            bills = {k: Invoice.objects.create(invoice_number=f'INV-{k}', branch=b, invoice_date=TODAY, customer=cust,
                                               customer_name='Due Customer', document_type='INVOICE', status='UNPAID',
                                               total_amount=D('80'), net_amount=D('80'))
                     for k, b in (('ho', self.ho), ('north', self.north))}
        res = self.nina.get('/api/financial/settlements/due-bills/', {'party_kind': 'customer', 'party': str(cust.pk)})
        self.assertEqual(res.status_code, 200, res.data)
        self.assertEqual({b['number'] for b in res.data['bills']}, {'INV-north'})
        res = self.admin.get('/api/financial/settlements/due-bills/', {'party_kind': 'customer', 'party': str(cust.pk)})
        self.assertEqual({b['number'] for b in res.data['bills']}, {'INV-ho', 'INV-north'})
        res = self.nina.post('/api/financial/settlements/receipt/', {
            'party_kind': 'customer', 'party': str(cust.pk), 'date': str(TODAY), 'idempotency_key': 'k-ho-1',
            'allocations': [{'bill': str(bills['ho'].pk), 'amount': '10'}],
            'payments': [{'method': 'Cash', 'amount': '10'}]}, format='json')
        self.assertEqual(res.status_code, 400, res.data)
        with self.in_a():
            self.assertEqual(Invoice.all_objects.get(pk=bills['ho'].pk).paid_amount, D('0'))


# =============================================================================================
# Task 2 — purchase attachments
# =============================================================================================

class AttachmentSecurityTests(P1Fixture):
    def setUp(self):
        super().setUp()
        self.media = tempfile.mkdtemp(prefix='p1-media-')
        self.addCleanup(shutil.rmtree, self.media, True)
        over = override_settings(MEDIA_ROOT=self.media)
        over.enable()
        self.addCleanup(over.disable)
        from apps.purchasing.models import PurchaseInvoice, Supplier
        with self.in_a():
            sup = Supplier.objects.create(name='Lens Lab')
            self.pinv = {k: PurchaseInvoice.objects.create(invoice_number=f'PI-{k}', supplier=sup, branch=b,
                                                           purchase_date=TODAY, status='DRAFT')
                         for k, b in (('ho', self.ho), ('north', self.north))}

    def upload(self, client, key='ho', name='bill.pdf', data=PDF):
        branch = self.ho if key == 'ho' else self.north
        return client.patch(f"/api/purchase/invoices/{self.pinv[key].pk}/",
                            {'attachment': SimpleUploadedFile(name, data, content_type='application/pdf')},
                            format='multipart', HTTP_X_BRANCH_ID=str(branch.pk))

    def test_upload_is_private_random_and_api_never_returns_media_url(self):
        res = self.upload(self.admin)
        self.assertEqual(res.status_code, 200, res.data)
        self.assertEqual(res.data['attachment'], f"/api/purchase/invoices/{self.pinv['ho'].pk}/attachment/")
        self.assertTrue(res.data['has_attachment'])
        self.assertEqual(res.data['attachment_name'], 'bill.pdf')
        from apps.purchasing.models import PurchaseInvoice
        with self.in_a():
            stored = PurchaseInvoice.all_objects.get(pk=self.pinv['ho'].pk).attachment.name
        self.assertRegex(stored, rf'^private/t{self.ta.pk}/purchase_attachments/[0-9a-f]{{32}}\.pdf$')
        self.assertNotIn('bill', stored)

    def test_download_requires_object_access(self):
        self.upload(self.admin)
        url = f"/api/purchase/invoices/{self.pinv['ho'].pk}/attachment/"
        ok = self.admin.get(url)
        self.assertEqual(ok.status_code, 200)
        self.assertEqual(b''.join(ok.streaming_content), PDF)
        self.assertEqual(ok['X-Content-Type-Options'], 'nosniff')
        self.assertEqual(self.mona.get(url).status_code, 404)        # other branch
        self.assertEqual(self.b_admin.get(url).status_code, 404)     # other tenant
        self.assertIn(APIClient().get(url).status_code, (401, 403, 404))  # anonymous

    def test_signed_link(self):
        self.upload(self.admin)
        link = self.admin.get(f"/api/purchase/invoices/{self.pinv['ho'].pk}/attachment-link/")
        self.assertEqual(link.status_code, 200, link.data)
        anon = APIClient()
        res = anon.get(link.data['url'])
        self.assertEqual(res.status_code, 200)
        self.assertEqual(b''.join(res.streaming_content), PDF)
        self.assertEqual(anon.get(link.data['url'] + 'x').status_code, 403)          # tampered
        self.assertEqual(self.mona.get(f"/api/purchase/invoices/{self.pinv['ho'].pk}/attachment-link/").status_code, 404)
        from apps.purchasing import attachments
        with mock.patch.object(attachments, 'LINK_TTL', -1):
            self.assertEqual(anon.get(link.data['url']).status_code, 403)             # expired
        get_user_model().objects.filter(username='clienta').update(is_active=False)
        self.assertEqual(anon.get(link.data['url']).status_code, 403)                 # user deactivated

    def test_signed_link_rechecks_branch_access(self):
        self.upload(self.admin, key='north')
        link = self.mona.get(f"/api/purchase/invoices/{self.pinv['north'].pk}/attachment-link/")
        self.assertEqual(link.status_code, 200)
        from apps.company.models import UserBranchAccess
        with self.in_a():
            UserBranchAccess.objects.get(user=self.u_mona).branches.set([self.ho])  # access withdrawn
        cache.clear()
        self.assertEqual(APIClient().get(link.data['url']).status_code, 404)

    def test_active_content_and_fake_files_are_refused(self):
        self.assertEqual(self.upload(self.admin, name='x.html', data=b'<script>alert(1)</script>').status_code, 400)
        self.assertEqual(self.upload(self.admin, name='x.svg', data=b'<svg/>').status_code, 400)
        self.assertEqual(self.upload(self.admin, name='x.pdf', data=b'<html>not a pdf</html>').status_code, 400)

    def test_legacy_attachment_still_served_through_the_endpoint(self):
        from apps.purchasing.models import PurchaseInvoice
        os.makedirs(os.path.join(self.media, 'purchase_attachments'), exist_ok=True)
        with open(os.path.join(self.media, 'purchase_attachments', 'old bill.pdf'), 'wb') as fh:
            fh.write(PDF)
        with self.in_a():
            PurchaseInvoice.all_objects.filter(pk=self.pinv['ho'].pk).update(attachment='purchase_attachments/old bill.pdf')
        res = self.admin.get(f"/api/purchase/invoices/{self.pinv['ho'].pk}/attachment/")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(b''.join(res.streaming_content), PDF)

    def test_public_media_route_refuses_private_files(self):
        from django.http import Http404
        from django.test import RequestFactory
        from apps.common.media_paths import is_publicly_servable, public_media_view
        self.assertFalse(is_publicly_servable(f'private/t{self.ta.pk}/purchase_attachments/a.pdf'))
        self.assertFalse(is_publicly_servable('purchase_attachments/a.pdf'))
        self.assertFalse(is_publicly_servable('import_batches/stock.xlsx'))
        self.assertFalse(is_publicly_servable('product_images/../purchase_attachments/a.pdf'))
        self.assertFalse(is_publicly_servable('product_images/a.html'))
        self.assertTrue(is_publicly_servable('product_images/a.png'))
        self.assertTrue(is_publicly_servable('public/t1/product_images/abc.webp'))
        with self.assertRaises(Http404):
            public_media_view(RequestFactory().get('/media/x'), 'purchase_attachments/a.pdf')

    def test_relocate_media_dry_run_then_apply_idempotent(self):
        from apps.purchasing.models import PurchaseInvoice
        os.makedirs(os.path.join(self.media, 'purchase_attachments'), exist_ok=True)
        with open(os.path.join(self.media, 'purchase_attachments', 'old.pdf'), 'wb') as fh:
            fh.write(PDF)
        with self.in_a():
            PurchaseInvoice.all_objects.filter(pk=self.pinv['ho'].pk).update(attachment='purchase_attachments/old.pdf')
            PurchaseInvoice.all_objects.filter(pk=self.pinv['north'].pk).update(attachment='purchase_attachments/gone.pdf')
        call_command('relocate_media', stdout=open(os.devnull, 'w'))
        with self.in_a():
            self.assertEqual(PurchaseInvoice.all_objects.get(pk=self.pinv['ho'].pk).attachment.name, 'purchase_attachments/old.pdf')
        call_command('relocate_media', '--apply', stdout=open(os.devnull, 'w'))
        with self.in_a():
            moved = PurchaseInvoice.all_objects.get(pk=self.pinv['ho'].pk).attachment.name
        self.assertTrue(moved.startswith(f'private/t{self.ta.pk}/purchase_attachments/'))
        self.assertTrue(os.path.exists(os.path.join(self.media, 'purchase_attachments', 'old.pdf')))  # old kept
        call_command('relocate_media', '--apply', stdout=open(os.devnull, 'w'))
        with self.in_a():
            self.assertEqual(PurchaseInvoice.all_objects.get(pk=self.pinv['ho'].pk).attachment.name, moved)


# =============================================================================================
# Task 4 — user-id based branch access
# =============================================================================================

class UserIdBranchAccessTests(P1Fixture):
    def context(self, client):
        res = client.get('/api/company/branch-context/')
        self.assertEqual(res.status_code, 200, res.data)
        return {b['id'] for b in res.data['branches']}

    def test_rows_are_linked_to_the_user(self):
        from apps.company.models import UserBranchAccess
        with self.in_a():
            self.assertEqual(UserBranchAccess.objects.get(username='mona').user_id, self.u_mona.pk)

    def test_rename_keeps_permissions(self):
        get_user_model().objects.filter(pk=self.u_mona.pk).update(username='mona.renamed')
        cache.clear()
        client = self.login('mona.renamed')
        self.assertEqual(self.context(client), {str(self.north.pk)})

    def test_case_variant_user_does_not_inherit_another_users_row(self):
        from apps.company.models import UserBranchAccess
        User = get_user_model()
        twin = User.objects.create_user('MONA', password=PW, role='MANAGER', tenant=self.ta)
        with self.in_a():
            self.assertIsNone(UserBranchAccess.for_user(twin))
        self.assertEqual(self.context(self.login('mona')), {str(self.north.pk)})

    def test_deleting_a_user_deletes_their_access_and_a_namesake_starts_unconfigured(self):
        from apps.company.models import UserBranchAccess
        User = get_user_model()
        User.objects.filter(pk=self.u_mona.pk).delete()
        with self.in_a():
            self.assertFalse(UserBranchAccess.all_objects.filter(username='mona', is_deleted=False).exists())
        newbie = User.objects.create_user('mona', password=PW, role='MANAGER', tenant=self.ta)
        with self.in_a():
            self.assertIsNone(UserBranchAccess.for_user(newbie))

    def test_api_upserts_by_user_and_restricted_user_sees_only_own_row(self):
        from apps.company.models import UserBranchAccess
        res = self.admin.post('/api/company/user-branch-access/', {
            'username': 'Mona', 'access_all_branches': False, 'branches': [str(self.north.pk), str(self.ho.pk)],
            'default_branch': str(self.north.pk)}, format='json')
        self.assertIn(res.status_code, (200, 201), res.data)
        with self.in_a():
            self.assertEqual(UserBranchAccess.objects.filter(user=self.u_mona).count(), 1)
        mine = self.mona.get('/api/company/user-branch-access/')
        self.assertEqual({r['username'] for r in rows(mine.data)}, {'mona'})
        self.assertEqual(self.mona.post('/api/company/user-branch-access/', {'username': 'mona'}, format='json').status_code, 403)

    def test_backfill_links_exactly_the_old_rule_row_and_verifies(self):
        from apps.company.branch_access_backfill import backfill_tenant, verify_tenant
        from apps.company.models import UserBranchAccess
        User = get_user_model()
        Access = django_apps.get_model('company', 'UserBranchAccess')
        with self.in_a():
            UserBranchAccess.all_objects.update(user=None)  # as before migration 0015
            # An orphan (no such user) and a case-variant pair resolving to one row.
            UserBranchAccess.all_objects.create(username='ghost', default_branch=self.ho)
            User.objects.create_user('Nina', password=PW, role='ACCOUNTANT', tenant=self.ta)
            UserBranchAccess.all_objects.filter(username='Nina').update(user=None)
            report = backfill_tenant(Access, User, self.ta.pk, apply=True)
            self.assertIn('mona', report['linked'])
            self.assertIn('nina', report['linked'])
            self.assertIn('ghost', report['orphan'])
            self.assertTrue(any(c.startswith('Nina') for c in report['cloned']))
            self.assertEqual(verify_tenant(Access, User, self.ta.pk), [])
            again = backfill_tenant(Access, User, self.ta.pk, apply=True)
            self.assertEqual((again['linked'], again['cloned']), ([], []))

    def test_verify_command_passes(self):
        call_command('verify_branch_access', stdout=open(os.devnull, 'w'))


# =============================================================================================
# Task 5 — wholesale branch relationships
# =============================================================================================

class WholesaleBranchTests(P1Fixture):
    def setUp(self):
        super().setUp()
        from apps.sales.models import Dealer, WholesaleInvoice
        with self.in_a():
            self.dealer = Dealer.objects.create(business_name='Dealer One', dealer_code='D1', phone='1')
            self.winv = {k: WholesaleInvoice.objects.create(invoice_number=f'W-{k}', dealer=self.dealer, branch=b,
                                                            invoice_date=TODAY, due_date=TODAY, grand_total=D('100'),
                                                            due_amount=D('100'))
                         for k, b in (('ho', self.ho), ('north', self.north), ('none', None))}

    def test_lists_and_details_are_branch_scoped(self):
        url = '/api/sales/wholesale/invoices/'
        self.assertEqual(ids(self.mona.get(url)), {str(self.winv['north'].pk)})
        self.assertEqual(self.mona.get(f"{url}{self.winv['ho'].pk}/").status_code, 404)
        self.assertEqual(self.mona.get(f"{url}{self.winv['none'].pk}/").status_code, 404)  # unassigned
        self.assertEqual(ids(self.admin.get(url, {'branches': 'all'})), {str(v.pk) for v in self.winv.values()})
        # Unrestricted user's working view keeps legacy Unassigned rows visible.
        self.assertIn(str(self.winv['none'].pk), ids(self.admin.get(url)))

    def test_create_stamps_working_branch_and_refuses_another(self):
        body = {'dealer': str(self.dealer.pk),
                'details': {'items': [{'id': str(self.product.pk), 'name': 'Frame X', 'qty': 1, 'rate': 10}]}}
        res = self.mona.post('/api/sales/wholesale/quotations/', body, format='json')
        self.assertEqual(res.status_code, 201, res.data)
        self.assertEqual(str(res.data['branch']), str(self.north.pk))
        res = self.mona.post('/api/sales/wholesale/quotations/', {**body, 'branch': str(self.ho.pk)}, format='json')
        self.assertEqual(res.status_code, 403)

    def test_update_and_delete_of_another_branch_are_404(self):
        url = f"/api/sales/wholesale/invoices/{self.winv['ho'].pk}/"
        self.assertEqual(self.mona.patch(url, {'status': 'Paid'}, format='json').status_code, 404)
        self.assertEqual(self.mona.delete(url).status_code, 404)

    def test_collection_and_return_follow_their_invoice_branch(self):
        base = {'dealer': str(self.dealer.pk), 'payment_date': str(TODAY), 'payment_method': 'Cash', 'amount_paid': '5'}
        res = self.mona.post('/api/sales/wholesale/collections/', {**base, 'receipt_number': 'C-1',
                                                                   'invoice_number': 'W-ho'}, format='json')
        self.assertEqual(res.status_code, 403)
        res = self.admin.post('/api/sales/wholesale/collections/', {**base, 'receipt_number': 'C-2',
                                                                    'invoice_number': 'W-north'}, format='json')
        self.assertEqual(res.status_code, 201, res.data)
        self.assertEqual(str(res.data['branch']), str(self.north.pk))
        res = self.mona.post('/api/sales/wholesale/returns/', {
            'return_number': 'R-1', 'invoice_number': 'W-ho', 'dealer': str(self.dealer.pk), 'return_date': str(TODAY),
            'reason': 'x', 'return_amount': '5'}, format='json')
        self.assertEqual(res.status_code, 403)

    def test_pos_sale_from_another_branch_warehouse_is_refused_and_moves_nothing(self):
        res = self.mona.post('/api/sales/wholesale/invoices/', {
            'invoice_number': 'W-POS', 'dealer': str(self.dealer.pk), 'invoice_date': str(TODAY), 'due_date': str(TODAY),
            'grand_total': '50', 'details': {'warehouseId': str(self.ho_wh.pk),
                                             'items': [{'id': str(self.product.pk), 'qty': 2}]}}, format='json')
        self.assertEqual(res.status_code, 403)
        self.assertEqual(self.branch_stock(self.ho), 10)
        from apps.sales.models import WholesaleInvoice
        with self.in_a():
            self.assertFalse(WholesaleInvoice.all_objects.filter(invoice_number='W-POS').exists())

    def test_pos_sale_is_stamped_with_the_stock_branch(self):
        res = self.admin.post('/api/sales/wholesale/invoices/', {
            'invoice_number': 'W-POS2', 'dealer': str(self.dealer.pk), 'invoice_date': str(TODAY), 'due_date': str(TODAY),
            'grand_total': '50', 'details': {'warehouseId': str(self.ho_wh.pk),
                                             'items': [{'id': str(self.product.pk), 'qty': 2}]}}, format='json')
        self.assertEqual(res.status_code, 201, res.data)
        from apps.sales.models import WholesaleInvoice
        with self.in_a():
            self.assertEqual(WholesaleInvoice.all_objects.get(invoice_number='W-POS2').branch_id, self.ho.pk)
        self.assertEqual(self.branch_stock(self.ho), 8)

    def test_journals_carry_the_document_branch(self):
        from apps.financial.posting_rules import build_wholesale_invoice
        with self.in_a():
            plan = build_wholesale_invoice(self.winv['north'])
        self.assertEqual(plan['branch'], self.north)

    def test_dealer_directory_shows_only_permitted_business(self):
        res = self.mona.get('/api/sales/wholesale/dealers/directory/')
        self.assertEqual(res.status_code, 200, res.data)
        row = next(r for r in res.data if r['id'] == str(self.dealer.pk))
        self.assertEqual((row['invoice_count'], D(row['bills_due'])), (1, D('100')))
        row = next(r for r in self.admin.get('/api/sales/wholesale/dealers/directory/').data if r['id'] == str(self.dealer.pk))
        self.assertEqual(row['invoice_count'], 3)

    def test_backfill_rules_evidence_only_and_idempotent(self):
        from apps.inventory.models import StockLedger
        from apps.sales.branch_backfill import backfill_wholesale_tenant
        from apps.sales.models import WholesaleInvoice, WholesaleOrder, WholesalePaymentCollection
        with self.in_a():
            w1 = WholesaleInvoice.objects.create(invoice_number='B-1', dealer=self.dealer, invoice_date=TODAY, due_date=TODAY,
                                                 grand_total=D('1'), stock_applied={'branch': str(self.north.pk), 'items': {}})
            w2 = WholesaleInvoice.objects.create(invoice_number='B-2', dealer=self.dealer, invoice_date=TODAY, due_date=TODAY,
                                                 grand_total=D('1'))
            StockLedger.objects.create(product=self.product, warehouse=self.ho_wh, branch=self.ho, quantity=-1,
                                       transaction_type='OUT', reference_id=w2.pk)
            w3 = WholesaleInvoice.objects.create(invoice_number='B-3', dealer=self.dealer, invoice_date=TODAY, due_date=TODAY,
                                                 grand_total=D('1'))
            col = WholesalePaymentCollection.objects.create(receipt_number='BC-1', dealer=self.dealer, invoice_number='B-1',
                                                            payment_date=TODAY, payment_method='Cash', amount_paid=D('1'))
            order = WholesaleOrder.objects.create(order_number='BO-1', dealer=self.dealer, order_date=TODAY, invoice=w2)
            report = backfill_wholesale_tenant(django_apps.get_model, self.ta.pk, apply=True)
            get = lambda m, o: m.all_objects.get(pk=o.pk).branch_id  # noqa: E731
            self.assertEqual(get(WholesaleInvoice, w1), self.north.pk)
            self.assertEqual(get(WholesaleInvoice, w2), self.ho.pk)
            self.assertIsNone(get(WholesaleInvoice, w3))                       # no evidence: Unassigned
            self.assertIsNone(get(WholesaleInvoice, self.winv['none']))
            self.assertEqual(get(WholesalePaymentCollection, col), self.north.pk)
            self.assertEqual(get(WholesaleOrder, order), self.ho.pk)
            self.assertEqual(get(WholesaleInvoice, self.winv['ho']), self.ho.pk)  # existing value untouched
            self.assertGreaterEqual(report['WholesaleInvoice']['unassigned'], 2)
            again = backfill_wholesale_tenant(django_apps.get_model, self.ta.pk, apply=True)
            self.assertEqual(sum(v for k, v in again['WholesaleInvoice'].items() if k != 'unassigned'), 0)

    def test_single_branch_tenant_backfill_assigns_its_only_branch(self):
        from apps.sales.branch_backfill import backfill_wholesale_tenant
        from apps.sales.models import Dealer, WholesaleInvoice
        with tenancy.use_tenant(self.tb.pk):
            d = Dealer.objects.create(business_name='B Dealer', dealer_code='BD', phone='2')
            w = WholesaleInvoice.objects.create(invoice_number='BW-1', dealer=d, invoice_date=TODAY, due_date=TODAY,
                                                grand_total=D('1'))
            backfill_wholesale_tenant(django_apps.get_model, self.tb.pk, apply=True)
            self.assertEqual(WholesaleInvoice.all_objects.get(pk=w.pk).branch_id, self.tb_branch.pk)


# =============================================================================================
# Task 6 — eye exams and appointments
# =============================================================================================

class ExamAppointmentBranchTests(P1Fixture):
    def setUp(self):
        super().setUp()
        from apps.sales.models import Appointment, EyeExamination
        with self.in_a():
            self.exam = {k: EyeExamination.objects.create(patient_name=f'P {k}', test_no=f'9{i}', branch_ref=b,
                                                          branch=b.name if b else 'Somewhere')
                         for i, (k, b) in enumerate((('ho', self.ho), ('north', self.north), ('none', None)))}
            self.appt = {k: Appointment.objects.create(patient_name=f'A {k}', appointment_date=TODAY, branch_ref=b,
                                                       test_no=f'8{i}')
                         for i, (k, b) in enumerate((('ho', self.ho), ('north', self.north)))}

    def test_exam_lists_and_details_are_scoped(self):
        url = '/api/sales/eye-examinations/'
        self.assertEqual(ids(self.mona.get(url)), {str(self.exam['north'].pk)})
        self.assertEqual(self.mona.get(f"{url}{self.exam['ho'].pk}/").status_code, 404)
        self.assertEqual(self.mona.get(f"{url}{self.exam['none'].pk}/").status_code, 404)
        self.assertEqual(self.mona.get(f"{url}{self.exam['ho'].pk}/report/").status_code, 404)
        self.assertIn(str(self.exam['none'].pk), ids(self.admin.get(url)))

    def test_appointments_are_scoped(self):
        self.assertEqual(ids(self.mona.get('/api/sales/appointments/')), {str(self.appt['north'].pk)})

    def test_create_stamps_relational_branch_and_fills_label(self):
        res = self.mona.post('/api/sales/eye-examinations/', {'patient_name': 'New Patient', 'patient_id': 'P-T1'},
                             format='json')
        self.assertEqual(res.status_code, 201, res.data)
        self.assertEqual(str(res.data['branch_ref']), str(self.north.pk))
        self.assertEqual(res.data['branch'], 'North')
        self.assertEqual(res.data['branch_name'], 'North')
        res = self.mona.post('/api/sales/eye-examinations/', {'patient_name': 'X', 'patient_id': 'P-T2',
                                                               'branch_ref': str(self.ho.pk)}, format='json')
        self.assertEqual(res.status_code, 403)

    def test_text_matching_rules(self):
        from apps.sales.branch_backfill import match_branch_text
        branches = [{'id': 1, 'name': 'North', 'code': 'NTH'}, {'id': 2, 'name': 'Head Office', 'code': 'HO'}]
        self.assertEqual(match_branch_text('  north ', branches), '1')
        self.assertEqual(match_branch_text('nth', branches), '1')
        self.assertEqual(match_branch_text('head   office', branches), '2')
        self.assertIsNone(match_branch_text('Main Branch', branches))       # UI default, several branches
        self.assertEqual(match_branch_text('Main Branch', branches[:1]), '1')  # one-branch tenant
        self.assertIsNone(match_branch_text('City Clinic', branches))
        dup = branches + [{'id': 3, 'name': 'North', 'code': 'N2'}]
        self.assertIsNone(match_branch_text('North', dup))                  # ambiguous

    def test_backfill_maps_only_unambiguous_text_and_keeps_text(self):
        from apps.sales.branch_backfill import backfill_exam_tenant
        from apps.sales.models import EyeExamination
        with self.in_a():
            e1 = EyeExamination.objects.create(patient_name='T1', test_no='71', branch='NORTH ')
            e2 = EyeExamination.objects.create(patient_name='T2', test_no='72', branch='City Clinic')
            e3 = EyeExamination.objects.create(patient_name='T3', test_no='73', branch='Main Branch')
            report = backfill_exam_tenant(django_apps.get_model, self.ta.pk, apply=True)
            get = lambda e: EyeExamination.all_objects.get(pk=e.pk)  # noqa: E731
            self.assertEqual(get(e1).branch_ref_id, self.north.pk)
            self.assertEqual(get(e1).branch, 'NORTH ')
            self.assertIsNone(get(e2).branch_ref_id)
            self.assertIsNone(get(e3).branch_ref_id)
            self.assertIn('City Clinic', report['EyeExamination']['unmatched_texts'])
            again = backfill_exam_tenant(django_apps.get_model, self.ta.pk, apply=True)
            self.assertEqual(again['EyeExamination']['matched'], 0)


# =============================================================================================
# Task 7 — stock transfers
# =============================================================================================

class StockTransferWorkflowTests(P1Fixture):
    API = '/api/company/stock-transfers/'

    def draft(self, client=None, qty=4, src=None, dst=None):
        res = (client or self.admin).post(self.API, {
            'from_branch': str((src or self.ho).pk), 'to_branch': str((dst or self.north).pk),
            'items': [{'product': str(self.product.pk), 'quantity': qty}]}, format='json')
        self.assertEqual(res.status_code, 201, res.data)
        return res.data

    def act(self, client, t, action, body=None):
        return client.post(f"{self.API}{t['id']}/{action}/", body or {}, format='json')

    def test_full_two_step_cycle(self):
        t = self.draft()
        self.assertTrue(t['transfer_number'].startswith('TRF-'))
        self.assertEqual(t['status'], 'DRAFT')
        res = self.act(self.admin, t, 'dispatch')
        self.assertEqual(res.status_code, 200, res.data)
        self.assertEqual((self.branch_stock(self.ho), self.branch_stock(self.north), self.product_stock()), (6, 0, 6))
        self.assertEqual(self.act(self.admin, t, 'dispatch').status_code, 409)       # no double dispatch
        self.assertEqual(self.branch_stock(self.ho), 6)
        item = res.data['items'][0]['id']
        res = self.act(self.admin, t, 'receive', {'quantities': {item: 1}})
        self.assertEqual(res.status_code, 200, res.data)
        self.assertEqual(res.data['status'], 'PARTIALLY_RECEIVED')
        self.assertEqual(self.branch_stock(self.north), 1)
        res = self.act(self.admin, t, 'receive')
        self.assertEqual(res.data['status'], 'RECEIVED')
        self.assertEqual((self.branch_stock(self.ho), self.branch_stock(self.north), self.product_stock()), (6, 4, 10))
        self.assertTrue(res.data['received_by'])
        self.assertIsNotNone(res.data['received_at'])
        self.assertEqual(self.act(self.admin, t, 'receive').status_code, 409)        # no double receive
        self.assertEqual(self.act(self.admin, t, 'cancel').status_code, 409)
        from apps.inventory.models import StockLedger
        with self.in_a():
            moves = list(StockLedger.objects.filter(transaction_type='TRANSFER', product=self.product)
                         .values_list('branch_id', 'quantity'))
        self.assertEqual(sorted(moves, key=str), sorted([(self.ho.pk, -4), (self.north.pk, 1), (self.north.pk, 3)], key=str))

    def test_over_receiving_is_refused(self):
        t = self.draft()
        res = self.act(self.admin, t, 'dispatch')
        item = res.data['items'][0]['id']
        self.assertEqual(self.act(self.admin, t, 'receive', {'quantities': {item: 5}}).status_code, 400)
        self.assertEqual(self.branch_stock(self.north), 0)

    def test_cancel_returns_what_is_in_transit(self):
        t = self.draft()
        self.act(self.admin, t, 'dispatch')
        res = self.act(self.admin, t, 'cancel', {'reason': 'wrong branch'})
        self.assertEqual(res.data['status'], 'CANCELLED')
        self.assertEqual((self.branch_stock(self.ho), self.product_stock()), (10, 10))
        t2 = self.draft()
        res = self.act(self.admin, t2, 'dispatch')
        self.act(self.admin, t2, 'receive', {'quantities': {res.data['items'][0]['id']: 1}})
        res = self.act(self.admin, t2, 'cancel')
        self.assertEqual(res.data['status'], 'CLOSED')
        self.assertEqual((self.branch_stock(self.ho), self.branch_stock(self.north), self.product_stock()), (9, 1, 10))

    def test_negative_stock_block_refuses_dispatch(self):
        self.set_pref(allow_negative_stock=False)
        t = self.draft(qty=50)
        self.assertEqual(self.act(self.admin, t, 'dispatch').status_code, 400)
        self.assertEqual(self.branch_stock(self.ho), 10)
        self.assertEqual(self.admin.get(f"{self.API}{t['id']}/").data['status'], 'DRAFT')

    def test_only_drafts_can_be_edited_or_deleted(self):
        t = self.draft()
        self.act(self.admin, t, 'dispatch')
        res = self.admin.patch(f"{self.API}{t['id']}/", {'notes': 'x'}, format='json')
        self.assertEqual(res.status_code, 409)
        self.assertEqual(self.admin.delete(f"{self.API}{t['id']}/").status_code, 409)

    def test_branch_authorization(self):
        t = self.draft()                                           # HO → North
        self.assertEqual(self.act(self.mona, t, 'dispatch').status_code, 403)   # mona is not HO
        self.act(self.admin, t, 'dispatch')
        self.assertEqual(self.act(self.mona, t, 'cancel').status_code, 403)     # receiver can't cancel
        self.assertEqual(self.act(self.mona, t, 'receive').status_code, 200)    # receiver receives
        back = self.draft(client=self.mona, src=self.north, dst=self.ho, qty=1)
        self.assertEqual(self.act(self.mona, back, 'dispatch').status_code, 200)
        self.assertEqual(self.act(self.mona, back, 'receive').status_code, 403)  # not HO
        res = self.mona.post(self.API, {'from_branch': str(self.ho.pk), 'to_branch': str(self.north.pk),
                                        'items': [{'product': str(self.product.pk), 'quantity': 1}]}, format='json')
        self.assertEqual(res.status_code, 403)
        self.assertEqual(self.b_admin.get(f"{self.API}{t['id']}/").status_code, 404)  # other tenant

    def test_validation(self):
        res = self.admin.post(self.API, {'from_branch': str(self.ho.pk), 'to_branch': str(self.ho.pk),
                                         'items': [{'product': str(self.product.pk), 'quantity': 1}]}, format='json')
        self.assertEqual(res.status_code, 400)
        res = self.admin.post(self.API, {'from_branch': str(self.ho.pk), 'to_branch': str(self.north.pk),
                                         'items': [{'product': str(self.product.pk), 'quantity': 0}]}, format='json')
        self.assertEqual(res.status_code, 400)

    def test_goods_in_transit_journals_balance_and_carry_branches(self):
        from apps.financial.models import JournalEntry
        t = self.draft()
        with self.captureOnCommitCallbacks(execute=True):
            self.act(self.admin, t, 'dispatch')
        with self.captureOnCommitCallbacks(execute=True):
            self.act(self.admin, t, 'receive')
        with self.in_a():
            entries = list(JournalEntry.objects.filter(source_module='inventory', source_event='branch_transfer',
                                                       status='POSTED').prefetch_related('lines__account'))
        self.assertEqual(len(entries), 2)
        by_branch = {e.branch_id: e for e in entries}
        self.assertEqual(set(by_branch), {self.ho.pk, self.north.pk})
        for e in entries:
            lines = list(e.lines.all())
            self.assertEqual(sum(l.debit for l in lines), sum(l.credit for l in lines))
            self.assertEqual(sum(l.debit for l in lines), D('200.00'))  # 4 × 50
            self.assertIn('1030', {l.account.code for l in lines})

    def test_in_transit_summary(self):
        t = self.draft()
        self.act(self.admin, t, 'dispatch')
        res = self.admin.get(f'{self.API}in-transit/')
        self.assertEqual(res.data, {str(self.product.pk): 4})

    def test_n10_completed_warehouse_transfer_never_moves_stock_again(self):
        from apps.company.models import Warehouse
        from apps.inventory.models import StockLedger
        with self.in_a():
            wh2 = Warehouse.objects.create(branch=self.ho, name='HO Back', code='HOB')
        res = self.admin.post('/api/inventory/transfers/', {'product': str(self.product.pk), 'from_warehouse': str(self.ho_wh.pk),
                                                             'to_warehouse': str(wh2.pk), 'quantity': 2}, format='json')
        self.assertEqual(res.status_code, 201, res.data)
        url = f"/api/inventory/transfers/{res.data['id']}/"
        self.assertEqual(self.admin.patch(url, {'status': 'COMPLETED'}, format='json').status_code, 200)
        self.assertEqual(self.admin.patch(url, {'status': 'COMPLETED'}, format='json').status_code, 400)
        with self.in_a():
            self.assertEqual(StockLedger.objects.filter(reference_id=res.data['id']).count(), 2)
        self.assertEqual(self.admin.delete(url).status_code, 400)
        res = self.admin.post('/api/inventory/transfers/', {'product': str(self.product.pk), 'from_warehouse': str(self.ho_wh.pk),
                                                             'to_warehouse': str(self.north_wh.pk), 'quantity': 1}, format='json')
        self.assertEqual(res.status_code, 400)  # cross-branch → Branch Transfers


# =============================================================================================
# Task 8 — remaining branch gaps
# =============================================================================================

class RemainingBranchGapTests(P1Fixture):
    def test_stock_history_shows_only_permitted_branches(self):
        from apps.inventory.stock_utils import adjust_branch_stock
        with self.in_a():
            adjust_branch_stock(self.product, self.north, 2, ledger={'transaction_type': 'IN', 'notes': 'north in'})
            adjust_branch_stock(self.product, self.ho, 1, ledger={'transaction_type': 'IN', 'notes': 'ho in'})
        url = f'/api/inventory/stock-overview/{self.product.pk}/history/'
        res = self.mona.get(url)
        self.assertEqual(res.status_code, 200, res.data)
        self.assertEqual({r['branch'] for r in rows(res.data)}, {'North'})
        self.assertEqual({r['branch'] for r in rows(self.admin.get(url).data)}, {'North', self.ho.name})

    def test_warehouse_master_is_branch_scoped(self):
        res = self.mona.get('/api/company/warehouses/')
        self.assertEqual(ids(res), {str(self.north_wh.pk)})
        self.assertEqual(self.mona.patch(f'/api/company/warehouses/{self.ho_wh.pk}/', {'name': 'x'}, format='json').status_code, 404)
        res = self.mona.post('/api/company/warehouses/', {'branch': str(self.ho.pk), 'name': 'Mine', 'code': 'MN'}, format='json')
        self.assertEqual(res.status_code, 403)
        res = self.mona.post('/api/company/warehouses/', {'branch': str(self.north.pk), 'name': 'N2', 'code': 'N2'}, format='json')
        self.assertIn(res.status_code, (201, 403), res.data)  # module gate may refuse by role; never another branch
        self.assertGreater(len(ids(self.admin.get('/api/company/warehouses/'))), 1)

    def test_branch_master_writes_need_every_branch(self):
        res = self.mona.patch(f'/api/company/branches/{self.north.pk}/', {'name': 'N'}, format='json')
        self.assertEqual(res.status_code, 403)
        self.assertEqual(self.mona.post(f'/api/company/branches/{self.ho.pk}/set-default/').status_code, 403)

    def test_single_branch_mode_is_unchanged(self):
        from apps.company.models import BusinessSettings
        from apps.sales.models import Dealer, WholesaleInvoice
        with self.in_a():
            s = BusinessSettings.load()
            s.multi_branch_enabled = False
            s.save()
            d = Dealer.objects.create(business_name='D', dealer_code='DD', phone='3')
            w = WholesaleInvoice.objects.create(invoice_number='S-1', dealer=d, branch=self.ho, invoice_date=TODAY,
                                                due_date=TODAY, grand_total=D('1'))
        cache.clear()
        mona = self.login('mona')
        self.assertIn(str(w.pk), ids(mona.get('/api/sales/wholesale/invoices/')))
        # Accounting tools: single-branch mode has no branch restriction (role rules only).
        self.assertNotEqual(self.login('nina').get('/api/financial/integration/failures/').status_code, 403)
        res = mona.post('/api/sales/eye-examinations/', {'patient_name': 'Single', 'patient_id': 'P-T3'}, format='json')
        self.assertEqual(res.status_code, 201, res.data)
        self.assertEqual(str(res.data['branch_ref']), str(self.ho.pk))  # default branch, as before
