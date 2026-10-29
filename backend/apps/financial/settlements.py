"""Bill-to-bill settlement: the Receipt / Payment Voucher's "Bill to Bill" mode.

A bill's outstanding amount lives where the existing posting rules already read it from, so a
settlement never books anything the source documents don't also know about:

  customer (sales.Customer)  -> retail Invoices: net_amount - paid_amount. Settled by creating
                                ordinary sales.Payment receipts (one per bill and pay mode) and
                                raising each bill's paid_amount, exactly like the Payments tab.
                                The engine books each receipt (Dr Cash/Bank, Cr Receivable).
  dealer   (sales.Dealer)    -> WholesaleInvoices: grand_total - paid_amount - credit notes.
                                Settled by WholesalePaymentCollection rows (booked by the
                                engine) plus the invoice's paid / due figures and the dealer's
                                outstanding balance.
  supplier (purchasing)      -> PurchaseInvoices: grand_total - what its own purchase_payment
                                rule books - earlier settlement vouchers. There is no supplier
                                payment document, so the settlement is ONE manual Payment Voucher
                                (Dr supplier payable per bill / Cr Cash/Bank) whose metadata
                                ['bill_allocations'] is the allocation record. Reversing that
                                voucher re-opens the bills, since only live vouchers count.

Every save runs in one transaction with the bills row-locked and their dues recomputed, and is
keyed by the screen's idempotency key so a retried / double-clicked save posts once.
"""
from decimal import Decimal

from django.db import IntegrityError, transaction
from django.db.models import F, Q
from django.utils import timezone
from rest_framework import serializers

from .accounting_catalog import payment_role
from .cheques import CHEQUE_METHOD, ChequeBook, ChequeInputSerializer
from .mapping import resolve_role
from .models import ChartOfAccount, JournalEntry, JournalSequence, PostingFailure
from .services import AccountingError, audit, create_journal, money

ZERO = Decimal('0.00')
PARTY_KINDS = {'RV': ('customer', 'dealer'), 'PV': ('supplier',)}
PAY_METHODS = ('Cash', 'Bank Transfer', 'Cheque', 'UPI', 'Card')
CLAIM_DOC_TYPE = 'BILL_RECEIPT'
MAX_PAGE = 100


# ---------------------------------------------------------------------------
# Parties
# ---------------------------------------------------------------------------

def _party_models():
    from apps.purchasing.models import Supplier
    from apps.sales.models import Customer, Dealer
    return {'customer': Customer, 'dealer': Dealer, 'supplier': Supplier}


def _party_row(kind, p):
    # Only what the picker shows — no addresses, IDs or medical-aid details.
    if kind == 'customer':
        return {'kind': kind, 'id': str(p.pk), 'code': p.patient_code or '', 'name': p.name,
                'mobile': p.phone or '', 'area': p.place or ''}
    if kind == 'dealer':
        return {'kind': kind, 'id': str(p.pk), 'code': p.dealer_code, 'name': p.business_name,
                'mobile': p.phone or '', 'area': p.city or ''}
    return {'kind': kind, 'id': str(p.pk), 'code': p.supplier_code or '', 'name': p.name,
            'mobile': p.phone or '', 'area': p.city or ''}


_SEARCH_FIELDS = {
    'customer': ('patient_code', 'name', 'phone', 'place'),
    'dealer': ('dealer_code', 'business_name', 'phone', 'city', 'owner_name'),
    'supplier': ('supplier_code', 'name', 'phone', 'city', 'company_name'),
}
_ORDER = {'customer': 'name', 'dealer': 'business_name', 'supplier': 'name'}


