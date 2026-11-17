"""Windows local edition: set a new password for a user who cannot sign in (lost administrator password).

Run on the server PC through ``gtrade-ctl reset-password`` from an elevated prompt. Only someone with
Administrator rights on the server can run it, because only they can read the installation's secrets
(DPAPI) that the command needs to reach the database. Input is a JSON object on **stdin** (never
argv, so the password is not visible in process listings or logs)::

    {"username": "...", "password": "..."}

or, with ``--list-admins``, nothing: it prints the administrator user names (no passwords) so the
technician can find the right account.

Rules:
* Only in the local edition.
* The new password must pass Django's validators (AUTH_PASSWORD_VALIDATORS), like any other password.
* Every open session of that user is ended, so a stolen session cannot outlive the reset.
* The reset is written to the security audit log (Administration -> Audit Logs).
* Nothing else about the account changes (role, company, active flag, two-factor enrolment).
"""

import json
import sys

from django.contrib.auth import get_user_model
from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from django.utils import timezone

ADMIN_ROLES = ('SUPER_ADMIN', 'ADMINISTRATOR', 'BRANCH_ADMIN')


class Command(BaseCommand):
    help = 'Set a new password for a user of a G OPTICALS Windows installation (JSON on stdin).'

    def add_arguments(self, parser):
        parser.add_argument('--list-admins', action='store_true',
                            help='print the administrator user names (no passwords) and change nothing')

    def handle(self, *args, **options):
        from apps.common.edition import is_local
        if not is_local():
            raise CommandError('local_reset_password is only available in the Windows edition.')
        User = get_user_model()

        if options['list_admins']:
            rows = (User.objects.filter(role__in=ADMIN_ROLES).order_by('username')
                    .values('username', 'role', 'is_active', 'tenant_id'))
            self.stdout.write(json.dumps({'ok': True, 'administrators': [
                {'username': r['username'], 'role': r['role'], 'active': r['is_active'], 'company_id': r['tenant_id']}
                for r in rows]}))
            return

        try:
            data = json.loads(sys.stdin.read() or '{}')
        except json.JSONDecodeError:
            raise CommandError('expected a JSON object on stdin')
        username = (data.get('username') or '').strip()
        password = data.get('password') or ''
        if not username:
            self.stdout.write(json.dumps({'ok': False, 'errors': {'username': 'Enter the user name.'}}))
            raise CommandError('invalid input')
        user = User.objects.filter(username=username).first()
        if user is None:
            self.stdout.write(json.dumps({'ok': False, 'errors': {'username': f'No user named "{username}".'}}))
            raise CommandError('invalid input')
        try:
            validate_password(password, user=user)
        except ValidationError as exc:
            self.stdout.write(json.dumps({'ok': False, 'errors': {'password': ' '.join(exc.messages)}}))
            raise CommandError('invalid input')

        from apps.security.audit import log_event
        from apps.security.models import AuthSession
        with transaction.atomic():
            user.set_password(password)
            user.save(update_fields=['password'])
            ended = (AuthSession.objects.filter(user=user, ended_at__isnull=True)
                     .update(ended_at=timezone.now(), end_reason='REVOKED'))
            log_event('PASSWORD_RESET_LOCAL', 'AUTH',
                      f'Password of {user.username} reset on the server PC (gtrade-ctl reset-password)',
                      actor_name='server administrator (gtrade-ctl)',
                      details={'username': user.username, 'sessions_ended': ended}, severity='WARNING')
        self.stdout.write(json.dumps({'ok': True, 'username': user.username, 'role': user.role,
                                      'active': user.is_active, 'sessions_ended': ended}))
