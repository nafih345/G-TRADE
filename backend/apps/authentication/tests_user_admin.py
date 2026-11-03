"""Administration → Users: /api/auth/users/ (apps/authentication/user_admin.py)."""
from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.test import TestCase
from rest_framework.test import APIClient

from apps.common.models import Tenant

PASSWORD = 'Str0ng-pass-123'
URL = '/api/auth/users/'


class StaffUserAdminTests(TestCase):
    def setUp(self):
        cache.clear()
        self.addCleanup(cache.clear)
        User = get_user_model()
        self.shop = Tenant.objects.create(name='City Opticals', code='city', max_users=10)
        self.other = Tenant.objects.create(name='Other Shop', code='other-shop')
        User.objects.create_user('owner', password=PASSWORD, role='SUPER_ADMIN', tenant=self.shop)
        User.objects.create_user('admin1', password=PASSWORD, role='ADMINISTRATOR', tenant=self.shop)
        User.objects.create_user('seller', password=PASSWORD, role='SALES_EXECUTIVE', tenant=self.shop)
        User.objects.create_user('otherowner', password=PASSWORD, role='SUPER_ADMIN', tenant=self.other)

    def _login(self, username, password=PASSWORD):
        client = APIClient()
        res = client.post('/api/auth/login/', {'username': username, 'password': password}, format='json')
        self.assertEqual(res.status_code, 200, res.content)
        client.credentials(HTTP_AUTHORIZATION=f"Bearer {res.data['access']}")
        client.login_payload = res.data
        return client

    def _create(self, client, **overrides):
        body = {'username': 'newsales', 'password': 'Gl4sses-Sales-77', 'role': 'SALES_EXECUTIVE',
                'first_name': 'Nina'}
        body.update(overrides)
        return client.post(URL, body, format='json')

    def test_admin_creates_sales_user_who_signs_in_at_once_with_sales_access(self):
        admin = self._login('admin1')
        listing = admin.get(URL)
        self.assertEqual(listing.status_code, 200, listing.content)
        self.assertEqual({u['username'] for u in listing.data['users']}, {'owner', 'admin1', 'seller'})

        res = self._create(admin)  # no re-auth / approval step
        self.assertEqual(res.status_code, 201, res.content)
        user = get_user_model().objects.get(username='newsales')
        self.assertEqual((user.tenant_id, user.role, user.is_active, user.is_superuser),
                         (self.shop.pk, 'SALES_EXECUTIVE', True, False))

        staff = self._login('newsales', 'Gl4sses-Sales-77')
        access = staff.login_payload['user']['module_access']
        self.assertEqual(access['sales'], 'full')
        self.assertEqual(access['admin'], 'none')

    def test_only_admin_staff_may_manage_users(self):
        seller = self._login('seller')
        self.assertEqual(seller.get(URL).status_code, 403)
        self.assertEqual(self._create(seller).status_code, 403)
        self.assertEqual(APIClient().get(URL).status_code, 401)

    def test_admin_cannot_hand_out_or_edit_higher_roles(self):
        admin = self._login('admin1')
        self.assertNotIn('SUPER_ADMIN', admin.get(URL).data['catalog']['assignable_roles'])
        self.assertEqual(self._create(admin, role='SUPER_ADMIN').status_code, 400)
        owner = get_user_model().objects.get(username='owner')
        res = admin.patch(f'{URL}{owner.pk}/', {'is_active': False}, format='json')
        self.assertEqual(res.status_code, 403)
        res = admin.post(f'{URL}{owner.pk}/reset-password/', {'password': 'Another-pass-99'}, format='json')
        self.assertEqual(res.status_code, 403)
        # The owner may create another owner.
        self.assertEqual(self._create(self._login('owner'), role='SUPER_ADMIN').status_code, 201)

    def test_users_stay_in_own_tenant(self):
        admin = self._login('admin1')
        stranger = get_user_model().objects.get(username='otherowner')
        self.assertEqual(admin.patch(f'{URL}{stranger.pk}/', {'role': 'CASHIER'}, format='json').status_code, 404)
        self._create(admin, tenant=self.other.pk)
        self.assertEqual(get_user_model().objects.get(username='newsales').tenant_id, self.shop.pk)

    def test_edit_role_disable_and_reset_password(self):
        admin = self._login('admin1')
        seller = get_user_model().objects.get(username='seller')
        res = admin.patch(f'{URL}{seller.pk}/', {'role': 'CASHIER'}, format='json')
        self.assertEqual(res.status_code, 200, res.content)
        res = admin.post(f'{URL}{seller.pk}/reset-password/', {'password': 'Fresh-pass-4567'}, format='json')
        self.assertEqual(res.status_code, 200, res.content)
        self._login('seller', 'Fresh-pass-4567')
        admin.patch(f'{URL}{seller.pk}/', {'is_active': False}, format='json')
        res = APIClient().post('/api/auth/login/', {'username': 'seller', 'password': 'Fresh-pass-4567'}, format='json')
        self.assertEqual(res.status_code, 401)

    def test_seat_limit_applies(self):
        self.shop.max_users = 3
        self.shop.save()
        res = self._create(self._login('admin1'))
        self.assertEqual(res.status_code, 400)
        self.assertIn('max_users', res.data)
