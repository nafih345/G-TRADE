"""Purchase entries (and every other journal) must reach the ledgers even after the financial
tables were wiped: the default Chart of Accounts heads and posting-role mappings are restored
on demand, a deliberately deactivated mapping is respected, and the save says what happened."""
from io import StringIO
from unittest import mock

from django.core.management import call_command
from django.test import TestCase
from rest_framework.test import APIClient

from apps.financial.accounting_catalog import ROLES
from apps.financial.defaults import ensure_accounting_defaults, missing_defaults
from apps.financial.models import AccountMapping, ChartOfAccount, PostingFailure
from apps.purchasing.models import PurchaseInvoice, Supplier
from apps.purchasing.supplier_utils import get_or_create_supplier_ledger_account

from .helpers import D, TODAY, ledger_is_balanced, lines_of, live, make_product, make_warehouse


def wipe_financial_setup(accounts=False):
    """What wipe_database leaves behind: no role mappings (and, with accounts=True, no heads)."""
    getattr(AccountMapping, 'all_objects', AccountMapping.objects).all().delete()  # TRUNCATE, not soft delete
    if accounts:
        ChartOfAccount.all_objects.all().delete()


class PurchaseBooksAfterWipeTests(TestCase):
    def setUp(self):
        make_warehouse()
        self.supplier = Supplier.objects.create(name='Essilor', supplier_code='SUP-1')

    def purchase(self, **kw):
        fields = dict(invoice_number='PE-1', supplier=self.supplier, purchase_date=TODAY, purchase_type='CREDIT',
                      payment_method='CREDIT', cgst_amount=D('45'), sgst_amount=D('45'), tax_amount=D('90'),
                      round_off=D('0.40'), grand_total=D('1090.40'))
        fields.update(kw)
        with self.captureOnCommitCallbacks(execute=True):
            return PurchaseInvoice.objects.create(**fields)

    def test_mappings_wiped_purchase_still_posts_to_the_right_heads(self):
        wipe_financial_setup()
        pi = self.purchase()
        # Stock at cost, GST input credit, round off — against the generic supplier payable
        # (this supplier has no own sub-ledger).
        self.assertEqual(lines_of(live('purchasing', 'purchase_invoice', pi.pk).get()),
                         {'1003': D('1000'), '1020': D('90'), '5070': D('0.40'), '2001': D('-1090.40')})
        self.assertEqual(set(AccountMapping.objects.values_list('role', flat=True)), set(ROLES))
        self.assertFalse(PostingFailure.objects.filter(status='OPEN').exists())
        self.assertTrue(ledger_is_balanced())

    def test_supplier_sub_ledger_and_cash_payment(self):
        wipe_financial_setup()
        self.supplier.ledger_account = get_or_create_supplier_ledger_account(self.supplier)
        self.supplier.save()
        ap = self.supplier.ledger_account.code
        pi = self.purchase(purchase_type='CASH', payment_method='CASH', paid_amount=D('1090.40'), payment_status='PAID')
        self.assertEqual(lines_of(live('purchasing', 'purchase_invoice', pi.pk).get())[ap], D('-1090.40'))
        self.assertEqual(lines_of(live('purchasing', 'purchase_payment', pi.pk).get()), {ap: D('1090.40'), '1001': D('-1090.40')})

    def test_accounts_wiped_too_are_recreated(self):
        wipe_financial_setup(accounts=True)
        pi = self.purchase()
        self.assertTrue(live('purchasing', 'purchase_invoice', pi.pk).exists())
        self.assertTrue(ChartOfAccount.objects.filter(code='1003', name='Optical Stock Inventory').exists())

    def test_deactivated_mapping_is_respected_and_fails_visibly(self):
        AccountMapping.objects.filter(role='INVENTORY').update(is_active=False)
        pi = self.purchase()
        self.assertFalse(live('purchasing', 'purchase_invoice', pi.pk).exists())
        failure = PostingFailure.objects.get(reference_id=pi.pk, source_event='purchase_invoice', status='OPEN')
        self.assertIn('Inventory', failure.error)
        self.assertFalse(AccountMapping.objects.filter(role='INVENTORY', is_active=True).exists())

    def test_retry_after_restore_posts_the_failed_entry(self):
        AccountMapping.objects.filter(role='INVENTORY').delete()
        AccountMapping.objects.filter(role='GST_INPUT').update(is_active=False)  # blocks the posting
        pi = self.purchase()
        self.assertTrue(PostingFailure.objects.filter(reference_id=pi.pk, status='OPEN').exists())
        AccountMapping.objects.filter(role='GST_INPUT').update(is_active=True)
        call_command('accounting', 'retry-failures', stdout=StringIO())
        self.assertTrue(live('purchasing', 'purchase_invoice', pi.pk).exists())
        self.assertFalse(PostingFailure.objects.filter(reference_id=pi.pk, status='OPEN').exists())


class RestoreDefaultsTests(TestCase):
    def test_idempotent_and_dry_run(self):
        self.assertEqual(missing_defaults(), ([], []))
        self.assertEqual(ensure_accounting_defaults(), {'accounts': [], 'mappings': []})
        wipe_financial_setup()
        out = StringIO()
        call_command('accounting', 'restore-defaults', stdout=out)
        self.assertIn('Dry run', out.getvalue())
        self.assertFalse(AccountMapping.objects.exists())
        call_command('accounting', 'restore-defaults', '--commit', stdout=StringIO())
        self.assertEqual(AccountMapping.objects.count(), len(ROLES))
        self.assertEqual(missing_defaults(), ([], []))

    def test_existing_custom_mapping_is_kept(self):
        custom = ChartOfAccount.objects.get(code='1002')
        AccountMapping.objects.exclude(role='CASH').delete()
        AccountMapping.objects.filter(role='CASH').update(account=custom)
        ensure_accounting_defaults()
        self.assertEqual(AccountMapping.objects.get(role='CASH').account.code, '1002')


class SaveResponseReportsBooksTests(TestCase):
    """In a live request the engine posts when perform_create's transaction commits, before the
    response is built. The test's outer transaction never commits, so commit callbacks run
    straight away here instead."""

    def setUp(self):
        make_warehouse()
        self.supplier = Supplier.objects.create(name='Hoya', supplier_code='SUP-9')
        self.product = make_product(name='Lens X', stock=0)
        self.client = APIClient()

    def post(self, number):
        with mock.patch('django.db.transaction.on_commit', side_effect=lambda fn, *a, **k: fn()):
            return self.client.post('/api/purchase/invoices/', {
            'invoice_number': number, 'supplier': str(self.supplier.pk), 'purchase_date': TODAY.isoformat(),
            'purchase_type': 'CREDIT', 'payment_method': 'CREDIT', 'status': 'CONFIRMED', 'grand_total': 500,
            'balance_amount': 500, 'items': [{'product': str(self.product.pk), 'quantity': 1, 'purchase_rate': 500,
                                              'line_total': 500}]}, format='json')

    def test_posted_and_failed_are_reported(self):
        wipe_financial_setup()
        res = self.post('PE-OK')
        self.assertEqual(res.status_code, 201, res.content)
        self.assertEqual([p['event'] for p in res.data['accounting']['posted']], ['purchase_invoice'])
        self.assertEqual(res.data['accounting']['failed'], [])

        AccountMapping.objects.filter(role='INVENTORY').update(is_active=False)
        res = self.post('PE-FAIL')
        self.assertEqual(res.status_code, 201, res.content)
        self.assertEqual(res.data['accounting']['posted'], [])
        self.assertIn('Inventory', res.data['accounting']['failed'][0]['error'])
