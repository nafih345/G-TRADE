"""Windows services.

| Service       | Program                      | Wrapper         | Account (hardened)      | Depends on |
|---------------|------------------------------|-----------------|-------------------------|------------|
| GTrade-DB     | PostgreSQL 17 (postgres.exe) | pg_ctl register | NT SERVICE\\GTrade-DB    | (RPCSS)    |
| GTrade-App    | python -m gtrade_server      | WinSW 2.12.0    | NT SERVICE\\GTrade-App   | GTrade-DB  |
| GTrade-Web    | nginx                        | WinSW 2.12.0    | NT SERVICE\\GTrade-Web   | GTrade-App |

Each service runs as its own *virtual service account* (``NT SERVICE\\<service id>``): no password,
not an administrator, not usable for interactive logon, and its SID (``S-1-5-80-<SHA-1 of the
service name>``, see :func:`service_sid`) is what the data-folder ACLs grant (winacl.py). Installs
from before 2026-11-13 ran App/Web as LocalSystem and the database as NETWORK SERVICE
(:data:`LEGACY_ACCOUNTS`); an update moves them over and its rollback moves them back.

**WinSW 2.12.0 command set** (verified against the bundled binary, see
tests/test_winsw_compat.py): install, uninstall, start, stop, stopwait, restart, restart!, status,
test, testwait, version, help. There is NO ``refresh`` in 2.x (it was added in WinSW 3); calling it
was the 2026-11-13 18:42 "Unknown command: refresh" update failure. WinSW 2.x re-reads
``<id>.xml`` every time the service starts, so executable, arguments, environment and log paths
need only the XML rewritten. What the Service Control Manager stores (start type, dependencies,
account, recovery actions) is set with ``sc.exe config`` / ``sc.exe failure`` and then read back and
verified (:func:`verify_registration`). Services are never deleted and re-created to change them.

WinSW 2.x also treats the mere *presence* of ``<delayedAutoStart>`` as "delayed" (whatever its
value), which is why the 11:54 install showed ``AUTO_START (DELAYED)``; the element is no longer
written and the delayed flag is cleared explicitly.

The WinSW wrappers live under the install root, which electron-builder deletes and re-copies on
every upgrade. ``ensure_service_files`` re-creates them before any service is started.

Registering/configuring services needs an elevated process. Commands are built first (``plan_*``)
so they are unit-testable and shown in dry runs.
"""

from __future__ import annotations

import hashlib
import re
import shutil
import struct
import subprocess
import sys
import time
from pathlib import Path
from xml.sax.saxutils import escape

APP = 'GTrade-App'
WEB = 'GTrade-Web'
DB = 'GTrade-DB'
ALL = (WEB, APP, DB)  # stop order; start order is reversed

LOCAL_SYSTEM = 'LocalSystem'
NETWORK_SERVICE = r'NT AUTHORITY\NetworkService'

HARDENED_ACCOUNTS = {sid: f'NT SERVICE\\{sid}' for sid in ALL}
LEGACY_ACCOUNTS = {DB: NETWORK_SERVICE, APP: LOCAL_SYSTEM, WEB: LOCAL_SYSTEM}

# Exactly the commands of the bundled WinSW 2.12.0 that this code uses (subset of its `help`).
WINSW_VERBS = ('install', 'uninstall', 'start', 'stop', 'stopwait', 'restart', 'status')

# Recovery: restart after 5 s, 10 s, 30 s; counter reset after an hour; also on non-crash failures
# (a wrapper or pg_ctl that exits with an error code, not only a crash).
RESET_SECONDS = 3600
RESTART_DELAYS_MS = (5000, 10000, 30000)


class ServiceError(RuntimeError):
    pass


def service_sid(service_id: str) -> str:
    """The service SID Windows derives for ``NT SERVICE\\<service_id>`` (as ``sc showsid`` prints it).

    Deterministic, so ACLs can be granted before the service exists."""
    digest = hashlib.sha1(service_id.upper().encode('utf-16-le')).digest()
    return 'S-1-5-80-' + '-'.join(str(x) for x in struct.unpack('<5I', digest))


def account_sid(account: str) -> str | None:
    """icacls-style SID (``*S-1-...``) of an account this module assigns, or None for LocalSystem
    (SYSTEM is always granted Full control by the data-root policy)."""
    a = normalize_account(account)
    if a == normalize_account(NETWORK_SERVICE):
        return '*S-1-5-20'
    if a.startswith('nt service\\'):
        return '*' + service_sid(account.split('\\', 1)[1])
    return None


