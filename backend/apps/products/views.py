from rest_framework import viewsets, permissions, status
from rest_framework.decorators import action
from rest_framework.response import Response
from rest_framework.serializers import ModelSerializer, SerializerMethodField
from rest_framework.pagination import PageNumberPagination
from django.db import transaction, IntegrityError
from django.db.models import Q
from .models import Product, BarcodeHistory, ProductBarcode
from .barcode_utils import reserve_barcodes, reserve_ean13


class ProductPagination(PageNumberPagination):
    page_size = 100
    page_size_query_param = 'page_size'
    max_page_size = 500

def infer_category_name(category_name, product_name):
    cat = (category_name or '').strip()
    name = (product_name or '').strip().lower()
    
    if cat and cat.lower() not in ('frames', 'general', 'all', 'none', ''):
        lower_cat = cat.lower()
        if 'sunglass' in lower_cat:
            return 'Sunglasses'
        if 'lens' in lower_cat or 'ophthalmic' in lower_cat:
            return 'Prescription Lenses'
        if 'contact' in lower_cat:
            return 'Contact Lenses'
        if 'reading' in lower_cat or 'reader' in lower_cat:
            return 'Reading Glasses'
        if 'accessori' in lower_cat:
            return 'Accessories'
        if 'solution' in lower_cat:
            return 'Lens Solutions'
        if 'clean' in lower_cat or 'kit' in lower_cat:
            return 'Cleaning Kits'
        if 'case' in lower_cat:
            return 'Cases'
        if 'drop' in lower_cat:
            return 'Eye Drops'
        return cat

    if 'sunglass' in name:
        return 'Sunglasses'
    if any(k in name for k in ['lens', 'crizal', 'essilor', 'hoya', 'zeiss', 'kodak', 'progressive', 'bifocal', 'single vision', 'arc', 'blue cut', 'photochromic']):
        return 'Prescription Lenses'
    if any(k in name for k in ['contact', 'bausch', 'freshlook', 'acuvue', 'air optix']):
        return 'Contact Lenses'
    if any(k in name for k in ['reading', 'reader']):
        return 'Reading Glasses'
    if 'solution' in name:
        return 'Lens Solutions'
    if any(k in name for k in ['clean', 'cloth', 'spray', 'kit']):
        return 'Cleaning Kits'
    if any(k in name for k in ['case', 'cover', 'pouch', 'box']):
        return 'Cases'
    if any(k in name for k in ['drop', 'tear', 'lubricant']):
        return 'Eye Drops'
    if any(k in name for k in ['chain', 'cord', 'screw', 'pad']):
        return 'Accessories'

    return cat or 'Frames'


