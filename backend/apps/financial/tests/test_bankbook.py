"""Bank Book: only posted movements on bank accounts, with mode / reference / party, balances that
reconcile, editable UTR details, and pending bank settlements that never touch the balance."""
import datetime

from rest_framework.test import APITestCase

from apps.company.models import Branch, BusinessSettings, UserBranchAccess
from apps.financial.models import BankEntryDetail, PendingBankSettlement
from apps.financial.services import create_journal, reverse_entry
from apps.sales.models import Invoice, Payment

from .helpers import D, TODAY, account, make_user, make_warehouse
from .test_cheques import cheque
from .test_payment_banks import make_bank

FIN = '/api/financial'
URL = f'{FIN}/reports/bankbook/'
PENDING = f'{FIN}/bankbook/pending/'
JAN1, JAN5, JAN10, JAN20 = (datetime.date(2026, 1, d) for d in (1, 5, 10, 20))
FEB1 = datetime.date(2026, 2, 1)


def post(code, dr, cr, amount, date, memo='', **kw):
    return create_journal(lines=[{'account': dr, 'debit': amount, 'memo': memo}, {'account': cr, 'credit': amount, 'memo': memo}],
                          date=date, voucher_type_code=code, source_module='financial', source_event='voucher', **kw)


class BankBookBase(APITestCase):
    def setUp(self):
        self.user = make_user('ACCOUNTANT')
        self.client.force_authenticate(self.user)
        self.bank = account('1002')
        self.cash = account('1001')

    def book(self, **params):
        params.setdefault('account', str(self.bank.pk))
        res = self.client.get(URL, params)
        self.assertEqual(res.status_code, 200, res.content)
        return res.data

    def opening(self, amount=D('10000'), date=JAN1, acc=None):
        return create_journal(lines=[{'account': acc or self.bank, 'debit': amount},
                                     {'account': account('3001'), 'credit': amount}],
                              date=date, voucher_type_code='OB', source_module='financial',
                              source_event='opening_balance', reference_type='OPENING_BALANCE')

    def assertReconciles(self, data):
        s = data['summary']
        self.assertEqual(D(s['closing_balance']),
                         D(s['opening_balance']) + D(s['total_deposits']) - D(s['total_withdrawals']))


