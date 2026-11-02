"""Day Book: every posted journal of the period, grouped into transactions (a bill with that day's
receipts), with each pay mode of a split payment listed under its bill and the unpaid rest as
Credit; totals that balance (debit = credit) whatever the filters."""
import datetime

from rest_framework.test import APITestCase

from apps.company.models import Branch, BusinessSettings, UserBranchAccess
from apps.financial.models import ChartOfAccount, JournalEntry
from apps.financial.services import create_journal, reverse_entry
from apps.purchasing.models import PurchaseInvoice, Supplier
from apps.sales.models import Invoice, Payment

from .helpers import D, TODAY, make_user, make_warehouse

URL = '/api/financial/reports/daybook/'
JAN5, JAN10 = datetime.date(2026, 1, 5), datetime.date(2026, 1, 10)


def acc(code):
    return ChartOfAccount.objects.get(code=code)


def post(code, dr, cr, amount, date, **kw):
    return create_journal(lines=[{'account': dr, 'debit': amount}, {'account': cr, 'credit': amount}],
                          date=date, voucher_type_code=code, source_module='financial', source_event='voucher', **kw)


def modes(row):
    return [(p['mode'], p['amount_in'], p['amount_out']) for p in row['payments']]


class DayBookBase(APITestCase):
    def setUp(self):
        self.client.force_authenticate(make_user('ACCOUNTANT'))

    def book(self, status=200, **params):
        params.setdefault('date_from', JAN5)
        params.setdefault('date_to', JAN10)
        res = self.client.get(URL, params)
        self.assertEqual(res.status_code, status, res.content)
        return res.data

    def sale(self, number='INV-1', total='1000', date=JAN5, splits=(), customer='Asha'):
        with self.captureOnCommitCallbacks(execute=True):
            inv = Invoice.objects.create(invoice_number=number, invoice_date=date, customer_name=customer,
                                         total_amount=D(total), net_amount=D(total))
            for method, amount, *pay_date in splits:
                Payment.objects.create(invoice=inv, amount=D(amount), method=method, source='BILLING',
                                       payment_date=pay_date[0] if pay_date else date, customer_name=customer)
        return inv


class DayBookTransactionTests(DayBookBase):
    def test_split_payment_listed_under_its_bill(self):
        self.sale(splits=(('Cash', '600'), ('UPI', '300')))
        data = self.book()
        row, = data['rows']
        self.assertEqual((row['kind'], row['reference'], row['party'], row['amount']), ('SALE', 'INV-1', 'Asha', '1000.00'))
        self.assertEqual(modes(row), [('Cash', '600.00', None), ('UPI', '300.00', None), ('Credit', '100.00', None)])
        self.assertEqual(len(row['entries']), 3)  # invoice + one receipt per pay mode
        self.assertEqual((row['money_in'], row['credit_amount']), ('900.00', '100.00'))
        self.assertTrue(row['time'])
        self.assertEqual(row['total_debit'], row['total_credit'])
        s = data['summary']
        self.assertEqual((s['transactions'], s['journals'], s['sales_total'], s['money_in']), (1, 3, '1000.00', '900.00'))
        self.assertEqual(s['total_debit'], s['total_credit'])
        self.assertEqual({m['mode']: m['amount_in'] for m in s['by_mode']},
                         {'Cash': '600.00', 'UPI': '300.00', 'Credit': '100.00'})

    def test_full_credit_sale_and_later_receipt(self):
        self.sale(splits=(('Card', '400', JAN10),))
        sale, receipt = self.book()['rows']
        self.assertEqual((sale['date'], sale['kind'], modes(sale)), ('2026-01-05', 'SALE', [('Credit', '1000.00', None)]))
        self.assertEqual((receipt['date'], receipt['kind'], receipt['reference']), ('2026-01-10', 'RECEIPT', 'INV-1'))
        self.assertEqual(modes(receipt), [('Card', '400.00', None)])
        days = self.book()['days']
        self.assertEqual([(d['date'], d['transactions']) for d in days], [('2026-01-05', 1), ('2026-01-10', 1)])

    def test_money_paid_before_the_bill_is_not_credit(self):
        self.sale(date=JAN10, splits=(('Cash', '600', JAN5), ('Cash', '400')))
        advance, sale = self.book()['rows']
        self.assertEqual(advance['kind'], 'RECEIPT')
        self.assertEqual((sale['kind'], sale['paid_earlier'], sale['credit_amount']), ('SALE', '600.00', None))
        self.assertEqual(modes(sale), [('Cash', '400.00', None)])

    def test_purchase_with_payment_and_vouchers(self):
        make_warehouse()
        supplier = Supplier.objects.create(name='Lens Lab')
        with self.captureOnCommitCallbacks(execute=True):
            PurchaseInvoice.objects.create(invoice_number='PE-1', supplier=supplier, purchase_date=TODAY,
                                           purchase_type='CASH', payment_method='CASH', payment_status='PAID',
                                           paid_amount=D('1000'), tax_amount=D('0'), grand_total=D('1000'))
        post('PV', acc('2001'), acc('1002'), D('250'), TODAY, narration='Rent')
        post('JV', acc('1004'), acc('4001'), D('50'), TODAY)
        rows = self.book(date_from=TODAY, date_to=TODAY)['rows']
        purchase, pv, jv = rows
        self.assertEqual((purchase['kind'], purchase['reference'], purchase['party']), ('PURCHASE', 'PE-1', 'Lens Lab'))
        self.assertEqual(modes(purchase), [('Cash', None, '1000.00')])
        self.assertEqual((pv['kind'], pv['description'], modes(pv)), ('PAYMENT_VOUCHER', 'Rent', [('Bank', None, '250.00')]))
        self.assertEqual((jv['kind'], jv['payments']), ('JOURNAL', []))
        lines = jv['entries'][0]['lines']
        self.assertEqual([(l['account_code'], l['debit'], l['credit']) for l in lines],
                         [('1004', '50.00', None), ('4001', None, '50.00')])

    def test_reversed_pair_hidden_unless_asked(self):
        je = post('RV', acc('1001'), acc('1004'), D('100'), JAN5)
        reverse_entry(je, reason='typo')
        data = self.book()
        self.assertEqual((data['rows'], data['summary']['hidden_reversals']), ([], 2))
        shown = self.book(show_reversed=1)['rows']
        self.assertEqual([r['status'] for r in shown], ['REVERSED', 'REVERSAL'])


