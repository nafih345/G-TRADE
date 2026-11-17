"""Interface-size (75/80/90/100 %) visual validation on the real staged SPA.

    cd windows && python -m tests.ui_scale_visual            (needs the staged app + Electron)

Installs a disposable Standalone stack (no services, no ACL changes, own PG cluster and ports),
seeds a realistic amount of data through the API, then runs tests/ui_scale_capture.js under
Electron once per Windows display scaling (100/125/150 % via --force-device-scale-factor) at
1366x768, 1440x900 and 1920x1080. Writes windows/out/evidence/ui_scale/ui_scale_report.json +
screenshots, and tears the stack down. Never touches the dev DB or the installed G OPTICALS.
"""

import json
import os
import re
import shutil
import ssl
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import zlib
from datetime import date
from pathlib import Path

from tests.stack import STAGE, Stack

WIN = Path(__file__).resolve().parents[1]
DESKTOP = WIN / 'desktop'
ELECTRON = DESKTOP / 'node_modules' / 'electron' / 'dist' / 'electron.exe'
OUT = WIN / 'out' / 'evidence' / 'ui_scale'
PORTS = dict(https_port=18473, app_port=18031, db_port=15574)
USER, PASS = 'uiowner', 'Gtrade-UiScale-Pass-2026!'
TODAY = date.today().isoformat()

ROUTES = ['/', '/inventory/products', '/inventory/stock-overview', '/purchase/entry', '/purchase/suppliers',
          '/sales/new', '/sales/orders', '/sales/customers', '/sales/reports', '/optical/eyetest',
          '/accounts/reports', '/settings']
SHOT_ROUTES = ['/', '/inventory/products', '/sales/new', '/sales/orders', '/purchase/entry', '/optical/eyetest']
RESOLUTIONS = [[1366, 768], [1440, 900], [1920, 1080]]
SCALES = [0.75, 0.8, 0.9, 1]
DPIS = [1, 1.25, 1.5]


class Api:
    def __init__(self, base, cafile):
        self.base, self.ctx, self.token = base, ssl.create_default_context(cafile=cafile), None

    def call(self, method, path, body=None):
        req = urllib.request.Request(self.base + path, data=json.dumps(body).encode() if body is not None else None,
                                     method=method)
        req.add_header('Content-Type', 'application/json')
        if self.token:
            req.add_header('Authorization', f'Bearer {self.token}')
        try:
            with urllib.request.urlopen(req, context=self.ctx, timeout=60) as r:
                return r.status, json.loads(r.read() or b'null')
        except urllib.error.HTTPError as e:
            return e.code, e.read()[:400]


def seed(api):
    ids = {'products': []}
    st, cat = api.call('POST', '/api/masters/categories/', {'name': 'Frames', 'code': 'FRM'})
    st, br = api.call('POST', '/api/masters/brands/', {'name': 'Visionline', 'code': 'VSL'})
    st, sup = api.call('POST', '/api/purchase/suppliers/', {'name': 'Coastal Optical Distributors Pvt Ltd', 'phone': '9876500000'})
    for i in range(1, 5):
        api.call('POST', '/api/purchase/suppliers/', {'name': f'Supplier {i} Lens Lab', 'phone': f'98765000{i:02d}'})
    for i in range(1, 31):
        st, p = api.call('POST', '/api/products/items/', {
            'name': f'Visionline Full Rim Acetate Frame Model {i:03d}', 'sku': f'VL-FR-{i:03d}', 'barcode': f'UIS{i:05d}',
            'category': cat['id'], 'brand': br['id'], 'cost_price': 250 + i, 'retail_price': 1000 + i * 10, 'stock': 0})
        if st == 201:
            ids['products'].append(p['id'])
    for i in range(1, 16):
        api.call('POST', '/api/sales/customers/', {'name': f'Customer Number {i:02d} Long Surname', 'phone': f'98765432{i:02d}'})
    items = [{'product': pid, 'quantity': 5, 'purchase_rate': 250, 'line_total': 1250} for pid in ids['products'][:10]]
    api.call('POST', '/api/purchase/invoices/', {
        'invoice_number': 'PE-UI-001', 'supplier': sup['id'], 'purchase_date': TODAY, 'purchase_type': 'CREDIT',
        'payment_method': 'CREDIT', 'status': 'CONFIRMED', 'grand_total': 12500, 'balance_amount': 12500, 'items': items})
    for i, pid in enumerate(ids['products'][:6]):
        api.call('POST', '/api/sales/invoices/', {
            'customer_name': f'Customer Number {i + 1:02d} Long Surname', 'invoice_date': TODAY, 'document_type': 'INVOICE',
            'total_amount': '1000', 'net_amount': '1000', 'paid_amount': '1000', 'payment_mode': 'CASH',
            'items': [{'product': pid, 'quantity': 1, 'unit_price': '1000', 'total': '1000'}]})
    return ids


