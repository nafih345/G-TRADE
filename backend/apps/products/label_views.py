"""Barcode label designer API.

  /api/products/label-templates/                 list / create (designer roles)
  /api/products/label-templates/<id>/            retrieve / update (optimistic lock) / soft delete
  /api/products/label-templates/<id>/duplicate/  copy into a new independent template
  /api/products/label-templates/<id>/set-default/
  /api/products/label-templates/<id>/restore-default/   reset to its starter preset
  /api/products/label-templates/<id>/versions/          previous saved states
  /api/products/label-templates/<id>/restore-version/   {version}
  /api/products/label-templates/<id>/undelete/
  /api/products/label-templates/deleted/                soft-deleted templates
  /api/products/label-templates/presets/                starter presets
  /api/products/label-templates/from-preset/            {preset_key, name?}
  /api/products/label-settings/                  GET / PUT workflow defaults + calibration
  /api/products/label-settings/import-legacy/    one-time import of browser-stored designs
  /api/products/label-fields/                    field catalog (+ which ones this user may use)
  /api/products/label-data/                      POST {product_ids} -> resolved field values

Reads are open like the rest of the product API; writes need a signed-in designer role.
Restricted pricing (wholesale / purchase cost) is only placed on templates by, and only
resolved for, PRICING_ROLES (label_fields.py).
"""
import copy
import re

from django.db import transaction
from django.db.utils import OperationalError, ProgrammingError
from rest_framework import permissions, serializers, status, viewsets
from rest_framework.decorators import action
from rest_framework.response import Response
from rest_framework.views import APIView

from .label_fields import (
    LayoutError, can_design, can_see_restricted, field_catalog, layout_uses_restricted,
    resolve_product_fields, resolve_store_fields, validate_template,
)
from .label_presets import PRESETS, preset_spec
from .models import LabelPrintSettings, LabelTemplate, LabelTemplateVersion, Product

UUID_RE = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', re.I)
MAX_VERSIONS_KEPT = 30
MAX_LABEL_DATA_PRODUCTS = 1000


class DesignerWritePermission(permissions.BasePermission):
    message = 'Sign in with a role that can design labels (Super Admin, Administrator, Manager, Inventory or Purchase) to change label templates.'

    def has_permission(self, request, view):
        if request.method in permissions.SAFE_METHODS:
            return True
        return can_design(request.user)


def _actor(request):
    u = getattr(request, 'user', None)
    return (getattr(u, 'username', '') or '') if u and u.is_authenticated else ''


def _lock_settings_row(pk):
    """Take the write lock on the settings singleton for the rest of the transaction, so
    concurrent first requests (the designer loads templates + settings in parallel)
    serialise instead of both seeding / importing. An UPDATE locks the row on PostgreSQL
    and takes the database write lock on SQLite, unlike a plain SELECT. Call it as the
    transaction's FIRST statement (get `pk` from LabelPrintSettings.load() beforehand):
    SQLite won't upgrade an earlier read lock while another connection is writing and
    fails at once with "database is locked"."""
    from django.utils import timezone
    LabelPrintSettings.objects.filter(pk=pk).update(updated_at=timezone.now())
    return LabelPrintSettings.objects.get(pk=pk)


def ensure_seeded():
    """Seed the starter presets the first time the table is empty (mirrors billing)."""
    try:
        if LabelTemplate.all_objects.exists():
            return
        pk = LabelPrintSettings.load().pk
        with transaction.atomic():
            _lock_settings_row(pk)
            if LabelTemplate.all_objects.exists():
                return  # another request seeded while we waited for the lock
            for spec in PRESETS:
                _create_from_spec(spec)
    except (ProgrammingError, OperationalError):
        pass  # not migrated yet — /api/health/ reports pending migrations


