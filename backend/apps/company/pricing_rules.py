"""Settings → Pricing Rules & Offers: the selling-below-cost lock and the clearance / offer
exceptions to it.

    GET  /api/company/pricing-rules/                 {settings, can_edit}
    PUT  /api/company/pricing-rules/                 save the master switches + margin (pricing admins)
    GET  /api/company/pricing-rules/offers/          every offer (?active=1: only running ones)
    POST /api/company/pricing-rules/offers/          add offers — one per product / category in the list
    PATCH/DELETE /api/company/pricing-rules/offers/<id>/
    POST /api/company/pricing-rules/floors/          {products: [ids]} → each one's cost / floor / offer
    POST /api/company/pricing-rules/approve/         a manager's username + password → override token

Rules (mirrored in frontend src/utils/pricingRules.js):
  * Lock OFF → any price. Lock ON → a product line's net price (after its own discount and its
    share of any bill-level discount, before tax) may not be below the floor:
        floor per stock unit = max(cost × (1 + min_margin_percent / 100), cost + min_profit_amount)
    A product with no cost price (0) has no floor.
  * Offers & Clearance ON → a running offer for the product (else its category) lowers that floor
    to the offer price, or removes it when the offer has no price.
  * Lens lines sold by the pair / single lens are costed per piece (a pair-stock lens's cost / 2).
  * A refused save is a 400 `below_cost`; it goes through with `override_price_floor: true` from a
    pricing admin, or a `price_override_token` a pricing admin issued at the till (approve/).
    Every override is written to the settings audit log.
"""
import datetime
from decimal import Decimal, InvalidOperation

from django.contrib.auth import get_user_model
from django.core import signing
from django.db import transaction
from django.db.models import Q
from rest_framework import permissions, status
from rest_framework.exceptions import ValidationError
from rest_framework.response import Response
from rest_framework.throttling import ScopedRateThrottle
from rest_framework.views import APIView

from apps.common import hot_cache
from .models import BusinessSettings, PricingOffer
from .localization import audit, actor_name

# Who may change these rules, add offers and approve a below-floor price.
PRICING_ADMIN_ROLES = {'SUPER_ADMIN', 'ADMINISTRATOR', 'BRANCH_ADMIN', 'MANAGER'}

DEFAULTS = {
    'cost_lock_enabled': False,   # off = what the system has always done
    'min_margin_percent': 0,      # floor = cost + this % ...
    'min_profit_amount': 0,       # ... or cost + this amount per unit, whichever is higher
    'offers_enabled': False,
}
PREF_KEY = 'pricing_rules'        # inside BusinessSettings.preferences
CACHE_KEY = 'company:pricing_rules'
TOKEN_SALT = 'pricing-floor-override'
TOKEN_SECONDS = 10 * 60
TOLERANCE = Decimal('0.005')
CENT = Decimal('0.01')


def _role(user):
    from apps.billing.views import user_role
    return user_role(user)


def is_pricing_admin(user):
    return _role(user) in PRICING_ADMIN_ROLES


def _dec(value, default=Decimal('0')):
    try:
        return Decimal(str(value)) if value not in (None, '') else default
    except (InvalidOperation, ValueError, TypeError):
        return default


# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------

def get_settings():
    def load():
        stored = (BusinessSettings.load().preferences or {}).get(PREF_KEY) or {}
        return {**DEFAULTS, **{k: v for k, v in stored.items() if k in DEFAULTS}}
    return dict(hot_cache.get_or_load(CACHE_KEY, load))


def validate_settings(data):
    clean, errors = {}, {}
    for key in ('cost_lock_enabled', 'offers_enabled'):
        if key in data:
            if isinstance(data[key], bool):
                clean[key] = data[key]
            else:
                errors[key] = 'Must be on or off.'
    for key, hi, label in (('min_margin_percent', 1000, 'a percentage between 0 and 1000'),
                           ('min_profit_amount', 10_000_000, 'an amount of 0 or more')):
        if key in data:
            try:
                n = Decimal(str(data[key]).strip() or '0')
            except InvalidOperation:
                errors[key] = f'Enter {label}.'
                continue
            if not Decimal('0') <= n <= hi:
                errors[key] = f'Enter {label}.'
            else:
                clean[key] = float(n.quantize(CENT))
    return clean, errors


