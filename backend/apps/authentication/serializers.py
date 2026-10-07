from django.conf import settings
from rest_framework import serializers, exceptions
from django.contrib.auth import get_user_model
from rest_framework_simplejwt.serializers import TokenObtainPairSerializer

User = get_user_model()

class UserSerializer(serializers.ModelSerializer):
    role_display = serializers.CharField(source='get_role_display', read_only=True)

    class Meta:
        model = User
        fields = ('id', 'username', 'email', 'first_name', 'last_name', 'role', 'role_display', 'phone', 'is_active')
        read_only_fields = ('id', 'is_active')


class CustomTokenObtainPairSerializer(TokenObtainPairSerializer):
    def validate(self, attrs):
        data = super().validate(attrs)
        # Credentials are valid at this point; now gate on role. A Django superuser always
        # counts as Super Admin (bootstrap_admin --reset-password doesn't touch `role`).
        role = 'SUPER_ADMIN' if self.user.is_superuser else (self.user.role or '').upper()
        if role not in settings.LOGIN_ENABLED_ROLES:
            # A dict detail so "code" reaches the response body; the frontend keys on it.
            raise exceptions.AuthenticationFailed({
                'detail': 'This account is not configured for sign-in yet. Access denied.',
                'code': 'role_not_enabled',
            })
        data['user'] = UserSerializer(self.user).data
        if self.user.is_superuser:
            data['user']['role'] = 'SUPER_ADMIN'
            data['user']['role_display'] = 'Super Admin'
        return data
