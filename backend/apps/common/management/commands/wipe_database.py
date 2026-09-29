"""Clear every business record from the database, leaving the schema intact.

Replaces the old top-level `clear_all_database.py`, which could only be run from a shell in
the project directory (Render's free plan has none), missed the `billing` app entirely, and
looped model-by-model — so a delete could fail on foreign-key order and be silently reported
as "skipped".

This command instead:
  * refuses to run without --yes-i-am-sure, and prints the target host/database first, so a
    production database cannot be emptied by a mistyped command;
  * on PostgreSQL issues a single TRUNCATE ... RESTART IDENTITY CASCADE, which is immune to
    foreign-key ordering and resets auto-increment counters (invoice numbers, the Test No
    series, patient codes) so a cleared database really does behave like a brand-new one;
  * on SQLite falls back to deleting with constraint checks disabled, for local use;
  * keeps user accounts by default — wiping them on a hosted deployment would lock you out.

Run it on Render from the service's Shell tab (paid plans) or as a one-off job:
    python manage.py wipe_database --yes-i-am-sure
"""

from django.apps import apps as django_apps
from django.core.management.base import BaseCommand, CommandError
from django.db import connection, transaction

# Apps whose tables hold data entered through the app. `authentication` is deliberately
# absent — see --include-users.
BUSINESS_APPS = [
    'sales', 'purchasing', 'inventory', 'products', 'accounts',
    'financial', 'masters', 'billing',
]

# Holds configuration rather than transactional data: business settings, branches, company
# profile. Wiped by default (a full clear), preserved with --keep-settings.
SETTINGS_APPS = ['company']


class Command(BaseCommand):
    help = "Delete all business data while keeping the database schema and user logins."

    def add_arguments(self, parser):
        parser.add_argument(
            '--yes-i-am-sure', action='store_true', dest='confirmed',
            help="Required. Without it the command only reports what it would delete.",
        )
        parser.add_argument(
            '--keep-settings', action='store_true',
            help="Preserve the company/branch/business-settings tables.",
        )
        parser.add_argument(
            '--include-users', action='store_true',
            help="Also delete user accounts, except superusers (which are always kept).",
        )

    def _target_tables(self, app_labels):
        """Concrete DB tables for the given app labels, skipping unmanaged/proxy models."""
        tables = []
        for label in app_labels:
            try:
                app_config = django_apps.get_app_config(label)
            except LookupError:
                self.stderr.write(f"  ! unknown app '{label}' — skipped")
                continue
            for model in app_config.get_models(include_auto_created=True):
                if model._meta.proxy or not model._meta.managed:
                    continue
                tables.append(model._meta.db_table)
        return sorted(set(tables))

    def handle(self, *args, **options):
        app_labels = list(BUSINESS_APPS)
        if not options['keep_settings']:
            app_labels += SETTINGS_APPS

        tables = self._target_tables(app_labels)
        db = connection.settings_dict
        vendor = connection.vendor

        self.stdout.write(self.style.WARNING("Target database"))
        self.stdout.write(f"  engine : {db.get('ENGINE')}")
        self.stdout.write(f"  name   : {db.get('NAME')}")
        self.stdout.write(f"  host   : {db.get('HOST') or '(local file)'}")
        self.stdout.write(f"  tables : {len(tables)} across {len(app_labels)} app(s)")

        counts = self._row_counts(tables)
        total = sum(counts.values())
        self.stdout.write(f"  rows   : {total}")

        if not options['confirmed']:
            self.stdout.write("")
            self.stdout.write(self.style.NOTICE(
                "DRY RUN — nothing deleted. Re-run with --yes-i-am-sure to actually wipe."
            ))
            for table, count in sorted(counts.items(), key=lambda kv: -kv[1]):
                if count:
                    self.stdout.write(f"    {count:>8}  {table}")
            return

        if vendor == 'postgresql':
            self._truncate_postgres(tables)
        else:
            self._delete_generic(tables)

        if options['include_users']:
            self._wipe_users()

        remaining = sum(self._row_counts(tables).values())
        self.stdout.write("")
        if remaining:
            raise CommandError(
                f"{remaining} row(s) still present after the wipe — see the table list above."
            )
        self.stdout.write(self.style.SUCCESS(
            f"Database cleared: {total} row(s) removed from {len(tables)} table(s). "
            "Schema and migrations are untouched."
        ))

    def _row_counts(self, tables):
        counts = {}
        with connection.cursor() as cursor:
            for table in tables:
                try:
                    cursor.execute(f'SELECT COUNT(*) FROM {connection.ops.quote_name(table)}')
                    counts[table] = cursor.fetchone()[0]
                except Exception:
                    # Table not created yet (migration pending) — nothing to clear in it.
                    counts[table] = 0
        return counts

    def _truncate_postgres(self, tables):
        """One statement: CASCADE resolves FK order, RESTART IDENTITY resets sequences."""
        quoted = ', '.join(connection.ops.quote_name(t) for t in tables)
        with connection.cursor() as cursor:
            cursor.execute(f'TRUNCATE TABLE {quoted} RESTART IDENTITY CASCADE')
        self.stdout.write(self.style.SUCCESS(f"  TRUNCATEd {len(tables)} table(s) (CASCADE)."))

    def _delete_generic(self, tables):
        """SQLite/other: delete with FK checks off, then reset AUTOINCREMENT counters."""
        with connection.constraint_checks_disabled():
            with transaction.atomic():
                with connection.cursor() as cursor:
                    for table in tables:
                        try:
                            cursor.execute(f'DELETE FROM {connection.ops.quote_name(table)}')
                        except Exception as exc:
                            self.stderr.write(f"  ! {table}: {exc}")
                    if connection.vendor == 'sqlite':
                        cursor.execute(
                            "DELETE FROM sqlite_sequence WHERE name IN (%s)"
                            % ', '.join(['%s'] * len(tables)),
                            tables,
                        )
        connection.check_constraints()
        self.stdout.write(self.style.SUCCESS(f"  Deleted rows from {len(tables)} table(s)."))

    def _wipe_users(self):
        """Remove non-superuser accounts. Superusers are kept so access is never lost."""
        from django.contrib.auth import get_user_model
        User = get_user_model()
        deleted, _ = User.objects.filter(is_superuser=False).delete()
        self.stdout.write(self.style.SUCCESS(
            f"  Removed {deleted} non-superuser account(s); superusers kept."
        ))
