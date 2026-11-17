"""Evidence-only branch backfill for wholesale documents (P1 Task 5) and eye examinations /
appointments (P1 Task 6). Shared by migrations 0038 / 0039 and `manage.py branch_backfill_report`.

Rules are applied per tenant, on rows whose branch is still NULL; a row that already has a branch
is never touched, so every run after the first changes nothing. Nothing is ever guessed: a row
without reliable evidence stays NULL ("Unassigned", visible to unrestricted users only). The
default branch is NEVER used as a fallback (approved P1-Q3 / P1-Q4).

Wholesale (P1-Q3 = Unassigned unless proven):
  W1 invoice   stock_applied['branch'] — the branch its stock was actually deducted from — when
               that branch exists in the tenant.
  W2 invoice   the branch of its StockLedger rows (reference_id = invoice id), when exactly one.
  W3 order     its billing invoice's branch.  challan  its order's branch.
     collection / return   the branch of the invoice with that invoice_number (unique per tenant).
     quotation  its converted order's, else converted invoice's, branch.
  W4 any       the tenant has exactly one branch row ever (deleted ones included): certain.
  otherwise    NULL.

Eye exams / appointments (P1-Q4):
  E1 the legacy text matches exactly one branch of the tenant by name or code, compared after
     trimming, collapsing spaces and case-folding.
  E2 the literal UI default 'Main Branch' counts only when the tenant has exactly one branch.
  otherwise NULL, and the distinct unmatched texts are reported for manual mapping.
"""
import re
from collections import Counter, defaultdict

WHOLESALE_MODELS = ('WholesaleInvoice', 'WholesaleOrder', 'WholesaleDeliveryChallan', 'WholesalePaymentCollection',
                    'WholesaleReturn', 'WholesaleQuotation')
UI_DEFAULT_BRANCH_TEXT = 'main branch'


def _norm(text):
    return re.sub(r'\s+', ' ', str(text or '')).strip().casefold()


def _tenant_branches(Branch, tenant_id):
    return list(Branch._base_manager.filter(tenant_id=tenant_id).values('id', 'name', 'code', 'is_deleted'))


def backfill_wholesale_tenant(get_model, tenant_id, apply=True):
    """Returns {model: Counter(rule -> rows)}; with apply=False nothing is written."""
    Branch = get_model('company', 'Branch')
    StockLedger = get_model('inventory', 'StockLedger')
    M = {name: get_model('sales', name) for name in WHOLESALE_MODELS}
    branches = _tenant_branches(Branch, tenant_id)
    branch_ids = {str(b['id']) for b in branches}
    only = str(branches[0]['id']) if len(branches) == 1 else None
    report = {name: Counter() for name in WHOLESALE_MODELS}
    assigned = {name: {} for name in WHOLESALE_MODELS}  # pk -> branch id (this run, for later rules)

    def existing(name):
        return {str(pk): str(b) for pk, b in M[name]._base_manager.filter(tenant_id=tenant_id, branch__isnull=False)
                .values_list('pk', 'branch_id')}

    def set_branch(name, pk, branch_id, rule):
        assigned[name][str(pk)] = branch_id
        report[name][rule] += 1
        if apply:
            M[name]._base_manager.filter(pk=pk, branch__isnull=True).update(branch_id=branch_id)

    def todo(name):
        return M[name]._base_manager.filter(tenant_id=tenant_id, branch__isnull=True)

    # Invoices: W1, W2, W4.
    ledger_branches = defaultdict(set)
    inv_ids = list(todo('WholesaleInvoice').values_list('pk', flat=True))
    if inv_ids:
        for ref, b in StockLedger._base_manager.filter(tenant_id=tenant_id, reference_id__in=inv_ids,
                                                       branch__isnull=False).values_list('reference_id', 'branch_id'):
            ledger_branches[str(ref)].add(str(b))
    for pk, applied in todo('WholesaleInvoice').values_list('pk', 'stock_applied'):
        b = str((applied or {}).get('branch') or '') if isinstance(applied, dict) else ''
        if b and b in branch_ids:
            set_branch('WholesaleInvoice', pk, b, 'W1_stock_applied')
        elif len(ledger_branches.get(str(pk), ())) == 1:
            set_branch('WholesaleInvoice', pk, next(iter(ledger_branches[str(pk)])), 'W2_stock_ledger')
        elif only:
            set_branch('WholesaleInvoice', pk, only, 'W4_single_branch')
        else:
            report['WholesaleInvoice']['unassigned'] += 1

    inv_branch = {**existing('WholesaleInvoice'), **assigned['WholesaleInvoice']}
    inv_by_number = {}
    for pk, number in M['WholesaleInvoice']._base_manager.filter(tenant_id=tenant_id).values_list('pk', 'invoice_number'):
        inv_by_number[number] = str(pk)

    def by_parent(name, parent_branch_of):
        for row in todo(name).values('pk', *parent_branch_of[0]):
            b = parent_branch_of[1](row)
            if b:
                set_branch(name, row['pk'], b, 'W3_source_document')
            elif only:
                set_branch(name, row['pk'], only, 'W4_single_branch')
            else:
                report[name]['unassigned'] += 1

    by_parent('WholesaleOrder', (('invoice_id',), lambda r: inv_branch.get(str(r['invoice_id'])) if r['invoice_id'] else None))
    order_branch = {**existing('WholesaleOrder'), **assigned['WholesaleOrder']}
    by_parent('WholesaleDeliveryChallan', (('order_id',), lambda r: order_branch.get(str(r['order_id']))))
    by_parent('WholesalePaymentCollection', (('invoice_number',),
                                            lambda r: inv_branch.get(inv_by_number.get(r['invoice_number'] or ''))))
    by_parent('WholesaleReturn', (('invoice_number',),
                                 lambda r: inv_branch.get(inv_by_number.get(r['invoice_number'] or ''))))
    order_by_number = {n: str(pk) for pk, n in M['WholesaleOrder']._base_manager.filter(tenant_id=tenant_id)
                       .values_list('pk', 'order_number')}
    by_parent('WholesaleQuotation', (('converted_order_number', 'converted_invoice_number'),
                                    lambda r: order_branch.get(order_by_number.get(r['converted_order_number'] or ''))
                                    or inv_branch.get(inv_by_number.get(r['converted_invoice_number'] or ''))))
    return report