def search_parties(voucher, search='', kind=None, only_due=False, limit=50, date_from=None, date_to=None):
    """Parties for the F1 picker with their outstanding (from open_bills, so the figure always
    equals the sum of the bills Load Due Bills will show). At most `limit` per party kind.
    A bill-date range keeps only parties with open bills dated in it, and counts only those bills."""
    kinds = [k for k in PARTY_KINDS[voucher] if not kind or k == kind]
    limit = max(1, min(int(limit or 50), MAX_PAGE))
    text = (search or '').strip()
    rows, has_more = [], False
    for k in kinds:
        model = _party_models()[k]
        qs = model.objects.all()
        if text:
            q = Q()
            for f in _SEARCH_FIELDS[k]:
                q |= Q(**{f'{f}__icontains': text})
            qs = qs.filter(q)
        if only_due or date_from is not None or date_to is not None:
            due_ids = list(open_bills(k, date_from=date_from, date_to=date_to).keys())
            qs = qs.filter(pk__in=due_ids)
        parties = list(qs.order_by(_ORDER[k])[:limit + 1])
        has_more = has_more or len(parties) > limit
        parties = parties[:limit]
        bills = open_bills(k, party_ids=[p.pk for p in parties], date_from=date_from, date_to=date_to) if parties else {}
        for p in parties:
            row = _party_row(k, p)
            mine = bills.get(p.pk, [])
            row['outstanding'] = str(sum((b['due'] for b in mine), ZERO))
            row['open_bills'] = len(mine)
            rows.append(row)
    rows.sort(key=lambda r: r['name'].lower())
    return {'results': rows, 'has_more': has_more}


# ---------------------------------------------------------------------------
# Open bills
# ---------------------------------------------------------------------------

def _account_info(acc):
    return {'account_id': str(acc.pk), 'account_code': acc.code, 'account_name': acc.name,
            'main_account': acc.parent_account.name if acc.parent_account_id else
            (acc.account_group.name if acc.account_group_id else '')}


class _Accounts:
    """Resolves (and caches) the receivable / payable each bill settles against."""
    def __init__(self):
        self.cache = {}

    def role(self, role):
        if role not in self.cache:
            self.cache[role] = ChartOfAccount.objects.select_related('account_group', 'parent_account') \
                .get(pk=resolve_role(role).pk)
        return self.cache[role]


def _bill(kind, doc, number, date, due_date, total, paid, due, account, ref=''):
    row = {'kind': kind, 'id': str(doc.pk), 'number': number, 'ref': ref or '', 'date': date, 'due_date': due_date,
           'total': money(total), 'paid': money(paid), 'due': money(due)}
    row.update(_account_info(account))
    return row


def supplier_settled_by_vouchers(bill_ids=None):
    """{purchase_invoice_id: amount} settled by live bill-to-bill Payment Vouchers."""
    settled = {}
    wanted = {str(b) for b in bill_ids} if bill_ids is not None else None
    for meta in (JournalEntry.objects.filter(status='POSTED', is_reversal=False, source_module='financial',
                                             metadata__has_key='bill_allocations')
                 .values_list('metadata', flat=True)):
        for a in (meta or {}).get('bill_allocations') or []:
            if a.get('kind') != 'purchase_invoice' or (wanted is not None and a.get('id') not in wanted):
                continue
            settled[a['id']] = settled.get(a['id'], ZERO) + money(a.get('amount'))
    return settled


