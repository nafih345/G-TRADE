from datetime import timedelta

from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.test import TestCase
from django.utils import timezone
from rest_framework.test import APIClient
from rest_framework_simplejwt.tokens import RefreshToken

from apps.security import totp
from apps.security.models import (AuthSession, LoginAttempt, SecurityAuditLog, SecuritySettings,
                                  UserTwoFactor)

User = get_user_model()
PASSWORD = 'Str0ng-pass!'


class SecurityTestBase(TestCase):
    def setUp(self):
        cache.clear()  # DRF throttle history
        self.owner = User.objects.create_user('owner', 'owner@example.com', PASSWORD, role='SUPER_ADMIN')
        self.admin = User.objects.create_user('admin2', 'admin2@example.com', PASSWORD, role='ADMINISTRATOR')
        self.client = APIClient()

    def login(self, username='owner', password=PASSWORD, **extra):
        return self.client.post('/api/auth/login/', {'username': username, 'password': password}, format='json', **extra)

    def bearer(self, access):
        self.client.credentials(HTTP_AUTHORIZATION=f'Bearer {access}')

    def set_policy(self, **values):
        SecuritySettings.objects.update_or_create(pk=1, defaults=values)


class SecuritySettingsApiTests(SecurityTestBase):
    def test_owner_reads_and_updates_with_audit(self):
        self.client.force_authenticate(self.owner)
        res = self.client.get('/api/security/settings/')
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.data['inactivity_timeout_minutes'], 30)
        version = res.data['version']

        res = self.client.patch('/api/security/settings/', {'inactivity_timeout_minutes': 15,
                                                            'sensitive_action_reauth': True,
                                                            'version': version}, format='json')
        self.assertEqual(res.status_code, 200, res.data)
        self.assertEqual(res.data['inactivity_timeout_minutes'], 15)
        self.assertEqual(res.data['version'], version + 1)
        log = SecurityAuditLog.objects.get(event='SECURITY_SETTINGS_UPDATED')
        self.assertEqual(log.actor_name, 'owner')
        self.assertEqual(log.details['changes']['inactivity_timeout_minutes'], [30, 15])

    def test_stale_version_is_refused(self):
        self.client.force_authenticate(self.owner)
        version = self.client.get('/api/security/settings/').data['version']
        self.client.patch('/api/security/settings/', {'lockout_minutes': 30, 'version': version}, format='json')
        res = self.client.patch('/api/security/settings/', {'lockout_minutes': 60, 'version': version}, format='json')
        self.assertEqual(res.status_code, 409)
        self.assertEqual(SecuritySettings.load().lockout_minutes, 30)

    def test_validation_errors_per_field(self):
        self.client.force_authenticate(self.owner)
        res = self.client.patch('/api/security/settings/', {'inactivity_timeout_minutes': 7,
                                                            'max_failed_attempts': 50,
                                                            'login_protection_enabled': 'yes'}, format='json')
        self.assertEqual(res.status_code, 400)
        self.assertEqual(set(res.data['errors']), {'inactivity_timeout_minutes', 'max_failed_attempts',
                                                   'login_protection_enabled'})

    def test_two_factor_cannot_be_enforced_before_own_enrolment(self):
        self.client.force_authenticate(self.owner)
        res = self.client.patch('/api/security/settings/', {'two_factor_required': True}, format='json')
        self.assertEqual(res.status_code, 400)
        self.assertIn('two_factor_required', res.data['errors'])
        self.assertFalse(SecuritySettings.load().two_factor_required)

    def test_permissions(self):
        self.client.force_authenticate(self.admin)
        self.assertEqual(self.client.get('/api/security/settings/').status_code, 200)
        self.assertEqual(self.client.patch('/api/security/settings/', {'lockout_minutes': 5},
                                           format='json').status_code, 403)
        cashier = User.objects.create_user('cashier', None, PASSWORD, role='CASHIER')
        self.client.force_authenticate(cashier)
        self.assertEqual(self.client.get('/api/security/settings/').status_code, 403)
        self.client.force_authenticate(None)
        self.assertIn(self.client.get('/api/security/settings/').status_code, (401, 403))

    def test_audit_rows_are_append_only(self):
        row = SecurityAuditLog.objects.create(event='X', category='SECURITY', summary='x')
        row.summary = 'changed'
        with self.assertRaises(PermissionError):
            row.save()
        with self.assertRaises(PermissionError):
            row.delete()


