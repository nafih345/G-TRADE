from django.db import models
from django.contrib.auth import get_user_model
from apps.common.models import BaseUUIDModel
from apps.company.models import Branch

User = get_user_model()

class AccountGroup(BaseUUIDModel):
    ACCOUNT_TYPES = [
        ('Asset', 'Asset'),
        ('Liability', 'Liability'),
        ('Equity', 'Equity'),
        ('Income', 'Income'),
        ('Expense', 'Expense'),
    ]

    name = models.CharField(max_length=100, unique=True)
    account_type = models.CharField(max_length=20, choices=ACCOUNT_TYPES)

    class Meta:
        ordering = ['name']

    def __str__(self):
        return f"{self.name} ({self.account_type})"


class ChartOfAccount(BaseUUIDModel):
    STATUS_CHOICES = [
        ('Active', 'Active'),
        ('Inactive', 'Inactive'),
    ]

    code = models.CharField(max_length=50, unique=True)
    name = models.CharField(max_length=150, unique=True)
    account_group = models.ForeignKey(AccountGroup, on_delete=models.PROTECT, related_name='accounts')
    parent_account = models.ForeignKey('self', on_delete=models.SET_NULL, null=True, blank=True, related_name='children')
    opening_balance = models.DecimalField(max_digits=15, decimal_places=2, default=0.0)
    current_balance = models.DecimalField(max_digits=15, decimal_places=2, default=0.0)
    branch = models.ForeignKey(Branch, on_delete=models.SET_NULL, null=True, blank=True, related_name='financial_accounts')
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default='Active')
    description = models.TextField(blank=True, null=True)
    is_deleted = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['code']

    def __str__(self):
        return f"{self.code} - {self.name}"


class VoucherType(BaseUUIDModel):
    name = models.CharField(max_length=100)
    code = models.CharField(max_length=20, unique=True)

    class Meta:
        ordering = ['code']

    def __str__(self):
        return f"{self.code} - {self.name}"


class JournalEntry(BaseUUIDModel):
    STATUS_CHOICES = [
        ('POSTED', 'Posted'),
        ('REVERSED', 'Reversed'),
        ('CANCELLED', 'Cancelled'),
    ]

    entry_number = models.CharField(max_length=50, unique=True)
    date = models.DateField()
    narration = models.TextField(blank=True, null=True)
    voucher_type = models.ForeignKey(VoucherType, on_delete=models.SET_NULL, null=True, blank=True, related_name='journal_entries')
    reference_type = models.CharField(max_length=50, blank=True, null=True) # e.g. SALE, WHOLESALE, PAYMENT, PURCHASE
    reference_id = models.IntegerField(null=True, blank=True)
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default='POSTED')
    reversed_entry = models.ForeignKey('self', on_delete=models.SET_NULL, null=True, blank=True, related_name='reversals')
    created_by = models.ForeignKey(User, on_delete=models.SET_NULL, null=True, blank=True, related_name='financial_journal_entries')
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-date', '-created_at']

    def __str__(self):
        return f"{self.entry_number} ({self.date}) [{self.status}]"


class LedgerEntry(BaseUUIDModel):
    journal_entry = models.ForeignKey(JournalEntry, on_delete=models.CASCADE, related_name='lines')
    account = models.ForeignKey(ChartOfAccount, on_delete=models.PROTECT, related_name='ledger_entries')
    debit = models.DecimalField(max_digits=15, decimal_places=2, default=0.0)
    credit = models.DecimalField(max_digits=15, decimal_places=2, default=0.0)

    def __str__(self):
        return f"{self.account.name} (Dr: {self.debit} | Cr: {self.credit})"
