"""JournalPostingService — the one place journal entries are created, posted and reversed.

Every journal in the system (automated postings from sales / purchasing / inventory, manual
vouchers, opening balances, reversals) goes through create_journal() / reverse_entry(), so the
rules live in exactly one place:

* lines are validated (known, active accounts; non-negative; one side per line) and must
  balance to the paisa;
* a POSTED entry is immutable — corrections are made by a reversal entry, never by editing;
* nothing posts into a CLOSED fiscal period;
* numbering is sequential per prefix and year (JournalSequence, row-locked);
* the whole entry (header + lines + balance cache) is written in one database transaction;
* duplicates are refused twice over: an idempotency key for manual vouchers, and a partial
  unique index allowing only one live entry per source document event.
"""
import datetime
import hashlib
import logging
from decimal import Decimal, ROUND_HALF_UP

from django.core.exceptions import ValidationError
from django.db import IntegrityError, transaction
from django.db.models import F
from django.utils import timezone

from .models import (
    AccountGroup, ChartOfAccount, VoucherType, JournalEntry, LedgerEntry, FiscalPeriod,
    JournalSequence, FinancialAuditLog, DEBIT_NORMAL_TYPES,
)

logger = logging.getLogger(__name__)

CENT = Decimal('0.01')


class AccountingError(ValidationError):
    """Base for every refusal the engine raises (all are ValidationErrors, so DRF views and
    existing callers that catch ValidationError keep working)."""
    kind = 'VALIDATION'


class MappingError(AccountingError):
    kind = 'MAPPING'


class PeriodClosedError(AccountingError):
    kind = 'PERIOD'


class UnbalancedEntryError(AccountingError):
    kind = 'VALIDATION'


def money(value):
    try:
        return Decimal(str(value if value not in (None, '') else 0)).quantize(CENT, rounding=ROUND_HALF_UP)
    except Exception:
        raise AccountingError(f"'{value}' is not a valid amount.")


def error_text(exc):
    if isinstance(exc, ValidationError):
        return '; '.join(str(m) for m in exc.messages)
    return str(exc)


# ---------------------------------------------------------------------------
# Small helpers kept for existing callers
# ---------------------------------------------------------------------------

def get_or_create_account(code, name, group_name, account_type):
    """Get or create a ChartOfAccount by code (used by the legacy import script)."""
    group, _ = AccountGroup.objects.get_or_create(name=group_name, defaults={'account_type': account_type})
    account, _ = ChartOfAccount.objects.get_or_create(
        code=code, defaults={'name': name, 'account_group': group, 'status': 'Active'},
    )
    return account


def get_or_create_voucher_type(code, name):
    vtype, _ = VoucherType.objects.get_or_create(code=code.upper().strip(), defaults={'name': name.strip()})
    return vtype


VOUCHER_TYPE_NAMES = {
    'RV': 'Receipt Voucher', 'PV': 'Payment Voucher', 'CV': 'Contra Entry', 'JV': 'Journal Voucher',
    'SV': 'Sales Voucher', 'PU': 'Purchase Voucher', 'IA': 'Inventory Adjustment', 'OB': 'Opening Balance',
}


def is_cash_or_bank_account(account):
    if not account:
        return False
    if account.account_subtype in ('CASH', 'BANK'):
        return True
    grp = (account.account_group.name if account.account_group_id else '').lower()
    name = (account.name or '').lower()
    return 'cash' in grp or 'bank' in grp or 'cash' in name or 'bank' in name


def audit(action, object_type, object_id='', summary='', before=None, after=None, user=None):
    actor = user if (user is not None and getattr(user, 'is_authenticated', False)) else None
    FinancialAuditLog.objects.create(
        action=action, object_type=object_type, object_id=str(object_id or ''), summary=summary[:255],
        before=before, after=after, actor=actor, actor_name=getattr(actor, 'username', '') if actor else 'system',
    )


def _actor(user):
    return user if (user is not None and getattr(user, 'is_authenticated', False)) else None


# ---------------------------------------------------------------------------
# Periods and numbering
# ---------------------------------------------------------------------------

