"""JournalPostingService, mappings, periods and the failure queue."""
import datetime
from unittest import mock

from django.core.exceptions import ValidationError
from django.db import IntegrityError, transaction
from django.test import TestCase

from apps.financial import integration, services
from apps.financial.mapping import resolve_role, save_mapping
from apps.financial.models import (
    AccountMapping, ChartOfAccount, FiscalPeriod, JournalEntry, PostingFailure, AccountingPolicy,
)
from apps.financial.services import (
    AccountingError, MappingError, PeriodClosedError, create_journal, reverse_entry, sync_source_entry,
    post_opening_balances,
)
from apps.sales.models import Invoice

from .helpers import D, TODAY, account, balance, ledger_is_balanced, lines_of, live


def cash_sale_lines(amount='100'):
    return [{'account': '1001', 'debit': amount}, {'account': '4001', 'credit': amount}]


class SeedTests(TestCase):
    def test_every_role_is_mapped_to_a_valid_account(self):
        from apps.financial.mapping import role_status
        bad = [r for r in role_status() if not r['valid']]
        self.assertEqual(bad, [])
        self.assertEqual(resolve_role('RETAIL_SALES').code, '4001')
        self.assertTrue(account('4001').is_system)

    def test_new_sources_have_a_go_live_cutoff_and_retail_does_not(self):
        starts = AccountingPolicy.get().source_start_dates
        self.assertIn('purchasing.purchase_invoice', starts)
        self.assertNotIn('sales.invoice', starts)


class PostingServiceTests(TestCase):
    def test_balanced_entry_posts_and_updates_balance_cache(self):
        entry = create_journal(lines=cash_sale_lines('250.50'), narration='t')
        self.assertEqual(entry.status, 'POSTED')
        self.assertEqual(entry.total_amount, D('250.50'))
        self.assertEqual(balance('1001'), D('250.50'))
        self.assertEqual(account('1001').current_balance, D('250.50'))
        self.assertTrue(ledger_is_balanced())

    def test_unbalanced_negative_and_two_sided_lines_are_refused(self):
        with self.assertRaises(AccountingError):
            create_journal(lines=[{'account': '1001', 'debit': 100}, {'account': '4001', 'credit': 99.99}])
        with self.assertRaises(AccountingError):
            create_journal(lines=[{'account': '1001', 'debit': -100}, {'account': '4001', 'credit': -100}])
        with self.assertRaises(AccountingError):
            create_journal(lines=[{'account': '1001', 'debit': 100, 'credit': 100}, {'account': '4001', 'credit': 0}])
        with self.assertRaises(AccountingError):
            create_journal(lines=[{'account': '1001', 'debit': 100}])
        self.assertFalse(JournalEntry.objects.exists())

    def test_inactive_or_unknown_account_is_refused(self):
        ChartOfAccount.objects.filter(code='5100').update(status='Inactive')
        with self.assertRaises(AccountingError):
            create_journal(lines=[{'account': '5100', 'debit': 10}, {'account': '1001', 'credit': 10}])
        with self.assertRaises(AccountingError):
            create_journal(lines=[{'account': 'NOPE', 'debit': 10}, {'account': '1001', 'credit': 10}])

    def test_idempotency_key_returns_the_first_entry(self):
        a = create_journal(lines=cash_sale_lines(), idempotency_key='form-1')
        b = create_journal(lines=cash_sale_lines(), idempotency_key='form-1')
        self.assertEqual(a.pk, b.pk)
        self.assertEqual(JournalEntry.objects.count(), 1)
        self.assertEqual(balance('1001'), D('100'))

    def test_posted_entry_cannot_be_deleted_and_reversal_nets_to_zero(self):
        entry = create_journal(lines=cash_sale_lines())
        with self.assertRaises(ValidationError):
            entry.delete()
        rev = reverse_entry(entry, reason='mistake')
        entry.refresh_from_db()
        self.assertEqual(entry.status, 'REVERSED')
        self.assertTrue(rev.is_reversal)
        self.assertEqual(lines_of(rev), {'1001': D('-100'), '4001': D('100')})
        self.assertEqual(balance('1001'), 0)
        with self.assertRaises(AccountingError):
            reverse_entry(entry)
        with self.assertRaises(AccountingError):
            reverse_entry(rev)

    def test_closed_period_rejects_posting_and_reversal_moves_to_today(self):
        last_month = TODAY.replace(day=1) - datetime.timedelta(days=1)
        entry = create_journal(lines=cash_sale_lines(), date=last_month)
        FiscalPeriod.objects.create(name='Closed', start_date=last_month.replace(day=1), end_date=last_month, status='CLOSED')
        with self.assertRaises(PeriodClosedError):
            create_journal(lines=cash_sale_lines(), date=last_month)
        rev = reverse_entry(entry)
        self.assertEqual(rev.date, TODAY)

    def test_numbers_are_sequential_per_prefix_and_year(self):
        a = create_journal(lines=cash_sale_lines(), voucher_type_code='JV')
        b = create_journal(lines=cash_sale_lines(), voucher_type_code='JV')
        self.assertEqual(a.entry_number, f"JV-{TODAY.year}-00001")
        self.assertEqual(b.entry_number, f"JV-{TODAY.year}-00002")

    def test_receipt_voucher_rule_needs_cash_or_bank_debit(self):
        with self.assertRaises(AccountingError):
            create_journal(lines=[{'account': '5100', 'debit': 10}, {'account': '4001', 'credit': 10}], voucher_type_code='RV')

    def test_database_refuses_a_second_live_entry_for_one_source(self):
        ref = Invoice._meta.pk.default()
        create_journal(lines=cash_sale_lines(), source_module='sales', source_event='invoice', reference_id=ref)
        with self.assertRaises(IntegrityError), transaction.atomic():
            create_journal(lines=cash_sale_lines(), source_module='sales', source_event='invoice', reference_id=ref)

    def test_sync_survives_a_concurrent_first_post(self):
        """Two requests both saw 'nothing posted yet'; the loser must not double-book."""
        ref = Invoice._meta.pk.default()
        plan = {'date': TODAY, 'lines': [{'account': account('1001'), 'debit': D('100'), 'credit': D('0')},
                                         {'account': account('4001'), 'debit': D('0'), 'credit': D('100')}]}
        sync_source_entry(source_module='sales', source_event='invoice', reference_id=ref, plan=plan)
        with mock.patch.object(services, 'live_entry', side_effect=[None, live('sales', 'invoice', ref).first()]):
            outcome, _ = sync_source_entry(source_module='sales', source_event='invoice', reference_id=ref, plan=plan)
        self.assertEqual(outcome, 'unchanged')
        self.assertEqual(live('sales', 'invoice', ref).count(), 1)
        self.assertEqual(balance('1001'), D('100'))

    def test_sync_is_idempotent_and_reposts_only_on_change(self):
        ref = Invoice._meta.pk.default()

        def plan(amount):
            return {'date': TODAY, 'lines': [{'account': account('1004'), 'debit': D(amount), 'credit': D('0')},
                                             {'account': account('4001'), 'debit': D('0'), 'credit': D(amount)}]}
        self.assertEqual(sync_source_entry(source_module='sales', source_event='invoice', reference_id=ref, plan=plan('100'))[0], 'posted')
        self.assertEqual(sync_source_entry(source_module='sales', source_event='invoice', reference_id=ref, plan=plan('100'))[0], 'unchanged')
        self.assertEqual(sync_source_entry(source_module='sales', source_event='invoice', reference_id=ref, plan=plan('150'))[0], 'reposted')
        self.assertEqual(balance('1004'), D('150'))
        self.assertEqual(sync_source_entry(source_module='sales', source_event='invoice', reference_id=ref, plan=None)[0], 'reversed')
        self.assertEqual(balance('1004'), 0)
        self.assertTrue(ledger_is_balanced())

    def test_opening_balances_post_against_opening_equity(self):
        ChartOfAccount.objects.filter(code='1002').update(opening_balance=D('5000'))
        ChartOfAccount.objects.filter(code='2001').update(opening_balance=D('1200'))
        post_opening_balances(as_of=TODAY)
        post_opening_balances(as_of=TODAY)  # re-running doesn't double-post
        self.assertEqual(balance('1002'), D('5000'))
        self.assertEqual(balance('2001'), D('1200'))
        self.assertEqual(balance('3001'), D('3800'))
        self.assertTrue(ledger_is_balanced())


