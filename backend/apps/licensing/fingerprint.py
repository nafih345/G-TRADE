"""Machine fingerprint v1 for the licence binding (server / standalone PC only).

Each component is hashed separately with a fixed salt; raw values never leave this computer and are
never stored. A licence lists the component hashes it was issued for and a tolerance: it still
matches when up to `tolerance` components changed (new network card, replaced disk).
"""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import uuid

SALT = 'gtrade-fp-v1'
_cache: dict | None = None


def _machine_guid():
    if sys.platform != 'win32':
        return ''
    import winreg
    with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r'SOFTWARE\Microsoft\Cryptography', 0,
                        winreg.KEY_READ | winreg.KEY_WOW64_64KEY) as k:
        return winreg.QueryValueEx(k, 'MachineGuid')[0]


def _volume_serial():
    if sys.platform != 'win32':
        return ''
    import ctypes
    serial = ctypes.c_ulong(0)
    drive = os.environ.get('SystemDrive', 'C:') + '\\'
    ok = ctypes.windll.kernel32.GetVolumeInformationW(ctypes.c_wchar_p(drive), None, 0, ctypes.byref(serial),
                                                      None, None, None, 0)
    return f'{serial.value:08X}' if ok else ''


def _bios_uuid():
    if sys.platform != 'win32':
        return ''
    proc = subprocess.run(['powershell', '-NoProfile', '-NonInteractive', '-Command',
                           '(Get-CimInstance -ClassName Win32_ComputerSystemProduct).UUID'],
                          capture_output=True, text=True, timeout=20)
    value = proc.stdout.strip()
    return '' if value in ('', 'FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF', '00000000-0000-0000-0000-000000000000') else value


def _cpu():
    if sys.platform != 'win32':
        return ''
    import winreg
    with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r'HARDWARE\DESCRIPTION\System\CentralProcessor\0') as k:
        return f'{winreg.QueryValueEx(k, "ProcessorNameString")[0]}|{winreg.QueryValueEx(k, "Identifier")[0]}'


def _mac():
    node = uuid.getnode()
    return '' if (node >> 40) & 1 else f'{node:012X}'  # multicast bit set = random, not a real NIC


COMPONENTS = (('machine_guid', _machine_guid), ('volume', _volume_serial), ('bios_uuid', _bios_uuid),
              ('cpu', _cpu), ('mac', _mac))


def _hash(name: str, value: str) -> str:
    return 'sha256:' + hashlib.sha256(f'{SALT}|{name}|{value}'.encode('utf-8')).hexdigest()


def component_hashes() -> dict[str, str]:
    """{component: hash} for the components available on this machine (cached per process)."""
    global _cache
    if _cache is not None:
        return dict(_cache)
    from django.conf import settings
    override = os.environ.get('GTRADE_FP_OVERRIDE')
    if override and (getattr(settings, 'RUNNING_TESTS', False) or getattr(settings, 'GTRADE_LICENSE_DEV_MODE', False)):
        values = json.loads(override)  # tests / dev only: simulate another machine
    else:
        values = {}
        for name, fn in COMPONENTS:
            try:
                values[name] = fn() or ''
            except Exception:
                values[name] = ''
    _cache = {n: _hash(n, v) for n, v in values.items() if v}
    return dict(_cache)


def reset_cache():
    global _cache
    _cache = None


def matches(licensed: dict, tolerance: int, current: dict | None = None) -> tuple[bool, int, int]:
    """(ok, matched, required). A component missing on this machine counts as changed."""
    current = component_hashes() if current is None else current
    names = list(licensed)
    matched = sum(1 for n in names if current.get(n) == licensed[n])
    required = max(1, len(names) - max(0, int(tolerance)))
    return matched >= required, matched, required
