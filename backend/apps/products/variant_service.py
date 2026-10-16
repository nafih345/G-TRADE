"""Bulk create / update of product variants (Add Multiple Items / Product Variant Master).

A variant is an ordinary Product row linked to a ProductVariantGroup, so this module only
decides *which* Product rows to write and validates them; stock, sales, purchases and barcode
printing keep using Product exactly as before.

save_variants() is the single entry point used by both Inventory → Products and
Purchase → Purchase Entry. It validates every row first (all-or-nothing): a payload with any
row error writes nothing and returns the errors keyed by row index, so the grid can show them
on the offending row.
"""
import re
from decimal import Decimal, InvalidOperation

from django.db import IntegrityError, transaction
from django.db.models import Q

from .barcode_utils import reserve_product_barcodes
from .models import (
    BarcodeHistory, BulkSaveReceipt, Product, ProductBarcode, ProductVariantGroup,
)

# Attributes that also have a real Product column. Everything else lives only in
# Product.variant_attributes (and is mirrored into extra_data for the legacy screens).
COLUMN_ATTRS = {'color': 'color', 'size': 'size'}
ATTR_ALIASES = {'colour': 'color'}

MAX_ROWS_PER_REQUEST = 5000

CONTEXT_INVENTORY = 'inventory'
CONTEXT_PURCHASE = 'purchase'


class VariantValidationError(Exception):
    def __init__(self, detail, row_errors=None, group_errors=None, status=400):
        super().__init__(detail)
        self.detail = detail
        self.row_errors = row_errors or {}
        self.group_errors = group_errors or {}
        self.status = status

    def as_dict(self):
        return {'detail': self.detail, 'row_errors': self.row_errors, 'group_errors': self.group_errors}


# ---------------------------------------------------------------------------
# Pure helpers (mirrored by frontend/src/components/inventory/variants/variantUtils.js)
# ---------------------------------------------------------------------------

def _clean(value, max_len=None):
    if value is None:
        return ''
    text = str(value).strip()
    return text[:max_len] if max_len else text


def normalise_attributes(attrs):
    """Lower-case keys (with aliases), trimmed string values, empties dropped."""
    out = {}
    for key, val in (attrs or {}).items():
        k = _clean(key).lower().replace(' ', '_')
        k = ATTR_ALIASES.get(k, k)
        v = _clean(val, 100)
        if k and v:
            out[k] = v
    return out


def variant_key(attrs):
    """Order-independent, case-insensitive identity of an attribute combination."""
    norm = normalise_attributes(attrs)
    if not norm:
        return '__base__'
    return '|'.join(f"{k}={norm[k].lower()}" for k in sorted(norm))[:255]


def attr_code(value):
    """Short SKU fragment for an attribute value: Black → BLK, Brown → BRN, M → M, -1.25 → M125."""
    text = _clean(value).upper()
    if not text:
        return ''
    num = re.fullmatch(r'([+-]?)(\d+(?:\.\d+)?)', text)
    if num:
        sign = {'-': 'M', '+': 'P'}.get(num.group(1), '')
        return sign + num.group(2).replace('.', '')
    alnum = re.sub(r'[^A-Z0-9]', '', text)
    if len(alnum) <= 3:
        return alnum
    skeleton = alnum[0] + re.sub(r'[AEIOU]', '', alnum[1:])
    if len(skeleton) > 3:
        skeleton = skeleton[:2] + skeleton[-1]
    return skeleton if len(skeleton) >= 2 else alnum[:3]


def build_variant_sku(base_sku, attrs, attribute_order=None):
    norm = normalise_attributes(attrs)
    order = [k for k in (attribute_order or []) if k in norm] + sorted(k for k in norm if k not in (attribute_order or []))
    parts = [attr_code(norm[k]) for k in order]
    return '-'.join([p for p in [_clean(base_sku).upper()] + parts if p])[:150]


