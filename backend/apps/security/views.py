"""System Security & Backup API.

/api/security/…  policy, session heartbeat, password re-confirmation, own 2FA enrolment, audit log
/api/backups/…   health, history, create / upload / download / delete, restore jobs, schedule
"""
import datetime
import re

from django.core import signing
from django.db import transaction
from django.http import StreamingHttpResponse
from django.shortcuts import get_object_or_404
from django.utils import timezone
from rest_framework import permissions, status
from rest_framework.response import Response
from rest_framework.throttling import ScopedRateThrottle
from rest_framework.views import APIView

from apps.billing.views import user_role
from apps.common.pagination import PageSizePagination

from . import login_protection, policy, totp
from .audit import log_event
from .backup import archive, scheduler, service, storage
from .models import BackupRecord, BackupSchedule, RestoreJob, SecurityAuditLog, SecuritySettings, UserTwoFactor

ADMIN_ROLES = {'SUPER_ADMIN', 'ADMINISTRATOR'}   # view status, run / download backups, edit schedule
OWNER_ROLES = {'SUPER_ADMIN'}                    # security policy, restore, upload, delete backups
DOWNLOAD_SALT = 'security.backup.download'
DOWNLOAD_TTL = 120
TIME_RE = re.compile(r'^([01][0-9]|2[0-3]):([0-5][0-9])$')


def _role_permission(read_roles, write_roles):
    class RolePermission(permissions.BasePermission):
        message = 'Your role is not allowed to do this.'

        def has_permission(self, request, view):
            roles = read_roles if request.method in permissions.SAFE_METHODS else write_roles
            return user_role(request.user) in roles
    return RolePermission


AdminOnly = _role_permission(ADMIN_ROLES, ADMIN_ROLES)
AdminReadOwnerWrite = _role_permission(ADMIN_ROLES, OWNER_ROLES)
OwnerOnly = _role_permission(OWNER_ROLES, OWNER_ROLES)


def _bad(errors, detail='Please fix the highlighted fields.'):
    return Response({'detail': detail, 'errors': errors}, status=status.HTTP_400_BAD_REQUEST)


def _iso(dt):
    return dt.isoformat() if dt else None


def _sid(request):
    token = getattr(request, 'auth', None)
    try:
        return token.get('sid') if token is not None else None
    except AttributeError:
        return None


# ---- security policy ---------------------------------------------------------------------------

SETTING_FIELDS = ('inactivity_timeout_minutes', 'sensitive_action_reauth', 'login_protection_enabled',
                  'max_failed_attempts', 'lockout_minutes', 'two_factor_required')


def _settings_payload(obj, user):
    tf = UserTwoFactor.objects.filter(user_id=user.pk).first()
    return {
        **{f: getattr(obj, f) for f in SETTING_FIELDS},
        'version': obj.version,
        'updated_at': _iso(obj.updated_at),
        'updated_by': obj.updated_by_name,
        'options': {
            'inactivity_timeout_minutes': list(SecuritySettings.TIMEOUT_CHOICES),
            'lockout_minutes': list(SecuritySettings.LOCKOUT_CHOICES),
            'max_failed_attempts': list(range(3, 11)),
        },
        'two_factor': {
            'enrolled': bool(tf and tf.enrolled),
            'confirmed_at': _iso(tf.confirmed_at) if tf else None,
            'enrolled_users': UserTwoFactor.objects.filter(confirmed_at__isnull=False).count(),
        },
        'can_edit': user_role(user) in OWNER_ROLES,
        'reauth_window_seconds': int(policy.REAUTH_WINDOW.total_seconds()),
    }


