import base64
import io
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from gtrade_licensing import format as fmt  # noqa: E402
from gtrade_licensing.app import LicensingService  # noqa: E402
from gtrade_licensing.keys import DevFileKeyProvider, KeyProviderError  # noqa: E402

FP = {'machine_guid': 'sha256:aa', 'volume': 'sha256:bb', 'bios_uuid': 'sha256:cc', 'cpu': 'sha256:dd', 'mac': 'sha256:ee'}


def verify(blob, prefix, pub):
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
    head, body, sig = blob.split('.')
    assert head == prefix
    Ed25519PublicKey.from_public_bytes(base64.b64decode(pub)).verify(fmt.b64u_decode(sig), f'{head}.{body}'.encode())
    return json.loads(fmt.b64u_decode(body))


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.svc = LicensingService(self.tmp, DevFileKeyProvider(self.tmp / 'k.pem'))
        self.pub = self.svc.keys.public_keys()['gtl-dev-1']
        self.key, self.lic = self.svc.store.create_key(customer='Sunrise', edition='PROFESSIONAL', type_='perpetual',
                                                       limits={'users': 5, 'companies': 2}, updates_until='2027-11-12T23:59:59+00:00')

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_key_only_stored_as_hash(self):
        raw = (self.tmp / 'licensing.sqlite3').read_bytes()
        self.assertNotIn(self.key.encode(), raw)
        self.assertRegex(self.key, r'^GT[A-Z0-9]{2}(-[A-Z0-9]{5}){4}$')

    def test_activate_signs_bound_licence_and_is_idempotent_per_install(self):
        code, body = self.svc.activate({'key': self.key.lower(), 'install_id': 'inst-1', 'fp': {'hashes': FP}})
        self.assertEqual(code, 200)
        p = verify(body['license'], 'GTL1', self.pub)
        self.assertEqual(p['install_id'], 'inst-1')
        self.assertEqual(p['fp']['hashes'], FP)
        self.assertEqual(p['limits']['users'], 5)
        self.assertEqual(p['key_id'], 'gtl-dev-1')
        verify(body['crl'], 'GTC1', self.pub)
        code2, body2 = self.svc.activate({'key': self.key, 'install_id': 'inst-1', 'fp': {'hashes': FP}})
        self.assertEqual(verify(body2['license'], 'GTL1', self.pub)['activation_id'], p['activation_id'])

    def test_activation_cap_and_unknown_key(self):
        for i in range(2):
            self.assertEqual(self.svc.activate({'key': self.key, 'install_id': f'i{i}', 'fp': {'hashes': FP}})[0], 200)
        self.assertEqual(self.svc.activate({'key': self.key, 'install_id': 'i3', 'fp': {'hashes': FP}})[0], 409)
        self.assertEqual(self.svc.activate({'key': 'GTXX-AAAAA-BBBBB-CCCCC-DDDDD', 'install_id': 'x', 'fp': {'hashes': FP}})[0], 404)

    def test_checkin_renews_and_revocation_flows_through_crl(self):
        _, body = self.svc.activate({'key': self.key, 'install_id': 'inst-1', 'fp': {'hashes': FP}})
        p = verify(body['license'], 'GTL1', self.pub)
        req = {'lic_id': p['lic_id'], 'activation_id': p['activation_id'], 'install_id': 'inst-1', 'fp': {'hashes': FP}}
        self.svc.store.update_key(self.lic, valid_until='2030-01-01T00:00:00+00:00')
        code, out = self.svc.checkin(req)
        self.assertEqual(code, 200)
        self.assertEqual(verify(out['license'], 'GTL1', self.pub)['valid_until'], '2030-01-01T00:00:00+00:00')
        self.assertEqual(verify(out['license'], 'GTL1', self.pub)['updates_until'], '2027-11-12T23:59:59+00:00',
                         'extend must not clear fields it was not given')
        self.svc.store.update_key(self.lic, revoked_at='2026-11-12T00:00:00+00:00', revoke_reason='refund')
        code, out = self.svc.checkin(req)
        self.assertNotIn('license', out)
        crl = verify(out['crl'], 'GTC1', self.pub)
        self.assertEqual(crl['revoked'][0]['lic_id'], self.lic)
        self.assertEqual(self.svc.activate({'key': self.key, 'install_id': 'new', 'fp': {'hashes': FP}})[0], 403)

    def test_deactivate_frees_a_slot(self):
        ids = []
        for i in range(2):
            _, b = self.svc.activate({'key': self.key, 'install_id': f'i{i}', 'fp': {'hashes': FP}})
            ids.append(verify(b['license'], 'GTL1', self.pub)['activation_id'])
        self.assertEqual(self.svc.deactivate({'activation_id': ids[0], 'install_id': 'i0'})[0], 200)
        self.assertEqual(self.svc.activate({'key': self.key, 'install_id': 'i3', 'fp': {'hashes': FP}})[0], 200)

    def test_wsgi_limits(self):
        def call(path, body=b'{}', method='POST', ip='1.2.3.4'):
            status = {}
            env = {'REQUEST_METHOD': method, 'PATH_INFO': path, 'REMOTE_ADDR': ip, 'CONTENT_LENGTH': str(len(body)),
                   'wsgi.input': io.BytesIO(body)}
            out = b''.join(self.svc(env, lambda s, h: status.setdefault('s', s)))
            return int(status['s'].split()[0]), json.loads(out)
        self.assertEqual(call('/v1/health', method='GET')[0], 200)
        self.assertEqual(call('/v1/activate', method='GET')[0], 405)
        self.assertEqual(call('/v1/activate', body=b'x' * 40000)[0], 413)
        self.assertEqual(call('/v1/activate', body=b'not json')[0], 400)
        codes = [call('/v1/activate', ip='9.9.9.9')[0] for _ in range(35)]
        self.assertIn(429, codes)
        self.assertEqual(call('/admin/keys', method='GET')[0], 404)  # no admin HTTP surface

    def test_dev_key_refused_in_production(self):
        os.environ['GTRADE_LICENSING_ENV'] = 'production'
        try:
            with self.assertRaises(KeyProviderError):
                DevFileKeyProvider(self.tmp / 'other.pem')
        finally:
            os.environ.pop('GTRADE_LICENSING_ENV')

    def test_licence_and_crl_signatures_are_not_interchangeable(self):
        _, body = self.svc.activate({'key': self.key, 'install_id': 'inst-1', 'fp': {'hashes': FP}})
        _, b, sig = body['license'].split('.')
        forged = f'GTC1.{b}.{sig}'
        with self.assertRaises(Exception):
            verify(forged, 'GTC1', self.pub)


if __name__ == '__main__':
    unittest.main()
