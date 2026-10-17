"""Accounting integration engine: turns operational documents into journals.

    signal (post_save / post_delete)  ->  schedule()  ->  on transaction commit  ->
    book_source_safely()  ->  book_source()  ->  posting rule  ->  resolve roles  ->
    services.sync_source_entry()  (post / leave / reverse + re-post)

Posting runs after the operational transaction commits, so the rule sees the finished
document (items, receipts) and an accounting problem can never roll back a sale at the
counter. Any failure is written to PostingFailure (never swallowed) and can be retried
from the Accounting Integration screen once fixed.
"""
import logging
from decimal import Decimal

from django.apps import apps as django_apps
from django.db import transaction
from django.db.models import Sum
from django.utils import timezone

from . import batch, posting_rules as rules
from .accounting_catalog import SOURCES
from .mapping import resolve_role
from .models import AccountingPolicy, JournalEntry, LedgerEntry, PostingFailure, ChartOfAccount
from .services import (
    AccountingError, error_text, live_entry, sync_source_entry, audit, money, normalize_lines,
)

logger = logging.getLogger(__name__)

# source_key -> (app_label.Model, builder, date attribute, number attribute)
REGISTRY = {
    'sales.invoice': ('sales.Invoice', rules.build_sales_invoice, 'invoice_date', 'invoice_number'),
    'sales.payment': ('sales.Payment', rules.build_sales_payment, 'payment_date', 'receipt_no'),
    'sales.wholesale_invoice': ('sales.WholesaleInvoice', rules.build_wholesale_invoice, 'invoice_date', 'invoice_number'),
    'sales.wholesale_collection': ('sales.WholesalePaymentCollection', rules.build_wholesale_collection, 'payment_date', 'receipt_number'),
    'sales.wholesale_return': ('sales.WholesaleReturn', rules.build_wholesale_return, 'return_date', 'return_number'),
    'purchasing.purchase_invoice': ('purchasing.PurchaseInvoice', rules.build_purchase_invoice, 'purchase_date', 'invoice_number'),
    'purchasing.purchase_payment': ('purchasing.PurchaseInvoice', rules.build_purchase_payment, 'purchase_date', 'invoice_number'),
    'purchasing.purchase_order': ('purchasing.PurchaseOrder', rules.build_purchase_order, 'order_date', 'order_number'),
    'inventory.stock_adjustment': ('inventory.StockAdjustment', rules.build_stock_adjustment, 'created_at', 'reason'),
}
assert set(REGISTRY) == set(SOURCES)


def split_key(source_key):
    module, event = source_key.split('.', 1)
    return module, event


def model_for(source_key):
    return django_apps.get_model(REGISTRY[source_key][0])


def load_document(source_key, pk):
    """The document including soft-deleted rows (a soft delete must unwind its posting)."""
    return model_for(source_key).all_objects.filter(pk=pk).first()


def document_date(source_key, doc):
    return rules._date(getattr(doc, REGISTRY[source_key][2], None))


def document_number(source_key, doc):
    return str(getattr(doc, REGISTRY[source_key][3], '') or '')[:80]


# ---------------------------------------------------------------------------
# Policy
# ---------------------------------------------------------------------------

def source_enabled(policy, source_key):
    return policy.auto_posting_enabled and policy.source_enabled.get(source_key, True)


def source_start_date(policy, source_key):
    raw = (policy.source_start_dates or {}).get(source_key)
    if not raw:
        return None
    import datetime
    return datetime.date.fromisoformat(str(raw)[:10])


def is_historical(policy, source_key, doc):
    start = source_start_date(policy, source_key)
    return bool(start and doc is not None and document_date(source_key, doc) < start)


# ---------------------------------------------------------------------------
# Plans
# ---------------------------------------------------------------------------

def materialize(plan):
    """Resolve each line's role to its mapped account (raises MappingError)."""
    if plan is None:
        return None
    resolved = []
    for line in plan['lines']:
        if line['debit'] == 0 and line['credit'] == 0:
            continue
        branch = plan.get('branch')
        account = line.get('account') or batch.memo(
            ('role', line['role'], getattr(branch, 'pk', branch), plan['date']),
            lambda: resolve_role(line['role'], branch=branch, date=plan['date']))
        resolved.append({'account': account, 'debit': line['debit'], 'credit': line['credit'],
                         'memo': line.get('memo', ''), 'role': line.get('role')})
    return {**plan, 'lines': resolved}