def _validate_settings(data, user):
    clean, errors = {}, {}

    def as_bool(key):
        value = data[key]
        if isinstance(value, bool):
            clean[key] = value
        else:
            errors[key] = 'Must be on or off.'

    def as_choice(key, choices, message):
        try:
            value = int(data[key])
        except (TypeError, ValueError):
            errors[key] = message
            return
        if value in choices:
            clean[key] = value
        else:
            errors[key] = message

    for key in ('sensitive_action_reauth', 'login_protection_enabled', 'two_factor_required'):
        if key in data:
            as_bool(key)
    if 'inactivity_timeout_minutes' in data:
        as_choice('inactivity_timeout_minutes', SecuritySettings.TIMEOUT_CHOICES,
                  'Choose 5, 15, 30, 60 or 120 minutes.')
    if 'lockout_minutes' in data:
        as_choice('lockout_minutes', SecuritySettings.LOCKOUT_CHOICES, 'Choose 5, 15, 30 or 60 minutes.')
    if 'max_failed_attempts' in data:
        as_choice('max_failed_attempts', range(3, 11), 'Choose between 3 and 10 attempts.')
    if clean.get('two_factor_required'):
        tf = UserTwoFactor.objects.filter(user_id=user.pk, confirmed_at__isnull=False).exists()
        if not tf:
            errors['two_factor_required'] = ('Set up two-factor authentication on your own account first, so '
                                             'enforcing it cannot lock you out.')
    return clean, errors


class SecuritySettingsView(APIView):
    permission_classes = [AdminReadOwnerWrite]

    def get(self, request):
        return Response(_settings_payload(SecuritySettings.load(), request.user))

    def patch(self, request):
        return self._save(request)

    def put(self, request):
        return self._save(request)

    def _save(self, request):
        data = request.data if isinstance(request.data, dict) else {}
        clean, errors = _validate_settings(data, request.user)
        if errors:
            return _bad(errors)
        with transaction.atomic():
            obj = SecuritySettings.objects.select_for_update().get(pk=SecuritySettings.load().pk)
            sent = data.get('version')
            if sent is not None and str(sent) != str(obj.version):
                return Response({'detail': 'Another administrator changed these settings while you were editing. '
                                           'Review the current values and save again.',
                                 'code': 'conflict', 'current': _settings_payload(obj, request.user)},
                                status=status.HTTP_409_CONFLICT)
            changes = {k: [getattr(obj, k), v] for k, v in clean.items() if getattr(obj, k) != v}
            if changes:
                for key, (_, new) in changes.items():
                    setattr(obj, key, new)
                obj.version += 1
                obj.updated_by_id = request.user.pk
                obj.updated_by_name = request.user.username[:150]
                obj.save()
                log_event('SECURITY_SETTINGS_UPDATED', 'SECURITY',
                          f"Security settings changed: {', '.join(sorted(changes))}", request=request,
                          details={'changes': changes})
        return Response(_settings_payload(obj, request.user))


class SecurityPolicyView(APIView):
    """The parts of the policy the browser needs (its idle timer, the re-auth prompt)."""

    def get(self, request):
        p = policy.get_settings()
        return Response({'inactivity_timeout_minutes': p.inactivity_timeout_minutes,
                         'sensitive_action_reauth': p.sensitive_action_reauth,
                         'two_factor_required': p.two_factor_required,
                         'two_factor_enrolled': UserTwoFactor.objects.filter(
                             user_id=request.user.pk, confirmed_at__isnull=False).exists(),
                         'reauth_window_seconds': int(policy.REAUTH_WINDOW.total_seconds())})


class SessionHeartbeatView(APIView):
    """The browser calls this while the user is active; authentication records the activity."""

    def post(self, request):
        return Response(status=status.HTTP_204_NO_CONTENT)


class ReauthView(APIView):
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = 'reauth'

    def post(self, request):
        sid = _sid(request)
        if not sid:
            return Response({'detail': 'Sign in again to continue.', 'code': 'session_expired'},
                            status=status.HTTP_401_UNAUTHORIZED)
        username = request.user.username
        login_protection.ensure_not_locked(username, request)
        if not request.user.check_password(str(request.data.get('password') or '')):
            login_protection.record_failure(username, request, reason='reauth')
            return _bad({'password': 'Incorrect password.'}, 'Incorrect password.')
        tf = UserTwoFactor.objects.filter(user_id=request.user.pk, confirmed_at__isnull=False).first()
        if tf is not None:
            step = totp.match_step(tf.secret, request.data.get('code'))
            if step is None or not UserTwoFactor.objects.filter(pk=tf.pk, last_used_step__lt=step).update(
                    last_used_step=step):
                login_protection.record_failure(username, request, reason='reauth-2fa')
                return _bad({'code': 'Enter the current 6-digit code from your authenticator app.'},
                            'Two-factor code required.')
        policy.mark_reauthenticated(sid)
        return Response({'reauthenticated': True, 'valid_for_seconds': int(policy.REAUTH_WINDOW.total_seconds()),
                         'two_factor': tf is not None})