def normalize_account(account: str | None) -> str:
    a = (account or '').strip().lower()
    return {'localsystem': 'localsystem', '.\\localsystem': 'localsystem', 'nt authority\\system': 'localsystem',
            'nt authority\\networkservice': 'nt authority\\networkservice',
            'nt authority\\network service': 'nt authority\\networkservice'}.get(a, a)


def same_account(a: str | None, b: str | None) -> bool:
    return normalize_account(a) == normalize_account(b)


def dependencies(cfg, sid: str) -> list[str] | None:
    """Dependencies this module manages; None = leave as registered (pg_ctl sets RPCSS for the DB)."""
    if sid == APP:
        return [DB] if cfg.is_server_side else []
    if sid == WEB:
        return [APP]
    return None


def winsw_xml(*, service_id: str, name: str, description: str, executable: Path, arguments: str,
              workdir: Path, logpath: Path, env: dict, depends: list[str], stop_executable: Path | None = None,
              stop_arguments: str = '') -> str:
    env_xml = '\n'.join(f'  <env name="{escape(k)}" value="{escape(str(v))}"/>' for k, v in sorted(env.items()))
    dep_xml = '\n'.join(f'  <depend>{escape(d)}</depend>' for d in depends)
    stop_xml = ''
    if stop_executable:
        stop_xml = (f'  <stopexecutable>{escape(str(stop_executable))}</stopexecutable>\n'
                    f'  <stoparguments>{escape(stop_arguments)}</stoparguments>\n')
    restarts = '\n'.join(f'  <onfailure action="restart" delay="{ms // 1000} sec"/>' for ms in RESTART_DELAYS_MS)
    # No <serviceaccount>: the account is set (and verified) through SCM by configure_registration.
    # No <delayedAutoStart>: WinSW 2.x makes ANY such element delayed, even "false".
    return f"""<!-- Generated by gtrade-ctl. Re-generated on repair/update; read by WinSW at every start. -->
<service>
  <id>{escape(service_id)}</id>
  <name>{escape(name)}</name>
  <description>{escape(description)}</description>
  <executable>{escape(str(executable))}</executable>
  <arguments>{escape(arguments)}</arguments>
  <workingdirectory>{escape(str(workdir))}</workingdirectory>
{stop_xml}  <startmode>Automatic</startmode>
{dep_xml}
{env_xml}
{restarts}
  <resetfailure>1 hour</resetfailure>
  <stoptimeout>30 sec</stoptimeout>
  <stopparentprocessfirst>true</stopparentprocessfirst>
  <logpath>{escape(str(logpath))}</logpath>
  <log mode="roll-by-size">
    <sizeThreshold>10240</sizeThreshold>
    <keepFiles>8</keepFiles>
  </log>
</service>
"""


def app_service_xml(layout, cfg, version: str, app_dir: Path | None = None) -> str:
    app_dir = Path(app_dir) if app_dir else layout.app_dir(version)
    env = {
        'GTRADE_DATA_ROOT': str(layout.data_root),
        'GTRADE_INSTALL_ROOT': str(layout.install_root),
        # Embedded Python ignores PYTHONPATH; runtime\python\Lib\site-packages\gtrade_app.pth
        # puts <GTRADE_APP_DIR>/backend and /windows on sys.path instead.
        'GTRADE_APP_DIR': str(app_dir),
        'PYTHONUTF8': '1',
        'PYTHONDONTWRITEBYTECODE': '1',
        # A virtual account's profile TEMP is not guaranteed to exist/be writable: use our own.
        'TEMP': str(layout.temp_dir / 'app'),
        'TMP': str(layout.temp_dir / 'app'),
    }
    return winsw_xml(service_id=APP, name='G-TRADE ERP Application',
                     description='G-TRADE ERP backend (Django on Waitress, loopback only).',
                     executable=layout.python_exe, arguments='-m gtrade_server',
                     workdir=app_dir / 'backend', logpath=layout.logs_dir / 'services', env=env,
                     depends=dependencies(cfg, APP))


