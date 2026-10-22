import datetime
import io
import json
import shutil
import tempfile
import zipfile
import zoneinfo
from unittest import mock

from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase, override_settings
from django.utils import timezone
from rest_framework.test import APIClient

from apps.masters.models import ProductCategory
from apps.security import middleware as maintenance
from apps.security.backup import archive, scheduler, service, storage
from apps.security.models import (AuthSession, BackupChunk, BackupRecord, BackupSchedule, OperationLock,
                                  RestoreJob, SecurityAuditLog)

User = get_user_model()
PASSWORD = 'Str0ng-pass!'


class BackupTestBase(TestCase):
    def setUp(self):
        cache.clear()
        self.tmp = tempfile.mkdtemp(prefix='erp-backup-test-')
        self.override = override_settings(BACKUP_DIR=self.tmp, BACKUP_STORAGE='filesystem')
        self.override.enable()
        self.owner = User.objects.create_user('owner', 'owner@example.com', PASSWORD, role='SUPER_ADMIN')
        self.admin = User.objects.create_user('admin2', 'a2@example.com', PASSWORD, role='ADMINISTRATOR')
        self.client = APIClient()
        self.client.force_authenticate(self.owner)

    def tearDown(self):
        self.override.disable()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def create_backup(self, kind='MANUAL'):
        record = service.start_backup(kind, user=self.owner, run_async=False)
        self.assertEqual(record.status, 'SUCCESS', record.error_summary)
        return record

    def archive_bytes(self, record):
        return b''.join(storage.store_for(record).iter_bytes(record))

    def upload(self, data, name='backup.zip'):
        return self.client.post('/api/backups/upload/', {'file': SimpleUploadedFile(name, data)}, format='multipart')


def rewrite_archive(data, mutate):
    """Rebuild an archive after `mutate(entries: dict[name, bytes])`, re-hashing the manifest."""
    import hashlib
    src = zipfile.ZipFile(io.BytesIO(data))
    entries = {n: src.read(n) for n in src.namelist()}
    manifest = json.loads(entries.pop('manifest.json'))
    mutate(entries)
    for name, body in entries.items():
        manifest['entries'][name]['sha256'] = hashlib.sha256(body).hexdigest()
        manifest['entries'][name]['rows'] = body.count(b'\n') - 1
    out = io.BytesIO()
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as zf:
        for name, body in entries.items():
            zf.writestr(name, body)
        zf.writestr('manifest.json', json.dumps(manifest))
    return out.getvalue()


