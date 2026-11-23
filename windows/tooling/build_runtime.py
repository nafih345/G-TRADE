"""Assemble the G-TRADE server payload (install-root layout) without any installed Python/Node.

    python windows/tooling/build_runtime.py --version 1.0.0 --out windows/out/stage
        [--pg-source "C:\\Program Files\\PostgreSQL\\17"] [--spa frontend/dist-local] [--skip-python-packages]

Output (``<out>/``)::

    runtime/python/   embedded CPython 3.12.10 + Lib/site-packages (requirements-local.txt, exact pins)
    runtime/pgsql/    PostgreSQL 17 bin/lib/share (no pgAdmin, docs, headers, symbols)
    runtime/nginx/    nginx.exe + conf/mime.types
    runtime/winsw/    WinSW-x64.exe
    app/<version>/backend|windows|frontend + VERSION
    app/current.json
    manifest.json     SHA-256 of every file (signed later by sign_manifest.py)

Every download is checked against ``runtime_pins.json``; a mismatch aborts the build.
"""

from __future__ import annotations

import argparse
import compileall
import fnmatch
import hashlib
import json
import os
import shutil
import subprocess
import sys
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PINS = json.loads((Path(__file__).with_name('runtime_pins.json')).read_text(encoding='utf-8'))
CACHE = ROOT / 'windows' / 'out' / 'cache'

BACKEND_EXCLUDE_DIRS = {'venv', '.venv', '__pycache__', 'media', 'logs', 'backups', 'static', 'dist', 'build',
                        'node_modules', 'staticfiles', '.pytest_cache'}
# apps/vendor_licensing ships (2026-11-19): the owner's Windows installation issues customer licences
# offline. It holds no key: signing needs the vendor key file that only the owner's installation has
# (config\\license\\vendor-signing.dpapi) and whose public half this build trusts.
BACKEND_EXCLUDE_FILES = ['db.sqlite3*', '*.bak*', '*.pyc', 'clear_all_database.py', 'backend.spec', 'launcher.py',
                         'build.sh', 'vercel.json', 'gunicorn.conf.py', '*.log',
                         # Developer / cloud configuration never ships (backend/.env holds the hosted
                         # database URL). The local edition is configured only by gtrade.env + DPAPI
                         # secrets that gtrade-ctl writes at install time.
                         '.env', '.env.*', '*.env',
                         # Cloud-only operations scripts (hosted database copy / Neon rehearsal).
                         'copy_database.py', 'p1_neon_rehearsal.py']


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open('rb') as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def fetch(pin: dict, name: str) -> Path:
    CACHE.mkdir(parents=True, exist_ok=True)
    dest = CACHE / name
    if not dest.exists():
        print(f'downloading {pin["url"]}')
        with urllib.request.urlopen(pin['url'], timeout=120) as r, dest.open('wb') as fh:
            shutil.copyfileobj(r, fh)
    got = sha256(dest)
    if got != pin['sha256']:
        dest.unlink()
        raise SystemExit(f'checksum mismatch for {name}: expected {pin["sha256"]}, got {got}')
    return dest


def build_python(out: Path, skip_packages: bool) -> None:
    pin = PINS['python_embed']
    z = fetch(pin, f'python-{pin["version"]}-embed-amd64.zip')
    pydir = out / 'runtime' / 'python'
    if pydir.exists():
        shutil.rmtree(pydir)
    pydir.mkdir(parents=True)
    with zipfile.ZipFile(z) as zf:
        zf.extractall(pydir)
    # Enable site-packages and our app folders. The ._pth file *replaces* sys.path computation in
    # embedded Python, which is what keeps a separately installed Python from leaking in.
    pth = next(pydir.glob('python3*._pth'))
    pth.write_text('python312.zip\n.\nLib\\site-packages\nimport site\n', encoding='ascii')
    site_packages = pydir / 'Lib' / 'site-packages'
    site_packages.mkdir(parents=True)
    # Embedded Python ignores PYTHONPATH. The active application version is put on sys.path by
    # this site hook instead, from GTRADE_APP_DIR (set by the WinSW service XML and gtrade-ctl).
    # Switching versions on update/rollback is then a single environment value.
    (site_packages / 'gtrade_app.pth').write_text(
        "import os, sys; _d = os.environ.get('GTRADE_APP_DIR'); "
        "_d and [sys.path.insert(0, os.path.join(_d, _s)) for _s in ('windows', 'backend')]\n",
        encoding='ascii')
    if skip_packages:
        return
    # The lock carries exact versions *and* SHA-256 hashes of the win_amd64 wheels, so the
    # runtime is byte-for-byte the package set the test suite ran on.
    req = ROOT / 'backend' / 'requirements-local.lock'
    cmd = [sys.executable, '-m', 'pip', 'install', '--disable-pip-version-check', '--no-compile',
           '--require-hashes', '--no-deps',
           '--only-binary=:all:', '--platform', 'win_amd64', '--python-version', '3.12',
           '--implementation', 'cp', '--target', str(site_packages), '-r', str(req)]
    print('installing packages into embedded runtime')
    subprocess.run(cmd, check=True)
    # Not needed at runtime and large.
    for junk in ('bin',):
        shutil.rmtree(site_packages / junk, ignore_errors=True)
    for test_dir in list(site_packages.glob('*/tests')) + list(site_packages.glob('*/*/tests')):
        if test_dir.is_dir() and test_dir.parent.name in ('pandas', 'numpy', 'openpyxl', 'PIL'):
            shutil.rmtree(test_dir, ignore_errors=True)


