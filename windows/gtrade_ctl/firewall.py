"""Windows Defender Firewall rule for a LAN Server (only nginx's HTTPS port, only the LAN).

* One inbound TCP rule for the HTTPS port, ``profile=private`` and ``remoteip=localsubnet``.
  Never on the Public profile; never for PostgreSQL or Waitress (both bind loopback anyway).
* Standalone and Workstation never get a rule.
* The rule name is fixed so repair/uninstall find exactly the rule we made.
"""

from __future__ import annotations

import subprocess

RULE_NAME = 'G-TRADE ERP HTTPS (LAN)'


def plan_add(port: int) -> list[str]:
    return ['netsh', 'advfirewall', 'firewall', 'add', 'rule', f'name={RULE_NAME}', 'dir=in', 'action=allow',
            'protocol=TCP', f'localport={int(port)}', 'profile=private', 'remoteip=localsubnet',
            'description=Allows G-TRADE ERP workstations on the local network to reach this server.']


def plan_delete() -> list[str]:
    return ['netsh', 'advfirewall', 'firewall', 'delete', 'rule', f'name={RULE_NAME}']


def exists() -> bool:
    proc = subprocess.run(['netsh', 'advfirewall', 'firewall', 'show', 'rule', f'name={RULE_NAME}'],
                          capture_output=True, text=True)
    return proc.returncode == 0 and RULE_NAME in proc.stdout


def active_profiles() -> str:
    """Raw output of the active network profiles, used to warn when the LAN is marked Public."""
    proc = subprocess.run(['powershell', '-NoProfile', '-Command',
                           'Get-NetConnectionProfile | Select-Object -ExpandProperty NetworkCategory'],
                          capture_output=True, text=True)
    return proc.stdout.strip()


def ensure(port: int, dry_run=False) -> list[list[str]]:
    cmds = []
    if not dry_run and exists():
        cmds.append(plan_delete())
    cmds.append(plan_add(port))
    if not dry_run:
        from .services import require_elevation, run
        require_elevation('Adding the firewall rule')
        for c in cmds:
            run(c, check=c is cmds[-1])
    return cmds


def remove(dry_run=False) -> list[list[str]]:
    cmds = [plan_delete()]
    if not dry_run:
        from .services import run
        run(cmds[0], check=False)
    return cmds
