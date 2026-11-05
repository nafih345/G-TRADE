"""Platform console, per client: data inspection and backups. Mixed into TenantAdminViewSet.

    GET    /api/superadmin/tenants/<id>/data/                         datasets, counts, recent activity
    GET    /api/superadmin/tenants/<id>/data/<key>/                   rows (search, date_from, date_to,
                                                                      deleted, page, page_size; export=csv)
    GET    /api/superadmin/tenants/<id>/data/<key>/<pk>/              one record + child lines
    GET    /api/superadmin/tenants/<id>/backups/                      history, schedule, sections, storage
    POST   /api/superadmin/tenants/<id>/backups/                      {sections: [] = full | [keys]}
    GET    /api/superadmin/tenants/<id>/backups/<bid>/                one backup (per-table row counts)
    DELETE /api/superadmin/tenants/<id>/backups/<bid>/
    POST   /api/superadmin/tenants/<id>/backups/<bid>/download-link/  short-lived signed URL
    PUT    /api/superadmin/tenants/<id>/backup-schedule/              automatic backups of this client
    GET    /api/superadmin/backup-download/<bid>/?token=…             the file (signed link, no bearer)

Reads are logged in the client's history (DATA_VIEWED at most once per dataset per actor every
VIEW_LOG_WINDOW, every CSV export and download), so the client's data access by the platform is
itself auditable. Backups reuse apps.security.backup — same archive, verification and storage as
whole-database backups — limited to this tenant's rows (tenant_scope). They are exports: they
cannot be restored from here or from System Security & Backup.
"""
import datetime

from django.core import signing
from django.db import transaction
from django.http import HttpResponse, StreamingHttpResponse
from django.shortcuts import get_object_or_404
from django.utils import timezone
from rest_framework import permissions, status
from rest_framework.decorators import action
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.common import tenant_data
from apps.common.models import TenantAuditLog
from apps.common.permissions import is_platform_admin
from apps.common.tenant_onboarding import log_event

DOWNLOAD_SALT = 'superadmin.client-backup.download'
DOWNLOAD_TTL = 120
VIEW_LOG_WINDOW = datetime.timedelta(minutes=30)
HISTORY_LIMIT = 100


def _log_view(tenant, user, dataset, label):
    since = timezone.now() - VIEW_LOG_WINDOW
    recent = TenantAuditLog.objects.filter(tenant=tenant, action='DATA_VIEWED', actor=user.username,
                                           created_at__gte=since, details__dataset=dataset)
    if not recent.exists():
        log_event(tenant, 'DATA_VIEWED', user, dataset=dataset, label=label)


def _client_records(tenant):
    from apps.security.models import BackupRecord
    return BackupRecord.objects.filter(client_tenant_id=tenant.pk)


def _schedule(tenant):
    from apps.security.models import TenantBackupSchedule
    return TenantBackupSchedule.objects.get_or_create(client_tenant_id=tenant.pk)[0]


def _schedule_payload(s):
    from apps.security.backup import scheduler, tenant_scope
    name, _ = scheduler.business_timezone(s.client_tenant_id)
    return {
        'enabled': s.enabled, 'frequency': s.frequency, 'backup_time': s.backup_time.strftime('%H:%M'),
        'weekday': s.weekday, 'day_of_month': s.day_of_month, 'retention_count': s.retention_count,
        'sections': s.sections, 'sections_label': tenant_scope.sections_label(s.sections), 'timezone': name,
        'next_run_at': s.next_run_at.isoformat() if s.enabled and s.next_run_at else None,
        'last_run_at': s.last_run_at.isoformat() if s.last_run_at else None, 'last_run_status': s.last_run_status,
        'updated_at': s.updated_at.isoformat() if s.updated_at else None, 'updated_by': s.updated_by_name,
    }


