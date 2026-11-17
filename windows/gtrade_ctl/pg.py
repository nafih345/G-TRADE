"""The installation's private PostgreSQL 17 cluster.

Rules that are never broken:

* ``initdb`` runs **only** when the data folder does not exist or is empty. A folder with
  ``PG_VERSION`` is an existing cluster: it is verified, never re-initialised. A non-empty folder
  that is *not* a cluster stops the installer with an error. There is no code path that deletes,
  truncates or re-initialises customer data.
* The cluster listens on loopback only (``listen_addresses = 'localhost'``) and ``pg_hba.conf``
  allows ``scram-sha-256`` from 127.0.0.1/::1 only. LAN workstations never reach PostgreSQL.
* The superuser ``postgres`` has a generated password and is used only by gtrade-ctl for
  maintenance. The application connects as ``gtrade``, which owns the ``gtrade`` database and is
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION.
* ``public`` schema: CREATE revoked from PUBLIC, the app role owns it; CONNECT on the database is
  revoked from PUBLIC.
* Passwords reach libpq through ``PGPASSWORD`` in the child environment, never on a command line.
* initdb gets the superuser password from a one-shot file (``gtrade-pw-*``) created with a protected
  DACL (Administrators + the process's own SID only), shredded straight after initdb, and swept
  again (stale files from an interrupted run) before every initdb and every install/repair.
* Process identity: initdb/pg_ctl/postgres always drop to a restricted token (Administrators =
  deny-only), so the cluster and log folders also carry one inheritable Modify ACE for the SID the
  installer runs as - see winacl.grant_operator and
  G_OPTICALS_POSTGRESQL_INITDB_PERMISSION_FIX_REPORT.md.
* An interrupted initdb leaves ``initdb.in-progress`` next to the data folder; a non-empty data
  folder with that marker (or a PG_VERSION without global/pg_control) is a *partial* cluster that is
  reported, never deleted or re-initialised automatically.
"""

from __future__ import annotations

import json
import os
import re
import secrets as _secrets
import shutil
import socket
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path

REQUIRED_MAJOR = 17
SUPERUSER = 'postgres'
PWFILE_PREFIX = 'gtrade-pw-'
INITDB_MARKER = 'initdb.in-progress'
PARTIAL_RECOVERY = (
    'The database folder {data} holds an INCOMPLETE database from an interrupted first setup. Nothing was '
    'changed or deleted. Recovery (G_OPTICALS_POSTGRESQL_INITDB_PERMISSION_FIX_REPORT.md, section 8): '
    'as Administrator rename the folder to keep it (for example data.incomplete-<date>), delete '
    '{marker}, then run the setup again. Do this only if this folder never held real business data; '
    'otherwise contact support first.')


class PgError(RuntimeError):
    pass


