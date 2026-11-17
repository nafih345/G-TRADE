"""Safe application updates for Standalone and LAN Server installations.

Order (every step logged to logs\\update\\update-<ts>.jsonl and run\\update-state.json):

 1. compatibility: no downgrade; ``min_upgrade_from`` respected; PostgreSQL major matches;
    payload integrity (manifest SHA-256 of the new version's files); licence update entitlement
 2. pre-checks: free disk >= 2 x (database + media); migration plan computed with the NEW code;
    migrations the release marks irreversible need an explicit acknowledgement
 3. maintenance flag on, application stopped
 4. **pre-update backup, verified** (mandatory gate: if it fails, nothing has changed; the old
    version is started again)
 5. migrate with the new code, collectstatic, switch the services to the new version, start
 6. health gate (HTTPS end-to-end, schema current, version == new)
 7. on any failure after step 4: stop, restore the pre-update backup into a new database and swap,
    switch the services back to the previous version's code, start, health-check

Rules: migrations are never reversed (no ``migrate <app> <older>``); the only way back for the
database is the verified pre-update backup. Customer data is never deleted: the database that
failed the update is kept under another name for investigation.
"""

from __future__ import annotations

import datetime as dt
import json
import shutil
import time
from pathlib import Path

from . import install_config
from .log import StepLog


class UpdateError(RuntimeError):
    pass


def parse_version(v: str) -> tuple:
    out = []
    for part in str(v).split('.'):
        num = ''.join(ch for ch in part if ch.isdigit())
        out.append(int(num or 0))
    return tuple((out + [0, 0, 0])[:3])


def read_release(app_dir: Path) -> dict:
    """release.json shipped with every version (written by the release pipeline)."""
    p = app_dir / 'release.json'
    if p.exists():
        return json.loads(p.read_text(encoding='utf-8'))
    version = (app_dir / 'VERSION').read_text().strip() if (app_dir / 'VERSION').exists() else '0.0.0'
    return {'version': version, 'release_date': dt.date.today().isoformat(), 'min_upgrade_from': '1.0.0',
            'irreversible_migrations': [], 'requires_pg_major': 17}


def check_payload_integrity(install_root: Path, version: str) -> dict:
    """Every file of the new version listed in manifest.json must be present with the same SHA-256."""
    from .backup import _sha256
    mf = install_root / 'manifest.json'
    if not mf.exists():
        return {'checked': 0, 'skipped': 'no manifest.json (development build)'}
    manifest = json.loads(mf.read_text(encoding='utf-8'))
    prefix = f'app/{version}/'
    bad, n = [], 0
    for rel, digest in manifest['files'].items():
        if rel.startswith(prefix) and not rel.endswith('.pyc'):
            n += 1
            f = install_root / rel
            if not f.exists() or _sha256(f) != digest:
                bad.append(rel)
    if bad:
        raise UpdateError(f'{len(bad)} file(s) of version {version} are missing or altered (e.g. {bad[0]}). '
                          'Download the installer again.')
    return {'checked': n}


class Controller:
    """How to stop/start the application and web front door. Production: Windows services."""

    def stop(self):
        from . import services
        services.stop_all(None, include_db=False)

    def start(self):
        from . import services
        services.start_all(None)

    def start_db(self, lay, cfg):
        from . import services
        services.start_service(services.DB, timeout=180)

    def accounts(self) -> dict:
        """The account each registered service runs as now (restored by any rollback)."""
        from . import services
        return services.snapshot_accounts()

    def prepare(self, lay, cfg, app_dir: Path, accounts: dict | None = None):
        """Re-create the service wrappers (the installer deleted them with the old program files)
        pointing at ``app_dir``, apply the data-folder permissions for the service accounts, and
        make every registration match (``accounts``: None = the hardened virtual accounts; a
        rollback passes the previous ones). Must run before any service is started."""
        from . import services, winacl
        version = (Path(app_dir) / 'VERSION').read_text().strip()
        winacl.apply_data_root_policy(lay, accounts=accounts)
        return services.ensure_service_files(lay, cfg, version, Path(app_dir), accounts=accounts)

    def switch_version(self, lay, cfg, app_dir: Path, accounts: dict | None = None):
        """Point GTrade-App (and nginx's SPA root) at another version folder."""
        from . import nginx
        nginx.write(lay, cfg, Path(app_dir) / 'frontend')  # before prepare: nginx.conf must get Web's grant
        self.prepare(lay, cfg, app_dir, accounts)

    def finalize(self, lay):
        """Every service proven healthy on its own account: drop the old shared-account grants."""
        from . import winacl
        return winacl.drop_legacy_grants(lay)


