"""Signal wiring for the accounting integration — the only receivers that create journals.

Each receiver just queues the document with integration.schedule(); the posting itself runs
after the operational transaction commits (see integration.py). Item rows queue their parent
because nested serializers save the header first and the lines afterwards.
"""
from django.db.models.signals import post_save, post_delete

from . import integration

# (model label, source keys booked from it, parent attribute for item models[, filter])
# A filter(instance) returning False skips queueing that save (hot models with rare postings).
WATCHED = [
    ('sales.Invoice', ('sales.invoice',), None),
    ('sales.InvoiceItem', ('sales.invoice',), 'invoice_id'),
    ('sales.Payment', ('sales.payment',), None),
    ('sales.EyeExamination', ('sales.eye_test_fee',), None),
    ('sales.WholesaleInvoice', ('sales.wholesale_invoice',), None),
    ('sales.WholesalePaymentCollection', ('sales.wholesale_collection',), None),
    ('sales.WholesaleReturn', ('sales.wholesale_return',), None),
    ('sales.SalesReturn', ('sales.sales_return',), None),
    ('purchasing.PurchaseReturn', ('purchasing.purchase_return',), None),
    ('purchasing.PurchaseInvoice', ('purchasing.purchase_invoice', 'purchasing.purchase_payment'), None),
    ('purchasing.PurchaseInvoiceItem', ('purchasing.purchase_invoice', 'purchasing.purchase_payment'), 'purchase_invoice_id'),
    ('purchasing.PurchaseOrder', ('purchasing.purchase_order',), None),
    ('inventory.StockAdjustment', ('inventory.stock_adjustment',), None),
    # A PO's own receive writes StockLedger rows after the PO is saved; re-check the PO then.
    ('inventory.StockLedger', ('purchasing.purchase_order',), 'reference_id'),
    # Only products carrying opening stock; deleting one keeps its opening entry (the stock
    # was on the books, and its sales have since credited Inventory) — so saves only.
    # Opening Stock page loads are booked per batch (inventory.opening_stock), not per product.
    ('products.Product', ('products.opening_stock',), None,
     lambda p: (p.opening_stock or 0) > 0 and p.stock_source != 'OPENING_STOCK'),
    ('inventory.OpeningStockBatch', ('inventory.opening_stock',), None),
]

SAVE_ONLY = {'products.Product', 'inventory.OpeningStockBatch'}


def _make_receiver(source_keys, parent_attr, wanted=None):
    def receiver(sender, instance, raw=False, **kwargs):
        if raw:  # fixture loading
            return
        if wanted is not None and not wanted(instance):
            return
        pk = getattr(instance, parent_attr) if parent_attr else instance.pk
        for key in source_keys:
            integration.schedule(key, pk)
    return receiver


_receivers = []


def connect():
    from django.apps import apps
    for label, keys, parent_attr, *wanted in WATCHED:
        model = apps.get_model(label)
        receiver = _make_receiver(keys, parent_attr, wanted[0] if wanted else None)
        _receivers.append(receiver)  # signals hold weak references
        post_save.connect(receiver, sender=model, dispatch_uid=f"accounting:{label}:save")
        if label not in SAVE_ONLY:
            post_delete.connect(receiver, sender=model, dispatch_uid=f"accounting:{label}:delete")
    # Each new supplier / wholesale dealer gets its own AP / AR sub-ledger (party_ledgers.py).
    from .party_ledgers import PARTIES, on_party_saved
    for kind, cfg in PARTIES.items():
        post_save.connect(on_party_saved, sender=apps.get_model(cfg[0]), dispatch_uid=f"accounting:party-ledger:{kind}")
