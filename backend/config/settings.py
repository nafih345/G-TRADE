import os
import sys
from pathlib import Path
from datetime import timedelta

# Build paths inside the project like this: BASE_DIR / 'subdir'.
# Under PyInstaller's onefile mode, __file__ resolves inside the ephemeral per-launch
# extraction temp dir (sys._MEIPASS), not the installed app folder — any config lookup or
# SQLite fallback anchored to that would silently reset on every restart. Anchor to the
# actual executable's directory instead, matching launcher.py's own frozen-aware BASE_DIR.
if getattr(sys, 'frozen', False):
    BASE_DIR = Path(sys.executable).resolve().parent
else:
    BASE_DIR = Path(__file__).resolve().parent.parent

# SECURITY WARNING: keep the secret key used in production secret!
SECRET_KEY = os.environ.get('SECRET_KEY', 'django-insecure-nova-erp-super-secret-key-for-development')

# True inside a Vercel / AWS Lambda serverless function: the code directory is read-only and
# every invocation is isolated, so logs must go to stdout and the database must be external
# (a bundled SQLite file would reset on every cold start). Vercel always sets $VERCEL.
IS_SERVERLESS = bool(os.environ.get('VERCEL') or os.environ.get('AWS_LAMBDA_FUNCTION_NAME'))

# True on Render (see render.yaml), which sets $RENDER on every service. Render gives a
# persistent process and a writable — but ephemeral — filesystem: unlike serverless it can
# hold DB connections open, but a bundled SQLite file still resets on each deploy/restart,
# so the database must be external here too.
IS_RENDER = bool(os.environ.get('RENDER'))

# Any managed cloud host. Used below for anything that differs from a local/desktop run
# regardless of which platform it is: safe DEBUG default, stdout logging, hashed static.
IS_CLOUD = IS_SERVERLESS or IS_RENDER

# SECURITY WARNING: don't run with debug turned on in production!
# The default must be driven by IS_CLOUD, not IS_SERVERLESS — Render does not set $VERCEL,
# so keying off the latter alone silently served the production backend with DEBUG=True
# (full tracebacks and the entire URL map exposed on any 404).
DEBUG = os.environ.get('DEBUG', 'False' if IS_CLOUD else 'True') == 'True'

# The backend is reached through the Vercel rewrite and/or directly by hostname, and Render
# health checks hit it by internal address, so the host list stays permissive; CSRF is what
# actually needs pinning down (below).
ALLOWED_HOSTS = ['*']

# Comma-separated https origins of the frontend, e.g.
# "https://g-opticals.vercel.app,https://www.gopticals.com". Once DEBUG=False, Django
# rejects any POST whose Origin is not listed here — which is what breaks the admin login
# and any cookie-authenticated write on a fresh production deploy.
FRONTEND_ORIGINS = [
    o.strip().rstrip('/')
    for o in os.environ.get('FRONTEND_ORIGINS', '').split(',')
    if o.strip()
]
CSRF_TRUSTED_ORIGINS = list(FRONTEND_ORIGINS)

# Render publishes the service's own external hostname; trust it so the Django admin served
# straight off onrender.com works without extra configuration.
_render_host = os.environ.get('RENDER_EXTERNAL_HOSTNAME')
if _render_host:
    CSRF_TRUSTED_ORIGINS.append(f'https://{_render_host}')

# Vercel preview deployments get a new subdomain per build, so they cannot be enumerated.
CSRF_TRUSTED_ORIGINS.append('https://*.vercel.app')

if IS_CLOUD and not DEBUG:
    # Render and Vercel both terminate TLS at their proxy and forward the original scheme
    # here; without this Django considers the request plain HTTP and redirect/cookie logic
    # misfires.
    SECURE_PROXY_SSL_HEADER = ('HTTP_X_FORWARDED_PROTO', 'https')
    SESSION_COOKIE_SECURE = True
    CSRF_COOKIE_SECURE = True

