"""Accounts → Transaction Report: every cash and bank movement from the ledger, balances that
reconcile per channel, tracking details on cash and bank rows, in-place narration fixes, and
manual-voucher corrections by reversal + re-post. Plus the two Statements built on it."""
import datetime

from rest_framework.test import APITestCase

from apps.financial.models import BankEntryDetail, ChartOfAccount, FinancialAuditLog, JournalEntry
from apps.financial.services import create_journal, reverse_entry
from apps.sales.models import Invoice, Payment

from .helpers import D, account, ledger_is_balanced, make_user

FIN = '/api/financial'
URL = f'{FIN}/reports/transactions/'
JAN1, JAN10, JAN20, JAN31 = (datetime.date(2026, 1, d) for d in (1, 10, 20, 31))
FEB5 = datetime.date(2026, 2, 5)


def post(code, dr, cr, amount, date, **kw):
    kw.setdefault('source_module', 'financial')
    kw.setdefault('source_event', 'voucher')
    return create_journal(lines=[{'account': account(dr), 'debit': amount}, {'account': account(cr), 'credit': amount}],
                          date=date, voucher_type_code=code, **kw)


class TransactionReportBase(APITestCase):
    def setUp(self):
        self.client.force_authenticate(make_user('ACCOUNTANT'))
        self.ob = post('OB', '1001', '3001', D('50000'), JAN1, source_event='opening_balance')
        self.cv = post('CV', '1002', '1001', D('20000'), JAN10)                         # cash -> bank
        self.rv = post('RV', '1001', '4003', D('3000'), JAN20, narration='Eye test fees')
        self.pv = post('PV', '5100', '1002', D('1500'), JAN20, narration='Shop rent')
        post('PV', '5100', '1001', D('700'), FEB5, narration='Next month')

    def report(self, **params):
        params.setdefault('date_from', JAN1)
        params.setdefault('date_to', JAN31)
        res = self.client.get(URL, params)
        self.assertEqual(res.status_code, 200, res.content)
        return res.data


class TransactionReportTests(TransactionReportBase):
    def test_every_cash_and_bank_movement_with_reconciling_balances(self):
        data = self.report()
        s = data['summary']
        self.assertEqual((s['opening_balance'], s['total_in'], s['total_out'], s['closing_balance']),
                         ('0.00', '73000.00', '21500.00', '51500.00'))
        self.assertEqual((s['cash']['closing'], s['bank']['closing']), ('33000.00', '18500.00'))
        rows = sorted((r['entry_number'][:2], r['channel'], r['direction'], r['amount_in'] or r['amount_out'], r['kind'])
                      for r in data['rows'])
        self.assertEqual(len(rows), 5)  # the contra shows on both accounts
        contra = [r for r in data['rows'] if r['entry_id'] == str(self.cv.pk)]
        self.assertEqual(sorted((r['channel'], r['direction'], r['kind']) for r in contra),
                         [('BANK', 'IN', 'CASH_DEPOSIT'), ('CASH', 'OUT', 'CASH_DEPOSIT')])
        cash_rv = next(r for r in data['rows'] if r['entry_id'] == str(self.rv.pk))
        self.assertEqual((cash_rv['mode'], cash_rv['origin'], cash_rv['can_correct']), ('CASH', 'manual', True))
        self.assertEqual(data['rows'][-1]['balance'], '51500.00')

    def test_channel_account_and_opening(self):
        data = self.report(channel='cash', date_from=JAN10)
        self.assertTrue(all(r['channel'] == 'CASH' for r in data['rows']))
        s = data['summary']
        self.assertEqual((s['opening_balance'], s['total_in'], s['total_out'], s['closing_balance']),
                         ('50000.00', '3000.00', '20000.00', '33000.00'))
        bank = self.report(account=str(account('1002').pk))
        self.assertEqual(bank['summary']['closing_balance'], '18500.00')

    def test_filters_narrow_rows_not_summary(self):
        data = self.report(direction='OUT')
        self.assertEqual(sorted(r['amount_out'] for r in data['rows']), ['1500.00', '20000.00'])
        self.assertEqual(data['matched']['out'], '21500.00')
        self.assertEqual(data['summary']['total_in'], '73000.00')
        self.assertEqual([r['narration'] for r in self.report(search='rent')['rows']], ['Shop rent'])
        self.assertEqual(self.client.get(URL, {'direction': 'SIDEWAYS'}).status_code, 400)

    def test_automated_receipts_appear_and_are_not_correctable(self):
        with self.captureOnCommitCallbacks(execute=True):
            inv = Invoice.objects.create(invoice_number='INV-T1', invoice_date=JAN20, customer_name='Asha',
                                         total_amount=D('900'), net_amount=D('900'))
            Payment.objects.create(invoice=inv, amount=D('400'), method='Cash', payment_date=JAN20)
            Payment.objects.create(invoice=inv, amount=D('500'), method='UPI', payment_date=JAN20)
        rows = [r for r in self.report(origin='auto')['rows']]
        self.assertEqual(sorted((r['channel'], r['amount_in'], r['party']) for r in rows),
                         [('BANK', '500.00', 'Asha'), ('CASH', '400.00', 'Asha')])
        self.assertTrue(all(not r['can_correct'] for r in rows))

    def test_reversed_pair_hidden_unless_asked(self):
        reverse_entry(self.rv, reason='typo')
        ids = {r['entry_id'] for r in self.report()['rows']}
        self.assertNotIn(str(self.rv.pk), ids)
        self.assertIn(str(self.rv.pk), {r['entry_id'] for r in self.report(show_reversed=1)['rows']})

    def test_stamp_changes_when_books_change(self):
        before = self.client.get(URL + 'stamp/').data['stamp']
        post('RV', '1001', '4003', D('10'), JAN20)
        self.assertNotEqual(self.client.get(URL + 'stamp/').data['stamp'], before)

    def test_options(self):
        res = self.client.get(URL + 'options/')
        self.assertEqual(res.status_code, 200)
        channels = {a['code']: a['channel'] for a in res.data['accounts']}
        self.assertEqual((channels['1001'], channels['1002']), ('CASH', 'BANK'))
        self.assertNotIn('4003', channels)


