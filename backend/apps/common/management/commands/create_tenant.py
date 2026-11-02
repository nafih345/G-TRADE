"""Create a tenant (client business) and its first Super Admin account.

    manage.py create_tenant "Client Two" --code client2 --admin client2admin --password '...'

The new tenant starts empty: its own branches, products, numbering series, settings and
chart of accounts are created by the app on first use, exactly as on a fresh install.
Usernames are global, so the admin username must not exist in any tenant.
"""
from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from django.utils.text import slugify

from apps.common.models import Tenant


class Command(BaseCommand):
    help = 'Create a tenant and its first Super Admin user.'

    def add_arguments(self, parser):
        parser.add_argument('name')
        parser.add_argument('--code', help='Short slug (defaults to the slugified name).')
        parser.add_argument('--admin', required=True, help='Username of the tenant Super Admin.')
        parser.add_argument('--password', required=True)
        parser.add_argument('--email', default='')

    def handle(self, *args, **opts):
        name = opts['name'].strip()
        code = slugify(opts['code'] or name)
        if not name or not code:
            raise CommandError('Give the tenant a name.')
        User = get_user_model()
        if Tenant.objects.filter(name__iexact=name).exists() or Tenant.objects.filter(code=code).exists():
            raise CommandError(f'A tenant named "{name}" or coded "{code}" already exists.')
        if User.objects.filter(username__iexact=opts['admin']).exists():
            raise CommandError(f'The username "{opts["admin"]}" is already taken.')

        with transaction.atomic():
            tenant = Tenant.objects.create(name=name, code=code)
            # Not is_superuser: that flag also grants Django-admin access across every tenant.
            User.objects.create_user(username=opts['admin'], email=opts['email'] or None, password=opts['password'],
                                     role='SUPER_ADMIN', tenant=tenant)
        self.stdout.write(self.style.SUCCESS(
            f'Created tenant #{tenant.pk} "{tenant.name}" with Super Admin "{opts["admin"]}".'))
