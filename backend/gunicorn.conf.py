"""Gunicorn settings for the hosted backend (Render). Gunicorn loads this file automatically
from the working directory (render.yaml's rootDir: backend), so the start command is just
`gunicorn config.wsgi:application`. Command-line flags still override anything here — the
Render dashboard's Start Command must not repeat --workers/--threads/--timeout.

Every value can be overridden with an environment variable, so tuning never needs a commit.
"""
import os

bind = f"0.0.0.0:{os.environ.get('PORT', '8000')}"

# Two processes, four threads each. The free instance has 0.1 vCPU and 512 MB, so more
# processes buy nothing but memory; threads are what let one process overlap requests that are
# all waiting on the database (each query is a network round trip to Neon).
workers = int(os.environ.get('WEB_CONCURRENCY', '2'))
worker_class = 'gthread'
threads = int(os.environ.get('GUNICORN_THREADS', '4'))

# Load the application once in the master, then fork the workers from it. Without this every
# worker imports Django and every app itself (about 1.3 s on a desktop core, 10-20 s on a 0.1 vCPU
# instance, two workers competing for it) and each one also re-ran the boot-time migration check
# against the database. With it the wake-from-sleep boot does that work once, the workers share
# the loaded code's memory, and a worker that is replaced later starts in milliseconds.
preload_app = os.environ.get('GUNICORN_PRELOAD', 'True').lower() not in ('0', 'false', 'no')

# A request still running after this long is killed with its worker. Long enough for the heavy
# reports over a cross-region database; short enough that a hung worker comes back.
timeout = int(os.environ.get('GUNICORN_TIMEOUT', '120'))
# Render sends SIGTERM on deploy/restart; let in-flight saves finish.
graceful_timeout = int(os.environ.get('GUNICORN_GRACEFUL_TIMEOUT', '30'))
# Keep idle client connections open longer than the platform's proxy does. Gunicorn's default
# (2 s) closes a connection the router may be about to reuse, and the request it sends on it gets
# a 502 — an intermittent failure with no trace in the app's logs.
keepalive = int(os.environ.get('GUNICORN_KEEPALIVE', '120'))

# Recycle workers now and then so slow memory growth can never reach the 512 MB limit (an
# out-of-memory kill drops every request in flight). Jitter keeps both from restarting together.
max_requests = int(os.environ.get('GUNICORN_MAX_REQUESTS', '2000'))
max_requests_jitter = int(os.environ.get('GUNICORN_MAX_REQUESTS_JITTER', '200'))

# Worker heartbeats are files in this directory; on a container's overlay disk a slow fsync can
# make a healthy worker look dead ("WORKER TIMEOUT"). /dev/shm is memory-backed.
if os.path.isdir('/dev/shm'):
    worker_tmp_dir = '/dev/shm'

accesslog = os.environ.get('GUNICORN_ACCESS_LOG', '-') or None
errorlog = '-'
loglevel = os.environ.get('GUNICORN_LOG_LEVEL', 'info')
# Request duration in the access log (%(M)s = milliseconds) — slow endpoints show up in Render's
# log stream without any extra tooling.
access_log_format = '%(h)s "%(r)s" %(s)s %(b)s %(M)sms'

# config/wsgi.py starts the backup scheduler thread itself, except in the gunicorn master — a
# thread started there would not survive the fork. post_fork starts it in each worker instead.
os.environ['GTRADE_GUNICORN_MASTER'] = '1'


def pre_fork(server, worker):
    # Never hand a database connection opened in the master (the boot migration check) to a
    # child: two processes speaking on one socket corrupt each other's queries.
    try:
        from django.db import connections
        connections.close_all()
    except Exception:
        pass


def post_fork(server, worker):
    os.environ.pop('GTRADE_GUNICORN_MASTER', None)
    if not preload_app:
        return  # the worker imports config.wsgi itself, which starts the scheduler
    try:
        from apps.security.backup.scheduler import start_scheduler
        start_scheduler()
    except Exception:
        server.log.exception('Backup scheduler did not start in worker %s', worker.pid)
