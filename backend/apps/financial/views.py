import datetime
import uuid

from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import transaction
from django.db.models import Q
from django.shortcuts import get_object_or_404
from django.utils import timezone
from rest_framework import viewsets, status
from rest_framework.decorators import action, api_view, permission_classes
from rest_framework.pagination import PageNumberPagination
from rest_framework.response import Response

from . import cashbook, cheques, integration, reports, settlements
from .accounting_catalog import SOURCES, ROLES
from .mapping import role_status, save_mapping, deactivate_mapping, accounts_in_active_mappings
from .models import (
    AccountGroup, ChartOfAccount, VoucherType, JournalEntry, LedgerEntry, AccountMapping, PostingFailure,
    FiscalPeriod, AccountingPolicy, FinancialAuditLog, Cheque,
)
from .permissions import FinancePermission, FINANCE_OVERRIDE_ROLES, user_role
from .serializers import (
    AccountGroupSerializer, ChartOfAccountSerializer, VoucherTypeSerializer, JournalEntrySerializer,
    LedgerEntrySerializer, VoucherInputSerializer, AccountMappingSerializer, PostingFailureSerializer,
    FiscalPeriodSerializer, AccountingPolicySerializer, FinancialAuditLogSerializer,
)
from .services import (
    AccountingError, error_text, create_journal, post_draft, reverse_entry, audit, normalize_lines,
    post_opening_balances, recompute_balance_cache, resolve_account,
)


class OptionalPagination(PageNumberPagination):
    """Paginate only when the client asks (?page= or ?page_size=); otherwise return the
    plain list the existing Financial screens expect."""
    page_size = 50
    page_size_query_param = 'page_size'
    max_page_size = 500

    def paginate_queryset(self, queryset, request, view=None):
        if 'page' not in request.query_params and 'page_size' not in request.query_params:
            return None
        return super().paginate_queryset(queryset, request, view)


def _error(exc, code=status.HTTP_400_BAD_REQUEST):
    return Response({'error': error_text(exc) if not isinstance(exc, str) else exc}, status=code)


def _date_param(request, name, default=None):
    try:
        return reports.parse_date(request.query_params.get(name), default)
    except ValueError:
        raise AccountingError(f"'{request.query_params.get(name)}' is not a valid {name} (use YYYY-MM-DD).")


def _check_voucher_date(date, user):
    """Backdating window (Accounting policy) and a sanity cap on future dates for posted vouchers."""
    policy = AccountingPolicy.get()
    if (policy.backdate_limit_days
            and date < timezone.localdate() - datetime.timedelta(days=policy.backdate_limit_days)
            and user_role(user) not in FINANCE_OVERRIDE_ROLES):
        raise AccountingError(f"Vouchers dated more than {policy.backdate_limit_days} day(s) back need an Administrator.")
    if date > timezone.localdate() + datetime.timedelta(days=366):
        raise AccountingError('Voucher date is too far in the future.')


class FinanceViewSetMixin:
    permission_classes = [FinancePermission]
    pagination_class = OptionalPagination


# ---------------------------------------------------------------------------
# Chart of Accounts
# ---------------------------------------------------------------------------

class AccountGroupViewSet(FinanceViewSetMixin, viewsets.ModelViewSet):
    queryset = AccountGroup.objects.all().order_by('name')
    serializer_class = AccountGroupSerializer

    def destroy(self, request, *args, **kwargs):
        group = self.get_object()
        if ChartOfAccount.all_objects.filter(account_group=group).exists():
            return _error('This group still has accounts.')
        group.hard_delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


