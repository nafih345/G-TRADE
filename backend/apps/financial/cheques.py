"""Cheque details on Receipt / Payment Vouchers, and the Cheque Register.

Every Cheque pay-mode line of a voucher carries its cheque's details; saving the voucher saves
one Cheque row per line, in the same transaction as the voucher itself:

  Normal mode        -> /journals/ lines: the cash/bank line carries `cheque` (RV debit, PV credit).
  Bill to Bill, RV   -> settlement pay lines carry `cheque`; linked by the BR- settlement number.
  Bill to Bill, PV   -> settlement pay lines carry `cheque`; linked to the PV journal.

A cheque split over several parties in one bill-to-bill save (the screen spreads pay lines over
the parties in order) arrives as several pieces with the same `ref`; they become ONE cheque for
the full amount listing every voucher number.

The amount always comes from the line that posted, never from the client's cheque payload, so the
register can't disagree with the books. Status changes are tracking only (see models.Cheque).
"""
import datetime
from decimal import Decimal

from django.db.models import Count, Q, Sum
from django.db.models.functions import Coalesce
from django.utils import timezone
from rest_framework import serializers

from .models import Cheque
from .services import AccountingError, audit, money

ZERO = Decimal('0.00')
CHEQUE_METHOD = 'Cheque'
DIRECTION_OF = {'RV': 'RECEIVED', 'PV': 'ISSUED'}

# status -> statuses it may move to. CLEARED -> DEPOSITED undoes a mistaken clear; a bounced
# cheque can be presented again. CANCELLED is final (reversed voucher or a void cheque).
TRANSITIONS = {
    'PENDING': {'DEPOSITED', 'CLEARED', 'BOUNCED', 'CANCELLED'},
    'DEPOSITED': {'PENDING', 'CLEARED', 'BOUNCED', 'CANCELLED'},
    'BOUNCED': {'PENDING', 'DEPOSITED', 'CANCELLED'},
    'CLEARED': {'DEPOSITED'},
    'CANCELLED': set(),
}
MAX_EXPORT = 5000


class ChequeInputSerializer(serializers.Serializer):
    cheque_number = serializers.CharField(max_length=40)
    cheque_date = serializers.DateField()
    bank_name = serializers.CharField(required=False, allow_blank=True, default='', max_length=150)
    deposited_date = serializers.DateField(required=False, allow_null=True, default=None)
    party_name = serializers.CharField(required=False, allow_blank=True, default='', max_length=200)
    remarks = serializers.CharField(required=False, allow_blank=True, default='', max_length=500)
    # The screen's pay-line id: pieces of one cheque spread over several parties share it.
    ref = serializers.CharField(required=False, allow_blank=True, default='', max_length=64)

    def validate_cheque_number(self, value):
        value = value.strip()
        if not value:
            raise serializers.ValidationError('Enter the cheque number.')
        return value

    def validate(self, attrs):
        attrs['bank_name'] = attrs['bank_name'].strip()
        if attrs.get('deposited_date') and attrs['deposited_date'] < attrs['cheque_date']:
            raise serializers.ValidationError('A cheque cannot be deposited before its cheque date.')
        return attrs


