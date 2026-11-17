"""Phase 2 — organization administration and consolidated (read-only) summaries.

    GET   /api/organization/                                    the caller's organization + its companies
    POST  /api/organization/companies/                          create a company {name, branch_name?,
                                                                copy_from?, sections?}
    PATCH /api/organization/companies/<id>/                     rename {name}
    GET   /api/organization/companies/<id>/members/             memberships of that company
    POST  /api/organization/companies/<id>/members/             grant / change {user_id, role, is_active?,
                                                                all_branches?, branch_ids?, default_branch_id?}
    GET   /api/organization/companies/<id>/branches/            branches (for the membership form)
    POST  /api/organization/companies/<id>/copy-masters/        {source_tenant_id, sections}
    GET   /api/organization/users/                              users of the organization (any company)
    GET   /api/organization/reports/sales-summary/?date_from&date_to[&export=csv]
    GET   /api/organization/reports/stock-summary/[?export=csv]

Organization admins only (organizations.is_org_admin). Writes are sensitive (re-auth policy,
security.policy.SENSITIVE_WRITES). Company deactivation stays in the platform console: it is a
billing / statutory-retention decision, and an organization admin who could deactivate could also
reactivate a company the provider suspended.

Nothing here uses tenancy.unscoped(). Tenant, Organization and memberships are global tables and
are always filtered by the caller's organization; per-company rows are read under
tenancy.use_tenant(<company>) for companies the caller is entitled to.
"""
import csv
import io

from django.http import HttpResponse
from rest_framework import permissions, status
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.common import organizations as orgs
from apps.common import tenancy
from apps.common.models import Organization


class IsOrgAdmin(permissions.BasePermission):
    message = 'Only an organization administrator can do this.'

    def has_permission(self, request, view):
        token = getattr(request, 'auth', None)
        if token is not None and hasattr(token, 'get') and token.get('workspace'):
            return False  # a platform workspace acts for one client, never for its organization
        return orgs.is_org_admin(request.user)


def _error(e):
    body = {'detail': e.message}
    if e.field:
        body['errors'] = {e.field: [e.message]}
    return Response(body, status=e.status)


def _org_id(request):
    return orgs.home_organization_id(request.user)


def _company_row(company, user, members):
    return {'tenant_id': company.pk, 'name': company.name, 'code': company.code,
            'is_active': company.is_effectively_active, 'is_home': company.pk == user.tenant_id,
            'can_access': orgs.can_access_company(user, company.pk), 'members': members.get(company.pk, 0),
            'created_at': company.created_at.isoformat() if company.created_at else None}


class OrganizationView(APIView):
    permission_classes = [permissions.IsAuthenticated, IsOrgAdmin]

    def get(self, request):
        from django.db.models import Count
        from apps.common.models import UserCompanyMembership
        org_id = _org_id(request)
        org = Organization.objects.get(pk=org_id)
        companies = list(orgs.organization_companies(org_id))
        members = dict(UserCompanyMembership.objects.filter(company__organization_id=org_id, is_active=True)
                       .values_list('company_id').annotate(n=Count('id')).values_list('company_id', 'n'))
        home_users = dict(orgs.organization_users(org_id).filter(is_active=True).values_list('tenant_id')
                          .annotate(n=Count('id')).values_list('tenant_id', 'n'))
        rows = []
        for c in companies:
            row = _company_row(c, request.user, members)
            row['home_users'] = home_users.get(c.pk, 0)
            rows.append(row)
        return Response({'organization': {'id': org.pk, 'name': org.name, 'code': org.code,
                                          'max_companies': org.max_companies, 'is_active': org.is_active},
                         'companies': rows, 'can_create': org.is_active and len(companies) < org.max_companies,
                         'active_tenant_id': tenancy.current_tenant_id(),
                         'copy_sections': [{'key': k, 'label': orgs.COPY_SECTION_LABELS[k]} for k in orgs.COPY_SECTIONS],
                         'roles': _roles()})


def _roles():
    from apps.common import module_access
    return [{'key': k, 'label': l} for k, l in module_access.CLIENT_ROLES]


class CompaniesAdminView(APIView):
    permission_classes = [permissions.IsAuthenticated, IsOrgAdmin]

    def post(self, request):
        data = request.data
        try:
            tenant, summary = orgs.create_company(
                request.user, name=data.get('name'), branch_name=str(data.get('branch_name') or '').strip(),
                copy_from=data.get('copy_from') or None, sections=data.get('sections') or [])
        except orgs.OrganizationError as e:
            return _error(e)
        return Response({'tenant_id': tenant.pk, 'name': tenant.name, 'code': tenant.code, 'copied': summary},
                        status=status.HTTP_201_CREATED)