def web_service_xml(layout) -> str:
    # nginx opens <prefix>/logs/error.log before it reads the config, so the prefix must be a
    # writable folder in the data root, not Program Files. A trailing slash is required by -p.
    nginx = layout.nginx_dir / 'nginx.exe'
    prefix = f'-p "{layout.run_dir / "nginx"}/" -c "{layout.nginx_conf}"'
    return winsw_xml(service_id=WEB, name='G-TRADE ERP Web (HTTPS)',
                     description='G-TRADE ERP HTTPS front door (nginx).',
                     executable=nginx, arguments=prefix, workdir=layout.nginx_dir,
                     logpath=layout.logs_dir / 'services', env={}, depends=[APP],
                     stop_executable=nginx, stop_arguments=f'{prefix} -s quit')


def write_service_files(layout, cfg, version: str, app_dir: Path | None = None) -> dict:
    """Write <id>.xml + a renamed WinSW copy for each WinSW-managed service."""
    out = {}
    layout.services_dir.mkdir(parents=True, exist_ok=True)
    (layout.temp_dir / 'app').mkdir(parents=True, exist_ok=True)
    for sid, xml in ((APP, app_service_xml(layout, cfg, version, app_dir)), (WEB, web_service_xml(layout))):
        xml_path = layout.services_dir / f'{sid}.xml'
        xml_path.write_text(xml, encoding='utf-8')
        exe = layout.services_dir / f'{sid}.exe'
        if layout.winsw_exe.exists() and not exe.exists():
            shutil.copy2(layout.winsw_exe, exe)
        if not exe.exists():
            raise ServiceError(f'the service wrapper {exe} could not be created ({layout.winsw_exe} is missing). '
                               'Run the installer again.')
        out[sid] = {'xml': str(xml_path), 'exe': str(exe)}
    return out


# ---- commands -----------------------------------------------------------------------------------
def plan_register_db(layout, cfg) -> list[str]:
    # Registered with the account pg_ctl has always used; configure_registration then moves it to
    # NT SERVICE\GTrade-DB (one code path for new and existing installs) before it is ever started.
    return [str(layout.pg_bin / 'pg_ctl.exe'), 'register', '-N', DB, '-U', NETWORK_SERVICE,
            '-D', str(layout.pg_data), '-S', 'auto', '-w']


def plan_unregister_db(layout) -> list[str]:
    return [str(layout.pg_bin / 'pg_ctl.exe'), 'unregister', '-N', DB]


def plan_winsw(layout, sid: str, verb: str) -> list[str]:
    if verb not in WINSW_VERBS:
        raise ValueError(f'{verb!r} is not a WinSW 2.12 command used by G-TRADE ({", ".join(WINSW_VERBS)})')
    return [str(layout.services_dir / f'{sid}.exe'), verb]


def plan_sc(verb: str, sid: str) -> list[str]:
    return ['sc.exe', verb, sid]


def plan_recovery(sid: str) -> list[list[str]]:
    """Failure actions (pg_ctl register sets none; WinSW sets them only at install)."""
    actions = '/'.join(f'restart/{ms}' for ms in RESTART_DELAYS_MS)
    return [['sc.exe', 'failure', sid, 'reset=', str(RESET_SECONDS), 'actions=', actions],
            ['sc.exe', 'failureflag', sid, '1']]


def plan_db_recovery() -> list[str]:
    return plan_recovery(DB)[0]


def plan_config(cfg, sid: str, account: str) -> list[str]:
    cmd = ['sc.exe', 'config', sid, 'start=', 'auto', 'obj=', account]
    deps = dependencies(cfg, sid)
    if deps is not None:
        cmd += ['depend=', '/'.join(deps) if deps else '/']
    return cmd


def run(cmd: list[str], check=True, timeout=120) -> subprocess.CompletedProcess:
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, encoding='utf-8', errors='replace')
    if check and proc.returncode != 0:
        raise ServiceError(f'{Path(cmd[0]).name} {" ".join(cmd[1:3])} failed ({proc.returncode}): '
                           f'{(proc.stderr or proc.stdout).strip()[-400:]}')
    return proc


def query(sid: str) -> str:
    """'RUNNING', 'STOPPED', 'START_PENDING', ..., or 'NOT_INSTALLED'."""
    if sys.platform != 'win32':  # pragma: no cover
        return 'NOT_INSTALLED'
    proc = subprocess.run(['sc.exe', 'query', sid], capture_output=True, text=True)
    if proc.returncode == 1060 or 'FAILED 1060' in proc.stdout:
        return 'NOT_INSTALLED'
    for line in proc.stdout.splitlines():
        if 'STATE' in line:
            return line.split()[-1]
    return 'UNKNOWN'


