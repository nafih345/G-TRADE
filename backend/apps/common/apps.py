from django.apps import AppConfig


def ensure_default_tenant(using='default', **_kwargs):
    """Tenant #1 is seeded by migration common 0002, but `flush` (TransactionTestCase, a wiped
    database) truncates it again and every row's default tenant would then dangle. post_migrate
    also runs after a flush, so re-create it here."""
    from django.core.management.color import no_style
    from django.db import connections
    from .models import Tenant
    from .tenancy import DEFAULT_TENANT_ID

    try:
        _, created = Tenant.objects.using(using).get_or_create(
            pk=DEFAULT_TENANT_ID, defaults={'name': 'Default', 'code': 'default'})
    except Exception:
        return  # table not migrated yet
    if created:
        # An explicit pk doesn't advance the Postgres id sequence; the next tenant would collide.
        connection = connections[using]
        with connection.cursor() as cursor:
            for sql in connection.ops.sequence_reset_sql(no_style(), [Tenant]):
                cursor.execute(sql)


class CommonConfig(AppConfig):
    name = 'apps.common'

    def ready(self):
        from . import hot_cache
        # Everything the per-request branch context and user lookups read (see hot_cache).
        hot_cache.connect_invalidation(
            'company.BusinessSettings', 'company.Branch', 'company.UserBranchAccess',
            'authentication.User', 'common.Tenant',
        )
        from django.db.models.signals import post_migrate
        post_migrate.connect(ensure_default_tenant, sender=self, dispatch_uid='common:default_tenant')

        from . import tenant_context, tenant_serializers
        tenant_serializers.install()
        tenant_context.install_drf_hook()
        from . import module_access
        module_access.install_api_gate()