def _create_from_spec(spec, name=None, is_default=None):
    w, h, layout = validate_template(spec['printer_type'], spec['width_mm'], spec['height_mm'],
                                     spec['layout'], allow_restricted=True)
    return LabelTemplate.objects.create(
        name=name or spec['name'], description=spec.get('description', ''),
        printer_type=spec['printer_type'], width_mm=w, height_mm=h, layout=layout,
        preset_key=spec['preset_key'],
        is_default=spec.get('is_default', False) if is_default is None else is_default,
    )


class LabelTemplateSerializer(serializers.ModelSerializer):
    # Sent back on update: the version the client edited (optimistic lock).
    expected_version = serializers.IntegerField(write_only=True, required=False)
    uses_restricted_fields = serializers.SerializerMethodField()

    class Meta:
        model = LabelTemplate
        fields = (
            'id', 'name', 'description', 'printer_type', 'width_mm', 'height_mm', 'layout',
            'version', 'is_default', 'preset_key', 'updated_by_name', 'created_at', 'updated_at',
            'expected_version', 'uses_restricted_fields',
        )
        read_only_fields = ('version', 'is_default', 'preset_key', 'updated_by_name', 'created_at', 'updated_at')

    def get_uses_restricted_fields(self, obj):
        return layout_uses_restricted(obj.layout)

    def validate_name(self, value):
        value = (value or '').strip()
        if not value:
            raise serializers.ValidationError('Template name is required.')
        qs = LabelTemplate.objects.filter(name__iexact=value)
        if self.instance:
            qs = qs.exclude(pk=self.instance.pk)
        if qs.exists():
            raise serializers.ValidationError(f'A template named “{value}” already exists.')
        return value

    def validate(self, attrs):
        inst = self.instance
        printer_type = attrs.get('printer_type', inst.printer_type if inst else 'thermal')
        width = attrs.get('width_mm', inst.width_mm if inst else None)
        height = attrs.get('height_mm', inst.height_mm if inst else None)
        layout = attrs.get('layout', inst.layout if inst else {})
        attrs.pop('expected_version', None)
        request = self.context.get('request')
        try:
            w, h, clean = validate_template(printer_type, width, height, layout, allow_restricted=True)
        except LayoutError as e:
            raise serializers.ValidationError({'layout': str(e)})
        # Restricted pricing may only be *added* by PRICING_ROLES. Another designer can
        # still edit a template a manager put wholesale price on, as long as they don't
        # add new restricted elements themselves.
        if not can_see_restricted(getattr(request, 'user', None)):
            added = _restricted_pairs(clean) - _restricted_pairs(inst.layout if inst else {})
            if added:
                raise serializers.ValidationError(
                    {'layout': 'You are not allowed to place restricted pricing (wholesale price / purchase cost) on labels.'})
        attrs.update(printer_type=printer_type, width_mm=w, height_mm=h, layout=clean)
        return attrs


def _restricted_pairs(layout):
    from .label_fields import RESTRICTED_FIELD_IDS
    pairs = set()
    for el in (layout or {}).get('elements') or []:
        for f in (el.get('field'), (el.get('fallback') or {}).get('field')):
            if f in RESTRICTED_FIELD_IDS:
                pairs.add((el.get('id'), f))
    return pairs


def _snapshot(tpl, actor):
    LabelTemplateVersion.objects.create(
        template=tpl, version=tpl.version, name=tpl.name, printer_type=tpl.printer_type,
        width_mm=tpl.width_mm, height_mm=tpl.height_mm, layout=copy.deepcopy(tpl.layout), saved_by=actor,
    )
    stale = list(tpl.versions.order_by('-version').values_list('pk', flat=True)[MAX_VERSIONS_KEPT:])
    if stale:
        LabelTemplateVersion.objects.filter(pk__in=stale).delete()


