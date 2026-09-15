"""Orders / Invoices / Quotations: required customer, list data (customer + frame/lens names),
saves that used to fail, and Total Paid / payment status.

- Every document needs a real customer name — a linked patient's, or one typed at the counter.
- Money totals summed in JS floats are rounded, not refused; a taken invoice number is replaced.
- paid_amount is the bill's Total Paid: receipts collected later against the bill raise it, and
  the PAID / PARTIAL / UNPAID status always follows it.
"""
from decimal import Decimal

from rest_framework.test import APITestCase

from apps.masters.models import ProductCategory
from apps.products.models import Product
from apps.sales.models import Customer, Invoice, InvoiceItem


class InvoiceTestMixin:
    url = '/api/sales/invoices/'
    payments_url = '/api/sales/payments/'

    def _body(self, **extra):
        body = {
            'document_type': 'ORDER', 'invoice_date': '2026-09-11', 'status': 'UNPAID',
            'total_amount': 1000, 'net_amount': 1000, 'paid_amount': 0,
            'customer_name': 'Anjali Menon', 'items': [],
        }
        body.update(extra)
        return body

    def _create(self, **extra):
        res = self.client.post(self.url, self._body(**extra), format='json')
        self.assertEqual(res.status_code, 201, res.content)
        return res.data

    def _get(self, inv_id):
        return self.client.get(f'{self.url}{inv_id}/').data


class ListPagingTests(InvoiceTestMixin, APITestCase):

    def test_a_screen_can_ask_for_the_whole_list(self):
        for i in range(25):
            Invoice.objects.create(invoice_number=f'INV-PG-{i}', invoice_date='2026-09-01',
                                   customer_name=f'Patient {i}')
        res = self.client.get(f'{self.url}?page_size=500')
        self.assertEqual(res.data['count'], 25)
        self.assertEqual(len(res.data['results']), 25)
        self.assertEqual(len(self.client.get(self.url).data['results']), 20)  # default page unchanged


class CustomerRequiredTests(InvoiceTestMixin, APITestCase):

    def test_document_without_customer_or_name_is_refused(self):
        for doc_type in ('ORDER', 'INVOICE', 'QUOTATION'):
            res = self.client.post(self.url, self._body(document_type=doc_type, customer_name=''), format='json')
            self.assertEqual(res.status_code, 400, res.content)
            self.assertIn('customer_name', res.data)
        self.assertFalse(Invoice.all_objects.exists())

    def test_placeholder_name_is_not_a_customer(self):
        for name in ('Walk-in Customer', 'walk-in patient', '  ', '---'):
            res = self.client.post(self.url, self._body(customer_name=name), format='json')
            self.assertEqual(res.status_code, 400, (name, res.content))

    def test_typed_name_is_saved_without_a_patient_link(self):
        data = self._create(customer_name='  Rahul   K  ')
        self.assertIsNone(data['customer'])
        self.assertEqual(data['customer_name'], 'Rahul K')

    def test_linked_patient_name_is_used_when_none_is_typed(self):
        cust = Customer.objects.create(name='Fathima Beevi', phone='9000000101')
        data = self._create(customer=str(cust.id), customer_name='')
        self.assertEqual(data['customer_name'], 'Fathima Beevi')
        self.assertEqual(data['customer_phone'], '9000000101')

    def test_status_patch_on_an_older_nameless_bill_still_works(self):
        legacy = Invoice.objects.create(invoice_number='ORD-OLD-1', invoice_date='2026-01-01',
                                        document_type='ORDER', net_amount=500)
        res = self.client.patch(f'{self.url}{legacy.id}/', {'fulfillment_status': 'Delivered'}, format='json')
        self.assertEqual(res.status_code, 200, res.content)

    def test_clearing_the_customer_needs_a_name(self):
        cust = Customer.objects.create(name='Suresh P', phone='9000000102')
        inv = self._create(customer=str(cust.id), customer_name='')
        res = self.client.patch(f"{self.url}{inv['id']}/", {'customer': None, 'customer_name': ''}, format='json')
        self.assertEqual(res.status_code, 400, res.content)
        res = self.client.patch(f"{self.url}{inv['id']}/", {'customer': None, 'customer_name': 'Suresh Walk-in'},
                                format='json')
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(res.data['customer_name'], 'Suresh Walk-in')


