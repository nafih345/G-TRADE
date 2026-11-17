"""Licensing service data (SQLite for development; the schema is plain SQL so it ports to Postgres).

Licence keys are bearer secrets: only their SHA-256 is stored. Personal data is minimal: customer
name and a contact e-mail hash; IP addresses are kept per activation for fraud review only.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import secrets
import sqlite3
import threading
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS license_key (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key_hash TEXT UNIQUE NOT NULL,
  lic_id TEXT UNIQUE NOT NULL,
  customer TEXT NOT NULL,
  email_hash TEXT NOT NULL DEFAULT '',
  edition TEXT NOT NULL,
  deployment TEXT NOT NULL DEFAULT 'LAN',
  type TEXT NOT NULL,
  limits TEXT NOT NULL,
  modules TEXT,
  valid_until TEXT,
  updates_until TEXT,
  grace_days INTEGER NOT NULL DEFAULT 30,
  checkin_days INTEGER,
  max_activations INTEGER NOT NULL DEFAULT 2,
  revoked_at TEXT,
  revoke_reason TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS activation (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  activation_id TEXT UNIQUE NOT NULL,
  key_id INTEGER NOT NULL REFERENCES license_key(id),
  install_id TEXT NOT NULL,
  fp TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  last_checkin_at TEXT,
  ip TEXT
);
CREATE TABLE IF NOT EXISTS event (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT NOT NULL
);
"""


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()


def key_hash(key: str) -> str:
    norm = ''.join(ch for ch in key.upper() if ch.isalnum())
    return hashlib.sha256(norm.encode()).hexdigest()


def new_license_key() -> str:
    alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    groups = [''.join(secrets.choice(alphabet) for _ in range(5)) for _ in range(4)]
    return 'GT' + ''.join(secrets.choice(alphabet) for _ in range(2)) + '-' + '-'.join(groups)


class Store:
    def __init__(self, path: Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        with self._conn() as c:
            c.executescript(SCHEMA)

    def _conn(self):
        conn = sqlite3.connect(self.path, timeout=10, isolation_level=None)
        conn.row_factory = sqlite3.Row
        conn.execute('PRAGMA foreign_keys = ON')
        return conn

    def log(self, kind, **detail):
        with self._conn() as c:
            c.execute('INSERT INTO event(at, kind, detail) VALUES (?,?,?)', (now_iso(), kind, json.dumps(detail)))

    # ---- keys ------------------------------------------------------------------------------------
    def create_key(self, *, customer, edition, type_, limits, modules=None, valid_until=None, updates_until=None,
                   grace_days=30, checkin_days=None, max_activations=2, deployment='LAN', email='') -> tuple[str, str]:
        key = new_license_key()
        with self._lock, self._conn() as c:
            n = c.execute('SELECT COUNT(*) FROM license_key').fetchone()[0] + 1
            lic_id = f'L-{dt.date.today().year}-{n:06d}'
            c.execute('INSERT INTO license_key(key_hash, lic_id, customer, email_hash, edition, deployment, type, limits, '
                      'modules, valid_until, updates_until, grace_days, checkin_days, max_activations, created_at) '
                      'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
                      (key_hash(key), lic_id, customer, hashlib.sha256(email.lower().encode()).hexdigest() if email else '',
                       edition, deployment, type_, json.dumps(limits), json.dumps(modules) if modules is not None else None,
                       valid_until, updates_until, grace_days, checkin_days, max_activations, now_iso()))
        self.log('key_created', lic_id=lic_id, customer=customer, edition=edition)
        return key, lic_id

    def find_key(self, key: str):
        with self._conn() as c:
            return c.execute('SELECT * FROM license_key WHERE key_hash = ?', (key_hash(key),)).fetchone()

    def key_by_lic(self, lic_id: str):
        with self._conn() as c:
            return c.execute('SELECT * FROM license_key WHERE lic_id = ?', (lic_id,)).fetchone()

    def update_key(self, lic_id: str, **fields):
        allowed = {'valid_until', 'updates_until', 'revoked_at', 'revoke_reason', 'limits', 'modules', 'max_activations'}
        sets = {k: v for k, v in fields.items() if k in allowed and v is not None}  # None = leave unchanged
        if not sets:
            return
        with self._conn() as c:
            c.execute(f'UPDATE license_key SET {", ".join(f"{k} = ?" for k in sets)} WHERE lic_id = ?',
                      (*sets.values(), lic_id))
        self.log('key_updated', lic_id=lic_id, fields=sorted(sets))

    def revoked(self):
        with self._conn() as c:
            return [dict(lic_id=r['lic_id'], reason=r['revoke_reason'] or '', at=r['revoked_at'])
                    for r in c.execute('SELECT lic_id, revoke_reason, revoked_at FROM license_key WHERE revoked_at IS NOT NULL')]

    # ---- activations -----------------------------------------------------------------------------
    def activations(self, key_row, active_only=True):
        q = 'SELECT * FROM activation WHERE key_id = ?' + (' AND active = 1' if active_only else '')
        with self._conn() as c:
            return c.execute(q, (key_row['id'],)).fetchall()

    def add_activation(self, key_row, install_id, fp, ip):
        aid = 'A-' + secrets.token_hex(8)
        with self._conn() as c:
            c.execute('INSERT INTO activation(activation_id, key_id, install_id, fp, active, created_at, last_checkin_at, ip) '
                      'VALUES (?,?,?,?,1,?,?,?)', (aid, key_row['id'], install_id, json.dumps(fp), now_iso(), now_iso(), ip))
        return aid

    def activation(self, activation_id):
        with self._conn() as c:
            return c.execute('SELECT * FROM activation WHERE activation_id = ?', (activation_id,)).fetchone()

    def touch_activation(self, activation_id, fp=None, active=None):
        with self._conn() as c:
            c.execute('UPDATE activation SET last_checkin_at = ?, fp = COALESCE(?, fp), active = COALESCE(?, active) '
                      'WHERE activation_id = ?', (now_iso(), json.dumps(fp) if fp else None, active, activation_id))