class BankBookLedgerTests(BankBookBase):
    def test_sale_receipts_only_bank_modes_with_party_and_mode(self):
        with self.captureOnCommitCallbacks(execute=True):
            inv = Invoice.objects.create(invoice_number='INV-1', invoice_date=JAN5, customer_name='Asha',
                                         total_amount=D('1000'), net_amount=D('1000'))
            Payment.objects.create(invoice=inv, amount=D('300'), method='Cash', payment_date=JAN5)
            Payment.objects.create(invoice=inv, amount=D('500'), method='UPI', payment_date=JAN5)
            Payment.objects.create(invoice=inv, amount=D('200'), method='Card', payment_date=JAN5)
        rows = self.book()['rows']
        self.assertEqual(sorted((r['voucher_kind'], r['txn_type'], r['mode'], r['deposit'], r['party'], r['bill_number'])
                                for r in rows),
                         [('CUSTOMER_RECEIPT', 'CREDIT', 'CARD', '200.00', 'Asha', 'INV-1'),
                          ('CUSTOMER_RECEIPT', 'CREDIT', 'UPI', '500.00', 'Asha', 'INV-1')])
        self.assertTrue(all(r['time'] and r['bank_account'].startswith('1002') for r in rows))

    def test_balances_reconcile_and_carry_across_pages(self):
        self.opening()
        for i, amount in enumerate((D('5000'), D('2500'), D('750.50'))):
            post('RV', self.bank, account('1004'), amount, JAN5 + datetime.timedelta(days=i), memo='NEFT UTR00%d' % i)
        post('PV', account('2001'), self.bank, D('4000'), JAN10, memo='RTGS')
        data = self.book(date_from=JAN5, date_to=JAN20)
        s = data['summary']
        self.assertEqual((s['opening_balance'], s['total_deposits'], s['total_withdrawals'], s['closing_balance']),
                         ('10000.00', '8250.50', '4000.00', '14250.50'))
        self.assertReconciles(data)
        self.assertEqual([r['mode'] for r in data['rows']], ['NEFT', 'NEFT', 'NEFT', 'RTGS'])
        self.assertEqual(data['rows'][0]['reference'], 'UTR000')
        self.assertEqual(data['rows'][-1]['txn_type'], 'DEBIT')
        page2 = self.book(date_from=JAN5, date_to=JAN20, page=2, page_size=2)
        self.assertEqual([r['balance'] for r in page2['rows']], ['18250.50', '14250.50'])
        self.assertEqual([r['row_no'] for r in page2['rows']], [3, 4])

    def test_cash_deposit_withdrawal_and_bank_charges(self):
        post('CV', self.bank, self.cash, D('2000'), JAN5)
        post('CV', self.cash, self.bank, D('500'), JAN10)
        post('PV', account('5130'), self.bank, D('25'), JAN10, narration='SMS charges')
        rows = self.book()['rows']
        self.assertEqual([(r['voucher_kind'], r['mode'], r['party']) for r in rows],
                         [('CASH_DEPOSIT', 'CASH', ''), ('CASH_WITHDRAWAL', 'CASH', ''), ('BANK_CHARGES', 'BANK_TRANSFER', rows[2]['particulars'])])

    def test_transfer_between_banks_shows_both_sides_in_all(self):
        hdfc = make_bank()
        self.opening(D('1000'))
        post('CV', hdfc, self.bank, D('400'), JAN5, memo='IMPS')
        one = self.book()
        self.assertEqual([(r['voucher_kind'], r['withdrawal']) for r in one['rows'][1:]], [('TRANSFER_OUT', '400.00')])
        both = self.book(account='all')
        kinds = [(r['voucher_kind'], r['bank_account_id']) for r in both['rows'] if r['voucher_kind'] != 'OPENING']
        self.assertEqual(sorted(kinds), sorted([('TRANSFER_OUT', str(self.bank.pk)), ('TRANSFER_IN', str(hdfc.pk))]))
        self.assertEqual(both['summary']['closing_balance'], '1000.00')
        per = {a['id']: a['closing'] for a in both['summary']['by_account']}
        self.assertEqual((per[str(self.bank.pk)], per[str(hdfc.pk)]), ('600.00', '400.00'))
        self.assertReconciles(both)

    def test_excludes_cash_only_and_hides_reversed_pairs(self):
        post('RV', self.cash, account('1004'), D('900'), JAN5)
        bad = post('RV', self.bank, account('1004'), D('100'), JAN5)
        reverse_entry(bad, reason='typo')
        self.assertEqual(self.book()['rows'], [])
        self.assertEqual(self.book()['summary']['hidden_reversals'], 2)
        self.assertEqual(len(self.book(show_reversed=1)['rows']), 2)

    def test_cheque_voucher_gives_mode_reference_and_status(self):
        with self.captureOnCommitCallbacks(execute=True):
            res = self.client.post(f'{FIN}/journals/', {
                'voucher_type_code': 'RV', 'date': str(TODAY), 'reference_no': 'Asha Menon', 'idempotency_key': 'k1',
                'lines': [{'account': str(self.bank.pk), 'debit': '750', 'memo': 'Cheque', 'cheque': cheque('778899')},
                          {'account': account('4001').pk.hex, 'credit': '750'}]}, format='json')
        self.assertEqual(res.status_code, 201, res.data)
        row, = self.book()['rows']
        self.assertEqual((row['mode'], row['reference'], row['cheque_status'], row['party']),
                         ('CHEQUE', '778899', 'PENDING', 'Asha Menon'))
        self.assertEqual(self.book()['summary']['uncleared_cheques_received']['amount'], '750.00')

    def test_filters_narrow_rows_not_summary(self):
        post('RV', self.bank, account('1004'), D('100'), JAN5, memo='UPI')
        post('RV', self.bank, account('1004'), D('200'), JAN5, memo='NEFT')
        post('PV', account('2001'), self.bank, D('50'), JAN10, memo='NEFT')
        data = self.book(type='DEBIT')
        self.assertEqual([r['withdrawal'] for r in data['rows']], ['50.00'])
        self.assertEqual(data['summary']['closing_balance'], '250.00')
        data = self.book(mode='NEFT')
        self.assertEqual((data['matched']['deposits'], data['matched']['withdrawals']), ('200.00', '50.00'))
        self.assertEqual([r['balance'] for r in data['rows']], ['300.00', '250.00'])
        self.assertEqual(self.client.get(URL, {'mode': 'BOGUS'}).status_code, 400)

    def test_entry_detail_sets_utr_and_is_searchable(self):
        je = post('RV', self.bank, account('1004'), D('100'), JAN5)
        url = f'{FIN}/bankbook/entries/{je.pk}/{self.bank.pk}/'
        res = self.client.put(url, {'reference': 'UTR998877', 'mode': 'IMPS', 'value_date': str(JAN10)}, format='json')
        self.assertEqual(res.status_code, 200, res.data)
        row, = self.book(search='998877')['rows']
        self.assertEqual((row['reference'], row['mode'], row['value_date'], row['reference_is_set']),
                         ('UTR998877', 'IMPS', '2026-01-10', True))
        self.assertEqual(self.client.put(f'{FIN}/bankbook/entries/{je.pk}/{self.cash.pk}/', {'reference': 'x'},
                                         format='json').status_code, 400)
        self.assertEqual(self.client.put(url, {'value_date': str(JAN1)}, format='json').status_code, 400)
        self.assertEqual(BankEntryDetail.objects.count(), 1)

    def test_accounts_list_and_rejects_non_bank(self):
        accounts = self.client.get(f'{URL}accounts/').data['accounts']
        codes = [a['code'] for a in accounts]
        self.assertIn('1002', codes)
        self.assertNotIn('1001', codes)
        self.assertTrue(next(a for a in accounts if a['code'] == '1002')['is_default'])
        self.assertEqual(self.client.get(URL, {'account': str(self.cash.pk)}).status_code, 400)
        self.assertEqual(self.client.get(URL, {'date_from': str(FEB1), 'date_to': str(JAN1)}).status_code, 400)

    def test_requires_a_finance_role(self):
        self.client.force_authenticate(make_user('SALES_EXECUTIVE', username='seller'))
        self.assertEqual(self.client.get(URL).status_code, 403)
        self.assertEqual(self.client.get(PENDING).status_code, 403)