@dataclass
class PgRuntime:
    bin_dir: Path
    data_dir: Path
    port: int
    log_dir: Path
    _operator_granted: bool = field(default=False, init=False, repr=False, compare=False)

    def exe(self, name: str) -> str:
        p = self.bin_dir / (name + ('.exe' if os.name == 'nt' else ''))
        if not p.exists():
            raise PgError(f'PostgreSQL program not found: {p}')
        return str(p)

    # ---- low-level helpers --------------------------------------------------------------------
    def _env(self, password: str | None = None) -> dict:
        env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
        env['PGCLIENTENCODING'] = 'UTF8'
        env['PGCONNECT_TIMEOUT'] = '5'
        if password is not None:
            env['PGPASSWORD'] = password
        return env

    def run(self, prog: str, *args: str, password: str | None = None, check=True, timeout=300,
            input_text: str | None = None) -> subprocess.CompletedProcess:
        proc = subprocess.run([self.exe(prog), *args], capture_output=True, text=True, timeout=timeout,
                              env=self._env(password), input=input_text, encoding='utf-8', errors='replace')
        if check and proc.returncode != 0:
            raise PgError(f'{prog} failed ({proc.returncode}): {(proc.stderr or proc.stdout).strip()[-600:]}')
        return proc

    def psql(self, sql: str, *, user: str, password: str, db: str = 'postgres', check=True) -> str:
        proc = self.run('psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-At', '-h', '127.0.0.1', '-p', str(self.port),
                        '-U', user, '-d', db, input_text=sql, password=password, check=check)
        return proc.stdout.strip()

    # ---- inspection ---------------------------------------------------------------------------
    def binary_major(self) -> int:
        out = self.run('pg_ctl', '--version').stdout
        m = re.search(r'(\d+)\.(\d+)', out)
        if not m:
            raise PgError(f'cannot parse PostgreSQL version from {out!r}')
        return int(m.group(1))

    @property
    def initdb_marker(self) -> Path:
        return self.data_dir.parent / INITDB_MARKER

    def cluster_state(self) -> str:
        """'absent' | 'empty' | 'cluster' | 'partial' (interrupted initdb) | 'foreign' (non-empty
        folder that is not a cluster). Only 'absent' and 'empty' may ever be initialised."""
        d = self.data_dir
        if not d.exists():
            return 'absent'
        has_entries = any(d.iterdir())
        if has_entries and self.initdb_marker.exists():
            return 'partial'
        if (d / 'PG_VERSION').exists():
            # initdb writes PG_VERSION before the bootstrap backend creates global/pg_control.
            return 'cluster' if (d / 'global' / 'pg_control').exists() else 'partial'
        if not has_entries:
            return 'empty'
        return 'foreign'

    def partial_message(self) -> str:
        return PARTIAL_RECOVERY.format(data=self.data_dir, marker=self.initdb_marker)

    def ensure_operator_access(self, required: bool = False) -> str | None:
        """Make the cluster + log folders usable by the restricted token PostgreSQL drops to (see the
        module docstring). Adds one ACE for this process's SID; cached per instance."""
        if self._operator_granted:
            return None
        from . import winacl
        folders = [f for f in (self.data_dir, self.log_dir) if f.is_dir()]
        try:
            sid = winacl.grant_operator(*folders)
        except winacl.AclError as exc:
            if required:
                raise PgError(f'Could not give the database program access to its folders: {exc}') from None
            return None
        self._operator_granted = True
        return sid

    def sweep_stale_pwfiles(self) -> int:
        """Shred one-shot password files left by an interrupted earlier run. Returns how many."""
        parent = self.data_dir.parent
        try:
            stale = [f for f in parent.glob(PWFILE_PREFIX + '*') if f.is_file()] if parent.is_dir() else []
        except OSError:
            stale = []
        return sum(1 for f in stale if _shred(f))

    def cluster_major(self) -> int | None:
        f = self.data_dir / 'PG_VERSION'
        return int(f.read_text().strip().split('.')[0]) if f.exists() else None

    def is_running(self) -> bool:
        self.ensure_operator_access()
        proc = self.run('pg_ctl', 'status', '-D', str(self.data_dir), check=False)
        return proc.returncode == 0

    def is_ready(self) -> bool:
        proc = self.run('pg_isready', '-h', '127.0.0.1', '-p', str(self.port), '-t', '3', check=False)
        return proc.returncode == 0

    # ---- lifecycle ----------------------------------------------------------------------------
    def initdb(self, superuser_password: str) -> None:
        state = self.cluster_state()
        if state == 'cluster':
            raise PgError('A database cluster already exists here; it will not be re-initialised.')
        if state == 'foreign':
            raise PgError(f'{self.data_dir} is not empty and is not a PostgreSQL cluster. '
                          'Choose an empty folder; nothing was changed.')
        if state == 'partial':
            raise PgError(self.partial_message())
        if self.binary_major() != REQUIRED_MAJOR:
            raise PgError(f'PostgreSQL {REQUIRED_MAJOR} binaries are required')
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.log_dir.mkdir(parents=True, exist_ok=True)
        self.sweep_stale_pwfiles()
        sid = self.ensure_operator_access(required=True)
        marker = self.initdb_marker
        marker.write_text(json.dumps({'started': time.strftime('%Y-%m-%dT%H:%M:%S'), 'pid': os.getpid(),
                                      'data_dir': str(self.data_dir)}), encoding='utf-8')
        ok = False
        try:
            pwfile = self._write_pwfile(superuser_password, sid)
            try:
                self.run('initdb', '-D', str(self.data_dir), '-U', SUPERUSER, '--pwfile', str(pwfile),
                         '-E', 'UTF8', '--locale=C', '--auth-local=scram-sha-256', '--auth-host=scram-sha-256',
                         '--data-checksums')
                ok = True
            except PgError as exc:
                raise PgError(_redact(str(exc), superuser_password)) from None
            finally:
                for _ in range(10):  # retry briefly, e.g. an antivirus scanner holding the file
                    if _shred(pwfile):
                        break
                    time.sleep(0.3)
        finally:
            # On failure initdb empties the folder itself; keep the marker only if it could not.
            if ok or not any(self.data_dir.iterdir()):
                marker.unlink(missing_ok=True)
        self.write_config()

    def _write_pwfile(self, password: str, operator_sid: str | None) -> Path:
        """One-shot password file. Protected DACL = Administrators (the elevated installer) + this
        process's own SID (the identity of the restricted initdb child). Never Users, Everyone or
        NETWORK SERVICE. Its name is random; the password never appears on a command line."""
        from . import winacl
        principals = [winacl.ADMINISTRATORS]
        own = operator_sid or winacl.current_user_sid()
        if own:
            principals.append(own)
        for _ in range(5):
            path = self.data_dir.parent / f'{PWFILE_PREFIX}{_secrets.token_hex(8)}'
            if path.exists():
                continue
            try:
                winacl.create_private_file(path, (password + '\n').encode('utf-8'), principals)
            except winacl.AclError as exc:
                _shred(path)
                raise PgError(f'Could not create the one-time database password file: {exc}') from None
            return path
        raise PgError('Could not create the one-time database password file (name collision)')

    def write_config(self, ram_bytes: int | None = None) -> None:
        """Append our managed block to postgresql.conf (idempotent) and rewrite pg_hba.conf."""
        ram = ram_bytes or _total_ram()
        mb = ram // (1024 * 1024)
        shared = max(128, min(mb // 4, 2048))
        effective = max(512, mb // 2)
        self.log_dir.mkdir(parents=True, exist_ok=True)
        managed = {
            'listen_addresses': "'localhost'",
            'port': str(self.port),
            'max_connections': '60',
            'password_encryption': "'scram-sha-256'",
            'shared_buffers': f"'{shared}MB'",
            'effective_cache_size': f"'{effective}MB'",
            'work_mem': "'16MB'",
            'maintenance_work_mem': "'128MB'",
            'wal_level': "'replica'",
            'max_wal_size': "'2GB'",
            'checkpoint_timeout': "'15min'",
            'logging_collector': 'on',
            'log_directory': "'" + str(self.log_dir).replace('\\', '/') + "'",
            'log_filename': "'postgresql-%a.log'",
            'log_truncate_on_rotation': 'on',
            'log_rotation_age': "'1d'",
            'log_min_duration_statement': '1000',
            'log_connections': 'off',
            'ssl': 'off',  # loopback only; TLS is terminated by nginx for clients
            'timezone': "'UTC'",
        }
        conf = self.data_dir / 'postgresql.conf'
        text = conf.read_text(encoding='utf-8')
        begin, end = '# >>> G-TRADE managed settings >>>', '# <<< G-TRADE managed settings <<<'
        text = re.sub(re.escape(begin) + r'.*?' + re.escape(end) + r'\n?', '', text, flags=re.S)
        block = '\n'.join([begin, *(f'{k} = {v}' for k, v in managed.items()), end]) + '\n'
        conf.write_text(text.rstrip('\n') + '\n\n' + block, encoding='utf-8')
        (self.data_dir / 'pg_hba.conf').write_text(
            '# Generated by gtrade-ctl: loopback only, SCRAM passwords only.\n'
            '# TYPE  DATABASE  USER  ADDRESS        METHOD\n'
            'local   all       all                  scram-sha-256\n'
            'host    all       all   127.0.0.1/32   scram-sha-256\n'
            'host    all       all   ::1/128        scram-sha-256\n', encoding='utf-8')

    def start(self, wait_seconds=60) -> None:
        """Start without a service (installer/test use). Services use ``sc start GTrade-DB``."""
        self.log_dir.mkdir(parents=True, exist_ok=True)
        self.ensure_operator_access()
        if self.is_running():
            return
        log = self.log_dir / 'pg_ctl-start.log'
        # pg_ctl start keeps the postmaster's stdio; send it to a file so capture never blocks.
        proc = subprocess.run([self.exe('pg_ctl'), 'start', '-D', str(self.data_dir), '-w', '-t', str(wait_seconds),
                               '-l', str(log)], env=self._env(), stdout=subprocess.DEVNULL,
                              stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL, timeout=wait_seconds + 30)
        if proc.returncode != 0:
            tail = log.read_text(encoding='utf-8', errors='replace')[-800:] if log.exists() else ''
            raise PgError(f'PostgreSQL did not start: {tail}')

    def stop(self, mode='fast') -> None:
        if self.is_running():
            self.run('pg_ctl', 'stop', '-D', str(self.data_dir), '-m', mode, '-w', '-t', '120')

    def wait_ready(self, timeout=60) -> None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self.is_ready():
                return
            time.sleep(1)
        raise PgError('PostgreSQL is not accepting connections')

    # ---- clean-shutdown evidence (G_OPTICALS_SELFTEST_SHUTDOWN_AND_PROGRAM_FILES_FIX_REPORT.md) ---
    def control_state(self) -> str:
        """'Database cluster state' from pg_control (pg_controldata), e.g. 'shut down' or 'in production'.
        Written by the shutdown checkpoint itself: the authoritative record of a clean shutdown."""
        out = self.run('pg_controldata', '-D', str(self.data_dir), check=False).stdout or ''
        for line in out.splitlines():
            if line.startswith('Database cluster state:'):
                return line.split(':', 1)[1].strip()
        return 'unknown'

    def postmaster_pid(self) -> int | None:
        try:
            return int((self.data_dir / 'postmaster.pid').read_text(errors='replace').splitlines()[0])
        except (OSError, ValueError, IndexError):
            return None

    def log_offsets(self) -> dict:
        """{file: size} of the server log files now - pass to shutdown_report to read only what follows."""
        return {p.name: p.stat().st_size for p in self.log_dir.glob('postgresql-*.log')} if self.log_dir.exists() else {}

    def log_since(self, offsets: dict) -> str:
        parts = []
        for p in sorted(self.log_dir.glob('postgresql-*.log')):
            data = p.read_bytes()
            start = offsets.get(p.name, 0)
            parts.append(data[start if start <= len(data) else 0:].decode('utf-8', 'replace'))
        return ''.join(parts)

    def shutdown_report(self, postmaster_pid: int | None, log_offsets: dict, exit_code: int | None = None,
                        drain_timeout: float = 60) -> dict:
        """Evidence that the cluster stopped cleanly. Call after the stop returned (pg_ctl stop, or SCM
        STOPPED - which pg_ctl runservice reports even when the postmaster did NOT exit in time).
        Waits until every process of THIS cluster (the postmaster ``postmaster_pid`` and its children,
        incl. the syslogger that writes the log) has exited, so the log is complete, then assesses."""
        deadline = time.monotonic() + drain_timeout
        alive = cluster_processes(postmaster_pid)
        while alive and time.monotonic() < deadline:
            time.sleep(0.25)
            alive = cluster_processes(postmaster_pid)
        return assess_shutdown(control_state=self.control_state(),
                               pidfile_exists=(self.data_dir / 'postmaster.pid').exists(),
                               live_pids=alive, log_text=self.log_since(log_offsets), exit_code=exit_code)

    # ---- roles and database -------------------------------------------------------------------
    def provision(self, *, superuser_password: str, app_user: str, app_password: str, db_name: str) -> dict:
        """Create/repair the application role and database with least privilege. Idempotent."""
        _check_ident(app_user)
        _check_ident(db_name)
        su = dict(user=SUPERUSER, password=superuser_password)
        pw = app_password.replace("'", "''")
        exists_role = self.psql(f"SELECT 1 FROM pg_roles WHERE rolname = '{app_user}'", **su) == '1'
        verb = 'ALTER' if exists_role else 'CREATE'
        self.psql(f"{verb} ROLE \"{app_user}\" WITH LOGIN PASSWORD '{pw}' NOSUPERUSER NOCREATEDB "
                  f"NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 50;", **su)
        created_db = False
        if self.psql(f"SELECT 1 FROM pg_database WHERE datname = '{db_name}'", **su) != '1':
            self.psql(f'CREATE DATABASE "{db_name}" OWNER "{app_user}" ENCODING \'UTF8\' '
                      f"LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0;", **su)
            created_db = True
        self.psql(f'REVOKE ALL ON DATABASE "{db_name}" FROM PUBLIC; '
                  f'GRANT CONNECT, TEMPORARY ON DATABASE "{db_name}" TO "{app_user}";', **su)
        self.psql(f'ALTER SCHEMA public OWNER TO "{app_user}"; REVOKE CREATE ON SCHEMA public FROM PUBLIC;',
                  db=db_name, **su)
        return {'role': app_user, 'database': db_name, 'role_existed': exists_role, 'database_created': created_db}

    def verify(self, *, app_user: str, app_password: str, db_name: str, superuser_password: str | None = None) -> dict:
        """Connectivity + privilege checks used by install, repair, health and updates."""
        report = {'binary_major': self.binary_major(), 'cluster_major': self.cluster_major(),
                  'running': self.is_running(), 'ready': self.is_ready()}
        if report['cluster_major'] not in (None, report['binary_major']):
            report['error'] = (f'cluster is PostgreSQL {report["cluster_major"]} but binaries are '
                               f'{report["binary_major"]}: a pg_upgrade is required')
            return report
        row = self.psql("SELECT current_user || '|' || rolsuper::text || '|' || rolcreatedb::text || '|' || "
                        "rolcreaterole::text || '|' || version() FROM pg_roles WHERE rolname = current_user",
                        user=app_user, password=app_password, db=db_name)
        user, is_super, can_db, can_role, version = row.split('|', 4)
        report.update(app_user=user, app_is_superuser=is_super == 'true', app_can_create_db=can_db == 'true',
                      app_can_create_role=can_role == 'true', server_version=version.split(' on ')[0])
        report['least_privilege'] = not (report['app_is_superuser'] or report['app_can_create_db']
                                         or report['app_can_create_role'])
        if superuser_password:
            listen = self.psql('SHOW listen_addresses', user=SUPERUSER, password=superuser_password)
            report['listen_addresses'] = listen
            report['loopback_only'] = listen.strip() in ('localhost', '127.0.0.1', '127.0.0.1,::1', '::1,127.0.0.1')
            size = self.psql(f"SELECT pg_database_size('{db_name}')", user=SUPERUSER, password=superuser_password)
            report['database_bytes'] = int(size or 0)
        report['ok'] = bool(report['ready'] and report['least_privilege'] and report.get('loopback_only', True))
        return report

    def database_size(self, *, user, password, db_name) -> int:
        return int(self.psql(f"SELECT pg_database_size('{db_name}')", user=user, password=password, db=db_name) or 0)


# Log lines that only appear when a shutdown was NOT clean (immediate mode, a killed/crashed process,
# crash recovery). NB "checkpoint starting: shutdown immediate" is NOT one of them: every shutdown
# checkpoint logs its flags CHECKPOINT_IS_SHUTDOWN|CHECKPOINT_IMMEDIATE that way.
UNCLEAN_LOG_MARKERS = (
    'received immediate shutdown request',
    'terminating any other active server processes',
    'all server processes terminated; reinitializing',
    'was terminated by exception',
    'was terminated by signal',
    'PANIC:',
    'not properly shut down',
)
_EXITED_NONZERO = re.compile(r'process \(PID \d+\) exited with exit code [1-9]')


def assess_shutdown(*, control_state: str, pidfile_exists: bool, live_pids, log_text: str,
                    exit_code: int | None = None) -> dict:
    """Pure decision: did the cluster shut down cleanly?

    Clean = ALL of: pg_control says 'shut down' (written only by a completed shutdown checkpoint;
    an immediate stop, a kill or a crash leaves 'in production'); postmaster.pid removed (the
    postmaster's last act on a normal exit; a killed postmaster leaves it); no process of the cluster
    still alive; the service's exit code (when known) is 0; the log since the stop has no unclean
    marker. ``database system is shut down`` is reported but deliberately NOT used as proof: it is
    logged by UnlinkLockFiles on EVERY postmaster exit (immediate shutdown and post-crash exits too),
    and it is the one line that reaches the file only through the syslogger after the postmaster has
    gone, so in service mode it may be written late or not at all after a perfectly clean shutdown
    (live log 2026-11-13 17:25:08; elevated self-test 22:01:56)."""
    problems = []
    if control_state != 'shut down':
        problems.append(f'pg_control cluster state is {control_state!r}, not \'shut down\'')
    if pidfile_exists:
        problems.append('postmaster.pid is still present (the postmaster did not exit normally)')
    if live_pids:
        problems.append(f'cluster processes still running: {sorted(live_pids)}')
    if exit_code not in (None, 0):
        problems.append(f'service exit code {exit_code}')
    markers = [m for m in UNCLEAN_LOG_MARKERS if m in log_text] + _EXITED_NONZERO.findall(log_text)
    if markers:
        problems.append(f'log shows an unclean stop: {markers}')
    return {
        'clean': not problems,
        'problems': problems,
        'control_state': control_state,
        'pidfile_exists': pidfile_exists,
        'live_pids': sorted(live_pids),
        'exit_code': exit_code,
        'shutdown_checkpoint_logged': bool(re.search(r'checkpoint starting: shutdown\b', log_text)),
        'checkpoint_complete_logged': 'checkpoint complete' in log_text,
        'final_line_logged': 'database system is shut down' in log_text,
    }


def process_table() -> list[tuple[int, int, str]]:
    """[(pid, parent_pid, exe_name)] of every process (Toolhelp snapshot; works without elevation)."""
    if os.name != 'nt':  # pragma: no cover
        return []
    import ctypes
    from ctypes import wintypes

    class PROCESSENTRY32W(ctypes.Structure):
        _fields_ = [('dwSize', wintypes.DWORD), ('cntUsage', wintypes.DWORD), ('th32ProcessID', wintypes.DWORD),
                    ('th32DefaultHeapID', ctypes.c_size_t), ('th32ModuleID', wintypes.DWORD),
                    ('cntThreads', wintypes.DWORD), ('th32ParentProcessID', wintypes.DWORD),
                    ('pcPriClassBase', ctypes.c_long), ('dwFlags', wintypes.DWORD), ('szExeFile', ctypes.c_wchar * 260)]
    k = ctypes.WinDLL('kernel32', use_last_error=True)
    k.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    k.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
    k.Process32FirstW.argtypes = k.Process32NextW.argtypes = [wintypes.HANDLE, ctypes.POINTER(PROCESSENTRY32W)]
    k.CloseHandle.argtypes = [wintypes.HANDLE]
    snap = k.CreateToolhelp32Snapshot(0x2, 0)  # TH32CS_SNAPPROCESS
    if snap in (None, wintypes.HANDLE(-1).value):
        raise PgError(f'process snapshot failed (Windows error {ctypes.get_last_error()})')
    out = []
    try:
        e = PROCESSENTRY32W()
        e.dwSize = ctypes.sizeof(e)
        ok = k.Process32FirstW(snap, ctypes.byref(e))
        while ok:
            out.append((e.th32ProcessID, e.th32ParentProcessID, e.szExeFile))
            ok = k.Process32NextW(snap, ctypes.byref(e))
    finally:
        k.CloseHandle(snap)
    return out


def cluster_processes(postmaster_pid: int | None) -> list[int]:
    """PIDs of postgres.exe processes that belong to ONE cluster: the postmaster itself and its direct
    children (checkpointer, syslogger, backends...). Never matches another installation's server."""
    if not postmaster_pid:
        return []
    return [pid for pid, ppid, name in process_table()
            if name.lower() == 'postgres.exe' and postmaster_pid in (pid, ppid)]


def _check_ident(name: str) -> None:
    if not re.fullmatch(r'[a-z_][a-z0-9_]{0,62}', name or ''):
        raise PgError(f'invalid identifier {name!r}')


def _shred(path: Path) -> bool:
    """Overwrite then delete. True when the file is gone afterwards."""
    try:
        if path.exists():
            size = path.stat().st_size
            with path.open('r+b') as fh:
                fh.write(os.urandom(max(size, 1)))
                fh.flush()
                os.fsync(fh.fileno())
            path.unlink()
    except OSError:
        try:
            path.unlink()  # could not overwrite: at least remove it
        except OSError:
            pass
    return not path.exists()


def _redact(text: str, *secret_values: str) -> str:
    for v in secret_values:
        if v:
            text = text.replace(v, '[REDACTED]')
    return text


def _total_ram() -> int:
    if os.name == 'nt':
        import ctypes

        class MEMORYSTATUSEX(ctypes.Structure):
            _fields_ = [('dwLength', ctypes.c_ulong), ('dwMemoryLoad', ctypes.c_ulong),
                        ('ullTotalPhys', ctypes.c_ulonglong), ('ullAvailPhys', ctypes.c_ulonglong),
                        ('ullTotalPageFile', ctypes.c_ulonglong), ('ullAvailPageFile', ctypes.c_ulonglong),
                        ('ullTotalVirtual', ctypes.c_ulonglong), ('ullAvailVirtual', ctypes.c_ulonglong),
                        ('sullAvailExtendedVirtual', ctypes.c_ulonglong)]
        stat = MEMORYSTATUSEX()
        stat.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
        ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(stat))
        return int(stat.ullTotalPhys)
    return 8 * 1024 ** 3  # pragma: no cover


def port_free(port: int, host='127.0.0.1') -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.5)
        return s.connect_ex((host, port)) != 0


def find_free_port(preferred: int, attempts=20) -> int:
    for p in range(preferred, preferred + attempts):
        if port_free(p):
            return p
    raise PgError(f'no free port near {preferred}')


class PgRuntimeMissing(PgError):
    """The bundled PostgreSQL programs are not where the resolved install root says they are."""


BACKUP_TOOLS = ('pg_dump', 'pg_restore', 'psql')


def require_pg_tools(lay, tools=BACKUP_TOOLS) -> Path:
    """Fail fast - before any lock, file or database contact - if the bundled PostgreSQL programs
    are missing. Never falls back to another PostgreSQL installation on the machine (a different
    major version would write dumps the bundled pg_restore cannot read, or vice versa)."""
    bin_dir = Path(lay.pg_bin)
    suffix = '.exe' if os.name == 'nt' else ''
    missing = [t + suffix for t in tools if not (bin_dir / (t + suffix)).is_file()]
    if missing:
        source = getattr(lay, 'install_root_source', 'explicit')
        how = 'GTRADE_PG_BIN' if os.environ.get('GTRADE_PG_BIN') else f'program folder {lay.install_root} (found via {source})'
        hint = ('No G OPTICALS server installation was found on this PC. Run the command through '
                'gtrade-ctl.cmd in the program folder, or pass --install-root.') if source == 'not-found' else (
                'This is expected on a Workstation install (it has no database). On a Standalone or Server '
                'install, run the installer again and choose Repair.')
        raise PgRuntimeMissing(f'PostgreSQL program(s) {", ".join(missing)} not found in {bin_dir} '
                               f'[{how}]. {hint}')
    return bin_dir


def find_pg_bin(explicit: str | None = None) -> Path | None:
    """Development/test helper only: locate PostgreSQL 17 binaries when the bundled runtime is absent.
    Production code paths use ``Layout.pg_bin`` + :func:`require_pg_tools` and never call this."""
    candidates = [explicit, os.environ.get('GTRADE_PG_BIN'), r'C:\Program Files\PostgreSQL\17\bin']
    for c in filter(None, candidates):
        if (Path(c) / 'pg_ctl.exe').exists() or (Path(c) / 'pg_ctl').exists():
            return Path(c)
    found = shutil.which('pg_ctl')
    return Path(found).parent if found else None
