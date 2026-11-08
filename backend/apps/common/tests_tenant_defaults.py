"""Default masters for newly provisioned clients, and the branch every session binds to.

Clients created in Client Management must be able to save and search from their first request:
the onboarding creates the Head Office branch, its Main Warehouse, the ledger groups, business
settings, the owner's branch binding and the starter lists — and a client created before one of
those existed receives it at its next sign-in (Tenant.defaults_version).
"""
import io

from django.contrib.auth import get_user_model
from django.core.management import call_command

from apps.common import tenancy
from apps.common.models import Tenant
from apps.common.tenant_onboarding import DEFAULTS_VERSION, ensure_tenant_defaults, onboard_tenant
from apps.common.tests_tenant_crud import PW, TenantFixture, rows


def counts(tenant):
    from apps.billing.models import BillTemplate
    from apps.company.models import Branch, BusinessSettings, UserBranchAccess, Warehouse
    from apps.financial.models import AccountMapping, ChartOfAccount
    from apps.masters.models import ProductCategory
    from apps.products.models import LabelTemplate
    from apps.sales.models import Service
    with tenancy.use_tenant(tenant.pk):
        default = Branch.objects.get(is_default=True)
        settings_row = BusinessSettings.objects.get()
        return {
            'branches': list(Branch.objects.values_list('name', 'code', 'is_default')),
            'warehouses': list(Warehouse.objects.values_list('branch_id', 'code')),
            'default_branch': default,
            'settings_default': settings_row.default_branch_id,
            'access': {a.username: (a.access_all_branches, a.default_branch_id)
                       for a in UserBranchAccess.objects.all()},
            'accounts': ChartOfAccount.objects.count(),
            'mappings': AccountMapping.objects.count(),
            'categories': ProductCategory.objects.count(),
            'services': Service.objects.count(),
            'bill_templates': BillTemplate.objects.count(),
            'label_templates': LabelTemplate.objects.count(),
        }


class OnboardingDefaultsTests(TenantFixture):
    def test_new_client_gets_every_default_master(self):
        c = counts(self.ta)
        self.assertEqual(c['branches'], [('Head Office', 'HO', True)])  # one primary branch, no "Default"
        self.assertEqual(c['warehouses'], [(c['default_branch'].pk, 'WH-MAIN')])
        self.assertEqual(c['settings_default'], c['default_branch'].pk)
        self.assertEqual(c['access'], {'clienta': (True, c['default_branch'].pk)})
        self.assertGreater(c['accounts'], 10)
        self.assertGreater(c['mappings'], 5)
        self.assertEqual(c['categories'], 10)
        self.assertEqual(c['services'], 5)
        self.assertGreater(c['bill_templates'], 0)
        self.assertGreater(c['label_templates'], 0)
        self.ta.refresh_from_db()
        self.assertEqual(self.ta.defaults_version, DEFAULTS_VERSION)

    def test_every_client_gets_bill_templates_not_just_the_first(self):
        # The seed flag used to be one per process: once any tenant was seeded, later clients
        # never received templates until a restart.
        tc, _ = onboard_tenant(name='Client C', admin_username='clientc', password=PW)
        self.assertGreater(counts(tc)['bill_templates'], 0)
        self.assertEqual(counts(tc)['bill_templates'], counts(self.tb)['bill_templates'])

    def test_defaults_are_idempotent(self):
        before = counts(self.ta)
        self.assertEqual(ensure_tenant_defaults(self.ta), [])
        self.assertEqual(counts(self.ta), before)

    def test_owner_session_binds_to_head_office(self):
        res = self.a.get('/api/company/branch-context/')
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.data['active_branch']['name'], 'Head Office')
        self.assertEqual([b['name'] for b in res.data['branches']], ['Head Office'])


