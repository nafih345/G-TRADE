"""Bank / UPI payments land in the bank the user picked; Cash can be marked Unpaid."""
from rest_framework.test import APITestCase

from apps.financial.models import AccountGroup, ChartOfAccount
from apps.purchasing.models import PurchaseInvoice, Supplier
from apps.sales.models import Dealer, Invoice, Payment, WholesalePaymentCollection

from .helpers import D, TODAY, balance, ledger_is_balanced, live, make_user
from .test_sources import Booked


def make_bank(name='HDFC Current', code='100201'):
    group = AccountGroup.objects.get(name='Bank Accounts')
    return ChartOfAccount.objects.create(code=code, name=name, account_group=group, account_subtype='BANK')


class PaymentBankPostingTests(Booked):
    def setUp(self):
        self.hdfc = make_bank()

    def test_upi_and_bank_receipts_debit_the_chosen_bank(self):
        with self.booked():
            inv = Invoice.objects.create(invoice_number='INV-B1', invoice_date=TODAY, customer_name='Asha',
                                         total_amount=D('1000'), net_amount=D('1000'))
            Payment.objects.create(invoice=inv, amount=D('300'), method='UPI', payment_date=TODAY, bank_account=self.hdfc)
            Payment.objects.create(invoice=inv, amount=D('200'), method='Bank Transfer', payment_date=TODAY)
        self.assertEqual(balance('100201'), D('300'))
        self.assertEqual(balance('1002'), D('200'))  # no bank picked -> the default Bank mapping
        self.assertTrue(ledger_is_balanced())

    def test_wholesale_collection_uses_the_chosen_bank(self):
        dealer = Dealer.objects.create(dealer_code='DL-9', business_name='Metro', phone='1')
        with self.booked():
            WholesalePaymentCollection.objects.create(receipt_number='R-9', dealer=dealer, payment_date=TODAY,
                                                      payment_method='Bank Transfer', amount_paid=D('500'),
                                                      bank_account=self.hdfc)
        self.assertEqual(balance('100201'), D('500'))
        self.assertEqual(balance('1002'), 0)


class PurchaseEntryPaymentTests(Booked):
    def setUp(self):
        from apps.purchasing.supplier_utils import get_or_create_supplier_ledger_account
        self.supplier = Supplier.objects.create(name='Essilor', supplier_code='SUP-9')
        self.supplier.ledger_account = get_or_create_supplier_ledger_account(self.supplier)
        self.supplier.save()
        self.ap_code = self.supplier.ledger_account.code

    def purchase(self, **kw):
        fields = dict(invoice_number='PE-9', supplier=self.supplier, purchase_date=TODAY, purchase_type='CASH',
                      tax_amount=D('0'), grand_total=D('1000'))
        fields.update(kw)
        return PurchaseInvoice.objects.create(**fields)

    def test_unpaid_cash_purchase_leaves_the_payable_open(self):
        with self.booked():
            pi = self.purchase(payment_method='CASH', payment_status='UNPAID', paid_amount=0)
        self.assertFalse(live('purchasing', 'purchase_payment', pi.pk).exists())
        self.assertEqual(balance(self.ap_code), D('1000'))
        self.assertEqual(balance('1001'), 0)

    def test_paid_cash_purchase_settles_from_cash(self):
        with self.booked():
            self.purchase(payment_method='CASH', payment_status='PAID', paid_amount=D('1000'))
        self.assertEqual(balance(self.ap_code), 0)
        self.assertEqual(balance('1001'), D('-1000'))

    def test_upi_purchase_credits_the_linked_bank(self):
        bank = make_bank('SBI Savings', '100202')
        with self.booked():
            self.purchase(payment_method='UPI', paid_amount=D('1000'), bank_account=bank)
        self.assertEqual(balance('100202'), D('-1000'))
        self.assertEqual(balance('1002'), 0)
        self.assertTrue(ledger_is_balanced())


