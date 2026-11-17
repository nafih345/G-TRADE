"""Run Django management commands for the installed version, with secrets in the child env only."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

from . import install_config, secrets_store


def backend_dir(layout, version: str | None = None) -> Path:
    override = os.environ.get('GTRADE_BACKEND_DIR')
    if override:
        return Path(override)
    if version is None:
        return active_app_dir(layout) / 'backend'
    return layout.app_dir(version) / 'backend'


def _current(layout) -> dict:
    if layout.current_json.exists():
        return json.loads(layout.current_json.read_text(encoding='utf-8'))
    if layout.install_json.exists():  # fall back to what install.json says is installed
        return {'version': json.loads(layout.install_json.read_text(encoding='utf-8'))['version']}
    raise FileNotFoundError(f'{layout.current_json} is missing; no application version is active')


def active_version(layout) -> str:
    return _current(layout)['version']


def active_app_dir(layout) -> Path:
    cur = _current(layout)
    return Path(cur['app_dir']) if cur.get('app_dir') else layout.app_dir(cur['version'])


def set_active(layout, version: str, app_dir: Path | None = None) -> None:
    r"""Record which code the services run. app_dir is set only when it lives outside app\<version>
    (a rollback copy kept by the installer)."""
    data = {'version': version}
    if app_dir is not None and Path(app_dir) != layout.app_dir(version):
        data['app_dir'] = str(app_dir)
    layout.current_json.parent.mkdir(parents=True, exist_ok=True)
    tmp = layout.current_json.with_suffix('.tmp')
    tmp.write_text(json.dumps(data), encoding='utf-8')
    import os
    os.replace(tmp, layout.current_json)


def python_exe(layout) -> str:
    override = os.environ.get('GTRADE_PYTHON')
    if override:
        return override
    return str(layout.python_exe) if layout.python_exe.exists() else sys.executable


def child_env(layout, cfg=None, extra: dict | None = None) -> dict:
    env = dict(os.environ)
    env.update(install_config.read_env(layout.env_file))
    if cfg is not None:
        env.update(install_config.env_values(cfg, layout))
    values = secrets_store.load(layout.secrets_file)
    env['GTRADE_SECRET_KEY'] = values['django_secret_key']
    env['GTRADE_DB_PASSWORD'] = values['db_app_password']
    env['GTRADE_LICENSE_STORE_KEY'] = values['license_store_key']
    env['DJANGO_SETTINGS_MODULE'] = 'config.settings_local'
    env['AUTO_MIGRATE'] = 'False'
    for k in ('DATABASE_URL', 'POSTGRES_URL', 'POSTGRES_URL_NON_POOLING'):
        env.pop(k, None)
    windows_dir = Path(__file__).resolve().parent.parent
    env['PYTHONPATH'] = os.pathsep.join(filter(None, [str(windows_dir), env.get('PYTHONPATH', '')]))
    if extra:
        env.update(extra)
    return env


def manage(layout, args: list[str], *, cfg=None, version: str | None = None, timeout=3600,
           extra_env: dict | None = None, input_text: str | None = None) -> subprocess.CompletedProcess:
    bdir = backend_dir(layout, version)
    env = child_env(layout, cfg, extra_env)
    env['GTRADE_APP_DIR'] = str(bdir.parent)
    return subprocess.run([python_exe(layout), 'manage.py', *args], cwd=str(bdir), env=env,
                          capture_output=True, text=True, timeout=timeout, encoding='utf-8', errors='replace',
                          input=input_text)


def migration_plan(layout, cfg=None, version=None) -> list[str]:
    proc = manage(layout, ['migrate', '--plan', '--noinput'], cfg=cfg, version=version, timeout=600)
    if proc.returncode != 0:
        raise RuntimeError(f'migrate --plan failed: {proc.stderr.strip()[-800:]}')
    lines = [line.strip() for line in proc.stdout.splitlines()]
    if any(line.startswith('No planned migration operations') for line in lines):
        return []
    # Each planned migration is a non-indented "app.0001_name" line followed by indented ops.
    return [line for line in proc.stdout.splitlines() if line and not line.startswith(' ')
            and '.' in line and not line.startswith('Planned')]
