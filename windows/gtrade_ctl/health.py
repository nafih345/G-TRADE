"""Health checks over HTTPS with the installation CA pinned (no system trust store involved)."""

from __future__ import annotations

import hashlib
import json
import socket
import ssl
import urllib.error
import urllib.request
from pathlib import Path


def ssl_context(ca_file: Path | None = None, ca_pem: str | None = None) -> ssl.SSLContext:
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.minimum_version = ssl.TLSVersion.TLSv1_2
    ctx.check_hostname = True
    ctx.verify_mode = ssl.CERT_REQUIRED
    if ca_file:
        ctx.load_verify_locations(cafile=str(ca_file))
    elif ca_pem:
        ctx.load_verify_locations(cadata=ca_pem)
    else:
        ctx.load_default_certs()
    return ctx


def get_json(url: str, ctx: ssl.SSLContext | None = None, timeout=10) -> tuple[int, dict]:
    req = urllib.request.Request(url, headers={'Accept': 'application/json', 'User-Agent': 'gtrade-ctl'})
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
            return resp.status, json.loads(resp.read().decode('utf-8') or '{}')
    except urllib.error.HTTPError as exc:
        try:
            body = json.loads(exc.read().decode('utf-8') or '{}')
        except Exception:
            body = {}
        return exc.code, body


def fetch_server_chain_fingerprint(host: str, port: int, timeout=5) -> str:
    """SHA-256 fingerprint of the *issuer* (CA) the server presents, for pairing a workstation.

    Used only to show the admin a fingerprint to compare with the server's connection sheet; the
    actual trust decision is the comparison the admin confirms (or the pairing code check).
    """
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    with socket.create_connection((host, port), timeout=timeout) as sock:
        with ctx.wrap_socket(sock, server_hostname=host) as tls:
            der = tls.getpeercert(binary_form=True)
    digest = hashlib.sha256(der).hexdigest().upper()
    return ':'.join(digest[i:i + 2] for i in range(0, len(digest), 2))


def check_local(layout, cfg, timeout=10) -> dict:
    """The installer's final gate: HTTPS live + full health through nginx, pinned to our CA."""
    ctx = ssl_context(ca_file=layout.tls_dir / 'ca.crt')
    base = f'https://localhost:{cfg.https_port}'
    result = {'url': base}
    try:
        code, live = get_json(base + '/api/health/live/', ctx, timeout)
        result['live'] = code == 200 and live.get('status') == 'ok'
        code, full = get_json(base + '/api/health/', ctx, timeout)
        result['health'] = full
        result['ok'] = bool(result['live'] and full.get('status') == 'ok' and full.get('edition') == 'local'
                            and full.get('debug') is False)
    except Exception as exc:
        result.update(ok=False, error=f'{type(exc).__name__}: {exc}')
    return result
