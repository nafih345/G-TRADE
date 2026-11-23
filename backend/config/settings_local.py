"""Settings for the G-TRADE ERP **Windows local edition** (Standalone / LAN Server).

Selected with ``DJANGO_SETTINGS_MODULE=config.settings_local`` (gtrade_server and gtrade-ctl set
it). The cloud deploys keep ``config.settings`` and are not affected by anything in this file.

Everything here is fail-closed. The process refuses to start rather than run with:
* DEBUG on (forced off, whatever the environment says);
* the insecure development SECRET_KEY, or one shorter than 50 characters;
* SQLite, ``config/database.json`` or a ``DATABASE_URL``: only the installation's own
  PostgreSQL, configured through ``GTRADE_DB_*``;
* a database on anything but loopback (LAN workstations talk HTTPS to nginx, never to Postgres);
* AUTO_MIGRATE: schema changes are applied only by ``gtrade-ctl migrate`` / the updater.

Secrets (SECRET_KEY, DB password) arrive as environment variables set by gtrade_server from the
DPAPI store (``config\\secrets.dpapi``). They are never read from a file by this module.
"""

import os
import sys
from pathlib import Path

from django.core.exceptions import ImproperlyConfigured

# Must be decided before the base settings import: startup.py reads it at call time, but the
# base module also derives defaults from the environment.
os.environ['AUTO_MIGRATE'] = 'False'
os.environ.setdefault('BACKUP_STORAGE', 'filesystem')

from .settings import *  # noqa: E402,F401,F403
from .settings import INSTALLED_APPS, LOGGING, MIDDLEWARE, REST_FRAMEWORK, SIMPLE_JWT, RUNNING_TESTS  # noqa: E402

GTRADE_EDITION = 'local'

# gtrade_ctl (backups, installation layout) ships next to the backend: app\<version>\windows in an
# installation, windows\ in the repository. Put it on sys.path for the in-app backup screen.
_windows_dir = Path(__file__).resolve().parent.parent.parent / 'windows'
if _windows_dir.is_dir() and str(_windows_dir) not in sys.path:
    sys.path.append(str(_windows_dir))
GTRADE_MODE = os.environ.get('GTRADE_MODE', 'standalone')
GTRADE_INSTALL_ID = os.environ.get('GTRADE_INSTALL_ID', '')
GTRADE_VERSION = os.environ.get('GTRADE_VERSION', '1.0.0')
# Oldest desktop client this server accepts (Electron compares on connect).
GTRADE_MIN_CLIENT_VERSION = os.environ.get('GTRADE_MIN_CLIENT_VERSION', '1.0.0')

if GTRADE_MODE not in ('standalone', 'server'):
    raise ImproperlyConfigured("GTRADE_MODE must be 'standalone' or 'server' (a workstation runs no backend)")


def _required(name):
    value = os.environ.get(name, '')
    if not value:
        raise ImproperlyConfigured(f'{name} is not set. Start the backend through gtrade_server or gtrade-ctl.')
    return value


# ---- core security ------------------------------------------------------------------------------
DEBUG = False

SECRET_KEY = _required('GTRADE_SECRET_KEY')
if SECRET_KEY.startswith('django-insecure') or len(SECRET_KEY) < 50:
    raise ImproperlyConfigured('GTRADE_SECRET_KEY is missing or too weak for a production installation.')
SIMPLE_JWT = {**SIMPLE_JWT, 'SIGNING_KEY': SECRET_KEY}

DATA_ROOT = Path(_required('GTRADE_DATA_ROOT'))

ALLOWED_HOSTS = [h.strip() for h in os.environ.get('GTRADE_ALLOWED_HOSTS', 'localhost,127.0.0.1').split(',') if h.strip()]
_origins = [o.strip().rstrip('/') for o in os.environ.get('GTRADE_ORIGINS', '').split(',') if o.strip()]
CSRF_TRUSTED_ORIGINS = _origins
FRONTEND_ORIGINS = _origins

