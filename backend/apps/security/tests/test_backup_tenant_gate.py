"""P1 Task 3 — whole-database backup / restore isolation, enforced in the service layer.

Interim rule (until D1/P2): whole-database backup, upload and restore only while the server hosts
at most one tenant, and a restore only of this install's own customer's archive.
"""
import io
import json
import zipfile
from unittest import mock

from django.core.files.uploadedfile import SimpleUploadedFile
from django.core.management import CommandError, call_command
from django.utils import timezone

from apps.common.models import Tenant
from apps.security.backup import archive, policy, scheduler, service
from apps.security.models import BackupRecord, BackupSchedule, RestoreJob, SecurityAuditLog

from .test_backups import BackupTestBase, rewrite_archive


def _retenant(data, tenants):
    """Replace the archive's common.tenant rows with `tenants` [(id, code, name)]."""
    def mutate(entries):
        name = 'data/common.tenant.jsonl'
        lines = entries[name].decode('utf-8').splitlines()
        header = json.loads(lines[0])
        fields = header['fields']
        template = json.loads(lines[1])
        out = [lines[0]]
        for tid, code, tname in tenants:
            row = list(template)
            row[fields.index('id')] = tid
            row[fields.index('code')] = code
            row[fields.index('name')] = tname
            out.append(json.dumps(row))
        entries[name] = ('\n'.join(out) + '\n').encode('utf-8')
    return rewrite_archive(data, mutate)


class SecondTenantMixin:
    def add_second_tenant(self):
        return Tenant.objects.create(name='Other Shop', code='other-shop')


class ServiceLayerGateTests(SecondTenantMixin, BackupTestBase):
    def test_single_tenant_backup_still_works(self):
        record = self.create_backup()
        self.assertTrue(record.verified)

    def test_backup_refused_by_the_service_with_two_tenants(self):
        self.add_second_tenant()
        before = BackupRecord.objects.count()
        with self.assertRaises(policy.WholeDatabaseBlocked):
            service.start_backup('MANUAL', user=self.owner, run_async=False)
        self.assertEqual(BackupRecord.objects.count(), before)
        self.assertTrue(SecurityAuditLog.objects.filter(event='BACKUP_REFUSED').exists())

    def test_create_backup_command_refused_with_two_tenants(self):
        self.add_second_tenant()
        with self.assertRaises(CommandError):
            call_command('create_backup')
        self.assertFalse(BackupRecord.objects.filter(status='SUCCESS').exists())

    def test_produce_refuses_even_a_record_queued_directly(self):
        self.add_second_tenant()
        record = service._new_record('MANUAL', actor_name='shell')
        service._produce(record, 'test-holder')
        record.refresh_from_db()
        self.assertEqual(record.status, 'FAILED')
        self.assertFalse(record.verified)

    def test_restore_refused_by_the_service_with_two_tenants(self):
        record = self.create_backup()
        self.add_second_tenant()
        with self.assertRaises(policy.WholeDatabaseBlocked):
            service.start_restore(record, user=self.owner)
        self.assertFalse(RestoreJob.objects.exists())

    def test_restore_archive_itself_refuses_with_two_tenants(self):
        record = self.create_backup()
        data = self.archive_bytes(record)
        self.add_second_tenant()
        path = self._write_tmp(data)
        with self.assertRaises(policy.WholeDatabaseBlocked):
            archive.restore_archive(path)
        self.assertEqual(Tenant.objects.count(), 2)  # nothing was replaced

    def test_upload_refused_with_two_tenants(self):
        record = self.create_backup()
        data = self.archive_bytes(record)
        self.add_second_tenant()
        upload = SimpleUploadedFile('b.zip', data)
        with self.assertRaises(policy.WholeDatabaseBlocked):
            service.import_upload(upload, user=self.owner)

    def test_http_gate_uses_the_same_rule(self):
        self.add_second_tenant()
        res = self.client.post('/api/backups/create/')
        self.assertEqual(res.status_code, 403)

    def _write_tmp(self, data):
        import os
        import tempfile
        fd, path = tempfile.mkstemp(suffix='.zip', dir=self.tmp)
        with os.fdopen(fd, 'wb') as fh:
            fh.write(data)
        return path