class PricingAdminWrite(permissions.BasePermission):
    message = 'Only an Administrator or Manager can change pricing rules and offers.'

    def has_permission(self, request, view):
        if request.method in permissions.SAFE_METHODS:
            return bool(request.user and request.user.is_authenticated)
        return is_pricing_admin(request.user)


class PricingRulesView(APIView):
    permission_classes = [PricingAdminWrite]

    def get(self, request):
        return Response({'settings': get_settings(), 'can_edit': is_pricing_admin(request.user)})

    def put(self, request):
        data = request.data if isinstance(request.data, dict) else {}
        data = data.get('settings', data) if isinstance(data.get('settings'), dict) else data
        clean, errors = validate_settings(data)
        if errors:
            return Response({'detail': 'Please fix the highlighted fields.', 'errors': errors},
                            status=status.HTTP_400_BAD_REQUEST)
        current = get_settings()
        changes = {k: [current.get(k), v] for k, v in clean.items() if current.get(k) != v}
        with transaction.atomic():
            obj = BusinessSettings.objects.select_for_update().get(pk=BusinessSettings.load().pk)
            prefs = dict(obj.preferences or {})
            prefs[PREF_KEY] = {**current, **clean}
            obj.preferences = prefs
            obj.save(update_fields=['preferences', 'updated_at'])
            if changes:
                audit(request, 'PRICING', 'UPDATE', f"Updated {', '.join(sorted(changes))}", changes)
        hot_cache.clear()
        return Response({'settings': get_settings(), 'can_edit': True})


# ---------------------------------------------------------------------------
# Offers
# ---------------------------------------------------------------------------

def _today():
    from .localization import tz_now
    return tz_now().date()


def running_offers_q(today=None):
    today = today or _today()
    return (Q(is_active=True) & (Q(start_date__isnull=True) | Q(start_date__lte=today))
            & (Q(end_date__isnull=True) | Q(end_date__gte=today)))


def offer_state(offer, today=None):
    today = today or _today()
    if not offer.is_active:
        return 'PAUSED'
    if offer.start_date and offer.start_date > today:
        return 'SCHEDULED'
    if offer.end_date and offer.end_date < today:
        return 'EXPIRED'
    return 'RUNNING'


def _offer_json(o, today=None):
    p, c = o.product, o.category
    return {
        'id': str(o.pk), 'scope': o.scope,
        'product': str(o.product_id) if o.product_id else None,
        'product_name': p.name if p else '', 'product_sku': p.sku if p else '',
        'product_barcode': (p.barcode or '') if p else '',
        'cost_price': float(p.cost_price) if p else None,
        'retail_price': float(p.retail_price) if p else None,
        'stock': p.stock if p else None,
        'category': str(o.category_id) if o.category_id else None,
        'category_name': c.name if c else (p.category_name or '' if p else ''),
        'offer_price': float(o.offer_price) if o.offer_price is not None else None,
        'tag': o.tag, 'notes': o.notes,
        'start_date': o.start_date.isoformat() if o.start_date else None,
        'end_date': o.end_date.isoformat() if o.end_date else None,
        'is_active': o.is_active, 'state': offer_state(o, today),
        'created_by': o.created_by, 'created_at': o.created_at.isoformat(),
    }


def _parse_date(value, label, errors):
    if value in (None, ''):
        return None
    try:
        return datetime.date.fromisoformat(str(value)[:10])
    except ValueError:
        errors[label] = 'Enter a valid date.'
        return None


