"""Tenant isolation across every module, not just the hand-picked ones in tests_tenant_crud.

Same real stack as tests_tenant_crud (login → signed JWT → tenant middleware → DRF, anonymous
tenant off). Three layers:

  * ModuleCrudTests — each client creates the records of the remaining modules (service, eye
    exam, appointment, stock adjustment, expense / receipt vouchers, store profile) and sees
    exactly its own.
  * LeakSweepTests — every parameter-free GET endpoint in the URLconf is called as Client B
    after Client A filled its books; no response may mention A's records (ids or a marker in
    their names), and none may crash. Every ViewSet's detail route refuses A's rows to B.
    New endpoints are covered automatically.
"""
import json
import re

from django.urls import URLPattern, URLResolver, get_resolver

from apps.common import tenancy
from apps.common.tests_tenant_crud import TODAY, TenantFixture, rows

MARKER = 'Qzalpha'  # in the names of everything Client A creates; must never reach Client B

# GETs that are not "read this tenant's data": platform console (separate gate, tested in
# tests_superadmin*), whole-database backups (disabled with >1 tenant), session plumbing.
SKIP_PREFIXES = ('/api/superadmin/', '/api/backups/', '/api/auth/logout', '/api/security/session/',
                 '/admin/', '/media/')


def _join(prefix, pattern):
    raw = str(pattern.pattern)
    raw = raw.lstrip('^').rstrip('$')
    return prefix + raw


def list_routes():
    """(path, viewset_class_or_None) for every URL with no path parameters."""
    found = []

    def walk(patterns, prefix):
        for p in patterns:
            path = _join(prefix, p)
            if isinstance(p, URLResolver):
                walk(p.url_patterns, path)
            elif isinstance(p, URLPattern):
                if '(?P' in path or '<' in path or '\\' in path or '(' in path:
                    continue
                if not path.startswith('api/'):
                    continue
                cb = p.callback
                actions = getattr(cb, 'actions', None) or {}
                cls = getattr(cb, 'cls', None)
                if actions and actions.get('get') != 'list':
                    continue  # a router route without parameters that isn't the list
                found.append(('/' + path, cls if actions else None))

    walk(get_resolver().url_patterns, '')
    return sorted(set(found), key=lambda r: r[0])


class ModuleFixture(TenantFixture):
    def create_modules(self, client, tag):
        """Records of the modules tests_tenant_crud.create_set does not cover."""
        ids = self.create_set(client, tag)
        res = self.call(client, 'post', '/api/sales/services/', {
            'name': f'Eye test {tag}', 'service_code': f'SV{tag[:4]}', 'default_price': '150'})
        self.assertEqual(res.status_code, 201, res.data)
        ids['service'] = res.data['id']
        patient_code = client.get(f"/api/sales/customers/{ids['customer']}/").data.get('patient_code') or f'P-{tag}'
        res = self.call(client, 'post', '/api/sales/eye-examinations/', {
            'customer': ids['customer'], 'patient_id': patient_code, 'patient_name': f'Customer {tag}',
            'primary_diagnosis': f'Myopia {tag}',
            'sub_sph_od': '-1.00'})
        self.assertEqual(res.status_code, 201, res.data)
        ids['exam'] = res.data['id']
        res = self.call(client, 'post', '/api/sales/appointments/', {
            'customer': ids['customer'], 'patient_name': f'Customer {tag}', 'appointment_date': TODAY,
            'phone': '9876543210'})
        self.assertEqual(res.status_code, 201, res.data)
        ids['appointment'] = res.data['id']
        wh = rows(client.get('/api/company/warehouses/').data)[0]['id']
        res = self.call(client, 'post', '/api/inventory/adjustments/', {
            'product': ids['product'], 'warehouse': wh, 'quantity': 5, 'adjustment_type': 'ADD',
            'reason': f'Found in store {tag}'})
        self.assertEqual(res.status_code, 201, res.data)
        ids['adjustment'] = res.data['id']
        # Expense: Shop rent (5100) paid in cash (1001) — codes resolve in the caller's own books.
        res = self.call(client, 'post', '/api/financial/journals/', {
            'voucher_type_code': 'PV', 'date': TODAY, 'narration': f'Shop rent {tag}',
            'lines': [{'account': '5100', 'debit': '700', 'memo': f'Rent {tag}'},
                      {'account': '1001', 'credit': '700', 'memo': 'Cash'}]})
        self.assertEqual(res.status_code, 201, res.data)
        ids['expense'] = res.data['id']
        res = self.call(client, 'post', '/api/financial/journals/', {
            'voucher_type_code': 'RV', 'date': TODAY, 'narration': f'Old dues {tag}',
            'lines': [{'account': '1001', 'debit': '300', 'memo': 'Cash'},
                      {'account': '4003', 'credit': '300', 'memo': f'Income {tag}'}]})
        self.assertEqual(res.status_code, 201, res.data)
        ids['receipt'] = res.data['id']
        res = self.call(client, 'put', '/api/company/store-profile/', {
            'name': f'Store {tag}', 'phone': '9847012345', 'city': 'Kochi', 'country': 'India'})
        self.assertEqual(res.status_code, 200, res.data)
        return ids


