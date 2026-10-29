"""Cheque details on Receipt / Payment Vouchers (normal and bill-to-bill) and the Cheque Register."""
import datetime

from rest_framework.test import APITestCase

from apps.financial.models import Cheque, JournalEntry
from apps.purchasing.models import PurchaseInvoice, Supplier
from apps.sales.models import Customer, Invoice, Payment

from .helpers import D, TODAY, account, balance, ledger_is_balanced, make_user
from .test_payment_banks import make_bank

FIN = '/api/financial'


def cheque(number='000123', when=TODAY, **kw):
    return dict({'cheque_number': number, 'cheque_date': str(when), 'bank_name': 'SBI Kochi'}, **kw)


class ChequeApiBase(APITestCase):
    def setUp(self):
        self.user = make_user('ACCOUNTANT')
        self.client.force_authenticate(self.user)
        self.bank = make_bank()

    def post(self, path, body):
        with self.captureOnCommitCallbacks(execute=True):
            return self.client.post(f'{FIN}/{path}', body, format='json')

    def voucher(self, code='RV', amount='5000', chq=None, key='v-1', **kw):
        bank_line = {'account': str(self.bank.pk), 'memo': 'Cheque', 'cheque': chq if chq is not None else cheque()}
        other = {'account': account('4001' if code == 'RV' else '5100').pk.hex}
        if code == 'RV':
            lines = [dict(bank_line, debit=amount), dict(other, credit=amount)]
        else:
            lines = [dict(other, debit=amount), dict(bank_line, credit=amount)]
        body = {'voucher_type_code': code, 'date': str(TODAY), 'reference_no': 'Asha Menon',
                'idempotency_key': key, 'lines': lines}
        body.update(kw)
        return self.post('journals/', body)


class NormalVoucherChequeTests(ChequeApiBase):
    def test_receipt_voucher_records_one_received_cheque(self):
        res = self.voucher(chq=cheque(deposited_date=str(TODAY + datetime.timedelta(days=3)), remarks='PDC'))
        self.assertEqual(res.status_code, 201, res.data)
        c = Cheque.objects.get()
        self.assertEqual((c.direction, c.voucher_type, c.voucher_number), ('RECEIVED', 'RV', res.data['entry_number']))
        self.assertEqual((c.amount, c.bank_account_id, c.party_name, c.status), (D('5000'), self.bank.pk, 'Asha Menon', 'PENDING'))
        self.assertEqual(c.journal_entry_id.hex, res.data['id'].replace('-', ''))
        self.assertEqual(balance(self.bank.code), D('5000'))

        # A retried save (same key) posts nothing twice — journal or cheque.
        again = self.voucher()
        self.assertEqual(again.data['id'], res.data['id'])
        self.assertEqual(Cheque.objects.count(), 1)

    def test_payment_voucher_records_an_issued_cheque(self):
        res = self.voucher('PV', amount='1200', chq=cheque('900001', party_name='Landlord'))
        self.assertEqual(res.status_code, 201, res.data)
        c = Cheque.objects.get()
        self.assertEqual((c.direction, c.amount, c.party_name), ('ISSUED', D('1200'), 'Landlord'))

    def test_bad_cheque_payloads_are_refused_and_nothing_posts(self):
        # Cheque on the wrong side of the voucher.
        body = {'voucher_type_code': 'RV', 'date': str(TODAY), 'idempotency_key': 'bad-1', 'lines': [
            {'account': str(self.bank.pk), 'debit': '100'},
            {'account': account('4001').pk.hex, 'credit': '100', 'cheque': cheque()}]}
        self.assertEqual(self.post('journals/', body).status_code, 400)
        # Not on contra / journal vouchers, nor on drafts.
        self.assertEqual(self.voucher(key='bad-2', voucher_type_code='JV').status_code, 400)
        self.assertEqual(self.voucher(key='bad-3', status='DRAFT').status_code, 400)
        # Deposited before the cheque date; blank number.
        self.assertEqual(self.voucher(key='bad-4', chq=cheque(deposited_date=str(TODAY - datetime.timedelta(days=1)))).status_code, 400)
        self.assertEqual(self.voucher(key='bad-5', chq=cheque('  ')).status_code, 400)
        self.assertFalse(JournalEntry.objects.exists())
        self.assertFalse(Cheque.objects.exists())

    def test_same_cheque_twice_is_refused_until_cancelled(self):
        first = self.voucher()
        self.assertEqual(first.status_code, 201)
        dup = self.voucher(key='v-2', chq=cheque('000123', bank_name='sbi kochi'))
        self.assertEqual(dup.status_code, 400)
        self.assertIn('already recorded', dup.data['error'])
        self.assertEqual(JournalEntry.objects.count(), 1)   # the voucher rolled back with its cheque
        # Same number on another bank is a different cheque.
        self.assertEqual(self.voucher(key='v-3', chq=cheque('000123', bank_name='HDFC')).status_code, 201)

    def test_reversing_the_voucher_cancels_its_cheque(self):
        res = self.voucher()
        rev = self.client.post(f"{FIN}/journals/{res.data['id']}/reverse/", {'reason': 'bounced'}, format='json')
        self.assertEqual(rev.status_code, 200, rev.data)
        c = Cheque.objects.get()
        self.assertEqual(c.status, 'CANCELLED')
        self.assertIn(res.data['entry_number'], c.status_note)
        # Once cancelled, the number is free again.
        self.assertEqual(self.voucher(key='v-2').status_code, 201)


