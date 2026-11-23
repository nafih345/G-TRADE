"""Helper for test_local_vendor_licensing_e2e: look at a REAL installation's licence on a future date.

    python lic_timetravel.py <data_root> <app_dir> <iso datetime> <username>

Runs inside the installation's own embedded Python against its own PostgreSQL database, with
django.utils.timezone.now pinned to the given moment, then drives the real middleware + API with
Django's test client as <username>. Everything happens in one transaction that is ROLLED BACK, so
the installation's clock-rollback guard (last_seen_utc) and data are left exactly as they were.
Prints one JSON line.
"""

import datetime as dt
import json
import sys
from pathlib import Path
from unittest import mock

data_root, app_dir, at, username = sys.argv[1:5]
sys.path.insert(0, str(Path(app_dir) / 'windows'))
from gtrade_server import load_environment  # noqa: E402

load_environment(Path(data_root))
sys.path.insert(0, str(Path(app_dir) / 'backend'))
import django  # noqa: E402

django.setup()
from django.contrib.auth import get_user_model  # noqa: E402
from django.db import transaction  # noqa: E402
from rest_framework.test import APIClient  # noqa: E402

from apps.licensing import state  # noqa: E402

moment = dt.datetime.fromisoformat(at)
out = {'at': at}
with transaction.atomic():
    with mock.patch('django.utils.timezone.now', return_value=moment):
        state.invalidate()
        v = state.current(force=True)
        out.update(status=v.status, read_only=v.read_only, message=v.message, days_left=v.days_left,
                   lic_id=v.lic_id, revision=v.revision, expires_on=v.expires_on)
        api = APIClient(HTTP_HOST='localhost')
        api.force_authenticate(get_user_model().objects.get(username=username))
        r = api.post('/api/masters/brands/', {'name': f'Time travel {at[:10]}', 'code': 'TT' + at[5:10].replace('-', '')},
                     format='json')
        out['write_status'] = r.status_code
        r = api.get('/api/masters/brands/')
        out['read_status'] = r.status_code
        # The data itself, straight from the installation's database (every company).
        from apps.common import tenancy
        from apps.masters.models import Brand
        with tenancy.unscoped():
            out['brands'] = sorted(Brand.objects.values_list('name', flat=True))
        out['active_users'] = get_user_model().objects.filter(is_active=True).count()
    transaction.set_rollback(True)
state.invalidate()
print(json.dumps(out, default=str))
