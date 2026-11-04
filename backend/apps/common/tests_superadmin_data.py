"""Platform console: client data inspection and per-client backups (superadmin_data_views)."""
import datetime
import json
import shutil
import tempfile
import zipfile
from pathlib import Path

from django.test import override_settings
from django.utils import timezone

from apps.common import tenancy
from apps.common.models import TenantAuditLog
from apps.common.tests_superadmin import URL, SuperAdminFixture
from apps.sales.models import Customer, EyeExamination, Invoice
from apps.security.backup import scheduler
from apps.security.models import BackupRecord, TenantBackupSchedule


class ClientDataFixture(SuperAdminFixture):
    def setUp(self):
        super().setUp()
        with tenancy.use_tenant(self.other.pk):
            self.patient = Customer.objects.create(name='Asha Menon', phone='9800000001', patient_code='P-1')
            Customer.objects.create(name='Removed Patient', phone='9800000002', patient_code='P-2', is_deleted=True)
            EyeExamination.objects.create(customer=self.patient, patient_name='Asha Menon', test_no='T-1',
                                          sub_sph_od='-1.25', examination_date=timezone.now())
            self.bill = Invoice.objects.create(invoice_number='INV-1', customer=self.patient,
                                               customer_name='Asha Menon', invoice_date=datetime.date(2026, 10, 5),
                                               net_amount=1500)
        with tenancy.use_tenant(self.t1.pk):
            self.own_patient = Customer.objects.create(name='Platform Side', phone='9700000000', patient_code='P-1')
        self.base = f'{URL}{self.other.pk}/'


class ClientDataInspectionTests(ClientDataFixture):
    def test_overview_counts_only_that_client(self):
        res = self.api.get(f'{self.base}data/')
        self.assertEqual(res.status_code, 200, res.content)
        counts = {c['key']: c for c in res.data['counts']}
        self.assertEqual(counts['patients']['count'], 2)
        self.assertEqual(counts['patients']['deleted'], 1)
        self.assertEqual(counts['eye_exams']['count'], 1)
        self.assertEqual(counts['invoices']['count'], 1)
        refs = {(a['dataset'], a['reference']) for a in res.data['activity']}
        self.assertIn(('invoices', 'INV-1'), refs)
        self.assertNotIn('Platform Side', json.dumps(res.data))

    def test_rows_search_filters_and_isolation(self):
        res = self.api.get(f'{self.base}data/patients/')
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(res.data['count'], 2)
        self.assertEqual({r['values']['name'] for r in res.data['results']}, {'Asha Menon', 'Removed Patient'})
        self.assertEqual(self.api.get(f'{self.base}data/patients/', {'deleted': 'live'}).data['count'], 1)
        self.assertEqual(self.api.get(f'{self.base}data/patients/', {'search': '0001'}).data['count'], 1)
        dated = self.api.get(f'{self.base}data/invoices/', {'date_from': '2026-10-06'})
        self.assertEqual(dated.data['count'], 0)
        self.assertEqual(self.api.get(f'{self.base}data/invoices/', {'date_to': '2026-10-05'}).data['count'], 1)
        self.assertEqual(self.api.get(f'{self.base}data/invoices/', {'date_to': 'nope'}).status_code, 400)
        self.assertEqual(self.api.get(f'{self.base}data/nothing/').status_code, 404)
        # Platform tenant's own patient is not reachable through another client's URL.
        self.assertEqual(self.api.get(f'{self.base}data/patients/{self.own_patient.pk}/').status_code, 404)

    def test_record_detail_has_prescription_and_children(self):
        exam = self.api.get(f'{self.base}data/eye_exams/').data['results'][0]
        detail = self.api.get(f"{self.base}data/eye_exams/{exam['id']}/")
        self.assertEqual(detail.status_code, 200, detail.content)
        fields = {f['key']: f['value'] for f in detail.data['fields']}
        self.assertEqual(fields['sub_sph_od'], '-1.25')
        self.assertEqual(fields['customer']['id'], str(self.patient.pk))
        bill = self.api.get(f'{self.base}data/invoices/{self.bill.pk}/')
        self.assertEqual([c['label'] for c in bill.data['children']], ['Bill lines', 'Payments'])

    def test_csv_export_and_access_is_logged(self):
        res = self.api.get(f'{self.base}data/patients/', {'export': 'csv', 'deleted': 'live'})
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res['Content-Type'], 'text/csv; charset=utf-8')
        text = res.content.decode('utf-8-sig')
        self.assertIn('Asha Menon', text)
        self.assertNotIn('Removed Patient', text)
        self.api.get(f'{self.base}data/patients/')
        self.api.get(f'{self.base}data/patients/')
        log = TenantAuditLog.objects.filter(tenant=self.other)
        self.assertEqual(log.filter(action='DATA_EXPORTED').get().details['rows'], 1)
        self.assertEqual(log.filter(action='DATA_VIEWED', details__dataset='patients').count(), 1)

    def test_only_platform_admin(self):
        client = self._login('otheradmin')
        self.assertEqual(client.get(f'{self.base}data/').status_code, 403)
        self.assertEqual(client.get(f'{self.base}data/patients/').status_code, 403)
        self.assertEqual(client.get(f'{self.base}backups/').status_code, 403)
        self.assertEqual(client.post(f'{self.base}backups/', {}, format='json').status_code, 403)


