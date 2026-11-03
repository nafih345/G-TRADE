from django.contrib.auth import get_user_model, password_validation
from django.contrib.auth.validators import UnicodeUsernameValidator
from django.core.exceptions import ValidationError as DjangoValidationError
from rest_framework import serializers

from apps.common.models import Tenant
from apps.common.tenant_onboarding import OnboardingError, check_available


class TenantOnboardSerializer(serializers.Serializer):
    tenant_name = serializers.CharField(max_length=150)
    admin_username = serializers.CharField(max_length=150, validators=[UnicodeUsernameValidator()])
    password = serializers.CharField(write_only=True, trim_whitespace=False, max_length=128)
    admin_email = serializers.EmailField(required=False, allow_blank=True, default='')
    contact_phone = serializers.CharField(max_length=20, required=False, allow_blank=True, default='')
    branch_name = serializers.CharField(max_length=100, required=False, allow_blank=True, default='')

    def validate(self, attrs):
        errors = {}
        try:
            check_available(attrs['tenant_name'].strip(), attrs['admin_username'].strip())
        except OnboardingError as e:
            errors[e.field] = [e.message]
        User = get_user_model()
        try:
            password_validation.validate_password(
                attrs['password'], user=User(username=attrs['admin_username'], email=attrs.get('admin_email') or ''))
        except DjangoValidationError as e:
            errors['password'] = list(e.messages)
        if errors:
            raise serializers.ValidationError(errors)
        return attrs


class TenantSerializer(serializers.ModelSerializer):
    """List / detail row. primary_admin and branch_count come from maps the view builds for the
    whole page in two queries (see TenantAdminViewSet.get_serializer_context)."""
    user_count = serializers.IntegerField(read_only=True)
    primary_admin = serializers.SerializerMethodField()
    branch_count = serializers.SerializerMethodField()

    class Meta:
        model = Tenant
        fields = ('id', 'name', 'code', 'is_active', 'created_at', 'contact_email', 'contact_phone',
                  'primary_admin', 'user_count', 'branch_count')
        read_only_fields = fields

    def get_primary_admin(self, obj):
        return self.context.get('admins', {}).get(obj.pk)

    def get_branch_count(self, obj):
        return self.context.get('branch_counts', {}).get(obj.pk, 0)
