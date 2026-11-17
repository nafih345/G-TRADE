"""Phase 2 — multi-company (Organization → Companies = Tenants → Branches) regression and isolation.

Every API request goes through the real stack (login → signed JWT → TenantContextMiddleware →
BranchContextMiddleware → DRF), with TENANCY_ANONYMOUS_TENANT_ID off, as in production.

Fixture
  Organization "Acme Group" (org admin: owner)
    · company A "Acme Optics"  — home of owner (SUPER_ADMIN), acct (ACCOUNTANT), cashier (CASHIER)
    · company B "Acme Wholesale" — created by owner through the API; acct is a MANAGER member there
  Organization "Other Customer" (org admin: outsider) — one company, a different customer.
"""
import datetime
import io
import json
import shutil
import tempfile

from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase, TransactionTestCase, override_settings
from rest_framework.test import APIClient
from rest_framework_simplejwt.tokens import AccessToken

from apps.common import organizations as orgs
from apps.common import tenancy
from apps.common.models import Organization, OrganizationAdmin, Tenant, UserCompanyMembership
from apps.common.tenant_onboarding import onboard_tenant

PW = 'Str0ng-pass-123'
TODAY = datetime.date.today().isoformat()
PDF = b'%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n'


def rows(data):
    if isinstance(data, dict):
        for key in ('results', 'rows'):
            if key in data:
                return data[key]
    return data


def ids_of(res):
    return {str(r['id']) for r in rows(res.data)}


@override_settings(TENANCY_ANONYMOUS_TENANT_ID=None)
class MultiCompanyFixture(TestCase):
    def setUp(self):
        cache.clear()
        self.addCleanup(cache.clear)
        User = get_user_model()
        self.ta, self.u_owner = onboard_tenant(name='Acme Optics', admin_username='owner', password=PW)
        self.org = self.ta.organization
        Organization.objects.filter(pk=self.org.pk).update(max_companies=3)
        self.u_acct = User.objects.create_user('acct', password=PW, role='ACCOUNTANT', tenant=self.ta)
        self.u_cashier = User.objects.create_user('cashier', password=PW, role='CASHIER', tenant=self.ta)
        self.tx, self.u_outsider = onboard_tenant(name='Other Customer', admin_username='outsider', password=PW)
        cache.clear()

        self.owner = self.login('owner')
        res = self.owner.post('/api/organization/companies/', {'name': 'Acme Wholesale'}, format='json')
        self.assertEqual(res.status_code, 201, res.data)
        self.tb = Tenant.objects.get(pk=res.data['tenant_id'])
        res = self.owner.post(f'/api/organization/companies/{self.tb.pk}/members/',
                              {'user_id': str(self.u_acct.pk), 'role': 'MANAGER', 'all_branches': True}, format='json')
        self.assertEqual(res.status_code, 200, res.data)
        self.acct = self.login('acct')
        self.cashier = self.login('cashier')
        self.outsider = self.login('outsider')

    # ---- helpers ------------------------------------------------------------------------------

    def login(self, username):
        client = APIClient()
        res = client.post('/api/auth/login/', {'username': username, 'password': PW}, format='json')
        self.assertEqual(res.status_code, 200, res.content)
        client.credentials(HTTP_AUTHORIZATION=f"Bearer {res.data['access']}")
        client.tokens = res.data
        return client

    def switch(self, client, tenant, expect=200):
        res = client.post('/api/auth/switch-company/', {'tenant_id': getattr(tenant, 'pk', tenant)}, format='json')
        self.assertEqual(res.status_code, expect, getattr(res, 'data', res.content))
        if expect != 200:
            return res
        fresh = APIClient()
        fresh.credentials(HTTP_AUTHORIZATION=f"Bearer {res.data['access']}")
        fresh.tokens = res.data
        return fresh

    def call(self, client, method, url, body=None, **extra):
        with self.captureOnCommitCallbacks(execute=True):
            if body is None:
                return getattr(client, method)(url, **extra)
            return getattr(client, method)(url, body, format='json', **extra)

    def create_set(self, client, tag):
        ids = {}
        res = self.call(client, 'post', '/api/masters/categories/', {'name': f'Test Frames {tag}', 'code': f'TFR{tag}'})
        self.assertEqual(res.status_code, 201, res.data)
        ids['category'] = res.data['id']
        res = self.call(client, 'post', '/api/masters/brands/', {'name': f'Brand {tag}', 'code': f'BR{tag}'})
        self.assertEqual(res.status_code, 201, res.data)
        ids['brand'] = res.data['id']
        res = self.call(client, 'post', '/api/products/items/', {
            'name': f'Frame {tag}', 'sku': f'FR-{tag}', 'barcode': f'BC{tag}', 'category': ids['category'],
            'brand': ids['brand'], 'cost_price': 250, 'retail_price': 1000, 'stock': 0})
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
        ids['sale_number'] = res.data['invoice_number']
        return ids


# =============================================================================================
# Organization model, migration backfill, membership rules
# =============================================================================================

class OrganizationModelTests(MultiCompanyFixture):
    def test_each_onboarded_client_is_its_own_organization(self):
        self.assertIsNotNone(self.ta.organization_id)
        self.assertNotEqual(self.ta.organization_id, self.tx.organization_id)
        self.assertEqual(self.tb.organization_id, self.ta.organization_id)
        self.assertTrue(OrganizationAdmin.objects.filter(organization=self.org, user=self.u_owner).exists())
        self.assertFalse(OrganizationAdmin.objects.filter(organization=self.org, user=self.u_acct).exists())

    def test_membership_never_crosses_organizations(self):
        with self.assertRaises(orgs.MembershipError):
            UserCompanyMembership.objects.create(user=self.u_outsider, company=self.tb, role='CASHIER')
        with self.assertRaises(orgs.MembershipError):
            UserCompanyMembership.objects.create(user=self.u_acct, company=self.tx, role='CASHIER')
        with self.assertRaises(orgs.MembershipError):  # home company needs no row
            UserCompanyMembership.objects.create(user=self.u_acct, company=self.ta, role='CASHIER')

    def test_forged_membership_row_across_organizations_grants_nothing(self):
        # Even a row written around save() (e.g. raw SQL) is ignored by the request-time check.
        UserCompanyMembership.objects.bulk_create([UserCompanyMembership(user=self.u_outsider, company=self.tb,
                                                                         role='SUPER_ADMIN')])
        cache.clear()
        self.assertIsNone(orgs.membership_role(self.u_outsider.pk, self.tx.pk, self.tb.pk))
        self.switch(self.outsider, self.tb, expect=403)

    def test_tenant_without_organization_is_given_one_lazily(self):
        legacy = Tenant.objects.create(name='Legacy Shop', code='legacy-shop')
        User = get_user_model()
        User.objects.create_user('legacyowner', password=PW, role='SUPER_ADMIN', tenant=legacy)
        self.assertIsNone(legacy.organization_id)
        client = self.login('legacyowner')
        legacy.refresh_from_db()
        self.assertIsNotNone(legacy.organization_id)
        self.assertEqual(AccessToken(client.tokens['access'])['org_id'], legacy.organization_id)
        self.assertTrue(orgs.is_org_admin(User.objects.get(username='legacyowner')))

    def test_company_scoped_user_copy_cannot_be_saved(self):
        member = orgs.company_user(self.u_acct, self.tb.pk)
        self.assertEqual(member.role, 'MANAGER')
        with self.assertRaises(RuntimeError):
            member.save()
        self.u_acct.refresh_from_db()
        self.assertEqual(self.u_acct.role, 'ACCOUNTANT')
        self.assertIsNone(orgs.company_user(self.u_cashier, self.tb.pk))

    def test_seats_count_active_memberships(self):
        from apps.common.tenant_onboarding import active_user_count
        self.assertEqual(active_user_count(self.tb), 2)  # owner + acct members, no home users yet


