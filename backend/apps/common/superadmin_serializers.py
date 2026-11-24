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


PLAN_KEYS = tuple(k for k, _l in Tenant.SUBSCRIPTION_PLANS)
SUBSCRIPTION_FIELDS = ('subscription_plan', 'subscription_starts_on', 'subscription_expires_on', 'max_branches')
PROFILE_FIELDS = ('owner_name', 'country', 'address')


def validate_subscription(attrs, instance=None):
    """Field errors for the subscription terms, with `attrs` merged over `instance`. A plan other
    than Perpetual needs an end date (a trial's end for TRIAL); Perpetual has none."""
    def cur(key):
        return attrs[key] if key in attrs else (getattr(instance, key) if instance is not None else None)
    errors = {}
    plan = cur('subscription_plan') or 'PERPETUAL'
    starts, expires = cur('subscription_starts_on'), cur('subscription_expires_on')
    if plan == 'PERPETUAL':
        if 'subscription_expires_on' in attrs and attrs['subscription_expires_on']:
            errors['subscription_expires_on'] = ['A perpetual subscription has no expiry date. Pick a term plan '
                                                 'or clear the date.']
        elif instance is not None and 'subscription_plan' in attrs:
            attrs['subscription_expires_on'] = None  # switching to Perpetual drops the old end date
    elif not expires:
        errors['subscription_expires_on'] = ['Enter the date the trial ends.' if plan == 'TRIAL'
                                             else 'Enter the date the subscription ends.']
    if starts and expires and expires < starts:
        errors['subscription_expires_on'] = ['The subscription must end on or after its start date.']
    return errors


def country_defaults(code):
    from apps.company.localization import COUNTRIES
    row = next((c for c in COUNTRIES if c[0] == code), None)
    if row is None:
        return {}
    return {'name': row[1], 'currency': row[2], 'time_zone': row[3], 'date_format': row[4],
            'number_format': row[5], 'language': row[6], 'fiscal_year_start_month': row[7]}


def _fiscal_year_for(month, today=None):
    import datetime
    today = today or timezone.localdate()
    start_year = today.year if today.month >= month else today.year - 1
    start = datetime.date(start_year, month, 1)
    end = datetime.date(start_year + 1, month, 1) - datetime.timedelta(days=1)
    return start, end


