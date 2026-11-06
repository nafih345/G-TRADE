"""Direct Edit switches + admin-approved edit requests (apps/authentication/edit_permissions.py)."""
from datetime import timedelta

from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.test import TestCase
from django.utils import timezone
from rest_framework.test import APIClient

from apps.authentication.models import EditRequest
from apps.common import tenancy
from apps.common.models import Tenant
from apps.sales.models import EyeExamination

PASSWORD = 'Str0ng-pass-123'


class EditPermissionWorkflowTests(TestCase):
    def setUp(self):
        cache.clear()
        self.addCleanup(cache.clear)
        User = get_user_model()
        self.shop = Tenant.objects.create(name='City Opticals', code='city', max_users=10)
        self.other = Tenant.objects.create(name='Other Shop', code='other-shop')
        self.owner = User.objects.create_user('owner', password=PASSWORD, role='SUPER_ADMIN', tenant=self.shop)
        self.admin = User.objects.create_user('admin1', password=PASSWORD, role='ADMINISTRATOR', tenant=self.shop)
        self.optom = User.objects.create_user('optom', password=PASSWORD, role='OPTOMETRIST', tenant=self.shop)
        User.objects.create_user('otherowner', password=PASSWORD, role='SUPER_ADMIN', tenant=self.other)
        with tenancy.use_tenant(self.shop.pk):
            self.exam = EyeExamination.objects.create(patient_id='P-1004', patient_name='Asha', test_no='1004')

    def _login(self, username):
        client = APIClient()
        res = client.post('/api/auth/login/', {'username': username, 'password': PASSWORD}, format='json')
        self.assertEqual(res.status_code, 200, res.content)
        client.credentials(HTTP_AUTHORIZATION=f"Bearer {res.data['access']}")
        client.login_payload = res.data
        return client

    def _exam_url(self):
        return f'/api/sales/eye-examinations/{self.exam.pk}/'

    def _turn_off(self, admin_client, module='eye_test'):
        res = admin_client.patch(f'/api/auth/edit-permissions/{self.optom.pk}/', {f'can_edit_{module}': False},
                                 format='json')
        self.assertEqual(res.status_code, 200, res.content)
        return res

    def test_switch_on_by_default_edits_directly(self):
        optom = self._login('optom')
        self.assertTrue(optom.login_payload['user']['edit_permissions']['eye_test'])
        res = optom.patch(self._exam_url(), {'optometrist': 'Dr. A'}, format='json')
        self.assertEqual(res.status_code, 200, res.content)

    def test_full_request_approve_complete_cycle(self):
        admin = self._login('admin1')
        self._turn_off(admin)
        optom = self._login('optom')
        self.assertFalse(optom.login_payload['user']['edit_permissions']['eye_test'])
        self.assertTrue(optom.login_payload['user']['edit_permissions']['sales'])

        # Blocked, with enough detail for the client to open the request dialog.
        res = optom.patch(self._exam_url(), {'optometrist': 'Dr. A'}, format='json')
        self.assertEqual(res.status_code, 403)
        self.assertEqual(res.data['code'], 'edit_approval_required')
        self.assertEqual(res.data['module'], 'eye_test')
        self.assertEqual(res.data['record_ref'], '1004')

        access = optom.get('/api/auth/edit-requests/access/', {'module': 'eye_test', 'record_id': str(self.exam.pk)})
        self.assertEqual((access.data['allowed'], access.data['mode']), (False, 'none'))

        # A reason is mandatory.
        self.assertEqual(optom.post('/api/auth/edit-requests/', {'module': 'eye_test', 'record_id': str(self.exam.pk),
                                                                  'reason': ''}, format='json').status_code, 400)
        req = optom.post('/api/auth/edit-requests/', {
            'module': 'eye_test', 'record_id': str(self.exam.pk), 'record_ref': 'Test 1004',
            'reason': 'Optometrist not assigned'}, format='json')
        self.assertEqual(req.status_code, 201, req.content)
        self.assertEqual(req.data['status'], 'PENDING')
        # Asking again updates the same pending request rather than stacking duplicates.
        again = optom.post('/api/auth/edit-requests/', {'module': 'eye_test', 'record_id': str(self.exam.pk),
                                                         'reason': 'Optometrist missing'}, format='json')
        self.assertEqual(again.data['id'], req.data['id'])

        self.assertEqual(optom.patch(self._exam_url(), {'optometrist': 'Dr. A'}, format='json').status_code, 403)
        self.assertEqual(optom.post(f"/api/auth/edit-requests/{req.data['id']}/approve/").status_code, 403)

        count = admin.get('/api/auth/edit-requests/pending-count/')
        self.assertEqual(count.data['count'], 1)
        queue = admin.get('/api/auth/edit-requests/', {'status': 'PENDING'})
        row = queue.data['results'][0]
        self.assertEqual((row['requested_by_username'], row['requester_role'], row['reason'], row['can_review']),
                         ('optom', 'OPTOMETRIST', 'Optometrist missing', True))

        ok = admin.post(f"/api/auth/edit-requests/{req.data['id']}/approve/", {'note': 'Go ahead'}, format='json')
        self.assertEqual(ok.status_code, 200, ok.content)
        self.assertEqual(ok.data['status'], 'APPROVED')
        access = optom.get('/api/auth/edit-requests/access/', {'module': 'eye_test', 'record_id': str(self.exam.pk)})
        self.assertEqual((access.data['allowed'], access.data['mode']), (True, 'approved'))

        # One save consumes the approval and relocks the record.
        self.assertEqual(optom.patch(self._exam_url(), {'optometrist': 'Dr. A'}, format='json').status_code, 200)
        with tenancy.use_tenant(self.shop.pk):
            self.assertEqual(EditRequest.objects.get(pk=req.data['id']).status, 'COMPLETED')
        self.assertEqual(optom.patch(self._exam_url(), {'optometrist': 'Dr. B'}, format='json').status_code, 403)

    def test_reject_with_note_and_expired_approval(self):
        admin = self._login('admin1')
        self._turn_off(admin)
        optom = self._login('optom')
        body = {'module': 'eye_test', 'record_id': str(self.exam.pk), 'reason': 'Wrong power'}
        rid = optom.post('/api/auth/edit-requests/', body, format='json').data['id']
        res = admin.post(f'/api/auth/edit-requests/{rid}/reject/', {'note': 'Re-test instead'}, format='json')
        self.assertEqual((res.data['status'], res.data['review_note']), ('REJECTED', 'Re-test instead'))
        self.assertEqual(admin.post(f'/api/auth/edit-requests/{rid}/approve/').status_code, 409)
        access = optom.get('/api/auth/edit-requests/access/', {'module': 'eye_test', 'record_id': str(self.exam.pk)})
        self.assertEqual(access.data['mode'], 'rejected')

        rid = optom.post('/api/auth/edit-requests/', body, format='json').data['id']
        admin.post(f'/api/auth/edit-requests/{rid}/approve/')
        with tenancy.use_tenant(self.shop.pk):
            EditRequest.objects.filter(pk=rid).update(expires_at=timezone.now() - timedelta(minutes=1))
        self.assertEqual(optom.patch(self._exam_url(), {'optometrist': 'Dr. A'}, format='json').status_code, 403)
        with tenancy.use_tenant(self.shop.pk):
            self.assertEqual(EditRequest.objects.get(pk=rid).status, 'EXPIRED')

    def test_creator_may_resave_a_fresh_record(self):
        admin = self._login('admin1')
        self._turn_off(admin)
        optom = self._login('optom')
        created = optom.post('/api/sales/eye-examinations/', {'patient_id': 'P-2001', 'patient_name': 'Ravi'},
                             format='json')
        self.assertEqual(created.status_code, 201, created.content)
        url = f"/api/sales/eye-examinations/{created.data['id']}/"
        self.assertEqual(optom.patch(url, {'optometrist': 'Dr. A'}, format='json').status_code, 200)
        access = optom.get('/api/auth/edit-requests/access/', {'module': 'eye_test', 'record_id': created.data['id']})
        self.assertEqual((access.data['allowed'], access.data['mode']), (True, 'fresh'))
        with tenancy.use_tenant(self.shop.pk):
            EyeExamination.objects.filter(pk=created.data['id']).update(created_at=timezone.now() - timedelta(hours=2))
        self.assertEqual(optom.patch(url, {'optometrist': 'Dr. B'}, format='json').status_code, 403)

    def test_matrix_rules(self):
        optom = self._login('optom')
        self.assertEqual(optom.get('/api/auth/edit-permissions/').status_code, 403)
        admin = self._login('admin1')
        listing = admin.get('/api/auth/edit-permissions/')
        self.assertEqual(listing.status_code, 200)
        self.assertEqual(len(listing.data['modules']), 6)
        by_name = {u['username']: u for u in listing.data['users']}
        self.assertNotIn('otherowner', by_name)
        self.assertTrue(by_name['owner']['always_direct'])
        self.assertFalse(by_name['owner']['can_manage'])
        self.assertTrue(by_name['optom']['can_manage'])
        # Owners can't be switched off; nobody changes their own switches.
        self.assertEqual(admin.patch(f'/api/auth/edit-permissions/{self.owner.pk}/', {'can_edit_sales': False},
                                     format='json').status_code, 400)
        self.assertEqual(admin.patch(f'/api/auth/edit-permissions/{self.admin.pk}/', {'can_edit_sales': False},
                                     format='json').status_code, 403)
        # Owner always edits directly, whatever the flag column says.
        get_user_model().objects.filter(pk=self.owner.pk).update(can_edit_eye_test=False)
        cache.clear()
        owner = self._login('owner')
        self.assertEqual(owner.patch(self._exam_url(), {'optometrist': 'Dr. O'}, format='json').status_code, 200)

    def test_requester_cannot_review_and_other_tenant_cannot_see(self):
        admin = self._login('admin1')
        self._turn_off(admin)
        optom = self._login('optom')
        rid = optom.post('/api/auth/edit-requests/', {'module': 'eye_test', 'record_id': str(self.exam.pk),
                                                      'reason': 'Typo'}, format='json').data['id']
        other = self._login('otherowner')
        self.assertEqual(other.get('/api/auth/edit-requests/').data['results'], [])
        self.assertEqual(other.post(f'/api/auth/edit-requests/{rid}/approve/').status_code, 404)
        # The requester sees only their own requests and may withdraw a pending one.
        mine = optom.get('/api/auth/edit-requests/')
        self.assertEqual([r['id'] for r in mine.data['results']], [rid])
        self.assertEqual(optom.post(f'/api/auth/edit-requests/{rid}/cancel/').data['status'], 'CANCELLED')
