import os
from django.core.asgi import get_asgi_application

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')

application = get_asgi_application()

try:
    from apps.common.startup import run_startup_migrations
    run_startup_migrations()
except Exception:
    pass
