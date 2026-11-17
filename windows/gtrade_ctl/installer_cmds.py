"""Installer-level commands: preflight, install (per mode), pair, create-org, client-config,
connection-sheet, repair, uninstall. The NSIS wizard only collects answers and calls these.

Secrets typed in the wizard (admin password) arrive in an *answers file* that the wizard writes
into a folder only Administrators/SYSTEM can read. gtrade-ctl reads it once, overwrites and deletes
it immediately, and passes the password to Django on stdin. It never appears on a command line.
"""

from __future__ import annotations

import json
import os
import platform
import shutil
import ssl
import sys
import time
from pathlib import Path

from . import install_config
from .cli import EXIT, command, out, _layout, _cfg, _pg
from .log import StepLog

MIN_BUILD = 19045          # Windows 10 22H2
MIN_RAM_BLOCK = 4 * 1024 ** 3
MIN_RAM_WARN = 8 * 1024 ** 3
MIN_DISK_SERVER = 10 * 1024 ** 3


class InstallError(RuntimeError):
    def __init__(self, message, code=EXIT['check']):
        super().__init__(message)
        self.code = code


def _read_answers(path: str | None) -> dict:
    if not path:
        return {}
    p = Path(path)
    try:
        text = p.read_text(encoding='utf-8-sig') if p.exists() else ''
        if text.lstrip().startswith('{'):
            data = json.loads(text)
        else:
            # INI written by the NSIS wizard (WriteINIStr): [answers] key=value. No interpolation and
            # no inline comments, so any character a user can type survives unchanged.
            import configparser
            cp = configparser.ConfigParser(interpolation=None, comment_prefixes=('#',), inline_comment_prefixes=None,
                                           strict=False)
            cp.optionxform = str
            cp.read_string(text)
            data = dict(cp['answers']) if cp.has_section('answers') else {}
    finally:
        from .pg import _shred
        _shred(p)
    return data


def _client_dir() -> Path:
    return Path(os.environ.get('GTRADE_CLIENT_DIR') or Path(os.environ.get('ProgramData', r'C:\ProgramData')) / 'G-TRADE' / 'client')


def _steplog(lay, area='install') -> StepLog:
    return StepLog(lay.logs_dir / area / f'{area}-{time.strftime("%Y%m%d-%H%M%S")}.jsonl')


# ---- preflight ---------------------------------------------------------------------------------
def preflight(mode: str, lay, ports: list[int], need_admin: bool) -> dict:
    from .pg import _total_ram, port_free
    from .services import is_elevated
    checks, blocking, warnings = {}, [], []
    ver = sys.getwindowsversion() if sys.platform == 'win32' else None
    checks['windows_build'] = ver.build if ver else None
    if ver and ver.build < MIN_BUILD:
        blocking.append(f'Windows 10 22H2 (build {MIN_BUILD}) or newer is required; this PC is build {ver.build}.')
    checks['x64'] = platform.machine().lower() in ('amd64', 'x86_64')
    if not checks['x64']:
        blocking.append('A 64-bit (x64) Windows is required.')
    checks['elevated'] = is_elevated()
    if need_admin and not checks['elevated']:
        blocking.append('Run the installer as Administrator.')
    if mode != 'workstation':
        ram = _total_ram()
        checks['ram_gb'] = round(ram / 1024 ** 3, 1)
        if ram < MIN_RAM_BLOCK:
            blocking.append('At least 4 GB of RAM is required for a server or single-PC installation.')
        elif ram < MIN_RAM_WARN:
            warnings.append('Less than 8 GB of RAM: the server will work but may be slow under load.')
        target = lay.data_root if lay.data_root.exists() else Path(lay.data_root.anchor)
        free = shutil.disk_usage(target).free
        checks['free_disk_gb'] = round(free / 1024 ** 3, 1)
        if free < MIN_DISK_SERVER:
            blocking.append('At least 10 GB of free disk space is needed on the data drive.')
        busy = [p for p in ports if not port_free(p)]
        checks['ports_busy'] = busy
        existing = lay.install_json.exists()
        if busy and not existing:
            blocking.append(f'Port(s) {busy} are already used by another program; choose other ports.')
        checks['existing_installation'] = existing
    return {'ok': not blocking, 'blocking': blocking, 'warnings': warnings, 'checks': checks}