def base_sku_from_name(name):
    letters = re.sub(r'[^A-Za-z0-9]', '', _clean(name)).upper()
    return (letters[:6] or 'ITEM')


def _decimal(value, field, errors, *, allow_blank=True, minimum=Decimal('0'), maximum=None):
    if value in (None, ''):
        if allow_blank:
            return None
        errors[field] = 'Required.'
        return None
    try:
        num = Decimal(str(value).replace('%', '').replace(',', '').strip())
    except (InvalidOperation, ValueError):
        errors[field] = 'Must be a number.'
        return None
    if not num.is_finite():
        errors[field] = 'Must be a number.'
        return None
    if minimum is not None and num < minimum:
        errors[field] = f'Cannot be less than {minimum}.'
        return None
    if maximum is not None and num > maximum:
        errors[field] = f'Cannot be more than {maximum}.'
        return None
    return num.quantize(Decimal('0.01'))


def _int(value, field, errors):
    if value in (None, ''):
        return 0
    try:
        num = Decimal(str(value).strip())
    except (InvalidOperation, ValueError):
        errors[field] = 'Must be a whole number.'
        return 0
    if num != num.to_integral_value() or num < 0:
        errors[field] = 'Must be a whole number of 0 or more.'
        return 0
    return int(num)


# ---------------------------------------------------------------------------
# Master lookups
# ---------------------------------------------------------------------------

def _lookup_master(model, name):
    name = _clean(name)
    if not name:
        return None
    return model.objects.filter(Q(name__iexact=name) | Q(code__iexact=name)).first()


def _resolve_tax(pct):
    from apps.masters.models import Tax
    if pct is None:
        return None
    return Tax.objects.filter(rate=pct).first()


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

def _row_attrs(row):
    attrs = dict(row.get('attributes') or {})
    for key in ('color', 'colour', 'size'):
        if row.get(key) not in (None, ''):
            attrs.setdefault(ATTR_ALIASES.get(key, key), row.get(key))
    return normalise_attributes(attrs)


