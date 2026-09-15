"""Split advance from New Sale: `payment_splits` = {cash, card, upi, bank}.

InvoiceViewSet records one BILLING receipt per pay mode against the bill, sets paid_amount to
their sum, refuses a split above the net payable, and keeps the receipts in step when the bill
is edited (voided receipts reverse their journal entry).
"""
from decimal import Decimal

from rest_framework.test import APITestCase

from apps.sales.models import Payment
from apps.sales.signals import _latest_live_entry


class InvoicePaymentSplitTests(APITestCase):
    url = '/api/sales/invoices/'

    def _create(self, splits, net=380, **extra):
        body = {
            'document_type': 'INVOICE', 'invoice_date': '2026-09-11', 'status': 'PARTIAL',
            'total_amount': 400, 'discount_amount': 20, 'net_amount': net,
            'paid_amount': 0, 'items': [], 'payment_splits': splits, 'customer_name': 'Split Test Patient',
        }
        body.update(extra)
        return self.client.post(self.url, body, format='json')

    def _receipts(self, inv_id):
        return {p.method: p.amount for p in Payment.objects.filter(invoice_id=inv_id)}

    def test_split_is_summed_into_paid_amount_and_recorded_per_mode(self):
        res = self._create({'cash': 100, 'card': 0, 'upi': '100.00', 'bank': ''})
        self.assertEqual(res.status_code, 201, res.content)
        self.assertEqual(Decimal(res.data['paid_amount']), Decimal('200'))
        self.assertEqual(self._receipts(res.data['id']), {'Cash': Decimal('100'), 'UPI': Decimal('100')})
        self.assertTrue(all(p.source == 'BILLING' for p in Payment.objects.filter(invoice_id=res.data['id'])))

        detail = self.client.get(f"{self.url}{res.data['id']}/")
        self.assertEqual(detail.data['payment_splits'],
                         {'cash': '100.00', 'card': '0.00', 'upi': '100.00', 'bank': '0.00'})

    def test_split_above_net_payable_is_refused_and_nothing_is_saved(self):
        res = self._create({'cash': 300, 'upi': 100})
        self.assertEqual(res.status_code, 400, res.content)
        self.assertIn('payment_splits', res.data)
        self.assertFalse(Payment.objects.exists())

    def test_negative_or_non_numeric_amount_is_refused(self):
        self.assertEqual(self._create({'cash': -50}).status_code, 400)
        self.assertEqual(self._create({'card': 'abc'}).status_code, 400)

    def test_edit_moves_receipts_to_the_new_split(self):
        inv = self._create({'cash': 100, 'upi': 100}).data['id']
        cash = Payment.objects.get(invoice_id=inv, method='Cash')
        upi = Payment.objects.get(invoice_id=inv, method='UPI')

        res = self.client.patch(f'{self.url}{inv}/', {
            'net_amount': 380, 'items': [], 'payment_splits': {'upi': 150, 'card': 230},
        }, format='json')
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(Decimal(res.data['paid_amount']), Decimal('380'))
        self.assertEqual(self._receipts(inv), {'UPI': Decimal('150'), 'Card': Decimal('230')})
        # UPI receipt updated in place (same receipt number); the cash one is voided and its
        # journal entry reversed, so the Cash account no longer shows money that was never kept.
        self.assertEqual(Payment.objects.get(invoice_id=inv, method='UPI').pk, upi.pk)
        cash_row = Payment.all_objects.get(pk=cash.pk)
        self.assertTrue(cash_row.is_deleted)
        self.assertEqual(cash_row.status, 'CANCELLED')
        self.assertIsNone(_latest_live_entry('PAYMENT_RECEIPT', cash.pk))

    def test_patch_without_a_split_leaves_receipts_and_paid_amount_alone(self):
        inv = self._create({'cash': 200}).data['id']
        res = self.client.patch(f'{self.url}{inv}/', {'fulfillment_status': 'Delivered'}, format='json')
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(Decimal(res.data['paid_amount']), Decimal('200'))
        self.assertEqual(self._receipts(inv), {'Cash': Decimal('200')})

    def test_receipts_recorded_from_the_payments_tab_are_not_touched_by_an_edit(self):
        inv = self._create({'cash': 100}).data['id']
        later = Payment.objects.create(invoice_id=inv, amount=80, method='UPI',
                                       payment_date='2026-09-12', customer_name='Walk-in Customer')
        self.client.patch(f'{self.url}{inv}/', {'items': [], 'payment_splits': {'cash': 120}}, format='json')
        later.refresh_from_db()
        self.assertFalse(later.is_deleted)
        self.assertEqual(later.amount, Decimal('80'))