@command('preflight', 'Check this PC before installing (Windows version, x64, admin, RAM, disk, ports)')
def cmd_preflight(args, sub=None):
    if sub:
        sub.add_argument('--mode', required=True, choices=install_config.MODES)
        sub.add_argument('--ports', default='8443,8001,5544')
        sub.add_argument('--no-admin-check', action='store_true')
        return None
    lay = _layout(args)
    rep = preflight(args.mode, lay, [int(p) for p in args.ports.split(',') if p], not args.no_admin_check)
    return out(rep, 0 if rep['ok'] else EXIT['preflight'])


# ---- workstation pairing -----------------------------------------------------------------------
def probe_ca(host: str, port: int, timeout=6) -> str:
    """Fetch the installation CA the server publishes at /gtrade-ca.crt, WITHOUT trusting it yet.

    The CA is only accepted if the TLS leaf certificate on the same connection was issued by it;
    the caller then authenticates the CA with the pairing code from the server's connection sheet.
    """
    import http.client
    from cryptography import x509
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    conn = http.client.HTTPSConnection(host, port, timeout=timeout, context=ctx)
    try:
        conn.request('GET', '/gtrade-ca.crt', headers={'User-Agent': 'gtrade-ctl'})
        resp = conn.getresponse()
        body = resp.read(65536).decode('ascii', 'replace')
        leaf_der = conn.sock.getpeercert(binary_form=True)
    finally:
        conn.close()
    if resp.status != 200 or 'BEGIN CERTIFICATE' not in body:
        raise InstallError(f'{host}:{port} is not a G-TRADE server (no installation certificate).', EXIT['health'])
    ca = x509.load_pem_x509_certificate(body.encode())
    leaf = x509.load_der_x509_certificate(leaf_der)
    try:
        leaf.verify_directly_issued_by(ca)
    except Exception:
        raise InstallError('The server certificate was not issued by the certificate it publishes. '
                           'Do not connect: something on the network may be intercepting traffic.', EXIT['health'])
    return body


def _fingerprint(pem: str) -> str:
    import hashlib
    der = ssl.PEM_cert_to_DER_cert(pem)
    h = hashlib.sha256(der).hexdigest().upper()
    return ':'.join(h[i:i + 2] for i in range(0, 64, 2))


def pairing_code(fp: str) -> str:
    hexs = fp.replace(':', '')
    return f'{hexs[:4]}-{hexs[4:8]}'


def write_client_config(server_url: str, ca_pem: str, mode: str) -> Path:
    d = _client_dir()
    d.mkdir(parents=True, exist_ok=True)
    data = {'serverUrl': server_url, 'caPem': ca_pem, 'caFingerprint': _fingerprint(ca_pem), 'mode': mode,
            'writtenAt': time.strftime('%Y-%m-%dT%H:%M:%S%z')}
    p = d / 'client.json'
    tmp = p.with_suffix('.tmp')
    tmp.write_text(json.dumps(data, indent=2), encoding='utf-8')
    os.replace(tmp, p)
    return p


@command('pair', 'LAN Workstation: verify the server with its pairing code and save the connection for all users')
def cmd_pair(args, sub=None):
    if sub:
        sub.add_argument('--server', required=True, help='SERVER or SERVER:PORT')
        sub.add_argument('--code', required=True, help='pairing code from the connection sheet')
        sub.add_argument('--version', default='1.0.0')
        return None
    from .health import get_json, ssl_context
    text = args.server.strip()
    if '://' in text:
        text = text.split('://', 1)[1]
    host, _, port = text.rstrip('/').partition(':')
    port = int(port or 8443)
    ca_pem = probe_ca(host, port)
    fp = _fingerprint(ca_pem)
    given = ''.join(ch for ch in args.code.upper() if ch.isalnum())
    import hmac
    if not hmac.compare_digest(given, pairing_code(fp).replace('-', '')):
        return out({'error': 'The pairing code does not match this server. Check the connection sheet.',
                    'fingerprint': fp}, EXIT['config'])
    url = f'https://{host}:{port}'
    code, health = get_json(url + '/api/health/', ssl_context(ca_pem=ca_pem))
    if code != 200 or health.get('edition') != 'local':
        return out({'error': f'{url} is not a reachable G-TRADE server (HTTP {code}).'}, EXIT['health'])
    lay = _layout(args)
    cfg = install_config.InstallConfig(mode='workstation', version=args.version, server_url=url, ca_fingerprint=fp)
    if lay.install_json.exists():
        old = install_config.read(lay.install_json)
        if old.mode != 'workstation':
            return out({'error': f'this computer is installed as {old.mode}'}, EXIT['config'])
        cfg.install_id, cfg.history = old.install_id, old.history
    install_config.record_history(cfg, 'pair', server=url)
    install_config.write(lay.install_json, cfg)
    path = write_client_config(url, ca_pem, 'workstation')
    return out({'paired': url, 'fingerprint': fp, 'server_version': health.get('server_version'), 'client_config': str(path)})