class ChartOfAccountViewSet(FinanceViewSetMixin, viewsets.ModelViewSet):
    serializer_class = ChartOfAccountSerializer

    def get_queryset(self):
        qs = ChartOfAccount.objects.select_related('account_group', 'parent_account').order_by('code')
        p = self.request.query_params
        if p.get('search'):
            s = p['search'].strip()
            qs = qs.filter(Q(code__icontains=s) | Q(name__icontains=s) | Q(account_group__name__icontains=s)
                           | Q(parent_account__name__icontains=s) | Q(description__icontains=s))
        if p.get('account_type'):
            qs = qs.filter(account_group__account_type__iexact=p['account_type'])
        if p.get('status'):
            qs = qs.filter(status__iexact=p['status'])
        if p.get('subtype'):
            qs = qs.filter(account_subtype=p['subtype'])
        return qs

    def list(self, request, *args, **kwargs):
        response = super().list(request, *args, **kwargs)
        if request.query_params.get('with_balances'):
            balances = {r['id']: r for r in reports.account_balances()}
            rows = response.data['results'] if isinstance(response.data, dict) else response.data
            for row in rows:
                b = balances.get(str(row['id']))
                row['ledger_balance'] = b['balance'] if b else '0.00'
                row['total_debit'] = b['total_debit'] if b else '0.00'
                row['total_credit'] = b['total_credit'] if b else '0.00'
        return response

    def perform_create(self, serializer):
        acc = serializer.save(created_by=self.request.user)
        audit('ACCOUNT_CREATED', 'account', acc.pk, f"{acc.code} - {acc.name}", user=self.request.user)

    def perform_update(self, serializer):
        before = ChartOfAccountSerializer(serializer.instance).data
        acc = serializer.save(updated_by=self.request.user)
        audit('ACCOUNT_CHANGED', 'account', acc.pk, f"{acc.code} - {acc.name}",
              before={k: str(v) for k, v in before.items()},
              after={k: str(v) for k, v in ChartOfAccountSerializer(acc).data.items()}, user=self.request.user)

    def destroy(self, request, *args, **kwargs):
        acc = self.get_object()
        if acc.is_system:
            return _error(f"'{acc.code} - {acc.name}' is a system account used by automated posting and cannot be deleted.")
        if acc.pk in accounts_in_active_mappings():
            return _error(f"'{acc.code} - {acc.name}' is used by an active posting mapping. Re-map that role first.")
        if acc.ledger_entries.exists():
            return _error(f"Cannot delete account '{acc.code} - {acc.name}'. It has ledger postings; mark it Inactive instead.")
        if acc.children.filter(is_deleted=False).exists():
            return _error(f"'{acc.code} - {acc.name}' has child accounts.")
        acc.is_deleted = True
        acc.save(update_fields=['is_deleted', 'updated_at'])
        audit('ACCOUNT_DELETED', 'account', acc.pk, f"{acc.code} - {acc.name}", user=request.user)
        return Response({'message': f"Account '{acc.code}' deleted successfully."})

    @action(detail=True, methods=['get'])
    def ledger(self, request, pk=None):
        acc = self.get_object()
        try:
            data = reports.general_ledger(acc, _date_param(request, 'date_from'), _date_param(request, 'date_to'),
                                          request.query_params.get('branch'))
        except AccountingError as exc:
            return _error(exc)
        return Response(data)


class VoucherTypeViewSet(FinanceViewSetMixin, viewsets.ModelViewSet):
    queryset = VoucherType.objects.all().order_by('code')
    serializer_class = VoucherTypeSerializer


# ---------------------------------------------------------------------------
# Journals / vouchers
# ---------------------------------------------------------------------------