def _validate(payload):
    """Returns (group_data, rows, row_errors, group_errors). rows are cleaned dicts."""
    group_in = payload.get('group') or {}
    variants_in = payload.get('variants') or []
    context = payload.get('context') or CONTEXT_INVENTORY
    row_errors, group_errors = {}, {}

    if not isinstance(variants_in, list) or not variants_in:
        raise VariantValidationError('Add at least one item row.')
    if len(variants_in) > MAX_ROWS_PER_REQUEST:
        raise VariantValidationError(
            f'Too many rows in one save ({len(variants_in)}). Save at most {MAX_ROWS_PER_REQUEST} rows at a time.'
        )

    g_err = {}
    group = {
        'id': payload.get('group_id') or group_in.get('id') or None,
        'name': _clean(group_in.get('name'), 255),
        'base_sku': _clean(group_in.get('base_sku'), 120).upper(),
        'description': _clean(group_in.get('description')),
        'long_description': _clean(group_in.get('long_description')),
        'category_name': _clean(group_in.get('category'), 150),
        'brand_name': _clean(group_in.get('brand'), 150),
        'sub_category': _clean(group_in.get('sub_category'), 150),
        'group_name': _clean(group_in.get('group'), 150),
        'model_number': _clean(group_in.get('model_number'), 150),
        'hsn_code': _clean(group_in.get('hsn_code'), 15),
        'unit_name': _clean(group_in.get('unit'), 50),
        'tax_percent': _decimal(group_in.get('tax_percent'), 'tax_percent', g_err, maximum=Decimal('100')),
        'attribute_keys': [ATTR_ALIASES.get(str(k).lower(), str(k).lower()) for k in (group_in.get('attribute_keys') or []) if k],
        'is_active': group_in.get('is_active', True) is not False,
    }
    group_errors.update(g_err)

    existing_group = None
    if group['id']:
        existing_group = ProductVariantGroup.objects.filter(pk=group['id']).first()
        if existing_group is None:
            raise VariantValidationError('The product being edited no longer exists.', status=404)

    rows = []
    for idx, raw in enumerate(variants_in):
        err = {}
        attrs = _row_attrs(raw)
        row = {
            'index': idx,
            'id': raw.get('id') or None,
            'name': _clean(raw.get('name'), 255),
            'long_name': _clean(raw.get('long_name')),
            'attributes': attrs,
            'key': variant_key(attrs),
            'sku': _clean(raw.get('sku'), 150),
            'barcode': _clean(raw.get('barcode'), 150),
            'category_name': _clean(raw.get('category'), 150) or group['category_name'],
            'brand_name': _clean(raw.get('brand'), 150) or group['brand_name'],
            'sub_category': _clean(raw.get('sub_category'), 150) or group['sub_category'],
            'group_name': _clean(raw.get('group'), 150) or group['group_name'],
            'model_number': _clean(raw.get('model_number'), 150) or group['model_number'],
            'hsn_code': _clean(raw.get('hsn_code'), 15) or group['hsn_code'],
            'cost_price': _decimal(raw.get('cost_price'), 'cost_price', err),
            'mrp': _decimal(raw.get('mrp'), 'mrp', err),
            'sales_price': _decimal(raw.get('sales_price'), 'sales_price', err),
            'tax_percent': _decimal(raw.get('tax_percent'), 'tax_percent', err, maximum=Decimal('100')),
            'opening_stock': _int(raw.get('opening_stock'), 'opening_stock', err),
            'is_active': raw.get('is_active', True) is not False,
        }
        if row['tax_percent'] is None:
            row['tax_percent'] = group['tax_percent']
        if not row['name'] and (group['name'] or existing_group):
            suffix = ' / '.join(attrs.values())
            row['name'] = f"{group['name'] or existing_group.name} {suffix}".strip()[:255]
        if not row['name']:
            # Variants need their parent's name; never save "Black / S" as a product of its own.
            err['name'] = 'Enter the Product Name (above) or a name for this row.' if attrs else 'Product name is required.'
        if row['mrp'] and row['sales_price'] and row['sales_price'] > row['mrp']:
            err['sales_price'] = 'Sales price cannot be more than MRP.'
        if row['id'] and context == CONTEXT_INVENTORY and row['opening_stock']:
            err['opening_stock'] = 'Opening stock applies to new items only. Use Stock Adjust for saved items.'
        if err:
            row_errors[str(idx)] = err
        rows.append(row)

    grouped = bool(existing_group or group['name'] and (len(rows) > 1 or any(r['attributes'] for r in rows)))
    if grouped and not group['name'] and existing_group is None:
        group_errors['name'] = 'Product name is required.'

    # Existing rows must exist (and belong to this group when editing one).
    ids = [r['id'] for r in rows if r['id']]
    existing = {str(p.id): p for p in Product.objects.filter(pk__in=ids)}
    for r in rows:
        if r['id'] and str(r['id']) not in existing:
            row_errors.setdefault(str(r['index']), {})['id'] = 'This item no longer exists. Remove the row and try again.'
        elif r['id'] and existing_group and existing[str(r['id'])].variant_group_id not in (None, existing_group.id):
            row_errors.setdefault(str(r['index']), {})['id'] = 'This item belongs to a different product.'

    # Duplicate combinations inside the payload and against the saved group.
    if grouped:
        seen = {}
        for r in rows:
            prev = seen.get(r['key'])
            if prev is not None:
                label = ' / '.join(r['attributes'].values()) or 'no attributes'
                row_errors.setdefault(str(r['index']), {})['attributes'] = f'Duplicate variant ({label}) — same as row {prev + 1}.'
            else:
                seen[r['key']] = r['index']
        if existing_group:
            taken = dict(
                Product.all_objects.filter(variant_group=existing_group)
                .exclude(pk__in=ids).values_list('variant_key', 'name')
            )
            for r in rows:
                if r['key'] in taken:
                    row_errors.setdefault(str(r['index']), {})['attributes'] = f'This variant already exists ({taken[r["key"]]}).'

    # Duplicate SKUs / barcodes inside the payload.
    for field in ('sku', 'barcode'):
        seen = {}
        for r in rows:
            val = r[field]
            if not val:
                continue
            k = val.lower()
            if k in seen:
                row_errors.setdefault(str(r['index']), {})[field] = f'{field.upper() if field == "sku" else "Barcode"} repeated — same as row {seen[k] + 1}.'
            else:
                seen[k] = r['index']

    # ...and against the database (Product.sku/barcode + printed label series).
    skus = [r['sku'] for r in rows if r['sku']]
    if skus:
        clash = {}
        for pid, sku, name in Product.all_objects.filter(sku__in=skus).values_list('id', 'sku', 'name'):
            clash[sku.lower()] = (str(pid), name)
        for r in rows:
            hit = clash.get(r['sku'].lower()) if r['sku'] else None
            if hit and hit[0] != str(r['id'] or ''):
                row_errors.setdefault(str(r['index']), {})['sku'] = f'SKU already used by "{hit[1]}".'

    codes = [r['barcode'] for r in rows if r['barcode']]
    if codes:
        clash = {}
        for pid, code, name in Product.all_objects.filter(barcode__in=codes).values_list('id', 'barcode', 'name'):
            clash[code] = (str(pid), name)
        for pid, code, name in Product.all_objects.filter(secondary_barcode__in=codes).values_list('id', 'secondary_barcode', 'name'):
            clash.setdefault(code, (str(pid), name))
        for pid, code, name in ProductBarcode.objects.filter(code__in=codes).values_list('product_id', 'code', 'product__name'):
            clash.setdefault(code, (str(pid), name))
        for r in rows:
            hit = clash.get(r['barcode']) if r['barcode'] else None
            if hit and hit[0] != str(r['id'] or ''):
                row_errors.setdefault(str(r['index']), {})['barcode'] = f'Barcode already assigned to "{hit[1]}".'

    if group['base_sku']:
        q = ProductVariantGroup.all_objects.filter(base_sku__iexact=group['base_sku'])
        if existing_group:
            q = q.exclude(pk=existing_group.pk)
        if q.exists():
            group_errors['base_sku'] = 'This base SKU is already used by another product.'

    return group, rows, row_errors, group_errors, existing_group, existing, grouped


