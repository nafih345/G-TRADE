"""Run outstanding DB migrations when the app process boots.

The desktop build does this in launcher.py, but the cloud deploy (Vercel) only ships
new *code* — nothing runs `manage.py migrate` against the production Postgres. That is
how the Multi-Branch release broke after deploy: the models/serializers/mixins went live
while `company_branchstock`, the seeded default `Branch`, and the `branch_id` columns on
Invoice / Payment / StockLedger / StockAdjustment / PurchaseOrder never got created, so
every branch-scoped query started raising ProgrammingError (500) the moment the toggle
was switched on.

`run_startup_migrations()` closes that gap: on process start it checks the migration
plan and, only if something is pending, applies it. It is idempotent, best-effort, and
never raises into the WSGI bootstrap.

Disable with AUTO_MIGRATE=False (e.g. when a managed platform already runs a release
command).
"""

import logging
import os

logger = logging.getLogger('django')

_ran = False


def _enabled():
    return os.environ.get('AUTO_MIGRATE', 'True').lower() not in ('0', 'false', 'no')


def run_startup_migrations():
    """Apply any unapplied migrations. Safe to call more than once."""
    global _ran
    if _ran or not _enabled():
        return
    _ran = True

    try:
        import django
        django.setup()
    except Exception:
        # Already set up, or cannot be — either way continue and let the checks below decide.
        pass

    try:
        from django.db import connections, DEFAULT_DB_ALIAS
        from django.db.migrations.executor import MigrationExecutor

        connection = connections[DEFAULT_DB_ALIAS]
        executor = MigrationExecutor(connection)
        targets = executor.loader.graph.leaf_nodes()
        plan = executor.migration_plan(targets)

        if not plan:
            logger.info("AUTO_MIGRATE: database schema is up to date.")
            return

        pending = ", ".join(f"{m.app_label}.{m.name}" for m, _ in plan)
        logger.warning("AUTO_MIGRATE: applying %d pending migration(s): %s", len(plan), pending)

        from django.core.management import call_command
        call_command('migrate', interactive=False, verbosity=1)
        logger.warning("AUTO_MIGRATE: migrations applied successfully.")
    except Exception as exc:  # pragma: no cover - defensive
        logger.exception("AUTO_MIGRATE: failed to apply migrations: %s", exc)


def run_migrations_now(reason=""):
    """Apply pending migrations immediately, bypassing the once-per-process boot guard.

    Called from a request handler (e.g. the Multi-Branch toggle) the moment a query hits
    a missing table/column — meaning the deploy shipped code ahead of the schema and the
    boot hook either never ran (the platform imports the app a different way) or ran before
    the database was reachable. Best-effort; returns True only if `migrate` completed
    without raising. Honours AUTO_MIGRATE=False like the boot hook.
    """
    global _ran
    if not _enabled():
        return False
    try:
        from django.core.management import call_command
        logger.warning("Running migrations on demand%s", f": {reason}" if reason else "")
        call_command('migrate', interactive=False, verbosity=1)
        _ran = True
        logger.warning("On-demand migrate completed.")
        return True
    except Exception as exc:  # pragma: no cover - defensive
        logger.exception("On-demand migrate failed: %s", exc)
        return False
