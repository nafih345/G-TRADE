"""``gtrade-ctl`` command line. Every command prints one JSON document on stdout.

Exit codes (also used by the installer): 0 ok · 1 failed check · 2 usage/config error ·
10 pre-flight · 20 database · 30 licence · 40 services · 50 health · 60 backup · 70 update.
"""

from __future__ import annotations

import argparse
import json
import sys
import traceback

from . import __version__
from .log import redact

EXIT = {'ok': 0, 'check': 1, 'config': 2, 'preflight': 10, 'db': 20, 'license': 30, 'services': 40,
        'health': 50, 'backup': 60, 'update': 70, 'update_unverified': 71}

COMMANDS = {}


def command(name, help_text):
    def deco(fn):
        COMMANDS[name] = (fn, help_text)
        return fn
    return deco


def out(obj, code=0):
    print(json.dumps(redact(obj), indent=2, default=str))
    return code


def _layout(args):
    """Layout for a command. A relative or unexpanded root is refused (exit 2) before any file is
    written - otherwise it silently resolves against the caller's working directory."""
    from .paths import check_root_path, layout
    lay = layout(getattr(args, 'install_root', None), getattr(args, 'data_root', None))
    check_root_path(lay.data_root, 'data folder')
    check_root_path(lay.install_root, 'program folder')
    return lay


def _cfg(lay):
    from . import install_config
    return install_config.read(lay.install_json)


def _pg(lay, cfg):
    from .pg import PgRuntime
    return PgRuntime(lay.pg_bin, lay.pg_data, cfg.db_port, lay.logs_dir / 'db')


# ---------------------------------------------------------------------------------------------------
@command('version', 'Show gtrade-ctl version')
def cmd_version(args, sub=None):
    if sub:
        return None
    return out({'gtrade_ctl': __version__})


@command('configure', 'Write install.json + gtrade.env (first install) or refresh them (repair/update)')
def cmd_configure(args, sub=None):
    if sub:
        sub.add_argument('--mode', choices=['standalone', 'server', 'workstation'])
        sub.add_argument('--version', required=True)
        sub.add_argument('--https-port', type=int)
        sub.add_argument('--app-port', type=int)
        sub.add_argument('--db-port', type=int)
        sub.add_argument('--server-url', default='')
        sub.add_argument('--ca-fingerprint', default='')
        sub.add_argument('--hosts', default='', help='extra host names/IPs, comma separated')
        return None
    from . import install_config
    lay = _layout(args)
    if lay.install_json.exists():
        cfg = install_config.read(lay.install_json)
        if args.mode and args.mode != cfg.mode:
            return out({'error': f'this computer is installed as {cfg.mode}; an upgrade or repair cannot change '
                                 f'the installation mode'}, EXIT['config'])
        previous = cfg.version
        cfg.version = args.version
        install_config.record_history(cfg, 'configure', previous=previous, version=args.version)
    else:
        if not args.mode:
            return out({'error': '--mode is required for a new installation'}, EXIT['config'])
        names, ips = install_config.default_hostnames()
        cfg = install_config.InstallConfig(mode=args.mode, version=args.version, hostnames=names, ip_addresses=ips,
                                           server_url=args.server_url, ca_fingerprint=args.ca_fingerprint,
                                           data_root=str(lay.data_root), install_root=str(lay.install_root))
        install_config.record_history(cfg, 'install', version=args.version)
    for name in ('https_port', 'app_port', 'db_port'):
        if getattr(args, name):
            setattr(cfg, name, getattr(args, name))
    for h in filter(None, (x.strip() for x in args.hosts.split(','))):
        target = cfg.ip_addresses if h.replace('.', '').isdigit() else cfg.hostnames
        if h not in target:
            target.append(h)
    install_config.write(lay.install_json, cfg)
    if cfg.is_server_side:
        install_config.write_env(lay.env_file, install_config.env_values(cfg, lay))
    return out({'mode': cfg.mode, 'version': cfg.version, 'install_id': cfg.install_id,
                'origins': cfg.origins() if cfg.is_server_side else [], 'server_url': cfg.server_url})


@command('prepare-data', 'Create the data folder tree and apply its permissions')
def cmd_prepare_data(args, sub=None):
    if sub:
        sub.add_argument('--no-acl', action='store_true')
        return None
    from . import winacl
    from .paths import validate_data_root
    lay = _layout(args)
    validate_data_root(lay.data_root, lay.install_root)
    created = lay.ensure_data_tree()
    if not args.no_acl:
        winacl.apply_data_root_policy(lay)
    return out({'data_root': str(lay.data_root), 'created': [str(p) for p in created], 'acl': not args.no_acl})


