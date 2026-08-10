from django.db.models.signals import post_save
from django.dispatch import receiver
from .models import Invoice


@receiver(post_save, sender=Invoice)
def invoice_post_save_journal_entry(sender, instance, created, **kwargs):
    """
    Automatically posts a financial Journal Entry when a Sales Invoice is created or completed.
    - Retail Sale -> Debit Cash/AR, Credit Retail Sales Income
    - Wholesale Invoice -> Debit Accounts Receivable, Credit Wholesale Sales Income
    """
    if not created and instance.status not in ['PAID', 'PARTIAL', 'UNPAID']:
        return

    net_amt = instance.net_amount or instance.total_amount or 0
    if net_amt <= 0:
        return

    try:
        from apps.financial.services import post_journal_entry, get_or_create_account
    except Exception:
        return

    is_wholesale = getattr(instance, 'is_wholesale', False) or ('WHOLESALE' in str(instance.invoice_number).upper())

    if is_wholesale:
        ar_acc = get_or_create_account('1004', 'Customer Accounts Receivable', 'Accounts Receivable', 'Asset')
        income_acc = get_or_create_account('4002', 'Wholesale B2B Revenue', 'Wholesale Sales', 'Income')
        lines = [
            {'account': ar_acc, 'debit': net_amt, 'credit': 0},
            {'account': income_acc, 'debit': 0, 'credit': net_amt}
        ]
        ref_type = 'WHOLESALE'
    else:
        pay_method = (instance.payment_method or '').lower()
        if 'cash' in pay_method or instance.status == 'PAID':
            debit_acc = get_or_create_account('1001', 'Cash in Hand', 'Cash Accounts', 'Asset')
        else:
            debit_acc = get_or_create_account('1004', 'Customer Accounts Receivable', 'Accounts Receivable', 'Asset')

        income_acc = get_or_create_account('4001', 'Retail Frame & Lens Sales', 'Retail Sales', 'Income')
        lines = [
            {'account': debit_acc, 'debit': net_amt, 'credit': 0},
            {'account': income_acc, 'debit': 0, 'credit': net_amt}
        ]
        ref_type = 'SALE'

    try:
        post_journal_entry(
            reference_type=ref_type,
            reference_id=getattr(instance, 'id', None),
            lines=lines,
            date=instance.invoice_date,
            narration=f"Automated entry for Sales Invoice {instance.invoice_number}"
        )
    except Exception as e:
        print("Notice posting sales journal entry:", e)
