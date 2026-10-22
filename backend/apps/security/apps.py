from django.apps import AppConfig


class SecurityConfig(AppConfig):
    name = 'apps.security'
    label = 'security'
    verbose_name = 'System Security & Backup'

    def ready(self):
        from apps.common import hot_cache
        # The policy is read on every authenticated request (see security.policy).
        hot_cache.connect_invalidation('security.SecuritySettings')