class SavePersistenceTests(InvoiceTestMixin, APITestCase):

    def test_float_noise_in_totals_is_rounded_instead_of_refused(self):
        data = self._create(total_amount=0.1 + 0.2, tax_amount=269.82000000000005,
                            net_amount=269.82000000000005 + 0.30000000000000004, paid_amount=0)
        self.assertEqual(data['total_amount'], '0.30')
        self.assertEqual(data['tax_amount'], '269.82')
        self.assertEqual(data['net_amount'], '270.12')

    def test_taken_invoice_number_gets_a_fresh_one(self):
        first = self._create(document_type='INVOICE', invoice_number='INV-2026-1234')
        second = self._create(document_type='INVOICE', invoice_number='INV-2026-1234')
        self.assertEqual(first['invoice_number'], 'INV-2026-1234')
        self.assertNotEqual(second['invoice_number'], 'INV-2026-1234')
        self.assertTrue(second['invoice_number'].startswith('INV-'))

    def test_edit_onto_a_taken_number_gets_a_fresh_one(self):
        self._create(invoice_number='ORD-2026-1111')
        other = self._create(invoice_number='ORD-2026-2222')
        res = self.client.patch(f"{self.url}{other['id']}/", {'invoice_number': 'ORD-2026-1111'}, format='json')
        self.assertEqual(res.status_code, 200, res.content)
        self.assertNotIn(res.data['invoice_number'], ('ORD-2026-1111', ''))
        res = self.client.patch(f"{self.url}{other['id']}/", {'invoice_number': ''}, format='json')
        self.assertEqual(res.status_code, 200, res.content)
        self.assertTrue(res.data['invoice_number'])


class FrameLensNameTests(InvoiceTestMixin, APITestCase):

    def setUp(self):
        frames = ProductCategory.objects.create(name='Frames', code='FRM')
        lenses = ProductCategory.objects.create(name='Spectacle Lens', code='LNS')
        accessories = ProductCategory.objects.create(name='Accessories', code='ACC')
        self.frame = Product.objects.create(name='Ray-Ban RB5154 Clubmaster', sku='FL-FRM-1', category=frames)
        self.lens = Product.objects.create(name='Crizal Blue Cut 1.56', sku='FL-LNS-1', category=lenses)
        self.case = Product.objects.create(name='Lens Cleaning Kit', sku='FL-ACC-1', category=accessories)

    def _line(self, product=None, description='', item_type='PRODUCT'):
        return {'product': str(product.id) if product else None, 'item_type': item_type,
                'description': description, 'quantity': 1, 'unit_price': 100, 'subtotal': 100}

    def test_names_come_from_the_products_when_lines_have_no_description(self):
        data = self._create(items=[
            self._line(self.frame), self._line(self.lens), self._line(self.case),
            self._line(description='Frame repair', item_type='SERVICE'),
        ])
        self.assertEqual(data['frame_name'], 'Ray-Ban RB5154 Clubmaster')
        self.assertEqual(data['lens_name'], 'Crizal Blue Cut 1.56')

    def test_an_id_in_the_description_falls_back_to_the_product_name(self):
        data = self._create(items=[self._line(self.frame, description=str(self.frame.id))])
        self.assertEqual(data['frame_name'], 'Ray-Ban RB5154 Clubmaster')

    def test_list_view_carries_names_for_every_row(self):
        self._create(items=[self._line(self.frame, description='Clubmaster Gold'), self._line(self.lens)])
        self._create(customer_name='Second Patient', items=[self._line(description='Custom lens -2.00', item_type='LENS')])
        res = self.client.get(self.url)
        rows = res.data['results'] if isinstance(res.data, dict) else res.data
        by_name = {r['customer_name']: r for r in rows}
        self.assertEqual(by_name['Anjali Menon']['frame_name'], 'Clubmaster Gold')
        self.assertEqual(by_name['Anjali Menon']['lens_name'], 'Crizal Blue Cut 1.56')
        self.assertIsNone(by_name['Second Patient']['frame_name'])
        self.assertEqual(by_name['Second Patient']['lens_name'], 'Custom lens -2.00')


class NewSaleLinePersistenceTests(InvoiceTestMixin, APITestCase):
    """A New Sale bill's frame and lens lines land in InvoiceItem linked to their products, and the
    list the Sales dashboard reads names them — even when the stock is named just "Frame"/"Lens"."""

    def setUp(self):
        frames = ProductCategory.objects.create(name='Frames', code='NS-FRM')
        lenses = ProductCategory.objects.create(name='Lens', code='NS-LNS')
        self.frame = Product.objects.create(name='Frame', sku='NS-FRM-1', color='Sky Blue', category=frames, stock=5)
        self.lens = Product.objects.create(name='Lens', sku='NS-LNS-1', category=lenses, stock=5)

    def _new_sale_line(self, product, description, price):
        # Exactly the line shape NewSaleWizard.saveCompletedSale sends.
        return {'product': str(product.id), 'service': None, 'item_type': 'PRODUCT', 'service_details': None,
                'description': description, 'quantity': 1, 'unit_price': price, 'tax_rate': 0,
                'tax_amount': 0, 'subtotal': price}

    def test_frame_and_lens_lines_are_saved_and_named(self):
        data = self._create(document_type='INVOICE', customer_name='Nuhman', invoice_number='INV-2026-4543',
                            items=[self._new_sale_line(self.frame, 'Frame', 1500),
                                   self._new_sale_line(self.lens, 'Lens', 1000)])
        rows = InvoiceItem.objects.filter(invoice_id=data['id']).order_by('description')
        self.assertEqual([(r.description, r.product_id) for r in rows], [('Frame', self.frame.id), ('Lens', self.lens.id)])
        self.assertEqual((data['frame_name'], data['lens_name']), ('Sky Blue Frame', 'Lens'))
        line = next(i for i in data['items'] if i['description'] == 'Frame')
        self.assertEqual((line['product_name'], line['color'], line['category_name'], line['display_name']),
                         ('Frame', 'Sky Blue', 'Frames', 'Sky Blue Frame'))

        listed = next(r for r in self.client.get(self.url).data['results'] if r['id'] == data['id'])
        self.assertEqual((listed['frame_name'], listed['lens_name']), ('Sky Blue Frame', 'Lens'))

    def test_colour_of_an_imported_product_comes_from_extra_data(self):
        imported = Product.objects.create(name='Frame', sku='NS-FRM-2', extra_data={'color_code': 'Matte Black'})
        data = self._create(items=[self._new_sale_line(imported, 'Frame', 10)])
        self.assertEqual(data['frame_name'], 'Matte Black Frame')


