"""Per-party sub-ledgers (suppliers → AP, wholesale dealers → AR) and new-product opening stock."""
import datetime

from django.test import TestCase

from apps.financial.models import AccountingPolicy, ChartOfAccount, JournalEntry
from apps.financial.party_ledgers import link_existing_parties
from apps.financial.settlements import open_bills
from apps.products.models import Product
from apps.purchasing.models import Supplier
from apps.sales.models import Dealer, WholesaleInvoice, WholesalePaymentCollection

from .helpers import D, TODAY, account, balance, ledger_is_balanced, lines_of, live


class Booked(TestCase):
    def booked(self):
        return self.captureOnCommitCallbacks(execute=True)


class PartyLedgerProvisioningTests(Booked):
    def test_new_dealer_gets_receivable_sub_ledger_under_the_control_account(self):
        dealer = Dealer.objects.create(dealer_code='DL-7', business_name='Vision Hub', phone='1',
                                       opening_balance=D('2500'))
        dealer.refresh_from_db()
        acc = dealer.ledger_account
        self.assertEqual((acc.code, acc.name), ('AR-DL-7', 'Vision Hub (Dealer DL-7)'))
        self.assertEqual(acc.account_subtype, 'RECEIVABLE')
        self.assertEqual(acc.account_group.name, 'Sundry Debtors')
        self.assertEqual(acc.account_type, 'Asset')
        self.assertEqual(acc.parent_account.code, '1005')
        self.assertEqual(acc.opening_balance, D('2500'))  # typed only, nothing posted
        self.assertFalse(JournalEntry.objects.exists())

    def test_new_supplier_gets_payable_sub_ledger_and_rename_follows(self):
        supplier = Supplier.objects.create(name='Zeiss', supplier_code='SUP-77')
        supplier.refresh_from_db()
        acc = supplier.ledger_account
        self.assertEqual((acc.code, acc.account_type, acc.parent_account.code), ('AP-SUP-77', 'Liability', '2001'))
        supplier.name = 'Carl Zeiss'
        supplier.save()
        acc.refresh_from_db()
        self.assertEqual(acc.name, 'Carl Zeiss (Supplier SUP-77)')

    def test_name_clash_with_a_hand_made_account_still_provisions(self):
        group = account('1005').account_group
        ChartOfAccount.objects.create(code='X-1', name='Vision Hub (Dealer DL-8)', account_group=group)
        dealer = Dealer.objects.create(dealer_code='DL-8', business_name='Vision Hub', phone='1')
        dealer.refresh_from_db()
        self.assertEqual(dealer.ledger_account.code, 'AR-DL-8')

    def test_dealer_bills_settle_against_the_dealer_ledger(self):
        dealer = Dealer.objects.create(dealer_code='DL-9', business_name='Lens Mart', phone='1')
        with self.booked():
            WholesaleInvoice.objects.create(invoice_number='W-9', dealer=dealer, invoice_date=TODAY,
                                            due_date=TODAY, grand_total=D('800'))
        bill = open_bills('dealer', party_ids=[dealer.pk])[dealer.pk][0]
        self.assertEqual(bill['account_code'], 'AR-DL-9')
        self.assertEqual(bill['main_account'], account('1005').name)


class LinkExistingPartiesTests(Booked):
    def legacy_dealer(self):
        dealer = Dealer.objects.create(dealer_code='DL-OLD', business_name='Old Optics', phone='1')
        Dealer.objects.filter(pk=dealer.pk).update(ledger_account=None)  # as before sub-ledgers existed
        ChartOfAccount.objects.filter(code='AR-DL-OLD').hard_delete()
        dealer.refresh_from_db()
        return dealer

    def test_legacy_dealer_posts_to_control_then_moves_with_its_history(self):
        dealer = self.legacy_dealer()
        with self.booked():
            inv = WholesaleInvoice.objects.create(invoice_number='W-OLD', dealer=dealer, invoice_date=TODAY,
                                                  due_date=TODAY, grand_total=D('1000'))
            WholesalePaymentCollection.objects.create(receipt_number='R-OLD', dealer=dealer, invoice_number='W-OLD',
                                                      payment_date=TODAY, payment_method='Cash', amount_paid=D('300'))
        self.assertEqual(balance('1005'), D('700'))

        dry = link_existing_parties(['dealer'])
        self.assertEqual([(r['code'], r['documents']) for r in dry], [('DL-OLD', 2)])
        self.assertFalse(ChartOfAccount.all_objects.filter(code='AR-DL-OLD').exists())

        done = link_existing_parties(['dealer'], commit=True)
        self.assertEqual((done[0]['rebooked'], done[0]['failed']), (2, 0))
        self.assertEqual(balance('1005'), D('0'))
        self.assertEqual(balance('AR-DL-OLD'), D('700'))
        self.assertEqual(lines_of(live('sales', 'wholesale_invoice', inv.pk).get())['AR-DL-OLD'], D('1000'))
        self.assertTrue(ledger_is_balanced())
        self.assertEqual(link_existing_parties(['dealer']), [])  # nothing left to link


class OpeningStockTests(Booked):
    def make(self, **kw):
        fields = dict(name='Ray Frame', sku='RF-1', cost_price=D('400'), stock=5, opening_stock=5)
        fields.update(kw)
        with self.booked():
            return Product.objects.create(**fields)

    def test_new_product_opening_stock_is_inventory_against_opening_equity(self):
        p = self.make()
        entry = live('products', 'opening_stock', p.pk).get()
        self.assertEqual(entry.voucher_type.code, 'OB')
        self.assertEqual(lines_of(entry), {'1003': D('2000'), '3001': D('-2000')})

    def test_later_cost_and_stock_changes_do_not_revalue_it(self):
        p = self.make()
        with self.booked():
            p.cost_price, p.stock = D('550'), 1
            p.save()
        self.assertEqual(JournalEntry.objects.filter(source_module='products').count(), 1)
        self.assertEqual(balance('1003'), D('2000'))

    def test_no_opening_stock_or_no_cost_posts_nothing(self):
        self.make(sku='RF-2', opening_stock=0)
        self.make(sku='RF-3', cost_price=D('0'))
        self.assertFalse(JournalEntry.objects.filter(source_module='products').exists())

    def test_products_before_go_live_are_historical(self):
        policy = AccountingPolicy.get()
        policy.source_start_dates = {**policy.source_start_dates,
                                     'products.opening_stock': (TODAY + datetime.timedelta(days=1)).isoformat()}
        policy.save()
        self.make()
        self.assertFalse(JournalEntry.objects.filter(source_module='products').exists())
