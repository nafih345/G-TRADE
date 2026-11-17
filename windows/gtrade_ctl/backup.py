"""L2 backups: PostgreSQL dump + uploaded files, verified, with retention and restore.

Layout: ``<data>\\backups\\db\\<name>\\`` with ``db.dump`` (pg_dump -Fc), ``media.zip`` and
``manifest.json`` (SHA-256 + size of each file, app version, install id, applied migrations).
``<data>\\backups\\db\\index.json`` summarises every backup for the status screen.

Credentials: the dump runs as the application role (it owns the database), so the GTrade-App
service can take scheduled/manual backups with the credentials it already has. Restore needs the
superuser (it creates a database) and is therefore gtrade-ctl only (Administrator).

Restore never overwrites: it restores into a NEW database, verifies it, then swaps names while the
application is stopped. The previous database is kept as ``<name>_pre_restore_<ts>``.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import os
import shutil
import time
import zipfile
from pathlib import Path

RETENTION = {'scheduled_daily': 14, 'scheduled_weekly': 8, 'scheduled_monthly': 12, 'pre-update': 5, 'pre-install': 5}


class BackupError(RuntimeError):
    pass


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open('rb') as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def _pg(lay, cfg):
    from .pg import PgRuntime
    return PgRuntime(lay.pg_bin, lay.pg_data, cfg.db_port, lay.logs_dir / 'db')


def _require_backup_tools(lay) -> None:
    """pg_dump / pg_restore / psql must be in the bundled runtime. Checked before any lock, folder,
    credential or database contact, with an error naming the folder and how it was found."""
    from .pg import PgRuntimeMissing, require_pg_tools
    try:
        require_pg_tools(lay)
    except PgRuntimeMissing as exc:
        raise BackupError(str(exc)) from exc


def _creds(lay, use_superuser=False):
    from . import secrets_store
    if os.environ.get('GTRADE_DB_PASSWORD') and not use_superuser:
        return os.environ.get('GTRADE_DB_USER', 'gtrade'), os.environ['GTRADE_DB_PASSWORD']
    s = secrets_store.load(lay.secrets_file)
    return ('postgres', s['db_superuser_password']) if use_superuser else (None, s['db_app_password'])


class _Lock:
    def __init__(self, path: Path, stale_seconds=6 * 3600):
        self.path, self.stale = path, stale_seconds

    def __enter__(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if self.path.exists() and time.time() - self.path.stat().st_mtime > self.stale:
            self.path.unlink()
        try:
            fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            raise BackupError('Another backup or restore is running. Try again in a few minutes.')
        os.write(fd, str(os.getpid()).encode())
        os.close(fd)
        return self

    def __exit__(self, *exc):
        try:
            self.path.unlink()
        except OSError:
            pass


def _applied_migrations(pg, user, password, db) -> dict:
    rows = pg.psql("SELECT app || ':' || max(name) FROM django_migrations GROUP BY app ORDER BY app",
                   user=user, password=password, db=db)
    return dict(r.split(':', 1) for r in rows.splitlines() if ':' in r)


def create_backup(lay, cfg, *, kind='manual', include_media=True, dest_dir: Path | None = None, actor='') -> dict:
    """Dump + media + manifest, then a quick verification. Returns the manifest."""
    if kind not in ('manual', 'scheduled', 'pre-update', 'pre-install', 'pre-restore', 'final'):
        raise BackupError(f'unknown backup kind {kind}')
    _require_backup_tools(lay)
    pg = _pg(lay, cfg)
    user, password = _creds(lay)
    user = user or cfg.db_user
    ts = dt.datetime.now().strftime('%Y%m%d-%H%M%S')
    name = f'gtrade-{kind}-{ts}'
    root = Path(dest_dir) if dest_dir else lay.backups_dir / 'db'
    out = root / name if not dest_dir else root
    with _Lock(lay.run_dir / 'backup.lock'):
        out.mkdir(parents=True, exist_ok=True)
        started = time.monotonic()
        dump = out / 'db.dump'
        pg.run('pg_dump', '-h', '127.0.0.1', '-p', str(cfg.db_port), '-U', user, '-d', cfg.db_name, '-Fc', '-Z', '6',
               '--no-password', '-f', str(dump), password=password, timeout=6 * 3600)
        manifest = {
            'name': name, 'kind': kind, 'created_at': dt.datetime.now(dt.timezone.utc).isoformat(), 'actor': actor,
            'app_version': cfg.version, 'install_id': cfg.install_id, 'db_name': cfg.db_name,
            'pg_major': pg.binary_major(), 'migrations': _applied_migrations(pg, user, password, cfg.db_name),
            'files': {'db.dump': {'sha256': _sha256(dump), 'bytes': dump.stat().st_size}},
        }
        if include_media and lay.media_dir.exists():
            mz = out / 'media.zip'
            with zipfile.ZipFile(mz, 'w', zipfile.ZIP_DEFLATED) as z:
                for f in sorted(lay.media_dir.rglob('*')):
                    if f.is_file():
                        z.write(f, f.relative_to(lay.media_dir).as_posix())
            manifest['files']['media.zip'] = {'sha256': _sha256(mz), 'bytes': mz.stat().st_size}
        manifest['seconds'] = round(time.monotonic() - started, 1)
        (out / 'manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    check = verify_backup(out, lay=lay, cfg=cfg)
    manifest['verified'] = check['ok']
    manifest['verification'] = check
    (out / 'manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    if not check['ok']:
        raise BackupError(f'backup {name} failed verification: {check.get("errors")}')
    manifest['path'] = str(out)
    if not dest_dir:
        write_index(lay)
    return manifest


def verify_backup(path: Path, *, lay=None, cfg=None, deep=False) -> dict:
    """Quick: checksums + archive readable (pg_restore --list, zip test). Deep: restore into a
    throwaway database in the same cluster, compare table count, then drop it."""
    path = Path(path)
    errors = []
    try:
        manifest = json.loads((path / 'manifest.json').read_text(encoding='utf-8'))
    except Exception as exc:
        return {'ok': False, 'errors': [f'manifest unreadable: {exc}']}
    for fname, meta in manifest.get('files', {}).items():
        f = path / fname
        if not f.exists():
            errors.append(f'{fname} missing')
        elif _sha256(f) != meta['sha256']:
            errors.append(f'{fname} checksum mismatch (file damaged or altered)')
    result = {'ok': False, 'errors': errors, 'deep': deep}
    if errors:
        return result
    if lay is not None and cfg is not None:
        try:
            _require_backup_tools(lay)
        except BackupError as exc:
            result['errors'].append(str(exc))
            return result
        pg = _pg(lay, cfg)
        listing = pg.run('pg_restore', '--list', str(path / 'db.dump'), check=False)
        if listing.returncode != 0:
            errors.append('database archive unreadable')
        else:
            result['objects'] = sum(1 for line in listing.stdout.splitlines() if line and not line.startswith(';'))
    if (path / 'media.zip').exists():
        with zipfile.ZipFile(path / 'media.zip') as z:
            bad = z.testzip()
            if bad:
                errors.append(f'media.zip damaged at {bad}')
            result['media_files'] = len(z.namelist())
    if deep and not errors and lay is not None:
        su, su_pw = _creds(lay, use_superuser=True)
        pg = _pg(lay, cfg)
        scratch = f'gtrade_verify_{int(time.time())}'
        try:
            pg.psql(f'CREATE DATABASE "{scratch}" OWNER "{cfg.db_user}" TEMPLATE template0', user=su, password=su_pw)
            pg.run('pg_restore', '-h', '127.0.0.1', '-p', str(cfg.db_port), '-U', su, '-d', scratch, '--no-owner',
                   f'--role={cfg.db_user}', '--exit-on-error', str(path / 'db.dump'), password=su_pw, timeout=6 * 3600)
            result['restored_tables'] = int(pg.psql("SELECT count(*) FROM information_schema.tables WHERE table_schema='public'",
                                                    user=su, password=su_pw, db=scratch) or 0)
            restored = _applied_migrations(pg, su, su_pw, scratch)
            if restored != manifest.get('migrations'):
                errors.append('restored migration state differs from the manifest')
        except Exception as exc:
            errors.append(f'test restore failed: {exc}')
        finally:
            pg.psql(f'DROP DATABASE IF EXISTS "{scratch}" WITH (FORCE)', user=su, password=su_pw, check=False)
    result['ok'] = not errors
    return result


def list_backups(lay) -> list[dict]:
    root = lay.backups_dir / 'db'
    out = []
    if not root.exists():
        return out
    for d in sorted(root.iterdir(), reverse=True):
        mf = d / 'manifest.json'
        if d.is_dir() and mf.exists():
            try:
                m = json.loads(mf.read_text(encoding='utf-8'))
            except Exception:
                continue
            out.append({'name': m['name'], 'kind': m['kind'], 'created_at': m['created_at'], 'app_version': m['app_version'],
                        'verified': m.get('verified', False), 'bytes': sum(f['bytes'] for f in m['files'].values()),
                        'path': str(d)})
    out.sort(key=lambda b: b['created_at'], reverse=True)  # newest first, whatever the kind
    return out


def write_index(lay, last_error: str | None = None) -> dict:
    items = list_backups(lay)
    idx_path = lay.backups_dir / 'db' / 'index.json'
    previous = {}
    if idx_path.exists():
        try:
            previous = json.loads(idx_path.read_text(encoding='utf-8'))
        except Exception:
            previous = {}
    index = {'updated_at': dt.datetime.now(dt.timezone.utc).isoformat(), 'count': len(items), 'backups': items[:100],
             'last_success': items[0]['created_at'] if items else None,
             'last_scheduled': next((b['created_at'] for b in items if b['kind'] == 'scheduled'), None),
             'last_error': last_error if last_error is not None else previous.get('last_error'),
             'total_bytes': sum(b['bytes'] for b in items),
             'offsite_copy': previous.get('offsite_copy')}
    idx_path.parent.mkdir(parents=True, exist_ok=True)
    idx_path.write_text(json.dumps(index, indent=1), encoding='utf-8')
    return index


def apply_retention(lay, now: dt.datetime | None = None) -> list[str]:
    """Delete only expired *scheduled* and old pre-update/pre-install backups. Manual and final
    backups are never deleted automatically; the newest verified backup is always kept."""
    now = now or dt.datetime.now(dt.timezone.utc)
    items = list_backups(lay)
    keep = set()
    if items:
        keep.add(next((b['name'] for b in items if b['verified']), items[0]['name']))
    sched = [b for b in items if b['kind'] == 'scheduled']
    days, weeks, months = [], [], []
    for b in sched:  # newest first
        t = dt.datetime.fromisoformat(b['created_at'])
        day, week, month = t.date(), t.isocalendar()[:2], (t.year, t.month)
        if day not in [d for d, _ in days] and len(days) < RETENTION['scheduled_daily']:
            days.append((day, b['name']))
        if week not in [w for w, _ in weeks] and len(weeks) < RETENTION['scheduled_weekly']:
            weeks.append((week, b['name']))
        if month not in [m for m, _ in months] and len(months) < RETENTION['scheduled_monthly']:
            months.append((month, b['name']))
    keep |= {n for _, n in days + weeks + months}
    for kind in ('pre-update', 'pre-install'):
        keep |= {b['name'] for b in [x for x in items if x['kind'] == kind][:RETENTION[kind]]}
    deleted = []
    for b in items:
        if b['kind'] in ('scheduled', 'pre-update', 'pre-install') and b['name'] not in keep:
            shutil.rmtree(b['path'], ignore_errors=True)
            deleted.append(b['name'])
    write_index(lay)
    return deleted


def restore_backup(lay, cfg, path: Path, *, stop_app, start_app, keep_media=False) -> dict:
    """Restore into a new database, verify, swap. Caller passes stop_app/start_app callbacks
    (Windows services in production, the test stack in tests). Never drops the old database."""
    from .pg import _check_ident
    path = Path(path)
    _require_backup_tools(lay)
    check = verify_backup(path, lay=lay, cfg=cfg)
    if not check['ok']:
        raise BackupError(f'backup failed verification, nothing restored: {check["errors"]}')
    manifest = json.loads((path / 'manifest.json').read_text(encoding='utf-8'))
    if manifest.get('install_id') and manifest['install_id'] != cfg.install_id:
        # Allowed (moving to new hardware / disaster recovery), but recorded.
        check['note'] = 'backup from another installation'
    su, su_pw = _creds(lay, use_superuser=True)
    pg = _pg(lay, cfg)
    ts = dt.datetime.now().strftime('%Y%m%d%H%M%S')
    new_db, old_db = f'{cfg.db_name}_restore_{ts}', f'{cfg.db_name}_pre_restore_{ts}'
    _check_ident(new_db)
    _check_ident(old_db)
    with _Lock(lay.run_dir / 'backup.lock'):
        pg.psql(f'CREATE DATABASE "{new_db}" OWNER "{cfg.db_user}" TEMPLATE template0', user=su, password=su_pw)
        try:
            pg.run('pg_restore', '-h', '127.0.0.1', '-p', str(cfg.db_port), '-U', su, '-d', new_db, '--no-owner',
                   f'--role={cfg.db_user}', '--exit-on-error', str(path / 'db.dump'), password=su_pw, timeout=6 * 3600)
            if _applied_migrations(pg, su, su_pw, new_db) != manifest.get('migrations'):
                raise BackupError('restored database does not match the backup manifest')
        except Exception:
            pg.psql(f'DROP DATABASE IF EXISTS "{new_db}" WITH (FORCE)', user=su, password=su_pw, check=False)
            raise
        maint = lay.maintenance_flag
        maint.parent.mkdir(parents=True, exist_ok=True)
        maint.write_text(json.dumps({'reason': f'restoring backup {manifest["name"]}'}), encoding='utf-8')
        try:
            stop_app()
            pg.psql(f"SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '{cfg.db_name}' "
                    "AND pid <> pg_backend_pid()", user=su, password=su_pw)
            pg.psql(f'ALTER DATABASE "{cfg.db_name}" RENAME TO "{old_db}"', user=su, password=su_pw)
            pg.psql(f'ALTER DATABASE "{new_db}" RENAME TO "{cfg.db_name}"', user=su, password=su_pw)
            pg.psql(f'ALTER SCHEMA public OWNER TO "{cfg.db_user}"', user=su, password=su_pw, db=cfg.db_name)
            media_note = None
            if (path / 'media.zip').exists() and not keep_media:
                staged = lay.data_root / f'media.restore_{ts}'
                staged.mkdir(parents=True, exist_ok=True)  # an empty archive still restores an (empty) folder
                with zipfile.ZipFile(path / 'media.zip') as z:
                    for member in z.namelist():  # zip-slip guard
                        target = (staged / member).resolve()
                        if not str(target).startswith(str(staged.resolve())):
                            raise BackupError(f'unsafe path in media archive: {member}')
                    z.extractall(staged)
                if lay.media_dir.exists():
                    lay.media_dir.rename(lay.data_root / f'media.pre_restore_{ts}')
                staged.rename(lay.media_dir)
                media_note = f'previous files kept in media.pre_restore_{ts}'
        finally:
            start_app()
            maint.unlink(missing_ok=True)
    return {'restored': manifest['name'], 'previous_database_kept_as': old_db, 'media': media_note,
            'from_app_version': manifest.get('app_version'), 'verification': check}