class LabelTemplateViewSet(viewsets.ModelViewSet):
    serializer_class = LabelTemplateSerializer
    permission_classes = [DesignerWritePermission]
    pagination_class = None

    def get_queryset(self):
        return LabelTemplate.objects.all()

    def list(self, request, *args, **kwargs):
        ensure_seeded()
        return super().list(request, *args, **kwargs)

    def perform_create(self, serializer):
        serializer.save(version=1, updated_by_name=_actor(self.request), preset_key='')

    def update(self, request, *args, **kwargs):
        tpl = self.get_object()
        expected = request.data.get('expected_version')
        if expected is not None and str(expected) != str(tpl.version):
            return Response({
                'detail': f'“{tpl.name}” was changed by someone else (now version {tpl.version}, you edited '
                          f'version {expected}). Reload it, or “Save as New” to keep your design.',
                'current_version': tpl.version,
            }, status=status.HTTP_409_CONFLICT)
        serializer = self.get_serializer(tpl, data=request.data, partial=kwargs.pop('partial', False))
        serializer.is_valid(raise_exception=True)
        with transaction.atomic():
            locked = LabelTemplate.objects.select_for_update().get(pk=tpl.pk)
            if expected is not None and str(expected) != str(locked.version):
                return Response({'detail': 'Template changed while saving — reload and try again.',
                                 'current_version': locked.version}, status=status.HTTP_409_CONFLICT)
            _snapshot(locked, _actor(request))
            serializer.save(version=locked.version + 1, updated_by_name=_actor(request))
        return Response(serializer.data)

    def destroy(self, request, *args, **kwargs):
        tpl = self.get_object()
        if tpl.is_default:
            return Response({'detail': 'Make another template the default before deleting this one.'},
                            status=status.HTTP_400_BAD_REQUEST)
        if LabelTemplate.objects.count() <= 1:
            return Response({'detail': 'At least one label template must remain.'}, status=status.HTTP_400_BAD_REQUEST)
        tpl.delete()  # soft delete — restorable from /deleted/
        return Response(status=status.HTTP_204_NO_CONTENT)

    @action(detail=True, methods=['post'])
    def duplicate(self, request, pk=None):
        src = self.get_object()
        base = (request.data.get('name') or f'{src.name} (Copy)').strip()[:120]
        name, n = base, 2
        while LabelTemplate.objects.filter(name__iexact=name).exists():
            name = f'{base} {n}'[:120]
            n += 1
        clone = LabelTemplate.objects.create(
            name=name, description=src.description, printer_type=src.printer_type,
            width_mm=src.width_mm, height_mm=src.height_mm, layout=copy.deepcopy(src.layout),
            preset_key=src.preset_key, updated_by_name=_actor(request),
        )
        return Response(self.get_serializer(clone).data, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=['post'], url_path='set-default')
    def set_default(self, request, pk=None):
        tpl = self.get_object()
        tpl.is_default = True
        tpl.save()
        return Response(self.get_serializer(tpl).data)

    @action(detail=True, methods=['post'], url_path='restore-default')
    def restore_default(self, request, pk=None):
        tpl = self.get_object()
        spec = preset_spec(tpl.preset_key)
        if not spec:
            return Response({'detail': 'This template was not created from a starter preset, so it has no default to restore. Use Versions to roll back instead.'},
                            status=status.HTTP_400_BAD_REQUEST)
        w, h, layout = validate_template(spec['printer_type'], spec['width_mm'], spec['height_mm'], spec['layout'], True)
        with transaction.atomic():
            _snapshot(tpl, _actor(request))
            tpl.printer_type, tpl.width_mm, tpl.height_mm, tpl.layout = spec['printer_type'], w, h, layout
            tpl.version += 1
            tpl.updated_by_name = _actor(request)
            tpl.save()
        return Response(self.get_serializer(tpl).data)

    @action(detail=True, methods=['get'])
    def versions(self, request, pk=None):
        tpl = self.get_object()
        rows = tpl.versions.all()[:MAX_VERSIONS_KEPT]
        return Response([{
            'version': v.version, 'name': v.name, 'printer_type': v.printer_type,
            'width_mm': v.width_mm, 'height_mm': v.height_mm, 'saved_at': v.saved_at,
            'saved_by': v.saved_by, 'element_count': len((v.layout or {}).get('elements') or []),
        } for v in rows])

    @action(detail=True, methods=['post'], url_path='restore-version')
    def restore_version(self, request, pk=None):
        tpl = self.get_object()
        v = tpl.versions.filter(version=request.data.get('version')).first()
        if not v:
            return Response({'detail': 'That version no longer exists.'}, status=status.HTTP_404_NOT_FOUND)
        if layout_uses_restricted(v.layout) and not can_see_restricted(request.user):
            return Response({'detail': 'That version contains restricted pricing fields.'}, status=status.HTTP_403_FORBIDDEN)
        with transaction.atomic():
            _snapshot(tpl, _actor(request))
            tpl.printer_type, tpl.width_mm, tpl.height_mm = v.printer_type, v.width_mm, v.height_mm
            tpl.layout = copy.deepcopy(v.layout)
            tpl.version += 1
            tpl.updated_by_name = _actor(request)
            tpl.save()
        return Response(self.get_serializer(tpl).data)

    @action(detail=False, methods=['get'])
    def deleted(self, request):
        rows = LabelTemplate.all_objects.filter(is_deleted=True).order_by('-updated_at')[:50]
        return Response(self.get_serializer(rows, many=True).data)

    @action(detail=True, methods=['post'])
    def undelete(self, request, pk=None):
        tpl = LabelTemplate.all_objects.filter(pk=pk, is_deleted=True).first()
        if not tpl:
            return Response({'detail': 'Deleted template not found.'}, status=status.HTTP_404_NOT_FOUND)
        if LabelTemplate.objects.filter(name__iexact=tpl.name).exists():
            tpl.name = f'{tpl.name} (Restored)'[:120]
        tpl.is_deleted = False
        tpl.is_default = False
        tpl.save()
        return Response(self.get_serializer(tpl).data)

    @action(detail=False, methods=['get'])
    def presets(self, request):
        return Response([{k: p[k] for k in ('preset_key', 'name', 'description', 'printer_type', 'width_mm', 'height_mm')}
                         for p in PRESETS])

    @action(detail=False, methods=['post'], url_path='from-preset')
    def from_preset(self, request):
        spec = preset_spec(request.data.get('preset_key'))
        if not spec:
            return Response({'detail': 'Unknown preset.'}, status=status.HTTP_400_BAD_REQUEST)
        base = (request.data.get('name') or spec['name']).strip()[:120]
        name, n = base, 2
        while LabelTemplate.objects.filter(name__iexact=name).exists():
            name = f'{base} ({n})'[:120]
            n += 1
        tpl = _create_from_spec(spec, name=name, is_default=False)
        return Response(self.get_serializer(tpl).data, status=status.HTTP_201_CREATED)


