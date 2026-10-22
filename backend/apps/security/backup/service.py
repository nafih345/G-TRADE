"""Backup and restore jobs.

Both run on a background thread (a hosted backup can outlast an HTTP request) and report through
their BackupRecord / RestoreJob row, which the screen polls. One OperationLock row serialises them
across every worker process: a second backup, or a backup during a restore, is refused rather than
queued. A heartbeat thread keeps the row fresh; a job whose heartbeat stops (the process died) is
marked failed by recover_stale() and its lock released.
"""
import contextlib
import hashlib
import logging
import os
import secrets
import threading
from datetime import timedelta

from django.conf import settings
from django.db import connections, transaction
from django.db.models import Q, Sum
from django.utils import timezone

from ..audit import log_event
from ..models import BackupRecord, BackupSchedule, OperationLock, RestoreJob
from . import archive, storage

logger = logging.getLogger('django')

LOCK_NAME = 'DATA'
STALE_AFTER = timedelta(seconds=180)
HEARTBEAT_SECONDS = 20

_active = set()           # holders running in this process (never stale while listed)
_active_lock = threading.Lock()
_maintenance = threading.Event()  # set while this process is restoring


class BackupBusy(archive.BackupError):
    pass


# ---- the operation lock ------------------------------------------------------------------------

def _acquire(holder):
    OperationLock.objects.get_or_create(name=LOCK_NAME)
    now = timezone.now()
    free = Q(holder='') | Q(heartbeat_at__lt=now - STALE_AFTER) | Q(heartbeat_at__isnull=True)
    claimed = OperationLock.objects.filter(Q(name=LOCK_NAME) & free).update(
        holder=holder, acquired_at=now, heartbeat_at=now)
    if claimed:
        with _active_lock:
            _active.add(holder)
    return bool(claimed)


def _release(holder):
    OperationLock.objects.filter(name=LOCK_NAME, holder=holder).update(holder='', heartbeat_at=None)
    with _active_lock:
        _active.discard(holder)


def current_holder():
    row = OperationLock.objects.filter(name=LOCK_NAME).values('holder', 'heartbeat_at').first()
    if not row or not row['holder']:
        return ''
    if row['holder'] not in _active and (row['heartbeat_at'] is None
                                         or timezone.now() - row['heartbeat_at'] > STALE_AFTER):
        return ''
    return row['holder']


def restore_in_progress():
    return _maintenance.is_set() or current_holder().startswith('restore:')


class _Heartbeat:
    """Touches the job row + lock from its own thread / DB connection every HEARTBEAT_SECONDS.
    (A restore's own connection is inside one long transaction, so it cannot do this itself.)"""

    def __init__(self, model, pk, holder):
        self.model, self.pk, self.holder = model, pk, holder
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name=f'heartbeat-{holder}', daemon=True)

    def _beat(self):
        now = timezone.now()
        try:
            self.model.objects.filter(pk=self.pk).update(heartbeat_at=now)
            OperationLock.objects.filter(name=LOCK_NAME, holder=self.holder).update(heartbeat_at=now)
        except Exception:  # SQLite write lock held by the restore — the in-process registry covers it
            pass

    def _run(self):
        try:
            while not self._stop.wait(HEARTBEAT_SECONDS):
                self._beat()
        finally:
            connections.close_all()

    def __enter__(self):
        self._thread.start()
        return self

    def __exit__(self, *exc):
        self._stop.set()
        self._thread.join(timeout=5)


def _spawn(target, *args):
    if getattr(settings, 'BACKUP_RUN_INLINE', False):
        target(*args)
        return

    def run():
        try:
            target(*args)
        finally:
            connections.close_all()
    threading.Thread(target=run, name=f'{target.__name__}', daemon=True).start()


def _safe_error(exc, ref):
    if isinstance(exc, archive.BackupError):
        return str(exc)[:500]
    logger.exception('Backup/restore %s failed', ref)
    return f'Unexpected server error (reference {ref}). Details are in the server log.'


# ---- creating backups --------------------------------------------------------------------------