class DayBookFilterTests(DayBookBase):
    def setUp(self):
        super().setUp()
        self.sale('INV-1', splits=(('Cash', '1000'),), customer='Asha')
        self.sale('INV-2', total='500', splits=(('UPI', '200'),), customer='Ravi')
        post('PV', acc('2001'), acc('1001'), D('300'), JAN10, narration='Electricity')

    def test_mode_kind_and_search_narrow_rows_not_summary(self):
        data = self.book(mode='UPI')
        self.assertEqual([r['reference'] for r in data['rows']], ['INV-2'])
        self.assertEqual(data['summary']['transactions'], 3)
        self.assertEqual([r['reference'] for r in self.book(mode='Credit')['rows']], ['INV-2'])
        self.assertEqual([r['kind'] for r in self.book(kind='PAYMENT_VOUCHER')['rows']], ['PAYMENT_VOUCHER'])
        found = self.book(search='ravi')
        self.assertEqual(([r['reference'] for r in found['rows']], found['matched']['money_in']), (['INV-2'], '200.00'))
        self.assertEqual(self.book(search='electricity')['rows'][0]['money_out'], '300.00')

    def test_dates(self):
        self.assertEqual(len(self.book(date_from=JAN10, date_to=JAN10)['rows']), 1)
        self.assertEqual(len(self.book(date_from=JAN5, date_to=JAN5)['rows']), 2)
        self.book(status=400, date_from=JAN10, date_to=JAN5)
        self.book(status=400, date_from='2024-01-01', date_to=JAN10)
        self.assertEqual(self.book(date_from='', date_to='')['date_from'], datetime.date.today().isoformat())

    def test_pagination_and_export(self):
        page = self.book(page_size=2, page=2)
        self.assertEqual((page['count'], page['num_pages'], [r['row_no'] for r in page['rows']]), (3, 2, [3]))
        self.assertEqual(len(self.book(page_size=1, export=1)['rows']), 3)


class DayBookBranchTests(DayBookBase):
    def test_branch_scope_is_enforced(self):
        main = make_warehouse().branch
        north = Branch.objects.create(company=main.company, name='North', code='NTH')
        settings_obj = BusinessSettings.load()
        settings_obj.multi_branch_enabled = True
        settings_obj.save()
        post('RV', acc('1001'), acc('1004'), D('100'), JAN5, branch=main)
        post('RV', acc('1001'), acc('1004'), D('70'), JAN5, branch=north)
        self.assertEqual(len(self.book()['rows']), 2)
        self.assertEqual([r['money_in'] for r in self.book(branch=str(north.pk))['rows']], ['70.00'])

        access = UserBranchAccess.objects.create(username='nina')
        access.branches.add(north)
        headers = {'HTTP_X_USER_NAME': 'nina', 'HTTP_X_USER_ROLE': 'ACCOUNTANT'}
        res = self.client.get(URL, {'date_from': JAN5, 'date_to': JAN10, 'branch': str(main.pk)}, **headers)
        self.assertEqual(res.status_code, 403)
        res = self.client.get(URL, {'date_from': JAN5, 'date_to': JAN10}, **headers)
        self.assertEqual([r['money_in'] for r in res.data['rows']], ['70.00'])
        self.assertEqual(JournalEntry.objects.count(), 2)