# ---------------------------------------------------------------------------
# Save
# ---------------------------------------------------------------------------

def _assign_skus(group, rows, grouped):
    """Fill blank SKUs: {BASE}-{attr codes}, made unique against the DB and the payload."""
    base = group['base_sku'] or base_sku_from_name(group['name'] or (rows[0]['name'] if rows else 'ITEM'))
    pending = [r for r in rows if not r['sku']]
    for r in pending:
        r['_stem'] = build_variant_sku(base, r['attributes'], group['attribute_keys']) if grouped else base_sku_from_name(r['name'])
    # One query for every existing SKU that could collide with a stem or its "-N" suffixes.
    stems = sorted({r['_stem'] for r in pending})
    taken = {r['sku'].lower() for r in rows if r['sku']}
    for i in range(0, len(stems), 200):
        q = Q()
        for stem in stems[i:i + 200]:
            q |= Q(sku__istartswith=stem)
        taken |= {s.lower() for s in Product.all_objects.filter(q).values_list('sku', flat=True)}
    for r in pending:
        stem = r.pop('_stem')
        candidate, n = stem, 1
        while candidate.lower() in taken:
            n += 1
            candidate = f"{stem}-{n}"
        taken.add(candidate.lower())
        r['sku'] = candidate
        r['sku_generated'] = True
    return base


