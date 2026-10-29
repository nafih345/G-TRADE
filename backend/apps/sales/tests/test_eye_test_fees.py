"""Eye test fees: free / paid at the test / deferred to the patient's frame & lens purchase.

- The fee status is derived from the Free Test flag and the "Pay during frame/lens purchase"
  toggle; payment mode is Cash or GPay (UPI) only.
- A deferred (PENDING) fee is found by New Sale through ?fee_status=PENDING&customer=/patient_id=.
- A bill carrying the fee line claims it (BILLED); removing the line, cancelling, turning it into
  a quotation or deleting the bill releases it; one fee can never sit on two bills.
"""
from decimal import Decimal

from rest_framework.test import APITestCase

from apps.sales.eye_test_fees import EYE_TEST_FEE_KIND
from apps.sales.models import Customer, EyeExamination


class EyeTestFeeMixin:
    exams_url = '/api/sales/eye-examinations/'
    invoices_url = '/api/sales/invoices/'

    def setUp(self):
        self.customer = Customer.objects.create(name='Anjali Menon', phone='9800000001', patient_code='P-5001')

    def _exam(self, n=1, **fee):
        body = {'customer': str(self.customer.id), 'patient_id': 'P-5001', 'patient_name': 'Anjali Menon',
                'primary_diagnosis': f'Myopia {n}', 'sub_sph_od': f'-{n}.00'}
        body.update(fee)
        res = self.client.post(self.exams_url, body, format='json')
        self.assertEqual(res.status_code, 201, res.content)
        return res.data

    def _fee_line(self, exam, amount=200):
        return {'item_type': 'SERVICE', 'description': f"Eye Test Fee (Test No {exam['test_no']})",
                'quantity': 1, 'unit_price': amount, 'subtotal': amount,
                'service_details': {'kind': EYE_TEST_FEE_KIND, 'eye_examination_id': exam['id'],
                                    'test_no': exam['test_no']}}

    def _bill(self, *lines, expect=201, **extra):
        body = {'document_type': 'INVOICE', 'invoice_date': '2026-10-29', 'status': 'UNPAID',
                'total_amount': 1000, 'net_amount': 1000, 'paid_amount': 0,
                'customer': str(self.customer.id), 'customer_name': 'Anjali Menon', 'items': list(lines)}
        body.update(extra)
        res = self.client.post(self.invoices_url, body, format='json')
        self.assertEqual(res.status_code, expect, res.content)
        return res.data

    def _status(self, exam):
        row = EyeExamination.objects.get(pk=exam['id'])
        return row.fee_status, (str(row.fee_invoice_id) if row.fee_invoice_id else None)


class FeeDerivationTests(EyeTestFeeMixin, APITestCase):

    def test_paid_test_records_amount_and_mode(self):
        exam = self._exam(procedure_charge=250, medical_aid_charge=100, medicine_charge=50,
                          fee_paid_amount=200, fee_payment_mode='upi')
        self.assertEqual(exam['fee_status'], 'PAID')
        self.assertEqual(Decimal(exam['fee_amount']), Decimal('200.00'))  # 250 + 50 - 100
        self.assertEqual(exam['fee_payment_mode'], 'UPI')
        self.assertEqual(Decimal(exam['fee_paid_amount']), Decimal('200.00'))

    def test_free_test_takes_no_payment(self):
        exam = self._exam(is_free_test=True, procedure_charge=250, fee_paid_amount=250, fee_payment_mode='CASH')
        self.assertEqual(exam['fee_status'], 'FREE')
        self.assertEqual(Decimal(exam['fee_amount']), Decimal('0'))
        self.assertEqual(Decimal(exam['fee_paid_amount']), Decimal('0'))
        self.assertEqual(exam['fee_payment_mode'], '')

    def test_deferred_fee_is_pending_with_nothing_paid(self):
        exam = self._exam(procedure_charge=200, fee_deferred=True, fee_paid_amount=200, fee_payment_mode='CASH')
        self.assertEqual(exam['fee_status'], 'PENDING')
        self.assertEqual(Decimal(exam['fee_amount']), Decimal('200.00'))
        self.assertEqual(Decimal(exam['fee_paid_amount']), Decimal('0'))

    def test_only_cash_and_gpay_are_accepted(self):
        res = self.client.post(self.exams_url, {'patient_id': 'P-5001', 'patient_name': 'Anjali Menon',
                                                'procedure_charge': 200, 'fee_payment_mode': 'CARD'}, format='json')
        self.assertEqual(res.status_code, 400, res.content)
        self.assertIn('fee_payment_mode', res.data)

    def test_client_cannot_set_fee_status_directly(self):
        exam = self._exam(procedure_charge=200, fee_payment_mode='CASH', fee_status='BILLED', fee_amount=5)
        self.assertEqual(exam['fee_status'], 'PAID')
        self.assertEqual(Decimal(exam['fee_amount']), Decimal('200.00'))

    def test_unrelated_patch_keeps_the_fee(self):
        exam = self._exam(procedure_charge=200, fee_deferred=True)
        res = self.client.patch(f"{self.exams_url}{exam['id']}/", {'primary_diagnosis': 'Hyperopia'}, format='json')
        self.assertEqual(res.data['fee_status'], 'PENDING')

    def test_pending_lookup_matches_customer_or_patient_code(self):
        pending = self._exam(1, procedure_charge=200, fee_deferred=True)
        self._exam(2, procedure_charge=200, fee_payment_mode='CASH')
        for params in ({'customer': str(self.customer.id)}, {'patient_id': 'P-5001'},
                       {'customer': 'not-a-uuid', 'patient_id': 'P-5001'}):
            res = self.client.get(self.exams_url, {'fee_status': 'PENDING', **params})
            ids = [r['id'] for r in res.data.get('results', res.data)]
            self.assertEqual(ids, [pending['id']], params)
        res = self.client.get(self.exams_url, {'fee_status': 'PENDING', 'patient_id': 'P-9999'})
        self.assertEqual(len(res.data.get('results', res.data)), 0)