class ModuleCrudTests(ModuleFixture):
    def test_each_client_creates_every_module_record(self):
        made = {'A': self.create_modules(self.a, f'A{MARKER}'), 'B': self.create_modules(self.b, 'Bravo')}
        for client, tag, other in ((self.a, 'A', 'B'), (self.b, 'B', 'A')):
            mine, theirs = made[tag], made[other]
            for key, path in (('service', '/api/sales/services/'), ('exam', '/api/sales/eye-examinations/'),
                              ('appointment', '/api/sales/appointments/'),
                              ('adjustment', '/api/inventory/adjustments/'),
                              ('expense', '/api/financial/journals/'), ('receipt', '/api/financial/journals/')):
                listed = {r['id'] for r in rows(client.get(path, {'page_size': 500}).data)}
                self.assertIn(mine[key], listed, f'{tag} {key}')
                self.assertNotIn(theirs[key], listed, f'{tag} sees {other} {key}')
            profile = client.get('/api/company/store-profile/').data
            self.assertTrue(profile['name'].startswith(f'Store {tag}'), profile['name'])
            # The adjustment moved this client's stock only: +2 purchase −1 sale +5 found.
            self.assertEqual(client.get(f"/api/products/items/{mine['product']}/").data['stock'], 6)
            status = client.get('/api/financial/integration/status/').data
            self.assertEqual(status['open_failures'], 0, status)
            self.assertTrue(status['ledger_balanced'])
        # The expense posted to each client's own 5100, never the other's.
        from apps.financial.models import JournalEntry
        with tenancy.unscoped():
            for tag, tenant in (('A', self.ta), ('B', self.tb)):
                entry = JournalEntry.objects.get(pk=made[tag]['expense'])
                self.assertEqual(entry.tenant_id, tenant.pk)
                self.assertEqual({l.account.tenant_id for l in entry.lines.all()}, {tenant.pk})

    def test_update_and_delete_module_records(self):
        ids = self.create_modules(self.a, 'A')
        res = self.call(self.a, 'patch', f"/api/sales/services/{ids['service']}/", {'default_price': '200'})
        self.assertEqual(res.status_code, 200, res.data)
        self.assertEqual(str(res.data['default_price']), '200.00')
        res = self.call(self.a, 'patch', f"/api/sales/appointments/{ids['appointment']}/", {'phone': '9000000001'})
        self.assertEqual(res.status_code, 200, res.data)
        res = self.call(self.a, 'delete', f"/api/sales/services/{ids['service']}/")
        self.assertIn(res.status_code, (200, 204), getattr(res, 'data', None))
        self.assertNotIn(ids['service'], {r['id'] for r in rows(self.a.get('/api/sales/services/').data)})

    def test_validation_errors_are_400_with_reasons(self):
        """Bad input answers 400 with field messages the screen can show — never 500, never 201."""
        for path, body in (('/api/sales/customers/', {}), ('/api/products/items/', {'retail_price': 'abc'}),
                           ('/api/masters/brands/', {'code': 'X'}), ('/api/sales/services/', {}),
                           ('/api/financial/journals/', {'voucher_type_code': 'PV', 'date': TODAY,
                                                         'lines': [{'account': '5100', 'debit': '1'}]})):
            res = self.call(self.a, 'post', path, body)
            self.assertEqual(res.status_code, 400, (path, res.status_code, getattr(res, 'data', None)))
            self.assertTrue(res.data, path)


