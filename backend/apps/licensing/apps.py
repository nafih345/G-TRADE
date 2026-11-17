from django.apps import AppConfig


class LicensingConfig(AppConfig):
    """Commercial licensing for the Windows local edition only (config.settings_local)."""
    name = 'apps.licensing'
    label = 'licensing'
    default_auto_field = 'django.db.models.BigAutoField'

    def ready(self):
        from apps.common.edition import register_health_hook
        from .state import health_summary
        register_health_hook(health_summary)