class SchedulerGateTests(SecondTenantMixin, BackupTestBase):
    def _due_schedule(self):
        schedule = BackupSchedule.load()
        schedule.enabled = True
        schedule.timezone = scheduler.business_timezone()[0]  # else ensure_current re-plans it
        schedule.next_run_at = timezone.now() - timezone.timedelta(minutes=1)
        schedule.save()
        return schedule

    def test_onboarding_a_second_tenant_switches_the_schedule_off(self):
        self._due_schedule()
        self.add_second_tenant()
        schedule = BackupSchedule.load()
        self.assertFalse(schedule.enabled)
        self.assertEqual(schedule.last_run_status, 'BLOCKED')
        self.assertTrue(SecurityAuditLog.objects.filter(event='BACKUP_SCHEDULE_DISABLED').exists())

    def test_a_schedule_still_enabled_never_produces_an_all_tenant_archive(self):
        self.add_second_tenant()
        self._due_schedule()  # re-enabled behind the gate's back (e.g. raw DB edit)
        self.assertIsNone(scheduler.run_due())
        self.assertFalse(BackupRecord.objects.filter(backup_type='SCHEDULED').exists())
        self.assertFalse(BackupSchedule.load().enabled)

    def test_single_tenant_schedule_runs(self):
        self._due_schedule()
        with mock.patch.object(service, 'apply_retention', return_value=0):
            record = scheduler.run_due()
        self.assertIsNotNone(record)
        self.assertEqual(record.status, 'SUCCESS')


class ArchiveOwnershipTests(BackupTestBase):
    def _mine(self):
        return Tenant.objects.values_list('id', 'code', 'name').get()

    def test_own_archive_is_restorable(self):
        data = self.archive_bytes(self.create_backup())
        self.assertEqual(policy.archive_owner_problem(io.BytesIO(data)), '')

    def test_another_customers_archive_is_refused_at_upload(self):
        data = self.archive_bytes(self.create_backup())
        tid, code, name = self._mine()
        foreign = _retenant(data, [(tid + 40, 'someone-else', 'Someone Else Optics')])
        res = self.upload(foreign)
        self.assertEqual(res.status_code, 400, res.data)
        self.assertFalse(BackupRecord.objects.filter(backup_type='UPLOADED').exists())
        self.assertTrue(SecurityAuditLog.objects.filter(event='BACKUP_UPLOAD_REFUSED').exists())

    def test_same_id_other_code_is_refused(self):
        data = self.archive_bytes(self.create_backup())
        tid, code, name = self._mine()
        foreign = _retenant(data, [(tid, 'other-code', name)])
        self.assertIn('another business', policy.archive_owner_problem(io.BytesIO(foreign)))

    def test_generic_default_tenant_with_another_name_is_refused(self):
        Tenant.objects.filter(pk=self._mine()[0]).update(code='default', name='My Shop')
        data = self.archive_bytes(self.create_backup())
        tid, _code, _name = self._mine()
        foreign = _retenant(data, [(tid, 'default', 'Their Shop')])
        self.assertIn('another business', policy.archive_owner_problem(io.BytesIO(foreign)))

    def test_multi_tenant_archive_is_refused(self):
        data = self.archive_bytes(self.create_backup())
        tid, code, name = self._mine()
        multi = _retenant(data, [(tid, code, name), (tid + 1, 'b', 'B')])
        with self.assertRaises(policy.ForeignArchive):
            policy.assert_archive_restorable(io.BytesIO(multi))

    def test_restore_job_fails_before_safety_backup_for_foreign_archive(self):
        record = self.create_backup()
        tid, code, name = self._mine()
        foreign = _retenant(self.archive_bytes(record), [(tid + 7, 'zzz', 'Z')])
        uploaded = service._new_record('UPLOADED', self.owner)
        path = self.tmp + '/foreign.zip'
        with open(path, 'wb') as fh:
            fh.write(foreign)
        from apps.security.backup import storage
        storage.store_for(uploaded).save(uploaded, path)
        BackupRecord.objects.filter(pk=uploaded.pk).update(status='SUCCESS', verified=True, checksum='')
        uploaded.refresh_from_db()
        with mock.patch.object(service, '_spawn', side_effect=lambda fn, *a: fn(*a)):
            job = service.start_restore(uploaded, user=self.owner)
        job.refresh_from_db()
        self.assertEqual(job.status, 'FAILED')
        self.assertIsNone(job.pre_restore_backup_id)
        self.assertIn('another business', job.error_summary)

    def test_per_client_backup_unaffected_by_multi_tenant_rule(self):
        other = Tenant.objects.create(name='Other Shop', code='other-shop')
        record = service.start_client_backup(other, run_async=False)
        self.assertEqual(record.status, 'SUCCESS', record.error_summary)
        self.assertEqual(record.client_tenant_id, other.pk)
