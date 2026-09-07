from decimal import Decimal

from django.db.models.signals import post_save, post_delete
from django.dispatch import receiver

from .models import Invoice, Payment


# ---------------------------------------------------------------------------
# Chart-of-account definitions (code, name, group, type) used by the automated
# sales postings. apps.financial.services.get_or_create_account creates each one
# on first use, so no migration/seed data is required.
# ---------------------------------------------------------------------------
AR_ACCOUNT = ('1004', 'Customer Accounts Receivable', 'Accounts Receivable', 'Asset')
CASH_ACCOUNT = ('1001', 'Cash in Hand', 'Cash Accounts', 'Asset')
BANK_ACCOUNT = ('1002', 'Bank Account', 'Bank Accounts', 'Asset')
# NB: 2001 is already the shared "Supplier Accounts Payable" code used by
# apps.purchasing.signals — output GST gets its own 2020 so the two never collide
# on ChartOfAccount.code (which is unique).
GST_OUTPUT_ACCOUNT = ('2020', 'GST Output Tax Payable', 'GST Payable', 'Liability')
DISCOUNT_ACCOUNT = ('5050', 'Discount Allowed', 'Selling', 'Expense')
RETAIL_INCOME_ACCOUNT = ('4001', 'Retail Frame & Lens Sales', 'Retail Sales', 'Income')
WHOLESALE_INCOME_ACCOUNT = ('4002', 'Wholesale B2B Revenue', 'Wholesale Sales', 'Income')

_VOUCHER_TYPE_NAMES = {'SV': 'Sales Voucher', 'RV': 'Receipt Voucher'}


def _decimal(value):
    try:
        return Decimal(str(value if value is not None else 0))
    except Exception:
        return Decimal('0')


def _financial_api():
    """The financial services module, or None if that app/its tables aren't ready
    (e.g. during the very first migrate, or if the app is uninstalled)."""
    try:
        from apps.financial import services as financial_services
        return financial_services
    except Exception:
        return None


def _latest_live_entry(reference_type, reference_id):
    """The current POSTED, non-reversal journal entry for this source document, if any.

    Reversal entries (created by reverse_journal_entry) are also POSTED and carry the
    same reference, so they're filtered out by their ``REV-`` number prefix — after a
    reversal this returns None, which is what lets _sync_entry re-post cleanly.
    """
    try:
        from apps.financial.models import JournalEntry
    except Exception:
        return None
    return (
        JournalEntry.objects
        .filter(reference_type=reference_type, reference_id=reference_id, status='POSTED')
        .exclude(entry_number__startswith='REV-')
        .order_by('-created_at')
        .first()
    )


def _entry_debit_total(entry):
    if not entry:
        return Decimal('0')
    return sum((line.debit for line in entry.lines.all()), Decimal('0'))


def _reverse_live_entry(reference_type, reference_id, reason):
    api = _financial_api()
    existing = _latest_live_entry(reference_type, reference_id)
    if api and existing:
        try:
            api.reverse_journal_entry(existing.id, reason=reason)
        except Exception as e:  # pragma: no cover - defensive
            print("Notice reversing sales journal entry:", e)


def _sync_entry(reference_type, reference_id, lines, date, narration, voucher_type_code):
    """Idempotently (re)post the journal entry for one source document.

    - nothing on the books yet            -> post it
    - an entry with the same debit total  -> leave it alone (signal fired on a no-op save)
    - an entry with a different total     -> reverse the stale one, post the corrected one
    """
    api = _financial_api()
    if not api:
        return

    # Give the voucher type a readable name the first time it's used, rather than
    # letting post_journal_entry fall back to "Voucher SV" / "Voucher RV".
    try:
        api.get_or_create_voucher_type(voucher_type_code, _VOUCHER_TYPE_NAMES.get(voucher_type_code, voucher_type_code))
    except Exception:
        pass

    new_total = sum((_decimal(l.get('debit')) for l in lines), Decimal('0'))
    if new_total <= 0:
        _reverse_live_entry(reference_type, reference_id, f"{reference_type} no longer has a billable amount")
        return

    existing = _latest_live_entry(reference_type, reference_id)
    if existing:
        if abs(_entry_debit_total(existing) - new_total) <= Decimal('0.01'):
            return
        try:
            api.reverse_journal_entry(existing.id, reason=f"Superseded by revised {reference_type}")
        except Exception as e:  # pragma: no cover - defensive
            print("Notice reversing superseded sales journal entry:", e)

    try:
        api.post_journal_entry(
            reference_type=reference_type,
            reference_id=reference_id,
            lines=lines,
            date=date,
            narration=narration,
            voucher_type_code=voucher_type_code,
        )
    except Exception as e:  # pragma: no cover - defensive
        print("Notice posting sales journal entry:", e)