class ClientBackupTests(ClientDataFixture):
    def setUp(self):
        super().setUp()
        self.tmp = tempfile.mkdtemp(prefix='erp-client-backup-test-')
        override = override_settings(BACKUP_DIR=self.tmp, BACKUP_STORAGE='filesystem')
        override.enable()
        self.addCleanup(override.disable)
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def _archive(self, record_id):
        record = BackupRecord.objects.get(pk=record_id)
        return zipfile.ZipFile(Path(self.tmp) / record.filename)

    def _rows(self, zf, label):
        name = f'data/{label}.jsonl'
        if name not in zf.namelist():
            return None
        lines = zf.read(name).decode('utf-8').splitlines()
        header = json.loads(lines[0])
        return [dict(zip(header['fields'], json.loads(line))) for line in lines[1:]]

    def test_full_backup_holds_only_that_client(self):
        res = self.api.post(f'{self.base}backups/', {}, format='json')
        self.assertEqual(res.status_code, 202, res.content)
        self.assertEqual(res.data['status'], 'SUCCESS', res.data)
        self.assertTrue(res.data['verified'])
        with self._archive(res.data['id']) as zf:
            manifest = json.loads(zf.read('manifest.json'))
            self.assertEqual(manifest['scope']['tenant_id'], self.other.pk)
            patients = self._rows(zf, 'sales.customer')
            self.assertEqual({p['name'] for p in patients}, {'Asha Menon', 'Removed Patient'})
            users = self._rows(zf, 'authentication.user')
            self.assertEqual({u['username'] for u in users}, {'otheradmin'})
            self.assertEqual([t['id'] for t in self._rows(zf, 'common.tenant')], [self.other.pk])
            self.assertIsNone(self._rows(zf, 'contenttypes.contenttype'))
        listing = self.api.get(f'{self.base}backups/')
        self.assertEqual([b['id'] for b in listing.data['backups']], [res.data['id']])
        self.assertEqual(listing.data['backups'][0]['sections_label'], 'Full client backup')
        self.assertTrue(TenantAuditLog.objects.filter(tenant=self.other, action='BACKUP_COMPLETED').exists())

    def test_section_backup(self):
        res = self.api.post(f'{self.base}backups/', {'sections': ['optical']}, format='json')
        self.assertEqual(res.data['status'], 'SUCCESS', res.data)
        with self._archive(res.data['id']) as zf:
            tables = {n[5:-6] for n in zf.namelist() if n.startswith('data/')}
        self.assertIn('sales.eyeexamination', tables)
        self.assertIn('sales.customer', tables)
        self.assertNotIn('sales.invoice', tables)
        self.assertNotIn('authentication.user', tables)
        bad = self.api.post(f'{self.base}backups/', {'sections': ['bogus']}, format='json')
        self.assertEqual(bad.status_code, 400)

    def test_client_backups_stay_out_of_whole_db_screens(self):
        res = self.api.post(f'{self.base}backups/', {}, format='json')
        from apps.security.backup import archive, service
        record = BackupRecord.objects.get(pk=res.data['id'])
        self.assertFalse(service.whole_db_records().filter(pk=record.pk).exists())
        with self.assertRaises(archive.BackupError):
            service.start_restore(record, user=None)
        with self.assertRaises(archive.BackupError):
            archive.restore_archive(str(Path(self.tmp) / record.filename))

    def test_download_link_and_delete(self):
        res = self.api.post(f'{self.base}backups/', {}, format='json')
        bid = res.data['id']
        link = self.api.post(f'{self.base}backups/{bid}/download-link/', {}, format='json')
        self.assertEqual(link.status_code, 200, link.content)
        from rest_framework.test import APIClient
        download = APIClient().get(link.data['url'])
        self.assertEqual(download.status_code, 200)
        self.assertEqual(b''.join(download.streaming_content)[:2], b'PK')
        self.assertEqual(APIClient().get(f'/api/superadmin/backup-download/{bid}/?token=bad').status_code, 403)
        # A backup of one client is not reachable under another client's URL.
        self.assertEqual(self.api.get(f'{URL}{self.t1.pk}/backups/{bid}/').status_code, 404)
        deleted = self.api.delete(f'{self.base}backups/{bid}/')
        self.assertEqual(deleted.status_code, 200, deleted.content)
        self.assertEqual(deleted.data['status'], 'DELETED')
        self.assertFalse((Path(self.tmp) / BackupRecord.objects.get(pk=bid).filename).exists())

    def test_schedule_runs_and_applies_retention(self):
        res = self.api.put(f'{self.base}backup-schedule/', {
            'enabled': True, 'frequency': 'DAILY', 'backup_time': '02:00', 'retention_count': 1,
            'sections': ['sales', 'financial']}, format='json')
        self.assertEqual(res.status_code, 200, res.content)
        self.assertTrue(res.data['next_run_at'])
        self.assertEqual(res.data['sections'], ['sales', 'financial'])
        bad = self.api.put(f'{self.base}backup-schedule/', {'backup_time': '25:00'}, format='json')
        self.assertEqual(bad.status_code, 400)
        later = timezone.now() + datetime.timedelta(days=2)
        first = scheduler.run_due_client_backups(now=later)
        self.assertEqual([r.status for r in first], ['SUCCESS'])
        self.assertEqual(first[0].backup_type, 'SCHEDULED')
        self.assertEqual(scheduler.run_due_client_backups(now=later), [])  # claimed, next slot is later
        second = scheduler.run_due_client_backups(now=later + datetime.timedelta(days=2))
        self.assertEqual(len(second), 1)
        first[0].refresh_from_db()
        self.assertEqual(first[0].status, 'DELETED')  # retention_count 1
        self.assertEqual(TenantBackupSchedule.objects.get(client_tenant_id=self.other.pk).last_run_status, 'SUCCESS')
