from decimal import Decimal
import re

from django.utils import timezone
from django.utils.text import slugify
from rest_framework import serializers

from . import tokens
from .models import ClientLicense, LicenseAuditEvent, LicensedClient, LicensePlan
from .service import LicenceError, clean_plan_modules

LIMIT_FIELDS = (('max_clients', 0), ('max_companies', 1), ('max_branches', 1), ('max_users', 1))


class PlanSerializer(serializers.ModelSerializer):
    """Each limit must be SENT on create: a number, or null for an explicitly unlimited limit."""
    code = serializers.CharField(max_length=40, required=False, allow_blank=True)
    max_clients = serializers.IntegerField(allow_null=True, min_value=0, max_value=100000)
    max_companies = serializers.IntegerField(allow_null=True, min_value=1, max_value=1000)
    max_branches = serializers.IntegerField(allow_null=True, min_value=1, max_value=100000)
    max_users = serializers.IntegerField(allow_null=True, min_value=1, max_value=100000)
    modules = serializers.ListField(child=serializers.CharField(), allow_empty=False)
    settings_features = serializers.ListField(child=serializers.CharField(), allow_null=True, required=False)
    duration = serializers.IntegerField(min_value=1, max_value=60, required=False, default=1)
    grace_days = serializers.IntegerField(min_value=0, max_value=90, required=False, default=7)
    price = serializers.DecimalField(max_digits=12, decimal_places=2, min_value=Decimal('0'))
    licence_count = serializers.SerializerMethodField()

    class Meta:
        model = LicensePlan
        fields = ('id', 'code', 'name', 'description', 'edition', 'billing_cycle', 'duration', 'price', 'currency',
                  'max_clients', 'max_companies', 'max_branches', 'max_users', 'modules', 'settings_features',
                  'grace_days', 'is_active', 'created_at', 'updated_at', 'created_by', 'updated_by', 'licence_count')
        read_only_fields = ('id', 'is_active', 'created_at', 'updated_at', 'created_by', 'updated_by')

    def get_licence_count(self, obj):
        return getattr(obj, 'licence_count', None)

    def validate_currency(self, value):
        value = (value or '').strip().upper()
        if not re.fullmatch(r'[A-Z]{3}', value):
            raise serializers.ValidationError('Use a 3-letter currency code such as INR.')
        return value

    def validate_name(self, value):
        value = (value or '').strip()
        if not value:
            raise serializers.ValidationError('Give the plan a name.')
        return value

    def validate(self, attrs):
        inst = self.instance
        if inst is not None and ('edition' in attrs and attrs['edition'] != inst.edition) and inst.licences.exists():
            raise serializers.ValidationError({'edition': 'Licences were issued on this plan; its edition cannot change.'})
        merged = {f: attrs.get(f, getattr(inst, f, None)) for f in ('modules', 'settings_features', 'name', 'code',
                                                                     'edition', 'billing_cycle')}
        try:
            attrs['modules'], attrs['settings_features'] = clean_plan_modules(merged['modules'],
                                                                              merged['settings_features'])
        except LicenceError as exc:
            raise serializers.ValidationError({'modules': exc.message})
        if inst is None or 'code' in attrs or 'name' in attrs:
            code = slugify(merged['code'] or '') or slugify(merged['name'] or '')[:40]
            if not code:
                raise serializers.ValidationError({'code': 'Give the plan a code.'})
            clash = LicensePlan.objects.filter(code=code)
            if inst is not None:
                clash = clash.exclude(pk=inst.pk)
            if clash.exists():
                raise serializers.ValidationError({'code': f'A plan with the code "{code}" already exists.'})
            attrs['code'] = code
        if merged['billing_cycle'] == tokens.LIFETIME:
            attrs['duration'] = 1
        if merged['edition'] == tokens.CLOUD and 'max_clients' in attrs:
            attrs['max_clients'] = None  # client counts apply to the Windows Local Super Admin only
        return attrs


class ClientSerializer(serializers.ModelSerializer):
    licence_count = serializers.SerializerMethodField()

    class Meta:
        model = LicensedClient
        fields = ('id', 'client_code', 'name', 'owner_name', 'email', 'phone', 'country', 'address', 'edition',
                  'tenant_id', 'created_at', 'licence_count')

    def get_licence_count(self, obj):
        return getattr(obj, 'licence_count', None)


def mask_key(token: str) -> str:
    return f'GTL1.••••••••{token[-8:]}' if token else ''


def subscription_label(cycle: str, duration) -> str:
    """Monthly / Quarterly / Half-Yearly / Yearly / Lifetime (else "N months" / "N years")."""
    n = int(duration or 1)
    if cycle == tokens.LIFETIME:
        return 'Lifetime'
    if cycle == tokens.MONTHLY:
        return {1: 'Monthly', 3: 'Quarterly', 6: 'Half-Yearly', 12: 'Yearly'}.get(n, f'{n} months')
    return 'Yearly' if n == 1 else f'{n} years'


def key_available(lic) -> bool:
    """Windows Local Super Admin: a licence not yet bound to the customer's installation has no
    usable key (an unbound key needs an online licence authority, which this offline vendor
    installation is not); bind the Installation ID first. Cloud console: always available."""
    from .service import local_edition
    return bool(lic.key_token) and not (local_edition() and lic.edition == tokens.WINDOWS_LOCAL and not lic.install_id)