class SessionTests(SecurityTestBase):
    def test_login_issues_session_bound_tokens_and_logout_ends_them(self):
        res = self.login()
        self.assertEqual(res.status_code, 200, res.data)
        access = res.data['access']
        self.bearer(access)
        self.assertEqual(self.client.get('/api/auth/profile/').status_code, 200)
        session = AuthSession.objects.get(user_id=self.owner.pk)
        self.assertIsNone(session.ended_at)

        self.assertEqual(self.client.post('/api/auth/logout/').status_code, 200)
        res = self.client.get('/api/auth/profile/')
        self.assertEqual(res.status_code, 401)
        self.assertEqual(res.data['code'], 'session_expired')

    def test_idle_session_expires_on_the_server(self):
        self.set_policy(inactivity_timeout_minutes=5)
        access = self.login().data['access']
        AuthSession.objects.filter(user_id=self.owner.pk).update(last_activity_at=timezone.now() - timedelta(minutes=6))
        from apps.security import policy
        policy._snapshots.clear()
        policy._touched.clear()
        self.bearer(access)
        res = self.client.get('/api/auth/profile/')
        self.assertEqual(res.status_code, 401)
        self.assertEqual(res.data['code'], 'session_timeout')
        self.assertEqual(AuthSession.objects.get(user_id=self.owner.pk).end_reason, 'TIMEOUT')

    def test_active_session_survives_and_records_activity(self):
        self.set_policy(inactivity_timeout_minutes=5)
        access = self.login().data['access']
        AuthSession.objects.filter(user_id=self.owner.pk).update(last_activity_at=timezone.now() - timedelta(minutes=4))
        from apps.security import policy
        policy._snapshots.clear()
        policy._touched.clear()
        self.bearer(access)
        self.assertEqual(self.client.post('/api/security/session/heartbeat/').status_code, 204)
        last = AuthSession.objects.get(user_id=self.owner.pk).last_activity_at
        self.assertLess(timezone.now() - last, timedelta(seconds=30))

    def test_token_without_session_is_rejected(self):
        legacy = RefreshToken.for_user(self.owner).access_token
        self.bearer(str(legacy))
        res = self.client.get('/api/auth/profile/')
        self.assertEqual(res.status_code, 401)

    def test_refresh_is_refused_after_logout(self):
        res = self.login()
        refresh = res.data['refresh']
        self.bearer(res.data['access'])
        self.client.post('/api/auth/logout/')
        self.client.credentials()
        res = self.client.post('/api/auth/token/refresh/', {'refresh': refresh}, format='json')
        self.assertEqual(res.status_code, 401)


class LoginProtectionTests(SecurityTestBase):
    def test_lockout_after_repeated_failures_even_with_right_password(self):
        self.set_policy(max_failed_attempts=3, lockout_minutes=15)
        for _ in range(3):
            self.assertEqual(self.login(password='wrong').status_code, 401)
        res = self.login()
        self.assertEqual(res.status_code, 429)
        self.assertEqual(res.data['code'], 'account_locked')
        self.assertTrue(SecurityAuditLog.objects.filter(event='LOGIN_LOCKED').exists())

    def test_lock_expires(self):
        self.set_policy(max_failed_attempts=3, lockout_minutes=15)
        for _ in range(3):
            self.login(password='wrong')
        LoginAttempt.objects.update(created_at=timezone.now() - timedelta(minutes=16))
        self.assertEqual(self.login().status_code, 200)

    def test_success_resets_the_count(self):
        self.set_policy(max_failed_attempts=3)
        self.login(password='wrong')
        self.login(password='wrong')
        self.assertEqual(self.login().status_code, 200)
        self.login(password='wrong')
        self.login(password='wrong')
        self.assertEqual(self.login().status_code, 200)

    def test_disabled_protection_never_locks(self):
        self.set_policy(login_protection_enabled=False, max_failed_attempts=3)
        for _ in range(5):
            self.login(password='wrong')
        self.assertEqual(self.login().status_code, 200)

    def test_role_gate_still_applies(self):
        res = self.login('admin2')
        self.assertEqual(res.status_code, 401)
        self.assertEqual(res.data['code'], 'role_not_enabled')


