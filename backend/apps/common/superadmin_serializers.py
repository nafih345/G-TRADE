from django.contrib.auth import get_user_model, password_validation
from django.contrib.auth.validators import UnicodeUsernameValidator
from django.core.exceptions import ValidationError as DjangoValidationError
from django.utils import timezone
from rest_framework import serializers

from apps.common import module_access
from apps.common.models import Tenant
from apps.common.tenant_onboarding import OnboardingError, check_available

# Why a client was deactivated; the free-text reason carries the detail.
DEACTIVATION_CATEGORIES = (
    ('NON_PAYMENT', 'Non-payment / overdue subscription'),
    ('CLIENT_REQUEST', 'Client requested closure'),
    ('CONTRACT_ENDED', 'Contract / trial ended'),
    ('POLICY_VIOLATION', 'Policy or terms violation'),
    ('BUSINESS_CLOSED', 'Shop closed / merged'),
    ('OTHER', 'Other'),
)


def _password_errors(password, username, email=''):
    try:
        password_validation.validate_password(password, user=get_user_model()(username=username, email=email or ''))
    except DjangoValidationError as e:
        return list(e.messages)
    return []


class ModulesField(serializers.ListField):
    child = serializers.CharField()


class TenantOnboardSerializer(serializers.Serializer):
    tenant_name = serializers.CharField(max_length=150)
    admin_username = serializers.CharField(max_length=150, validators=[UnicodeUsernameValidator()])
    password = serializers.CharField(write_only=True, trim_whitespace=False, max_length=128)
    admin_email = serializers.EmailField(required=False, allow_blank=True, default='')
    contact_phone = serializers.CharField(max_length=20, required=False, allow_blank=True, default='')
    branch_name = serializers.CharField(max_length=100, required=False, allow_blank=True, default='')
    package = serializers.CharField(required=False, default=module_access.FULL_SUITE)
    modules = ModulesField(required=False, default=list)
    max_users = serializers.IntegerField(required=False, default=5, min_value=1, max_value=10000)

    def validate(self, attrs):
        errors = {}
        try:
            check_available(attrs['tenant_name'].strip(), attrs['admin_username'].strip())
        except OnboardingError as e:
            errors[e.field] = [e.message]
        try:
            attrs['package'], attrs['modules'] = module_access.normalize_modules(attrs['package'], attrs['modules'])
        except ValueError as e:
            errors['modules'] = [str(e)]
        pw = _password_errors(attrs['password'], attrs['admin_username'], attrs.get('admin_email'))
        if pw:
            errors['password'] = pw
        if errors:
            raise serializers.ValidationError(errors)
        return attrs


def tenant_status(tenant):
    if not tenant.is_effectively_active:
        return 'INACTIVE'
    return 'SCHEDULED' if tenant.deactivation_effective_date else 'ACTIVE'


class TenantSerializer(serializers.ModelSerializer):
    """List / detail row. primary_admin, branch_count and active_user_count come from maps the
    view builds for the whole page in a few queries (TenantAdminViewSet._context_for)."""
    user_count = serializers.IntegerField(read_only=True)
    active_user_count = serializers.IntegerField(read_only=True)
    primary_admin = serializers.SerializerMethodField()
    branch_count = serializers.SerializerMethodField()
    status = serializers.SerializerMethodField()
    is_platform = serializers.SerializerMethodField()

    class Meta:
        model = Tenant
        fields = ('id', 'name', 'code', 'is_active', 'status', 'is_platform', 'created_at',
                  'contact_email', 'contact_phone', 'primary_admin', 'user_count', 'active_user_count',
                  'max_users', 'branch_count', 'package', 'modules',
                  'deactivation_category', 'deactivation_reason', 'deactivation_effective_date',
                  'deactivation_until', 'deactivated_at', 'deactivated_by')
        read_only_fields = fields

    def get_primary_admin(self, obj):
        return self.context.get('admins', {}).get(obj.pk)

    def get_branch_count(self, obj):
        return self.context.get('branch_counts', {}).get(obj.pk, 0)

    def get_status(self, obj):
        return tenant_status(obj)

    def get_is_platform(self, obj):
        from apps.common import tenancy
        return obj.pk == tenancy.DEFAULT_TENANT_ID


