"""G-TRADE ERP application server for Windows (the ``GTrade-App`` service).

Runs ``python -m gtrade_server``. Responsibilities, in order:

1. Load ``config\\gtrade.env`` (non-secret settings) and the DPAPI secrets into the environment.
2. Refuse to start with DEBUG, ``runserver`` or a missing secret (``config.settings_local`` does
   the checking).
3. Wait for PostgreSQL (the service can start a few seconds before the database accepts
   connections after boot).
4. **Never migrate.** If the schema is behind the code, serve only health endpoints and answer
   503 ``schema_out_of_date`` everywhere else until ``gtrade-ctl migrate`` has run.
5. Answer 503 ``maintenance`` while an update/restore holds the maintenance flag.
6. Serve with Waitress on loopback, trusting X-Forwarded-* only from nginx (127.0.0.1).
7. Shut down cleanly on Ctrl+C / Ctrl+Break (WinSW stop), closing DB connections.
"""

from __future__ import annotations

import json
import logging
import os
import signal
import sys
import threading
import time
from pathlib import Path

HEALTH_PATHS = ('/api/health/', '/api/health/live/')
SCHEMA_RECHECK_SECONDS = 30
EXIT_CONFIG = 2
EXIT_DB_UNREACHABLE = 3

log = logging.getLogger('gtrade.server')


def load_environment(data_root: Path) -> None:
    """Populate os.environ from gtrade.env + secrets.dpapi. Existing variables win (tests)."""
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    from gtrade_ctl import install_config, secrets_store
    from gtrade_ctl.paths import layout

    lay = layout(data_root=data_root)
    for k, v in install_config.read_env(lay.env_file).items():
        os.environ.setdefault(k, v)
    if 'GTRADE_SECRET_KEY' not in os.environ or 'GTRADE_DB_PASSWORD' not in os.environ:
        values = secrets_store.load(lay.secrets_file)
        os.environ.setdefault('GTRADE_SECRET_KEY', values['django_secret_key'])
        os.environ.setdefault('GTRADE_DB_PASSWORD', values['db_app_password'])
        os.environ.setdefault('GTRADE_LICENSE_STORE_KEY', values['license_store_key'])
    version_file = Path(os.environ.get('GTRADE_APP_DIR', '')) / 'VERSION' if os.environ.get('GTRADE_APP_DIR') else None
    if version_file and version_file.exists():
        os.environ.setdefault('GTRADE_VERSION', version_file.read_text().strip())
    os.environ['DJANGO_SETTINGS_MODULE'] = 'config.settings_local'
    os.environ['AUTO_MIGRATE'] = 'False'


def wait_for_database(timeout: float) -> None:
    from django.db import connection
    deadline = time.monotonic() + timeout
    delay = 1.0
    while True:
        try:
            connection.ensure_connection()
            connection.close()
            return
        except Exception as exc:
            if time.monotonic() >= deadline:
                raise
            log.warning('database not ready (%s); retrying in %.0fs', type(exc).__name__, delay)
            time.sleep(delay)
            delay = min(delay * 2, 10)


def pending_migrations() -> list[str]:
    from django.db import DEFAULT_DB_ALIAS, connections
    from django.db.migrations.executor import MigrationExecutor
    executor = MigrationExecutor(connections[DEFAULT_DB_ALIAS])
    plan = executor.migration_plan(executor.loader.graph.leaf_nodes())
    return [f'{m.app_label}.{m.name}' for m, _ in plan]


