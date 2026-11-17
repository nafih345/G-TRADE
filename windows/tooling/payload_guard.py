"""Release guard: no developer or cloud secrets may ship in the Windows payload.

    python windows/tooling/payload_guard.py windows/out/stage
    python windows/tooling/payload_guard.py windows/out/installer/win-unpacked

Two independent checks, both fatal:

1. **Forbidden files**: environment files (``.env``, ``.env.*``), private keys and certificates
   bundles we do not ship, developer database configs, SQLite files, DPAPI blobs, SSH keys. Only
   ``runtime/`` (third-party Python/PostgreSQL/nginx distributions) may carry ``*.pem`` CA
   bundles such as certifi's ``cacert.pem``.
2. **Leaked values**: every secret-looking value found in this repository's own developer env
   files (``backend/.env``, ``.env.local``, ``frontend/.env*``, …) and the password of every
   credential-bearing URL in them is searched for, byte for byte, in every shipped file
   (including ``app.asar``). The values themselves are never printed: a finding names the file
   and the env key only.

The cloud and local configurations stay separate: the local edition is configured only by
``gtrade.env`` + DPAPI secrets written at install time (``gtrade_ctl``), never by a repo env file.
"""

from __future__ import annotations

import fnmatch
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

# Developer env files whose values must never appear in a payload. Missing files are fine.
DEV_ENV_FILES = (
    '.env', '.env.local', '.env.production', '.env.development',
    'backend/.env', 'backend/.env.local', 'backend/.env.production',
    'frontend/.env', 'frontend/.env.local', 'frontend/.env.production', 'frontend/.env.production.local',
    'windows/desktop/.env', 'licensing_service/.env',
)

FORBIDDEN_NAMES = ('.env', '.env.*', '*.env', 'database.json', 'settings.local.json', '*.sqlite3', '*.sqlite3-*',
                   '*.dpapi', 'id_rsa*', 'id_ed25519*', '*.pfx', '*.p12', '*.key', '*.pem', '*.dump',
                   'credentials*.json', 'service-account*.json')
# Third-party runtime trees legitimately ship CA bundles (certifi, pip, PostgreSQL share).
PEM_ALLOWED_UNDER = ('runtime/',)
PEM_LIKE = ('*.pem',)

SECRET_KEY_RE = re.compile(r'(PASS|SECRET|TOKEN|KEY|PWD|CREDENTIAL|DATABASE_URL|_URL$|DSN|AUTH)', re.I)
CRED_URL_RE = re.compile(r'[a-z][a-z0-9+.-]*://[^/\s:@]+:([^/\s@]+)@', re.I)
# Values that are not secrets even under a secret-looking key.
HARMLESS = re.compile(r'^(true|false|none|null|0|1|changeme|change-me|change_me|your[-_].*|<.*>|x+|\*+)$', re.I)
MIN_LEN = 8


def _parse_env(path: Path) -> dict[str, str]:
    out = {}
    try:
        text = path.read_text(encoding='utf-8', errors='replace')
    except OSError:
        return out
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        k, v = line.split('=', 1)
        k = k.strip().removeprefix('export ').strip()
        v = v.strip().strip('"').strip("'")
        if v:
            out[k] = v
    return out


def secret_needles(repo: Path = ROOT, env_files=DEV_ENV_FILES) -> list[tuple[str, bytes]]:
    """(label, value) pairs to search for. Label = 'file:KEY', never the value."""
    needles, seen = [], set()

    def add(label, value):
        if len(value) < MIN_LEN or HARMLESS.match(value) or value in seen:
            return
        # Local development URLs (http://localhost:8000) are not secrets and appear in source.
        if re.fullmatch(r'https?://(localhost|127\.0\.0\.1)(:\d+)?/?', value):
            return
        seen.add(value)
        needles.append((label, value.encode('utf-8')))

    for rel in env_files:
        p = repo / rel
        if not p.is_file():
            continue
        for k, v in _parse_env(p).items():
            for m in CRED_URL_RE.finditer(v):
                add(f'{rel}:{k} (URL password)', m.group(1))
            if SECRET_KEY_RE.search(k):
                add(f'{rel}:{k}', v)
    return needles


def forbidden_files(root: Path) -> list[str]:
    hits = []
    for p in root.rglob('*'):
        if not p.is_file():
            continue
        rel = p.relative_to(root).as_posix()
        name = p.name
        for pat in FORBIDDEN_NAMES:
            if fnmatch.fnmatch(name.lower(), pat):
                if pat in PEM_LIKE and any(f'/{a}' in f'/{rel}' for a in PEM_ALLOWED_UNDER):
                    break
                hits.append(rel)
                break
    return hits


def leaked_values(root: Path, needles) -> list[str]:
    hits = []
    if not needles:
        return hits
    for p in root.rglob('*'):
        if not p.is_file():
            continue
        try:
            data = p.read_bytes()
        except OSError:
            continue
        for label, value in needles:
            if value in data:
                hits.append(f'{p.relative_to(root).as_posix()}  <-  {label}')
    return hits


def check(root: Path, repo: Path = ROOT) -> dict:
    root = Path(root)
    if not root.is_dir():
        return {'ok': False, 'error': f'{root} does not exist'}
    needles = secret_needles(repo)
    files = forbidden_files(root)
    leaks = leaked_values(root, needles)
    return {'ok': not files and not leaks, 'root': str(root), 'forbidden_files': files,
            'leaked_values': leaks, 'values_checked': len(needles)}


def enforce(root: Path, repo: Path = ROOT) -> dict:
    rep = check(root, repo)
    if not rep['ok']:
        lines = [f'payload_guard: {rep.get("error") or "secrets found in " + str(root)}']
        lines += [f'  forbidden file: {f}' for f in rep.get('forbidden_files', [])]
        lines += [f'  leaked value:   {f}' for f in rep.get('leaked_values', [])]
        raise SystemExit('\n'.join(lines))
    return rep


def main(argv=None):
    argv = argv if argv is not None else sys.argv[1:]
    if not argv:
        raise SystemExit(__doc__)
    for target in argv:
        rep = enforce(Path(target))
        print(f'payload_guard: OK  {rep["root"]}  (0 forbidden files, {rep["values_checked"]} secret values checked)')


if __name__ == '__main__':
    main()
