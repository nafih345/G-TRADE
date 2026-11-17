"""Admin CLI for the vendor licensing service (run on the service host only).

    python -m gtrade_licensing --data DIR serve [--host 127.0.0.1 --port 8765]
    python -m gtrade_licensing --data DIR export-public-keys --out pubkeys.json
    python -m gtrade_licensing --data DIR create-key --customer "Shop" --edition PROFESSIONAL --type perpetual \
            --users 10 --companies 2 --branches-total 5 --branches-per-company 3 --updates-until 2027-11-12 [--valid-until ...]
    python -m gtrade_licensing --data DIR extend --lic L-2026-000001 [--valid-until ..] [--updates-until ..]
    python -m gtrade_licensing --data DIR revoke --lic L-2026-000001 --reason refund
    python -m gtrade_licensing --data DIR respond --request activation-request.gtr --out license.lic   (offline)
"""

import argparse
import json
import sys
from pathlib import Path

from .app import LicensingService
from .keys import from_environment


def _iso_day(text):
    return f'{text}T23:59:59+00:00' if text and len(text) == 10 else text


def main(argv=None):
    ap = argparse.ArgumentParser(prog='gtrade_licensing')
    ap.add_argument('--data', required=True)
    sub = ap.add_subparsers(dest='cmd', required=True)
    s = sub.add_parser('serve')
    s.add_argument('--host', default='127.0.0.1')
    s.add_argument('--port', type=int, default=8765)
    e = sub.add_parser('export-public-keys')
    e.add_argument('--out', required=True)
    c = sub.add_parser('create-key')
    c.add_argument('--customer', required=True)
    c.add_argument('--email', default='')
    c.add_argument('--edition', choices=['STANDARD', 'PROFESSIONAL', 'ENTERPRISE'], required=True)
    c.add_argument('--type', choices=['perpetual', 'subscription', 'trial'], required=True)
    c.add_argument('--deployment', choices=['STANDALONE', 'LAN'], default='LAN')
    c.add_argument('--users', type=int, required=True)
    c.add_argument('--companies', type=int, default=1)
    c.add_argument('--branches-total', type=int, default=1)
    c.add_argument('--branches-per-company', type=int, default=1)
    c.add_argument('--modules', help='comma-separated module keys (default: all)')
    c.add_argument('--valid-until')
    c.add_argument('--updates-until')
    c.add_argument('--grace-days', type=int, default=30)
    c.add_argument('--checkin-days', type=int)
    c.add_argument('--max-activations', type=int, default=2)
    x = sub.add_parser('extend')
    x.add_argument('--lic', required=True)
    x.add_argument('--valid-until')
    x.add_argument('--updates-until')
    r = sub.add_parser('revoke')
    r.add_argument('--lic', required=True)
    r.add_argument('--reason', required=True)
    o = sub.add_parser('respond')
    o.add_argument('--request', required=True)
    o.add_argument('--out', required=True)
    a = ap.parse_args(argv)

    svc = LicensingService(Path(a.data), from_environment(Path(a.data)))
    if a.cmd == 'serve':
        from waitress import serve
        print(f'licensing service on http://{a.host}:{a.port} (key {svc.keys.key_id})', flush=True)
        serve(svc, host=a.host, port=a.port, threads=4, ident='gtrade-licensing')
    elif a.cmd == 'export-public-keys':
        Path(a.out).write_text(json.dumps(svc.keys.public_keys(), indent=2))
        print(json.dumps({'written': a.out, 'key_ids': list(svc.keys.public_keys())}))
    elif a.cmd == 'create-key':
        limits = {'users': a.users, 'companies': a.companies, 'branches_total': a.branches_total,
                  'branches_per_company': a.branches_per_company}
        modules = [m.strip() for m in a.modules.split(',')] if a.modules else None
        key, lic_id = svc.store.create_key(customer=a.customer, email=a.email, edition=a.edition, type_=a.type,
                                           deployment=a.deployment, limits=limits, modules=modules,
                                           valid_until=_iso_day(a.valid_until), updates_until=_iso_day(a.updates_until),
                                           grace_days=a.grace_days,
                                           checkin_days=a.checkin_days or (30 if a.type == 'subscription' else None),
                                           max_activations=a.max_activations)
        # The key is shown ONCE; only its hash is stored.
        print(json.dumps({'lic_id': lic_id, 'license_key': key}))
    elif a.cmd == 'extend':
        svc.store.update_key(a.lic, valid_until=_iso_day(a.valid_until), updates_until=_iso_day(a.updates_until))
        print(json.dumps({'extended': a.lic}))
    elif a.cmd == 'revoke':
        from .store import now_iso
        svc.store.update_key(a.lic, revoked_at=now_iso(), revoke_reason=a.reason)
        print(json.dumps({'revoked': a.lic}))
    elif a.cmd == 'respond':
        req = json.loads(Path(a.request).read_text(encoding='utf-8-sig'))
        code, body = svc.activate(req, ip='offline')
        if code != 200:
            print(json.dumps(body))
            return 1
        Path(a.out).write_text(body['license'], encoding='ascii')
        print(json.dumps({'written': a.out}))
    return 0


if __name__ == '__main__':
    sys.exit(main())
