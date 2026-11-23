"""Vendor Super Admin licence console: /api/superadmin/licensing/ (cloud only).

    GET   catalog/                         editions, cycles, modules, settings sections, signing status
    GET   plans/ ?edition=&active=         POST plans/            create a plan
    GET   plans/<id>/                      PATCH plans/<id>/      edit (sold licences keep their terms)
    POST  plans/<id>/activate/ | deactivate/
    POST  preview/ {plan_id, starts_on}    expiry date and limits before issuing
    GET   clients/ ?search=&edition=       licensed clients (Windows Local + Cloud)
    GET   licences/ ?search=&status=&edition=&client=&page=    POST licences/ issue a licence
    GET   licences/<id>/                   detail + issuance history + audit + usage
    POST  licences/<id>/key/               the full licence key (audited copy)
    POST  licences/<id>/renew/             {periods, confirm, reason}       preview first, then confirm
    POST  licences/<id>/change-plan/       {plan_id, restart_period, confirm, reason}
    POST  licences/<id>/suspend/ | reactivate/ {reason}
    POST  licences/<id>/revoke/            {reason, confirm_lic_id}  permanent
    POST  licences/<id>/replace-key/       {reason, installation?, clear_binding?}
    GET   audit/                           recent licence audit events

Platform owner only (IsPlatformAdmin); every write is a SENSITIVE_WRITE (password re-check) and is
audit logged (LicenseAuditEvent).
"""

from django.db.models import Count, Q
from django.shortcuts import get_object_or_404
from rest_framework import permissions, status
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.common import module_access
from apps.common.permissions import IsPlatformAdmin

from . import service, signing, tokens
from .models import ClientLicense, LicenseAuditEvent, LicensedClient, LicensePlan
from .serializers import (AuditSerializer, ClientSerializer, LicenceCreateSerializer, LicenceSerializer,
                          NewClientSerializer, PlanSerializer, key_available)


def _ip(request):
    return (request.META.get('HTTP_X_FORWARDED_FOR', '').split(',')[0].strip() or request.META.get('REMOTE_ADDR', ''))[:64]


def _error(exc: service.LicenceError):
    body = {'detail': exc.message, 'code': exc.code}
    if exc.field:
        body[exc.field] = [exc.message]
    return Response(body, status=exc.status)


class _Console(APIView):
    permission_classes = [permissions.IsAuthenticated, IsPlatformAdmin]

    def run(self, fn):
        try:
            return fn()
        except service.LicenceError as exc:
            return _error(exc)
        except signing.SigningKeyError as exc:
            return Response({'detail': str(exc), 'code': 'signing_unavailable'}, status=503)


class CatalogView(_Console):
    def get(self, request):
        from apps.company import localization
        cat = module_access.catalog()
        loc = localization.catalog()
        local = service.local_edition()
        if local:
            service.ensure_local_plans(request.user.username)
        return Response({
            'local': local,
            'tiers': list(service.TIERS),
            'limit_labels': service.LIMIT_LABELS,
            'editions': [{'key': k, 'label': l} for k, l in tokens.EDITIONS if not local or k != tokens.CLOUD],
            'cycles': [{'key': k, 'label': l} for k, l in tokens.CYCLES],
            'modules': cat['modules'], 'packages': cat['packages'],
            'settings_features': cat.get('settings_features', []),
            'currencies': loc.get('currencies', []), 'countries': loc.get('countries', []),
            'signing': {k: v for k, v in signing.status().items() if k != 'public_key'},
            'plans': PlanSerializer(LicensePlan.objects.filter(is_active=True), many=True).data,
        })


class PlanListView(_Console):
    def get(self, request):
        qs = LicensePlan.objects.annotate(licence_count=Count('licences'))
        edition = (request.query_params.get('edition') or '').upper()
        if edition:
            qs = qs.filter(edition=edition)
        if request.query_params.get('active') in ('1', 'true'):
            qs = qs.filter(is_active=True)
        return Response(PlanSerializer(qs, many=True).data)

    def post(self, request):
        ser = PlanSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        actor = request.user.username
        plan = ser.save(created_by=actor, updated_by=actor)
        service.audit('PLAN_CREATED', actor, plan=plan, ip=_ip(request), terms=PlanSerializer(plan).data)
        return Response(PlanSerializer(plan).data, status=status.HTTP_201_CREATED)


