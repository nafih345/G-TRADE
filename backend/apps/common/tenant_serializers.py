"""Keep DRF's friendly uniqueness errors after uniques became per-tenant.

`code = CharField(unique=True)` used to give every ModelSerializer a UniqueValidator, so a
duplicate came back as a 400 "already exists". Those fields are now
UniqueConstraint(fields=['tenant', 'code']), and DRF skips a unique-together check whose fields
the serializer doesn't all expose — `tenant` never is (editable=False) — so a duplicate would
surface as an IntegrityError (500) instead. install() restores the old checks:

  * ('tenant', X) constraints  -> a UniqueValidator on X, exactly what unique=True produced;
  * ('tenant', X, Y, ...)      -> the unique-together check on (X, Y, ...).

Both validate against model._default_manager, which is tenant-scoped, so "already exists"
means "already exists for this tenant".
"""
from rest_framework import serializers
from rest_framework.validators import UniqueValidator

_installed = False


def _is_tenant_owned(model):
    from apps.common.models import TenantOwnedModel
    return isinstance(model, type) and issubclass(model, TenantOwnedModel)


def tenant_unique_fields(model):
    """Field names X with an unconditional UniqueConstraint(fields=['tenant', X])."""
    from django.db import models
    out = set()
    for constraint in model._meta.constraints:
        if (isinstance(constraint, models.UniqueConstraint) and constraint.condition is None
                and len(constraint.fields) == 2 and constraint.fields[0] == 'tenant'):
            out.add(constraint.fields[1])
    return out


def install():
    global _installed
    if _installed:
        return
    _installed = True
    base = serializers.ModelSerializer
    orig_build_standard_field = base.build_standard_field
    orig_constraints = base.get_unique_together_constraints

    def build_standard_field(self, field_name, model_field):
        field_class, field_kwargs = orig_build_standard_field(self, field_name, model_field)
        model = getattr(model_field, 'model', None)
        if (_is_tenant_owned(model) and not field_kwargs.get('read_only')
                and model_field.name in tenant_unique_fields(model)):
            field_kwargs['validators'] = [*field_kwargs.get('validators', []),
                                          UniqueValidator(queryset=model._default_manager)]
        return field_class, field_kwargs

    def get_unique_together_constraints(self, model):
        for fields, queryset in orig_constraints(self, model):
            if _is_tenant_owned(model) and 'tenant' in fields:
                fields = tuple(f for f in fields if f != 'tenant')
                if len(fields) < 2:
                    continue  # single field: handled by build_standard_field
            yield fields, queryset

    base.build_standard_field = build_standard_field
    base.get_unique_together_constraints = get_unique_together_constraints
