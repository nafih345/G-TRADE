"""Where archive files live.

FILESYSTEM — settings.BACKUP_DIR on the server's own disk (desktop installs; outside every public
             web directory). Right for a machine whose disk persists.
DATABASE   — chunked into security_backupchunk rows. The hosted backend (Render) has an ephemeral
             disk that is wiped on every deploy and restart, so files written there would vanish;
             the database is the only durable store it has. (These rows are never part of a backup.)

Pick with BACKUP_STORAGE=filesystem|database (default: database on cloud hosts, filesystem otherwise).
"""
import contextlib
import os
import re
import shutil
import tempfile
from pathlib import Path

from django.conf import settings
from django.db import transaction

from ..models import BackupChunk

CHUNK_BYTES = 1024 * 1024
SAFE_NAME = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_.-]{0,190}\.zip$')


def temp_dir():
    path = getattr(settings, 'BACKUP_TEMP_DIR', None)
    if path:
        Path(path).mkdir(parents=True, exist_ok=True)
        return str(path)
    return None


def new_temp_path(suffix='.zip'):
    fd, path = tempfile.mkstemp(prefix='erp-backup-', suffix=suffix, dir=temp_dir())
    os.close(fd)
    return path


class FilesystemStore:
    location = 'FILESYSTEM'
    label = 'Server disk'

    @property
    def root(self):
        root = Path(settings.BACKUP_DIR).resolve()
        root.mkdir(parents=True, exist_ok=True)
        return root

    def _path(self, record):
        if not SAFE_NAME.match(record.filename or ''):
            raise ValueError('Unsafe backup filename')
        path = (self.root / record.filename).resolve()
        if path.parent != self.root:
            raise ValueError('Backup path escapes the backup directory')
        return path

    def save(self, record, src_path):
        dest = self._path(record)
        partial = dest.with_name(dest.name + '.partial')
        shutil.copyfile(src_path, partial)
        os.replace(partial, dest)

    def exists(self, record):
        try:
            return self._path(record).is_file()
        except ValueError:
            return False

    @contextlib.contextmanager
    def materialize(self, record):
        path = self._path(record)
        if not path.is_file():
            raise FileNotFoundError(record.filename)
        yield str(path)

    def iter_bytes(self, record):
        with open(self._path(record), 'rb') as fh:
            yield from iter(lambda: fh.read(CHUNK_BYTES), b'')

    def delete(self, record):
        with contextlib.suppress(FileNotFoundError, ValueError):
            self._path(record).unlink()


class DatabaseStore:
    location = 'DATABASE'
    label = 'Database storage'

    def save(self, record, src_path):
        with transaction.atomic():
            BackupChunk.objects.filter(record=record).delete()
            batch = []
            seq = 0
            with open(src_path, 'rb') as fh:
                for data in iter(lambda: fh.read(CHUNK_BYTES), b''):
                    batch.append(BackupChunk(record=record, seq=seq, data=data))
                    seq += 1
                    if len(batch) >= 8:
                        BackupChunk.objects.bulk_create(batch)
                        batch = []
            if batch:
                BackupChunk.objects.bulk_create(batch)

    def exists(self, record):
        return BackupChunk.objects.filter(record=record).exists()

    def iter_bytes(self, record):
        seqs = list(BackupChunk.objects.filter(record=record).order_by('seq').values_list('seq', flat=True))
        if not seqs:
            raise FileNotFoundError(record.filename)
        for seq in seqs:
            data = BackupChunk.objects.filter(record=record, seq=seq).values_list('data', flat=True).first()
            yield bytes(data)

    @contextlib.contextmanager
    def materialize(self, record):
        path = new_temp_path()
        try:
            with open(path, 'wb') as out:
                for data in self.iter_bytes(record):
                    out.write(data)
            yield path
        finally:
            with contextlib.suppress(OSError):
                os.remove(path)

    def delete(self, record):
        BackupChunk.objects.filter(record=record).delete()


_STORES = {'FILESYSTEM': FilesystemStore(), 'DATABASE': DatabaseStore()}


def configured_store():
    name = str(getattr(settings, 'BACKUP_STORAGE', 'filesystem')).upper()
    return _STORES.get(name, _STORES['FILESYSTEM'])


def store_for(record):
    return _STORES[record.storage_location]


def capacity_bytes():
    return int(getattr(settings, 'BACKUP_STORAGE_CAPACITY_MB', 5120)) * 1024 * 1024


def ephemeral_warning():
    """Text when the chosen storage will not survive a redeploy, else ''."""
    if configured_store().location == 'FILESYSTEM' and getattr(settings, 'IS_CLOUD', False):
        return ('Backups are written to this host\'s temporary disk and will be lost on the next deploy or '
                'restart. Set BACKUP_STORAGE=database (or download each backup).')
    return ''
