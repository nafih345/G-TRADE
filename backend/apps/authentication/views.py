from django.contrib.auth import authenticate, get_user_model
from django.core import signing
from rest_framework import exceptions, status, generics, permissions
from rest_framework.throttling import ScopedRateThrottle
from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework_simplejwt.views import TokenRefreshView

from apps.security import login_protection, policy, totp
from apps.security.audit import log_event
from apps.security.models import UserTwoFactor

from .serializers import (ProfileSerializer, UserSerializer, SessionTokenRefreshSerializer, ensure_login_role,
                          login_user_payload)

User = get_user_model()

CHALLENGE_SALT = 'security.two-factor.challenge'
CHALLENGE_TTL = 300


def _invalid_credentials():
    return Response({'detail': 'No active account found with the given credentials', 'code': 'invalid_credentials'},
                    status=status.HTTP_401_UNAUTHORIZED)


def _signed_in(user, request, two_factor=False):
    from apps.common.organizations import accessible_companies
    tokens = policy.issue_tokens(user, request, two_factor=two_factor)
    # Phase 2: the session starts in the user's home company. With more than one company the
    # frontend shows the company picker next; picking another one calls /api/auth/switch-company/.
    return Response({'access': tokens['access'], 'refresh': tokens['refresh'], 'user': login_user_payload(user),
                     'companies': accessible_companies(user),
                     'session': {'inactivity_timeout_minutes': policy.get_settings().inactivity_timeout_minutes}})


class CustomTokenObtainPairView(APIView):
    """Sign in. Order matters: the lockout is checked before the password (a locked account says
    nothing about whether the password was right), then the role gate, then the second factor."""
    authentication_classes = []
    token_authentication = False  # token-blind by design (see tenant_context.install_drf_hook)
    permission_classes = [permissions.AllowAny]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = 'login'

    def post(self, request):
        username = str(request.data.get('username') or '').strip()
        password = str(request.data.get('password') or '')
        if not username or not password:
            return Response({'detail': 'Enter your username and password.', 'code': 'missing_credentials'},
                            status=status.HTTP_400_BAD_REQUEST)
        login_protection.ensure_not_locked(username, request)
        user = authenticate(request, username=username, password=password)
        if user is None:
            login_protection.record_failure(username, request)
            return _invalid_credentials()
        try:
            ensure_login_role(user)
        except exceptions.AuthenticationFailed as exc:
            # Returned, not raised: with no authentication classes DRF would turn a raised 401 into 403.
            return Response(exc.detail, status=status.HTTP_401_UNAUTHORIZED)
        # The platform console's own sign-in page (/#/super-admin/login) is for the platform owner
        # only. A client's owner also has role SUPER_ADMIN, but used to be let in there and landed
        # on a dashboard without Client Management. Refused before any token or 2FA challenge.
        if str(request.data.get('portal') or '') == 'platform':
            from apps.common.permissions import is_platform_owner
            if not is_platform_owner(user):
                return Response({'detail': 'This sign-in page is for the platform administrator. '
                                           'Business accounts sign in on the main login page.',
                                 'code': 'not_platform_admin'}, status=status.HTTP_403_FORBIDDEN)

        tf = UserTwoFactor.objects.filter(user_id=user.pk).first()
        if tf is not None and tf.enrolled:
            challenge = signing.dumps({'u': str(user.pk), 'n': username}, salt=CHALLENGE_SALT)
            return Response({'two_factor_required': True, 'challenge': challenge, 'expires_in': CHALLENGE_TTL})
        if policy.get_settings().two_factor_required:
            # Enforced but this account has no authenticator yet: enrol now, as part of signing in.
            secret = totp.new_secret()
            UserTwoFactor.objects.update_or_create(user_id=user.pk, defaults={
                'secret': secret, 'confirmed_at': None, 'last_used_step': 0})
            challenge = signing.dumps({'u': str(user.pk), 'n': username, 'setup': True}, salt=CHALLENGE_SALT)
            return Response({'two_factor_setup_required': True, 'challenge': challenge, 'expires_in': CHALLENGE_TTL,
                             'secret': secret, 'otpauth_uri': totp.provisioning_uri(secret, user.username)})

        login_protection.record_success(username, request)
        return _signed_in(user, request)