# Application definition
INSTALLED_APPS = [
    'django.contrib.admin',
    'django.contrib.auth',
    'django.contrib.contenttypes',
    'django.contrib.sessions',
    'django.contrib.messages',
    'django.contrib.staticfiles',
    
    # Third party packages
    'rest_framework',
    'rest_framework_simplejwt',
    'corsheaders',
    
    # Internal apps
    'apps.common',
    'apps.authentication',
    'apps.company',
    'apps.billing',
    'apps.masters',
    'apps.products',
    'apps.inventory',
    'apps.purchasing',
    'apps.sales',
    'apps.accounts',
    'apps.financial',
]

MIDDLEWARE = [
    'corsheaders.middleware.CorsMiddleware',
    'django.middleware.security.SecurityMiddleware',
    # Serves STATIC_ROOT directly from the app process. Required on Render/Vercel: with
    # DEBUG=False Django refuses to serve /static/ itself and there is no nginx in front,
    # so without this the Django admin loads with no CSS or JS.
    'whitenoise.middleware.WhiteNoiseMiddleware',
    'django.contrib.sessions.middleware.SessionMiddleware',
    'django.middleware.common.CommonMiddleware',
    'django.middleware.csrf.CsrfViewMiddleware',
    'django.contrib.auth.middleware.AuthenticationMiddleware',
    'apps.common.branch_context.BranchContextMiddleware',
    'django.contrib.messages.middleware.MessageMiddleware',
    'django.middleware.clickjacking.XFrameOptionsMiddleware',
]

ROOT_URLCONF = 'config.urls'

TEMPLATES = [
    {
        'BACKEND': 'django.template.backends.django.DjangoTemplates',
        'DIRS': [],
        'APP_DIRS': True,
        'OPTIONS': {
            'context_processors': [
                'django.template.context_processors.debug',
                'django.template.context_processors.request',
                'django.contrib.auth.context_processors.auth',
                'django.contrib.messages.context_processors.messages',
            ],
        },
    },
]

WSGI_APPLICATION = 'config.wsgi.application'

import json

# Check for external config files in root or BASE_DIR
ROOT_DIR = BASE_DIR.parent
CONFIG_DIR = ROOT_DIR / 'config' if (ROOT_DIR / 'config').exists() else BASE_DIR / 'config'
LOGS_DIR = ROOT_DIR / 'logs' if (ROOT_DIR / 'logs').exists() else BASE_DIR / 'logs'

# Ensure logs directory exists. On a read-only serverless filesystem fall back to /tmp,
# the only writable location (LOGGING is switched to stdout below anyway).
if IS_CLOUD:
    LOGS_DIR = Path('/tmp/optical-erp-logs')
try:
    os.makedirs(LOGS_DIR, exist_ok=True)
except OSError:
    LOGS_DIR = Path('/tmp/optical-erp-logs')
    os.makedirs(LOGS_DIR, exist_ok=True)

# Load external database.json config if available
db_config_file = CONFIG_DIR / 'database.json'
db_json_data = {}
if db_config_file.exists():
    try:
        with open(db_config_file, 'r', encoding='utf-8') as f:
            db_json_data = json.load(f)
    except Exception as e:
        print(f"Warning loading database.json: {e}")

# Base Database Configuration
db_engine = db_json_data.get('ENGINE', 'django.db.backends.sqlite3')
if db_engine == 'django.db.backends.sqlite3':
    db_path = BASE_DIR / db_json_data.get('NAME', 'db.sqlite3')
    db_path.parent.mkdir(parents=True, exist_ok=True)
    DATABASES = {
        'default': {
            'ENGINE': db_engine,
            'NAME': db_path,
        }
    }
else:
    DATABASES = {
        'default': {
            'ENGINE': db_engine,
            'NAME': db_json_data.get('NAME', 'optical_erp_db'),
        }
    }

if db_json_data.get('ENGINE') == 'django.db.backends.postgresql':
    DATABASES['default'].update({
        'USER': db_json_data.get('USER', 'postgres'),
        'PASSWORD': db_json_data.get('PASSWORD', 'postgres'),
        'HOST': db_json_data.get('HOST', 'localhost'),
        'PORT': db_json_data.get('PORT', '5432'),
    })

