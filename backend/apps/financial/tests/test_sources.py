"""Each operational source books the right journal exactly once, follows the document's
lifecycle (edit / cancel / delete / convert) and leaves the ledger balanced."""
import datetime

from django.test import TestCase
from rest_framework.test import APITestCase

from apps.financial import integration
from apps.financial.models import AccountingPolicy, JournalEntry
from apps.inventory.models import StockAdjustment, StockLedger
from apps.purchasing.models import PurchaseInvoice, PurchaseOrder, Supplier
from apps.sales.models import (
    Dealer, Invoice, InvoiceItem, Payment, WholesaleInvoice, WholesalePaymentCollection, WholesaleReturn,
)

from .helpers import D, TODAY, balance, ledger_is_balanced, lines_of, live, make_product, make_warehouse


class Booked(TestCase):
    """Saves inside `with self.booked():` are posted when the block exits, the way
    on_commit runs them after a real request."""

    def booked(self):
        return self.captureOnCommitCallbacks(execute=True)


class RetailInvoiceTests(Booked):
    def make_invoice(self, **kw):
        fields = dict(invoice_number='INV-1', invoice_date=TODAY, customer_name='Asha', total_amount=D('1180'),
                      discount_amount=D('100'), tax_amount=D('162'), net_amount=D('1062'))
        fields.update(kw)
        return Invoice.objects.create(**fields)

    def test_invoice_with_tax_discount_service_and_cogs(self):
        frame = make_product('Frame', cost='300')
        with self.booked():
            inv = self.make_invoice()
            InvoiceItem.objects.create(invoice=inv, product=frame, item_type='PRODUCT', quantity=2,
                                       unit_price=D('450'), subtotal=D('900'))
            InvoiceItem.objects.create(invoice=inv, item_type='SERVICE', description='Fitting', quantity=1,
                                       unit_price=D('100'), subtotal=D('100'))
            inv.save()  # repeated saves inside one transaction book once
        entries = live('sales', 'invoice', inv.pk)
        self.assertEqual(entries.count(), 1)
        # revenue = 1062 + 100 - 162 = 1000, split 900:100 product:service
        self.assertEqual(lines_of(entries.first()), {
            '1004': D('1062'), '5050': D('100'), '4001': D('-900'), '4003': D('-100'), '2020': D('-162'),
            '5001': D('600'), '1003': D('-600'),
        })
        self.assertEqual(JournalEntry.objects.filter(reference_id=inv.pk).count(), 1)

        with self.booked():
            inv.save()
        self.assertEqual(JournalEntry.objects.filter(reference_id=inv.pk).count(), 1)
        self.assertTrue(ledger_is_balanced())

    def test_edit_reposts_but_keeps_original_cost_basis(self):
        frame = make_product('Frame', cost='300')
        with self.booked():
            inv = self.make_invoice(discount_amount=0, tax_amount=0, net_amount=D('900'), total_amount=D('900'))
            InvoiceItem.objects.create(invoice=inv, product=frame, quantity=2, unit_price=D('450'), subtotal=D('900'))
        frame.cost_price = D('350')
        frame.save()
        with self.booked():
            inv.net_amount = inv.total_amount = D('950')
            inv.save()
        entry = live('sales', 'invoice', inv.pk).get()
        self.assertEqual(lines_of(entry)['5001'], D('600'))  # still 2 × 300
        self.assertEqual(lines_of(entry)['1004'], D('950'))
        self.assertEqual(JournalEntry.objects.filter(reference_id=inv.pk, is_reversal=True).count(), 1)

    def test_orders_and_quotations_are_not_revenue_and_advances_move_on_conversion(self):
        with self.booked():
            order = self.make_invoice(document_type='ORDER', discount_amount=0, tax_amount=0,
                                      net_amount=D('1000'), total_amount=D('1000'))
            pay = Payment.objects.create(invoice=order, amount=D('400'), method='Cash', payment_date=TODAY)
        self.assertFalse(live('sales', 'invoice', order.pk).exists())
        self.assertEqual(balance('2030'), D('400'))  # customer advance
        self.assertEqual(balance('1001'), D('400'))

        with self.booked():
            order.document_type = 'INVOICE'
            order.save()
        self.assertTrue(live('sales', 'invoice', order.pk).exists())
        self.assertEqual(balance('2030'), 0)
        self.assertEqual(balance('1004'), D('600'))  # 1000 billed − 400 advance applied
        self.assertEqual(lines_of(live('sales', 'payment', pay.pk).get()), {'1001': D('400'), '1004': D('-400')})

    def test_partial_payments_split_modes_refund_and_void(self):
        with self.booked():
            inv = self.make_invoice(discount_amount=0, tax_amount=0, net_amount=D('1000'), total_amount=D('1000'))
            Payment.objects.create(invoice=inv, amount=D('300'), method='Cash', payment_date=TODAY)
            upi = Payment.objects.create(invoice=inv, amount=D('200'), method='UPI', payment_date=TODAY)
            Payment.objects.create(invoice=inv, amount=D('100'), method='Card', payment_date=TODAY)
        self.assertEqual(balance('1004'), D('400'))
        self.assertEqual(balance('1001'), D('300'))
        self.assertEqual(balance('1002'), D('300'))  # UPI + Card both default to the bank account

        with self.booked():
            Payment.objects.create(invoice=inv, amount=D('-50'), method='Cash', payment_date=TODAY)  # refund
        self.assertEqual(balance('1004'), D('450'))
        self.assertEqual(balance('1001'), D('250'))

        with self.booked():
            upi.delete()  # soft delete = voided receipt
        self.assertFalse(live('sales', 'payment', upi.pk).exists())
        self.assertEqual(balance('1004'), D('650'))
        self.assertTrue(ledger_is_balanced())

    def test_cancel_and_delete_reverse_the_invoice(self):
        with self.booked():
            inv = self.make_invoice()
        with self.booked():
            inv.status = 'CANCELLED'
            inv.save()
        self.assertFalse(live('sales', 'invoice', inv.pk).exists())
        self.assertEqual(balance('1004'), 0)
        self.assertEqual(balance('2020'), 0)

        with self.booked():
            inv.status = 'UNPAID'
            inv.save()
        with self.booked():
            inv.delete()
        self.assertFalse(live('sales', 'invoice', inv.pk).exists())
        self.assertEqual(balance('4001'), 0)

    def test_wholesale_rows_in_invoice_table_use_wholesale_accounts(self):
        with self.booked():
            inv = self.make_invoice(invoice_number='WHOLESALE-77', discount_amount=0, tax_amount=0,
                                    net_amount=D('500'), total_amount=D('500'))
        self.assertEqual(lines_of(live('sales', 'invoice', inv.pk).get()), {'1005': D('500'), '4002': D('-500')})