def closed_period_for(date):
    return FiscalPeriod.objects.filter(status='CLOSED', start_date__lte=date, end_date__gte=date).first()


def check_period_open(date):
    period = closed_period_for(date)
    if period:
        raise PeriodClosedError(
            f"{date:%d %b %Y} falls in the closed fiscal period '{period.name}'. "
            f"Re-open the period or post in an open one."
        )


def next_entry_number(prefix, date):
    """PREFIX-YYYY-00001, sequential per prefix and calendar year of the entry date. (A posting
    that loses a race to the unique live-entry index burns its number, so gaps are possible.)"""
    prefix = (prefix or 'JV').upper()[:10]
    year = date.year
    with transaction.atomic():
        try:
            with transaction.atomic():
                JournalSequence.objects.get_or_create(prefix=prefix, year=year)
        except IntegrityError:
            pass  # created concurrently — the locked read below sees it
        seq = JournalSequence.objects.select_for_update().get(prefix=prefix, year=year)
        seq.last_number += 1
        seq.save(update_fields=['last_number'])
        number = f"{prefix}-{year}-{seq.last_number:05d}"
    # Legacy rows used other formats, but guard anyway: never hand out a taken number.
    while JournalEntry.all_objects.filter(entry_number=number).exists():
        return next_entry_number(prefix, date)
    return number


# ---------------------------------------------------------------------------
# Line validation
# ---------------------------------------------------------------------------

def resolve_account(raw, allow_inactive=False):
    """ChartOfAccount from an instance, id, code or exact name. Must be active (reversals pass
    allow_inactive so an account deactivated later can still have its postings unwound)."""
    account = None
    if isinstance(raw, ChartOfAccount):
        account = raw
    elif raw not in (None, ''):
        text = str(raw).strip()
        qs = ChartOfAccount.objects.select_related('account_group')
        try:
            account = qs.filter(pk=text).first()
        except (ValidationError, ValueError):
            account = None
        account = account or qs.filter(code__iexact=text).first() or qs.filter(name__iexact=text).first()
    if not account:
        raise AccountingError(f"Account '{raw}' was not found in the Chart of Accounts.")
    if account.is_deleted:
        raise AccountingError(f"Account {account.code} - {account.name} has been deleted.")
    if account.status != 'Active' and not allow_inactive:
        raise AccountingError(f"Account {account.code} - {account.name} is inactive and cannot be posted to.")
    return account


def normalize_lines(lines, allow_inactive=False):
    """Validate raw lines -> [{'account', 'debit', 'credit', 'memo'}] with Decimal amounts.
    Zero lines are dropped; the result must balance exactly."""
    parsed = []
    for line in lines or []:
        debit, credit = money(line.get('debit')), money(line.get('credit'))
        if debit < 0 or credit < 0:
            raise AccountingError('Debit and credit amounts cannot be negative.')
        if debit > 0 and credit > 0:
            raise AccountingError('A journal line cannot carry both a debit and a credit.')
        if debit == 0 and credit == 0:
            continue
        parsed.append({
            'account': resolve_account(line.get('account'), allow_inactive=allow_inactive),
            'debit': debit, 'credit': credit, 'memo': str(line.get('memo') or '')[:255],
        })
    if len(parsed) < 2:
        raise AccountingError('A journal entry needs at least two non-zero lines.')
    total_dr = sum((l['debit'] for l in parsed), Decimal('0'))
    total_cr = sum((l['credit'] for l in parsed), Decimal('0'))
    if total_dr != total_cr:
        raise UnbalancedEntryError(
            f"Unbalanced journal: debits ₹{total_dr:,.2f} do not equal credits ₹{total_cr:,.2f}."
        )
    if total_dr <= 0:
        raise AccountingError('A journal entry must move a positive amount.')
    return parsed