# The SPA is served by nginx from the same origin as /api, so cross-origin access is not needed.
CORS_ALLOW_ALL_ORIGINS = False
CORS_ALLOWED_ORIGINS = []
CORS_ALLOWED_ORIGIN_REGEXES = []
CORS_POLICY = 'same-origin'

# nginx terminates TLS and is the only client of Waitress (loopback).
SECURE_PROXY_SSL_HEADER = ('HTTP_X_FORWARDED_PROTO', 'https')
USE_X_FORWARDED_HOST = True
SESSION_COOKIE_SECURE = True
CSRF_COOKIE_SECURE = True
SESSION_COOKIE_HTTPONLY = True
SECURE_CONTENT_TYPE_NOSNIFF = True
X_FRAME_OPTIONS = 'SAMEORIGIN'
SECURE_REFERRER_POLICY = 'same-origin'

# ---- database -----------------------------------------------------------------------------------
_db_host = os.environ.get('GTRADE_DB_HOST', '127.0.0.1')
if _db_host not in ('127.0.0.1', 'localhost', '::1'):
    raise ImproperlyConfigured('The local edition database must be on loopback (GTRADE_DB_HOST).')
for _forbidden in ('DATABASE_URL', 'POSTGRES_URL', 'POSTGRES_URL_NON_POOLING'):
    if os.environ.get(_forbidden):
        raise ImproperlyConfigured(f'{_forbidden} must not be set for the local edition (cloud-only setting).')

DATABASES = {
    'default': {
        'ENGINE': 'django.db.backends.postgresql',
        'NAME': _required('GTRADE_DB_NAME'),
        'USER': _required('GTRADE_DB_USER'),
        'PASSWORD': _required('GTRADE_DB_PASSWORD'),
        'HOST': _db_host,
        'PORT': os.environ.get('GTRADE_DB_PORT', '5544'),
        'CONN_MAX_AGE': 300,
        'CONN_HEALTH_CHECKS': True,
        'OPTIONS': {
            'connect_timeout': 5,
            'application_name': 'gtrade-app',
        },
        'TEST': {'NAME': os.environ.get('GTRADE_TEST_DB_NAME') or None},
    }
}
DATABASE_SOURCE = 'GTRADE_DB_*'
DATABASE_URL = None
EXPECTED_DATABASE_NAME = DATABASES['default']['NAME']

# ---- files --------------------------------------------------------------------------------------
MEDIA_ROOT = DATA_ROOT / 'media'
STATIC_ROOT = DATA_ROOT / 'static'
LOGS_DIR = DATA_ROOT / 'logs' / 'app'
BACKUP_STORAGE = 'filesystem'
BACKUP_DIR = DATA_ROOT / 'backups' / 'app'
BACKUP_TEMP_DIR = str(DATA_ROOT / 'temp')
for _d in (MEDIA_ROOT, LOGS_DIR, BACKUP_DIR):
    try:
        os.makedirs(_d, exist_ok=True)
    except OSError as exc:  # pragma: no cover - permissions problem on the data root
        raise ImproperlyConfigured(f'Cannot create {_d}: {exc}')

if not RUNNING_TESTS:
    STORAGES = {
        'default': {'BACKEND': 'django.core.files.storage.FileSystemStorage'},
        'staticfiles': {'BACKEND': 'django.contrib.staticfiles.storage.ManifestStaticFilesStorage'},
    }

