"""ELEVATED, DISPOSABLE self-test of the real Windows service mechanics (run as Administrator).

    cd "D:\\G OPTICALS\\windows"
    .\\out\\venv-candidate\\Scripts\\python.exe -m tests.elevated_service_selftest

What it proves, with throw-away services named ``GTradeST-<role>-<random>`` (it refuses any other
name, never touches GTrade-DB/App/Web, never uses port 5544, never stops a process it did not start):

 1. WinSW 2.12.0 (the pinned binary) installs a service from gtrade-ctl's generated XML.
 2. ``sc config obj= "NT SERVICE\\<id>"`` moves it to its virtual account; delayed start cleared;
    recovery actions + non-crash flag set; all read back with services.query_config.
 3. Under that account the REAL data-root policy (winacl.apply_data_root_policy) is enforced:
    App can read the secrets but not the CA key / database / config writes; Web can read only
    nginx's files; both write only their own folders (a probe running AS the service checks this).
    Program files (install root - deliberately placed under C:\\ProgramData, whose inherited ACL lets
    Users create files): own protected ACL, no write grant to anyone but SYSTEM/Administrators/
    TrustedInstaller in the whole tree, and every create/modify/delete/mkdir/plant attempt made AS
    each service is denied (2026-11-13 22:02 defect: "app: write program files -> ok").
    Then the SAME disposable web service runs the REAL nginx.exe with the real rendered nginx.conf and
    TLS files (2026-11-17 error 70: the .NET probe passed, but nginx's GetLongPathNameW check needs
    List on every parent folder): it must stay RUNNING, log no [emerg] and answer HTTPS.
 4. Intentional crash of the service's child process -> SCM restarts it (failure actions).
 5. PostgreSQL 17 (staged runtime, copied) as ``NT SERVICE\\GTradeST-DB-x``: initdb, start through
    SCM, real SQL; graceful stop judged by pg.shutdown_report (pg_control 'shut down', postmaster.pid
    removed, no process of the cluster left, SCM exit code 0, clean log); restart without crash
    recovery; NEGATIVE CONTROL: the service's own postmaster force-killed -> judged NOT clean and the
    next start performs crash recovery; then a second clean stop.
 6. Everything is removed afterwards (services deleted, folder deleted) and no GTradeST-* service /
    GTradeSelfTest-* folder may remain anywhere.

Option --remove-stale: also delete GTradeSelfTest-<6 hex> folders left by an ABORTED earlier run (only
when no GTradeST-* service is registered). Without it such leftovers make cleaned_up false.

Results: windows\\out\\selftest\\elevated-selftest-<timestamp>.json (and printed). Exit 0 = all passed.
"""

from __future__ import annotations

import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import time
import traceback
from pathlib import Path

WIN = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(WIN))
os.environ.pop('GTRADE_SKIP_ACL', None)
os.environ.pop('GTRADE_PG_BIN', None)

from gtrade_ctl import services, winacl  # noqa: E402
from gtrade_ctl.paths import layout  # noqa: E402
from gtrade_ctl.pg import PgRuntime, cluster_processes, find_free_port  # noqa: E402

PREFIX = 'GTradeST-'
STAGE = WIN / 'out' / 'stage' / 'runtime'
WINSW = STAGE / 'winsw' / 'WinSW-x64.exe'
POWERSHELL = Path(os.environ.get('SystemRoot', r'C:\Windows')) / 'System32' / 'WindowsPowerShell' / 'v1.0' / 'powershell.exe'

PROBE = r'''
$ErrorActionPreference = 'Stop'
$r = [ordered]@{}
$id = [Security.Principal.WindowsIdentity]::GetCurrent()
$r.user = $id.Name; $r.user_sid = $id.User.Value; $r.pid = $PID
$r.is_admin = ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$r.groups = @($id.Groups | ForEach-Object { $_.Value })
$checks = [ordered]@{}
function T($name, $op, $path) {
  try {
    if ($op -eq 'r') { [IO.File]::ReadAllBytes($path) | Out-Null }
    elseif ($op -eq 'd') { [IO.File]::Delete($path); if ([IO.File]::Exists($path)) { throw 'still there' } }
    elseif ($op -eq 'm') { [IO.Directory]::CreateDirectory($path) | Out-Null }
    else { [IO.File]::WriteAllText($path, 'probe') }
    $checks[$name] = 'ok'
  } catch [UnauthorizedAccessException] { $checks[$name] = 'denied' }
  catch { $checks[$name] = 'error: ' + $_.Exception.InnerException.Message + $_.Exception.Message }
}
__CHECKS__
$r.checks = $checks
$r.at = (Get-Date).ToString('o')
[IO.File]::WriteAllText('__OUT__', ($r | ConvertTo-Json -Depth 4))
while ($true) { Start-Sleep -Seconds 3600 }
'''