def build_plan(source_key, doc):
    module, event = split_key(source_key)
    previous = live_entry(module, event, doc.pk) if doc is not None else None
    if doc is None:
        return None
    return materialize(REGISTRY[source_key][1](doc, previous=previous))


# ---------------------------------------------------------------------------
# Booking
# ---------------------------------------------------------------------------

def _dependents(source_key, doc):
    """Other postings whose figures depend on this document."""
    if doc is None:
        return []
    if source_key == 'sales.invoice':
        # Receipts post to Receivable or Customer Advances depending on whether their bill is
        # a live invoice — re-check them whenever the bill changes state.
        Payment = django_apps.get_model('sales.Payment')
        return [('sales.payment', pk) for pk in Payment.all_objects.filter(invoice_id=doc.pk).values_list('pk', flat=True)]
    return []


def book_source(source_key, pk, user=None, force=False, cascade=True):
    """Bring the books in line with one source document. Raises on failure.

    force=True ignores the per-source enable switch and historical cut-off (used by the
    controlled backfill and by an explicit retry)."""
    module, event = split_key(source_key)
    policy = batch.memo('policy', AccountingPolicy.get)
    doc = load_document(source_key, pk)
    if not force:
        if not source_enabled(policy, source_key):
            return {'outcome': 'disabled'}
        if is_historical(policy, source_key, doc):
            return {'outcome': 'historical'}

    plan = build_plan(source_key, doc)
    outcome, entry = sync_source_entry(source_module=module, source_event=event, reference_id=pk,
                                       plan=plan, user=user)
    PostingFailure.objects.filter(source_module=module, source_event=event, reference_id=pk, status='OPEN') \
        .update(status='RESOLVED', resolved_at=timezone.now(), resolved_by=user if getattr(user, 'is_authenticated', False) else None)
    batch.mark_booked((source_key, str(pk)))
    if cascade:
        for dep_key, dep_pk in _dependents(source_key, doc):
            # Already booked after this same commit — nothing it depends on has changed since.
            if batch.already_booked((dep_key, str(dep_pk))):
                continue
            book_source_safely(dep_key, dep_pk, user=user, force=force, cascade=False)
    return {'outcome': outcome, 'entry': entry.entry_number if entry else None}


def record_failure(source_key, pk, exc):
    module, event = split_key(source_key)
    doc = None
    try:
        doc = load_document(source_key, pk)
    except Exception:  # pragma: no cover - defensive
        pass
    kind = getattr(exc, 'kind', 'ERROR') if isinstance(exc, AccountingError) else 'ERROR'
    text = error_text(exc)[:4000]
    with transaction.atomic():
        failure = (PostingFailure.objects.select_for_update()
                   .filter(source_module=module, source_event=event, reference_id=pk, status='OPEN').first())
        if failure:
            failure.attempts += 1
            failure.error, failure.kind, failure.last_failed_at = text, kind, timezone.now()
            failure.save(update_fields=['attempts', 'error', 'kind', 'last_failed_at', 'updated_at'])
        else:
            failure = PostingFailure.objects.create(
                source_module=module, source_event=event, reference_id=pk, kind=kind, error=text,
                source_number=document_number(source_key, doc) if doc is not None else '',
            )
    return failure


def book_source_safely(source_key, pk, user=None, force=False, cascade=True):
    try:
        return book_source(source_key, pk, user=user, force=force, cascade=cascade)
    except Exception as exc:
        logger.warning("Accounting posting failed for %s %s: %s", source_key, pk, error_text(exc))
        try:
            record_failure(source_key, pk, exc)
        except Exception:  # the failure log itself must never take the request down
            logger.exception("Could not record posting failure for %s %s", source_key, pk)
        return {'outcome': 'failed', 'error': error_text(exc)}