def open_bills(kind, party_ids=None, bill_ids=None, lock=False, date_from=None, date_to=None):
    """{party_id: [bill, ...]} of bills with something still due, oldest first. Party ids are
    the model's pk values. `lock` row-locks the bills (call inside a transaction). date_from /
    date_to narrow by bill date (invoice / purchase date), inclusive."""
    accounts = _Accounts()
    out = {}

    if kind == 'customer':
        from apps.sales.models import Invoice
        from .posting_rules import invoice_is_wholesale
        qs = Invoice.objects.filter(customer__isnull=False, net_amount__gt=F('paid_amount')) \
            .filter(Q(document_type='INVOICE') | Q(document_type='') | Q(document_type__isnull=True)) \
            .exclude(status__in=('DRAFT', 'CANCELLED'))
        if party_ids is not None:
            qs = qs.filter(customer_id__in=party_ids)
        if bill_ids is not None:
            qs = qs.filter(pk__in=bill_ids)
        qs = _dated(qs, 'invoice_date', date_from, date_to)
        if lock:
            qs = qs.select_for_update(of=('self',))
        for inv in qs.order_by('invoice_date', 'created_at'):
            due = money(inv.net_amount) - money(inv.paid_amount)
            if due <= 0:
                continue
            acc = accounts.role('WHOLESALE_RECEIVABLE' if invoice_is_wholesale(inv) else 'RETAIL_RECEIVABLE')
            out.setdefault(inv.customer_id, []).append(
                _bill('invoice', inv, inv.invoice_number, inv.invoice_date, None, inv.net_amount, inv.paid_amount, due, acc))
        return out

    if kind == 'dealer':
        from apps.sales.models import WholesaleInvoice, WholesaleReturn
        qs = WholesaleInvoice.objects.all()
        if party_ids is not None:
            qs = qs.filter(dealer_id__in=party_ids)
        if bill_ids is not None:
            qs = qs.filter(pk__in=bill_ids)
        qs = _dated(qs, 'invoice_date', date_from, date_to)
        if lock:
            qs = qs.select_for_update(of=('self',))
        invoices = [inv for inv in qs.order_by('invoice_date', 'created_at')
                    if (inv.status or '').strip().lower() not in ('cancelled', 'canceled', 'draft', 'void')
                    and money(inv.grand_total) > 0]
        credited = {}
        if invoices:
            # Credit notes / returns credit the receivable against the invoice (build_wholesale_return).
            for r in WholesaleReturn.objects.filter(invoice_number__in=[i.invoice_number for i in invoices]):
                if 'replace' not in (r.action_taken or '').lower():
                    credited[r.invoice_number] = credited.get(r.invoice_number, ZERO) + money(r.return_amount)
        acc = accounts.role('WHOLESALE_RECEIVABLE') if invoices else None
        for inv in invoices:
            paid = money(inv.paid_amount) + credited.get(inv.invoice_number, ZERO)
            due = money(inv.grand_total) - paid
            if due <= 0:
                continue
            out.setdefault(inv.dealer_id, []).append(
                _bill('wholesale_invoice', inv, inv.invoice_number, inv.invoice_date, inv.due_date,
                      inv.grand_total, paid, due, acc))
        return out

    if kind == 'supplier':
        from apps.purchasing.models import PurchaseInvoice
        from .posting_rules import build_purchase_payment, purchase_invoice_is_live
        qs = PurchaseInvoice.objects.filter(grand_total__gt=0).exclude(status__in=('DRAFT', 'CANCELLED'))
        if party_ids is not None:
            qs = qs.filter(supplier_id__in=party_ids)
        if bill_ids is not None:
            qs = qs.filter(pk__in=bill_ids)
        qs = _dated(qs, 'purchase_date', date_from, date_to)
        if lock:
            qs = qs.select_for_update(of=('self',))
        invoices = [pi for pi in qs.select_related('supplier__ledger_account__account_group',
                                                   'supplier__ledger_account__parent_account', 'bank_account')
                    .order_by('purchase_date', 'created_at') if purchase_invoice_is_live(pi)]
        settled = supplier_settled_by_vouchers([pi.pk for pi in invoices]) if invoices else {}
        for pi in invoices:
            # Paid at entry = exactly what the purchase_payment rule books, so the due amount
            # always equals what the supplier's payable still carries for this bill.
            plan = build_purchase_payment(pi)
            paid_at_entry = plan['lines'][0]['debit'] if plan else ZERO
            paid = paid_at_entry + settled.get(str(pi.pk), ZERO)
            due = money(pi.grand_total) - paid
            if due <= 0:
                continue
            acc = supplier_payable(pi.supplier, accounts)
            out.setdefault(pi.supplier_id, []).append(
                _bill('purchase_invoice', pi, pi.invoice_number, pi.purchase_date, pi.due_date, pi.grand_total, paid,
                      due, acc, ref=pi.supplier_invoice_number))
        return out

    raise AccountingError(f"Unknown party type '{kind}'.")


def _dated(qs, field, date_from, date_to):
    if date_from is not None:
        qs = qs.filter(**{f'{field}__gte': date_from})
    if date_to is not None:
        qs = qs.filter(**{f'{field}__lte': date_to})
    return qs


def supplier_payable(supplier, accounts=None):
    acc = getattr(supplier, 'ledger_account', None) if supplier else None
    if acc is not None and not acc.is_deleted and acc.status == 'Active':
        return acc
    return (accounts or _Accounts()).role('SUPPLIER_PAYABLE')


