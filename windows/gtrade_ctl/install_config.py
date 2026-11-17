"""``install.json`` (what was installed) and ``gtrade.env`` (non-secret runtime settings).

``install.json`` is the single source of truth for an installation: mode, version, ports,
host names, installation id. The installer writes it once; upgrades update ``version`` and
``history`` but **never** change ``mode`` or ``install_id``.

``gtrade.env`` holds only non-secret settings for the services (paths, ports, hosts). Secrets
come from ``secrets.dpapi`` at process start (see gtrade_server). Keeping them apart means the
env file can be attached to a support ticket.
"""

from __future__ import annotations

import json
import os
import socket
import stat
import time
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path

MODES = ('standalone', 'server', 'workstation')
DEFAULT_HTTPS_PORT = 8443
DEFAULT_APP_PORT = 8001
DEFAULT_DB_PORT = 5544
SCHEMA_VERSION = 1


class ConfigError(ValueError):
    pass


@dataclass
class InstallConfig:
    mode: str
    version: str
    install_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    https_port: int = DEFAULT_HTTPS_PORT
    app_port: int = DEFAULT_APP_PORT
    db_port: int = DEFAULT_DB_PORT
    db_name: str = 'gtrade'
    db_user: str = 'gtrade'
    hostnames: list = field(default_factory=list)
    ip_addresses: list = field(default_factory=list)
    server_url: str = ''            # workstation: the LAN server it talks to
    ca_fingerprint: str = ''        # workstation: pinned SHA-256 of the server's CA
    data_root: str = ''
    install_root: str = ''
    created_at: str = field(default_factory=lambda: time.strftime('%Y-%m-%dT%H:%M:%S%z'))
    history: list = field(default_factory=list)
    schema: int = SCHEMA_VERSION

    def validate(self) -> 'InstallConfig':
        if self.mode not in MODES:
            raise ConfigError(f'mode must be one of {MODES}')
        for name in ('https_port', 'app_port', 'db_port'):
            port = int(getattr(self, name))
            if not 1024 <= port <= 65535:
                raise ConfigError(f'{name} must be between 1024 and 65535')
        if len({self.https_port, self.app_port, self.db_port}) != 3 and self.mode != 'workstation':
            raise ConfigError('https, app and database ports must differ')
        if self.mode == 'workstation':
            if not self.server_url.startswith('https://'):
                raise ConfigError('a workstation needs the https:// address of the LAN server')
        uuid.UUID(self.install_id)
        return self

    @property
    def is_server_side(self) -> bool:
        """Standalone and LAN Server run the database and backend; a workstation never does."""
        return self.mode in ('standalone', 'server')

    @property
    def bind_address(self) -> str:
        return '0.0.0.0' if self.mode == 'server' else '127.0.0.1'

    def origins(self) -> list[str]:
        hosts = ['localhost', '127.0.0.1', *self.hostnames, *self.ip_addresses]
        seen, out = set(), []
        for h in hosts:
            o = f'https://{h}:{self.https_port}'
            if o not in seen:
                seen.add(o)
                out.append(o)
        return out


def default_hostnames() -> tuple[list[str], list[str]]:
    """Hostname, FQDN and the machine's IPv4 addresses (for the TLS SAN list and ALLOWED_HOSTS)."""
    names, ips = [], []
    host = socket.gethostname()
    if host:
        names.append(host.upper() if host.isupper() else host)
        try:
            fqdn = socket.getfqdn()
            if fqdn and fqdn.lower() != host.lower():
                names.append(fqdn)
        except OSError:
            pass
        try:
            for info in socket.getaddrinfo(host, None, socket.AF_INET):
                ip = info[4][0]
                if not ip.startswith('127.') and ip not in ips:
                    ips.append(ip)
        except OSError:
            pass
    return names, ips


class ConfigAccessError(ConfigError):
    """A G-TRADE config file exists but this process may not read/write it (clear message, no traceback)."""


def _access_error(path: Path, exc: PermissionError, write: bool) -> ConfigAccessError:
    try:
        from .winacl import access_problem
        msg = access_problem(path, write=write)
    except Exception:  # diagnostics must never hide the original problem
        msg = None
    return ConfigAccessError(msg or f'Access denied to {path}: {exc}')