def parse_exit_codes(text: str) -> dict:
    """``sc query`` -> {'win32': int|None, 'service': int|None} (WIN32_EXIT_CODE / SERVICE_EXIT_CODE)."""
    out = {'win32': None, 'service': None}
    for line in (text or '').splitlines():
        key, _, val = line.partition(':')
        key = key.strip().upper()
        if key in ('WIN32_EXIT_CODE', 'SERVICE_EXIT_CODE'):
            m = re.match(r'\s*(\d+)', val)
            if m:
                out['win32' if key.startswith('WIN32') else 'service'] = int(m.group(1))
    return out


def query_exit_codes(sid: str) -> dict:
    if sys.platform != 'win32':  # pragma: no cover
        return {'win32': None, 'service': None}
    return parse_exit_codes(subprocess.run(['sc.exe', 'query', sid], capture_output=True, text=True,
                                           errors='replace').stdout)


def parse_qc(text: str) -> dict:
    """Parse ``sc qc`` output (start type, delayed flag, binary path, dependencies, account)."""
    out = {'dependencies': []}
    last = None
    for raw in text.splitlines():
        if ':' not in raw:
            continue
        key, _, val = raw.partition(':')
        key, val = key.strip(), val.strip()
        if not key and last == 'DEPENDENCIES':
            if val:
                out['dependencies'].append(val)
            continue
        last = key
        if key == 'START_TYPE':
            out['start_type'] = val.split()[1] if len(val.split()) > 1 else val
            out['delayed'] = '(DELAYED)' in val
        elif key == 'BINARY_PATH_NAME':
            out['binary_path'] = val
        elif key == 'DEPENDENCIES':
            if val:
                out['dependencies'].append(val)
        elif key == 'SERVICE_START_NAME':
            out['account'] = val
    return out


def parse_qfailure(text: str) -> dict:
    out = {'reset': None, 'actions': []}
    for raw in text.splitlines():
        s = raw.strip()
        if s.startswith('RESET_PERIOD'):
            try:
                out['reset'] = int(s.rsplit(':', 1)[1].strip())
            except ValueError:
                pass
        if 'RESTART -- Delay =' in s:
            out['actions'].append(int(s.split('Delay =', 1)[1].split()[0]))
    return out


def query_config(sid: str) -> dict | None:
    """Everything SCM stores about ``sid`` that this module manages, or None if not installed."""
    if sys.platform != 'win32':  # pragma: no cover
        return None
    qc = subprocess.run(['sc.exe', 'qc', sid, '8192'], capture_output=True, text=True, errors='replace')
    if 'FAILED 1060' in qc.stdout or qc.returncode == 1060:
        return None
    info = parse_qc(qc.stdout)
    info.update(parse_qfailure(subprocess.run(['sc.exe', 'qfailure', sid, '8192'], capture_output=True,
                                              text=True, errors='replace').stdout))
    flag = subprocess.run(['sc.exe', 'qfailureflag', sid], capture_output=True, text=True, errors='replace').stdout
    info['failure_flag'] = parse_failure_flag(flag)
    return info


def parse_failure_flag(text: str) -> bool | None:
    """``FAILURE_ACTIONS_ON_NONCRASH_FAILURES:  TRUE|FALSE`` -> bool (None if absent)."""
    for line in (text or '').splitlines():
        if 'NONCRASH' in line.upper():
            return line.rsplit(':', 1)[-1].strip().upper() == 'TRUE'
    return None


def current_account(sid: str) -> str | None:
    info = query_config(sid)
    return info.get('account') if info else None


def snapshot_accounts() -> dict:
    """{service: account} for the registered services (restored by an update's rollback)."""
    found = {sid: current_account(sid) for sid in ALL}
    return {sid: acc for sid, acc in found.items() if acc is not None}


def is_elevated() -> bool:
    if sys.platform != 'win32':  # pragma: no cover
        return False
    import ctypes
    try:
        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    except Exception:
        return False


def require_elevation(action: str) -> None:
    if not is_elevated():
        raise ServiceError(f'{action} needs Administrator rights. Run it from an elevated prompt or the installer.')


