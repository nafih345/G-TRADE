"""Eye Test Report: one visit's billing references — the fee receipt, the bill a deferred fee went
onto, and bills dispensed against the Test No (bill Test No or a lens line's Rx source)."""
from datetime import date

from rest_framework.test import APITestCase

from apps.sales.models import EyeExamination, Invoice, InvoiceItem
from apps.sales.tests.test_eye_test_fees import EyeTestFeeMixin


class EyeTestReportTests(EyeTestFeeMixin, APITestCase):

    def _report(self, exam):
        res = self.client.get(f"{self.exams_url}{exam['id']}/report/")
        self.assertEqual(res.status_code, 200, res.content)
        return res.data

    def test_test_type_is_stored(self):
        exam = self._exam(test_type='COMPREHENSIVE EYE TEST', procedure_charge=300, fee_paid_amount=300,
                          fee_payment_mode='CASH')
        report = self._report(exam)
        self.assertEqual(report['exam']['test_type'], 'COMPREHENSIVE EYE TEST')
        self.assertEqual(report['exam']['patient_name'], 'Anjali Menon')
        self.assertEqual(report['exam']['patient_code'], 'P-5001')

    def test_paid_fee_has_receipt_number(self):
        exam = self._exam(procedure_charge=300, fee_paid_amount=300, fee_payment_mode='UPI')
        fee = self._report(exam)['billing']['fee']
        self.assertEqual(fee['status'], 'PAID')
        self.assertEqual(fee['receipt_no'], f"EYE-{exam['test_no']}")
        self.assertEqual(fee['payment_mode'], 'UPI')
        self.assertEqual(fee['amount'], '300.00')

    def test_free_test_has_no_receipt_or_bills(self):
        exam = self._exam(is_free_test=True)
        billing = self._report(exam)['billing']
        self.assertEqual(billing['fee']['status'], 'FREE')
        self.assertEqual(billing['fee']['receipt_no'], '')
        self.assertEqual(billing['invoices'], [])

    def test_deferred_fee_names_the_bill_it_went_onto(self):
        exam = self._exam(procedure_charge=200, fee_deferred=True)
        bill = self._bill(self._fee_line(exam), test_no=exam['test_no'])
        billing = self._report(exam)['billing']
        self.assertEqual(billing['fee']['status'], 'BILLED')
        self.assertEqual(billing['fee']['invoice_number'], bill['invoice_number'])
        self.assertEqual(billing['fee']['receipt_no'], '')
        [row] = billing['invoices']
        self.assertEqual(row['invoice_number'], bill['invoice_number'])
        self.assertEqual(row['links'], ['eye_test_fee', 'test_no'])

    def test_bills_dispensed_against_the_test(self):
        exam = self._exam()
        other = self._exam(n=2)
        by_test_no = self._bill(test_no=exam['test_no'])
        self._bill(test_no=other['test_no'])  # another visit's bill

        lens_bill = Invoice.objects.create(invoice_number='INV-LENS-1', invoice_date=date(2026, 11, 1),
                                           customer_name='Anjali Menon', net_amount=1500, paid_amount=500)
        InvoiceItem.objects.create(invoice=lens_bill, item_type='LENS', description='Lens',
                                   quantity=1, unit_price=1500, subtotal=1500,
                                   lens_details={'rx_source': f"Eye Test (Test No: {exam['test_no']})"})
        # Same prefix, different Test No — must not be picked up by the coarse icontains pre-filter.
        near_miss = Invoice.objects.create(invoice_number='INV-LENS-2', invoice_date=date(2026, 11, 1),
                                           customer_name='Anjali Menon', net_amount=900)
        InvoiceItem.objects.create(invoice=near_miss, item_type='LENS', description='Lens',
                                   quantity=1, unit_price=900, subtotal=900,
                                   lens_details={'rx_source': f"Eye Test (Test No: {exam['test_no']}9)"})

        rows = {r['invoice_number']: r for r in self._report(exam)['billing']['invoices']}
        self.assertEqual(set(rows), {by_test_no['invoice_number'], 'INV-LENS-1'})
        self.assertEqual(rows[by_test_no['invoice_number']]['links'], ['test_no'])
        self.assertEqual(rows['INV-LENS-1']['links'], ['lens_rx'])
        self.assertEqual(rows['INV-LENS-1']['balance'], '1000.00')