# ---- server-side steps -------------------------------------------------------------------------
@command('client-config', 'Write the machine-wide desktop connection (this server, its CA) for all users')
def cmd_client_config(args, sub=None):
    if sub:
        return None
    lay = _layout(args)
    cfg = _cfg(lay)
    ca = (lay.tls_dir / 'ca.crt').read_text()
    path = write_client_config(f'https://localhost:{cfg.https_port}', ca, cfg.mode)
    return out({'written': str(path)})


@command('connection-sheet', 'LAN Server: write the page workstations need (addresses, fingerprint, pairing code)')
def cmd_connection_sheet(args, sub=None):
    if sub:
        sub.add_argument('--out')
        return None
    lay = _layout(args)
    cfg = _cfg(lay)
    fp = _fingerprint((lay.tls_dir / 'ca.crt').read_text())
    addrs = [f'{h}:{cfg.https_port}' for h in [*cfg.hostnames, *cfg.ip_addresses]]
    text = '\n'.join([
        'G OPTICALS - workstation connection sheet', '=' * 43, '',
        'Server address (any of):', *[f'    {a}' for a in addrs], '',
        f'Pairing code:   {pairing_code(fp)}', '',
        'Certificate fingerprint (SHA-256):', f'    {fp}', '',
        'On each workstation: install G OPTICALS, choose "LAN Workstation",',
        'enter one server address and the pairing code above.',
        'Keep this sheet with the server. It contains no passwords.', ''])
    target = Path(args.out) if args.out else lay.config_dir / 'connection-sheet.txt'
    target.write_text(text, encoding='utf-8')
    return out({'written': str(target), 'pairing_code': pairing_code(fp), 'addresses': addrs})


@command('create-org', 'New database only: create the first company and its administrator (answers file)')
def cmd_create_org(args, sub=None):
    if sub:
        sub.add_argument('--answers', required=True, help='JSON file; deleted after reading')
        sub.add_argument('--validate-only', action='store_true')
        return None
    from .django_bridge import manage
    lay = _layout(args)
    answers = _read_answers(args.answers)
    payload = {k: answers.get(k, '') for k in ('company_name', 'branch_name', 'admin_username', 'admin_password',
                                                'admin_full_name', 'admin_email', 'admin_phone')}
    cmd = ['local_create_admin'] + (['--validate-only'] if args.validate_only else [])
    proc = manage(lay, cmd, cfg=_cfg(lay), input_text=json.dumps(payload))
    last = (proc.stdout.strip().splitlines() or ['{}'])[-1]
    try:
        result = json.loads(last)
    except json.JSONDecodeError:
        result = {}
    if proc.returncode != 0:
        result.setdefault('error', proc.stderr.strip().splitlines()[-1] if proc.stderr.strip() else 'failed')
        return out(result, EXIT['check'])
    if not args.validate_only:
        cfg = _cfg(lay)
        install_config.record_history(cfg, 'create-org', company=result.get('company'))
        install_config.write(lay.install_json, cfg)
    return out(result)


def _config_access_refusal(lay, command_name: str, write: bool = False):
    """None when this process may use config\\ (install.json, gtrade.env, secrets.dpapi); otherwise
    the printed refusal (exit 2) - before any prompt, nothing changed. Never touches an ACL."""
    from .services import is_elevated
    try:
        install_config.require_access(lay, command_name, write=write)
        return None
    except install_config.ConfigError as exc:
        return out({'error': str(exc), 'elevated': is_elevated(), 'changed': False}, EXIT['config'])