class BackupCreationTests(BackupTestBase):
    def test_manual_backup_is_created_verified_and_audited(self):
        ProductCategory.objects.create(name='Frames', code='FRAMES')
        res = self.client.post('/api/backups/create/')
        self.assertEqual(res.status_code, 202, res.data)
        record = BackupRecord.objects.get(pk=res.data['id'])
        self.assertEqual(record.status, 'SUCCESS')
        self.assertTrue(record.verified)
        self.assertEqual(len(record.checksum), 64)
        self.assertGreater(record.file_size, 0)
        self.assertTrue(storage.store_for(record).exists(record))
        self.assertGreaterEqual(record.manifest['total_rows'], 1)

        with zipfile.ZipFile(io.BytesIO(self.archive_bytes(record))) as zf:
            names = set(zf.namelist())
            self.assertIn('data/masters.productcategory.jsonl', names)
            self.assertFalse(any(n.startswith('data/security.') for n in names))
            self.assertFalse(any(n.startswith('data/sessions.') for n in names))
        events = set(SecurityAuditLog.objects.values_list('event', flat=True))
        self.assertTrue({'BACKUP_REQUESTED', 'BACKUP_COMPLETED'} <= events)

    def test_failure_is_recorded_and_shown_in_health(self):
        self.create_backup()
        with mock.patch.object(archive, 'write_archive', side_effect=RuntimeError('disk exploded at /secret/path')):
            res = self.client.post('/api/backups/create/')
        record = BackupRecord.objects.get(pk=res.data['id'])
        self.assertEqual(record.status, 'FAILED')
        self.assertNotIn('/secret/path', record.error_summary)  # no server internals leak to the screen
        self.assertTrue(SecurityAuditLog.objects.filter(event='BACKUP_FAILED').exists())
        health = self.client.get('/api/backups/health/').data
        self.assertEqual(health['status'], 'failed')
        self.assertIsNotNone(health['last_successful'])
        self.assertEqual(OperationLock.objects.get(name='DATA').holder, '')  # lock released

    def test_concurrent_backup_is_refused(self):
        OperationLock.objects.create(name='DATA', holder='backup:other', heartbeat_at=timezone.now())
        res = self.client.post('/api/backups/create/')
        self.assertEqual(res.status_code, 409)
        self.assertFalse(BackupRecord.objects.exists())

    def test_stale_lock_and_job_are_recovered(self):
        old = timezone.now() - datetime.timedelta(minutes=10)
        stuck = BackupRecord.objects.create(backup_identifier='BKP-STUCK', filename='x.zip', backup_type='MANUAL',
                                            storage_location='FILESYSTEM', status='RUNNING', heartbeat_at=old)
        OperationLock.objects.create(name='DATA', holder=f'backup:{stuck.pk}', heartbeat_at=old)
        res = self.client.post('/api/backups/create/')
        self.assertEqual(res.status_code, 202)
        stuck.refresh_from_db()
        self.assertEqual(stuck.status, 'FAILED')

    def test_health_without_backups(self):
        health = self.client.get('/api/backups/health/').data
        self.assertEqual(health['status'], 'none')
        self.assertEqual(health['message'], 'No backup available yet')
        self.assertIsNone(health['last_successful'])
        self.assertEqual(health['storage']['used_bytes'], 0)

    def test_health_reports_real_storage(self):
        record = self.create_backup()
        health = self.client.get('/api/backups/health/').data
        self.assertEqual(health['storage']['used_bytes'], record.file_size)
        self.assertEqual(health['last_successful']['id'], str(record.pk))
        self.assertEqual(health['status'], 'warning')  # automatic backups are off
        self.assertIn('Automatic backups are turned off.', health['warnings'])

    def test_permissions(self):
        self.client.force_authenticate(self.admin)
        self.assertEqual(self.client.post('/api/backups/create/').status_code, 202)
        record = BackupRecord.objects.get()
        self.assertEqual(self.client.delete(f'/api/backups/{record.pk}/').status_code, 403)
        self.assertEqual(self.client.post('/api/backups/restore/', {}, format='json').status_code, 403)
        self.assertEqual(self.upload(b'x').status_code, 403)
        cashier = User.objects.create_user('cashier', None, PASSWORD, role='CASHIER')
        self.client.force_authenticate(cashier)
        self.assertEqual(self.client.get('/api/backups/health/').status_code, 403)
        self.assertEqual(self.client.post('/api/backups/create/').status_code, 403)

    def test_history_filters_and_pagination(self):
        self.create_backup('MANUAL')
        self.create_backup('SCHEDULED')
        res = self.client.get('/api/backups/history/?type=SCHEDULED')
        self.assertEqual(res.data['count'], 1)
        self.assertEqual(res.data['results'][0]['backup_type_label'], 'Automatic')
        res = self.client.get('/api/backups/history/?page_size=1')
        self.assertEqual(res.data['count'], 2)
        self.assertEqual(len(res.data['results']), 1)
        res = self.client.get('/api/backups/history/?status=FAILED')
        self.assertEqual(res.data['count'], 0)

    @override_settings(BACKUP_STORAGE='database')
    def test_database_storage(self):
        record = self.create_backup()
        self.assertEqual(record.storage_location, 'DATABASE')
        self.assertTrue(BackupChunk.objects.filter(record=record).exists())
        with storage.store_for(record).materialize(record) as path:
            archive.validate_archive(path)