def _extra_data(existing, r):
    data = dict(existing or {})
    data.update({
        'mrp': float(r['mrp']) if r['mrp'] is not None else data.get('mrp', 0),
        'sale_price': float(r['sales_price']) if r['sales_price'] is not None else data.get('sale_price', 0),
        'model_no': r['model_number'],
        'sub_category': r['sub_category'],
        'group': r['group_name'],
        'long_name': r['long_name'],
    })
    for k, v in r['attributes'].items():
        data[k] = v
    if r['tax_percent'] is not None:
        data['gst'] = f"{r['tax_percent'].normalize():f}%"
    return data


def _apply_row(product, r, context, masters, group_obj, is_new):
    from .views import infer_category_name

    product.name = r['name']
    product.sku = r['sku']
    if r['barcode']:
        product.barcode = r['barcode']
    elif is_new:
        product.barcode = None
    product.category_name = infer_category_name(r['category_name'], r['name']) if r['category_name'] or is_new else product.category_name
    product.brand_name = r['brand_name'] or product.brand_name
    product.category = masters['category'].get(r['category_name'].lower()) if r['category_name'] else product.category
    product.brand = masters['brand'].get(r['brand_name'].lower()) if r['brand_name'] else product.brand
    if masters['unit'] is not None:
        product.unit = masters['unit']
    product.hsn_code = r['hsn_code'] or product.hsn_code
    product.color = r['attributes'].get('color') or (None if group_obj else product.color)
    product.size = r['attributes'].get('size') or (None if group_obj else product.size)
    if r['tax_percent'] is not None:
        cache = masters['tax']
        if r['tax_percent'] not in cache:
            cache[r['tax_percent']] = _resolve_tax(r['tax_percent'])
        product.tax = cache[r['tax_percent']]
    # Supplier-specific purchase cost belongs to the purchase line, not the product master:
    # from Purchase Entry the posted purchase sets cost_price (existing posting rule).
    if context == CONTEXT_INVENTORY and r['cost_price'] is not None:
        product.cost_price = r['cost_price']
    if r['sales_price'] is not None:
        product.retail_price = r['sales_price']
    if r['mrp'] is not None:
        product.wholesale_price = r['mrp']  # same convention as ProductMasterDialog
    product.is_active = r['is_active']
    product.extra_data = _extra_data(product.extra_data if not is_new else {}, r)
    product.variant_group = group_obj
    product.variant_attributes = r['attributes']
    product.variant_key = r['key'] if group_obj else None