def ensure_database(lay, cfg, controller: 'Controller', timeout=180) -> dict:
    """Start PostgreSQL if needed and prove it answers SQL as the application role.

    A RUNNING service is not enough (it was RUNNING-then-killed in the 2026-11-13 incident), and
    pg_isready only proves the postmaster accepts connections: this runs a real query."""
    from .backup import _creds, _pg
    pg = _pg(lay, cfg)
    if not (lay.pg_bin / 'pg_ctl.exe').exists():
        raise UpdateError(f'PostgreSQL program files are missing ({lay.pg_bin}). Run the installer again.')
    if not (lay.pg_data / 'PG_VERSION').exists():
        raise UpdateError(f'the database folder {lay.pg_data} is missing or not a PostgreSQL cluster. '
                          'Nothing was changed; contact support before doing anything else.')
    controller.start_db(lay, cfg)
    try:
        pg.wait_ready(timeout)
    except Exception as exc:
        raise UpdateError(f'PostgreSQL did not accept connections on 127.0.0.1:{cfg.db_port} within {timeout}s '
                          f'(see {lay.logs_dir / "db"}): {exc}') from exc
    user, pw = _creds(lay)
    got = pg.psql('SELECT 1', user=user or cfg.db_user, password=pw, db=cfg.db_name)
    if got.strip() != '1':
        raise UpdateError(f'database {cfg.db_name} did not answer a test query: {got[:200]!r}')
    return {'port': cfg.db_port, 'sql_ok': True}


def build_id(app_dir: Path) -> str:
    p = Path(app_dir) / 'BUILD_ID'
    return p.read_text(encoding='ascii').strip() if p.exists() else ''


def mark_verified(lay, app_dir: Path) -> None:
    """Record which build was last proven healthy. The installer refreshes its rollback copy of the
    program only from that build, so a failed update can never overwrite the good copy."""
    bid = build_id(app_dir)
    if bid:
        lay.config_dir.mkdir(parents=True, exist_ok=True)
        (lay.config_dir / 'verified-build').write_text(bid, encoding='ascii')


def restore_previous(lay, cfg, app_dir: Path, version: str, controller: 'Controller', health_timeout=180,
                     accounts: dict | None = None) -> dict:
    """Nothing in the database changed: bring the previous version back - its code AND the service
    accounts it ran under (``accounts``) - and PROVE it is healthy."""
    rep = {'version': version, 'app_dir': str(app_dir), 'accounts': accounts}
    try:
        if not (Path(app_dir) / 'backend' / 'manage.py').exists():
            raise UpdateError(f'the copy of the previous version is missing ({app_dir})')
        controller.prepare(lay, cfg, Path(app_dir), accounts)  # wrappers + previous accounts first
        rep['database'] = ensure_database(lay, cfg, controller)
        from .django_bridge import set_active
        controller.switch_version(lay, cfg, Path(app_dir), accounts)
        set_active(lay, version, Path(app_dir))
        lay.maintenance_flag.unlink(missing_ok=True)
        controller.start()
        h = _health(lay, cfg, version, timeout=health_timeout)
        rep['ok'] = h['ok']
        if not h['ok']:
            rep['error'] = f'previous version not healthy: {h.get("last")}'
    except Exception as exc:
        rep.update(ok=False, error=str(exc))
    return rep


def _health(lay, cfg, expect_version: str, timeout=180) -> dict:
    from .health import check_local
    deadline = time.monotonic() + timeout
    rep = {}
    while time.monotonic() < deadline:
        rep = check_local(lay, cfg)
        h = rep.get('health') or {}
        if rep.get('ok') and h.get('server_version') == expect_version:
            return {'ok': True, 'server_version': h.get('server_version')}
        time.sleep(3)
    return {'ok': False, 'last': rep}


