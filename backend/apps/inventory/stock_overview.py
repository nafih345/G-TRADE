"""Purchase → Stock Overview API.

  GET   /api/inventory/stock-overview/                 paginated stock list (filters below)
  GET   /api/inventory/stock-overview/summary/         card totals for the same filters
  GET   /api/inventory/stock-overview/facets/          filter options + what this user may do
  GET   /api/inventory/stock-overview/lookup/?code=    exact scan match (barcodes / SKU)
  GET   /api/inventory/stock-overview/export/?export_format=xlsx|csv   filtered list as a file
  PATCH /api/inventory/stock-overview/<id>/            prices, minimum stock, rack, bin, UOM
  POST  /api/inventory/stock-overview/<id>/adjust/     set the counted quantity (ledgered)
  GET   /api/inventory/stock-overview/<id>/history/    the product's stock movements

Nothing here keeps its own stock: rows are Product records (each variant is its own Product,
so nothing is counted twice), quantities are Product.stock, and a quantity change is a
StockAdjustment pushed through apps.inventory.stock_utils.adjust_branch_stock — the same path
purchases and sales use — so BranchStock, Product.stock and the StockLedger stay consistent.

List filters: q (words; each must match some identifying field), code (exact scan), brand,
category, rack, supplier (Supplier id), variant_group, status (in|low|out), ordering.
"""
import csv
import io
import uuid
from decimal import Decimal, InvalidOperation

from django.db import transaction
from django.db.models import (
    Count, DecimalField, Exists, ExpressionWrapper, F, OuterRef, Q, Subquery, Sum, Value,
)
from django.db.models.functions import Coalesce
from django.http import HttpResponse
from django.utils import timezone
from django.utils.dateparse import parse_date
from rest_framework import permissions, status, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import NotFound, PermissionDenied
from rest_framework.pagination import PageNumberPagination
from rest_framework.response import Response

from apps.common.request_actor import actor_from_request, get_actor, reset_actor, set_actor
from apps.common.sequences import bump_sequence
from apps.products.models import Product, ProductBarcode, ProductVariantGroup
from apps.purchasing.models import PurchaseInvoice, PurchaseInvoiceItem, PurchaseOrder, Supplier

from .models import StockAdjustment, StockAdjustmentSequence, StockLedger
from .stock_utils import adjust_branch_stock

# ---------------------------------------------------------------------------------------------
# Permissions. Role codes match authentication.User.ROLE_CHOICES (superusers = SUPER_ADMIN).
# ---------------------------------------------------------------------------------------------
ALL_ROLES = {'SUPER_ADMIN', 'ADMINISTRATOR', 'MANAGER', 'ACCOUNTANT', 'INVENTORY_MANAGER',
             'SALES_EXECUTIVE', 'PURCHASE_EXECUTIVE', 'CASHIER'}
# Same set label_fields uses for purchase cost on labels: cost and purchase value are hidden
# from everyone else.
COST_VIEW_ROLES = {'SUPER_ADMIN', 'ADMINISTRATOR', 'MANAGER', 'ACCOUNTANT'}
PRICE_EDIT_ROLES = {'SUPER_ADMIN', 'ADMINISTRATOR', 'MANAGER'}
LOCATION_EDIT_ROLES = {'SUPER_ADMIN', 'ADMINISTRATOR', 'MANAGER', 'INVENTORY_MANAGER', 'PURCHASE_EXECUTIVE'}
STOCK_ADJUST_ROLES = {'SUPER_ADMIN', 'ADMINISTRATOR', 'MANAGER', 'INVENTORY_MANAGER'}
IMPORT_ROLES = {'SUPER_ADMIN', 'ADMINISTRATOR', 'MANAGER', 'INVENTORY_MANAGER', 'PURCHASE_EXECUTIVE'}
EXPORT_ROLES = {'SUPER_ADMIN', 'ADMINISTRATOR', 'MANAGER', 'ACCOUNTANT', 'INVENTORY_MANAGER', 'PURCHASE_EXECUTIVE'}

PRICE_FIELDS = {'cost_price', 'retail_price', 'mrp'}
LOCATION_FIELDS = {'minimum_stock', 'rack_location', 'bin_location', 'unit'}
EDITABLE_FIELDS = PRICE_FIELDS | LOCATION_FIELDS

MAX_QTY = 10_000_000
MAX_PRICE = Decimal('9999999999.99')  # Product price columns: max_digits=12, decimal_places=2
EXPORT_ROW_LIMIT = 200_000


def user_role(user):
    if not user or not getattr(user, 'is_authenticated', False):
        return ''
    if getattr(user, 'is_superuser', False):
        return 'SUPER_ADMIN'
    return (getattr(user, 'role', '') or '').upper()


