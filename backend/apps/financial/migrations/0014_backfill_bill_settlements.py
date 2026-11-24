"""Rebuild BillSettlement / BillAllocation records for bill-to-bill vouchers saved before 0013.

Sources (the same ones settlements.py has always written):
  * PV: manual Payment Voucher journals whose metadata holds 'bill_allocations';
  * RV: sales receipts (Payment.receipt_no) and wholesale collections (receipt_number) numbered
    BR-YYYY-NNNNN/<n> — one settlement per BR- number.

The due before / after each bill was never stored, so backfilled rows leave those empty
(origin='backfill'). Idempotent: a settlement that already exists is skipped, so a re-run or an
upgrade over a partially migrated database is harmless. Runs per tenant row, never across tenants.
"""
from decimal import Decimal

from django.db import migrations

ZERO = Decimal('0.00')


def _money(v):
    try:
        return Decimal(str(v or 0)).quantize(Decimal('0.01'))
    except Exception:
        return ZERO


def backfill(apps, schema_editor):
    Settlement = apps.get_model('financial', 'BillSettlement')
    Allocation = apps.get_model('financial', 'BillAllocation')
    Journal = apps.get_model('financial', 'JournalEntry')
    Line = apps.get_model('financial', 'LedgerEntry')
    Payment = apps.get_model('sales', 'Payment')
    Invoice = apps.get_model('sales', 'Invoice')
    Customer = apps.get_model('sales', 'Customer')
    Collection = apps.get_model('sales', 'WholesalePaymentCollection')
    WInvoice = apps.get_model('sales', 'WholesaleInvoice')
    Dealer = apps.get_model('sales', 'Dealer')
    PInvoice = apps.get_model('purchasing', 'PurchaseInvoice')

    have = set(Settlement.objects.values_list('tenant_id', 'voucher_type', 'number'))

    # ---- Payment Vouchers ----
    for entry in Journal.objects.filter(source_module='financial', is_reversal=False,
                                        metadata__has_key='bill_allocations').order_by('date', 'created_at'):
        if (entry.tenant_id, 'PV', entry.entry_number) in have:
            continue
        meta = entry.metadata or {}
        party = meta.get('party') or {}
        allocs = [a for a in meta.get('bill_allocations') or [] if a.get('kind') == 'purchase_invoice']
        on_account = _money(meta.get('on_account'))
        allocated = sum((_money(a.get('amount')) for a in allocs), ZERO)
        pays = [{'method': (l.memo or '').split(' ')[0] or 'Payment', 'amount': str(_money(l.credit)),
                 'bank_account': str(l.account_id), 'bank_name': '', 'ref_no': '', 'ref_date': None,
                 'cheque_number': '', 'cheque_date': None, 'cheque_bank': ''}
                for l in Line.objects.filter(journal_entry_id=entry.pk, credit__gt=0)]
        s = Settlement.objects.create(
            tenant_id=entry.tenant_id, number=entry.entry_number, voucher_type='PV', date=entry.date,
            party_kind='supplier', party_id=str(party.get('id') or ''), party_name=(party.get('name') or '')[:200],
            party_code=(party.get('code') or '')[:60], total_amount=allocated + on_account, allocated_amount=allocated,
            on_account_amount=on_account, payments=pays, narration=(entry.narration or '')[:500],
            journal_entry_id=entry.pk, status='POSTED' if entry.status == 'POSTED' else 'REVERSED',
            origin='backfill', branch_id=entry.branch_id)
        bills = {str(b.pk): b for b in PInvoice.objects.filter(pk__in=[a.get('id') for a in allocs if a.get('id')])}
        Allocation.objects.bulk_create([
            Allocation(tenant_id=entry.tenant_id, settlement=s, position=n, bill_kind='purchase_invoice',
                       bill_id=str(a.get('id') or ''), bill_number=(a.get('number') or '')[:60],
                       bill_ref=((bills[a['id']].supplier_invoice_number or '') if a.get('id') in bills else '')[:80],
                       bill_date=bills[a['id']].purchase_date if a.get('id') in bills else None,
                       bill_total=bills[a['id']].grand_total if a.get('id') in bills else None,
                       allocated_amount=_money(a.get('amount')))
            for n, a in enumerate(allocs, start=1)])

    # ---- Receipt Vouchers (BR- receipts) ----
    groups = {}
    for p in Payment.objects.filter(receipt_no__startswith='BR-').order_by('receipt_no'):
        if getattr(p, 'is_deleted', False):
            continue
        key = (p.tenant_id, p.receipt_no.split('/', 1)[0])
        groups.setdefault(key, {'kind': 'customer', 'rows': []})['rows'].append(p)
    for c in Collection.objects.filter(receipt_number__startswith='BR-').order_by('receipt_number'):
        if getattr(c, 'is_deleted', False):
            continue
        key = (c.tenant_id, c.receipt_number.split('/', 1)[0])
        groups.setdefault(key, {'kind': 'dealer', 'rows': []})['rows'].append(c)

    for (tenant_id, number), g in groups.items():
        if (tenant_id, 'RV', number) in have:
            continue
        rows, kind = g['rows'], g['kind']
        first = rows[0]
        per_bill, pays, on_account = {}, {}, ZERO
        if kind == 'customer':
            party = Customer.objects.filter(pk=first.customer_id).first() if first.customer_id else None
            party_id = str(first.customer_id or '')
            party_name = (party.name if party else first.customer_name) or ''
            party_code = (party.patient_code if party else '') or ''
            for p in rows:
                amt = _money(p.amount)
                if p.invoice_id:
                    b = per_bill.setdefault(str(p.invoice_id), {'amount': ZERO, 'receipts': []})
                    b['amount'] += amt
                    b['receipts'].append(p.receipt_no)
                else:
                    on_account += amt
                k = (p.method or '', str(p.bank_account_id or ''))
                pays[k] = pays.get(k, ZERO) + amt
            bills = {str(i.pk): ('invoice', i.invoice_number, None, i.invoice_date, i.net_amount)
                     for i in Invoice.objects.filter(pk__in=list(per_bill))}
            date, branch_id = first.payment_date, first.branch_id
        else:
            party = Dealer.objects.filter(pk=first.dealer_id).first()
            party_id = str(first.dealer_id or '')
            party_name = party.business_name if party else ''
            party_code = party.dealer_code if party else ''
            by_number = {}
            for c in rows:
                amt = _money(c.amount_paid)
                if c.invoice_number:
                    b = by_number.setdefault(c.invoice_number, {'amount': ZERO, 'receipts': []})
                    b['amount'] += amt
                    b['receipts'].append(c.receipt_number)
                else:
                    on_account += amt
                k = (c.payment_method or '', str(c.bank_account_id or ''))
                pays[k] = pays.get(k, ZERO) + amt
            invs = {i.invoice_number: i for i in WInvoice.objects.filter(dealer_id=first.dealer_id,
                                                                           invoice_number__in=list(by_number))}
            bills = {}
            for no, b in by_number.items():
                inv = invs.get(no)
                bid = str(inv.pk) if inv else no
                per_bill[bid] = b
                bills[bid] = ('wholesale_invoice', no, None, inv.invoice_date if inv else None, inv.grand_total if inv else None)
            date, branch_id = first.payment_date, first.branch_id
        allocated = sum((b['amount'] for b in per_bill.values()), ZERO)
        s = Settlement.objects.create(
            tenant_id=tenant_id, number=number, voucher_type='RV', date=date, party_kind=kind, party_id=party_id,
            party_name=party_name[:200], party_code=(party_code or '')[:60], total_amount=allocated + on_account,
            allocated_amount=allocated, on_account_amount=on_account,
            payments=[{'method': m, 'amount': str(a), 'bank_account': bank or None, 'bank_name': '', 'ref_no': '',
                       'ref_date': None, 'cheque_number': '', 'cheque_date': None, 'cheque_bank': ''}
                      for (m, bank), a in pays.items()],
            origin='backfill', branch_id=branch_id)
        Allocation.objects.bulk_create([
            Allocation(tenant_id=tenant_id, settlement=s, position=n,
                       bill_kind=(bills.get(bid) or (('invoice' if kind == 'customer' else 'wholesale_invoice'),))[0],
                       bill_id=bid, bill_number=((bills.get(bid) or (None, bid))[1] or '')[:60],
                       bill_date=bills[bid][3] if bid in bills else None,
                       bill_total=bills[bid][4] if bid in bills else None,
                       allocated_amount=b['amount'], receipt_numbers=b['receipts'])
            for n, (bid, b) in enumerate(per_bill.items(), start=1)])


class Migration(migrations.Migration):

    dependencies = [
        ('financial', '0013_bill_settlement'),
        ('sales', '0040_wholesale_invoice_delivery'),
        ('purchasing', '0017_attachment_name_db_default'),
    ]

    operations = [migrations.RunPython(backfill, migrations.RunPython.noop)]