class BankApiTests(APITestCase):
    def test_list_and_quick_add(self):
        self.assertEqual([b['code'] for b in self.client.get('/api/financial/bank-accounts/').data], ['1002'])
        res = self.client.post('/api/financial/bank-accounts/', {'name': 'ICICI'}, format='json')
        self.assertEqual(res.status_code, 403)
        self.client.force_authenticate(make_user())
        res = self.client.post('/api/financial/bank-accounts/',
                               {'name': 'ICICI Current', 'account_number': '0042', 'ifsc': 'icic0000001'}, format='json')
        self.assertEqual(res.status_code, 201, res.content)
        self.assertEqual(res.data['code'], '100201')
        self.assertEqual(res.data['description'], 'A/c 0042 · ICIC0000001')
        dup = self.client.post('/api/financial/bank-accounts/', {'name': 'icici current'}, format='json')
        self.assertEqual(dup.status_code, 400)

    def test_sale_split_records_the_bank_per_mode_and_rejects_non_banks(self):
        bank = make_bank()
        body = {'document_type': 'INVOICE', 'invoice_date': TODAY.isoformat(), 'status': 'PARTIAL',
                'total_amount': 1000, 'net_amount': 1000, 'items': [], 'customer_name': 'Ravi',
                'payment_splits': {'cash': 300, 'upi': 200}, 'payment_banks': {'upi': str(bank.pk)}}
        with self.captureOnCommitCallbacks(execute=True):
            res = self.client.post('/api/sales/invoices/', body, format='json')
        self.assertEqual(res.status_code, 201, res.content)
        again = self.client.get(f"/api/sales/invoices/{res.data['id']}/").data
        self.assertEqual(again['payment_banks'], {'upi': str(bank.pk), 'bank': None})
        self.assertEqual(balance('100201'), D('200'))

        cash = ChartOfAccount.objects.get(code='1001')
        bad = self.client.post('/api/sales/invoices/', {**body, 'payment_banks': {'upi': str(cash.pk)}}, format='json')
        self.assertEqual(bad.status_code, 400)

    def test_purchase_serializer_drops_stale_bank_and_zeroes_unpaid_cash(self):
        supplier = Supplier.objects.create(name='Hoya', supplier_code='SUP-10')
        bank = make_bank()
        body = {'invoice_number': 'PE-API', 'supplier': str(supplier.pk), 'purchase_date': TODAY.isoformat(),
                'purchase_type': 'CASH', 'payment_method': 'CASH', 'payment_status': 'UNPAID',
                'paid_amount': 500, 'grand_total': 500, 'bank_account': str(bank.pk), 'items': []}
        res = self.client.post('/api/purchase/invoices/', body, format='json')
        self.assertEqual(res.status_code, 201, res.content)
        self.assertIsNone(res.data['bank_account'])
        self.assertEqual(D(res.data['paid_amount']), 0)


class BankMasterApiTests(APITestCase):
    URL = '/api/financial/banks/'

    def setUp(self):
        self.client.force_authenticate(make_user())

    def test_create_edit_default_card_and_deactivate(self):
        res = self.client.post(self.URL, {
            'bank_name': 'SBI', 'account_name': 'SBI ABDU', 'branch_name': 'Kozhikode', 'address': 'Main Rd',
            'account_number': '37287309223', 'account_holder': 'Abdu', 'ifsc_code': 'sbin0001234',
            'is_default_card': True}, format='json')
        self.assertEqual(res.status_code, 201, res.content)
        bank = res.data
        self.assertEqual((bank['code'], bank['sl_no'], bank['ifsc_code']), ('100201', 1, 'SBIN0001234'))
        self.assertTrue(bank['is_default_card'])
        from apps.financial.mapping import resolve_role
        self.assertEqual(str(resolve_role('PAYMENT_CARD').pk), bank['id'])

        # Same A/c number twice and a malformed IFSC are refused.
        dup = self.client.post(self.URL, {'bank_name': 'SBI 2', 'account_number': '37287309223',
                                          'ifsc_code': 'SBIN0001234'}, format='json')
        self.assertEqual(dup.status_code, 400)
        self.assertIn('account_number', dup.data)
        self.assertIn('ifsc_code', self.client.post(self.URL, {'bank_name': 'X', 'ifsc_code': 'BAD'}, format='json').data)

        res = self.client.patch(f"{self.URL}{bank['id']}/", {'account_name': 'SBI Current', 'sl_no': 5}, format='json')
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual((res.data['name'], res.data['sl_no'], res.data['branch_name']), ('SBI Current', 5, 'Kozhikode'))

        # The card-default bank can't be deactivated; once another bank takes cards, it can.
        self.assertEqual(self.client.delete(f"{self.URL}{bank['id']}/").status_code, 400)
        esaf = self.client.post(self.URL, {'bank_name': 'ESAF PRECIUS', 'is_default_card': True}, format='json').data
        self.assertTrue(esaf['is_default_card'])
        res = self.client.delete(f"{self.URL}{bank['id']}/")
        self.assertEqual(res.data['status'], 'Inactive')
        picker = [b['name'] for b in self.client.get('/api/financial/bank-accounts/').data]
        self.assertNotIn('SBI Current', picker)
        self.assertIn('SBI Current', [b['name'] for b in self.client.get(self.URL).data])

    def test_system_bank_cannot_be_deactivated_and_staff_cannot_write(self):
        sys_bank = ChartOfAccount.objects.get(code='1002')
        self.assertEqual(self.client.delete(f"{self.URL}{sys_bank.pk}/").status_code, 400)
        self.client.force_authenticate(make_user('MANAGER', 'mgr'))
        self.assertEqual(self.client.post(self.URL, {'bank_name': 'Y'}, format='json').status_code, 403)