@command('secrets', 'Create (first install only) or check the DPAPI secret store')
def cmd_secrets(args, sub=None):
    if sub:
        sub.add_argument('action', choices=['init', 'check', 'rotate'])
        sub.add_argument('--name')
        return None
    from . import secrets_store
    lay = _layout(args)
    if args.action == 'init':
        values, created = secrets_store.init(lay.secrets_file)
        return out({'created': created, 'names': sorted(values)})
    if args.action == 'check':
        values = secrets_store.load(lay.secrets_file)
        return out({'ok': all(values.get(n) for n in secrets_store.SECRET_NAMES), 'names': sorted(values)})
    values = secrets_store.rotate(lay.secrets_file, args.name)
    return out({'rotated': args.name, 'note': 'restart services; rotating db_app_password also needs repair-db'})


@command('cert', 'Create/renew the installation CA and server certificate')
def cmd_cert(args, sub=None):
    if sub:
        sub.add_argument('action', choices=['ensure', 'info'])
        return None
    from . import certs
    lay = _layout(args)
    cfg = _cfg(lay)
    if args.action == 'info':
        ca = certs.info(lay.tls_dir / 'ca.crt')
        srv = certs.info(lay.tls_dir / 'server.crt')
        return out({'ca_fingerprint': ca.fingerprint_sha256, 'ca_days_left': ca.days_left,
                    'server_days_left': srv.days_left, 'server_sans': srv.sans})
    hosts = [*cfg.hostnames, *cfg.ip_addresses]
    return out(certs.ensure(lay.tls_dir, cfg.install_id, hosts))


@command('nginx-conf', 'Generate nginx.conf for this installation')
def cmd_nginx(args, sub=None):
    if sub:
        sub.add_argument('--spa-root', help='built SPA folder (default: active version frontend)')
        return None
    from pathlib import Path
    from . import nginx
    from .django_bridge import active_version
    lay = _layout(args)
    cfg = _cfg(lay)
    from .django_bridge import active_app_dir
    spa = Path(args.spa_root) if args.spa_root else active_app_dir(lay) / 'frontend'
    return out({'written': str(nginx.write(lay, cfg, spa))})


@command('init-db', 'Initialise the PostgreSQL cluster (only when none exists) and provision the app role')
def cmd_init_db(args, sub=None):
    if sub:
        sub.add_argument('--no-start', action='store_true')
        return None
    from . import secrets_store
    lay = _layout(args)
    cfg = _cfg(lay)
    if not cfg.is_server_side:
        return out({'error': 'a LAN workstation never hosts a database'}, EXIT['config'])
    pg = _pg(lay, cfg)
    s = secrets_store.load(lay.secrets_file)
    pg.sweep_stale_pwfiles()
    state = pg.cluster_state()
    if state == 'partial':
        return out({'error': pg.partial_message()}, EXIT['db'])
    if state in ('absent', 'empty'):
        pg.initdb(s['db_superuser_password'])
        initialised = True
    elif state == 'cluster':
        initialised = False
        pg.write_config()
    else:
        return out({'error': f'{lay.pg_data} is not empty and is not a database cluster'}, EXIT['db'])
    if args.no_start:
        return out({'initialised': initialised})
    pg.start()
    pg.wait_ready()
    prov = pg.provision(superuser_password=s['db_superuser_password'], app_user=cfg.db_user,
                        app_password=s['db_app_password'], db_name=cfg.db_name)
    return out({'initialised': initialised, **prov})


@command('verify-db', 'Check the database: version, connectivity, least privilege, loopback only')
def cmd_verify_db(args, sub=None):
    if sub:
        return None
    from . import secrets_store
    lay = _layout(args)
    cfg = _cfg(lay)
    pg = _pg(lay, cfg)
    s = secrets_store.load(lay.secrets_file)
    rep = pg.verify(app_user=cfg.db_user, app_password=s['db_app_password'], db_name=cfg.db_name,
                    superuser_password=s['db_superuser_password'])
    return out(rep, 0 if rep.get('ok') else EXIT['db'])


@command('migrate', 'Show (--plan) or apply (--apply) database migrations for the active version')
def cmd_migrate(args, sub=None):
    if sub:
        g = sub.add_mutually_exclusive_group(required=True)
        g.add_argument('--plan', action='store_true')
        g.add_argument('--apply', action='store_true')
        return None
    from .django_bridge import manage, migration_plan
    lay = _layout(args)
    cfg = _cfg(lay)
    plan = migration_plan(lay, cfg)
    if args.plan:
        return out({'pending': plan, 'count': len(plan)})
    proc = manage(lay, ['migrate', '--noinput'], cfg=cfg)
    if proc.returncode != 0:
        return out({'applied': False, 'error': proc.stderr[-1500:]}, EXIT['db'])
    return out({'applied': True, 'migrations': plan, 'remaining': migration_plan(lay, cfg)})


@command('collectstatic', 'Collect Django static files into the data folder')
def cmd_collectstatic(args, sub=None):
    if sub:
        return None
    from .django_bridge import manage
    lay = _layout(args)
    proc = manage(lay, ['collectstatic', '--noinput', '--clear', '-v', '0'], cfg=_cfg(lay))
    return out({'ok': proc.returncode == 0, 'error': proc.stderr[-800:] if proc.returncode else None},
               0 if proc.returncode == 0 else EXIT['check'])