class ChequeBook:
    """Collects the cheques of one save (see the module docstring), then writes them."""

    def __init__(self, voucher_type, user=None, branch=None):
        self.voucher_type = voucher_type
        self.user = user
        self.branch = branch
        self.items = {}

    def add(self, details, amount, *, voucher_number='', journal=None, bank_account=None,
            party_kind='', party_id='', party_name=''):
        key = details.get('ref') or f"#{len(self.items)}"
        item = self.items.get(key)
        if item is not None:
            item['amount'] += money(amount)
            if voucher_number and voucher_number not in item['numbers']:
                item['numbers'].append(voucher_number)
            return
        self.items[key] = {
            'details': details, 'amount': money(amount), 'numbers': [voucher_number] if voucher_number else [],
            'journal': journal, 'bank_account': bank_account, 'party_kind': party_kind,
            'party_id': str(party_id or ''), 'party_name': party_name,
        }

    def save(self):
        if not self.items:
            return []
        direction = DIRECTION_OF[self.voucher_type]
        seen = set()
        rows = []
        for item in self.items.values():
            d = item['details']
            ident = (d['cheque_number'].lower(), d['bank_name'].lower())
            if ident in seen:
                raise AccountingError(f"Cheque {d['cheque_number']} is entered twice in this voucher.")
            seen.add(ident)
            clash = Cheque.objects.filter(direction=direction, cheque_number__iexact=d['cheque_number'],
                                          bank_name__iexact=d['bank_name']).exclude(status='CANCELLED').first()
            if clash:
                raise AccountingError(
                    f"Cheque {d['cheque_number']}{f' ({clash.bank_name})' if clash.bank_name else ''} is already "
                    f"recorded on {clash.voucher_number or 'another voucher'}. Cancel that cheque first if it was a mistake.")
            journal = item['journal']
            rows.append(Cheque(
                direction=direction, voucher_type=self.voucher_type,
                voucher_number=', '.join(item['numbers'])[:255], journal_entry=journal,
                cheque_number=d['cheque_number'], cheque_date=d['cheque_date'], bank_name=d['bank_name'],
                amount=item['amount'], deposited_date=d.get('deposited_date'),
                party_name=(d.get('party_name') or '').strip() or item['party_name'][:200],
                party_kind=item['party_kind'], party_id=item['party_id'],
                bank_account=item['bank_account'], remarks=(d.get('remarks') or '').strip(),
                branch=(journal.branch if journal is not None and journal.branch_id else None) or self.branch,
                created_by=self.user if getattr(self.user, 'is_authenticated', False) else None,
            ))
        Cheque.objects.bulk_create(rows)
        for c in rows:
            audit('CHEQUE_RECORDED', 'cheque', c.pk,
                  f"{c.get_direction_display()} cheque {c.cheque_number} ₹{c.amount} on {c.voucher_number}", user=self.user)
        return rows


def on_voucher_reversed(entry):
    """A reversed voucher took its cheque's money back off the books: cancel the cheque."""
    Cheque.objects.filter(journal_entry=entry).exclude(status='CANCELLED').update(
        status='CANCELLED', status_note=f"Voucher {entry.entry_number} reversed"[:255],
        status_changed_at=timezone.now(), updated_at=timezone.now())


# ---------------------------------------------------------------------------
# Register
# ---------------------------------------------------------------------------

def days_left(cheque, today=None):
    """Days until the due date (negative = overdue), only while the cheque is still open."""
    if cheque.status not in Cheque.OPEN_STATUSES:
        return None
    return (cheque.due_date - (today or timezone.localdate())).days


def cheque_row(c, today=None):
    return {
        'id': str(c.pk), 'direction': c.direction, 'direction_label': c.get_direction_display(),
        'voucher_type': c.voucher_type, 'voucher_number': c.voucher_number,
        'journal_entry': str(c.journal_entry_id) if c.journal_entry_id else None,
        'cheque_number': c.cheque_number, 'cheque_date': c.cheque_date, 'bank_name': c.bank_name,
        'amount': str(c.amount), 'deposited_date': c.deposited_date, 'cleared_date': c.cleared_date,
        'due_date': c.due_date, 'days_left': days_left(c, today),
        'party_name': c.party_name, 'party_kind': c.party_kind,
        'bank_account': str(c.bank_account_id) if c.bank_account_id else None,
        'bank_account_name': f"{c.bank_account.code} - {c.bank_account.name}" if c.bank_account_id else '',
        'remarks': c.remarks, 'status': c.status, 'status_label': c.get_status_display(),
        'status_note': c.status_note, 'branch': str(c.branch_id) if c.branch_id else None,
        'branch_name': c.branch.name if c.branch_id else '',
        'created_at': c.created_at, 'created_by': c.created_by.username if c.created_by_id else '',
        'allowed_status': sorted(TRANSITIONS[c.status]),
    }


