"""Read-only view into one client's (tenant's) records, for the platform console.

    GET .../tenants/<id>/data/                      datasets with row counts + last entry, recent activity
    GET .../tenants/<id>/data/<key>/                one dataset, paginated (search, date_from, date_to,
                                                    deleted=all|live|deleted, page, page_size, format=csv)
    GET .../tenants/<id>/data/<key>/<pk>/           one record: every stored field, plus its child lines

DATASETS is the whole surface: a dataset names a model, the columns the list shows, what the search
box matches and which date the range filters on. Only listed models are reachable, and every query
is pinned to the client explicitly (tenancy.unscoped + tenant_id filter) rather than through the
caller's own tenant context — the platform admin belongs to tenant #1, not to the client viewed.

Soft-deleted rows are shown (flagged) by default: an audit must see what was removed, not only what
is left. Nothing here writes.
"""
import csv
import datetime
import decimal
import io
import uuid

from django.apps import apps
from django.core.exceptions import FieldDoesNotExist
from django.db.models import Max, Q
from django.utils.dateparse import parse_date

from apps.common import tenancy


def _ds(key, label, section, model, columns, search=(), date='created_at', order=None, children=(), hint=''):
    return {'key': key, 'label': label, 'section': section, 'model': model, 'columns': columns,
            'search': search, 'date': date, 'order': order or (f'-{date}', '-pk'), 'children': children,
            'hint': hint}


def _child(label, model, fk, columns, order=('created_at', 'pk')):
    return {'label': label, 'model': model, 'fk': fk, 'columns': columns, 'order': order}


BY = ('created_by__username', 'Entered by')

