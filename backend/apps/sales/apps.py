from django.apps import AppConfig


class SalesConfig(AppConfig):
    default_auto_field = 'django.db.models.BigAutoField'
    name = 'apps.sales'

    def ready(self):
        try:
            from . import signals  # noqa: F401
        except ImportError:
            pass