class GuardedApplication:
    """WSGI wrapper: schema gate + maintenance gate in front of Django."""

    def __init__(self, app, maintenance_flag: Path):
        self.app = app
        self.maintenance_flag = maintenance_flag
        self._schema_ok = False
        self._checked_at = 0.0
        self._lock = threading.Lock()
        self.pending: list[str] = []

    def schema_ok(self) -> bool:
        if self._schema_ok:
            return True
        now = time.monotonic()
        if now - self._checked_at < SCHEMA_RECHECK_SECONDS and self._checked_at:
            return False
        with self._lock:
            try:
                self.pending = pending_migrations()
                self._schema_ok = not self.pending
            except Exception as exc:
                log.error('migration check failed: %s', exc)
                self._schema_ok = False
            finally:
                from django.db import connection
                connection.close()
            self._checked_at = now
        if not self._schema_ok:
            log.critical('database schema is behind this version (%d pending migrations); '
                         'run "gtrade-ctl migrate --apply"', len(self.pending))
        return self._schema_ok

    def _unavailable(self, start_response, code: str, message: str):
        body = json.dumps({'error': code, 'detail': message}).encode()
        start_response('503 Service Unavailable', [('Content-Type', 'application/json'),
                                                   ('Content-Length', str(len(body))),
                                                   ('Retry-After', '30'), ('Cache-Control', 'no-store')])
        return [body]

    def __call__(self, environ, start_response):
        path = environ.get('PATH_INFO', '')
        if path in HEALTH_PATHS:
            return self.app(environ, start_response)
        if self.maintenance_flag.exists():
            return self._unavailable(start_response, 'maintenance',
                                     'G-TRADE is being updated or restored. Please wait a few minutes.')
        if not self.schema_ok():
            return self._unavailable(start_response, 'schema_out_of_date',
                                     'The database has not been upgraded for this version yet. '
                                     'Ask the administrator to finish the update.')
        return self.app(environ, start_response)


def build_application(data_root: Path):
    import django
    django.setup()
    from django.core.wsgi import get_wsgi_application
    app = get_wsgi_application()
    try:
        from django.urls import get_resolver
        get_resolver().reverse_dict
    except Exception:
        pass
    return GuardedApplication(app, data_root / 'run' / 'maintenance.flag')


def _db_backup_due(now, last_iso, slot_hhmm) -> bool:
    """Daily database backup at the configured local time, plus catch-up after downtime."""
    import datetime as dt
    hh, mm = (int(x) for x in slot_hhmm.split(':'))
    slot = now.replace(hour=hh, minute=mm, second=0, microsecond=0)
    if now < slot:
        slot -= dt.timedelta(days=1)
    if not last_iso:
        return now >= slot
    last = dt.datetime.fromisoformat(last_iso).astimezone()
    return last < slot


def _db_backup_loop(stop_event, interval=600):
    """L2 scheduled backups (pg_dump + documents) with retention. Runs inside GTrade-App so no
    Task Scheduler entry or extra privileges are needed."""
    import datetime as dt
    from gtrade_ctl import backup, install_config
    from gtrade_ctl.paths import layout
    slot = os.environ.get('GTRADE_BACKUP_TIME', '21:30')
    while not stop_event.wait(interval):
        try:
            lay = layout()
            idx_path = lay.backups_dir / 'db' / 'index.json'
            last = json.loads(idx_path.read_text()).get('last_scheduled') if idx_path.exists() else None
            if not _db_backup_due(dt.datetime.now().astimezone(), last, slot):
                continue
            cfg = install_config.read(lay.install_json)
            m = backup.create_backup(lay, cfg, kind='scheduled', include_media=True, actor='scheduler')
            deleted = backup.apply_retention(lay)
            log.info('scheduled database backup %s verified=%s; retention removed %d', m['name'], m['verified'], len(deleted))
        except Exception as exc:
            log.error('scheduled database backup failed: %s', exc)
            try:
                from gtrade_ctl import backup as b
                from gtrade_ctl.paths import layout as lay_fn
                b.write_index(lay_fn(), last_error=f'{dt.datetime.now().isoformat()}: {exc}')
            except Exception:
                pass


