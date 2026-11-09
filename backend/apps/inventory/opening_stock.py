"""Inventory → Opening Stock API: the legacy stock a newly onboarded shop brings in.

  GET  /api/inventory/opening-stock/            recent Opening Stock batches
  POST /api/inventory/opening-stock/parse/      multipart `file` (.xlsx/.xls/.csv) → sheets, headers,
                                                raw rows and a suggested column mapping (nothing saved)
  POST /api/inventory/opening-stock/validate/   {rows, auto_barcode} → per-row errors / duplicate warnings
  POST /api/inventory/opening-stock/manual/     {rows, auto_barcode, client_token}            → batch
  POST /api/inventory/opening-stock/import/     {rows, auto_barcode, client_token, file_name} → batch

A row is {name, barcode, category, brand, quantity, cost_price, mrp} (+ row_number for messages).
Every saved row becomes a NEW lightweight Product tagged stock_source=OPENING_STOCK — an existing
product's stock is never touched here (that is a Stock Overview adjustment), so a barcode that
already belongs to a product is a duplicate the user must leave out. The whole save is one
transaction: OpeningStockBatch (OS-000001) + products + BranchStock + one StockLedger 'IN' row per
product (source_type OPENING_STOCK, reference = the batch), in a fixed handful of queries however
many rows there are. The batch's cost total is booked once by the accounting engine
(inventory.opening_stock: Dr Inventory / Cr Opening balance equity).
"""
import os
import tempfile
from decimal import Decimal

from django.db import IntegrityError, transaction
from django.db.models import OuterRef, Q, Subquery
from django.db.models.functions import Lower
from rest_framework import status, viewsets
from rest_framework.decorators import action
from rest_framework.parsers import FormParser, JSONParser, MultiPartParser
from rest_framework.response import Response

from apps.common.request_actor import actor_from_request, get_actor
from apps.common.sequences import bump_sequence
from apps.products.barcode_utils import reserve_product_barcodes
from apps.products.models import BarcodeHistory, Product

from .models import OpeningStockBatch, StockAdjustmentSequence, StockLedger
from .stock_overview import (
    RequestActorMixin, StockOverviewPermission, _money, _parse_int, _parse_money, _resolve_branch_and_warehouse,
    capabilities,
)
from .stock_utils import adjust_branch_stock_many

MAX_ROWS = 5000            # one save
MAX_PARSE_ROWS = MAX_ROWS   # one uploaded file, across its sheets
MAX_FILE_BYTES = 15 * 1024 * 1024
FIELDS = ('name', 'barcode', 'category', 'brand', 'quantity', 'cost_price', 'mrp')
TEXT_MAX = {'name': 255, 'barcode': 150, 'category': 150, 'brand': 150}
METHOD_NOTES = {'MANUAL': 'Opening stock (manual entry)', 'IMPORT': 'Opening stock (Excel import)'}

# Header → field suggestions for the column mapper; the user confirms or changes every one.
HEADER_ALIASES = {
    'name': ['item name', 'product name', 'item', 'product', 'name', 'description', 'particulars', 'item description'],
    'barcode': ['barcode', 'bar code', 'ean', 'upc', 'item code', 'product code', 'code', 'sku'],
    'category': ['category', 'group', 'item group', 'type'],
    'brand': ['brand', 'make', 'company', 'manufacturer'],
    'quantity': ['qty', 'quantity', 'opening stock', 'opening qty', 'stock', 'closing stock', 'balance', 'qty on hand'],
    'cost_price': ['cost price', 'cost', 'purchase price', 'purchase rate', 'cp', 'landing cost', 'buying price', 'rate'],
    'mrp': ['mrp', 'sales price', 'selling price', 'sale price', 'sp', 'retail price', 'price'],
}


class RowsInvalid(Exception):
    def __init__(self, results):
        super().__init__('rows invalid')
        self.results = results


