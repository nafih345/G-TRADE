"""Purchase Entry → Barcode Printing: per-line label progress with resumable print jobs.

Each PurchaseInvoiceItem needs `label_total` labels (quantity + free quantity) and has had
units 1..labels_printed confirmed printed. Printing always continues from the next unit, so a
job that stopped part-way (printer out of labels, jam) resumes exactly where it stopped and
never repeats a label.

A browser print job can't report what the printer really produced, so:
  1. start_job records a PRINT job as SENT with the exact unit ranges, in print order;
  2. the user confirms how far it got — all, "the last good label was N", or none;
  3. confirm_job moves the counters by exactly what printed.
While a PRINT job is SENT no other PRINT job can start on the entry (the screen asks for that
confirmation first, even after a reload), so counts can't be applied twice or overlap.
REPRINT jobs re-issue units already counted (lost / damaged tags) and are logged only.
"""
from django.db import transaction
from django.db.models import F
from django.utils import timezone

from .models import PurchaseInvoiceItem, PurchaseLabelPrintJob

MAX_LABELS_PER_JOB = 20000
HISTORY_LIMIT = 30


class LabelPrintError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def _line_key(item):
    return (str(item.product_id), (item.batch_number or '').strip().lower(), str(item.expiry_date or ''))


def carry_over_label_progress(invoice, old_items, new_items):
    """An edit deletes and recreates the entry's lines. Hand each new line the printed count of
    the old line with the same product / batch / expiry (matched in order, so two identical
    lines keep their own counts), and repoint any unconfirmed job at the new line ids."""
    pool = {}
    for item in old_items:
        pool.setdefault(_line_key(item), []).append(item)
    id_map, changed = {}, []
    for item in new_items:
        bucket = pool.get(_line_key(item))
        if not bucket:
            continue
        old = bucket.pop(0)
        id_map[str(old.pk)] = str(item.pk)
        if old.labels_printed:
            item.labels_printed = old.labels_printed
            changed.append(item)
    if changed:
        PurchaseInvoiceItem.objects.bulk_update(changed, ['labels_printed'])
    for job in PurchaseLabelPrintJob.objects.filter(purchase_invoice=invoice, status='SENT'):
        job.lines = [{**ln, 'item': id_map.get(str(ln.get('item')), ln.get('item'))} for ln in job.lines or []]
        job.save(update_fields=['lines', 'updated_at'])


def _attr(product, name):
    value = getattr(product, name, None)
    if not value and isinstance(product.extra_data, dict):
        value = product.extra_data.get(name) or product.extra_data.get('colour' if name == 'color' else name)
    return value or ''


def _item_row(item):
    total = item.label_total
    printed = item.labels_printed
    product = item.product
    return {
        'id': str(item.pk),
        'product': str(item.product_id),
        'product_name': product.name,
        'sku': product.sku or '',
        'brand': product.brand_name or '',
        'color': _attr(product, 'color'),
        'size': _attr(product, 'size'),
        'barcode': item.barcode or product.barcode or '',
        'batch_number': item.batch_number or '',
        'expiry_date': item.expiry_date.isoformat() if item.expiry_date else '',
        'quantity': float(item.quantity or 0),
        'free_quantity': float(item.free_quantity or 0),
        'mrp': float(item.mrp or 0),
        'selling_price': float(item.selling_price or 0),
        'total': total,
        'printed': min(printed, total),
        # Labels confirmed beyond the line's current quantity (it was reduced after printing).
        'over_printed': max(0, printed - total),
        'pending': max(0, total - printed),
        'next_unit': printed + 1 if printed < total else None,
    }


def _job_row(job):
    return {
        'id': str(job.pk),
        'kind': job.kind,
        'status': job.status,
        'lines': job.lines or [],
        'labels_sent': job.labels_sent,
        'labels_printed': job.labels_printed,
        'template_name': job.template_name,
        'printed_by': job.printed_by,
        'confirmed_by': job.confirmed_by,
        'created_at': job.created_at.isoformat() if job.created_at else None,
        'confirmed_at': job.confirmed_at.isoformat() if job.confirmed_at else None,
    }


def _items(invoice, lock=False):
    qs = PurchaseInvoiceItem.objects.filter(purchase_invoice=invoice).select_related('product')  # Meta: line order
    return list(qs.select_for_update(of=('self',)) if lock else qs)


