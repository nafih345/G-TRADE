"""manage.py license <status|import|activate|checkin|request|update-allowed> - used by gtrade-ctl.

Secrets (the licence key) are read from stdin, never argv. Output is one JSON object.
"""

import json
import sys

from django.core.management.base import BaseCommand, CommandError

from apps.licensing import licfmt, service, state
from apps.licensing.enforcement import update_allowed


class Command(BaseCommand):
    help = 'Licence administration for the G-TRADE Windows edition'

    def add_arguments(self, parser):
        parser.add_argument('action', choices=['status', 'import', 'activate', 'checkin', 'request', 'update-allowed'])
        parser.add_argument('--file', help='licence file to import')
        parser.add_argument('--release-date', help='update-allowed: ISO date of the release')

    def handle(self, *args, **o):
        from apps.common.edition import is_local
        if not is_local():
            raise CommandError('licensing is only available in the G-TRADE Windows edition')
        act = o['action']
        try:
            if act == 'status':
                out = state.current(force=True).as_dict() | {'usage': service.usage(), 'install_id': state.install_id()}
            elif act == 'import':
                if not o['file']:
                    raise CommandError('--file is required')
                with open(o['file'], encoding='utf-8-sig') as fh:
                    out = service.install_blob(fh.read(), actor='gtrade-ctl', source='import').as_dict()
            elif act == 'activate':
                out = service.activate(sys.stdin.readline().strip(), actor='gtrade-ctl').as_dict()
            elif act == 'checkin':
                out = service.checkin(actor='gtrade-ctl').as_dict()
            elif act == 'request':
                out = service.offline_request(sys.stdin.readline().strip())
            else:
                ok, reason = update_allowed(o['release_date'])
                out = {'allowed': ok, 'reason': reason}
        except (licfmt.LicenseFormatError, service.LicenseServiceError) as exc:
            self.stdout.write(json.dumps({'ok': False, 'error': str(exc)}))
            raise CommandError(str(exc))
        self.stdout.write(json.dumps(out, default=str))