class LicenceSerializer(serializers.ModelSerializer):
    client = serializers.SerializerMethodField()
    plan = serializers.SerializerMethodField()
    effective_status = serializers.SerializerMethodField()
    activation_status = serializers.SerializerMethodField()
    lifetime = serializers.BooleanField(source='is_lifetime', read_only=True)
    key_masked = serializers.SerializerMethodField()
    days_left = serializers.SerializerMethodField()
    development_key = serializers.SerializerMethodField()
    hardware_bound = serializers.SerializerMethodField()

    class Meta:
        model = ClientLicense
        fields = ('id', 'lic_id', 'client', 'plan', 'tier', 'custom_terms', 'edition', 'billing_cycle', 'duration',
                  'starts_on', 'expires_on',
                  'lifetime', 'status', 'status_reason', 'effective_status', 'activation_status', 'install_id',
                  'hardware_bound', 'activated_at', 'last_checkin_at', 'revision', 'key_masked', 'key_id',
                  'development_key', 'issued_at', 'days_left', 'limits', 'modules', 'settings_features', 'grace_days',
                  'revoked_at', 'created_at', 'created_by', 'renewal_status', 'key_available', 'subscription')

    tier = serializers.SerializerMethodField()
    custom_terms = serializers.SerializerMethodField()
    renewal_status = serializers.SerializerMethodField()
    key_available = serializers.SerializerMethodField()
    subscription = serializers.SerializerMethodField()

    def get_renewal_status(self, obj):
        from .service import renewal_status
        return renewal_status(obj)

    def get_key_available(self, obj):
        return key_available(obj)

    def get_subscription(self, obj):
        return subscription_label(obj.billing_cycle, obj.duration)

    def get_tier(self, obj):
        return (obj.plan_snapshot or {}).get('tier', '')

    def get_custom_terms(self, obj):
        return bool((obj.plan_snapshot or {}).get('custom'))

    def get_client(self, obj):
        c = obj.client
        return {'id': str(c.pk), 'client_code': c.client_code, 'name': c.name, 'edition': c.edition,
                'tenant_id': c.tenant_id, 'email': c.email, 'phone': c.phone}

    def get_plan(self, obj):
        snap = obj.plan_snapshot or {}
        return {'id': str(obj.plan_id), 'code': snap.get('code', ''), 'name': snap.get('name', ''),
                'price': snap.get('price'), 'currency': snap.get('currency')}

    def get_effective_status(self, obj):
        return obj.effective_status()

    def get_activation_status(self, obj):
        return obj.activation_status()

    def get_key_masked(self, obj):
        return mask_key(obj.key_token)

    def get_days_left(self, obj):
        return (obj.expires_on - timezone.localdate()).days if obj.expires_on else None

    def get_development_key(self, obj):
        return obj.key_id.startswith('gtl-dev-')

    def get_hardware_bound(self, obj):
        return bool(obj.install_fp)


class AuditSerializer(serializers.ModelSerializer):
    lic_id = serializers.CharField(source='licence.lic_id', default=None, read_only=True)
    plan_name = serializers.CharField(source='plan.name', default=None, read_only=True)
    client_name = serializers.CharField(source='client.name', default=None, read_only=True)

    class Meta:
        model = LicenseAuditEvent
        fields = ('id', 'created_at', 'action', 'actor', 'reason', 'details', 'ip', 'lic_id', 'plan_name', 'client_name')


class NewClientSerializer(serializers.Serializer):
    name = serializers.CharField(max_length=150)
    owner_name = serializers.CharField(max_length=150, required=False, allow_blank=True, default='')
    email = serializers.EmailField(required=False, allow_blank=True, default='')
    phone = serializers.CharField(max_length=20, required=False, allow_blank=True, default='')
    country = serializers.CharField(max_length=2, required=False, allow_blank=True, default='')
    address = serializers.CharField(max_length=1000, required=False, allow_blank=True, default='')


class TermsSerializer(serializers.Serializer):
    """This customer's own terms over the plan's defaults (service.apply_overrides). Only the keys
    sent are changed; a limit sent as null is unlimited."""
    expires_on = serializers.DateField(required=False, allow_null=True)
    limits = serializers.DictField(required=False)
    modules = serializers.ListField(child=serializers.CharField(), required=False)
    settings_features = serializers.ListField(child=serializers.CharField(), required=False, allow_null=True)
    tier = serializers.CharField(required=False, allow_blank=True, max_length=20)


class LicenceCreateSerializer(serializers.Serializer):
    plan_id = serializers.UUIDField()
    terms = TermsSerializer(required=False, allow_null=True, default=None)
    starts_on = serializers.DateField(required=False, allow_null=True, default=None)
    client_id = serializers.UUIDField(required=False, allow_null=True, default=None)
    tenant_id = serializers.IntegerField(required=False, allow_null=True, default=None)
    client = NewClientSerializer(required=False, allow_null=True, default=None)
    installation = serializers.CharField(required=False, allow_blank=True, default='', max_length=4000)

    def validate(self, attrs):
        given = [k for k in ('client_id', 'tenant_id', 'client') if attrs.get(k)]
        if len(given) != 1:
            raise serializers.ValidationError({'client': 'Choose an existing client or enter the new client\'s details.'})
        try:
            attrs['install'] = tokens.parse_installation(attrs['installation'])
        except ValueError as exc:
            raise serializers.ValidationError({'installation': str(exc)})
        attrs['starts_on'] = attrs['starts_on'] or timezone.localdate()
        return attrs