class JournalEntryViewSet(FinanceViewSetMixin, viewsets.ModelViewSet):
    """Register of all journals. Manual vouchers are created here (through the posting
    service); automated entries are read-only. Posted entries are corrected by reversal."""
    serializer_class = JournalEntrySerializer
    http_method_names = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options']

    def get_queryset(self):
        qs = (JournalEntry.objects.select_related('voucher_type', 'reversed_entry', 'created_by', 'posted_by')
              .prefetch_related('lines__account').order_by('-date', '-created_at'))
        p = self.request.query_params
        if p.get('status'):
            qs = qs.filter(status__in=p['status'].upper().split(','))
        if p.get('voucher_type'):
            qs = qs.filter(voucher_type__code__in=p['voucher_type'].upper().split(','))
        if p.get('source_module'):
            qs = qs.filter(source_module=p['source_module'])
        if p.get('source_key'):
            m, _, e = p['source_key'].partition('.')
            qs = qs.filter(source_module=m, source_event=e)
        if p.get('manual'):
            qs = qs.filter(Q(source_module='financial', source_event='voucher') | Q(source_module=''))
        if p.get('reference_id'):
            qs = qs.filter(reference_id=p['reference_id'])
        if p.get('account'):
            qs = qs.filter(lines__account_id=p['account']).distinct()
        if p.get('date_from'):
            qs = qs.filter(date__gte=p['date_from'])
        if p.get('date_to'):
            qs = qs.filter(date__lte=p['date_to'])
        if p.get('search'):
            s = p['search'].strip()
            qs = qs.filter(Q(entry_number__icontains=s) | Q(narration__icontains=s) | Q(source_number__icontains=s))
        return qs

    def _voucher_payload(self, request):
        ser = VoucherInputSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        data = ser.validated_data
        if data['status'] == 'POSTED':
            _check_voucher_date(data['date'], request.user)
        elif data['date'] > timezone.localdate() + datetime.timedelta(days=366):
            raise AccountingError('Voucher date is too far in the future.')
        return data

    def create(self, request, *args, **kwargs):
        try:
            data = self._voucher_payload(request)
            code = data['voucher_type_code']
            cheque_lines = [l for l in data['lines'] if l.get('cheque')]
            if cheque_lines:
                if code not in cheques.DIRECTION_OF:
                    raise AccountingError('Cheque details are taken on Receipt and Payment Vouchers only.')
                if data['status'] != 'POSTED':
                    raise AccountingError('Cheque details can only be saved on a posted voucher.')
                side = 'debit' if code == 'RV' else 'credit'
                if any(l[side] <= 0 for l in cheque_lines):
                    raise AccountingError(f"A cheque belongs on the cash / bank {side} line of the voucher.")
            key = data.get('idempotency_key') or None
            repeated = bool(key) and JournalEntry.all_objects.filter(idempotency_key=key).exists()
            with transaction.atomic():
                entry = create_journal(
                    lines=[{k: v for k, v in l.items() if k != 'cheque'} for l in data['lines']], date=data['date'],
                    narration=data['narration'], status=data['status'], voucher_type_code=code,
                    source_module='financial', source_event='voucher', source_number=data['reference_no'],
                    reference_type={'RV': 'RECEIPT_VOUCHER', 'PV': 'PAYMENT_VOUCHER', 'CV': 'CONTRA_ENTRY', 'JV': 'JOURNAL_VOUCHER'}[code],
                    branch=_branch(data.get('branch')), user=request.user, idempotency_key=key,
                )
                if cheque_lines and not repeated:
                    book = cheques.ChequeBook(code, user=request.user, branch=_request_branch(request))
                    for l in cheque_lines:
                        book.add(l['cheque'], l['debit'] or l['credit'], voucher_number=entry.entry_number, journal=entry,
                                 bank_account=resolve_account(l['account']), party_name=data['reference_no'])
                    book.save()
        except AccountingError as exc:
            return _error(exc)
        audit('VOUCHER_CREATED', 'journal', entry.pk, f"{entry.entry_number} ({entry.status}) ₹{entry.total_amount}",
              user=request.user)
        return Response(JournalEntrySerializer(entry).data, status=status.HTTP_201_CREATED)

    def update(self, request, *args, **kwargs):
        entry = self.get_object()
        if not entry.is_editable:
            return _error(f"{entry.entry_number} is {entry.status}. Posted journals cannot be edited; reverse it instead.")
        if entry.source_module not in ('financial', ''):
            return _error('Automated entries cannot be edited.')
        try:
            data = self._voucher_payload(request)
            parsed = normalize_lines([dict(l) for l in data['lines']])
            with transaction.atomic():
                entry.lines.all().delete()
                LedgerEntry.objects.bulk_create([LedgerEntry(journal_entry=entry, account=l['account'], debit=l['debit'],
                                                             credit=l['credit'], memo=l['memo']) for l in parsed])
                entry.date, entry.narration, entry.source_number = data['date'], data['narration'], data['reference_no']
                entry.total_amount = sum(l['debit'] for l in parsed)
                entry.save()
            if data['status'] == 'POSTED':
                entry = post_draft(entry, user=request.user)
        except AccountingError as exc:
            return _error(exc)
        return Response(JournalEntrySerializer(entry).data)

    partial_update = update

    def destroy(self, request, *args, **kwargs):
        entry = self.get_object()
        if not entry.is_editable:
            return _error(f"{entry.entry_number} is {entry.status} and cannot be deleted; reverse it instead.")
        number = entry.entry_number
        entry.delete()
        audit('DRAFT_DELETED', 'journal', '', f"Draft {number} deleted", user=request.user)
        return Response(status=status.HTTP_204_NO_CONTENT)

    @action(detail=True, methods=['post'], url_path='post')
    def post_entry(self, request, pk=None):
        try:
            entry = post_draft(self.get_object(), user=request.user)
        except AccountingError as exc:
            return _error(exc)
        return Response(JournalEntrySerializer(entry).data)

    @action(detail=True, methods=['post'])
    def reverse(self, request, pk=None):
        entry = self.get_object()
        reason = (request.data.get('reason') or '').strip()
        if entry.source_module not in ('financial', '') and not request.data.get('confirm_automated'):
            return _error(f"{entry.entry_number} was posted automatically from {entry.source_key} {entry.source_number}. "
                          f"Correct or cancel the source document instead; pass confirm_automated to override.")
        try:
            with transaction.atomic():
                reversal = reverse_entry(entry, user=request.user, reason=reason)
                settlements.on_voucher_reversed(entry)
                cheques.on_voucher_reversed(entry)
        except AccountingError as exc:
            return _error(exc)
        audit('JOURNAL_REVERSED', 'journal', entry.pk, f"{entry.entry_number} reversed by {reversal.entry_number}: {reason}",
              user=request.user)
        return Response({'message': 'Journal entry reversed successfully.', 'reversal_entry_number': reversal.entry_number,
                         'reversal': JournalEntrySerializer(reversal).data})


