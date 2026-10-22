"""System Security & Backup: session policy, login protection, two-factor sign-in, the security
audit trail and database backups / restores.

None of these tables is part of a database backup (see backup/archive.py EXCLUDED_APPS): a
restore must not rewind the audit log, the backup history it is reading from, or anyone's
second factor. User references therefore carry no database constraint — a restore replaces the
user table wholesale, and a dangling id here must not make that transaction fail. Every row
keeps the person's name next to the id so history still reads correctly afterwards.
"""
import datetime
import uuid

from django.conf import settings
from django.db import models
from django.utils import timezone


def _user_fk(**extra):
    return models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.DO_NOTHING, db_constraint=False,
                             null=True, blank=True, related_name='+', **extra)


class SecuritySettings(models.Model):
    """Singleton (pk=1) security policy. Read it through security.policy.get_settings()."""
    TIMEOUT_CHOICES = (5, 15, 30, 60, 120)
    LOCKOUT_CHOICES = (5, 15, 30, 60)

    inactivity_timeout_minutes = models.PositiveSmallIntegerField(default=30)
    sensitive_action_reauth = models.BooleanField(default=False)
    login_protection_enabled = models.BooleanField(default=True)
    max_failed_attempts = models.PositiveSmallIntegerField(default=5)
    lockout_minutes = models.PositiveSmallIntegerField(default=15)
    two_factor_required = models.BooleanField(default=False)
    # Bumped on every save; a PATCH carrying an older version is refused (two admins editing).
    version = models.PositiveIntegerField(default=1)
    updated_by = _user_fk()
    updated_by_name = models.CharField(max_length=150, blank=True, default='')
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = 'Security Settings'
        verbose_name_plural = 'Security Settings'
        constraints = [
            models.CheckConstraint(condition=models.Q(inactivity_timeout_minutes__in=(5, 15, 30, 60, 120)),
                                   name='security_timeout_choice'),
            models.CheckConstraint(condition=models.Q(max_failed_attempts__gte=3, max_failed_attempts__lte=10),
                                   name='security_max_attempts_range'),
        ]

    @classmethod
    def load(cls):
        obj, _ = cls.objects.get_or_create(pk=1)
        return obj


class AuthSession(models.Model):
    """One sign-in. Its id rides in the JWT as the `sid` claim, so the server can expire an
    idle session, end it on logout, and remember a recent password re-confirmation."""
    END_REASONS = [('LOGOUT', 'Signed out'), ('TIMEOUT', 'Inactivity timeout'),
                   ('RESTORE', 'Database restored'), ('REVOKED', 'Revoked')]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = _user_fk()
    username = models.CharField(max_length=150, blank=True, default='')
    created_at = models.DateTimeField(default=timezone.now)
    last_activity_at = models.DateTimeField(default=timezone.now)
    reauthenticated_at = models.DateTimeField(null=True, blank=True)
    two_factor_verified = models.BooleanField(default=False)
    ended_at = models.DateTimeField(null=True, blank=True)
    end_reason = models.CharField(max_length=10, choices=END_REASONS, blank=True, default='')
    ip_address = models.GenericIPAddressField(null=True, blank=True)
    user_agent = models.CharField(max_length=255, blank=True, default='')

    class Meta:
        indexes = [models.Index(fields=['user', 'ended_at'], name='sec_session_user_open')]


class LoginAttempt(models.Model):
    """Each sign-in / second-factor / password re-confirmation attempt, for lockouts."""
    username = models.CharField(max_length=150)  # lower-cased, as typed (username or email)
    ip_address = models.GenericIPAddressField(null=True, blank=True)
    successful = models.BooleanField(default=False)
    reason = models.CharField(max_length=30, blank=True, default='')
    created_at = models.DateTimeField(default=timezone.now)

    class Meta:
        indexes = [
            models.Index(fields=['username', 'created_at'], name='sec_attempt_user_time'),
            models.Index(fields=['ip_address', 'created_at'], name='sec_attempt_ip_time'),
        ]