# =============================================================================================
# Login, company selector data, switching and token validation
# =============================================================================================

class CompanySwitchingTests(MultiCompanyFixture):
    def test_login_lists_accessible_companies(self):
        names = {c['name'] for c in self.login('owner').tokens['companies']}  # signed in after B exists
        self.assertEqual(names, {'Acme Optics', 'Acme Wholesale'})
        self.assertEqual({c['name'] for c in self.cashier.tokens['companies']}, {'Acme Optics'})
        self.assertEqual({c['name'] for c in self.outsider.tokens['companies']}, {'Other Customer'})
        acct = {c['name']: c['role'] for c in self.acct.tokens['companies']}
        self.assertEqual(acct, {'Acme Optics': 'ACCOUNTANT', 'Acme Wholesale': 'MANAGER'})

    def test_login_starts_in_home_company_with_org_claim(self):
        token = AccessToken(self.acct.tokens['access'])
        self.assertEqual(token['tenant_id'], self.ta.pk)
        self.assertEqual(token['org_id'], self.org.pk)
        self.assertEqual(self.acct.tokens['user']['active_company']['tenant_id'], self.ta.pk)
        self.assertEqual(self.acct.tokens['user']['company_count'], 2)

    def test_switch_issues_new_scoped_tokens_and_ends_old_session(self):
        b = self.switch(self.acct, self.tb)
        token = AccessToken(b.tokens['access'])
        self.assertEqual(token['tenant_id'], self.tb.pk)
        self.assertEqual(token['org_id'], self.org.pk)
        self.assertNotEqual(token['sid'], AccessToken(self.acct.tokens['access'])['sid'])
        profile = b.get('/api/auth/profile/').data
        self.assertEqual(profile['role'], 'MANAGER')                 # membership role in B
        self.assertIsNone(profile['workspace'])                      # a member, not a platform workspace
        self.assertIsNone(b.tokens['user']['workspace'])
        self.assertEqual(profile['active_company']['tenant_id'], self.tb.pk)
        self.assertFalse(profile['active_company']['is_home'])
        self.assertEqual(self.acct.get('/api/sales/customers/').status_code, 401)  # old session ended
        back = self.switch(b, self.ta)
        self.assertEqual(back.get('/api/auth/profile/').data['role'], 'ACCOUNTANT')

    def test_switch_refused_without_membership(self):
        self.switch(self.cashier, self.tb, expect=403)               # same org, no membership
        self.switch(self.cashier, self.tx, expect=403)               # another organization
        res = self.switch(self.cashier, 999999, expect=403)          # unknown id: same answer
        self.assertEqual(res.data['code'], 'company_forbidden')
        self.switch(self.outsider, self.ta, expect=403)
        self.assertEqual(self.cashier.get('/api/sales/customers/').status_code, 200)  # session intact

    def test_switch_rejects_garbage_and_workspace(self):
        res = self.cashier.post('/api/auth/switch-company/', {'tenant_id': 'abc'}, format='json')
        self.assertEqual(res.status_code, 400)
        self.assertEqual(APIClient().post('/api/auth/switch-company/', {'tenant_id': self.ta.pk},
                                          format='json').status_code, 401)

    def test_forged_company_claim_is_rejected(self):
        token = AccessToken(self.cashier.tokens['access'])
        token['tenant_id'] = self.tb.pk          # validly re-signed, but no membership in B
        forged = APIClient()
        forged.credentials(HTTP_AUTHORIZATION=f'Bearer {token}')
        self.assertEqual(forged.get('/api/sales/customers/').status_code, 401)
        self.assertEqual(forged.get('/api/masters/brands/').status_code, 401)   # AllowAny view too

    def test_mismatched_org_claim_is_rejected(self):
        b = self.switch(self.acct, self.tb)
        token = AccessToken(b.tokens['access'])
        token['org_id'] = self.tx.organization_id
        forged = APIClient()
        forged.credentials(HTTP_AUTHORIZATION=f'Bearer {token}')
        self.assertEqual(forged.get('/api/sales/customers/').status_code, 401)

    def test_revoked_membership_locks_the_member_out_at_once(self):
        b = self.switch(self.acct, self.tb)
        self.assertEqual(b.get('/api/sales/customers/').status_code, 200)
        res = self.owner.post(f'/api/organization/companies/{self.tb.pk}/members/',
                              {'user_id': str(self.u_acct.pk), 'role': 'MANAGER', 'is_active': False}, format='json')
        self.assertEqual(res.status_code, 200, res.data)
        self.assertEqual(b.get('/api/sales/customers/').status_code, 401)
        self.assertEqual(APIClient().post('/api/auth/token/refresh/', {'refresh': b.tokens['refresh']},
                                          format='json').status_code, 401)
        home = self.login('acct')
        self.switch(home, self.tb, expect=403)
        self.assertEqual({c['name'] for c in home.tokens['companies']}, {'Acme Optics'})

    def test_refresh_keeps_the_company(self):
        b = self.switch(self.acct, self.tb)
        res = APIClient().post('/api/auth/token/refresh/', {'refresh': b.tokens['refresh']}, format='json')
        self.assertEqual(res.status_code, 200, res.data)
        self.assertEqual(AccessToken(res.data['access'])['tenant_id'], self.tb.pk)

    def test_deactivated_user_and_company(self):
        b = self.switch(self.acct, self.tb)
        Tenant.objects.filter(pk=self.tb.pk).update(is_active=False)
        cache.clear()
        self.assertNotEqual(b.get('/api/sales/customers/').status_code, 200)
        self.switch(self.login('acct'), self.tb, expect=403)
        self.assertEqual({c['name'] for c in self.login('acct').tokens['companies']}, {'Acme Optics'})

    def test_companies_endpoint(self):
        res = self.acct.get('/api/auth/companies/')
        self.assertEqual(res.status_code, 200)
        active = [c for c in res.data['companies'] if c['is_active_company']]
        self.assertEqual([c['tenant_id'] for c in active], [self.ta.pk])
        self.assertFalse(res.data['is_org_admin'])

    def test_switch_is_audited(self):
        from apps.common.models import TenantAuditLog
        from apps.security.models import SecurityAuditLog
        self.switch(self.acct, self.tb)
        self.switch(self.cashier, self.tb, expect=403)
        self.assertTrue(SecurityAuditLog.objects.filter(event='COMPANY_SWITCHED').exists())
        self.assertTrue(SecurityAuditLog.objects.filter(event='COMPANY_SWITCH_DENIED').exists())
        self.assertTrue(TenantAuditLog.objects.filter(tenant=self.tb, action='COMPANY_SWITCH_IN').exists())

    def test_profile_cannot_change_role(self):
        res = self.cashier.patch('/api/auth/profile/', {'role': 'SUPER_ADMIN', 'first_name': 'Cash'}, format='json')
        self.assertEqual(res.status_code, 200, res.data)
        self.u_cashier.refresh_from_db()
        self.assertEqual(self.u_cashier.role, 'CASHIER')
        self.assertEqual(self.u_cashier.first_name, 'Cash')

    def test_member_profile_edit_saves_contact_details_only(self):
        b = self.switch(self.acct, self.tb)
        res = b.patch('/api/auth/profile/', {'first_name': 'Ann', 'role': 'SUPER_ADMIN'}, format='json')
        self.assertEqual(res.status_code, 200, res.data)
        self.assertEqual(res.data['role'], 'MANAGER')
        self.u_acct.refresh_from_db()
        self.assertEqual((self.u_acct.role, self.u_acct.first_name), ('ACCOUNTANT', 'Ann'))


