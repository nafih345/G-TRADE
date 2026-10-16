"""Bill & Invoice Designer API (mounted at /api/billing/).

  templates/                          list / create
  templates/<id>/                     retrieve / update (optimistic lock + version snapshot) / soft delete
  templates/<id>/duplicate/           independent copy {name?}
  templates/<id>/rename/              {name}
  templates/<id>/set-default/ | activate/ | deactivate/
  templates/<id>/assign/              {document_types: [...], replace?: bool}
  templates/<id>/restore-default/     reset to the starter preset it came from
  templates/<id>/versions/            previous saved states
  templates/<id>/restore-version/     {version}
  templates/<id>/undelete/
  templates/deleted/                  soft-deleted templates
  templates/presets/                  visual starter presets
  templates/from-preset/              {preset_key, name?}
  templates/restore-defaults/         {reset_modified?: bool, reassign?: bool}
  assignments/ (+ bulk/)              document type -> template (compatibility checked)
  settings/                           branding + single-template switch + saved themes
  document-types/                     the printable document types
  meta/                               {can_design, ...} for the signed-in user

Reads stay open (every module prints through these); writes need a designer role. Nothing
here touches transactions, numbering, stock or accounting — templates are presentation only.
"""
import copy
import logging

from django.db import transaction
from django.db.utils import OperationalError, ProgrammingError
from django.utils import timezone
from rest_framework import exceptions, viewsets, permissions, status
from rest_framework.decorators import action
from rest_framework.response import Response
from rest_framework.views import APIView

from .bill_fields import compatible_document_types, incompatibility_reason
from .bill_presets import (
    DEFAULT_PRESET_KEY, PRESET_GENERATION, VISUAL_DEFAULT_ASSIGNMENTS, VISUAL_PRESETS, visual_preset,
)
from .models import (
    BillTemplate, BillTemplateVersion, DocumentTemplateAssignment, BillingSettings,
    DOCUMENT_TYPES, DOCUMENT_TYPE_KEYS, DOCUMENT_TYPE_ALIASES,
)
from .presets import legacy_preset
from .serializers import (
    BillTemplateSerializer, DocumentTemplateAssignmentSerializer, BillingSettingsSerializer,
)

logger = logging.getLogger('django')

DOC_LABELS = dict(DOCUMENT_TYPES)
MAX_VERSIONS_KEPT = 30
# Roles that may create / change bill templates, assignments and branding. Matches
# accounts.User.ROLE_CHOICES (superusers count as SUPER_ADMIN).
DESIGNER_ROLES = {'SUPER_ADMIN', 'ADMINISTRATOR', 'MANAGER'}


def user_role(user):
    if not user or not getattr(user, 'is_authenticated', False):
        return ''
    if getattr(user, 'is_superuser', False):
        return 'SUPER_ADMIN'
    return (getattr(user, 'role', '') or '').upper()


def can_design(user):
    return user_role(user) in DESIGNER_ROLES


def _actor(request):
    u = getattr(request, 'user', None)
    return (getattr(u, 'username', '') or '') if u and getattr(u, 'is_authenticated', False) else ''


def _doc_type(value):
    return DOCUMENT_TYPE_ALIASES.get(value, value)


class DesignerWritePermission(permissions.BasePermission):
    message = 'Sign in as a Super Admin, Administrator or Manager to change bill templates.'

    def has_permission(self, request, view):
        if request.method in permissions.SAFE_METHODS:
            return True
        return can_design(request.user)


class OpenReadsMixin:
    """Printing reads these endpoints from every screen; an expired / missing token must not
    turn a reprint into an error, so reads skip authentication entirely. Writes authenticate
    normally (and DesignerWritePermission then checks the role)."""
    permission_classes = [DesignerWritePermission]

    def perform_authentication(self, request):
        if request.method not in permissions.SAFE_METHODS:
            request.user  # noqa: B018 — forces authentication


# ---------------------------------------------------------------------------
# Seeding
# ---------------------------------------------------------------------------

_seeded = False


def _create_from_spec(spec, *, name=None, is_default=False, actor=''):
    return BillTemplate.objects.create(
        name=name or spec['name'], template_type=spec.get('template_type', 'CUSTOM'),
        description=spec.get('description', ''), paper_size=spec['paper_size'],
        orientation=spec.get('orientation', 'portrait'), margins=copy.deepcopy(spec.get('margins') or {}),
        config=copy.deepcopy(spec['config']), is_active=True, is_default=is_default, is_preset=True,
        preset_key=spec['preset_key'], updated_by_name=actor,
    )


