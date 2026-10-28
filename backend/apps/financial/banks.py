"""Bank accounts: the Bank Master (Settings) and bank selection on payments.

A bank is an active Chart of Accounts row with account_subtype BANK, so payments and journals
point at a real ledger. Its bank-specific details (bank name, branch, A/c no, IFSC, address...)
live in BankDetail. Every payment screen (Purchase Entry, New Sale, POS, Wholesale, receipts)
lets the user pick one for a BANK or UPI payment; the posting rules then debit/credit that
exact ledger instead of the generic BANK / PAYMENT_UPI role mapping.
"""
import re

from django.db import IntegrityError, transaction
from django.db.models import Max
from rest_framework import serializers
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import AllowAny
from rest_framework.response import Response

from .mapping import MappingError, resolve_role, save_mapping
from .models import AccountGroup, BankDetail, ChartOfAccount
from .permissions import FINANCE_ADMIN_ROLES, user_role

BANK_GROUP_NAME = 'Bank Accounts'
BANK_CODE_PREFIX = '1002'
CARD_ROLE = 'PAYMENT_CARD'
# The default bank is the BANK role's mapping: the ledger a bank payment posts to when no bank
# was picked, and the one every payment screen pre-selects when the user chooses Bank.
DEFAULT_ROLE = 'BANK'
UPI_ROLE = 'PAYMENT_UPI'
IFSC_RE = re.compile(r'^[A-Z]{4}0[A-Z0-9]{6}$')

DETAIL_FIELDS = ('bank_name', 'branch_name', 'address', 'iban_number', 'vat_reg_number', 'account_number',
                 'account_holder', 'ifsc_code', 'country_code', 'country')


def bank_accounts(include_inactive=False):
    qs = ChartOfAccount.objects.filter(account_subtype='BANK').select_related('bank_detail')
    if not include_inactive:
        qs = qs.filter(status='Active')
    return qs


def validate_bank_account(account):
    """Serializer-level check shared by every model that carries a bank_account FK."""
    if account is None:
        return account
    if account.account_subtype != 'BANK':
        raise serializers.ValidationError(f"'{account.name}' is not a bank account.")
    if account.status != 'Active' or account.is_deleted:
        raise serializers.ValidationError(f"Bank account '{account.name}' is inactive.")
    return account


def bank_line_kwargs(role, bank_account):
    """posting_rules._line kwargs: the chosen bank's ledger when one was picked, else the role."""
    if bank_account is not None:
        return {'account': bank_account}
    return {'role': role}


def _detail(acc):
    try:
        return acc.bank_detail
    except BankDetail.DoesNotExist:
        return None


def _role_account_id(role):
    try:
        return resolve_role(role).pk
    except MappingError:
        return None


def _card_account_id():
    return _role_account_id(CARD_ROLE)


def _defaults():
    return {'card': _card_account_id(), 'bank': _role_account_id(DEFAULT_ROLE), 'upi': _role_account_id(UPI_ROLE)}


def _summary(acc, detail):
    """One-line description for the payment pickers: "SBI · A/c 3728… · SBIN0001234"."""
    if detail is None:
        return acc.description or ''
    parts = [detail.bank_name if detail.bank_name and detail.bank_name != acc.name else '',
             f"A/c {detail.account_number}" if detail.account_number else '', detail.ifsc_code]
    return ' · '.join(p for p in parts if p)


def _row(acc, defaults=None):
    detail = _detail(acc)
    defaults = defaults or {}
    row = {
        'id': str(acc.pk), 'code': acc.code, 'name': acc.name, 'account_name': acc.name,
        'status': acc.status, 'is_system': acc.is_system,
        'sl_no': detail.sl_no if detail else 0,
        'description': _summary(acc, detail),
        'is_default_card': defaults.get('card') == acc.pk,
        'is_default_bank': defaults.get('bank') == acc.pk,
        'is_default_upi': defaults.get('upi') == acc.pk,
    }
    for f in DETAIL_FIELDS:
        row[f] = getattr(detail, f) if detail else BankDetail._meta.get_field(f).default
    return row


