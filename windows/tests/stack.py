"""Real end-to-end stack on this Windows PC, without services or elevation.

Uses the *staged* install root (windows/out/stage: embedded Python, bundled PostgreSQL 17, nginx)
and a disposable data root. Starts PostgreSQL with pg_ctl, the app with ``python -m gtrade_server``
and nginx with the exact arguments the WinSW service XML uses. Nothing touches the dev database.

    python windows/tests/stack.py up   --data-root <scratch> [--https-port 18443 ...]
    python windows/tests/stack.py down --data-root <scratch>
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

WINDOWS = Path(__file__).resolve().parents[1]
STAGE = WINDOWS / 'out' / 'stage'
CREATE_NEW_PROCESS_GROUP = 0x00000200


class Stack:
    def __init__(self, data_root: Path, install_root: Path = STAGE, version='1.0.0', mode='standalone',
                 https_port=18443, app_port=18001, db_port=15544):
        self.data_root = Path(data_root)
        self.install_root = Path(install_root)
        self.version = version
        self.mode = mode
        self.ports = dict(https=https_port, app=app_port, db=db_port)
        self.python = self.install_root / 'runtime' / 'python' / 'python.exe'
        self.app_dir = self.install_root / 'app' / version
        self.server_proc = None

    # ---- helpers ------------------------------------------------------------------------------
    def env(self, app_dir: Path | None = None) -> dict:
        env = {k: v for k, v in os.environ.items() if not k.startswith(('GTRADE_', 'DJANGO_', 'PG'))}
        env.pop('DATABASE_URL', None)
        env.update(GTRADE_APP_DIR=str(app_dir or self.app_dir), GTRADE_SKIP_ACL='1', OPENBLAS_NUM_THREADS='1',
                   PYTHONUTF8='1')
        return env

    def ctl(self, *args, check=True, timeout=1800, app_dir=None) -> dict:
        cmd = [str(self.python), '-m', 'gtrade_ctl', '--install-root', str(self.install_root),
               '--data-root', str(self.data_root), *args]
        proc = subprocess.run(cmd, capture_output=True, text=True, env=self.env(app_dir), timeout=timeout,
                              encoding='utf-8', errors='replace')
        try:
            data = json.loads(proc.stdout) if proc.stdout.strip() else {}
        except json.JSONDecodeError:
            data = {'raw': proc.stdout[-2000:]}
        data['_exit'] = proc.returncode
        if check and proc.returncode != 0:
            raise RuntimeError(f'gtrade-ctl {" ".join(args)} -> {proc.returncode}: {data} {proc.stderr[-1500:]}')
        return data

    # ---- lifecycle ----------------------------------------------------------------------------
    def provision(self) -> dict:
        p = self.ports
        out = {}
        out['configure'] = self.ctl('configure', '--mode', self.mode, '--version', self.version,
                                    '--https-port', str(p['https']), '--app-port', str(p['app']),
                                    '--db-port', str(p['db']))
        out['prepare'] = self.ctl('prepare-data', '--no-acl')
        out['secrets'] = self.ctl('secrets', 'init')
        out['init_db'] = self.ctl('init-db')
        out['verify_db'] = self.ctl('verify-db')
        out['plan_before'] = self.ctl('migrate', '--plan')['count']
        out['migrate'] = self.ctl('migrate', '--apply')['applied']
        out['plan_after'] = self.ctl('migrate', '--plan')['count']
        out['collectstatic'] = self.ctl('collectstatic')['ok']
        out['cert'] = self.ctl('cert', 'ensure')
        out['nginx'] = self.ctl('nginx-conf', '--spa-root', str(self.app_dir / 'frontend'))
        return out

    def start_db(self):
        return self.ctl('init-db')  # idempotent: starts an existing cluster, re-provisions

    def start_app(self, app_dir=None):
        log = self.data_root / 'logs' / 'services' / 'GTrade-App.console.log'
        log.parent.mkdir(parents=True, exist_ok=True)
        fh = open(log, 'ab')
        self._log_fh = fh
        env = self.env(app_dir)
        env['GTRADE_DB_BACKUP_SCHEDULER'] = '0'  # tests drive backups explicitly
        self.server_proc = subprocess.Popen([str(self.python), '-m', 'gtrade_server', '--data-root', str(self.data_root)],
                                            env=env, stdout=fh, stderr=subprocess.STDOUT,
                                            creationflags=CREATE_NEW_PROCESS_GROUP)
        (self.data_root / 'run').mkdir(exist_ok=True)
        (self.data_root / 'run' / 'app.pid').write_text(str(self.server_proc.pid))
        return self.server_proc

    def stop_app(self, timeout=30) -> int | None:
        proc = self.server_proc
        self.server_proc = None
        (self.data_root / 'run' / 'app.pid').unlink(missing_ok=True)
        try:
            if proc is None:
                return None
            if proc.poll() is not None:  # already exited (crashed / broken release)
                return proc.returncode
            os.kill(proc.pid, signal.CTRL_BREAK_EVENT)  # what WinSW's console stop delivers
            try:
                return proc.wait(timeout)
            except subprocess.TimeoutExpired:
                proc.kill()
                return -9
        finally:
            fh = getattr(self, '_log_fh', None)
            if fh:
                fh.close()
                self._log_fh = None

    def nginx_args(self):
        nginx = self.install_root / 'runtime' / 'nginx' / 'nginx.exe'
        return [str(nginx), '-p', str(self.data_root / 'run' / 'nginx') + '/', '-c',
                str(self.data_root / 'config' / 'nginx.conf')]

    def start_web(self):
        test = subprocess.run([*self.nginx_args(), '-t'], capture_output=True, text=True)
        if test.returncode != 0:
            raise RuntimeError(f'nginx -t failed: {test.stderr}')
        subprocess.Popen(self.nginx_args(), creationflags=CREATE_NEW_PROCESS_GROUP,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def stop_web(self):
        subprocess.run([*self.nginx_args(), '-s', 'quit'], capture_output=True)
        time.sleep(1)

    def stop_db(self):
        pg_ctl = self.install_root / 'runtime' / 'pgsql' / 'bin' / 'pg_ctl.exe'
        subprocess.run([str(pg_ctl), 'stop', '-D', str(self.data_root / 'pgsql' / 'data'), '-m', 'fast', '-w'],
                       capture_output=True)

    def wait_health(self, timeout=90) -> dict:
        deadline = time.monotonic() + timeout
        last = {}
        while time.monotonic() < deadline:
            last = self.ctl('health', check=False, timeout=60)
            if last.get('ok'):
                return last
            time.sleep(2)
        return last

    def down(self):
        self.stop_web()
        self.stop_app()
        self.stop_db()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('action', choices=['up', 'down'])
    ap.add_argument('--data-root', required=True)
    args = ap.parse_args()
    s = Stack(Path(args.data_root))
    if args.action == 'up':
        print(json.dumps(s.provision(), indent=1, default=str))
        s.start_app()
        s.start_web()
        print(json.dumps(s.wait_health(), indent=1))
    else:
        s.down()


if __name__ == '__main__':
    sys.exit(main())