class LabelPrintSettingsSerializer(serializers.ModelSerializer):
    class Meta:
        model = LabelPrintSettings
        fields = (
            'inventory_template', 'purchase_template', 'barcode_printing_template',
            'thermal_printer_name', 'a4_printer_name', 'h_offset_mm', 'v_offset_mm',
            'print_scale_percent', 'default_copies', 'printer_dpi', 'unique_label_series', 'legacy_migrated', 'updated_at',
        )
        read_only_fields = ('legacy_migrated', 'updated_at')

    def _range(self, v, lo, hi, label):
        if v is not None and not (lo <= float(v) <= hi):
            raise serializers.ValidationError(f'{label} must be between {lo} and {hi}.')
        return v

    def validate_h_offset_mm(self, v):
        return self._range(v, -20, 20, 'Horizontal offset (mm)')

    def validate_v_offset_mm(self, v):
        return self._range(v, -20, 20, 'Vertical offset (mm)')

    def validate_print_scale_percent(self, v):
        return self._range(v, 50, 150, 'Print scale (%)')

    def validate_printer_dpi(self, v):
        if v not in (0, 203, 300, 600):
            raise serializers.ValidationError('Printer resolution must be 203, 300 or 600 dpi (or 0 to disable snapping).')
        return v

    def validate_default_copies(self, v):
        return self._range(v, 1, 500, 'Default copies')