def label_status(invoice):
    items = _items(invoice)
    jobs = list(PurchaseLabelPrintJob.objects.filter(purchase_invoice=invoice).order_by('-created_at')[:HISTORY_LIMIT])
    open_job = PurchaseLabelPrintJob.objects.filter(purchase_invoice=invoice, kind='PRINT', status='SENT').first()
    rows = [_item_row(i) for i in items]
    return {
        'invoice': {
            'id': str(invoice.pk),
            'invoice_number': invoice.invoice_number,
            'supplier_invoice_number': invoice.supplier_invoice_number or '',
            'supplier_name': invoice.supplier.name if invoice.supplier_id else '',
            'purchase_date': invoice.purchase_date.isoformat() if invoice.purchase_date else None,
            'status': invoice.status,
        },
        'items': rows,
        'totals': {
            'labels': sum(r['total'] for r in rows),
            'printed': sum(r['printed'] for r in rows),
            'pending': sum(r['pending'] for r in rows),
        },
        'open_job': _job_row(open_job) if open_job else None,
        'history': [_job_row(j) for j in jobs],
    }


def label_queue(invoices):
    """Purchase → Barcode Printing queue: every saved entry in `invoices` (already tenant /
    branch scoped) that still has labels to print, oldest purchase first."""
    lines = (PurchaseInvoiceItem.objects
             .filter(purchase_invoice__in=invoices.exclude(status='CANCELLED'),
                     labels_printed__lt=F('quantity') + F('free_quantity'))
             .values('purchase_invoice_id', 'quantity', 'free_quantity', 'labels_printed'))
    pending = {}
    for ln in lines:
        left = max(0, int((ln['quantity'] or 0) + (ln['free_quantity'] or 0))) - ln['labels_printed']
        if left <= 0:  # fractional qty: 2.5 → 2 labels, already printed
            continue
        row = pending.setdefault(ln['purchase_invoice_id'], {'items': 0, 'labels': 0, 'resume': False})
        row['items'] += 1
        row['labels'] += left
        row['resume'] = row['resume'] or ln['labels_printed'] > 0
    if not pending:
        return []
    open_jobs = set(PurchaseLabelPrintJob.objects
                    .filter(purchase_invoice_id__in=pending, kind='PRINT', status='SENT')
                    .values_list('purchase_invoice_id', flat=True))
    entries = invoices.model.objects.filter(pk__in=pending).select_related('supplier').order_by('purchase_date', 'created_at')
    return [{
        'id': str(inv.pk),
        'invoice_number': inv.invoice_number,
        'supplier_invoice_number': inv.supplier_invoice_number or '',
        'supplier_name': inv.supplier.name if inv.supplier_id else '',
        'purchase_date': inv.purchase_date.isoformat() if inv.purchase_date else None,
        'status': inv.status,
        'pending_items': pending[inv.pk]['items'],
        'pending_labels': pending[inv.pk]['labels'],
        # Some of its pending lines are part-printed: the next print resumes mid-line.
        'resume': pending[inv.pk]['resume'],
        'awaiting_confirmation': inv.pk in open_jobs,
    } for inv in entries]


def _as_int(value, name):
    try:
        n = int(value)
    except (TypeError, ValueError):
        raise LabelPrintError(f'{name} must be a whole number.')
    return n


