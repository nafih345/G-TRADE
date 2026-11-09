"""Order → Invoice settlement (New Sale's payment pop-up): `balance_receipts` on the PATCH.

The order's advance (its BILLING split) stays as booked; the balance collected at delivery is
recorded as today's receipts in the same transaction that converts the order and marks it
delivered.
"""
from decimal import Decimal

from django.utils import timezone
from rest_framework.test import APITestCase

from apps.financial.models import AccountGroup, ChartOfAccount
from apps.sales.models import Payment


class OrderSettlementTests(APITestCase):
    url = '/api/sales/invoices/'

    def setUp(self):
        res = self.client.post(self.url, {
            'document_type': 'ORDER', 'invoice_date': '2026-11-01', 'status': 'PARTIAL',
            'total_amount': 1000, 'net_amount': 1000, 'paid_amount': 0, 'items': [],
            'payment_splits': {'cash': 300}, 'customer_name': 'Settlement Patient',
        }, format='json')
        self.assertEqual(res.status_code, 201, res.content)
        self.order = res.data['id']
        self.advance = Payment.objects.get(invoice_id=self.order)

    def _settle(self, balance, **extra):
        body = {'document_type': 'INVOICE', 'net_amount': 1000, 'items': [],
                'payment_splits': {'cash': 300}, 'fulfillment_status': 'Delivered',
                'balance_receipts': balance}
        body.update(extra)
        return self.client.patch(f'{self.url}{self.order}/', body, format='json')

    def test_balance_is_recorded_as_todays_receipts_and_the_advance_is_untouched(self):
        group = AccountGroup.objects.get(name='Bank Accounts')
        bank = ChartOfAccount.objects.create(code='100291', name='Settle Bank', account_group=group,
                                             account_subtype='BANK')
        res = self._settle({'cash': 200, 'upi': {'amount': 500, 'bank_account': str(bank.pk), 'reference': 'UTR9'}})
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(res.data['document_type'], 'INVOICE')
        self.assertEqual(Decimal(res.data['paid_amount']), Decimal('1000'))
        self.assertEqual(res.data['status'], 'PAID')
        self.assertEqual(res.data['fulfillment_status'], 'Delivered')

        self.advance.refresh_from_db()
        self.assertFalse(self.advance.is_deleted)
        self.assertEqual(self.advance.amount, Decimal('300'))
        later = {p.method: p for p in Payment.objects.filter(invoice_id=self.order, source='')}
        self.assertEqual({m: p.amount for m, p in later.items()}, {'Cash': Decimal('200'), 'UPI': Decimal('500')})
        self.assertEqual(later['UPI'].bank_account_id, bank.pk)
        self.assertEqual(later['UPI'].reference_no, 'UTR9')
        self.assertEqual(later['Cash'].payment_date, timezone.localdate())

        # A later New Sale edit keeps the collected balance in Total Paid.
        res = self.client.patch(f'{self.url}{self.order}/', {'items': [], 'payment_splits': {'cash': 300}}, format='json')
        self.assertEqual(Decimal(res.data['paid_amount']), Decimal('1000'))

    def test_partial_balance_leaves_the_invoice_partly_paid(self):
        res = self._settle({'cash': 100})
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(Decimal(res.data['paid_amount']), Decimal('400'))
        self.assertEqual(res.data['status'], 'PARTIAL')

    def test_digital_balance_without_a_bank_is_refused_and_nothing_changes(self):
        res = self._settle({'card': 700})
        self.assertEqual(res.status_code, 400, res.content)
        self.assertIn('balance_receipts', res.data)
        detail = self.client.get(f'{self.url}{self.order}/').data
        self.assertEqual(detail['document_type'], 'ORDER')
        self.assertEqual(Payment.objects.filter(invoice_id=self.order).count(), 1)

    def test_collecting_more_than_the_balance_is_refused(self):
        res = self._settle({'cash': 701})
        self.assertEqual(res.status_code, 400, res.content)
        self.assertEqual(Payment.objects.filter(invoice_id=self.order).count(), 1)

    def test_negative_amount_is_refused(self):
        self.assertEqual(self._settle({'cash': -5}).status_code, 400)