DATASETS = (
    _ds('patients', 'Patients', 'optical', 'sales.Customer',
        [('patient_code', 'Code'), ('name', 'Name'), ('phone', 'Phone'), ('gender', 'Gender'), ('age', 'Age'),
         ('place', 'Place'), ('outstanding_balance', 'Outstanding'), ('created_at', 'Created'), BY],
        search=('patient_code', 'name', 'phone', 'email', 'id_number')),
    _ds('eye_exams', 'Eye examinations & prescriptions', 'optical', 'sales.EyeExamination',
        [('test_no', 'Test No'), ('examination_date', 'Date'), ('patient_name', 'Patient'), ('patient_id', 'Patient ID'),
         ('optometrist', 'Optometrist'), ('test_type', 'Type'), ('rx_summary', 'Rx'), ('fee_status', 'Fee'),
         ('fee_amount', 'Fee amount'), BY],
        search=('test_no', 'patient_name', 'patient_id', 'phone', 'optometrist'), date='examination_date',
        hint='Open a record for the full prescription (subjective, auto-refraction, PGP, contact lens).'),
    _ds('appointments', 'Appointments', 'optical', 'sales.Appointment',
        [('appointment_code', 'Code'), ('appointment_date', 'Date'), ('appointment_time', 'Time'),
         ('patient_name', 'Patient'), ('doctor', 'Doctor'), ('appointment_type', 'Type'), ('status', 'Status'),
         ('branch', 'Branch'), BY],
        search=('appointment_code', 'patient_name', 'phone', 'doctor'), date='appointment_date'),
    _ds('invoices', 'Bills, orders & quotations', 'sales', 'sales.Invoice',
        [('invoice_number', 'Number'), ('document_type', 'Type'), ('invoice_date', 'Date'),
         ('customer_name', 'Customer'), ('branch__name', 'Branch'), ('net_amount', 'Net'), ('paid_amount', 'Paid'),
         ('status', 'Status'), ('salesman', 'Salesman'), BY],
        search=('invoice_number', 'customer_name', 'salesman', 'test_no'), date='invoice_date',
        children=(
            _child('Bill lines', 'sales.InvoiceItem', 'invoice',
                   [('item_type', 'Type'), ('description', 'Description'), ('product__name', 'Product'),
                    ('power', 'Power'), ('quantity', 'Qty'), ('unit_price', 'Rate'), ('tax_amount', 'Tax'),
                    ('subtotal', 'Amount')]),
            _child('Payments', 'sales.Payment', 'invoice',
                   [('receipt_no', 'Receipt'), ('payment_date', 'Date'), ('method', 'Mode'), ('amount', 'Amount'),
                    ('status', 'Status')]),
        )),
    _ds('payments', 'Payment receipts', 'sales', 'sales.Payment',
        [('receipt_no', 'Receipt'), ('payment_date', 'Date'), ('customer_name', 'Customer'),
         ('invoice__invoice_number', 'Bill'), ('method', 'Mode'), ('amount', 'Amount'), ('status', 'Status'),
         ('source', 'Source'), ('branch__name', 'Branch'), BY],
        search=('receipt_no', 'customer_name', 'invoice__invoice_number', 'notes'), date='payment_date'),
    _ds('wholesale_invoices', 'Wholesale invoices', 'wholesale', 'sales.WholesaleInvoice',
        [('invoice_number', 'Number'), ('invoice_date', 'Date'), ('dealer__business_name', 'Dealer'),
         ('grand_total', 'Total'), ('paid_amount', 'Paid'), ('due_amount', 'Due'), ('status', 'Status'), BY],
        search=('invoice_number', 'dealer__business_name', 'order_ref'), date='invoice_date'),
    _ds('wholesale_collections', 'Wholesale collections', 'wholesale', 'sales.WholesalePaymentCollection',
        [('receipt_number', 'Receipt'), ('payment_date', 'Date'), ('dealer__business_name', 'Dealer'),
         ('invoice_number', 'Invoice'), ('payment_method', 'Mode'), ('amount_paid', 'Amount'), BY],
        search=('receipt_number', 'dealer__business_name', 'invoice_number'), date='payment_date'),
    _ds('dealers', 'Dealers', 'wholesale', 'sales.Dealer',
        [('dealer_code', 'Code'), ('business_name', 'Business'), ('phone', 'Phone'), ('city', 'City'),
         ('outstanding_balance', 'Outstanding'), ('status', 'Status'), ('created_at', 'Created')],
        search=('dealer_code', 'business_name', 'phone', 'gstin')),
    _ds('products', 'Products', 'inventory', 'products.Product',
        [('name', 'Name'), ('sku', 'SKU'), ('barcode', 'Barcode'), ('category_name', 'Category'),
         ('brand_name', 'Brand'), ('cost_price', 'Cost'), ('retail_price', 'MRP'), ('stock', 'Stock'),
         ('is_active', 'Active'), ('created_at', 'Created')],
        search=('name', 'sku', 'barcode', 'secondary_barcode', 'brand_name', 'category_name')),
    _ds('stock_adjustments', 'Stock adjustments', 'inventory', 'inventory.StockAdjustment',
        [('adjustment_number', 'Number'), ('created_at', 'When'), ('product__name', 'Product'),
         ('branch__name', 'Branch'), ('adjustment_type', 'Type'), ('quantity', 'Qty'),
         ('previous_quantity', 'Before'), ('new_quantity', 'After'), ('reason', 'Reason'),
         ('performed_by', 'By')],
        search=('adjustment_number', 'product__name', 'reason', 'reference', 'performed_by')),
    _ds('stock_ledger', 'Stock ledger (every movement)', 'inventory', 'inventory.StockLedger',
        [('created_at', 'When'), ('product__name', 'Product'), ('branch__name', 'Branch'),
         ('transaction_type', 'Movement'), ('quantity', 'Qty'), ('balance_after', 'Balance'),
         ('reference_number', 'Reference'), ('performed_by', 'By')],
        search=('product__name', 'reference_number', 'notes', 'performed_by', 'transaction_type')),
    _ds('stock_transfers', 'Branch stock transfers', 'inventory', 'company.StockTransfer',
        [('transfer_number', 'Number'), ('created_at', 'Created'), ('from_branch__name', 'From'),
         ('to_branch__name', 'To'), ('status', 'Status'), ('transferred_at', 'Transferred'), BY],
        search=('transfer_number', 'notes'),
        children=(_child('Items', 'company.StockTransferItem', 'transfer',
                         [('product__name', 'Product'), ('quantity', 'Qty')]),)),
    _ds('purchase_invoices', 'Purchase entries', 'purchase', 'purchasing.PurchaseInvoice',
        [('invoice_number', 'Number'), ('supplier_invoice_number', 'Supplier bill'), ('purchase_date', 'Date'),
         ('supplier__name', 'Supplier'), ('branch__name', 'Branch'), ('grand_total', 'Total'),
         ('paid_amount', 'Paid'), ('balance_amount', 'Balance'), ('payment_status', 'Payment'), BY],
        search=('invoice_number', 'supplier_invoice_number', 'supplier__name'), date='purchase_date',
        children=(_child('Items', 'purchasing.PurchaseInvoiceItem', 'purchase_invoice',
                         [('product__name', 'Product'), ('barcode', 'Barcode'), ('quantity', 'Qty'),
                          ('free_quantity', 'Free'), ('purchase_rate', 'Rate'), ('gst_amount', 'Tax'),
                          ('line_total', 'Amount')]),)),
    _ds('suppliers', 'Suppliers', 'purchase', 'purchasing.Supplier',
        [('supplier_code', 'Code'), ('name', 'Name'), ('phone', 'Phone'), ('gstin', 'GSTIN'), ('city', 'City'),
         ('outstanding_balance', 'Outstanding'), ('created_at', 'Created')],
        search=('supplier_code', 'name', 'company_name', 'phone', 'gstin')),
    _ds('lens_orders', 'Lens purchase orders', 'purchase', 'purchasing.LensPurchaseOrder',
        [('po_number', 'PO'), ('order_date', 'Date'), ('supplier__name', 'Supplier'), ('branch__name', 'Branch'),
         ('expected_delivery_date', 'Expected'), ('status', 'Status'), ('created_by_name', 'Entered by')],
        search=('po_number', 'supplier__name', 'remarks'), date='order_date'),
    _ds('journals', 'Journal entries', 'financial', 'financial.JournalEntry',
        [('entry_number', 'Number'), ('date', 'Date'), ('voucher_type__name', 'Voucher'),
         ('source_module', 'Source'), ('source_number', 'Document'), ('narration', 'Narration'),
         ('total_amount', 'Amount'), ('status', 'Status'), ('is_reversal', 'Reversal'), BY],
        search=('entry_number', 'source_number', 'narration', 'source_module'), date='date',
        children=(_child('Ledger lines', 'financial.LedgerEntry', 'journal_entry',
                         [('account__code', 'Code'), ('account__name', 'Account'), ('debit', 'Debit'),
                          ('credit', 'Credit'), ('memo', 'Memo')]),)),
    _ds('ledger_lines', 'Account ledger lines', 'financial', 'financial.LedgerEntry',
        [('journal_entry__date', 'Date'), ('journal_entry__entry_number', 'Journal'), ('account__code', 'Code'),
         ('account__name', 'Account'), ('debit', 'Debit'), ('credit', 'Credit'), ('memo', 'Memo')],
        search=('account__name', 'account__code', 'memo', 'journal_entry__entry_number'),
        date='journal_entry__date'),
    _ds('accounts', 'Chart of accounts', 'financial', 'financial.ChartOfAccount',
        [('code', 'Code'), ('name', 'Name'), ('account_group__name', 'Group'), ('account_subtype', 'Type'),
         ('opening_balance', 'Opening'), ('current_balance', 'Balance'), ('status', 'Status')],
        search=('code', 'name'), order=('code', 'pk')),
    _ds('cheques', 'Cheques', 'financial', 'financial.Cheque',
        [('cheque_number', 'Cheque'), ('cheque_date', 'Date'), ('direction', 'Direction'), ('party_name', 'Party'),
         ('bank_name', 'Bank'), ('amount', 'Amount'), ('status', 'Status'), ('voucher_number', 'Voucher')],
        search=('cheque_number', 'party_name', 'bank_name', 'voucher_number'), date='cheque_date'),
    _ds('financial_audit', 'Financial audit log', 'logs', 'financial.FinancialAuditLog',
        [('created_at', 'When'), ('action', 'Action'), ('object_type', 'Object'), ('summary', 'Summary'),
         ('actor_name', 'By')],
        search=('action', 'object_type', 'summary', 'actor_name')),
    _ds('settings_audit', 'Settings change log', 'logs', 'company.SettingsAuditLog',
        [('created_at', 'When'), ('section', 'Section'), ('action', 'Action'), ('summary', 'Summary'),
         ('performed_by', 'By')],
        search=('section', 'action', 'summary', 'performed_by')),
)
DATASET_MAP = {d['key']: d for d in DATASETS}
SECTIONS = (
    ('optical', 'Optical Services'), ('sales', 'Sales'), ('wholesale', 'Wholesale'), ('inventory', 'Inventory'),
    ('purchase', 'Purchase'), ('financial', 'Financial Accounts'), ('logs', 'Audit logs'),
)
# The recent-activity feed: what the client entered last, across these datasets.
ACTIVITY = ('patients', 'eye_exams', 'appointments', 'invoices', 'payments', 'wholesale_invoices',
            'stock_adjustments', 'purchase_invoices', 'journals')
