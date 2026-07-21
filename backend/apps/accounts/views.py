from rest_framework import viewsets, permissions
from rest_framework.serializers import ModelSerializer
from django.db import transaction
from .models import Account, JournalEntry, JournalItem

class AccountSerializer(ModelSerializer):
    class Meta:
        model = Account
        fields = '__all__'

class JournalItemSerializer(ModelSerializer):
    class Meta:
        model = JournalItem
        fields = '__all__'

class JournalEntrySerializer(ModelSerializer):
    items = JournalItemSerializer(many=True, read_only=True)

    class Meta:
        model = JournalEntry
        fields = '__all__'

class AccountViewSet(viewsets.ModelViewSet):
    queryset = Account.objects.all()
    serializer_class = AccountSerializer
    permission_classes = [permissions.IsAuthenticated]

class JournalEntryViewSet(viewsets.ModelViewSet):
    queryset = JournalEntry.objects.all()
    serializer_class = JournalEntrySerializer
    permission_classes = [permissions.IsAuthenticated]

    def perform_create(self, serializer):
        with transaction.atomic():
            je = serializer.save()
            if je.status == 'POSTED':
                self._post_journal(je)

    def perform_update(self, serializer):
        with transaction.atomic():
            je = serializer.save()
            if je.status == 'POSTED':
                self._post_journal(je)

    def _post_journal(self, je):
        for item in je.items.all():
            account = item.account
            # Update balances based on debit and credit entries
            # Asset / Expense increases on Debit, decreases on Credit.
            # Liability / Equity / Income increases on Credit, decreases on Debit.
            if account.account_type in ['ASSET', 'EXPENSE']:
                account.balance += (item.debit - item.credit)
            else:
                account.balance += (item.credit - item.debit)
            account.save()