# =============================================================================================
# Cross-company read / write / delete prevention
# =============================================================================================

class CrossCompanyIsolationTests(MultiCompanyFixture):
    def setUp(self):
        super().setUp()
        self.ids_a = self.create_set(self.owner, 'A')
        self.owner_b = self.switch(self.login('owner'), self.tb)
        self.ids_b = self.create_set(self.owner_b, 'B')

    DETAIL = (('product', '/api/products/items/{}/'), ('customer', '/api/sales/customers/{}/'),
              ('supplier', '/api/purchase/suppliers/{}/'), ('sale', '/api/sales/invoices/{}/'),
              ('purchase', '/api/purchase/invoices/{}/'), ('category', '/api/masters/categories/{}/'),
              ('brand', '/api/masters/brands/{}/'))
    LISTS = ('/api/products/items/', '/api/sales/customers/', '/api/purchase/suppliers/', '/api/sales/invoices/',
             '/api/purchase/invoices/', '/api/masters/categories/', '/api/masters/brands/', '/api/inventory/ledger/',
             '/api/financial/journals/', '/api/sales/payments/')

    def test_lists_never_show_the_other_companys_rows(self):
        a_ids = {str(v) for v in self.ids_a.values()}
        b_ids = {str(v) for v in self.ids_b.values()}
        for path in self.LISTS:
            in_b = self.owner_b.get(path)
            self.assertEqual(in_b.status_code, 200, path)
            self.assertFalse(ids_of(in_b) & a_ids, path)
            in_a = self.owner.get(path)
            self.assertFalse(ids_of(in_a) & b_ids, path)

    def test_direct_ids_of_the_other_company_are_unreachable(self):
        for key, pattern in self.DETAIL:
            url = pattern.format(self.ids_a[key])
            self.assertEqual(self.owner_b.get(url).status_code, 404, url)
            self.assertEqual(self.call(self.owner_b, 'patch', url, {'name': 'Hijack'}).status_code, 404, url)
            self.assertEqual(self.call(self.owner_b, 'delete', url).status_code, 404, url)
            self.assertEqual(self.owner.get(url).status_code, 200, url)  # still there in A

    def test_same_user_different_company_cannot_reference_other_company_rows(self):
        res = self.call(self.owner_b, 'post', '/api/sales/invoices/', {
            'customer_name': 'X', 'customer': self.ids_a['customer'], 'invoice_date': TODAY,
            'document_type': 'INVOICE', 'total_amount': '10', 'net_amount': '10', 'paid_amount': '10',
            'items': [{'product': self.ids_a['product'], 'quantity': 1, 'unit_price': '10', 'total': '10'}]})
        self.assertIn(res.status_code, (400, 403, 404), res.data)
        with tenancy.use_tenant(self.ta.pk):
            from apps.products.models import Product
            self.assertEqual(Product.objects.get(pk=self.ids_a['product']).stock, 1)  # 2 bought, 1 sold

    def test_company_in_request_body_is_ignored(self):
        res = self.call(self.owner_b, 'post', '/api/sales/customers/',
                        {'name': 'Spoof', 'phone': '9000000001', 'tenant': self.ta.pk, 'tenant_id': self.ta.pk})
        self.assertEqual(res.status_code, 201, res.data)
        self.assertIn(res.data['id'], ids_of(self.owner_b.get('/api/sales/customers/')))
        self.assertNotIn(res.data['id'], ids_of(self.owner.get('/api/sales/customers/')))

    def test_search_stays_inside_the_company(self):
        res = self.owner_b.get('/api/products/items/', {'search': 'Frame A'})
        self.assertFalse(ids_of(res) & {self.ids_a['product']})
        res = self.owner_b.get('/api/products/items/', {'search': 'BCA'})
        self.assertFalse(ids_of(res) & {self.ids_a['product']})

    def test_numbering_and_uniques_are_per_company(self):
        # The same codes are free in each company: separate masters, separate sequences.
        res = self.call(self.owner_b, 'post', '/api/masters/brands/', {'name': 'Brand A', 'code': 'BRA'})
        self.assertEqual(res.status_code, 201, res.data)

    def test_reports_and_exports_are_per_company(self):
        report_b = self.owner_b.get('/api/sales/invoices/report/')
        self.assertEqual(report_b.status_code, 200)
        # Invoice numbers are per company (both companies' first bill is INV-…-0001), so match by
        # id and customer instead.
        text_b = json.dumps(report_b.data, default=str)
        self.assertNotIn(self.ids_a['sale'], text_b)
        self.assertNotIn('Customer A', text_b)
        self.assertIn(self.ids_b['sale'], text_b)
        text_a = json.dumps(self.owner.get('/api/sales/invoices/report/').data, default=str)
        self.assertIn(self.ids_a['sale'], text_a)
        self.assertNotIn('Customer B', text_a)
        for client, other in ((self.owner, 'Customer B'), (self.owner_b, 'Customer A')):
            res = client.get('/api/financial/statements/', {'type': 'day_book', 'from_date': TODAY,
                                                             'to_date': TODAY, 'export': 'xlsx'})
            self.assertEqual(res.status_code, 200)
            text = _xlsx_text(res.content)
            self.assertNotIn(other, text)

    def test_financial_books_are_separate(self):
        a = rows(self.owner.get('/api/financial/journals/').data)
        b = rows(self.owner_b.get('/api/financial/journals/').data)
        self.assertTrue(a and b)
        self.assertFalse({r['id'] for r in a} & {r['id'] for r in b})


def _xlsx_text(content):
    from openpyxl import load_workbook
    wb = load_workbook(io.BytesIO(content), read_only=True)
    out = []
    for ws in wb.worksheets:
        for row in ws.iter_rows(values_only=True):
            out.extend(str(v) for v in row if v is not None)
    return '\n'.join(out)


# =============================================================================================
# Branch-level permissions inside each company
# =============================================================================================