class LeakSweepTests(ModuleFixture):
    def setUp(self):
        super().setUp()
        self.ids_a = self.create_modules(self.a, f'A{MARKER}')
        self.create_modules(self.b, 'Bravo')
        self.routes = list_routes()

    def test_route_discovery_finds_the_api(self):
        paths = {p for p, _ in self.routes}
        for p in ('/api/products/items/', '/api/sales/invoices/', '/api/financial/journals/',
                  '/api/financial/reports/cashbook/', '/api/inventory/adjustments/'):
            self.assertIn(p, paths)
        self.assertGreater(len(self.routes), 100)

    def test_no_endpoint_shows_client_a_data_to_client_b(self):
        needles = [MARKER.lower()] + [str(v).lower() for v in self.ids_a.values()]
        leaks, crashes, checked = [], [], 0
        for path, _ in self.routes:
            if path.startswith(SKIP_PREFIXES):
                continue
            res = self.b.get(path)
            checked += 1
            if res.status_code >= 500:
                crashes.append(f'{path} → {res.status_code}')
                continue
            ctype = res.get('Content-Type', '')
            if 'json' not in ctype and 'text' not in ctype:
                continue
            body = res.content.decode('utf-8', 'replace').lower()
            hit = [n for n in needles if n in body]
            if hit:
                leaks.append(f'{path}: {hit[:3]}')
        print(f'\n[leak sweep: {checked} GET endpoints checked as Client B]')
        self.assertEqual(crashes, [], 'endpoints crashed:\n' + '\n'.join(crashes))
        self.assertEqual(leaks, [], "Client A's data reached Client B:\n" + '\n'.join(leaks))

    def test_client_a_sees_its_own_marker(self):
        """Sanity check for the sweep: the marker really is in A's responses."""
        body = self.a.get('/api/sales/customers/').content.decode().lower()
        self.assertIn(MARKER.lower(), body)

    def test_every_viewset_refuses_other_clients_rows(self):
        refused, wrong, checked = 0, [], 0
        for path, cls in self.routes:
            if cls is None or path.startswith(SKIP_PREFIXES):
                continue
            res = self.a.get(path, {'page_size': 50})
            if res.status_code != 200:
                continue
            data = rows(res.data)
            if not isinstance(data, list):
                continue
            for row in data[:3]:
                if not isinstance(row, dict) or 'id' not in row:
                    continue
                checked += 1
                detail = f"{path}{row['id']}/"
                for method, body in (('get', None), ('patch', {'name': 'hijacked', 'changes': {'name': 'hijacked'}}), ('delete', None)):
                    r = self.call(self.b, method, detail, body)
                    if r.status_code in (404, 403, 405):
                        refused += 1
                    else:
                        wrong.append(f'{method.upper()} {detail} → {r.status_code}')
        print(f'\n[detail sweep: {checked} of Client A\'s rows, {refused} cross-client calls refused]')
        self.assertGreater(checked, 20)
        self.assertEqual(wrong, [], 'Client B reached Client A rows:\n' + '\n'.join(wrong))
        # A's rows are untouched.
        self.assertEqual(self.a.get(f"/api/sales/customers/{self.ids_a['customer']}/").status_code, 200)

    def test_client_a_endpoints_do_not_crash(self):
        crashes = []
        for path, _ in self.routes:
            if path.startswith(SKIP_PREFIXES):
                continue
            res = self.a.get(path)
            if res.status_code >= 500:
                crashes.append(f'{path} → {res.status_code}')
        self.assertEqual(crashes, [], '\n'.join(crashes))
