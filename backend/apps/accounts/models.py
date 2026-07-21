from django.db import models
from apps.common.models import BaseUUIDModel

class Account(BaseUUIDModel):
    ACCOUNT_TYPES = [
        ('ASSET', 'Asset'),
        ('LIABILITY', 'Liability'),
        ('EQUITY', 'Equity'),
        ('INCOME', 'Income'),
        ('EXPENSE', 'Expense'),
    ]

    name = models.CharField(max_length=150)
    code = models.CharField(max_length=50, unique=True)
    account_type = models.CharField(max_length=20, choices=ACCOUNT_TYPES)
    parent = models.ForeignKey('self', on_delete=models.SET_NULL, null=True, blank=True, related_name='children')
    description = models.TextField(blank=True, null=True)
    balance = models.DecimalField(max_digits=15, decimal_places=2, default=0.0)

    def __str__(self):
        return f"{self.code} - {self.name}"


class JournalEntry(BaseUUIDModel):
    STATUS_CHOICES = [
        ('DRAFT', 'Draft'),
        ('POSTED', 'Posted'),
    ]

    entry_number = models.CharField(max_length=50, unique=True)
    date = models.DateField()
    description = models.TextField(blank=True, null=True)
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default='DRAFT')

    def __str__(self):
        return self.entry_number


class JournalItem(BaseUUIDModel):
    journal_entry = models.ForeignKey(JournalEntry, on_delete=models.CASCADE, related_name='items')
    account = models.ForeignKey(Account, on_delete=models.CASCADE, related_name='journal_items')
    debit = models.DecimalField(max_digits=15, decimal_places=2, default=0.0)
    credit = models.DecimalField(max_digits=15, decimal_places=2, default=0.0)
    memo = models.CharField(max_length=255, blank=True, null=True)

    def __str__(self):
        return f"{self.account.name} (D: {self.debit} | C: {self.credit})"