def save_variants(payload, *, user=None, branch=None, changed_by='Administrator'):
    """Validate and (unless dry_run) write the whole payload atomically.

    Returns a dict: {group, variants, created, updated, deactivated, dry_run}.
    Raises VariantValidationError with per-row errors when anything is invalid.
    """
    token = _clean(payload.get('client_token'), 64)
    dry_run = bool(payload.get('dry_run'))
    if token and not dry_run:
        receipt = BulkSaveReceipt.objects.filter(token=token).first()
        if receipt:
            return {**receipt.response, 'replayed': True}

    context = payload.get('context') or CONTEXT_INVENTORY
    if context not in (CONTEXT_INVENTORY, CONTEXT_PURCHASE):
        raise VariantValidationError('Unknown context.')

    group, rows, row_errors, group_errors, existing_group, existing, grouped = _validate(payload)
    if row_errors or group_errors:
        n = len(row_errors)
        raise VariantValidationError(
            f'{n} row(s) need attention before saving.' if n else 'Please fix the highlighted product details.',
            row_errors, group_errors,
        )

    auto_sku = payload.get('auto_sku', True) is not False
    if auto_sku:
        base = _assign_skus(group, rows, grouped)
    else:
        base = group['base_sku']
        missing = {str(r['index']): {'sku': 'SKU is required.'} for r in rows if not r['sku']}
        if missing:
            raise VariantValidationError(f'{len(missing)} row(s) need attention before saving.', missing)

    if dry_run:
        return {
            'dry_run': True, 'grouped': grouped, 'base_sku': base,
            'variants': [{'index': r['index'], 'sku': r['sku'], 'name': r['name'], 'key': r['key']} for r in rows],
        }

    from apps.masters.models import Brand, ProductCategory, Unit
    masters = {
        'category': {c.name.lower(): c for c in ProductCategory.objects.filter(name__in={r['category_name'] for r in rows if r['category_name']})},
        'brand': {b.name.lower(): b for b in Brand.objects.filter(name__in={r['brand_name'] for r in rows if r['brand_name']})},
        'unit': _lookup_master(Unit, group['unit_name']),
        'tax': {},
    }
    remove_ids = [str(i) for i in (payload.get('remove_ids') or []) if i]
    auto_barcode = bool(payload.get('auto_barcode'))

    try:
        with transaction.atomic():
            group_obj = existing_group
            if grouped:
                if group_obj is None:
                    group_obj = ProductVariantGroup(created_by=user if getattr(user, 'is_authenticated', False) else None)
                else:
                    group_obj = ProductVariantGroup.objects.select_for_update().get(pk=group_obj.pk)
                if group['name']:
                    group_obj.name = group['name']
                group_obj.base_sku = group['base_sku'] or group_obj.base_sku or _unique_base_sku(base, group_obj.pk)
                for f in ('description', 'long_description', 'category_name', 'brand_name', 'sub_category',
                          'group_name', 'model_number', 'hsn_code'):
                    setattr(group_obj, f, group[f])
                group_obj.tax_percent = group['tax_percent']
                group_obj.category = masters['category'].get(group['category_name'].lower()) if group['category_name'] else None
                group_obj.brand = masters['brand'].get(group['brand_name'].lower()) if group['brand_name'] else None
                group_obj.unit = masters['unit']
                keys = group['attribute_keys'] or []
                for r in rows:
                    keys += [k for k in r['attributes'] if k not in keys]
                group_obj.attribute_keys = keys
                group_obj.is_active = group['is_active']
                group_obj.save()

            missing_barcode = [r for r in rows if not r['barcode'] and not (r['id'] and existing[str(r['id'])].barcode)]
            if auto_barcode and missing_barcode:
                for r, code in zip(missing_barcode, _free_ean13(len(missing_barcode))):
                    r['barcode'] = code

            saved, created, updated = [], 0, 0
            history = []
            for r in rows:
                is_new = not r['id']
                product = Product() if is_new else Product.objects.select_for_update().get(pk=r['id'])
                old_barcode = None if is_new else product.barcode
                _apply_row(product, r, context, masters, group_obj if grouped else None, is_new)
                if is_new:
                    product.stock = 0
                    product.opening_stock = r['opening_stock'] if context == CONTEXT_INVENTORY else 0
                    if getattr(user, 'is_authenticated', False):
                        product.created_by = user
                product.save()
                if product.barcode != old_barcode and product.barcode:
                    history.append(BarcodeHistory(
                        product=product, old_barcode=old_barcode, new_barcode=product.barcode,
                        changed_by=changed_by,
                        reason='Created with product (Add Multiple Items)' if is_new else 'Manual update (Manage Variants)',
                    ))
                if is_new and context == CONTEXT_INVENTORY and r['opening_stock'] > 0:
                    from apps.inventory.stock_utils import adjust_branch_stock
                    adjust_branch_stock(product, branch, r['opening_stock'], ledger={
                        'transaction_type': 'ADJ_ADD',
                        'reference_id': product.id,
                        'notes': 'Opening stock (Add Multiple Items)',
                    })
                    product.refresh_from_db(fields=['stock'])
                created += is_new
                updated += not is_new
                saved.append((r, product))
            if history:
                BarcodeHistory.objects.bulk_create(history)

            deactivated = 0
            if remove_ids:
                q = Product.objects.filter(pk__in=remove_ids)
                q = q.filter(variant_group=existing_group) if existing_group else q.none()
                deactivated = q.update(is_active=False)

            result = {
                'dry_run': False,
                'group': serialize_group(group_obj) if grouped else None,
                'variants': [dict(serialize_variant(p), index=r['index']) for r, p in saved],
                'created': created, 'updated': updated, 'deactivated': deactivated,
            }
            if token:
                BulkSaveReceipt.objects.create(token=token, response=_jsonable(result))
            return result
    except IntegrityError as exc:
        # Lost a race with another save (same SKU / barcode / combination committed meanwhile).
        raise VariantValidationError(
            'Another user saved a conflicting SKU, barcode or variant at the same time. Please check and save again.',
            status=409,
        ) from exc


