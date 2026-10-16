from django.db import models
from django.db.models import Q
from django.contrib.auth import get_user_model
from django.core.exceptions import ValidationError
from apps.common.models import BaseUUIDModel
from apps.company.models import Branch

User = get_user_model()

DEBIT_NORMAL_TYPES = ('Asset', 'Expense')


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
    # Finer classification inside the five account types. Posting roles (see
    # accounting_catalog.ROLES) check it so e.g. the CASH role can't be pointed at a
    # receivable. Blank = unclassified (user-created accounts start that way).
    SUBTYPE_CHOICES = [
        ('CASH', 'Cash'),
        ('BANK', 'Bank'),
        ('RECEIVABLE', 'Receivable'),
        ('INVENTORY', 'Inventory'),
        ('TAX_ASSET', 'Tax Asset'),
        ('FIXED_ASSET', 'Fixed Asset'),
        ('OTHER_ASSET', 'Other Asset'),
        ('PAYABLE', 'Payable'),
        ('TAX_LIABILITY', 'Tax Liability'),
        ('ADVANCE', 'Customer Advance'),
        ('OTHER_LIABILITY', 'Other Liability'),
        ('EQUITY', 'Equity'),
        ('REVENUE', 'Revenue'),
        ('CONTRA_REVENUE', 'Contra Revenue'),
        ('OTHER_INCOME', 'Other Income'),
        ('COGS', 'Cost of Goods Sold'),
        ('EXPENSE', 'Expense'),
    ]

    code = models.CharField(max_length=50, unique=True)
    name = models.CharField(max_length=150, unique=True)
    account_group = models.ForeignKey(AccountGroup, on_delete=models.PROTECT, related_name='accounts')
    parent_account = models.ForeignKey('self', on_delete=models.SET_NULL, null=True, blank=True, related_name='children')
    account_subtype = models.CharField(max_length=20, choices=SUBTYPE_CHOICES, blank=True, default='')
    # Opening balance as typed on the account. It only reaches the ledger (and so the
    # reports) once posted as an OPENING journal against Opening Balance Equity — see
    # services.post_opening_balances — so the books always come from journal lines alone.
    opening_balance = models.DecimalField(max_digits=15, decimal_places=2, default=0.0)
    opening_balance_date = models.DateField(null=True, blank=True)
    # Running cache of the ledger balance (normal-balance sign), kept in step by the
    # posting service. Reports never read it; they aggregate LedgerEntry directly.
    current_balance = models.DecimalField(max_digits=15, decimal_places=2, default=0.0)
    branch = models.ForeignKey(Branch, on_delete=models.SET_NULL, null=True, blank=True, related_name='financial_accounts')
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default='Active')
    # System accounts are the defaults the automated posting rules were seeded with.
    # They can be renamed but not deleted, deactivated or moved to another account type.
    is_system = models.BooleanField(default=False)
    description = models.TextField(blank=True, null=True)
    is_deleted = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['code']

    def __str__(self):
        return f"{self.code} - {self.name}"

    @property
    def account_type(self):
        return self.account_group.account_type if self.account_group_id else ''

    @property
    def normal_balance(self):
        return 'DEBIT' if self.account_type in DEBIT_NORMAL_TYPES else 'CREDIT'


class VoucherType(BaseUUIDModel):
    name = models.CharField(max_length=100)
    code = models.CharField(max_length=20, unique=True)

    class Meta:
        ordering = ['code']

    def __str__(self):
        return f"{self.code} - {self.name}"


