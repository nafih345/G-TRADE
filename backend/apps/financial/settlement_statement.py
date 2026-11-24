"""Bill-to-Bill Settlement Statement (Accounts → Reports and Financial → Settlement Statement).

Three read-only views over the settlement records that settlements.py writes (BillSettlement /
BillAllocation) and the documents the dues live on:

  * settlement_list   — every bill-to-bill Receipt / Payment Voucher in a period, each with its
                        payment source breakdown (Cash / Cheque # / Bank …) and the bills it
                        closed or part-settled (bill total, due before, settled, due after).
  * settlement_detail — one voucher's breakdown, found by its number (BR-…, BR-…/2, PV-…) or by
                        any journal it produced (the "View Settlement Breakdown" action), with each
                        bill's live due today.
  * party_ledger      — one customer / dealer / supplier: bills, receipts / payments, returns, in
                        date order with a running balance due, and which voucher settled which bill.

Money is returned as strings with 2 decimals; the screen formats them in the tenant's currency.
"""
from decimal import Decimal

from django.db.models import Q

from .models import BillAllocation, BillSettlement, JournalEntry
from .services import AccountingError, money
from .settlements import PARTY_KINDS, _party_models, _party_row, open_bills

ZERO = Decimal('0.00')
MAX_ROWS = 2000
_CANCELLED = ('cancelled', 'canceled', 'void', 'voided', 'failed', 'reversed')
BILL_KIND_LABEL = {'invoice': 'Sales Invoice', 'wholesale_invoice': 'Wholesale Invoice',
                   'purchase_invoice': 'Purchase Entry'}


def _s(v):
    return str(money(v)) if v is not None else None


def _d(v):
    return v.isoformat() if hasattr(v, 'isoformat') else (v or None)


def base_number(number):
    """'BR-2026-00012/3' (one receipt of a settlement) -> 'BR-2026-00012'."""
    number = (number or '').strip()
    return number.split('/', 1)[0] if number.upper().startswith('BR-') else number


# ---------------------------------------------------------------------------
# Live state
# ---------------------------------------------------------------------------

def _dead_receipt_settlements(settlements):
    """Numbers of RV settlements whose sales receipts have all been deleted / cancelled since
    (a receipt voucher has no journal of its own to reverse; its receipts are undone one by one)."""
    from apps.sales.models import Payment, WholesalePaymentCollection
    rv = [s for s in settlements if s.voucher_type == 'RV' and s.status == 'POSTED']
    if not rv:
        return set()
    q_pay, q_col = Q(), Q()
    for s in rv:
        q_pay |= Q(receipt_no__startswith=f"{s.number}/")
        q_col |= Q(receipt_number__startswith=f"{s.number}/")
    alive = set()
    for no, st in Payment.objects.filter(q_pay).values_list('receipt_no', 'status'):
        if (st or '').strip().lower() not in _CANCELLED:
            alive.add(base_number(no))
    for no in WholesalePaymentCollection.objects.filter(q_col).values_list('receipt_number', flat=True):
        alive.add(base_number(no))
    return {s.number for s in rv if s.number not in alive}


def _status(s, dead):
    if s.status == 'REVERSED' or s.number in dead:
        return 'REVERSED'
    return 'POSTED'


def _payment_rows(s):
    out = []
    for p in s.payments or []:
        detail = []
        if p.get('cheque_number'):
            detail.append(f"Cheque #{p['cheque_number']}" + (f" dt {p['cheque_date']}" if p.get('cheque_date') else ''))
            if p.get('cheque_bank'):
                detail.append(p['cheque_bank'])
        elif p.get('ref_no'):
            detail.append(f"Ref {p['ref_no']}")
        if p.get('bank_name') and p.get('method') != 'Cash':
            detail.append(f"via {p['bank_name']}")
        out.append({'method': p.get('method') or '', 'amount': _s(p.get('amount')), 'bank_name': p.get('bank_name') or '',
                    'ref_no': p.get('ref_no') or '', 'ref_date': p.get('ref_date'),
                    'cheque_number': p.get('cheque_number') or '', 'cheque_date': p.get('cheque_date'),
                    'cheque_bank': p.get('cheque_bank') or '', 'detail': ' · '.join(detail)})
    return out