def _clean_offer_fields(data, errors, partial=False):
    out = {}
    if 'offer_price' in data or not partial:
        raw = data.get('offer_price')
        if raw in (None, ''):
            out['offer_price'] = None
        else:
            n = _dec(raw, None)
            if n is None or n < 0:
                errors['offer_price'] = 'Enter a price of 0 or more, or leave it blank to allow any price.'
            else:
                out['offer_price'] = n.quantize(CENT)
    if 'tag' in data or not partial:
        tag = str(data.get('tag') or '').strip()[:60]
        if not tag:
            errors['tag'] = 'Give the offer a tag, e.g. "Clearance Stock".'
        out['tag'] = tag
    if 'notes' in data:
        out['notes'] = str(data.get('notes') or '').strip()[:255]
    for key in ('start_date', 'end_date'):
        if key in data or not partial:
            out[key] = _parse_date(data.get(key), key, errors)
    if 'is_active' in data:
        if not isinstance(data['is_active'], bool):
            errors['is_active'] = 'Must be on or off.'
        else:
            out['is_active'] = data['is_active']
    return out


def _check_dates(start, end, errors):
    if start and end and end < start:
        errors['end_date'] = 'The end date is before the start date.'


class PricingOfferListView(APIView):
    permission_classes = [PricingAdminWrite]

    def get(self, request):
        qs = PricingOffer.objects.select_related('product', 'category')
        if request.query_params.get('active') in ('1', 'true'):
            qs = qs.filter(running_offers_q())
        today = _today()
        return Response([_offer_json(o, today) for o in qs])

    def post(self, request):
        """One offer per product id in `products` (and/or category id in `categories`), all with
        the same price / tag / dates. A target that already has an offer gets it updated instead
        of a second one, so re-adding an item never stacks offers."""
        from apps.masters.models import ProductCategory
        from apps.products.models import Product

        data = request.data if isinstance(request.data, dict) else {}
        errors = {}
        fields = _clean_offer_fields(data, errors)
        _check_dates(fields.get('start_date'), fields.get('end_date'), errors)
        product_ids = [str(x) for x in (data.get('products') or [])]
        category_ids = [str(x) for x in (data.get('categories') or [])]
        if data.get('product'):
            product_ids.append(str(data['product']))
        if data.get('category'):
            category_ids.append(str(data['category']))
        products = Product.objects.in_bulk(product_ids) if product_ids else {}
        categories = ProductCategory.objects.in_bulk(category_ids) if category_ids else {}
        if not products and not categories:
            errors['products'] = 'Pick at least one product or category.'
        if errors:
            return Response({'detail': 'Please fix the highlighted fields.', 'errors': errors},
                            status=status.HTTP_400_BAD_REQUEST)
        fields.setdefault('is_active', True)
        by = actor_name(request)[:150]
        saved = []
        with transaction.atomic():
            for scope, objs, fk in (('PRODUCT', products.values(), 'product'),
                                    ('CATEGORY', categories.values(), 'category')):
                for obj in objs:
                    offer = PricingOffer.objects.filter(scope=scope, **{fk: obj}).first()
                    if offer is None:
                        offer = PricingOffer(scope=scope, created_by=by, **{fk: obj})
                    for k, v in fields.items():
                        setattr(offer, k, v)
                    offer.save()
                    saved.append(offer)
            audit(request, 'PRICING', 'CREATE',
                  f"Offer '{fields['tag']}' set on {len(saved)} item(s)",
                  {'offers': [str(o.pk) for o in saved], 'offer_price': str(fields.get('offer_price'))})
        today = _today()
        rows = PricingOffer.objects.select_related('product', 'category').filter(pk__in=[o.pk for o in saved])
        return Response([_offer_json(o, today) for o in rows], status=status.HTTP_201_CREATED)