def clear_delayed_autostart(sid: str) -> None:
    """ChangeServiceConfig2(SERVICE_CONFIG_DELAYED_AUTO_START_INFO, FALSE). ``sc config start= auto``
    does not reliably clear a flag WinSW set at install."""
    if sys.platform != 'win32':  # pragma: no cover
        return
    import ctypes
    from ctypes import wintypes
    advapi = ctypes.WinDLL('advapi32', use_last_error=True)
    advapi.OpenSCManagerW.restype = wintypes.HANDLE
    advapi.OpenSCManagerW.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.DWORD]
    advapi.OpenServiceW.restype = wintypes.HANDLE
    advapi.OpenServiceW.argtypes = [wintypes.HANDLE, wintypes.LPCWSTR, wintypes.DWORD]
    advapi.ChangeServiceConfig2W.argtypes = [wintypes.HANDLE, wintypes.DWORD, ctypes.c_void_p]
    advapi.ChangeServiceConfig2W.restype = wintypes.BOOL
    advapi.CloseServiceHandle.argtypes = [wintypes.HANDLE]
    SC_MANAGER_CONNECT, SERVICE_CHANGE_CONFIG, SERVICE_CONFIG_DELAYED_AUTO_START_INFO = 0x1, 0x2, 3
    scm = advapi.OpenSCManagerW(None, None, SC_MANAGER_CONNECT)
    if not scm:
        raise ServiceError(f'OpenSCManager failed (Windows error {ctypes.get_last_error()})')
    try:
        svc = advapi.OpenServiceW(scm, sid, SERVICE_CHANGE_CONFIG)
        if not svc:
            raise ServiceError(f'OpenService {sid} failed (Windows error {ctypes.get_last_error()})')
        try:
            flag = wintypes.BOOL(False)
            if not advapi.ChangeServiceConfig2W(svc, SERVICE_CONFIG_DELAYED_AUTO_START_INFO, ctypes.byref(flag)):
                raise ServiceError(f'clearing delayed start of {sid} failed (Windows error {ctypes.get_last_error()})')
        finally:
            advapi.CloseServiceHandle(svc)
    finally:
        advapi.CloseServiceHandle(scm)


def expected_binary(layout, sid: str) -> Path:
    if sid == DB:
        return layout.pg_bin / 'pg_ctl.exe'
    return layout.services_dir / f'{sid}.exe'


def verify_registration(layout, cfg, sid: str, account: str, info: dict | None = None) -> list[str]:
    """What is wrong with ``sid``'s SCM registration (empty = correct). Read back, never assumed."""
    info = info if info is not None else query_config(sid)
    if info is None:
        return [f'{sid} is not registered']
    problems = []
    exe = expected_binary(layout, sid)
    bp = (info.get('binary_path') or '').lower()
    if str(exe).lower() not in bp:
        problems.append(f'{sid} points at {info.get("binary_path")!r}, expected {exe}')
    if not exe.exists():
        problems.append(f'{sid} program file {exe} is missing')
    if sid != DB and not (layout.services_dir / f'{sid}.xml').exists():
        problems.append(f'{sid} configuration {layout.services_dir / (sid + ".xml")} is missing')
    if info.get('start_type') != 'AUTO_START' or info.get('delayed'):
        problems.append(f'{sid} start type is {info.get("start_type")}{" (DELAYED)" if info.get("delayed") else ""}, '
                        'expected AUTO_START')
    if not same_account(info.get('account'), account):
        problems.append(f'{sid} runs as {info.get("account")!r}, expected {account!r}')
    deps = dependencies(cfg, sid)
    if deps is not None and sorted(d.lower() for d in info.get('dependencies', [])) != sorted(d.lower() for d in deps):
        problems.append(f'{sid} depends on {info.get("dependencies")}, expected {deps}')
    if info.get('reset') != RESET_SECONDS or tuple(info.get('actions') or ()) != RESTART_DELAYS_MS:
        problems.append(f'{sid} recovery actions are {info.get("actions")} (reset {info.get("reset")}), '
                        f'expected restart {list(RESTART_DELAYS_MS)} ms, reset {RESET_SECONDS}')
    if info.get('failure_flag') is False:
        problems.append(f'{sid} recovery does not apply to non-crash failures')
    return problems