def _allocation_rows(s, live_due=None):
    out = []
    for a in s.allocations.all():
        row = {'bill_kind': a.bill_kind, 'bill_kind_label': BILL_KIND_LABEL.get(a.bill_kind, a.bill_kind),
               'bill_id': a.bill_id, 'bill_number': a.bill_number, 'bill_ref': a.bill_ref, 'bill_date': _d(a.bill_date),
               'bill_total': _s(a.bill_total), 'previous_paid': _s(a.previous_paid), 'previous_due': _s(a.previous_due),
               'settled': _s(a.allocated_amount), 'remaining_due': _s(a.new_due),
               'status': a.settlement_status or '', 'receipts': a.receipt_numbers or [], 'narration': a.narration}
        if live_due is not None:
            row['current_due'] = _s(live_due.get(a.bill_id, ZERO))
        out.append(row)
    return out


def _settlement_row(s, dead, live_due=None):
    return {
        'id': str(s.pk), 'number': s.number, 'voucher': s.voucher_type, 'date': _d(s.date),
        'party_kind': s.party_kind, 'party_id': s.party_id, 'party_name': s.party_name, 'party_code': s.party_code,
        'total': _s(s.total_amount), 'allocated': _s(s.allocated_amount), 'on_account': _s(s.on_account_amount),
        'status': _status(s, dead), 'origin': s.origin, 'narration': s.narration,
        'journal': s.journal_entry.entry_number if s.journal_entry_id else '',
        'branch': s.branch.name if s.branch_id else '',
        'payments': _payment_rows(s),
        'pay_modes': ' + '.join(dict.fromkeys(p.get('method') or '' for p in (s.payments or []))) or '',
        'bills': _allocation_rows(s, live_due),
        'bills_closed': sum(1 for a in s.allocations.all() if a.settlement_status == 'CLOSED'),
        'bills_partial': sum(1 for a in s.allocations.all() if a.settlement_status == 'PARTIAL'),
    }


def _queryset(branch_ids=None):
    qs = BillSettlement.objects.select_related('journal_entry', 'branch').prefetch_related('allocations')
    if branch_ids is not None:
        qs = qs.filter(branch_id__in=[str(b) for b in branch_ids])
    return qs


# ---------------------------------------------------------------------------
# Voucher list / detail
# ---------------------------------------------------------------------------

def settlement_list(voucher=None, party_kind=None, party_id=None, date_from=None, date_to=None, search='',
                    status=None, branch_ids=None):
    qs = _queryset(branch_ids)
    if voucher:
        if voucher not in PARTY_KINDS:
            raise AccountingError('Voucher must be RV or PV.')
        qs = qs.filter(voucher_type=voucher)
    if party_kind:
        qs = qs.filter(party_kind=party_kind)
    if party_id:
        qs = qs.filter(party_id=str(party_id))
    if date_from:
        qs = qs.filter(date__gte=date_from)
    if date_to:
        qs = qs.filter(date__lte=date_to)
    text = (search or '').strip()
    if text:
        bills = BillAllocation.objects.filter(bill_number__icontains=text).values('settlement_id')
        qs = qs.filter(Q(number__icontains=text) | Q(party_name__icontains=text) | Q(party_code__icontains=text)
                       | Q(narration__icontains=text) | Q(pk__in=bills))
    settlements = list(qs.order_by('-date', '-created_at')[:MAX_ROWS + 1])
    truncated = len(settlements) > MAX_ROWS
    settlements = settlements[:MAX_ROWS]
    dead = _dead_receipt_settlements(settlements)
    rows = [_settlement_row(s, dead) for s in settlements]
    if status:
        rows = [r for r in rows if r['status'] == status]
    posted = [r for r in rows if r['status'] == 'POSTED']
    summary = {
        'vouchers': len(posted),
        'total': _s(sum((money(r['total']) for r in posted), ZERO)),
        'allocated': _s(sum((money(r['allocated']) for r in posted), ZERO)),
        'on_account': _s(sum((money(r['on_account']) for r in posted), ZERO)),
        'bills_settled': sum(len(r['bills']) for r in posted),
        'bills_closed': sum(r['bills_closed'] for r in posted),
        'bills_partial': sum(r['bills_partial'] for r in posted),
        'reversed': len(rows) - len(posted),
        'by_mode': {},
    }
    for r in posted:
        for p in r['payments']:
            summary['by_mode'][p['method']] = _s(money(summary['by_mode'].get(p['method'])) + money(p['amount']))
    return {'results': rows, 'summary': summary, 'truncated': truncated}