def capabilities(user):
    role = user_role(user)
    return {
        'role': role,
        'view': role in ALL_ROLES,
        'view_cost': role in COST_VIEW_ROLES,
        'edit_prices': role in PRICE_EDIT_ROLES,
        'edit_location': role in LOCATION_EDIT_ROLES,
        'adjust_stock': role in STOCK_ADJUST_ROLES,
        'view_history': role in ALL_ROLES,
        'import': role in IMPORT_ROLES,
        'export': role in EXPORT_ROLES,
        'print_barcode': role in ALL_ROLES,
    }


class StockOverviewPermission(permissions.BasePermission):
    message = 'Sign in to view stock.'

    def has_permission(self, request, view):
        return user_role(request.user) in ALL_ROLES


# ---------------------------------------------------------------------------------------------
# Queryset: one SQL query per page — last purchase date / supplier are correlated subqueries
# evaluated only for the rows returned, barcode-series matches are EXISTS, never a join that
# would duplicate rows and need DISTINCT.
# ---------------------------------------------------------------------------------------------
STATUS_FILTERS = {
    'out': Q(stock__lte=0),
    'low': Q(stock__gt=0, stock__lte=F('minimum_stock')),
    'in': Q(stock__gt=F('minimum_stock')) & Q(stock__gt=0),
}

ORDERING = {
    'name': 'name', 'sku': 'sku', 'barcode': 'barcode', 'brand': 'brand_name', 'category': 'category_name',
    'rack': 'rack_location', 'bin': 'bin_location', 'stock': 'stock', 'minimum_stock': 'minimum_stock',
    'cost_price': 'cost_price', 'retail_price': 'retail_price', 'mrp': 'wholesale_price',
    'last_purchase_date': 'last_purchase_date', 'updated_at': 'updated_at',
}


def _last_purchase_items():
    return (PurchaseInvoiceItem.objects
            .filter(product=OuterRef('pk'), purchase_invoice__is_deleted=False)
            .exclude(purchase_invoice__status__in=['DRAFT', 'CANCELLED'])
            .order_by('-purchase_invoice__purchase_date', '-created_at'))


def base_queryset():
    last = _last_purchase_items()
    return (Product.objects.filter(is_active=True)
            .select_related('unit', 'variant_group')
            .annotate(last_purchase_date=Subquery(last.values('purchase_invoice__purchase_date')[:1]),
                      last_supplier_name=Subquery(last.values('purchase_invoice__supplier__name')[:1])))


def _search_q(word):
    return (Q(name__icontains=word) | Q(sku__icontains=word) | Q(barcode__icontains=word)
            | Q(secondary_barcode__icontains=word) | Q(brand_name__icontains=word)
            | Q(category_name__icontains=word) | Q(color__icontains=word) | Q(size__icontains=word)
            | Q(frame_type__icontains=word) | Q(variant_key__icontains=word)
            | Q(rack_location__icontains=word) | Q(bin_location__icontains=word)
            | Q(extra_data__model_no__icontains=word)
            | Q(Exists(ProductBarcode.objects.filter(product=OuterRef('pk'), code__icontains=word))))


def _code_q(code):
    """A scanned code: exact on every code a product scans as, or its SKU."""
    return (Q(barcode=code) | Q(secondary_barcode=code) | Q(sku__iexact=code)
            | Q(Exists(ProductBarcode.objects.filter(product=OuterRef('pk'), code=code))))


def _is_uuid(value):
    try:
        uuid.UUID(str(value))
        return True
    except (TypeError, ValueError, AttributeError):
        return False


def apply_filters(qs, params):
    q = (params.get('q') or params.get('search') or '').strip()
    for word in q.split()[:8]:
        qs = qs.filter(_search_q(word))
    code = (params.get('code') or '').strip()
    if code:
        qs = qs.filter(_code_q(code))
    for param, field in (('brand', 'brand_name'), ('category', 'category_name'), ('rack', 'rack_location')):
        value = (params.get(param) or '').strip()
        if value:
            qs = qs.filter(**{f'{field}__iexact': value})
    supplier = (params.get('supplier') or '').strip()
    if supplier:
        if not _is_uuid(supplier):
            return qs.none()
        name = Supplier.objects.filter(pk=supplier).values_list('name', flat=True).first()
        supplied = Exists(PurchaseInvoiceItem.objects.filter(
            product=OuterRef('pk'), purchase_invoice__supplier_id=supplier, purchase_invoice__is_deleted=False))
        qs = qs.filter(Q(supplied) | Q(supplier_name__iexact=name)) if name else qs.filter(supplied)
    group = (params.get('variant_group') or '').strip()
    if group == 'none':
        qs = qs.filter(variant_group__isnull=True)
    elif group == 'any':
        qs = qs.filter(variant_group__isnull=False)
    elif group:
        qs = qs.filter(variant_group_id=group) if _is_uuid(group) else qs.none()
    status_key = (params.get('status') or '').strip().lower()
    if status_key in STATUS_FILTERS:
        qs = qs.filter(STATUS_FILTERS[status_key])
    return qs