class DownloadTests(BackupTestBase):
    def test_signed_link_streams_the_archive(self):
        record = self.create_backup()
        link = self.client.post(f'/api/backups/{record.pk}/download-link/').data
        anonymous = APIClient()
        res = anonymous.get(link['url'])
        self.assertEqual(res.status_code, 200)
        self.assertEqual(b''.join(res.streaming_content), self.archive_bytes(record))
        self.assertIn(record.filename, res['Content-Disposition'])
        self.assertTrue(SecurityAuditLog.objects.filter(event='BACKUP_DOWNLOADED').exists())

    def test_unauthorized_downloads_are_refused(self):
        record = self.create_backup()
        anonymous = APIClient()
        self.assertEqual(anonymous.get(f'/api/backups/{record.pk}/download/').status_code, 403)
        self.assertEqual(anonymous.get(f'/api/backups/{record.pk}/download/?token=forged').status_code, 403)
        other = self.create_backup()
        link = self.client.post(f'/api/backups/{record.pk}/download-link/').data
        self.assertEqual(anonymous.get(link['url'].replace(str(record.pk), str(other.pk))).status_code, 403)
        # A link minted for someone who has since lost the role stops working.
        self.client.force_authenticate(self.admin)
        link = self.client.post(f'/api/backups/{record.pk}/download-link/').data
        User.objects.filter(pk=self.admin.pk).update(role='CASHIER')
        self.assertEqual(anonymous.get(link['url']).status_code, 403)
        # Expired.
        self.client.force_authenticate(self.owner)
        link = self.client.post(f'/api/backups/{record.pk}/download-link/').data
        with mock.patch('django.core.signing.time.time', return_value=timezone.now().timestamp() + 600):
            self.assertEqual(anonymous.get(link['url']).status_code, 403)


class UploadValidationTests(BackupTestBase):
    def test_rejects_non_zip(self):
        res = self.upload(b'DROP TABLE users;', name='evil.zip')
        self.assertEqual(res.status_code, 400)
        self.assertIn('file', res.data['errors'])

    def test_rejects_wrong_extension(self):
        self.assertEqual(self.upload(b'x', name='backup.sql').status_code, 400)

    def test_rejects_path_traversal_entries(self):
        out = io.BytesIO()
        with zipfile.ZipFile(out, 'w') as zf:
            zf.writestr('manifest.json', '{}')
            zf.writestr('../../etc/cron.d/evil', 'x')
        res = self.upload(out.getvalue())
        self.assertEqual(res.status_code, 400)
        self.assertIn('unexpected files', res.data['detail'])

    def test_rejects_foreign_manifest(self):
        out = io.BytesIO()
        with zipfile.ZipFile(out, 'w') as zf:
            zf.writestr('manifest.json', json.dumps({'format': 'something-else'}))
        self.assertEqual(self.upload(out.getvalue()).status_code, 400)

    def test_rejects_tampered_entry(self):
        data = self.archive_bytes(self.create_backup())
        src = zipfile.ZipFile(io.BytesIO(data))
        out = io.BytesIO()
        with zipfile.ZipFile(out, 'w') as zf:
            for name in src.namelist():
                body = src.read(name)
                if name == 'data/authentication.user.jsonl':
                    body += b'["tampered"]\n'
                zf.writestr(name, body)
        res = self.upload(out.getvalue())
        self.assertEqual(res.status_code, 400)
        self.assertIn('integrity', res.data['detail'])

    def test_rejects_backup_from_newer_version(self):
        data = self.archive_bytes(self.create_backup())

        def add_future_migration(entries):
            pass
        rebuilt = rewrite_archive(data, add_future_migration)
        src = zipfile.ZipFile(io.BytesIO(rebuilt))
        manifest = json.loads(src.read('manifest.json'))
        manifest['migrations']['masters'].append('9999_from_the_future')
        out = io.BytesIO()
        with zipfile.ZipFile(out, 'w') as zf:
            for name in src.namelist():
                zf.writestr(name, json.dumps(manifest) if name == 'manifest.json' else src.read(name))
        res = self.upload(out.getvalue())
        self.assertEqual(res.status_code, 400)
        self.assertIn('newer version', res.data['detail'])

    def test_accepts_valid_archive(self):
        record = self.create_backup()
        data = self.archive_bytes(record)
        # Same file again is recognised rather than stored twice.
        res = self.upload(data)
        self.assertEqual(res.status_code, 201)
        self.assertTrue(res.data['duplicate'])
        # As if it came from another machine.
        storage.store_for(record).delete(record)
        BackupRecord.objects.all().delete()
        res = self.upload(data, name='from-shop-pc.zip')
        self.assertEqual(res.status_code, 201, res.data)
        self.assertFalse(res.data['duplicate'])
        self.assertEqual(res.data['backup']['backup_type'], 'UPLOADED')
        self.assertEqual(res.data['compatibility'], 'same')
        self.assertEqual(res.data['source']['backup_identifier'], record.backup_identifier)


