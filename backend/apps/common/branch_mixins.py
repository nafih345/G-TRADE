"""DRF mixin that makes a ModelViewSet branch-aware.

Put BranchScopedViewSetMixin first in the bases of a ModelViewSet whose model has a
`branch` FK. When Multi-Branch Mode is ON it:
  * filters list/detail querysets to the request's active branch, so every detail route
    (retrieve, update, delete, custom actions using get_object) answers 404 for another branch's
    row — or an unassigned one, for a branch-restricted user (P1-Q2),
  * stamps `branch` on newly created rows (via _branch_stamp_kwargs),
  * never trusts a client-supplied branch: a `branch` (or a warehouse / parent document that
    belongs to a branch, see branch_parent_fields) outside the caller's branches is 403, on create
    and on update, before anything is written (P1 / N4),
  * returns 403 when the caller requested a branch they cannot access (X-Branch-Id),
  * lets an admin pass `?branches=all` to see every branch at once (combined reports).

When Multi-Branch Mode is OFF it is a near no-op: the active branch is always the default
branch, so filtering/stamping keep behaviour identical to the single-branch system.

Viewsets that define their own perform_create should merge _branch_stamp_kwargs(serializer)
into their serializer.save(...) call; viewsets without one get stamping for free. Updates are
checked in update() (which partial_update goes through), so a viewset's own perform_update
needs nothing extra.
"""

import logging

from django.db.utils import OperationalError, ProgrammingError
from rest_framework.exceptions import PermissionDenied

from apps.common.branch_context import (
    BRANCH_DENIED, get_active_branch, get_allowed_branch_ids, is_branch_restricted, require_branch_permitted,
    resolve_requested_branch,
)

logger = logging.getLogger('django')


def _is_uuid(value):
    import uuid
    try:
        uuid.UUID(str(value))
        return True
    except (TypeError, ValueError, AttributeError):
        return False