def _branch(pk):
    if not pk:
        return None
    from apps.company.models import Branch
    return Branch.objects.filter(pk=pk).first()


def _request_branch(request):
    """The working branch (X-Branch-Id) in multi-branch mode, else None."""
    if not getattr(request, 'multi_branch_enabled', False):
        return None
    branch = getattr(request, 'active_branch', None)
    return branch if getattr(branch, 'pk', None) else None


class LedgerEntryViewSet(FinanceViewSetMixin, viewsets.ReadOnlyModelViewSet):
    serializer_class = LedgerEntrySerializer

    def get_queryset(self):
        qs = reports.posted_lines().select_related('account', 'journal_entry').order_by('-journal_entry__date')
        if self.request.query_params.get('account'):
            qs = qs.filter(account_id=self.request.query_params['account'])
        return qs


# ---------------------------------------------------------------------------
# Reports
# ---------------------------------------------------------------------------

def _report(fn):
    @api_view(['GET'])
    @permission_classes([FinancePermission])
    def view(request):
        try:
            return Response(fn(request))
        except (AccountingError, ValueError) as exc:
            return _error(exc)
    view.__name__ = fn.__name__
    return view


@_report
def trial_balance_view(request):
    return reports.trial_balance(_date_param(request, 'as_of'), request.query_params.get('branch'))


@_report
def profit_loss_view(request):
    return reports.profit_and_loss(_date_param(request, 'date_from'), _date_param(request, 'date_to'),
                                   request.query_params.get('branch'))


@_report
def balance_sheet_view(request):
    return reports.balance_sheet(_date_param(request, 'as_of'), request.query_params.get('branch'))


@_report
def general_ledger_view(request):
    acc = get_object_or_404(ChartOfAccount.all_objects, pk=request.query_params.get('account'))
    return reports.general_ledger(acc, _date_param(request, 'date_from'), _date_param(request, 'date_to'),
                                  request.query_params.get('branch'))


@_report
def ledger_register_view(request):
    p = request.query_params
    sources = [s for s in (p.get('source') or '').split(',') if s.strip()]
    return reports.ledger_register(_date_param(request, 'date_from'), _date_param(request, 'date_to'),
                                   p.get('branch'), sources=sources,
                                   services_only=p.get('services') in ('1', 'true'), search=p.get('search') or '')


def _cashbook_branches(request):
    """(branch ids the Cashbook may read or None for every branch, label). Single-branch mode
    reads everything; a user limited to some branches never gets rows from the others."""
    from rest_framework.exceptions import PermissionDenied
    from apps.common.branch_context import get_allowed_branch_ids
    from apps.company.models import Branch

    if not getattr(request, 'multi_branch_enabled', False):
        return None, 'All branches'
    allowed = get_allowed_branch_ids(request)
    wanted = (request.query_params.get('branch') or 'all').strip()
    if wanted == 'all':
        if allowed is None:
            return None, 'All branches'
        return sorted(allowed), 'All permitted branches'
    try:
        branch = Branch.objects.filter(pk=wanted).first()
    except (ValueError, DjangoValidationError):
        branch = None
    if branch is None:
        raise AccountingError('Unknown branch.')
    if allowed is not None and str(branch.pk) not in allowed:
        raise PermissionDenied('You do not have access to the selected branch.')
    return [str(branch.pk)], branch.name


@_report
def cashbook_accounts_view(request):
    return {'accounts': cashbook.cash_accounts()}