class UserTwoFactor(models.Model):
    """A user's TOTP authenticator. Enrolled once `confirmed_at` is set (a code was verified)."""
    user = models.OneToOneField(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, db_constraint=False,
                                related_name='two_factor')
    secret = models.CharField(max_length=64)  # base32; never returned by the API once confirmed
    confirmed_at = models.DateTimeField(null=True, blank=True)
    last_used_step = models.BigIntegerField(default=0)  # replay guard: each code works once
    created_at = models.DateTimeField(default=timezone.now)

    @property
    def enrolled(self):
        return self.confirmed_at is not None


class SecurityAuditLog(models.Model):
    """Append-only trail of security configuration changes, lockouts, backups and restores.
    Nothing in the API edits or deletes these rows, and the model refuses to."""
    CATEGORIES = [('SECURITY', 'Security settings'), ('AUTH', 'Sign-in'), ('BACKUP', 'Backup'),
                  ('RESTORE', 'Restore')]
    SEVERITIES = [('INFO', 'Info'), ('WARNING', 'Warning'), ('ERROR', 'Error')]

    event = models.CharField(max_length=40, db_index=True)
    category = models.CharField(max_length=10, choices=CATEGORIES, db_index=True)
    severity = models.CharField(max_length=10, choices=SEVERITIES, default='INFO')
    summary = models.CharField(max_length=255)
    details = models.JSONField(default=dict, blank=True)
    actor = _user_fk()
    actor_name = models.CharField(max_length=150, blank=True, default='')
    ip_address = models.GenericIPAddressField(null=True, blank=True)
    created_at = models.DateTimeField(default=timezone.now, db_index=True)

    class Meta:
        ordering = ['-created_at', '-id']

    def save(self, *args, **kwargs):
        if not self._state.adding:
            raise PermissionError('Security audit records cannot be changed.')
        super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        raise PermissionError('Security audit records cannot be deleted.')


class BackupSchedule(models.Model):
    """Singleton (pk=1) automatic-backup schedule. Times are in the business time zone."""
    FREQUENCIES = [('DAILY', 'Daily'), ('WEEKLY', 'Weekly'), ('MONTHLY', 'Monthly')]

    enabled = models.BooleanField(default=False)
    frequency = models.CharField(max_length=10, choices=FREQUENCIES, default='DAILY')
    backup_time = models.TimeField(default=datetime.time(2, 0))
    weekday = models.PositiveSmallIntegerField(default=6)       # WEEKLY: 0 = Monday … 6 = Sunday
    day_of_month = models.PositiveSmallIntegerField(default=1)  # MONTHLY: 1–28 (exists every month)
    retention_count = models.PositiveSmallIntegerField(default=15)
    timezone = models.CharField(max_length=64, blank=True, default='')  # zone next_run_at was computed in
    next_run_at = models.DateTimeField(null=True, blank=True)
    last_run_at = models.DateTimeField(null=True, blank=True)
    last_run_status = models.CharField(max_length=10, blank=True, default='')
    version = models.PositiveIntegerField(default=1)
    updated_by = _user_fk()
    updated_by_name = models.CharField(max_length=150, blank=True, default='')
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        constraints = [
            models.CheckConstraint(condition=models.Q(weekday__lte=6), name='backup_schedule_weekday'),
            models.CheckConstraint(condition=models.Q(day_of_month__gte=1, day_of_month__lte=28),
                                   name='backup_schedule_day_of_month'),
            models.CheckConstraint(condition=models.Q(retention_count__gte=1, retention_count__lte=365),
                                   name='backup_schedule_retention'),
        ]

    @classmethod
    def load(cls):
        obj, _ = cls.objects.get_or_create(pk=1)
        return obj


