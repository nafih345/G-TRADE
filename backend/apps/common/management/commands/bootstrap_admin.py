"""Create the initial superuser on a fresh database, from environment variables.

A newly provisioned Postgres is empty — migrations create the tables but no users, so the
app has no login and `createsuperuser` cannot be run interactively on a platform with no
shell (Render's free plan). This runs as part of the release (see build.sh) and is a no-op
once the account exists, so it is safe on every redeploy.

Reads the same variable names Django's own `createsuperuser --noinput` uses:
    DJANGO_SUPERUSER_USERNAME   (required, else the command does nothing)
    DJANGO_SUPERUSER_PASSWORD   (required, else the command does nothing)
    DJANGO_SUPERUSER_EMAIL      (optional)
"""

import os

from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand
from django.db.utils import OperationalError, ProgrammingError


class Command(BaseCommand):
    help = "Create the initial superuser from DJANGO_SUPERUSER_* env vars, if absent."

    def add_arguments(self, parser):
        parser.add_argument(
            '--reset-password',
            action='store_true',
            help="If the user already exists, reset its password to DJANGO_SUPERUSER_PASSWORD.",
        )

    def handle(self, *args, **options):
        username = os.environ.get('DJANGO_SUPERUSER_USERNAME', '').strip()
        password = os.environ.get('DJANGO_SUPERUSER_PASSWORD', '')
        email = os.environ.get('DJANGO_SUPERUSER_EMAIL', '').strip() or None

        if not username or not password:
            self.stdout.write(
                "bootstrap_admin: DJANGO_SUPERUSER_USERNAME / DJANGO_SUPERUSER_PASSWORD "
                "not set — skipping (no admin account will be created)."
            )
            return

        User = get_user_model()
        try:
            existing = User.objects.filter(username=username).first()
        except (OperationalError, ProgrammingError) as exc:
            # Never fail the release over this — `migrate` runs immediately before, so this
            # only fires if the database is unreachable, which the deploy log will show.
            self.stderr.write(f"bootstrap_admin: database not ready ({exc}) — skipping.")
            return

        if existing:
            if options['reset_password']:
                existing.set_password(password)
                existing.is_active = True
                existing.is_staff = True
                existing.is_superuser = True
                existing.save(update_fields=['password', 'is_active', 'is_staff', 'is_superuser'])
                self.stdout.write(self.style.SUCCESS(
                    f"bootstrap_admin: password reset for existing user '{username}'."
                ))
            else:
                self.stdout.write(
                    f"bootstrap_admin: user '{username}' already exists — nothing to do."
                )
            return

        User.objects.create_superuser(username=username, email=email, password=password)
        self.stdout.write(self.style.SUCCESS(
            f"bootstrap_admin: created superuser '{username}' (role SUPER_ADMIN)."
        ))
