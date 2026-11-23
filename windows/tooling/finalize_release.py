"""Final release build, run once the production licence key exists (from PowerShell, not Git Bash):

    python windows\\tooling\\finalize_release.py --key-id gtl-prod-2026a --public-key <base64 public key>
    python windows\\tooling\\finalize_release.py --key-id gtl-vendor-2026a --public-key <base64> --proof GTP1...
        (the owner's Windows vendor installation key: `gtrade-ctl vendor-key status` prints all three)

1. embed_licence_public_key: proves the public key against the LIVE production licence authority
   (health key id + a freshly signed CRL) and writes backend/apps/licensing/vendor_public_keys.json;
2. build_frontend.py (Windows SPA) and build_runtime.py --only app --only manifest (stage, RELEASE marker);
3. electron-builder --win nsis (windows/desktop, ELECTRON_RUN_AS_NODE removed);
4. payload_guard on win-unpacked and verify_package.py --require-production-key on the .exe;
5. writes the .sha256.txt next to the installer and prints name, size and SHA-256.
Stops at the first failure. Handles only the PUBLIC key; the private key never comes near this PC.
"""

import argparse
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

WIN = Path(__file__).resolve().parents[1]
ROOT = WIN.parent
PY = sys.executable
EXE = WIN / 'out' / 'installer' / 'G-OPTICALS-Setup-1.0.0.exe'


def step(name, cmd, cwd=ROOT, env=None):
    print(f'== {name}', flush=True)
    proc = subprocess.run(cmd, cwd=cwd, env=env)
    if proc.returncode != 0:
        print(f'FAILED: {name} (exit {proc.returncode})')
        sys.exit(proc.returncode or 1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--key-id', required=True)
    ap.add_argument('--public-key', required=True)
    ap.add_argument('--authority', default='https://g-trade-backend.onrender.com/api/licence-authority')
    ap.add_argument('--proof', default='', help='GTP1 proof of the Windows vendor installation key')
    a = ap.parse_args()
    step('embed + prove production public key',
         [PY, str(WIN / 'tooling' / 'embed_licence_public_key.py'), '--key-id', a.key_id, '--public-key', a.public_key,
          '--authority', a.authority, *(['--proof', a.proof] if a.proof else [])])
    step('build Windows SPA', [PY, str(WIN / 'tooling' / 'build_frontend.py')])
    step('stage application', [PY, str(WIN / 'tooling' / 'build_runtime.py'), '--version', '1.0.0',
                                '--only', 'app', '--only', 'manifest'])
    env = {k: v for k, v in os.environ.items() if k != 'ELECTRON_RUN_AS_NODE'}
    npx = 'npx.cmd' if os.name == 'nt' else 'npx'
    step('electron-builder (NSIS installer)', [npx, 'electron-builder', '--win', 'nsis'], cwd=WIN / 'desktop', env=env)
    step('payload guard', [PY, str(WIN / 'tooling' / 'payload_guard.py'), str(WIN / 'out' / 'installer' / 'win-unpacked')])
    step('package verification (production key required)',
         [PY, str(WIN / 'tooling' / 'verify_package.py'), '--require-production-key'])
    h = hashlib.sha256()
    with open(EXE, 'rb') as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b''):
            h.update(chunk)
    digest = h.hexdigest().upper()
    (EXE.parent / (EXE.name + '.sha256.txt')).write_text(f'{digest}  {EXE.name}\n', encoding='ascii')
    print(json.dumps({'installer': str(EXE), 'size_bytes': EXE.stat().st_size, 'sha256': digest,
                      'build_id': (WIN / 'out' / 'stage' / 'app' / '1.0.0' / 'BUILD_ID').read_text().strip()}, indent=2))


if __name__ == '__main__':
    main()
