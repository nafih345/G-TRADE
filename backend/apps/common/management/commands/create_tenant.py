"""Create a tenant (client business) and its first Super Admin account.

    manage.py create_tenant "Client Two" --code client2 --admin client2admin --password '...'

Same rows as Administration → Client Management (apps/common/tenant_onboarding.py): the tenant,
its Super Admin, and a Company + default branch. Everything else is created on first use.
"""
from django.core.management.base import BaseCommand, CommandError

from apps.common.tenant_onboarding import OnboardingError, onboard_tenant


class Command(BaseCommand):
    help = 'Create a tenant and its first Super Admin user (same as the Super Admin console).'

    def add_arguments(self, parser):
        parser.add_argument('name')
        parser.add_argument('--code', help='Short slug (defaults to the slugified name).')
        parser.add_argument('--admin', required=True, help='Username of the tenant Super Admin.')
        parser.add_argument('--password', required=True)
        parser.add_argument('--email', default='')
        parser.add_argument('--phone', default='')
        parser.add_argument('--branch', default='', help='Name of the first branch (default "Head Office").')

    def handle(self, *args, **opts):
        try:
            tenant, admin = onboard_tenant(
                name=opts['name'], code=opts['code'], admin_username=opts['admin'], password=opts['password'],
                admin_email=opts['email'], contact_phone=opts['phone'], branch_name=opts['branch'])
        except OnboardingError as e:
            raise CommandError(e.message)
        self.stdout.write(self.style.SUCCESS(
            f'Created tenant #{tenant.pk} "{tenant.name}" with Super Admin "{admin.username}".'))