class BranchWithinCompanyTests(MultiCompanyFixture):
    def setUp(self):
        super().setUp()
        from apps.company.models import Branch, BusinessSettings, Warehouse
        with tenancy.use_tenant(self.tb.pk):
            self.b_ho = Branch.objects.get(is_default=True)
            self.b_east = Branch.objects.create(company=self.b_ho.company, name='East', code='EST', is_active=True)
            Warehouse.objects.create(branch=self.b_east, name='East Store', code='EST-W')
            s = BusinessSettings.load()
            s.multi_branch_enabled = True
            s.save()
        # acct: MANAGER in B, Head Office only.
        res = self.owner.post(f'/api/organization/companies/{self.tb.pk}/members/',
                              {'user_id': str(self.u_acct.pk), 'role': 'MANAGER', 'branch_ids': [str(self.b_ho.pk)]},
                              format='json')
        self.assertEqual(res.status_code, 200, res.data)
        cache.clear()
        self.owner_b = self.switch(self.login('owner'), self.tb)
        self.acct_b = self.switch(self.login('acct'), self.tb)

    def _sale(self, client, branch, name):
        return self.call(client, 'post', '/api/sales/invoices/', {
            'customer_name': name, 'invoice_date': TODAY, 'document_type': 'INVOICE', 'total_amount': '10',
            'net_amount': '10', 'paid_amount': '10', 'items': []}, HTTP_X_BRANCH_ID=str(branch.pk))

    def test_restricted_member_sees_only_assigned_branch(self):
        east = self._sale(self.owner_b, self.b_east, 'East buyer')
        ho = self._sale(self.owner_b, self.b_ho, 'HO buyer')
        self.assertEqual(east.status_code, 201, east.data)
        self.assertEqual(ho.status_code, 201, ho.data)
        seen = ids_of(self.acct_b.get('/api/sales/invoices/'))
        self.assertIn(ho.data['id'], seen)
        self.assertNotIn(east.data['id'], seen)
        self.assertEqual(self.acct_b.get('/api/sales/invoices/', HTTP_X_BRANCH_ID=str(self.b_east.pk)).status_code, 403)
        self.assertEqual(self.acct_b.get(f"/api/sales/invoices/{east.data['id']}/").status_code, 404)

    def test_branch_context_reports_only_permitted_branches(self):
        res = self.acct_b.get('/api/company/branch-context/')
        self.assertEqual(res.status_code, 200)
        listed = {str(b['id']) for b in res.data.get('branches', [])}
        self.assertNotIn(str(self.b_east.pk), listed)

    def test_member_without_branch_row_has_no_branch(self):
        from apps.company.models import UserBranchAccess
        with tenancy.use_tenant(self.tb.pk):
            UserBranchAccess.objects.filter(user=self.u_acct).delete()
        cache.clear()
        res = self.acct_b.get('/api/sales/invoices/')
        self.assertEqual(rows(res.data), [])  # fail-closed (P1 decision 1)

    def test_home_company_branch_access_is_untouched(self):
        acct_a = self.login('acct')
        self.assertEqual(acct_a.get('/api/sales/invoices/').status_code, 200)
        from apps.company.models import UserBranchAccess
        with tenancy.use_tenant(self.ta.pk):
            self.assertFalse(UserBranchAccess.objects.filter(user=self.u_acct).exists())


# =============================================================================================
# Organization administration: authorization, company creation, memberships, copy-masters
# =============================================================================================

class OrganizationAdminTests(MultiCompanyFixture):
    def test_only_org_admins_reach_organization_endpoints(self):
        for client in (self.cashier, self.acct):
            self.assertEqual(client.get('/api/organization/').status_code, 403)
            self.assertEqual(client.post('/api/organization/companies/', {'name': 'Sneaky'}, format='json')
                             .status_code, 403)
            self.assertEqual(client.get('/api/organization/reports/sales-summary/').status_code, 403)
        self.assertIn(APIClient().get('/api/organization/').status_code, (401, 403))

    def test_other_customers_admin_cannot_touch_our_companies(self):
        mine = self.outsider.get('/api/organization/').data
        self.assertEqual({c['name'] for c in mine['companies']}, {'Other Customer'})
        for path in (f'/api/organization/companies/{self.tb.pk}/members/',
                     f'/api/organization/companies/{self.tb.pk}/branches/'):
            self.assertEqual(self.outsider.get(path).status_code, 404, path)
        res = self.outsider.post(f'/api/organization/companies/{self.tb.pk}/members/',
                                 {'user_id': str(self.u_outsider.pk), 'role': 'SUPER_ADMIN'}, format='json')
        self.assertEqual(res.status_code, 404)
        res = self.outsider.post(f'/api/organization/companies/{self.tx.pk}/copy-masters/',
                                 {'source_tenant_id': self.ta.pk, 'sections': ['brands']}, format='json')
        self.assertEqual(res.status_code, 404)
        self.assertEqual(self.outsider.patch(f'/api/organization/companies/{self.ta.pk}/', {'name': 'Mine now'},
                                             format='json').status_code, 404)
        users = {u['username'] for u in self.outsider.get('/api/organization/users/').data}
        self.assertEqual(users, {'outsider'})

    def test_granting_a_user_of_another_organization_is_refused(self):
        res = self.owner.post(f'/api/organization/companies/{self.tb.pk}/members/',
                              {'user_id': str(self.u_outsider.pk), 'role': 'CASHIER'}, format='json')
        self.assertEqual(res.status_code, 400)
        self.assertFalse(UserCompanyMembership.objects.filter(user=self.u_outsider).exists())

    def test_branch_of_another_company_cannot_be_assigned(self):
        from apps.company.models import Branch
        with tenancy.use_tenant(self.ta.pk):
            a_branch = Branch.objects.get(is_default=True)
        res = self.owner.post(f'/api/organization/companies/{self.tb.pk}/members/',
                              {'user_id': str(self.u_cashier.pk), 'role': 'CASHIER',
                               'branch_ids': [str(a_branch.pk)]}, format='json')
        self.assertEqual(res.status_code, 400)
        self.assertFalse(UserCompanyMembership.objects.filter(user=self.u_cashier, company=self.tb,
                                                             is_active=True).exists())

    def test_company_limit_is_enforced(self):
        self.assertEqual(self.owner.post('/api/organization/companies/', {'name': 'Acme Three'},
                                         format='json').status_code, 201)
        res = self.owner.post('/api/organization/companies/', {'name': 'Acme Four'}, format='json')
        self.assertEqual(res.status_code, 400)
        self.assertIn('may hold 3', res.data['detail'])
        res = self.outsider.post('/api/organization/companies/', {'name': 'Outsider Two'}, format='json')
        self.assertEqual(res.status_code, 400)  # migrated / onboarded customers stay at 1

    def test_new_company_has_independent_default_masters(self):
        from apps.company.models import Branch, Warehouse
        from apps.financial.models import ChartOfAccount
        for t in (self.ta, self.tb):
            with tenancy.use_tenant(t.pk):
                self.assertEqual(Branch.objects.filter(is_default=True).count(), 1)
                self.assertTrue(Warehouse.objects.exists())
                self.assertTrue(ChartOfAccount.objects.exists())
        with tenancy.use_tenant(self.ta.pk):
            a_coa = set(ChartOfAccount.objects.values_list('pk', flat=True))
        with tenancy.use_tenant(self.tb.pk):
            b_coa = set(ChartOfAccount.objects.values_list('pk', flat=True))
        self.assertFalse(a_coa & b_coa)
        self.assertEqual(self.tb.modules, self.ta.modules)

    def test_duplicate_company_name_refused(self):
        res = self.owner.post('/api/organization/companies/', {'name': 'other customer'}, format='json')
        self.assertEqual(res.status_code, 400)

    def test_rename(self):
        res = self.owner.patch(f'/api/organization/companies/{self.tb.pk}/', {'name': 'Acme Trade'}, format='json')
        self.assertEqual(res.status_code, 200, res.data)
        self.tb.refresh_from_db()
        self.assertEqual(self.tb.name, 'Acme Trade')

    def test_workspace_token_cannot_use_organization_endpoints(self):
        User = get_user_model()
        User.objects.create_superuser('platform', password=PW, tenant=Tenant.objects.get(pk=tenancy.DEFAULT_TENANT_ID))
        platform = self.login('platform')
        res = platform.post(f'/api/superadmin/tenants/{self.ta.pk}/workspace/', {}, format='json')
        self.assertEqual(res.status_code, 200, res.data)
        ws = APIClient()
        ws.credentials(HTTP_AUTHORIZATION=f"Bearer {res.data['access']}")
        self.assertEqual(ws.get('/api/organization/').status_code, 403)
        self.assertEqual(ws.post('/api/auth/switch-company/', {'tenant_id': self.tb.pk}, format='json').status_code, 400)

    def test_platform_admin_sets_company_limit(self):
        User = get_user_model()
        User.objects.create_superuser('platform', password=PW, tenant=Tenant.objects.get(pk=tenancy.DEFAULT_TENANT_ID))
        platform = self.login('platform')
        res = platform.patch(f'/api/superadmin/tenants/{self.tx.pk}/', {'max_companies': 2}, format='json')
        self.assertEqual(res.status_code, 200, res.data)
        self.assertEqual(Organization.objects.get(pk=self.tx.organization_id).max_companies, 2)
        self.assertEqual(platform.patch(f'/api/superadmin/tenants/{self.ta.pk}/', {'max_companies': 1},
                                        format='json').status_code, 400)  # already holds 2
        self.assertEqual(self.outsider.post('/api/organization/companies/', {'name': 'Outsider Two'},
                                            format='json').status_code, 201)