class TenantOnboardSerializer(serializers.Serializer):
    # Client (the customer the platform contracts with)
    tenant_name = serializers.CharField(max_length=150)
    owner_name = serializers.CharField(max_length=150, required=False, allow_blank=True, default='')
    admin_email = serializers.EmailField(required=False, allow_blank=True, default='')
    contact_phone = serializers.CharField(max_length=20, required=False, allow_blank=True, default='')
    country = serializers.CharField(max_length=2, required=False, allow_blank=True, default='')
    address = serializers.CharField(max_length=1000, required=False, allow_blank=True, default='')
    tax_registration_no = serializers.CharField(max_length=30, required=False, allow_blank=True, default='')
    logo_data_url = serializers.CharField(required=False, allow_blank=True, default='', trim_whitespace=True)
    # Company (the business's own identity, printed on its documents)
    company_name = serializers.CharField(max_length=150, required=False, allow_blank=True, default='')
    company_registration_no = serializers.CharField(max_length=60, required=False, allow_blank=True, default='')
    business_address = serializers.CharField(max_length=1000, required=False, allow_blank=True, default='')
    currency = serializers.CharField(max_length=3, required=False, allow_blank=True, default='')
    language = serializers.CharField(max_length=10, required=False, allow_blank=True, default='')
    time_zone = serializers.CharField(max_length=64, required=False, allow_blank=True, default='')
    tax_enabled = serializers.BooleanField(required=False, default=True)
    # Main branch
    branch_name = serializers.CharField(max_length=100, required=False, allow_blank=True, default='')
    branch_address = serializers.CharField(max_length=1000, required=False, allow_blank=True, default='')
    branch_phone = serializers.CharField(max_length=20, required=False, allow_blank=True, default='')
    branch_email = serializers.EmailField(required=False, allow_blank=True, default='')
    # Administrator: a password now, or an invitation link (no password chosen by the platform)
    admin_username = serializers.CharField(max_length=150, validators=[UnicodeUsernameValidator()])
    admin_name = serializers.CharField(max_length=150, required=False, allow_blank=True, default='')
    invite_admin = serializers.BooleanField(required=False, default=False)
    password = serializers.CharField(write_only=True, trim_whitespace=False, max_length=128, required=False,
                                     allow_blank=True, default='')
    # Modules and subscription
    package = serializers.CharField(required=False, default=module_access.FULL_SUITE)
    modules = ModulesField(required=False, default=list)
    settings_features = serializers.ListField(child=serializers.CharField(), required=False, allow_null=True,
                                              default=None)
    max_users = serializers.IntegerField(required=False, default=5, min_value=1, max_value=10000)
    max_branches = serializers.IntegerField(required=False, allow_null=True, default=None, min_value=1,
                                            max_value=1000)
    subscription_plan = serializers.ChoiceField(choices=PLAN_KEYS, required=False, default='PERPETUAL')
    subscription_starts_on = serializers.DateField(required=False, allow_null=True, default=None)
    subscription_expires_on = serializers.DateField(required=False, allow_null=True, default=None)

    def to_internal_value(self, data):
        # A missing password is reported with the other blank fields in one go (the password is
        # optional only when an invitation is sent instead, which validate() can't see while
        # other fields are already invalid).
        try:
            return super().to_internal_value(data)
        except serializers.ValidationError as exc:
            invite = str(data.get('invite_admin')).lower() in ('true', '1')
            if isinstance(exc.detail, dict) and not invite and not str(data.get('password') or ''):
                exc.detail.setdefault('password', ['Enter a password, or choose to send the admin an '
                                                   'invitation link instead.'])
            raise

    def validate(self, attrs):
        from apps.company import localization
        from apps.company.store_profile import clean_logo
        errors = {}
        try:
            check_available(attrs['tenant_name'].strip(), attrs['admin_username'].strip())
        except OnboardingError as e:
            errors[e.field] = [e.message]
        try:
            attrs['package'], attrs['modules'] = module_access.normalize_modules(attrs['package'], attrs['modules'])
        except ValueError as e:
            errors['modules'] = [str(e)]
        try:
            attrs['settings_features'] = module_access.normalize_settings_features(attrs.get('settings_features'))
        except ValueError as e:
            errors['settings_features'] = [str(e)]
        if attrs['invite_admin']:
            attrs['password'] = None  # set by the admin through the invitation link
        elif not attrs['password']:
            errors['password'] = ['Enter a password, or choose to send the admin an invitation link instead.']
        else:
            pw = _password_errors(attrs['password'], attrs['admin_username'], attrs.get('admin_email'))
            if pw:
                errors['password'] = pw
        errors.update(validate_subscription(attrs))
        if not attrs.get('subscription_starts_on'):
            attrs['subscription_starts_on'] = timezone.localdate()

        # Country drives the defaults the form left blank (currency, time zone, language, formats).
        country = attrs['country'].strip().upper()
        if country and country not in localization.COUNTRY_CODES:
            errors['country'] = ['Choose a supported country.']
            country = ''
        attrs['country'] = country
        suggested = country_defaults(country)
        prefs_in = {'tax_enabled': attrs['tax_enabled']}
        if country:
            prefs_in.update(country=country, region='', date_format=suggested['date_format'],
                            number_format=suggested['number_format'],
                            fiscal_year_start_month=suggested['fiscal_year_start_month'])
        for key, pref in (('currency', 'base_currency'), ('language', 'language'), ('time_zone', 'time_zone')):
            value = attrs[key].strip() or suggested.get(key, '')
            if value:
                prefs_in[pref] = value
        prefs, pref_errors = localization.validate_preferences(prefs_in, dict(localization.DEFAULTS))
        for key, msg in pref_errors.items():
            errors[{'base_currency': 'currency'}.get(key, key)] = [msg if isinstance(msg, str) else str(msg)]
        try:
            tax_reg = localization.clean_tax_registration(attrs['tax_registration_no'], country)
        except ValueError as e:
            errors['tax_registration_no'] = [str(e)]
            tax_reg = ''
        logo, logo_error = clean_logo(attrs['logo_data_url'])
        if logo_error:
            errors['logo_data_url'] = [logo_error]
        if errors:
            raise serializers.ValidationError(errors)

        currency = prefs.get('base_currency')
        company = {
            'name': attrs['company_name'].strip() or attrs['tenant_name'].strip(),
            'business_reg_no': attrs['company_registration_no'].strip(),
            'gstin': tax_reg,
            'address': attrs['business_address'].strip() or attrs['address'].strip(),
            'country': suggested.get('name', ''),
            'contact_person': attrs['owner_name'].strip(),
            'currency': localization.CURRENCY_BY_CODE[currency][2] if currency else '',
        }
        if prefs.get('fiscal_year_start_month'):
            company['fiscal_year_start'], company['fiscal_year_end'] = _fiscal_year_for(prefs['fiscal_year_start_month'])
        attrs['company_profile'] = company
        attrs['preferences'] = prefs
        attrs['logo'] = logo
        attrs['tenant_profile'] = {'owner_name': attrs['owner_name'].strip(), 'country': country,
                                   'address': attrs['address'].strip()}
        attrs['subscription'] = {k: attrs[k] for k in SUBSCRIPTION_FIELDS}
        attrs['branch_details'] = {'address': attrs['branch_address'].strip(), 'phone': attrs['branch_phone'].strip(),
                                   'email': attrs['branch_email'].strip(),
                                   'country': suggested.get('name', '')}
        return attrs