def lines_fingerprint(lines):
    """Hash of the net effect per account — two line sets with the same fingerprint post
    the same thing, whatever their order, memos or split into lines."""
    net = {}
    for l in lines:
        acc = l['account'] if isinstance(l, dict) else l.account
        dr = l['debit'] if isinstance(l, dict) else l.debit
        cr = l['credit'] if isinstance(l, dict) else l.credit
        net[str(acc.pk)] = net.get(str(acc.pk), Decimal('0')) + money(dr) - money(cr)
    text = '|'.join(f"{k}:{v}" for k, v in sorted(net.items()) if v != 0)
    return hashlib.sha256(text.encode()).hexdigest()


def _check_voucher_rules(code, parsed):
    code = (code or '').upper()
    if code == 'RV' and not any(is_cash_or_bank_account(l['account']) for l in parsed if l['debit'] > 0):
        raise AccountingError('Receipt Voucher: the debit line must be a Cash or Bank account.')
    if code == 'PV' and not any(is_cash_or_bank_account(l['account']) for l in parsed if l['credit'] > 0):
        raise AccountingError('Payment Voucher: the credit line must be a Cash or Bank account.')
    if code == 'CV' and not all(is_cash_or_bank_account(l['account']) for l in parsed):
        raise AccountingError('Contra Entry: every line must be a Cash or Bank account.')


def _apply_balance_cache(parsed, sign=1):
    for l in parsed:
        acc = l['account']
        delta = (l['debit'] - l['credit']) if acc.account_type in DEBIT_NORMAL_TYPES else (l['credit'] - l['debit'])
        ChartOfAccount.objects.filter(pk=acc.pk).update(current_balance=F('current_balance') + delta * sign)


# ---------------------------------------------------------------------------
# Create / post / reverse
# ---------------------------------------------------------------------------

def create_journal(*, lines, date=None, narration='', status='POSTED', voucher_type_code=None,
                   source_module='', source_event='', reference_id=None, source_number='',
                   reference_type=None, branch=None, user=None, idempotency_key=None,
                   metadata=None, is_reversal=False, reversed_entry=None, prefix=None, allow_inactive=False):
    if status not in ('DRAFT', 'PENDING_APPROVAL', 'POSTED'):
        raise AccountingError(f"Cannot create a journal in status {status}.")
    date = date or timezone.localdate()
    if isinstance(date, str):
        date = datetime.date.fromisoformat(date[:10])

    if idempotency_key:
        existing = JournalEntry.all_objects.filter(idempotency_key=idempotency_key).first()
        if existing:
            return existing

    parsed = normalize_lines(lines, allow_inactive=allow_inactive)
    code = (voucher_type_code or '').upper() or None
    # Receipt/Payment/Contra account rules govern vouchers keyed in by hand; automated
    # postings take their accounts from the validated role mappings instead.
    if code and source_module in ('', 'financial') and not is_reversal:
        _check_voucher_rules(code, parsed)
    if status == 'POSTED':
        check_period_open(date)

    vtype = get_or_create_voucher_type(code, VOUCHER_TYPE_NAMES.get(code, f'Voucher {code}')) if code else None
    actor = _actor(user)
    total = sum((l['debit'] for l in parsed), Decimal('0'))

    with transaction.atomic():
        entry = JournalEntry.objects.create(
            entry_number=next_entry_number(prefix or code or 'JV', date),
            date=date,
            narration=narration or f"{source_module}.{source_event} {source_number}".strip(),
            voucher_type=vtype,
            reference_type=reference_type or (f"{source_module}.{source_event}".upper() if source_module else None),
            reference_id=reference_id,
            source_module=source_module or '', source_event=source_event or '', source_number=source_number or '',
            status=status, is_reversal=is_reversal, reversed_entry=reversed_entry, branch=branch,
            idempotency_key=idempotency_key or None, total_amount=total, metadata=metadata or {},
            posted_at=timezone.now() if status == 'POSTED' else None,
            posted_by=actor if status == 'POSTED' else None,
            created_by=actor,
        )
        LedgerEntry.objects.bulk_create([
            LedgerEntry(journal_entry=entry, account=l['account'], debit=l['debit'], credit=l['credit'], memo=l['memo'])
            for l in parsed
        ])
        if status == 'POSTED':
            _apply_balance_cache(parsed)
    return entry


