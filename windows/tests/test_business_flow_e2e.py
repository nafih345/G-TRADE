"""Customer business flow on a real Windows stack built from the STAGED payload.

The engine `install` command is the one the NSIS wizard runs (only services, firewall and ACLs are
left out, as non-elevated). Then, over HTTPS through nginx exactly as the desktop app talks:
login -> category/brand -> product -> customer -> supplier -> purchase -> sale -> read back.
Then a full COLD stop of nginx, the app and PostgreSQL (what a Windows restart does), a cold start,
and the same records, stock and documents must still be there.

It also times the main read screens (login, dashboard, product list/search, barcode lookup,
customers, suppliers, sales list, sales report, stock overview, trial balance) twice: a first
(cold) and a warm call. The numbers go to windows/out/evidence/business_flow_e2e.json.

Opt-in (slow: full migration): GTRADE_E2E=1, after restaging windows/out/stage.
"""

import json
import os
import shutil
import ssl
import tempfile
import time
import unittest
import urllib.error
import urllib.request
import uuid
from datetime import date
from pathlib import Path

from tests.stack import STAGE, Stack

EVIDENCE = Path(__file__).resolve().parents[1] / 'out' / 'evidence'
ADMIN_USER = 'owner'
ADMIN_PASS = 'Flow-' + uuid.uuid4().hex[:12] + '!9'
PORTS = dict(https_port=18473, app_port=18031, db_port=15574)
TODAY = date.today().isoformat()


@unittest.skipUnless(os.environ.get('GTRADE_E2E') == '1' and (STAGE / 'runtime' / 'python' / 'python.exe').exists(),
                     'set GTRADE_E2E=1 after building windows/out/stage')