class TransactionControlTests(TransactionReportBase):
    def test_details_on_cash_and_bank_rows(self):
        url = f"{FIN}/transactions/entries/{self.rv.pk}/{account('1001').pk}/"
        res = self.client.patch(url, {'reference': 'RCPT-77', 'remarks': 'Counted at close'}, format='json')
        self.assertEqual(res.status_code, 200, res.content)
        row = next(r for r in self.report()['rows'] if r['entry_id'] == str(self.rv.pk))
        self.assertEqual((row['reference'], row['remarks'], row['reference_is_set']), ('RCPT-77', 'Counted at close', True))
        bad = self.client.patch(f"{FIN}/transactions/entries/{self.rv.pk}/{account('4003').pk}/", {'remarks': 'x'},
                                format='json')
        self.assertEqual(bad.status_code, 400)
        self.assertEqual(BankEntryDetail.objects.count(), 1)

    def test_text_correction_in_place_is_audited(self):
        res = self.client.post(f"{FIN}/journals/{self.rv.pk}/correct/",
                               {'mode': 'text', 'narration': 'Eye test fees — Jan', 'reference': 'R-1'}, format='json')
        self.assertEqual(res.status_code, 200, res.content)
        self.rv.refresh_from_db()
        self.assertEqual((self.rv.narration, self.rv.metadata['reference'], self.rv.status),
                         ('Eye test fees — Jan', 'R-1', 'POSTED'))
        self.assertTrue(FinancialAuditLog.objects.filter(action='JOURNAL_DETAILS_EDITED').exists())

    def test_voucher_correction_reverses_and_reposts(self):
        template = self.client.get(f"{FIN}/journals/{self.rv.pk}/correction/").data
        self.assertEqual(template['voucher_type_code'], 'RV')
        payload = {'mode': 'voucher', 'reason': 'Fee was 3500', 'voucher_type_code': 'RV', 'date': '2026-01-20',
                   'narration': 'Eye test fees', 'status': 'POSTED',
                   'lines': [{'account': str(account('1001').pk), 'debit': '3500', 'credit': '0'},
                             {'account': str(account('4003').pk), 'debit': '0', 'credit': '3500'}]}
        self.assertEqual(self.client.post(f"{FIN}/journals/{self.rv.pk}/correct/", {**payload, 'reason': ''},
                                          format='json').status_code, 400)
        res = self.client.post(f"{FIN}/journals/{self.rv.pk}/correct/", payload, format='json')
        self.assertEqual(res.status_code, 200, res.content)
        self.rv.refresh_from_db()
        self.assertEqual(self.rv.status, 'REVERSED')
        new = JournalEntry.objects.get(pk=res.data['corrected']['id'])
        self.assertEqual((new.metadata['corrected_from'], self.rv.metadata['corrected_by']),
                         (self.rv.entry_number, new.entry_number))
        self.assertEqual(self.report()['summary']['cash']['closing'], '33500.00')
        self.assertTrue(ledger_is_balanced())
        # A correction of an already-corrected voucher is refused.
        self.assertEqual(self.client.post(f"{FIN}/journals/{self.rv.pk}/correct/", payload, format='json').status_code, 400)

    def test_automated_entry_amounts_cannot_be_corrected_here(self):
        with self.captureOnCommitCallbacks(execute=True):
            inv = Invoice.objects.create(invoice_number='INV-T2', invoice_date=JAN20, customer_name='Ravi',
                                         total_amount=D('100'), net_amount=D('100'))
            pay = Payment.objects.create(invoice=inv, amount=D('100'), method='Cash', payment_date=JAN20)
        je = JournalEntry.objects.get(source_module='sales', source_event='payment', reference_id=pay.pk)
        payload = {'mode': 'voucher', 'reason': 'x', 'voucher_type_code': 'RV', 'date': '2026-01-20', 'status': 'POSTED',
                   'lines': [{'account': str(account('1001').pk), 'debit': '90', 'credit': '0'},
                             {'account': str(account('4003').pk), 'debit': '0', 'credit': '90'}]}
        res = self.client.post(f"{FIN}/journals/{je.pk}/correct/", payload, format='json')
        self.assertEqual(res.status_code, 400)
        self.assertIn('source document', str(res.data))
        ok = self.client.post(f"{FIN}/journals/{je.pk}/correct/", {'mode': 'text', 'narration': 'Counter 2'}, format='json')
        self.assertEqual(ok.status_code, 200)
        ref = self.client.post(f"{FIN}/journals/{je.pk}/correct/", {'mode': 'text', 'reference': 'X'}, format='json')
        self.assertEqual(ref.status_code, 400)

    def test_viewers_cannot_write(self):
        self.client.force_authenticate(make_user('MANAGER'))
        self.assertEqual(self.report()['summary']['transactions'], 5)
        res = self.client.post(f"{FIN}/journals/{self.rv.pk}/correct/", {'mode': 'text', 'narration': 'x'}, format='json')
        self.assertEqual(res.status_code, 403)