def apply_ordering(qs, params):
    raw = (params.get('ordering') or 'name').strip()
    desc = raw.startswith('-')
    field = ORDERING.get(raw.lstrip('-'), 'name')
    expr = F(field).desc(nulls_last=True) if desc else F(field).asc(nulls_last=True)
    return qs.order_by(expr, 'pk')


# ---------------------------------------------------------------------------------------------
# Row shape
# ---------------------------------------------------------------------------------------------
def _extra(product, *keys):
    data = product.extra_data if isinstance(product.extra_data, dict) else {}
    lowered = {str(k).lower(): v for k, v in data.items()}
    for key in keys:
        val = lowered.get(key)
        if val not in (None, ''):
            return val
    return None


def _money(value):
    if value in (None, ''):
        return None
    try:
        return str(Decimal(str(value)).quantize(Decimal('0.01')))
    except (InvalidOperation, ValueError):
        return None


def product_mrp(product):
    """MRP as the Product Master stores it: extra_data.mrp (what labels print), mirrored into
    wholesale_price (ProductMasterDialog / variant_service convention). None when unknown."""
    raw = _extra(product, 'mrp')
    if raw is not None:
        return _money(raw)
    return _money(product.wholesale_price) if product.wholesale_price else None


def stock_status(product):
    stock = int(product.stock or 0)
    if stock <= 0:
        return 'out'
    if stock <= int(product.minimum_stock or 0):
        return 'low'
    return 'in'


def serialize_row(p, caps):
    color = (p.color or '').strip() or str(_extra(p, 'color', 'colour') or '')
    size = (p.size or '').strip() or str(_extra(p, 'size', 'frame_size') or '')
    model_no = str(_extra(p, 'model_no', 'model', 'model_number') or '')
    variant_bits = [b for b in (model_no, p.frame_type, color, size) if b]
    unit = p.unit
    return {
        'id': str(p.pk),
        'sku': p.sku,
        'barcode': p.barcode or '',
        'secondary_barcode': p.secondary_barcode or '',
        'name': p.name,
        'brand': p.brand_name or '',
        'category': p.category_name or '',
        'model_no': model_no,
        'frame_type': p.frame_type or '',
        'color': color,
        'size': size,
        'variant': ' / '.join(variant_bits),
        'variant_group': str(p.variant_group_id) if p.variant_group_id else None,
        'variant_group_name': p.variant_group.name if p.variant_group_id and p.variant_group else '',
        'rack_location': p.rack_location or '',
        'bin_location': p.bin_location or '',
        'stock': int(p.stock or 0),
        'minimum_stock': int(p.minimum_stock or 0),
        'unit': str(unit.pk) if unit else None,
        'uom': (unit.code if unit else None) or str(_extra(p, 'uom', 'unit') or ''),
        'cost_price': _money(p.cost_price) if caps['view_cost'] else None,
        'retail_price': _money(p.retail_price),
        'mrp': product_mrp(p),
        'supplier_name': getattr(p, 'last_supplier_name', None) or p.supplier_name or '',
        'last_purchase_date': p.last_purchase_date.isoformat() if getattr(p, 'last_purchase_date', None) else None,
        'status': stock_status(p),
        'updated_at': p.updated_at.isoformat() if p.updated_at else None,
    }


# ---------------------------------------------------------------------------------------------
# Validation helpers
# ---------------------------------------------------------------------------------------------
class FieldErrors(Exception):
    def __init__(self, errors):
        super().__init__(errors)
        self.errors = errors


def _parse_money(value, field, errors):
    if value in (None, ''):
        return Decimal('0.00')
    try:
        d = Decimal(str(value).strip())
    except (InvalidOperation, ValueError):
        errors[field] = 'Enter a number.'
        return None
    if not d.is_finite():
        errors[field] = 'Enter a number.'
        return None
    if d < 0:
        errors[field] = 'Cannot be negative.'
        return None
    if d > MAX_PRICE:
        errors[field] = 'Too large.'
        return None
    return d.quantize(Decimal('0.01'))


def _parse_int(value, field, errors, *, minimum=0):
    if value in (None, ''):
        errors[field] = 'Required.'
        return None
    try:
        text = str(value).strip()
        d = Decimal(text)
        if d != d.to_integral_value():
            errors[field] = 'Enter a whole number.'
            return None
        n = int(d)
    except (InvalidOperation, ValueError):
        errors[field] = 'Enter a whole number.'
        return None
    if n < minimum:
        errors[field] = f'Cannot be less than {minimum}.'
        return None
    if n > MAX_QTY:
        errors[field] = 'Too large.'
        return None
    return n


