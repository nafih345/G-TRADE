"""Where everything lives on a Windows installation.

Two roots, never mixed:

* **Install root** (read-only program files). The NSIS installer puts it at
  ``$INSTDIR\\resources\\server`` (electron-builder ``extraResources`` -> ``server``), e.g.
  ``C:\\Program Files\\G OPTICALS\\resources\\server``; installs made before the rebrand live in
  ``C:\\Program Files\\G-TRADE\\resources\\server``::

      runtime\\python\\            embedded CPython 3.12 + site-packages
      runtime\\pgsql\\bin\\        PostgreSQL 17 binaries (pg_ctl, postgres, pg_dump, pg_restore, psql)
      runtime\\nginx\\  runtime\\winsw\\
      app\\<version>\\backend\\     Django project
      app\\<version>\\windows\\     gtrade_ctl + gtrade_server
      app\\<version>\\frontend\\    built SPA (VITE_EDITION=local)
      app\\current.json            which version is active (side-by-side updates)

* **Data root** (customer data, survives uninstall), default ``C:\\ProgramData\\G-TRADE``::

      config\\   install.json, gtrade.env, secrets.dpapi, nginx.conf, tls\\, license\\
      pgsql\\data\\  media\\  static\\  backups\\{db,media,app}\\  logs\\{app,web,db,install,update,backup}\\
      run\\      maintenance.flag, locks
      updates\\  staged update packages

Both roots can be overridden with ``GTRADE_INSTALL_ROOT`` / ``GTRADE_DATA_ROOT``; tests always do.
With neither ``--install-root`` nor ``GTRADE_INSTALL_ROOT``, :func:`resolve_install_root` finds the
real installation. There is no hardcoded program-folder guess any more: the old default
``C:\\Program Files\\G-TRADE ERP`` (without ``resources\\server``) never existed on an install, so a
backup started without a root looked for ``...\\G-TRADE ERP\\runtime\\pgsql\\bin\\pg_dump.exe``.
"""

from __future__ import annotations

import json
import os
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

DEFAULT_DATA_ROOT = Path(os.environ.get('ProgramData', r'C:\ProgramData')) / 'G-TRADE'
# Program Files folder names an installer-made install uses (electron-builder productName), newest
# first. Last-resort lookup only, and only if the folder really holds the server runtime.
KNOWN_PRODUCT_DIRS = ('G OPTICALS', 'G-TRADE')
SERVER_SUBDIR = Path('resources') / 'server'
DB_SERVICE = 'GTrade-DB'

DATA_SUBDIRS = (
    'config', 'config/tls', 'config/license',
    'pgsql',
    'media', 'static',
    'backups/db', 'backups/media', 'backups/app',
    'logs/app', 'logs/web', 'logs/db', 'logs/install', 'logs/update', 'logs/backup', 'logs/services',
    'run', 'updates', 'temp',
)