@command('reset-password', 'Server PC only: set a new password for a user who cannot sign in (lost admin password)')
def cmd_reset_password(args, sub=None):
    """`reset-password --list-admins` prints the administrator user names. `reset-password --user NAME`
    reads the new password from stdin (piped) or asks for it twice without echo. It is never taken
    from the command line, so it does not appear in process listings or shell history."""
    if sub:
        sub.add_argument('--user', help='user name whose password is reset')
        sub.add_argument('--list-admins', action='store_true', help='list administrator user names; change nothing')
        return None
    from .django_bridge import manage
    lay = _layout(args)
    if not args.list_admins and not args.user:
        return out({'error': 'give --user NAME (or --list-admins to see the administrator names)'}, EXIT['config'])
    refused = _config_access_refusal(lay, 'reset-password')  # before the password prompt
    if refused:
        return refused
    if args.list_admins:
        cmd, payload = ['local_reset_password', '--list-admins'], ''
    else:
        if sys.stdin is not None and sys.stdin.isatty():
            import getpass
            first = getpass.getpass('New password: ')
            if first != getpass.getpass('Repeat the new password: '):
                return out({'error': 'the two passwords are different; nothing was changed'}, EXIT['config'])
        else:
            first = (sys.stdin.readline() if sys.stdin is not None else '').rstrip('\r\n')
        cmd, payload = ['local_reset_password'], json.dumps({'username': args.user, 'password': first})
    proc = manage(lay, cmd, cfg=_cfg(lay), input_text=payload)
    last = (proc.stdout.strip().splitlines() or ['{}'])[-1]
    try:
        result = json.loads(last)
    except json.JSONDecodeError:
        result = {}
    if proc.returncode != 0:
        result.setdefault('error', proc.stderr.strip().splitlines()[-1] if proc.stderr.strip() else 'failed')
        return out(result, EXIT['check'])
    return out(result)


@command('create-superadmin', 'Server PC only: create the Local Super Admin (Client Management), or --status / --reset-password')
def cmd_create_superadmin(args, sub=None):
    """`create-superadmin --user NAME [--email E] [--full-name N]` creates the installation's Local
    Super Admin; the password is read from stdin (piped) or asked twice without echo, never taken
    from the command line. Idempotent: an existing Local Super Admin is never duplicated.
    `--status` shows who it is; `--reset-password --user NAME` sets a new password for it."""
    if sub:
        sub.add_argument('--user', help='Local Super Admin user name')
        sub.add_argument('--email', default='')
        sub.add_argument('--full-name', default='')
        sub.add_argument('--status', action='store_true', help='show the Local Super Admin; change nothing')
        sub.add_argument('--reset-password', action='store_true', help='new password for the existing Local Super Admin')
        return None
    from .django_bridge import manage
    lay = _layout(args)
    if args.status:
        cmd, payload = ['local_superadmin', '--status'], ''
    elif not args.user:
        return out({'error': 'give --user NAME (or --status)'}, EXIT['config'])
    # Before the password prompt: a prompt that is not elevated cannot read the configuration and
    # secrets, and must not collect a password it can never use (2026-11-17).
    refused = _config_access_refusal(lay, 'create-superadmin', write=not args.status)
    if refused:
        return refused
    if not args.status:
        if sys.stdin is not None and sys.stdin.isatty():
            import getpass
            first = getpass.getpass('Password for the Local Super Admin: ')
            if first != getpass.getpass('Repeat the password: '):
                return out({'error': 'the two passwords are different; nothing was changed'}, EXIT['config'])
        else:
            first = (sys.stdin.readline() if sys.stdin is not None else '').rstrip('\r\n')
        cmd = ['local_superadmin'] + (['--reset-password'] if args.reset_password else [])
        payload = json.dumps({'username': args.user, 'password': first, 'email': args.email,
                              'full_name': args.full_name})
    proc = manage(lay, cmd, cfg=_cfg(lay), input_text=payload)
    last = (proc.stdout.strip().splitlines() or ['{}'])[-1]
    try:
        result = json.loads(last)
    except json.JSONDecodeError:
        result = {}
    if proc.returncode != 0:
        result.setdefault('error', proc.stderr.strip().splitlines()[-1] if proc.stderr.strip() else 'failed')
        return out(result, EXIT['check'])
    if not args.status and result.get('created'):
        cfg = _cfg(lay)
        install_config.record_history(cfg, 'create-superadmin', username=result.get('username'))
        install_config.write(lay.install_json, cfg)
    return out(result)


def _run_steps(lay, steps, log: StepLog):
    done = []
    for name, fn in steps:
        with log.step(name):
            result = fn()
        done.append({'step': name, 'result': result})
    return done