class JournalEntry(BaseUUIDModel):
    STATUS_CHOICES = [
        ('DRAFT', 'Draft'),
        ('PENDING_APPROVAL', 'Pending Approval'),
        ('POSTED', 'Posted'),
        ('REVERSED', 'Reversed'),
        ('CANCELLED', 'Cancelled'),
    ]
    # Statuses whose lines are on the books. A REVERSED entry stays on the books: its
    # reversal is a separate POSTED entry with the lines swapped, so the two net to zero
    # while both remain visible in the ledger.
    LEDGER_STATUSES = ('POSTED', 'REVERSED')

    entry_number = models.CharField(max_length=50, unique=True)
    date = models.DateField()
    narration = models.TextField(blank=True, null=True)
    voucher_type = models.ForeignKey(VoucherType, on_delete=models.SET_NULL, null=True, blank=True, related_name='journal_entries')
    # Legacy free-text tag (SALE, WHOLESALE, PAYMENT_RECEIPT, PURCHASE, RECEIPT_VOUCHER, ...),
    # still filled for display; source_module/source_event below are what the engine keys on.
    reference_type = models.CharField(max_length=50, blank=True, null=True)
    # UUIDField, not IntegerField: every model linked here (Invoice, PurchaseOrder,
    # StockAdjustment, StockTransfer, ...) uses a UUID primary key (BaseUUIDModel), so storing
    # `instance.id` into a 32-bit IntegerField always overflowed ("integer out of range") and
    # silently dropped the journal entry. StockLedger.reference_id uses UUIDField for the same
    # reason; this brings JournalEntry in line with it.
    reference_id = models.UUIDField(null=True, blank=True)
    # The operational document this entry books: e.g. ('sales', 'invoice'),
    # ('purchasing', 'purchase_invoice'), ('financial', 'voucher').
    source_module = models.CharField(max_length=40, blank=True, default='', db_index=True)
    source_event = models.CharField(max_length=40, blank=True, default='')
    source_number = models.CharField(max_length=80, blank=True, default='')
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default='POSTED')
    # True on the swapped-lines entry created by a reversal (so it never counts as the
    # document's "live" posting).
    is_reversal = models.BooleanField(default=False)
    reversed_entry = models.ForeignKey('self', on_delete=models.SET_NULL, null=True, blank=True, related_name='reversals')
    branch = models.ForeignKey(Branch, on_delete=models.SET_NULL, null=True, blank=True, related_name='journal_entries')
    # Client-supplied key for manual vouchers (one per form submission) so a double-click or
    # a retried request can never post the same voucher twice.
    idempotency_key = models.CharField(max_length=120, null=True, blank=True, unique=True)
    total_amount = models.DecimalField(max_digits=15, decimal_places=2, default=0)
    # Anything the posting rule needs to reproduce its figures later — e.g. the unit costs
    # COGS was booked at, so an edited invoice keeps its original cost basis.
    metadata = models.JSONField(default=dict, blank=True)
    posted_at = models.DateTimeField(null=True, blank=True)
    posted_by = models.ForeignKey(User, on_delete=models.SET_NULL, null=True, blank=True, related_name='financial_journals_posted')
    created_by = models.ForeignKey(User, on_delete=models.SET_NULL, null=True, blank=True, related_name='financial_journal_entries')
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-date', '-created_at']
        constraints = [
            # At most one live (posted, non-reversal) entry per source document event. This
            # is the database-level guarantee that a document is booked exactly once, even
            # if two requests race each other past the service-level check.
            models.UniqueConstraint(
                fields=['source_module', 'source_event', 'reference_id'],
                condition=Q(status='POSTED', is_reversal=False, reference_id__isnull=False) & ~Q(source_module=''),
                name='uniq_live_journal_per_source',
            ),
        ]

    def __str__(self):
        return f"{self.entry_number} ({self.date}) [{self.status}]"

    @property
    def source_key(self):
        return f"{self.source_module}.{self.source_event}" if self.source_module else ''

    @property
    def is_editable(self):
        return self.status in ('DRAFT', 'PENDING_APPROVAL')

    def delete(self, *args, **kwargs):
        if not self.is_editable:
            raise ValidationError(f"Journal {self.entry_number} is {self.status} and cannot be deleted; reverse it instead.")
        return self.hard_delete(*args, **kwargs)


class LedgerEntry(BaseUUIDModel):
    journal_entry = models.ForeignKey(JournalEntry, on_delete=models.CASCADE, related_name='lines')
    account = models.ForeignKey(ChartOfAccount, on_delete=models.PROTECT, related_name='ledger_entries')
    debit = models.DecimalField(max_digits=15, decimal_places=2, default=0.0)
    credit = models.DecimalField(max_digits=15, decimal_places=2, default=0.0)
    memo = models.CharField(max_length=255, blank=True, default='')

    def __str__(self):
        return f"{self.account.name} (Dr: {self.debit} | Cr: {self.credit})"


class AccountMapping(BaseUUIDModel):
    """Which ledger account a posting role (accounting_catalog.ROLES) resolves to.

    The posting rules never name an account code; they ask for a role ("RETAIL_SALES",
    "PAYMENT_UPI", ...) and get whichever account is mapped here — optionally per branch
    and from an effective date, so a re-mapping never rewrites already-posted history.
    """
    role = models.CharField(max_length=60, db_index=True)
    account = models.ForeignKey(ChartOfAccount, on_delete=models.PROTECT, related_name='mappings')
    branch = models.ForeignKey(Branch, on_delete=models.CASCADE, null=True, blank=True, related_name='account_mappings')
    effective_from = models.DateField(null=True, blank=True)
    is_active = models.BooleanField(default=True)
    notes = models.CharField(max_length=255, blank=True, default='')

    class Meta:
        ordering = ['role', 'branch', '-effective_from']

    def __str__(self):
        return f"{self.role} -> {self.account}"