def _find(number=None, journal=None, branch_ids=None):
    qs = _queryset(branch_ids)
    if number:
        n = base_number(number)
        hit = qs.filter(number=n).first() or qs.filter(journal_entry__entry_number=number).first()
        if hit:
            return hit
        journal = journal or number
    if not journal:
        return None
    entry = JournalEntry.all_objects.filter(entry_number=journal).first()
    if entry is None:
        return None
    hit = qs.filter(journal_entry=entry).first()
    if hit or entry.reversed_entry_id is None:
        if hit:
            return hit
    else:  # the reversal of a PV: show the voucher it reversed
        hit = qs.filter(journal_entry_id=entry.reversed_entry_id).first()
        if hit:
            return hit
    # A BR- receipt's own journal: source document -> its receipt number -> the settlement.
    if entry.reference_id:
        from apps.sales.models import Payment, WholesalePaymentCollection
        receipt = None
        if entry.source_event == 'payment':
            receipt = Payment.all_objects.filter(pk=entry.reference_id).values_list('receipt_no', flat=True).first()
        elif entry.source_event == 'wholesale_collection':
            receipt = WholesalePaymentCollection.all_objects.filter(pk=entry.reference_id) \
                .values_list('receipt_number', flat=True).first()
        if receipt and receipt.upper().startswith('BR-'):
            return qs.filter(voucher_type='RV', number=base_number(receipt)).first()
    return None


def settlement_detail(number=None, journal=None, branch_ids=None):
    s = _find(number, journal, branch_ids)
    if s is None:
        return None
    kinds = {}
    for a in s.allocations.all():
        kinds.setdefault(a.bill_kind, []).append(a.bill_id)
    live = {}
    party_kind = {'invoice': 'customer', 'wholesale_invoice': 'dealer', 'purchase_invoice': 'supplier'}
    for bill_kind, ids in kinds.items():
        for bills in open_bills(party_kind[bill_kind], bill_ids=ids).values():
            for b in bills:
                live[b['id']] = b['due']
    row = _settlement_row(s, _dead_receipt_settlements([s]), live_due=live)
    row['party_outstanding'] = _s(sum((b['due'] for bills in open_bills(s.party_kind, party_ids=[s.party_id]).values()
                                       for b in bills), ZERO))
    return row


# ---------------------------------------------------------------------------
# Party ledger
# ---------------------------------------------------------------------------

def _entry(date, kind, number, description, bill=ZERO, paid=ZERO, *, ref='', settles=None, settled_by=None,
           settlement=None, created=None, bill_id=None):
    return {'date': date, 'type': kind, 'number': number, 'ref': ref or '', 'description': description,
            'bill_amount': money(bill), 'paid_amount': money(paid), 'settles': settles or [],
            'settled_by': settled_by or [], 'settlement': settlement or '', 'bill_id': bill_id,
            '_order': (date, 0 if kind == 'BILL' else 1, created or '')}