class BranchScopedViewSetMixin:
    branch_field = 'branch'
    # FKs on the model whose target belongs to a branch (warehouse.branch, invoice.branch, ...):
    # a client may only point at one in a branch it may use. Fields the model lacks are skipped.
    branch_parent_fields = ('warehouse',)
    # P1 Tasks 5/6: modules whose legacy rows may be Unassigned (branch NULL) after the
    # evidence-only backfill show those rows to unrestricted users alongside the working branch.
    show_unassigned_to_unrestricted = False

    def _wants_all_branches(self):
        val = (self.request.query_params.get('branches') or '').lower()
        return val == 'all' and getattr(self.request, 'is_branch_admin', False)

    def _model_has_branch(self, model):
        """True only for a real FK to company.Branch: eye examinations and appointments keep a
        free-text `branch` name, which a `branch_id` filter would 500 on (multi-branch dashboard)."""
        try:
            field = model._meta.get_field(self.branch_field)
        except Exception:
            return False
        related = getattr(field, 'related_model', None)
        return bool(field.many_to_one and related is not None and related._meta.label == 'company.Branch')

    def _scoped_model(self):
        queryset = getattr(self, 'queryset', None)
        return queryset.model if queryset is not None else super().get_queryset().model

    # ---- reads ---------------------------------------------------------------------------------

    def get_queryset(self):
        qs = super().get_queryset()
        active = get_active_branch(self.request)  # raises 403 for an off-limits X-Branch-Id

        if not getattr(self.request, 'multi_branch_enabled', False):
            return qs
        if not self._model_has_branch(qs.model):
            return qs
        try:
            return self._branch_scoped_queryset(qs, active)
        except (ProgrammingError, OperationalError):
            # The branch columns/tables aren't in the database yet (schema behind the
            # deployed code). Fall back to the unscoped queryset so the app keeps working
            # instead of 500ing; the missing migration is reported by /api/health/.
            logger.exception(
                "BranchScopedViewSetMixin: branch schema missing for %s; serving unscoped.",
                qs.model.__name__,
            )
            return super().get_queryset()

    def _branch_scoped_queryset(self, qs, active):
        field = self.branch_field
        allowed = get_allowed_branch_ids(self.request)
        if self._wants_all_branches():
            return qs.filter(**{f'{field}_id__in': allowed}) if allowed is not None else qs

        explicit = self.request.query_params.get(field)
        if explicit:
            if (allowed is not None and str(explicit) not in allowed) or not _is_uuid(explicit):
                return qs.none()
            return qs.filter(**{f'{field}_id': explicit})
        if active is not None:
            if allowed is not None and str(active.pk) not in allowed:
                return qs.none()  # never happens via the middleware; fail closed if it does
            if allowed is None and self.show_unassigned_to_unrestricted:
                # Legacy rows the evidence-only backfill left Unassigned stay in an unrestricted
                # user's working view (never in a restricted user's: P1-Q2).
                from django.db.models import Q
                return qs.filter(Q(**{f'{field}_id': active.id}) | Q(**{f'{field}__isnull': True}))
            return qs.filter(**{f'{field}_id': active.id})
        if allowed is not None:
            # A restricted user with no working branch: only their permitted branches (none, if
            # they have none) — never the unscoped table.
            return qs.filter(**{f'{field}_id__in': list(allowed)})
        return qs

    def branch_row_visible(self, pk):
        """Is row `pk` inside this caller's branch scope? EditApprovalMixin asks before it shows an
        approval prompt (which names the record) — another branch's row must look missing."""
        if not getattr(self.request, 'multi_branch_enabled', False):
            return True
        return self.get_queryset().filter(pk=pk).exists()

    # ---- writes --------------------------------------------------------------------------------

    def _check_branch_input(self, model, updating=False):
        """Validate every branch reference the client sent, before anything is written:
        `branch` itself (400 unknown / other tenant, 403 not permitted; a restricted user may not
        un-assign a row either) and each parent FK in branch_parent_fields (403 when the parent
        belongs to a branch the caller may not use, or to none)."""
        data = getattr(self.request, 'data', None)
        if not hasattr(data, 'get'):
            return
        if self.branch_field in data:
            value = data.get(self.branch_field)
            if value in (None, ''):
                if updating and is_branch_restricted(self.request):
                    raise PermissionDenied('You cannot remove the branch from this record.')
            else:
                resolve_requested_branch(self.request, value)
        if not is_branch_restricted(self.request):
            return
        for name in self.branch_parent_fields:
            value = data.get(name) if name in data else None
            if value in (None, '') or not _is_uuid(getattr(value, 'pk', value)):
                continue  # nothing / malformed: the serializer answers that
            try:
                related = model._meta.get_field(name).related_model
            except Exception:
                continue
            if related is None or not any(f.name == 'branch' for f in related._meta.get_fields()):
                continue
            manager = getattr(related, 'all_objects', related.objects)
            parent = manager.filter(pk=str(getattr(value, 'pk', value))).values('branch_id').first()
            if parent is not None:  # missing (or another tenant's): the serializer answers 400
                require_branch_permitted(self.request, parent['branch_id'],
                                         f'The selected {name.replace("_", " ")} belongs to a branch you cannot use.')

    def _branch_stamp_kwargs(self, serializer):
        active = get_active_branch(self.request)
        model = serializer.Meta.model
        if not self._model_has_branch(model):
            return {}
        self._check_branch_input(model)
        supplied = serializer.validated_data.get(self.branch_field)
        if supplied is not None:
            require_branch_permitted(self.request, supplied.pk)
            return {}
        if active is None:
            if is_branch_restricted(self.request):
                raise PermissionDenied('No branch is assigned to your account, so you cannot create records.')
            return {}
        require_branch_permitted(self.request, active.pk)
        return {self.branch_field: active}

    def perform_create(self, serializer):
        serializer.save(**self._branch_stamp_kwargs(serializer))

    def update(self, request, *args, **kwargs):
        model = self._scoped_model()
        if getattr(request, 'multi_branch_enabled', False) and self._model_has_branch(model):
            get_active_branch(request)
            self._check_branch_input(model, updating=True)
        return super().update(request, *args, **kwargs)


__all__ = ['BranchScopedViewSetMixin', 'BRANCH_DENIED']
