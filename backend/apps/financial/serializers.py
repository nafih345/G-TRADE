import datetime
from decimal import Decimal

from rest_framework import serializers

from .accounting_catalog import SOURCES
from .models import (
    AccountGroup, ChartOfAccount, VoucherType, JournalEntry, LedgerEntry, AccountMapping, PostingFailure,
    FiscalPeriod, AccountingPolicy, FinancialAuditLog,
)


class AccountGroupSerializer(serializers.ModelSerializer):
    class Meta:
        model = AccountGroup
        fields = '__all__'


class ChartOfAccountSerializer(serializers.ModelSerializer):
    account_group_name = serializers.ReadOnlyField(source='account_group.name')
    account_type = serializers.ReadOnlyField()
    normal_balance = serializers.ReadOnlyField()
    parent_account_name = serializers.ReadOnlyField(source='parent_account.name')

    class Meta:
        model = ChartOfAccount
        fields = '__all__'
        # The balance cache is maintained by the posting service only.
        read_only_fields = ('current_balance', 'is_system', 'is_deleted')

    def validate_code(self, value):
        code = (value or '').strip()
        if not code:
            raise serializers.ValidationError("Account code is required.")
        qs = ChartOfAccount.all_objects.filter(code__iexact=code)
        if self.instance:
            qs = qs.exclude(pk=self.instance.pk)
        if qs.exists():
            raise serializers.ValidationError(f"Account code '{code}' already exists. Account code must be unique.")
        return code

    def validate_name(self, value):
        name = (value or '').strip()
        if not name:
            raise serializers.ValidationError("Account name is required.")
        qs = ChartOfAccount.all_objects.filter(name__iexact=name)
        if self.instance:
            qs = qs.exclude(pk=self.instance.pk)
        if qs.exists():
            raise serializers.ValidationError(f"Account name '{name}' already exists. Account name must be unique.")
        return name

    def validate(self, attrs):
        inst = self.instance
        parent = attrs.get('parent_account', inst.parent_account if inst else None)
        group = attrs.get('account_group', inst.account_group if inst else None)
        if parent is not None:
            if inst and parent.pk == inst.pk:
                raise serializers.ValidationError({'parent_account': 'An account cannot be its own parent.'})
            node, seen = parent, set()
            while node is not None and node.pk not in seen:
                if inst and node.pk == inst.pk:
                    raise serializers.ValidationError({'parent_account': 'That parent would create a loop in the hierarchy.'})
                seen.add(node.pk)
                node = node.parent_account
            if group is not None and parent.account_type != group.account_type:
                raise serializers.ValidationError({'parent_account': 'A child account must have the same account type as its parent.'})
        if inst:
            from .mapping import accounts_in_active_mappings
            type_changed = group is not None and group.account_type != inst.account_type
            deactivating = attrs.get('status', inst.status) != 'Active' and inst.status == 'Active'
            if inst.is_system and (type_changed or deactivating):
                raise serializers.ValidationError('System accounts used by automated posting cannot be deactivated or moved to another account type.')
            if inst.pk in accounts_in_active_mappings() and (type_changed or deactivating):
                raise serializers.ValidationError('This account is used by an active posting mapping. Re-map that role first.')
            if type_changed and inst.ledger_entries.exists():
                raise serializers.ValidationError('This account already has ledger postings; its account type can no longer change.')
        return attrs


class VoucherTypeSerializer(serializers.ModelSerializer):
    class Meta:
        model = VoucherType
        fields = '__all__'


class LedgerEntrySerializer(serializers.ModelSerializer):
    account_name = serializers.ReadOnlyField(source='account.name')
    account_code = serializers.ReadOnlyField(source='account.code')

    class Meta:
        model = LedgerEntry
        fields = ('id', 'journal_entry', 'account', 'account_code', 'account_name', 'debit', 'credit', 'memo')


class JournalEntrySerializer(serializers.ModelSerializer):
    lines = LedgerEntrySerializer(many=True, read_only=True)
    voucher_type_name = serializers.ReadOnlyField(source='voucher_type.name')
    voucher_type_code = serializers.ReadOnlyField(source='voucher_type.code')
    source_key = serializers.ReadOnlyField()
    reversed_entry_number = serializers.ReadOnlyField(source='reversed_entry.entry_number')
    created_by_name = serializers.ReadOnlyField(source='created_by.username')
    posted_by_name = serializers.ReadOnlyField(source='posted_by.username')

    class Meta:
        model = JournalEntry
        fields = ('id', 'entry_number', 'date', 'narration', 'voucher_type', 'voucher_type_code', 'voucher_type_name',
                  'reference_type', 'reference_id', 'source_module', 'source_event', 'source_key', 'source_number',
                  'status', 'is_reversal', 'reversed_entry', 'reversed_entry_number', 'branch', 'total_amount',
                  'metadata', 'posted_at', 'posted_by_name', 'created_by_name', 'created_at', 'lines')
        read_only_fields = fields


