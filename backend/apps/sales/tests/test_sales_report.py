"""Reports → Sales Report (GET /api/sales/invoices/report/): one row per bill with customer profile,
linked eye test + visit sequence, line details (codes / barcodes / lens specs), payment breakdown
and the salesman saved on the bill."""
from datetime import timedelta

from django.utils import timezone
from rest_framework.test import APITestCase

from apps.products.models import Product
from apps.sales.models import Customer, EyeExamination


class SalesReportTests(APITestCase):
    url = '/api/sales/invoices/'

    def setUp(self):
        self.customer = Customer.objects.create(
            name='Asha Menon', phone='9800011122', address='12 Lake Road', place='Kochi', patient_code='P-5001')
        now = timezone.now()
        self.first = EyeExamination.objects.create(customer=self.customer, patient_id='P-5001',
                                                   patient_name='Asha Menon', test_no='7001')
        self.second = EyeExamination.objects.create(customer=self.customer, patient_id='P-5001',
                                                    patient_name='Asha Menon', test_no='7002',
                                                    sub_sph_od='-1.25', optometrist='Dr. Rao')
        # examination_date is auto_now_add — order the visits explicitly.
        EyeExamination.objects.filter(pk=self.first.pk).update(examination_date=now - timedelta(days=200))
        EyeExamination.objects.filter(pk=self.second.pk).update(examination_date=now - timedelta(days=1))
        self.frame = Product.objects.create(name='Aviator Frame', sku='FR-AV-01', barcode='2000000000017',
                                            brand_name='RayBan', extra_data={'model_no': 'RB3025'})

    def _bill(self, **extra):
        body = {
            'document_type': 'INVOICE', 'invoice_date': '2026-10-15', 'customer': str(self.customer.pk),
            'customer_name': 'Asha Menon', 'total_amount': 3000, 'discount_amount': 200, 'net_amount': 2800,
            'paid_amount': 0, 'payment_splits': {'cash': 1000, 'upi': 800}, 'salesman': 'Ravi',
            'items': [
                {'product': str(self.frame.pk), 'description': 'Aviator Frame', 'quantity': 1,
                 'unit_price': 2000, 'subtotal': 2000},
                {'item_type': 'LENS', 'description': 'Single Vision Lens', 'quantity': 1, 'unit_price': 1000,
                 'subtotal': 1000, 'selling_unit': 'PAIR',
                 'lens_details': {'rx': {'re': {'sph': '-1.25'}, 'le': {'sph': '-1.00'}},
                                  'lens_index': '1.56', 'specs': {'coating': 'Blue Cut', 'design': 'SV'},
                                  'rx_source': 'Test No 7002'}},
            ],
        }
        body.update(extra)
        res = self.client.post(self.url, body, format='json')
        self.assertEqual(res.status_code, 201, res.content)
        return res.data

    def _report(self, **params):
        res = self.client.get(f'{self.url}report/', {'date_from': '2026-10-01', 'date_to': '2026-10-31', **params})
        self.assertEqual(res.status_code, 200, res.content)
        return res.data['results']

    def test_row_carries_customer_exam_lines_payment_and_staff(self):
        self._bill()
        [row] = self._report()
        self.assertEqual(row['document_type'], 'INVOICE')
        self.assertEqual(row['customer']['phone'], '9800011122')
        self.assertEqual(row['customer']['address'], '12 Lake Road')
        self.assertEqual(row['salesman'], 'Ravi')

        # Linked through the lens line's prescription source; the second visit = a follow-up.
        self.assertEqual(row['test_no'], '7002')
        self.assertEqual(row['exam']['linked_by'], 'lens_rx')
        self.assertEqual((row['exam']['visit_ordinal'], row['exam']['visit_total']), (2, 2))
        self.assertFalse(row['exam']['is_first_test'])
        self.assertEqual(row['exam']['re']['sph'], '-1.25')

        frame, lens = row['lines']
        self.assertEqual((frame['kind'], frame['brand'], frame['model'], frame['code'], frame['barcode']),
                         ('FRAME', 'RayBan', 'RB3025', 'FR-AV-01', '2000000000017'))
        self.assertEqual((lens['kind'], lens['lens']['index'], lens['lens']['coating']), ('LENS', '1.56', 'Blue Cut'))

        self.assertEqual(row['totals'], {'gross': '3000.00', 'discount': '200.00', 'tax': '0.00',
                                         'net': '2800.00', 'paid': '1800.00', 'balance': '1000.00'})
        self.assertEqual(row['payment']['mode'], 'Split')
        self.assertEqual({m['mode'] for m in row['payment']['modes']}, {'Cash', 'UPI'})

    def test_test_no_saved_on_the_bill_wins_and_first_visit_is_flagged(self):
        self._bill(test_no='7001', items=[], payment_splits={'cash': 2800})
        [row] = self._report()
        self.assertEqual(row['exam']['linked_by'], 'bill')
        self.assertTrue(row['exam']['is_first_test'])
        self.assertEqual(row['payment']['mode'], 'Cash')
        self.assertEqual(row['exam_history']['count'], 2)

    def test_date_range_and_document_type_filter(self):
        self._bill()
        self._bill(document_type='QUOTATION', status='DRAFT', payment_splits={}, invoice_date='2026-10-20')
        self._bill(invoice_date='2026-09-30')
        self.assertEqual(len(self._report()), 2)
        [quote] = self._report(document_type='QUOTATION')
        self.assertEqual(quote['payment']['mode'], '—')