class PostingFailure(BaseUUIDModel):
    """A source document the engine could not book. Nothing is ever dropped silently: the
    error stays here (visible under Accounting Integration) until a retry succeeds or an
    authorized user marks it ignored."""
    STATUS_CHOICES = [('OPEN', 'Open'), ('RESOLVED', 'Resolved'), ('IGNORED', 'Ignored')]
    KIND_CHOICES = [
        ('MAPPING', 'Missing / invalid account mapping'),
        ('PERIOD', 'Closed fiscal period'),
        ('VALIDATION', 'Validation error'),
        ('ERROR', 'Unexpected error'),
    ]

    source_module = models.CharField(max_length=40)
    source_event = models.CharField(max_length=40)
    reference_id = models.UUIDField()
    source_number = models.CharField(max_length=80, blank=True, default='')
    kind = models.CharField(max_length=20, choices=KIND_CHOICES, default='ERROR')
    error = models.TextField()
    attempts = models.PositiveIntegerField(default=1)
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default='OPEN', db_index=True)
    last_failed_at = models.DateTimeField(auto_now_add=True)
    resolved_at = models.DateTimeField(null=True, blank=True)
    resolved_by = models.ForeignKey(User, on_delete=models.SET_NULL, null=True, blank=True, related_name='+')

    class Meta:
        ordering = ['-last_failed_at']
        constraints = [
            models.UniqueConstraint(
                fields=['source_module', 'source_event', 'reference_id'],
                condition=Q(status='OPEN'),
                name='uniq_open_posting_failure',
            ),
        ]


class FiscalPeriod(BaseUUIDModel):
    STATUS_CHOICES = [('OPEN', 'Open'), ('CLOSED', 'Closed')]

    name = models.CharField(max_length=60, unique=True)
    start_date = models.DateField()
    end_date = models.DateField()
    status = models.CharField(max_length=10, choices=STATUS_CHOICES, default='OPEN')
    closed_at = models.DateTimeField(null=True, blank=True)
    closed_by = models.ForeignKey(User, on_delete=models.SET_NULL, null=True, blank=True, related_name='+')

    class Meta:
        ordering = ['-start_date']
        constraints = [
            models.CheckConstraint(condition=Q(end_date__gte=models.F('start_date')), name='fiscal_period_dates_ordered'),
        ]

    def __str__(self):
        return f"{self.name} [{self.status}]"


class AccountingPolicy(models.Model):
    """Singleton (pk=1) holding the switches for automated posting."""
    auto_posting_enabled = models.BooleanField(default=True)
    # {source_key: bool} — a source missing here counts as enabled.
    source_enabled = models.JSONField(default=dict, blank=True)
    # {source_key: 'YYYY-MM-DD'} — documents dated before this are historical: the engine
    # leaves them alone (no automatic re-posting); bring them in with the controlled
    # backfill tool instead. A source missing here has no cut-off.
    source_start_dates = models.JSONField(default=dict, blank=True)
    # Manual vouchers dated more than this many days back need an accounting admin.
    # 0 = no restriction.
    backdate_limit_days = models.PositiveIntegerField(default=0)
    # Only valuation implemented: Product.cost_price, which Purchase Entry refreshes to the
    # latest purchase rate (i.e. last purchase cost). Kept as a field so reports can state it.
    inventory_valuation = models.CharField(max_length=30, default='LAST_PURCHASE_COST')
    updated_at = models.DateTimeField(auto_now=True)

    @classmethod
    def get(cls):
        obj, _ = cls.objects.get_or_create(pk=1)
        return obj


class JournalSequence(models.Model):
    """Gap-free journal numbering per prefix and year (row-locked on increment)."""
    prefix = models.CharField(max_length=10)
    year = models.PositiveIntegerField()
    last_number = models.PositiveIntegerField(default=0)

    class Meta:
        constraints = [models.UniqueConstraint(fields=['prefix', 'year'], name='uniq_journal_sequence')]


class FinancialAuditLog(models.Model):
    action = models.CharField(max_length=40, db_index=True)
    object_type = models.CharField(max_length=40)
    object_id = models.CharField(max_length=64, blank=True, default='')
    summary = models.CharField(max_length=255, blank=True, default='')
    before = models.JSONField(null=True, blank=True)
    after = models.JSONField(null=True, blank=True)
    actor = models.ForeignKey(User, on_delete=models.SET_NULL, null=True, blank=True, related_name='+')
    actor_name = models.CharField(max_length=150, blank=True, default='')
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        ordering = ['-created_at']