@receiver(post_save, sender=Invoice)
def invoice_post_save_journal_entry(sender, instance, created, **kwargs):
    """Keep the accounting books in step with a Sales Invoice:

        Dr  Customer Accounts Receivable      net_amount
        Dr  Discount Allowed                  discount_amount
            Cr  Retail / Wholesale Sales      (balancing taxable revenue)
            Cr  GST Output Tax Payable        tax_amount

    Customer money is posted separately by payment_post_save_journal_entry
    (Dr Cash/Bank / Cr Accounts Receivable), so the AR balance always reflects
    what the customer still owes.
    """
    api = _financial_api()
    if not api:
        return

    is_wholesale = bool(getattr(instance, 'is_wholesale', False)) or \
        ('WHOLESALE' in str(instance.invoice_number).upper())
    ref_type = 'WHOLESALE' if is_wholesale else 'SALE'

    # Only a real, live tax INVOICE belongs on the books. Quotations and unconverted
    # lab Orders share this table (Invoice.document_type); a DRAFT or CANCELLED invoice
    # isn't a sale either. If a previously-billed invoice moved into any of those
    # states, unwind whatever it had posted.
    document_type = getattr(instance, 'document_type', 'INVOICE')
    if document_type != 'INVOICE' or instance.status in ('DRAFT', 'CANCELLED'):
        _reverse_live_entry(ref_type, instance.id, f"Invoice {instance.invoice_number} is not a live sale")
        return

    receivable = _decimal(instance.net_amount) or _decimal(instance.total_amount)
    if receivable <= 0:
        _reverse_live_entry(ref_type, instance.id, f"Invoice {instance.invoice_number} has no billable amount")
        return

    tax = _decimal(instance.tax_amount)
    discount = _decimal(instance.discount_amount)
    revenue = receivable + discount - tax

    # Guard against a nonsensical split (tax/discount larger than the sale itself) —
    # fall back to booking the whole amount as revenue.
    if revenue < 0:
        tax = Decimal('0')
        discount = Decimal('0')
        revenue = receivable

    ar_acc = api.get_or_create_account(*AR_ACCOUNT)
    income_acc = api.get_or_create_account(
        *(WHOLESALE_INCOME_ACCOUNT if is_wholesale else RETAIL_INCOME_ACCOUNT)
    )

    lines = [{'account': ar_acc, 'debit': receivable, 'credit': 0}]
    if discount > 0:
        lines.append({'account': api.get_or_create_account(*DISCOUNT_ACCOUNT), 'debit': discount, 'credit': 0})
    lines.append({'account': income_acc, 'debit': 0, 'credit': revenue})
    if tax > 0:
        lines.append({'account': api.get_or_create_account(*GST_OUTPUT_ACCOUNT), 'debit': 0, 'credit': tax})

    _sync_entry(
        reference_type=ref_type,
        reference_id=instance.id,
        lines=lines,
        date=instance.invoice_date,
        narration=f"Sales Invoice {instance.invoice_number}",
        voucher_type_code='SV',
    )


@receiver(post_save, sender=Payment)
def payment_post_save_journal_entry(sender, instance, created, **kwargs):
    """Post a customer receipt against Accounts Receivable:

        Dr  Cash in Hand / Bank Account          amount
            Cr  Customer Accounts Receivable     amount

    This settles the AR raised when the Invoice was booked, so a fully-paid
    invoice nets to zero and a partly-paid one leaves the balance outstanding.
    """
    api = _financial_api()
    if not api:
        return

    amount = _decimal(instance.amount)
    status = (instance.status or '').upper()
    if amount <= 0 or status in ('CANCELLED', 'VOID', 'VOIDED', 'FAILED', 'REVERSED'):
        _reverse_live_entry('PAYMENT_RECEIPT', instance.id, f"Receipt {instance.receipt_no or instance.id} voided")
        return

    method = (instance.method or '').lower()
    is_cash = ('cash' in method) or (not method)
    debit_acc = api.get_or_create_account(*(CASH_ACCOUNT if is_cash else BANK_ACCOUNT))
    ar_acc = api.get_or_create_account(*AR_ACCOUNT)

    lines = [
        {'account': debit_acc, 'debit': amount, 'credit': 0},
        {'account': ar_acc, 'debit': 0, 'credit': amount},
    ]

    _sync_entry(
        reference_type='PAYMENT_RECEIPT',
        reference_id=instance.id,
        lines=lines,
        date=instance.payment_date,
        narration=(f"Receipt {instance.receipt_no or ''} from {instance.customer_name or 'customer'}").strip(),
        voucher_type_code='RV',
    )


@receiver(post_delete, sender=Invoice)
def invoice_post_delete_reverse(sender, instance, **kwargs):
    for ref_type in ('SALE', 'WHOLESALE'):
        _reverse_live_entry(ref_type, instance.id, f"Invoice {instance.invoice_number} deleted")


@receiver(post_delete, sender=Payment)
def payment_post_delete_reverse(sender, instance, **kwargs):
    _reverse_live_entry('PAYMENT_RECEIPT', instance.id, f"Receipt {instance.receipt_no or instance.id} deleted")
