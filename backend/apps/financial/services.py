import datetime
import uuid
from decimal import Decimal
from django.db import transaction
from django.core.exceptions import ValidationError
from .models import AccountGroup, ChartOfAccount, VoucherType, JournalEntry, LedgerEntry

def get_or_create_account(code, name, group_name, account_type):
    """
    Helper function to get or create a default ChartOfAccount record safely.
    """
    group, _ = AccountGroup.objects.get_or_create(
        name=group_name,
        defaults={'account_type': account_type}
    )
    account, _ = ChartOfAccount.objects.get_or_create(
        code=code,
        defaults={
            'name': name,
            'account_group': group,
            'status': 'Active'
        }
    )
    return account


def get_or_create_voucher_type(code, name):
    """
    Helper to lookup or create a VoucherType model instance.
    """
    vtype, _ = VoucherType.objects.get_or_create(
        code=code.upper().strip(),
        defaults={'name': name.strip()}
    )
    return vtype


def is_cash_or_bank_account(account):
    """
    Returns True if account belongs to Cash or Bank group or represents a Cash/Bank account.
    """
    if not account:
        return False
    grp = str(account.account_group.name if hasattr(account.account_group, 'name') else (account.account_group or '')).lower()
    code = str(account.code or '').lower()
    name = str(account.name or '').lower()
    return ('cash' in grp or 'bank' in grp or 'cash' in name or 'bank' in name or code in ['1001', '1002'])


def post_journal_entry(reference_type, reference_id, lines, date=None, narration="", user=None, voucher_type_code=None):
    """
    Atomically creates a JournalEntry (supporting N debit/credit lines), associated LedgerEntry rows,
    validates sum(debit) == sum(credit), enforces Voucher Type account rules, and updates current_balance.
    """
    if not lines or len(lines) < 2:
        raise ValidationError("A valid journal entry must contain at least 2 debit/credit lines.")

    if date is None:
        date = datetime.date.today()

    vtype_obj = None
    if voucher_type_code:
        vtype_obj = VoucherType.objects.filter(code__iexact=voucher_type_code).first()
        if not vtype_obj:
            vtype_obj = get_or_create_voucher_type(voucher_type_code, f"Voucher {voucher_type_code.upper()}")

    total_debits = Decimal('0.00')
    total_credits = Decimal('0.00')
    parsed_lines = []

    for line in lines:
        raw_account = line.get('account')
        if isinstance(raw_account, ChartOfAccount):
            account = raw_account
        elif isinstance(raw_account, str):
            account = ChartOfAccount.objects.filter(code__iexact=raw_account).first() or \
                      ChartOfAccount.objects.filter(name__iexact=raw_account).first()
            if not account:
                raise ValidationError(f"Chart of Account matching '{raw_account}' was not found.")
        else:
            raise ValidationError("Each line must specify a valid ChartOfAccount instance or account code/name.")

        debit = Decimal(str(line.get('debit') or 0))
        credit = Decimal(str(line.get('credit') or 0))

        total_debits += debit
        total_credits += credit

        parsed_lines.append({
            'account': account,
            'debit': debit,
            'credit': credit
        })

    # Validate double-entry balance constraint across N lines
    if abs(total_debits - total_credits) > Decimal('0.01'):
        raise ValidationError(
            f"Unbalanced Journal Entry: Total debits (₹{total_debits:,.2f}) "
            f"do not equal total credits (₹{total_credits:,.2f})."
        )

    # Enforce Voucher Type Account Restrictions
    vtype_code_upper = (voucher_type_code or (vtype_obj.code if vtype_obj else '') or '').upper()

    if 'RECEIPT' in vtype_code_upper or vtype_code_upper == 'RV':
        debit_cash_bank = any(is_cash_or_bank_account(item['account']) for item in parsed_lines if item['debit'] > 0)
        if not debit_cash_bank:
            raise ValidationError("Receipt Voucher rule violation: The debit line must be a Cash or Bank account.")
    elif 'PAYMENT' in vtype_code_upper or vtype_code_upper == 'PV':
        credit_cash_bank = any(is_cash_or_bank_account(item['account']) for item in parsed_lines if item['credit'] > 0)
        if not credit_cash_bank:
            raise ValidationError("Payment Voucher rule violation: The credit line must be a Cash or Bank account.")
    elif 'CONTRA' in vtype_code_upper or vtype_code_upper == 'CV':
        all_cash_bank = all(is_cash_or_bank_account(item['account']) for item in parsed_lines)
        if not all_cash_bank:
            raise ValidationError("Contra Entry rule violation: Both debit and credit lines must be Cash or Bank accounts only.")

    entry_prefix = vtype_code_upper[:3] if vtype_code_upper else 'JV'
    entry_num = f"{entry_prefix}-{datetime.date.today().strftime('%Y%m%d')}-{uuid.uuid4().hex[:6].upper()}"

    with transaction.atomic():
        journal_entry = JournalEntry.objects.create(
            entry_number=entry_num,
            date=date,
            narration=narration or f"Automated entry for {reference_type} #{reference_id}",
            voucher_type=vtype_obj,
            reference_type=reference_type,
            reference_id=reference_id,
            status='POSTED',
            created_by=user
        )

        for item in parsed_lines:
            account = item['account']
            debit = item['debit']
            credit = item['credit']

            LedgerEntry.objects.create(
                journal_entry=journal_entry,
                account=account,
                debit=debit,
                credit=credit
            )

            # Update account current_balance
            account_type = account.account_group.account_type
            if account_type in ['Asset', 'Expense']:
                account.current_balance = Decimal(str(account.current_balance)) + (debit - credit)
            else:
                account.current_balance = Decimal(str(account.current_balance)) + (credit - debit)
            account.save(update_fields=['current_balance', 'updated_at'])

    return journal_entry


def reverse_journal_entry(journal_entry_id, user=None, reason=""):
    """
    Reverses an existing JournalEntry by creating a new entry with debits/credits swapped,
    updating status to REVERSED, and linking reversed_entry without mutating original lines.
    """
    with transaction.atomic():
        original = JournalEntry.objects.select_for_update().get(id=journal_entry_id)

        if original.status in ['REVERSED', 'CANCELLED']:
            raise ValidationError(f"Journal Entry '{original.entry_number}' is already {original.status}.")

        reversal_num = f"REV-{original.entry_number}"

        reversal_entry = JournalEntry.objects.create(
            entry_number=reversal_num,
            date=datetime.date.today(),
            narration=f"Reversal of {original.entry_number}. Reason: {reason or 'Reversal requested'}",
            voucher_type=original.voucher_type,
            reference_type=original.reference_type,
            reference_id=original.reference_id,
            status='POSTED',
            reversed_entry=original,
            created_by=user
        )

        for orig_line in original.lines.all():
            # Swap debit and credit
            rev_debit = orig_line.credit
            rev_credit = orig_line.debit

            LedgerEntry.objects.create(
                journal_entry=reversal_entry,
                account=orig_line.account,
                debit=rev_debit,
                credit=rev_credit
            )

            # Update account current_balance
            account = orig_line.account
            account_type = account.account_group.account_type
            if account_type in ['Asset', 'Expense']:
                account.current_balance = Decimal(str(account.current_balance)) + (rev_debit - rev_credit)
            else:
                account.current_balance = Decimal(str(account.current_balance)) + (rev_credit - rev_debit)
            account.save(update_fields=['current_balance', 'updated_at'])

        # Update original entry status & link
        original.status = 'REVERSED'
        original.reversed_entry = reversal_entry
        original.save(update_fields=['status', 'reversed_entry'])

    return reversal_entry
