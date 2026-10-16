from django.contrib import admin

from .models import (
    AccountGroup, ChartOfAccount, JournalEntry, LedgerEntry, AccountMapping, PostingFailure, FiscalPeriod,
    AccountingPolicy, FinancialAuditLog,
)


@admin.register(AccountGroup)
class AccountGroupAdmin(admin.ModelAdmin):
    list_display = ('name', 'account_type')
    search_fields = ('name', 'account_type')


@admin.register(ChartOfAccount)
class ChartOfAccountAdmin(admin.ModelAdmin):
    list_display = ('code', 'name', 'account_group', 'account_subtype', 'current_balance', 'status', 'is_system', 'is_deleted')
    list_filter = ('account_group__account_type', 'status', 'is_system', 'is_deleted')
    search_fields = ('code', 'name', 'account_group__name')
    readonly_fields = ('current_balance',)


class LedgerEntryInline(admin.TabularInline):
    model = LedgerEntry
    extra = 0
    can_delete = False
    readonly_fields = ('account', 'debit', 'credit', 'memo')


@admin.register(JournalEntry)
class JournalEntryAdmin(admin.ModelAdmin):
    """Read-only: journals are created, posted and reversed through the posting service."""
    list_display = ('entry_number', 'date', 'status', 'source_module', 'source_event', 'source_number', 'total_amount', 'is_reversal')
    list_filter = ('status', 'source_module', 'is_reversal', 'date')
    search_fields = ('entry_number', 'narration', 'source_number')
    inlines = [LedgerEntryInline]

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False

    def has_add_permission(self, request):
        return False


@admin.register(AccountMapping)
class AccountMappingAdmin(admin.ModelAdmin):
    list_display = ('role', 'account', 'branch', 'effective_from', 'is_active')
    list_filter = ('is_active', 'role')


@admin.register(PostingFailure)
class PostingFailureAdmin(admin.ModelAdmin):
    list_display = ('source_module', 'source_event', 'source_number', 'kind', 'status', 'attempts', 'last_failed_at')
    list_filter = ('status', 'kind', 'source_module')


@admin.register(FiscalPeriod)
class FiscalPeriodAdmin(admin.ModelAdmin):
    list_display = ('name', 'start_date', 'end_date', 'status', 'closed_at')


admin.site.register(AccountingPolicy)


@admin.register(FinancialAuditLog)
class FinancialAuditLogAdmin(admin.ModelAdmin):
    list_display = ('created_at', 'action', 'object_type', 'summary', 'actor_name')
    list_filter = ('action', 'object_type')

    def has_change_permission(self, request, obj=None):
        return False
