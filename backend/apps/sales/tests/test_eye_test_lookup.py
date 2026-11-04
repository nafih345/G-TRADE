"""New Sale's Test No lookup: a date range's tests with their sale status, and the guarded discard."""
from datetime import timedelta

from django.utils import timezone
from rest_framework.test import APITestCase

from apps.sales.models import EyeExamination, Invoice
from apps.sales.tests.test_eye_test_fees import EyeTestFeeMixin


class EyeTestLookupTests(EyeTestFeeMixin, APITestCase):

    def _lookup(self, start=None, end=None):
        now = timezone.now()
        start = start or now - timedelta(hours=1)
        end = end or now + timedelta(hours=1)
        res = self.client.get(f'{self.exams_url}lookup/', {'from': start.isoformat(), 'to': end.isoformat()})
        self.assertEqual(res.status_code, 200, res.content)
        return {r['test_no']: r for r in res.data['results']}

    def _goods(self):
        return {'item_type': 'PRODUCT', 'description': 'Frame', 'quantity': 1, 'unit_price': 800, 'subtotal': 800}

    def test_lists_tests_in_range_with_sale_status(self):
        sold = self._exam(n=1)
        pending = self._exam(n=2)
        self._bill(self._goods(), test_no=sold['test_no'])
        rows = self._lookup()
        self.assertEqual(rows[sold['test_no']]['sale_status'], 'SOLD')
        self.assertEqual(len(rows[sold['test_no']]['sales']), 1)
        self.assertEqual(rows[pending['test_no']]['sale_status'], 'PENDING')
        self.assertEqual(rows[pending['test_no']]['patient_code'], 'P-5001')

    def test_range_excludes_other_days(self):
        exam = self._exam()
        EyeExamination.objects.filter(pk=exam['id']).update(examination_date=timezone.now() - timedelta(days=2))
        self.assertNotIn(exam['test_no'], self._lookup())
        past = timezone.now() - timedelta(days=2)
        self.assertIn(exam['test_no'], self._lookup(past - timedelta(hours=1), past + timedelta(hours=1)))

    def test_requires_bounds(self):
        self.assertEqual(self.client.get(f'{self.exams_url}lookup/').status_code, 400)

    def test_quotation_and_cancelled_are_not_sales(self):
        quoted = self._exam(n=1)
        cancelled = self._exam(n=2)
        self._bill(self._goods(), test_no=quoted['test_no'], document_type='QUOTATION', status='DRAFT')
        bill = self._bill(self._goods(), test_no=cancelled['test_no'])
        Invoice.objects.filter(pk=bill['id']).update(status='CANCELLED')
        rows = self._lookup()
        self.assertEqual(rows[quoted['test_no']]['sale_status'], 'PENDING')
        self.assertEqual(len(rows[quoted['test_no']]['quotations']), 1)
        self.assertEqual(rows[cancelled['test_no']]['sale_status'], 'PENDING')

    def test_fee_with_goods_is_a_sale_fee_alone_is_not(self):
        with_goods = self._exam(n=1, procedure_charge=200, fee_deferred=True)
        fee_only = self._exam(n=2, procedure_charge=200, fee_deferred=True)
        self._bill(self._fee_line(with_goods), self._goods())
        self._bill(self._fee_line(fee_only))
        rows = self._lookup()
        self.assertEqual(rows[with_goods['test_no']]['sale_status'], 'SOLD')
        self.assertEqual(rows[fee_only['test_no']]['sale_status'], 'PENDING')
        self.assertEqual(len(rows[fee_only['test_no']]['fee_only']), 1)

    def test_discard_pending_test(self):
        exam = self._exam()
        res = self.client.delete(f"{self.exams_url}{exam['id']}/discard/")
        self.assertEqual(res.status_code, 204, res.content)
        self.assertFalse(EyeExamination.objects.filter(pk=exam['id']).exists())
        self.assertTrue(EyeExamination.all_objects.filter(pk=exam['id']).exists())  # soft delete
        self.assertNotIn(exam['test_no'], self._lookup())

    def test_discard_refuses_sold_fee_billed_or_paid_tests(self):
        sold = self._exam(n=1)
        self._bill(self._goods(), test_no=sold['test_no'])
        billed = self._exam(n=2, procedure_charge=200, fee_deferred=True)
        self._bill(self._fee_line(billed))
        paid = self._exam(n=3, procedure_charge=300, fee_paid_amount=300, fee_payment_mode='CASH')
        for exam in (sold, billed, paid):
            res = self.client.delete(f"{self.exams_url}{exam['id']}/discard/")
            self.assertEqual(res.status_code, 409, res.content)
            self.assertTrue(EyeExamination.objects.filter(pk=exam['id']).exists())
