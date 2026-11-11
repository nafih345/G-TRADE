"""Sales Return & Purchase Return (apps/inventory/returns.py): stock, settlement rules, books,
Stock Overview's Return Stock, cancel."""
from unittest import mock

from rest_framework.test import APITestCase

from apps.financial.defaults import ensure_accounting_defaults
from apps.financial.tests.helpers import D, TODAY, account, ledger_is_balanced, lines_of, live, make_warehouse
from apps.products.models import Product
from apps.purchasing.models import PurchaseInvoice, PurchaseInvoiceItem, Supplier
from apps.sales.models import Invoice, InvoiceItem, SalesReturn

SR = '/api/sales/returns/'
PR = '/api/purchase/returns/'


class ReturnsBase(APITestCase):
    def setUp(self):
        make_warehouse()
        ensure_accounting_defaults()
        self.bank = account('1002')
        self.frame = Product.objects.create(name='Frame', sku='FR-1', barcode='111', stock=5,
                                            cost_price=D('300'), retail_price=D('590'))
        self.case = Product.objects.create(name='Case', sku='CS-1', stock=10, cost_price=D('20'))

    def stock(self, p):
        p.refresh_from_db()
        return p.stock

    def post(self, url, body, code=201):
        with self.captureOnCommitCallbacks(execute=True):
            res = self.client.post(url, body, format='json')
        self.assertEqual(res.status_code, code, res.content)
        return res.data

    def invoice(self):
        inv = Invoice.objects.create(invoice_number='INV-9', invoice_date=TODAY, customer_name='Asha',
                                     total_amount=D('1180'), net_amount=D('1180'), tax_amount=D('180'))
        item = InvoiceItem.objects.create(invoice=inv, product=self.frame, quantity=2, unit_price=D('500'),
                                          tax_rate=D('18'), tax_amount=D('180'), subtotal=D('1180'))
        return inv, item


