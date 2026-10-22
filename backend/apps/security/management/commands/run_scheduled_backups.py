from django.core.management.base import BaseCommand

from apps.security.backup import scheduler, service


class Command(BaseCommand):
    help = ('Run the automatic backup if it is due (for hosts without a long-running server process — '
            'call it from cron every few minutes). Safe to overlap with the in-process scheduler.')

    def handle(self, *args, **options):
        service.recover_stale()
        record = scheduler.run_due()
        if record is None:
            self.stdout.write('No scheduled backup is due.')
        elif record.status == 'SUCCESS':
            self.stdout.write(self.style.SUCCESS(f'Scheduled backup {record.backup_identifier} completed.'))
        else:
            self.stderr.write(f'Scheduled backup {record.backup_identifier} failed: {record.error_summary}')