class BackupRecord(models.Model):
    TYPES = [('MANUAL', 'Manual'), ('SCHEDULED', 'Automatic'), ('PRE_RESTORE', 'Pre-restore safety'),
             ('UPLOADED', 'Uploaded')]
    STATUSES = [('QUEUED', 'Queued'), ('RUNNING', 'Running'), ('SUCCESS', 'Successful'),
                ('FAILED', 'Failed'), ('DELETED', 'Deleted')]
    LOCATIONS = [('FILESYSTEM', 'Server disk'), ('DATABASE', 'Database storage')]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    backup_identifier = models.CharField(max_length=40, unique=True)
    filename = models.CharField(max_length=200)
    backup_type = models.CharField(max_length=12, choices=TYPES)
    storage_location = models.CharField(max_length=12, choices=LOCATIONS)
    file_size = models.BigIntegerField(default=0)
    checksum = models.CharField(max_length=64, blank=True, default='')  # SHA-256 of the archive file
    status = models.CharField(max_length=10, choices=STATUSES, default='QUEUED')
    verified = models.BooleanField(default=False)
    manifest = models.JSONField(default=dict, blank=True)  # summary of the archive's manifest
    created_at = models.DateTimeField(default=timezone.now)
    started_at = models.DateTimeField(null=True, blank=True)
    completed_at = models.DateTimeField(null=True, blank=True)
    heartbeat_at = models.DateTimeField(null=True, blank=True)
    initiated_by = _user_fk()
    initiated_by_name = models.CharField(max_length=150, blank=True, default='')
    error_summary = models.CharField(max_length=500, blank=True, default='')
    deleted_at = models.DateTimeField(null=True, blank=True)
    deleted_by_name = models.CharField(max_length=150, blank=True, default='')

    class Meta:
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['status', 'created_at'], name='sec_backup_status_time'),
            models.Index(fields=['backup_type', 'created_at'], name='sec_backup_type_time'),
        ]
        constraints = [models.CheckConstraint(condition=models.Q(file_size__gte=0), name='backup_size_nonneg')]

    @property
    def available(self):
        return self.status == 'SUCCESS' and self.verified


class BackupChunk(models.Model):
    """Archive bytes for DATABASE storage (hosts with an ephemeral disk), in 1 MB pieces."""
    record = models.ForeignKey(BackupRecord, on_delete=models.CASCADE, related_name='chunks')
    seq = models.PositiveIntegerField()
    data = models.BinaryField()

    class Meta:
        constraints = [models.UniqueConstraint(fields=['record', 'seq'], name='uniq_backup_chunk')]


class RestoreJob(models.Model):
    STATUSES = [('QUEUED', 'Queued'), ('RUNNING', 'Running'), ('SUCCESS', 'Successful'), ('FAILED', 'Failed')]
    STAGES = [('QUEUED', 'Waiting to start'), ('VALIDATING', 'Validating backup'),
              ('SAFETY_BACKUP', 'Creating safety backup'), ('RESTORING', 'Restoring data'),
              ('FINALIZING', 'Finalizing'), ('DONE', 'Done')]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    backup = models.ForeignKey(BackupRecord, on_delete=models.PROTECT, related_name='restores')
    status = models.CharField(max_length=10, choices=STATUSES, default='QUEUED')
    stage = models.CharField(max_length=14, choices=STAGES, default='QUEUED')
    pre_restore_backup = models.ForeignKey(BackupRecord, on_delete=models.SET_NULL, null=True, blank=True,
                                           related_name='+')
    result = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(default=timezone.now)
    started_at = models.DateTimeField(null=True, blank=True)
    completed_at = models.DateTimeField(null=True, blank=True)
    heartbeat_at = models.DateTimeField(null=True, blank=True)
    initiated_by = _user_fk()
    initiated_by_name = models.CharField(max_length=150, blank=True, default='')
    error_summary = models.CharField(max_length=500, blank=True, default='')

    class Meta:
        ordering = ['-created_at']


class OperationLock(models.Model):
    """At most one backup or restore runs at a time, across every worker process. `holder` is
    'backup:<id>' / 'restore:<id>' while held, '' when free; a holder whose heartbeat stopped
    (the process died) is treated as free after a few minutes."""
    name = models.CharField(max_length=20, primary_key=True)
    holder = models.CharField(max_length=60, blank=True, default='')
    acquired_at = models.DateTimeField(null=True, blank=True)
    heartbeat_at = models.DateTimeField(null=True, blank=True)