MAX_PAGE_SIZE = 200
CSV_LIMIT = 50000


class DatasetError(Exception):
    pass


def _model(ds):
    return apps.get_model(ds['model'])


def _resolve(model, path):
    """The model field at the end of a `a__b__c` path."""
    field = None
    for part in path.split('__'):
        field = model._meta.get_field(part)
        if field.is_relation:
            model = field.related_model
    return field


def _kind(field):
    t = field.get_internal_type()
    if t == 'DecimalField':
        return 'money'
    if t in ('IntegerField', 'PositiveIntegerField', 'PositiveSmallIntegerField', 'BigIntegerField',
             'SmallIntegerField', 'FloatField', 'BigAutoField', 'AutoField'):
        return 'number'
    if t == 'DateTimeField':
        return 'datetime'
    if t == 'DateField':
        return 'date'
    if t == 'BooleanField':
        return 'bool'
    if t == 'JSONField':
        return 'json'
    return 'text'


def _columns(model, columns):
    return [{'key': path, 'label': label, 'kind': _kind(_resolve(model, path))} for path, label in columns]


def _plain(value):
    if isinstance(value, (datetime.datetime, datetime.date, datetime.time)):
        return value.isoformat()
    if isinstance(value, decimal.Decimal):
        return str(value)
    if isinstance(value, uuid.UUID):
        return str(value)
    if isinstance(value, (bytes, memoryview)):
        return '(binary)'
    return value


