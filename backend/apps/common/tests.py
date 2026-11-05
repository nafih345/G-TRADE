from django.db import connection
from django.test import RequestFactory, TestCase, override_settings
from django.test.utils import CaptureQueriesContext

from apps.common import hot_cache
from apps.common.branch_context import _resolve
from apps.company.models import BusinessSettings
from apps.financial.tests.helpers import make_warehouse


@override_settings(HOT_CACHE_SECONDS=30)  # the test runner turns the cache off by default
class HotCacheTests(TestCase):
    def setUp(self):
        hot_cache.clear()
        self.addCleanup(hot_cache.clear)
        make_warehouse()

    def resolve(self):
        request = RequestFactory().get('/api/masters/units/', HTTP_X_USER_NAME='alice')
        with CaptureQueriesContext(connection) as ctx:
            _resolve(request)
        return request, len(ctx.captured_queries)

    def test_branch_context_is_read_once_then_served_from_memory(self):
        request, first = self.resolve()
        self.assertGreater(first, 0)
        expected = BusinessSettings.load().default_branch
        self.assertEqual(request.active_branch, expected)
        request, again = self.resolve()
        self.assertEqual(again, 0)
        self.assertEqual(request.active_branch, expected)

    def test_saving_settings_clears_the_cache(self):
        request, _ = self.resolve()
        self.assertFalse(request.multi_branch_enabled)
        settings_obj = BusinessSettings.load()
        settings_obj.multi_branch_enabled = True
        settings_obj.save()
        request, _ = self.resolve()
        self.assertTrue(request.multi_branch_enabled)


class HealthDatabaseInstanceTests(TestCase):
    """/api/health/ names the database's contents so browsers can drop caches from another one."""

    def setUp(self):
        import config.urls as root_urls
        self.root_urls = root_urls
        root_urls._db_instance = None
        self.addCleanup(setattr, root_urls, '_db_instance', None)

    def test_instance_is_stable_and_follows_first_migration(self):
        from django.db.migrations.recorder import MigrationRecorder
        first = self.client.get('/api/health/').json()['db_instance']
        self.assertRegex(first, r'^[0-9a-f]{16}$')
        with CaptureQueriesContext(connection) as ctx:
            again = self.client.get('/api/health/').json()['db_instance']
        self.assertEqual(again, first)
        self.assertFalse(any('django_migrations' in q['sql'] for q in ctx.captured_queries),
                         'identity is read once per process')

        # A different database = a different first migration row.
        self.root_urls._db_instance = None
        row = MigrationRecorder.Migration.objects.order_by('applied', 'id').first()
        MigrationRecorder.Migration.objects.filter(pk=row.pk).update(applied=row.applied.replace(year=2001))
        self.assertNotEqual(self.client.get('/api/health/').json()['db_instance'], first)

    def test_expected_database_name_mismatch_degrades_health(self):
        from django.conf import settings as dj_settings
        actual = str(dj_settings.DATABASES['default']['NAME'])
        with self.settings(EXPECTED_DATABASE_NAME=actual):
            body = self.client.get('/api/health/').json()
        self.assertEqual(body['database'], 'connected')
        with self.settings(EXPECTED_DATABASE_NAME='neondb-elsewhere'):
            response = self.client.get('/api/health/')
        body = response.json()
        self.assertEqual(response.status_code, 200, 'never fails the platform health check')
        self.assertEqual(body['status'], 'degraded')
        self.assertTrue(body['database'].startswith('error: connected to database'))
        self.assertIn("'neondb-elsewhere'", body['database'])