def _ordered(rows):
    # Sl.No first (banks without one go last, in code order).
    return sorted(rows, key=lambda r: (r['sl_no'] or 10 ** 6, r['code']))


def _next_code():
    n = 1
    while ChartOfAccount.all_objects.filter(code=f'{BANK_CODE_PREFIX}{n:02d}').exists():
        n += 1
    return f'{BANK_CODE_PREFIX}{n:02d}'


def _next_sl_no():
    return (BankDetail.objects.aggregate(m=Max('sl_no'))['m'] or 0) + 1


def _clean(data, instance=None):
    """Validated {account_name, detail fields...} from the request, or raises ValidationError."""
    out = {f: ' '.join(str(data.get(f) or '').split()) if f != 'address' else str(data.get(f) or '').strip()
           for f in DETAIL_FIELDS}
    out['ifsc_code'] = out['ifsc_code'].upper()
    out['iban_number'] = out['iban_number'].upper().replace(' ', '')
    out['account_number'] = out['account_number'].replace(' ', '')
    out['country'] = (out['country'] or 'INDIA').upper()
    # Account Name = the ledger's name. Blank -> the bank name (the usual case).
    name = ' '.join(str(data.get('account_name') or data.get('name') or '').split()) or out['bank_name']
    errors = {}
    if not name:
        errors['account_name'] = 'Account name (or bank name) is required.'
    elif ChartOfAccount.all_objects.filter(name__iexact=name).exclude(pk=getattr(instance, 'pk', None)).exists():
        errors['account_name'] = f"Another account is already named '{name}'."
    if out['ifsc_code'] and not IFSC_RE.match(out['ifsc_code']):
        errors['ifsc_code'] = 'IFSC must be 11 characters, e.g. SBIN0001234.'
    if out['account_number'] and not re.fullmatch(r'[0-9A-Za-z-]{4,34}', out['account_number']):
        errors['account_number'] = 'Account number should be 4–34 letters/digits.'
    if out['account_number']:
        clash = BankDetail.objects.filter(account_number__iexact=out['account_number'], ifsc_code=out['ifsc_code'])
        if instance is not None:
            clash = clash.exclude(account=instance)
        if clash.exists():
            errors['account_number'] = 'This account number is already in the bank master.'
    try:
        sl_no = int(data.get('sl_no') or 0)
    except (TypeError, ValueError):
        sl_no = 0
        errors['sl_no'] = 'Sl.No must be a whole number.'
    if errors:
        raise serializers.ValidationError(errors)
    out['account_name'] = name
    out['sl_no'] = max(0, sl_no)
    return out


def _bank_group():
    group = AccountGroup.objects.filter(name=BANK_GROUP_NAME).first()
    return group or AccountGroup.objects.create(name=BANK_GROUP_NAME, account_type='Asset')


def _apply_defaults(acc, data, user):
    # Ticking a default moves the role to this bank; unticking does nothing (some bank must
    # stay the default, so the user ticks another one instead).
    for flag, role in (('is_default_card', CARD_ROLE), ('is_default_bank', DEFAULT_ROLE)):
        if data.get(flag) and _role_account_id(role) != acc.pk:
            save_mapping(role=role, account=acc, notes='Set from Bank Master', user=user)


def create_bank(data, user=None):
    clean = _clean(data)
    with transaction.atomic():
        acc = ChartOfAccount.objects.create(
            code=_next_code(), name=clean.pop('account_name'), account_group=_bank_group(),
            account_subtype='BANK', status='Active',
        )
        clean['sl_no'] = clean['sl_no'] or _next_sl_no()
        BankDetail.objects.create(account=acc, **clean)
        _apply_defaults(acc, data, user)
    return acc


