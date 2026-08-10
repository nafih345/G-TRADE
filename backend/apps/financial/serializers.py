from rest_framework import serializers
from .models import AccountGroup, ChartOfAccount, VoucherType, JournalEntry, LedgerEntry

class AccountGroupSerializer(serializers.ModelSerializer):
    class Meta:
        model = AccountGroup
        fields = '__all__'


class ChartOfAccountSerializer(serializers.ModelSerializer):
    account_group_name = serializers.ReadOnlyField(source='account_group.name')
    account_type = serializers.ReadOnlyField(source='account_group.account_type')
    parent_account_name = serializers.ReadOnlyField(source='parent_account.name')

    class Meta:
        model = ChartOfAccount
        fields = '__all__'

    def validate_code(self, value):
        code_trimmed = (value or '').strip()
        if not code_trimmed:
            raise serializers.ValidationError("Account code is required.")
        query = ChartOfAccount.objects.filter(code__iexact=code_trimmed)
        if this_id := self.instance.id if self.instance else None:
            query = query.exclude(id=this_id)
        if query.exists():
            raise serializers.ValidationError(f"Account code '{code_trimmed}' already exists. Account code must be unique.")
        return code_trimmed

    def validate_name(self, value):
        name_trimmed = (value or '').strip()
        if not name_trimmed:
            raise serializers.ValidationError("Account name is required.")
        query = ChartOfAccount.objects.filter(name__iexact=name_trimmed)
        if this_id := self.instance.id if self.instance else None:
            query = query.exclude(id=this_id)
        if query.exists():
            raise serializers.ValidationError(f"Account name '{name_trimmed}' already exists. Account name must be unique.")
        return name_trimmed


class VoucherTypeSerializer(serializers.ModelSerializer):
    class Meta:
        model = VoucherType
        fields = '__all__'


class LedgerEntrySerializer(serializers.ModelSerializer):
    account_name = serializers.ReadOnlyField(source='account.name')
    account_code = serializers.ReadOnlyField(source='account.code')

    class Meta:
        model = LedgerEntry
        fields = '__all__'


class JournalEntrySerializer(serializers.ModelSerializer):
    lines = LedgerEntrySerializer(many=True, read_only=True)
    voucher_type_name = serializers.ReadOnlyField(source='voucher_type.name')
    voucher_type_code = serializers.ReadOnlyField(source='voucher_type.code')

    class Meta:
        model = JournalEntry
        fields = '__all__'