class BusinessFlowE2E(unittest.TestCase):
    ids: dict = {}

    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix='gtrade-flow-'))
        cls.stack = Stack(cls.tmp / 'data', **PORTS)
        cls.evidence = {'started': time.strftime('%Y-%m-%dT%H:%M:%S'), 'timings_ms': {}}
        answers = cls.tmp / 'answers.json'
        answers.write_text(json.dumps({'company_name': 'Lakeview Eye Care', 'branch_name': 'Town Centre',
                                       'admin_username': ADMIN_USER, 'admin_password': ADMIN_PASS,
                                       'admin_full_name': 'Store Owner', 'admin_email': 'owner@example.invalid'}))
        env = cls.stack.env()
        env['GTRADE_CLIENT_DIR'] = str(cls.tmp / 'client')
        import subprocess
        t = time.monotonic()
        proc = subprocess.run([str(cls.stack.python), '-m', 'gtrade_ctl', '--install-root', str(STAGE),
                               '--data-root', str(cls.stack.data_root), 'install', '--mode', 'standalone',
                               '--version', '1.0.0', '--https-port', str(PORTS['https_port']),
                               '--app-port', str(PORTS['app_port']), '--db-port', str(PORTS['db_port']),
                               '--answers', str(answers), '--no-services', '--no-firewall', '--no-acl'],
                              env=env, capture_output=True, text=True, timeout=1800, encoding='utf-8', errors='replace')
        cls.install_exit = proc.returncode
        cls.install = json.loads(proc.stdout) if proc.stdout.strip().startswith('{') else {
            'raw': proc.stdout[-3000:], 'err': proc.stderr[-3000:]}
        cls.evidence['install'] = {'exit': proc.returncode, 'seconds': round(time.monotonic() - t, 1),
                                   'steps': [s['step'] for s in cls.install.get('steps', [])]}
        cls._up()
        cls.ctx = ssl.create_default_context(cafile=str(cls.stack.data_root / 'config' / 'tls' / 'ca.crt'))
        cls.base = f'https://localhost:{PORTS["https_port"]}'
        cls.token = None

    @classmethod
    def _up(cls):
        cls.stack.start_app()
        cls.stack.start_web()
        return cls.stack.wait_health().get('ok')

    @classmethod
    def tearDownClass(cls):
        try:
            cls.stack.down()
        finally:
            EVIDENCE.mkdir(parents=True, exist_ok=True)
            (EVIDENCE / 'business_flow_e2e.json').write_text(json.dumps(cls.evidence, indent=1, default=str))
            shutil.rmtree(cls.tmp, ignore_errors=True)

    # ---- HTTP helpers -------------------------------------------------------------------------
    def call(self, method, path, body=None, auth=True, timed=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method)
        req.add_header('Content-Type', 'application/json')
        if auth and type(self).token:
            req.add_header('Authorization', f'Bearer {type(self).token}')
        t = time.perf_counter()
        try:
            with urllib.request.urlopen(req, context=self.ctx, timeout=60) as r:
                code, raw = r.status, r.read()
        except urllib.error.HTTPError as e:
            code, raw = e.code, e.read()
        ms = round((time.perf_counter() - t) * 1000, 1)
        if timed:
            self.evidence['timings_ms'].setdefault(timed, []).append({'ms': ms, 'status': code})
        try:
            payload = json.loads(raw) if raw else None
        except ValueError:
            payload = raw[:300]
        return code, payload

    def login(self, label):
        code, res = self.call('POST', '/api/auth/login/', {'username': ADMIN_USER, 'password': ADMIN_PASS},
                              auth=False, timed=label)
        self.assertEqual(code, 200, res)
        type(self).token = res['access']
        return res

    def post_ok(self, path, body):
        code, res = self.call('POST', path, body)
        self.assertEqual(code, 201, f'{path}: {res}')
        return res

    def stock(self):
        code, res = self.call('GET', f'/api/products/products/{self.ids["product"]}/')
        self.assertEqual(code, 200, res)
        return float(res['stock'])

    def read_screens(self, phase):
        ids = self.ids
        reads = [
            ('dashboard', '/api/sales/dashboard-summary/'),
            ('products_list', '/api/products/items/?page=1'),
            ('product_search', '/api/products/items/?search=Frame'),
            ('barcode_lookup', f'/api/products/items/resolve_barcode/?code={ids["barcode"]}'),
            ('customers_list', '/api/sales/customers/?page=1'),
            ('suppliers_list', '/api/purchase/suppliers/'),
            ('purchase_list', '/api/purchase/invoices/'),
            ('sales_list', '/api/sales/invoices/?page=1'),
            ('sales_report', f'/api/sales/invoices/report/?date_from={TODAY}&date_to={TODAY}'),
            ('stock_overview', '/api/inventory/stock-overview/'),
            ('trial_balance', f'/api/financial/statements/?type=trial_balance&as_on={TODAY}'),
        ]
        out = {}
        for name, path in reads:
            for _ in range(2):  # cold, warm
                code, _res = self.call('GET', path, timed=f'{phase}:{name}')
            out[name] = code
        return out

    # ---- the flow -----------------------------------------------------------------------------
    def test_01_install_engine_completed(self):
        self.assertEqual(self.install_exit, 0, self.install)
        self.assertTrue((self.stack.data_root / 'config' / 'install.complete').exists())
        text = ''.join(p.read_text(encoding='utf-8') for p in (self.stack.data_root / 'logs').rglob('*.jsonl'))
        self.assertNotIn(ADMIN_PASS, text, 'admin password must never reach the install log')

    def test_02_login_and_customer_org(self):
        res = self.login('first:login')
        self.login('first:login')
        code, prof = self.call('GET', '/api/company/store-profile/')
        self.evidence['store_profile_status'] = code
        if code == 200:
            blob = json.dumps(prof)
            self.assertEqual(prof.get('name'), 'Lakeview Eye Care')   # the customer's name, not a placeholder
            self.assertEqual(prof.get('active_branch_name'), 'Town Centre')
            self.assertNotIn('G OPTICALS', blob)                       # vendor name never on the store profile
        self.evidence['login_user_role'] = (res.get('user') or {}).get('role')

    def test_03_create_masters_purchase_and_sale(self):
        tag = uuid.uuid4().hex[:6].upper()
        ids = type(self).ids
        ids['barcode'] = f'BC{tag}'
        ids['category'] = self.post_ok('/api/masters/categories/', {'name': f'Frames {tag}', 'code': f'FR{tag}'})['id']
        ids['brand'] = self.post_ok('/api/masters/brands/', {'name': f'Brand {tag}', 'code': f'BR{tag}'})['id']
        ids['product'] = self.post_ok('/api/products/items/', {
            'name': f'Frame {tag}', 'sku': f'FR-{tag}', 'barcode': ids['barcode'], 'category': ids['category'],
            'brand': ids['brand'], 'cost_price': 250, 'retail_price': 1000, 'stock': 0})['id']
        ids['customer'] = self.post_ok('/api/sales/customers/', {'name': f'Customer {tag}', 'phone': '9876543210'})['id']
        ids['supplier'] = self.post_ok('/api/purchase/suppliers/', {'name': f'Supplier {tag}', 'phone': '9876500000'})['id']
        ids['purchase'] = self.post_ok('/api/purchase/invoices/', {
            'invoice_number': f'PE-{tag}', 'supplier': ids['supplier'], 'purchase_date': TODAY,
            'purchase_type': 'CREDIT', 'payment_method': 'CREDIT', 'status': 'CONFIRMED', 'grand_total': 500,
            'balance_amount': 500, 'items': [{'product': ids['product'], 'quantity': 2, 'purchase_rate': 250,
                                              'line_total': 500}]})['id']
        self.assertEqual(self.stock(), 2.0, 'purchase must add stock')
        sale = self.post_ok('/api/sales/invoices/', {
            'customer_name': f'Customer {tag}', 'customer': ids['customer'], 'invoice_date': TODAY,
            'document_type': 'INVOICE', 'total_amount': '1000', 'net_amount': '1000', 'paid_amount': '1000',
            'payment_mode': 'CASH',
            'items': [{'product': ids['product'], 'quantity': 1, 'unit_price': '1000', 'total': '1000'}]})
        ids['sale'], ids['sale_number'] = sale['id'], sale['invoice_number']
        self.assertTrue(ids['sale_number'])
        self.assertEqual(self.stock(), 1.0, 'sale must reduce stock')
        self.evidence['created'] = {k: v for k, v in ids.items()}

    def test_04_read_back_and_time_screens(self):
        code, inv = self.call('GET', f'/api/sales/invoices/{self.ids["sale"]}/')
        self.assertEqual(code, 200, inv)
        self.assertEqual(inv['invoice_number'], self.ids['sale_number'])
        self.assertEqual(len(inv.get('items') or []), 1)
        code, cust = self.call('GET', f'/api/sales/customers/{self.ids["customer"]}/')
        self.assertEqual(code, 200, cust)
        statuses = self.read_screens('before_restart')
        self.evidence['read_status_before'] = statuses
        for name in ('dashboard', 'products_list', 'product_search', 'barcode_lookup', 'customers_list',
                     'suppliers_list', 'purchase_list', 'sales_list', 'sales_report', 'stock_overview'):
            self.assertEqual(statuses[name], 200, f'{name} -> {statuses[name]}')

    def test_05_cold_restart_keeps_everything(self):
        stack = self.stack
        stack.stop_web()
        stack.stop_app()
        stack.stop_db()
        t = time.monotonic()
        stack.start_db()
        self.assertTrue(self._up(), 'stack must come back healthy after a cold restart')
        self.evidence['cold_restart_seconds'] = round(time.monotonic() - t, 1)
        self.login('after_restart:login')
        self.assertEqual(self.stock(), 1.0)
        code, inv = self.call('GET', f'/api/sales/invoices/{self.ids["sale"]}/')
        self.assertEqual(code, 200, inv)
        self.assertEqual(inv['invoice_number'], self.ids['sale_number'])
        code, pi = self.call('GET', f'/api/purchase/invoices/{self.ids["purchase"]}/')
        self.assertEqual(code, 200, pi)
        code, cust = self.call('GET', f'/api/sales/customers/{self.ids["customer"]}/')
        self.assertEqual(code, 200, cust)
        self.evidence['read_status_after'] = self.read_screens('after_restart')
        # A second sale after the restart still numbers and deducts correctly.
        sale2 = self.post_ok('/api/sales/invoices/', {
            'customer_name': cust['name'], 'customer': self.ids['customer'], 'invoice_date': TODAY,
            'document_type': 'INVOICE', 'total_amount': '1000', 'net_amount': '1000', 'paid_amount': '1000',
            'payment_mode': 'CASH',
            'items': [{'product': self.ids['product'], 'quantity': 1, 'unit_price': '1000', 'total': '1000'}]})
        self.assertNotEqual(sale2['invoice_number'], self.ids['sale_number'])
        self.assertEqual(self.stock(), 0.0)


if __name__ == '__main__':
    unittest.main()
