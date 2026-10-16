from django.contrib import admin

from .models import BillTemplate, BillTemplateVersion, DocumentTemplateAssignment, BillingSettings


@admin.register(BillTemplate)
class BillTemplateAdmin(admin.ModelAdmin):
    list_display = ('name', 'template_type', 'paper_size', 'version', 'preset_key', 'is_default', 'is_active', 'is_preset', 'updated_at')
    list_filter = ('template_type', 'paper_size', 'is_active', 'is_default')
    search_fields = ('name', 'description')


@admin.register(DocumentTemplateAssignment)
class DocumentTemplateAssignmentAdmin(admin.ModelAdmin):
    list_display = ('document_type', 'template')
    list_filter = ('document_type',)


@admin.register(BillingSettings)
class BillingSettingsAdmin(admin.ModelAdmin):
    list_display = ('use_single_template', 'single_template', 'primary_color', 'updated_at')


@admin.register(BillTemplateVersion)
class BillTemplateVersionAdmin(admin.ModelAdmin):
    list_display = ('template', 'version', 'name', 'saved_at', 'saved_by')
    list_filter = ('template',)