class ReauthTests(SecurityTestBase):
    def test_sensitive_action_needs_recent_password(self):
        self.set_policy(sensitive_action_reauth=True)
        self.bearer(self.login().data['access'])
        target = '/api/backups/00000000-0000-0000-0000-000000000000/'
        res = self.client.delete(target)
        self.assertEqual(res.status_code, 403)
        self.assertEqual(res.data['code'], 'reauth_required')

        self.assertEqual(self.client.post('/api/security/reauth/', {'password': 'nope'}, format='json').status_code, 400)
        self.assertEqual(self.client.post('/api/security/reauth/', {'password': PASSWORD}, format='json').status_code, 200)
        self.assertEqual(self.client.delete(target).status_code, 404)  # past the gate; nothing to delete

    def test_reads_and_ordinary_writes_are_not_gated(self):
        self.set_policy(sensitive_action_reauth=True)
        self.bearer(self.login().data['access'])
        self.assertEqual(self.client.get('/api/security/settings/').status_code, 200)
        self.assertEqual(self.client.post('/api/security/session/heartbeat/').status_code, 204)

    def test_policy_off_means_no_prompt(self):
        self.bearer(self.login().data['access'])
        self.assertEqual(self.client.delete('/api/backups/00000000-0000-0000-0000-000000000000/').status_code, 404)


class TwoFactorTests(SecurityTestBase):
    def enrol(self):
        self.client.force_authenticate(self.owner)
        secret = self.client.post('/api/security/two-factor/setup/').data['secret']
        res = self.client.post('/api/security/two-factor/confirm/', {'code': totp.code_for(secret)}, format='json')
        self.assertEqual(res.status_code, 200, res.data)
        self.client.force_authenticate(None)
        return secret

    def next_code(self, secret):
        # The enrolment used the current time step; a code is accepted once, so use the next one.
        return totp._code_at(secret, totp.current_step() + 1)

    def test_totp_matches_rfc_6238_vector(self):
        secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'  # base32("12345678901234567890")
        self.assertEqual(totp._code_at(secret, 59 // 30), '287082')
        self.assertEqual(totp.match_step(secret, '287082', now=59), 1)

    def test_enrolled_user_needs_a_code_to_sign_in(self):
        secret = self.enrol()
        res = self.login()
        self.assertEqual(res.status_code, 200)
        self.assertTrue(res.data['two_factor_required'])
        self.assertNotIn('access', res.data)
        challenge = res.data['challenge']

        bad = self.client.post('/api/auth/two-factor/verify/', {'challenge': challenge, 'code': '000000'}, format='json')
        self.assertEqual(bad.status_code, 401)
        code = self.next_code(secret)
        ok = self.client.post('/api/auth/two-factor/verify/', {'challenge': challenge, 'code': code}, format='json')
        self.assertEqual(ok.status_code, 200, ok.data)
        self.assertIn('access', ok.data)
        self.assertTrue(AuthSession.objects.get(user_id=self.owner.pk).two_factor_verified)
        replay = self.client.post('/api/auth/two-factor/verify/', {'challenge': challenge, 'code': code}, format='json')
        self.assertEqual(replay.status_code, 401)

    def test_tampered_challenge_is_rejected(self):
        self.enrol()
        res = self.client.post('/api/auth/two-factor/verify/', {'challenge': 'forged', 'code': '123456'}, format='json')
        self.assertEqual(res.status_code, 400)

    def test_enforced_policy_enrols_at_sign_in(self):
        self.enrol()
        self.set_policy(two_factor_required=True)
        other = User.objects.create_superuser('boss', 'b@example.com', PASSWORD)
        res = self.login('boss')
        self.assertTrue(res.data['two_factor_setup_required'])
        secret = res.data['secret']
        ok = self.client.post('/api/auth/two-factor/verify/', {'challenge': res.data['challenge'],
                                                               'code': totp.code_for(secret)}, format='json')
        self.assertEqual(ok.status_code, 200, ok.data)
        self.assertTrue(UserTwoFactor.objects.get(user_id=other.pk).enrolled)

    def test_cannot_disable_while_enforced(self):
        secret = self.enrol()
        self.set_policy(two_factor_required=True)
        self.client.force_authenticate(self.owner)
        res = self.client.post('/api/security/two-factor/disable/', {'password': PASSWORD,
                                                                     'code': self.next_code(secret)}, format='json')
        self.assertEqual(res.status_code, 400)
        self.assertTrue(UserTwoFactor.objects.filter(user_id=self.owner.pk).exists())

    def test_disable_needs_password_and_code(self):
        secret = self.enrol()
        self.client.force_authenticate(self.owner)
        res = self.client.post('/api/security/two-factor/disable/', {'password': 'x', 'code': '1'}, format='json')
        self.assertEqual(res.status_code, 400)
        res = self.client.post('/api/security/two-factor/disable/', {'password': PASSWORD,
                                                                     'code': self.next_code(secret)}, format='json')
        self.assertEqual(res.status_code, 200)
        self.assertFalse(UserTwoFactor.objects.filter(user_id=self.owner.pk).exists())
        self.assertTrue(SecurityAuditLog.objects.filter(event='TWO_FACTOR_DISABLED').exists())