class RestoreTests(BackupTestBase):
    def restore(self, record, **overrides):
        body = {'backup_id': str(record.pk), 'password': PASSWORD, 'confirmation': 'RESTORE', **overrides}
        return self.client.post('/api/backups/restore/', body, format='json')

    def test_restore_brings_data_back_and_keeps_a_safety_copy(self):
        ProductCategory.objects.create(name='Before', code='BEFORE')
        record = self.create_backup()
        ProductCategory.objects.filter(name='Before').delete()
        ProductCategory.objects.create(name='After', code='AFTER')
        session = AuthSession.objects.create(user_id=self.owner.pk, username='owner')

        res = self.restore(record)
        self.assertEqual(res.status_code, 202, res.data)
        job = RestoreJob.objects.get(pk=res.data['id'])
        self.assertEqual(job.status, 'SUCCESS', job.error_summary)
        names = set(ProductCategory.all_objects.values_list('name', flat=True))
        self.assertIn('Before', names)
        self.assertNotIn('After', names)

        safety = job.pre_restore_backup
        self.assertEqual(safety.backup_type, 'PRE_RESTORE')
        self.assertTrue(safety.available)
        session.refresh_from_db()
        self.assertEqual(session.end_reason, 'RESTORE')
        self.assertTrue(SecurityAuditLog.objects.filter(event='RESTORE_COMPLETED').exists())
        status_res = self.client.get(f'/api/backups/restore/{job.pk}/')
        self.assertEqual(status_res.data['status'], 'SUCCESS')

    def test_restore_needs_password_and_confirmation(self):
        record = self.create_backup()
        res = self.restore(record, password='wrong', confirmation='yes')
        self.assertEqual(res.status_code, 400)
        self.assertEqual(set(res.data['errors']), {'password', 'confirmation'})
        self.assertFalse(RestoreJob.objects.exists())

    def test_failed_restore_changes_nothing(self):
        ProductCategory.objects.create(name='Current', code='CURRENT')
        data = self.archive_bytes(self.create_backup())

        def break_foreign_key(entries):
            name = 'data/auth.permission.jsonl'
            lines = entries[name].split(b'\n')
            header = json.loads(lines[0])
            row = json.loads(lines[1])
            row[header['fields'].index('content_type_id')] = 987654321
            lines[1] = json.dumps(row).encode()
            entries[name] = b'\n'.join(lines)
        broken = rewrite_archive(data, break_foreign_key)
        BackupRecord.objects.all().delete()  # so the upload is not a duplicate
        uploaded = self.upload(broken)
        self.assertEqual(uploaded.status_code, 201, uploaded.data)
        ProductCategory.objects.create(name='Added later', code='ADDED_LATER')

        res = self.client.post('/api/backups/restore/', {'backup_id': uploaded.data['backup']['id'], 'password': PASSWORD,
                                                         'confirmation': 'RESTORE'}, format='json')
        job = RestoreJob.objects.get(pk=res.data['id'])
        self.assertEqual(job.status, 'FAILED')
        self.assertIn('Added later', set(ProductCategory.objects.values_list('name', flat=True)))
        self.assertTrue(SecurityAuditLog.objects.filter(event='RESTORE_FAILED').exists())

    def test_only_available_backups_can_be_restored(self):
        record = self.create_backup()
        BackupRecord.objects.filter(pk=record.pk).update(status='FAILED')
        self.assertEqual(self.restore(record).status_code, 400)

    def test_writes_are_paused_during_a_restore(self):
        OperationLock.objects.create(name='DATA', holder='restore:abc', heartbeat_at=timezone.now())
        maintenance._cached = (0.0, False)
        res = self.client.post('/api/masters/categories/', {'name': 'x'}, format='json')
        self.assertEqual(res.status_code, 423)
        self.assertEqual(res.json()['code'], 'maintenance')
        self.assertEqual(self.client.get('/api/backups/health/').status_code, 200)
        maintenance._cached = (0.0, False)