class LabelPrintSettingsView(APIView):
    permission_classes = [DesignerWritePermission]

    def get(self, request):
        ensure_seeded()
        return Response(LabelPrintSettingsSerializer(LabelPrintSettings.load()).data)

    def put(self, request):
        obj = LabelPrintSettings.load()
        ser = LabelPrintSettingsSerializer(obj, data=request.data, partial=True)
        ser.is_valid(raise_exception=True)
        ser.save()
        return Response(ser.data)

    patch = put


class LabelLegacyImportView(APIView):
    """One-time import of the label designs that used to live only in the browser's
    localStorage. The client converts them to the element layout; this validates and
    stores them and flips `legacy_migrated` so no other browser imports twice."""
    permission_classes = [DesignerWritePermission]

    def post(self, request):
        ensure_seeded()
        pk = LabelPrintSettings.load().pk
        with transaction.atomic():
            settings_obj = _lock_settings_row(pk)
            if settings_obj.legacy_migrated:
                return Response({'imported': 0, 'detail': 'Already imported.'})
            return self._import(request, settings_obj)

    def _import(self, request, settings_obj):
        allow_restricted = can_see_restricted(request.user)
        created, errors = [], []
        for item in (request.data.get('templates') or [])[:20]:
            try:
                w, h, layout = validate_template(item.get('printer_type'), item.get('width_mm'),
                                                 item.get('height_mm'), item.get('layout') or {}, allow_restricted)
            except LayoutError as e:
                errors.append(f"{item.get('name')}: {e}")
                continue
            base = (str(item.get('name') or 'Imported label')).strip()[:110]
            name, n = base, 2
            while LabelTemplate.objects.filter(name__iexact=name).exists():
                name = f'{base} ({n})'
                n += 1
            tpl = LabelTemplate.objects.create(
                name=name, description='Imported from this browser’s earlier label settings.',
                printer_type=item.get('printer_type'), width_mm=w, height_mm=h, layout=layout,
                updated_by_name=_actor(request),
            )
            if item.get('make_default'):
                tpl.is_default = True
                tpl.save()
            created.append(str(tpl.id))
        settings_obj.legacy_migrated = True
        settings_obj.save(update_fields=['legacy_migrated', 'updated_at'])
        return Response({'imported': len(created), 'ids': created, 'errors': errors})


class LabelFieldsView(APIView):
    permission_classes = [permissions.AllowAny]

    def get(self, request):
        return Response({
            'fields': field_catalog(request.user),
            'can_design': can_design(request.user),
            'can_see_restricted': can_see_restricted(request.user),
        })


class LabelDataView(APIView):
    """Resolve label field values for products from the database (the source of truth).
    Restricted prices are included only for PRICING_ROLES."""
    permission_classes = [permissions.AllowAny]

    def post(self, request):
        ids = [str(i) for i in (request.data.get('product_ids') or []) if UUID_RE.match(str(i))]
        ids = list(dict.fromkeys(ids))[:MAX_LABEL_DATA_PRODUCTS]
        include_restricted = can_see_restricted(request.user)
        products = (Product.objects.filter(pk__in=ids)
                    .select_related('brand', 'category', 'variant_group').prefetch_related('extra_barcodes'))
        out = {}
        for p in products:
            out[str(p.id)] = {
                'id': str(p.id),
                'variant_group': str(p.variant_group_id) if p.variant_group_id else None,
                'variant_attributes': p.variant_attributes or {},
                'stock': p.stock,
                'fields': resolve_product_fields(p, include_restricted),
            }
        missing = [i for i in ids if i not in out]
        return Response({
            'products': out,
            'missing': missing,
            'store': resolve_store_fields(),
            'restricted_included': include_restricted,
        })
