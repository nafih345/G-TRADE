from django.conf import settings
from rest_framework import serializers, exceptions
from django.contrib.auth import get_user_model
from rest_framework_simplejwt.serializers import TokenObtainPairSerializer, TokenRefreshSerializer
from rest_framework_simplejwt.tokens import RefreshToken

User = get_user_model()

class UserSerializer(serializers.ModelSerializer):
    role_display = serializers.CharField(source='get_role_display', read_only=True)

    class Meta:
        model = User
        fields = ('id', 'username', 'email', 'first_name', 'last_name', 'role', 'role_display', 'phone', 'is_active')
        read_only_fields = ('id', 'is_active')


def ensure_login_role(user):
    """Credentials are valid at this point; now gate on role. A Django superuser always counts as
    Super Admin (bootstrap_admin --reset-password doesn't touch `role`)."""
    role = 'SUPER_ADMIN' if user.is_superuser else (user.role or '').upper()
    if role not in settings.LOGIN_ENABLED_ROLES:
        # A dict detail so "code" reaches the response body; the frontend keys on it.
        raise exceptions.AuthenticationFailed({
            'detail': 'This account is not configured for sign-in yet. Access denied.',
            'code': 'role_not_enabled',
        })


def login_user_payload(user):
    data = UserSerializer(user).data
    if user.is_superuser:
        data['role'] = 'SUPER_ADMIN'
        data['role_display'] = 'Super Admin'
    return data


class CustomTokenObtainPairSerializer(TokenObtainPairSerializer):
    def validate(self, attrs):
        data = super().validate(attrs)
        ensure_login_role(self.user)
        data['user'] = login_user_payload(self.user)
        return data


class SessionTokenRefreshSerializer(TokenRefreshSerializer):
    """Refresh only while the sign-in session the token belongs to is still open and not idle."""

    def validate(self, attrs):
        from apps.security import policy
        refresh = RefreshToken(attrs['refresh'])
        user = User.objects.filter(pk=refresh.get('user_id'), is_active=True).first()
        if user is None:
            raise policy.SessionEnded()
        policy.validate_session(refresh.get('sid'), user, policy.get_settings().inactivity_timeout_minutes)
        return super().validate(attrs)