def _new_identity(now):
    suffix = secrets.token_hex(2).upper()
    ident = f'BKP-{now:%Y%m%d-%H%M%S}-{suffix}'
    filename = f'GreensolERP_Backup_{now:%Y%m%d_%H%M%S}_{suffix}.zip'
    return ident, filename


def _new_record(backup_type, user=None, actor_name=''):
    now = timezone.now()
    ident, filename = _new_identity(now)
    return BackupRecord.objects.create(
        backup_identifier=ident, filename=filename, backup_type=backup_type,
        storage_location=storage.configured_store().location, status='QUEUED',
        initiated_by_id=getattr(user, 'pk', None),
        initiated_by_name=(actor_name or getattr(user, 'username', '') or 'System')[:150])


def start_backup(backup_type, *, user=None, actor_name='', request=None, run_async=True):
    """Queue a backup; returns its BackupRecord. Raises BackupBusy when another backup / restore runs."""
    recover_stale()
    record = _new_record(backup_type, user, actor_name)
    holder = f'backup:{record.pk}'
    if not _acquire(holder):
        record.delete()
        raise BackupBusy('Another backup or restore is already running. Try again when it finishes.')
    log_event('BACKUP_REQUESTED', 'BACKUP', f'{record.get_backup_type_display()} backup {record.backup_identifier} '
              'requested', request=request, user=user, actor_name=record.initiated_by_name,
              details={'backup_id': str(record.pk), 'type': backup_type})
    if run_async:
        _spawn(_run_backup_job, record.pk, holder)
    else:
        _run_backup_job(record.pk, holder)
    record.refresh_from_db()
    return record


def _run_backup_job(record_id, holder):
    try:
        _produce(BackupRecord.objects.get(pk=record_id), holder)
    finally:
        _release(holder)


def _sha256(path):
    sha = hashlib.sha256()
    with open(path, 'rb') as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b''):
            sha.update(chunk)
    return sha.hexdigest()


def _produce(record, holder):
    """Dump, store, verify. Leaves the record SUCCESS (verified) or FAILED; never raises."""
    now = timezone.now()
    BackupRecord.objects.filter(pk=record.pk).update(status='RUNNING', started_at=now, heartbeat_at=now)
    store = storage.store_for(record)
    tmp = storage.new_temp_path()
    try:
        with _Heartbeat(BackupRecord, record.pk, holder):
            with open(tmp, 'wb') as fh:
                manifest = archive.write_archive(fh, backup_identifier=record.backup_identifier)
            size = os.path.getsize(tmp)
            checksum = _sha256(tmp)
            store.save(record, tmp)
            # Verify what was actually stored, not the temp file: read it back, hash it, and
            # re-check every entry against the manifest.
            with store.materialize(record) as stored:
                if _sha256(stored) != checksum:
                    raise archive.BackupError('The stored backup does not match what was written.')
                archive.validate_archive(stored)
        BackupRecord.objects.filter(pk=record.pk).update(
            status='SUCCESS', verified=True, file_size=size, checksum=checksum,
            manifest=archive.manifest_summary(manifest), completed_at=timezone.now(), error_summary='')
        record.refresh_from_db()
        log_event('BACKUP_COMPLETED', 'BACKUP',
                  f'{record.get_backup_type_display()} backup {record.backup_identifier} completed and verified',
                  actor_name=record.initiated_by_name,
                  details={'backup_id': str(record.pk), 'size': size, 'rows': manifest['total_rows'],
                           'tables': manifest['table_count'], 'checksum': checksum})
    except Exception as exc:  # noqa: BLE001 - every failure is recorded on the row
        message = _safe_error(exc, record.backup_identifier)
        with contextlib.suppress(Exception):
            store.delete(record)
        BackupRecord.objects.filter(pk=record.pk).update(status='FAILED', verified=False,
                                                         error_summary=message, completed_at=timezone.now())
        record.refresh_from_db()
        log_event('BACKUP_FAILED', 'BACKUP', f'Backup {record.backup_identifier} failed',
                  actor_name=record.initiated_by_name, severity='ERROR',
                  details={'backup_id': str(record.pk), 'error': message})
    finally:
        with contextlib.suppress(OSError):
            os.remove(tmp)
    return record