class TenantDataBackupMixin:
    """Actions for TenantAdminViewSet (which supplies get_object and the IsPlatformAdmin gate)."""

    # ---- data inspection ----------------------------------------------------------------

    @action(detail=True, methods=['get'], url_path='data')
    def data_overview(self, request, pk=None):
        tenant = self.get_object()
        _log_view(tenant, request.user, 'overview', 'Data overview')
        return Response(tenant_data.overview(tenant))

    @action(detail=True, methods=['get'], url_path=r'data/(?P<dataset>[a-z_]{1,40})')
    def data_rows(self, request, pk=None, dataset=None):
        tenant = self.get_object()
        params = request.query_params
        try:
            if params.get('export') == 'csv':
                filename, text, count = tenant_data.export_csv(tenant, dataset, params)
                log_event(tenant, 'DATA_EXPORTED', request.user, dataset=dataset, rows=count,
                          label=tenant_data.DATASET_MAP[dataset]['label'],
                          filters={k: params.get(k) for k in ('search', 'date_from', 'date_to', 'deleted')
                                   if params.get(k)})
                response = HttpResponse(text, content_type='text/csv; charset=utf-8')
                response['Content-Disposition'] = f'attachment; filename="{filename}"'
                response['Cache-Control'] = 'no-store'
                return response
            data = tenant_data.rows(tenant, dataset, params)
        except tenant_data.DatasetError as exc:
            return Response({'detail': str(exc)}, status=status.HTTP_400_BAD_REQUEST
                            if dataset in tenant_data.DATASET_MAP else status.HTTP_404_NOT_FOUND)
        _log_view(tenant, request.user, dataset, data['label'])
        return Response(data)

    @action(detail=True, methods=['get'], url_path=r'data/(?P<dataset>[a-z_]{1,40})/(?P<record_id>[0-9A-Za-z-]{1,40})')
    def data_record(self, request, pk=None, dataset=None, record_id=None):
        tenant = self.get_object()
        try:
            return Response(tenant_data.record(tenant, dataset, record_id))
        except tenant_data.DatasetError as exc:
            return Response({'detail': str(exc)}, status=status.HTTP_404_NOT_FOUND)

    # ---- backups ------------------------------------------------------------------------

    @action(detail=True, methods=['get', 'post'], url_path='backups')
    def client_backups(self, request, pk=None):
        from apps.security.backup import archive, service, storage, tenant_scope
        tenant = self.get_object()
        if request.method == 'POST':
            body = request.data if isinstance(request.data, dict) else {}
            sections = body.get('sections') or []
            if not isinstance(sections, list):
                return Response({'sections': ['Send a list of sections, or none for a full backup.']},
                                status=status.HTTP_400_BAD_REQUEST)
            try:
                record = service.start_client_backup(tenant, sections, user=request.user)
            except service.BackupBusy as exc:
                return Response({'detail': str(exc), 'code': 'busy'}, status=status.HTTP_409_CONFLICT)
            except archive.BackupError as exc:
                return Response({'sections': [str(exc)]}, status=status.HTTP_400_BAD_REQUEST)
            log_event(tenant, 'BACKUP_REQUESTED', request.user, backup=record.backup_identifier,
                      sections=tenant_scope.sections_label(record.sections))
            return Response(service.record_summary(record, detail=True), status=status.HTTP_202_ACCEPTED)

        service.recover_stale()
        records = _client_records(tenant).exclude(status='DELETED').order_by('-created_at')[:HISTORY_LIMIT]
        used = sum(r.file_size for r in records if r.available)
        return Response({
            'backups': [service.record_summary(r) | {'can_delete': r.status not in ('QUEUED', 'RUNNING')}
                        for r in records],
            'running': any(r.status in ('QUEUED', 'RUNNING') for r in records),
            'sections': [{'key': k, 'label': label, 'description': d} for k, label, d in tenant_scope.SECTIONS],
            'schedule': _schedule_payload(_schedule(tenant)),
            'storage': {'client_bytes': used, 'used_bytes': service.storage_used_bytes(),
                        'capacity_bytes': storage.capacity_bytes(),
                        'location_label': storage.configured_store().label,
                        'warning': storage.ephemeral_warning()},
            'retention_presets': [7, 15, 30, 60],
        })

    def _client_record(self, tenant, backup_id):
        return get_object_or_404(_client_records(tenant), pk=backup_id)

    @action(detail=True, methods=['get', 'delete'], url_path=r'backups/(?P<backup_id>[0-9a-fA-F-]{36})')
    def client_backup(self, request, pk=None, backup_id=None):
        from apps.security.backup import archive, service
        tenant = self.get_object()
        record = self._client_record(tenant, backup_id)
        if request.method == 'DELETE':
            try:
                service.delete_backup(record, user=request.user, request=request)
            except archive.BackupError as exc:
                return Response({'detail': str(exc), 'code': 'not_deletable'}, status=status.HTTP_409_CONFLICT)
            log_event(tenant, 'BACKUP_DELETED', request.user, backup=record.backup_identifier)
            record.refresh_from_db()
        else:
            service.recover_stale()
        return Response(service.record_summary(record, detail=True))

    @action(detail=True, methods=['post'], url_path=r'backups/(?P<backup_id>[0-9a-fA-F-]{36})/download-link')
    def client_backup_link(self, request, pk=None, backup_id=None):
        from apps.security.backup import storage
        tenant = self.get_object()
        record = self._client_record(tenant, backup_id)
        if not record.available or not storage.store_for(record).exists(record):
            return Response({'detail': 'This backup is not available for download.'}, status=status.HTTP_409_CONFLICT)
        token = signing.dumps({'b': str(record.pk), 'u': str(request.user.pk)}, salt=DOWNLOAD_SALT, compress=True)
        return Response({'url': f'/api/superadmin/backup-download/{record.pk}/?token={token}',
                         'expires_in': DOWNLOAD_TTL, 'filename': record.filename, 'size': record.file_size})

    @action(detail=True, methods=['put'], url_path='backup-schedule')
    def client_backup_schedule(self, request, pk=None):
        from apps.security.backup import archive, scheduler, tenant_scope
        from apps.security.models import TenantBackupSchedule
        from apps.security.views import _validate_schedule
        tenant = self.get_object()
        data = request.data if isinstance(request.data, dict) else {}
        clean, errors = _validate_schedule(data)
        if 'sections' in data:
            try:
                clean['sections'] = tenant_scope.normalize_sections(data['sections'] or [])
            except archive.BackupError as exc:
                errors['sections'] = str(exc)
        if errors:
            return Response({'detail': 'Please fix the highlighted fields.', 'errors': errors},
                            status=status.HTTP_400_BAD_REQUEST)
        with transaction.atomic():
            s = TenantBackupSchedule.objects.select_for_update().get(pk=_schedule(tenant).pk)
            changes = {k: v for k, v in clean.items() if getattr(s, k) != v}
            for key, value in clean.items():
                setattr(s, key, value)
            s.updated_by_name = request.user.username[:150]
            s.save()
        scheduler.refresh_client_next_run(s)
        if changes:
            shown = {k: (v.strftime('%H:%M') if isinstance(v, datetime.time) else v) for k, v in changes.items()}
            log_event(tenant, 'BACKUP_SCHEDULE_CHANGED', request.user, changes=shown)
        return Response(_schedule_payload(s))