def _has_field(model, name):
    try:
        model._meta.get_field(name)
        return True
    except FieldDoesNotExist:
        return False


def _base(tenant, model):
    # _base_manager: no soft-delete filter, no tenant scope — the tenant is pinned right here.
    return model._base_manager.filter(tenant_id=tenant.pk)


def get_dataset(key):
    ds = DATASET_MAP.get(key)
    if ds is None:
        raise DatasetError('Unknown dataset.')
    return ds


def catalog():
    out = []
    for ds in DATASETS:
        model = _model(ds)
        out.append({'key': ds['key'], 'label': ds['label'], 'section': ds['section'], 'hint': ds['hint'],
                    'columns': _columns(model, ds['columns']), 'searchable': bool(ds['search']),
                    'date_label': _resolve(model, ds['date']).verbose_name.capitalize(),
                    'soft_delete': _has_field(model, 'is_deleted')})
    return out


def overview(tenant):
    """Row counts and newest entry per dataset, plus the latest records across the business."""
    counts = []
    activity = []
    with tenancy.unscoped():
        for ds in DATASETS:
            model = _model(ds)
            qs = _base(tenant, model)
            soft = _has_field(model, 'is_deleted')
            row = {'key': ds['key'], 'count': qs.count(),
                   'deleted': qs.filter(is_deleted=True).count() if soft else 0,
                   'last_entry_at': _plain(qs.aggregate(m=Max('created_at'))['m']) if _has_field(model, 'created_at') else None}
            counts.append(row)
            if ds['key'] in ACTIVITY and row['count']:
                ref_col = ds['columns'][0][0]
                party = next((p for p, _ in ds['columns'] if p in ('patient_name', 'customer_name', 'name',
                                                                   'dealer__business_name', 'supplier__name',
                                                                   'product__name', 'narration')), None)
                amount = next((p for p, _ in ds['columns'] if p in ('net_amount', 'amount', 'grand_total',
                                                                    'total_amount', 'quantity')), None)
                fields = ['pk', 'created_at', ref_col] + [f for f in (party, amount) if f]
                if _has_field(model, 'created_by'):
                    fields.append('created_by__username')
                for r in qs.order_by('-created_at').values(*fields)[:10]:
                    activity.append({'dataset': ds['key'], 'label': ds['label'], 'id': str(r['pk']),
                                     'created_at': _plain(r['created_at']), 'reference': _plain(r[ref_col]),
                                     'party': _plain(r.get(party)) if party else None,
                                     'amount': _plain(r.get(amount)) if amount else None,
                                     'amount_kind': 'number' if amount == 'quantity' else 'money',
                                     'by': r.get('created_by__username') or ''})
    activity.sort(key=lambda a: a['created_at'] or '', reverse=True)
    return {'sections': [{'key': k, 'label': label} for k, label in SECTIONS], 'datasets': catalog(),
            'counts': counts, 'activity': activity[:40]}


