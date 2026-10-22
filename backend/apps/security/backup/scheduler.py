"""Automatic backups.

A daemon thread in each server process wakes every minute and runs the schedule when it is due.
With several worker processes all of them wake, so the run is *claimed* by a conditional UPDATE
that moves next_run_at forward — exactly one process wins. A host that was asleep at the planned
time (Render's free plan sleeps when idle) runs the missed backup once when it wakes, then carries
on from the next slot; it never replays every missed day.

Environments without a long-lived process can call `manage.py run_scheduled_backups` from cron
instead (or as well — the claim makes overlapping callers safe).
"""
import datetime
import logging
import threading
import zoneinfo

from django.conf import settings
from django.db import connections
from django.utils import timezone

from ..audit import log_event
from ..models import BackupSchedule
from . import service

logger = logging.getLogger('django')
TICK_SECONDS = 60

_started = False
_start_lock = threading.Lock()


def business_timezone():
    try:
        from apps.company.localization import get_preference
        name = get_preference('time_zone') or 'UTC'
        return name, zoneinfo.ZoneInfo(name)
    except Exception:
        return 'UTC', zoneinfo.ZoneInfo('UTC')


def compute_next_run(schedule, after=None, tz=None):
    """The first scheduled moment strictly after `after` (default: now), as an aware datetime."""
    if tz is None:
        _, tz = business_timezone()
    after = after or timezone.now()
    local = after.astimezone(tz)
    at = schedule.backup_time
    if isinstance(at, str):
        at = datetime.time.fromisoformat(at)

    def make(day):
        return datetime.datetime.combine(day, at, tzinfo=tz)

    if schedule.frequency == 'WEEKLY':
        day = local.date() + datetime.timedelta(days=(schedule.weekday - local.weekday()) % 7)
        candidate = make(day)
        if candidate <= local:
            candidate = make(day + datetime.timedelta(days=7))
    elif schedule.frequency == 'MONTHLY':
        candidate = make(local.date().replace(day=schedule.day_of_month))
        if candidate <= local:
            year, month = (local.year + 1, 1) if local.month == 12 else (local.year, local.month + 1)
            candidate = make(datetime.date(year, month, schedule.day_of_month))
    else:
        candidate = make(local.date())
        if candidate <= local:
            candidate = make(local.date() + datetime.timedelta(days=1))
    return candidate.astimezone(datetime.timezone.utc)


def refresh_next_run(schedule, save=True):
    """Recompute next_run_at (after a schedule edit, or when the business time zone changed)."""
    name, tz = business_timezone()
    schedule.timezone = name
    schedule.next_run_at = compute_next_run(schedule, tz=tz) if schedule.enabled else None
    if save:
        BackupSchedule.objects.filter(pk=schedule.pk).update(timezone=name, next_run_at=schedule.next_run_at)
    return schedule


def ensure_current(schedule):
    """Keep next_run_at in step with the business time zone and enabled flag."""
    name, _ = business_timezone()
    if schedule.enabled and (schedule.next_run_at is None or schedule.timezone != name):
        refresh_next_run(schedule)
    return schedule


def run_due(now=None):
    """Run the scheduled backup if it is due and this caller wins the claim. Returns the record or None."""
    now = now or timezone.now()
    schedule = ensure_current(BackupSchedule.load())
    if not schedule.enabled or schedule.next_run_at is None or schedule.next_run_at > now:
        return None
    _, tz = business_timezone()
    following = compute_next_run(schedule, after=now, tz=tz)
    claimed = BackupSchedule.objects.filter(pk=schedule.pk, enabled=True, next_run_at=schedule.next_run_at).update(
        next_run_at=following, last_run_at=now, last_run_status='RUNNING')
    if not claimed:
        return None
    try:
        record = service.start_backup('SCHEDULED', actor_name='Scheduler', run_async=False)
    except service.BackupBusy:
        BackupSchedule.objects.filter(pk=schedule.pk).update(last_run_status='SKIPPED')
        log_event('BACKUP_SCHEDULE_SKIPPED', 'BACKUP', 'Scheduled backup skipped — another backup or restore was '
                  'running', actor_name='Scheduler', severity='WARNING')
        return None
    BackupSchedule.objects.filter(pk=schedule.pk).update(last_run_status=record.status)
    if record.status == 'SUCCESS':
        service.apply_retention()
    return record


def _loop():
    # Let the server finish booting (and migrations land) before the first check.
    stop = threading.Event()
    stop.wait(30)
    while True:
        try:
            service.recover_stale()
            run_due()
        except Exception:
            logger.exception('Scheduled backup tick failed')
        finally:
            connections.close_all()
        stop.wait(TICK_SECONDS)


def start_scheduler():
    """Start the background scheduler once per process (idempotent)."""
    global _started
    if not getattr(settings, 'BACKUP_SCHEDULER_ENABLED', True):
        return False
    with _start_lock:
        if _started:
            return False
        _started = True
    threading.Thread(target=_loop, name='backup-scheduler', daemon=True).start()
    logger.info('Backup scheduler started.')
    return True