def tenant_status(tenant):
    """INACTIVE (deactivated) > EXPIRED (subscription ended) > SCHEDULED (deactivation coming) >
    TRIAL > ACTIVE."""
    due = tenant.deactivation_effective_date and tenant.deactivation_effective_date <= timezone.localdate()
    if not tenant.is_active or due:
        return 'INACTIVE'
    if tenant.is_subscription_expired:
        return 'EXPIRED'
    if tenant.deactivation_effective_date:
        return 'SCHEDULED'
    return 'TRIAL' if tenant.subscription_plan == 'TRIAL' else 'ACTIVE'


class TenantSerializer(serializers.ModelSerializer):
    """List / detail row. primary_admin, branch_count and active_user_count come from maps the
    view builds for the whole page in a few queries (TenantAdminViewSet._context_for)."""
    user_count = serializers.IntegerField(read_only=True)
    active_user_count = serializers.IntegerField(read_only=True)
    primary_admin = serializers.SerializerMethodField()
    branch_count = serializers.SerializerMethodField()
    status = serializers.SerializerMethodField()
    is_platform = serializers.SerializerMethodField()
    # Phase 2: the customer organization this company belongs to and how many companies it may hold.
    organization_id = serializers.IntegerField(read_only=True)
    organization_name = serializers.SerializerMethodField()
    max_companies = serializers.SerializerMethodField()
    company_name = serializers.SerializerMethodField()
    active_branch_count = serializers.SerializerMethodField()
    days_to_expiry = serializers.SerializerMethodField()
    subscription = serializers.SerializerMethodField()

    class Meta:
        model = Tenant
        fields = ('id', 'name', 'code', 'is_active', 'status', 'is_platform', 'created_at',
                  'organization_id', 'organization_name', 'max_companies', 'company_name',
                  'owner_name', 'country', 'address',
                  'contact_email', 'contact_phone', 'primary_admin', 'user_count', 'active_user_count',
                  'max_users', 'branch_count', 'active_branch_count', 'max_branches',
                  'package', 'modules', 'settings_features', 'module_features',
                  'subscription_plan', 'subscription_starts_on', 'subscription_expires_on', 'days_to_expiry',
                  'deactivation_category', 'deactivation_reason', 'deactivation_effective_date',
                  'deactivation_until', 'deactivated_at', 'deactivated_by', 'subscription')
        read_only_fields = fields

    def get_subscription(self, obj):
        # Windows Local Hosted Workspaces: the current subscription (by dates and status), or None.
        return self.context.get('subscriptions', {}).get(obj.pk)

    def get_primary_admin(self, obj):
        return self.context.get('admins', {}).get(obj.pk)

    def get_branch_count(self, obj):
        return self.context.get('branch_counts', {}).get(obj.pk, 0)

    def get_active_branch_count(self, obj):
        return self.context.get('active_branch_counts', {}).get(obj.pk, 0)

    def get_company_name(self, obj):
        return self.context.get('company_names', {}).get(obj.pk) or obj.name

    def get_days_to_expiry(self, obj):
        if not obj.subscription_expires_on:
            return None
        return (obj.subscription_expires_on - timezone.localdate()).days

    def get_status(self, obj):
        return tenant_status(obj)

    def get_is_platform(self, obj):
        from apps.common import tenancy
        return obj.pk == tenancy.DEFAULT_TENANT_ID

    def get_organization_name(self, obj):
        return obj.organization.name if obj.organization_id else None

    def get_max_companies(self, obj):
        return obj.organization.max_companies if obj.organization_id else None