def _unique_base_sku(base, own_pk):
    candidate, n = base, 1
    while ProductVariantGroup.all_objects.filter(base_sku__iexact=candidate).exclude(pk=own_pk).exists():
        n += 1
        candidate = f"{base}{n}"
    return candidate


def _free_ean13(count):
    """Next `count` codes from the shared product series that nobody holds yet."""
    return reserve_product_barcodes(count=count)


def _jsonable(obj):
    import json
    from django.core.serializers.json import DjangoJSONEncoder
    return json.loads(json.dumps(obj, cls=DjangoJSONEncoder))


# ---------------------------------------------------------------------------
# Read models
# ---------------------------------------------------------------------------

def serialize_variant(p):
    data = p.extra_data if isinstance(p.extra_data, dict) else {}
    gst = data.get('gst')
    tax = None
    if p.tax_id and p.tax:
        tax = float(p.tax.rate)
    elif gst not in (None, ''):
        try:
            tax = float(str(gst).replace('%', ''))
        except ValueError:
            tax = None
    return {
        'id': str(p.id),
        'name': p.name,
        'long_name': data.get('long_name', ''),
        'sku': p.sku,
        'barcode': p.barcode or '',
        'attributes': p.variant_attributes or normalise_attributes({'color': p.color, 'size': p.size}),
        'color': p.color or '',
        'size': p.size or '',
        'category': p.category_name or '',
        'brand': p.brand_name or '',
        'sub_category': data.get('sub_category', ''),
        'group': data.get('group', ''),
        'model_number': data.get('model_no', ''),
        'hsn_code': p.hsn_code or '',
        'cost_price': float(p.cost_price or 0),
        'mrp': float(data.get('mrp') or p.wholesale_price or 0),
        'sales_price': float(p.retail_price or 0),
        'tax_percent': tax,
        'stock': p.stock,
        'minimum_stock': p.minimum_stock,
        'is_active': p.is_active,
        'variant_group': str(p.variant_group_id) if p.variant_group_id else None,
    }


def serialize_group(g, with_variants=False):
    out = {
        'id': str(g.id),
        'name': g.name,
        'base_sku': g.base_sku or '',
        'description': g.description or '',
        'long_description': g.long_description or '',
        'category': g.category_name or '',
        'brand': g.brand_name or '',
        'sub_category': g.sub_category or '',
        'group': g.group_name or '',
        'model_number': g.model_number or '',
        'hsn_code': g.hsn_code or '',
        'unit': g.unit.name if g.unit_id and g.unit else '',
        'tax_percent': float(g.tax_percent) if g.tax_percent is not None else None,
        'attribute_keys': g.attribute_keys or [],
        'is_active': g.is_active,
    }
    if with_variants:
        variants = g.variants.filter(is_deleted=False).select_related('tax').order_by('created_at', 'sku')
        out['variants'] = [serialize_variant(p) for p in variants]
        out['variant_count'] = len(out['variants'])
        out['total_stock'] = sum(v['stock'] or 0 for v in out['variants'])
    return out