def start_background_jobs():
    from django.conf import settings
    if getattr(settings, 'BACKUP_SCHEDULER_ENABLED', False):
        try:
            from apps.security.backup.scheduler import start_scheduler
            start_scheduler()
        except Exception as exc:
            log.error('backup scheduler did not start: %s', exc)
    if os.environ.get('GTRADE_DB_BACKUP_SCHEDULER', '1') != '0':
        stop = threading.Event()
        threading.Thread(target=_db_backup_loop, args=(stop,), name='gtrade-db-backup', daemon=True).start()
        return stop
    return None


def serve(argv=None) -> int:
    import argparse
    parser = argparse.ArgumentParser(prog='gtrade_server')
    parser.add_argument('--data-root', default=os.environ.get('GTRADE_DATA_ROOT') or r'C:\ProgramData\G-TRADE')
    parser.add_argument('--host', default=None)
    parser.add_argument('--port', type=int, default=None)
    parser.add_argument('--threads', type=int, default=int(os.environ.get('GTRADE_APP_THREADS', '16')))
    parser.add_argument('--db-wait', type=float, default=120.0)
    parser.add_argument('--check', action='store_true', help='load settings, check DB + schema, then exit')
    args = parser.parse_args(argv)

    data_root = Path(args.data_root)
    try:
        load_environment(data_root)
    except Exception as exc:
        print(f'gtrade_server: cannot load configuration: {exc}', file=sys.stderr)
        return EXIT_CONFIG

    host = args.host or os.environ.get('GTRADE_APP_BIND', '127.0.0.1')
    port = args.port or int(os.environ.get('GTRADE_APP_PORT', '8001'))
    if host not in ('127.0.0.1', 'localhost', '::1'):
        print('gtrade_server: refusing to bind a non-loopback address; nginx is the network front door.',
              file=sys.stderr)
        return EXIT_CONFIG

    try:
        application = build_application(data_root)
    except Exception as exc:
        print(f'gtrade_server: configuration error: {exc}', file=sys.stderr)
        return EXIT_CONFIG

    logging.getLogger('gtrade').setLevel(logging.INFO)
    try:
        wait_for_database(args.db_wait)
    except Exception as exc:
        log.critical('database unreachable after %.0fs: %s', args.db_wait, type(exc).__name__)
        return EXIT_DB_UNREACHABLE

    ok = application.schema_ok()
    if args.check:
        print(json.dumps({'database': 'ok', 'schema_current': ok, 'pending': application.pending}))
        return 0 if ok else 1

    start_background_jobs()

    from waitress.server import create_server
    server = create_server(
        application, host=host, port=port, threads=args.threads,
        trusted_proxy='127.0.0.1', trusted_proxy_count=1,
        trusted_proxy_headers={'x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host'},
        clear_untrusted_proxy_headers=True,
        channel_timeout=300, connection_limit=200, ident='G-TRADE',
        max_request_body_size=1100 * 1024 * 1024,
    )

    def _stop(signum, frame):
        # Closing the listening socket alone leaves Waitress's loop running on its trigger
        # channel, so break the loop from the main thread; cleanup happens in `finally`.
        log.info('stop requested (signal %s); shutting down', signum)
        raise KeyboardInterrupt

    for sig in (signal.SIGINT, signal.SIGTERM, getattr(signal, 'SIGBREAK', None)):
        if sig is not None:
            try:
                signal.signal(sig, _stop)
            except (ValueError, OSError):
                pass

    log.info('G-TRADE application server listening on http://%s:%s (%d threads)', host, port, args.threads)
    try:
        server.run()
    except (KeyboardInterrupt, OSError, ValueError):
        # server.close() from the signal handler makes the asyncore loop raise on its closed
        # sockets; that is the normal shutdown path.
        pass
    finally:
        try:
            server.close()
            server.task_dispatcher.shutdown(timeout=20)  # let in-flight requests finish
        except Exception:
            pass
        from django.db import connections
        connections.close_all()
        log.info('G-TRADE application server stopped')
    return 0