def elevation_message(layout, command: str) -> str:
    return (f'"gtrade-ctl {command}" must be run from an elevated Command Prompt. This prompt is not elevated '
            f'(a normal Command Prompt, PowerShell or VS Code terminal is not, even for an administrator '
            f'account), so Windows does not let it read {layout.config_dir}: the installation settings and '
            f'encrypted secrets there are readable only by Administrators, SYSTEM and the GTrade-App service, '
            f'by design. Right-click "Command Prompt", choose "Run as administrator" (the window title then '
            f'starts with "Administrator:"), run  cd /d "{layout.install_root}"  and then the same command '
            f'again. Nothing was changed. Do not change the permissions of the config folder.')


def _probe_open(path: Path, write: bool) -> None:
    """Open ``path`` for reading (and writing when ``write``) and close it again; nothing is changed.
    The read-only ATTRIBUTE is not a denial: atomic_write_text clears it before replacing the file."""
    try:
        with open(path, 'r+b' if write else 'rb'):
            return
    except PermissionError:
        try:
            readonly_attr = bool(getattr(os.stat(path), 'st_file_attributes', 0) & 0x1)
        except OSError:
            readonly_attr = False
        if not (write and readonly_attr):
            raise
    with open(path, 'rb'):
        pass


def require_access(layout, command: str, *, write: bool = False) -> None:
    """Fail fast, before any password prompt and before anything changes, when this process may not
    use the protected configuration that ``command`` needs: install.json (read; also write when
    ``write``), gtrade.env and secrets.dpapi (read).

    ``config\\`` is SYSTEM + Administrators Full, NT SERVICE\\GTrade-App read only
    (winacl.apply_data_root_policy). Under UAC, a prompt that was not started with "Run as
    administrator" holds Administrators only as a deny-only group, even for an administrator account,
    so it may read nothing there. On 2026-11-17 ``create-superadmin`` asked for the password twice and
    then died with a raw ``PermissionError [WinError 5] ... install.json``. The remedy is an elevated
    prompt, never a wider ACL: this function only opens the files and changes nothing."""
    denied = []
    for path, wr in ((layout.install_json, write), (layout.env_file, False), (layout.secrets_file, False)):
        try:
            _probe_open(path, wr)
        except FileNotFoundError:
            if path == layout.install_json:
                raise ConfigError(f'{path} not found - G-TRADE is not installed on this computer') from None
        except PermissionError as exc:
            denied.append((path, wr, exc))
    if not denied:
        return
    from .services import is_elevated
    if not is_elevated():
        raise ConfigAccessError(elevation_message(layout, command))
    path, wr, exc = denied[0]
    raise _access_error(path, exc, write=wr)  # elevated and still denied: damaged ACL (repair-permissions)


def _clear_readonly(path: Path) -> None:
    """Windows refuses to replace a file with the read-only attribute (a user or a copy tool may
    have set it). Clearing the attribute on our own config file is the only change made."""
    try:
        st = os.stat(path)
    except OSError:
        return
    if getattr(st, 'st_file_attributes', 0) & 0x1:  # FILE_ATTRIBUTE_READONLY
        os.chmod(path, stat.S_IREAD | stat.S_IWRITE)