def server_install(lay, *, version, mode, https_port, app_port, db_port, answers_path, services: bool,
                   firewall_rule: bool, acl: bool, spa_root=None, log: StepLog) -> dict:
    """The full Standalone / LAN Server install (and re-install over kept data)."""
    from . import certs, nginx, secrets_store, services as svc, winacl, firewall
    from .django_bridge import manage, migration_plan
    from .paths import validate_data_root
    from .pg import PgRuntime
    report = {}
    acl_state = {'applied': False}

    def permissions():
        """Repair the permissions of an EXISTING data folder before any config file is read.

        Setups before 2026-11-13 left every file under the data folder with an empty ACL (see
        winacl.py), so a retry died reading its own install.json. Re-applying the policy only adds
        access for SYSTEM/Administrators/the service account inside the G-TRADE data folder; it
        never deletes, resets or takes ownership of anything."""
        if not acl:
            return {'skipped': 'acl disabled (--no-acl)'}
        if not lay.data_root.exists():
            return {'skipped': 'new data folder (permissions are applied in prepare-data)'}
        winacl.apply_data_root_policy(lay)
        acl_state['applied'] = True
        problems = [p for p in (winacl.access_problem(f, write=True)
                                for f in (lay.install_json, lay.env_file, lay.secrets_file)) if p]
        if problems:
            raise InstallError('Permissions could not be repaired. Nothing was changed. ' + ' | '.join(problems),
                               EXIT['config'])
        return {'repaired': True}

    def configure():
        if lay.install_json.exists():
            cfg = install_config.read(lay.install_json)
            if cfg.mode != mode:
                raise InstallError(f'This computer is already installed as {cfg.mode}.', EXIT['config'])
            install_config.record_history(cfg, 'reinstall', version=version)
            cfg.version = version
        else:
            names, ips = install_config.default_hostnames()
            cfg = install_config.InstallConfig(mode=mode, version=version, https_port=https_port, app_port=app_port,
                                               db_port=db_port, hostnames=names, ip_addresses=ips,
                                               data_root=str(lay.data_root), install_root=str(lay.install_root))
            install_config.record_history(cfg, 'install', version=version)
        install_config.write(lay.install_json, cfg)
        install_config.write_env(lay.env_file, install_config.env_values(cfg, lay))
        from .django_bridge import set_active
        set_active(lay, version)
        return {'install_id': cfg.install_id}

    def prepare():
        validate_data_root(lay.data_root, lay.install_root)
        created = lay.ensure_data_tree()
        (lay.data_root / 'client').mkdir(exist_ok=True)
        if acl and (created or not acl_state['applied']):
            winacl.apply_data_root_policy(lay)
        return {'acl': acl}

    def secrets():
        _v, created = secrets_store.init(lay.secrets_file)
        return {'created': created}

    state = {}

    def database():
        cfg = _cfg(lay)
        s = secrets_store.load(lay.secrets_file)
        pg = PgRuntime(lay.pg_bin, lay.pg_data, cfg.db_port, lay.logs_dir / 'db')
        # A password file left by an interrupted earlier attempt holds the real superuser password.
        swept = pg.sweep_stale_pwfiles()
        cs = pg.cluster_state()
        if cs == 'foreign':
            raise InstallError(f'{lay.pg_data} contains files that are not a G-TRADE database. Nothing was changed.', EXIT['db'])
        if cs == 'partial':
            raise InstallError(pg.partial_message(), EXIT['db'])
        state['existing_cluster'] = cs == 'cluster'
        report['stale_password_files_removed'] = swept
        if cs in ('absent', 'empty'):
            pg.initdb(s['db_superuser_password'])
        else:
            pg.write_config()
        pg.start()
        pg.wait_ready()
        prov = pg.provision(superuser_password=s['db_superuser_password'], app_user=cfg.db_user,
                            app_password=s['db_app_password'], db_name=cfg.db_name)
        rep = pg.verify(app_user=cfg.db_user, app_password=s['db_app_password'], db_name=cfg.db_name,
                        superuser_password=s['db_superuser_password'])
        if not rep.get('ok'):
            raise InstallError(f'Database check failed: {rep}', EXIT['db'])
        return {'existing_cluster': state['existing_cluster'], **prov}

    def migrate():
        plan = migration_plan(lay, _cfg(lay))
        if plan and state.get('existing_cluster'):
            # Re-install / upgrade over kept data: never migrate without a verified backup first.
            from .backup import create_backup
            b = create_backup(lay, _cfg(lay), kind='pre-install', include_media=True)
            report['pre_migration_backup'] = b['name']
        if plan:
            proc = manage(lay, ['migrate', '--noinput'], cfg=_cfg(lay))
            if proc.returncode != 0:
                raise InstallError(f'Database upgrade failed: {proc.stderr[-1200:]}', EXIT['db'])
        remaining = migration_plan(lay, _cfg(lay))
        if remaining:
            raise InstallError(f'{len(remaining)} migrations still pending after migrate', EXIT['db'])
        return {'applied': len(plan)}

    def static():
        proc = manage(lay, ['collectstatic', '--noinput', '--clear', '-v', '0'], cfg=_cfg(lay))
        if proc.returncode != 0:
            raise InstallError(f'collectstatic failed: {proc.stderr[-600:]}')
        return {}

    def organization():
        if not answers_path:
            return {'skipped': 'no answers file'}
        answers = _read_answers(answers_path)
        if not answers.get('company_name'):
            return {'skipped': 'no company in answers'}
        payload = {k: answers.get(k, '') for k in ('company_name', 'branch_name', 'admin_username', 'admin_password',
                                                    'admin_full_name', 'admin_email', 'admin_phone')}
        proc = manage(lay, ['local_create_admin'], cfg=_cfg(lay), input_text=json.dumps(payload))
        if proc.returncode != 0:
            tail = (proc.stdout.strip().splitlines() or [''])[-1] + ' ' + (proc.stderr.strip().splitlines() or [''])[-1]
            if 'already has users' in tail:
                return {'skipped': 'existing data kept; administrator not changed'}
            raise InstallError(f'Creating the company/administrator failed: {tail.strip()}')
        res = json.loads(proc.stdout.strip().splitlines()[-1])
        cfg = _cfg(lay)
        install_config.record_history(cfg, 'create-org', company=res.get('company'))
        install_config.write(lay.install_json, cfg)
        return {'company': res.get('company'), 'admin': res.get('admin_username')}

    def tls():
        cfg = _cfg(lay)
        return certs.ensure(lay.tls_dir, cfg.install_id, [*cfg.hostnames, *cfg.ip_addresses])

    def web():
        cfg = _cfg(lay)
        spa = Path(spa_root) if spa_root else lay.app_dir(version) / 'frontend'
        return {'conf': str(nginx.write(lay, cfg, spa))}

    def register_services():
        if not services:
            return {'skipped': 'services disabled (--no-services)'}
        cfg = _cfg(lay)
        cmds = svc.install_all(lay, cfg, version)
        # The cluster was started by pg_ctl for the install steps; hand it over to the service.
        PgRuntime(lay.pg_bin, lay.pg_data, cfg.db_port, lay.logs_dir / 'db').stop()
        svc.start_all(lay)
        return {'commands': len(cmds)}

    def fw():
        cfg = _cfg(lay)
        if cfg.mode != 'server' or not firewall_rule:
            return {'skipped': True}
        return {'commands': firewall.ensure(cfg.https_port)}

    def client():
        cfg = _cfg(lay)
        return {'written': str(write_client_config(f'https://localhost:{cfg.https_port}',
                                                   (lay.tls_dir / 'ca.crt').read_text(), cfg.mode))}

    def health():
        if not services:
            return {'skipped': 'services not started by installer'}
        from .health import check_local
        deadline = time.monotonic() + 120
        while True:
            rep = check_local(lay, _cfg(lay))
            if rep.get('ok') or time.monotonic() > deadline:
                break
            time.sleep(3)
        if not rep.get('ok'):
            raise InstallError(f'G-TRADE did not become healthy: {rep.get("error") or rep.get("health")}', EXIT['health'])
        return {'ok': True}

    def sheet():
        cfg = _cfg(lay)
        fp = _fingerprint((lay.tls_dir / 'ca.crt').read_text())
        return {'pairing_code': pairing_code(fp), 'fingerprint': fp,
                'addresses': [f'{h}:{cfg.https_port}' for h in [*cfg.hostnames, *cfg.ip_addresses]]}

    steps = [('permissions', permissions), ('configure', configure), ('prepare-data', prepare), ('secrets', secrets), ('database', database),
             ('migrate', migrate), ('collectstatic', static), ('create-org', organization), ('tls', tls),
             ('nginx', web)]
    try:
        from . import license_cmds  # noqa: F401  (Phase 7: licence step registered there)
        steps.append(('license', lambda: license_cmds.install_step(lay, answers_path)))
    except ImportError:
        pass
    steps += [('services', register_services), ('firewall', fw), ('client-config', client), ('health', health),
              ('connection-info', sheet)]
    report['steps'] = _run_steps(lay, steps, log)
    # Only now is this a complete installation (see Layout.install_complete / installer.nsh gtReadMode).
    lay.install_complete.write_text(json.dumps({'version': version, 'mode': mode,
                                                'at': time.strftime('%Y-%m-%dT%H:%M:%S')}), encoding='utf-8')
    if services:  # the health step proved this build works: the installer may snapshot it for rollback
        from .update import mark_verified
        mark_verified(lay, lay.app_dir(version))
        # ...and that every service works under its own account: old shared-account grants go.
        report['legacy_grants_removed'] = winacl.drop_legacy_grants(lay)
    return report