class TotalPaidAndStatusTests(InvoiceTestMixin, APITestCase):

    def _receipt(self, inv_id, amount, **extra):
        body = {'invoice': inv_id, 'amount': amount, 'method': 'Cash', 'payment_date': '2026-09-12',
                'customer_name': 'Anjali Menon'}
        body.update(extra)
        res = self.client.post(self.payments_url, body, format='json')
        self.assertEqual(res.status_code, 201, res.content)
        return res.data

    def test_status_follows_what_has_been_paid(self):
        self.assertEqual(self._create(payment_splits={'cash': 0})['payment_status'], 'UNPAID')
        partial = self._create(status='PAID', payment_splits={'cash': 300})
        self.assertEqual(partial['payment_status'], 'PARTIAL')
        self.assertEqual(partial['status'], 'PARTIAL')   # a client's "PAID" can't contradict the amounts
        self.assertEqual(partial['balance_due'], '700.00')
        paid = self._create(payment_splits={'cash': 400, 'upi': 600})
        self.assertEqual((paid['payment_status'], paid['status'], paid['paid_amount']), ('PAID', 'PAID', '1000.00'))

    def test_quotation_stays_draft(self):
        data = self._create(document_type='QUOTATION', status='DRAFT')
        self.assertEqual(data['status'], 'DRAFT')
        self.assertEqual(data['payment_status'], 'UNPAID')

    def test_receipt_collected_against_the_bill_raises_total_paid(self):
        inv = self._create(payment_splits={'cash': 300})
        receipt = self._receipt(inv['id'], 700)
        data = self._get(inv['id'])
        self.assertEqual((data['paid_amount'], data['payment_status'], data['status']), ('1000.00', 'PAID', 'PAID'))

        self.assertEqual(self.client.delete(f"{self.payments_url}{receipt['id']}/").status_code, 204)
        data = self._get(inv['id'])
        self.assertEqual((data['paid_amount'], data['payment_status']), ('300.00', 'PARTIAL'))

    def test_cancelling_or_changing_a_receipt_moves_total_paid(self):
        inv = self._create(payment_splits={'cash': 100})
        receipt = self._receipt(inv['id'], 400)
        self.client.patch(f"{self.payments_url}{receipt['id']}/", {'amount': 250}, format='json')
        self.assertEqual(self._get(inv['id'])['paid_amount'], '350.00')
        self.client.patch(f"{self.payments_url}{receipt['id']}/", {'status': 'CANCELLED'}, format='json')
        self.assertEqual(self._get(inv['id'])['paid_amount'], '100.00')

    def test_receipt_without_a_bill_changes_no_bill(self):
        inv = self._create(payment_splits={'cash': 100})
        self._receipt(None, 500)
        self.assertEqual(self._get(inv['id'])['paid_amount'], '100.00')

    def test_editing_the_bill_keeps_money_collected_later(self):
        inv = self._create(payment_splits={'cash': 300})
        self._receipt(inv['id'], 200)
        res = self.client.patch(f"{self.url}{inv['id']}/", {'items': [], 'payment_splits': {'cash': 300, 'upi': 100}},
                                format='json')
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(res.data['paid_amount'], '600.00')
        self.assertEqual(res.data['payment_status'], 'PARTIAL')

    def test_converted_quotation_leaves_draft_and_takes_stock(self):
        frame = Product.objects.create(name='Convert Frame', sku='CV-FRM-1', stock=10)
        quote = self._create(document_type='QUOTATION', status='DRAFT', items=[
            {'product': str(frame.id), 'description': 'Convert Frame', 'quantity': 2, 'unit_price': 500, 'subtotal': 1000},
        ])
        res = self.client.post(f"{self.url}{quote['id']}/convert/", {'document_type': 'INVOICE'}, format='json')
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(res.data['status'], 'UNPAID')
        frame.refresh_from_db()
        self.assertEqual(frame.stock, 8)
        self.assertEqual(Decimal(res.data['net_amount']), Decimal('1000'))