def schedule(source_key, pk):
    """Book the document once the current transaction commits (immediately in autocommit).
    Repeated saves of the same document within one transaction queue it only once."""
    if pk is None:
        return
    key = (source_key, str(pk))
    conn = transaction.get_connection()
    run_batch = None
    if conn.in_atomic_block:
        pending = [entry[1] for entry in conn.run_on_commit]
        if any(getattr(fn, '_accounting_key', None) == key and not getattr(fn, '_accounting_done', False)
               for fn in pending):
            return
        # Every posting this transaction queues shares one Batch (see batch.py): settings read
        # once, and a document already booked by an earlier posting of the same commit (an
        # invoice re-books its receipts) is not booked again.
        # Only a batch none of whose postings has run yet: callbacks that already ran (an earlier
        # commit's, still listed while a test's outer transaction is open) belong to the past.
        run_batch = next((fn._accounting_batch for fn in pending
                          if getattr(fn, '_accounting_batch', None) is not None
                          and not fn._accounting_batch.started), None) or batch.Batch()

    def run():
        run._accounting_done = True
        if run_batch is None:
            book_source_safely(source_key, pk)
            return
        run_batch.started = True
        with batch.active(run_batch):
            if not batch.already_booked(key):
                book_source_safely(source_key, pk)

    run._accounting_key = key
    run._accounting_batch = run_batch
    transaction.on_commit(run)


# ---------------------------------------------------------------------------
# Admin tools: preview, retry, backfill, reconciliation
# ---------------------------------------------------------------------------

def _plan_lines_json(plan):
    return [{'account_id': str(l['account'].pk), 'account_code': l['account'].code, 'account_name': l['account'].name,
             'role': l.get('role'), 'debit': str(l['debit']), 'credit': str(l['credit']), 'memo': l.get('memo', '')}
            for l in plan['lines']]


def preview(source_key, pk):
    """What the engine would post for a document right now, without posting."""
    module, event = split_key(source_key)
    doc = load_document(source_key, pk)
    if doc is None:
        return {'error': 'Document not found.'}
    existing = live_entry(module, event, pk)
    result = {
        'source_key': source_key, 'source_number': document_number(source_key, doc),
        'document_date': document_date(source_key, doc).isoformat(),
        'posted_entry': existing.entry_number if existing else None,
        'historical': is_historical(AccountingPolicy.get(), source_key, doc),
    }
    try:
        plan = build_plan(source_key, doc)
    except AccountingError as exc:
        return {**result, 'error': error_text(exc)}
    if plan is None:
        return {**result, 'postable': False, 'lines': []}
    try:
        normalize_lines(plan['lines'])
        balanced, problem = True, None
    except AccountingError as exc:
        balanced, problem = False, error_text(exc)
    return {**result, 'postable': True, 'balanced': balanced, 'error': problem, 'narration': plan.get('narration'),
            'date': plan['date'].isoformat(), 'lines': _plan_lines_json(plan)}


def retry_failure(failure, user=None):
    key = f"{failure.source_module}.{failure.source_event}"
    if key not in REGISTRY:
        raise AccountingError(f"Unknown source {key}.")
    result = book_source_safely(key, failure.reference_id, user=user, force=True)
    audit('POSTING_RETRIED', 'posting_failure', failure.pk, f"Retry {key} {failure.source_number}: {result.get('outcome')}",
          after=result, user=user)
    return result


def _eligible_documents(source_key, date_from=None, date_to=None):
    Model = model_for(source_key)
    date_field = REGISTRY[source_key][2]
    qs = Model.all_objects.all()
    lookup = f"{date_field}__date" if date_field == 'created_at' else date_field
    if date_from:
        qs = qs.filter(**{f"{lookup}__gte": date_from})
    if date_to:
        qs = qs.filter(**{f"{lookup}__lte": date_to})
    return qs