class VoucherLineInputSerializer(serializers.Serializer):
    account = serializers.CharField()
    debit = serializers.DecimalField(max_digits=15, decimal_places=2, required=False, default=0, min_value=Decimal('0'))
    credit = serializers.DecimalField(max_digits=15, decimal_places=2, required=False, default=0, min_value=Decimal('0'))
    memo = serializers.CharField(required=False, allow_blank=True, default='')


class VoucherInputSerializer(serializers.Serializer):
    voucher_type_code = serializers.ChoiceField(choices=('RV', 'PV', 'CV', 'JV'))
    date = serializers.DateField()
    narration = serializers.CharField(required=False, allow_blank=True, default='')
    reference_no = serializers.CharField(required=False, allow_blank=True, default='', max_length=80)
    status = serializers.ChoiceField(choices=('DRAFT', 'POSTED'), default='POSTED')
    idempotency_key = serializers.CharField(required=False, allow_blank=True, allow_null=True, max_length=120)
    branch = serializers.UUIDField(required=False, allow_null=True)
    lines = VoucherLineInputSerializer(many=True)


class AccountMappingSerializer(serializers.ModelSerializer):
    account_code = serializers.ReadOnlyField(source='account.code')
    account_name = serializers.ReadOnlyField(source='account.name')
    branch_name = serializers.ReadOnlyField(source='branch.name')

    class Meta:
        model = AccountMapping
        fields = ('id', 'role', 'account', 'account_code', 'account_name', 'branch', 'branch_name',
                  'effective_from', 'is_active', 'notes', 'created_at', 'updated_at')
        read_only_fields = ('is_active', 'created_at', 'updated_at')


class PostingFailureSerializer(serializers.ModelSerializer):
    source_key = serializers.SerializerMethodField()
    source_label = serializers.SerializerMethodField()
    resolved_by_name = serializers.ReadOnlyField(source='resolved_by.username')

    class Meta:
        model = PostingFailure
        fields = ('id', 'source_module', 'source_event', 'source_key', 'source_label', 'reference_id', 'source_number',
                  'kind', 'error', 'attempts', 'status', 'created_at', 'last_failed_at', 'resolved_at', 'resolved_by_name')

    def get_source_key(self, obj):
        return f"{obj.source_module}.{obj.source_event}"

    def get_source_label(self, obj):
        return SOURCES.get(self.get_source_key(obj), (self.get_source_key(obj),))[0]


class FiscalPeriodSerializer(serializers.ModelSerializer):
    closed_by_name = serializers.ReadOnlyField(source='closed_by.username')

    class Meta:
        model = FiscalPeriod
        fields = ('id', 'name', 'start_date', 'end_date', 'status', 'closed_at', 'closed_by_name')
        read_only_fields = ('status', 'closed_at', 'closed_by_name')

    def validate(self, attrs):
        start = attrs.get('start_date', getattr(self.instance, 'start_date', None))
        end = attrs.get('end_date', getattr(self.instance, 'end_date', None))
        if start and end and end < start:
            raise serializers.ValidationError('The period must end on or after its start date.')
        if self.instance and self.instance.status == 'CLOSED':
            raise serializers.ValidationError('Re-open a closed period before changing it.')
        overlap = FiscalPeriod.objects.filter(start_date__lte=end, end_date__gte=start)
        if self.instance:
            overlap = overlap.exclude(pk=self.instance.pk)
        if overlap.exists():
            raise serializers.ValidationError(f"Overlaps the existing period '{overlap.first().name}'.")
        return attrs


class AccountingPolicySerializer(serializers.ModelSerializer):
    class Meta:
        model = AccountingPolicy
        fields = ('auto_posting_enabled', 'source_enabled', 'source_start_dates', 'backdate_limit_days',
                  'inventory_valuation', 'updated_at')
        read_only_fields = ('inventory_valuation', 'updated_at')

    def validate_source_enabled(self, value):
        if not isinstance(value, dict) or any(k not in SOURCES or not isinstance(v, bool) for k, v in value.items()):
            raise serializers.ValidationError('Expected {source_key: true/false} for known sources.')
        return value

    def validate_source_start_dates(self, value):
        if not isinstance(value, dict):
            raise serializers.ValidationError('Expected {source_key: "YYYY-MM-DD" | null}.')
        for k, v in value.items():
            if k not in SOURCES:
                raise serializers.ValidationError(f"Unknown source '{k}'.")
            if v:
                try:
                    datetime.date.fromisoformat(str(v)[:10])
                except ValueError:
                    raise serializers.ValidationError(f"'{v}' is not a date.")
        return {k: (str(v)[:10] if v else None) for k, v in value.items()}


class FinancialAuditLogSerializer(serializers.ModelSerializer):
    class Meta:
        model = FinancialAuditLog
        fields = '__all__'