def _customer_entries(party_id, branch_ids):
    from apps.sales.models import Invoice, Payment
    invoices = Invoice.objects.filter(customer_id=party_id) \
        .filter(Q(document_type='INVOICE') | Q(document_type='') | Q(document_type__isnull=True)) \
        .exclude(status__in=('DRAFT', 'CANCELLED'))
    if branch_ids is not None:
        invoices = invoices.filter(branch_id__in=[str(b) for b in branch_ids])
    invoices = list(invoices.order_by('invoice_date', 'created_at'))
    inv_ids = [i.pk for i in invoices]
    pays = Payment.objects.filter(Q(customer_id=party_id) | Q(invoice_id__in=inv_ids)).select_related('invoice') \
        .order_by('payment_date', 'created_at', 'receipt_no')
    pays = [p for p in pays if (p.status or '').strip().lower() not in _CANCELLED and money(p.amount) != 0
            and (p.invoice_id is None or p.invoice_id in set(inv_ids) or p.customer_id == party_id)]
    settled_by = {}
    for p in pays:
        if p.invoice_id:
            settled_by.setdefault(p.invoice_id, []).append(
                {'number': base_number(p.receipt_no), 'receipt': p.receipt_no or '', 'date': _d(p.payment_date),
                 'amount': _s(p.amount)})
    entries = [_entry(_d(i.invoice_date), 'BILL', i.invoice_number, 'Sales Invoice', bill=i.net_amount,
                      settled_by=settled_by.get(i.pk), created=_d(i.created_at), bill_id=str(i.pk)) for i in invoices]
    # BR- receipts of one settlement are one voucher on the statement.
    grouped = {}
    for p in pays:
        no = p.receipt_no or ''
        key = base_number(no) if no.upper().startswith('BR-') else f"{no}#{p.pk}"
        g = grouped.setdefault(key, {'date': _d(p.payment_date), 'number': base_number(no) if no.upper().startswith('BR-') else (no or '—'),
                                     'amount': ZERO, 'settles': [], 'methods': [], 'br': no.upper().startswith('BR-'),
                                     'created': _d(p.created_at)})
        g['amount'] += money(p.amount)
        g['methods'].append(p.method or '')
        g['settles'].append({'bill_number': p.invoice.invoice_number if p.invoice_id else 'On account',
                             'amount': _s(p.amount)})
    for g in grouped.values():
        methods = ' + '.join(dict.fromkeys(m for m in g['methods'] if m))
        refund = g['amount'] < 0
        entries.append(_entry(g['date'], 'REFUND' if refund else 'RECEIPT', g['number'],
                              f"{'Refund' if refund else 'Receipt Voucher (Bill to Bill)' if g['br'] else 'Receipt'}"
                              f"{' — ' + methods if methods else ''}",
                              bill=-g['amount'] if refund else ZERO, paid=ZERO if refund else g['amount'],
                              settles=g['settles'], settlement=g['number'] if g['br'] else '', created=g['created']))
    return entries