class DeleteAndRetentionTests(BackupTestBase):
    def test_only_backup_cannot_be_deleted(self):
        record = self.create_backup()
        res = self.client.delete(f'/api/backups/{record.pk}/')
        self.assertEqual(res.status_code, 409)
        self.assertIn('only verified backup', res.data['detail'])

    def test_delete_purges_file_and_keeps_history(self):
        first = self.create_backup()
        self.create_backup()
        res = self.client.delete(f'/api/backups/{first.pk}/')
        self.assertEqual(res.status_code, 200, res.data)
        first.refresh_from_db()
        self.assertEqual(first.status, 'DELETED')
        self.assertFalse(storage.store_for(first).exists(first))
        self.assertTrue(SecurityAuditLog.objects.filter(event='BACKUP_DELETED').exists())

    def test_backup_being_restored_cannot_be_deleted(self):
        record = self.create_backup()
        self.create_backup()
        RestoreJob.objects.create(backup=record, status='RUNNING', heartbeat_at=timezone.now())
        self.assertEqual(self.client.delete(f'/api/backups/{record.pk}/').status_code, 409)

    def test_retention_keeps_newest_scheduled_backups(self):
        BackupSchedule.objects.update_or_create(pk=1, defaults={'retention_count': 2})
        manual = self.create_backup('MANUAL')
        scheduled = [self.create_backup('SCHEDULED') for _ in range(4)]
        for i, rec in enumerate([manual] + scheduled):  # distinct, ordered creation times
            BackupRecord.objects.filter(pk=rec.pk).update(created_at=timezone.now() - datetime.timedelta(hours=10 - i))
        self.assertEqual(service.apply_retention(), 2)
        alive = set(BackupRecord.objects.filter(status='SUCCESS').values_list('pk', flat=True))
        self.assertEqual(alive, {manual.pk, scheduled[2].pk, scheduled[3].pk})
        self.assertEqual(SecurityAuditLog.objects.filter(event='BACKUP_RETENTION_DELETED').count(), 2)


