"""The backup archive: a zip holding one JSON-lines file per table plus a manifest.

Why a logical (ORM-level) dump rather than pg_dump / copying db.sqlite3: the same build runs on
the desktop (SQLite or a local PostgreSQL) and on the hosted stack (Render + Neon), and the hosts
have no matching pg_dump binary. Dumping through Django works on every engine, lets a backup taken
on one install be restored on another, and never touches database credentials.

Layout
    manifest.json                 format, versions, engine, migration state, per-file row counts and
                                  SHA-256 hashes
    data/<app>.<model>.jsonl      line 1: {"model": ..., "fields": [attname, ...]}; then one JSON
                                  array of column values per row

Excluded: Django sessions, and this app's own tables (security policy, sign-in sessions, lockout
counters, 2FA secrets, the audit log and the backup history) — a restore must not rewind the
record of itself. Uploaded media files are not part of the database and are not included.

Restore replaces every included table inside ONE transaction: if anything fails — a bad row, a
constraint, the process dying — the database is left exactly as it was.
"""
import base64
import datetime
import decimal
import hashlib
import json
import re
import uuid
import zipfile

from django.apps import apps
from django.conf import settings
from django.core.management.color import no_style
from django.db import DEFAULT_DB_ALIAS, connections, transaction
from django.db.migrations.recorder import MigrationRecorder
from django.utils import timezone
from django.utils.duration import duration_iso_string

FORMAT = 'greensol-erp-backup'
FORMAT_VERSION = 1
APP_NAME = 'Greensol Optical ERP'
EXCLUDED_APPS = frozenset({'security', 'sessions'})
MANIFEST = 'manifest.json'
ENTRY_RE = re.compile(r'^data/([a-z][a-z0-9_]{0,99})\.([a-z][a-z0-9_]{0,99})\.jsonl$')
MAX_COMPRESSION_RATIO = 1000  # a zip-bomb guard; JSON text compresses ~10–50×
INSERT_BATCH = 500


class BackupError(Exception):
    """A failure whose message is safe to show to the operator."""


class IncompatibleBackup(BackupError):
    pass


# ---- which tables ------------------------------------------------------------------------------

def backup_models():
    """Every concrete table the ORM manages, including auto-created many-to-many tables."""
    out = []
    for model in apps.get_models(include_auto_created=True):
        meta = model._meta
        if meta.app_label in EXCLUDED_APPS or meta.proxy or not meta.managed or meta.swapped:
            continue
        out.append(model)
    return sorted(out, key=lambda m: m._meta.label_lower)


def _scope_apps():
    return {m._meta.app_label for m in backup_models()}


def applied_migrations(using=DEFAULT_DB_ALIAS):
    scope = _scope_apps()
    applied = {}
    for app_label, name in MigrationRecorder(connections[using]).applied_migrations():
        if app_label in scope:
            applied.setdefault(app_label, []).append(name)
    return {k: sorted(v) for k, v in sorted(applied.items())}


# ---- value encoding ----------------------------------------------------------------------------

def _encoder(field):
    kind = field.get_internal_type()
    if kind == 'BinaryField':
        return lambda v: None if v is None else base64.b64encode(bytes(v)).decode('ascii')
    if kind == 'DurationField':
        return lambda v: None if v is None else duration_iso_string(v)
    return None


def _default(o):
    if isinstance(o, (datetime.datetime, datetime.date, datetime.time)):
        return o.isoformat()
    if isinstance(o, decimal.Decimal):
        return str(o)
    if isinstance(o, uuid.UUID):
        return str(o)
    if isinstance(o, (bytes, bytearray, memoryview)):
        return base64.b64encode(bytes(o)).decode('ascii')
    if isinstance(o, datetime.timedelta):
        return duration_iso_string(o)
    raise TypeError(f'Cannot serialise {type(o).__name__}')


class _HashingWriter:
    def __init__(self, raw):
        self.raw = raw
        self.sha = hashlib.sha256()

    def write(self, data):
        self.sha.update(data)
        self.raw.write(data)