# Fallback: Environment Variables for PostgreSQL
DB_NAME = os.environ.get('DB_NAME')
DB_USER = os.environ.get('DB_USER')
DB_PASSWORD = os.environ.get('DB_PASSWORD')
DB_HOST = os.environ.get('DB_HOST')
DB_PORT = os.environ.get('DB_PORT', '5432')
# Vercel Postgres / Neon inject POSTGRES_URL(+ _NON_POOLING); other hosts use DATABASE_URL.
# Prefer the non-pooling URL so `migrate` on boot runs on a direct connection.
DATABASE_URL = (
    os.environ.get('DATABASE_URL')
    or os.environ.get('POSTGRES_URL_NON_POOLING')
    or os.environ.get('POSTGRES_URL')
)

if DATABASE_URL:
    # Render's *internal* URL (host like `dpg-xxxx-a`, no dots) stays inside their private
    # network and offers no verifiable certificate, so forcing sslmode=require on it fails to
    # connect. Any host with a dot in it is being reached across the public internet —
    # Render external, Neon, Supabase — and must be encrypted. Deciding from the URL rather
    # than from the platform flag means the same code is correct for every combination.
    _db_host = DATABASE_URL.split('@')[-1].split('/')[0].split(':')[0]
    _db_needs_ssl = '.' in _db_host and _db_host not in ('localhost', '127.0.0.1')
    # `sslmode` already spelled out in the URL wins — never override an explicit choice.
    if 'sslmode=' in DATABASE_URL:
        _db_needs_ssl = False
    try:
        import importlib
        dj_database_url = importlib.import_module('dj_database_url')
        DATABASES['default'] = dj_database_url.config(
            default=DATABASE_URL,
            # Serverless isolates every invocation, so a pooled connection cannot be reused
            # and only leaks server-side slots. Render runs a long-lived process, so reusing
            # connections avoids a TCP+TLS handshake on each request.
            conn_max_age=0 if IS_SERVERLESS else 600,
            ssl_require=_db_needs_ssl,
        )
    except ImportError:
        # Hand-rolled equivalent for the case where dj-database-url did not install. It must
        # apply the SAME connection lifetime and TLS decision as the branch above, or a
        # dependency-resolution hiccup would quietly cost the deployed app its connection
        # reuse and, worse, its encryption — with no error to show for it.
        from urllib.parse import urlparse, unquote
        url = urlparse(DATABASE_URL)
        DATABASES['default'] = {
            'ENGINE': 'django.db.backends.postgresql',
            'NAME': (url.path or '/').lstrip('/'),
            # Managed providers hand out generated passwords containing URL-escaped
            # characters; leaving them escaped fails authentication.
            'USER': unquote(url.username or ''),
            'PASSWORD': unquote(url.password or ''),
            'HOST': url.hostname or '',
            'PORT': str(url.port or '5432'),
            'CONN_MAX_AGE': 0 if IS_SERVERLESS else 600,
            'OPTIONS': {'sslmode': 'require'} if _db_needs_ssl else {},
        }
elif DB_NAME and DB_USER:
    DATABASES['default'] = {
        'ENGINE': 'django.db.backends.postgresql',
        'NAME': DB_NAME,
        'USER': DB_USER,
        'PASSWORD': DB_PASSWORD,
        'HOST': DB_HOST,
        'PORT': DB_PORT,
    }

# File Logging Configuration with Rotation
LOGGING = {
    'version': 1,
    'disable_existing_loggers': False,
    'formatters': {
        'verbose': {
            'format': '{levelname} {asctime} {module} {process:d} {thread:d} {message}',
            'style': '{',
        },
    },
    'handlers': {
        'backend_file': {
            'level': 'INFO',
            'class': 'logging.handlers.RotatingFileHandler',
            'filename': str(LOGS_DIR / 'backend.log'),
            'maxBytes': 1024 * 1024 * 5,  # 5 MB
            'backupCount': 5,
            'formatter': 'verbose',
        },
        'error_file': {
            'level': 'ERROR',
            'class': 'logging.handlers.RotatingFileHandler',
            'filename': str(LOGS_DIR / 'error.log'),
            'maxBytes': 1024 * 1024 * 5,  # 5 MB
            'backupCount': 5,
            'formatter': 'verbose',
        },
    },
    'loggers': {
        'django': {
            'handlers': ['backend_file', 'error_file'],
            'level': 'INFO',
            'propagate': True,
        },
    },
}

