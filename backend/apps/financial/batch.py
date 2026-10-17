"""Per-commit memo for the accounting engine.

One saved bill queues several postings that all run back to back right after its transaction
commits: the invoice, then each receipt — and booking the invoice already re-books its receipts
(integration._dependents), so the receipts' own queued postings repeated identical work. Each
posting also re-read the policy, the role mappings and the voucher types. On the hosted
database every one of those reads is a network round trip.

A Batch lives for one commit's postings only: what was booked (so a repeat is skipped) and the
settings already read (so they are read once). Nothing outlives the batch, so a policy, mapping
or fiscal-period change is never served stale to a later request.
"""
import threading
from contextlib import contextmanager

_local = threading.local()


class Batch:
    def __init__(self):
        self.booked = set()
        self.memo = {}
        self.started = False  # set when its first posting runs; later schedules start a new batch


def current():
    return getattr(_local, 'batch', None)


@contextmanager
def active(batch):
    previous = current()
    _local.batch = batch
    try:
        yield batch
    finally:
        _local.batch = previous


def memo(key, loader):
    """loader() once per batch (every time outside one). Exceptions are not memoised."""
    batch = current()
    if batch is None:
        return loader()
    if key not in batch.memo:
        batch.memo[key] = loader()
    return batch.memo[key]


def already_booked(key):
    batch = current()
    return batch is not None and key in batch.booked


def mark_booked(key):
    batch = current()
    if batch is not None:
        batch.booked.add(key)