class SalesReturnTests(ReturnsBase):
    def test_cash_return_adds_stock_and_books_refund(self):
        inv, item = self.invoice()
        data = self.post(SR, {'original_document': str(inv.pk), 'items': [
            {'original_item': str(item.pk), 'return_qty': 1, 'return_reason_category': 'DAMAGED'}],
            'settlements': [{'mode': 'CASH', 'amount': '590'}]})
        self.assertEqual(self.stock(self.frame), 6)              # 5 + 1
        self.assertEqual(data['total_amount'], '590.00')         # 1180 / 2, incl. tax
        self.assertEqual(data['tax_amount'], '90.00')
        self.assertEqual(data['original']['number'], 'INV-9')
        self.assertEqual(data['party']['name'], 'Asha')
        entry = live('sales', 'sales_return', data['id']).get()
        self.assertEqual(lines_of(entry), {
            '4090': D('500'), '2020': D('90'), '1001': D('-590'),   # Dr returns + GST, Cr Cash
            '1003': D('300'), '5001': D('-300'),                     # goods back at cost
        })
        self.assertTrue(ledger_is_balanced())

    def test_spec_example_five_plus_five(self):
        self.frame.stock = 5
        self.frame.save()
        data = self.post(SR, {'customer_name': 'Walk in', 'items': [
            {'product': str(self.frame.pk), 'return_qty': 5, 'unit_price': '100', 'return_reason_category': 'DEFECTIVE'}],
            'payment_mode': 'CASH'})
        self.assertEqual(self.stock(self.frame), 10)
        # Stock Overview's red "Return Stock" switch lists just this product, with 5 units came back.
        from apps.inventory.returns import return_stock_by_product
        from apps.inventory.stock_overview import apply_filters
        listed = apply_filters(Product.objects.filter(is_active=True), {'source': 'RETURN'})
        self.assertEqual(list(listed.values_list('pk', flat=True)), [self.frame.pk])
        self.assertEqual(return_stock_by_product([self.frame.pk])[self.frame.pk], {'sales': 5, 'purchase': 0})
        self.assertEqual(data['payment_mode'], 'CASH')
        # A cancelled return drops out of Return Stock.
        with self.captureOnCommitCallbacks(execute=True):
            self.client.post(f"{SR}{data['id']}/cancel/", {'reason': 'Wrong entry'}, format='json')
        self.assertFalse(apply_filters(Product.objects.filter(is_active=True), {'source': 'RETURN'}).exists())
        self.assertEqual(self.stock(self.frame), 5)

    def test_refunds_show_as_returns_in_cash_and_bank_books(self):
        from apps.financial.bankbook import bankbook
        from apps.financial.cashbook import cashbook
        inv, item = self.invoice()
        self.post(SR, {'original_document': str(inv.pk), 'items': [
            {'original_item': str(item.pk), 'return_qty': 2, 'return_reason_category': 'DAMAGED'}],
            'settlements': [{'mode': 'CASH', 'amount': '180'},
                            {'mode': 'GPAY', 'amount': '1000', 'bank_account': str(self.bank.pk)}]})
        cash_rows = cashbook([account('1001').pk], date_from=TODAY, date_to=TODAY)['rows']
        self.assertEqual([r['voucher_kind'] for r in cash_rows], ['SALES_RETURN'])
        bank_rows = bankbook([self.bank.pk], date_from=TODAY, date_to=TODAY)['rows']
        self.assertEqual([(r['voucher_kind'], r['withdrawal']) for r in bank_rows], [('SALES_RETURN', '1000.00')])

    def test_cannot_return_more_than_sold(self):
        inv, item = self.invoice()
        self.post(SR, {'original_document': str(inv.pk), 'items': [
            {'original_item': str(item.pk), 'return_qty': 1, 'return_reason_category': 'DAMAGED'}],
            'settlements': [{'mode': 'CASH', 'amount': '590'}]})
        bad = self.post(SR, {'original_document': str(inv.pk), 'items': [
            {'original_item': str(item.pk), 'return_qty': 2, 'return_reason_category': 'DAMAGED'}],
            'settlements': [{'mode': 'CASH', 'amount': '1180'}]}, code=400)
        self.assertIn('only 1 left to return', str(bad))
        lines = self.client.get(f"{SR}returnable/?document={inv.pk}").data['lines']
        self.assertEqual((lines[0]['returned_qty'], lines[0]['returnable_qty']), (1, 1))

    def test_gpay_needs_bank_and_posts_to_it(self):
        inv, item = self.invoice()
        body = {'original_document': str(inv.pk), 'items': [
            {'original_item': str(item.pk), 'return_qty': 1, 'return_reason_category': 'WRONG_ITEM'}],
            'settlements': [{'mode': 'GPAY', 'amount': '590'}]}
        self.assertIn('select the bank', str(self.post(SR, body, code=400)))
        self.assertEqual(self.stock(self.frame), 5)              # nothing saved
        body['settlements'][0]['bank_account'] = str(self.bank.pk)
        data = self.post(SR, body)
        self.assertEqual(data['bank_account'], str(self.bank.pk))
        self.assertEqual(lines_of(live('sales', 'sales_return', data['id']).get())['1002'], D('-590'))

    def test_split_and_credit_and_settlement_must_match(self):
        inv, item = self.invoice()
        base = {'original_document': str(inv.pk), 'items': [
            {'original_item': str(item.pk), 'return_qty': 2, 'return_reason_category': 'OTHER', 'reason_notes': 'Allergy'}]}
        short = self.post(SR, {**base, 'settlements': [{'mode': 'CASH', 'amount': '100'}]}, code=400)
        self.assertIn('must equal the return value', str(short))
        data = self.post(SR, {**base, 'settlements': [
            {'mode': 'CASH', 'amount': '180'}, {'mode': 'CREDIT', 'amount': '1000'}]})
        self.assertEqual(data['payment_mode'], 'SPLIT')
        lines = lines_of(live('sales', 'sales_return', data['id']).get())
        self.assertEqual((lines['1001'], lines['1004']), (D('-180'), D('-1000')))

    def test_reason_is_mandatory_and_other_needs_note(self):
        inv, item = self.invoice()
        for line, msg in (({'return_reason_category': ''}, 'choose the return reason'),
                          ({'return_reason_category': 'OTHER'}, 'describe the issue')):
            res = self.post(SR, {'original_document': str(inv.pk), 'items': [
                {'original_item': str(item.pk), 'return_qty': 1, **line}],
                'settlements': [{'mode': 'CASH', 'amount': '590'}]}, code=400)
            self.assertIn(msg, str(res))

    def test_cancel_takes_stock_back_out_and_reverses_books(self):
        inv, item = self.invoice()
        data = self.post(SR, {'original_document': str(inv.pk), 'items': [
            {'original_item': str(item.pk), 'return_qty': 1, 'return_reason_category': 'DAMAGED'}],
            'settlements': [{'mode': 'CASH', 'amount': '590'}]})
        with self.captureOnCommitCallbacks(execute=True):
            res = self.client.post(f"{SR}{data['id']}/cancel/", {'reason': 'Entered twice'}, format='json')
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(res.data['status'], 'CANCELLED')
        self.assertEqual(self.stock(self.frame), 5)
        self.assertFalse(live('sales', 'sales_return', data['id']).exists())
        self.assertTrue(ledger_is_balanced())
        # the units are returnable again
        lines = self.client.get(f"{SR}returnable/?document={inv.pk}").data['lines']
        self.assertEqual(lines[0]['returnable_qty'], 2)

    def test_double_submit_returns_the_first(self):
        inv, item = self.invoice()
        body = {'client_token': 'tok-1', 'original_document': str(inv.pk), 'items': [
            {'original_item': str(item.pk), 'return_qty': 1, 'return_reason_category': 'DAMAGED'}],
            'settlements': [{'mode': 'CASH', 'amount': '590'}]}
        first = self.post(SR, body)
        again = self.post(SR, body, code=200)
        self.assertEqual(first['id'], again['id'])
        self.assertEqual(SalesReturn.objects.count(), 1)
        self.assertEqual(self.stock(self.frame), 6)

    def test_report_lists_and_sums(self):
        inv, item = self.invoice()
        self.post(SR, {'original_document': str(inv.pk), 'items': [
            {'original_item': str(item.pk), 'return_qty': 1, 'return_reason_category': 'DAMAGED'}],
            'settlements': [{'mode': 'CASH', 'amount': '590'}]})
        rep = self.client.get(f"{SR}report/?date_from={TODAY}&date_to={TODAY}").data
        self.assertEqual(rep['summary']['count'], 1)
        self.assertEqual(rep['summary']['total_amount'], '590.00')
        self.assertEqual(rep['rows'][0]['items'][0]['return_reason_label'], 'Damaged')
        self.assertEqual(rep['summary']['by_mode'], {'Cash': '590.00'})


