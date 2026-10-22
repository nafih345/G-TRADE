"""RFC 6238 time-based one-time passwords (Google Authenticator, Microsoft Authenticator, Authy…)."""
import base64
import hashlib
import hmac
import secrets
import struct
import time
from urllib.parse import quote

STEP_SECONDS = 30
DIGITS = 6


def new_secret():
    """160 random bits, base32 (no padding) — the form authenticator apps expect."""
    return base64.b32encode(secrets.token_bytes(20)).decode('ascii').rstrip('=')


def _code_at(secret, step):
    key = base64.b32decode(secret + '=' * (-len(secret) % 8), casefold=True)
    digest = hmac.new(key, struct.pack('>Q', step), hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    value = struct.unpack('>I', digest[offset:offset + 4])[0] & 0x7FFFFFFF
    return str(value % (10 ** DIGITS)).zfill(DIGITS)


def current_step(now=None):
    return int((time.time() if now is None else now) // STEP_SECONDS)


def code_for(secret, now=None):
    return _code_at(secret, current_step(now))


def match_step(secret, code, *, now=None, window=1):
    """The time step `code` belongs to (allowing ±`window` steps of clock drift), else None."""
    code = ''.join(ch for ch in str(code or '') if ch.isdigit())
    if len(code) != DIGITS:
        return None
    step = current_step(now)
    for candidate in range(step - window, step + window + 1):
        if hmac.compare_digest(_code_at(secret, candidate), code):
            return candidate
    return None


def provisioning_uri(secret, account, issuer='Greensol Optical ERP'):
    label = quote(f'{issuer}:{account}')
    return f'otpauth://totp/{label}?secret={secret}&issuer={quote(issuer)}&digits={DIGITS}&period={STEP_SECONDS}'
