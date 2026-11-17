"""Verify a BUILT installer's payload (not the stage): extract the .exe with 7-Zip and check it.

    python windows/tooling/verify_package.py [--exe <path>] [--out <json>] [--keep]

Extracts the NSIS installer, then its app-64.7z payload, into a scratch folder and checks that the
packaged server tree is byte-identical to the stage manifest, migrations/licensing/runtime pieces
are present, the SPA + desktop shell (incl. Interface size) are packaged, docs are the current
ones, and no secrets/private keys/vendor keys leaked. Writes PACKAGE_VERIFICATION.json next to the
installer. Exit 1 if any check fails.
"""
import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import payload_guard  # noqa: E402

WIN = Path(__file__).resolve().parents[1]
ROOT = WIN.parent
STAGE = WIN / 'out' / 'stage'
SEVEN_ZIP = Path(r'C:\Program Files\7-Zip\7z.exe')


def sha256(p: Path) -> str:
    h = hashlib.sha256()
    with p.open('rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def extract(exe: Path, dest: Path) -> Path:
    outer = dest / 'outer'
    subprocess.run([str(SEVEN_ZIP), 'x', '-y', f'-o{outer}', str(exe)], check=True, capture_output=True)
    app7z = next(outer.rglob('app-64.7z'))
    payload = dest / 'payload'
    subprocess.run([str(SEVEN_ZIP), 'x', '-y', f'-o{payload}', str(app7z)], check=True, capture_output=True)
    return payload


def asar_files(asar: Path) -> dict:
    """Read the asar header (JSON index) and return {relative path: bytes} for small text files."""
    data = asar.read_bytes()
    header_size = int.from_bytes(data[12:16], 'little')
    header = json.loads(data[16:16 + header_size])
    base = 8 + int.from_bytes(data[4:8], 'little')
    out = {}

    def walk(node, prefix):
        for name, item in node.get('files', {}).items():
            path = f'{prefix}{name}'
            if 'files' in item:
                walk(item, path + '/')
            elif 'offset' in item and item.get('size', 0) < 2_000_000:
                off = base + int(item['offset'])
                out[path] = data[off:off + item['size']]
    walk(header, '')
    return out


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('--exe', default=str(WIN / 'out' / 'installer' / 'G-OPTICALS-Setup-1.0.0.exe'))
    ap.add_argument('--out', default=None)
    ap.add_argument('--keep', action='store_true')
    a = ap.parse_args(argv)
    exe = Path(a.exe)
    tmp = Path(tempfile.mkdtemp(prefix='gtrade-pkgverify-'))
    checks = []

    def check(name, ok, detail=''):
        checks.append({'name': name, 'ok': bool(ok), 'detail': detail})

    try:
        payload = extract(exe, tmp)
        res = payload / 'resources'
        server = res / 'server'
        manifest = json.loads((STAGE / 'manifest.json').read_text(encoding='utf-8'))
        files = manifest['files']
        mismatched = [rel for rel, digest in files.items()
                      if not (server / rel).is_file() or sha256(server / rel) != digest]
        extra = [str(p.relative_to(server)).replace('\\', '/') for p in server.rglob('*')
                 if p.is_file() and str(p.relative_to(server)).replace('\\', '/') not in files
                 and p.name != 'manifest.json']
        check('server tree matches stage manifest', not mismatched and not extra,
              f'{len(files)} files; mismatched {mismatched[:3]}; extra {extra[:3]}')
        check('packaged manifest.json identical to stage', sha256(server / 'manifest.json') == sha256(STAGE / 'manifest.json'))
        app = server / 'app' / '1.0.0'
        src_backend = ROOT / 'backend'
        drift = []
        for rel in [r for r in files if r.startswith('app/1.0.0/backend/') and r.endswith('.py')]:
            src = src_backend / rel[len('app/1.0.0/backend/'):]
            if src.is_file() and sha256(src) != files[rel]:
                drift.append(rel)
        check('packaged app == current source', not drift, f'drifted: {drift[:5]}')
        src_migs = sorted(p.relative_to(src_backend).as_posix() for p in src_backend.glob('apps/*/migrations/0*.py'))
        missing = [m for m in src_migs if not (app / 'backend' / m).is_file()]
        check('all migrations packaged', not missing, f'{len(src_migs)} migrations; missing {missing[:3]}')
        check('licensing app + local settings packaged', (app / 'backend' / 'apps' / 'licensing').is_dir()
              and (app / 'backend' / 'config' / 'settings_local.py').is_file())
        build_id = (app / 'BUILD_ID').read_text().strip() if (app / 'BUILD_ID').is_file() else ''
        check('BUILD_ID present', bool(build_id), build_id)
        pg = server / 'runtime' / 'pgsql'
        check('PostgreSQL binaries present', all((pg / 'bin' / b).is_file() for b in ('postgres.exe', 'pg_ctl.exe', 'initdb.exe', 'pg_dump.exe')))
        tools = ('pg_dump.exe', 'pg_restore.exe', 'psql.exe', 'libpq.dll')
        check('PostgreSQL backup tools + libpq present', all((pg / 'bin' / b).is_file() for b in tools),
              [b for b in tools if not (pg / 'bin' / b).is_file()])
        # --version loads every DLL pg_dump/pg_restore link against; no server or database is contacted.
        tool_vers = {t: subprocess.run([str(pg / 'bin' / t), '--version'], capture_output=True, text=True).stdout.strip()
                     for t in ('pg_dump.exe', 'pg_restore.exe', 'psql.exe') if (pg / 'bin' / t).is_file()}
        check('pg_dump/pg_restore/psql run (17.x, DLLs load)', len(tool_vers) == 3 and all(' 17.' in v for v in tool_vers.values()),
              tool_vers)
        # The packaged gtrade_ctl must find ITS OWN runtime with no --install-root / GTRADE_* set: that
        # is what a backup started from the bundled interpreter does. (Resolved from python.exe's path.)
        clean_env = {k: v for k, v in os.environ.items() if not k.upper().startswith(('GTRADE_', 'PG'))}
        probe = subprocess.run([str(server / 'runtime' / 'python' / 'python.exe'), '-c',
                                'import sys; sys.path[:0] = [sys.argv[1]]; from gtrade_ctl.paths import layout; '
                                'from gtrade_ctl.pg import require_pg_tools; l = layout(); '
                                'print(l.install_root_source); print(require_pg_tools(l))', str(app / 'windows')],
                               capture_output=True, text=True, env=clean_env)
        lines = probe.stdout.strip().splitlines()
        check('packaged gtrade_ctl resolves its own pg_dump (no env/args)',
              probe.returncode == 0 and len(lines) == 2 and lines[0] == 'bundled-python'
              and Path(lines[1]).resolve() == (pg / 'bin').resolve(), (probe.stdout + probe.stderr).strip()[-300:])
        ver = subprocess.run([str(pg / 'bin' / 'postgres.exe'), '--version'], capture_output=True, text=True).stdout.strip()
        check('PostgreSQL is 17.x', ' 17.' in ver, ver)
        check('PostgreSQL share/lib present', (pg / 'share').is_dir() and (pg / 'lib').is_dir())
        py = server / 'runtime' / 'python' / 'python.exe'
        imp = subprocess.run([str(py), '-I', '-c', 'import django, waitress, cryptography, psycopg2, sys; '
                              'print(sys.version.split()[0], django.get_version())'], capture_output=True, text=True)
        check('embedded Python 3.12 + Django/Waitress/cryptography/psycopg2 import',
              imp.returncode == 0 and imp.stdout.startswith('3.12'), (imp.stdout + imp.stderr).strip()[:200])
        check('nginx present', any(server.glob('runtime/nginx/**/nginx.exe')))
        check('WinSW service wrapper present', any(server.glob('runtime/**/*winsw*.exe')) or any(server.glob('runtime/**/WinSW*.exe')))
        check('gtrade-ctl entry point', (server / 'gtrade-ctl.cmd').is_file())
        ctl = app / 'windows' / 'gtrade_ctl'
        check('gtrade_ctl config generators/modules present', ctl.is_dir() and (ctl / '__main__.py').is_file()
              and len(list(ctl.glob('*.py'))) >= 10, f'{len(list(ctl.glob("*.py")))} modules')
        check('Waitress server package present', (app / 'windows' / 'gtrade_server').is_dir())
        spa = app / 'frontend'
        check('SPA present', (spa / 'index.html').is_file() and any(spa.glob('assets/*.js')))
        spa_js = ''.join(p.read_text(encoding='utf-8', errors='ignore') for p in spa.glob('assets/index-*.js'))
        check('SPA includes Interface size control', 'header-ui-scale' in spa_js and 'ui-scale-reset' in spa_js)
        asar = res / 'app.asar'
        check('desktop app.asar present', asar.is_file())
        af = asar_files(asar) if asar.is_file() else {}
        ui = af.get('lib/uiScale.js', b'').decode()
        main_js = af.get('main.js', b'').decode()
        check('desktop shell includes Interface size (80% default, 75-100%)',
              'DEFAULT_SCALE = 0.8' in ui and '[0.75, 0.8, 0.9, 1]' in ui and 'uiScale' in af.get('preload.js', b'').decode()
              and 'zoomFactor: currentScale' in main_js and "role: 'zoomIn'" not in main_js)
        check('desktop exe present', (payload / 'G-TRADE.exe').is_file())
        docs = res / 'docs'
        names = sorted(p.name for p in docs.glob('*.md'))
        check('docs bundled (drafts/release notes excluded)', 'INSTALLATION_GUIDE.md' in names
              and not any(n.startswith(('LICENSE_AGREEMENT_DRAFT', 'RELEASE_NOTES')) for n in names), names)
        check('bundled INSTALLATION_GUIDE == source', sha256(docs / 'INSTALLATION_GUIDE.md') == sha256(WIN / 'docs' / 'INSTALLATION_GUIDE.md'))
        check('bundled USER_GUIDE == source', sha256(docs / 'USER_GUIDE.md') == sha256(WIN / 'docs' / 'USER_GUIDE.md'))
        forbidden = payload_guard.forbidden_files(payload)
        leaked = payload_guard.leaked_values(payload, payload_guard.secret_needles())
        check('no forbidden secret files / leaked secret values', not forbidden and not leaked,
              f'forbidden {forbidden[:3]}; leaked {leaked[:3]}')
        keys = []
        for p in payload.rglob('*'):
            if p.is_file() and p.suffix.lower() in ('.pem', '.key', '.txt', '.json', '.py', '.env', '.cfg', '.ini', '') and p.stat().st_size < 1_000_000:
                if b'PRIVATE KEY-----' in p.read_bytes():
                    keys.append(str(p.relative_to(payload)))
        keys = [k for k in keys if 'test' not in k.lower().replace('\\', '/').split('/')[-2:][0] and 'site-packages' not in k]
        check('no private keys in payload', not keys, keys[:5])
        check('vendor licensing_service (dev keys) not bundled', not any(payload.rglob('licensing_service')))
    finally:
        report = {'installer': str(exe), 'installer_sha256': sha256(exe).upper(), 'unpacked': str(tmp),
                  'ok': all(c['ok'] for c in checks) and bool(checks), 'passed': sum(c['ok'] for c in checks),
                  'total': len(checks), 'checks': checks}
        out = Path(a.out) if a.out else exe.parent / 'PACKAGE_VERIFICATION.json'
        out.write_text(json.dumps(report, indent=1), encoding='utf-8')
        if not a.keep:
            shutil.rmtree(tmp, ignore_errors=True)
    for c in checks:
        print(('PASS ' if c['ok'] else 'FAIL ') + c['name'] + (f'  [{c["detail"]}]' if not c['ok'] and c['detail'] else ''))
    print(f'{report["passed"]}/{report["total"]} checks passed')
    return 0 if report['ok'] else 1


if __name__ == '__main__':
    sys.exit(main())
