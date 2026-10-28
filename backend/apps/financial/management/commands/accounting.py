"""Accounting integration maintenance.

    python manage.py accounting status
    python manage.py accounting reconcile [--source sales.invoice] [--from 2026-04-01] [--to 2026-10-31]
    python manage.py accounting backfill --source purchasing.purchase_invoice [--from ...] [--to ...] [--commit]
    python manage.py accounting retry-failures
    python manage.py accounting recompute-balances
    python manage.py accounting restore-defaults [--commit]

backfill and restore-defaults are dry runs unless --commit is given. Run reconcile first and
review the list. restore-defaults puts back missing default accounts / posting-role mappings
(e.g. after wipe_database); postings also restore them on their own when a role was never mapped.
"""
import json

from django.core.management.base import BaseCommand, CommandError

from apps.financial import integration, reports
from apps.financial.accounting_catalog import SOURCES
from apps.financial.defaults import ensure_accounting_defaults, missing_defaults
from apps.financial.models import PostingFailure
from apps.financial.services import recompute_balance_cache


class Command(BaseCommand):
    help = 'Accounting integration: status, reconcile, backfill, retry-failures, recompute-balances, restore-defaults'

    def add_arguments(self, parser):
        parser.add_argument('action', choices=['status', 'reconcile', 'backfill', 'retry-failures', 'recompute-balances', 'restore-defaults'])
        parser.add_argument('--source', choices=list(SOURCES))
        parser.add_argument('--from', dest='date_from')
        parser.add_argument('--to', dest='date_to')
        parser.add_argument('--commit', action='store_true', help='backfill / restore-defaults: actually write (default is a dry run)')

    def out(self, data):
        self.stdout.write(json.dumps(data, indent=2, default=str))

    def handle(self, action, source=None, date_from=None, date_to=None, commit=False, **opts):
        df, dt = reports.parse_date(date_from), reports.parse_date(date_to)
        if action == 'status':
            self.out(integration.integration_status())
        elif action == 'reconcile':
            keys = [source] if source else list(SOURCES)
            self.out({'sources': [integration.reconcile_source(k, df, dt) for k in keys],
                      'subledgers': integration.subledger_reconciliation()})
        elif action == 'backfill':
            if not source:
                raise CommandError('--source is required for backfill.')
            rows = integration.backfill(source, df, dt, dry_run=not commit)
            self.out(rows)
            self.stdout.write(self.style.SUCCESS(f"{len(rows)} document(s) {'posted' if commit else 'would be posted (dry run)'}."))
        elif action == 'retry-failures':
            results = [integration.retry_failure(f) for f in PostingFailure.objects.filter(status='OPEN')]
            self.out(results)
        elif action == 'restore-defaults':
            if commit:
                self.out(ensure_accounting_defaults())
            else:
                accounts, roles = missing_defaults()
                self.out({'missing_accounts': accounts, 'unmapped_roles': roles})
                self.stdout.write(self.style.NOTICE('Dry run — re-run with --commit to restore them.'))
        elif action == 'recompute-balances':
            self.stdout.write(f"{recompute_balance_cache()} cached balance(s) corrected.")