class ClientBackupDownloadView(APIView):
    """Streams a per-client backup for a signed link from client_backup_link, so the browser can
    download natively (a plain navigation carries no bearer header)."""
    authentication_classes = []
    token_authentication = False  # token-blind by design (see tenant_context.install_drf_hook)
    permission_classes = [permissions.AllowAny]

    def get(self, request, pk):
        from django.contrib.auth import get_user_model
        from apps.common.models import Tenant
        from apps.security.backup import storage
        from apps.security.models import BackupRecord
        try:
            claims = signing.loads(request.query_params.get('token') or '', salt=DOWNLOAD_SALT, max_age=DOWNLOAD_TTL)
        except signing.SignatureExpired:
            return Response({'detail': 'This download link has expired. Start the download again.'},
                            status=status.HTTP_403_FORBIDDEN)
        except signing.BadSignature:
            return Response({'detail': 'Invalid download link.'}, status=status.HTTP_403_FORBIDDEN)
        if claims.get('b') != str(pk):
            return Response({'detail': 'Invalid download link.'}, status=status.HTTP_403_FORBIDDEN)
        user = get_user_model().objects.filter(pk=claims.get('u')).first()
        if not is_platform_admin(user):
            return Response({'detail': 'You are not allowed to download client backups.'},
                            status=status.HTTP_403_FORBIDDEN)
        record = get_object_or_404(BackupRecord.objects.filter(client_tenant_id__isnull=False), pk=pk)
        if not record.available:
            return Response({'detail': 'This backup is not available for download.'}, status=status.HTTP_409_CONFLICT)
        store = storage.store_for(record)
        try:
            chunks = store.iter_bytes(record)
            first = next(chunks)
        except (FileNotFoundError, StopIteration):
            return Response({'detail': 'The backup file is missing from storage.'}, status=status.HTTP_410_GONE)

        def stream():
            yield first
            yield from chunks

        tenant = Tenant.objects.filter(pk=record.client_tenant_id).first()
        if tenant is not None:
            log_event(tenant, 'BACKUP_DOWNLOADED', user, backup=record.backup_identifier)
        response = StreamingHttpResponse(stream(), content_type='application/zip')
        response['Content-Disposition'] = f'attachment; filename="{record.filename}"'
        response['Content-Length'] = str(record.file_size)
        response['Cache-Control'] = 'no-store'
        response['X-Content-Type-Options'] = 'nosniff'
        return response
