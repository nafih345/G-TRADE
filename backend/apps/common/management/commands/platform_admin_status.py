"""Read-only diagnosis: can anyone sign in as the platform Super Admin and open Client Management?

    python manage.py platform_admin_status

Prints every account that looks like a platform administrator and, for each, whether it passes
the same checks the API applies (apps.common.permissions.is_platform_owner + the sign-in gate):
active, Django superuser, in the platform tenant (#1), platform tenant active, role allowed to
sign in, usable password. Exit code 1 when no account passes. Changes nothing.
"""
from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand, CommandError
from django.db.models import Q


class Command(BaseCommand):
    help = 'Diagnose platform Super Admin (Client Management) access. Read-only.'

    def handle(self, *args, **options):
        from apps.common.edition import is_local
        from apps.common.models import Tenant
        from apps.common.tenancy import DEFAULT_TENANT_ID, unscoped

        local = is_local()
        if local:
            self.stdout.write('Windows edition: the platform owner is the Local Super Admin '
                              '(create it with `gtrade-ctl create-superadmin`).')

        User = get_user_model()
        with unscoped():
            platform = Tenant.objects.filter(pk=DEFAULT_TENANT_ID).first()
            # Locally, tenant #1's own SUPER_ADMIN is the customer's company owner, not a candidate.
            who = Q(is_superuser=True) if local else Q(is_superuser=True) | Q(tenant_id=DEFAULT_TENANT_ID, role='SUPER_ADMIN')
            candidates = list(User.objects.filter(who).order_by('date_joined'))
        self.stdout.write(f'Platform tenant #{DEFAULT_TENANT_ID}: '
                          + (f'"{platform.name}", {"active" if platform.is_effectively_active else "NOT ACTIVE"}'
                             if platform else 'MISSING (run migrate)'))
        ok = 0
        for user in candidates:
            problems = []
            if not user.is_active:
                problems.append('account deactivated')
            if not user.is_superuser:
                problems.append('not a superuser (role SUPER_ADMIN alone is a client owner)')
            if user.tenant_id != DEFAULT_TENANT_ID:
                problems.append(f'belongs to client #{user.tenant_id}, not the platform tenant')
            if not user.has_usable_password():
                problems.append('no usable password')
            if 'SUPER_ADMIN' not in settings.LOGIN_ENABLED_ROLES:
                problems.append('SUPER_ADMIN missing from LOGIN_ENABLED_ROLES')
            if platform is None or not platform.is_effectively_active:
                problems.append('platform tenant not active')
            status = 'OK — can open Client Management' if not problems else 'BLOCKED: ' + '; '.join(problems)
            ok += not problems
            self.stdout.write(f'  {user.username:<24} {status}')
        if not candidates:
            self.stdout.write('  (no superuser or platform-tenant Super Admin accounts)')
        if not ok:
            if local:
                raise CommandError('No account can open Client Management. Create the Local Super Admin with '
                                   '`gtrade-ctl create-superadmin` (elevated prompt on the server PC).')
            raise CommandError('No account can open Client Management. Create one with DJANGO_SUPERUSER_* + '
                               '`manage.py bootstrap_admin`, or `manage.py createsuperuser`; repair an existing '
                               'platform-tenant account with `bootstrap_admin --reset-password`.')
        self.stdout.write(self.style.SUCCESS(f'{ok} account(s) can open Client Management.'))