# ---- uploaded archives -------------------------------------------------------------------------

def import_upload(uploaded, *, user, request=None):
    """Validate an uploaded archive and keep it as an UPLOADED backup (ready to restore).
    Raises archive.BackupError with an operator-safe message."""
    limit = int(getattr(settings, 'BACKUP_MAX_UPLOAD_MB', 1024)) * 1024 * 1024
    if uploaded.size > limit:
        raise archive.BackupError(f'The file is larger than the {limit // (1024 * 1024)} MB upload limit.')
    tmp = storage.new_temp_path()
    try:
        with open(tmp, 'wb') as out:
            for chunk in uploaded.chunks():
                out.write(chunk)
        checksum = _sha256(tmp)
        result = archive.validate_archive(tmp)
        manifest = result['manifest']
        duplicate = BackupRecord.objects.filter(checksum=checksum, status='SUCCESS').first()
        if duplicate:
            return duplicate, result, True
        record = _new_record('UPLOADED', user)
        store = storage.store_for(record)
        try:
            store.save(record, tmp)
        except Exception:
            store.delete(record)
            record.delete()
            raise
        summary = archive.manifest_summary(manifest)
        summary['original_filename'] = os.path.basename(uploaded.name or '')[:200]
        BackupRecord.objects.filter(pk=record.pk).update(
            status='SUCCESS', verified=True, file_size=os.path.getsize(tmp), checksum=checksum,
            manifest=summary, started_at=record.created_at, completed_at=timezone.now())
        record.refresh_from_db()
        log_event('BACKUP_UPLOADED', 'BACKUP', f'Backup file "{summary["original_filename"]}" uploaded and '
                  f'validated as {record.backup_identifier}', request=request, user=user,
                  details={'backup_id': str(record.pk), 'source_identifier': manifest.get('backup_identifier'),
                           'size': record.file_size})
        return record, result, False
    finally:
        with contextlib.suppress(OSError):
            os.remove(tmp)


# ---- deleting / retention ----------------------------------------------------------------------

def _available():
    return BackupRecord.objects.filter(status='SUCCESS', verified=True)


def deletion_blocker(record):
    """Why `record` may not be deleted, else ''."""
    if record.status in ('QUEUED', 'RUNNING'):
        return 'This backup is still being created.'
    if record.status == 'DELETED':
        return 'This backup has already been deleted.'
    if RestoreJob.objects.filter(backup=record, status__in=('QUEUED', 'RUNNING')).exists():
        return 'This backup is being restored.'
    if record.available and not _available().exclude(pk=record.pk).exists():
        return 'This is the only verified backup — create another before deleting it.'
    return ''


def _purge(record, actor_name, event, request=None, user=None):
    with contextlib.suppress(Exception):
        storage.store_for(record).delete(record)
    BackupRecord.objects.filter(pk=record.pk).update(status='DELETED', deleted_at=timezone.now(),
                                                     deleted_by_name=actor_name[:150])
    log_event(event, 'BACKUP', f'Backup {record.backup_identifier} deleted'
              + (' by the retention policy' if event == 'BACKUP_RETENTION_DELETED' else ''),
              request=request, user=user, actor_name=actor_name,
              details={'backup_id': str(record.pk), 'filename': record.filename, 'size': record.file_size})


def delete_backup(record, *, user, request=None):
    reason = deletion_blocker(record)
    if reason:
        raise archive.BackupError(reason)
    _purge(record, getattr(user, 'username', ''), 'BACKUP_DELETED', request=request, user=user)