def configure_registration(layout, cfg, sid: str, account: str) -> dict:
    """Make SCM's record of ``sid`` exactly right (start type, account, dependencies, recovery),
    then read it back. Raises ServiceError listing every mismatch: nothing is silently ignored.

    Works on a running service (SCM applies the account at the next start); callers restart."""
    before = query_config(sid)
    if before is None:
        raise ServiceError(f'{sid} is not registered')
    run(plan_config(cfg, sid, account))
    clear_delayed_autostart(sid)
    for c in plan_recovery(sid):
        run(c)
    problems = verify_registration(layout, cfg, sid, account)
    if problems:
        raise ServiceError('; '.join(problems))
    return {'account': account, 'previous_account': before.get('account'),
            'account_changed': not same_account(before.get('account'), account)}


def target_accounts(accounts: dict | None = None) -> dict:
    """The account each service should run as: hardened unless a rollback passes the old ones."""
    out = dict(HARDENED_ACCOUNTS)
    for sid, acc in (accounts or {}).items():
        if acc:
            out[sid] = acc
    return out


def install_all(layout, cfg, version: str, dry_run=False, accounts: dict | None = None) -> list[list[str]]:
    """Register what is missing, then configure every service (never re-creates an existing one)."""
    if not cfg.is_server_side:
        return []
    want = target_accounts(accounts)
    cmds = []
    if query(DB) == 'NOT_INSTALLED':
        cmds.append(plan_register_db(layout, cfg))
    if not dry_run:  # a dry run only plans; it writes nothing
        write_service_files(layout, cfg, version)
    for sid in (APP, WEB):
        if query(sid) == 'NOT_INSTALLED':
            cmds.append(plan_winsw(layout, sid, 'install'))
    for sid in (DB, APP, WEB):
        cmds.append(plan_config(cfg, sid, want[sid]))
        cmds.extend(plan_recovery(sid))
    if dry_run:
        return cmds
    require_elevation('Installing services')
    for c in cmds:
        if c[0] != 'sc.exe':  # registrations; the sc.exe lines are what ensure_service_files applies
            run(c)
    ensure_service_files(layout, cfg, version, accounts=accounts)
    return cmds


def wait_state(sid: str, want: str, timeout: float = 120, poll: float = 1.0) -> str:
    """Poll until the service reaches ``want``; returns the last state seen."""
    deadline = time.monotonic() + timeout
    state = query(sid)
    while state != want and time.monotonic() < deadline:
        if want == 'RUNNING' and state == 'STOPPED':
            # A start that fails leaves the service STOPPED: give SCM a moment, then stop waiting.
            time.sleep(poll)
            state = query(sid)
            if state == 'STOPPED':
                break
        time.sleep(poll)
        state = query(sid)
    return state


def start_service(sid: str, timeout: float = 120) -> None:
    """Start one service and wait until SCM reports RUNNING. Raises with SCM's own message."""
    state = query(sid)
    if state == 'NOT_INSTALLED':
        raise ServiceError(f'{sid} is not registered. Run "gtrade-ctl repair" as Administrator.')
    if state == 'RUNNING':
        return
    err_log = service_err_log(sid)
    mark = _size(err_log)
    proc = run(plan_sc('start', sid), check=False)
    state = wait_state(sid, 'RUNNING', timeout)
    if state != 'RUNNING':
        # The program's own reason (e.g. nginx "[emerg] ... Access is denied") beats SCM's status dump,
        # which is all the 2026-11-17 update log could show.
        reason = _new_text(err_log, mark)
        if not reason:
            reason = ' '.join((proc.stdout or proc.stderr or '').strip().splitlines())[-300:]
        raise ServiceError(f'{sid} did not start (state {state}): {reason}')


def service_err_log(sid: str, data_root: Path | None = None) -> Path:
    """WinSW's <logpath> copy of the program's stderr (logs\\services\\<id>.err.log)."""
    import os
    from . import paths
    root = Path(data_root or os.environ.get('GTRADE_DATA_ROOT') or paths.DEFAULT_DATA_ROOT)
    return root / 'logs' / 'services' / f'{sid}.err.log'


def _size(path: Path) -> int:
    try:
        return path.stat().st_size
    except OSError:
        return 0


def _new_text(path: Path, start: int, limit: int = 600) -> str:
    """The distinct lines appended to ``path`` after byte ``start`` (last ``limit`` chars)."""
    try:
        with open(path, 'rb') as fh:
            fh.seek(start)
            text = fh.read().decode('utf-8', errors='replace')
    except OSError:
        return ''
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    return ' | '.join(dict.fromkeys(lines))[-limit:]