def _parsed_from_entry(entry):
    return [{'account': l.account, 'debit': l.debit, 'credit': l.credit, 'memo': l.memo}
            for l in entry.lines.select_related('account__account_group')]


def post_draft(entry, user=None):
    with transaction.atomic():
        entry = JournalEntry.objects.select_for_update().get(pk=entry.pk)
        if entry.status not in ('DRAFT', 'PENDING_APPROVAL'):
            raise AccountingError(f"Journal {entry.entry_number} is {entry.status}; only drafts can be posted.")
        parsed = normalize_lines([{'account': l['account'], 'debit': l['debit'], 'credit': l['credit'], 'memo': l['memo']}
                                  for l in _parsed_from_entry(entry)])
        if entry.voucher_type_id:
            _check_voucher_rules(entry.voucher_type.code, parsed)
        check_period_open(entry.date)
        entry.status = 'POSTED'
        entry.posted_at = timezone.now()
        entry.posted_by = _actor(user)
        entry.save(update_fields=['status', 'posted_at', 'posted_by', 'updated_at'])
        _apply_balance_cache(parsed)
    audit('JOURNAL_POSTED', 'journal', entry.pk, f"Posted draft {entry.entry_number}", user=user)
    return entry


def reverse_entry(entry, user=None, reason='', date=None):
    """Book the mirror image of a posted entry and mark the original REVERSED.

    The reversal is dated on the original's date when that period is still open (so a
    correction leaves the original period's figures right), otherwise today."""
    with transaction.atomic():
        original = JournalEntry.objects.select_for_update().get(pk=getattr(entry, 'pk', entry))
        if original.status != 'POSTED' or original.is_reversal:
            raise AccountingError(f"Journal {original.entry_number} is {original.status}"
                                  f"{' (a reversal)' if original.is_reversal else ''} and cannot be reversed.")
        if date is None:
            date = original.date if not closed_period_for(original.date) else timezone.localdate()
        swapped = [{'account': l['account'], 'debit': l['credit'], 'credit': l['debit'],
                    'memo': f"Reversal: {l['memo']}"[:255]} for l in _parsed_from_entry(original)]
        reversal = create_journal(
            lines=swapped, date=date,
            narration=f"Reversal of {original.entry_number}. Reason: {reason or 'Reversal requested'}",
            voucher_type_code=original.voucher_type.code if original.voucher_type_id else None,
            source_module=original.source_module, source_event=original.source_event,
            reference_id=original.reference_id, source_number=original.source_number,
            reference_type=original.reference_type, branch=original.branch, user=user,
            is_reversal=True, reversed_entry=original, prefix='REV', allow_inactive=True,
        )
        original.status = 'REVERSED'
        original.reversed_entry = reversal
        original.save(update_fields=['status', 'reversed_entry', 'updated_at'])
    return reversal


# Backwards-compatible wrappers (old signal handlers / scripts called these).

def post_journal_entry(reference_type, reference_id, lines, date=None, narration="", user=None, voucher_type_code=None):
    return create_journal(lines=lines, date=date, narration=narration, voucher_type_code=voucher_type_code,
                          reference_type=reference_type, reference_id=reference_id, user=user)


def reverse_journal_entry(journal_entry_id, user=None, reason=""):
    return reverse_entry(journal_entry_id, user=user, reason=reason)


# ---------------------------------------------------------------------------
# Source-document sync (used by the integration engine)
# ---------------------------------------------------------------------------

def live_entry(source_module, source_event, reference_id, lock=False):
    qs = JournalEntry.objects.filter(source_module=source_module, source_event=source_event,
                                     reference_id=reference_id, status='POSTED', is_reversal=False)
    if lock:
        qs = qs.select_for_update()
    return qs.order_by('-created_at').first()


