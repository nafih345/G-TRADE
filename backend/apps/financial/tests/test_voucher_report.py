"""Voucher Reports (Accounts → Reports): one row per RV / PV / CV / JV journal with its
ledger accounts, pay modes, party and Reference No; reversal entries fold into the voucher they
reverse; totals count posted vouchers only."""
import datetime

from rest_framework.test import APITestCase

from apps.financial.models import ChartOfAccount
from apps.financial.services import create_journal, reverse_entry
from apps.sales.models import Invoice, Payment

from .helpers import D, make_user

URL = '/api/financial/reports/vouchers/'
JAN5, JAN10 = datetime.date(2026, 1, 5), datetime.date(2026, 1, 10)


def acc(code):
    return ChartOfAccount.objects.get(code=code)


class VoucherReportTests(APITestCase):
    def setUp(self):
        self.client.force_authenticate(make_user('ACCOUNTANT'))

    def report(self, expect=200, **params):
        params.setdefault('date_from', JAN5)
        params.setdefault('date_to', JAN10)
        res = self.client.get(URL, params)
        self.assertEqual(res.status_code, expect, res.content)
        return res.data

    def voucher(self, code='PV', amount='250', date=JAN5, party='Landlord', reference='', narration='Rent', pay='Cash'):
        cash_bank = acc('1001') if pay == 'Cash' else acc('1002')
        other = acc('2001') if code == 'PV' else acc('1004')
        money_line = {'account': str(cash_bank.pk), 'memo': pay}
        other_line = {'account': str(other.pk), 'memo': narration}
        if code == 'PV':
            lines = [{**other_line, 'debit': amount}, {**money_line, 'credit': amount}]
        else:
            lines = [{**money_line, 'debit': amount}, {**other_line, 'credit': amount}]
        res = self.client.post('/api/financial/journals/', {
            'voucher_type_code': code, 'date': date, 'narration': narration, 'reference_no': party,
            'reference': reference, 'lines': lines}, format='json')
        self.assertEqual(res.status_code, 201, res.content)
        return res.data

    def test_payment_voucher_row(self):
        saved = self.voucher(reference='BILL-77', pay='UPI')
        self.assertEqual(saved['metadata'], {'reference': 'BILL-77'})
        data = self.report(voucher='PV')
        row, = data['rows']
        self.assertEqual((row['voucher_no'], row['party'], row['reference'], row['origin']),
                         (saved['entry_number'], 'Landlord', 'BILL-77', 'manual'))
        self.assertEqual([(a['code'], a['amount']) for a in row['accounts']], [('2001', '250.00')])
        self.assertEqual([(p['mode'], p['amount']) for p in row['payments']], [('UPI', '250.00')])
        self.assertEqual((data['summary']['total'], data['summary']['posted']), ('250.00', 1))
        self.assertEqual(self.report(voucher='RV')['rows'], [])

    def test_filters(self):
        self.voucher(reference='R-1', narration='Rent')
        self.voucher(reference='E-1', narration='Electricity', pay='Bank', date=JAN10)
        self.assertEqual(len(self.report(voucher='PV')['rows']), 2)
        self.assertEqual([r['reference'] for r in self.report(voucher='PV', mode='Bank')['rows']], ['E-1'])
        self.assertEqual([r['reference'] for r in self.report(voucher='PV', search='electric')['rows']], ['E-1'])
        self.assertEqual([r['reference'] for r in self.report(voucher='PV', date_to=JAN5)['rows']], ['R-1'])
        self.assertEqual(len(self.report(voucher='PV', origin='auto')['rows']), 0)
        self.assertEqual(len(self.report(voucher='PV', account=str(acc('2001').pk))['rows']), 2)
        # The journal register finds a voucher by its Reference No too.
        res = self.client.get('/api/financial/journals/', {'search': 'E-1'})
        self.assertEqual(len(res.data['results'] if isinstance(res.data, dict) else res.data), 1)

    def test_reversed_voucher_is_one_row_and_left_out_of_totals(self):
        saved = self.voucher(code='RV', amount='100', party='Asha')
        self.voucher(code='RV', amount='40', party='Ravi')
        reversal = reverse_entry(saved['id'], reason='Typo')
        data = self.report(voucher='RV')
        self.assertEqual(len(data['rows']), 2)
        rev = next(r for r in data['rows'] if r['party'] == 'Asha')
        self.assertEqual((rev['status'], rev['reversed_by']), ('REVERSED', reversal.entry_number))
        s = data['summary']
        self.assertEqual((s['total'], s['posted'], s['reversed']), ('40.00', 1, 1))
        self.assertEqual([r['party'] for r in self.report(voucher='RV', status='REVERSED')['rows']], ['Asha'])

    def test_automated_receipt_is_listed_with_its_bill(self):
        with self.captureOnCommitCallbacks(execute=True):
            inv = Invoice.objects.create(invoice_number='INV-9', invoice_date=JAN5, customer_name='Meera',
                                         total_amount=D('500'), net_amount=D('500'))
            Payment.objects.create(invoice=inv, amount=D('300'), method='Card', source='BILLING',
                                   payment_date=JAN5, customer_name='Meera')
        row, = self.report(voucher='RV', origin='auto')['rows']
        self.assertEqual((row['reference'], row['party'], row['origin']), ('INV-9', 'Meera', 'auto'))
        self.assertEqual([(p['mode'], p['amount']) for p in row['payments']], [('Card', '300.00')])
        self.assertEqual(self.report(voucher='RV', origin='manual')['rows'], [])

    def post(self, code, lines, expect=201, **extra):
        res = self.client.post('/api/financial/journals/', {
            'voucher_type_code': code, 'date': JAN5, 'lines': lines, **extra}, format='json')
        self.assertEqual(res.status_code, expect, res.content)
        return res.data

    def test_contra_entry_row_shows_from_and_to(self):
        cash, bank = acc('1001'), acc('1002')
        saved = self.post('CV', [{'account': str(bank.pk), 'debit': '1000', 'memo': 'Deposit'},
                                 {'account': str(cash.pk), 'credit': '1000', 'memo': 'Cash'}],
                          reference='SLIP-4', narration='Cash deposited')
        row, = self.report(voucher='CV')['rows']
        self.assertEqual((row['voucher_no'], row['reference'], row['amount'], row['origin_label']),
                         (saved['entry_number'], 'SLIP-4', '1000.00', 'Contra Entry'))
        self.assertEqual([(d['code'], d['amount']) for d in row['debits']], [('1002', '1000.00')])
        self.assertEqual([(c['code'], c['amount']) for c in row['credits']], [('1001', '1000.00')])
        self.assertEqual(self.report(voucher='CV')['title'], 'Contra Entry')
        self.assertEqual(len(self.report(voucher='CV', search='deposit')['rows']), 1)

    def test_contra_entry_refuses_non_cash_accounts(self):
        self.post('CV', [{'account': str(acc('2001').pk), 'debit': '50'},
                         {'account': str(acc('1001').pk), 'credit': '50'}], expect=400)

    def test_journal_voucher_row_and_balance_rule(self):
        cogs, payable, expense = acc('5001'), acc('2001'), acc('5050')
        saved = self.post('JV', [{'account': str(cogs.pk), 'debit': '70', 'memo': 'Part A'},
                                 {'account': str(expense.pk), 'debit': '30'},
                                 {'account': str(payable.pk), 'credit': '100', 'memo': 'Accrual'}],
                          reference='ADJ-1', narration='Month-end accrual')
        row, = self.report(voucher='JV')['rows']
        self.assertEqual((row['voucher_no'], row['reference'], row['amount'], row['origin']),
                         (saved['entry_number'], 'ADJ-1', '100.00', 'manual'))
        self.assertEqual(sorted((d['code'], d['amount'], d['memo']) for d in row['debits']),
                         [('5001', '70.00', 'Part A'), ('5050', '30.00', '')])
        self.assertEqual([(c['code'], c['amount']) for c in row['credits']], [('2001', '100.00')])
        self.assertEqual(self.report(voucher='JV', search='accrual')['summary']['total'], '100.00')
        # Unbalanced journals are refused by the posting service.
        self.post('JV', [{'account': str(cogs.pk), 'debit': '70'},
                         {'account': str(payable.pk), 'credit': '60'}], expect=400)
        self.assertEqual(len(self.report(voucher='JV')['rows']), 1)

    def test_bad_params(self):
        self.report(expect=400, voucher='SV')
        self.report(expect=400, voucher='PV', date_from=JAN10, date_to=JAN5)
