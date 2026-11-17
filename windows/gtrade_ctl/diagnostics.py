"""Support bundle: logs + non-secret configuration + service/port state. Never secrets or data.

Excluded on purpose: ``secrets.dpapi``, every ``*.key`` file, the licence store, database files,
media, backups. Text files are passed through :func:`redact` before they are zipped.
"""

from __future__ import annotations

import json
import platform
import time
import zipfile
from pathlib import Path

from .log import redact

EXCLUDE_SUFFIXES = {'.key', '.dpapi', '.pem', '.pfx', '.lic', '.dump', '.zip', '.gz'}
MAX_FILE = 5 * 1024 * 1024


def collect(layout, out_path: str) -> Path:
    from . import services
    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
        meta = {
            'collected_at': time.strftime('%Y-%m-%dT%H:%M:%S%z'),
            'windows': platform.platform(), 'python': platform.python_version(),
            'services': {s: services.query(s) for s in services.ALL},
            # account, start type, dependencies and recovery actions as SCM holds them
            'service_config': {s: services.query_config(s) for s in services.ALL},
        }
        z.writestr('summary.json', json.dumps(meta, indent=2))
        for p in [layout.install_json, layout.env_file, layout.nginx_conf]:
            if p.exists():
                z.writestr(f'config/{p.name}', redact(p.read_text(encoding='utf-8', errors='replace')))
        tls = layout.tls_dir / 'ca.crt'
        if tls.exists():
            z.writestr('config/ca.crt', tls.read_text())
        if layout.logs_dir.exists():
            for f in layout.logs_dir.rglob('*'):
                if f.is_file() and f.suffix.lower() not in EXCLUDE_SUFFIXES and f.stat().st_size <= MAX_FILE:
                    rel = f.relative_to(layout.logs_dir)
                    z.writestr(f'logs/{rel.as_posix()}', redact(f.read_text(encoding='utf-8', errors='replace')))
    return out
