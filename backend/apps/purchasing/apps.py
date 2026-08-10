from django.apps import AppConfig  # type: ignore


class PurchasingConfig(AppConfig):
    default_auto_field = 'django.db.models.BigAutoField'  # type: ignore
    name = 'apps.purchasing'

    def ready(self):
        try:
            from . import signals  # noqa: F401
        except ImportError:
            pass