def build_pgsql(out: Path, source: Path) -> None:
    ver = subprocess.run([str(source / 'bin' / 'pg_ctl.exe'), '--version'], capture_output=True, text=True).stdout
    if f' {PINS["postgresql"]["required_major"]}.' not in ver:
        raise SystemExit(f'{source} is not PostgreSQL {PINS["postgresql"]["required_major"]}: {ver}')
    dest = out / 'runtime' / 'pgsql'
    if dest.exists():
        shutil.rmtree(dest)
    excl = PINS['postgresql']['exclude_globs']

    def ignore(d, names):
        return [n for n in names if any(fnmatch.fnmatch(n, g) for g in excl)]

    for part in PINS['postgresql']['include']:
        shutil.copytree(source / part, dest / part, ignore=ignore)
    # Backups/restore/upgrade run these from runtime\pgsql\bin: refuse to stage a runtime without them.
    required = ('postgres.exe', 'pg_ctl.exe', 'initdb.exe', 'pg_dump.exe', 'pg_restore.exe', 'psql.exe', 'libpq.dll')
    missing = [n for n in required if not (dest / 'bin' / n).is_file()]
    if missing:
        raise SystemExit(f'staged PostgreSQL runtime is missing {missing} (check exclude_globs in runtime_pins.json)')
    (dest / 'PG_RUNTIME_VERSION').write_text(ver.strip(), encoding='utf-8')


def build_nginx(out: Path) -> None:
    pin = PINS['nginx']
    z = fetch(pin, f'nginx-{pin["version"]}.zip')
    dest = out / 'runtime' / 'nginx'
    if dest.exists():
        shutil.rmtree(dest)
    dest.mkdir(parents=True)
    prefix = f'nginx-{pin["version"]}/'
    with zipfile.ZipFile(z) as zf:
        for member in zf.namelist():
            rel = member[len(prefix):] if member.startswith(prefix) else member
            if rel in ('nginx.exe', 'conf/mime.types', 'docs/LICENSE', 'docs/OpenSSL.LICENSE', 'docs/PCRE.LICENCE',
                       'docs/zlib.LICENSE'):
                target = dest / rel
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(zf.read(member))


def build_winsw(out: Path) -> None:
    pin = PINS['winsw']
    exe = fetch(pin, f'WinSW-x64-{pin["version"]}.exe')
    dest = out / 'runtime' / 'winsw'
    dest.mkdir(parents=True, exist_ok=True)
    shutil.copy2(exe, dest / 'WinSW-x64.exe')


def copy_tree(src: Path, dest: Path, exclude_dirs=frozenset(), exclude_files=()) -> None:
    def ignore(d, names):
        return [n for n in names if n in exclude_dirs or any(fnmatch.fnmatch(n, g) for g in exclude_files)]
    if dest.exists():
        shutil.rmtree(dest)
    shutil.copytree(src, dest, ignore=ignore)