@_report
def cashbook_view(request):
    p = request.query_params
    wanted = (p.get('account') or '').strip()
    if wanted == 'all':
        account_ids = [a['id'] for a in cashbook.cash_accounts()]
        if not account_ids:
            raise AccountingError('No cash accounts in the Chart of Accounts.')
    else:
        wanted = wanted or cashbook.default_cash_account_id()
        if not wanted:
            raise AccountingError('No cash accounts in the Chart of Accounts.')
        try:
            uuid.UUID(str(wanted))
        except ValueError:
            raise AccountingError('Select a valid cash account.')
        account_ids = [wanted]
    branch_ids, branch_label = _cashbook_branches(request)
    try:
        data = cashbook.cashbook(
            account_ids, all_accounts=wanted == 'all', date_from=_date_param(request, 'date_from'),
            date_to=_date_param(request, 'date_to'), branch_ids=branch_ids, search=p.get('search') or '',
            show_reversed=p.get('show_reversed') in ('1', 'true'), page=_int(p.get('page'), 1),
            page_size=_int(p.get('page_size'), 100), export=p.get('export') in ('1', 'true'))
    except cashbook.CashbookError as exc:
        raise AccountingError(str(exc))
    data['branch'] = {'id': (p.get('branch') or 'all') if getattr(request, 'multi_branch_enabled', False) else 'all',
                      'label': branch_label}
    return data


def _int(value, default):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


@_report
def account_balances_view(request):
    return reports.account_balances(_date_param(request, 'as_of'), request.query_params.get('branch'))


@_report
def source_breakdown_view(request):
    return reports.source_breakdown(_date_param(request, 'date_from'), _date_param(request, 'date_to'),
                                    request.query_params.get('branch'))


# ---------------------------------------------------------------------------
# Accounting integration (administration & monitoring)
# ---------------------------------------------------------------------------

@_report
def integration_status_view(request):
    return integration.integration_status()


@_report
def catalog_view(request):
    return {'sources': [{'key': k, 'label': v[0], 'rule': v[1]} for k, v in SOURCES.items()],
            'roles': [{'role': k, 'label': v[0], 'default_code': v[1], 'allowed_types': list(v[2]), 'description': v[3]}
                      for k, v in ROLES.items()]}


class AccountMappingViewSet(FinanceViewSetMixin, viewsets.ModelViewSet):
    serializer_class = AccountMappingSerializer
    http_method_names = ['get', 'post', 'patch', 'delete', 'head', 'options']

    def get_queryset(self):
        qs = AccountMapping.objects.select_related('account', 'branch').order_by('role', '-effective_from')
        if self.request.query_params.get('role'):
            qs = qs.filter(role=self.request.query_params['role'])
        if not self.request.query_params.get('include_inactive'):
            qs = qs.filter(is_active=True)
        return qs

    @action(detail=False, methods=['get'])
    def roles(self, request):
        return Response(role_status(_branch(request.query_params.get('branch'))))

    @action(detail=False, methods=['post'])
    def validate(self, request):
        from .mapping import mapping_problems
        acc = ChartOfAccount.objects.select_related('account_group').filter(pk=request.data.get('account')).first()
        problems = mapping_problems(request.data.get('role'), acc)
        return Response({'valid': not problems, 'problems': problems})

    def create(self, request, *args, **kwargs):
        ser = self.get_serializer(data=request.data)
        ser.is_valid(raise_exception=True)
        d = ser.validated_data
        try:
            m = save_mapping(role=d['role'], account=d['account'], branch=d.get('branch'),
                             effective_from=d.get('effective_from'), notes=d.get('notes', ''), user=request.user)
        except AccountingError as exc:
            return _error(exc)
        return Response(AccountMappingSerializer(m).data, status=status.HTTP_201_CREATED)

    def partial_update(self, request, *args, **kwargs):
        m = self.get_object()
        acc = ChartOfAccount.objects.select_related('account_group').filter(pk=request.data.get('account', m.account_id)).first()
        try:
            m = save_mapping(role=m.role, account=acc, branch=m.branch, effective_from=m.effective_from,
                             notes=request.data.get('notes', m.notes), user=request.user, mapping=m)
        except AccountingError as exc:
            return _error(exc)
        return Response(AccountMappingSerializer(m).data)

    def destroy(self, request, *args, **kwargs):
        m = self.get_object()
        deactivate_mapping(m, user=request.user)
        return Response(AccountMappingSerializer(m).data)


