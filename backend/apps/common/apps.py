from django.apps import AppConfig


class CommonConfig(AppConfig):
    name = 'apps.common'

    def ready(self):
        from . import hot_cache
        # Everything the per-request branch context and user lookups read (see hot_cache).
        hot_cache.connect_invalidation(
            'company.BusinessSettings', 'company.Branch', 'company.UserBranchAccess',
            'authentication.User',
        )