def update_bank(acc, data, user=None):
    clean = _clean(data, instance=acc)
    with transaction.atomic():
        acc.name = clean.pop('account_name')
        if 'status' in data and not acc.is_system:
            acc.status = 'Active' if str(data['status']).lower() == 'active' else 'Inactive'
        acc.save()
        detail = _detail(acc) or BankDetail(account=acc)
        for k, v in clean.items():
            setattr(detail, k, v)
        detail.sl_no = detail.sl_no or _next_sl_no()
        detail.save()
        _apply_defaults(acc, data, user)
    return acc


def _forbidden(request):
    if user_role(request.user) not in FINANCE_ADMIN_ROLES:
        return Response({'detail': 'Only Super Admin, Administrator or Accountant can change the bank master.'},
                        status=403)
    return None


def _error(exc):
    if isinstance(exc, serializers.ValidationError):
        return Response(exc.detail, status=400)
    if isinstance(exc, MappingError):
        return Response({'detail': str(exc)}, status=400)
    return Response({'detail': 'Could not save the bank (code or name clash). Try again.'}, status=400)


@api_view(['GET', 'POST'])
@permission_classes([AllowAny])
def bank_accounts_view(request):
    """Active banks for the payment pickers; POST = quick-add from a payment screen."""
    if request.method == 'GET':
        defaults = _defaults()
        return Response(_ordered([_row(a, defaults) for a in bank_accounts()]))
    denied = _forbidden(request)
    if denied:
        return denied
    data = dict(request.data)
    data = {k: (v[0] if isinstance(v, list) else v) for k, v in data.items()}
    data.setdefault('bank_name', data.get('name'))
    data['ifsc_code'] = data.get('ifsc_code') or data.get('ifsc')
    try:
        acc = create_bank(data, request.user)
    except (serializers.ValidationError, MappingError, IntegrityError) as exc:
        return _error(exc)
    return Response(_row(acc, _defaults()), status=201)


@api_view(['GET', 'POST'])
@permission_classes([AllowAny])
def bank_master_list_view(request):
    """Settings > Bank Master: every bank (inactive too) / create one."""
    if request.method == 'GET':
        defaults = _defaults()
        return Response(_ordered([_row(a, defaults) for a in bank_accounts(include_inactive=True)]))
    denied = _forbidden(request)
    if denied:
        return denied
    try:
        acc = create_bank(request.data, request.user)
    except (serializers.ValidationError, MappingError, IntegrityError) as exc:
        return _error(exc)
    return Response(_row(acc, _defaults()), status=201)


@api_view(['GET', 'PUT', 'PATCH', 'DELETE'])
@permission_classes([AllowAny])
def bank_master_detail_view(request, pk):
    acc = bank_accounts(include_inactive=True).filter(pk=pk).first()
    if acc is None:
        return Response({'detail': 'Bank not found.'}, status=404)
    if request.method == 'GET':
        return Response(_row(acc, _defaults()))
    denied = _forbidden(request)
    if denied:
        return denied
    if request.method == 'DELETE':
        # Never hard-deleted: old payments and journals keep pointing at the ledger. It just
        # stops being offered on payment screens.
        if acc.is_system:
            return Response({'detail': 'The default bank account is a system account and cannot be deactivated.'},
                            status=400)
        if _card_account_id() == acc.pk:
            return Response({'detail': 'This bank takes card payments. Make another bank the card default first.'},
                            status=400)
        if _role_account_id(DEFAULT_ROLE) == acc.pk:
            return Response({'detail': 'This is the default bank account. Make another bank the default first.'},
                            status=400)
        acc.status = 'Inactive'
        acc.save(update_fields=['status', 'updated_at'])
        return Response(_row(acc, _defaults()))
    data = request.data
    if request.method == 'PATCH':
        data = {**_row(acc, _defaults()), **request.data}
    try:
        update_bank(acc, data, request.user)
    except (serializers.ValidationError, MappingError, IntegrityError) as exc:
        return _error(exc)
    acc.refresh_from_db()
    return Response(_row(acc, _defaults()))
