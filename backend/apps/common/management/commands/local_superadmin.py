"""Windows local edition: create (or repair) the Local Super Admin — the installation's own platform
owner who signs in at ``/#/super-admin/login`` and runs Client Management, offline, against this
installation's database.

Run on the server PC through ``gtrade-ctl create-superadmin`` (elevated prompt: only an Administrator
can read the installation secrets the command needs). Input is a JSON object on **stdin** — never
argv, so the password is not visible in process listings, logs or shell history::

    {"username": "...", "password": "...", "email": "...", "full_name": "..."}

``--status`` takes no input and prints who the Local Super Admin is (no passwords).
``--reset-password`` sets a new password for the EXISTING Local Super Admin (same username).

Rules (the same model as the cloud's ``bootstrap_admin``, which reads environment variables instead):
* Local edition only. The account is a Django superuser in tenant #1 (the installation owner's
  company) — apps.common.permissions.is_platform_owner.
* Idempotent: when a Local Super Admin already exists nothing is created (a second, different
  username is refused — there is exactly one); re-running with the same username reports
  "already exists" and changes nothing.
* Never promotes an existing account (a company administrator or a client's user).
* The password must pass Django's validators and is stored only as a hash (configured hasher).
* Every creation / reset is written to the security audit log; a reset ends open sessions.
"""

import json
import sys

from django.contrib.auth import get_user_model
from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from django.utils import timezone


def _owners():
    from apps.common.tenancy import DEFAULT_TENANT_ID, unscoped
    with unscoped():
        return list(get_user_model().objects.filter(is_superuser=True, tenant_id=DEFAULT_TENANT_ID)
                    .order_by('date_joined'))


class Command(BaseCommand):
    help = 'Create or repair the Local Super Admin of a G OPTICALS Windows installation (JSON on stdin).'

    def add_arguments(self, parser):
        parser.add_argument('--status', action='store_true', help='show the Local Super Admin (no passwords); change nothing')
        parser.add_argument('--reset-password', action='store_true',
                            help='set a new password for the existing Local Super Admin (same username)')

    def _fail(self, errors, message='invalid input'):
        self.stdout.write(json.dumps({'ok': False, 'errors': errors}))
        raise CommandError(message)

    def handle(self, *args, **options):
        from apps.common.edition import is_local
        if not is_local():
            raise CommandError('local_superadmin is only available in the Windows edition '
                               '(the cloud uses DJANGO_SUPERUSER_* + bootstrap_admin).')
        from apps.common.models import Tenant
        from apps.common.tenancy import DEFAULT_TENANT_ID

        if options['status']:
            owners = _owners()
            tenant = Tenant.objects.filter(pk=DEFAULT_TENANT_ID).first()
            self.stdout.write(json.dumps({
                'ok': True, 'exists': bool(owners),
                'installation_company': tenant.name if tenant else None,
                'super_admins': [{'username': u.username, 'active': u.is_active,
                                  'usable_password': u.has_usable_password(),
                                  'last_login': u.last_login.isoformat() if u.last_login else None} for u in owners],
                'sign_in_page': '/#/super-admin/login'}))
            return

        try:
            data = json.loads(sys.stdin.read() or '{}')
        except json.JSONDecodeError:
            raise CommandError('expected a JSON object on stdin')
        if not isinstance(data, dict):
            raise CommandError('expected a JSON object on stdin')
        username = (data.get('username') or '').strip()
        password = data.get('password') or ''
        email = (data.get('email') or '').strip() or None
        first, _, last = (data.get('full_name') or '').strip().partition(' ')
        if not username:
            self._fail({'username': 'Enter a user name for the Local Super Admin.'})
        if len(username) > 150 or any(c.isspace() for c in username):
            self._fail({'username': 'Use a user name without spaces (max 150 characters).'})

        User = get_user_model()
        from apps.common.tenancy import unscoped
        from apps.security.audit import log_event

        with transaction.atomic():
            tenant = Tenant.objects.select_for_update().filter(pk=DEFAULT_TENANT_ID).first()
            if tenant is None:
                raise CommandError('The installation database is not initialised (run gtrade-ctl migrate first).')
            owners = _owners()
            with unscoped():
                taken = User.objects.filter(username__iexact=username).first()

            if options['reset_password']:
                target = next((u for u in owners if u.username.lower() == username.lower()), None)
                if target is None:
                    self._fail({'username': f'"{username}" is not the Local Super Admin of this installation.'})
                try:
                    validate_password(password, user=target)
                except ValidationError as exc:
                    self._fail({'password': ' '.join(exc.messages)})
                from apps.security.models import AuthSession
                target.set_password(password)
                target.is_active = True
                target.save(update_fields=['password', 'is_active'])
                ended = (AuthSession.objects.filter(user=target, ended_at__isnull=True)
                         .update(ended_at=timezone.now(), end_reason='REVOKED'))
                log_event('LOCAL_SUPER_ADMIN_PASSWORD_RESET', 'AUTH',
                          f'Local Super Admin {target.username}: password reset on the server PC',
                          actor_name='server administrator (gtrade-ctl)',
                          details={'username': target.username, 'sessions_ended': ended}, severity='WARNING')
                self.stdout.write(json.dumps({'ok': True, 'created': False, 'reset': True,
                                              'username': target.username, 'sessions_ended': ended}))
                return

            if owners:
                same = next((u for u in owners if u.username.lower() == username.lower()), None)
                if same is not None:
                    # Idempotent re-run: nothing changes (use --reset-password to set a new password).
                    self.stdout.write(json.dumps({'ok': True, 'created': False, 'username': same.username,
                                                  'detail': 'The Local Super Admin already exists; nothing was changed.'}))
                    return
                self._fail({'username': f'This installation already has a Local Super Admin '
                                        f'("{owners[0].username}"). Use --reset-password for that account.'},
                           'super admin exists')
            if taken is not None:
                # Never turn an existing (company or client) account into the platform owner.
                self._fail({'username': f'The user name "{username}" is already used by another account. '
                                        'Choose a different name.'})
            candidate = User(username=username, email=email, first_name=first, last_name=last)
            try:
                validate_password(password, user=candidate)
            except ValidationError as exc:
                self._fail({'password': ' '.join(exc.messages)})
            user = User.objects.create_superuser(username=username, email=email, password=password,
                                                 tenant_id=DEFAULT_TENANT_ID, first_name=first[:150],
                                                 last_name=last.strip()[:150])
            log_event('LOCAL_SUPER_ADMIN_CREATED', 'AUTH',
                      f'Local Super Admin {user.username} created on the server PC',
                      actor_name='server administrator (gtrade-ctl)',
                      details={'username': user.username}, severity='WARNING')
        self.stdout.write(json.dumps({'ok': True, 'created': True, 'username': user.username,
                                      'sign_in_page': '/#/super-admin/login'}))
