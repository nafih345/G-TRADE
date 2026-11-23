"""embed_licence_public_key: only a public key that the licence authority's live signature proves is
written; dev keys, wrong keys, private keys and an authority without signing are refused."""

import base64
import json
import shutil
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

WIN = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(WIN / 'tooling'))
sys.path.insert(0, str(WIN.parent / 'backend'))

import embed_licence_public_key as tool  # noqa: E402
from apps.licensing import licfmt  # noqa: E402  (the real wire format)


def _keypair():
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    key = Ed25519PrivateKey.generate()
    pub = base64.b64encode(key.public_key().public_bytes(serialization.Encoding.Raw,
                                                         serialization.PublicFormat.Raw)).decode()
    return key, pub


class FakeAuthority:
    def __init__(self, key, key_id, signing=True):
        outer = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_GET(self):
                if self.path.endswith('/v1/health'):
                    body = {'status': 'ok', 'signing': signing, 'key_id': key_id if signing else ''}
                elif self.path.endswith('/v1/crl'):
                    body = {'crl': licfmt.encode({'key_id': key_id, 'issued_at': '2026-11-19T00:00:00+00:00',
                                                  'revoked': []}, 'GTC1', key.sign)}
                else:
                    self.send_response(404)
                    self.end_headers()
                    return
                data = json.dumps(body).encode()
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)
        outer.httpd = HTTPServer(('127.0.0.1', 0), H)
        threading.Thread(target=outer.httpd.serve_forever, daemon=True).start()
        self.url = f'http://127.0.0.1:{outer.httpd.server_port}/api/licence-authority'

    def close(self):
        self.httpd.shutdown()


class EmbedTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.file = self.tmp / 'vendor_public_keys.json'
        self.file.write_text('{}\n')
        self.key, self.pub = _keypair()
        self.auth = FakeAuthority(self.key, 'gtl-prod-2026a')

    def tearDown(self):
        self.auth.close()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def embed(self, key_id='gtl-prod-2026a', pub=None, url=None):
        return tool.embed(key_id, pub or self.pub, url or self.auth.url, self.file, _insecure_for_tests=True)

    def test_matching_key_is_proven_and_written(self):
        out = self.embed()
        self.assertEqual(out['key_ids'], ['gtl-prod-2026a'])
        self.assertEqual(json.loads(self.file.read_text()), {'gtl-prod-2026a': self.pub})

    def test_wrong_key_dev_key_private_key_and_unsigned_authority_refused(self):
        _, other_pub = _keypair()
        with self.assertRaisesRegex(tool.EmbedError, 'does NOT verify'):
            self.embed(pub=other_pub)
        with self.assertRaisesRegex(tool.EmbedError, 'development key'):
            self.embed(key_id='gtl-dev-1')
        with self.assertRaisesRegex(tool.EmbedError, 'signs with'):
            self.embed(key_id='gtl-prod-other')
        with self.assertRaises(tool.EmbedError):
            self.embed(pub='-----BEGIN PRIVATE KEY-----')
        unsigned = FakeAuthority(self.key, 'gtl-prod-2026a', signing=False)
        try:
            with self.assertRaisesRegex(tool.EmbedError, 'no signing key'):
                self.embed(url=unsigned.url)
        finally:
            unsigned.close()
        self.assertEqual(json.loads(self.file.read_text()), {}, 'nothing written on refusal')

    def test_real_cli_refuses_insecure_authority(self):
        with self.assertRaisesRegex(tool.EmbedError, 'https'):
            tool.embed('gtl-prod-2026a', self.pub, self.auth.url, self.file)

    def test_rotation_keeps_existing_production_keys_and_drops_dev(self):
        _, old_pub = _keypair()
        self.file.write_text(json.dumps({'gtl-prod-2025a': old_pub, 'gtl-dev-x': old_pub}))
        out = self.embed()
        self.assertEqual(out['key_ids'], ['gtl-prod-2025a', 'gtl-prod-2026a'])


if __name__ == '__main__':
    unittest.main()


class VendorInstallationProofTests(unittest.TestCase):
    """The owner's Windows vendor key: proven offline with the GTP1 proof `gtrade-ctl vendor-key`
    prints (signed by the installation's private key), never with a network call."""

    def setUp(self):
        sys.path.insert(0, str(WIN))
        from gtrade_ctl import vendor_key
        self.vk = vendor_key
        self.tmp = Path(tempfile.mkdtemp())
        self.file = self.tmp / 'vendor_public_keys.json'
        self.file.write_text('{"gtl-prod-2026a": "%s"}\n' % _keypair()[1])
        self.key, self.pub = _keypair()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_proof_from_the_private_key_embeds_and_keeps_other_keys(self):
        proof = self.vk.proof('gtl-vendor-2026a', self.key, 'install-1')
        out = tool.embed('gtl-vendor-2026a', self.pub, 'https://unused.invalid', self.file, proof_token=proof)
        self.assertEqual(out['proved_by'], 'vendor installation proof')
        self.assertEqual(sorted(json.loads(self.file.read_text())), ['gtl-prod-2026a', 'gtl-vendor-2026a'])

    def test_proof_from_another_key_or_for_another_id_is_refused(self):
        other, _ = _keypair()
        for token, key_id in ((self.vk.proof('gtl-vendor-2026a', other), 'gtl-vendor-2026a'),
                              (self.vk.proof('gtl-vendor-2026b', self.key), 'gtl-vendor-2026a'),
                              ('GTP1.garbage.sig', 'gtl-vendor-2026a')):
            with self.assertRaises(tool.EmbedError):
                tool.embed(key_id, self.pub, 'https://unused.invalid', self.file, proof_token=token)
        self.assertNotIn('gtl-vendor-2026a', json.loads(self.file.read_text()))
