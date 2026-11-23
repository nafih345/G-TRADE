"""/api/licensing/ (local edition only).

GET  status/     any signed-in user: verdict, plan, limits, usage (the frontend only displays it)
POST activate/   {key}          paste a vendor licence key (verified here; online only to bind a key
                                that is not bound to an installation yet)         } Local Super Admin /
POST import/     {license}      licence file: the SAME rules as a pasted key       } administrator of the
POST checkin/                   renew / status / revocation check with the vendor } installation owner
POST request/    {}             installation request code for the vendor            } only
                 {key}          legacy offline activation request file
The customer can never change the plan, period, limits or modules: they come only from the
vendor's signature.
"""

from rest_framework import permissions, status
from rest_framework.response import Response
from rest_framework.views import APIView

from . import licfmt, service, state
from .models import LicenseState

ADMIN_ROLES = ('SUPER_ADMIN', 'ADMINISTRATOR')


class IsLicenseAdmin(permissions.BasePermission):
    """The installation's licence covers every client on this server, so only the Local Super Admin
    or an owner / administrator of the installation owner's organization may change it
    (edition.installation_admin). A client company's administrator may not."""
    message = 'Only the Local Super Admin or the installation owner\'s administrator can manage the licence.'

    def has_permission(self, request, view):
        from apps.common.edition import installation_admin
        return installation_admin(request.user)


def _payload(verdict, request=None):
    from apps.common.edition import installation_admin
    data = verdict.as_dict()
    data['install_id'] = state.install_id()
    data['can_manage'] = bool(request is not None and installation_admin(request.user))
    data['service_configured'] = service.service_configured()
    st = LicenseState.load()
    data['activation'] = {'activated_at': st.activated_at, 'last_checkin_at': st.last_checkin_at,
                          'last_checkin_error': st.last_checkin_error, 'client_id': st.client_id,
                          'revoked_at': st.revoked_at}
    # Installation-wide usage (every client's users / branches) is for installation admins only.
    if request is None or data['can_manage']:
        data['usage'] = service.usage()
        data['activation_confirmation'] = service.activation_confirmation(verdict)
    return data


class StatusView(APIView):
    def get(self, request):
        return Response(_payload(state.current(force=True), request))


class _AdminView(APIView):
    permission_classes = [permissions.IsAuthenticated, IsLicenseAdmin]

    def _run(self, fn, request=None):
        try:
            verdict = fn()
        except licfmt.LicenseFormatError as exc:
            msg = str(exc)
            return Response({'error': msg[:1].upper() + msg[1:] + ('' if msg.endswith('.') else '.')},
                            status=status.HTTP_400_BAD_REQUEST)
        except service.LicenseServiceError as exc:
            return Response({'error': str(exc)}, status=status.HTTP_502_BAD_GATEWAY)
        return Response(_payload(verdict, request) if isinstance(verdict, state.Verdict) else verdict)


class ActivateView(_AdminView):
    def post(self, request):
        key = str(request.data.get('key') or '')
        if not key.strip():
            return Response({'error': 'Paste the licence key you received from your vendor.'}, status=400)
        return self._run(lambda: service.activate_key(key, actor=request.user.username), request)


class ImportView(_AdminView):
    def post(self, request):
        blob = licfmt.normalize_key(str(request.data.get('license') or ''))
        if blob.startswith(licfmt.CRL_PREFIX + '.'):
            def apply():
                service.apply_crl(blob)
                return state.current(force=True)
            return self._run(apply, request)
        if not blob.startswith(licfmt.LICENSE_PREFIX + '.'):
            return Response({'error': 'This file is not a G OPTICALS licence file.'}, status=400)
        return self._run(lambda: service.activate_key(blob, actor=request.user.username), request)


class CheckinView(_AdminView):
    def post(self, request):
        return self._run(lambda: service.checkin(actor=request.user.username), request)


class RequestView(_AdminView):
    def post(self, request):
        key = str(request.data.get('key') or '')
        if not key.strip():
            return Response({'install_id': state.install_id(), 'request_code': service.installation_request()})
        return Response(service.offline_request(key))


class IsLocalSuperAdmin(permissions.BasePermission):
    message = 'Only the Local Super Admin can activate the platform-owner licence.'

    def has_permission(self, request, view):
        from apps.common.permissions import is_platform_admin
        return is_platform_admin(request.user)


class PlatformOwnerView(APIView):
    """GET: can this installation issue its own permanent platform-owner licence (the vendor
    signing key is provisioned here and trusted by this build)? POST: issue + install it. Only on the
    vendor's installation; a customer installation has no signing key, so POST always fails there."""
    permission_classes = [permissions.IsAuthenticated, IsLocalSuperAdmin]

    def get(self, request):
        from django.apps import apps as django_apps
        if not django_apps.is_installed('apps.vendor_licensing'):
            return Response({'available': False})
        from apps.vendor_licensing import service as vendor
        return Response(vendor.platform_owner_status())

    def post(self, request):
        from apps.vendor_licensing import service as vendor, signing
        try:
            verdict = vendor.issue_platform_owner(request.user, ip=request.META.get('REMOTE_ADDR', ''))
        except vendor.LicenceError as exc:
            return Response({'error': exc.message}, status=exc.status)
        except signing.SigningKeyError as exc:
            return Response({'error': str(exc)}, status=503)
        except licfmt.LicenseFormatError as exc:
            return Response({'error': str(exc)}, status=400)
        return Response(_payload(verdict, request))