def reconcile_source(source_key, date_from=None, date_to=None, limit=50):
    """Compare operational documents with the ledger for one source: documents that should
    be booked but aren't (missing), are booked but shouldn't be (stale), or are booked with
    different figures than the rule produces now (mismatched)."""
    from .services import lines_fingerprint, _parsed_from_entry
    module, event = split_key(source_key)
    policy = AccountingPolicy.get()
    live = {e.reference_id: e for e in JournalEntry.objects.filter(
        source_module=module, source_event=event, status='POSTED', is_reversal=False)}
    report = {'source_key': source_key, 'label': SOURCES[source_key][0], 'documents': 0, 'posted': 0,
              'missing': [], 'stale': [], 'mismatched': [], 'errors': [], 'historical_unposted': 0,
              'start_date': (policy.source_start_dates or {}).get(source_key)}
    for doc in _eligible_documents(source_key, date_from, date_to).iterator():
        report['documents'] += 1
        entry = live.get(doc.pk)
        try:
            plan = build_plan(source_key, doc)
        except AccountingError as exc:
            if len(report['errors']) < limit:
                report['errors'].append({'id': str(doc.pk), 'number': document_number(source_key, doc), 'error': error_text(exc)})
            continue
        info = {'id': str(doc.pk), 'number': document_number(source_key, doc),
                'date': document_date(source_key, doc).isoformat()}
        if plan is None:
            if entry and len(report['stale']) < limit:
                report['stale'].append({**info, 'entry': entry.entry_number})
            continue
        if entry is None:
            if is_historical(policy, source_key, doc):
                report['historical_unposted'] += 1
            elif len(report['missing']) < limit:
                report['missing'].append({**info, 'amount': str(sum((l['debit'] for l in plan['lines']), Decimal('0')))})
            continue
        report['posted'] += 1
        if lines_fingerprint(_parsed_from_entry(entry)) != lines_fingerprint(plan['lines']) or entry.date != plan['date']:
            if len(report['mismatched']) < limit:
                report['mismatched'].append({**info, 'entry': entry.entry_number})
    return report


def backfill(source_key, date_from=None, date_to=None, dry_run=True, user=None, limit=500):
    """Controlled posting of documents that have no live entry (historical data or
    anything missed). dry_run lists what would be posted without touching the books."""
    module, event = split_key(source_key)
    posted_ids = set(JournalEntry.objects.filter(source_module=module, source_event=event, status='POSTED',
                                                 is_reversal=False).values_list('reference_id', flat=True))
    rows = []
    for doc in _eligible_documents(source_key, date_from, date_to).iterator():
        if doc.pk in posted_ids or len(rows) >= limit:
            continue
        try:
            plan = build_plan(source_key, doc)
        except AccountingError as exc:
            rows.append({'id': str(doc.pk), 'number': document_number(source_key, doc), 'outcome': 'error', 'error': error_text(exc)})
            continue
        if plan is None:
            continue
        row = {'id': str(doc.pk), 'number': document_number(source_key, doc), 'date': plan['date'].isoformat(),
               'amount': str(sum((l['debit'] for l in plan['lines']), Decimal('0')))}
        if dry_run:
            rows.append({**row, 'outcome': 'would_post'})
        else:
            rows.append({**row, **book_source_safely(source_key, doc.pk, user=user, force=True, cascade=False)})
    if not dry_run:
        audit('BACKFILL', 'source', source_key, f"Backfilled {len(rows)} {source_key} document(s)",
              after={'date_from': str(date_from or ''), 'date_to': str(date_to or ''), 'count': len(rows)}, user=user)
    return rows


def _role_account_balance(role):
    try:
        acc = resolve_role(role)
    except AccountingError:
        return None, None
    agg = LedgerEntry.objects.filter(account=acc, journal_entry__status__in=JournalEntry.LEDGER_STATUSES,
                                     journal_entry__is_deleted=False).aggregate(dr=Sum('debit'), cr=Sum('credit'))
    return acc, money((agg['dr'] or 0) - (agg['cr'] or 0))