def apply_retention():
    """Keep the newest `retention_count` automatic backups. Never removes the newest verified
    backup of any kind, nor one being restored. Returns the number deleted."""
    keep = BackupSchedule.load().retention_count
    newest = _available().order_by('-created_at').values_list('pk', flat=True).first()
    in_use = set(RestoreJob.objects.filter(status__in=('QUEUED', 'RUNNING')).values_list('backup_id', flat=True))
    deleted = 0
    for record in _available().filter(backup_type='SCHEDULED').order_by('-created_at')[keep:]:
        if record.pk == newest or record.pk in in_use:
            continue
        _purge(record, 'Retention policy', 'BACKUP_RETENTION_DELETED')
        deleted += 1
    return deleted


# ---- restore -----------------------------------------------------------------------------------

def start_restore(record, *, user, request=None, keep_session=None):
    """Queue a restore. `keep_session` (the operator's sign-in) survives the sign-out-everyone at the
    end, so the operator's screen can still read the result."""
    recover_stale()
    if not record.available:
        raise archive.BackupError('Only a successful, verified backup can be restored.')
    if not storage.store_for(record).exists(record):
        raise archive.BackupError('The backup file is missing from storage.')
    job = RestoreJob.objects.create(backup=record, initiated_by_id=user.pk, initiated_by_name=user.username[:150])
    holder = f'restore:{job.pk}'
    if not _acquire(holder):
        job.delete()
        raise BackupBusy('Another backup or restore is already running. Try again when it finishes.')
    log_event('RESTORE_REQUESTED', 'RESTORE', f'Restore from {record.backup_identifier} requested',
              request=request, user=user, severity='WARNING',
              details={'job_id': str(job.pk), 'backup_id': str(record.pk), 'filename': record.filename})
    _spawn(_run_restore_job, job.pk, holder, keep_session)
    job.refresh_from_db()
    return job


def _stage(job, stage, **extra):
    RestoreJob.objects.filter(pk=job.pk).update(stage=stage, heartbeat_at=timezone.now(), **extra)


def _run_restore_job(job_id, holder, keep_session=None):
    job = RestoreJob.objects.select_related('backup').get(pk=job_id)
    record = job.backup
    try:
        _stage(job, 'VALIDATING', status='RUNNING', started_at=timezone.now())
        with _Heartbeat(RestoreJob, job.pk, holder):
            with storage.store_for(record).materialize(record) as path:
                if record.checksum and _sha256(path) != record.checksum:
                    raise archive.BackupError('The backup file failed its integrity check.')
                validation = archive.validate_archive(path)

                # A verified safety copy of the current data comes first — no copy, no restore.
                _stage(job, 'SAFETY_BACKUP')
                safety = _new_record('PRE_RESTORE', actor_name=job.initiated_by_name)
                RestoreJob.objects.filter(pk=job.pk).update(pre_restore_backup=safety)
                _produce(safety, holder)
                if not safety.available:
                    raise archive.BackupError('The safety backup of the current data failed, so nothing was '
                                              f'restored. ({safety.error_summary})')

                _stage(job, 'RESTORING')
                _maintenance.set()
                try:
                    counts = archive.restore_archive(path)
                finally:
                    _maintenance.clear()

        _stage(job, 'FINALIZING')
        _after_restore(keep_session)
        result = {'tables': counts['tables'], 'rows': counts['rows'], 'warnings': validation['warnings'],
                  'source_created_at': validation['manifest'].get('created_at')}
        RestoreJob.objects.filter(pk=job.pk).update(status='SUCCESS', stage='DONE', result=result,
                                                    completed_at=timezone.now())
        log_event('RESTORE_COMPLETED', 'RESTORE',
                  f'Database restored from {record.backup_identifier} ({counts["rows"]} rows)',
                  actor_name=job.initiated_by_name, severity='WARNING',
                  details={'job_id': str(job.pk), 'backup_id': str(record.pk), 'filename': record.filename,
                           'safety_backup_id': str(safety.pk), **result})
    except Exception as exc:  # noqa: BLE001
        message = _safe_error(exc, f'restore {job.pk}')
        RestoreJob.objects.filter(pk=job.pk).update(status='FAILED', error_summary=message,
                                                    completed_at=timezone.now())
        log_event('RESTORE_FAILED', 'RESTORE', f'Restore from {record.backup_identifier} failed — no data was changed',
                  actor_name=job.initiated_by_name, severity='ERROR',
                  details={'job_id': str(job.pk), 'backup_id': str(record.pk), 'error': message})
    finally:
        _release(holder)