def _current_value(product, field):
    """The field's value in the same shape serialize_row sends, for optimistic-lock checks."""
    if field == 'mrp':
        return product_mrp(product)
    if field in ('cost_price', 'retail_price'):
        return _money(getattr(product, field))
    if field == 'minimum_stock':
        return int(product.minimum_stock or 0)
    if field == 'unit':
        return str(product.unit_id) if product.unit_id else None
    return getattr(product, field) or ''


def _same(a, b, field):
    if field in PRICE_FIELDS:
        return (_money(a) or '0.00') == (_money(b) or '0.00')  # blank MRP == 0
    if field == 'minimum_stock':
        try:
            return int(a) == int(b)
        except (TypeError, ValueError):
            return False
    return (a or '') == (b or '')


def _next_adjustment_number():
    n = bump_sequence(StockAdjustmentSequence, {'prefix': 'ADJ'})
    return f"ADJ-{n:06d}"


def _resolve_branch_and_warehouse(request):
    from apps.common.branch_context import get_active_branch
    from apps.company.models import Branch, Warehouse
    branch = get_active_branch(request) or Branch.get_default()
    if branch is None:
        return None, None
    warehouse = Warehouse.objects.filter(branch=branch).order_by('created_at').first() \
        or Warehouse.objects.order_by('created_at').first()
    if warehouse is None:
        # StockLedger / StockAdjustment need a warehouse; seed the same default the
        # Multi-Branch migration creates rather than skip the audit row.
        code = 'WH-MAIN' if not Warehouse.all_objects.filter(code='WH-MAIN').exists() \
            else f"WH-{uuid.uuid4().hex[:6].upper()}"
        warehouse = Warehouse.objects.create(branch=branch, name='Main Warehouse', code=code)
    return branch, warehouse


# ---------------------------------------------------------------------------------------------
# History: ledger rows enriched with their source document in a fixed number of queries.
# ---------------------------------------------------------------------------------------------
HISTORY_TYPE_FILTERS = {
    'PURCHASE': lambda: Q(transaction_type='IN') & (
        Q(Exists(PurchaseInvoice.all_objects.filter(pk=OuterRef('reference_id'))))
        | Q(Exists(PurchaseOrder.all_objects.filter(pk=OuterRef('reference_id'))))),
    'SALE': lambda: Q(Exists(_sales_invoice_model().all_objects.filter(pk=OuterRef('reference_id')))),
    'ADJUSTMENT': lambda: Q(transaction_type__in=['ADJ_ADD', 'ADJ_SUB']),
    'TRANSFER': lambda: Q(transaction_type='TRANSFER'),
    'IN': lambda: Q(quantity__gt=0),
    'OUT': lambda: Q(quantity__lt=0),
}


def _sales_invoice_model():
    from apps.sales.models import Invoice
    return Invoice


def describe_ledger_rows(rows, product):
    refs = {r.reference_id for r in rows if r.reference_id}
    purchases = {p.pk: p for p in PurchaseInvoice.all_objects.filter(pk__in=refs).select_related('supplier')} if refs else {}
    orders = {o.pk: o for o in PurchaseOrder.all_objects.filter(pk__in=refs).select_related('supplier')} if refs else {}
    sales = {i.pk: i for i in _sales_invoice_model().all_objects.filter(pk__in=refs)} if refs else {}
    adjustments = {a.pk: a for a in StockAdjustment.all_objects.filter(pk__in=refs)} if refs else {}
    costs = {}
    if purchases:
        for inv_id, rate in (PurchaseInvoiceItem.all_objects
                             .filter(purchase_invoice_id__in=purchases, product=product)
                             .order_by('created_at').values_list('purchase_invoice_id', 'purchase_rate')):
            costs.setdefault(inv_id, rate)

    out = []
    for r in rows:
        qty = int(r.quantity or 0)
        kind, party, ref_no, remarks, cost = 'Movement', '', r.reference_number or '', r.notes or '', r.unit_cost
        before = (r.balance_after - qty) if r.balance_after is not None else None
        after = r.balance_after
        if r.reference_id in purchases:
            p = purchases[r.reference_id]
            kind, party, ref_no = 'Purchase Entry', p.supplier.name if p.supplier_id else '', ref_no or p.invoice_number
            cost = cost if cost is not None else costs.get(p.pk)
        elif r.reference_id in orders:
            o = orders[r.reference_id]
            kind, party, ref_no = 'Purchase Order Receipt', o.supplier.name if o.supplier_id else '', ref_no or o.order_number
        elif r.reference_id in sales:
            s = sales[r.reference_id]
            kind = 'Sale' if qty < 0 else 'Sale Edit / Returned to Stock'
            party, ref_no = s.customer_name or '', ref_no or s.invoice_number
        elif r.reference_id in adjustments:
            a = adjustments[r.reference_id]
            kind = 'Manual Adjustment'
            ref_no = ref_no or a.adjustment_number
            remarks = a.reason or remarks
            if a.reference:
                remarks = f"{remarks} (Ref: {a.reference})" if remarks else f"Ref: {a.reference}"
            if a.previous_quantity is not None and before is None:
                before, after = a.previous_quantity, a.new_quantity
        elif r.reference_id and r.reference_id == product.pk:
            kind = 'Opening Stock'
        elif r.transaction_type == 'TRANSFER':
            kind = 'Transfer'
        elif r.transaction_type in ('ADJ_ADD', 'ADJ_SUB'):
            kind = 'Adjustment'
        else:
            kind = 'Stock In' if qty >= 0 else 'Stock Out'
        out.append({
            'id': str(r.pk),
            'date': r.created_at.isoformat(),
            'transaction_type': r.transaction_type,
            'type_label': kind,
            'reference_number': ref_no,
            'party': party,
            'quantity_in': qty if qty > 0 else 0,
            'quantity_out': -qty if qty < 0 else 0,
            'previous_stock': before,
            'new_stock': after,
            'unit_cost': _money(cost),
            'performed_by': r.performed_by or (r.created_by.username if r.created_by_id and r.created_by else ''),
            'remarks': remarks,
            'branch': r.branch.name if r.branch_id and r.branch else '',
        })
    return out