class FeeSettlementTests(EyeTestFeeMixin, APITestCase):

    def test_bill_claims_and_edit_releases_the_fee(self):
        exam = self._exam(procedure_charge=200, fee_deferred=True)
        bill = self._bill(self._fee_line(exam))
        self.assertEqual(self._status(exam), ('BILLED', bill['id']))

        # The billed fee is frozen against edits on the Eye Test screen.
        res = self.client.patch(f"{self.exams_url}{exam['id']}/",
                                {'procedure_charge': 500, 'fee_deferred': False, 'fee_payment_mode': 'CASH'},
                                format='json')
        self.assertEqual(res.data['fee_status'], 'BILLED')
        self.assertEqual(Decimal(res.data['fee_amount']), Decimal('200.00'))

        res = self.client.patch(f"{self.invoices_url}{bill['id']}/", {'items': []}, format='json')
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(self._status(exam), ('PENDING', None))

    def test_one_fee_cannot_be_billed_twice(self):
        exam = self._exam(procedure_charge=200, fee_deferred=True)
        first = self._bill(self._fee_line(exam))
        self._bill(self._fee_line(exam), expect=400)
        self.assertEqual(self._status(exam), ('BILLED', first['id']))

    def test_paid_fee_cannot_be_billed(self):
        exam = self._exam(procedure_charge=200, fee_payment_mode='CASH')
        self._bill(self._fee_line(exam), expect=400)
        self.assertEqual(self._status(exam), ('PAID', None))

    def test_quotation_does_not_claim_until_converted(self):
        exam = self._exam(procedure_charge=200, fee_deferred=True)
        quote = self._bill(self._fee_line(exam), document_type='QUOTATION', status='DRAFT')
        self.assertEqual(self._status(exam), ('PENDING', None))
        res = self.client.post(f"{self.invoices_url}{quote['id']}/convert/", {'document_type': 'ORDER'}, format='json')
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(self._status(exam), ('BILLED', quote['id']))

    def test_cancel_or_delete_releases_the_fee(self):
        exam = self._exam(procedure_charge=200, fee_deferred=True)
        bill = self._bill(self._fee_line(exam), document_type='ORDER')
        self.client.patch(f"{self.invoices_url}{bill['id']}/", {'status': 'CANCELLED'}, format='json')
        self.assertEqual(self._status(exam), ('PENDING', None))

        bill = self._bill(self._fee_line(exam), document_type='ORDER')
        self.assertEqual(self._status(exam), ('BILLED', bill['id']))
        res = self.client.delete(f"{self.invoices_url}{bill['id']}/")
        self.assertIn(res.status_code, (200, 204), res.content)
        self.assertEqual(self._status(exam), ('PENDING', None))