class PlanDetailView(_Console):
    def get(self, request, pk):
        return Response(PlanSerializer(get_object_or_404(LicensePlan, pk=pk)).data)

    def patch(self, request, pk):
        plan = get_object_or_404(LicensePlan, pk=pk)
        before = PlanSerializer(plan).data
        ser = PlanSerializer(plan, data=request.data, partial=True)
        ser.is_valid(raise_exception=True)
        plan = ser.save(updated_by=request.user.username)
        after = PlanSerializer(plan).data
        changed = {k: {'from': before[k], 'to': after[k]} for k in after
                   if k not in ('updated_at', 'updated_by') and before.get(k) != after.get(k)}
        if changed:
            service.audit('PLAN_UPDATED', request.user.username, plan=plan, ip=_ip(request), changes=changed)
        return Response(after)


class PlanStateView(_Console):
    active = True

    def post(self, request, pk):
        plan = get_object_or_404(LicensePlan, pk=pk)
        if plan.is_active == self.active:
            return Response({'detail': f'The plan is already {"active" if self.active else "deactivated"}.'}, status=400)
        plan.is_active = self.active
        plan.updated_by = request.user.username
        plan.save(update_fields=['is_active', 'updated_by', 'updated_at'])
        service.audit('PLAN_ACTIVATED' if self.active else 'PLAN_DEACTIVATED', request.user.username, plan=plan,
                      ip=_ip(request), reason=str(request.data.get('reason') or ''))
        return Response(PlanSerializer(plan).data)


class PreviewView(_Console):
    def post(self, request):
        from rest_framework import serializers as s

        class In(s.Serializer):
            plan_id = s.UUIDField()
            starts_on = s.DateField(required=False, allow_null=True, default=None)
        ser = In(data=request.data)
        ser.is_valid(raise_exception=True)
        plan = get_object_or_404(LicensePlan, pk=ser.validated_data['plan_id'])
        from django.utils import timezone
        terms = service.terms_from_plan(plan, ser.validated_data['starts_on'] or timezone.localdate())
        return Response(service._jsonable(terms))


class ClientListView(_Console):
    def get(self, request):
        qs = LicensedClient.objects.annotate(licence_count=Count('licences'))
        q = (request.query_params.get('search') or '').strip()
        if q:
            qs = qs.filter(Q(name__icontains=q) | Q(client_code__icontains=q) | Q(email__icontains=q)
                           | Q(owner_name__icontains=q))
        edition = (request.query_params.get('edition') or '').upper()
        if edition:
            qs = qs.filter(edition=edition)
        return Response(ClientSerializer(qs[:200], many=True).data)