class CompanyAdminView(APIView):
    permission_classes = [permissions.IsAuthenticated, IsOrgAdmin]

    def patch(self, request, tenant_id):
        from apps.common.models import Tenant
        try:
            company = orgs._org_company(_org_id(request), tenant_id)
        except orgs.OrganizationError as e:
            return _error(e)
        name = str(request.data.get('name') or '').strip()
        if not name or len(name) > 150:
            return _error(orgs.OrganizationError('name', 'Give the company a name (at most 150 characters).'))
        if Tenant.objects.filter(name__iexact=name).exclude(pk=company.pk).exists():
            return _error(orgs.OrganizationError('name', f'A company named "{name}" already exists.'))
        old = company.name
        company.name = name
        company.save(update_fields=['name'])
        orgs._audit(company, 'COMPANY_RENAMED', request.user, old=old, new=name)
        return Response({'tenant_id': company.pk, 'name': company.name})


class CompanyMembersView(APIView):
    permission_classes = [permissions.IsAuthenticated, IsOrgAdmin]

    def get(self, request, tenant_id):
        try:
            company = orgs._org_company(_org_id(request), tenant_id)
        except orgs.OrganizationError as e:
            return _error(e)
        return Response({'tenant_id': company.pk, 'name': company.name,
                         'members': orgs.membership_rows(_org_id(request), company)})

    def post(self, request, tenant_id):
        d = request.data
        try:
            orgs.save_membership(request.user, tenant_id, user_id=d.get('user_id'), role=d.get('role'),
                                 is_active=bool(d.get('is_active', True)), all_branches=bool(d.get('all_branches')),
                                 branch_ids=d.get('branch_ids') or [], default_branch_id=d.get('default_branch_id'))
            company = orgs._org_company(_org_id(request), tenant_id)
        except orgs.OrganizationError as e:
            return _error(e)
        return Response({'tenant_id': company.pk, 'members': orgs.membership_rows(_org_id(request), company)})


class CompanyBranchesView(APIView):
    permission_classes = [permissions.IsAuthenticated, IsOrgAdmin]

    def get(self, request, tenant_id):
        from apps.company.models import Branch
        try:
            company = orgs._org_company(_org_id(request), tenant_id)
        except orgs.OrganizationError as e:
            return _error(e)
        with tenancy.use_tenant(company.pk):
            rows = [{'id': str(b['id']), 'name': b['name'], 'code': b['code'], 'is_default': b['is_default']}
                    for b in Branch.objects.filter(is_active=True).order_by('-is_default', 'name')
                    .values('id', 'name', 'code', 'is_default')]
        return Response(rows)


class CopyMastersView(APIView):
    permission_classes = [permissions.IsAuthenticated, IsOrgAdmin]

    def post(self, request, tenant_id):
        try:
            result = orgs.copy_master_data(request.user, request.data.get('source_tenant_id'), tenant_id,
                                           request.data.get('sections') or [])
        except orgs.OrganizationError as e:
            return _error(e)
        return Response(result)


class OrganizationUsersView(APIView):
    permission_classes = [permissions.IsAuthenticated, IsOrgAdmin]

    def get(self, request):
        rows = [{'id': str(u.pk), 'username': u.username, 'name': u.get_full_name() or u.username,
                 'home_tenant_id': u.tenant_id, 'home_company': u.tenant.name if u.tenant_id else '',
                 'role': u.role, 'is_active': u.is_active}
                for u in orgs.organization_users(_org_id(request))]
        return Response(rows)


def _csv(filename, header, rows):
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(header)
    for row in rows:
        # Spreadsheet formula injection guard for text cells.
        writer.writerow([("'" + v) if isinstance(v, str) and v[:1] in ('=', '+', '-', '@') else v for v in row])
    resp = HttpResponse(buf.getvalue(), content_type='text/csv; charset=utf-8')
    resp['Content-Disposition'] = f'attachment; filename="{filename}"'
    return resp


class SalesSummaryView(APIView):
    permission_classes = [permissions.IsAuthenticated, IsOrgAdmin]

    def get(self, request):
        try:
            data = orgs.sales_summary(request.user, request.query_params.get('date_from'),
                                      request.query_params.get('date_to'))
        except orgs.OrganizationError as e:
            return _error(e)
        if request.query_params.get('export') == 'csv':
            cols = ('name', 'currency', 'retail_invoices', 'retail_total', 'retail_paid', 'wholesale_invoices',
                    'wholesale_total', 'wholesale_paid', 'returns', 'returns_total', 'net_sales')
            return _csv(f"sales-summary-{data['date_from']}-{data['date_to']}.csv", cols,
                        [[r[c] for c in cols] for r in data['companies']])
        return Response(data)


class StockSummaryView(APIView):
    permission_classes = [permissions.IsAuthenticated, IsOrgAdmin]

    def get(self, request):
        data = orgs.stock_summary(request.user)
        if request.query_params.get('export') == 'csv':
            cols = ('name', 'currency', 'products', 'units_on_hand', 'out_of_stock', 'low_stock',
                    'stock_value_retail', 'stock_value_cost')
            return _csv(f"stock-summary-{data['as_of']}.csv", cols,
                        [[('' if r[c] is None else r[c]) for c in cols] for r in data['companies']])
        return Response(data)
