"""An eye test fee paid at the test reaches the ledger: Dr Cash (or UPI) / Cr Service revenue.
Free tests and pay-after-sale fees don't post here; edits re-post, and switching away from a
paid fee or deleting the exam reverses it."""
from rest_framework.test import APITestCase

from .helpers import D, balance, ledger_is_balanced, lines_of, live


class EyeTestFeePostingTests(APITestCase):
    url = '/api/sales/eye-examinations/'

    def _save(self, method='post', pk=None, **body):
        payload = {'patient_id': 'P-7001', 'patient_name': 'Ravi', 'primary_diagnosis': 'Myopia', **body}
        with self.captureOnCommitCallbacks(execute=True):
            res = getattr(self.client, method)(f"{self.url}{pk}/" if pk else self.url, payload, format='json')
        self.assertIn(res.status_code, (200, 201), res.content)
        return res.data

    def test_cash_fee_posts_to_cash_and_service_revenue(self):
        exam = self._save(procedure_charge=250, fee_paid_amount=250, fee_payment_mode='CASH')
        entry = live('sales', 'eye_test_fee', exam['id']).get()
        self.assertEqual(lines_of(entry), {'1001': D('250'), '4003': D('-250')})
        self.assertTrue(ledger_is_balanced())

    def test_gpay_fee_posts_to_upi_and_edits_repost(self):
        exam = self._save(procedure_charge=300, fee_paid_amount=200, fee_payment_mode='UPI')
        self.assertEqual(lines_of(live('sales', 'eye_test_fee', exam['id']).get()), {'1002': D('200'), '4003': D('-200')})
        self._save('patch', exam['id'], fee_paid_amount=300, fee_payment_mode='UPI')
        self.assertEqual(lines_of(live('sales', 'eye_test_fee', exam['id']).get()), {'1002': D('300'), '4003': D('-300')})
        self.assertEqual(balance('4003'), D('300'))

    def test_free_and_deferred_fees_do_not_post(self):
        free = self._save(is_free_test=True, procedure_charge=200)
        later = self._save(procedure_charge=200, fee_deferred=True, primary_diagnosis='Hyperopia')
        self.assertFalse(live('sales', 'eye_test_fee', free['id']).exists())
        self.assertFalse(live('sales', 'eye_test_fee', later['id']).exists())

    def test_switching_to_pay_later_or_deleting_reverses(self):
        exam = self._save(procedure_charge=200, fee_paid_amount=200, fee_payment_mode='CASH')
        self._save('patch', exam['id'], fee_deferred=True)
        self.assertFalse(live('sales', 'eye_test_fee', exam['id']).exists())
        self.assertEqual(balance('1001'), D('0'))

        self._save('patch', exam['id'], fee_deferred=False, fee_paid_amount=200, fee_payment_mode='CASH')
        self.assertTrue(live('sales', 'eye_test_fee', exam['id']).exists())
        with self.captureOnCommitCallbacks(execute=True):
            self.client.delete(f"{self.url}{exam['id']}/")
        self.assertFalse(live('sales', 'eye_test_fee', exam['id']).exists())
        self.assertEqual(balance('4003'), D('0'))
        self.assertTrue(ledger_is_balanced())