class BillToBillChequeTests(ChequeApiBase):
    def setUp(self):
        super().setUp()
        with self.captureOnCommitCallbacks(execute=True):
            self.asha = Customer.objects.create(name='Asha Menon', phone='9847012345')
            self.inv = Invoice.objects.create(invoice_number='INV-C1', invoice_date=TODAY, customer=self.asha,
                                              customer_name='Asha Menon', total_amount=D('1000'), net_amount=D('1000'))

    def receipt(self, payments, key='r-1'):
        return self.post('settlements/receipt/', {
            'party_kind': 'customer', 'party': str(self.asha.pk), 'date': str(TODAY), 'idempotency_key': key,
            'allocations': [{'bill': str(self.inv.pk), 'amount': '1000'}], 'payments': payments})

    def test_split_cash_and_cheque_receipt(self):
        res = self.receipt([{'method': 'Cash', 'amount': '400'},
                            {'method': 'Cheque', 'amount': '600', 'bank_account': str(self.bank.pk),
                             'ref_no': '445566', 'cheque': cheque('445566')}])
        self.assertEqual(res.status_code, 201, res.data)
        c = Cheque.objects.get()
        self.assertEqual((c.direction, c.amount, c.voucher_number), ('RECEIVED', D('600'), res.data['number']))
        self.assertEqual((c.party_kind, c.party_id, c.party_name), ('customer', str(self.asha.pk), 'Asha Menon'))
        self.assertEqual(c.bank_account_id, self.bank.pk)
        self.assertEqual(Payment.objects.filter(receipt_no__startswith=res.data['number']).count(), 2)
        self.assertEqual(balance(self.bank.code), D('600'))
        self.assertTrue(ledger_is_balanced())
        self.assertEqual(self.receipt([{'method': 'Cash', 'amount': '400'},
                                       {'method': 'Cheque', 'amount': '600', 'cheque': cheque('445566')}]).status_code, 200)
        self.assertEqual(Cheque.objects.count(), 1)

    def test_cheque_method_needs_details_and_only_cheques_take_them(self):
        self.assertEqual(self.receipt([{'method': 'Cheque', 'amount': '1000'}]).status_code, 400)
        self.assertEqual(self.receipt([{'method': 'Cash', 'amount': '1000', 'cheque': cheque()}], key='r-2').status_code, 400)
        self.assertFalse(Payment.objects.exists())

    def test_one_cheque_split_over_two_suppliers_is_one_record(self):
        from apps.purchasing.supplier_utils import get_or_create_supplier_ledger_account
        sups, bills = [], []
        with self.captureOnCommitCallbacks(execute=True):
            for n, name in enumerate(('Essilor', 'Zeiss'), start=1):
                s = Supplier.objects.create(name=name, supplier_code=f'SUP-{n}', outstanding_balance=D('500'))
                s.ledger_account = get_or_create_supplier_ledger_account(s)
                s.save()
                sups.append(s)
                bills.append(PurchaseInvoice.objects.create(invoice_number=f'PE-C{n}', supplier=s, purchase_date=TODAY,
                                                            purchase_type='CREDIT', payment_method='CREDIT',
                                                            grand_total=D('500')))
        piece = cheque('777001', bank_name='', ref='line-9')
        res = self.post('settlements/batch/pv/', {'settlements': [
            {'party_kind': 'supplier', 'party': str(s.pk), 'date': str(TODAY), 'idempotency_key': f'b:{s.pk}',
             'allocations': [{'bill': str(b.pk), 'amount': '500'}],
             'payments': [{'method': 'Cheque', 'amount': '500', 'bank_account': str(self.bank.pk), 'cheque': piece}]}
            for s, b in zip(sups, bills)]})
        self.assertEqual(res.status_code, 201, res.data)
        c = Cheque.objects.get()
        self.assertEqual((c.direction, c.amount), ('ISSUED', D('1000')))
        self.assertEqual(c.voucher_number, ', '.join(r['entry_number'] for r in res.data['results']))
        self.assertEqual(balance(self.bank.code), D('-1000'))


