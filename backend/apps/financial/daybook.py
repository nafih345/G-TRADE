"""Day Book: every posted financial transaction, day by day, in the order it happened.

There is no day book table. It reads the same posted journals the Ledger, Cashbook and Trial
Balance read (status POSTED / REVERSED, not deleted), so nothing can appear here that is not on
the books, and nothing on the books is left out: sales and credit sales, receipts, refunds,
advances, eye test fees, wholesale bills and collections, purchases and their payments, stock
adjustments and every manual voucher.

A row is a *transaction*: one source document's journals on one date.
- A retail bill and the receipts taken against it that day are one transaction. New Sale saves a
  split payment as one receipt per pay mode (Cash, UPI, Card, Bank), so each mode is listed as
  its own payment line under the bill, and any unpaid rest shows as "Credit".
- Likewise a wholesale bill with that day's collections, and a purchase entry with its payment.
- A receipt for an older bill, an advance against an order, a voucher or a stock adjustment is a
  transaction of its own.

Payment mode is read from the line that hits a money account (cash / bank, or whatever account
the Cash, Bank, Card and UPI roles are mapped to): the line memo carries the method the money was
taken in ("Cash", "UPI", "Card", "Cheque" ...); without one, the account decides (cash vs bank).

Rules shared with the Cashbook:
- A reversed journal and its reversal both inside the listed range are a void that nets to zero:
  hidden unless show_reversed. A half pair straddling the range stays.
- Kind / mode filters and search narrow the rows listed; the summary always covers the whole
  period and branch, so it reconciles with the Ledger. `matched` totals the listed rows.
- Time is when the journal was posted (local time), which for counter documents is the moment
  the bill or receipt was saved.
"""
from collections import OrderedDict, defaultdict
from decimal import Decimal

from django.utils import timezone

from .accounting_catalog import PAYMENT_METHOD_ROLES, SOURCES
from .cashbook import _is_bank, _is_cash
from .models import JournalEntry, LedgerEntry, PostingFailure
from .services import money

ZERO = Decimal('0')
MAX_PAGE_SIZE = 500
MAX_EXPORT_ROWS = 20000

MODES = ('Cash', 'UPI', 'Card', 'Bank', 'Cheque', 'Credit')
_ROLE_MODES = {'CASH': 'Cash', 'PAYMENT_UPI': 'UPI', 'PAYMENT_CARD': 'Card', 'BANK': 'Bank'}
MONEY_ROLES = ('CASH', 'BANK', 'PAYMENT_CARD', 'PAYMENT_UPI')

KIND_LABELS = OrderedDict([
    ('SALE', 'Sale'),
    ('WHOLESALE_SALE', 'Wholesale Sale'),
    ('RECEIPT', 'Receipt'),
    ('ADVANCE', 'Advance Receipt'),
    ('REFUND', 'Refund'),
    ('EYE_TEST_FEE', 'Eye Test Fee'),
    ('WHOLESALE_COLLECTION', 'Wholesale Collection'),
    ('SALES_RETURN', 'Sales Return'),
    ('PURCHASE', 'Purchase'),
    ('PURCHASE_PAYMENT', 'Purchase Payment'),
    ('STOCK', 'Stock Adjustment'),
    ('RECEIPT_VOUCHER', 'Receipt Voucher'),
    ('PAYMENT_VOUCHER', 'Payment Voucher'),
    ('CONTRA', 'Contra'),
    ('JOURNAL', 'Journal'),
    ('OPENING', 'Opening Balance'),
])
# Kinds whose amount is a bill: the unpaid part of it is shown as a "Credit" payment line.
BILL_KINDS = {'SALE', 'WHOLESALE_SALE', 'PURCHASE'}


class DayBookError(ValueError):
    pass


def _money_account_ids():
    """Accounts the Cash / Bank / Card / UPI roles are mapped to (they may sit outside the
    cash and bank groups)."""
    from .models import AccountMapping
    return set(AccountMapping.objects.filter(role__in=MONEY_ROLES).values_list('account_id', flat=True))