def atomic_write_text(path: Path, text: str, encoding: str = 'utf-8') -> None:
    """Write ``text`` to ``path`` so a reader never sees a half-written file and a failure never
    destroys the previous version: unique temp file in the same folder (it inherits the folder's
    ACL), flush + fsync, then ``os.replace``. The temp file is removed on any failure."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f'.{path.name}.{os.getpid()}.{uuid.uuid4().hex[:8]}.tmp')
    try:
        with open(tmp, 'w', encoding=encoding, newline='') as fh:
            fh.write(text)
            fh.flush()
            os.fsync(fh.fileno())
        _clear_readonly(path)
        try:
            os.replace(tmp, path)
        except PermissionError:
            # Replacing can fail transiently while antivirus/indexer holds the old file; retry briefly.
            for delay in (0.2, 0.5, 1.0):
                time.sleep(delay)
                try:
                    os.replace(tmp, path)
                    break
                except PermissionError:
                    continue
            else:
                raise
    except PermissionError as exc:
        raise _access_error(path, exc, write=True) from exc
    finally:
        if tmp.exists():
            try:
                tmp.unlink()
            except OSError:
                pass


def read(path: Path) -> InstallConfig:
    # No separate exists() test: when this process may not list the config FOLDER (a prompt that is
    # not elevated), Windows makes even Path.exists() raise PermissionError, which escaped as a raw
    # traceback instead of the clear ConfigAccessError below (2026-11-17, create-superadmin).
    try:
        text = path.read_text(encoding='utf-8')
    except FileNotFoundError:
        raise ConfigError(f'{path} not found - G-TRADE is not installed on this computer') from None
    except PermissionError as exc:
        raise _access_error(path, exc, write=False) from exc
    data = json.loads(text)
    known = {f for f in InstallConfig.__dataclass_fields__}
    return InstallConfig(**{k: v for k, v in data.items() if k in known}).validate()


def write(path: Path, cfg: InstallConfig) -> None:
    cfg.validate()
    atomic_write_text(path, json.dumps(asdict(cfg), indent=2))
    # Plain-text copies the NSIS installer reads to detect an upgrade and lock the mode.
    atomic_write_text(path.parent / 'install.mode', cfg.mode, encoding='ascii')
    atomic_write_text(path.parent / 'install.version', cfg.version, encoding='ascii')


def record_history(cfg: InstallConfig, event: str, **details) -> None:
    cfg.history.append({'at': time.strftime('%Y-%m-%dT%H:%M:%S%z'), 'event': event, **details})
    cfg.history[:] = cfg.history[-50:]


# ---- gtrade.env --------------------------------------------------------------------------------
def env_values(cfg: InstallConfig, layout) -> dict:
    """Non-secret environment for GTrade-App and gtrade-ctl commands."""
    hosts = ['localhost', '127.0.0.1', *cfg.hostnames, *cfg.ip_addresses]
    return {
        'GTRADE_EDITION': 'local',
        'DJANGO_SETTINGS_MODULE': 'config.settings_local',
        'GTRADE_MODE': cfg.mode,
        'GTRADE_INSTALL_ID': cfg.install_id,
        'GTRADE_DATA_ROOT': str(layout.data_root),
        'GTRADE_INSTALL_ROOT': str(layout.install_root),
        'GTRADE_DB_HOST': '127.0.0.1',
        'GTRADE_DB_PORT': str(cfg.db_port),
        'GTRADE_DB_NAME': cfg.db_name,
        'GTRADE_DB_USER': cfg.db_user,
        'GTRADE_APP_BIND': '127.0.0.1',
        'GTRADE_APP_PORT': str(cfg.app_port),
        'GTRADE_HTTPS_PORT': str(cfg.https_port),
        'GTRADE_ALLOWED_HOSTS': ','.join(dict.fromkeys(hosts)),
        'GTRADE_ORIGINS': ','.join(cfg.origins()),
        'AUTO_MIGRATE': 'False',
        'PYTHONUTF8': '1',
        'PYTHONDONTWRITEBYTECODE': '1',
        'OPENBLAS_NUM_THREADS': '1',
    }


def write_env(path: Path, values: dict) -> None:
    for k, v in values.items():
        if '\n' in str(v):
            raise ConfigError(f'newline in env value {k}')
    lines = ['# G-TRADE ERP runtime settings. Generated by gtrade-ctl; contains no secrets.']
    lines += [f'{k}={v}' for k, v in sorted(values.items())]
    atomic_write_text(path, '\n'.join(lines) + '\n')


def read_env(path: Path) -> dict:
    out = {}
    if not path.exists():
        return out
    try:
        text = path.read_text(encoding='utf-8')
    except PermissionError as exc:
        raise _access_error(path, exc, write=False) from exc
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        k, v = line.split('=', 1)
        out[k.strip()] = v.strip()
    return out