# Cloud: rotating file handlers are pointless on an ephemeral filesystem — log to stdout so
# the platform captures it (Render "Logs", Vercel "Runtime Logs", CloudWatch, etc.).
if IS_CLOUD:
    LOGGING['handlers'] = {
        'console': {'level': 'INFO', 'class': 'logging.StreamHandler', 'formatter': 'verbose'},
    }
    LOGGING['loggers']['django']['handlers'] = ['console']


# Password validation
AUTH_PASSWORD_VALIDATORS = [
    {
        'NAME': 'django.contrib.auth.password_validation.UserAttributeSimilarityValidator',
    },
    {
        'NAME': 'django.contrib.auth.password_validation.MinimumLengthValidator',
    },
    {
        'NAME': 'django.contrib.auth.password_validation.CommonPasswordValidator',
    },
    {
        'NAME': 'django.contrib.auth.password_validation.NumericPasswordValidator',
    },
]

# Internationalization
LANGUAGE_CODE = 'en-us'
TIME_ZONE = 'UTC'
USE_I18N = True
USE_TZ = True

# Static files (CSS, JavaScript, Images)
STATIC_URL = '/static/'
STATIC_ROOT = BASE_DIR / 'static'

# WhiteNoise (middleware above) serves STATIC_ROOT. The compressed+manifest backend
# fingerprints filenames so they can be cached forever; it requires `collectstatic` to have
# run, which build.sh does, so it is only enabled in the cloud — a local dev run that has
# never collected static would otherwise raise on every admin page.
if IS_CLOUD:
    STORAGES = {
        'default': {'BACKEND': 'django.core.files.storage.FileSystemStorage'},
        'staticfiles': {
            'BACKEND': 'whitenoise.storage.CompressedManifestStaticFilesStorage',
        },
    }

DEFAULT_AUTO_FIELD = 'django.db.models.BigAutoField'

# Custom User Model
AUTH_USER_MODEL = 'authentication.User'

# REST Framework Configuration
REST_FRAMEWORK = {
    'DEFAULT_AUTHENTICATION_CLASSES': (
        'apps.common.authentication.LenientJWTAuthentication',
    ),
    'DEFAULT_PERMISSION_CLASSES': (
        'rest_framework.permissions.IsAuthenticated',
    ),
    'DEFAULT_PAGINATION_CLASS': 'rest_framework.pagination.PageNumberPagination',
    'PAGE_SIZE': 20,
}

# Simple JWT Configuration
SIMPLE_JWT = {
    'ACCESS_TOKEN_LIFETIME': timedelta(days=1),
    'REFRESH_TOKEN_LIFETIME': timedelta(days=7),
    'ROTATE_REFRESH_TOKENS': True,
    'BLACKLIST_AFTER_ROTATION': False,
    'ALGORITHM': 'HS256',
    'SIGNING_KEY': SECRET_KEY,
    'AUTH_HEADER_TYPES': ('Bearer',),
    'USER_ID_FIELD': 'id',
    'USER_ID_CLAIM': 'user_id',
}

# CORS Configuration
CORS_ALLOW_ALL_ORIGINS = True
CORS_ALLOW_CREDENTIALS = True

# The frontend attaches Multi-Branch context headers to every API call (see
# frontend/src/utils/apiClient.js). CORS_ALLOW_ALL_ORIGINS only whitelists the Origin, not
# request headers — custom headers must be listed explicitly or the browser's preflight
# (OPTIONS) fails and silently blocks the real request.
try:
    from corsheaders.defaults import default_headers as _cors_default_headers
    CORS_ALLOW_HEADERS = (*_cors_default_headers, 'x-branch-id', 'x-user-name', 'x-user-role')
except Exception:
    CORS_ALLOW_HEADERS = [
        'accept', 'accept-encoding', 'authorization', 'content-type', 'dnt', 'origin',
        'user-agent', 'x-csrftoken', 'x-requested-with',
        'x-branch-id', 'x-user-name', 'x-user-role',
    ]

# Media files
MEDIA_URL = '/media/'
MEDIA_ROOT = BASE_DIR / 'media'