class ProductSerializer(ModelSerializer):
    category = SerializerMethodField()
    brand = SerializerMethodField()
    price = SerializerMethodField()
    selling_price = SerializerMethodField()
    supplier = SerializerMethodField()
    rack = SerializerMethodField()
    tax_rate = SerializerMethodField()
    extra_barcodes = SerializerMethodField()
    colour = SerializerMethodField()
    size = SerializerMethodField()
    product_code = SerializerMethodField()

    class Meta:
        model = Product
        fields = '__all__'

    def _extra_value(self, obj, *keys):
        # Legacy imported / UI-created products stored variant attributes only inside
        # the raw `extra_data` blob. Scan it case-insensitively as a fallback so the
        # barcode label still shows a colour / size for rows created before the
        # dedicated columns existed.
        data = obj.extra_data or {}
        if not isinstance(data, dict):
            return ''
        lowered = {str(k).lower(): v for k, v in data.items()}
        for key in keys:
            val = lowered.get(key.lower())
            if val not in (None, ''):
                return str(val).strip()
        return ''

    def get_colour(self, obj):
        return (obj.color or '').strip() or self._extra_value(obj, 'color', 'colour', 'color_code', 'colorcode')

    def get_size(self, obj):
        return (obj.size or '').strip() or self._extra_value(obj, 'size', 'frame_size', 'framesize')

    def get_product_code(self, obj):
        return obj.sku or ''

    def get_extra_barcodes(self, obj):
        # Every code in the product's printed per-label EAN-13 series. Billing/POS
        # screens match a scanned code against this list as well as `barcode`, so
        # any physical tag from a label sheet resolves back to this product.
        return [b.code for b in obj.extra_barcodes.all()]

    def get_tax_rate(self, obj):
        # The item-entry screens (Sales / Purchase) need a numeric GST % to pre-fill the
        # Tax dropdown when a product is picked. Prefer the linked Tax master rate; fall
        # back to the product category's configured GST percentage (stored as e.g. "18%").
        if getattr(obj, 'tax', None) and obj.tax.rate is not None:
            return float(obj.tax.rate)
        if getattr(obj, 'category', None) and obj.category.gst_percentage:
            try:
                return float(str(obj.category.gst_percentage).replace('%', '').strip())
            except (TypeError, ValueError):
                pass
        return None

    def get_category(self, obj):
        cat_val = obj.category_name or (obj.category.name if obj.category else None)
        return infer_category_name(cat_val, obj.name)

    def get_brand(self, obj):
        return obj.brand_name or (obj.brand.name if obj.brand else None) or 'Generic'

    def get_price(self, obj):
        return float(obj.retail_price or 0.0)

    def get_selling_price(self, obj):
        return float(obj.retail_price or 0.0)

    def get_supplier(self, obj):
        return obj.supplier_name or ''

    def get_rack(self, obj):
        return obj.rack_location or 'A1'

    def validate_barcode(self, value):
        # Normalize blank barcode to None so two blank products don't collide
        # under the unique constraint (NULLs are distinct; empty strings aren't).
        return value or None

    def _apply_variant_attrs(self, validated_data, input_data):
        # `size` is a read-only SerializerMethodField (so it can fall back to
        # extra_data on output), so writes to the real column have to be lifted
        # from the raw request here. `colour` is accepted as an alias for `color`.
        for key in ('color', 'colour'):
            if key in input_data and input_data.get(key) not in (None, ''):
                validated_data['color'] = str(input_data.get(key)).strip()[:100]
                break
        if 'size' in input_data and input_data.get('size') not in (None, ''):
            validated_data['size'] = str(input_data.get('size')).strip()[:100]

    def create(self, validated_data):
        request = self.context.get('request')
        input_data = request.data if request else {}
        cat_val = input_data.get('category') or input_data.get('category_name') or validated_data.get('category_name')
        name_val = input_data.get('name') or validated_data.get('name')
        validated_data['category_name'] = infer_category_name(cat_val, name_val)

        brand_val = input_data.get('brand') or input_data.get('brand_name') or validated_data.get('brand_name')
        if brand_val:
            validated_data['brand_name'] = str(brand_val)
        self._apply_variant_attrs(validated_data, input_data)
        return super().create(validated_data)

    def update(self, instance, validated_data):
        request = self.context.get('request')
        input_data = request.data if request else {}
        cat_val = input_data.get('category') or input_data.get('category_name') or validated_data.get('category_name') or instance.category_name
        name_val = input_data.get('name') or validated_data.get('name') or instance.name
        validated_data['category_name'] = infer_category_name(cat_val, name_val)

        brand_val = input_data.get('brand') or input_data.get('brand_name') or validated_data.get('brand_name') or instance.brand_name
        if brand_val:
            validated_data['brand_name'] = str(brand_val)
        self._apply_variant_attrs(validated_data, input_data)
        return super().update(instance, validated_data)