# ---------------------------------------------------------------------------
# Input
# ---------------------------------------------------------------------------

class AllocationSerializer(serializers.Serializer):
    bill = serializers.UUIDField()
    amount = serializers.DecimalField(max_digits=14, decimal_places=2, min_value=Decimal('0.01'))
    narration = serializers.CharField(required=False, allow_blank=True, default='', max_length=120)


class PayLineSerializer(serializers.Serializer):
    method = serializers.ChoiceField(choices=PAY_METHODS)
    amount = serializers.DecimalField(max_digits=14, decimal_places=2, min_value=Decimal('0.01'))
    bank_account = serializers.UUIDField(required=False, allow_null=True)
    ref_no = serializers.CharField(required=False, allow_blank=True, default='', max_length=60)
    ref_date = serializers.DateField(required=False, allow_null=True)
    cheque = ChequeInputSerializer(required=False, allow_null=True, default=None)

    def validate(self, attrs):
        if attrs['method'] == CHEQUE_METHOD and not attrs.get('cheque'):
            raise serializers.ValidationError('Enter the cheque details for the Cheque payment.')
        if attrs['method'] != CHEQUE_METHOD and attrs.get('cheque'):
            raise serializers.ValidationError('Cheque details belong on a Cheque payment only.')
        return attrs


class SettlementInputSerializer(serializers.Serializer):
    party_kind = serializers.ChoiceField(choices=('customer', 'dealer', 'supplier'))
    party = serializers.UUIDField()
    date = serializers.DateField()
    narration = serializers.CharField(required=False, allow_blank=True, default='', max_length=500)
    idempotency_key = serializers.CharField(max_length=100)
    allocations = AllocationSerializer(many=True)
    payments = PayLineSerializer(many=True)

    def validate(self, attrs):
        if not attrs['allocations']:
            raise serializers.ValidationError('Select at least one bill and enter the amount against it.')
        if not attrs['payments']:
            raise serializers.ValidationError('Enter at least one payment (Cash / Bank).')
        ids = [str(a['bill']) for a in attrs['allocations']]
        if len(ids) != len(set(ids)):
            raise serializers.ValidationError('A bill appears more than once in this voucher.')
        allocated = sum((a['amount'] for a in attrs['allocations']), ZERO)
        paid = sum((p['amount'] for p in attrs['payments']), ZERO)
        if allocated != paid:
            raise serializers.ValidationError(
                f"The bills total ₹{allocated:,.2f} but the payment modes total ₹{paid:,.2f}. They must match.")
        return attrs


def _bank(pay):
    """The chosen bank ledger, or None (= the pay mode's role mapping). Cash never takes one."""
    from .banks import validate_bank_account
    if pay['method'] == 'Cash' or not pay.get('bank_account'):
        return None
    acc = ChartOfAccount.objects.select_related('account_group').filter(pk=pay['bank_account']).first()
    if acc is None:
        raise AccountingError('The selected bank account was not found.')
    try:
        return validate_bank_account(acc)
    except serializers.ValidationError as exc:
        raise AccountingError(' '.join(str(d) for d in exc.detail))


def _pay_note(pay):
    parts = [pay.get('ref_no') or '', pay['ref_date'].isoformat() if pay.get('ref_date') else '']
    return ' '.join(p for p in parts if p)


def _checked_bills(kind, party_id, data):
    """Lock the bills, recompute their dues and refuse any allocation above what is due."""
    ids = [a['bill'] for a in data['allocations']]
    bills = {b['id']: b for b in open_bills(kind, bill_ids=ids, lock=True).get(party_id, [])}
    for a in data['allocations']:
        bill = bills.get(str(a['bill']))
        if bill is None:
            raise AccountingError('One of the selected bills is no longer outstanding for this party '
                                  '(already settled, cancelled, or belongs to someone else). Reload the due bills.')
        if a['amount'] > bill['due']:
            raise AccountingError(f"₹{a['amount']:,.2f} against {bill['number']} is more than its due "
                                  f"₹{bill['due']:,.2f}.")
    return bills


