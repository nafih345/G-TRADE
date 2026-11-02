"""Row-level tenant isolation (apps/common/tenancy.py, tenant_context.py)."""
from django.contrib.auth import get_user_model
from django.test import TestCase, override_settings
from rest_framework.test import APIClient

from apps.common import tenancy
from apps.common.models import Tenant
from apps.common.sequences import bump_sequence
from apps.masters.models import Brand
from apps.sales.models import Customer, PatientCodeSequence

PASSWORD = 'Str0ng-pass-123'

# Built at import time, outside any tenant — like a viewset's `queryset = ...` attribute.
CLASS_LEVEL_QS = Customer.objects.all()


class TenantFixture(TestCase):
    def setUp(self):
        self.t1 = Tenant.objects.get(pk=tenancy.DEFAULT_TENANT_ID)
        self.t2 = Tenant.objects.create(name='Client Two', code='client-two')
        with tenancy.use_tenant(self.t1.pk):
            self.c1 = Customer.objects.create(name='Alice (client 1)')
        with tenancy.use_tenant(self.t2.pk):
            self.c2 = Customer.objects.create(name='Bob (client 2)')


class OrmIsolationTests(TenantFixture):
    def test_rows_are_stamped_with_the_creating_tenant(self):
        self.assertEqual(self.c1.tenant_id, self.t1.pk)
        self.assertEqual(self.c2.tenant_id, self.t2.pk)

    def test_each_tenant_sees_only_its_rows(self):
        with tenancy.use_tenant(self.t2.pk):
            self.assertEqual(list(Customer.objects.values_list('name', flat=True)), ['Bob (client 2)'])
            self.assertFalse(Customer.objects.filter(pk=self.c1.pk).exists())
            self.assertFalse(Customer.all_objects.filter(pk=self.c1.pk).exists())
            with self.assertRaises(Customer.DoesNotExist):
                Customer.objects.get(pk=self.c1.pk)

    def test_import_time_queryset_is_scoped_when_used(self):
        with tenancy.use_tenant(self.t2.pk):
            self.assertEqual([c.pk for c in CLASS_LEVEL_QS.all()], [self.c2.pk])
            self.assertEqual(CLASS_LEVEL_QS.count(), 1)
            self.assertEqual(CLASS_LEVEL_QS.filter(name__startswith='Alice').count(), 0)
        with tenancy.use_tenant(self.t1.pk):
            self.assertEqual([c.pk for c in CLASS_LEVEL_QS.all()], [self.c1.pk])

    def test_bulk_update_and_delete_never_reach_another_tenant(self):
        with tenancy.use_tenant(self.t2.pk):
            self.assertEqual(Customer.objects.filter(pk=self.c1.pk).update(name='hijacked'), 0)
            Customer.objects.all().delete()  # soft delete, own rows only
        with tenancy.unscoped():
            self.c1.refresh_from_db()
            self.assertEqual(self.c1.name, 'Alice (client 1)')
            self.assertFalse(self.c1.is_deleted)

    def test_saving_another_tenants_row_is_refused(self):
        with tenancy.use_tenant(self.t2.pk):
            self.c1.name = 'hijacked'
            with self.assertRaises(tenancy.CrossTenantWrite):
                self.c1.save()

    def test_tenant_cannot_be_moved_by_update(self):
        with tenancy.use_tenant(self.t2.pk):
            with self.assertRaises(tenancy.CrossTenantWrite):
                Customer.objects.filter(pk=self.c2.pk).update(tenant_id=self.t1.pk)

    def test_fk_to_another_tenants_row_is_refused(self):
        from apps.sales.models import Invoice
        with tenancy.use_tenant(self.t2.pk):
            with self.assertRaises(tenancy.CrossTenantWrite):
                Invoice.objects.create(customer=self.c1, invoice_number='X-1', customer_name='x')

    def test_strict_context_without_tenant_sees_and_writes_nothing(self):
        token = tenancy.activate(None, strict=True)
        try:
            self.assertEqual(Customer.objects.count(), 0)
            self.assertEqual(CLASS_LEVEL_QS.count(), 0)
            with self.assertRaises(tenancy.TenantRequired):
                Customer.objects.create(name='anonymous')
        finally:
            tenancy.deactivate(token)

    def test_unique_values_are_per_tenant(self):
        with tenancy.use_tenant(self.t1.pk):
            Brand.objects.create(name='Ray', code='RB')
        with tenancy.use_tenant(self.t2.pk):
            Brand.objects.create(name='Ray', code='RB')  # no IntegrityError
            self.assertEqual(Brand.objects.count(), 1)

    def test_sequences_are_per_tenant(self):
        with tenancy.use_tenant(self.t1.pk):
            self.assertEqual(bump_sequence(PatientCodeSequence, {'prefix': 'Q'}, defaults={'last_number': 0}), 1)
            self.assertEqual(bump_sequence(PatientCodeSequence, {'prefix': 'Q'}, defaults={'last_number': 0}), 2)
        with tenancy.use_tenant(self.t2.pk):
            self.assertEqual(bump_sequence(PatientCodeSequence, {'prefix': 'Q'}, defaults={'last_number': 0}), 1)

    def test_singletons_are_per_tenant(self):
        from apps.company.models import BusinessSettings
        from apps.financial.models import AccountingPolicy
        from apps.products.models import BarcodeSeriesConfig, LabelPrintSettings
        for model, load in ((AccountingPolicy, 'get'), (BarcodeSeriesConfig, 'load'),
                            (LabelPrintSettings, 'load'), (BusinessSettings, 'load')):
            with tenancy.use_tenant(self.t1.pk):
                a = getattr(model, load)()
            with tenancy.use_tenant(self.t2.pk):
                b = getattr(model, load)()
                self.assertEqual(getattr(model, load)().pk, b.pk)
            self.assertNotEqual(a.pk, b.pk, model.__name__)
            self.assertEqual((a.tenant_id, b.tenant_id), (self.t1.pk, self.t2.pk))