class PostingFailureViewSet(FinanceViewSetMixin, viewsets.ReadOnlyModelViewSet):
    serializer_class = PostingFailureSerializer

    def get_queryset(self):
        qs = PostingFailure.objects.select_related('resolved_by')
        st = self.request.query_params.get('status', 'OPEN')
        if st != 'ALL':
            qs = qs.filter(status=st)
        return qs

    @action(detail=True, methods=['post'])
    def retry(self, request, pk=None):
        failure = self.get_object()
        result = integration.retry_failure(failure, user=request.user)
        failure.refresh_from_db()
        return Response({'result': result, 'failure': PostingFailureSerializer(failure).data})

    @action(detail=False, methods=['post'], url_path='retry-all')
    def retry_all(self, request):
        results = [integration.retry_failure(f, user=request.user) for f in PostingFailure.objects.filter(status='OPEN')[:200]]
        return Response({'retried': len(results), 'succeeded': sum(1 for r in results if r.get('outcome') != 'failed')})

    @action(detail=True, methods=['post'])
    def ignore(self, request, pk=None):
        failure = self.get_object()
        if not (request.data.get('reason') or '').strip():
            return _error('Give a reason for ignoring this failure.')
        failure.status, failure.resolved_at, failure.resolved_by = 'IGNORED', timezone.now(), request.user
        failure.save(update_fields=['status', 'resolved_at', 'resolved_by', 'updated_at'])
        audit('POSTING_FAILURE_IGNORED', 'posting_failure', failure.pk, request.data['reason'][:200], user=request.user)
        return Response(PostingFailureSerializer(failure).data)


def _source_key(request):
    key = request.data.get('source_key') or request.query_params.get('source_key')
    if key not in SOURCES:
        raise AccountingError(f"Unknown source '{key}'. Expected one of: {', '.join(SOURCES)}.")
    return key


@api_view(['GET'])
@permission_classes([FinancePermission])
def preview_view(request):
    try:
        return Response(integration.preview(_source_key(request), request.query_params.get('id')))
    except (AccountingError, ValueError) as exc:
        return _error(exc)


@api_view(['GET'])
@permission_classes([FinancePermission])
def reconciliation_view(request):
    try:
        df, dt = _date_param(request, 'date_from'), _date_param(request, 'date_to')
        keys = [_source_key(request)] if request.query_params.get('source_key') else list(SOURCES)
        return Response({
            'sources': [integration.reconcile_source(k, df, dt) for k in keys],
            'subledgers': integration.subledger_reconciliation(),
            'trial_balance': {k: v for k, v in reports.trial_balance().items() if k != 'rows'},
        })
    except AccountingError as exc:
        return _error(exc)


@api_view(['POST'])
@permission_classes([FinancePermission])
def backfill_view(request):
    try:
        key = _source_key(request)
        df = reports.parse_date(request.data.get('date_from'))
        dt = reports.parse_date(request.data.get('date_to'))
        dry_run = request.data.get('dry_run', True) not in (False, 'false', 0, '0')
        return Response({'source_key': key, 'dry_run': dry_run,
                         'rows': integration.backfill(key, df, dt, dry_run=dry_run, user=request.user)})
    except (AccountingError, ValueError) as exc:
        return _error(exc)


@api_view(['POST'])
@permission_classes([FinancePermission])
def opening_balances_view(request):
    try:
        return Response({'results': post_opening_balances(user=request.user, as_of=reports.parse_date(request.data.get('as_of')),
                                                          account_ids=request.data.get('account_ids') or None)})
    except (AccountingError, ValueError) as exc:
        return _error(exc)


@api_view(['POST'])
@permission_classes([FinancePermission])
def recompute_balances_view(request):
    changed = recompute_balance_cache()
    audit('BALANCES_RECOMPUTED', 'account', '', f"{changed} cached balance(s) corrected", user=request.user)
    return Response({'corrected': changed})


@api_view(['GET', 'PATCH'])
@permission_classes([FinancePermission])
def policy_view(request):
    policy = AccountingPolicy.get()
    if request.method == 'GET':
        return Response(AccountingPolicySerializer(policy).data)
    before = AccountingPolicySerializer(policy).data
    ser = AccountingPolicySerializer(policy, data=request.data, partial=True)
    ser.is_valid(raise_exception=True)
    ser.save()
    audit('POLICY_CHANGED', 'policy', 1, 'Accounting policy updated', before=dict(before), after=dict(ser.data), user=request.user)
    return Response(ser.data)


