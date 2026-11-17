"""Per-installation TLS: a private CA plus a server certificate (decision D7: TLS on loopback too).

* ``ca.key`` / ``ca.crt``: ECDSA P-256 CA, valid 10 years, created once per installation. Its
  SHA-256 fingerprint is what workstations pin (shown on the server's connection sheet).
* ``server.key`` / ``server.crt``: ECDSA P-256, valid 397 days (browser maximum), SAN =
  localhost, 127.0.0.1, ::1 + the server's hostnames and IPs. Renewed by ``cert renew`` when
  fewer than 30 days remain; the CA (and therefore every workstation's pin) is kept.

Private keys are written PKCS#8 unencrypted (nginx for Windows cannot prompt for a passphrase
at service start) and protected by the ``config\\`` ACL instead.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import ipaddress
import os
from dataclasses import dataclass
from pathlib import Path

CA_DAYS = 3650
SERVER_DAYS = 397
RENEW_BEFORE_DAYS = 30


@dataclass
class CertInfo:
    path: Path
    subject: str
    not_before: dt.datetime
    not_after: dt.datetime
    sans: list
    fingerprint_sha256: str

    @property
    def days_left(self) -> int:
        return (self.not_after - dt.datetime.now(dt.timezone.utc)).days


def _now():
    return dt.datetime.now(dt.timezone.utc)


def fingerprint(cert) -> str:
    from cryptography.hazmat.primitives import serialization
    der = cert.public_bytes(serialization.Encoding.DER)
    digest = hashlib.sha256(der).hexdigest().upper()
    return ':'.join(digest[i:i + 2] for i in range(0, len(digest), 2))


def _write_key(path: Path, key) -> None:
    from cryptography.hazmat.primitives import serialization
    data = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
    tmp = path.with_suffix('.tmp')
    tmp.write_bytes(data)
    os.replace(tmp, path)


def _write_cert(path: Path, cert) -> None:
    from cryptography.hazmat.primitives import serialization
    tmp = path.with_suffix('.tmp')
    tmp.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    os.replace(tmp, path)


def load_cert(path: Path):
    from cryptography import x509
    return x509.load_pem_x509_certificate(path.read_bytes())


def info(path: Path) -> CertInfo:
    from cryptography import x509
    cert = load_cert(path)
    try:
        ext = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
        sans = [str(v) for v in ext.get_values_for_type(x509.DNSName)] + \
               [str(v) for v in ext.get_values_for_type(x509.IPAddress)]
    except x509.ExtensionNotFound:
        sans = []
    return CertInfo(path, cert.subject.rfc4514_string(), cert.not_valid_before_utc, cert.not_valid_after_utc,
                    sans, fingerprint(cert))


def init_ca(tls_dir: Path, install_id: str) -> CertInfo:
    """Create the installation CA if missing. Never replaces an existing CA."""
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import NameOID

    tls_dir.mkdir(parents=True, exist_ok=True)
    key_path, crt_path = tls_dir / 'ca.key', tls_dir / 'ca.crt'
    if crt_path.exists() and key_path.exists():
        return info(crt_path)
    if crt_path.exists() != key_path.exists():
        raise RuntimeError('Incomplete CA (one of ca.key / ca.crt missing). Refusing to replace it automatically.')

    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, 'G-TRADE ERP local installation'),
        x509.NameAttribute(NameOID.COMMON_NAME, f'G-TRADE Local CA {install_id[:8]}'),
    ])
    now = _now()
    cert = (x509.CertificateBuilder()
            .subject_name(name).issuer_name(name)
            .public_key(key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(now - dt.timedelta(minutes=5))
            .not_valid_after(now + dt.timedelta(days=CA_DAYS))
            .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
            .add_extension(x509.KeyUsage(digital_signature=False, content_commitment=False, key_encipherment=False,
                                         data_encipherment=False, key_agreement=False, key_cert_sign=True,
                                         crl_sign=True, encipher_only=False, decipher_only=False), critical=True)
            .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), critical=False)
            .sign(key, hashes.SHA256()))
    _write_key(key_path, key)
    _write_cert(crt_path, cert)
    return info(crt_path)


def _san_entries(hosts):
    from cryptography import x509
    entries, seen = [], set()
    for h in ['localhost', '127.0.0.1', '::1', *hosts]:
        h = (h or '').strip()
        if not h or h.lower() in seen:
            continue
        seen.add(h.lower())
        try:
            entries.append(x509.IPAddress(ipaddress.ip_address(h)))
        except ValueError:
            entries.append(x509.DNSName(h))
    return entries


def issue_server_cert(tls_dir: Path, hosts: list[str]) -> CertInfo:
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

    ca_key = serialization.load_pem_private_key((tls_dir / 'ca.key').read_bytes(), password=None)
    ca_cert = load_cert(tls_dir / 'ca.crt')
    key = ec.generate_private_key(ec.SECP256R1())
    now = _now()
    cn = next((h for h in hosts if h and not h[0].isdigit()), 'localhost')
    cert = (x509.CertificateBuilder()
            .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, cn[:64])]))
            .issuer_name(ca_cert.subject)
            .public_key(key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(now - dt.timedelta(minutes=5))
            .not_valid_after(min(now + dt.timedelta(days=SERVER_DAYS), ca_cert.not_valid_after_utc))
            .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
            .add_extension(x509.KeyUsage(digital_signature=True, content_commitment=False, key_encipherment=False,
                                         data_encipherment=False, key_agreement=True, key_cert_sign=False,
                                         crl_sign=False, encipher_only=False, decipher_only=False), critical=True)
            .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
            .add_extension(x509.SubjectAlternativeName(_san_entries(hosts)), critical=False)
            .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_key.public_key()), critical=False)
            .sign(ca_key, hashes.SHA256()))
    _write_key(tls_dir / 'server.key', key)
    # nginx wants the leaf followed by the chain.
    from cryptography.hazmat.primitives import serialization as ser
    chain = cert.public_bytes(ser.Encoding.PEM) + ca_cert.public_bytes(ser.Encoding.PEM)
    tmp = tls_dir / 'server.crt.tmp'
    tmp.write_bytes(chain)
    os.replace(tmp, tls_dir / 'server.crt')
    return info(tls_dir / 'server.crt')


def needs_renewal(tls_dir: Path, hosts: list[str]) -> tuple[bool, str]:
    crt = tls_dir / 'server.crt'
    if not crt.exists() or not (tls_dir / 'server.key').exists():
        return True, 'missing'
    i = info(crt)
    if i.days_left < RENEW_BEFORE_DAYS:
        return True, f'expires in {i.days_left} days'
    have = {s.lower() for s in i.sans}
    want = {e.value.compressed.lower() if hasattr(e.value, 'compressed') else str(e.value).lower()
            for e in _san_entries(hosts)}
    if not want <= have:
        return True, 'host list changed'
    return False, f'valid for {i.days_left} more days'


def ensure(tls_dir: Path, install_id: str, hosts: list[str]) -> dict:
    ca = init_ca(tls_dir, install_id)
    renew, reason = needs_renewal(tls_dir, hosts)
    server = issue_server_cert(tls_dir, hosts) if renew else info(tls_dir / 'server.crt')
    return {'ca_fingerprint': ca.fingerprint_sha256, 'ca_expires': ca.not_after.isoformat(),
            'server_expires': server.not_after.isoformat(), 'server_sans': server.sans,
            'renewed': renew, 'reason': reason}
