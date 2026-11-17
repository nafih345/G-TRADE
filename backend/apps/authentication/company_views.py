"""Phase 2 — company selection for a signed-in user.

    GET  /api/auth/companies/        the companies this user can work in (home + active memberships)
    POST /api/auth/switch-company/   {tenant_id} → a NEW session and token pair scoped to that company

The company id in the body is only a request. The server checks the user's membership (same
organization, active membership, active company, a role allowed to sign in), ends the current
session, and signs the new company into the new tokens. Nothing from the browser is trusted as
the active company: every later request is scoped by the signed `tenant_id` claim and re-checked
against the membership (tenant_context.check_user_tenant).
"""
from django.conf import settings
from django.contrib.auth import get_user_model
from rest_framework import permissions, status
from rest_framework.response import Response
from rest_framework.throttling import ScopedRateThrottle
from rest_framework.views import APIView

from apps.common import tenancy
from apps.common.models import Tenant
from apps.common.organizations import accessible_companies, can_access_company, company_role, is_org_admin
from apps.security import policy
from apps.security.audit import log_event
from apps.security.models import AuthSession

from .serializers import login_user_payload

User = get_user_model()

FORBIDDEN = {'detail': 'You do not have access to this company.', 'code': 'company_forbidden'}


def _token(request):
    token = getattr(request, 'auth', None)
    return token if token is not None and hasattr(token, 'get') else None


class CompaniesView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def get(self, request):
        token = _token(request)
        user = User.objects.select_related('tenant').get(pk=request.user.pk)
        active = tenancy.current_tenant_id()
        companies = [] if token is not None and token.get('workspace') else accessible_companies(user)
        for c in companies:
            c['is_active_company'] = c['tenant_id'] == active
        return Response({'active_tenant_id': active, 'companies': companies, 'is_org_admin': is_org_admin(user),
                         'workspace': bool(token is not None and token.get('workspace'))})


class SwitchCompanyView(APIView):
    permission_classes = [permissions.IsAuthenticated]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = 'login'

    def post(self, request):
        token = _token(request)
        if token is not None and token.get('workspace'):
            return Response({'detail': 'Leave the client workspace before switching company.',
                             'code': 'workspace'}, status=status.HTTP_400_BAD_REQUEST)
        try:
            target_id = int(request.data.get('tenant_id'))
        except (TypeError, ValueError):
            return Response({'detail': 'Pick a company.', 'code': 'invalid'}, status=status.HTTP_400_BAD_REQUEST)

        # The real account (request.user may be a read-only member copy of another company).
        user = User.objects.select_related('tenant').filter(pk=request.user.pk, is_active=True).first()
        tenant = Tenant.objects.filter(pk=target_id).first()
        current = tenancy.current_tenant_id()
        if user is None or tenant is None or not can_access_company(user, tenant.pk):
            # Same answer whether the company does not exist or belongs to someone else.
            log_event('COMPANY_SWITCH_DENIED', 'AUTH', f'{request.user.username} was refused company #{target_id}',
                      request=request, user=request.user, severity='WARNING',
                      details={'from_tenant': current, 'to_tenant': target_id})
            return Response(FORBIDDEN, status=status.HTTP_403_FORBIDDEN)
        if not tenant.is_effectively_active:
            return Response({'detail': f'{tenant.name} is disabled.', 'code': 'company_inactive'},
                            status=status.HTTP_403_FORBIDDEN)
        role = company_role(user, tenant.pk)
        if role not in settings.LOGIN_ENABLED_ROLES:
            return Response({'detail': 'Your role in this company is not allowed to sign in.',
                             'code': 'role_not_enabled'}, status=status.HTTP_403_FORBIDDEN)

        from apps.common.tenant_onboarding import heal_tenant_defaults
        heal_tenant_defaults(tenant)
        old_sid = token.get('sid') if token is not None else None
        two_factor = bool(old_sid and AuthSession.objects.filter(pk=old_sid, two_factor_verified=True).exists())
        tokens = policy.issue_tokens(user, request, two_factor=two_factor, company_tenant_id=tenant.pk)
        if old_sid:
            # The previous company's session ends: its tokens stop working everywhere.
            policy.end_session(old_sid, 'SWITCH')  # end_reason holds 10 chars
        log_event('COMPANY_SWITCHED', 'AUTH', f'{user.username} switched to {tenant.name}',
                  request=request, user=user,
                  details={'from_tenant': current, 'to_tenant': tenant.pk, 'role': role,
                           'session_id': tokens['session_id']})
        from apps.common.tenant_onboarding import log_event as tenant_log
        tenant_log(tenant, 'COMPANY_SWITCH_IN', user, from_tenant=current, role=role)

        payload = login_user_payload(user, tenant_id=tenant.pk)
        return Response({'access': tokens['access'], 'refresh': tokens['refresh'], 'user': payload,
                         'company': {'tenant_id': tenant.pk, 'name': tenant.name, 'code': tenant.code,
                                     'role': role, 'is_home': tenant.pk == user.tenant_id},
                         'companies': accessible_companies(user),
                         'session': {'inactivity_timeout_minutes': policy.get_settings().inactivity_timeout_minutes}})