class FiscalPeriodViewSet(FinanceViewSetMixin, viewsets.ModelViewSet):
    queryset = FiscalPeriod.objects.select_related('closed_by').all()
    serializer_class = FiscalPeriodSerializer

    def perform_create(self, serializer):
        p = serializer.save()
        audit('PERIOD_CREATED', 'fiscal_period', p.pk, f"{p.name} {p.start_date}–{p.end_date}", user=self.request.user)

    def destroy(self, request, *args, **kwargs):
        p = self.get_object()
        if p.status == 'CLOSED':
            return _error('Re-open the period before deleting it.')
        p.hard_delete()
        audit('PERIOD_DELETED', 'fiscal_period', '', p.name, user=request.user)
        return Response(status=status.HTTP_204_NO_CONTENT)

    @action(detail=True, methods=['post'])
    def close(self, request, pk=None):
        p = self.get_object()
        drafts = JournalEntry.objects.filter(status__in=('DRAFT', 'PENDING_APPROVAL'), date__range=(p.start_date, p.end_date)).count()
        failures = PostingFailure.objects.filter(status='OPEN').count()
        if (drafts or failures) and not request.data.get('force'):
            return _error(f"{drafts} draft voucher(s) in this period and {failures} open posting failure(s). "
                          f"Resolve them first or pass force to close anyway.", status.HTTP_409_CONFLICT)
        p.status, p.closed_at, p.closed_by = 'CLOSED', timezone.now(), request.user
        p.save(update_fields=['status', 'closed_at', 'closed_by', 'updated_at'])
        audit('PERIOD_CLOSED', 'fiscal_period', p.pk, p.name, user=request.user)
        return Response(FiscalPeriodSerializer(p).data)

    @action(detail=True, methods=['post'])
    def reopen(self, request, pk=None):
        if user_role(request.user) not in FINANCE_OVERRIDE_ROLES:
            return _error('Only an Administrator can re-open a closed period.', status.HTTP_403_FORBIDDEN)
        p = self.get_object()
        p.status, p.closed_at, p.closed_by = 'OPEN', None, None
        p.save(update_fields=['status', 'closed_at', 'closed_by', 'updated_at'])
        audit('PERIOD_REOPENED', 'fiscal_period', p.pk, p.name, user=request.user)
        return Response(FiscalPeriodSerializer(p).data)


class FinancialAuditLogViewSet(FinanceViewSetMixin, viewsets.ReadOnlyModelViewSet):
    serializer_class = FinancialAuditLogSerializer

    def get_queryset(self):
        qs = FinancialAuditLog.objects.all()
        if self.request.query_params.get('object_type'):
            qs = qs.filter(object_type=self.request.query_params['object_type'])
        return qs[:1000] if 'page' not in self.request.query_params else qs


# ---------------------------------------------------------------------------
# Bill-to-bill settlement (Receipt / Payment Voucher "Bill to Bill" mode) — see settlements.py
# ---------------------------------------------------------------------------

@_report
def settlement_parties_view(request):
    p = request.query_params
    voucher = (p.get('voucher') or 'RV').upper()
    if voucher not in settlements.PARTY_KINDS:
        raise AccountingError("voucher must be RV or PV.")
    kind = p.get('kind') or None
    if kind and kind not in settlements.PARTY_KINDS[voucher]:
        raise AccountingError(f"'{kind}' is not a party type for {voucher}.")
    try:
        limit = int(p.get('limit') or 50)
    except ValueError:
        raise AccountingError('limit must be a number.')
    return settlements.search_parties(voucher, p.get('search') or '', kind=kind,
                                      only_due=p.get('only_due') in ('1', 'true'), limit=limit,
                                      date_from=_date_param(request, 'date_from'), date_to=_date_param(request, 'date_to'))


@_report
def settlement_due_bills_view(request):
    p = request.query_params
    kind = p.get('party_kind')
    if kind not in ('customer', 'dealer', 'supplier'):
        raise AccountingError('party_kind must be customer, dealer or supplier.')
    try:
        import uuid
        party = uuid.UUID(str(p.get('party')))
    except (ValueError, TypeError):
        raise AccountingError('party must be a valid id.')
    bills = settlements.open_bills(kind, party_ids=[party], date_from=_date_param(request, 'date_from'),
                                   date_to=_date_param(request, 'date_to')).get(party, [])
    money_fields = ('total', 'paid', 'due')
    bills = [{k: (str(v) if k in money_fields else v) for k, v in b.items()} for b in bills]
    return {'party_kind': kind, 'party': str(party), 'bills': bills,
            'total_due': str(sum((settlements.money(b['due']) for b in bills), settlements.ZERO))}


def _settlement_input(request, voucher):
    ser = settlements.SettlementInputSerializer(data=request.data)
    ser.is_valid(raise_exception=True)
    data = ser.validated_data
    if data['party_kind'] not in settlements.PARTY_KINDS[voucher]:
        raise AccountingError(f"A {'Receipt' if voucher == 'RV' else 'Payment'} Voucher cannot settle {data['party_kind']} bills.")
    _check_voucher_date(data['date'], request.user)
    return data


@api_view(['POST'])
@permission_classes([FinancePermission])
def settlement_receipt_view(request):
    try:
        result, created = settlements.post_bill_receipt(_settlement_input(request, 'RV'), user=request.user,
                                                       branch=_request_branch(request))
    except AccountingError as exc:
        return _error(exc)
    return Response(dict(result, duplicate=not created), status=status.HTTP_201_CREATED if created else status.HTTP_200_OK)