class LicenceListView(_Console):
    def get(self, request):
        qs = ClientLicense.objects.select_related('client').order_by('-created_at')
        p = request.query_params
        q = (p.get('search') or '').strip()
        if q:
            qs = qs.filter(Q(lic_id__icontains=q) | Q(client__name__icontains=q) | Q(client__client_code__icontains=q)
                           | Q(install_id__icontains=q) | Q(plan_snapshot__name__icontains=q))
        if p.get('edition'):
            qs = qs.filter(edition=p['edition'].upper())
        if p.get('client'):
            qs = qs.filter(client_id=p['client'])
        if p.get('tenant'):
            qs = qs.filter(client__tenant_id=p['tenant'])
        rows = list(qs)
        wanted = (p.get('status') or '').upper()
        if wanted:
            rows = [r for r in rows if r.effective_status() == wanted]
        try:
            page = max(1, int(p.get('page') or 1))
            size = min(100, max(1, int(p.get('page_size') or 25)))
        except ValueError:
            return Response({'detail': 'page and page_size must be whole numbers.'}, status=400)
        chunk = rows[(page - 1) * size: page * size]
        counts = {}
        for r in rows:
            s = r.effective_status()
            counts[s] = counts.get(s, 0) + 1
        return Response({'count': len(rows), 'page': page, 'page_size': size, 'by_status': counts,
                         'results': LicenceSerializer(chunk, many=True).data})

    def post(self, request):
        ser = LicenceCreateSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        v = ser.validated_data
        plan = get_object_or_404(LicensePlan, pk=v['plan_id'])
        actor = request.user.username

        def go():
            from django.db import transaction
            with transaction.atomic():
                if v.get('client_id'):
                    client = get_object_or_404(LicensedClient, pk=v['client_id'])
                elif v.get('tenant_id'):
                    from apps.common.models import Tenant
                    from apps.common.tenancy import DEFAULT_TENANT_ID
                    if v['tenant_id'] == DEFAULT_TENANT_ID:
                        raise service.LicenceError('The platform account itself is not licensed.', field='tenant_id')
                    tenant = get_object_or_404(Tenant, pk=v['tenant_id'])
                    client = service.client_for_tenant(tenant, actor)
                    if service.local_edition() and not v.get('terms'):
                        # Hosted Workspace: the subscription carries the workspace's modules / seats.
                        v['terms'] = service.hosted_terms(tenant)
                else:
                    if plan.edition == tokens.CLOUD:
                        raise service.LicenceError('Create a Cloud Edition client from Client Management → New client '
                                                   '(it needs a cloud workspace).', field='client')
                    client = service.create_client(edition=plan.edition, actor=actor, **v['client'])
                if service.local_edition() and plan.edition != tokens.WINDOWS_LOCAL:
                    raise service.LicenceError('A Windows installation issues Windows Local licences only.',
                                               field='plan_id')
                lic = service.issue(client=client, plan=plan, starts_on=v['starts_on'], actor=actor,
                                    install=v['install'], ip=_ip(request), overrides=_terms(v.get('terms')))
            data = LicenceSerializer(lic).data
            if key_available(lic):
                data['key'] = lic.key_token  # shown once here; later copies go through key/ (audited)
            return Response(data, status=status.HTTP_201_CREATED)
        return self.run(go)


def _terms(raw):
    """Validated per-customer terms (TermsSerializer) -> service overrides; None = plan defaults."""
    if not raw:
        return None
    from .serializers import TermsSerializer
    ser = TermsSerializer(data=raw)
    ser.is_valid(raise_exception=True)
    return dict(ser.validated_data) or None


def _licence(pk):
    return get_object_or_404(ClientLicense.objects.select_related('client', 'plan'), pk=pk)


class LicenceDetailView(_Console):
    def get(self, request, pk):
        lic = _licence(pk)
        data = LicenceSerializer(lic).data
        try:
            payload = signing.verify_token(lic.key_token)
            data['signature'] = {'valid': True, 'key_id': payload.get('key_id'), 'revision': payload.get('rev')}
        except Exception as exc:  # shown, never fatal: e.g. a retired key not configured for verification
            data['signature'] = {'valid': False, 'error': str(exc)}
        data['issuances'] = list(lic.issuances.values('revision', 'reason', 'status', 'starts_on', 'expires_on',
                                                      'install_id', 'key_id', 'issued_at', 'issued_by'))
        data['audit'] = AuditSerializer(lic.audit.all()[:100], many=True).data
        data['usage'] = service.usage_for(lic)
        data['plan_active'] = lic.plan.is_active
        return Response(data)


class LicenceKeyView(_Console):
    def post(self, request, pk):
        lic = _licence(pk)
        if not key_available(lic):
            return Response({'detail': f'Licence {lic.lic_id} is waiting for the customer\'s Installation ID. Bind it '
                                       'first ("Bind installation"); the key is generated for that installation.',
                              'code': 'awaiting_installation'}, status=400)
        return Response({'lic_id': lic.lic_id, 'revision': lic.revision,
                         'key': service.copy_key(lic, actor=request.user.username, ip=_ip(request))})