@dataclass(frozen=True)
class Layout:
    install_root: Path
    data_root: Path
    # How install_root was found (explicit / env / bundled-python / install.json / service /
    # known-folder / not-found); quoted in "runtime missing" errors so a wrong root is diagnosable.
    install_root_source: str = field(default='explicit', compare=False)

    # ---- data root -------------------------------------------------------------------
    @property
    def config_dir(self) -> Path:
        return self.data_root / 'config'

    @property
    def install_json(self) -> Path:
        return self.config_dir / 'install.json'

    @property
    def install_complete(self) -> Path:
        """Written only after every server install step succeeded. The NSIS wizard treats a server
        installation as an upgrade/repair (mode locked, setup pages skipped) only when it exists,
        so a fresh install that stopped part-way is resumed through the full wizard."""
        return self.config_dir / 'install.complete'

    @property
    def env_file(self) -> Path:
        return self.config_dir / 'gtrade.env'

    @property
    def secrets_file(self) -> Path:
        return self.config_dir / 'secrets.dpapi'

    @property
    def tls_dir(self) -> Path:
        return self.config_dir / 'tls'

    @property
    def license_dir(self) -> Path:
        return self.config_dir / 'license'

    @property
    def nginx_conf(self) -> Path:
        return self.config_dir / 'nginx.conf'

    @property
    def pg_data(self) -> Path:
        return self.data_root / 'pgsql' / 'data'

    @property
    def media_dir(self) -> Path:
        return self.data_root / 'media'

    @property
    def static_dir(self) -> Path:
        return self.data_root / 'static'

    @property
    def backups_dir(self) -> Path:
        return self.data_root / 'backups'

    @property
    def logs_dir(self) -> Path:
        return self.data_root / 'logs'

    @property
    def run_dir(self) -> Path:
        return self.data_root / 'run'

    @property
    def maintenance_flag(self) -> Path:
        return self.run_dir / 'maintenance.flag'

    @property
    def updates_dir(self) -> Path:
        return self.data_root / 'updates'

    @property
    def temp_dir(self) -> Path:
        return self.data_root / 'temp'

    # ---- install root ----------------------------------------------------------------
    @property
    def runtime_dir(self) -> Path:
        return self.install_root / 'runtime'

    @property
    def python_exe(self) -> Path:
        return self.runtime_dir / 'python' / 'python.exe'

    @property
    def pg_bin(self) -> Path:
        override = os.environ.get('GTRADE_PG_BIN')
        return Path(override) if override else self.runtime_dir / 'pgsql' / 'bin'

    @property
    def nginx_dir(self) -> Path:
        override = os.environ.get('GTRADE_NGINX_DIR')
        return Path(override) if override else self.runtime_dir / 'nginx'

    @property
    def winsw_exe(self) -> Path:
        return self.runtime_dir / 'winsw' / 'WinSW-x64.exe'

    @property
    def services_dir(self) -> Path:
        """Per-service WinSW copies + XML. Lives in the install root (Program Files ACLs)."""
        return self.install_root / 'services'

    @property
    def apps_dir(self) -> Path:
        return self.install_root / 'app'

    @property
    def current_json(self) -> Path:
        return self.apps_dir / 'current.json'

    def app_dir(self, version: str) -> Path:
        return self.apps_dir / version

    def ensure_data_tree(self) -> list[Path]:
        created = []
        for sub in DATA_SUBDIRS:
            p = self.data_root / sub
            if not p.exists():
                p.mkdir(parents=True, exist_ok=True)
                created.append(p)
        return created


def _program_files() -> list[Path]:
    out = []
    for var in ('ProgramW6432', 'ProgramFiles'):
        val = os.environ.get(var)
        if val and all(str(p).lower() != val.lower() for p in out):
            out.append(Path(val))
    return out or [Path(r'C:\Program Files')]


def looks_like_install_root(path: Path) -> bool:
    """A server install root holds the embedded interpreter plus the admin entry point/app tree."""
    try:
        return (path / 'runtime' / 'python' / 'python.exe').is_file() and (
            (path / 'gtrade-ctl.cmd').is_file() or (path / 'manifest.json').is_file() or (path / 'app').is_dir())
    except OSError:
        return False


def _from_executable(executable: str | None) -> Path | None:
    """``<root>\\runtime\\python\\python.exe`` -> ``<root>``. The GTrade-App service, gtrade-ctl.cmd and
    the installer all run the bundled interpreter, so this is the tree actually in use."""
    if not executable:
        return None
    exe = Path(executable)
    if exe.parent.name.lower() == 'python' and exe.parent.parent.name.lower() == 'runtime':
        root = exe.parent.parent.parent
        return root if looks_like_install_root(root) else None
    return None


def _from_install_json(data_root: Path) -> Path | None:
    try:
        cfg = json.loads((data_root / 'config' / 'install.json').read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return None  # missing, or unreadable without Administrator rights
    root = cfg.get('install_root') if isinstance(cfg, dict) else None
    return Path(root) if root and looks_like_install_root(Path(root)) else None


def service_image_path(name: str) -> str | None:
    """Read-only registry lookup of a service's command line. Never touches the service."""
    if os.name != 'nt':
        return None
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, rf'SYSTEM\CurrentControlSet\Services\{name}') as key:
            return str(winreg.QueryValueEx(key, 'ImagePath')[0])
    except OSError:
        return None


def _from_service(image_path: str | None) -> Path | None:
    """GTrade-DB is registered as ``"<root>\\runtime\\pgsql\\bin\\pg_ctl.exe" runservice ...``."""
    if not image_path:
        return None
    m = re.match(r'\s*(?:"([^"]+)"|(\S+))', image_path)
    if not m:
        return None
    exe = Path(m.group(1) or m.group(2))
    if exe.name.lower() != 'pg_ctl.exe' or [p.lower() for p in exe.parts[-4:-1]] != ['runtime', 'pgsql', 'bin']:
        return None
    root = exe.parents[3]
    return root if looks_like_install_root(root) else None