def _text(value, field, errors):
    text = str(value if value is not None else '').replace('\x00', '').strip()
    if len(text) > TEXT_MAX[field]:
        errors[field] = f'At most {TEXT_MAX[field]} characters.'
    return text


def _number_text(value):
    """'1,250' / '₹ 1,250.00' as typed or exported → '1250.00'."""
    return str(value if value is not None else '').replace(',', '').replace('₹', '').strip()


def check_rows(raw_rows):
    """Cleans and checks every row. Returns (clean, results): results[i] =
    {index, row_number, status: ok|warning|duplicate|error, duplicate, errors{field: msg}, warnings[...]}.
    Only 'error' rows cannot be saved — a barcode clash is an error (with duplicate=True). 'duplicate'
    is the softer case of the same item appearing twice without a barcode: savable, but the preview
    leaves it unticked."""
    clean, results = [], []
    for i, raw in enumerate(raw_rows):
        raw = raw if isinstance(raw, dict) else {}
        errors, warnings = {}, []
        row = {f: _text(raw.get(f), f, errors) for f in ('name', 'barcode', 'category', 'brand')}
        if not row['name']:
            errors['name'] = 'Item name is required.'
        row['quantity'] = _parse_int(_number_text(raw.get('quantity')), 'quantity', errors, minimum=1)
        cost = _number_text(raw.get('cost_price'))
        if cost == '':
            errors['cost_price'] = 'Cost price is required.'
            row['cost_price'] = None
        else:
            row['cost_price'] = _parse_money(cost, 'cost_price', errors)
        mrp = _number_text(raw.get('mrp'))
        row['mrp'] = _parse_money(mrp, 'mrp', errors) if mrp else None
        if row['mrp'] is not None and row['cost_price'] is not None and row['mrp'] and row['mrp'] < row['cost_price']:
            warnings.append('MRP is below the cost price.')
        clean.append(row)
        results.append({'index': i, 'row_number': raw.get('row_number') or i + 1, 'errors': errors,
                        'warnings': warnings, 'duplicate': False})

    # Barcodes: unique inside the file, and not already scanning as some product.
    first_with = {}
    for row, res in zip(clean, results):
        code = row['barcode']
        if not code or 'barcode' in res['errors']:
            continue
        key = code.lower()
        if key in first_with:
            res['errors']['barcode'] = f"Same barcode as row {first_with[key]['row_number']}."
            res['duplicate'] = True
        else:
            first_with[key] = res
    codes = [r['barcode'] for r in clean if r['barcode']]
    if codes:
        owners = _barcode_owners(codes)
        for row, res in zip(clean, results):
            owner = owners.get(row['barcode'])
            if owner and 'barcode' not in res['errors']:
                res['errors']['barcode'] = (f"Barcode already belongs to {owner['name']} ({owner['sku']})"
                                            + (' — an archived product' if owner['archived'] else '') + '.')
                res['duplicate'] = True

    # No barcode to tell them apart: the same item twice in the sheet, or an item already in products.
    seen = {}
    for row, res in zip(clean, results):
        if not row['name']:
            continue
        key = (row['name'].lower(), row['brand'].lower(), row['category'].lower(), row['barcode'].lower())
        if key in seen:
            res['warnings'].append(f"Same item as row {seen[key]['row_number']}.")
            res['duplicate'] = True
        else:
            seen[key] = res
    names = {r['name'].lower() for r in clean if r['name'] and not r['barcode']}
    if names:
        existing = {}
        for chunk in _chunks(sorted(names), 500):
            for name, sku in (Product.objects.annotate(l=Lower('name')).filter(l__in=chunk, is_active=True)
                              .values_list('l', 'sku')):
                existing.setdefault(name, sku)
        for row, res in zip(clean, results):
            sku = existing.get(row['name'].lower()) if not row['barcode'] else None
            if sku:
                res['warnings'].append(f'A product with this name already exists ({sku}); this adds a new one.')

    for res in results:
        res['status'] = ('error' if res['errors'] else 'duplicate' if res['duplicate']
                         else 'warning' if res['warnings'] else 'ok')
    return clean, results