DATE_FIELDS = {'cheque': 'cheque_date', 'deposited': 'deposited_date', 'cleared': 'cleared_date', 'entered': 'created_at__date'}
DUE_FILTERS = ('overdue', 'today', 'week')


def _filtered(*, direction='', statuses=(), date_field='cheque', date_from=None, date_to=None, search='',
              due='', bank_account='', branch_ids=None, today=None):
    today = today or timezone.localdate()
    qs = Cheque.objects.select_related('bank_account', 'branch', 'created_by') \
        .annotate(due=Coalesce('deposited_date', 'cheque_date'))
    if branch_ids is not None:
        qs = qs.filter(branch_id__in=branch_ids)
    if bank_account:
        qs = qs.filter(bank_account_id=bank_account)
    field = DATE_FIELDS.get(date_field or 'cheque')
    if field is None:
        raise AccountingError(f"date_field must be one of {', '.join(DATE_FIELDS)}.")
    if date_from:
        qs = qs.filter(**{f'{field}__gte': date_from})
    if date_to:
        qs = qs.filter(**{f'{field}__lte': date_to})
    if search:
        s = search.strip()
        qs = qs.filter(Q(cheque_number__icontains=s) | Q(party_name__icontains=s) | Q(bank_name__icontains=s)
                       | Q(voucher_number__icontains=s) | Q(remarks__icontains=s))
    # The summary is taken here: it follows every filter except type / status / due, so the
    # summary cards (which apply those) keep showing every figure.
    base = qs
    if direction:
        qs = qs.filter(direction=direction)
    if statuses:
        qs = qs.filter(status__in=statuses)
    if due:
        if due not in DUE_FILTERS:
            raise AccountingError(f"due must be one of {', '.join(DUE_FILTERS)}.")
        qs = qs.filter(status__in=Cheque.OPEN_STATUSES)
        qs = {'overdue': qs.filter(due__lt=today), 'today': qs.filter(due=today),
              'week': qs.filter(due__gte=today, due__lte=today + datetime.timedelta(days=7))}[due]
    return base, qs


def _summary(base, today):
    def agg(qs):
        r = qs.aggregate(n=Count('id'), amt=Sum('amount'))
        return {'count': r['n'] or 0, 'amount': str(money(r['amt'] or ZERO))}
    open_qs = base.filter(status__in=Cheque.OPEN_STATUSES)
    return {
        'by_status': {s: agg(base.filter(status=s)) for s, _ in Cheque.STATUS_CHOICES},
        'received_open': agg(open_qs.filter(direction='RECEIVED')),
        'issued_open': agg(open_qs.filter(direction='ISSUED')),
        'overdue': agg(open_qs.filter(due__lt=today)),
        'due_today': agg(open_qs.filter(due=today)),
        'due_week': agg(open_qs.filter(due__gte=today, due__lte=today + datetime.timedelta(days=7))),
        'total': agg(base),
    }