class _LicenceAction(_Console):
    def post(self, request, pk):
        lic = _licence(pk)
        return self.run(lambda: self.act(request, lic, request.data, request.user.username, _ip(request)))

    @staticmethod
    def done(lic, extra=None):
        lic = _licence(lic.pk)
        data = LicenceSerializer(lic).data
        if key_available(lic):
            data['key'] = lic.key_token
        return Response({**data, **(extra or {})})

    @staticmethod
    def flag(data, name):
        return str(data.get(name)).lower() in ('1', 'true', 'yes')


class RenewView(_LicenceAction):
    def act(self, request, lic, d, actor, ip):
        out = service.renew(lic, periods=d.get('periods') or 1, actor=actor, confirm=self.flag(d, 'confirm'),
                            reason=str(d.get('reason') or ''), ip=ip, overrides=_terms(d.get('terms')))
        return Response(out) if 'licence' not in out else self.done(out['licence'], {'preview': out['preview']})


class ChangePlanView(_LicenceAction):
    def act(self, request, lic, d, actor, ip):
        plan = get_object_or_404(LicensePlan, pk=d.get('plan_id'))
        out = service.change_plan(lic, plan, actor=actor, restart_period=self.flag(d, 'restart_period'),
                                  confirm=self.flag(d, 'confirm'), reason=str(d.get('reason') or ''), ip=ip)
        return Response(out) if 'licence' not in out else self.done(out['licence'], {'preview': out['preview']})


class SuspendView(_LicenceAction):
    def act(self, request, lic, d, actor, ip):
        return self.done(service.suspend(lic, reason=str(d.get('reason') or ''), actor=actor, ip=ip))


class ReactivateView(_LicenceAction):
    def act(self, request, lic, d, actor, ip):
        return self.done(service.reactivate(lic, reason=str(d.get('reason') or ''), actor=actor, ip=ip))


class RevokeView(_LicenceAction):
    def act(self, request, lic, d, actor, ip):
        return self.done(service.revoke(lic, reason=str(d.get('reason') or ''), actor=actor, ip=ip,
                                        confirm_lic_id=str(d.get('confirm_lic_id') or '')))


class ReplaceKeyView(_LicenceAction):
    def act(self, request, lic, d, actor, ip):
        try:
            install = tokens.parse_installation(str(d.get('installation') or ''))
        except ValueError as exc:
            raise service.LicenceError(str(exc), field='installation')
        return self.done(service.replace_key(lic, reason=str(d.get('reason') or ''), actor=actor, ip=ip,
                                             install=install if install['install_id'] else None,
                                             clear_binding=self.flag(d, 'clear_binding')))


class AuditView(_Console):
    def get(self, request):
        qs = LicenseAuditEvent.objects.select_related('licence', 'plan', 'client')
        if request.query_params.get('licence'):
            qs = qs.filter(licence_id=request.query_params['licence'])
        return Response(AuditSerializer(qs[:300], many=True).data)


class BindInstallationView(_LicenceAction):
    """POST {installation}: the customer's Installation ID / request code arrived later; bind the
    licence to it and return the key that activates offline on that installation."""
    def act(self, request, lic, d, actor, ip):
        try:
            install = tokens.parse_installation(str(d.get('installation') or ''))
        except ValueError as exc:
            raise service.LicenceError(str(exc), field='installation')
        return self.done(service.bind_installation(lic, install=install, actor=actor, ip=ip))


class RecordActivationView(_LicenceAction):
    """POST {code} (the customer's activation confirmation code) or {reason} (manual)."""
    def act(self, request, lic, d, actor, ip):
        return self.done(service.record_activation(lic, code=str(d.get('code') or ''), reason=str(d.get('reason') or ''),
                                                   actor=actor, ip=ip))


def _client_row(client, lic):
    data = ClientSerializer(client).data
    data['licence_count'] = getattr(client, 'licence_count', None)
    data['licence'] = LicenceSerializer(lic).data if lic else None
    data['current_licence_id'] = str(lic.pk) if lic else None
    data['renewal_status'] = service.client_renewal_status(client, lic)
    return data