def stop_service(sid: str, timeout: float = 180) -> None:
    """Graceful stop through SCM (PostgreSQL: fast shutdown with checkpoint). Never kills a process:
    if it does not stop in time this raises and the caller changes nothing."""
    state = query(sid)
    if state in ('STOPPED', 'NOT_INSTALLED'):
        return
    run(plan_sc('stop', sid), check=False)
    state = wait_state(sid, 'STOPPED', timeout)
    if state != 'STOPPED':
        raise ServiceError(f'{sid} did not stop within {timeout:.0f}s (state {state}). Nothing was changed.')


def start_all(layout, dry_run=False, timeout: float = 120):
    """Start DB -> App -> Web one at a time, each confirmed RUNNING before the next."""
    cmds = [plan_sc('start', s) for s in reversed(ALL) if query(s) not in ('RUNNING', 'NOT_INSTALLED')]
    if not dry_run:
        for sid in reversed(ALL):
            if query(sid) != 'NOT_INSTALLED':
                start_service(sid, timeout)
    return cmds


def ensure_service_files(layout, cfg, version: str, app_dir: Path | None = None, accounts: dict | None = None) -> dict:
    """Re-create the WinSW wrappers/XML (deleted with the old program files on upgrade) and make
    SCM's registration of every installed service match (account, start type, dependencies,
    recovery). Elevated only; never registers or removes a service.

    A service whose account changes while it is RUNNING is stopped gracefully first (the new
    account applies only at the next start); the caller starts it again and proves it works."""
    if not cfg.is_server_side:
        return {'skipped': 'workstation'}
    want = target_accounts(accounts)
    files = write_service_files(layout, cfg, version, app_dir)
    from . import winacl
    winacl.apply_service_access(layout, want)
    # Prove the accounts can really use their folders BEFORE any service is reconfigured or started
    # (update step 0 runs this ahead of the backup/migration: a defect now changes nothing).
    try:
        winacl.require_service_access(layout, want)
    except winacl.AclError as exc:
        raise ServiceError(str(exc)) from exc
    configured = {}
    for sid in (WEB, APP, DB):  # stop order, in case a running service must be restarted
        info = query_config(sid)
        if info is None:
            continue
        if not same_account(info.get('account'), want[sid]) and query(sid) != 'STOPPED':
            stop_service(sid)
        configured[sid] = configure_registration(layout, cfg, sid, want[sid])
    return {'files': files, 'configured': configured}


def verify_all(layout, cfg, accounts: dict | None = None) -> dict:
    """Read-only check of every registration (``gtrade-ctl services verify``, diagnostics)."""
    want = target_accounts(accounts)
    out = {}
    for sid in (DB, APP, WEB):
        info = query_config(sid)
        out[sid] = {'state': query(sid), 'account': info.get('account') if info else None,
                    'problems': verify_registration(layout, cfg, sid, want[sid], info) if info else ['not registered']}
    out['ok'] = all(not v['problems'] for k, v in out.items() if k != 'ok')
    return out


def stop_all(layout, dry_run=False, include_db=True):
    targets = ALL if include_db else (WEB, APP)
    cmds = [plan_sc('stop', s) for s in targets if query(s) not in ('STOPPED', 'NOT_INSTALLED')]
    if not dry_run:
        for c in cmds:
            run(c, check=False)
        for s in targets:  # SCM's stop returns at once; wait so the next step sees them stopped
            if query(s) not in ('STOPPED', 'NOT_INSTALLED'):
                wait_state(s, 'STOPPED', 180)
    return cmds


def uninstall_all(layout, dry_run=False):
    cmds = []
    for sid in (WEB, APP):
        if query(sid) != 'NOT_INSTALLED':
            # An older uninstaller may already have deleted the wrapper: then SCM removes the entry.
            exe = layout.services_dir / f'{sid}.exe'
            cmds.append(plan_winsw(layout, sid, 'uninstall') if exe.exists() else plan_sc('delete', sid))
    if query(DB) != 'NOT_INSTALLED':
        cmds.append(plan_unregister_db(layout))
    if not dry_run:
        require_elevation('Removing services')
        stop_all(layout)
        for c in cmds:
            run(c, check=False)
    return cmds