def _after_restore(keep_session=None):
    """Bring caches and bookkeeping in line with the restored data, and sign everyone out (the
    restored user table may differ from the one their sessions were issued against)."""
    from django.apps import apps
    from django.contrib.auth.management import create_permissions
    from django.contrib.contenttypes.management import create_contenttypes
    from django.contrib.contenttypes.models import ContentType

    from apps.common import hot_cache
    from ..policy import end_all_sessions

    ContentType.objects.clear_cache()
    for app_config in apps.get_app_configs():
        with contextlib.suppress(Exception):
            create_contenttypes(app_config, verbosity=0)
            create_permissions(app_config, verbosity=0)
    hot_cache.clear()
    end_all_sessions('RESTORE', except_sid=keep_session)


# ---- stale-job recovery & health ---------------------------------------------------------------

def recover_stale():
    """Fail jobs whose process died (no heartbeat for STALE_AFTER) and free their lock."""
    cutoff = timezone.now() - STALE_AFTER
    with _active_lock:
        live = set(_active)
    live_backups = {h.split(':', 1)[1] for h in live if h.startswith('backup:')}
    live_restores = {h.split(':', 1)[1] for h in live if h.startswith('restore:')}
    stale = Q(heartbeat_at__lt=cutoff) | Q(heartbeat_at__isnull=True, created_at__lt=cutoff)
    try:
        for record in BackupRecord.objects.filter(stale, status__in=('QUEUED', 'RUNNING')):
            if str(record.pk) in live_backups:
                continue
            if BackupRecord.objects.filter(pk=record.pk, status__in=('QUEUED', 'RUNNING')).update(
                    status='FAILED', completed_at=timezone.now(),
                    error_summary='Interrupted — the server restarted before the backup finished.'):
                with contextlib.suppress(Exception):
                    storage.store_for(record).delete(record)
                log_event('BACKUP_FAILED', 'BACKUP', f'Backup {record.backup_identifier} was interrupted',
                          actor_name=record.initiated_by_name, severity='ERROR',
                          details={'backup_id': str(record.pk), 'error': 'interrupted'})
        for job in RestoreJob.objects.filter(stale, status__in=('QUEUED', 'RUNNING')):
            if str(job.pk) in live_restores:
                continue
            if RestoreJob.objects.filter(pk=job.pk, status__in=('QUEUED', 'RUNNING')).update(
                    status='FAILED', completed_at=timezone.now(),
                    error_summary='Interrupted — the server restarted during the restore. The restore runs in '
                                  'a single transaction, so no data was changed.'):
                log_event('RESTORE_FAILED', 'RESTORE', 'A restore was interrupted — no data was changed',
                          actor_name=job.initiated_by_name, severity='ERROR', details={'job_id': str(job.pk)})
        OperationLock.objects.filter(name=LOCK_NAME).exclude(holder='').filter(
            Q(heartbeat_at__lt=cutoff) | Q(heartbeat_at__isnull=True)).exclude(holder__in=live).update(
            holder='', heartbeat_at=None)
    except Exception:  # pragma: no cover - never break the status endpoints over housekeeping
        logger.exception('Backup stale-job recovery failed')


def storage_used_bytes():
    return _available().aggregate(total=Sum('file_size'))['total'] or 0


def expected_interval(schedule):
    if schedule.enabled:
        return {'DAILY': timedelta(days=1), 'WEEKLY': timedelta(days=7), 'MONTHLY': timedelta(days=31)}[schedule.frequency]
    return timedelta(days=7)