class ApiIsolationTests(TenantFixture):
    def setUp(self):
        super().setUp()
        User = get_user_model()
        User.objects.create_user('owner1', password=PASSWORD, role='SUPER_ADMIN', tenant=self.t1)
        User.objects.create_user('owner2', password=PASSWORD, role='SUPER_ADMIN', tenant=self.t2)
        self.api1, self.tokens1 = self._login('owner1')
        self.api2, self.tokens2 = self._login('owner2')

    def _login(self, username):
        client = APIClient()
        res = client.post('/api/auth/login/', {'username': username, 'password': PASSWORD}, format='json')
        self.assertEqual(res.status_code, 200, res.content)
        client.credentials(HTTP_AUTHORIZATION=f"Bearer {res.data['access']}")
        return client, res.data

    def _ids(self, res):
        rows = res.data['results'] if isinstance(res.data, dict) and 'results' in res.data else res.data
        return {str(r['id']) for r in rows}

    def test_token_carries_tenant_id(self):
        from rest_framework_simplejwt.tokens import AccessToken
        self.assertEqual(AccessToken(self.tokens1['access'])['tenant_id'], self.t1.pk)
        self.assertEqual(AccessToken(self.tokens2['access'])['tenant_id'], self.t2.pk)
        self.assertEqual(self.tokens2['user']['tenant'], self.t2.pk)

    def test_list_returns_only_own_rows(self):
        self.assertEqual(self._ids(self.api1.get('/api/sales/customers/')), {str(self.c1.pk)})
        self.assertEqual(self._ids(self.api2.get('/api/sales/customers/')), {str(self.c2.pk)})

    def test_detail_update_delete_of_other_tenant_are_404(self):
        url = f'/api/sales/customers/{self.c1.pk}/'
        self.assertEqual(self.api2.get(url).status_code, 404)
        self.assertEqual(self.api2.patch(url, {'name': 'hijacked'}, format='json').status_code, 404)
        self.assertEqual(self.api2.delete(url).status_code, 404)
        self.assertEqual(self.api1.get(url).status_code, 200)

    def test_create_ignores_tenant_in_body(self):
        res = self.api2.post('/api/masters/brands/', {'name': 'Oakley', 'code': 'OK', 'tenant': self.t1.pk,
                                                      'tenant_id': self.t1.pk}, format='json')
        self.assertEqual(res.status_code, 201, res.content)
        with tenancy.unscoped():
            self.assertEqual(Brand.objects.get(pk=res.data['id']).tenant_id, self.t2.pk)
        self.assertEqual(self._ids(self.api1.get('/api/masters/brands/')), set())

    def test_duplicate_code_is_400_within_tenant_but_allowed_across(self):
        body = {'name': 'Oakley', 'code': 'OK'}
        self.assertEqual(self.api1.post('/api/masters/brands/', body, format='json').status_code, 201)
        dup = self.api1.post('/api/masters/brands/', body, format='json')
        self.assertEqual(dup.status_code, 400)
        self.assertIn('code', dup.data)
        self.assertEqual(self.api2.post('/api/masters/brands/', body, format='json').status_code, 201)

    @override_settings(TENANCY_ANONYMOUS_TENANT_ID=None)
    def test_request_without_token_sees_no_tenant_data(self):
        res = APIClient().get('/api/masters/brands/')  # AllowAny, no authentication classes
        self.assertEqual(self._ids(res), set())

    def test_forged_tenant_claim_is_rejected(self):
        from rest_framework_simplejwt.tokens import AccessToken
        token = AccessToken(self.tokens2['access'])
        token['tenant_id'] = self.t1.pk  # re-signed with the server key: user/tenant mismatch
        client = APIClient()
        client.credentials(HTTP_AUTHORIZATION=f'Bearer {token}')
        self.assertEqual(client.get('/api/sales/invoices/').status_code, 401)

    def test_user_without_tenant_cannot_sign_in(self):
        get_user_model().objects.create_user('orphan', password=PASSWORD, role='SUPER_ADMIN', tenant=None)
        res = APIClient().post('/api/auth/login/', {'username': 'orphan', 'password': PASSWORD}, format='json')
        self.assertEqual(res.status_code, 401)
        self.assertEqual(res.data['code'], 'no_tenant')

    def test_backups_are_off_with_several_tenants(self):
        self.assertEqual(self.api1.get('/api/backups/history/').status_code, 403)