class ProductViewSet(viewsets.ModelViewSet):
    queryset = Product.objects.all().prefetch_related('extra_barcodes').order_by('-created_at')
    serializer_class = ProductSerializer
    authentication_classes = []
    permission_classes = [permissions.AllowAny]
    pagination_class = ProductPagination

    def get_queryset(self):
        qs = super().get_queryset()
        search = self.request.query_params.get('search', '').strip()
        if search:
            qs = qs.filter(
                Q(name__icontains=search) | Q(sku__icontains=search) |
                Q(barcode__icontains=search) | Q(brand_name__icontains=search) |
                Q(category_name__icontains=search) | Q(supplier_name__icontains=search) |
                Q(extra_barcodes__code__icontains=search)
            ).distinct()
        has_barcode = self.request.query_params.get('has_barcode')
        if has_barcode is not None:
            missing = Q(barcode__isnull=True) | Q(barcode='')
            qs = qs.filter(missing) if has_barcode.lower() in ('false', '0') else qs.exclude(missing)
        return qs

    def paginate_queryset(self, queryset):
        if self.request.query_params.get('page') is None and self.request.query_params.get('page_size') is None:
            return None
        return super().paginate_queryset(queryset)

    def destroy(self, request, *args, **kwargs):
        instance = self.get_object()
        instance.hard_delete()
        return Response(status=status.HTTP_204_NO_CONTENT)

    def perform_create(self, serializer):
        super().perform_create(serializer)
        if serializer.instance.barcode:
            BarcodeHistory.objects.create(
                product=serializer.instance,
                old_barcode=None,
                new_barcode=serializer.instance.barcode,
                changed_by=self.request.data.get('changed_by') or 'Administrator',
                reason=self.request.data.get('barcode_change_reason') or 'Created with product'
            )

    def perform_update(self, serializer):
        old_barcode = serializer.instance.barcode
        super().perform_update(serializer)
        new_barcode = serializer.instance.barcode
        if old_barcode != new_barcode:
            BarcodeHistory.objects.create(
                product=serializer.instance,
                old_barcode=old_barcode,
                new_barcode=new_barcode,
                changed_by=self.request.data.get('changed_by') or 'Administrator',
                reason=self.request.data.get('barcode_change_reason') or ('Cleared' if not new_barcode else 'Manual update')
            )

    @action(detail=True, methods=['post'], url_path='generate_barcode')
    def generate_barcode(self, request, pk=None):
        product = self.get_object()
        force = bool(request.data.get('force'))

        if product.barcode and not force:
            return Response(
                {'detail': 'Product already has a barcode. Pass force=true to regenerate.'},
                status=status.HTTP_409_CONFLICT
            )

        old_barcode = product.barcode
        reason = request.data.get('reason') or ('Regenerated' if old_barcode else 'Initial generation')
        changed_by = request.data.get('changed_by') or 'Administrator'

        new_barcode = None
        last_error = None
        for _attempt in range(3):
            candidate = reserve_barcodes(count=1)[0]
            try:
                with transaction.atomic():
                    product.barcode = candidate
                    product.save(update_fields=['barcode'])
                new_barcode = candidate
                break
            except IntegrityError as exc:
                last_error = exc
                continue

        if new_barcode is None:
            return Response(
                {'detail': f'Could not generate a unique barcode: {last_error}'},
                status=status.HTTP_500_INTERNAL_SERVER_ERROR
            )

        BarcodeHistory.objects.create(
            product=product, old_barcode=old_barcode, new_barcode=new_barcode,
            changed_by=changed_by, reason=reason
        )
        return Response(ProductSerializer(product, context={'request': request}).data)

    @action(detail=False, methods=['post'], url_path='generate_missing_barcodes')
    def generate_missing_barcodes(self, request):
        product_ids = request.data.get('product_ids')
        qs = Product.objects.filter(Q(barcode__isnull=True) | Q(barcode=''))
        if product_ids:
            qs = qs.filter(id__in=product_ids)
        products = list(qs)

        if not products:
            return Response({'generated': 0, 'products': []})

        codes = reserve_barcodes(count=len(products))
        changed_by = request.data.get('changed_by') or 'Administrator'
        history_rows = []
        for product, code in zip(products, codes):
            product.barcode = code
            history_rows.append(BarcodeHistory(
                product=product, old_barcode=None, new_barcode=code,
                changed_by=changed_by, reason='Bulk generation'
            ))

        with transaction.atomic():
            Product.objects.bulk_update(products, ['barcode'])
            BarcodeHistory.objects.bulk_create(history_rows)

        return Response({
            'generated': len(products),
            'products': ProductSerializer(products, many=True, context={'request': request}).data
        })

    @action(detail=False, methods=['post'], url_path='next_barcode_candidate')
    def next_barcode_candidate(self, request):
        code = reserve_barcodes(count=1)[0]
        return Response({'barcode': code})

    @action(detail=False, methods=['post'], url_path='next_ean13_candidate')
    def next_ean13_candidate(self, request):
        """Next barcode in the 13-digit EAN-13 series (used by the Product Master dialog)."""
        code = reserve_ean13(count=1)[0]
        return Response({'barcode': code})

    @action(detail=True, methods=['post'], url_path='label_barcode_series')
    def label_barcode_series(self, request, pk=None):
        """Return `count` distinct barcodes for one product, minting more as needed.

        Label #1 is always the product's own `barcode`; the rest come from a
        persisted EAN-13 series (ProductBarcode) so every printed tag is unique
        while still resolving back to this product when scanned. Re-printing the
        same or a smaller quantity reuses the existing series — no new codes.
        """
        product = self.get_object()
        try:
            count = int(request.data.get('count') or 1)
        except (TypeError, ValueError):
            count = 1
        count = max(1, min(count, 1000))

        if not product.barcode:
            minted = reserve_ean13(count=1)[0]
            product.barcode = minted
            product.save(update_fields=['barcode'])
            BarcodeHistory.objects.create(
                product=product, old_barcode=None, new_barcode=minted,
                changed_by=request.data.get('changed_by') or 'Administrator',
                reason='Label printing',
            )

        existing = list(
            product.extra_barcodes.order_by('created_at').values_list('code', flat=True)
        )
        need = (count - 1) - len(existing)
        attempts = 0
        while need > 0 and attempts < 5:
            attempts += 1
            for candidate in reserve_ean13(count=need):
                if candidate == product.barcode or Product.objects.filter(barcode=candidate).exists():
                    continue
                _obj, created = ProductBarcode.objects.get_or_create(
                    code=candidate, defaults={'product': product}
                )
                if created:
                    existing.append(candidate)
            need = (count - 1) - len(existing)

        series = [product.barcode] + existing[: max(0, count - 1)]
        return Response({'barcodes': series})

    @action(detail=True, methods=['post'], url_path='register_barcode')
    def register_barcode(self, request, pk=None):
        """Persist a manually-entered barcode so a later scan resolves to this product.

        Used by the label print dialog's "manual override" field: the typed value
        is printed on the tag, so it has to be scannable afterwards. If the product
        has no primary barcode yet the code becomes the primary; otherwise it is
        stored as an additional scan-in code (ProductBarcode), unless it already
        belongs to a product.
        """
        product = self.get_object()
        code = (request.data.get('code') or '').strip()
        if not code:
            return Response({'detail': 'code is required'}, status=status.HTTP_400_BAD_REQUEST)

        if product.barcode == code or product.extra_barcodes.filter(code=code).exists():
            return Response({'registered': True, 'primary': product.barcode == code})

        clash = (
            Product.objects.filter(barcode=code).exclude(pk=product.pk).first()
            or ProductBarcode.objects.filter(code=code).exclude(product=product).first()
        )
        if clash:
            owner = clash if isinstance(clash, Product) else clash.product
            return Response(
                {'detail': f'Barcode "{code}" already belongs to {owner.name}.'},
                status=status.HTTP_409_CONFLICT,
            )

        if not product.barcode:
            product.barcode = code
            product.save(update_fields=['barcode'])
            BarcodeHistory.objects.create(
                product=product, old_barcode=None, new_barcode=code,
                changed_by=request.data.get('changed_by') or 'Administrator',
                reason='Manual barcode (label print)',
            )
            return Response({'registered': True, 'primary': True})

        ProductBarcode.objects.get_or_create(code=code, defaults={'product': product})
        return Response({'registered': True, 'primary': False})

    @action(detail=False, methods=['get'], url_path='resolve_barcode')
    def resolve_barcode(self, request):
        """Look up a scanned code against primary barcodes AND printed label series."""
        code = (request.query_params.get('code') or '').strip()
        if not code:
            return Response({'found': False, 'product': None})
        product = (
            Product.objects
            .filter(Q(barcode=code) | Q(extra_barcodes__code=code))
            .prefetch_related('extra_barcodes')
            .first()
        )
        if not product:
            return Response({'found': False, 'product': None})
        return Response({
            'found': True,
            'product': ProductSerializer(product, context={'request': request}).data,
        })

    @action(detail=False, methods=['get'], url_path='check_barcode')
    def check_barcode(self, request):
        barcode = (request.query_params.get('barcode') or '').strip()
        exclude_id = request.query_params.get('exclude_id')
        if not barcode:
            return Response({'exists': False, 'product_name': None})
        qs = Product.objects.filter(Q(barcode=barcode) | Q(extra_barcodes__code=barcode))
        if exclude_id:
            qs = qs.exclude(id=exclude_id)
        existing = qs.first()
        return Response({'exists': bool(existing), 'product_name': existing.name if existing else None})

    @action(detail=True, methods=['get'], url_path='barcode_history')
    def barcode_history(self, request, pk=None):
        product = self.get_object()
        history = product.barcode_history.all()
        return Response([
            {
                'id': str(h.id),
                'old_barcode': h.old_barcode,
                'new_barcode': h.new_barcode,
                'changed_by': h.changed_by,
                'reason': h.reason,
                'created_at': h.created_at,
            } for h in history
        ])

    @action(detail=False, methods=['delete', 'post'], url_path='clear-all')
    def clear_all(self, request):
        from rest_framework.response import Response
        from rest_framework import status
        from django.apps import apps
        
        target_apps = [
            'products', 'inventory', 'purchasing', 'sales', 
            'accounts', 'financial', 'masters', 'company'
        ]

        for app_name in target_apps:
            try:
                app_config = apps.get_app_config(app_name)
                for model in app_config.get_models():
                    try:
                        if hasattr(model, 'all_objects'):
                            try:
                                model.all_objects.all().hard_delete()
                            except Exception:
                                model.all_objects.all().delete()
                        else:
                            model.objects.all().delete()
                    except Exception:
                        pass
            except Exception:
                pass

        return Response({
            'message': 'All project database records cleared successfully across all modules.'
        }, status=status.HTTP_200_OK)