# ---- own two-factor enrolment ------------------------------------------------------------------

class TwoFactorStatusView(APIView):
    def get(self, request):
        tf = UserTwoFactor.objects.filter(user_id=request.user.pk).first()
        return Response({'enrolled': bool(tf and tf.enrolled), 'confirmed_at': _iso(tf.confirmed_at) if tf else None,
                         'required': policy.get_settings().two_factor_required})


class TwoFactorSetupView(APIView):
    def post(self, request):
        tf = UserTwoFactor.objects.filter(user_id=request.user.pk).first()
        if tf and tf.enrolled:
            return _bad({'code': 'Two-factor authentication is already set up. Turn it off first to replace it.'},
                        'Already set up.')
        secret = totp.new_secret()
        UserTwoFactor.objects.update_or_create(user_id=request.user.pk,
                                               defaults={'secret': secret, 'confirmed_at': None, 'last_used_step': 0})
        return Response({'secret': secret, 'otpauth_uri': totp.provisioning_uri(secret, request.user.username)})


class TwoFactorConfirmView(APIView):
    def post(self, request):
        tf = UserTwoFactor.objects.filter(user_id=request.user.pk, confirmed_at__isnull=True).first()
        if tf is None:
            return _bad({'code': 'Start the setup again.'}, 'No setup in progress.')
        step = totp.match_step(tf.secret, request.data.get('code'))
        if step is None:
            return _bad({'code': 'That code is not valid. Check the time on your phone and try again.'}, 'Invalid code.')
        UserTwoFactor.objects.filter(pk=tf.pk).update(confirmed_at=timezone.now(), last_used_step=step)
        log_event('TWO_FACTOR_ENROLLED', 'SECURITY', f'{request.user.username} turned on two-factor authentication',
                  request=request)
        return Response({'enrolled': True})


class TwoFactorDisableView(APIView):
    def post(self, request):
        tf = UserTwoFactor.objects.filter(user_id=request.user.pk).first()
        if tf is None:
            return Response({'enrolled': False})
        if tf.enrolled and policy.get_settings().two_factor_required:
            return _bad({'code': 'Two-factor authentication is required for every sign-in. Turn off the '
                                 'requirement first.'}, 'Two-factor is enforced.')
        if tf.enrolled:
            errors = {}
            if not request.user.check_password(str(request.data.get('password') or '')):
                errors['password'] = 'Incorrect password.'
            if totp.match_step(tf.secret, request.data.get('code')) is None:
                errors['code'] = 'Enter the current code from your authenticator app.'
            if errors:
                login_protection.record_failure(request.user.username, request, reason='2fa-disable')
                return _bad(errors)
        tf.delete()
        if tf.enrolled:
            log_event('TWO_FACTOR_DISABLED', 'SECURITY', f'{request.user.username} turned off two-factor '
                      'authentication', request=request, severity='WARNING')
        return Response({'enrolled': False})


# ---- audit log ---------------------------------------------------------------------------------

def _date_param(value):
    try:
        return datetime.date.fromisoformat(value) if value else None
    except ValueError:
        return None


def _local_day_bounds(day):
    _, tz = scheduler.business_timezone()
    start = datetime.datetime.combine(day, datetime.time.min, tzinfo=tz)
    return start, start + datetime.timedelta(days=1)


def _filter_dates(qs, request, field='created_at'):
    start = _date_param(request.query_params.get('date_from'))
    end = _date_param(request.query_params.get('date_to'))
    if start:
        qs = qs.filter(**{f'{field}__gte': _local_day_bounds(start)[0]})
    if end:
        qs = qs.filter(**{f'{field}__lt': _local_day_bounds(end)[1]})
    return qs


