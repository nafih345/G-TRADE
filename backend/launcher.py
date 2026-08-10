import os
import sys
import json
import logging
from pathlib import Path

# Determine Base Directory (frozen executable vs script mode)
if getattr(sys, 'frozen', False):
    BASE_DIR = Path(sys._MEIPASS)
    EXE_DIR = Path(sys.executable).parent
else:
    BASE_DIR = Path(__file__).resolve().parent
    EXE_DIR = BASE_DIR

# Add BASE_DIR to Python path
sys.path.insert(0, str(BASE_DIR))

# Ensure required directories exist in working directory
for folder in ['logs', 'config', 'database', 'media', 'static', 'reports', 'backups', 'temp']:
    folder_path = EXE_DIR / folder
    folder_path.mkdir(parents=True, exist_ok=True)

# Set Django Settings
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')

def main():
    import django
    django.setup()

    logger = logging.getLogger('django')
    logger.info("Initializing Standalone Optical ERP Backend Executable...")

    # Automatic Database Migration on launch
    from django.core.management import call_command
    try:
        logger.info("Running automatic database migrations...")
        call_command('migrate', interactive=False)
        logger.info("Database migrations completed successfully.")
    except Exception as e:
        logger.error(f"Error during database migration: {e}")

    # Load port from settings.json if exists
    port = 8000
    settings_file = EXE_DIR / 'config' / 'settings.json'
    if settings_file.exists():
        try:
            with open(settings_file, 'r', encoding='utf-8') as f:
                cfg = json.load(f)
                port = cfg.get('PORT', 8000)
        except Exception as e:
            logger.warning(f"Could not parse config/settings.json: {e}")

    # Launch Production WSGI Server (Waitress) or fallback to Django WSGI
    from config.wsgi import application
    print(f"Starting Optical ERP Django WSGI Server on http://127.0.0.1:{port}...")
    logger.info(f"Serving Optical ERP Backend on port {port}")

    try:
        import waitress
        waitress.serve(application, host='127.0.0.1', port=port, threads=6)
    except ImportError:
        logger.warning("Waitress server not installed. Falling back to wsgiref simple server.")
        from wsgiref.simple_server import make_server
        httpd = make_server('127.0.0.1', port, application)
        httpd.serve_forever()

if __name__ == '__main__':
    main()