class ChequeRegisterTests(ChequeApiBase):
    def setUp(self):
        super().setUp()
        self.voucher(key='a', chq=cheque('A1', when=TODAY - datetime.timedelta(days=5)))                 # overdue
        self.voucher(key='b', chq=cheque('B2', when=TODAY + datetime.timedelta(days=3), bank_name='Canara'))  # due this week
        self.voucher('PV', key='c', amount='750', chq=cheque('C3', when=TODAY + datetime.timedelta(days=30)))

    def register(self, **params):
        res = self.client.get(f'{FIN}/cheques/', params)
        self.assertEqual(res.status_code, 200, res.data)
        return res.data

    def test_rows_days_left_filters_and_summary(self):
        data = self.register()
        self.assertEqual([r['cheque_number'] for r in data['rows']], ['A1', 'B2', 'C3'])   # soonest due first
        self.assertEqual([r['days_left'] for r in data['rows']], [-5, 3, 30])
        s = data['summary']
        self.assertEqual((s['overdue']['count'], D(s['overdue']['amount'])), (1, D('5000')))
        self.assertEqual(s['due_week']['count'], 1)
        self.assertEqual((s['received_open']['count'], s['issued_open']['count']), (2, 1))
        self.assertEqual(D(s['total']['amount']), D('10750'))

        self.assertEqual([r['cheque_number'] for r in self.register(direction='ISSUED')['rows']], ['C3'])
        self.assertEqual([r['cheque_number'] for r in self.register(due='overdue')['rows']], ['A1'])
        self.assertEqual([r['cheque_number'] for r in self.register(search='canara')['rows']], ['B2'])
        self.assertEqual([r['cheque_number'] for r in self.register(date_from=str(TODAY))['rows']], ['B2', 'C3'])
        self.assertEqual(self.client.get(f'{FIN}/cheques/', {'status': 'NOPE'}).status_code, 400)
        export = self.register(export=1, page_size=1)
        self.assertEqual(len(export['rows']), 3)

    def test_status_workflow(self):
        c = Cheque.objects.get(cheque_number='A1')
        url = f'{FIN}/cheques/{c.pk}/'
        dep = self.client.patch(url, {'status': 'DEPOSITED'}, format='json')
        self.assertEqual(dep.status_code, 200, dep.data)
        self.assertEqual((dep.data['status'], dep.data['deposited_date']), ('DEPOSITED', TODAY))
        self.assertEqual(dep.data['days_left'], 0)
        done = self.client.patch(url, {'status': 'CLEARED'}, format='json')
        self.assertEqual((done.data['status'], done.data['cleared_date'], done.data['days_left']), ('CLEARED', TODAY, None))
        self.assertEqual(self.client.patch(url, {'status': 'BOUNCED'}, format='json').status_code, 400)
        self.assertEqual(self.client.patch(url, {'bank_name': 'Other'}, format='json').status_code, 400)
        self.assertEqual(self.client.patch(url, {'status': 'DEPOSITED'}, format='json').data['cleared_date'], None)

        b = Cheque.objects.get(cheque_number='B2')
        burl = f'{FIN}/cheques/{b.pk}/'
        # Deposit date before the cheque date is refused; a bounced cheque can be presented again.
        self.assertEqual(self.client.patch(burl, {'status': 'DEPOSITED', 'deposited_date': str(TODAY)}, format='json').status_code, 400)
        self.assertEqual(self.client.patch(burl, {'status': 'BOUNCED', 'status_note': 'Funds insufficient'}, format='json').status_code, 200)
        self.assertEqual(self.client.patch(burl, {'status': 'PENDING'}, format='json').data['status'], 'PENDING')
        self.assertEqual(self.client.patch(burl, {'status': 'CANCELLED'}, format='json').status_code, 200)
        self.assertEqual(self.client.patch(burl, {'remarks': 'x'}, format='json').status_code, 400)
        # Tracking only: nothing was posted by any of this.
        self.assertEqual(JournalEntry.objects.count(), 3)

    def test_finance_role_required(self):
        self.client.force_authenticate(make_user('CASHIER', username='cashier'))
        self.assertEqual(self.client.get(f'{FIN}/cheques/').status_code, 403)
