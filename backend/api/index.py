"""Vercel serverless entrypoint for the Django backend.

Vercel's `@vercel/python` builder imports this module and serves the module-level `app`
(a WSGI callable). Importing `config.wsgi` also runs `run_startup_migrations()` on cold
start (see apps/common/startup.py), so shipping code ahead of the DB schema can't leave
the deploy broken — the pending migrations are applied on the first request.

The Django project lives in `backend/` (one level up from this `api/` folder), so that
directory has to be on sys.path before `config` can be imported.
"""
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')

from config.wsgi import application  # noqa: E402

app = application