def _paginate(request, view, qs, serialize):
    paginator = PageSizePagination()
    page = paginator.paginate_queryset(qs, request, view=view)
    return paginator.get_paginated_response([serialize(x) for x in page])


class SecurityAuditLogView(APIView):
    permission_classes = [AdminOnly]

    def get(self, request):
        qs = SecurityAuditLog.objects.all()
        for param in ('category', 'severity', 'event'):
            value = (request.query_params.get(param) or '').upper()
            if value:
                qs = qs.filter(**{param: value})
        qs = _filter_dates(qs, request)
        return _paginate(request, self, qs, lambda r: {
            'id': r.pk, 'event': r.event, 'category': r.category, 'severity': r.severity, 'summary': r.summary,
            'details': r.details, 'actor': r.actor_name, 'ip_address': r.ip_address, 'created_at': _iso(r.created_at)})


# ---- backups -----------------------------------------------------------------------------------

class BackupHealthView(APIView):
    permission_classes = [AdminOnly]

    def get(self, request):
        return Response(service.health())


class BackupHistoryView(APIView):
    permission_classes = [AdminOnly]

    def get(self, request):
        service.recover_stale()
        qs = BackupRecord.objects.all()
        kind = (request.query_params.get('type') or '').upper()
        if kind:
            qs = qs.filter(backup_type=kind)
        state = (request.query_params.get('status') or '').upper()
        if state:
            qs = qs.filter(status=state)
        elif request.query_params.get('include_deleted') not in ('1', 'true'):
            qs = qs.exclude(status='DELETED')
        qs = _filter_dates(qs, request)
        return _paginate(request, self, qs, lambda r: service.record_summary(r, detail=False) | {
            'can_delete': not service.deletion_blocker(r)})


class BackupCreateView(APIView):
    permission_classes = [AdminOnly]

    def post(self, request):
        try:
            record = service.start_backup('MANUAL', user=request.user, request=request)
        except service.BackupBusy as exc:
            return Response({'detail': str(exc), 'code': 'busy'}, status=status.HTTP_409_CONFLICT)
        return Response(service.record_summary(record, detail=True), status=status.HTTP_202_ACCEPTED)


class BackupDetailView(APIView):
    permission_classes = [AdminReadOwnerWrite]

    def get(self, request, pk):
        service.recover_stale()
        return Response(service.record_summary(get_object_or_404(BackupRecord, pk=pk), detail=True))

    def delete(self, request, pk):
        record = get_object_or_404(BackupRecord, pk=pk)
        try:
            service.delete_backup(record, user=request.user, request=request)
        except archive.BackupError as exc:
            return Response({'detail': str(exc), 'code': 'not_deletable'}, status=status.HTTP_409_CONFLICT)
        record.refresh_from_db()
        return Response(service.record_summary(record, detail=True))


class BackupDownloadLinkView(APIView):
    """A signed link valid for DOWNLOAD_TTL seconds, so the browser can stream the file natively
    (no bearer header on a plain navigation) without exposing a reusable credential."""
    permission_classes = [AdminOnly]

    def post(self, request, pk):
        record = get_object_or_404(BackupRecord, pk=pk)
        if not record.available or not storage.store_for(record).exists(record):
            return Response({'detail': 'This backup is not available for download.'}, status=status.HTTP_409_CONFLICT)
        token = signing.dumps({'b': str(record.pk), 'u': str(request.user.pk)}, salt=DOWNLOAD_SALT, compress=True)
        return Response({'url': f'/api/backups/{record.pk}/download/?token={token}', 'expires_in': DOWNLOAD_TTL,
                         'filename': record.filename, 'size': record.file_size})


