"""One-time account-setup links ("invitations") for client users.

The platform admin can create a client's administrator without choosing a password: the account
gets an unusable password and the admin is handed a link to set their own. The link carries a
signed token (Django's password-reset token machinery, with its own salt so a reset token and an
invitation token are never interchangeable). It is valid for INVITATION_TIMEOUT and stops working
as soon as it is used, because the token's hash covers the password and last-login time.

Nothing is e-mailed: there is no mail integration, so the platform admin copies the link and
sends it the way they already contact the client. The link is the full secret — it is shown once,
never stored server-side (the idempotency cache is told not to keep it) and not logged.

    POST /api/auth/invitation/check/   {uid, token}            → who the link is for
    POST /api/auth/invitation/accept/  {uid, token, password}  → password set; sign in normally
"""
from django.contrib.auth import get_user_model
from django.contrib.auth.password_validation import validate_password
from django.contrib.auth.tokens import PasswordResetTokenGenerator
from django.core.exceptions import ValidationError
from django.utils.crypto import constant_time_compare
from django.utils.encoding import force_bytes, force_str
from django.utils.http import base36_to_int, urlsafe_base64_decode, urlsafe_base64_encode
from rest_framework import permissions, status
from rest_framework.response import Response
from rest_framework.throttling import ScopedRateThrottle
from rest_framework.views import APIView

INVITATION_TIMEOUT_HOURS = 72


class _InvitationTokenGenerator(PasswordResetTokenGenerator):
    key_salt = 'apps.common.invitations.InvitationTokenGenerator'

    timeout = INVITATION_TIMEOUT_HOURS * 3600

    def check_token(self, user, token):
        """Django's check with this generator's own lifetime (the base class reads the global
        PASSWORD_RESET_TIMEOUT)."""
        if not (user and token):
            return False
        try:
            ts_b36, _ = token.split('-')
            ts = base36_to_int(ts_b36)
        except ValueError:
            return False
        if not any(constant_time_compare(self._make_token_with_timestamp(user, ts, secret), token)
                   for secret in [self.secret, *self.secret_fallbacks]):
            return False
        return 0 <= self._num_seconds(self._now()) - ts <= self.timeout


token_generator = _InvitationTokenGenerator()


def issue(user):
    """{uid, token, expires_in_hours} for `user`. The caller builds the link (the browser knows its
    own origin; the server never trusts a Host header for it)."""
    return {'uid': urlsafe_base64_encode(force_bytes(user.pk)), 'token': token_generator.make_token(user),
            'expires_in_hours': INVITATION_TIMEOUT_HOURS}


def resolve(uid, token):
    """The active user an unused, unexpired invitation belongs to, or None."""
    from apps.common.tenancy import unscoped
    import uuid
    try:
        pk = str(uuid.UUID(force_str(urlsafe_base64_decode(str(uid or '')))))
    except (TypeError, ValueError, OverflowError, UnicodeDecodeError):
        return None
    with unscoped():
        user = get_user_model().objects.select_related('tenant').filter(pk=pk).first() if pk else None
    if user is None or not user.is_active or user.is_superuser or not token_generator.check_token(user, str(token or '')):
        return None
    if user.tenant_id is None or not user.tenant.is_effectively_active:
        return None
    return user


def _invalid():
    return Response({'detail': 'This setup link is invalid, already used or expired. Ask your administrator '
                               'for a new one.', 'code': 'invitation_invalid'}, status=status.HTTP_400_BAD_REQUEST)


class _PublicView(APIView):
    authentication_classes = []
    token_authentication = False  # works signed out; a stale token in the browser is ignored
    permission_classes = [permissions.AllowAny]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = 'login'


class InvitationCheckView(_PublicView):
    def post(self, request):
        user = resolve(request.data.get('uid'), request.data.get('token'))
        if user is None:
            return _invalid()
        return Response({'username': user.username, 'name': user.get_full_name(), 'business': user.tenant.name})


class InvitationAcceptView(_PublicView):
    def post(self, request):
        user = resolve(request.data.get('uid'), request.data.get('token'))
        if user is None:
            return _invalid()
        password = str(request.data.get('password') or '')
        try:
            validate_password(password, user=user)
        except ValidationError as exc:
            return Response({'password': list(exc.messages)}, status=status.HTTP_400_BAD_REQUEST)
        user.set_password(password)
        user.save(update_fields=['password'])  # invalidates this and every other setup link
        from apps.common.tenant_onboarding import log_event
        log_event(user.tenant, 'INVITATION_ACCEPTED', user.username, username=user.username)
        return Response({'detail': 'Your password is set. Sign in with your username and new password.',
                         'username': user.username})