def _filtered(tenant, ds, params):
    model = _model(ds)
    qs = _base(tenant, model)
    term = (params.get('search') or '').strip()
    if term and ds['search']:
        q = Q()
        for path in ds['search']:
            q |= Q(**{f'{path}__icontains': term})
        qs = qs.filter(q)
    date_path = ds['date']
    is_datetime = _kind(_resolve(model, date_path)) == 'datetime'
    for param, op in (('date_from', 'gte'), ('date_to', 'lte')):
        raw = params.get(param)
        if not raw:
            continue
        day = parse_date(str(raw))
        if day is None:
            raise DatasetError(f'{param} must be a date (YYYY-MM-DD).')
        qs = qs.filter(**{f'{date_path}__date__{op}' if is_datetime else f'{date_path}__{op}': day})
    deleted = params.get('deleted') or 'all'
    if _has_field(model, 'is_deleted') and deleted in ('live', 'deleted'):
        qs = qs.filter(is_deleted=(deleted == 'deleted'))
    return model, qs.order_by(*ds['order'])


def _row_values(model, qs, ds):
    paths = [p for p, _ in ds['columns']]
    extra = ['is_deleted'] if _has_field(model, 'is_deleted') else []
    for r in qs.values('pk', *paths, *extra):
        yield {'id': str(r['pk']), 'deleted': bool(r.get('is_deleted')),
               'values': {p: _plain(r[p]) for p in paths}}


def rows(tenant, key, params):
    ds = get_dataset(key)
    try:
        page = max(1, int(params.get('page') or 1))
        size = min(MAX_PAGE_SIZE, max(1, int(params.get('page_size') or 50)))
    except ValueError:
        raise DatasetError('page and page_size must be numbers.')
    with tenancy.unscoped():
        model, qs = _filtered(tenant, ds, params)
        total = qs.count()
        start = (page - 1) * size
        results = list(_row_values(model, qs[start:start + size], ds))
    return {'dataset': key, 'label': ds['label'], 'columns': _columns(model, ds['columns']),
            'count': total, 'page': page, 'page_size': size, 'results': results}


def export_csv(tenant, key, params):
    """(filename, csv text, rows written) of the filtered dataset, at most CSV_LIMIT rows."""
    ds = get_dataset(key)
    out = io.StringIO()
    writer = csv.writer(out)
    labels = [label for _, label in ds['columns']]
    with tenancy.unscoped():
        model, qs = _filtered(tenant, ds, params)
        soft = _has_field(model, 'is_deleted')
        writer.writerow(labels + (['Deleted'] if soft else []))
        n = 0
        for r in _row_values(model, qs[:CSV_LIMIT], ds):
            values = ['' if r['values'][p] is None else r['values'][p] for p, _ in ds['columns']]
            writer.writerow(values + (['yes' if r['deleted'] else ''] if soft else []))
            n += 1
    code = ''.join(c if c.isalnum() else '-' for c in (tenant.code or f'client{tenant.pk}'))
    return f'{code}_{key}_{datetime.date.today():%Y%m%d}.csv', '﻿' + out.getvalue(), n


def _field_value(obj, field):
    value = getattr(obj, field.attname)
    if field.is_relation and value is not None:
        related = getattr(obj, field.name, None)
        return {'id': _plain(value), 'text': str(related) if related is not None else None}
    if field.get_internal_type() == 'FileField':
        return value.name if value else None
    return _plain(value)


def record(tenant, key, pk):
    ds = get_dataset(key)
    with tenancy.unscoped():
        model = _model(ds)
        try:
            obj = _base(tenant, model).filter(pk=pk).first()
        except (ValueError, TypeError):
            obj = None
        if obj is None:
            raise DatasetError('Record not found for this client.')
        fields = [{'key': f.name, 'label': str(f.verbose_name).capitalize(), 'kind': _kind(f),
                   'value': _field_value(obj, f)}
                  for f in model._meta.concrete_fields if f.name != 'tenant']
        children = []
        for child in ds['children']:
            child_model = apps.get_model(child['model'])
            paths = [p for p, _ in child['columns']]
            qs = _base(tenant, child_model).filter(**{f"{child['fk']}_id": obj.pk}).order_by(*child['order'])
            extra = ['is_deleted'] if _has_field(child_model, 'is_deleted') else []
            children.append({
                'label': child['label'], 'columns': _columns(child_model, child['columns']),
                'rows': [{'id': str(r['pk']), 'deleted': bool(r.get('is_deleted')),
                          'values': {p: _plain(r[p]) for p in paths}} for r in qs.values('pk', *paths, *extra)[:500]],
            })
        title = ' · '.join(str(v) for v in (getattr(obj, ds['columns'][0][0].split('__')[0], None),) if v)
    return {'dataset': key, 'label': ds['label'], 'id': str(obj.pk), 'title': title or str(obj),
            'deleted': bool(getattr(obj, 'is_deleted', False)), 'fields': fields, 'children': children}
