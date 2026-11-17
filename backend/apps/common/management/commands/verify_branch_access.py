"""P1 Task 4 — verify (or preview) the user-id branch-access migration. Read-only by default.

    manage.py verify_branch_access            # per tenant: what the backfill did / would do,
                                              # and every user whose effective access under the
                                              # new user-id rule differs from the old username rule
    manage.py verify_branch_access --apply    # (re)run the idempotent backfill, then verify

Exit code 1 when any user's access differs, so it can gate a deployment.
"""
from django.conf import settings
from django.apps import apps as django_apps
from django.core.management.base import BaseCommand, CommandError

from apps.common import tenancy
from apps.company.branch_access_backfill import backfill_tenant, summary_line, verify_tenant


class Command(BaseCommand):
    help = 'Verify that user-id branch access gives every user the same branches as the old username rule.'

    def add_arguments(self, parser):
        parser.add_argument('--apply', action='store_true', help='Run the idempotent backfill before verifying.')
        parser.add_argument('--tenant', type=int, help='Only this tenant id.')

    def handle(self, *args, **opts):
        Access = django_apps.get_model('company', 'UserBranchAccess')
        User = django_apps.get_model(*settings.AUTH_USER_MODEL.split('.'))
        Tenant = django_apps.get_model('common', 'Tenant')
        tenants = [opts['tenant']] if opts.get('tenant') else list(Tenant.objects.values_list('pk', flat=True))
        failures = 0
        for tid in tenants:
            with tenancy.use_tenant(tid):
                report = backfill_tenant(Access, User, tid, apply=bool(opts['apply']))
                self.stdout.write(('APPLIED ' if opts['apply'] else 'DRY RUN ') + summary_line(report))
                for key in ('cloned', 'orphan', 'superseded'):
                    if report[key]:
                        self.stdout.write(f'    {key}: {", ".join(report[key])}')
                pending = not opts['apply'] and (report['linked'] or report['cloned'])
                problems = [] if pending else verify_tenant(Access, User, tid)
            if pending:
                self.stdout.write('    rows still to link: run with --apply (or migrate) before verifying.')
            for p in problems:
                self.stdout.write(self.style.ERROR(f'    MISMATCH {p}'))
            failures += len(problems)
        if failures:
            raise CommandError(f'{failures} user(s) would get different branch access. Do not deploy; investigate.')
        self.stdout.write(self.style.SUCCESS('Every user keeps the same branch access.'))
