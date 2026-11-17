"""Step logging with secret redaction.

Every gtrade-ctl step writes a JSON line (step, status, duration, redacted details) to the
relevant log folder. Anything that looks like a secret is masked before it reaches the disk:
known secret keys, ``password=`` style pairs, connection URLs with credentials, licence keys.
"""

from __future__ import annotations

import json
import logging
import logging.handlers
import re
import sys
import time
from contextlib import contextmanager
from pathlib import Path

SECRET_KEYS = re.compile(r'(pass(word)?|secret|token|key|pwd|credential|signature|private)', re.I)
_PAIR = re.compile(r'(?i)\b([\w-]*(?:password|passwd|pwd|secret|token|api[_-]?key|private[_-]?key)[\w-]*)\s*([=:])\s*("[^"]*"|\'[^\']*\'|\S+)')
_URL_CRED = re.compile(r'(?i)\b([a-z][a-z0-9+.-]*://)([^:/@\s]+):([^@\s]+)@')
_LICENSE_KEY = re.compile(r'\bGT[A-Z0-9]{2}(?:-[A-Z0-9]{4,6}){3,6}\b')
MASK = '********'


def redact(value):
    """Return ``value`` with secrets masked. Works on str, dict, list (recursively)."""
    if isinstance(value, dict):
        return {k: (MASK if isinstance(k, str) and SECRET_KEYS.search(k) and v not in (None, '') else redact(v))
                for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return type(value)(redact(v) for v in value)
    if isinstance(value, str):
        out = _URL_CRED.sub(lambda m: f'{m.group(1)}{m.group(2)}:{MASK}@', value)
        out = _PAIR.sub(lambda m: f'{m.group(1)}{m.group(2)}{MASK}', out)
        out = _LICENSE_KEY.sub('GT**-****-****-****', out)
        return out
    return value


class RedactingFilter(logging.Filter):
    def filter(self, record):
        try:
            msg = record.getMessage()
        except Exception:
            return True
        record.msg = redact(msg)
        record.args = ()
        return True


def get_logger(name: str, log_file: Path | None = None, level=logging.INFO) -> logging.Logger:
    logger = logging.getLogger(f'gtrade.{name}')
    if getattr(logger, '_gtrade_configured', False):
        return logger
    logger.setLevel(level)
    fmt = logging.Formatter('%(asctime)s %(levelname)s %(name)s %(message)s')
    stream = logging.StreamHandler(sys.stderr)
    stream.setFormatter(fmt)
    stream.addFilter(RedactingFilter())
    logger.addHandler(stream)
    if log_file is not None:
        log_file.parent.mkdir(parents=True, exist_ok=True)
        fh = logging.handlers.RotatingFileHandler(log_file, maxBytes=5 * 1024 * 1024, backupCount=5, encoding='utf-8')
        fh.setFormatter(fmt)
        fh.addFilter(RedactingFilter())
        logger.addHandler(fh)
    logger.propagate = False
    logger._gtrade_configured = True
    return logger


class StepLog:
    """Append-only JSONL record of installer/updater steps (``logs/<area>/<area>-<ts>.jsonl``)."""

    def __init__(self, path: Path):
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)

    def write(self, **event):
        event.setdefault('ts', time.strftime('%Y-%m-%dT%H:%M:%S%z'))
        with self.path.open('a', encoding='utf-8') as fh:
            fh.write(json.dumps(redact(event), default=str) + '\n')

    @contextmanager
    def step(self, name: str, **details):
        started = time.monotonic()
        self.write(step=name, status='start', **details)
        try:
            yield
        except BaseException as exc:
            self.write(step=name, status='failed', seconds=round(time.monotonic() - started, 2),
                       error=f'{type(exc).__name__}: {exc}')
            raise
        self.write(step=name, status='ok', seconds=round(time.monotonic() - started, 2))

    def read(self):
        if not self.path.exists():
            return []
        return [json.loads(line) for line in self.path.read_text(encoding='utf-8').splitlines() if line.strip()]