@command('install', 'Install or re-install this computer (Standalone, LAN Server or LAN Workstation)')
def cmd_install(args, sub=None):
    if sub:
        sub.add_argument('--mode', required=True, choices=install_config.MODES)
        sub.add_argument('--version', required=True)
        sub.add_argument('--https-port', type=int, default=install_config.DEFAULT_HTTPS_PORT)
        sub.add_argument('--app-port', type=int, default=install_config.DEFAULT_APP_PORT)
        sub.add_argument('--db-port', type=int, default=install_config.DEFAULT_DB_PORT)
        sub.add_argument('--answers', help='JSON answers file (company, admin, licence); deleted after use')
        sub.add_argument('--server', help='workstation: server address')
        sub.add_argument('--code', help='workstation: pairing code')
        sub.add_argument('--no-services', action='store_true', help='test/technician mode: do not register services')
        sub.add_argument('--no-firewall', action='store_true')
        sub.add_argument('--no-acl', action='store_true')
        sub.add_argument('--spa-root')
        return None
    lay = _layout(args)
    if args.mode != 'workstation':
        # Refuse a bad data folder BEFORE the step log or any config file is created inside it
        # (2026-11-12: the log and install.mode landed under Program Files\$COMMONPROGRAMDATA).
        from .paths import validate_data_root
        try:
            validate_data_root(lay.data_root, lay.install_root)
        except ValueError as exc:
            return out({'error': f'ValueError: {exc}', 'data_root': str(lay.data_root)}, EXIT['config'])
    log = _steplog(lay)
    if args.mode == 'workstation':
        if not (args.server and args.code):
            return out({'error': 'a workstation needs --server and --code'}, EXIT['config'])
        args.version = args.version
        return cmd_pair(args)
    pf = preflight(args.mode, lay, [args.https_port, args.app_port, args.db_port], need_admin=not args.no_services)
    log.write(step='preflight', status='ok' if pf['ok'] else 'failed', **pf)
    if not pf['ok']:
        return out({'error': 'preflight failed', **pf}, EXIT['preflight'])
    try:
        rep = server_install(lay, version=args.version, mode=args.mode, https_port=args.https_port,
                             app_port=args.app_port, db_port=args.db_port, answers_path=args.answers,
                             services=not args.no_services, firewall_rule=not args.no_firewall, acl=not args.no_acl,
                             spa_root=args.spa_root, log=log)
    except InstallError as exc:
        return out({'error': str(exc), 'log': str(log.path)}, exc.code)
    finally:
        if args.answers and Path(args.answers).exists():
            from .pg import _shred
            _shred(Path(args.answers))
    rep['warnings'] = pf['warnings']
    rep['log'] = str(log.path)
    return out(rep)


