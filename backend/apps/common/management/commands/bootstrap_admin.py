"""Create the platform owner (the Super Admin who runs Client Management) on a fresh database,
from environment variables.

A newly provisioned Postgres is empty — migrations create the tables but no users, so the
app has no login and `createsuperuser` cannot be run interactively on a platform with no
shell (Render's free plan). This runs as part of the release (see build.sh) and is a no-op
once the account exists, so it is safe on every redeploy.

Reads the same variable names Django's own `createsuperuser --noinput` uses:
    DJANGO_SUPERUSER_USERNAME   (required, else the command does nothing)
    DJANGO_SUPERUSER_PASSWORD   (required, else the command does nothing)
    DJANGO_SUPERUSER_EMAIL      (optional)

There is no built-in default account or password, in any mode: without the variables nothing
is created (locally, use `manage.py createsuperuser`).

The platform owner is a Django superuser in the platform tenant (#1) — see
apps.common.permissions.is_platform_owner. An existing account with the configured name that
is NOT that (a client's user in another tenant, or a tenant-#1 user without superuser rights)
used to be reported as "already exists — nothing to do", so the owner could sign in but never
saw Client Management. The command now says exactly what is wrong; `--reset-password` repairs a
tenant-#1 account and never promotes another tenant's user. `manage.py platform_admin_status`
diagnoses the whole picture.
"""

import os

from django.contrib.auth import get_user_model
from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError
from django.core.management.base import BaseCommand
from django.db.utils import OperationalError, ProgrammingError


class Command(BaseCommand):
    help = "Create the platform owner from DJANGO_SUPERUSER_* env vars, if absent."

    def add_arguments(self, parser):
        parser.add_argument(
            '--reset-password',
            action='store_true',
            help="If the user already exists in the platform tenant, reset its password to "
                 "DJANGO_SUPERUSER_PASSWORD and restore its platform-owner rights.",
        )

    def handle(self, *args, **options):
        from apps.common.edition import is_local
        if is_local():
            # The Windows edition's platform owner is the Local Super Admin, created from stdin (never
            # environment variables) by `local_superadmin` / `gtrade-ctl create-superadmin`.
            self.stdout.write("bootstrap_admin: not used in the Windows edition — use "
                              "`gtrade-ctl create-superadmin` to create the Local Super Admin. Skipping.")
            return

        username = os.environ.get('DJANGO_SUPERUSER_USERNAME', '').strip()
        password = os.environ.get('DJANGO_SUPERUSER_PASSWORD', '')
        email = os.environ.get('DJANGO_SUPERUSER_EMAIL', '').strip() or None

        if not username or not password:
            self.stdout.write(
                "bootstrap_admin: DJANGO_SUPERUSER_USERNAME / DJANGO_SUPERUSER_PASSWORD "
                "not set — skipping (no admin account will be created)."
            )
            return

        from apps.common.tenancy import DEFAULT_TENANT_ID, unscoped

        User = get_user_model()
        try:
            with unscoped():
                # Sign-in matches usernames case-insensitively (UsernameOrEmailBackend).
                existing = User.objects.filter(username__iexact=username).first()
        except (OperationalError, ProgrammingError) as exc:
            # Never fail the release over this — `migrate` runs immediately before, so this
            # only fires if the database is unreachable, which the deploy log will show.
            self.stderr.write(f"bootstrap_admin: database not ready ({exc}) — skipping.")
            return

        if existing:
            self._existing(existing, password, options['reset_password'], DEFAULT_TENANT_ID)
            return

        try:
            validate_password(password, user=User(username=username, email=email or ''))
        except ValidationError as exc:
            self.stderr.write(self.style.ERROR(
                "bootstrap_admin: DJANGO_SUPERUSER_PASSWORD is too weak — no account created: "
                + ' '.join(exc.messages)))
            return

        # The platform owner belongs to the platform tenant (#1, seeded by common 0002).
        User.objects.create_superuser(username=username, email=email, password=password,
                                      tenant_id=DEFAULT_TENANT_ID)
        self.stdout.write(self.style.SUCCESS(
            f"bootstrap_admin: created platform owner '{username}' (Super Admin, Client Management)."
        ))

    def _existing(self, user, password, reset, platform_tenant_id):
        owner = user.is_superuser and user.is_active and user.tenant_id == platform_tenant_id
        if user.tenant_id != platform_tenant_id:
            # Never turn a client's account into the platform owner.
            self.stderr.write(self.style.ERROR(
                f"bootstrap_admin: '{user.username}' belongs to client #{user.tenant_id}, not the platform "
                "account. It cannot become the platform owner. Set DJANGO_SUPERUSER_USERNAME to a new name."))
            return
        if not reset:
            if owner:
                self.stdout.write(f"bootstrap_admin: platform owner '{user.username}' already exists — nothing to do.")
            else:
                problems = [p for p, bad in (('not a superuser', not user.is_superuser),
                                             ('deactivated', not user.is_active)) if bad]
                self.stderr.write(self.style.WARNING(
                    f"bootstrap_admin: '{user.username}' exists but is {' and '.join(problems)}, so it cannot "
                    "open Client Management. Re-run with --reset-password to restore it."))
            return
        user.set_password(password)
        user.is_active = True
        user.is_staff = True
        user.is_superuser = True
        user.save(update_fields=['password', 'is_active', 'is_staff', 'is_superuser'])
        self.stdout.write(self.style.SUCCESS(
            f"bootstrap_admin: password reset and platform-owner rights restored for '{user.username}'."))