def build_app(out: Path, version: str, spa: Path | None) -> Path:
    app = out / 'app' / version
    copy_tree(ROOT / 'backend', app / 'backend', BACKEND_EXCLUDE_DIRS, BACKEND_EXCLUDE_FILES)
    # Developer configuration (database.json with a developer password, demo licence) must never ship.
    for f in list((app / 'backend').rglob('database.json')) + list((app / 'backend').rglob('settings.json')):
        f.unlink()
    win = app / 'windows'
    for pkg in ('gtrade_ctl', 'gtrade_server'):
        copy_tree(ROOT / 'windows' / pkg, win / pkg, {'__pycache__'}, ['*.pyc'])
    if spa and spa.exists():
        copy_tree(spa, app / 'frontend')
    (app / 'VERSION').write_text(version, encoding='ascii')
    # Release marker (config/settings_local.py GTRADE_RELEASE_BUILD): development licence keys and
    # dev mode are refused on every installation built here, whatever its environment says.
    (app / 'RELEASE').write_text(f'G OPTICALS {version} release build\n', encoding='ascii')
    # Unique per build: the installer only snapshots a build gtrade-ctl proved healthy (configerified-build).
    import datetime as _dt
    import secrets as _secrets
    (app / 'BUILD_ID').write_text(f'{version}-{_dt.datetime.now(_dt.timezone.utc):%Y%m%dT%H%M%SZ}-{_secrets.token_hex(4)}',
                                  encoding='ascii')
    # Fatal if any developer env file, key or secret value made it into the payload.
    from payload_guard import enforce
    print('payload_guard:', enforce(app)['values_checked'], 'secret values checked, none found')
    compileall.compile_dir(str(app), quiet=1, legacy=False, workers=1)
    (out / 'app' / 'current.json').write_text(json.dumps({'version': version}), encoding='utf-8')
    # Admin entry point: picks the active version (incl. a rollback copy) from app\current.json.
    (out / 'gtrade-ctl.cmd').write_text(CTL_CMD, encoding='ascii')
    return app


CTL_CMD = r'''@echo off
rem G-TRADE admin tool. Runs the bundled Python with the active application version
rem (app\current.json, which may point at a rollback copy). No installed Python is needed.
setlocal
set "ROOT=%~dp0."
"%ROOT%\runtime\python\python.exe" -c "import json,os,runpy,sys;r=os.environ['ROOT'];d=json.load(open(os.path.join(r,'app','current.json')));a=d.get('app_dir') or os.path.join(r,'app',d['version']);os.environ['GTRADE_APP_DIR']=a;sys.path[:0]=[os.path.join(a,'windows'),os.path.join(a,'backend')];sys.argv=['gtrade-ctl','--install-root',r]+sys.argv[1:];runpy.run_module('gtrade_ctl',run_name='__main__')" %*
'''


def write_manifest(out: Path, version: str) -> Path:
    files = {}
    for p in sorted(out.rglob('*')):
        if p.is_file() and p.name not in ('manifest.json', 'manifest.sig'):
            files[p.relative_to(out).as_posix()] = sha256(p)
    manifest = {'product': 'G-TRADE ERP', 'version': version, 'files': files,
                'pins': {k: v.get('version') for k, v in PINS.items() if isinstance(v, dict)}}
    path = out / 'manifest.json'
    path.write_text(json.dumps(manifest, indent=1, sort_keys=True), encoding='utf-8')
    return path


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('--version', required=True)
    ap.add_argument('--out', default=str(ROOT / 'windows' / 'out' / 'stage'))
    ap.add_argument('--pg-source', default=r'C:\Program Files\PostgreSQL\17')
    ap.add_argument('--spa', default=str(ROOT / 'frontend' / 'dist-local'))
    ap.add_argument('--skip-python-packages', action='store_true')
    ap.add_argument('--only', choices=['python', 'pgsql', 'nginx', 'winsw', 'app', 'manifest'], action='append')
    args = ap.parse_args(argv)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    steps = args.only or ['python', 'pgsql', 'nginx', 'winsw', 'app', 'manifest']
    if 'python' in steps:
        build_python(out, args.skip_python_packages)
    if 'pgsql' in steps:
        build_pgsql(out, Path(args.pg_source))
    if 'nginx' in steps:
        build_nginx(out)
    if 'winsw' in steps:
        build_winsw(out)
    if 'app' in steps:
        build_app(out, args.version, Path(args.spa) if args.spa else None)
    if 'manifest' in steps:
        from payload_guard import enforce
        enforce(out)
        print('manifest:', write_manifest(out, args.version))


if __name__ == '__main__':
    main()