class WholesaleTests(Booked):
    def setUp(self):
        self.dealer = Dealer.objects.create(dealer_code='DL-1', business_name='Metro Optical', phone='1')

    def test_invoice_collection_and_return_with_tax_share(self):
        with self.booked():
            inv = WholesaleInvoice.objects.create(
                invoice_number='W-1', dealer=self.dealer, invoice_date=TODAY, due_date=TODAY, grand_total=D('1180'),
                details={'summary': {'subtotal': 1000, 'totalGst': 180, 'grandTotal': 1180}})
            WholesalePaymentCollection.objects.create(receipt_number='R-1', dealer=self.dealer, invoice_number='W-1',
                                                      payment_date=TODAY, payment_method='Cash', amount_paid=D('500'))
            WholesalePaymentCollection.objects.create(receipt_number='R-2', dealer=self.dealer, payment_date=TODAY,
                                                      payment_method='Credit Sale', amount_paid=D('680'))
            ret = WholesaleReturn.objects.create(return_number='WR-1', invoice_number='W-1', dealer=self.dealer,
                                                 return_date=TODAY, reason='Damaged', return_amount=D('118'))
        self.assertEqual(lines_of(live('sales', 'wholesale_invoice', inv.pk).get()),
                         {'1005': D('1180'), '4002': D('-1000'), '2020': D('-180')})
        self.assertEqual(lines_of(live('sales', 'wholesale_return', ret.pk).get()),
                         {'4090': D('100'), '2020': D('18'), '1005': D('-118')})
        self.assertEqual(balance('1005'), D('562'))  # 1180 − 500 cash − 118 credit note; "Credit Sale" moves no money
        self.assertEqual(balance('2020'), D('162'))
        self.assertTrue(ledger_is_balanced())

    def test_replacement_and_cancelled_invoice_post_nothing(self):
        with self.booked():
            inv = WholesaleInvoice.objects.create(invoice_number='W-2', dealer=self.dealer, invoice_date=TODAY,
                                                  due_date=TODAY, grand_total=D('500'), status='Cancelled')
            ret = WholesaleReturn.objects.create(return_number='WR-2', invoice_number='W-2', dealer=self.dealer,
                                                 return_date=TODAY, reason='Swap', return_amount=D('100'),
                                                 action_taken='Replacement')
        self.assertFalse(JournalEntry.objects.filter(reference_id__in=[inv.pk, ret.pk]).exists())