class PendingSettlementTests(BankBookBase):
    def create(self, **kw):
        body = {'direction': 'RECEIVE', 'party_kind': 'customer', 'party_name': 'Asha Menon', 'amount': '1500',
                'agreed_date': str(TODAY), 'expected_date': str(TODAY + datetime.timedelta(days=3)),
                'bank_account': str(self.bank.pk), 'mode': 'NEFT', 'bill_numbers': 'INV-9'}
        body.update(kw)
        return self.client.post(PENDING, body, format='json')

    def test_create_list_and_projected_balance(self):
        self.opening(D('1000'), date=TODAY)
        res = self.create()
        self.assertEqual(res.status_code, 201, res.data)
        self.assertTrue(res.data['number'].startswith(f'PBS-{TODAY.year}-'))
        self.assertEqual(self.create(direction='PAY', party_kind='supplier', party_name='Lens Lab', amount='400',
                                     expected_date=str(TODAY)).status_code, 201)
        data = self.client.get(PENDING).data
        self.assertEqual((data['summary']['to_receive']['amount'], data['summary']['to_pay']['amount']), ('1500.00', '400.00'))
        self.assertEqual(data['summary']['due_today']['count'], 1)
        s = self.book()['summary']
        self.assertEqual((s['closing_balance'], s['projected_balance']), ('1000.00', '2100.00'))
        self.assertEqual(self.client.get(PENDING, {'direction': 'PAY'}).data['count'], 1)

    def test_validation(self):
        self.assertEqual(self.create(amount='0').status_code, 400)
        self.assertEqual(self.create(party_name=' ').status_code, 400)
        self.assertEqual(self.create(expected_date=str(TODAY - datetime.timedelta(days=1))).status_code, 400)
        self.assertEqual(self.create(bank_account=str(self.cash.pk)).status_code, 400)

    def test_settle_links_voucher_and_carries_utr(self):
        row = self.create(reference='UTR5550001').data
        je = post('RV', self.bank, account('1004'), D('1500'), TODAY)
        matches = self.client.get(f"{PENDING}{row['id']}/matches/").data['results']
        self.assertEqual(matches[0]['entry_id'], str(je.pk))
        self.assertTrue(matches[0]['exact_amount'])
        res = self.client.patch(f"{PENDING}{row['id']}/", {'status': 'SETTLED', 'voucher_number': je.entry_number},
                                format='json')
        self.assertEqual(res.status_code, 200, res.data)
        self.assertEqual((res.data['status'], res.data['voucher_number'], res.data['settled_amount']),
                         ('SETTLED', je.entry_number, '1500.00'))
        bank_row, = self.book()['rows']
        self.assertEqual((bank_row['reference'], bank_row['settlements']), ('UTR5550001', [row['number']]))
        self.assertEqual(self.book()['summary']['pending_receive']['count'], 0)
        # Undo, then cancelling needs a reason.
        self.assertEqual(self.client.patch(f"{PENDING}{row['id']}/", {'status': 'PENDING'}, format='json').data['journal_entry'], None)
        self.assertEqual(self.client.patch(f"{PENDING}{row['id']}/", {'status': 'CANCELLED'}, format='json').status_code, 400)
        res = self.client.patch(f"{PENDING}{row['id']}/", {'status': 'CANCELLED', 'status_note': 'paid in cash'}, format='json')
        self.assertEqual(res.data['status'], 'CANCELLED')
        self.assertEqual(self.client.patch(f"{PENDING}{row['id']}/", {'status': 'SETTLED'}, format='json').status_code, 400)

    def test_settle_with_unknown_voucher_is_refused(self):
        row = self.create().data
        res = self.client.patch(f"{PENDING}{row['id']}/", {'status': 'SETTLED', 'voucher_number': 'NOPE-1'}, format='json')
        self.assertEqual(res.status_code, 400)
        self.assertEqual(PendingBankSettlement.objects.get().status, 'PENDING')

    def test_overdue_filter(self):
        PendingBankSettlement.objects.create(number='PBS-X-1', direction='RECEIVE', party_name='Old', amount=D('10'),
                                             agreed_date=TODAY - datetime.timedelta(days=9),
                                             expected_date=TODAY - datetime.timedelta(days=2))
        self.create()
        data = self.client.get(PENDING, {'due': 'overdue'}).data
        self.assertEqual([r['party_name'] for r in data['rows']], ['Old'])
        self.assertEqual(data['rows'][0]['days_left'], -2)


class BankBookBranchTests(BankBookBase):
    def setUp(self):
        super().setUp()
        self.main = make_warehouse().branch
        self.north = Branch.objects.create(company=self.main.company, name='North', code='NTH')
        settings_obj = BusinessSettings.load()
        settings_obj.multi_branch_enabled = True
        settings_obj.save()
        post('RV', self.bank, account('1004'), D('100'), JAN5, branch=self.main)
        post('RV', self.bank, account('1004'), D('30'), JAN10, branch=self.north)

    def test_restricted_user_only_sees_their_branches(self):
        access = UserBranchAccess.objects.create(username='nina')
        access.branches.add(self.north)
        headers = {'HTTP_X_USER_NAME': 'nina', 'HTTP_X_USER_ROLE': 'ACCOUNTANT'}
        res = self.client.get(URL, {'account': str(self.bank.pk), 'branch': str(self.main.pk)}, **headers)
        self.assertEqual(res.status_code, 403)
        res = self.client.get(URL, {'account': str(self.bank.pk), 'branch': 'all'}, **headers)
        self.assertEqual([r['deposit'] for r in res.data['rows']], ['30.00'])