def _pair(allocations, payments):
    """Spread the pay-mode lines over the bills in order: [(allocation, payment, amount)]."""
    pairs, pays = [], [[p, p['amount']] for p in payments]
    i = 0
    for a in allocations:
        left = a['amount']
        while left > 0:
            pay = pays[i]
            take = min(left, pay[1])
            pairs.append((a, pay[0], take))
            left -= take
            pay[1] -= take
            if pay[1] <= 0:
                i += 1
    return pairs


def _next_number(prefix, date):
    from apps.common.sequences import bump_sequence
    return f"{prefix}-{date.year}-{bump_sequence(JournalSequence, {'prefix': prefix, 'year': date.year}):05d}"


# ---------------------------------------------------------------------------
# Receipt (customer / dealer)
# ---------------------------------------------------------------------------

def _receipt_result(number):
    from apps.sales.models import Payment, WholesalePaymentCollection
    prefix = f"{number}/"
    rows = [{'receipt_no': p.receipt_no, 'bill': p.invoice.invoice_number if p.invoice_id else '', 'amount': str(p.amount),
             'method': p.method, 'source': ('sales', 'payment', p.pk)}
            for p in Payment.objects.filter(receipt_no__startswith=prefix).select_related('invoice').order_by('receipt_no')]
    rows += [{'receipt_no': c.receipt_number, 'bill': c.invoice_number or '', 'amount': str(c.amount_paid),
              'method': c.payment_method, 'source': ('sales', 'wholesale_collection', c.pk)}
             for c in WholesalePaymentCollection.objects.filter(receipt_number__startswith=prefix).order_by('receipt_number')]
    journals, failed = [], []
    for r in rows:
        module, event, pk = r.pop('source')
        e = JournalEntry.objects.filter(source_module=module, source_event=event, reference_id=pk,
                                        status='POSTED', is_reversal=False).first()
        if e:
            journals.append(e.entry_number)
            r['journal'] = e.entry_number
        f = PostingFailure.objects.filter(source_module=module, source_event=event, reference_id=pk, status='OPEN').first()
        if f:
            failed.append({'receipt_no': r['receipt_no'], 'error': f.error})
    return {'number': number, 'receipts': rows, 'journals': journals, 'failed': failed,
            'total': str(sum((Decimal(r['amount']) for r in rows), ZERO))}


def post_bill_receipt(data, user=None, branch=None):
    """Settle customer / dealer bills. Returns (result, created)."""
    number, created = _settle_receipt(data, user, branch=branch)
    # The receipts are booked on commit; read back what the books did.
    return _receipt_result(number), created


