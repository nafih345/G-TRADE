"""Licence signing key ceremony (vendor server only; owner action).

    manage.py licence_signing_key generate --key-id gtl-prod-2026a --out C:/secure/gtl-prod-2026a.pem
        Writes a NEW Ed25519 private key (PKCS#8 PEM) to --out, which must not exist yet, and prints
        ONLY the public half + the key id. Keep the PEM in the host's secret store
        (GTRADE_LICENSE_SIGNING_KEY or GTRADE_LICENSE_SIGNING_KEY_FILE); delete the local copy
        after storing it. Never commit it, never put it in a frontend or a Windows build.
    manage.py licence_signing_key status
        Which key signs on this server and its public half (to embed in
        backend/apps/licensing/vendor_public_keys.json before building the Windows installer).
"""

import json
import os
from pathlib import Path

from django.core.management.base import BaseCommand, CommandError

from apps.licensing import keys as trusted
from apps.vendor_licensing import signing


class Command(BaseCommand):
    help = 'Generate or inspect the vendor licence signing key (public output only)'

    def add_arguments(self, parser):
        parser.add_argument('action', choices=['generate', 'status'])
        parser.add_argument('--key-id', help='new key id, e.g. gtl-prod-2026a')
        parser.add_argument('--out', help='path for the new private key (PEM); must not exist')

    def handle(self, *args, **o):
        if o['action'] == 'status':
            st = signing.status()
            self.stdout.write(json.dumps({k: v for k, v in st.items()}, indent=2))
            return
        key_id, out = (o.get('key_id') or '').strip(), o.get('out')
        if not trusted.KEY_ID_RE.match(key_id or ''):
            raise CommandError('--key-id must look like gtl-prod-2026a (lower case letters, digits, dashes).')
        if not out:
            raise CommandError('--out is required (the private key is written to a file, never printed).')
        path = Path(out)
        if path.exists():
            raise CommandError(f'{path} already exists; refusing to overwrite a key.')
        repo = Path(__file__).resolve().parents[5]
        try:
            path.resolve().relative_to(repo)
            raise CommandError('Refusing to write a private key inside the source repository.')
        except ValueError:
            pass
        pem, pub = signing.generate_keypair()
        path.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w', encoding='ascii') as fh:
            fh.write(pem)
        self.stdout.write(json.dumps({
            'key_id': key_id, 'private_key_file': str(path),
            'public_key': pub,
            'vendor_public_keys.json entry': {key_id: pub},
            'next_steps': [
                'Store the PEM in the vendor server secret store as GTRADE_LICENSE_SIGNING_KEY (or a secret file '
                'referenced by GTRADE_LICENSE_SIGNING_KEY_FILE) and set GTRADE_LICENSE_SIGNING_KEY_ID.',
                'Add the public entry to backend/apps/licensing/vendor_public_keys.json and rebuild the Windows '
                'installer so installations trust it.',
                'Delete the local PEM copy once it is stored securely.'],
        }, indent=2))