@command('services', 'Install/configure/start/stop/verify/remove Windows services (elevated)')
def cmd_services(args, sub=None):
    if sub:
        sub.add_argument('action', choices=['install', 'start', 'stop', 'uninstall', 'status', 'verify', 'xml'])
        sub.add_argument('--dry-run', action='store_true')
        return None
    from . import services
    from .django_bridge import active_version
    lay = _layout(args)
    if args.action == 'status':
        return out({s: services.query(s) for s in services.ALL})
    cfg = _cfg(lay)
    if args.action == 'verify':
        rep = services.verify_all(lay, cfg)
        return out(rep, 0 if rep['ok'] else EXIT['check'])
    if args.action == 'xml':
        return out({'app': services.app_service_xml(lay, cfg, active_version(lay)), 'web': services.web_service_xml(lay)})
    fn = {'install': lambda: services.install_all(lay, cfg, active_version(lay), dry_run=args.dry_run),
          'start': lambda: services.start_all(lay, dry_run=args.dry_run),
          'stop': lambda: services.stop_all(lay, dry_run=args.dry_run),
          'uninstall': lambda: services.uninstall_all(lay, dry_run=args.dry_run)}[args.action]
    return out({'action': args.action, 'commands': fn(), 'dry_run': args.dry_run})


@command('firewall', 'Add/remove the LAN Server HTTPS firewall rule (elevated)')
def cmd_firewall(args, sub=None):
    if sub:
        sub.add_argument('action', choices=['add', 'remove', 'status'])
        sub.add_argument('--dry-run', action='store_true')
        return None
    from . import firewall
    lay = _layout(args)
    if args.action == 'status':
        return out({'rule_present': firewall.exists(), 'network_profiles': firewall.active_profiles()})
    if args.action == 'remove':
        return out({'commands': firewall.remove(dry_run=args.dry_run)})
    cfg = _cfg(lay)
    if cfg.mode != 'server':
        return out({'skipped': f'no firewall rule for mode {cfg.mode}'})
    return out({'commands': firewall.ensure(cfg.https_port, dry_run=args.dry_run)})


@command('health', 'End-to-end health over HTTPS (nginx -> Waitress -> PostgreSQL)')
def cmd_health(args, sub=None):
    if sub:
        return None
    from .health import check_local
    lay = _layout(args)
    rep = check_local(lay, _cfg(lay))
    return out(rep, 0 if rep.get('ok') else EXIT['health'])


@command('diagnostics', 'Write a support zip (logs, config without secrets, service states)')
def cmd_diagnostics(args, sub=None):
    if sub:
        sub.add_argument('--out', required=True)
        return None
    from .diagnostics import collect
    lay = _layout(args)
    return out({'written': str(collect(lay, args.out))})


def build_parser():
    p = argparse.ArgumentParser(prog='gtrade-ctl', description='G-TRADE ERP installation and maintenance tool')
    p.add_argument('--install-root')
    p.add_argument('--data-root')
    subs = p.add_subparsers(dest='command', required=True)
    for name, (fn, help_text) in COMMANDS.items():
        sp = subs.add_parser(name, help=help_text)
        fn(None, sp)
        sp.set_defaults(_fn=fn)
    return p


def main(argv=None) -> int:
    _load_extensions()
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return args._fn(args) or 0
    except SystemExit:
        raise
    except Exception as exc:
        code = EXIT['check']
        name = type(exc).__name__
        if name in ('PgError',):
            code = EXIT['db']
        elif name in ('ServiceError', 'AclError'):
            code = EXIT['services']
        elif name in ('ConfigError', 'ConfigAccessError', 'PermissionError', 'ValueError', 'FileNotFoundError',
                      'SecretsError'):
            code = EXIT['config']
        elif name in ('LicenseError',):
            code = EXIT['license']
        elif name in ('BackupError',):
            code = EXIT['backup']
        elif name in ('UpdateError',):
            code = EXIT['update_unverified']  # nothing proven running
        if name == 'ConfigAccessError':  # e.g. a prompt that is not elevated: the message says what to do
            out({'error': f'{name}: {exc}'}, code)
            return code
        out({'error': f'{name}: {exc}', 'trace': traceback.format_exc(limit=3)}, code)
        return code


def _load_extensions():
    """Commands added by later phases live in their own modules and register on import."""
    import importlib
    for mod in ('installer_cmds', 'backup_cmds', 'update_cmds', 'license_cmds'):
        try:
            importlib.import_module(f'{__package__}.{mod}')
        except ModuleNotFoundError as exc:
            if exc.name != f'{__package__}.{mod}':
                raise


if __name__ == '__main__':  # pragma: no cover
    sys.exit(main())