@command('repair', 'Re-check and re-apply configuration, services and certificates. Never touches business data.')
def cmd_repair(args, sub=None):
    if sub:
        sub.add_argument('--no-services', action='store_true')
        sub.add_argument('--no-acl', action='store_true')
        return None
    lay = _layout(args)
    if not args.no_acl and lay.data_root.exists() and lay.install_json.exists():
        from . import services as svc, winacl
        if winacl.access_problem(lay.install_json) and svc.is_elevated():
            winacl.apply_data_root_policy(lay)  # damaged by an older setup: repair before reading
    cfg = _cfg(lay)
    if cfg.mode == 'workstation':
        return out({'repaired': 'workstation', 'client_config': str(_client_dir() / 'client.json'),
                    'note': 'run "pair" again if the server changed'})
    from . import services as svc
    from .django_bridge import migration_plan
    if not args.no_services and svc.query(svc.DB) != 'NOT_INSTALLED':
        # An interrupted upgrade leaves the service wrappers deleted and PostgreSQL stopped: bring
        # both back (wrappers first) and prove SQL before asking the database anything.
        from . import winacl
        from .update import Controller, UpdateError, ensure_database
        ctrl = Controller()
        before = ctrl.accounts()
        try:
            ctrl.prepare(lay, cfg, lay.app_dir(cfg.version))
            ensure_database(lay, cfg, ctrl)
        except (UpdateError, svc.ServiceError, winacl.AclError) as exc:
            # Never leave the database down because of the account change: put the previous
            # registrations back, prove SQL, and report the failure (not silently ignored).
            restored = 'not attempted'
            if before:
                try:
                    ctrl.prepare(lay, cfg, lay.app_dir(cfg.version), before)
                    ensure_database(lay, cfg, ctrl)
                    restored = f'previous service accounts restored and database verified: {before}'
                except Exception as rexc:  # noqa: BLE001
                    restored = f'restoring the previous accounts ALSO failed: {rexc}'
            return out({'error': f'database not available: {exc}', 'recovery': restored}, EXIT['db'])
    if migration_plan(lay, cfg):
        return out({'error': 'database migrations are pending (an update was interrupted). Run the installer '
                             'again, or "gtrade-ctl update rollback" with the pre-update backup.'}, EXIT['update'])
    log = _steplog(lay, 'install')
    try:
        rep = server_install(lay, version=cfg.version, mode=cfg.mode, https_port=cfg.https_port, app_port=cfg.app_port,
                             db_port=cfg.db_port, answers_path=None, services=not args.no_services,
                             firewall_rule=True, acl=not args.no_acl, log=log)
    except InstallError as exc:
        return out({'error': str(exc), 'log': str(log.path)}, exc.code)
    return out({'repaired': cfg.mode, **rep})