def subledger_reconciliation():
    """Control accounts in the GL vs the operational subledgers they summarise."""
    Invoice = django_apps.get_model('sales.Invoice')
    Dealer = django_apps.get_model('sales.Dealer')
    Supplier = django_apps.get_model('purchasing.Supplier')
    Product = django_apps.get_model('products.Product')
    rows = []

    acc, gl = _role_account_balance('RETAIL_RECEIVABLE')
    outstanding = Decimal('0')
    for inv in Invoice.objects.filter(document_type='INVOICE').exclude(status__in=('DRAFT', 'CANCELLED')):
        if not rules.invoice_is_wholesale(inv):
            outstanding += max(money(inv.net_amount) - money(inv.paid_amount), Decimal('0'))
    rows.append({'name': 'Retail receivables', 'account': acc.code if acc else None, 'ledger': str(gl) if gl is not None else None,
                 'subledger': str(money(outstanding)), 'subledger_source': 'Invoices: net − paid'})

    acc, gl = _role_account_balance('WHOLESALE_RECEIVABLE')
    dealers = money(Dealer.objects.aggregate(s=Sum('outstanding_balance'))['s'] or 0) if hasattr(Dealer, 'outstanding_balance') else None
    rows.append({'name': 'Wholesale receivables', 'account': acc.code if acc else None, 'ledger': str(gl) if gl is not None else None,
                 'subledger': str(dealers) if dealers is not None else None, 'subledger_source': 'Dealer outstanding balances'})

    payable_ids = set(Supplier.objects.exclude(ledger_account=None).values_list('ledger_account_id', flat=True))
    try:
        payable_ids.add(resolve_role('SUPPLIER_PAYABLE').pk)
    except AccountingError:
        pass
    agg = LedgerEntry.objects.filter(account_id__in=payable_ids, journal_entry__status__in=JournalEntry.LEDGER_STATUSES,
                                     journal_entry__is_deleted=False).aggregate(dr=Sum('debit'), cr=Sum('credit'))
    ap = money((agg['cr'] or 0) - (agg['dr'] or 0))
    suppliers = money(Supplier.objects.aggregate(s=Sum('outstanding_balance'))['s'] or 0)
    rows.append({'name': 'Supplier payables', 'account': 'AP + supplier sub-ledgers', 'ledger': str(ap),
                 'subledger': str(suppliers), 'subledger_source': 'Supplier outstanding balances'})

    acc, gl = _role_account_balance('INVENTORY')
    stock_value = Decimal('0')
    for stock, cost in Product.objects.values_list('stock', 'cost_price'):
        stock_value += Decimal(stock or 0) * money(cost)
    rows.append({'name': 'Inventory', 'account': acc.code if acc else None, 'ledger': str(gl) if gl is not None else None,
                 'subledger': str(money(stock_value)), 'subledger_source': 'Σ product stock × cost price'})

    for r in rows:
        if r['ledger'] is not None and r['subledger'] is not None:
            r['difference'] = str(money(Decimal(r['ledger']) - Decimal(r['subledger'])))
        else:
            r['difference'] = None
    return rows


def integration_status():
    from django.db.models import Count
    from .mapping import role_status
    roles = role_status()
    open_failures = PostingFailure.objects.filter(status='OPEN')
    dupes = list(JournalEntry.objects.filter(status='POSTED', is_reversal=False).exclude(source_module='')
                 .exclude(reference_id=None).values('source_module', 'source_event', 'reference_id')
                 .annotate(n=Count('id')).filter(n__gt=1)[:50])
    legacy_dupes = JournalEntry.objects.filter(status='POSTED', source_event__startswith='legacy_duplicate').count()
    agg = LedgerEntry.objects.filter(journal_entry__status__in=JournalEntry.LEDGER_STATUSES,
                                     journal_entry__is_deleted=False).aggregate(dr=Sum('debit'), cr=Sum('credit'))
    policy = AccountingPolicy.get()
    return {
        'auto_posting_enabled': policy.auto_posting_enabled,
        'unmapped_roles': [r for r in roles if not r['valid']],
        'open_failures': open_failures.count(),
        'failures_by_kind': list(open_failures.values('kind').annotate(n=Count('id'))),
        'duplicate_live_entries': [{**d, 'reference_id': str(d['reference_id'])} for d in dupes],
        'legacy_duplicate_entries': legacy_dupes,
        'ledger_debits': str(money(agg['dr'] or 0)), 'ledger_credits': str(money(agg['cr'] or 0)),
        'ledger_balanced': money(agg['dr'] or 0) == money(agg['cr'] or 0),
        'draft_vouchers': JournalEntry.objects.filter(status__in=('DRAFT', 'PENDING_APPROVAL')).count(),
        'inactive_accounts_in_use': ChartOfAccount.objects.filter(status='Inactive', mappings__is_active=True).distinct().count(),
    }