def sync_source_entry(*, source_module, source_event, reference_id, plan, user=None):
    """Make the books show exactly `plan` for this source document event.

    plan is None  -> the document should not be on the books: reverse any live entry.
    same effect   -> nothing to do (a repeated save / retried request).
    changed       -> reverse the stale entry, post the new one.
    Returns (outcome, entry)."""
    with transaction.atomic():
        existing = live_entry(source_module, source_event, reference_id, lock=True)
        if plan is None:
            if existing:
                reverse_entry(existing, user=user, reason='Source document is no longer a posted transaction')
                return 'reversed', None
            return 'none', None

        parsed = normalize_lines(plan['lines'])
        if existing:
            same = (lines_fingerprint(_parsed_from_entry(existing)) == lines_fingerprint(parsed)
                    and existing.date == plan['date'])
            if same:
                return 'unchanged', existing
            reverse_entry(existing, user=user, reason=f"Superseded by revised {source_module}.{source_event}")

        try:
            with transaction.atomic():
                entry = create_journal(
                    lines=parsed, date=plan['date'], narration=plan.get('narration', ''),
                    voucher_type_code=plan.get('voucher_type_code'),
                    source_module=source_module, source_event=source_event, reference_id=reference_id,
                    source_number=plan.get('source_number', ''), reference_type=plan.get('reference_type'),
                    branch=plan.get('branch'), user=user, metadata=plan.get('metadata') or {},
                )
        except IntegrityError:
            # Another request booked this document between our read and write; the unique
            # live-entry index refused the duplicate. Its entry stands.
            return 'unchanged', live_entry(source_module, source_event, reference_id)
        return ('reposted' if existing else 'posted'), entry


# ---------------------------------------------------------------------------
# Opening balances
# ---------------------------------------------------------------------------

def post_opening_balances(user=None, as_of=None, account_ids=None):
    """Post each account's typed opening_balance as an OPENING journal against the
    OPENING_EQUITY role account. Already-posted openings are left alone (re-running only
    picks up accounts that are new or whose opening changed — those are re-booked)."""
    from .mapping import resolve_role
    equity = resolve_role('OPENING_EQUITY', date=as_of)
    qs = ChartOfAccount.objects.select_related('account_group').exclude(pk=equity.pk).filter(status='Active')
    if account_ids:
        qs = qs.filter(pk__in=account_ids)
    results = []
    for acc in qs:
        amount = money(acc.opening_balance)
        date = acc.opening_balance_date or as_of or timezone.localdate()
        plan = None
        if amount != 0:
            debit_side = (acc.normal_balance == 'DEBIT') == (amount > 0)
            amt = abs(amount)
            plan = {
                'date': date, 'narration': f"Opening balance — {acc.code} {acc.name}", 'voucher_type_code': 'OB',
                'source_number': acc.code, 'reference_type': 'OPENING_BALANCE',
                'lines': [
                    {'account': acc, 'debit': amt if debit_side else 0, 'credit': 0 if debit_side else amt},
                    {'account': equity, 'debit': 0 if debit_side else amt, 'credit': amt if debit_side else 0},
                ],
            }
        if plan is None and not live_entry('financial', 'opening_balance', acc.pk):
            continue
        outcome, entry = sync_source_entry(source_module='financial', source_event='opening_balance',
                                           reference_id=acc.pk, plan=plan, user=user)
        results.append({'account': acc.code, 'outcome': outcome, 'entry': entry.entry_number if entry else None})
    audit('OPENING_BALANCES_POSTED', 'account', '', f"Opening balances processed for {len(results)} account(s)",
          after=results, user=user)
    return results


def recompute_balance_cache():
    """Rebuild every ChartOfAccount.current_balance from the ledger (repair tool)."""
    from django.db.models import Sum
    totals = {
        row['account']: (row['dr'] or 0, row['cr'] or 0)
        for row in LedgerEntry.objects.filter(journal_entry__status__in=JournalEntry.LEDGER_STATUSES,
                                              journal_entry__is_deleted=False)
        .values('account').annotate(dr=Sum('debit'), cr=Sum('credit'))
    }
    changed = 0
    for acc in ChartOfAccount.objects.select_related('account_group'):
        dr, cr = totals.get(acc.pk, (0, 0))
        bal = (dr - cr) if acc.account_type in DEBIT_NORMAL_TYPES else (cr - dr)
        if money(acc.current_balance) != money(bal):
            ChartOfAccount.objects.filter(pk=acc.pk).update(current_balance=bal)
            changed += 1
    return changed