class PricingOfferDetailView(APIView):
    permission_classes = [PricingAdminWrite]

    def _get(self, pk):
        return PricingOffer.objects.select_related('product', 'category').filter(pk=pk).first()

    def patch(self, request, pk):
        offer = self._get(pk)
        if offer is None:
            return Response({'detail': 'Offer not found.'}, status=status.HTTP_404_NOT_FOUND)
        data = request.data if isinstance(request.data, dict) else {}
        errors = {}
        fields = _clean_offer_fields(data, errors, partial=True)
        _check_dates(fields.get('start_date', offer.start_date), fields.get('end_date', offer.end_date), errors)
        if errors:
            return Response({'detail': 'Please fix the highlighted fields.', 'errors': errors},
                            status=status.HTTP_400_BAD_REQUEST)
        changes = {k: [str(getattr(offer, k)), str(v)] for k, v in fields.items() if getattr(offer, k) != v}
        for k, v in fields.items():
            setattr(offer, k, v)
        offer.save()
        if changes:
            audit(request, 'PRICING', 'UPDATE', f"Offer '{offer.tag}' updated", changes)
        return Response(_offer_json(offer))

    def delete(self, request, pk):
        offer = self._get(pk)
        if offer is None:
            return Response(status=status.HTTP_204_NO_CONTENT)
        audit(request, 'PRICING', 'DELETE', f"Offer '{offer.tag}' removed",
              {'product': str(offer.product_id or ''), 'category': str(offer.category_id or '')})
        offer.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


# ---------------------------------------------------------------------------
# Floors
# ---------------------------------------------------------------------------

def lens_stock_unit(product):
    unit = str(((product.extra_data or {}) if product else {}).get('lens_stock_unit') or '').upper()
    return 'PIECE' if unit == 'PIECE' else 'PAIR'


def floors_for(products, settings=None, today=None):
    """{product_id: info} for Product rows. info: cost and floor per stock unit (floor None = no
    limit), base_floor (from the margin rule alone), the running offer if any, lens_stock_unit."""
    settings = settings or get_settings()
    products = list(products)
    offers_by_product, offers_by_category = {}, {}
    if settings['offers_enabled'] and products:
        cat_ids = {p.category_id for p in products if p.category_id}
        q = Q(scope='PRODUCT', product_id__in=[p.pk for p in products])
        if cat_ids:
            q |= Q(scope='CATEGORY', category_id__in=cat_ids)
        for o in PricingOffer.objects.filter(running_offers_q(today)).filter(q).order_by('created_at'):
            target = offers_by_product if o.scope == 'PRODUCT' else offers_by_category
            key = o.product_id if o.scope == 'PRODUCT' else o.category_id
            target[key] = o   # latest wins; at most one per target is created anyway
    margin = _dec(settings['min_margin_percent'])
    profit = _dec(settings['min_profit_amount'])
    out = {}
    for p in products:
        cost = _dec(p.cost_price)
        base = None
        if settings['cost_lock_enabled'] and cost > 0:
            base = max(cost * (1 + margin / 100), cost + profit).quantize(CENT)
        offer = offers_by_product.get(p.pk) or offers_by_category.get(p.category_id)
        floor = base
        if offer is not None and base is not None:
            floor = None if offer.offer_price is None else min(base, offer.offer_price)
        out[str(p.pk)] = {
            'cost': float(cost), 'base_floor': float(base) if base is not None else None,
            'floor': float(floor) if floor is not None else None,
            'lens_stock_unit': lens_stock_unit(p),
            'offer': {'id': str(offer.pk), 'tag': offer.tag, 'scope': offer.scope,
                      'offer_price': float(offer.offer_price) if offer.offer_price is not None else None,
                      'end_date': offer.end_date.isoformat() if offer.end_date else None} if offer else None,
        }
    return out


class PricingFloorsView(APIView):
    """What New Sale needs to check each line as it is typed, and to badge each line On Offer /
    Not on Offer. Products are looked up while either the lock or Offers & Clearance is on."""

    def post(self, request):
        from apps.products.models import Product
        from apps.sales.views import _is_uuid
        ids = [str(x) for x in ((request.data or {}).get('products') or []) if _is_uuid(x)][:500]
        settings = get_settings()
        wanted = settings['cost_lock_enabled'] or settings['offers_enabled']
        products = Product.objects.filter(pk__in=ids) if ids and wanted else []
        return Response({'settings': settings, 'floors': floors_for(products, settings),
                         'can_override': is_pricing_admin(request.user)})


# ---------------------------------------------------------------------------
# Manager approval at the till
# ---------------------------------------------------------------------------

def _tenant_id():
    from apps.common.tenancy import current_tenant_id
    return current_tenant_id()