PROGRAMDATA = Path(os.environ.get('ProgramData', r'C:\ProgramData'))
STALE_DIR = re.compile(r'GTradeSelfTest-[0-9a-f]{6}')


def leftover_services() -> list[str]:
    """Every registered service named GTradeST-* (any state)."""
    out = subprocess.run(['sc.exe', 'query', 'type=', 'service', 'state=', 'all'], capture_output=True, text=True,
                         errors='replace').stdout
    return sorted({l.split(':', 1)[1].strip() for l in out.splitlines()
                   if l.strip().upper().startswith('SERVICE_NAME:') and l.split(':', 1)[1].strip().startswith(PREFIX)})


def leftover_folders() -> list[Path]:
    return sorted(d for d in PROGRAMDATA.iterdir() if d.is_dir() and STALE_DIR.fullmatch(d.name))


def sh(cmd, check=True, timeout=180):
    p = subprocess.run([str(c) for c in cmd], capture_output=True, text=True, errors='replace', timeout=timeout)
    if check and p.returncode != 0:
        raise RuntimeError(f'{" ".join(map(str, cmd[:3]))} -> {p.returncode}: {(p.stdout + p.stderr).strip()[-500:]}')
    return p


class SelfTest:
    def __init__(self, remove_stale=False):
        self.remove_stale = remove_stale
        tag = secrets.token_hex(3)
        self.ids = {'app': f'{PREFIX}App-{tag}', 'web': f'{PREFIX}Web-{tag}', 'db': f'{PREFIX}DB-{tag}'}
        for sid in self.ids.values():
            assert sid.startswith(PREFIX) and sid not in services.ALL
        self.root = Path(os.environ.get('ProgramData', r'C:\ProgramData')) / f'GTradeSelfTest-{tag}'
        self.lay = layout(self.root / 'install', self.root / 'data')
        self.accounts = {services.APP: f'NT SERVICE\\{self.ids["app"]}', services.WEB: f'NT SERVICE\\{self.ids["web"]}',
                         services.DB: f'NT SERVICE\\{self.ids["db"]}'}
        self.results = {'started': time.strftime('%Y-%m-%dT%H:%M:%S'), 'ids': self.ids, 'checks': {}, 'ok': False}
        self.registered = []

    # ---- helpers -----------------------------------------------------------------------------
    def check(self, name, cond, detail=None):
        self.results['checks'][name] = {'pass': bool(cond), **({'detail': detail} if detail is not None else {})}
        print(('PASS ' if cond else 'FAIL ') + name + ('' if cond else f'  -> {detail}'))
        return cond

    def configure(self, sid, account, start='demand'):
        services.run(['sc.exe', 'config', sid, 'start=', start, 'obj=', account])
        services.clear_delayed_autostart(sid)
        for c in services.plan_recovery(sid):
            services.run(c)
        return services.query_config(sid)

    # ---- set-up --------------------------------------------------------------------------------
    def build_tree(self):
        lay = self.lay
        lay.ensure_data_tree()
        (lay.data_root / 'client').mkdir(exist_ok=True)
        lay.install_root.mkdir(parents=True, exist_ok=True)
        for f in ('secrets.dpapi', 'gtrade.env', 'install.json', 'nginx.conf', 'mime.types',
                  'tls/ca.key', 'tls/ca.crt', 'tls/server.key', 'tls/server.crt'):
            (lay.config_dir / f).write_text('selftest')
        (lay.static_dir / 'app.js').write_text('selftest')
        (lay.install_root / 'program.txt').write_text('selftest')
        (lay.media_dir).mkdir(exist_ok=True)
        dst = lay.runtime_dir / 'pgsql'
        for part in ('bin', 'lib', 'share'):
            shutil.copytree(STAGE / 'pgsql' / part, dst / part)

    def apply_policy(self):
        winacl.apply_data_root_policy(self.lay, include_current_user=True, accounts=self.accounts, keep_network_service=False)

    # ---- program files must be read-only for every service ---------------------------------------
    def program_write_checks(self, role):
        """Every way a service could change program files (2026-11-13 22:02: 'write program files -> ok')."""
        ir = self.lay.install_root
        return {
            'write program files': ('w', ir / f'probe-{role}.txt'),
            'modify program file': ('w', ir / 'program.txt'),
            'delete program file': ('d', ir / 'program.txt'),
            'create folder in program files': ('m', ir / f'probe-dir-{role}'),
            'plant file in runtime\\pgsql\\bin': ('w', self.lay.pg_bin / f'probe-{role}.dll'),
            'replace postgres.exe': ('w', self.lay.pg_bin / 'postgres.exe'),
            'plant file in services folder': ('w', ir / 'services' / f'probe-{role}.exe'),
        }

    def check_program_files_acl(self):
        ir = self.lay.install_root
        d = winacl.read_dacl(ir)
        sids = {a[3] for a in d['aces'] if a[0] == 0}
        exposure = winacl.write_exposure(ir)
        self.check('program files: own protected ACL (nothing inherited from C:\\ProgramData)',
                   d['protected'] and not any(a[1] & 0x10 for a in d['aces']), d)
        self.check('program files: no Everyone / Authenticated Users / CREATOR OWNER / per-user entry',
                   not sids & {'S-1-1-0', 'S-1-5-11', 'S-1-3-0', 'S-1-5-4'}
                   and not any(s.startswith('S-1-5-21-') for s in sids), sorted(sids))
        self.check('program files: no write grant to anyone but SYSTEM/Administrators/TrustedInstaller (whole tree)',
                   exposure == [], exposure[:10])
        self.check('program files: each service account has read & execute',
                   all(services.service_sid(s) in sids for s in self.ids.values()), sorted(sids))

    # ---- WinSW services under virtual accounts -------------------------------------------------
    def probe_service(self, role, checks: dict):
        sid = self.ids[role]
        lay = self.lay
        out = (lay.logs_dir / 'app' if role == 'app' else lay.logs_dir / 'web') / f'probe-{role}.json'
        lines = '\n'.join(f"T '{k}' '{op}' '{path}'" for k, (op, path) in checks.items())
        script = lay.install_root / f'probe-{role}.ps1'
        script.write_text(PROBE.replace('__CHECKS__', lines).replace('__OUT__', str(out)), encoding='utf-8-sig')
        sdir = lay.install_root / 'services'
        sdir.mkdir(exist_ok=True)
        xml = services.winsw_xml(service_id=sid, name=f'G-TRADE self-test {role}', description='disposable self-test',
                                 executable=POWERSHELL,
                                 arguments=f'-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{script}"',
                                 workdir=lay.install_root, logpath=lay.logs_dir / 'services', env={}, depends=[])
        (sdir / f'{sid}.xml').write_text(xml, encoding='utf-8')
        shutil.copy2(WINSW, sdir / f'{sid}.exe')
        sh([sdir / f'{sid}.exe', 'install'])
        self.registered.append(('winsw', sid))
        acl = winacl.describe(lay.install_root)
        self.check(f'{role}: SID granted before registration now resolves to NT SERVICE\\{sid}',
                   f'nt service\\{sid}'.lower() in acl.lower(), acl[-600:])
        info = self.configure(sid, f'NT SERVICE\\{sid}')
        self.check(f'{role}: account is virtual NT SERVICE\\{sid}', services.same_account(info.get('account'), f'NT SERVICE\\{sid}'), info)
        self.check(f'{role}: not delayed, recovery 5/10/30 s, reset 1 h, non-crash flag',
                   not info.get('delayed') and tuple(info.get('actions') or ()) == services.RESTART_DELAYS_MS
                   and info.get('reset') == services.RESET_SECONDS and info.get('failure_flag') is True, info)
        services.start_service(sid, timeout=60)
        rep = self.wait_json(out, 60)
        self.check(f'{role}: runs as its service SID, not an administrator',
                   rep and rep['user_sid'] == services.service_sid(sid) and not rep['is_admin'], rep and {k: rep[k] for k in ('user', 'user_sid', 'is_admin')})
        return sid, out, rep

    @staticmethod
    def wait_json(path: Path, timeout):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                return json.loads(path.read_text(encoding='utf-8-sig'))
            except (OSError, ValueError):
                time.sleep(1)
        return None

    def test_app_and_web(self):
        lay = self.lay
        c = lay.config_dir
        app_checks = {
            'read secrets.dpapi': ('r', c / 'secrets.dpapi'), 'read gtrade.env': ('r', c / 'gtrade.env'),
            'read CA private key': ('r', c / 'tls' / 'ca.key'), 'read TLS server key': ('r', c / 'tls' / 'server.key'),
            'write config': ('w', c / 'probe.txt'), 'read database file': ('r', lay.pg_data / 'PG_VERSION'),
            'write media': ('w', lay.media_dir / 'probe.txt'), 'write backups': ('w', lay.backups_dir / 'db' / 'probe.txt'),
            'write logs\\app': ('w', lay.logs_dir / 'app' / 'probe.txt'), 'read static': ('r', lay.static_dir / 'app.js'),
            'write static': ('w', lay.static_dir / 'probe.txt'), 'read program files': ('r', lay.install_root / 'program.txt'),
            'read postgres.exe': ('r', lay.pg_bin / 'postgres.exe'),
            **self.program_write_checks('app'), 'write temp\\app': ('w', lay.temp_dir / 'app' / 'p.txt'),
        }
        expect_app = {'read secrets.dpapi': 'ok', 'read gtrade.env': 'ok', 'read CA private key': 'denied',
                      'read TLS server key': 'denied', 'write config': 'denied', 'read database file': 'denied',
                      'write media': 'ok', 'write backups': 'ok', 'write logs\\app': 'ok', 'read static': 'ok',
                      'write static': 'denied', 'read program files': 'ok', 'read postgres.exe': 'ok',
                      **{k: 'denied' for k in self.program_write_checks('app')}, 'write temp\\app': 'ok'}
        (lay.temp_dir / 'app').mkdir(exist_ok=True)
        self.apply_policy()
        self.check_program_files_acl()
        sid, out, rep = self.probe_service('app', app_checks)
        for k, want in expect_app.items():
            got = (rep or {}).get('checks', {}).get(k)
            self.check(f'app: {k} -> {want}', got == want, got)

        # crash -> SCM recovery (only ever the probe's own powershell, identified by its PID + script)
        if rep:
            old_pid = rep['pid']
            cmdline = sh(['powershell', '-NoProfile', '-Command',
                          f'(Get-CimInstance Win32_Process -Filter "ProcessId={old_pid}").CommandLine'], check=False).stdout
            if 'probe-app.ps1' in cmdline:
                out.unlink(missing_ok=True)
                sh(['taskkill', '/PID', str(old_pid), '/F'], check=False)
                new = self.wait_json(out, 90)
                self.check('app: intentional crash -> SCM restarted the service (failure actions)',
                           new is not None and new['pid'] != old_pid and services.query(sid) == 'RUNNING',
                           {'old_pid': old_pid, 'new': new and new['pid'], 'state': services.query(sid)})
            else:
                self.check('app: crash test target identified', False, cmdline)
        services.stop_service(sid, timeout=60)
        self.check('app: graceful stop through SCM', services.query(sid) == 'STOPPED', services.query(sid))

        web_checks = {
            'read nginx.conf': ('r', c / 'nginx.conf'), 'read mime.types': ('r', c / 'mime.types'),
            'read TLS server key': ('r', c / 'tls' / 'server.key'), 'read server.crt': ('r', c / 'tls' / 'server.crt'),
            'read CA private key': ('r', c / 'tls' / 'ca.key'), 'read secrets.dpapi': ('r', c / 'secrets.dpapi'),
            'write logs\\web': ('w', lay.logs_dir / 'web' / 'probe.txt'), 'write run\\nginx': ('w', lay.run_dir / 'nginx' / 'p.txt'),
            'write media': ('w', lay.media_dir / 'probe-web.txt'), 'read database file': ('r', lay.pg_data / 'PG_VERSION'),
            'read static': ('r', lay.static_dir / 'app.js'), 'write backups': ('w', lay.backups_dir / 'db' / 'web.txt'),
            'read program files': ('r', lay.install_root / 'program.txt'), **self.program_write_checks('web'),
        }
        expect_web = {'read nginx.conf': 'ok', 'read mime.types': 'ok', 'read TLS server key': 'ok', 'read server.crt': 'ok',
                      'read CA private key': 'denied', 'read secrets.dpapi': 'denied', 'write logs\\web': 'ok',
                      'write run\\nginx': 'ok', 'write media': 'denied', 'read database file': 'denied', 'read static': 'ok',
                      'write backups': 'denied', 'read program files': 'ok',
                      **{k: 'denied' for k in self.program_write_checks('web')}}
        sid, out, rep = self.probe_service('web', web_checks)
        for k, want in expect_web.items():
            got = (rep or {}).get('checks', {}).get(k)
            self.check(f'web: {k} -> {want}', got == want, got)
        services.stop_service(sid, timeout=60)
        self.test_real_nginx(sid)

    # ---- the REAL nginx as the web service (2026-11-17 error 70) ---------------------------------
    def test_real_nginx(self, sid):
        """The probe above writes with .NET file APIs; nginx validates every path with GetLongPathNameW,
        which needs List on each parent folder - the difference that made the 2026-11-17 update fail
        ("CreateDirectory() .../temp/nginx/client_body failed (5: Access is denied)") although the
        probe passed. Here the same disposable service runs the real nginx with the real config + TLS."""
        import socket
        import ssl
        from gtrade_ctl import certs, install_config, nginx
        lay = self.lay
        shutil.copytree(STAGE / 'nginx', lay.nginx_dir, dirs_exist_ok=True)
        for f in ('nginx.conf', 'mime.types', 'tls/ca.key', 'tls/ca.crt', 'tls/server.key', 'tls/server.crt'):
            (lay.config_dir / f).unlink(missing_ok=True)  # the probe's placeholder text files
        certs.ensure(lay.tls_dir, 'selftest', ['localhost'])
        port = find_free_port(18443)
        cfg = install_config.InstallConfig(mode='standalone', version='1.0.0', https_port=port, app_port=find_free_port(18101))
        nginx.write(lay, cfg, lay.static_dir)
        self.apply_policy()
        problems = winacl.service_access_problems(lay, winacl.service_principals(self.accounts, False))
        self.check('web: pre-start access check (winacl.service_access_problems) finds nothing', problems == [], problems)
        xml = services.web_service_xml(lay).replace(f'<id>{services.WEB}</id>', f'<id>{sid}</id>')
        xml = xml.replace(f'  <depend>{services.APP}</depend>\n', '')
        (lay.install_root / 'services' / f'{sid}.xml').write_text(xml, encoding='utf-8')
        err_log = lay.logs_dir / 'services' / f'{sid}.err.log'
        before = err_log.stat().st_size if err_log.exists() else 0
        try:
            services.start_service(sid, timeout=60)
            started = None
        except Exception as exc:  # noqa: BLE001
            started = str(exc)
        time.sleep(4)  # nginx exits within ~1 s when it cannot create its folders
        new_err = ''
        if err_log.exists():
            with open(err_log, 'rb') as fh:
                fh.seek(before)
                new_err = fh.read().decode('utf-8', 'replace')
        self.check('web: REAL nginx starts and stays running as NT SERVICE\\' + sid,
                   started is None and services.query(sid) == 'RUNNING' and '[emerg]' not in new_err,
                   {'start_error': started, 'state': services.query(sid), 'stderr': new_err[-600:]})
        status = None
        try:
            ctx = ssl.create_default_context()
            ctx.check_hostname, ctx.verify_mode = False, ssl.CERT_NONE
            with socket.create_connection(('127.0.0.1', port), timeout=10) as raw, ctx.wrap_socket(raw) as s:
                s.sendall(b'GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n')
                status = s.recv(64).split(b'\r\n', 1)[0].decode('latin-1')
        except OSError as exc:
            status = f'error: {exc}'
        self.check('web: REAL nginx answers HTTPS on the loopback port', status.startswith('HTTP/1.1 '), status)
        services.stop_service(sid, timeout=60)
        self.check('web: REAL nginx stops through SCM', services.query(sid) == 'STOPPED', services.query(sid))

    # ---- PostgreSQL under its virtual account --------------------------------------------------
    def test_database(self):
        lay = self.lay
        sid = self.ids['db']
        port = find_free_port(55440)
        assert port != 5544
        pg = PgRuntime(lay.pg_bin, lay.pg_data, port, lay.logs_dir / 'db')
        pw = secrets.token_urlsafe(18)
        pg.initdb(pw)  # exactly as the installer: operator grant, private pwfile, write_config
        # As on a fresh install (prepare-data runs before the services step): NO service exists yet, so
        # no service SID can be translated to a name. icacls refused that (error 1332, the 2026-11-13
        # failure); winacl now writes the SIDs with the Win32 ACL API.
        self.check('policy: applied while none of the three services is registered',
                   all(services.query_config(s) is None for s in self.ids.values()),
                   {s: services.query(s) for s in self.ids.values()})
        self.apply_policy()
        self.check('policy: no Everyone entry anywhere under the self-test root',
                   not any(a[3] == 'S-1-1-0' for p in [self.root, *self.root.rglob('*')] for a in winacl.read_dacl(p)['aces']))
        sh([lay.pg_bin / 'pg_ctl.exe', 'register', '-N', sid, '-U', services.NETWORK_SERVICE, '-D', lay.pg_data, '-S', 'demand', '-w'])
        self.registered.append(('pg', sid))
        acl = winacl.describe(lay.pg_data.parent)
        self.check(f'db: SID granted before registration now resolves to NT SERVICE\\{sid}',
                   f'nt service\\{sid}'.lower() in acl.lower(), acl[-600:])
        info = self.configure(sid, f'NT SERVICE\\{sid}')
        self.check('db: account is virtual NT SERVICE\\' + sid, services.same_account(info.get('account'), f'NT SERVICE\\{sid}'), info)
        self.check('db: recovery actions set', tuple(info.get('actions') or ()) == services.RESTART_DELAYS_MS, info)
        services.start_service(sid, timeout=120)
        pg.wait_ready(60)
        got = pg.psql('SELECT 1', user='postgres', password=pw)
        self.check('db: real SQL answered under the virtual account', got.strip() == '1', got)
        owner = sh(['powershell', '-NoProfile', '-Command', f"(Get-Acl -LiteralPath '{lay.pg_data / 'postmaster.pid'}').Sddl"],
                   check=False).stdout
        self.check('db: postmaster.pid created by the service SID', f'O:{services.service_sid(sid)}' in owner, owner[:120])
        # Graceful stop. SCM 'STOPPED' alone proves nothing: pg_ctl runservice reports it even when the
        # postmaster did not exit within its 60 s wait. pg.shutdown_report waits for THIS cluster's
        # processes (postmaster + children incl. the syslogger) to exit, then requires pg_control
        # 'shut down', postmaster.pid removed, exit code 0 and a clean log (see pg.assess_shutdown for
        # why "database system is shut down" is recorded but not used as proof).
        self.graceful_stop_and_assess(pg, sid, 'db: graceful stop = clean shutdown checkpoint')
        after = self.start_and_log(pg, sid)
        self.check('db: restart needs no crash recovery',
                   'database system was shut down at' in after and 'not properly shut down' not in after
                   and 'redo starts' not in after, after[-600:])
        self.check('db: SQL after restart', pg.psql('SELECT 2', user='postgres', password=pw).strip() == '2')

        # Negative control on the SAME service: a forced termination must NOT be judged clean.
        pm = pg.postmaster_pid()
        own = pm and pm in cluster_processes(pm) and self.root in lay.pg_data.parents
        self.check('db: forced-termination target is this self-test\'s own postmaster', own, pm)
        if own:
            offsets = pg.log_offsets()
            sh(['taskkill', '/PID', str(pm), '/F'], check=False)
            rep = pg.shutdown_report(pm, offsets, exit_code=None, drain_timeout=60)
            self.check('db: forced termination detected as NOT clean', not rep['clean'] and rep['pidfile_exists']
                       and rep['control_state'] == 'in production', rep)
            services.wait_state(sid, 'STOPPED', 30)
            if services.query(sid) != 'RUNNING':  # SCM recovery actions may already have restarted it
                services.start_service(sid, timeout=120)
            pg.wait_ready(90)
            rec = pg.log_since(offsets)
            self.check('db: restart after forced termination performed crash recovery',
                       'not properly shut down' in rec or 'automatic recovery in progress' in rec, rec[-600:])
            self.check('db: SQL after crash recovery', pg.psql('SELECT 3', user='postgres', password=pw).strip() == '3')
        self.graceful_stop_and_assess(pg, sid, 'db: second graceful stop also clean')

    def graceful_stop_and_assess(self, pg, sid, name):
        pm = pg.postmaster_pid()
        offsets = pg.log_offsets()
        services.stop_service(sid, timeout=120)
        codes = services.query_exit_codes(sid)
        rep = pg.shutdown_report(pm, offsets, exit_code=codes['win32'], drain_timeout=60)
        rep['scm_state'], rep['scm_exit_codes'], rep['postmaster_pid'] = services.query(sid), codes, pm
        rep['log_tail'] = pg.log_since(offsets)[-500:]
        self.check(name, bool(pm) and rep['scm_state'] == 'STOPPED' and rep['clean'] and rep['shutdown_checkpoint_logged'], rep)
        return rep

    def start_and_log(self, pg, sid):
        offsets = pg.log_offsets()
        services.start_service(sid, timeout=120)
        pg.wait_ready(60)
        time.sleep(1)
        return pg.log_since(offsets)

    # ---- teardown ------------------------------------------------------------------------------
    def cleanup(self):
        for kind, sid in reversed(self.registered):
            assert sid.startswith(PREFIX)
            try:
                services.stop_service(sid, timeout=120)
            except Exception as exc:  # noqa: BLE001
                print(f'warning: {sid} did not stop: {exc}')
            if kind == 'pg':
                sh([self.lay.pg_bin / 'pg_ctl.exe', 'unregister', '-N', sid], check=False)
            else:
                exe = self.lay.install_root / 'services' / f'{sid}.exe'
                sh([exe, 'uninstall'], check=False) if exe.exists() else sh(['sc.exe', 'delete', sid], check=False)
        time.sleep(2)
        self._remove_folder(self.root)
        own = not self.root.exists() and all(services.query(s) == 'NOT_INSTALLED' for _k, s in self.registered)
        # Not just this run: no self-test service or folder may exist anywhere (an aborted earlier run
        # leaves them behind). Stale FOLDERS are removed only with --remove-stale; services never are.
        if self.remove_stale and not leftover_services():
            for d in leftover_folders():
                print(f'removing stale self-test folder {d}')
                self._remove_folder(d)
        self.results['leftovers'] = {'services': leftover_services(), 'folders': [str(d) for d in leftover_folders()]}
        self.results['cleaned_up'] = own and not any(self.results['leftovers'].values())

    @staticmethod
    def _remove_folder(d: Path):
        assert STALE_DIR.fullmatch(d.name) and d.parent == PROGRAMDATA, d
        sh(['icacls', d, '/reset', '/T', '/C', '/Q'], check=False, timeout=600)
        shutil.rmtree(d, ignore_errors=True)

    def run(self) -> int:
        if not services.is_elevated():
            print('Run this from an elevated (Administrator) prompt.')
            return 2
        if not WINSW.exists() or not (STAGE / 'pgsql' / 'bin' / 'pg_ctl.exe').exists():
            print(f'Staged runtime not found under {STAGE}. Build it first (tooling/build_runtime.py).')
            return 2
        try:
            self.build_tree()
            self.test_database()      # first: the App/Web probes must find a real cluster to be denied
            self.test_app_and_web()
        except Exception as exc:  # noqa: BLE001
            self.check('self-test ran to completion', False, f'{exc}\n{traceback.format_exc()[-1500:]}')
        finally:
            self.cleanup()
        checks = self.results['checks']
        self.results['ok'] = bool(checks) and all(v['pass'] for v in checks.values()) and self.results.get('cleaned_up')
        self.results['finished'] = time.strftime('%Y-%m-%dT%H:%M:%S')
        out = WIN / 'out' / 'selftest' / f'elevated-selftest-{time.strftime("%Y%m%d-%H%M%S")}.json'
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(self.results, indent=2), encoding='utf-8')
        passed = sum(v['pass'] for v in checks.values())
        print(f'\n{passed}/{len(checks)} checks passed; cleaned up: {self.results.get("cleaned_up")}; report: {out}')
        return 0 if self.results['ok'] else 1


if __name__ == '__main__':
    sys.exit(SelfTest(remove_stale='--remove-stale' in sys.argv[1:]).run())