def _mode(line, acc, money_ids):
    """Payment mode of a ledger line, or None when the line is not money moving."""
    if not (acc.pk in money_ids or _is_cash(acc) or _is_bank(acc)):
        return None
    text = (line.memo or '').lower()
    if 'cheque' in text or 'check' in text:
        return 'Cheque'
    for needle, role in PAYMENT_METHOD_ROLES:
        if needle in text and role in _ROLE_MODES:
            return _ROLE_MODES[role]
    return 'Cash' if _is_cash(acc) else 'Bank'


def _local_time(dt):
    if dt is None:
        return None
    return timezone.localtime(dt) if timezone.is_aware(dt) else dt


def _source_lookups(entries):
    """Linked documents for grouping and party names, in one query per source type."""
    refs = defaultdict(set)
    for je in entries:
        if je.reference_id:
            refs[je.source_key].add(je.reference_id)
    out = {'payments': {}, 'invoices': {}, 'collections': {}, 'wholesale': {}, 'purchases': {},
           'receipts': {}}

    from apps.sales.models import Invoice, Payment, WholesaleInvoice, WholesalePaymentCollection
    if refs['sales.payment']:
        for p in Payment.all_objects.filter(pk__in=refs['sales.payment']).values(
                'pk', 'invoice_id', 'customer_name', 'invoice__invoice_number', 'invoice__document_type',
                'invoice__customer_name'):
            out['payments'][p['pk']] = p
    invoice_ids = set(refs['sales.invoice']) | {p['invoice_id'] for p in out['payments'].values() if p['invoice_id']}
    if invoice_ids:
        for i in Invoice.all_objects.filter(pk__in=invoice_ids).values(
                'pk', 'invoice_number', 'customer_name', 'net_amount', 'total_amount', 'document_type'):
            out['invoices'][i['pk']] = i
        # Live receipts per bill, so money taken on an earlier day (an advance on the order) is
        # not shown as credit on the day the bill is raised.
        dead = ('CANCELLED', 'VOID', 'VOIDED', 'FAILED', 'REVERSED')
        out['receipts'] = defaultdict(list)
        for p in Payment.objects.filter(invoice_id__in=refs['sales.invoice']).values(
                'invoice_id', 'payment_date', 'amount', 'status'):
            if (p['status'] or '').upper() not in dead:
                out['receipts'][p['invoice_id']].append((p['payment_date'], money(p['amount'] or 0)))
    if refs['sales.wholesale_collection']:
        for c in WholesalePaymentCollection.all_objects.filter(pk__in=refs['sales.wholesale_collection']).values(
                'pk', 'invoice_number', 'dealer__business_name'):
            out['collections'][c['pk']] = c
    if refs['sales.wholesale_invoice']:
        for w in WholesaleInvoice.all_objects.filter(pk__in=refs['sales.wholesale_invoice']).values(
                'pk', 'invoice_number', 'grand_total', 'dealer__business_name'):
            out['wholesale'][w['pk']] = w
    purchase_ids = refs['purchasing.purchase_invoice'] | refs['purchasing.purchase_payment']
    if purchase_ids:
        from apps.purchasing.models import PurchaseInvoice
        for pi in PurchaseInvoice.all_objects.filter(pk__in=purchase_ids).values(
                'pk', 'invoice_number', 'supplier_invoice_number', 'grand_total', 'supplier__name'):
            out['purchases'][pi['pk']] = pi
    return out


def _group_key(je, look):
    """Journals that belong to one transaction share a key (always within one date)."""
    key, ref = je.source_key, je.reference_id
    if key == 'sales.invoice' and ref:
        return ('sales', ref)
    if key == 'sales.payment':
        p = look['payments'].get(ref)
        if p and p['invoice_id']:
            return ('sales', p['invoice_id'])
    if key == 'sales.wholesale_invoice' and je.source_number:
        return ('wholesale', je.source_number)
    if key == 'sales.wholesale_collection':
        c = look['collections'].get(ref)
        if c and c['invoice_number']:
            return ('wholesale', c['invoice_number'])
    if key in ('purchasing.purchase_invoice', 'purchasing.purchase_payment') and ref:
        return ('purchase', ref)
    return ('je', je.pk)