def _dealer_entries(party_id, branch_ids):
    from apps.financial.accounting_catalog import is_credit_method
    from apps.sales.models import WholesaleInvoice, WholesalePaymentCollection, WholesaleReturn
    invoices = WholesaleInvoice.objects.filter(dealer_id=party_id)
    if branch_ids is not None:
        invoices = invoices.filter(branch_id__in=[str(b) for b in branch_ids])
    invoices = [i for i in invoices.order_by('invoice_date', 'created_at')
                if (i.status or '').strip().lower() not in ('cancelled', 'canceled', 'draft', 'void') and money(i.grand_total) > 0]
    numbers = {i.invoice_number for i in invoices}
    cols = [c for c in WholesalePaymentCollection.objects.filter(dealer_id=party_id).order_by('payment_date', 'created_at', 'receipt_number')
            if not is_credit_method(c.payment_method) and money(c.amount_paid) > 0]
    returns = [r for r in WholesaleReturn.objects.filter(invoice_number__in=numbers)
               if 'replace' not in (r.action_taken or '').lower() and money(r.return_amount) > 0]
    settled_by = {}
    for c in cols:
        if c.invoice_number:
            settled_by.setdefault(c.invoice_number, []).append(
                {'number': base_number(c.receipt_number), 'receipt': c.receipt_number, 'date': _d(c.payment_date),
                 'amount': _s(c.amount_paid)})
    for r in returns:
        settled_by.setdefault(r.invoice_number, []).append(
            {'number': r.return_number, 'receipt': r.return_number, 'date': _d(getattr(r, 'return_date', None)),
             'amount': _s(r.return_amount), 'kind': 'return'})
    entries = [_entry(_d(i.invoice_date), 'BILL', i.invoice_number, 'Wholesale Invoice', bill=i.grand_total,
                      settled_by=settled_by.get(i.invoice_number), created=_d(i.created_at), bill_id=str(i.pk))
               for i in invoices]
    grouped = {}
    for c in cols:
        no = c.receipt_number or ''
        br = no.upper().startswith('BR-')
        key = base_number(no) if br else f"{no}#{c.pk}"
        g = grouped.setdefault(key, {'date': _d(c.payment_date), 'number': base_number(no) if br else no, 'amount': ZERO,
                                     'settles': [], 'methods': [], 'br': br, 'created': _d(c.created_at)})
        g['amount'] += money(c.amount_paid)
        g['methods'].append(c.payment_method or '')
        g['settles'].append({'bill_number': c.invoice_number or 'On account', 'amount': _s(c.amount_paid)})
    for g in grouped.values():
        methods = ' + '.join(dict.fromkeys(m for m in g['methods'] if m))
        entries.append(_entry(g['date'], 'RECEIPT', g['number'],
                              f"{'Receipt Voucher (Bill to Bill)' if g['br'] else 'Collection'}{' — ' + methods if methods else ''}",
                              paid=g['amount'], settles=g['settles'], settlement=g['number'] if g['br'] else '',
                              created=g['created']))
    for r in returns:
        entries.append(_entry(_d(getattr(r, 'return_date', None) or r.created_at.date()), 'RETURN', r.return_number,
                              f"Return / credit note{' — ' + r.action_taken if r.action_taken else ''}",
                              paid=r.return_amount, settles=[{'bill_number': r.invoice_number, 'amount': _s(r.return_amount)}],
                              created=_d(r.created_at)))
    return entries


def _supplier_entries(party_id, branch_ids):
    from apps.purchasing.models import PurchaseInvoice
    from .posting_rules import build_purchase_payment, purchase_invoice_is_live
    invoices = PurchaseInvoice.objects.filter(supplier_id=party_id, grand_total__gt=0).exclude(status__in=('DRAFT', 'CANCELLED'))
    if branch_ids is not None:
        invoices = invoices.filter(branch_id__in=[str(b) for b in branch_ids])
    invoices = [pi for pi in invoices.select_related('bank_account').order_by('purchase_date', 'created_at')
                if purchase_invoice_is_live(pi)]
    by_id = {str(pi.pk): pi for pi in invoices}
    settled_by, entries = {}, []
    for pi in invoices:
        plan = build_purchase_payment(pi)
        at_entry = plan['lines'][0]['debit'] if plan else ZERO
        if at_entry > 0:
            settled_by.setdefault(str(pi.pk), []).append(
                {'number': pi.invoice_number, 'receipt': '', 'date': _d(pi.purchase_date), 'amount': _s(at_entry),
                 'kind': 'at_entry'})
            entries.append(_entry(_d(pi.purchase_date), 'PAYMENT', pi.invoice_number, 'Paid at purchase entry',
                                  paid=at_entry, settles=[{'bill_number': pi.invoice_number, 'amount': _s(at_entry)}],
                                  created=_d(pi.created_at)))
    vouchers = BillSettlement.objects.filter(voucher_type='PV', party_kind='supplier', party_id=str(party_id),
                                             status='POSTED').prefetch_related('allocations')
    for s in vouchers:
        settles = []
        for a in s.allocations.all():
            settles.append({'bill_number': a.bill_number, 'amount': _s(a.allocated_amount)})
            if a.bill_id in by_id:
                settled_by.setdefault(a.bill_id, []).append(
                    {'number': s.number, 'receipt': '', 'date': _d(s.date), 'amount': _s(a.allocated_amount)})
        if s.on_account_amount:
            settles.append({'bill_number': 'On account', 'amount': _s(s.on_account_amount)})
        methods = ' + '.join(dict.fromkeys(p.get('method') or '' for p in (s.payments or [])))
        entries.append(_entry(_d(s.date), 'PAYMENT', s.number,
                              f"Payment Voucher (Bill to Bill){' — ' + methods if methods else ''}",
                              paid=s.total_amount, settles=settles, settlement=s.number, created=_d(s.created_at)))
    for pi in invoices:
        entries.append(_entry(_d(pi.purchase_date), 'BILL', pi.invoice_number, 'Purchase Entry', bill=pi.grand_total,
                              ref=pi.supplier_invoice_number, settled_by=settled_by.get(str(pi.pk)),
                              created=_d(pi.created_at), bill_id=str(pi.pk)))
    return entries