def _unique_name(base, exclude_pk=None):
    base = (base or 'Untitled').strip()[:110]
    name, n = base, 2
    qs = BillTemplate.objects.all()
    if exclude_pk:
        qs = qs.exclude(pk=exclude_pk)
    while qs.filter(name__iexact=name).exists():
        name = f'{base} {n}'
        n += 1
    return name


def ensure_seeded():
    """Give the install the current generation of visual starter templates.

    Fresh database: seed every preset, make Classic A4 the default and assign each document
    type its recommended starter. Existing install: add only the presets it is missing and
    assign starters to document types that had no assignment row at all (new types) — the
    user's existing choices, including "use default", are never changed."""
    global _seeded
    if _seeded:
        return
    try:
        pk = BillingSettings.load().pk
        with transaction.atomic():
            # UPDATE first: takes the row lock (PostgreSQL) / write lock (SQLite) so parallel
            # first requests serialise instead of seeding twice.
            BillingSettings.objects.filter(pk=pk).update(updated_at=timezone.now())
            settings_row = BillingSettings.objects.get(pk=pk)
            if settings_row.presets_generation >= PRESET_GENERATION:
                _seeded = True
                return
            fresh = not BillTemplate.all_objects.exists()
            have = set(BillTemplate.all_objects.exclude(preset_key='').values_list('preset_key', flat=True))
            for p in VISUAL_PRESETS:
                if p['preset_key'] not in have:
                    _create_from_spec(visual_preset(p['preset_key']),
                                      name=_unique_name(p['name']),
                                      is_default=fresh and p['preset_key'] == DEFAULT_PRESET_KEY)
            existing_rows = set(DocumentTemplateAssignment.objects.values_list('document_type', flat=True))
            for dt in DOCUMENT_TYPE_KEYS:
                row, created = DocumentTemplateAssignment.objects.get_or_create(document_type=dt)
                if (fresh or dt not in existing_rows) and row.template_id is None:
                    tpl = BillTemplate.objects.filter(preset_key=VISUAL_DEFAULT_ASSIGNMENTS.get(dt)).first()
                    if tpl:
                        row.template = tpl
                        row.save(update_fields=['template', 'updated_at'])
            if not BillTemplate.objects.filter(is_default=True).exists():
                tpl = BillTemplate.objects.filter(preset_key=DEFAULT_PRESET_KEY).first()
                if tpl:
                    tpl.is_default = True
                    tpl.save()
            settings_row.presets_generation = PRESET_GENERATION
            settings_row.save(update_fields=['presets_generation', 'updated_at'])
        _seeded = True
    except (ProgrammingError, OperationalError):
        # Billing tables not migrated yet — /api/health/ reports the pending migration.
        pass


def reset_seed_flag():
    global _seeded
    _seeded = False


def _snapshot(tpl, actor):
    BillTemplateVersion.objects.create(
        template=tpl, version=tpl.version, name=tpl.name, paper_size=tpl.paper_size,
        orientation=tpl.orientation, custom_width_mm=tpl.custom_width_mm,
        custom_height_mm=tpl.custom_height_mm, margins=copy.deepcopy(tpl.margins),
        config=copy.deepcopy(tpl.config), saved_by=actor,
    )
    stale = list(tpl.versions.order_by('-version').values_list('pk', flat=True)[MAX_VERSIONS_KEPT:])
    if stale:
        BillTemplateVersion.objects.filter(pk__in=stale).delete()


def _preset_spec(key):
    return visual_preset(key) or legacy_preset(key)


def _apply_spec(tpl, spec):
    tpl.paper_size = spec['paper_size']
    tpl.orientation = spec.get('orientation', 'portrait')
    tpl.custom_width_mm = None
    tpl.custom_height_mm = None
    tpl.margins = copy.deepcopy(spec.get('margins') or {})
    tpl.config = copy.deepcopy(spec['config'])


# ---------------------------------------------------------------------------
# Templates
# ---------------------------------------------------------------------------