class PricingApproveView(APIView):
    """A manager types their own username + password on the cashier's screen. Checked against the
    login lockout like any sign-in; on success returns a short-lived token the sale carries."""
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = 'reauth'

    def post(self, request):
        from apps.security import login_protection
        from apps.security.models import UserTwoFactor
        from apps.security import totp

        data = request.data if isinstance(request.data, dict) else {}
        username = str(data.get('username') or '').strip()
        password = str(data.get('password') or '')
        if not username or not password:
            return Response({'detail': "Enter the manager's username and password."},
                            status=status.HTTP_400_BAD_REQUEST)
        login_protection.ensure_not_locked(username, request)
        user = get_user_model().objects.filter(username__iexact=username, is_active=True).first()
        if user is None or not user.check_password(password):
            login_protection.record_failure(username, request, reason='price-approval')
            return Response({'detail': 'Incorrect username or password.'}, status=status.HTTP_400_BAD_REQUEST)
        tenant = _tenant_id()
        if tenant and getattr(user, 'tenant_id', None) and str(user.tenant_id) != str(tenant) \
                and not user.is_superuser:
            login_protection.record_failure(username, request, reason='price-approval')
            return Response({'detail': 'Incorrect username or password.'}, status=status.HTTP_400_BAD_REQUEST)
        if not is_pricing_admin(user):
            return Response({'detail': f'{user.username} is not an Administrator or Manager and cannot approve '
                                       'a price below cost.'}, status=status.HTTP_403_FORBIDDEN)
        tf = UserTwoFactor.objects.filter(user_id=user.pk, confirmed_at__isnull=False).first()
        if tf is not None:
            step = totp.match_step(tf.secret, data.get('code'))
            if step is None or not UserTwoFactor.objects.filter(pk=tf.pk, last_used_step__lt=step).update(
                    last_used_step=step):
                login_protection.record_failure(username, request, reason='price-approval-2fa')
                return Response({'detail': "Enter the manager's current 6-digit authenticator code.",
                                 'code': 'two_factor_required'}, status=status.HTTP_400_BAD_REQUEST)
        login_protection.record_success(username, request)
        token = signing.dumps({'u': str(user.pk), 'n': user.username, 't': str(tenant or '')}, salt=TOKEN_SALT)
        return Response({'token': token, 'approver': user.get_full_name() or user.username,
                         'expires_in': TOKEN_SECONDS})


def _approver_from_token(token):
    try:
        data = signing.loads(str(token), salt=TOKEN_SALT, max_age=TOKEN_SECONDS)
    except signing.BadSignature:
        return None
    if str(data.get('t') or '') != str(_tenant_id() or ''):
        return None
    user = get_user_model().objects.filter(pk=data.get('u'), is_active=True).first()
    return user if user is not None and is_pricing_admin(user) else None


# ---------------------------------------------------------------------------
# Enforcement on a sales document's lines
# ---------------------------------------------------------------------------

def _line_net(raw, gross):
    """A line's price after its own discount, before tax. New Sale sends `discount`; POS Billing
    sends a pre-tax subtotal with no line discount; older callers a tax-inclusive subtotal."""
    if 'discount' in raw:
        return max(gross - _dec(raw.get('discount')), Decimal('0'))
    subtotal = _dec(raw.get('subtotal', raw.get('total')))
    tax = _dec(raw.get('tax_amount', raw.get('tax')))
    if abs(subtotal - gross) <= CENT:
        return gross
    return max(min(subtotal - tax, gross), Decimal('0'))


def _cost_units(raw, qty, product):
    """How many of the product's stock units a line sells (lens pieces per pair stock = 1/2)."""
    unit = str(raw.get('selling_unit') or '').upper()
    if unit not in ('PAIR', 'PIECE'):
        return qty
    pieces = _dec(raw.get('physical_quantity'), None)
    if pieces is None:
        pieces = qty * (2 if unit == 'PAIR' else 1)
    return pieces if lens_stock_unit(product) == 'PIECE' else pieces / 2


