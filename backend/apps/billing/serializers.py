from rest_framework import serializers

from .models import BillTemplate, DocumentTemplateAssignment, BillingSettings


class BillTemplateSerializer(serializers.ModelSerializer):
    used_by = serializers.SerializerMethodField()

    class Meta:
        model = BillTemplate
        fields = (
            'id', 'name', 'template_type', 'description',
            'paper_size', 'orientation', 'custom_width_mm', 'custom_height_mm',
            'margins', 'config', 'is_active', 'is_default', 'is_preset',
            'thumbnail', 'used_by', 'created_at', 'updated_at',
        )
        read_only_fields = ('is_preset', 'created_at', 'updated_at')

    def get_used_by(self, obj):
        return [a.document_type for a in obj.assignments.all()]


class DocumentTemplateAssignmentSerializer(serializers.ModelSerializer):
    template_name = serializers.CharField(source='template.name', read_only=True)

    class Meta:
        model = DocumentTemplateAssignment
        fields = ('id', 'document_type', 'template', 'template_name')


class BillingSettingsSerializer(serializers.ModelSerializer):
    class Meta:
        model = BillingSettings
        fields = (
            'id', 'use_single_template', 'single_template',
            'logo_data_url', 'primary_color', 'accent_color', 'business_info',
            'updated_at',
        )
        read_only_fields = ('id', 'updated_at')
