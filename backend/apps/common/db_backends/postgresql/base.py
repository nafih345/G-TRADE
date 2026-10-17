"""PostgreSQL backend that skips the connection health check on a connection that was just used.

CONN_HEALTH_CHECKS makes Django run `SELECT 1` before the first query of every request on a
reused connection. That protects against a provider (Neon) that suspends when idle and drops
its sockets — but it is also one extra network round trip on every single request, which on
the hosted database is a few hundred milliseconds each time.

A connection that ran a query a few seconds ago has not been dropped for idleness, so the
check is skipped for it; after any longer pause it runs exactly as before. Should a socket
still die inside that window, the request errors, Django sees errors_occurred and closes the
connection, and the next request reconnects.
"""
import time

from django.db.backends.postgresql import base

# Far below Neon's idle suspend (5 minutes by default).
FRESH_SECONDS = 20


class DatabaseWrapper(base.DatabaseWrapper):
    _last_activity = 0.0

    def close_if_health_check_failed(self):
        if (self.connection is not None and self.health_check_enabled and not self.health_check_done
                and time.monotonic() - self._last_activity < FRESH_SECONDS):
            self.health_check_done = True
            return
        super().close_if_health_check_failed()

    def _cursor(self, name=None):
        cursor = super()._cursor(name)
        self._last_activity = time.monotonic()
        return cursor