def price_violations(raw_items, net_amount, tax_amount, settings=None):
    """Lines priced below their floor: [{index, product, name, qty, net_unit, floor_unit, cost_unit,
    margin_applied, offer}] (per selling unit). Empty when the lock is off."""
    from apps.products.models import Product
    from apps.sales.views import _is_uuid

    settings = settings or get_settings()
    if not settings['cost_lock_enabled'] or not raw_items:
        return []
    lines = []
    for i, raw in enumerate(raw_items):
        qty = _dec(raw.get('quantity', raw.get('qty')), Decimal('1'))
        price = _dec(raw.get('unit_price', raw.get('price')))
        gross = qty * price
        lines.append((i, raw, qty, _line_net(raw, gross)))
    # A bill-level (coupon / overall) discount comes off every line in proportion to its net.
    total_net = sum((n for *_, n in lines), Decimal('0'))
    bill_disc = total_net - (_dec(net_amount) - _dec(tax_amount))
    factor = (1 - bill_disc / total_net) if total_net > 0 and bill_disc > CENT else Decimal('1')

    ids = {str(raw.get('product')) for _, raw, *_ in lines if _is_uuid(raw.get('product'))}
    products = {str(p.pk): p for p in Product.objects.filter(pk__in=ids)} if ids else {}
    floors = floors_for(products.values(), settings)
    out = []
    for i, raw, qty, net in lines:
        pid = str(raw.get('product'))
        info = floors.get(pid)
        if info is None or info['floor'] is None or qty <= 0:
            continue
        units = _cost_units(raw, qty, products[pid])
        line_floor = _dec(info['floor']) * units
        line_net = net * factor
        if line_net + TOLERANCE < line_floor:
            out.append({
                'index': i, 'product': pid,
                'name': raw.get('description') or raw.get('name') or products[pid].name,
                'qty': float(qty),
                'net_unit': float((line_net / qty).quantize(CENT)),
                'floor_unit': float((line_floor / qty).quantize(CENT)),
                'cost_unit': float((_dec(info['cost']) * units / qty).quantize(CENT)),
                'margin_applied': info['base_floor'] is not None and info['base_floor'] > info['cost'],
                'offer': info['offer'],
            })
    return out


def violation_message(v, symbol='₹'):
    floor = f"{symbol}{v['floor_unit']:.2f}"
    if v['offer']:
        reason = f"the {v['offer']['tag']} offer price ({floor})"
    elif v['margin_applied']:
        reason = f"the minimum selling price ({floor}; cost {symbol}{v['cost_unit']:.2f} + margin)"
    else:
        reason = f"the cost price ({floor})"
    return f"{v['name']}: {symbol}{v['net_unit']:.2f} is below {reason}"


def enforce_line_prices(request, raw_items, net_amount, tax_amount, document_label=''):
    """Raise a 400 `below_cost` naming every line under its floor, unless a pricing admin
    overrides (their own `override_price_floor`, or a till approval token). Returns the approver
    when an override was used."""
    violations = price_violations(raw_items, net_amount, tax_amount)
    if not violations:
        return None
    data = request.data if isinstance(request.data, dict) else {}
    approver = None
    if data.get('price_override_token'):
        approver = _approver_from_token(data['price_override_token'])
    if approver is None and data.get('override_price_floor') is True and is_pricing_admin(request.user):
        approver = request.user
    from .store_profile import get_company
    company = get_company()
    symbol = (company.currency if company else '') or '₹'
    messages = [violation_message(v, symbol) for v in violations]
    if approver is None:
        raise ValidationError({
            'detail': 'Selling price cannot be less than the cost price — '
                      + '; '.join(messages) + '. A manager must approve it.',
            'code': 'below_cost',
            'violations': violations,
        })
    audit(request, 'PRICING', 'OVERRIDE',
          f"Below-cost price approved by {approver.username}"
          + (f" on {document_label}" if document_label else '') + f" ({len(violations)} line(s))",
          {'approver': approver.username, 'cashier': actor_name(request), 'document': document_label,
           'lines': messages})
    return approver