class PurchasingTests(Booked):
    def setUp(self):
        from apps.purchasing.supplier_utils import get_or_create_supplier_ledger_account
        self.supplier = Supplier.objects.create(name='Essilor', supplier_code='SUP-1')
        self.supplier.ledger_account = get_or_create_supplier_ledger_account(self.supplier)
        self.supplier.save()
        self.ap_code = self.supplier.ledger_account.code

    def purchase(self, **kw):
        fields = dict(invoice_number='PE-1', supplier=self.supplier, purchase_date=TODAY, purchase_type='CREDIT',
                      payment_method='CREDIT', cgst_amount=D('45'), sgst_amount=D('45'), tax_amount=D('90'),
                      round_off=D('0.40'), grand_total=D('1090.40'))
        fields.update(kw)
        return PurchaseInvoice.objects.create(**fields)

    def test_credit_purchase_books_inventory_gst_round_off_and_supplier(self):
        with self.booked():
            pi = self.purchase()
        self.assertEqual(lines_of(live('purchasing', 'purchase_invoice', pi.pk).get()),
                         {'1003': D('1000'), '1020': D('90'), '5070': D('0.40'), self.ap_code: D('-1090.40')})
        self.assertFalse(live('purchasing', 'purchase_payment', pi.pk).exists())

    def test_cash_purchase_is_settled_and_cancel_reverses_both(self):
        with self.booked():
            pi = self.purchase(purchase_type='CASH', payment_method='BANK', paid_amount=0)
        self.assertEqual(balance(self.ap_code), 0)
        self.assertEqual(balance('1002'), D('-1090.40'))
        with self.booked():
            pi.status = 'CANCELLED'
            pi.save()
        self.assertEqual(balance('1003'), 0)
        self.assertEqual(balance('1002'), 0)
        self.assertTrue(ledger_is_balanced())

    def test_po_books_only_when_it_moved_stock_itself(self):
        with self.booked():
            converted = PurchaseOrder.objects.create(order_number='PO-1', supplier=self.supplier, order_date=TODAY,
                                                     status='RECEIVED', net_amount=D('500'), total_amount=D('500'))
        self.assertFalse(live('purchasing', 'purchase_order', converted.pk).exists())

        wh = make_warehouse()
        with self.booked():
            po = PurchaseOrder.objects.create(order_number='PO-2', supplier=self.supplier, order_date=TODAY,
                                              status='RECEIVED', net_amount=D('500'), total_amount=D('500'))
            StockLedger.objects.create(product=make_product('Lens'), warehouse=wh, quantity=5,
                                       transaction_type='IN', reference_id=po.pk)
        self.assertEqual(lines_of(live('purchasing', 'purchase_order', po.pk).get()), {'1003': D('500'), self.ap_code: D('-500')})