def match_branch_text(text, branches):
    """The branch id a legacy branch text names unambiguously, else None."""
    key = _norm(text)
    if not key:
        return None
    live = [b for b in branches]
    if key == UI_DEFAULT_BRANCH_TEXT and len(live) != 1:
        # The hardcoded UI default is not evidence of where the visit happened (P1-Q4) - unless
        # it is literally the name or code of one branch.
        hits = [b for b in live if _norm(b['name']) == key or _norm(b['code']) == key]
        return str(hits[0]['id']) if len(hits) == 1 else None
    if key == UI_DEFAULT_BRANCH_TEXT and len(live) == 1:
        return str(live[0]['id'])
    hits = {str(b['id']) for b in live if _norm(b['name']) == key or (b['code'] and _norm(b['code']) == key)}
    return next(iter(hits)) if len(hits) == 1 else None


def backfill_exam_tenant(get_model, tenant_id, apply=True):
    """Returns {model: {'matched': n, 'unassigned': n, 'blank': n, 'unmatched_texts': Counter}}."""
    Branch = get_model('company', 'Branch')
    branches = _tenant_branches(Branch, tenant_id)
    report = {}
    for name in ('EyeExamination', 'Appointment'):
        model = get_model('sales', name)
        stats = {'matched': 0, 'unassigned': 0, 'blank': 0, 'unmatched_texts': Counter()}
        cache = {}
        for pk, text in model._base_manager.filter(tenant_id=tenant_id, branch_ref__isnull=True) \
                .values_list('pk', 'branch'):
            if not _norm(text):
                stats['blank'] += 1
                if len(branches) == 1:
                    # A one-branch tenant: every visit necessarily happened there.
                    stats['matched'] += 1
                    if apply:
                        model._base_manager.filter(pk=pk, branch_ref__isnull=True).update(branch_ref_id=branches[0]['id'])
                continue
            key = _norm(text)
            if key not in cache:
                cache[key] = match_branch_text(text, branches)
            b = cache[key]
            if b:
                stats['matched'] += 1
                if apply:
                    model._base_manager.filter(pk=pk, branch_ref__isnull=True).update(branch_ref_id=b)
            else:
                stats['unassigned'] += 1
                stats['unmatched_texts'][str(text).strip()] += 1
        report[name] = stats
    return report


def tenant_ids(get_model):
    return list(get_model('common', 'Tenant')._base_manager.values_list('pk', flat=True))