class CopyMasterDataTests(MultiCompanyFixture):
    def setUp(self):
        super().setUp()
        self.ids_a = self.create_set(self.owner, 'A')

    def test_copy_creates_independent_rows_without_stock_or_customers(self):
        from apps.products.models import Product as P
        with tenancy.use_tenant(self.ta.pk):  # the API stores brand as text; link the FK as imports do
            P.objects.filter(pk=self.ids_a['product']).update(brand_id=self.ids_a['brand'],
                                                              category_id=self.ids_a['category'])
        res = self.owner.post(f'/api/organization/companies/{self.tb.pk}/copy-masters/',
                              {'source_tenant_id': self.ta.pk, 'sections': ['products', 'suppliers', 'services']},
                              format='json')
        self.assertEqual(res.status_code, 200, res.data)
        self.assertEqual(res.data['sections']['products']['created'], 1)
        from apps.masters.models import Brand
        from apps.products.models import Product
        from apps.purchasing.models import Supplier
        from apps.sales.models import Customer
        with tenancy.use_tenant(self.tb.pk):
            copied = Product.objects.get(sku='FR-A')
            self.assertNotEqual(str(copied.pk), self.ids_a['product'])
            self.assertEqual(copied.stock, 0)
            self.assertEqual(copied.barcode, 'BCA')
            self.assertEqual(copied.brand.code, 'BRA')
            self.assertNotEqual(str(copied.brand_id), self.ids_a['brand'])
            self.assertTrue(Supplier.objects.filter(name='Supplier A').exists())
            self.assertIsNotNone(Supplier.objects.get(name='Supplier A').ledger_account_id)
            self.assertFalse(Customer.objects.filter(name='Customer A').exists())
            Brand.objects.filter(code='BRA').update(name='Changed in B')
        with tenancy.use_tenant(self.ta.pk):
            self.assertEqual(Brand.objects.get(code='BRA').name, 'Brand A')        # A untouched
            self.assertEqual(Product.objects.get(pk=self.ids_a['product']).stock, 1)
        again = self.owner.post(f'/api/organization/companies/{self.tb.pk}/copy-masters/',
                                {'source_tenant_id': self.ta.pk, 'sections': ['products']}, format='json')
        self.assertEqual(again.data['sections']['products'], {'created': 0, 'skipped': 1})

    def test_create_company_with_copy(self):
        res = self.owner.post('/api/organization/companies/', {'name': 'Acme Three', 'copy_from': self.ta.pk,
                                                               'sections': ['brands']}, format='json')
        self.assertEqual(res.status_code, 201, res.data)
        self.assertGreaterEqual(res.data['copied']['sections']['brands']['created'], 1)

    def test_copy_refusals(self):
        url = f'/api/organization/companies/{self.tb.pk}/copy-masters/'
        self.assertEqual(self.acct.post(url, {'source_tenant_id': self.ta.pk, 'sections': ['brands']},
                                        format='json').status_code, 403)
        self.assertEqual(self.owner.post(url, {'source_tenant_id': self.tx.pk, 'sections': ['brands']},
                                         format='json').status_code, 404)   # other organization
        self.assertEqual(self.owner.post(url, {'source_tenant_id': self.ta.pk, 'sections': ['customers']},
                                         format='json').status_code, 400)   # never copied
        self.assertEqual(self.owner.post(url, {'source_tenant_id': self.tb.pk, 'sections': ['brands']},
                                         format='json').status_code, 400)   # same company

    def test_org_admin_without_access_to_a_company_cannot_copy_from_it(self):
        UserCompanyMembership.objects.filter(user=self.u_owner, company=self.tb).update(is_active=False)
        cache.clear()
        res = self.owner.post(f'/api/organization/companies/{self.ta.pk}/copy-masters/',
                              {'source_tenant_id': self.tb.pk, 'sections': ['brands']}, format='json')
        self.assertEqual(res.status_code, 403)


# =============================================================================================
# Consolidated summaries (read-only)
# =============================================================================================