def _kind(primary, entries, money_in, money_out, look):
    keys = {je.source_key for je in entries}
    if 'sales.invoice' in keys:
        return 'WHOLESALE_SALE' if primary.reference_type == 'WHOLESALE' else 'SALE'
    if 'sales.wholesale_invoice' in keys:
        return 'WHOLESALE_SALE'
    if keys & {'purchasing.purchase_invoice', 'purchasing.purchase_order'}:
        return 'PURCHASE'
    key = primary.source_key
    if key == 'sales.payment':
        if money_out > money_in:
            return 'REFUND'
        p = look['payments'].get(primary.reference_id)
        if not p or not p['invoice_id'] or str(p['invoice__document_type'] or 'INVOICE').upper() != 'INVOICE':
            return 'ADVANCE' if p and p['invoice_id'] else 'RECEIPT'
        return 'RECEIPT'
    simple = {'sales.eye_test_fee': 'EYE_TEST_FEE', 'sales.wholesale_collection': 'WHOLESALE_COLLECTION',
              'sales.wholesale_return': 'SALES_RETURN', 'purchasing.purchase_payment': 'PURCHASE_PAYMENT',
              'inventory.stock_adjustment': 'STOCK'}
    if key in simple:
        return simple[key]
    vtype = primary.voucher_type.code if primary.voucher_type_id else ''
    if vtype == 'OB' or primary.reference_type == 'OPENING_BALANCE' or primary.source_event == 'opening_balance':
        return 'OPENING'
    if vtype == 'CV' or (money_in > 0 and money_in == money_out):
        return 'CONTRA'
    if vtype == 'RV' or (money_in > 0 and not money_out):
        return 'RECEIPT_VOUCHER'
    if vtype == 'PV' or (money_out > 0 and not money_in):
        return 'PAYMENT_VOUCHER'
    return 'JOURNAL'


def _reference_and_party(primary, kind, look):
    """(bill / reference number, party name) for a transaction."""
    ref, key = primary.reference_id, primary.source_key
    if key in ('sales.invoice', 'sales.payment'):
        p = look['payments'].get(ref) if key == 'sales.payment' else None
        inv = look['invoices'].get(p['invoice_id'] if p else ref)
        party = (inv or {}).get('customer_name') or (p or {}).get('customer_name') or ''
        return ((inv or {}).get('invoice_number') or primary.source_number, party)
    if key in ('sales.wholesale_invoice', 'sales.wholesale_collection'):
        doc = look['wholesale'].get(ref) or look['collections'].get(ref) or {}
        return (doc.get('invoice_number') or primary.source_number, doc.get('dealer__business_name') or '')
    if key in ('purchasing.purchase_invoice', 'purchasing.purchase_payment'):
        pi = look['purchases'].get(ref) or {}
        return (pi.get('invoice_number') or primary.source_number, pi.get('supplier__name') or '')
    return (primary.source_number or primary.entry_number, '')


def _bill_amount(primary, kind, look):
    """Face value of a bill (what was billed, before any payment), else None."""
    if kind not in BILL_KINDS:
        return None
    ref = primary.reference_id
    if primary.source_key == 'sales.invoice':
        inv = look['invoices'].get(ref)
        if inv:
            return money(inv['net_amount'] or inv['total_amount'] or 0)
    if primary.source_key == 'sales.wholesale_invoice':
        w = look['wholesale'].get(ref)
        if w:
            return money(w['grand_total'] or 0)
    if primary.source_key == 'purchasing.purchase_invoice':
        pi = look['purchases'].get(ref)
        if pi:
            return money(pi['grand_total'] or 0)
    return None


