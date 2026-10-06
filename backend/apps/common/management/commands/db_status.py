"""Report which database this configuration resolves to, and what is in it. Read-only.

Exists because the public /api/health/ endpoint deliberately does not answer the question
"is my data still there?". Row counts are ordinary business information — how many invoices
a shop has written — and an unauthenticated endpoint is the wrong place for them. So the
count lives here instead, in a command run from a trusted machine against the connection
string of your choice:

    # Windows PowerShell
    $env:DATABASE_URL = "<the Internal/External URL from the provider dashboard>"
    python manage.py db_status

Run it before and after a migration or a DATABASE_URL change and compare: identical (or
larger) counts mean nothing was dropped. It never writes, never migrates, and never prints
the password.
"""

from django.apps import apps
from django.core.management.base import BaseCommand
from django.db import DEFAULT_DB_ALIAS, connections


def _masked_target(conf):
    """Human-readable connection target with the credentials removed.

    The password is never included at all — not starred out from the real value, simply
    never read — so this output is safe to paste into an issue or a support thread.
    """
    engine = str(conf.get('ENGINE', '')).rsplit('.', 1)[-1]
    if engine.endswith('sqlite3'):
        return f"sqlite3 file: {conf.get('NAME')}"
    host = conf.get('HOST') or '(unset)'
    port = conf.get('PORT') or '5432'
    name = conf.get('NAME') or '(unset)'
    user = conf.get('USER') or '(unset)'
    # Only the first character of the username, for the "am I on the right account?" check,
    # without publishing the login itself.
    user_hint = f"{user[:1]}***" if user and user != '(unset)' else user
    return f"{engine}://{user_hint}@{host}:{port}/{name}"


class Command(BaseCommand):
    help = "Show the resolved database target, migration state and per-table row counts (read-only)."

    def add_arguments(self, parser):
        parser.add_argument(
            '--database',
            default=DEFAULT_DB_ALIAS,
            help="Database alias to inspect (default: 'default').",
        )
        parser.add_argument(
            '--empty',
            action='store_true',
            help="Also list tables with zero rows (hidden by default to keep the output short).",
        )

    def handle(self, *args, **options):
        alias = options['database']
        connection = connections[alias]
        conf = connection.settings_dict

        self.stdout.write(self.style.MIGRATE_HEADING("Target"))
        self.stdout.write(f"  {_masked_target(conf)}")
        sslmode = (conf.get('OPTIONS') or {}).get('sslmode') or 'disabled'
        self.stdout.write(f"  sslmode={sslmode}  conn_max_age={conf.get('CONN_MAX_AGE') or 0}"
                          f"  conn_health_checks={bool(conf.get('CONN_HEALTH_CHECKS'))}")

        self.stdout.write(self.style.MIGRATE_HEADING("Connection"))
        try:
            connection.ensure_connection()
        except Exception as exc:
            self.stdout.write(self.style.ERROR(f"  FAILED: {exc}"))
            # No connection means no counts; stop here rather than raising a second,
            # less informative error out of every model below.
            return
        self.stdout.write(self.style.SUCCESS("  connected"))

        self.stdout.write(self.style.MIGRATE_HEADING("Migrations"))
        try:
            from django.db.migrations.executor import MigrationExecutor

            executor = MigrationExecutor(connection)
            plan = executor.migration_plan(executor.loader.graph.leaf_nodes())
            if plan:
                self.stdout.write(self.style.WARNING(f"  {len(plan)} pending:"))
                for migration, _ in plan:
                    self.stdout.write(f"    - {migration.app_label}.{migration.name}")
            else:
                self.stdout.write(self.style.SUCCESS("  up to date"))
        except Exception as exc:
            self.stdout.write(self.style.ERROR(f"  could not determine: {exc}"))

        self.stdout.write(self.style.MIGRATE_HEADING("Row counts"))
        total = 0
        hidden = 0
        for model in sorted(apps.get_models(), key=lambda m: (m._meta.app_label, m.__name__)):
            label = f"{model._meta.app_label}.{model.__name__}"
            try:
                count = model.objects.using(alias).count()
            except Exception as exc:
                # A table missing here means the schema is behind the code — worth showing,
                # not worth aborting the rest of the report for.
                self.stdout.write(self.style.ERROR(f"  {label:<44} ERROR: {exc}"))
                continue
            total += count
            if count == 0 and not options['empty']:
                hidden += 1
                continue
            style = self.style.SUCCESS if count else self.style.NOTICE
            self.stdout.write(f"  {label:<44} {style(str(count))}")

        if hidden:
            self.stdout.write(f"  ({hidden} empty table(s) hidden - pass --empty to show them)")
        self.stdout.write(self.style.MIGRATE_HEADING("Total"))
        self.stdout.write(f"  {total} row(s) across all application tables")