class ScheduleTests(BackupTestBase):
    tz = zoneinfo.ZoneInfo('Asia/Kolkata')

    def schedule(self, **values):
        s = BackupSchedule.load()
        for k, v in values.items():
            setattr(s, k, v)
        return s

    def test_next_run_daily_weekly_monthly(self):
        after = datetime.datetime(2026, 10, 22, 10, 0, tzinfo=self.tz)  # a Thursday
        daily = scheduler.compute_next_run(self.schedule(frequency='DAILY', backup_time=datetime.time(2, 0)), after, self.tz)
        self.assertEqual(daily.astimezone(self.tz), datetime.datetime(2026, 10, 23, 2, 0, tzinfo=self.tz))
        later = scheduler.compute_next_run(self.schedule(frequency='DAILY', backup_time=datetime.time(23, 30)), after, self.tz)
        self.assertEqual(later.astimezone(self.tz), datetime.datetime(2026, 10, 22, 23, 30, tzinfo=self.tz))
        weekly = scheduler.compute_next_run(self.schedule(frequency='WEEKLY', weekday=6,
                                                          backup_time=datetime.time(1, 0)), after, self.tz)
        self.assertEqual(weekly.astimezone(self.tz), datetime.datetime(2026, 10, 25, 1, 0, tzinfo=self.tz))
        monthly = scheduler.compute_next_run(self.schedule(frequency='MONTHLY', day_of_month=5,
                                                           backup_time=datetime.time(3, 0)), after, self.tz)
        self.assertEqual(monthly.astimezone(self.tz), datetime.datetime(2026, 11, 5, 3, 0, tzinfo=self.tz))
        december = datetime.datetime(2026, 12, 20, 10, 0, tzinfo=self.tz)
        rollover = scheduler.compute_next_run(self.schedule(frequency='MONTHLY', day_of_month=5,
                                                            backup_time=datetime.time(3, 0)), december, self.tz)
        self.assertEqual(rollover.astimezone(self.tz), datetime.datetime(2027, 1, 5, 3, 0, tzinfo=self.tz))

    def test_save_schedule_validates_audits_and_computes_next_run(self):
        res = self.client.put('/api/backups/schedule/', {'enabled': True, 'frequency': 'HOURLY', 'backup_time': '25:00',
                                                         'retention_count': 0}, format='json')
        self.assertEqual(res.status_code, 400)
        self.assertEqual(set(res.data['errors']), {'frequency', 'backup_time', 'retention_count'})

        version = self.client.get('/api/backups/schedule/').data['version']
        res = self.client.put('/api/backups/schedule/', {'enabled': True, 'frequency': 'WEEKLY', 'backup_time': '01:30',
                                                         'weekday': 2, 'retention_count': 30, 'version': version},
                              format='json')
        self.assertEqual(res.status_code, 200, res.data)
        self.assertIsNotNone(res.data['next_run_at'])
        self.assertGreater(datetime.datetime.fromisoformat(res.data['next_run_at']), timezone.now())
        self.assertTrue(SecurityAuditLog.objects.filter(event='BACKUP_SCHEDULE_UPDATED').exists())
        stale = self.client.put('/api/backups/schedule/', {'retention_count': 7, 'version': version}, format='json')
        self.assertEqual(stale.status_code, 409)

    def test_due_schedule_runs_once_and_applies_retention(self):
        BackupSchedule.objects.update_or_create(pk=1, defaults={
            'enabled': True, 'retention_count': 1, 'timezone': scheduler.business_timezone()[0],
            'next_run_at': timezone.now() - datetime.timedelta(minutes=1)})
        old = self.create_backup('SCHEDULED')
        BackupRecord.objects.filter(pk=old.pk).update(created_at=timezone.now() - datetime.timedelta(days=1))
        record = scheduler.run_due()
        self.assertIsNotNone(record)
        self.assertEqual(record.backup_type, 'SCHEDULED')
        self.assertEqual(record.status, 'SUCCESS')
        s = BackupSchedule.load()
        self.assertGreater(s.next_run_at, timezone.now())
        self.assertEqual(s.last_run_status, 'SUCCESS')
        self.assertIsNone(scheduler.run_due())  # not due again
        old.refresh_from_db()
        self.assertEqual(old.status, 'DELETED')  # retention 1

    def test_disabled_schedule_never_runs(self):
        BackupSchedule.objects.update_or_create(pk=1, defaults={
            'enabled': False, 'next_run_at': timezone.now() - datetime.timedelta(minutes=1)})
        self.assertIsNone(scheduler.run_due())
        self.assertFalse(BackupRecord.objects.exists())
