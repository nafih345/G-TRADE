"""Tax Configuration (Settings → Business & Localization → Tax Configuration) over masters.Tax.

    GET    /api/company/tax-config/          every tax (active and inactive) + how many products use it
    POST   /api/company/tax-config/          create
    PUT    /api/company/tax-config/<id>/     edit (rate changes never touch completed documents —
                                             their lines keep the rate they were billed at)
    DELETE /api/company/tax-config/<id>/     only when no product uses it; otherwise deactivate

/api/masters/taxes/ stays as the read endpoint other screens already use.
"""
from decimal import Decimal, InvalidOperation

from django.db import transaction
from django.db.models import Count, Q
from rest_framework import status
from rest_framework.response import Response

from apps.masters.models import Tax
from .localization import OpenReadsSettingsView, audit

TAX_TYPES = {k for k, _ in Tax.TAX_TYPES}
TREATMENTS = {k for k, _ in Tax.TREATMENTS}
CATEGORIES = {k for k, _ in Tax.CATEGORIES}
ZERO_CATEGORIES = {'ZERO_RATED', 'EXEMPT', 'NIL_RATED', 'NON_TAXABLE'}
FIELDS = ('name', 'rate', 'tax_type', 'treatment', 'category', 'applies_to_sales', 'applies_to_purchases',
          'is_active', 'is_default', 'description')


def _queryset():
    return Tax.objects.annotate(product_count=Count('products', filter=Q(products__is_deleted=False)))


def serialize(t):
    return {
        'id': str(t.pk), 'name': t.name, 'rate': str(Decimal(t.rate).quantize(Decimal('0.01'))),
        'tax_type': t.tax_type, 'treatment': t.treatment, 'category': t.category,
        'applies_to_sales': t.applies_to_sales, 'applies_to_purchases': t.applies_to_purchases,
        'is_active': t.is_active, 'is_default': t.is_default, 'description': t.description,
        'product_count': getattr(t, 'product_count', None),
    }


def validate(data, current=None, exclude_pk=None):
    cur = current or {'name': '', 'rate': None, 'tax_type': 'GST', 'treatment': 'EXCLUSIVE', 'category': 'STANDARD',
                      'applies_to_sales': True, 'applies_to_purchases': True, 'is_active': True,
                      'is_default': False, 'description': ''}
    clean, errors = {}, {}
    if 'name' in data or current is None:
        name = str(data.get('name') or '').strip()
        if not name:
            errors['name'] = 'Enter a tax name.'
        elif len(name) > 50:
            errors['name'] = 'Use at most 50 characters.'
        elif Tax.objects.filter(name__iexact=name).exclude(pk=exclude_pk).exists():
            errors['name'] = 'A tax with this name already exists.'
        else:
            clean['name'] = name
    if 'rate' in data or current is None:
        try:
            rate = Decimal(str(data.get('rate')).strip())
            if not rate.is_finite():
                raise InvalidOperation
        except (InvalidOperation, ValueError, TypeError):
            errors['rate'] = 'Enter the rate as a percentage, e.g. 18 or 0.'
        else:
            if not Decimal('0') <= rate <= Decimal('100'):
                errors['rate'] = 'The rate must be between 0 and 100.'
            elif rate != rate.quantize(Decimal('0.01')):
                errors['rate'] = 'Use at most 2 decimal places.'
            else:
                clean['rate'] = rate
    for key, allowed in (('tax_type', TAX_TYPES), ('treatment', TREATMENTS), ('category', CATEGORIES)):
        if key in data:
            if data[key] not in allowed:
                errors[key] = 'Choose a supported option.'
            else:
                clean[key] = data[key]
    for key in ('applies_to_sales', 'applies_to_purchases', 'is_active', 'is_default'):
        if key in data:
            if not isinstance(data[key], bool):
                errors[key] = 'Must be on or off.'
            else:
                clean[key] = data[key]
    if 'description' in data:
        clean['description'] = str(data.get('description') or '').strip()[:200]

    merged = {**cur, **clean}
    if 'rate' not in errors and merged['rate'] is not None:
        if merged['category'] in ZERO_CATEGORIES and Decimal(merged['rate']) != 0:
            errors['rate'] = 'Zero-rated, exempt, nil-rated and non-taxable taxes must have a 0% rate.'
        elif merged['category'] == 'STANDARD' and Decimal(merged['rate']) == 0:
            errors['category'] = 'A 0% tax must use the Zero rated, Exempt, Nil rated or Non-taxable category.'
    if not (merged['applies_to_sales'] or merged['applies_to_purchases']):
        errors['applies_to_sales'] = 'Apply the tax to sales, purchases or both.'
    if merged['is_default'] and not merged['is_active']:
        errors['is_default'] = 'An inactive tax cannot be the default.'
    return clean, errors


def _bad(errors):
    return Response({'detail': 'Please fix the highlighted fields.', 'errors': errors},
                    status=status.HTTP_400_BAD_REQUEST)


def _clear_other_defaults(tax):
    if tax.is_default:
        Tax.objects.filter(is_default=True).exclude(pk=tax.pk).update(is_default=False)


class TaxConfigListView(OpenReadsSettingsView):
    def get(self, request):
        return Response([serialize(t) for t in _queryset().order_by('-is_active', 'rate', 'name')])

    def post(self, request):
        data = request.data if isinstance(request.data, dict) else {}
        clean, errors = validate(data)
        if errors:
            return _bad(errors)
        with transaction.atomic():
            tax = Tax.objects.create(**clean)
            _clear_other_defaults(tax)
            audit(request, 'TAX', 'CREATE', f'Created tax {tax.name} ({tax.rate}%)',
                  {k: [None, str(v)] for k, v in clean.items()})
        return Response(serialize(_queryset().get(pk=tax.pk)), status=status.HTTP_201_CREATED)


class TaxConfigDetailView(OpenReadsSettingsView):
    def _get(self, pk):
        return _queryset().filter(pk=pk).first()

    def put(self, request, pk):
        tax = self._get(pk)
        if tax is None:
            return Response({'detail': 'Tax not found.'}, status=status.HTTP_404_NOT_FOUND)
        data = request.data if isinstance(request.data, dict) else {}
        current = {f: getattr(tax, f) for f in FIELDS}
        clean, errors = validate(data, current, exclude_pk=tax.pk)
        if errors:
            return _bad(errors)
        changes = {k: [str(current[k]), str(v)] for k, v in clean.items() if current[k] != v}
        with transaction.atomic():
            for k, v in clean.items():
                setattr(tax, k, v)
            tax.save()
            _clear_other_defaults(tax)
            if changes:
                audit(request, 'TAX', 'UPDATE', f'Updated tax {tax.name}: {", ".join(sorted(changes))}', changes)
        return Response(serialize(self._get(tax.pk)))

    def delete(self, request, pk):
        tax = self._get(pk)
        if tax is None:
            return Response({'detail': 'Tax not found.'}, status=status.HTTP_404_NOT_FOUND)
        if tax.product_count:
            return Response({'detail': f'{tax.product_count} product(s) use this tax. Deactivate it instead — '
                                       'completed documents keep their billed rate either way.'},
                            status=status.HTTP_409_CONFLICT)
        name = tax.name
        tax.delete()  # soft delete (BaseUUIDModel)
        audit(request, 'TAX', 'DELETE', f'Deleted tax {name}')
        return Response(status=status.HTTP_204_NO_CONTENT)