class PurchaseReturnTests(ReturnsBase):
    def setUp(self):
        super().setUp()
        self.supplier = Supplier.objects.create(name='Lux Optics')
        self.bill = PurchaseInvoice.objects.create(invoice_number='PINV-1', supplier=self.supplier, purchase_date=TODAY,
                                                   grand_total=D('1180'), purchase_type='CREDIT', payment_method='CREDIT')
        self.line = PurchaseInvoiceItem.objects.create(purchase_invoice=self.bill, product=self.case, quantity=D('10'),
                                                       purchase_rate=D('100'), gst_percent=D('18'), line_total=D('1180'))

    def test_bank_refund_takes_stock_out(self):
        data = self.post(PR, {'original_document': str(self.bill.pk), 'items': [
            {'original_item': str(self.line.pk), 'return_qty': 3, 'return_reason_category': 'DEFECTIVE'}],
            'settlements': [{'mode': 'BANK', 'amount': '354', 'bank_account': str(self.bank.pk)}]})
        self.assertEqual(self.stock(self.case), 7)               # 10 - 3
        self.assertEqual(data['total_amount'], '354.00')         # 3 × 118
        entry = live('purchasing', 'purchase_return', data['id']).get()
        self.assertEqual(lines_of(entry), {'1002': D('354'), '1003': D('-300'), '1020': D('-54')})
        from apps.inventory.returns import return_stock_by_product
        self.assertEqual(return_stock_by_product([self.case.pk])[self.case.pk], {'sales': 0, 'purchase': 3})

    def test_credit_lowers_supplier_payable_and_cancel_restores(self):
        Supplier.objects.filter(pk=self.supplier.pk).update(outstanding_balance=D('1180'))
        data = self.post(PR, {'original_document': str(self.bill.pk), 'items': [
            {'original_item': str(self.line.pk), 'return_qty': 1, 'return_reason_category': 'WRONG_ITEM'}],
            'settlements': [{'mode': 'CREDIT', 'amount': '118'}]})
        self.supplier.refresh_from_db()
        self.assertEqual(self.supplier.outstanding_balance, D('1062'))
        entry = live('purchasing', 'purchase_return', data['id']).get()
        payable = [code for code, amt in lines_of(entry).items() if amt == D('118')]
        self.assertEqual(len(payable), 1)                        # Dr the supplier's payable ledger
        with self.captureOnCommitCallbacks(execute=True):
            self.client.post(f"{PR}{data['id']}/cancel/", {'reason': 'Supplier refused'}, format='json')
        self.supplier.refresh_from_db()
        self.assertEqual(self.supplier.outstanding_balance, D('1180'))
        self.assertEqual(self.stock(self.case), 10)

    def test_cannot_return_stock_we_do_not_have(self):
        Product.objects.filter(pk=self.case.pk).update(stock=1)
        with mock.patch('apps.inventory.stock_utils.negative_stock_blocked', return_value=True):
            res = self.post(PR, {'original_document': str(self.bill.pk), 'items': [
                {'original_item': str(self.line.pk), 'return_qty': 3, 'return_reason_category': 'DAMAGED'}],
                'settlements': [{'mode': 'CASH', 'amount': '354'}]}, code=400)
        self.assertIn('Not enough stock', str(res))
        self.assertEqual(self.stock(self.case), 1)

    def test_manual_return_needs_supplier(self):
        res = self.post(PR, {'items': [{'product': str(self.case.pk), 'return_qty': 1, 'unit_price': '50',
                                        'return_reason_category': 'DAMAGED'}],
                             'settlements': [{'mode': 'CASH', 'amount': '50'}]}, code=400)
        self.assertIn('supplier', str(res))
        ok = self.post(PR, {'supplier': str(self.supplier.pk), 'items': [
            {'product': str(self.case.pk), 'return_qty': 1, 'unit_price': '50', 'return_reason_category': 'DAMAGED'}],
            'settlements': [{'mode': 'CASH', 'amount': '50'}]})
        self.assertEqual(ok['party']['name'], 'Lux Optics')
        self.assertEqual(self.stock(self.case), 9)