def health():
    recover_stale()
    schedule = BackupSchedule.load()
    now = timezone.now()
    # An uploaded archive is a copy of some other moment's data, not a backup of this system.
    last_success = _available().exclude(backup_type='UPLOADED').order_by('-completed_at').first()
    last_finished = (BackupRecord.objects.filter(status__in=('SUCCESS', 'FAILED'))
                     .exclude(backup_type='UPLOADED').order_by('-completed_at').first())
    running = BackupRecord.objects.filter(status__in=('QUEUED', 'RUNNING')).order_by('-created_at').first()
    restoring = RestoreJob.objects.filter(status__in=('QUEUED', 'RUNNING')).order_by('-created_at').first()
    used = storage_used_bytes()
    capacity = storage.capacity_bytes()
    percent = round(used * 100 / capacity, 1) if capacity else 0

    warnings = []
    if last_success is None:
        state, message = 'none', 'No backup available yet'
    elif last_finished and last_finished.status == 'FAILED':
        state, message = 'failed', 'The last backup failed'
    else:
        state, message = 'healthy', 'Your data is safe'
        if now - last_success.completed_at > expected_interval(schedule) * 1.5:
            warnings.append('The last successful backup is older than expected.')
        if not schedule.enabled:
            warnings.append('Automatic backups are turned off.')
    if percent >= 90:
        warnings.append('Backup storage is almost full.' if percent < 100 else 'Backup storage is over capacity.')
    eph = storage.ephemeral_warning()
    if eph:
        warnings.append(eph)
    if state == 'healthy' and warnings:
        state, message = 'warning', 'Backups need attention'

    return {
        'status': state,
        'message': message,
        'protected': state in ('healthy', 'warning'),
        'warnings': warnings,
        'last_successful': record_summary(last_success),
        'last_backup': record_summary(last_finished),
        'next_scheduled_at': schedule.next_run_at.isoformat() if schedule.enabled and schedule.next_run_at else None,
        'schedule_enabled': schedule.enabled,
        'storage': {'used_bytes': used, 'capacity_bytes': capacity, 'percent': percent,
                    'location': storage.configured_store().location,
                    'location_label': storage.configured_store().label},
        'running_backup': record_summary(running),
        'running_restore': restore_summary(restoring),
        'total_backups': _available().count(),
        'timezone': _business_tz_name(),
        'max_upload_bytes': int(getattr(settings, 'BACKUP_MAX_UPLOAD_MB', 1024)) * 1024 * 1024,
    }


def _business_tz_name():
    from .scheduler import business_timezone
    return business_timezone()[0]


def record_summary(record, *, detail=False):
    if record is None:
        return None
    out = {
        'id': str(record.pk), 'backup_identifier': record.backup_identifier, 'filename': record.filename,
        'backup_type': record.backup_type, 'backup_type_label': record.get_backup_type_display(),
        'storage_location': record.storage_location, 'file_size': record.file_size, 'status': record.status,
        'status_label': record.get_status_display(), 'verified': record.verified,
        'created_at': record.created_at.isoformat(),
        'completed_at': record.completed_at.isoformat() if record.completed_at else None,
        'initiated_by': record.initiated_by_name, 'error_summary': record.error_summary,
        'can_delete': not deletion_blocker(record) if detail else None,
    }
    if detail:
        out.update({'checksum': record.checksum, 'manifest': record.manifest,
                    'started_at': record.started_at.isoformat() if record.started_at else None,
                    'deleted_at': record.deleted_at.isoformat() if record.deleted_at else None,
                    'deleted_by': record.deleted_by_name, 'delete_blocker': deletion_blocker(record)})
    return out


def restore_summary(job):
    if job is None:
        return None
    return {
        'id': str(job.pk), 'status': job.status, 'stage': job.stage, 'stage_label': job.get_stage_display(),
        'backup_id': str(job.backup_id), 'backup_identifier': job.backup.backup_identifier,
        'pre_restore_backup_id': str(job.pre_restore_backup_id) if job.pre_restore_backup_id else None,
        'result': job.result, 'error_summary': job.error_summary, 'initiated_by': job.initiated_by_name,
        'created_at': job.created_at.isoformat(),
        'completed_at': job.completed_at.isoformat() if job.completed_at else None,
    }