class BillTemplateViewSet(OpenReadsMixin, viewsets.ModelViewSet):
    serializer_class = BillTemplateSerializer
    pagination_class = None

    def get_queryset(self):
        qs = BillTemplate.objects.all().prefetch_related('assignments')
        if (self.request.query_params.get('active') or '').lower() in ('1', 'true', 'yes'):
            qs = qs.filter(is_active=True)
        return qs

    def list(self, request, *args, **kwargs):
        ensure_seeded()
        return super().list(request, *args, **kwargs)

    def perform_create(self, serializer):
        serializer.save(version=1, updated_by_name=_actor(self.request), preset_key='', is_preset=False)

    def update(self, request, *args, **kwargs):
        tpl = self.get_object()
        expected = request.data.get('expected_version')
        if expected not in (None, '') and str(expected) != str(tpl.version):
            return Response({
                'detail': f'“{tpl.name}” was changed by someone else (now version {tpl.version}, you edited '
                          f'version {expected}). Reload it, or “Save as New” to keep your design.',
                'current_version': tpl.version,
            }, status=status.HTTP_409_CONFLICT)
        serializer = self.get_serializer(tpl, data=request.data, partial=kwargs.pop('partial', False))
        serializer.is_valid(raise_exception=True)
        with transaction.atomic():
            locked = BillTemplate.objects.select_for_update().get(pk=tpl.pk)
            if expected not in (None, '') and str(expected) != str(locked.version):
                return Response({'detail': 'Template changed while saving — reload and try again.',
                                 'current_version': locked.version}, status=status.HTTP_409_CONFLICT)
            _snapshot(locked, _actor(request))
            serializer.save(version=locked.version + 1, updated_by_name=_actor(request))
        return Response(serializer.data)

    def destroy(self, request, *args, **kwargs):
        tpl = self.get_object()
        if tpl.is_default:
            return Response({'detail': 'Set another template as default before deleting this one.'},
                            status=status.HTTP_400_BAD_REQUEST)
        if BillTemplate.objects.filter(is_active=True).exclude(pk=tpl.pk).count() < 1:
            return Response({'detail': 'At least one active template must remain.'},
                            status=status.HTTP_400_BAD_REQUEST)
        with transaction.atomic():
            # Soft delete doesn't fire the FK's SET_NULL, so release the assignments explicitly —
            # those document types fall back to the default template.
            DocumentTemplateAssignment.objects.filter(template=tpl).update(template=None, updated_at=timezone.now())
            BillingSettings.objects.filter(single_template=tpl).update(single_template=None, use_single_template=False)
            tpl.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)

    @action(detail=True, methods=['post'])
    def duplicate(self, request, pk=None):
        src = self.get_object()
        clone = BillTemplate.objects.create(
            name=_unique_name(request.data.get('name') or f'{src.name} (Copy)'),
            template_type=src.template_type if src.template_type != 'STANDARD' else 'CUSTOM',
            description=src.description, paper_size=src.paper_size, orientation=src.orientation,
            custom_width_mm=src.custom_width_mm, custom_height_mm=src.custom_height_mm,
            margins=copy.deepcopy(src.margins), config=copy.deepcopy(src.config),
            is_active=True, is_default=False, is_preset=False, preset_key=src.preset_key,
            updated_by_name=_actor(request),
        )
        return Response(self.get_serializer(clone).data, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=['post'])
    def rename(self, request, pk=None):
        tpl = self.get_object()
        ser = self.get_serializer(tpl, data={'name': request.data.get('name')}, partial=True)
        ser.is_valid(raise_exception=True)
        tpl.name = ser.validated_data['name']
        tpl.updated_by_name = _actor(request)
        tpl.save(update_fields=['name', 'updated_by_name', 'updated_at'])
        return Response(self.get_serializer(tpl).data)

    @action(detail=True, methods=['post'], url_path='set-default')
    def set_default(self, request, pk=None):
        tpl = self.get_object()
        tpl.is_default = True
        tpl.is_active = True
        tpl.save()  # model.save() demotes every other default
        return Response(self.get_serializer(tpl).data)

    @action(detail=True, methods=['post'])
    def activate(self, request, pk=None):
        tpl = self.get_object()
        tpl.is_active = True
        tpl.save(update_fields=['is_active', 'updated_at'])
        return Response(self.get_serializer(tpl).data)

    @action(detail=True, methods=['post'])
    def deactivate(self, request, pk=None):
        tpl = self.get_object()
        if tpl.is_default:
            return Response({'detail': 'The default template cannot be deactivated.'},
                            status=status.HTTP_400_BAD_REQUEST)
        tpl.is_active = False
        tpl.save(update_fields=['is_active', 'updated_at'])
        return Response(self.get_serializer(tpl).data)

    @action(detail=True, methods=['post'])
    def assign(self, request, pk=None):
        """Point the given document types at this template. With replace=true, document types
        not listed that currently use it are released to the default template."""
        tpl = self.get_object()
        wanted = [_doc_type(d) for d in (request.data.get('document_types') or [])]
        unknown = [d for d in wanted if d not in DOCUMENT_TYPE_KEYS]
        if unknown:
            return Response({'detail': f'Unknown document type “{unknown[0]}”.'}, status=status.HTTP_400_BAD_REQUEST)
        errors = {d: incompatibility_reason(tpl.config, d) for d in wanted}
        errors = {d: r for d, r in errors.items() if r}
        if errors:
            first = next(iter(errors))
            return Response({'detail': f'“{tpl.name}” cannot print {DOC_LABELS[first]}: {errors[first]}.',
                             'errors': errors}, status=status.HTTP_400_BAD_REQUEST)
        with transaction.atomic():
            for d in wanted:
                row, _ = DocumentTemplateAssignment.objects.get_or_create(document_type=d)
                row.template = tpl
                row.save(update_fields=['template', 'updated_at'])
            if _truthy(request.data.get('replace')):
                DocumentTemplateAssignment.objects.filter(template=tpl).exclude(document_type__in=wanted) \
                    .update(template=None, updated_at=timezone.now())
            if not tpl.is_active:
                tpl.is_active = True
                tpl.save(update_fields=['is_active', 'updated_at'])
        tpl.refresh_from_db()
        return Response(self.get_serializer(tpl).data)

    @action(detail=True, methods=['post'], url_path='restore-default')
    def restore_default(self, request, pk=None):
        tpl = self.get_object()
        spec = _preset_spec(tpl.preset_key)
        if not spec:
            return Response({'detail': 'This template was not created from a starter preset, so it has no '
                                       'default to restore. Use Version history to roll back instead.'},
                            status=status.HTTP_400_BAD_REQUEST)
        for a in tpl.assignments.all():
            reason = incompatibility_reason(spec['config'], a.document_type)
            if reason:
                return Response({'detail': f'The starter layout cannot print {DOC_LABELS.get(a.document_type)} '
                                           f'({reason}) — reassign that document first.'},
                                status=status.HTTP_400_BAD_REQUEST)
        with transaction.atomic():
            _snapshot(tpl, _actor(request))
            _apply_spec(tpl, spec)
            tpl.version += 1
            tpl.updated_by_name = _actor(request)
            tpl.save()
        return Response(self.get_serializer(tpl).data)

    @action(detail=True, methods=['get'])
    def versions(self, request, pk=None):
        tpl = self.get_object()
        return Response([{
            'version': v.version, 'name': v.name, 'paper_size': v.paper_size, 'orientation': v.orientation,
            'saved_at': v.saved_at, 'saved_by': v.saved_by,
            'schema': 2 if (v.config or {}).get('schema') == 2 else 1,
        } for v in tpl.versions.all()[:MAX_VERSIONS_KEPT]])

    @action(detail=True, methods=['post'], url_path='restore-version')
    def restore_version(self, request, pk=None):
        tpl = self.get_object()
        v = tpl.versions.filter(version=request.data.get('version')).first()
        if not v:
            return Response({'detail': 'That version no longer exists.'}, status=status.HTTP_404_NOT_FOUND)
        for a in tpl.assignments.all():
            reason = incompatibility_reason(v.config, a.document_type)
            if reason:
                return Response({'detail': f'Version {v.version} cannot print {DOC_LABELS.get(a.document_type)} '
                                           f'({reason}) — reassign that document first.'},
                                status=status.HTTP_400_BAD_REQUEST)
        with transaction.atomic():
            _snapshot(tpl, _actor(request))
            tpl.paper_size, tpl.orientation = v.paper_size, v.orientation
            tpl.custom_width_mm, tpl.custom_height_mm = v.custom_width_mm, v.custom_height_mm
            tpl.margins = copy.deepcopy(v.margins)
            tpl.config = copy.deepcopy(v.config)
            tpl.version += 1
            tpl.updated_by_name = _actor(request)
            tpl.save()
        return Response(self.get_serializer(tpl).data)

    @action(detail=False, methods=['get'])
    def deleted(self, request):
        rows = BillTemplate.all_objects.filter(is_deleted=True).order_by('-updated_at')[:50]
        return Response(self.get_serializer(rows, many=True).data)

    @action(detail=True, methods=['post'])
    def undelete(self, request, pk=None):
        tpl = BillTemplate.all_objects.filter(pk=pk, is_deleted=True).first()
        if not tpl:
            return Response({'detail': 'Deleted template not found.'}, status=status.HTTP_404_NOT_FOUND)
        tpl.name = _unique_name(tpl.name if not BillTemplate.objects.filter(name__iexact=tpl.name).exists()
                                else f'{tpl.name} (Restored)')
        tpl.is_deleted = False
        tpl.is_default = False
        tpl.save()
        return Response(self.get_serializer(tpl).data)

    @action(detail=False, methods=['get'])
    def presets(self, request):
        out = []
        for p in VISUAL_PRESETS:
            spec = visual_preset(p['preset_key'])
            out.append({
                'preset_key': p['preset_key'], 'name': p['name'], 'description': p['description'],
                'paper_size': p['paper_size'], 'orientation': p['orientation'], 'margins': spec['margins'],
                'config': spec['config'], 'compatible_types': compatible_document_types(spec['config']),
                'recommended_for': [d for d, k in VISUAL_DEFAULT_ASSIGNMENTS.items() if k == p['preset_key']],
            })
        return Response(out)

    @action(detail=False, methods=['post'], url_path='from-preset')
    def from_preset(self, request):
        spec = visual_preset(request.data.get('preset_key'))
        if not spec:
            return Response({'detail': 'Unknown starter template.'}, status=status.HTTP_400_BAD_REQUEST)
        tpl = _create_from_spec(spec, name=_unique_name(request.data.get('name') or spec['name']),
                                actor=_actor(request))
        tpl.is_preset = False
        tpl.save(update_fields=['is_preset'])
        return Response(self.get_serializer(tpl).data, status=status.HTTP_201_CREATED)

    @action(detail=False, methods=['post'], url_path='restore-defaults')
    def restore_defaults(self, request):
        """Bring back the starter templates: recreate any that were deleted, optionally reset
        edited ones (each keeps its old design in Version history) and optionally re-point
        every document type at its recommended starter."""
        reset_modified = _truthy(request.data.get('reset_modified'))
        reassign = _truthy(request.data.get('reassign'))
        actor = _actor(request)
        created, reset = [], []
        with transaction.atomic():
            for p in VISUAL_PRESETS:
                key = p['preset_key']
                spec = visual_preset(key)
                live = BillTemplate.objects.filter(preset_key=key, is_preset=True).first()
                if live is None:
                    live = _create_from_spec(spec, name=_unique_name(spec['name']), actor=actor)
                    created.append(live.name)
                elif reset_modified and (live.config != spec['config'] or live.paper_size != spec['paper_size']
                                         or live.orientation != spec['orientation'] or live.margins != spec['margins']):
                    if any(incompatibility_reason(spec['config'], a.document_type) for a in live.assignments.all()):
                        continue
                    _snapshot(live, actor)
                    _apply_spec(live, spec)
                    live.version += 1
                    live.is_active = True
                    live.updated_by_name = actor
                    live.save()
                    reset.append(live.name)
            if reassign:
                for dt, key in VISUAL_DEFAULT_ASSIGNMENTS.items():
                    tpl = BillTemplate.objects.filter(preset_key=key, is_preset=True).first()
                    if tpl:
                        DocumentTemplateAssignment.objects.update_or_create(document_type=dt, defaults={'template': tpl})
                BillingSettings.objects.update(use_single_template=False)
            if not BillTemplate.objects.filter(is_default=True).exists():
                tpl = BillTemplate.objects.filter(preset_key=DEFAULT_PRESET_KEY).first()
                if tpl:
                    tpl.is_default = True
                    tpl.save()
        return Response({'created': created, 'reset': reset, 'reassigned': reassign})


