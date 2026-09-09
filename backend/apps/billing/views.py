import copy
import logging

from django.db.utils import OperationalError, ProgrammingError
from rest_framework import viewsets, permissions, status
from rest_framework.decorators import action
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import (
    BillTemplate, DocumentTemplateAssignment, BillingSettings,
    DOCUMENT_TYPES, DOCUMENT_TYPE_KEYS,
)
from .serializers import (
    BillTemplateSerializer, DocumentTemplateAssignmentSerializer,
    BillingSettingsSerializer,
)
from .presets import PRESETS, DEFAULT_ASSIGNMENTS

logger = logging.getLogger('django')

_seed_checked = False


def ensure_seeded():
    """Populate the six starter templates + default document-type assignments the first
    time the table is empty. Mirrors the multi-branch self-heal so a fresh / wiped
    database is never left with a blank designer."""
    global _seed_checked
    try:
        if BillTemplate.objects.exists():
            _seed_checked = True
            return
        by_name = {}
        for spec in PRESETS:
            tpl = BillTemplate.objects.create(is_preset=True, **spec)
            by_name[tpl.name] = tpl
        for doc_type, tpl_name in DEFAULT_ASSIGNMENTS.items():
            DocumentTemplateAssignment.objects.get_or_create(
                document_type=doc_type,
                defaults={'template': by_name.get(tpl_name)},
            )
        BillingSettings.load()
        _seed_checked = True
    except (ProgrammingError, OperationalError):
        # Billing tables not migrated yet — let the request proceed; /api/health/ reports
        # the pending migration.
        pass


class BillTemplateViewSet(viewsets.ModelViewSet):
    queryset = BillTemplate.objects.all().prefetch_related('assignments')
    serializer_class = BillTemplateSerializer
    authentication_classes = []
    permission_classes = [permissions.AllowAny]

    def list(self, request, *args, **kwargs):
        ensure_seeded()
        return super().list(request, *args, **kwargs)

    def get_queryset(self):
        try:
            qs = BillTemplate.objects.all().prefetch_related('assignments')
            if (self.request.query_params.get('active') or '').lower() in ('1', 'true', 'yes'):
                qs = qs.filter(is_active=True)
            return qs
        except Exception:
            return BillTemplate.objects.none()

    @action(detail=True, methods=['post'])
    def duplicate(self, request, pk=None):
        src = self.get_object()
        clone = BillTemplate.objects.create(
            name=f"{src.name} (Copy)",
            template_type='CUSTOM',
            description=src.description,
            paper_size=src.paper_size,
            orientation=src.orientation,
            custom_width_mm=src.custom_width_mm,
            custom_height_mm=src.custom_height_mm,
            margins=copy.deepcopy(src.margins),
            config=copy.deepcopy(src.config),
            is_active=True,
            is_default=False,
            is_preset=False,
        )
        return Response(self.get_serializer(clone).data, status=status.HTTP_201_CREATED)

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

    def destroy(self, request, *args, **kwargs):
        tpl = self.get_object()
        if tpl.is_default:
            return Response({'detail': 'Set another template as default before deleting this one.'},
                            status=status.HTTP_400_BAD_REQUEST)
        if BillTemplate.objects.filter(is_active=True).count() <= 1:
            return Response({'detail': 'At least one active template must remain.'},
                            status=status.HTTP_400_BAD_REQUEST)
        return super().destroy(request, *args, **kwargs)


class DocumentTemplateAssignmentViewSet(viewsets.ModelViewSet):
    queryset = DocumentTemplateAssignment.objects.select_related('template').all()
    serializer_class = DocumentTemplateAssignmentSerializer
    authentication_classes = []
    permission_classes = [permissions.AllowAny]

    def list(self, request, *args, **kwargs):
        ensure_seeded()
        # Guarantee a row for every known document type so the UI always renders the full list.
        try:
            existing = set(DocumentTemplateAssignment.objects.values_list('document_type', flat=True))
            missing = [k for k in DOCUMENT_TYPE_KEYS if k not in existing]
            for k in missing:
                DocumentTemplateAssignment.objects.get_or_create(document_type=k)
        except (ProgrammingError, OperationalError):
            pass
        return super().list(request, *args, **kwargs)

    @action(detail=False, methods=['put', 'patch'], url_path='bulk')
    def bulk_update(self, request):
        """Body: {"assignments": [{"document_type": "...", "template": "<uuid|null>"}, ...]}"""
        rows = request.data.get('assignments', [])
        out = []
        for row in rows:
            dt = row.get('document_type')
            if dt not in DOCUMENT_TYPE_KEYS:
                continue
            obj, _ = DocumentTemplateAssignment.objects.get_or_create(document_type=dt)
            obj.template_id = row.get('template') or None
            obj.save(update_fields=['template', 'updated_at'])
            out.append(obj)
        return Response(DocumentTemplateAssignmentSerializer(out, many=True).data)


class BillingSettingsView(APIView):
    authentication_classes = []
    permission_classes = [permissions.AllowAny]

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


class DocumentTypeListView(APIView):
    authentication_classes = []
    permission_classes = [permissions.AllowAny]

    def get(self, request):
        return Response([{'key': k, 'label': v} for k, v in DOCUMENT_TYPES])