def pdf_geometry(path: Path):
    """Filled-rectangle widths in the PDF content streams (identical geometry = identical print size)."""
    data, rects = path.read_bytes(), []
    for m in re.finditer(rb'stream\r?\n(.*?)\r?\nendstream', data, re.S):
        try:
            s = zlib.decompress(m.group(1))
        except zlib.error:
            continue
        rects += [round(float(r.group(1)), 2) for r in re.finditer(rb'[-\d.]+ [-\d.]+ ([-\d.]+) [-\d.]+ re', s)]
        rects += [round(float(c.group(1)), 4) for c in re.finditer(rb'([-\d.]+) 0 0 [-\d.]+ [-\d.]+ [-\d.]+ cm', s)]
    return sorted(set(rects))


def main():
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True)
    tmp = Path(tempfile.mkdtemp(prefix='gtrade-uiscale-'))
    stack = Stack(tmp / 'data', **PORTS)
    report = {'started': time.strftime('%Y-%m-%dT%H:%M:%S'), 'dpi_runs': {}}
    try:
        answers = tmp / 'answers.json'
        answers.write_text(json.dumps({'company_name': 'Lakeview Eye Care', 'branch_name': 'Town Centre',
                                       'admin_username': USER, 'admin_password': PASS,
                                       'admin_full_name': 'Store Owner', 'admin_email': 'owner@example.invalid'}))
        env = stack.env()
        env['GTRADE_CLIENT_DIR'] = str(tmp / 'client')
        proc = subprocess.run([str(stack.python), '-m', 'gtrade_ctl', '--install-root', str(STAGE),
                               '--data-root', str(stack.data_root), 'install', '--mode', 'standalone', '--version', '1.0.0',
                               '--https-port', str(PORTS['https_port']), '--app-port', str(PORTS['app_port']),
                               '--db-port', str(PORTS['db_port']), '--answers', str(answers),
                               '--no-services', '--no-firewall', '--no-acl'],
                              env=env, capture_output=True, text=True, timeout=1800, encoding='utf-8', errors='replace')
        if proc.returncode != 0:
            raise SystemExit(f'install failed {proc.returncode}: {proc.stdout[-1500:]} {proc.stderr[-1500:]}')
        stack.start_app()
        stack.start_web()
        stack.wait_health()
        api = Api(f'https://localhost:{PORTS["https_port"]}', str(stack.data_root / 'config' / 'tls' / 'ca.crt'))
        st, login = api.call('POST', '/api/auth/login/', {'username': USER, 'password': PASS})
        assert st == 200, login
        api.token = login['access']
        report['seeded_products'] = len(seed(api)['products'])
        cenv = {k: v for k, v in os.environ.items() if k != 'ELECTRON_RUN_AS_NODE'}
        for dpi in DPIS:
            cfg = {'baseUrl': api.base, 'username': USER, 'password': PASS, 'preload': str(DESKTOP / 'preload.js'),
                   'dpi': dpi, 'resolutions': RESOLUTIONS, 'scales': SCALES, 'routes': ROUTES, 'settleMs': 2200,
                   'dropdownRoutes': ['/sales/reports', '/inventory/stock-overview', '/accounts/reports'],
                   'shotRoutes': SHOT_ROUTES, 'outDir': str(OUT), 'out': str(tmp / f'cap_{dpi}.json'),
                   'shots': {'1366x768@1': SCALES, '1920x1080@1': [0.8, 1], '1366x768@1.25': [0.8],
                             '1920x1080@1.25': [0.8], '1366x768@1.5': [0.8, 1], '1920x1080@1.5': [0.8]}}
            cfg_file = tmp / f'cfg_{dpi}.json'
            cfg_file.write_text(json.dumps(cfg))
            t = time.monotonic()
            subprocess.run([str(ELECTRON), str(WIN / 'tests' / 'ui_scale_capture.js'), f'--config={cfg_file}',
                            f'--force-device-scale-factor={dpi}', f'--user-data-dir={tmp / f"ud{dpi}"}'],
                           env=cenv, timeout=3600, capture_output=True)
            res = json.loads(Path(cfg['out']).read_text())
            if not (res.get('login') or {}).get('header'):
                raise SystemExit(f'login through the form failed at dpi {dpi}: {res.get("login")}')
            bad = [r['route'] for r in res['runs'] if not (r.get('m') or {}).get('appShell')]
            if bad:
                raise SystemExit(f'{len(bad)} page loads were not the signed-in app (e.g. {bad[:3]})')
            res['seconds'] = round(time.monotonic() - t)
            res['print_geometry'] = {s: pdf_geometry(OUT / f) for s, f in res['print'].items()}
            report['dpi_runs'][str(dpi)] = res
            print(f'dpi {dpi}: {len(res["runs"])} page loads in {res["seconds"]} s', flush=True)
    finally:
        stack.down()
        shutil.rmtree(tmp, ignore_errors=True)
        (OUT / 'ui_scale_report.json').write_text(json.dumps(report, indent=1))
    return 0


if __name__ == '__main__':
    sys.exit(main())