def _truthy(v):
    return v is True or str(v).lower() in ('1', 'true', 'yes')


# ---------------------------------------------------------------------------
# Assignments / settings / meta
# ---------------------------------------------------------------------------

class DocumentTemplateAssignmentViewSet(OpenReadsMixin, viewsets.ModelViewSet):
    queryset = DocumentTemplateAssignment.objects.select_related('template').all()
    serializer_class = DocumentTemplateAssignmentSerializer
    pagination_class = None
    http_method_names = ['get', 'put', 'patch', 'head', 'options']

    def get_queryset(self):
        return DocumentTemplateAssignment.objects.select_related('template') \
            .filter(document_type__in=DOCUMENT_TYPE_KEYS)

    def list(self, request, *args, **kwargs):
        ensure_seeded()
        # Guarantee a row for every known document type so the UI always renders the full list.
        try:
            existing = set(DocumentTemplateAssignment.objects.values_list('document_type', flat=True))
            for k in DOCUMENT_TYPE_KEYS:
                if k not in existing:
                    DocumentTemplateAssignment.objects.get_or_create(document_type=k)
        except (ProgrammingError, OperationalError):
            pass
        return super().list(request, *args, **kwargs)

    def update(self, request, *args, **kwargs):
        return self._save_rows([{**request.data, 'document_type': self.get_object().document_type}], single=True)

    @action(detail=False, methods=['put', 'patch'], url_path='bulk')
    def bulk_update(self, request):
        """Body: {"assignments": [{"document_type": "...", "template": "<uuid|null>"}, ...]}"""
        return self._save_rows(request.data.get('assignments', []))

    def _save_rows(self, rows, single=False):
        plan, errors = [], {}
        for row in rows:
            dt = _doc_type(row.get('document_type'))
            if dt not in DOCUMENT_TYPE_KEYS:
                continue
            tpl_id = row.get('template') or None
            tpl = None
            if tpl_id:
                tpl = BillTemplate.objects.filter(pk=tpl_id).first()
                if tpl is None:
                    errors[dt] = 'that template no longer exists'
                    continue
                reason = incompatibility_reason(tpl.config, dt)
                if reason:
                    errors[dt] = f'“{tpl.name}” cannot be used — {reason}'
                    continue
            plan.append((dt, tpl))
        if errors:
            first = next(iter(errors))
            return Response({'detail': f'{DOC_LABELS.get(first, first)}: {errors[first]}.', 'errors': errors},
                            status=status.HTTP_400_BAD_REQUEST)
        out = []
        with transaction.atomic():
            for dt, tpl in plan:
                obj, _ = DocumentTemplateAssignment.objects.get_or_create(document_type=dt)
                obj.template = tpl
                obj.save(update_fields=['template', 'updated_at'])
                if tpl is not None and not tpl.is_active:
                    tpl.is_active = True
                    tpl.save(update_fields=['is_active', 'updated_at'])
                out.append(obj)
        data = DocumentTemplateAssignmentSerializer(out, many=True).data
        return Response(data[0] if single and data else data)