def apply_update(lay, *, new_version: str, previous_app_dir: Path | None, controller: Controller | None = None,
                 acknowledge_irreversible=False, health_timeout=180) -> dict:
    from .backup import create_backup
    from .django_bridge import manage, migration_plan
    controller = controller or Controller()
    cfg = install_config.read(lay.install_json)
    if not cfg.is_server_side:
        raise UpdateError('workstations are updated by their installer only; they hold no database')
    old_version = cfg.version
    new_dir = lay.app_dir(new_version)
    if not (new_dir / 'backend' / 'manage.py').exists():
        raise UpdateError(f'version {new_version} is not installed in {new_dir}')
    prev_dir = Path(previous_app_dir) if previous_app_dir else lay.app_dir(old_version)
    if not (prev_dir / 'backend' / 'manage.py').exists():
        # No copy of the running version: a failure can then only be recovered with the pre-update
        # backup and the NEW code. Recorded in the report so support sees it.
        prev_dir = new_dir
    log = StepLog(lay.logs_dir / 'update' / f'update-{time.strftime("%Y%m%d-%H%M%S")}.jsonl')
    state_file = lay.run_dir / 'update-state.json'
    # The identities the services ran under before this update: every way back restores them.
    before_accounts = controller.accounts()
    report = {'from': old_version, 'to': new_version, 'log': str(log.path), 'previous_app_dir': str(prev_dir),
              'previous_accounts': before_accounts}

    def save_state(phase, **extra):
        lay.run_dir.mkdir(parents=True, exist_ok=True)
        state_file.write_text(json.dumps({'from': old_version, 'to': new_version, 'phase': phase,
                                          'previous_app_dir': str(prev_dir), 'previous_accounts': before_accounts,
                                          'at': dt.datetime.now(dt.timezone.utc).isoformat(), **extra}), encoding='utf-8')

    def early_failure(exc):
        # Nothing in the database has changed. The installer may already have stopped the services and
        # replaced the program files, so "nothing changed" is not enough: restart the previous version
        # and only report it as running if the health check proves it.
        report.update(ok=False, changed=False, error=str(exc))
        log.write(step='restore-previous', status='start', reason=str(exc)[:500])
        lay.maintenance_flag.unlink(missing_ok=True)
        report['rollback'] = restore_previous(lay, cfg, prev_dir, old_version, controller, health_timeout,
                                              accounts=before_accounts)
        report['rolled_back'] = bool(report['rollback'].get('ok'))
        log.write(step='update', status='failed-before-changes', previous_running=report['rolled_back'])
        state_file.unlink(missing_ok=True)
        return UpdateError(json.dumps(report, default=str))

    try:
        # 0. database: wrappers first (deleted with the old program files), pointing at the previous
        #    code because the schema belongs to it until migrate succeeds; then prove SQL works.
        #    The services move to their own least-privilege accounts here; PostgreSQL's move is
        #    proven by the SQL query, App/Web's by the health gate (any failure restores them).
        save_state('database')
        with log.step('database'):
            report['services'] = controller.prepare(lay, cfg, prev_dir)
            report['database'] = ensure_database(lay, cfg, controller)

        # 1. compatibility ---------------------------------------------------------------------------
        with log.step('compatibility'):
            rel = read_release(new_dir)
            report['release'] = rel
            if parse_version(new_version) < parse_version(old_version):
                raise UpdateError(f'{new_version} is older than the installed {old_version}. Downgrades are not '
                                  'supported; restore a backup with the older version instead.')
            if parse_version(old_version) < parse_version(rel.get('min_upgrade_from', '0.0.0')):
                raise UpdateError(f'{new_version} can only be installed over {rel["min_upgrade_from"]} or newer; '
                                  f'install the intermediate release first.')
            from .backup import _pg
            if rel.get('requires_pg_major') and _pg(lay, cfg).binary_major() != int(rel['requires_pg_major']):
                raise UpdateError('this release needs another PostgreSQL major version (pg_upgrade required)')
            report['integrity'] = check_payload_integrity(lay.install_root, new_version)
            proc = manage(lay, ['license', 'update-allowed', '--release-date', rel['release_date']], cfg=cfg, version=new_version)
            verdict = json.loads((proc.stdout.strip().splitlines() or ['{}'])[-1] or '{}')
            if proc.returncode == 0 and verdict.get('allowed') is False:
                raise UpdateError(verdict.get('reason') or 'no update entitlement')
            report['entitlement'] = verdict
        if new_version == old_version:
            report['note'] = 'same version: repair only'

        # 2. pre-checks ------------------------------------------------------------------------------
        with log.step('prechecks'):
            from .backup import _creds, _pg as pgf
            user, pw = _creds(lay)
            db_bytes = pgf(lay, cfg).database_size(user=user or cfg.db_user, password=pw, db_name=cfg.db_name)
            media_bytes = sum(f.stat().st_size for f in lay.media_dir.rglob('*') if f.is_file()) if lay.media_dir.exists() else 0
            free = shutil.disk_usage(lay.data_root).free
            if free < 2 * (db_bytes + media_bytes) + 512 * 1024 * 1024:
                raise UpdateError('not enough free disk space for the pre-update backup')
            plan = migration_plan(lay, cfg, version=new_version)
            irreversible = [m for m in plan if m in set(rel.get('irreversible_migrations', []))]
            report.update(pending_migrations=plan, irreversible=irreversible)
            if irreversible and not acknowledge_irreversible:
                raise UpdateError(f'this update contains irreversible database changes ({", ".join(irreversible)}). '
                                  'Re-run it with the acknowledgement after reading the release notes.')

        # 3+4. stop + verified backup (gate) ---------------------------------------------------------
        lay.maintenance_flag.parent.mkdir(parents=True, exist_ok=True)
        lay.maintenance_flag.write_text(json.dumps({'reason': f'update to {new_version}'}), encoding='utf-8')
        save_state('backup')
        with log.step('stop'):
            controller.stop()
        with log.step('pre-update-backup'):
            backup = create_backup(lay, cfg, kind='pre-update', include_media=True, actor='updater')
            report['backup'] = backup['name']
    except Exception as exc:
        raise early_failure(exc) from exc

    # 5+6. migrate, switch, start, health -------------------------------------------------------------
    save_state('migrate', backup=backup['name'])
    try:
        with log.step('migrate', count=len(plan)):
            proc = manage(lay, ['migrate', '--noinput'], cfg=cfg, version=new_version)
            if proc.returncode != 0:
                raise UpdateError(f'database upgrade failed: {proc.stderr.strip()[-800:]}')
        with log.step('collectstatic'):
            proc = manage(lay, ['collectstatic', '--noinput', '--clear', '-v', '0'], cfg=cfg, version=new_version)
            if proc.returncode != 0:
                raise UpdateError(f'collectstatic failed: {proc.stderr.strip()[-400:]}')
        with log.step('switch'):
            from .django_bridge import set_active
            controller.switch_version(lay, cfg, new_dir)
            set_active(lay, new_version)
            cfg.version = new_version
            install_config.record_history(cfg, 'update', previous=old_version, backup=backup['name'])
            install_config.write(lay.install_json, cfg)
            install_config.write_env(lay.env_file, install_config.env_values(cfg, lay))
            lay.maintenance_flag.unlink(missing_ok=True)
            controller.start()
        with log.step('health'):
            h = _health(lay, cfg, new_version, timeout=health_timeout)
            if not h['ok']:
                raise UpdateError(f'the new version did not become healthy: {h.get("last")}')
        mark_verified(lay, new_dir)
        with log.step('finalize-accounts'):
            report['legacy_grants_removed'] = controller.finalize(lay)
        state_file.unlink(missing_ok=True)
        report.update(ok=True, rolled_back=False)
        log.write(step='update', status='complete', to=new_version)
        return report
    except Exception as exc:
        report.update(ok=False, changed=True, error=str(exc))
        log.write(step='rollback', status='start', reason=str(exc))
        save_state('rollback', backup=backup['name'], error=str(exc))
        try:
            report['rollback'] = rollback(lay, backup_name=backup['name'], app_dir=prev_dir, version=old_version,
                                          controller=controller, log=log, health_timeout=health_timeout,
                                          accounts=before_accounts)
            if report['rollback'].get('ok'):
                state_file.unlink(missing_ok=True)
        except Exception as rexc:
            report['rollback'] = {'ok': False, 'error': str(rexc)}
            log.write(step='rollback', status='failed', error=str(rexc))
        if not report['rollback'].get('ok'):
            report['rollback']['action'] = ('Run "gtrade-ctl update rollback" or restore the pre-update backup '
                                            f'{backup["name"]} manually. Nothing was deleted.')
        report['rolled_back'] = bool(report['rollback'].get('ok'))
        raise UpdateError(json.dumps(report, default=str))