class TenantUpdateSerializer(serializers.Serializer):
    """PATCH /tenants/<id>/ — profile, subscription, seats, role permissions, multi-branch."""
    name = serializers.CharField(max_length=150, required=False)
    contact_email = serializers.EmailField(required=False, allow_blank=True)
    contact_phone = serializers.CharField(max_length=20, required=False, allow_blank=True)
    package = serializers.CharField(required=False)
    modules = ModulesField(required=False)
    max_users = serializers.IntegerField(required=False, min_value=1, max_value=10000)
    role_permissions = serializers.DictField(required=False)
    multi_branch_enabled = serializers.BooleanField(required=False)

    def validate_name(self, value):
        value = value.strip()
        if not value:
            raise serializers.ValidationError('Give the client a name.')
        if Tenant.objects.filter(name__iexact=value).exclude(pk=self.instance.pk).exists():
            raise serializers.ValidationError(f'A client named "{value}" already exists.')
        return value

    def validate_role_permissions(self, value):
        try:
            return module_access.normalize_role_permissions(value)
        except ValueError as e:
            raise serializers.ValidationError(str(e))

    def validate_max_users(self, value):
        from apps.common.tenant_onboarding import active_user_count
        used = active_user_count(self.instance)
        if value < used:
            raise serializers.ValidationError(
                f'{used} users are active. Deactivate users first, or keep at least {used} seats.')
        return value

    def validate(self, attrs):
        from apps.common import tenancy
        if 'package' in attrs or 'modules' in attrs:
            if self.instance.pk == tenancy.DEFAULT_TENANT_ID:
                raise serializers.ValidationError({'modules': ['The platform account always has every module.']})
            package = attrs.get('package', self.instance.package)
            modules = attrs.get('modules', self.instance.modules)
            try:
                attrs['package'], attrs['modules'] = module_access.normalize_modules(package, modules)
            except ValueError as e:
                raise serializers.ValidationError({'modules': [str(e)]})
        return attrs


class DeactivateSerializer(serializers.Serializer):
    category = serializers.ChoiceField(choices=DEACTIVATION_CATEGORIES)
    reason = serializers.CharField(max_length=2000)
    effective_date = serializers.DateField(required=False, allow_null=True)
    until = serializers.DateField(required=False, allow_null=True)

    def validate_reason(self, value):
        value = value.strip()
        if len(value) < 5:
            raise serializers.ValidationError('Describe the reason (at least a few words) — it is kept on record.')
        return value

    def validate(self, attrs):
        attrs['effective_date'] = attrs.get('effective_date') or timezone.localdate()
        until = attrs.get('until')
        if until and until <= attrs['effective_date']:
            raise serializers.ValidationError({'until': ['The suspension must end after it starts.']})
        return attrs


class ReactivateSerializer(serializers.Serializer):
    reason = serializers.CharField(max_length=2000, required=False, allow_blank=True, default='')


class BranchAccessMixin(serializers.Serializer):
    access_all_branches = serializers.BooleanField(required=False)
    branch_ids = serializers.ListField(child=serializers.UUIDField(), required=False)
    default_branch_id = serializers.UUIDField(required=False, allow_null=True)


class ClientUserCreateSerializer(BranchAccessMixin):
    username = serializers.CharField(max_length=150, validators=[UnicodeUsernameValidator()])
    password = serializers.CharField(write_only=True, trim_whitespace=False, max_length=128)
    role = serializers.ChoiceField(choices=module_access.CLIENT_ROLE_KEYS)
    first_name = serializers.CharField(max_length=150, required=False, allow_blank=True, default='')
    last_name = serializers.CharField(max_length=150, required=False, allow_blank=True, default='')
    email = serializers.EmailField(required=False, allow_blank=True, default='')
    phone = serializers.CharField(max_length=20, required=False, allow_blank=True, default='')

    def validate_username(self, value):
        value = value.strip()
        if get_user_model().objects.filter(username__iexact=value).exists():
            raise serializers.ValidationError(f'The username "{value}" is already taken.')
        return value

    def validate(self, attrs):
        pw = _password_errors(attrs['password'], attrs['username'], attrs.get('email'))
        if pw:
            raise serializers.ValidationError({'password': pw})
        return attrs


class ClientUserUpdateSerializer(BranchAccessMixin):
    role = serializers.ChoiceField(choices=module_access.CLIENT_ROLE_KEYS, required=False)
    first_name = serializers.CharField(max_length=150, required=False, allow_blank=True)
    last_name = serializers.CharField(max_length=150, required=False, allow_blank=True)
    email = serializers.EmailField(required=False, allow_blank=True)
    phone = serializers.CharField(max_length=20, required=False, allow_blank=True)
    is_active = serializers.BooleanField(required=False)


class PasswordResetSerializer(serializers.Serializer):
    password = serializers.CharField(write_only=True, trim_whitespace=False, max_length=128)


class ClientBranchSerializer(serializers.Serializer):
    name = serializers.CharField(max_length=100)
    code = serializers.CharField(max_length=20)
    phone = serializers.CharField(max_length=20, required=False, allow_blank=True, allow_null=True)
    email = serializers.EmailField(required=False, allow_blank=True, allow_null=True)
    address = serializers.CharField(required=False, allow_blank=True, allow_null=True)
    city = serializers.CharField(max_length=100, required=False, allow_blank=True, allow_null=True)
    state = serializers.CharField(max_length=100, required=False, allow_blank=True, allow_null=True)
    country = serializers.CharField(max_length=100, required=False, allow_blank=True, allow_null=True)
    pin_code = serializers.CharField(max_length=20, required=False, allow_blank=True, allow_null=True)
    is_active = serializers.BooleanField(required=False)
    is_default = serializers.BooleanField(required=False)

    def validate_name(self, value):
        value = value.strip()
        if not value:
            raise serializers.ValidationError('Give the branch a name.')
        return value

    def validate_code(self, value):
        value = value.strip().upper()
        if not value:
            raise serializers.ValidationError('Give the branch a short code (e.g. HO, DXB2).')
        return value
