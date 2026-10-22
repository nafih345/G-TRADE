"""Custom field definitions (Settings → Business & Localization → Custom Fields).

    GET    /api/company/custom-fields/[?module=PRODUCT]
    POST   /api/company/custom-fields/
    PUT    /api/company/custom-fields/<id>/
    DELETE /api/company/custom-fields/<id>/
"""
import re

from django.db import transaction
from rest_framework import status
from rest_framework.response import Response

from .localization import OpenReadsSettingsView, audit
from .models import CustomField

FIELD_TYPES = {k for k, _ in CustomField.FIELD_TYPES}
MODULES = {k for k, _ in CustomField.MODULES}
FIELDS = ('name', 'key', 'field_type', 'module', 'options', 'is_required', 'is_active', 'sort_order')


def serialize(f):
    return {'id': f.pk, **{k: getattr(f, k) for k in FIELDS}}


def slugify_key(name):
    return re.sub(r'[^a-z0-9]+', '_', (name or '').lower()).strip('_')[:60]


def validate(data, current=None, exclude_pk=None):
    cur = current or {'name': '', 'key': '', 'field_type': 'TEXT', 'module': '', 'options': [],
                      'is_required': False, 'is_active': True, 'sort_order': 0}
    clean, errors = {}, {}
    if 'name' in data or current is None:
        name = str(data.get('name') or '').strip()
        if not name:
            errors['name'] = 'Enter a field name.'
        elif len(name) > 60:
            errors['name'] = 'Use at most 60 characters.'
        else:
            clean['name'] = name
    if 'field_type' in data or current is None:
        if data.get('field_type') not in FIELD_TYPES:
            errors['field_type'] = 'Choose a field type.'
        else:
            clean['field_type'] = data['field_type']
    if 'module' in data or current is None:
        if data.get('module') not in MODULES:
            errors['module'] = 'Choose the module this field belongs to.'
        else:
            clean['module'] = data['module']
    for key in ('is_required', 'is_active'):
        if key in data:
            if not isinstance(data[key], bool):
                errors[key] = 'Must be on or off.'
            else:
                clean[key] = data[key]
    if 'sort_order' in data:
        try:
            clean['sort_order'] = max(0, int(data['sort_order'] or 0))
        except (TypeError, ValueError):
            errors['sort_order'] = 'Enter a whole number.'
    if 'options' in data:
        opts = data['options']
        if not isinstance(opts, list):
            errors['options'] = 'Expected a list of choices.'
        else:
            out = []
            for o in opts:
                o = str(o or '').strip()[:80]
                if o and o.lower() not in {x.lower() for x in out}:
                    out.append(o)
            clean['options'] = out

    merged = {**cur, **clean}
    if merged['field_type'] == 'DROPDOWN' and not merged['options'] and 'options' not in errors:
        errors['options'] = 'Add at least one choice for a dropdown.'
    if merged['field_type'] != 'DROPDOWN':
        clean['options'] = []
    if 'name' in clean or 'module' in clean:
        key = slugify_key(merged['name']) if current is None or 'name' in clean else cur['key']
        if not key:
            errors.setdefault('name', 'Use at least one letter or digit.')
        elif CustomField.objects.filter(module=merged['module'], key=key).exclude(pk=exclude_pk).exists():
            errors.setdefault('name', 'This module already has a field with this name.')
        else:
            clean['key'] = key
    return clean, errors


def _bad(errors):
    return Response({'detail': 'Please fix the highlighted fields.', 'errors': errors},
                    status=status.HTTP_400_BAD_REQUEST)


class CustomFieldListView(OpenReadsSettingsView):
    def get(self, request):
        qs = CustomField.objects.all()
        module = request.query_params.get('module')
        if module:
            qs = qs.filter(module=module)
        return Response([serialize(f) for f in qs])

    def post(self, request):
        data = request.data if isinstance(request.data, dict) else {}
        clean, errors = validate(data)
        if errors:
            return _bad(errors)
        with transaction.atomic():
            f = CustomField.objects.create(**clean)
            audit(request, 'CUSTOM_FIELD', 'CREATE', f'Added custom field {f.name} ({f.module})')
        return Response(serialize(f), status=status.HTTP_201_CREATED)


class CustomFieldDetailView(OpenReadsSettingsView):
    def put(self, request, pk):
        f = CustomField.objects.filter(pk=pk).first()
        if f is None:
            return Response({'detail': 'Custom field not found.'}, status=status.HTTP_404_NOT_FOUND)
        data = request.data if isinstance(request.data, dict) else {}
        current = {k: getattr(f, k) for k in FIELDS}
        clean, errors = validate(data, current, exclude_pk=f.pk)
        if errors:
            return _bad(errors)
        changes = {k: [current[k], v] for k, v in clean.items() if current[k] != v}
        with transaction.atomic():
            for k, v in clean.items():
                setattr(f, k, v)
            f.save()
            if changes:
                audit(request, 'CUSTOM_FIELD', 'UPDATE', f'Updated custom field {f.name}', changes)
        return Response(serialize(f))

    def delete(self, request, pk):
        f = CustomField.objects.filter(pk=pk).first()
        if f is None:
            return Response({'detail': 'Custom field not found.'}, status=status.HTTP_404_NOT_FOUND)
        name = f.name
        f.delete()
        audit(request, 'CUSTOM_FIELD', 'DELETE', f'Deleted custom field {name}')
        return Response(status=status.HTTP_204_NO_CONTENT)
