"""Build the SPA for the Windows local edition (same-origin API, no internet on load).

    python windows/tooling/build_frontend.py          -> frontend/dist-local/

Runs `vite build` with VITE_EDITION=local (cloud `dist/` is untouched) and vendors the pinned
SheetJS file to dist-local/vendor/ so Excel import works on an offline LAN.
"""
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_runtime import PINS, ROOT, fetch  # noqa: E402


def main():
    fe = ROOT / 'frontend'
    env = {k: v for k, v in os.environ.items() if k not in ('VITE_API_URL',)}
    env['VITE_EDITION'] = 'local'
    npx = 'npx.cmd' if os.name == 'nt' else 'npx'
    subprocess.run([npx, 'vite', 'build', '--mode', 'production'], cwd=fe, env=env, check=True)
    out = fe / 'dist-local'
    html = (out / 'index.html').read_text(encoding='utf-8')
    for banned in ('onrender.com', 'fonts.googleapis.com', 'cdn.jsdelivr.net'):
        if banned in html:
            raise SystemExit(f'local build still references {banned}')
    vendor = out / 'vendor'
    vendor.mkdir(exist_ok=True)
    shutil.copy2(fetch(PINS['xlsx'], 'xlsx-0.18.5.full.min.js'), vendor / 'xlsx.full.min.js')
    # Scan the JS bundle for hosts the local edition must not contact at runtime.
    hits = {}
    for js in (out / 'assets').glob('*.js'):
        text = js.read_text(encoding='utf-8', errors='ignore')
        for host in ('cdn.jsdelivr.net', 'fonts.googleapis.com'):
            if host in text:
                hits.setdefault(host, []).append(js.name)
    (out / 'BUILD_INFO.json').write_text(json.dumps({'edition': 'local', 'external_hosts_in_bundle': hits}, indent=1))
    print('built', out, 'external hosts in bundle:', hits or 'none')


if __name__ == '__main__':
    main()