class ConsolidatedReportTests(MultiCompanyFixture):
    def setUp(self):
        super().setUp()
        self.ids_a = self.create_set(self.owner, 'A')
        self.ids_b = self.create_set(self.switch(self.login('owner'), self.tb), 'B')
        self.create_set(self.outsider, 'X')

    def test_sales_summary_covers_only_the_callers_companies(self):
        res = self.owner.get('/api/organization/reports/sales-summary/', {'date_from': TODAY, 'date_to': TODAY})
        self.assertEqual(res.status_code, 200, res.data)
        by = {r['name']: r for r in res.data['companies']}
        self.assertEqual(set(by), {'Acme Optics', 'Acme Wholesale'})
        self.assertEqual(by['Acme Optics']['retail_total'], '1000.00')
        self.assertEqual(by['Acme Wholesale']['retail_invoices'], 1)
        self.assertEqual(res.data['totals']['retail_total'], '2000.00')
        outsider = self.outsider.get('/api/organization/reports/sales-summary/').data
        self.assertEqual({r['name'] for r in outsider['companies']}, {'Other Customer'})

    def test_org_admin_working_inside_another_company_gets_the_same_summary(self):
        # In company B request.user is the member copy; the home company must still use the home
        # role (an admin role), not B's.
        from apps.company.models import BusinessSettings
        from apps.company.models import UserBranchAccess
        with tenancy.use_tenant(self.ta.pk):
            s = BusinessSettings.load()
            s.multi_branch_enabled = True
            s.save()
            # Only the owner's ROLE (Super Admin at home) now makes A company-wide for them.
            UserBranchAccess.objects.filter(user=self.u_owner).update(access_all_branches=False)
        UserCompanyMembership.objects.filter(user=self.u_owner, company=self.tb).update(role='CASHIER')
        with tenancy.use_tenant(self.tb.pk):
            UserBranchAccess.objects.filter(user=self.u_owner).update(access_all_branches=True)
        cache.clear()
        owner_b = self.switch(self.login('owner'), self.tb)
        self.assertEqual(owner_b.get('/api/auth/profile/').data['role'], 'CASHIER')
        res = owner_b.get('/api/organization/reports/sales-summary/', {'date_from': TODAY, 'date_to': TODAY})
        self.assertEqual(res.status_code, 200, res.data)
        self.assertEqual({r['name'] for r in res.data['companies']}, {'Acme Optics', 'Acme Wholesale'})
        roles = {c['name']: c['role'] for c in owner_b.get('/api/auth/companies/').data['companies']}
        self.assertEqual(roles, {'Acme Optics': 'SUPER_ADMIN', 'Acme Wholesale': 'CASHIER'})

    def test_stock_summary(self):
        res = self.owner.get('/api/organization/reports/stock-summary/')
        self.assertEqual(res.status_code, 200)
        by = {r['name']: r for r in res.data['companies']}
        self.assertEqual(by['Acme Optics']['units_on_hand'], 1)
        self.assertEqual(by['Acme Optics']['stock_value_retail'], '1000.00')

    def test_reports_never_change_books(self):
        from apps.financial.models import JournalEntry
        counts = {}
        for t in (self.ta, self.tb):
            with tenancy.use_tenant(t.pk):
                counts[t.pk] = JournalEntry.objects.count()
        self.owner.get('/api/organization/reports/sales-summary/')
        self.owner.get('/api/organization/reports/stock-summary/')
        for t in (self.ta, self.tb):
            with tenancy.use_tenant(t.pk):
                self.assertEqual(JournalEntry.objects.count(), counts[t.pk])

    def test_branch_restricted_company_is_excluded(self):
        from apps.company.models import BusinessSettings, UserBranchAccess
        OrganizationAdmin.objects.create(organization=self.org, user=self.u_acct)
        with tenancy.use_tenant(self.tb.pk):
            s = BusinessSettings.load()
            s.multi_branch_enabled = True
            s.save()
            access = UserBranchAccess.objects.get(user=self.u_acct)
            access.access_all_branches = False
            access.save()
        cache.clear()
        acct = self.login('acct')
        res = acct.get('/api/organization/reports/sales-summary/', {'date_from': TODAY, 'date_to': TODAY})
        self.assertEqual(res.status_code, 200, res.data)
        self.assertEqual({r['name'] for r in res.data['companies']}, {'Acme Optics'})
        self.assertEqual([e['name'] for e in res.data['excluded']], ['Acme Wholesale'])

    def test_csv_export(self):
        res = self.owner.get('/api/organization/reports/sales-summary/',
                             {'date_from': TODAY, 'date_to': TODAY, 'export': 'csv'})
        self.assertEqual(res.status_code, 200)
        text = res.content.decode('utf-8')
        self.assertIn('Acme Optics', text)
        self.assertNotIn('Other Customer', text)
        res = self.owner.get('/api/organization/reports/stock-summary/', {'export': 'csv'})
        self.assertIn('Acme Wholesale', res.content.decode('utf-8'))

    def test_bad_dates(self):
        res = self.owner.get('/api/organization/reports/sales-summary/', {'date_from': '2026-13-01'})
        self.assertEqual(res.status_code, 400)


# =============================================================================================
# Attachments and files
# =============================================================================================

class CompanyAttachmentTests(MultiCompanyFixture):
    def setUp(self):
        super().setUp()
        self.media = tempfile.mkdtemp(prefix='p2-media-')
        self.addCleanup(shutil.rmtree, self.media, True)
        over = override_settings(MEDIA_ROOT=self.media)
        over.enable()
        self.addCleanup(over.disable)
        from apps.purchasing.models import PurchaseInvoice, Supplier
        self.pinv = {}
        for key, t in (('a', self.ta), ('b', self.tb)):
            with tenancy.use_tenant(t.pk):
                sup = Supplier.objects.create(name=f'Lab {key}')
                self.pinv[key] = PurchaseInvoice.objects.create(invoice_number=f'PI-{key}', supplier=sup,
                                                                purchase_date=TODAY, status='DRAFT')
        self.owner_b = self.switch(self.login('owner'), self.tb)
        for client, key in ((self.owner, 'a'), (self.owner_b, 'b')):
            res = client.patch(f"/api/purchase/invoices/{self.pinv[key].pk}/",
                               {'attachment': SimpleUploadedFile('bill.pdf', PDF, content_type='application/pdf')},
                               format='multipart')
            self.assertEqual(res.status_code, 200, res.data)

    def test_files_are_stored_per_company_and_unreachable_from_the_other(self):
        from apps.purchasing.models import PurchaseInvoice
        with tenancy.use_tenant(self.tb.pk):
            stored = PurchaseInvoice.all_objects.get(pk=self.pinv['b'].pk).attachment.name
        self.assertTrue(stored.startswith(f'private/t{self.tb.pk}/'), stored)
        url_a = f"/api/purchase/invoices/{self.pinv['a'].pk}/attachment/"
        self.assertEqual(self.owner.get(url_a).status_code, 200)
        self.assertEqual(self.owner_b.get(url_a).status_code, 404)
        self.assertEqual(self.owner_b.get(f"/api/purchase/invoices/{self.pinv['a'].pk}/attachment-link/").status_code, 404)

    def test_signed_link_follows_membership(self):
        acct_b = self.switch(self.acct, self.tb)
        link = acct_b.get(f"/api/purchase/invoices/{self.pinv['b'].pk}/attachment-link/")
        self.assertEqual(link.status_code, 200, link.data)
        anon = APIClient()
        self.assertEqual(anon.get(link.data['url']).status_code, 200)
        UserCompanyMembership.objects.filter(user=self.u_acct, company=self.tb).update(is_active=False)
        cache.clear()
        self.assertEqual(anon.get(link.data['url']).status_code, 403)


# =============================================================================================
# Whole-database backups with several companies of one organization
# =============================================================================================