def daybook(date_from, date_to, branch_ids=None, search='', kinds=None, modes=None, show_reversed=False,
            page=1, page_size=100, export=False):
    """`branch_ids`: None = every branch (and journals with no branch), else the branch ids the
    journals must belong to. `kinds` / `modes`: optional lists narrowing the rows listed."""
    if not date_from or not date_to:
        raise DayBookError('Choose a From and To date.')
    if date_from > date_to:
        raise DayBookError('From date must be on or before To date.')

    qs = (JournalEntry.objects.filter(status__in=JournalEntry.LEDGER_STATUSES, is_deleted=False,
                                      date__gte=date_from, date__lte=date_to)
          .select_related('voucher_type', 'branch')
          .order_by('date', 'created_at', 'entry_number'))
    if branch_ids is not None:
        qs = qs.filter(branch_id__in=branch_ids)
    entries = list(qs)

    hidden = set()
    if not show_reversed:
        ids = {je.pk for je in entries}
        for je in entries:
            if je.is_reversal and je.reversed_entry_id in ids:
                hidden.update((je.pk, je.reversed_entry_id))
        entries = [je for je in entries if je.pk not in hidden]

    lines_by_entry = defaultdict(list)
    for l in (LedgerEntry.objects.filter(journal_entry_id__in=[je.pk for je in entries])
              .select_related('account__account_group').order_by('id')):
        lines_by_entry[l.journal_entry_id].append(l)

    look = _source_lookups(entries)
    money_ids = _money_account_ids()

    buckets = OrderedDict()
    for je in entries:
        buckets.setdefault((je.date, _group_key(je, look)), []).append(je)

    groups = [_build_group(date, members, lines_by_entry, money_ids, look)
              for (date, _key), members in buckets.items()]
    # Ordered by the moment each transaction started; a later receipt on an earlier bill stays
    # under the bill.
    groups.sort(key=lambda g: (g['date'], g['_sort']))

    summary = _summary(groups, len(hidden))
    days = _day_totals(groups)

    listed = groups
    kinds = [k for k in (kinds or []) if k in KIND_LABELS]
    if kinds:
        listed = [g for g in listed if g['kind'] in kinds]
    modes = [m for m in (modes or []) if m in MODES]
    if modes:
        listed = [g for g in listed if any(p['mode'] in modes for p in g['payments'])]
    s = (search or '').strip()
    if s:
        needle = s.lower()
        listed = [g for g in listed if needle in g['_text']]

    count = len(listed)
    if export:
        page, page_size = 1, MAX_EXPORT_ROWS
    else:
        page_size = max(1, min(int(page_size or 100), MAX_PAGE_SIZE))
    num_pages = max(1, -(-count // page_size))
    page = max(1, min(int(page or 1), num_pages))
    start = (page - 1) * page_size
    window = listed[start:start + page_size]
    for i, g in enumerate(window):
        g['row_no'] = start + i + 1

    filtered = bool(kinds or modes or s)
    return {
        'date_from': date_from.isoformat(), 'date_to': date_to.isoformat(),
        'summary': summary,
        'days': days,
        'search': s, 'kinds': kinds, 'modes': modes,
        'matched': {'count': count, 'filtered': filtered,
                    'total_debit': str(money(sum((D(g['total_debit']) for g in listed), ZERO))),
                    'total_credit': str(money(sum((D(g['total_credit']) for g in listed), ZERO))),
                    'money_in': str(money(sum((D(g['money_in']) for g in listed), ZERO))),
                    'money_out': str(money(sum((D(g['money_out']) for g in listed), ZERO)))},
        'page': page, 'page_size': page_size, 'num_pages': num_pages, 'count': count,
        'truncated': export and count > MAX_EXPORT_ROWS,
        'kind_options': [{'value': k, 'label': v} for k, v in KIND_LABELS.items()],
        'mode_options': list(MODES),
        'posting_failures': PostingFailure.objects.filter(status='OPEN').count(),
        'rows': [{k: v for k, v in g.items() if not k.startswith('_')} for g in window],
    }


def D(value):
    return Decimal(str(value or 0))


def _build_group(date, members, lines_by_entry, money_ids, look):
    members = sorted(members, key=lambda je: (je.created_at, je.entry_number))
    doc_keys = ('sales.invoice', 'sales.wholesale_invoice', 'purchasing.purchase_invoice', 'purchasing.purchase_order')
    primary = next((je for je in members if je.source_key in doc_keys and not je.is_reversal), members[0])

    out_entries, pay = [], OrderedDict()
    total_dr = total_cr = money_in = money_out = ZERO
    text = []
    for je in members:
        rows = []
        # Debits before credits (line ids are UUIDs, so insertion order is not recoverable).
        for l in sorted(lines_by_entry.get(je.pk, []), key=lambda l: (not l.debit, -(l.debit or l.credit or 0))):
            acc = l.account
            mode = _mode(l, acc, money_ids)
            dr, cr = money(l.debit or 0), money(l.credit or 0)
            total_dr += dr
            total_cr += cr
            rows.append({'account_id': str(acc.pk), 'account_code': acc.code, 'account_name': acc.name,
                         'debit': str(dr) if dr else None, 'credit': str(cr) if cr else None,
                         'memo': l.memo or '', 'mode': mode})
            text.extend((acc.name, acc.code, l.memo or ''))
            if mode:
                money_in += dr
                money_out += cr
                p = pay.setdefault((mode, acc.pk), {'mode': mode, 'account_name': acc.name,
                                                    'amount_in': ZERO, 'amount_out': ZERO, 'references': []})
                p['amount_in'] += dr
                p['amount_out'] += cr
                if je.source_number and je.source_number not in p['references'] and je is not primary:
                    p['references'].append(je.source_number)
        posted = _local_time(je.posted_at or je.created_at)
        out_entries.append({
            'entry_id': str(je.pk), 'entry_number': je.entry_number, 'date': je.date.isoformat(),
            'time': posted.strftime('%H:%M') if posted else '',
            'voucher_type': je.voucher_type.code if je.voucher_type_id else '',
            'source_module': je.source_module, 'source_event': je.source_event, 'source_key': je.source_key,
            'source_label': SOURCES.get(je.source_key, ('Manual voucher',))[0] if je.source_module not in ('', 'financial') else 'Manual voucher',
            'source_number': je.source_number,
            'reference_id': str(je.reference_id) if je.reference_id else None,
            'narration': je.narration or '', 'status': je.status, 'is_reversal': je.is_reversal,
            'total_amount': str(money(je.total_amount)), 'lines': rows,
        })
        text.extend((je.entry_number, je.source_number or '', je.narration or ''))

    kind = _kind(primary, members, money_in, money_out, look)
    reference, party = _reference_and_party(primary, kind, look)
    bill = _bill_amount(primary, kind, look)
    payments = []
    for p in pay.values():
        net_in, net_out = p['amount_in'] - min(p['amount_in'], p['amount_out']), p['amount_out'] - min(p['amount_in'], p['amount_out'])
        if not net_in and not net_out:
            continue
        payments.append({'mode': p['mode'], 'account_name': p['account_name'],
                         'amount_in': str(money(net_in)) if net_in else None,
                         'amount_out': str(money(net_out)) if net_out else None,
                         'references': p['references']})
    payments.sort(key=lambda p: MODES.index(p['mode']))
    settled = (money_in - money_out) if kind != 'PURCHASE' else (money_out - money_in)
    paid_earlier = ZERO
    if primary.source_key == 'sales.invoice':
        paid_earlier = sum((amt for day, amt in look['receipts'].get(primary.reference_id, ())
                            if day and day < date), ZERO)
    credit = money(bill - settled - paid_earlier) if bill is not None and bill - settled - paid_earlier > 0 else ZERO
    if credit > 0:
        payments.append({'mode': 'Credit', 'account_name': 'Unpaid balance', 'references': [],
                         'amount_in': str(credit) if kind != 'PURCHASE' else None,
                         'amount_out': str(credit) if kind == 'PURCHASE' else None})
    amount = bill if bill is not None else max(money_in, money_out, money(primary.total_amount))
    if any(je.is_reversal for je in members) and all(je.is_reversal for je in members):
        status = 'REVERSAL'
    elif any(je.status == 'REVERSED' for je in members):
        status = 'REVERSED'
    else:
        status = 'POSTED'
    branch = primary.branch if primary.branch_id else None
    text.extend((reference or '', party, KIND_LABELS[kind]))
    first = _local_time(members[0].posted_at or members[0].created_at)
    return {
        'id': f"{date.isoformat()}:{primary.pk}",
        'date': date.isoformat(), 'time': first.strftime('%H:%M') if first else '',
        'kind': kind, 'kind_label': KIND_LABELS[kind],
        'reference': reference or '', 'party': party,
        'description': primary.narration or '',
        'branch_id': str(branch.pk) if branch else None, 'branch_name': branch.name if branch else '',
        'status': status,
        'amount': str(money(amount)),
        'total_debit': str(money(total_dr)), 'total_credit': str(money(total_cr)),
        'money_in': str(money(money_in)), 'money_out': str(money(money_out)),
        'credit_amount': str(credit) if credit else None,
        'paid_earlier': str(money(paid_earlier)) if paid_earlier else None,
        'payments': payments,
        'entries': out_entries,
        # primary journal for "Show bill"
        'entry_id': str(primary.pk), 'entry_number': primary.entry_number,
        'source_module': primary.source_module, 'source_event': primary.source_event,
        'source_number': primary.source_number,
        'reference_id': str(primary.reference_id) if primary.reference_id else None,
        'is_reversal': primary.is_reversal,
        '_sort': (members[0].created_at, members[0].entry_number),
        '_text': ' '.join(t for t in text if t).lower(),
    }


def _summary(groups, hidden):
    by_mode = OrderedDict((m, {'mode': m, 'amount_in': ZERO, 'amount_out': ZERO, 'count': 0}) for m in MODES)
    by_kind = OrderedDict()
    tot = defaultdict(lambda: ZERO)
    for g in groups:
        tot['debit'] += D(g['total_debit'])
        tot['credit'] += D(g['total_credit'])
        tot['in'] += D(g['money_in'])
        tot['out'] += D(g['money_out'])
        if g['kind'] in ('SALE', 'WHOLESALE_SALE'):
            tot['sales'] += D(g['amount'])
        elif g['kind'] == 'PURCHASE':
            tot['purchases'] += D(g['amount'])
        k = by_kind.setdefault(g['kind'], {'kind': g['kind'], 'label': g['kind_label'], 'count': 0, 'amount': ZERO})
        k['count'] += 1
        k['amount'] += D(g['amount'])
        for p in g['payments']:
            m = by_mode[p['mode']]
            m['amount_in'] += D(p['amount_in'])
            m['amount_out'] += D(p['amount_out'])
            m['count'] += 1
    return {
        'transactions': len(groups), 'journals': sum(len(g['entries']) for g in groups),
        'hidden_reversals': hidden,
        'total_debit': str(money(tot['debit'])), 'total_credit': str(money(tot['credit'])),
        'money_in': str(money(tot['in'])), 'money_out': str(money(tot['out'])),
        'net_money': str(money(tot['in'] - tot['out'])),
        'sales_total': str(money(tot['sales'])), 'purchases_total': str(money(tot['purchases'])),
        'by_mode': [{'mode': m['mode'], 'count': m['count'], 'amount_in': str(money(m['amount_in'])),
                     'amount_out': str(money(m['amount_out'])), 'net': str(money(m['amount_in'] - m['amount_out']))}
                    for m in by_mode.values() if m['count']],
        'by_kind': [{'kind': k['kind'], 'label': k['label'], 'count': k['count'], 'amount': str(money(k['amount']))}
                    for k in sorted(by_kind.values(), key=lambda k: list(KIND_LABELS).index(k['kind']))],
    }


def _day_totals(groups):
    days = OrderedDict()
    for g in groups:
        d = days.setdefault(g['date'], {'date': g['date'], 'transactions': 0, 'total_debit': ZERO,
                                        'total_credit': ZERO, 'money_in': ZERO, 'money_out': ZERO})
        d['transactions'] += 1
        for k in ('total_debit', 'total_credit', 'money_in', 'money_out'):
            d[k] += D(g[k])
    return [{**d, **{k: str(money(d[k])) for k in ('total_debit', 'total_credit', 'money_in', 'money_out')}}
            for d in days.values()]
