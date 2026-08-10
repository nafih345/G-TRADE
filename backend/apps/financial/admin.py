from django.contrib import admin
from .models import AccountGroup, ChartOfAccount, JournalEntry, LedgerEntry

@admin.register(AccountGroup)
class AccountGroupAdmin(admin.ModelAdmin):
    list_display = ('name', 'account_type')
    search_fields = ('name', 'account_type')

@admin.register(ChartOfAccount)
class ChartOfAccountAdmin(admin.ModelAdmin):
    list_display = ('code', 'name', 'account_group', 'current_balance', 'status', 'is_deleted')
    list_filter = ('account_group__account_type', 'status', 'is_deleted')
    search_fields = ('code', 'name', 'account_group__name')

class LedgerEntryInline(admin.TabularInline):
    model = LedgerEntry
    extra = 0

@admin.register(JournalEntry)
class JournalEntryAdmin(admin.ModelAdmin):
    list_display = ('entry_number', 'date', 'reference_type', 'reference_id', 'created_at')
    list_filter = ('reference_type', 'date')
    search_fields = ('entry_number', 'narration')
    inlines = [LedgerEntryInline]