class MultiCompanyBackupGateTests(MultiCompanyFixture):
    def test_single_organization_keeps_whole_db_operations_for_org_admins_only(self):
        from apps.security.backup import policy
        # Two organizations on this test server (Acme + Other Customer, plus the default tenant).
        self.assertFalse(policy.whole_db_allowed())
        # A server holding only Acme's companies:
        Tenant.objects.filter(pk__in=[self.tx.pk, tenancy.DEFAULT_TENANT_ID]).update(organization=self.org)
        cache.clear()
        self.assertTrue(policy.whole_db_allowed())
        User = get_user_model()
        User.objects.create_user('admin2', password=PW, role='ADMINISTRATOR', tenant=self.ta)
        admin2 = self.login('admin2')
        self.assertEqual(admin2.get('/api/backups/history/').status_code, 403)          # not an org admin
        owner = self.login('owner')
        self.assertEqual(owner.get('/api/backups/history/').status_code, 200)
        payload = admin2.get('/api/security/settings/').data
        self.assertFalse(payload['server_wide_available'])
        self.assertTrue(owner.get('/api/security/settings/').data['server_wide_available'])

    def test_new_company_in_same_organization_keeps_the_backup_schedule(self):
        from apps.security.models import BackupSchedule
        Tenant.objects.update(organization=self.org)
        Organization.objects.filter(pk=self.org.pk).update(max_companies=10)
        cache.clear()
        BackupSchedule.objects.update_or_create(pk=1, defaults={'enabled': True})
        res = self.login('owner').post('/api/organization/companies/', {'name': 'Acme Three'}, format='json')
        self.assertEqual(res.status_code, 201, res.data)
        self.assertTrue(BackupSchedule.objects.get(pk=1).enabled)
        Tenant.objects.create(name='Stranger', code='stranger')  # a second customer appears
        self.assertFalse(BackupSchedule.objects.get(pk=1).enabled)


# =============================================================================================
# Migration and rollback safety
# =============================================================================================

@override_settings(TENANCY_ANONYMOUS_TENANT_ID=None)
class OrganizationMigrationTests(TransactionTestCase):
    """Reverse and re-apply the Phase 2 migrations on the test database: existing companies keep
    every record, each becomes exactly one organization, owners become its admins, nothing is
    split or merged, and the rollback leaves business data untouched."""

    def _migrate(self, target):
        from django.db import connection
        from django.db.migrations.executor import MigrationExecutor
        executor = MigrationExecutor(connection)
        executor.loader.build_graph()
        executor.migrate(target)

    def test_backfill_and_rollback(self):
        from apps.masters.models import Brand
        cache.clear()
        ta, _ = onboard_tenant(name='Shop One', admin_username='one', password=PW)
        tb, _ = onboard_tenant(name='Shop Two', admin_username='two', password=PW)
        with tenancy.use_tenant(ta.pk):
            Brand.objects.create(name='Keep A', code='KA')
        with tenancy.use_tenant(tb.pk):
            Brand.objects.create(name='Keep B', code='KB')
        try:
            self._migrate([('common', '0009_organizations')])   # undo the backfill
            self.assertEqual(Organization.objects.count(), 0)
            self.assertFalse(Tenant.objects.filter(organization__isnull=False).exists())
            self._migrate([('common', '0010_backfill_organizations')])
            self.assertFalse(Tenant.objects.filter(organization__isnull=True).exists())
            self.assertEqual(Organization.objects.count(), Tenant.objects.count())
            self.assertEqual(len(set(Tenant.objects.values_list('organization_id', flat=True))), Tenant.objects.count())
            self.assertTrue(set(Organization.objects.values_list('max_companies', flat=True)) == {1})
            for t, owner in ((ta, 'one'), (tb, 'two')):
                # Only the column this check needs: at 0010 the table lacks Tenant fields added later.
                t.refresh_from_db(fields=['organization'])
                self.assertTrue(OrganizationAdmin.objects.filter(organization_id=t.organization_id,
                                                                 user__username=owner).exists())
            self._migrate([('common', '0008_tenant_defaults_version')])  # full Phase 2 rollback
            from django.db import connection
            with connection.cursor() as c:
                c.execute("SELECT COUNT(*) FROM masters_brand WHERE code IN ('KA', 'KB')")
                self.assertEqual(c.fetchone()[0], 2)                      # business data untouched
        finally:
            from django.db.migrations.executor import MigrationExecutor
            from django.db import connection
            executor = MigrationExecutor(connection)
            executor.loader.build_graph()
            executor.migrate(executor.loader.graph.leaf_nodes())
        with tenancy.use_tenant(ta.pk):
            self.assertEqual(Brand.objects.get(code='KA').name, 'Keep A')
        with tenancy.use_tenant(tb.pk):
            self.assertFalse(Brand.objects.filter(code='KA').exists())


# =============================================================================================
# Direct Edit switches are per company (final verification, item 8)
# =============================================================================================

