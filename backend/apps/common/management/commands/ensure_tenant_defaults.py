"""Create any missing default masters for client businesses (tenant_onboarding.ensure_tenant_defaults):
Head Office branch, Main Warehouse, chart of accounts, business settings, the owners' branch
binding, starter categories / services / templates.

    manage.py ensure_tenant_defaults            # every tenant
    manage.py ensure_tenant_defaults --tenant 4 # one tenant (id or code)

Additive and idempotent: existing rows are never changed or removed. Clients also receive these
automatically at their next sign-in; this command does it ahead of time.
"""
from django.core.management.base import BaseCommand, CommandError

from apps.common import tenancy
from apps.common.models import Tenant
from apps.common.tenant_onboarding import ensure_tenant_defaults, log_event


class Command(BaseCommand):
    help = "Create missing default masters (branch, warehouse, ledgers, ...) for client businesses."

    def add_arguments(self, parser):
        parser.add_argument('--tenant', help='Tenant id or code (default: all tenants).')

    def handle(self, *args, **opts):
        with tenancy.unscoped():
            tenants = Tenant.objects.order_by('pk')
            if opts['tenant']:
                key = opts['tenant']
                tenants = tenants.filter(pk=int(key)) if key.isdigit() else tenants.filter(code=key)
                if not tenants.exists():
                    raise CommandError(f'No tenant "{key}".')
            tenants = list(tenants)
        for tenant in tenants:
            created = ensure_tenant_defaults(tenant)
            if created:
                log_event(tenant, 'DEFAULTS_PROVISIONED', 'system', created=created)
            self.stdout.write(f'#{tenant.pk} {tenant.name}: ' + (', '.join(created) if created else 'complete'))
