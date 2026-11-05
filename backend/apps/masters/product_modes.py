"""Frame / Lens mode of a Category or Brand for the "Add New Product" dialog.

An explicit ``product_mode`` wins. Untagged rows resolve as:
- Category: LENS when its name is a spectacle-lens category, else FRAME (mirrors
  isSpectacleLensCategory in frontend/src/utils/lensUnits.js).
- Brand: from the products using it — only lens products → LENS, lens and other products →
  BOTH, other products → FRAME; a brand no product uses yet falls back to its name.
"""
import re

_NOT_SPECTACLE_LENS = re.compile(r'contact|solution|clean|case|cloth|drop|kit|accessor|frame|sunglass')
_SPECTACLE_LENS = re.compile(r'\blens(es)?\b|ophthalmic')
# Mirrors LENS_BRAND_RE in frontend/src/components/inventory/productAttributeOptions.js.
_LENS_BRAND = re.compile(
    r'essilor|zeiss|hoya|crizal|kodak|nikon|rodenstock|varilux|shamir|seiko|younger|'
    r'vision ?rx|gkb|tokai|indo|\blens'
)


def is_spectacle_lens_category(name):
    t = (name or '').strip().lower()
    if not t or _NOT_SPECTACLE_LENS.search(t):
        return False
    return bool(_SPECTACLE_LENS.search(t))


def category_mode(category):
    if category.product_mode:
        return category.product_mode
    return 'LENS' if is_spectacle_lens_category(category.name) else 'FRAME'


def brand_usage(context):
    """{brand id or lower-cased brand name: {'lens': bool, 'other': bool}} over every product,
    built once per list response (``context`` is shared by every row)."""
    usage = context.get('_product_brand_usage')
    if usage is None:
        from apps.products.models import Product
        usage = {}
        rows = Product.objects.values_list('brand_id', 'brand_name', 'category_name', 'category__name')
        for brand_id, brand_name, category_name, fk_category_name in rows:
            kind = 'lens' if is_spectacle_lens_category(fk_category_name or category_name) else 'other'
            for key in (brand_id, (brand_name or '').strip().lower()):
                if key:
                    usage.setdefault(key, {'lens': False, 'other': False})[kind] = True
        context['_product_brand_usage'] = usage
    return usage


def brand_mode(brand, usage):
    if brand.product_mode:
        return brand.product_mode
    name = (brand.name or '').strip().lower()
    lens = other = False
    for key in (brand.pk, name):
        flags = usage.get(key)
        if flags:
            lens = lens or flags['lens']
            other = other or flags['other']
    if lens and other:
        return 'BOTH'
    if lens:
        return 'LENS'
    if other:
        return 'FRAME'
    return 'LENS' if _LENS_BRAND.search(name) else 'FRAME'