class PerCompanyEditPermissionTests(MultiCompanyFixture):
    """User.can_edit_* apply in the home company only; inside another company the switches are that
    company's, on the membership, managed by that company's admins."""

    def setUp(self):
        super().setUp()
        self.owner_b = self.switch(self.login('owner'), self.tb)
        self.inv_a = self._invoice(self.owner, 'Buyer A')
        self.inv_b = self._invoice(self.owner_b, 'Buyer B')
        # A role that may write sales at home too, so only the Direct Edit switch decides there.
        get_user_model().objects.filter(pk=self.u_acct.pk).update(role='MANAGER')
        self.u_acct.refresh_from_db()
        cache.clear()
        self.acct_b = self.switch(self.login('acct'), self.tb)
        self.acct_a = self.login('acct')

    def _invoice(self, client, name):
        res = self.call(client, 'post', '/api/sales/invoices/', {
            'customer_name': name, 'invoice_date': TODAY, 'document_type': 'INVOICE', 'total_amount': '10',
            'net_amount': '10', 'paid_amount': '10', 'items': []})
        self.assertEqual(res.status_code, 201, res.data)
        return res.data['id']

    def _edit(self, client, inv):
        return self.call(client, 'patch', f'/api/sales/invoices/{inv}/', {'salesman': 'Edited'})

    def _membership(self):
        return UserCompanyMembership.objects.get(user=self.u_acct, company=self.tb)

    def test_home_switch_does_not_leak_into_another_company(self):
        res = self.owner.patch(f'/api/auth/edit-permissions/{self.u_acct.pk}/', {'can_edit_sales': False},
                               format='json')
        self.assertEqual(res.status_code, 200, res.data)
        self.assertTrue(self._membership().can_edit_sales)
        self.assertEqual(self._edit(self.acct_a, self.inv_a).data.get('code'), 'edit_approval_required')
        self.assertEqual(self._edit(self.acct_b, self.inv_b).status_code, 200)

    def test_company_b_admin_controls_the_member_in_b_only(self):
        matrix = self.owner_b.get('/api/auth/edit-permissions/').data
        row = next(u for u in matrix['users'] if u['id'] == str(self.u_acct.pk))
        self.assertTrue(row['is_member'])
        self.assertEqual(row['role'], 'MANAGER')
        res = self.owner_b.patch(f'/api/auth/edit-permissions/{self.u_acct.pk}/', {'can_edit_sales': False},
                                 format='json')
        self.assertEqual(res.status_code, 200, res.data)
        self.assertFalse(self._membership().can_edit_sales)
        self.u_acct.refresh_from_db()
        self.assertTrue(self.u_acct.can_edit_sales)                       # account untouched
        res = self._edit(self.acct_b, self.inv_b)
        self.assertEqual((res.status_code, res.data.get('code')), (403, 'edit_approval_required'))
        self.assertEqual(self._edit(self.acct_a, self.inv_a).status_code, 200)  # home company unaffected
        self.assertFalse(self.acct_b.get('/api/auth/profile/').data['edit_permissions']['sales'])
        self.assertTrue(self.acct_a.get('/api/auth/profile/').data['edit_permissions']['sales'])

    def test_admin_of_one_company_cannot_set_switches_for_another(self):
        User = get_user_model()
        b_home = User.objects.create_user('bhome', password=PW, role='CASHIER', tenant=self.tb)
        User.objects.create_user('admin_a', password=PW, role='ADMINISTRATOR', tenant=self.ta)
        admin_a = self.login('admin_a')
        self.assertEqual(admin_a.patch(f'/api/auth/edit-permissions/{b_home.pk}/', {'can_edit_sales': False},
                                       format='json').status_code, 404)
        b_home.refresh_from_db()
        self.assertTrue(b_home.can_edit_sales)
        listed = {u['id'] for u in admin_a.get('/api/auth/edit-permissions/').data['users']}
        self.assertNotIn(str(b_home.pk), listed)

    def test_edit_request_and_approval_stay_in_the_company(self):
        UserCompanyMembership.objects.filter(pk=self._membership().pk).update(can_edit_sales=False)
        cache.clear()
        req = self.acct_b.post('/api/auth/edit-requests/', {'module': 'sales', 'record_id': self.inv_b,
                                                             'record_ref': 'B bill', 'reason': 'Fix salesman'},
                               format='json')
        self.assertEqual(req.status_code, 201, req.data)
        self.assertNotIn(req.data['id'], {r['id'] for r in rows(self.owner.get('/api/auth/edit-requests/').data)})
        self.assertIn(req.data['id'], {r['id'] for r in rows(self.owner_b.get('/api/auth/edit-requests/').data)})
        res = self.owner_b.post(f"/api/auth/edit-requests/{req.data['id']}/approve/", {'note': 'ok'}, format='json')
        self.assertEqual(res.status_code, 200, res.data)
        self.assertEqual(self._edit(self.acct_b, self.inv_b).status_code, 200)
        self.assertEqual(self._edit(self.acct_b, self.inv_b).status_code, 403)   # single use

    def test_new_membership_starts_with_switches_on_and_revoked_member_is_not_listed(self):
        self.assertTrue(all(getattr(self._membership(), f) for f in orgs.EDIT_FLAGS))
        self.owner.post(f'/api/organization/companies/{self.tb.pk}/members/',
                        {'user_id': str(self.u_acct.pk), 'role': 'MANAGER', 'is_active': False}, format='json')
        listed = {u['id'] for u in self.owner_b.get('/api/auth/edit-permissions/').data['users']}
        self.assertNotIn(str(self.u_acct.pk), listed)


class P1BranchControlsInSecondCompanyTests(BranchWithinCompanyTests):
    """Final verification item 9: Phase 1 branch controls hold for a branch-restricted MEMBER inside a
    second company (financial reports B-3, voucher posting B-4, stock transfers B-6, branch header)."""

    def setUp(self):
        super().setUp()
        res = self.owner.post(f'/api/organization/companies/{self.tb.pk}/members/',
                              {'user_id': str(self.u_cashier.pk), 'role': 'ACCOUNTANT',
                               'branch_ids': [str(self.b_ho.pk)]}, format='json')
        self.assertEqual(res.status_code, 200, res.data)
        cache.clear()
        self.acc_b = self.switch(self.login('cashier'), self.tb)
        from apps.inventory.stock_utils import adjust_branch_stock
        from apps.products.models import Product
        with tenancy.use_tenant(self.tb.pk):
            self.product = Product.objects.create(name='B Frame', sku='B-FR-1', stock=0)
            adjust_branch_stock(self.product, self.b_ho, 10)
            adjust_branch_stock(self.product, self.b_east, 5)

    def test_financial_report_for_another_branch_is_refused(self):
        url = '/api/financial/reports/trial-balance/'
        self.assertEqual(self.acc_b.get(url, {'branch': str(self.b_east.pk)}).status_code, 403)
        self.assertEqual(self.acc_b.get(url, {'branch': str(self.b_ho.pk)}).status_code, 200)
        self.assertEqual(self.owner_b.get(url, {'branch': str(self.b_east.pk)}).status_code, 200)

    def test_voucher_into_another_branch_is_refused(self):
        from apps.financial.models import JournalEntry
        body = {'voucher_type_code': 'RV', 'date': TODAY, 'status': 'POSTED', 'narration': 'Receipt',
                'lines': [{'account': '1001', 'debit': '25'}, {'account': '4001', 'credit': '25'}]}
        with tenancy.use_tenant(self.tb.pk):
            before = JournalEntry.objects.count()
        res = self.call(self.acc_b, 'post', '/api/financial/journals/', {**body, 'branch': str(self.b_east.pk)})
        self.assertEqual(res.status_code, 403, res.data)
        with tenancy.use_tenant(self.tb.pk):
            self.assertEqual(JournalEntry.objects.count(), before)
        res = self.call(self.acc_b, 'post', '/api/financial/journals/', {**body, 'branch': str(self.b_ho.pk)})
        self.assertEqual(res.status_code, 201, res.data)

    def test_stock_transfer_branch_authorization(self):
        api = '/api/company/stock-transfers/'
        item = [{'product': str(self.product.pk), 'quantity': 1}]
        res = self.acct_b.post(api, {'from_branch': str(self.b_east.pk), 'to_branch': str(self.b_ho.pk),
                                     'items': item}, format='json')
        self.assertEqual(res.status_code, 403, res.data)                   # not their origin branch
        res = self.acct_b.post(api, {'from_branch': str(self.b_ho.pk), 'to_branch': str(self.b_east.pk),
                                     'items': item}, format='json')
        self.assertEqual(res.status_code, 201, res.data)
        t = res.data
        self.assertEqual(self.acct_b.post(f"{api}{t['id']}/dispatch/", {}, format='json').status_code, 200)
        self.assertEqual(self.acct_b.post(f"{api}{t['id']}/receive/", {}, format='json').status_code, 403)
        self.assertEqual(self.owner.get(f"{api}{t['id']}/").status_code, 404)       # company A session

    def test_branch_of_the_other_company_in_header_is_refused(self):
        from apps.company.models import Branch
        with tenancy.use_tenant(self.ta.pk):
            a_branch = Branch.objects.get(is_default=True)
        self.assertEqual(self.acct_b.get('/api/sales/invoices/', HTTP_X_BRANCH_ID=str(a_branch.pk)).status_code, 403)