def cheque_register(*, page=1, page_size=100, export=False, sort='due', **filters):
    today = timezone.localdate()
    base, qs = _filtered(today=today, **filters)
    order = {'due': ('due', 'created_at'), 'cheque_date': ('-cheque_date', '-created_at'),
             'entered': ('-created_at',), 'amount': ('-amount', '-created_at')}.get(sort)
    if order is None:
        raise AccountingError('sort must be due, cheque_date, entered or amount.')
    qs = qs.order_by(*order)
    count = qs.count()
    matched = qs.aggregate(amt=Sum('amount'))['amt'] or ZERO
    if export:
        rows, page, num_pages = list(qs[:MAX_EXPORT]), 1, 1
    else:
        page_size = max(1, min(int(page_size or 100), 500))
        num_pages = max(1, -(-count // page_size))
        page = max(1, min(int(page or 1), num_pages))
        rows = list(qs[(page - 1) * page_size: page * page_size])
    return {
        'today': today, 'count': count, 'page': page, 'num_pages': num_pages,
        'matched_amount': str(money(matched)), 'truncated': export and count > MAX_EXPORT,
        'rows': [cheque_row(c, today) for c in rows],
        'summary': _summary(base, today),
    }


# ---------------------------------------------------------------------------
# Status / detail updates
# ---------------------------------------------------------------------------

class ChequeUpdateSerializer(serializers.Serializer):
    status = serializers.ChoiceField(choices=[s for s, _ in Cheque.STATUS_CHOICES], required=False)
    deposited_date = serializers.DateField(required=False, allow_null=True)
    cleared_date = serializers.DateField(required=False, allow_null=True)
    cheque_number = serializers.CharField(required=False, max_length=40)
    cheque_date = serializers.DateField(required=False)
    bank_name = serializers.CharField(required=False, allow_blank=True, max_length=150)
    party_name = serializers.CharField(required=False, allow_blank=True, max_length=200)
    remarks = serializers.CharField(required=False, allow_blank=True, max_length=500)
    status_note = serializers.CharField(required=False, allow_blank=True, max_length=255)


DETAIL_FIELDS = ('cheque_number', 'cheque_date', 'bank_name', 'party_name')


def update_cheque(cheque, data, user=None):
    """Apply a status move and / or edits. The amount is what the voucher posted: never edited."""
    before = cheque_row(cheque)
    today = timezone.localdate()
    if cheque.status == 'CANCELLED':
        raise AccountingError('A cancelled cheque cannot be changed.')
    new = data.get('status') or cheque.status
    if new != cheque.status and new not in TRANSITIONS[cheque.status]:
        raise AccountingError(f"A {cheque.get_status_display().lower()} cheque cannot be marked "
                              f"{dict(Cheque.STATUS_CHOICES)[new].lower()}.")
    if any(f in data for f in DETAIL_FIELDS) and cheque.status not in Cheque.OPEN_STATUSES + ('BOUNCED',):
        raise AccountingError('The cheque details can only be corrected while it is pending, deposited or bounced.')

    for f in DETAIL_FIELDS + ('remarks', 'status_note'):
        if f in data:
            setattr(cheque, f, data[f].strip() if isinstance(data[f], str) else data[f])
    if 'cheque_number' in data and not cheque.cheque_number:
        raise AccountingError('Enter the cheque number.')
    if 'deposited_date' in data:
        cheque.deposited_date = data['deposited_date']
    if 'cleared_date' in data:
        cheque.cleared_date = data['cleared_date']

    if new == 'DEPOSITED':
        cheque.deposited_date = cheque.deposited_date or today
        cheque.cleared_date = None
    elif new == 'CLEARED':
        cheque.cleared_date = cheque.cleared_date or today
        cheque.deposited_date = cheque.deposited_date or cheque.cleared_date
    elif new == 'PENDING':
        cheque.cleared_date = None
    if cheque.deposited_date and cheque.deposited_date < cheque.cheque_date:
        raise AccountingError('A cheque cannot be deposited before its cheque date.')
    if cheque.cleared_date and cheque.deposited_date and cheque.cleared_date < cheque.deposited_date:
        raise AccountingError('The cleared date cannot be before the deposited date.')

    if new != cheque.status:
        cheque.status = new
        cheque.status_changed_at = timezone.now()
    if getattr(user, 'is_authenticated', False):
        cheque.updated_by = user
    cheque.save()
    audit('CHEQUE_UPDATED', 'cheque', cheque.pk,
          f"Cheque {cheque.cheque_number} {before['status']} → {cheque.status}" if before['status'] != cheque.status
          else f"Cheque {cheque.cheque_number} details updated",
          before={k: str(before[k]) for k in ('status', 'deposited_date', 'cleared_date', 'cheque_number', 'bank_name')},
          after={k: str(getattr(cheque, k)) for k in ('status', 'deposited_date', 'cleared_date', 'cheque_number', 'bank_name')},
          user=user)
    return cheque