@api_view(['POST'])
@permission_classes([FinancePermission])
def settlement_payment_view(request):
    try:
        entry, created = settlements.post_bill_payment(_settlement_input(request, 'PV'), user=request.user,
                                                      branch=_request_branch(request))
    except AccountingError as exc:
        return _error(exc)
    return Response(dict(JournalEntrySerializer(entry).data, duplicate=not created),
                    status=status.HTTP_201_CREATED if created else status.HTTP_200_OK)


@api_view(['POST'])
@permission_classes([FinancePermission])
def settlement_batch_view(request, voucher):
    """Several parties settled together (Bill to Bill with more than one party ticked)."""
    voucher = voucher.upper()
    if voucher not in settlements.PARTY_KINDS:
        return _error('voucher must be RV or PV.')
    ser = settlements.BatchInputSerializer(data=request.data)
    ser.is_valid(raise_exception=True)
    try:
        items = ser.validated_data['settlements']
        for data in items:
            if data['party_kind'] not in settlements.PARTY_KINDS[voucher]:
                raise AccountingError(f"A {'Receipt' if voucher == 'RV' else 'Payment'} Voucher cannot settle {data['party_kind']} bills.")
            _check_voucher_date(data['date'], request.user)
        results, duplicate = settlements.post_bill_batch(voucher, items, user=request.user,
                                                         branch=_request_branch(request))
    except AccountingError as exc:
        return _error(exc)
    if voucher == 'PV':
        results = JournalEntrySerializer(results, many=True).data
    return Response({'results': results, 'duplicate': duplicate},
                    status=status.HTTP_200_OK if duplicate else status.HTTP_201_CREATED)


# ---------------------------------------------------------------------------
# Cheque Register
# ---------------------------------------------------------------------------

@_report
def cheque_register_view(request):
    """GET /financial/cheques/ — cheques from Receipt / Payment Vouchers, filtered, with a summary."""
    p = request.query_params
    direction = (p.get('direction') or '').upper()
    if direction and direction not in ('RECEIVED', 'ISSUED'):
        raise AccountingError('direction must be RECEIVED or ISSUED.')
    statuses = [s for s in (p.get('status') or '').upper().split(',') if s]
    valid = {s for s, _ in Cheque.STATUS_CHOICES}
    if any(s not in valid for s in statuses):
        raise AccountingError(f"status must be one of {', '.join(sorted(valid))}.")
    if p.get('bank_account'):
        try:
            uuid.UUID(p['bank_account'])
        except ValueError:
            raise AccountingError('Select a valid bank account.')
    branch_ids, branch_label = _cashbook_branches(request)
    data = cheques.cheque_register(
        direction=direction, statuses=statuses, date_field=p.get('date_field') or 'cheque',
        date_from=_date_param(request, 'date_from'), date_to=_date_param(request, 'date_to'),
        search=p.get('search') or '', due=(p.get('due') or '').lower(), bank_account=p.get('bank_account') or '',
        branch_ids=branch_ids, sort=p.get('sort') or 'due', page=_int(p.get('page'), 1),
        page_size=_int(p.get('page_size'), 100), export=p.get('export') in ('1', 'true'))
    data['branch'] = {'id': (p.get('branch') or 'all') if getattr(request, 'multi_branch_enabled', False) else 'all',
                      'label': branch_label}
    return data


@api_view(['GET', 'PATCH'])
@permission_classes([FinancePermission])
def cheque_detail_view(request, pk):
    cheque = get_object_or_404(Cheque.objects.select_related('bank_account', 'branch', 'created_by'), pk=pk)
    from apps.common.branch_context import get_allowed_branch_ids
    allowed = get_allowed_branch_ids(request) if getattr(request, 'multi_branch_enabled', False) else None
    if allowed is not None and str(cheque.branch_id) not in allowed:
        return _error('You do not have access to this cheque.', status.HTTP_403_FORBIDDEN)
    if request.method == 'PATCH':
        ser = cheques.ChequeUpdateSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        try:
            with transaction.atomic():
                cheques.update_cheque(Cheque.objects.select_for_update().get(pk=cheque.pk),
                                      ser.validated_data, user=request.user)
        except AccountingError as exc:
            return _error(exc)
        cheque = Cheque.objects.select_related('bank_account', 'branch', 'created_by').get(pk=cheque.pk)
    return Response(cheques.cheque_row(cheque))