@command('repair-permissions', 'Re-apply the data folder permissions (Administrator). Never deletes or resets anything.')
def cmd_repair_permissions(args, sub=None):
    if sub:
        return None
    from . import services as svc, winacl
    lay = _layout(args)
    if not lay.data_root.exists():
        return out({'error': f'{lay.data_root} does not exist'}, EXIT['config'])
    if not svc.is_elevated():
        return out({'error': 'Repairing permissions needs Administrator rights (run from an elevated prompt).'},
                   EXIT['config'])
    winacl.apply_data_root_policy(lay)
    problems = [p for p in (winacl.access_problem(f, write=True)
                            for f in (lay.install_json, lay.env_file, lay.secrets_file)) if p]
    if problems:
        return out({'error': 'still not accessible', 'problems': problems}, EXIT['config'])
    return out({'repaired': str(lay.data_root)})


@command('uninstall','Remove services, firewall rule and client config. Business data is KEPT unless confirmed.')
def cmd_uninstall(args, sub=None):
    if sub:
        sub.add_argument('--delete-data', action='store_true')
        sub.add_argument('--confirm-company', default='', help='must equal the company name to delete data')
        sub.add_argument('--final-backup-dir', help='where the final backup goes before data deletion')
        sub.add_argument('--no-services', action='store_true')
        return None
    from . import firewall, services as svc
    lay = _layout(args)
    result = {'data_kept': True}
    cfg = install_config.read(lay.install_json) if lay.install_json.exists() else None
    if not args.no_services and cfg and cfg.is_server_side:
        result['services'] = svc.uninstall_all(lay, dry_run=not svc.is_elevated())
        result['firewall'] = firewall.remove(dry_run=not svc.is_elevated())
    client = _client_dir() / 'client.json'
    if client.exists():
        client.unlink()
        result['client_config_removed'] = True
    if not args.delete_data:
        result['note'] = f'Business data and backups were kept in {lay.data_root}.'
        return out(result)
    # Deleting data needs the exact company name AND a verified final backup first.
    company = next((h.get('company') for h in reversed(cfg.history if cfg else []) if h.get('event') == 'create-org'), None)
    if not company or args.confirm_company.strip() != company:
        result['error'] = 'Data NOT deleted: type the exact company name to confirm.'
        return out(result, EXIT['config'])
    from .backup import create_backup, verify_backup
    dest = Path(args.final_backup_dir or Path.home() / 'Desktop' / f'G-TRADE-final-backup-{time.strftime("%Y%m%d-%H%M%S")}')
    b = create_backup(lay, cfg, kind='final', include_media=True, dest_dir=dest)
    if not verify_backup(Path(b['path'])).get('ok'):
        result['error'] = 'Data NOT deleted: the final backup could not be verified.'
        return out(result, EXIT['backup'])
    from .pg import PgRuntime, _shred
    PgRuntime(lay.pg_bin, lay.pg_data, cfg.db_port, lay.logs_dir / 'db').stop()
    for f in lay.config_dir.rglob('*'):
        if f.is_file() and (f.suffix in ('.key', '.dpapi') or f.parent.name == 'license'):
            _shred(f)
    shutil.rmtree(lay.data_root, ignore_errors=True)
    result.update(data_kept=False, final_backup=str(dest))
    return out(result)