class TenantSubscriptionsView(_Console):
    """Client Management → Hosted Workspaces → Manage → Subscription Plans: the workspace's current
    subscription and its whole history (no licensing record yet = no subscription yet)."""
    def get(self, request, tenant_id):
        from apps.common.models import Tenant
        tenant = get_object_or_404(Tenant, pk=tenant_id)
        client = LicensedClient.objects.filter(tenant=tenant).prefetch_related('licences').first()
        if client is None:
            return Response({'tenant_id': tenant.pk, 'client': None, 'current_licence_id': None, 'subscription': None,
                             'licences': []})
        lic = service.current_licence(client)
        return Response({'tenant_id': tenant.pk, 'client': ClientSerializer(client).data,
                         'current_licence_id': str(lic.pk) if lic else None,
                         'subscription': service.subscription_summary(client),
                         'licences': LicenceSerializer(client.licences.select_related('plan').all(), many=True).data})


class ChangeStartView(_LicenceAction):
    """POST {starts_on, reason}: move the start date (expiry follows); re-signed and audited."""
    def act(self, request, lic, d, actor, ip):
        return self.done(service.change_start(lic, starts_on=d.get('starts_on'), reason=str(d.get('reason') or ''),
                                              actor=actor, ip=ip))


class ClientOverviewView(_Console):
    """Client Management → Customers: one row per customer with its current subscription
    (plan, licence status, activation, issue / expiry date, installation, renewal status).
    ?search= ?status=<licence effective status|NONE> ?renewal=<renewal status> ?edition="""
    def get(self, request):
        p = request.query_params
        qs = LicensedClient.objects.annotate(licence_count=Count('licences')).prefetch_related('licences', 'licences__plan')
        edition = (p.get('edition') or (tokens.WINDOWS_LOCAL if service.local_edition() else '')).upper()
        if edition:
            qs = qs.filter(edition=edition)
        if service.local_edition() and p.get('hosted') not in ('1', 'true'):
            # Hosted Workspace clients are managed in Hosted Workspaces (one record, one place).
            qs = qs.filter(tenant__isnull=True)
        q = (p.get('search') or '').strip()
        if q:
            qs = qs.filter(Q(name__icontains=q) | Q(client_code__icontains=q) | Q(email__icontains=q)
                           | Q(owner_name__icontains=q) | Q(phone__icontains=q) | Q(licences__lic_id__icontains=q)
                           | Q(licences__install_id__icontains=q)).distinct()
        rows = []
        counts = {'renewal': {}, 'status': {}}
        for client in qs:
            lic = service.current_licence(client)
            row = _client_row(client, lic)
            st = row['licence']['effective_status'] if lic else 'NONE'
            counts['status'][st] = counts['status'].get(st, 0) + 1
            counts['renewal'][row['renewal_status']] = counts['renewal'].get(row['renewal_status'], 0) + 1
            rows.append((st, row))
        if p.get('status'):
            rows = [r for r in rows if r[0] == p['status'].upper()]
        if p.get('renewal'):
            rows = [r for r in rows if r[1]['renewal_status'] == p['renewal'].upper()]
        return Response({'count': len(rows), 'counts': counts, 'results': [r[1] for r in rows]})


class ClientDetailView(_Console):
    """GET: the customer with every subscription (licence) it ever had. PATCH: edit its details."""
    def get(self, request, pk):
        client = get_object_or_404(LicensedClient, pk=pk)
        lic = service.current_licence(client)
        data = _client_row(client, lic)
        data['licences'] = LicenceSerializer(client.licences.select_related('plan').all(), many=True).data
        return Response(data)

    def patch(self, request, pk):
        client = get_object_or_404(LicensedClient, pk=pk)
        ser = NewClientSerializer(data={**ClientSerializer(client).data, **request.data})
        ser.is_valid(raise_exception=True)
        changed = {k: ser.validated_data[k] for k in service.CLIENT_EDITABLE if k in request.data}
        return self.run(lambda: Response(_client_row(
            service.update_client(client, changed, actor=request.user.username, ip=_ip(request)),
            service.current_licence(client))))
