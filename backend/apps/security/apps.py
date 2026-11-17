from django.apps import AppConfig


class SecurityConfig(AppConfig):
    name = 'apps.security'
    label = 'security'
    verbose_name = 'System Security & Backup'

    def ready(self):
        from apps.common import hot_cache
        # The policy is read on every authenticated request (see security.policy).
        hot_cache.connect_invalidation('security.SecuritySettings')
        # P1 Task 3: adding a second tenant switches the whole-database schedule off at once.
        from django.db.models.signals import post_save
        from apps.common.models import Tenant
        post_save.connect(_tenant_created, sender=Tenant, dispatch_uid='security:tenant_created_backup_gate')


def _tenant_created(sender, instance, created, **kwargs):
    if not created:
        return
    try:
        from apps.security.backup.policy import disable_whole_db_schedule_if_multi_tenant
        disable_whole_db_schedule_if_multi_tenant(f'Business "{instance.name}" was added to this server.')
    except Exception:  # never block onboarding; the scheduler re-checks before every run
        import logging
        logging.getLogger('django').exception('Could not switch the whole-database backup schedule off')