def _chunks(items, size):
    for i in range(0, len(items), size):
        yield items[i:i + size]


def _barcode_owners(codes):
    """code → {name, sku, archived} for every code some product already scans as."""
    from apps.products.models import ProductBarcode
    owners = {}
    for chunk in _chunks(list(set(codes)), 500):
        for p in Product.all_objects.filter(Q(barcode__in=chunk) | Q(secondary_barcode__in=chunk)).only(
                'name', 'sku', 'barcode', 'secondary_barcode', 'is_deleted', 'is_active'):
            info = {'name': p.name, 'sku': p.sku, 'archived': p.is_deleted or not p.is_active}
            for code in (p.barcode, p.secondary_barcode):
                if code in chunk:
                    owners.setdefault(code, info)
        for pb in ProductBarcode.objects.filter(code__in=chunk).select_related('product'):
            owners.setdefault(pb.code, {'name': pb.product.name, 'sku': pb.product.sku, 'archived': False})
    return owners


def _masters(model, names):
    names = {n.lower() for n in names if n}
    if not names:
        return {}
    return {m.l: m for m in model.objects.annotate(l=Lower('name')).filter(l__in=names)}


def save_opening_stock(raw_rows, *, method, request, auto_barcode=False, file_name='', token=None):
    """Writes the rows as one OpeningStockBatch. Raises RowsInvalid when any row can't be saved."""
    from apps.masters.models import Brand, ProductCategory
    from apps.products.variant_service import _assign_skus

    if token:
        done = OpeningStockBatch.objects.filter(client_token=token).first()
        if done is not None:
            return done, True

    clean, results = check_rows(raw_rows)
    if any(r['status'] == 'error' for r in results):
        raise RowsInvalid(results)

    branch, warehouse = _resolve_branch_and_warehouse(request)
    if warehouse is None:
        raise ValueError('Set up a branch first (Settings → Company): opening stock is recorded '
                         'against a branch warehouse.')

    user = request.user if getattr(request.user, 'is_authenticated', False) else None
    actor = (actor_from_request(request) or get_actor() or '')[:150]
    for row in clean:
        row.update(sku='', attributes={})
    _assign_skus({'base_sku': '', 'name': ''}, clean, grouped=False)
    categories = _masters(ProductCategory, {r['category'] for r in clean})
    brands = _masters(Brand, {r['brand'] for r in clean})

    with transaction.atomic():
        missing = [r for r in clean if not r['barcode']]
        if auto_barcode and missing:
            avoid = {r['barcode'] for r in clean if r['barcode']}
            for row, code in zip(missing, reserve_product_barcodes(count=len(missing), avoid=avoid)):
                row['barcode'] = code
        total_value = sum((r['cost_price'] * r['quantity'] for r in clean), Decimal('0')).quantize(Decimal('0.01'))
        number = bump_sequence(StockAdjustmentSequence, {'prefix': 'OS'})
        batch = OpeningStockBatch.objects.create(
            batch_number=f'OS-{number:06d}', method=method, file_name=(file_name or '')[:255], branch=branch,
            product_count=len(clean), total_quantity=sum(r['quantity'] for r in clean), total_value=total_value,
            performed_by=actor, client_token=token, created_by=user,
        )
        products = []
        for r in clean:
            category = categories.get(r['category'].lower()) if r['category'] else None
            brand = brands.get(r['brand'].lower()) if r['brand'] else None
            mrp = r['mrp'] or Decimal('0')
            products.append(Product(
                name=r['name'], sku=r['sku'], barcode=r['barcode'] or None,
                category=category, category_name=(category.name if category else r['category']) or None,
                brand=brand, brand_name=(brand.name if brand else r['brand']) or None,
                cost_price=r['cost_price'], retail_price=mrp, wholesale_price=mrp,
                extra_data={'mrp': float(mrp)} if r['mrp'] else {},
                opening_stock=r['quantity'], stock=0, stock_source='OPENING_STOCK', created_by=user,
            ))
        Product.objects.bulk_create(products, batch_size=500)
        adjust_branch_stock_many({p: p.opening_stock for p in products}, branch, ledger={
            'warehouse': warehouse, 'transaction_type': 'IN', 'reference_id': batch.id,
            'reference_number': batch.batch_number, 'notes': METHOD_NOTES[method],
            'performed_by': actor, 'source_type': 'OPENING_STOCK',
        })
        # The ledger dict is shared by every row; each row's unit cost is its own product's.
        StockLedger.objects.filter(reference_id=batch.id).update(unit_cost=Subquery(
            Product.objects.filter(pk=OuterRef('product_id')).values('cost_price')[:1]))
        BarcodeHistory.objects.bulk_create([
            BarcodeHistory(product=p, old_barcode=None, new_barcode=p.barcode, changed_by=actor or 'Administrator',
                           reason=f'Created with opening stock {batch.batch_number}')
            for p in products if p.barcode
        ])
    return batch, False