# ---- logging: rotating files under the data root -----------------------------------------------
LOGGING = {
    **LOGGING,
    'handlers': {
        'backend_file': {
            'level': 'INFO', 'class': 'logging.handlers.RotatingFileHandler',
            'filename': str(LOGS_DIR / 'backend.log'), 'maxBytes': 10 * 1024 * 1024, 'backupCount': 10,
            'formatter': 'verbose', 'encoding': 'utf-8',
        },
        'error_file': {
            'level': 'ERROR', 'class': 'logging.handlers.RotatingFileHandler',
            'filename': str(LOGS_DIR / 'error.log'), 'maxBytes': 10 * 1024 * 1024, 'backupCount': 10,
            'formatter': 'verbose', 'encoding': 'utf-8',
        },
    },
    'loggers': {
        'django': {'handlers': ['backend_file', 'error_file'], 'level': 'INFO', 'propagate': False},
        'gtrade': {'handlers': ['backend_file', 'error_file'], 'level': 'INFO', 'propagate': False},
        'waitress': {'handlers': ['backend_file', 'error_file'], 'level': 'INFO', 'propagate': False},
    },
}

# ---- local-edition apps -------------------------------------------------------------------------
# Licensing exists only here: the cloud edition is governed by the platform console, and keeping
# the app out of config.settings means cloud deploys never see its migrations.
# The vendor licence console (apps.vendor_licensing: customers, plans, issuing, renewal) also runs
# on the OWNER's Windows installation, so the Local Super Admin issues customer licences offline.
# It can sign only where the owner provisioned the vendor signing key (`gtrade-ctl vendor-key
# generate`: config\license\vendor-signing.dpapi, DPAPI + protected ACL) AND this build trusts its
# public key. A customer installation has no key file: the console there can never issue anything,
# and it verifies licences with the embedded public keys only. Never from the environment here.
INSTALLED_APPS = [*INSTALLED_APPS, 'apps.licensing']
GTRADE_LICENSE_SIGNING_KEY_ID = GTRADE_LICENSE_SIGNING_KEY = ''
GTRADE_LICENSE_SIGNING_KEY_FILE = '' if RUNNING_TESTS else str(DATA_ROOT / 'config' / 'license' / 'vendor-signing.dpapi')
GTRADE_LICENSE_VERIFY_KEYS = ''
MIDDLEWARE = [*MIDDLEWARE, 'apps.licensing.middleware.LicenseEnforcementMiddleware']

# Licence verification uses public keys only (apps/licensing/keys.py). The vendor's private signing
# key never ships. Dev mode (development licences signed by a gtl-dev-* key) is refused in a
# release build (RELEASE marker file written by the release pipeline next to the backend).
GTRADE_RELEASE_BUILD = (Path(__file__).resolve().parent.parent.parent / 'RELEASE').exists()
GTRADE_LICENSE_DEV_MODE = os.environ.get('GTRADE_LICENSE_DEV_MODE') == '1'
GTRADE_LICENSE_DEV_PUBKEYS = os.environ.get('GTRADE_LICENSE_DEV_PUBKEYS', '')
# The vendor's licence authority (cloud console, apps/vendor_licensing/authority_views.py): used only
# when an administrator activates a key that is not yet bound to this installation, or clicks "Check
# with vendor". Direct backend host (the Vercel /api proxy answers 429 while Render sleeps). A
# gtrade.env value overrides it; an empty value disables online activation (installation-bound keys
# and licence files keep working offline). Never the default under the test runner.
PRODUCTION_LICENSE_SERVICE_URL = 'https://g-trade-backend.onrender.com/api/licence-authority'
GTRADE_LICENSE_SERVICE_URL = os.environ.get('GTRADE_LICENSE_SERVICE_URL',
                                            '' if RUNNING_TESTS else PRODUCTION_LICENSE_SERVICE_URL)
GTRADE_LICENSE_SERVICE_CA = os.environ.get('GTRADE_LICENSE_SERVICE_CA', '')

# The in-process ORM backup scheduler (L1) keeps running; L2 pg_dump backups are scheduled by
# gtrade-ctl (Task Scheduler) and do not depend on this process.
BACKUP_SCHEDULER_ENABLED = (not RUNNING_TESTS) and os.environ.get('BACKUP_SCHEDULER', 'True').lower() not in ('0', 'false', 'no')

if 'runserver' in sys.argv:
    raise ImproperlyConfigured('The development server is disabled in the local edition. Use the GTrade-App service.')
