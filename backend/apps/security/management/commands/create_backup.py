from django.core.management.base import BaseCommand, CommandError

from apps.security.backup import service


class Command(BaseCommand):
    help = 'Create and verify a database backup now (same archive as Settings → System Security & Backup).'

    def handle(self, *args, **options):
        try:
            record = service.start_backup('MANUAL', actor_name='Command line', run_async=False)
        except service.BackupBusy as exc:
            raise CommandError(str(exc))
        if record.status != 'SUCCESS':
            raise CommandError(f'Backup {record.backup_identifier} failed: {record.error_summary}')
        self.stdout.write(self.style.SUCCESS(
            f'Backup {record.backup_identifier} created and verified ({record.file_size:,} bytes, '
            f'{record.storage_location.lower()} storage: {record.filename})'))