class TwoFactorVerifyView(APIView):
    """Second step of sign-in: the 6-digit code for the challenge issued by the login view."""
    authentication_classes = []
    token_authentication = False  # token-blind by design (see tenant_context.install_drf_hook)
    permission_classes = [permissions.AllowAny]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = 'login'

    def post(self, request):
        try:
            claims = signing.loads(str(request.data.get('challenge') or ''), salt=CHALLENGE_SALT, max_age=CHALLENGE_TTL)
        except signing.BadSignature:
            return Response({'detail': 'The sign-in attempt expired. Enter your password again.',
                             'code': 'challenge_expired'}, status=status.HTTP_400_BAD_REQUEST)
        typed_name = claims.get('n') or ''
        login_protection.ensure_not_locked(typed_name, request)
        user = User.objects.filter(pk=claims.get('u'), is_active=True).first()
        tf = UserTwoFactor.objects.filter(user_id=getattr(user, 'pk', None)).first()
        if user is None or tf is None:
            return Response({'detail': 'The sign-in attempt expired. Enter your password again.',
                             'code': 'challenge_expired'}, status=status.HTTP_400_BAD_REQUEST)
        setup = bool(claims.get('setup'))
        if setup == tf.enrolled:  # the enrolment changed since the challenge was issued
            return Response({'detail': 'The sign-in attempt expired. Enter your password again.',
                             'code': 'challenge_expired'}, status=status.HTTP_400_BAD_REQUEST)

        step = totp.match_step(tf.secret, request.data.get('code'))
        # Each code is accepted once (the conditional update is the replay guard).
        if step is None or not UserTwoFactor.objects.filter(pk=tf.pk, last_used_step__lt=step).update(last_used_step=step):
            login_protection.record_failure(typed_name, request, reason='2fa')
            return Response({'detail': 'That code is not valid. Check the time on your phone and try again.',
                             'code': 'invalid_code'}, status=status.HTTP_401_UNAUTHORIZED)
        if setup:
            from django.utils import timezone
            UserTwoFactor.objects.filter(pk=tf.pk).update(confirmed_at=timezone.now())
            log_event('TWO_FACTOR_ENROLLED', 'SECURITY', f'{user.username} set up two-factor authentication at sign-in',
                      request=request, user=user)
        login_protection.record_success(typed_name, request)
        return _signed_in(user, request, two_factor=True)


class SessionTokenRefreshView(TokenRefreshView):
    serializer_class = SessionTokenRefreshSerializer


class UserProfileView(generics.RetrieveUpdateAPIView):
    serializer_class = ProfileSerializer
    permission_classes = [permissions.IsAuthenticated]

    def get_object(self):
        return self.request.user

    def perform_update(self, serializer):
        # In another company request.user is a read-only member copy (organizations.company_user):
        # save the contact details onto the real account, then show them in this company's view.
        user = self.request.user
        if getattr(user, '_company_tenant_id', None) is not None:
            real = User.objects.get(pk=user.pk)
            for field, value in serializer.validated_data.items():
                setattr(real, field, value)
                setattr(user, field, value)
            real.save()
            serializer.instance = user
            return
        serializer.save()


class IsSuperAdmin(permissions.BasePermission):
    def has_permission(self, request, view):
        u = request.user
        return bool(u and u.is_authenticated and (u.is_superuser or u.role == 'SUPER_ADMIN'))


class RegisterUserView(generics.CreateAPIView):
    queryset = User.objects.all()
    serializer_class = UserSerializer
    # Was AllowAny, which let anyone create a SUPER_ADMIN account and walk past the
    # login role gate (settings.LOGIN_ENABLED_ROLES).
    permission_classes = [IsSuperAdmin]

    def perform_create(self, serializer):
        from apps.common.tenant_onboarding import OnboardingError, check_seat_available
        from apps.common.models import Tenant
        from apps.common.permissions import request_tenant_id
        tenant_id = request_tenant_id(self.request.user)
        tenant = Tenant.objects.filter(pk=tenant_id).first() if tenant_id else None
        if tenant is not None:
            try:
                check_seat_available(tenant)  # the client's seat limit (platform console)
            except OnboardingError as e:
                raise exceptions.ValidationError({'detail': e.message, 'code': 'seat_limit'})
        # New accounts always join the creator's tenant; the body can't choose another.
        user = serializer.save(tenant_id=tenant_id)
        password = self.request.data.get('password')
        if password:
            user.set_password(password)
            user.save()


class LogoutView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def post(self, request):
        # Ends the server-side session, so the token stops working even if a copy survives.
        token = getattr(request, 'auth', None)
        sid = token.get('sid') if token is not None and hasattr(token, 'get') else None
        if sid:
            policy.end_session(sid, 'LOGOUT')
        return Response({"message": "Successfully logged out."}, status=status.HTTP_200_OK)