def party_ledger(party_kind, party_id, date_from=None, date_to=None, branch_ids=None):
    models = _party_models()
    if party_kind not in models:
        raise AccountingError(f"Unknown party type '{party_kind}'.")
    party = models[party_kind].objects.filter(pk=party_id).first()
    if party is None:
        raise AccountingError('That party was not found.')
    builder = {'customer': _customer_entries, 'dealer': _dealer_entries, 'supplier': _supplier_entries}[party_kind]
    entries = sorted(builder(party.pk, branch_ids), key=lambda e: tuple(str(x or '') for x in e['_order']))
    df, dt = _d(date_from), _d(date_to)
    opening = ZERO
    rows, balance = [], ZERO
    bill_total = paid_total = ZERO
    for e in entries:
        e.pop('_order')
        delta = e['bill_amount'] - e['paid_amount']
        if df and (e['date'] or '') < df:
            opening += delta
            continue
        if dt and (e['date'] or '') > dt:
            continue
        if not rows:
            balance = opening
        balance += delta
        bill_total += e['bill_amount']
        paid_total += e['paid_amount']
        rows.append(dict(e, bill_amount=_s(e['bill_amount']) if e['bill_amount'] else '',
                         paid_amount=_s(e['paid_amount']) if e['paid_amount'] else '', balance=_s(balance)))
    if not rows:
        balance = opening
    outstanding = sum((b['due'] for bills in open_bills(party_kind, party_ids=[party.pk], branch_ids=branch_ids).values()
                       for b in bills), ZERO)
    return {
        'party': _party_row(party_kind, party),
        'side': 'payable' if party_kind == 'supplier' else 'receivable',
        'date_from': df, 'date_to': dt,
        'opening_balance': _s(opening), 'closing_balance': _s(balance),
        'total_billed': _s(bill_total), 'total_paid': _s(paid_total),
        'outstanding_bills': _s(outstanding),
        'rows': rows[:MAX_ROWS * 2], 'truncated': len(rows) > MAX_ROWS * 2,
    }


# ---------------------------------------------------------------------------
# Excel
# ---------------------------------------------------------------------------

def to_xlsx(title, meta, header, lines, company_name='', money_cols=()):
    """A plain table workbook (bytes): title block, header row, then the lines; money columns
    are numbers so the sheet can be summed."""
    from io import BytesIO
    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill
    from openpyxl.utils import get_column_letter

    wb = Workbook()
    ws = wb.active
    ws.title = title[:31]
    r = 1
    for i, text in enumerate(t for t in [company_name, title, *meta] if t):
        ws.cell(row=r, column=1, value=text).font = Font(bold=True, size=14 if i == 0 else 11)
        r += 1
    r += 1
    fill = PatternFill('solid', fgColor='E2E8F0')
    for c, h in enumerate(header, start=1):
        cell = ws.cell(row=r, column=c, value=h)
        cell.font = Font(bold=True)
        cell.fill = fill
    for line in lines:
        r += 1
        for c, v in enumerate(line, start=1):
            if c - 1 in money_cols and v not in (None, ''):
                try:
                    v = float(v)
                except (TypeError, ValueError):
                    pass
            cell = ws.cell(row=r, column=c, value=v)
            if c - 1 in money_cols:
                cell.number_format = '#,##0.00'
    for c in range(1, len(header) + 1):
        ws.column_dimensions[get_column_letter(c)].width = 18
    out = BytesIO()
    wb.save(out)
    return out.getvalue()