class BillingSettingsView(OpenReadsMixin, APIView):

    def get(self, request):
        ensure_seeded()
        return Response(BillingSettingsSerializer(BillingSettings.load()).data)

    def patch(self, request):
        obj = BillingSettings.load()
        ser = BillingSettingsSerializer(obj, data=request.data, partial=True)
        ser.is_valid(raise_exception=True)
        ser.save()
        return Response(ser.data)

    put = patch


class DocumentTypeListView(OpenReadsMixin, APIView):

    def get(self, request):
        return Response([{'key': k, 'label': v} for k, v in DOCUMENT_TYPES])


class BillingMetaView(APIView):
    """What the signed-in user may do in the designer. Authenticates (unlike the open reads)
    but never fails: no / bad token simply means can_design=false."""
    permission_classes = [permissions.AllowAny]

    def perform_authentication(self, request):
        try:
            request.user  # noqa: B018
        except exceptions.APIException:
            pass  # DRF already fell back to AnonymousUser

    def get(self, request):
        user = request.user
        return Response({
            'can_design': can_design(user),
            'role': user_role(user),
            'username': _actor(request) if user is not None else '',
            'document_types': [{'key': k, 'label': v} for k, v in DOCUMENT_TYPES],
            'preset_generation': PRESET_GENERATION,
        })