class HealAtSignInTests(TenantFixture):
    def strip(self, tenant):
        """Reduce a client to what older onboarding left behind."""
        from apps.company.models import BusinessSettings, UserBranchAccess, Warehouse
        with tenancy.use_tenant(tenant.pk):
            Warehouse.all_objects.all().delete()
            UserBranchAccess.objects.all().delete()
            BusinessSettings.objects.update(default_branch=None)
        Tenant.objects.filter(pk=tenant.pk).update(defaults_version=0)

    def test_older_client_is_completed_at_its_next_sign_in(self):
        self.strip(self.ta)
        self.login('clienta')
        c = counts(self.ta)
        self.assertEqual(len(c['warehouses']), 1)
        self.assertEqual(c['settings_default'], c['default_branch'].pk)
        self.assertEqual(c['access'], {'clienta': (True, c['default_branch'].pk)})
        self.ta.refresh_from_db()
        self.assertEqual(self.ta.defaults_version, DEFAULTS_VERSION)
        # …and the other client is untouched.
        self.assertEqual(len(counts(self.tb)['warehouses']), 1)

    def test_client_without_a_default_branch_gets_one(self):
        from apps.company.models import Branch
        with tenancy.use_tenant(self.ta.pk):
            Branch.objects.update(is_default=False)
        Tenant.objects.filter(pk=self.ta.pk).update(defaults_version=0)
        self.login('clienta')
        self.assertEqual(counts(self.ta)['branches'], [('Head Office', 'HO', True)])

    def test_management_command_fills_every_client(self):
        self.strip(self.ta)
        self.strip(self.tb)
        call_command('ensure_tenant_defaults', stdout=io.StringIO())
        self.assertEqual(len(counts(self.ta)['warehouses']), 1)
        self.assertEqual(len(counts(self.tb)['warehouses']), 1)

    def test_stock_adjustment_without_a_warehouse_uses_the_branch_one(self):
        res = self.call(self.a, 'post', '/api/products/items/', {
            'name': 'Frame X', 'sku': 'FR-X', 'cost_price': 100, 'retail_price': 300, 'stock': 0})
        self.assertEqual(res.status_code, 201, res.data)
        res = self.call(self.a, 'post', '/api/inventory/adjustments/', {
            'product': res.data['id'], 'quantity': 4, 'adjustment_type': 'ADD', 'reason': 'Opening count'})
        self.assertEqual(res.status_code, 201, res.data)
        from apps.company.models import Warehouse
        with tenancy.use_tenant(self.ta.pk):
            self.assertEqual(str(res.data['warehouse']), str(Warehouse.objects.get(code='WH-MAIN').pk))


class StaffBranchBindingTests(TenantFixture):
    def setUp(self):
        super().setUp()
        from apps.company.models import Branch, BusinessSettings, Company
        with tenancy.use_tenant(self.ta.pk):
            self.ho = Branch.objects.get(is_default=True)
            self.city = Branch.objects.create(company=Company.objects.get(), name='City Branch', code='CITY')
            settings_row = BusinessSettings.load()
            settings_row.multi_branch_enabled = True
            settings_row.save()
        self.a = self.login('clienta')

    def add_staff(self, **access):
        res = self.call(self.a, 'post', '/api/auth/users/', {
            'username': 'optom', 'password': PW, 'role': 'OPTOMETRIST', 'is_active': True,
            'first_name': 'Opto', 'last_name': 'Metrist', **access})
        self.assertEqual(res.status_code, 201, res.data)
        return self.login('optom')

    def test_assigned_branch_becomes_the_default_without_picking_one(self):
        staff = self.add_staff(access_all_branches=False, branch_ids=[str(self.city.pk)])
        from apps.company.models import UserBranchAccess
        with tenancy.use_tenant(self.ta.pk):
            self.assertEqual(UserBranchAccess.objects.get(username='optom').default_branch_id, self.city.pk)
        res = staff.get('/api/company/branch-context/')
        self.assertEqual(res.data['active_branch']['id'], str(self.city.pk))
        self.assertEqual([b['name'] for b in res.data['branches']], ['City Branch'])

    def test_a_previous_users_branch_falls_back_to_the_staff_branch(self):
        staff = self.add_staff(access_all_branches=False, branch_ids=[str(self.city.pk)],
                               default_branch_id=str(self.city.pk))
        # The browser still holds the owner's Head Office pick, which this user may not use.
        res = staff.get('/api/company/branch-context/', HTTP_X_BRANCH_ID=str(self.ho.pk))
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.data['active_branch']['id'], str(self.city.pk))

    def test_staff_user_can_save_patient_records(self):
        staff = self.add_staff(access_all_branches=False, branch_ids=[str(self.city.pk)])
        res = self.call(staff, 'post', '/api/sales/customers/', {'name': 'Walk-in', 'phone': '9876543210'})
        self.assertEqual(res.status_code, 201, res.data)
        res = self.call(staff, 'post', '/api/sales/eye-examinations/', {
            'patient': res.data['id'], 'patient_id': res.data['patient_code'], 'patient_name': 'Walk-in',
            'exam_date': '2026-11-08'})
        self.assertIn(res.status_code, (200, 201), res.data)
        listed = rows(staff.get('/api/sales/customers/').data)
        self.assertEqual([c['name'] for c in listed], ['Walk-in'])
        User = get_user_model()
        self.assertEqual(User.objects.get(username='optom').role, 'OPTOMETRIST')

    def test_multi_branch_dashboard_loads_for_staff(self):
        # EyeExamination.branch is a text field; scoping it as a Branch FK used to 500.
        staff = self.add_staff(access_all_branches=False, branch_ids=[str(self.city.pk)])
        res = staff.get('/api/sales/dashboard-summary/')
        self.assertEqual(res.status_code, 200, res.content[:300])