def _from_known_dirs(program_files: list[Path]) -> Path | None:
    for pf in program_files:
        for name in KNOWN_PRODUCT_DIRS:
            root = pf / name / SERVER_SUBDIR
            if looks_like_install_root(root):
                return root
    return None


def resolve_install_root(data_root: Path | None = None, *, env=None, executable: str | None = None,
                         db_service_image=service_image_path, program_files=None) -> tuple[Path, str]:
    """Find the install root when none was passed. First hit wins:

    1. ``GTRADE_INSTALL_ROOT`` (set for the GTrade-App service and in gtrade.env)
    2. the running bundled interpreter (``<root>\\runtime\\python\\python.exe``)
    3. ``install_root`` recorded in ``<data>\\config\\install.json`` (when readable)
    4. the registered GTrade-DB service's pg_ctl.exe path (registry, read-only)
    5. ``<Program Files>\\{G OPTICALS,G-TRADE}\\resources\\server`` if it really holds the runtime

    A build/staging tree is used only when the caller is actually running from it (2). If nothing is
    found, the fresh-install default is returned with source ``not-found`` so callers can report
    "runtime missing" instead of guessing. ``db_service_image`` may be a callable(name) or a string.
    """
    env = os.environ if env is None else env
    if env.get('GTRADE_INSTALL_ROOT'):
        return Path(env['GTRADE_INSTALL_ROOT']), 'env'
    found = _from_executable(sys.executable if executable is None else executable)
    if found:
        return found, 'bundled-python'
    if data_root is not None:
        found = _from_install_json(Path(data_root))
        if found:
            return found, 'install.json'
    image = db_service_image(DB_SERVICE) if callable(db_service_image) else db_service_image
    found = _from_service(image)
    if found:
        return found, 'service'
    pf = _program_files() if program_files is None else [Path(p) for p in program_files]
    found = _from_known_dirs(pf)
    if found:
        return found, 'known-folder'
    return pf[0] / KNOWN_PRODUCT_DIRS[0] / SERVER_SUBDIR, 'not-found'


def layout(install_root: str | os.PathLike | None = None, data_root: str | os.PathLike | None = None) -> Layout:
    dr = Path(data_root or os.environ.get('GTRADE_DATA_ROOT') or DEFAULT_DATA_ROOT)
    if install_root:
        return Layout(install_root=Path(install_root), data_root=dr, install_root_source='explicit')
    ir, source = resolve_install_root(dr)
    return Layout(install_root=ir, data_root=dr, install_root_source=source)


def is_inside(child: Path, parent: Path) -> bool:
    try:
        child.resolve().relative_to(parent.resolve())
        return True
    except ValueError:
        return False


def check_root_path(path: Path, what: str = 'data folder') -> None:
    """A root must be a full path with every variable expanded.

    A relative path silently resolves against the caller's working directory (the installer runs
    from Program Files), and a leftover ``$NAME`` / ``%NAME%`` means an installer constant or
    environment variable was never expanded - the cause of the 2026-11-12 "error 2" install.
    """
    text = str(path)
    # "$NAME" / "${NAME}" / "$(NAME)" = unexpanded NSIS or shell token; "\\srv\D$\x" (admin share) is fine.
    if re.search(r'\$[A-Za-z_{(]', text) or re.search(r'%[^%\\/]+%', text):
        raise ValueError(f'The {what} path "{text}" contains an unexpanded variable. '
                         f'Use a full path such as C:\\ProgramData\\G-TRADE.')
    if not Path(text).is_absolute():
        raise ValueError(f'The {what} must be a full path (for example C:\\ProgramData\\G-TRADE), not "{text}".')


def validate_data_root(data_root: Path, install_root: Path) -> None:
    """Refuse data folders that would be lost or wrongly protected.

    Customer data must never live inside Program Files (an uninstall or update replaces that
    tree, and its ACLs deny writes to the service accounts), nor be the install folder itself.
    """
    check_root_path(data_root)
    if is_inside(data_root, install_root) or is_inside(install_root, data_root):
        raise ValueError('The data folder must be outside the program folder.')
    pf = [os.environ.get(v) for v in ('ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432')]
    for root in filter(None, pf):
        if is_inside(data_root, Path(root)):
            raise ValueError('The data folder cannot be inside Program Files.')
    if len(data_root.parts) <= 1:
        raise ValueError('The data folder cannot be a drive root.')
