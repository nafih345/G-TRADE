"""Hosted-reliability guarantees (Render + Neon): liveness never touches the database, the
backup scheduler doesn't poll the database every minute, and the boot-time warm-up holds."""
from datetime import timedelta
from unittest import mock

from django.db import connection
from django.test import TestCase, SimpleTestCase
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

from apps.security.backup import scheduler
from apps.security.models import BackupRecord, BackupSchedule


class LivenessTests(TestCase):
    def test_liveness_runs_no_queries_even_with_a_token_header(self):
        with CaptureQueriesContext(connection) as ctx:
            res = self.client.get('/api/health/live/', HTTP_AUTHORIZATION='Bearer not-a-real-token')
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()['status'], 'ok')
        self.assertEqual(len(ctx.captured_queries), 0, [q['sql'][:120] for q in ctx.captured_queries])

    def test_liveness_answers_while_the_database_is_down(self):
        from django.db.utils import OperationalError
        with mock.patch('django.db.backends.base.base.BaseDatabaseWrapper.ensure_connection',
                        side_effect=OperationalError('could not connect')):
            res = self.client.get('/api/health/live/')
        self.assertEqual(res.status_code, 200)

    def test_full_health_still_reports_the_database(self):
        res = self.client.get('/api/health/')
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()['database'], 'connected')


class SchedulerPacingTests(TestCase):
    def test_idle_with_nothing_scheduled_sleeps_the_maximum(self):
        BackupSchedule.objects.update_or_create(pk=1, defaults={'enabled': False})
        self.assertEqual(scheduler.seconds_until_next_check(), scheduler.IDLE_MAX_SECONDS)
        self.assertGreaterEqual(scheduler.IDLE_MAX_SECONDS, 15 * 60)  # far past Neon's 5-min suspend

    def test_sleeps_until_the_next_due_backup(self):
        now = timezone.now()
        BackupSchedule.objects.update_or_create(pk=1, defaults={'enabled': True, 'next_run_at': now + timedelta(minutes=7)})
        wait = scheduler.seconds_until_next_check(now)
        self.assertTrue(7 * 60 <= wait <= 7 * 60 + 2, wait)

    def test_a_running_job_keeps_the_one_minute_tick(self):
        BackupSchedule.objects.update_or_create(pk=1, defaults={'enabled': False})
        BackupRecord.objects.create(status='RUNNING', backup_type='MANUAL')
        self.assertEqual(scheduler.seconds_until_next_check(), scheduler.TICK_SECONDS)

    def test_overdue_never_spins(self):
        now = timezone.now()
        BackupSchedule.objects.update_or_create(pk=1, defaults={'enabled': True, 'next_run_at': now - timedelta(hours=1)})
        self.assertEqual(scheduler.seconds_until_next_check(now), scheduler.TICK_SECONDS)

    def test_refresh_next_run_wakes_the_thread(self):
        scheduler._wake.clear()
        s, _ = BackupSchedule.objects.update_or_create(pk=1, defaults={'enabled': True})
        scheduler.refresh_next_run(s)
        self.assertTrue(scheduler._wake.is_set())


class DatabaseOptionTests(SimpleTestCase):
    def test_pooler_url_gets_timeouts_keepalives_and_no_server_side_cursors(self):
        import os
        import subprocess
        import sys
        env = dict(os.environ, RENDER='1', DEBUG='False', SECRET_KEY='x', AUTO_MIGRATE='False',
                   DATABASE_URL='postgresql://u:p@ep-x-pooler.c-6.us-east-2.aws.neon.tech/neondb?sslmode=require')
        code = ("import os;os.environ['DJANGO_SETTINGS_MODULE']='config.settings';"
                "from django.conf import settings as s;d=s.DATABASES['default'];"
                "print(d['OPTIONS']['connect_timeout'], d['OPTIONS']['keepalives'], d.get('DISABLE_SERVER_SIDE_CURSORS'), d['CONN_MAX_AGE'])")
        out = subprocess.run([sys.executable, '-c', code], env=env, capture_output=True, text=True, timeout=120,
                             cwd=os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
        self.assertEqual(out.stdout.split(), ['10', '1', 'True', '600'], out.stderr[-500:])


from apps.common.tests_tenant_crud import TenantFixture  # noqa: E402


class ReconciliationQueryScalingTests(TenantFixture):
    """Accounting Integration → reconciliation walked every product with one journal lookup each:
    3,061 queries for 3,000 products (minutes on the hosted DB, past the 120 s worker timeout)."""

    def _queries(self):
        with CaptureQueriesContext(connection) as ctx:
            res = self.a.get('/api/financial/integration/reconciliation/')
        self.assertEqual(res.status_code, 200, res.content[:300])
        return len(ctx.captured_queries)

    def _add_products(self, n, start):
        from apps.common import tenancy
        from apps.products.models import Product
        with tenancy.use_tenant(self.ta.pk):
            Product.objects.bulk_create([Product(name=f'P{i}', sku=f'RQ-{i}', cost_price=10, retail_price=20,
                                                 stock=1, opening_stock=1, tenant_id=self.ta.pk)
                                         for i in range(start, start + n)])

    def test_query_count_does_not_grow_with_the_catalogue(self):
        self._add_products(20, 0)
        small = self._queries()
        self._add_products(200, 1000)
        large = self._queries()
        self.assertLessEqual(large, small + 2, f'{small} queries with 20 products, {large} with 220')