def _settle_receipt(data, user=None, book=None, branch=None):
    """The receipt settlement itself -> (settlement number, created). Books on commit. A batch
    passes its own `book` so a cheque split over several parties is saved once, at the end."""
    from apps.company.models import DocumentNumberClaim
    kind = data['party_kind']
    if kind not in PARTY_KINDS['RV']:
        raise AccountingError('A Receipt Voucher settles customer or dealer bills.')
    key = data['idempotency_key'].strip()[:100]
    claimed = DocumentNumberClaim.objects.filter(doc_type=CLAIM_DOC_TYPE, client_token=key).first()
    if claimed:
        return claimed.number, False

    model = _party_models()[kind]
    party = model.objects.filter(pk=data['party']).first()
    if party is None:
        raise AccountingError('That customer / dealer was not found.')

    with transaction.atomic():
        number = _next_number('BR', data['date'])
        try:
            with transaction.atomic():
                DocumentNumberClaim.objects.create(doc_type=CLAIM_DOC_TYPE, client_token=key, number=number)
        except IntegrityError:  # the same voucher is being saved by a concurrent request
            claimed = DocumentNumberClaim.objects.get(doc_type=CLAIM_DOC_TYPE, client_token=key)
            return claimed.number, False

        bills = _checked_bills(kind, party.pk, data)
        banks = [_bank(p) for p in data['payments']]
        bank_of = {id(p): b for p, b in zip(data['payments'], banks)}
        narration = data['narration'].strip()
        own_book = book is None
        book = book if book is not None else ChequeBook('RV', user=user, branch=branch)
        for pay in data['payments']:
            if pay.get('cheque'):
                book.add(pay['cheque'], pay['amount'], voucher_number=number,
                         bank_account=bank_of[id(pay)] or resolve_role(payment_role(pay['method'])),
                         party_kind=kind, party_id=party.pk, party_name=_party_row(kind, party)['name'])

        if kind == 'customer':
            from apps.sales.models import Invoice, Payment
            from apps.sales.views import _shift_invoice_paid
            invoices = {str(i.pk): i for i in Invoice.objects.filter(pk__in=[a['bill'] for a in data['allocations']])}
            for n, (a, pay, amount) in enumerate(_pair(data['allocations'], data['payments']), start=1):
                inv = invoices[str(a['bill'])]
                Payment.objects.create(
                    receipt_no=f"{number}/{n}", branch=inv.branch, invoice=inv, customer=party,
                    customer_name=inv.customer_name or party.name, amount=amount, method=pay['method'],
                    payment_date=data['date'], status='Completed', bank_account=bank_of[id(pay)],
                    notes=' · '.join(x for x in (f"Receipt Voucher {number}", _pay_note(pay), a['narration'], narration) if x),
                )
                _shift_invoice_paid(inv.pk, amount)
        else:
            from apps.sales.models import Dealer, WholesaleInvoice, WholesalePaymentCollection
            for n, (a, pay, amount) in enumerate(_pair(data['allocations'], data['payments']), start=1):
                WholesalePaymentCollection.objects.create(
                    receipt_number=f"{number}/{n}", dealer=party, invoice_number=bills[str(a['bill'])]['number'],
                    payment_date=data['date'], payment_method=pay['method'], amount_paid=amount,
                    bank_account=bank_of[id(pay)],
                    reference_note=' · '.join(x for x in (f"RV {number}", _pay_note(pay), a['narration'], narration) if x)[:200],
                )
            for a in data['allocations']:
                inv = WholesaleInvoice.objects.get(pk=a['bill'])
                paid = money(inv.paid_amount) + a['amount']
                due = max(money(inv.grand_total) - paid, ZERO)
                # update(): only the running totals change, the invoice's own posting is untouched.
                WholesaleInvoice.objects.filter(pk=inv.pk).update(
                    paid_amount=paid, due_amount=due, status='Paid' if due <= 0 else 'Partial',
                    updated_at=timezone.now())
            total = sum((a['amount'] for a in data['allocations']), ZERO)
            Dealer.objects.filter(pk=party.pk).update(outstanding_balance=F('outstanding_balance') - total)

        total = sum((a['amount'] for a in data['allocations']), ZERO)
        audit('BILL_RECEIPT', 'settlement', number,
              f"Bill-to-bill receipt {number} ₹{total} from {_party_row(kind, party)['name']}",
              after={'party_kind': kind, 'party': str(party.pk),
                     'allocations': [{'bill': bills[str(a['bill'])]['number'], 'amount': str(a['amount'])}
                                     for a in data['allocations']]},
              user=user)
        if own_book:
            book.save()
    return number, True


# ---------------------------------------------------------------------------
# Payment (supplier)
# ---------------------------------------------------------------------------