class TenantUpdateSerializer(serializers.Serializer):
    """PATCH /tenants/<id>/ — profile, subscription, seats, role permissions, multi-branch."""
    name = serializers.CharField(max_length=150, required=False)
    contact_email = serializers.EmailField(required=False, allow_blank=True)
    contact_phone = serializers.CharField(max_length=20, required=False, allow_blank=True)
    package = serializers.CharField(required=False)
    modules = ModulesField(required=False)
    settings_features = serializers.ListField(child=serializers.CharField(), required=False, allow_null=True)
    # Opt-in features inside a module ({key: bool}); merged over what the tenant has.
    module_features = serializers.DictField(child=serializers.BooleanField(), required=False)
    max_users = serializers.IntegerField(required=False, min_value=1, max_value=10000)
    role_permissions = serializers.DictField(required=False)
    multi_branch_enabled = serializers.BooleanField(required=False)
    # Phase 2: the organization's company limit (applies to every company of that organization).
    max_companies = serializers.IntegerField(required=False, min_value=1, max_value=1000)
    owner_name = serializers.CharField(max_length=150, required=False, allow_blank=True)
    country = serializers.CharField(max_length=2, required=False, allow_blank=True)
    address = serializers.CharField(max_length=1000, required=False, allow_blank=True)
    subscription_plan = serializers.ChoiceField(choices=PLAN_KEYS, required=False)
    subscription_starts_on = serializers.DateField(required=False, allow_null=True)
    subscription_expires_on = serializers.DateField(required=False, allow_null=True)
    max_branches = serializers.IntegerField(required=False, allow_null=True, min_value=1, max_value=1000)

    def validate_country(self, value):
        from apps.company.localization import COUNTRY_CODES
        value = value.strip().upper()
        if value and value not in COUNTRY_CODES:
            raise serializers.ValidationError('Choose a supported country.')
        return value

    def validate_max_branches(self, value):
        from apps.common.tenant_onboarding import active_branch_count
        if value is None:
            return value
        used = active_branch_count(self.instance)
        if value < used:
            raise serializers.ValidationError(
                f'{used} branches are active. Deactivate branches first, or allow at least {used}.')
        return value

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

    def validate_settings_features(self, value):
        try:
            return module_access.normalize_settings_features(value)
        except ValueError as e:
            raise serializers.ValidationError(str(e))

    def validate_module_features(self, value):
        try:
            merged = dict(self.instance.module_features or {}) if self.instance is not None else {}
            merged.update(module_access.normalize_module_features(value))
            return merged
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
        if 'module_features' in attrs and self.instance.pk == tenancy.DEFAULT_TENANT_ID:
            raise serializers.ValidationError(
                {'module_features': ["Switch the platform account's own features in Settings → Business Settings."]})
        if 'settings_features' in attrs and self.instance.pk == tenancy.DEFAULT_TENANT_ID:
            raise serializers.ValidationError(
                {'settings_features': ['The platform account always has every Settings section.']})
        if set(SUBSCRIPTION_FIELDS) & set(attrs):
            if self.instance.pk == tenancy.DEFAULT_TENANT_ID:
                raise serializers.ValidationError(
                    {'subscription_plan': ['The platform account has no subscription terms or limits.']})
            errors = validate_subscription(attrs, self.instance)
            if errors:
                raise serializers.ValidationError(errors)
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
    # invite = True: no password now; the console fetches a one-time setup link next.
    invite = serializers.BooleanField(required=False, default=False)
    password = serializers.CharField(write_only=True, trim_whitespace=False, max_length=128, required=False,
                                     allow_blank=True, default='')
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
        if attrs['invite']:
            attrs['password'] = None
            return attrs
        if not attrs['password']:
            raise serializers.ValidationError({'password': ['Enter a password, or send an invitation link instead.']})
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