class HistoryPagination(PageNumberPagination):
    page_size = 50
    page_size_query_param = 'page_size'
    max_page_size = 500


class StockOverviewPagination(PageNumberPagination):
    page_size = 50
    page_size_query_param = 'page_size'
    max_page_size = 500


# ---------------------------------------------------------------------------------------------
# ViewSet
# ---------------------------------------------------------------------------------------------
class StockOverviewViewSet(viewsets.GenericViewSet):
    permission_classes = [StockOverviewPermission]
    pagination_class = StockOverviewPagination

    def initial(self, request, *args, **kwargs):
        super().initial(request, *args, **kwargs)
        # Authenticated here, so the ledger rows this request writes carry the real user.
        self._actor_token = set_actor(actor_from_request(request))

    def finalize_response(self, request, response, *args, **kwargs):
        token = getattr(self, '_actor_token', None)
        if token is not None:
            reset_actor(token)
            self._actor_token = None
        return super().finalize_response(request, response, *args, **kwargs)

    def get_queryset(self):
        return base_queryset()

    def _caps(self):
        return capabilities(self.request.user)

    def _require(self, cap, message):
        if not self._caps()[cap]:
            raise PermissionDenied(message)

    def _get_product(self, pk, *, lock=False):
        if not _is_uuid(pk):
            raise NotFound('Product not found.')
        qs = Product.objects.filter(pk=pk, is_active=True)
        if lock:
            qs = qs.select_for_update()
        product = qs.first()
        if product is None:
            raise NotFound('Product not found.')
        return product

    def _row(self, pk):
        return serialize_row(base_queryset().get(pk=pk), self._caps())

    # -- list / summary / facets ---------------------------------------------------------------
    def list(self, request):
        qs = apply_ordering(apply_filters(self.get_queryset(), request.query_params), request.query_params)
        caps = self._caps()
        page = self.paginate_queryset(qs)
        return self.get_paginated_response([serialize_row(p, caps) for p in page])

    @action(detail=False, methods=['get'])
    def summary(self, request):
        qs = apply_filters(Product.objects.filter(is_active=True), request.query_params)
        positive = Q(stock__gt=0)
        money = DecimalField(max_digits=20, decimal_places=2)
        agg = qs.aggregate(
            total_products=Count('id'),
            total_quantity=Coalesce(Sum('stock', filter=positive), 0),
            low_stock=Count('id', filter=STATUS_FILTERS['low']),
            out_of_stock=Count('id', filter=STATUS_FILTERS['out']),
            purchase_value=Coalesce(Sum(ExpressionWrapper(F('stock') * F('cost_price'), output_field=money),
                                        filter=positive), Value(Decimal('0')), output_field=money),
            selling_value=Coalesce(Sum(ExpressionWrapper(F('stock') * F('retail_price'), output_field=money),
                                       filter=positive), Value(Decimal('0')), output_field=money),
        )
        caps = self._caps()
        return Response({
            'total_products': agg['total_products'],
            'total_quantity': int(agg['total_quantity'] or 0),
            'low_stock': agg['low_stock'],
            'out_of_stock': agg['out_of_stock'],
            'purchase_value': _money(agg['purchase_value']) if caps['view_cost'] else None,
            'selling_value': _money(agg['selling_value']),
            'generated_at': timezone.now().isoformat(),
        })

    @action(detail=False, methods=['get'])
    def facets(self, request):
        from apps.masters.models import Unit
        active = Product.objects.filter(is_active=True)

        def distinct(field):
            return sorted({v.strip() for v in active.exclude(**{f'{field}__isnull': True})
                           .exclude(**{field: ''}).values_list(field, flat=True).distinct()[:2000]
                           if v and v.strip()}, key=str.lower)

        groups = (ProductVariantGroup.objects.filter(variants__is_active=True, variants__is_deleted=False)
                  .annotate(n=Count('variants')).order_by('name').values('id', 'name', 'n')[:1000])
        return Response({
            'brands': distinct('brand_name'),
            'categories': distinct('category_name'),
            'racks': distinct('rack_location'),
            'suppliers': [{'id': str(s['id']), 'name': s['name']}
                          for s in Supplier.objects.order_by('name').values('id', 'name')[:2000]],
            'variant_groups': [{'id': str(g['id']), 'name': g['name'], 'count': g['n']} for g in groups],
            'units': [{'id': str(u['id']), 'code': u['code'], 'name': u['name']}
                      for u in Unit.objects.order_by('code').values('id', 'code', 'name')],
            'adjustment_reasons': ['Physical stock count', 'Damaged / broken', 'Lost / theft',
                                   'Found during audit', 'Opening stock correction', 'Expired', 'Other'],
            'permissions': self._caps(),
        })

    @action(detail=False, methods=['get'])
    def lookup(self, request):
        code = (request.query_params.get('code') or '').strip()
        if not code:
            return Response({'found': False, 'results': []})
        caps = self._caps()
        rows = [serialize_row(p, caps) for p in base_queryset().filter(_code_q(code)).order_by('name')[:5]]
        return Response({'found': bool(rows), 'results': rows})

    # -- export ---------------------------------------------------------------------------------
    EXPORT_COLUMNS = [
        ('sku', 'Item Code / SKU'), ('barcode', 'Barcode 1'), ('secondary_barcode', 'Barcode 2'),
        ('name', 'Product Name'), ('brand', 'Brand'), ('category', 'Category'), ('variant', 'Model / Variant'),
        ('color', 'Colour'), ('size', 'Size'), ('rack_location', 'Rack'), ('bin_location', 'Shelf / Bin'),
        ('stock', 'Current Stock'), ('minimum_stock', 'Minimum Stock'), ('uom', 'UOM'),
        ('status_label', 'Stock Status'), ('cost_price', 'Purchase Cost'), ('retail_price', 'Selling Price'),
        ('mrp', 'MRP'), ('supplier_name', 'Supplier'), ('last_purchase_date', 'Last Purchase Date'),
    ]
    STATUS_LABELS = {'in': 'In Stock', 'low': 'Low Stock', 'out': 'Out of Stock'}

    @action(detail=False, methods=['get'])
    def export(self, request):
        self._require('export', 'Your role cannot export stock data.')
        fmt = (request.query_params.get('export_format') or 'xlsx').lower()
        caps = self._caps()
        columns = [c for c in self.EXPORT_COLUMNS if c[0] != 'cost_price' or caps['view_cost']]
        qs = apply_ordering(apply_filters(self.get_queryset(), request.query_params), request.query_params)
        stamp = timezone.localtime().strftime('%Y%m%d-%H%M')

        def rows():
            for p in qs[:EXPORT_ROW_LIMIT].iterator(chunk_size=2000):
                r = serialize_row(p, caps)
                r['status_label'] = self.STATUS_LABELS[r['status']]
                yield [r.get(key) for key, _ in columns]

        if fmt == 'csv':
            buf = io.StringIO()
            buf.write('﻿')  # Excel opens UTF-8 CSV correctly with a BOM
            writer = csv.writer(buf)
            writer.writerow([label for _, label in columns])
            for row in rows():
                writer.writerow(['' if v is None else v for v in row])
            resp = HttpResponse(buf.getvalue(), content_type='text/csv; charset=utf-8')
            resp['Content-Disposition'] = f'attachment; filename="stock-overview-{stamp}.csv"'
            return resp

        from openpyxl import Workbook
        wb = Workbook(write_only=True)
        ws = wb.create_sheet('Stock Overview')
        ws.append([label for _, label in columns])
        numeric = {'stock', 'minimum_stock', 'cost_price', 'retail_price', 'mrp'}
        keys = [k for k, _ in columns]
        for row in rows():
            ws.append([
                (float(v) if k in ('cost_price', 'retail_price', 'mrp') else v) if (k in numeric and v not in (None, ''))
                else ('' if v is None else v)
                for k, v in zip(keys, row)
            ])
        out = io.BytesIO()
        wb.save(out)
        resp = HttpResponse(out.getvalue(),
                            content_type='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        resp['Content-Disposition'] = f'attachment; filename="stock-overview-{stamp}.xlsx"'
        return resp

    # -- field edits (never quantity) -----------------------------------------------------------
    def partial_update(self, request, pk=None):
        changes = request.data.get('changes')
        original = request.data.get('original') or {}
        if not isinstance(changes, dict) or not changes:
            return Response({'detail': 'Nothing to update.'}, status=status.HTTP_400_BAD_REQUEST)
        if 'stock' in changes or 'quantity' in changes:
            return Response({'detail': 'Stock quantity is changed with a stock adjustment, not a field edit.'},
                            status=status.HTTP_400_BAD_REQUEST)
        unknown = set(changes) - EDITABLE_FIELDS
        if unknown:
            return Response({'detail': f"These fields can't be edited here: {', '.join(sorted(unknown))}."},
                            status=status.HTTP_400_BAD_REQUEST)
        caps = self._caps()
        if set(changes) & PRICE_FIELDS and not caps['edit_prices']:
            raise PermissionDenied('Your role cannot change prices.')
        if 'cost_price' in changes and not caps['view_cost']:
            raise PermissionDenied('Your role cannot change the purchase cost.')
        if set(changes) & LOCATION_FIELDS and not caps['edit_location']:
            raise PermissionDenied('Your role cannot change stock levels or locations.')

        errors, clean = {}, {}
        for field, value in changes.items():
            if field in PRICE_FIELDS:
                clean[field] = _parse_money(value, field, errors)
            elif field == 'minimum_stock':
                clean[field] = _parse_int(value, field, errors)
            elif field in ('rack_location', 'bin_location'):
                text = '' if value is None else str(value).strip()
                if len(text) > 150:
                    errors[field] = 'At most 150 characters.'
                clean[field] = text or None
            elif field == 'unit':
                if value in (None, ''):
                    clean[field] = None
                else:
                    from apps.masters.models import Unit
                    unit = Unit.objects.filter(pk=value).first() if _is_uuid(value) else None
                    if unit is None:
                        errors[field] = 'Pick a unit from the Unit master.'
                    clean[field] = unit
        if errors:
            return Response({'detail': 'Please correct the highlighted values.', 'errors': errors},
                            status=status.HTTP_400_BAD_REQUEST)

        with transaction.atomic():
            product = self._get_product(pk, lock=True)
            # Optimistic lock per field: refuse only when someone changed a field this edit also
            # touches since the user loaded it — a sale moving stock meanwhile is no conflict.
            conflicts = {f: _current_value(product, f) for f in clean
                         if f in original and not _same(original.get(f), _current_value(product, f), f)}
            if conflicts:
                return Response({
                    'detail': 'Someone else changed this product while you were editing. Review the latest values and try again.',
                    'conflicts': conflicts, 'row': self._row(product.pk),
                }, status=status.HTTP_409_CONFLICT)

            # Same rule as Add Multiple Items (variant_service), checked only when this edit
            # touches a price so legacy rows don't block a rack or minimum-stock change.
            retail = clean.get('retail_price', product.retail_price)
            mrp = clean['mrp'] if 'mrp' in clean else Decimal(product_mrp(product) or '0')
            if ({'retail_price', 'mrp'} & set(clean)) and mrp and retail and retail > mrp:
                return Response({'detail': 'Selling price cannot be more than the MRP.',
                                 'errors': {'retail_price': 'More than MRP.'}}, status=status.HTTP_400_BAD_REQUEST)

            fields = ['updated_at']
            for field, value in clean.items():
                if field == 'mrp':
                    product.wholesale_price = value
                    extra = dict(product.extra_data) if isinstance(product.extra_data, dict) else {}
                    extra['mrp'] = float(value)
                    product.extra_data = extra
                    fields += ['wholesale_price', 'extra_data']
                elif field == 'unit':
                    product.unit = value
                    fields.append('unit')
                else:
                    setattr(product, field, value)
                    fields.append(field)
            if request.user and request.user.is_authenticated:
                product.updated_by = request.user
                fields.append('updated_by')
            product.save(update_fields=list(dict.fromkeys(fields)))
        return Response(self._row(product.pk))

    # -- quantity adjustment --------------------------------------------------------------------
    @action(detail=True, methods=['post'])
    def adjust(self, request, pk=None):
        self._require('adjust_stock', 'Your role cannot adjust stock.')
        data = request.data
        errors = {}
        new_qty = _parse_int(data.get('new_quantity'), 'new_quantity', errors, minimum=0)
        expected = data.get('expected_stock')
        expected = _parse_int(expected, 'expected_stock', errors, minimum=-MAX_QTY) if expected not in (None, '') else None
        reason = str(data.get('reason') or '').strip()
        if not reason:
            errors['reason'] = 'Give a reason for the adjustment.'
        elif len(reason) > 500:
            errors['reason'] = 'At most 500 characters.'
        reference = str(data.get('reference') or '').strip()
        if len(reference) > 100:
            errors['reference'] = 'At most 100 characters.'
        token = str(data.get('client_token') or '').strip()[:64] or None
        if errors:
            return Response({'detail': 'Please correct the highlighted values.', 'errors': errors},
                            status=status.HTTP_400_BAD_REQUEST)

        # Retried submit (double click, network retry): answer with what the first one did.
        if token:
            done = StockAdjustment.all_objects.filter(client_token=token).first()
            if done is not None:
                if str(done.product_id) != str(pk):
                    return Response({'detail': 'This request token was already used for another product.'},
                                    status=status.HTTP_409_CONFLICT)
                return Response({'adjustment': _adjustment_json(done), 'row': self._row(done.product_id),
                                 'replayed': True})

        branch, warehouse = _resolve_branch_and_warehouse(request)
        if warehouse is None:
            return Response({'detail': 'Set up a branch first (Settings → Company): stock adjustments are '
                                       'recorded against a branch warehouse.'},
                            status=status.HTTP_400_BAD_REQUEST)

        with transaction.atomic():
            # Lock the product's per-branch stock rows BEFORE reading Product.stock: sales and
            # purchases (adjust_branch_stock_many) lock BranchStock then update Product, so taking
            # the same order here means a concurrent bill waits instead of deadlocking, and the
            # figure read below can't move before this adjustment is written.
            from apps.company.models import BranchStock
            if _is_uuid(pk):
                list(BranchStock.all_objects.select_for_update().filter(product_id=pk).values_list('pk', flat=True))
            product = self._get_product(pk)
            current = int(product.stock or 0)
            if expected is not None and expected != current:
                return Response({
                    'detail': f'Stock changed to {current} while you were editing (a sale, purchase or '
                              f'another user). Check the new figure and enter the count again.',
                    'current_stock': current, 'row': self._row(product.pk),
                }, status=status.HTTP_409_CONFLICT)
            delta = new_qty - current
            if delta == 0:
                return Response({'detail': 'The quantity is unchanged — nothing to adjust.'},
                                status=status.HTTP_400_BAD_REQUEST)
            actor = actor_from_request(request) or get_actor()
            adj = StockAdjustment.objects.create(
                product=product, warehouse=warehouse, branch=branch,
                quantity=abs(delta), adjustment_type='ADD' if delta > 0 else 'SUB',
                reason=reason, reference=reference, adjustment_number=_next_adjustment_number(),
                previous_quantity=current, new_quantity=new_qty, performed_by=actor, client_token=token,
                created_by=request.user if request.user.is_authenticated else None,
            )
            adjust_branch_stock(product, branch, delta, ledger={
                'warehouse': warehouse,
                'transaction_type': 'ADJ_ADD' if delta > 0 else 'ADJ_SUB',
                'reference_id': adj.id,
                'reference_number': adj.adjustment_number,
                'notes': reason,
                'performed_by': actor,
                'unit_cost': product.cost_price,
            })
            product.refresh_from_db(fields=['stock'])
            if product.stock != new_qty:
                # Product.stock is the sum over branches; another branch's figure moved under us.
                # Undo the whole transaction rather than record an adjustment that doesn't add up.
                transaction.set_rollback(True)
                return Response({'detail': "This product's stock total is out of step with its per-branch stock, "
                                           'so the count could not be applied safely. Nothing was changed.'},
                                status=status.HTTP_409_CONFLICT)
        return Response({'adjustment': _adjustment_json(adj), 'row': self._row(product.pk)},
                        status=status.HTTP_201_CREATED)

    # -- history --------------------------------------------------------------------------------
    @action(detail=True, methods=['get'])
    def history(self, request, pk=None):
        self._require('view_history', 'Your role cannot view stock history.')
        product = self._get_product(pk)
        params = request.query_params
        qs = StockLedger.objects.filter(product=product).select_related('branch', 'created_by')
        date_from, date_to = parse_date(params.get('date_from') or ''), parse_date(params.get('date_to') or '')
        if date_from:
            qs = qs.filter(created_at__date__gte=date_from)
        if date_to:
            qs = qs.filter(created_at__date__lte=date_to)
        kind = (params.get('type') or '').upper()
        if kind in HISTORY_TYPE_FILTERS:
            qs = qs.filter(HISTORY_TYPE_FILTERS[kind]())
        ref = (params.get('reference') or '').strip()
        if ref:
            qs = qs.filter(Q(reference_number__icontains=ref) | Q(notes__icontains=ref))
        qs = qs.order_by('-created_at', '-pk')
        paginator = HistoryPagination()
        page = paginator.paginate_queryset(qs, request, view=self)
        resp = paginator.get_paginated_response(describe_ledger_rows(page, product))
        resp.data['product'] = serialize_row(base_queryset().get(pk=product.pk), self._caps())
        return resp


def _adjustment_json(adj):
    return {
        'id': str(adj.pk), 'adjustment_number': adj.adjustment_number,
        'previous_quantity': adj.previous_quantity, 'new_quantity': adj.new_quantity,
        'difference': (adj.new_quantity or 0) - (adj.previous_quantity or 0),
        'reason': adj.reason, 'reference': adj.reference, 'performed_by': adj.performed_by,
        'created_at': adj.created_at.isoformat(),
    }
