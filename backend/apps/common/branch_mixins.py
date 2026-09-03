"""DRF mixin that makes a ModelViewSet branch-aware.

Put BranchScopedViewSetMixin first in the bases of a ModelViewSet whose model has a
`branch` FK. When Multi-Branch Mode is ON it:
  * filters list/detail querysets to the request's active branch,
  * stamps `branch` on newly created rows (via _branch_stamp_kwargs),
  * returns 403 when the caller requested a branch they cannot access,
  * lets an admin pass `?branches=all` to see every branch at once (combined reports).

When Multi-Branch Mode is OFF it is a near no-op: the active branch is always the default
branch, so filtering/stamping keep behaviour identical to the single-branch system.

Viewsets that define their own perform_create should merge _branch_stamp_kwargs(serializer)
into their serializer.save(...) call; viewsets without one get stamping for free.
"""

import logging

from django.db.utils import OperationalError, ProgrammingError

from apps.common.branch_context import get_active_branch, get_allowed_branch_ids

logger = logging.getLogger('django')


class BranchScopedViewSetMixin:
    branch_field = 'branch'

    def _wants_all_branches(self):
        val = (self.request.query_params.get('branches') or '').lower()
        return val == 'all' and getattr(self.request, 'is_branch_admin', False)

    def _model_has_branch(self, model):
        try:
            model._meta.get_field(self.branch_field)
            return True
        except Exception:
            return False

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
        if self._wants_all_branches():
            allowed = get_allowed_branch_ids(self.request)
            return qs.filter(**{f'{self.branch_field}_id__in': allowed}) if allowed is not None else qs

        explicit = self.request.query_params.get(self.branch_field)
        allowed = get_allowed_branch_ids(self.request)
        if explicit:
            if allowed is not None and str(explicit) not in allowed:
                return qs.none()
            return qs.filter(**{f'{self.branch_field}_id': explicit})
        if active is not None:
            return qs.filter(**{f'{self.branch_field}_id': active.id})
        return qs

    def _branch_stamp_kwargs(self, serializer):
        active = get_active_branch(self.request)
        if active is None or not self._model_has_branch(serializer.Meta.model):
            return {}
        if serializer.validated_data.get(self.branch_field) is not None:
            return {}
        return {self.branch_field: active}

    def perform_create(self, serializer):
        serializer.save(**self._branch_stamp_kwargs(serializer))
