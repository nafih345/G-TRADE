from rest_framework import serializers

from .bill_fields import (
    PAPER_SIZES, LayoutError, compatible_document_types, incompatibility_reason, validate_config, _color,
)
from .models import BillTemplate, DocumentTemplateAssignment, BillingSettings, DOCUMENT_TYPES

DOC_LABELS = dict(DOCUMENT_TYPES)


class BillTemplateSerializer(serializers.ModelSerializer):
    used_by = serializers.SerializerMethodField()
    compatible_types = serializers.SerializerMethodField()
    schema = serializers.SerializerMethodField()
    # Sent back on update: the version the client edited (optimistic lock, see views).
    expected_version = serializers.IntegerField(write_only=True, required=False)

    class Meta:
        model = BillTemplate
        fields = (
            'id', 'name', 'template_type', 'description',
            'paper_size', 'orientation', 'custom_width_mm', 'custom_height_mm',
            'margins', 'config', 'is_active', 'is_default', 'is_preset',
            'thumbnail', 'used_by', 'compatible_types', 'schema',
            'version', 'preset_key', 'updated_by_name', 'expected_version',
            'created_at', 'updated_at',
        )
        # is_default only changes through the set-default action (keeps the single-default rule
        # in one place); version / preset_key are server-managed.
        read_only_fields = ('is_preset', 'is_default', 'version', 'preset_key', 'updated_by_name',
                            'created_at', 'updated_at')

    def get_used_by(self, obj):
        return [a.document_type for a in obj.assignments.all()]

    def get_compatible_types(self, obj):
        return compatible_document_types(obj.config)

    def get_schema(self, obj):
        return 2 if (obj.config or {}).get('schema') == 2 else 1

    def validate_name(self, value):
        name = (value or '').strip()
        if not name:
            raise serializers.ValidationError('Give the template a name.')
        qs = BillTemplate.objects.filter(name__iexact=name)
        if self.instance is not None:
            qs = qs.exclude(pk=self.instance.pk)
        if qs.exists():
            raise serializers.ValidationError(f'A template called “{name}” already exists.')
        return name[:120]

    def validate_paper_size(self, value):
        if value not in PAPER_SIZES:
            raise serializers.ValidationError(f'Unsupported paper size “{value}”.')
        return value

    def validate_orientation(self, value):
        if value not in ('portrait', 'landscape'):
            raise serializers.ValidationError('Orientation must be portrait or landscape.')
        return value

    def validate_margins(self, value):
        if not isinstance(value, dict):
            raise serializers.ValidationError('Margins must be an object.')
        out = {}
        for side in ('top', 'right', 'bottom', 'left'):
            try:
                out[side] = round(min(50.0, max(0.0, float(value.get(side, 10)))), 1)
            except (TypeError, ValueError):
                raise serializers.ValidationError(f'Margin “{side}” must be a number of millimetres.')
        return out

    def validate_config(self, value):
        try:
            return validate_config(value)
        except LayoutError as e:
            raise serializers.ValidationError(str(e))

    def validate(self, attrs):
        attrs.pop('expected_version', None)
        paper = attrs.get('paper_size', getattr(self.instance, 'paper_size', 'A4'))
        if paper == 'CUSTOM':
            w = attrs.get('custom_width_mm', getattr(self.instance, 'custom_width_mm', None))
            h = attrs.get('custom_height_mm', getattr(self.instance, 'custom_height_mm', None))
            if w is None or not (20 <= float(w) <= 1000):
                raise serializers.ValidationError({'custom_width_mm': 'Custom paper width must be 20–1000 mm.'})
            if h is not None and not (20 <= float(h) <= 3000):
                raise serializers.ValidationError({'custom_height_mm': 'Custom paper height must be 20–3000 mm (leave blank for a continuous roll).'})
        # A template already printing some document types must stay able to render them —
        # otherwise a layout edit would silently break those documents' printing.
        if self.instance is not None and 'config' in attrs:
            problems = []
            for a in self.instance.assignments.all():
                reason = incompatibility_reason(attrs['config'], a.document_type)
                if reason:
                    problems.append(f"{DOC_LABELS.get(a.document_type, a.document_type)}: {reason}")
            if problems:
                raise serializers.ValidationError({'config': [
                    'This template is assigned to documents it could no longer print — ' + '; '.join(problems)
                    + '. Assign those documents to another template first, or “Save as New”.'
                ]})
        return attrs


class BillTemplateVersionSerializer(serializers.Serializer):
    version = serializers.IntegerField()
    name = serializers.CharField()
    paper_size = serializers.CharField()
    orientation = serializers.CharField()
    saved_at = serializers.DateTimeField()
    saved_by = serializers.CharField()


class DocumentTemplateAssignmentSerializer(serializers.ModelSerializer):
    template_name = serializers.CharField(source='template.name', read_only=True, default='')
    label = serializers.SerializerMethodField()

    class Meta:
        model = DocumentTemplateAssignment
        fields = ('id', 'document_type', 'label', 'template', 'template_name')

    def get_label(self, obj):
        return DOC_LABELS.get(obj.document_type, obj.document_type)

    def to_representation(self, instance):
        data = super().to_representation(instance)
        # A soft-deleted template is not a usable assignment.
        if instance.template_id and getattr(instance.template, 'is_deleted', False):
            data['template'] = None
            data['template_name'] = ''
        return data


MAX_LOGO_CHARS = 800_000


class BillingSettingsSerializer(serializers.ModelSerializer):
    class Meta:
        model = BillingSettings
        fields = (
            'id', 'use_single_template', 'single_template',
            'logo_data_url', 'primary_color', 'accent_color', 'business_info', 'themes',
            'updated_at',
        )
        read_only_fields = ('id', 'updated_at')

    def validate_logo_data_url(self, value):
        value = value or ''
        if value and not value.startswith('data:image/'):
            raise serializers.ValidationError('The logo must be an uploaded image.')
        if value.startswith('data:image/svg'):
            raise serializers.ValidationError('SVG logos are not supported — upload a PNG or JPEG.')
        if len(value) > MAX_LOGO_CHARS:
            raise serializers.ValidationError('The logo is too large — upload an image under 500 KB.')
        return value

    def validate_business_info(self, value):
        if not isinstance(value, dict):
            raise serializers.ValidationError('Business info must be an object.')
        return {str(k)[:40]: str(v)[:600] for k, v in list(value.items())[:30] if v is not None}

    def validate_themes(self, value):
        if not isinstance(value, list):
            raise serializers.ValidationError('Themes must be a list.')
        out = []
        for t in value[:20]:
            if not isinstance(t, dict) or not str(t.get('name') or '').strip():
                continue
            row = {'name': str(t['name']).strip()[:40]}
            for k in ('primary', 'accent', 'text', 'muted', 'border', 'headerBg', 'headerText'):
                c = _color(t.get(k))
                if c:
                    row[k] = c
            out.append(row)
        return out

    def validate_single_template(self, value):
        if value is not None and value.is_deleted:
            raise serializers.ValidationError('That template has been deleted.')
        return value