class BackupDownloadView(APIView):
    authentication_classes = []
    permission_classes = [permissions.AllowAny]

    def get(self, request, pk):
        from django.contrib.auth import get_user_model
        try:
            claims = signing.loads(request.query_params.get('token') or '', salt=DOWNLOAD_SALT, max_age=DOWNLOAD_TTL)
        except signing.SignatureExpired:
            return Response({'detail': 'This download link has expired. Start the download again.'},
                            status=status.HTTP_403_FORBIDDEN)
        except signing.BadSignature:
            return Response({'detail': 'Invalid download link.'}, status=status.HTTP_403_FORBIDDEN)
        if claims.get('b') != str(pk):
            return Response({'detail': 'Invalid download link.'}, status=status.HTTP_403_FORBIDDEN)
        user = get_user_model().objects.filter(pk=claims.get('u'), is_active=True).first()
        if user is None or user_role(user) not in ADMIN_ROLES:
            return Response({'detail': 'You are not allowed to download backups.'}, status=status.HTTP_403_FORBIDDEN)
        record = get_object_or_404(BackupRecord, pk=pk)
        if not record.available:
            return Response({'detail': 'This backup is not available for download.'}, status=status.HTTP_409_CONFLICT)
        store = storage.store_for(record)
        try:
            chunks = store.iter_bytes(record)
            first = next(chunks)
        except (FileNotFoundError, StopIteration):
            return Response({'detail': 'The backup file is missing from storage.'}, status=status.HTTP_410_GONE)

        def stream():
            yield first
            yield from chunks

        log_event('BACKUP_DOWNLOADED', 'BACKUP', f'Backup {record.backup_identifier} downloaded', request=request,
                  user=user, details={'backup_id': str(record.pk), 'filename': record.filename})
        response = StreamingHttpResponse(stream(), content_type='application/zip')
        response['Content-Disposition'] = f'attachment; filename="{record.filename}"'
        response['Content-Length'] = str(record.file_size)
        response['Cache-Control'] = 'no-store'
        response['X-Content-Type-Options'] = 'nosniff'
        return response


class BackupUploadView(APIView):
    permission_classes = [OwnerOnly]

    def post(self, request):
        uploaded = request.FILES.get('file')
        if uploaded is None:
            return _bad({'file': 'Choose a backup file.'})
        if not (uploaded.name or '').lower().endswith('.zip'):
            return _bad({'file': 'Choose a .zip backup file created by this application.'})
        try:
            record, result, duplicate = service.import_upload(uploaded, user=request.user, request=request)
        except archive.BackupError as exc:
            log_event('BACKUP_UPLOAD_REJECTED', 'BACKUP', f'Uploaded backup file rejected: {exc}', request=request,
                      severity='WARNING', details={'filename': (uploaded.name or '')[:200]})
            return _bad({'file': str(exc)}, str(exc))
        manifest = result['manifest']
        return Response({
            'backup': service.record_summary(record, detail=True),
            'duplicate': duplicate,
            'compatibility': result['compatibility'],
            'warnings': result['warnings'],
            'source': {'backup_identifier': manifest.get('backup_identifier'), 'created_at': manifest.get('created_at'),
                       'database_engine': manifest.get('database_engine'), 'table_count': manifest.get('table_count'),
                       'total_rows': manifest.get('total_rows')},
        }, status=status.HTTP_201_CREATED)


class RestoreStartView(APIView):
    permission_classes = [OwnerOnly]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = 'reauth'

    def post(self, request):
        data = request.data if isinstance(request.data, dict) else {}
        errors = {}
        if str(data.get('confirmation') or '').strip() != 'RESTORE':
            errors['confirmation'] = 'Type RESTORE to confirm.'
        record = BackupRecord.objects.filter(pk=data.get('backup_id')).first() if _is_uuid(data.get('backup_id')) else None
        if record is None:
            errors['backup_id'] = 'Choose a backup to restore.'
        login_protection.ensure_not_locked(request.user.username, request)
        if not request.user.check_password(str(data.get('password') or '')):
            login_protection.record_failure(request.user.username, request, reason='restore')
            errors['password'] = 'Incorrect password.'
        if errors:
            return _bad(errors)
        try:
            job = service.start_restore(record, user=request.user, request=request, keep_session=_sid(request))
        except service.BackupBusy as exc:
            return Response({'detail': str(exc), 'code': 'busy'}, status=status.HTTP_409_CONFLICT)
        except archive.BackupError as exc:
            return _bad({'backup_id': str(exc)}, str(exc))
        return Response(service.restore_summary(job), status=status.HTTP_202_ACCEPTED)


