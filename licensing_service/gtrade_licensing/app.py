"""WSGI application: POST /v1/activate, /v1/checkin, /v1/deactivate; GET /v1/crl, /v1/health.

There is deliberately no admin HTTP API: keys are issued, extended and revoked with the admin CLI
(`python -m gtrade_licensing ...`) on the service host. Requests are size-limited and rate-limited
per client address.
"""

from __future__ import annotations

import datetime as dt
import json
import threading
import time
from pathlib import Path

from . import format as fmt
from .store import Store, now_iso

MAX_BODY = 32 * 1024
RATE_PER_MIN = 30


class LicensingService:
    def __init__(self, data_dir: Path, key_provider):
        self.store = Store(Path(data_dir) / 'licensing.sqlite3')
        self.keys = key_provider
        self._hits: dict[str, list[float]] = {}
        self._lock = threading.Lock()

    # ---- signing helpers -------------------------------------------------------------------------
    def sign_license(self, key_row, activation_id, install_id, fp_hashes) -> str:
        payload = {
            'lic_id': key_row['lic_id'], 'activation_id': activation_id, 'install_id': install_id,
            'key_id': self.keys.key_id, 'customer': {'name': key_row['customer'], 'email_hash': key_row['email_hash']},
            'edition': key_row['edition'], 'deployment': key_row['deployment'], 'type': key_row['type'],
            'limits': json.loads(key_row['limits']),
            'modules': json.loads(key_row['modules']) if key_row['modules'] else None,
            'issued_at': now_iso(), 'valid_until': key_row['valid_until'], 'updates_until': key_row['updates_until'],
            'grace_days': key_row['grace_days'], 'checkin_days': key_row['checkin_days'],
            'fp': {'v': 1, 'hashes': fp_hashes, 'tolerance': 2},
        }
        return fmt.encode(payload, fmt.LICENSE_PREFIX, self.keys.sign)

    def crl(self) -> str:
        return fmt.encode({'key_id': self.keys.key_id, 'issued_at': now_iso(), 'revoked': self.store.revoked()},
                          fmt.CRL_PREFIX, self.keys.sign)

    # ---- operations ------------------------------------------------------------------------------
    def activate(self, body: dict, ip='') -> tuple[int, dict]:
        key = str(body.get('key') or '')
        install_id = str(body.get('install_id') or '')
        fp = ((body.get('fp') or {}).get('hashes')) or {}
        if not key or not install_id or not isinstance(fp, dict) or not fp:
            return 400, {'error': 'key, install_id and machine fingerprint are required'}
        row = self.store.find_key(key)
        if row is None:
            self.store.log('activate_unknown_key', ip=ip)
            return 404, {'error': 'Unknown licence key.'}
        if row['revoked_at']:
            return 403, {'error': 'This licence key has been revoked.'}
        if row['valid_until'] and dt.datetime.fromisoformat(row['valid_until']) < dt.datetime.now(dt.timezone.utc):
            return 403, {'error': 'This licence key has expired. Renew it first.'}
        active = self.store.activations(row)
        same = next((a for a in active if a['install_id'] == install_id), None)
        if same is not None:
            aid = same['activation_id']
            self.store.touch_activation(aid, fp=fp)
        else:
            if len(active) >= row['max_activations']:
                return 409, {'error': f'This key is already active on {len(active)} installation(s). Deactivate the old '
                                      'server first or ask the vendor for a transfer.'}
            aid = self.store.add_activation(row, install_id, fp, ip)
        self.store.log('activated', lic_id=row['lic_id'], activation_id=aid, install_id=install_id, ip=ip)
        return 200, {'license': self.sign_license(row, aid, install_id, fp), 'crl': self.crl()}

    def checkin(self, body: dict, ip='') -> tuple[int, dict]:
        act = self.store.activation(str(body.get('activation_id') or ''))
        if act is None or act['install_id'] != body.get('install_id'):
            return 404, {'error': 'Unknown activation.'}
        row = self.store.key_by_lic(str(body.get('lic_id') or ''))
        if row is None or row['id'] != act['key_id']:
            return 404, {'error': 'Unknown licence.'}
        fp = ((body.get('fp') or {}).get('hashes')) or {}
        old = json.loads(act['fp'])
        changed = sum(1 for k, v in old.items() if fp.get(k) != v)
        if changed > 2:
            self.store.log('clone_suspected', lic_id=row['lic_id'], activation_id=act['activation_id'], changed=changed, ip=ip)
        if not act['active']:
            return 403, {'error': 'This activation was deactivated.', 'crl': self.crl()}
        self.store.touch_activation(act['activation_id'], fp=fp if changed <= 2 else None)
        out = {'crl': self.crl()}
        if not row['revoked_at']:
            out['license'] = self.sign_license(row, act['activation_id'], act['install_id'], fp if changed <= 2 else old)
        self.store.log('checkin', lic_id=row['lic_id'], activation_id=act['activation_id'], ip=ip)
        return 200, out

    def deactivate(self, body: dict, ip='') -> tuple[int, dict]:
        act = self.store.activation(str(body.get('activation_id') or ''))
        if act is None or act['install_id'] != body.get('install_id'):
            return 404, {'error': 'Unknown activation.'}
        self.store.touch_activation(act['activation_id'], active=0)
        self.store.log('deactivated', activation_id=act['activation_id'], ip=ip)
        return 200, {'deactivated': act['activation_id']}

    # ---- WSGI ------------------------------------------------------------------------------------
    def _rate_limited(self, ip: str) -> bool:
        now = time.monotonic()
        with self._lock:
            hits = [t for t in self._hits.get(ip, []) if now - t < 60]
            hits.append(now)
            self._hits[ip] = hits
            return len(hits) > RATE_PER_MIN

    def __call__(self, environ, start_response):
        method, path = environ['REQUEST_METHOD'], environ.get('PATH_INFO', '')
        ip = environ.get('REMOTE_ADDR', '')

        def reply(code, obj):
            body = json.dumps(obj).encode()
            reason = {200: 'OK', 400: 'Bad Request', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed',
                      409: 'Conflict', 413: 'Payload Too Large', 429: 'Too Many Requests'}.get(code, 'Error')
            start_response(f'{code} {reason}', [('Content-Type', 'application/json'), ('Content-Length', str(len(body))),
                                                ('Cache-Control', 'no-store')])
            return [body]

        if path == '/v1/health' and method == 'GET':
            return reply(200, {'status': 'ok', 'key_id': self.keys.key_id})
        if path == '/v1/crl' and method == 'GET':
            return reply(200, {'crl': self.crl()})
        routes = {'/v1/activate': self.activate, '/v1/checkin': self.checkin, '/v1/deactivate': self.deactivate}
        if path not in routes:
            return reply(404, {'error': 'not found'})
        if method != 'POST':
            return reply(405, {'error': 'POST only'})
        if self._rate_limited(ip):
            return reply(429, {'error': 'Too many requests; try again in a minute.'})
        length = int(environ.get('CONTENT_LENGTH') or 0)
        if length > MAX_BODY:
            return reply(413, {'error': 'request too large'})
        try:
            body = json.loads(environ['wsgi.input'].read(length) or b'{}')
            if not isinstance(body, dict):
                raise ValueError
        except ValueError:
            return reply(400, {'error': 'invalid JSON'})
        code, obj = routes[path](body, ip)
        return reply(code, obj)