# ---- dump --------------------------------------------------------------------------------------

def write_archive(fileobj, *, backup_identifier, using=DEFAULT_DB_ALIAS, heartbeat=None):
    """Write a complete archive of the database to `fileobj`; returns the manifest dict.

    All tables are read inside one transaction (REPEATABLE READ on PostgreSQL) so the archive is a
    consistent snapshot even while the shop keeps billing."""
    connection = connections[using]
    entries = {}
    total_rows = 0
    with zipfile.ZipFile(fileobj, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
        with transaction.atomic(using=using):
            if connection.vendor == 'postgresql' and not _in_outer_atomic(connection):
                with connection.cursor() as cursor:
                    cursor.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
            migrations = applied_migrations(using)
            for model in backup_models():
                fields = list(model._meta.concrete_fields)
                attnames = [f.attname for f in fields]
                encoders = [(i, enc) for i, enc in ((i, _encoder(f)) for i, f in enumerate(fields)) if enc]
                name = f'data/{model._meta.label_lower}.jsonl'
                rows = 0
                with zf.open(name, 'w', force_zip64=True) as raw:
                    out = _HashingWriter(raw)
                    header = {'model': model._meta.label_lower, 'fields': attnames}
                    out.write((json.dumps(header) + '\n').encode('utf-8'))
                    qs = model._base_manager.using(using).order_by('pk').values_list(*attnames)
                    for values in qs.iterator(chunk_size=2000):
                        if encoders:
                            values = list(values)
                            for i, enc in encoders:
                                values[i] = enc(values[i])
                        out.write((json.dumps(values, default=_default, ensure_ascii=False) + '\n').encode('utf-8'))
                        rows += 1
                        if heartbeat and rows % 5000 == 0:
                            heartbeat()
                entries[name] = {'model': model._meta.label_lower, 'rows': rows, 'sha256': out.sha.hexdigest()}
                total_rows += rows
                if heartbeat:
                    heartbeat()
        manifest = {
            'format': FORMAT,
            'format_version': FORMAT_VERSION,
            'application': APP_NAME,
            'backup_identifier': backup_identifier,
            'created_at': timezone.now().isoformat(),
            'database_engine': connection.vendor,
            'django_version': _django_version(),
            'migrations': migrations,
            'excluded': sorted(EXCLUDED_APPS) + ['media files'],
            'table_count': len(entries),
            'total_rows': total_rows,
            'entries': entries,
        }
        zf.writestr(MANIFEST, json.dumps(manifest, indent=2))
    return manifest


def _in_outer_atomic(connection):
    # SET TRANSACTION must be the first statement of a transaction; inside an outer atomic block
    # (the test runner) our atomic() is only a savepoint.
    return len(connection.atomic_blocks) > 1


def _django_version():
    import django
    return django.get_version()


def manifest_summary(manifest):
    """The part of a manifest worth keeping on the BackupRecord (no per-file hashes)."""
    return {k: manifest.get(k) for k in ('format_version', 'application', 'backup_identifier', 'created_at',
                                          'database_engine', 'django_version', 'table_count', 'total_rows',
                                          'excluded')}


# ---- validation --------------------------------------------------------------------------------

def _limits():
    return int(getattr(settings, 'BACKUP_MAX_UNCOMPRESSED_MB', 8192)) * 1024 * 1024


def open_archive(path):
    try:
        return zipfile.ZipFile(path, 'r')
    except (zipfile.BadZipFile, OSError, ValueError):
        raise BackupError('The file is not a valid backup archive (it is not a readable zip file).')


def _check_structure(zf):
    names = set()
    total = 0
    for info in zf.infolist():
        name = info.filename
        if info.is_dir() or (name != MANIFEST and not ENTRY_RE.match(name)):
            raise BackupError('The archive contains unexpected files — it is not a Greensol ERP backup.')
        if name in names:
            raise BackupError('The archive contains duplicate entries.')
        if info.flag_bits & 0x1:
            raise BackupError('Encrypted archives are not supported.')
        names.add(name)
        total += info.file_size
        if info.compress_size and info.file_size / info.compress_size > MAX_COMPRESSION_RATIO:
            raise BackupError('The archive is malformed (abnormal compression ratio).')
    if MANIFEST not in names:
        raise BackupError('The archive has no manifest — it is not a Greensol ERP backup.')
    if total > _limits():
        raise BackupError('The backup is larger than this server accepts (BACKUP_MAX_UNCOMPRESSED_MB).')
    return names


def read_manifest(zf):
    info = zf.getinfo(MANIFEST)
    if info.file_size > 20 * 1024 * 1024:
        raise BackupError('The backup manifest is too large.')
    try:
        manifest = json.loads(zf.read(MANIFEST).decode('utf-8'))
    except (ValueError, UnicodeDecodeError, zipfile.BadZipFile):
        raise BackupError('The backup manifest is unreadable.')
    if not isinstance(manifest, dict) or manifest.get('format') != FORMAT:
        raise BackupError('This file is not a Greensol ERP database backup.')
    version = manifest.get('format_version')
    if not isinstance(version, int) or version < 1:
        raise BackupError('The backup manifest is malformed.')
    if version > FORMAT_VERSION:
        raise IncompatibleBackup('This backup was made by a newer version of the application. Update first.')
    if not isinstance(manifest.get('entries'), dict) or not isinstance(manifest.get('migrations'), dict):
        raise BackupError('The backup manifest is malformed.')
    return manifest


def compatibility(manifest, using=DEFAULT_DB_ALIAS):
    """('same' | 'older', warnings) or raise IncompatibleBackup."""
    current = applied_migrations(using)
    backup = manifest.get('migrations') or {}
    newer = []
    older = False
    for app_label, names in backup.items():
        have = set(current.get(app_label, []))
        if not isinstance(names, list):
            raise BackupError('The backup manifest is malformed.')
        missing = [n for n in names if n not in have]
        if missing:
            newer.append(f'{app_label}.{missing[0]}')
        if have - set(names):
            older = True
    for app_label in current:
        if app_label not in backup:
            older = True
    if newer:
        raise IncompatibleBackup('This backup was made by a newer version of the application '
                                 f'(it includes {newer[0]}). Update the application before restoring it.')
    warnings = []
    if older:
        warnings.append('This backup was made by an older version of the application. Fields added since '
                        'then will take their default values.')
    return ('older' if older else 'same'), warnings


def validate_archive(path, *, deep=True, using=DEFAULT_DB_ALIAS):
    """Check structure, manifest, compatibility and (deep) every entry's hash and row count.
    Returns {'manifest', 'compatibility', 'warnings'}; raises BackupError."""
    with open_archive(path) as zf:
        names = _check_structure(zf)
        manifest = read_manifest(zf)
        entries = manifest['entries']
        data_names = names - {MANIFEST}
        if set(entries) != data_names:
            raise BackupError('The archive does not match its manifest (files missing or added).')
        known = {m._meta.label_lower for m in backup_models()}
        level, warnings = compatibility(manifest, using)
        unknown = []
        for name, meta in entries.items():
            label = '.'.join(ENTRY_RE.match(name).groups())
            if not isinstance(meta, dict) or meta.get('model') != label:
                raise BackupError('The backup manifest is malformed.')
            if label not in known:
                if label.split('.')[0] in EXCLUDED_APPS:
                    raise BackupError('The archive contains tables that are never part of a backup.')
                unknown.append(label)
            if deep:
                _verify_entry(zf, name, meta)
        if unknown:
            if level == 'same':
                raise IncompatibleBackup('The backup contains tables this installation does not have.')
            warnings.append(f'{len(unknown)} table(s) from the older version no longer exist and will be skipped.')
    return {'manifest': manifest, 'compatibility': level, 'warnings': warnings}


def _verify_entry(zf, name, meta):
    sha = hashlib.sha256()
    lines = 0
    try:
        with zf.open(name) as fh:
            for chunk in iter(lambda: fh.read(1024 * 1024), b''):
                sha.update(chunk)
                lines += chunk.count(b'\n')
    except (zipfile.BadZipFile, OSError, EOFError):
        raise BackupError(f'The backup is damaged ({name} cannot be read).')
    if sha.hexdigest() != meta.get('sha256'):
        raise BackupError(f'The backup is damaged ({name} failed its integrity check).')
    if lines - 1 != meta.get('rows'):
        raise BackupError(f'The backup is damaged ({name} has the wrong number of rows).')


# ---- restore -----------------------------------------------------------------------------------

def _iter_rows(zf, name):
    with zf.open(name) as fh:
        header = None
        for raw in fh:
            line = raw.decode('utf-8').rstrip('\n')
            if not line:
                continue
            if header is None:
                header = json.loads(line)
                yield header
                continue
            yield json.loads(line)


def restore_archive(path, *, using=DEFAULT_DB_ALIAS, heartbeat=None):
    """Replace every backed-up table with the archive's rows, atomically. The archive must already
    have passed validate_archive(). Returns {'tables': n, 'rows': n}."""
    connection = connections[using]
    models = {m._meta.label_lower: m for m in backup_models()}
    total = 0
    tables = 0
    with open_archive(path) as zf:
        manifest = read_manifest(zf)
        with transaction.atomic(using=using):
            # FKs are DEFERRABLE INITIALLY DEFERRED on both engines, so delete-all-then-insert in
            # any order is consistent by commit time; check_constraints() below verifies early.
            for model in models.values():
                model._base_manager.using(using).all()._raw_delete(using)
            for name in sorted(manifest['entries']):
                label = '.'.join(ENTRY_RE.match(name).groups())
                model = models.get(label)
                if model is None:
                    continue  # validated as a table removed since the backup's (older) version
                rows = _iter_rows(zf, name)
                header = next(rows)
                total += _insert_rows(model, header.get('fields') or [], rows, using, heartbeat)
                tables += 1
            connection.check_constraints()
            if connection.vendor == 'postgresql':
                sql = connection.ops.sequence_reset_sql(no_style(), list(models.values()))
                if sql:
                    with connection.cursor() as cursor:
                        for statement in sql:
                            cursor.execute(statement)
    return {'tables': tables, 'rows': total}


def _insert_rows(model, attnames, rows, using, heartbeat):
    by_attname = {f.attname: f for f in model._meta.concrete_fields}
    columns = [(i, by_attname[a]) for i, a in enumerate(attnames) if a in by_attname]
    fields = [f for _, f in columns]
    if not fields:
        return 0
    # Columns added after an older backup was taken get the model default; timestamps maintained
    # by auto_now(_add) have none, so they are stamped with the restore time.
    stamped = [f.attname for f in model._meta.concrete_fields
               if f not in fields and (getattr(f, 'auto_now', False) or getattr(f, 'auto_now_add', False))]
    now = timezone.now()
    manager = model._base_manager
    batch = []
    count = 0
    for values in rows:
        kwargs = {attname: now for attname in stamped}
        for i, field in columns:
            value = values[i]
            kwargs[field.attname] = None if value is None else field.to_python(value)
        batch.append(model(**kwargs))
        if len(batch) >= INSERT_BATCH:
            count += _flush(manager, batch, model, using)
            batch = []
            if heartbeat:
                heartbeat()
    if batch:
        count += _flush(manager, batch, model, using)
    return count


def _flush(manager, batch, model, using):
    # raw=True writes the stored values verbatim (no auto_now overwrite, no signals).
    fields = [f for f in model._meta.concrete_fields]
    connection = connections[using]
    size = max(1, connection.ops.bulk_batch_size(fields, batch) or len(batch))
    for start in range(0, len(batch), size):
        manager._insert(batch[start:start + size], fields=fields, using=using, raw=True)
    return len(batch)