def post_bill_payment(data, user=None, book=None, branch=None):
    """Settle supplier bills with one Payment Voucher. Returns (journal, created)."""
    from apps.purchasing.models import Supplier
    if data['party_kind'] != 'supplier':
        raise AccountingError('A Payment Voucher settles supplier bills.')
    key = data['idempotency_key'].strip()[:100]
    existing = JournalEntry.all_objects.filter(idempotency_key=key).first()
    if existing:
        return existing, False
    supplier = Supplier.objects.select_related('ledger_account').filter(pk=data['party']).first()
    if supplier is None:
        raise AccountingError('That supplier was not found.')

    with transaction.atomic():
        Supplier.objects.select_for_update().filter(pk=supplier.pk).first()
        bills = _checked_bills('supplier', supplier.pk, data)
        accounts = _Accounts()
        lines, allocations, cheque_pays = [], [], []
        for a in data['allocations']:
            bill = bills[str(a['bill'])]
            lines.append({'account': bill['account_id'], 'debit': a['amount'], 'credit': ZERO,
                          'memo': ' · '.join(x for x in (f"Settles {bill['number']}" + (f" (bill {bill['ref']})" if bill['ref'] else ''),
                                                         a['narration']) if x)})
            allocations.append({'kind': 'purchase_invoice', 'id': bill['id'], 'number': bill['number'],
                                'amount': str(a['amount'])})
        for pay in data['payments']:
            bank = _bank(pay)
            acc = bank or accounts.role(payment_role(pay['method']))
            lines.append({'account': acc, 'debit': ZERO, 'credit': pay['amount'],
                          'memo': ' '.join(x for x in (pay['method'], _pay_note(pay)) if x)})
            if pay.get('cheque'):
                cheque_pays.append((pay, acc))
        total = sum((a['amount'] for a in data['allocations']), ZERO)
        try:
            entry = create_journal(
                lines=lines, date=data['date'], voucher_type_code='PV',
                narration=data['narration'].strip() or f"Payment Voucher — {supplier.name} (Bill to Bill)",
                source_module='financial', source_event='voucher', source_number=supplier.name[:80],
                reference_type='PAYMENT_VOUCHER', user=user, idempotency_key=key,
                metadata={'bill_allocations': allocations,
                          'party': {'kind': 'supplier', 'id': str(supplier.pk), 'name': supplier.name,
                                    'code': supplier.supplier_code or ''}},
            )
        except IntegrityError:  # same key saved concurrently
            return JournalEntry.all_objects.get(idempotency_key=key), False
        Supplier.objects.filter(pk=supplier.pk).update(outstanding_balance=F('outstanding_balance') - total)
        own_book = book is None
        book = book if book is not None else ChequeBook('PV', user=user, branch=branch)
        for pay, acc in cheque_pays:
            book.add(pay['cheque'], pay['amount'], voucher_number=entry.entry_number, journal=entry,
                     bank_account=acc, party_kind='supplier', party_id=supplier.pk, party_name=supplier.name)
        if own_book:
            book.save()
    audit('VOUCHER_CREATED', 'journal', entry.pk, f"{entry.entry_number} bill-to-bill ₹{entry.total_amount}", user=user)
    return entry, True


def on_voucher_reversed(entry):
    """A reversed bill-to-bill Payment Voucher re-opens its bills (open_bills counts live vouchers
    only); put the supplier's outstanding balance back to match."""
    from apps.purchasing.models import Supplier
    meta = entry.metadata or {}
    party = meta.get('party') or {}
    if not meta.get('bill_allocations') or party.get('kind') != 'supplier':
        return
    total = sum((money(a.get('amount')) for a in meta['bill_allocations']), ZERO)
    Supplier.objects.filter(pk=party.get('id')).update(outstanding_balance=F('outstanding_balance') + total)


def post_bill_batch(voucher, items, user=None, branch=None):
    """Several parties' settlements (each its own number / voucher) in ONE transaction: if any
    of them is refused, none is saved. Returns ([result, ...], all_were_duplicates)."""
    book = ChequeBook(voucher, user=user, branch=branch)
    with transaction.atomic():
        if voucher == 'RV':
            done = [_settle_receipt(d, user, book=book) for d in items]
        else:
            done = [post_bill_payment(d, user, book=book) for d in items]
        book.save()
    duplicate = not any(created for _, created in done)
    # After commit: the receipts' journals now exist.
    if voucher == 'RV':
        return [_receipt_result(number) for number, _ in done], duplicate
    return [entry for entry, _ in done], duplicate


class BatchInputSerializer(serializers.Serializer):
    settlements = SettlementInputSerializer(many=True)

    def validate_settlements(self, value):
        if not value:
            raise serializers.ValidationError('Nothing to save.')
        if len(value) > 100:
            raise serializers.ValidationError('At most 100 parties per voucher.')
        parties = [(v['party_kind'], str(v['party'])) for v in value]
        if len(parties) != len(set(parties)):
            raise serializers.ValidationError('A party appears more than once.')
        keys = [v['idempotency_key'] for v in value]
        if len(keys) != len(set(keys)):
            raise serializers.ValidationError('Each party needs its own idempotency key.')
        return value