class MappingTests(TestCase):
    def test_incompatible_account_is_refused(self):
        with self.assertRaises(MappingError):
            save_mapping(role='CASH', account=account('4001'))

    def test_branch_and_effective_date_mappings_win(self):
        save_mapping(role='CASH', account=account('1002'), effective_from=TODAY)
        self.assertEqual(resolve_role('CASH', date=TODAY).code, '1002')
        self.assertEqual(resolve_role('CASH', date=TODAY - datetime.timedelta(days=1)).code, '1001')

    def test_missing_mapping_fails_loudly_and_retry_posts_after_fix(self):
        AccountMapping.objects.filter(role='RETAIL_SALES').update(is_active=False)
        inv = Invoice.objects.create(invoice_number='INV-MAP-1', invoice_date=TODAY, customer_name='A',
                                     total_amount=100, net_amount=100)
        result = integration.book_source_safely('sales.invoice', inv.pk)
        self.assertEqual(result['outcome'], 'failed')
        failure = PostingFailure.objects.get(reference_id=inv.pk)
        self.assertEqual((failure.kind, failure.status, failure.source_number), ('MAPPING', 'OPEN', 'INV-MAP-1'))
        self.assertFalse(live('sales', 'invoice', inv.pk).exists())

        integration.book_source_safely('sales.invoice', inv.pk)
        failure.refresh_from_db()
        self.assertEqual(failure.attempts, 2)

        save_mapping(role='RETAIL_SALES', account=account('4001'))
        integration.retry_failure(failure)
        failure.refresh_from_db()
        self.assertEqual(failure.status, 'RESOLVED')
        self.assertTrue(live('sales', 'invoice', inv.pk).exists())