def batch_json(batch, caps):
    return {
        'id': str(batch.pk), 'batch_number': batch.batch_number, 'method': batch.method,
        'method_label': batch.get_method_display(), 'file_name': batch.file_name,
        'product_count': batch.product_count, 'total_quantity': batch.total_quantity,
        **({'total_value': _money(batch.total_value)} if caps['view_cost'] else {}),
        'performed_by': batch.performed_by, 'created_at': batch.created_at.isoformat(),
    }


# ---------------------------------------------------------------------------------------------
# Excel parsing: the sheet as it is, for the column mapper. Nothing is interpreted beyond
# finding the header row and suggesting which column is which.
# ---------------------------------------------------------------------------------------------
def parse_sheet_file(path, ext):
    import itertools
    from apps.products.import_engine import (
        HEADER_SCAN_ROWS, _find_header_row, _iter_raw_sheets, _unique_headers, resolve_field_headers,
    )
    sheets, budget = [], MAX_PARSE_ROWS
    for name, raw in _iter_raw_sheets(path, ext):
        head = list(itertools.islice(raw, HEADER_SCAN_ROWS))
        header_idx = _find_header_row(head, HEADER_ALIASES)
        if header_idx is None:
            header_idx = next((i for i, cells in enumerate(head) if any(cells)), None)
        if header_idx is None:
            continue  # an empty sheet
        headers = _unique_headers(head[header_idx])
        if not headers:
            continue
        found = resolve_field_headers(headers, HEADER_ALIASES)
        rows, truncated = [], False
        for row_no, cells in enumerate(itertools.chain(head[header_idx + 1:], raw), start=header_idx + 2):
            cells = [(cells[i] if i < len(cells) else '') for i in range(len(headers))]
            if not any(cells) or cells == head[header_idx][:len(headers)]:
                continue  # blank line, or the header repeated at a page break
            if budget <= 0:
                truncated = True
                break
            rows.append({'row_number': row_no, 'cells': cells})
            budget -= 1
        sheets.append({
            'name': name, 'header_row': header_idx + 1, 'headers': headers, 'rows': rows, 'truncated': truncated,
            'suggested_mapping': {field: headers.index(h) for field, h in found.items()},
        })
    return sheets


