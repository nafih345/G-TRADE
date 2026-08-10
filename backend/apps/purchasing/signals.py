from django.db.models.signals import post_save
from django.dispatch import receiver
from .models import PurchaseOrder


@receiver(post_save, sender=PurchaseOrder)
def purchase_order_post_save_journal_entry(sender, instance, created, **kwargs):
    """
    Automatically posts a financial Journal Entry when a Purchase Order is received.
    - Purchase -> Debit Inventory Assets (1003), Credit Accounts Payable (2001)
    """
    if instance.status != 'RECEIVED':
        return

    net_amt = instance.net_amount or instance.total_amount or 0
    if net_amt <= 0:
        return

    try:
        from apps.financial.services import post_journal_entry, get_or_create_account
    except Exception:
        return

    inv_acc = get_or_create_account('1003', 'Optical Stock Inventory', 'Inventory Assets', 'Asset')
    ap_acc = get_or_create_account('2001', 'Supplier Accounts Payable', 'Accounts Payable', 'Liability')

    lines = [
        {'account': inv_acc, 'debit': net_amt, 'credit': 0},
        {'account': ap_acc, 'debit': 0, 'credit': net_amt}
    ]

    try:
        post_journal_entry(
            reference_type='PURCHASE',
            reference_id=getattr(instance, 'id', None),
            lines=lines,
            date=instance.order_date,
            narration=f"Automated entry for Purchase Order {instance.order_number}"
        )
    except Exception as e:
        print("Notice posting purchase journal entry:", e)