class InventoryTests(Booked):
    def setUp(self):
        self.wh = make_warehouse()
        self.product = make_product('Case', cost='50')

    def adjust(self, kind, qty, reason):
        return StockAdjustment.objects.create(product=self.product, warehouse=self.wh, quantity=qty,
                                              adjustment_type=kind, reason=reason)

    def test_gain_loss_and_wholesale_cogs(self):
        with self.booked():
            gain = self.adjust('ADD', 4, 'Found in stock count')
            loss = self.adjust('SUB', 1, 'Damaged')
            sale = self.adjust('SUB', 2, 'Wholesale POS sale W-9')
        self.assertEqual(lines_of(live('inventory', 'stock_adjustment', gain.pk).get()), {'1003': D('200'), '4080': D('-200')})
        self.assertEqual(lines_of(live('inventory', 'stock_adjustment', loss.pk).get()), {'5060': D('50'), '1003': D('-50')})
        self.assertEqual(lines_of(live('inventory', 'stock_adjustment', sale.pk).get()), {'5001': D('100'), '1003': D('-100')})
        self.assertEqual(balance('1003'), D('50'))

    def test_zero_cost_stock_has_no_value_to_book(self):
        self.product.cost_price = 0
        self.product.save()
        with self.booked():
            adj = self.adjust('ADD', 3, 'Opening count')
        self.assertFalse(JournalEntry.objects.filter(reference_id=adj.pk).exists())


class HistoricalCutoffTests(Booked):
    def test_documents_before_go_live_wait_for_controlled_backfill(self):
        supplier = Supplier.objects.create(name='Old Supplier', supplier_code='SUP-OLD')
        old_day = TODAY - datetime.timedelta(days=30)
        with self.booked():
            pi = PurchaseInvoice.objects.create(invoice_number='PE-OLD', supplier=supplier, purchase_date=old_day,
                                                purchase_type='CREDIT', payment_method='CREDIT', grand_total=D('700'))
        self.assertFalse(JournalEntry.objects.filter(reference_id=pi.pk).exists())

        report = integration.reconcile_source('purchasing.purchase_invoice')
        self.assertEqual(report['historical_unposted'], 1)

        dry = integration.backfill('purchasing.purchase_invoice', dry_run=True)
        self.assertEqual([r['outcome'] for r in dry], ['would_post'])
        self.assertFalse(JournalEntry.objects.filter(reference_id=pi.pk).exists())

        integration.backfill('purchasing.purchase_invoice', dry_run=False)
        self.assertTrue(live('purchasing', 'purchase_invoice', pi.pk).exists())
        self.assertEqual(integration.backfill('purchasing.purchase_invoice', dry_run=True), [])

    def test_disabled_source_posts_nothing(self):
        policy = AccountingPolicy.get()
        policy.source_enabled = {'sales.invoice': False}
        policy.save()
        with self.booked():
            inv = Invoice.objects.create(invoice_number='INV-OFF', invoice_date=TODAY, customer_name='A',
                                         total_amount=100, net_amount=100)
        self.assertFalse(JournalEntry.objects.filter(reference_id=inv.pk).exists())


class ApiFlowTests(APITestCase):
    """Through the real sales endpoint: a bill with a split advance books once, even when
    the same PATCH is sent twice."""

    def test_sale_with_split_payment_through_the_api(self):
        body = {'document_type': 'INVOICE', 'invoice_date': TODAY.isoformat(), 'status': 'PARTIAL',
                'total_amount': 1000, 'discount_amount': 0, 'net_amount': 1000, 'paid_amount': 0, 'items': [],
                'payment_splits': {'cash': 300, 'upi': 200}, 'customer_name': 'Ravi'}
        with self.captureOnCommitCallbacks(execute=True):
            res = self.client.post('/api/sales/invoices/', body, format='json')
        self.assertEqual(res.status_code, 201, res.content)
        inv_id = res.data['id']
        for _ in range(2):
            with self.captureOnCommitCallbacks(execute=True):
                self.client.patch(f'/api/sales/invoices/{inv_id}/', {'fulfillment_status': 'Delivered'}, format='json')
        self.assertEqual(live('sales', 'invoice', inv_id).count(), 1)
        self.assertEqual(JournalEntry.objects.filter(reference_id=inv_id).count(), 1)
        self.assertEqual(balance('1004'), D('500'))
        self.assertEqual(balance('1001'), D('300'))
        self.assertEqual(balance('1002'), D('200'))
        self.assertTrue(ledger_is_balanced())
