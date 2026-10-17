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
