from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand, CommandError

from apps.security.audit import log_event
from apps.security.models import UserTwoFactor


class Command(BaseCommand):
    help = ('Remove a user\'s two-factor authenticator (recovery when the phone is lost). They will be asked '
            'to set up a new one at their next sign-in if two-factor authentication is enforced.')

    def add_arguments(self, parser):
        parser.add_argument('username')

    def handle(self, *args, username, **options):
        user = get_user_model().objects.filter(username__iexact=username).first()
        if user is None:
            raise CommandError(f'No user named "{username}".')
        deleted, _ = UserTwoFactor.objects.filter(user_id=user.pk).delete()
        if not deleted:
            self.stdout.write(f'{user.username} has no two-factor authenticator.')
            return
        log_event('TWO_FACTOR_RESET', 'SECURITY', f'Two-factor authentication reset for {user.username} from the '
                  'command line', actor_name='Command line', severity='WARNING')
        self.stdout.write(self.style.SUCCESS(f'Two-factor authentication removed for {user.username}.'))