class TransactionStatementTests(TransactionReportBase):
    def statement(self, **params):
        res = self.client.get(f'{FIN}/statements/', {'from_date': '2026-01-01', 'to_date': '2026-01-31', **params})
        self.assertEqual(res.status_code, 200, res.content)
        return res.data

    def test_transaction_statement_matches_report(self):
        data = self.statement(type='transactions')
        cells = [r['cells'] for r in data['tables'][0]['rows']]
        self.assertEqual((cells[0]['particulars'], cells[-1]['balance']), ('Opening Balance', '51500.00'))
        self.assertEqual(len(cells), 7)
        self.assertEqual({s['label']: s['value'] for s in data['summary']}['Bank closing'], '18500.00')

    def test_sub_ledger_statement(self):
        control = account('2001')
        sup = ChartOfAccount.objects.create(code='2001-01', name='Lens Lab', account_group=control.account_group,
                                            parent_account=control)
        post('PV', '2001-01', '1002', D('2500'), JAN20)
        opts = self.client.get(f'{FIN}/statements/options/').data
        self.assertIn(str(control.pk), [a['id'] for a in opts['control_accounts']])
        data = self.statement(type='sub_ledgers', account_id=str(control.pk))
        line = next(r['cells'] for r in data['tables'][0]['rows'] if r['cells'].get('code') == '2001-01')
        self.assertEqual((line['debit'], line['closing']), ('2500.00', '2500.00'))
        self.assertEqual(data['tables'][1]['rows'][0]['cells']['voucher_no'][:2], 'PV')
        everything = self.statement(type='sub_ledgers')
        self.assertTrue(any(r['style'] == 'section' and '2001' in r['cells']['name'] for r in everything['tables'][0]['rows']))
        leaf = self.client.get(f'{FIN}/statements/', {'type': 'sub_ledgers', 'account_id': str(sup.pk),
                                                       'from_date': '2026-01-01', 'to_date': '2026-01-31'})
        self.assertEqual(leaf.status_code, 400)