def _is_uuid(value):
    import uuid
    try:
        uuid.UUID(str(value))
        return True
    except (TypeError, ValueError):
        return False


class RestoreStatusView(APIView):
    permission_classes = [AdminOnly]

    def get(self, request, pk):
        service.recover_stale()
        return Response(service.restore_summary(get_object_or_404(RestoreJob.objects.select_related('backup'), pk=pk)))


# ---- schedule ----------------------------------------------------------------------------------

SCHEDULE_FIELDS = ('enabled', 'frequency', 'backup_time', 'weekday', 'day_of_month', 'retention_count')


def _schedule_payload(s):
    name, _ = scheduler.business_timezone()
    return {
        'enabled': s.enabled, 'frequency': s.frequency, 'backup_time': s.backup_time.strftime('%H:%M'),
        'weekday': s.weekday, 'day_of_month': s.day_of_month, 'retention_count': s.retention_count,
        'timezone': name, 'next_run_at': _iso(s.next_run_at) if s.enabled else None,
        'last_run_at': _iso(s.last_run_at), 'last_run_status': s.last_run_status,
        'version': s.version, 'updated_at': _iso(s.updated_at), 'updated_by': s.updated_by_name,
        'options': {'retention_presets': [7, 15, 30, 60], 'retention_max': 365},
    }


def _validate_schedule(data):
    clean, errors = {}, {}
    if 'enabled' in data:
        if isinstance(data['enabled'], bool):
            clean['enabled'] = data['enabled']
        else:
            errors['enabled'] = 'Must be on or off.'
    if 'frequency' in data:
        if data['frequency'] in ('DAILY', 'WEEKLY', 'MONTHLY'):
            clean['frequency'] = data['frequency']
        else:
            errors['frequency'] = 'Choose daily, weekly or monthly.'
    if 'backup_time' in data:
        m = TIME_RE.match(str(data['backup_time'] or ''))
        if m:
            clean['backup_time'] = datetime.time(int(m.group(1)), int(m.group(2)))
        else:
            errors['backup_time'] = 'Enter a time as HH:MM (24-hour).'
    for key, lo, hi, message in (('weekday', 0, 6, 'Choose a day of the week.'),
                                 ('day_of_month', 1, 28, 'Choose a day between 1 and 28.'),
                                 ('retention_count', 1, 365, 'Keep between 1 and 365 backups.')):
        if key in data:
            try:
                value = int(data[key])
                if isinstance(data[key], bool) or not lo <= value <= hi:
                    raise ValueError
                clean[key] = value
            except (TypeError, ValueError):
                errors[key] = message
    return clean, errors


class BackupScheduleView(APIView):
    permission_classes = [AdminOnly]

    def get(self, request):
        return Response(_schedule_payload(scheduler.ensure_current(BackupSchedule.load())))

    def put(self, request):
        data = request.data if isinstance(request.data, dict) else {}
        clean, errors = _validate_schedule(data)
        if errors:
            return _bad(errors)
        with transaction.atomic():
            s = BackupSchedule.objects.select_for_update().get(pk=BackupSchedule.load().pk)
            sent = data.get('version')
            if sent is not None and str(sent) != str(s.version):
                return Response({'detail': 'Another administrator changed the schedule while you were editing. '
                                           'Review it and save again.', 'code': 'conflict',
                                 'current': _schedule_payload(s)}, status=status.HTTP_409_CONFLICT)

            def show(v):
                return v.strftime('%H:%M') if isinstance(v, datetime.time) else v
            changes = {k: [show(getattr(s, k)), show(v)] for k, v in clean.items() if getattr(s, k) != v}
            if changes:
                for key, value in clean.items():
                    setattr(s, key, value)
                s.version += 1
                s.updated_by_id = request.user.pk
                s.updated_by_name = request.user.username[:150]
                scheduler.refresh_next_run(s, save=False)
                s.save()
                log_event('BACKUP_SCHEDULE_UPDATED', 'BACKUP', f"Backup schedule changed: {', '.join(sorted(changes))}",
                          request=request, details={'changes': changes,
                                                    'next_run_at': _iso(s.next_run_at)})
        return Response(_schedule_payload(s))