def rollback(lay, *, backup_name: str, app_dir: Path, version: str, controller: Controller | None = None,
             log: StepLog | None = None, health_timeout=180, accounts: dict | None = None) -> dict:
    """Restore the pre-update database backup and run the previous version's code again.

    This is the ONLY way back across a schema change. Data entered after the backup is not in
    it, which is why a manual rollback requires the caller's explicit confirmation (CLI flag)."""
    from .backup import restore_backup
    controller = controller or Controller()
    log = log or StepLog(lay.logs_dir / 'update' / f'rollback-{time.strftime("%Y%m%d-%H%M%S")}.jsonl')
    cfg = install_config.read(lay.install_json)
    path = lay.backups_dir / 'db' / backup_name
    with log.step('database'):
        controller.prepare(lay, cfg, Path(app_dir), accounts)  # previous code's wrappers + accounts
        ensure_database(lay, cfg, controller)
    with log.step('restore-database', backup=backup_name):
        restored = restore_backup(lay, cfg, path, stop_app=controller.stop, start_app=lambda: None)
    with log.step('switch-back', version=version):
        from .django_bridge import set_active
        controller.switch_version(lay, cfg, Path(app_dir), accounts)
        set_active(lay, version, Path(app_dir))
        cfg.version = version
        install_config.record_history(cfg, 'rollback', backup=backup_name)
        install_config.write(lay.install_json, cfg)
        install_config.write_env(lay.env_file, install_config.env_values(cfg, lay))
        lay.maintenance_flag.unlink(missing_ok=True)
        controller.start()
    with log.step('health'):
        h = _health(lay, cfg, version, timeout=health_timeout)
    log.write(step='rollback', status='complete' if h['ok'] else 'unhealthy', version=version)
    if h['ok']:
        mark_verified(lay, Path(app_dir))
    return {'ok': h['ok'], 'restored': restored, 'version': version, **({} if h['ok'] else {'health': h.get('last')})}