@transaction.atomic
def start_job(invoice, data, actor=''):
    """data: {kind: PRINT|REPRINT, template_name, lines: [{item, from_unit, to_unit}]} (print order)."""
    kind = str(data.get('kind') or 'PRINT').upper()
    if kind not in ('PRINT', 'REPRINT'):
        raise LabelPrintError('kind must be PRINT or REPRINT.')
    if invoice.status == 'CANCELLED':
        raise LabelPrintError('This purchase entry is cancelled.')
    requested = data.get('lines')
    if not isinstance(requested, list) or not requested:
        raise LabelPrintError('Select at least one item to print.')

    # Lock the entry so two screens can't both start a PRINT job on it.
    type(invoice).objects.select_for_update().filter(pk=invoice.pk).first()
    items = {str(i.pk): i for i in _items(invoice, lock=True)}
    if kind == 'PRINT' and PurchaseLabelPrintJob.objects.filter(purchase_invoice=invoice, kind='PRINT', status='SENT').exists():
        raise LabelPrintError('A print job on this entry is still waiting for confirmation. Confirm how many labels printed first.', 409)

    lines, seen, sent = [], set(), 0
    for raw in requested:
        if not isinstance(raw, dict):
            raise LabelPrintError('Each line needs item, from_unit and to_unit.')
        item = items.get(str(raw.get('item')))
        if item is None:
            raise LabelPrintError('An item in this print is no longer on the purchase entry. Refresh and try again.', 409)
        if item.pk in seen:
            raise LabelPrintError(f'{item.product.name} is listed twice in this print.')
        seen.add(item.pk)
        start, end = _as_int(raw.get('from_unit'), 'from_unit'), _as_int(raw.get('to_unit'), 'to_unit')
        name = item.product.name
        if end < start:
            raise LabelPrintError(f'{name}: "to" unit is before the "from" unit.')
        if kind == 'PRINT':
            # Resume exactly after the last confirmed label — anything else would skip or repeat units.
            if start != item.labels_printed + 1:
                raise LabelPrintError(f'{name}: labels 1–{item.labels_printed} are already printed; printing continues from '
                                      f'unit {item.labels_printed + 1}. Refresh and try again.', 409)
            if end > item.label_total:
                raise LabelPrintError(f'{name}: only {item.label_total} label(s) on this line.')
        else:
            if start < 1 or end > item.labels_printed:
                raise LabelPrintError(f'{name}: only units 1–{item.labels_printed} have been printed, so only those can be reprinted.')
        lines.append({
            'item': str(item.pk), 'product_name': name, 'barcode': item.barcode or item.product.barcode or '',
            'from_unit': start, 'to_unit': end,
        })
        sent += end - start + 1
    if sent > MAX_LABELS_PER_JOB:
        raise LabelPrintError(f'At most {MAX_LABELS_PER_JOB} labels per print job.')

    job = PurchaseLabelPrintJob.objects.create(
        purchase_invoice=invoice, kind=kind, lines=lines, labels_sent=sent,
        template_name=str(data.get('template_name') or '')[:150], printed_by=actor or '',
        # A reprint never changes the counters, so there is nothing to confirm.
        status='SENT' if kind == 'PRINT' else 'COMPLETED',
        labels_printed=0 if kind == 'PRINT' else sent,
        confirmed_at=None if kind == 'PRINT' else timezone.now(),
    )
    return _job_row(job)


@transaction.atomic
def confirm_job(invoice, job_id, data, actor=''):
    """data: {outcome: ALL|PARTIAL|NONE, printed_count}. printed_count (PARTIAL) = how many labels
    from the start of the job came out right; labels after it count as not printed."""
    job = PurchaseLabelPrintJob.objects.select_for_update().filter(purchase_invoice=invoice, pk=job_id).first()
    if job is None:
        raise LabelPrintError('Print job not found.', 404)
    if job.status != 'SENT':
        raise LabelPrintError('This print job has already been confirmed.', 409)

    outcome = str(data.get('outcome') or '').upper()
    if outcome == 'ALL':
        count = job.labels_sent
    elif outcome == 'NONE':
        count = 0
    elif outcome == 'PARTIAL':
        count = _as_int(data.get('printed_count'), 'printed_count')
        if count < 0 or count > job.labels_sent:
            raise LabelPrintError(f'printed_count must be between 0 and {job.labels_sent}.')
    else:
        raise LabelPrintError('outcome must be ALL, PARTIAL or NONE.')

    items = {str(i.pk): i for i in _items(invoice, lock=True)}
    left, changed, skipped = count, [], []
    for line in job.lines or []:
        size = line['to_unit'] - line['from_unit'] + 1
        done = min(left, size)
        left -= done
        line['printed'] = done
        if not done:
            continue
        item = items.get(str(line['item']))
        # The line was removed by an edit, or its progress moved some other way: don't guess.
        if item is None or item.labels_printed != line['from_unit'] - 1:
            skipped.append(line['product_name'])
            continue
        item.labels_printed = line['from_unit'] - 1 + done
        changed.append(item)
    if changed:
        PurchaseInvoiceItem.objects.bulk_update(changed, ['labels_printed'])

    job.labels_printed = count
    job.status = 'COMPLETED' if count == job.labels_sent else 'FAILED' if count == 0 else 'PARTIAL'
    job.confirmed_by = actor or ''
    job.confirmed_at = timezone.now()
    job.save(update_fields=['lines', 'labels_printed', 'status', 'confirmed_by', 'confirmed_at', 'updated_at'])
    return {'job': _job_row(job), 'skipped': skipped, 'status': label_status(invoice)}