class OpeningStockViewSet(RequestActorMixin, viewsets.GenericViewSet):
    permission_classes = [StockOverviewPermission]
    parser_classes = [JSONParser, MultiPartParser, FormParser]

    def _caps(self):
        return capabilities(self.request.user)

    def _forbidden(self):
        if not self._caps()['adjust_stock']:
            return Response({'detail': 'Your role cannot add opening stock.'}, status=status.HTTP_403_FORBIDDEN)
        return None

    def _rows(self):
        rows = self.request.data.get('rows')
        if not isinstance(rows, list) or not rows:
            return None, Response({'detail': 'Add at least one item.'}, status=status.HTTP_400_BAD_REQUEST)
        if len(rows) > MAX_ROWS:
            return None, Response({'detail': f'At most {MAX_ROWS} items per save — split the sheet.'},
                                  status=status.HTTP_400_BAD_REQUEST)
        return rows, None

    def list(self, request):
        caps = self._caps()
        return Response([batch_json(b, caps) for b in OpeningStockBatch.objects.order_by('-created_at')[:30]])

    @action(detail=False, methods=['post'])
    def parse(self, request):
        from apps.products.import_engine import detect_ext
        denied = self._forbidden()
        if denied:
            return denied
        upload = request.FILES.get('file')
        if upload is None:
            return Response({'detail': 'Choose an Excel or CSV file.'}, status=status.HTTP_400_BAD_REQUEST)
        ext = detect_ext(upload.name)
        if ext is None:
            return Response({'detail': 'Only .xlsx, .xls or .csv files can be read.'}, status=status.HTTP_400_BAD_REQUEST)
        if upload.size > MAX_FILE_BYTES:
            return Response({'detail': 'The file is larger than 15 MB.'}, status=status.HTTP_400_BAD_REQUEST)
        fd, path = tempfile.mkstemp(suffix=f'.{ext}')
        try:
            with os.fdopen(fd, 'wb') as out:
                for chunk in upload.chunks():
                    out.write(chunk)
            sheets = parse_sheet_file(path, ext)
        except Exception:  # noqa: BLE001 — any unreadable workbook is the same answer to the user
            return Response({'detail': 'This file could not be read as a spreadsheet.'},
                            status=status.HTTP_400_BAD_REQUEST)
        finally:
            try:
                os.remove(path)
            except OSError:
                pass
        if not sheets:
            return Response({'detail': 'No rows found in this file.'}, status=status.HTTP_400_BAD_REQUEST)
        return Response({'file_name': upload.name, 'sheets': sheets})

    @action(detail=False, methods=['post'])
    def validate(self, request):
        denied = self._forbidden()
        if denied:
            return denied
        rows, err = self._rows()
        if err:
            return err
        _clean, results = check_rows(rows)
        return Response({'results': results, 'summary': _summary(results)})

    @action(detail=False, methods=['post'])
    def manual(self, request):
        return self._save('MANUAL')

    @action(detail=False, methods=['post'], url_path='import')
    def import_rows(self, request):
        return self._save('IMPORT')

    def _save(self, method):
        denied = self._forbidden()
        if denied:
            return denied
        rows, err = self._rows()
        if err:
            return err
        data = self.request.data
        try:
            batch, replayed = save_opening_stock(
                rows, method=method, request=self.request, auto_barcode=bool(data.get('auto_barcode')),
                file_name=str(data.get('file_name') or ''), token=str(data.get('client_token') or '').strip()[:64] or None)
        except RowsInvalid as exc:
            bad = [r for r in exc.results if r['status'] == 'error']
            return Response({'detail': f'{len(bad)} item(s) need attention before saving.',
                             'results': exc.results, 'summary': _summary(exc.results)},
                            status=status.HTTP_400_BAD_REQUEST)
        except ValueError as exc:
            return Response({'detail': str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        except IntegrityError:
            return Response({'detail': 'Another save took one of these codes at the same time. '
                                       'Check the items and save again.'}, status=status.HTTP_409_CONFLICT)
        return Response({'batch': batch_json(batch, self._caps()), 'replayed': replayed},
                        status=status.HTTP_200_OK if replayed else status.HTTP_201_CREATED)


def _summary(results):
    counts = {'total': len(results), 'ok': 0, 'warning': 0, 'duplicate': 0, 'error': 0}
    for r in results:
        counts[r['status']] += 1
    counts['valid'] = counts['total'] - counts['error']
    return counts
