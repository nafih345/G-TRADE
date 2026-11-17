"""/api/licensing/ (local edition only).

GET  status/     any signed-in user: verdict, limits, usage (the frontend only displays it)
POST activate/   {key}          online activation         } company owner / administrator
POST import/     {license}      install a licence file    } of the home company only
POST checkin/                   renew + revocation check  }
POST request/    {key}          offline activation request file
"""

from rest_framework import permissions, status
from rest_framework.response import Response
from rest_framework.views import APIView

from . import licfmt, service, state

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
    # Installation-wide usage (every client's users / branches) is for installation admins only.
    if request is None or data['can_manage']:
        data['usage'] = service.usage()
    return data


class StatusView(APIView):
    def get(self, request):
        return Response(_payload(state.current(force=True), request))


class _AdminView(APIView):
    permission_classes = [permissions.IsAuthenticated, IsLicenseAdmin]

    def _run(self, fn):
        try:
            verdict = fn()
        except licfmt.LicenseFormatError as exc:
            return Response({'error': str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        except service.LicenseServiceError as exc:
            return Response({'error': str(exc)}, status=status.HTTP_502_BAD_GATEWAY)
        return Response(_payload(verdict) if isinstance(verdict, state.Verdict) else verdict)


class ActivateView(_AdminView):
    def post(self, request):
        key = str(request.data.get('key') or '')
        if not key.strip():
            return Response({'error': 'Enter the licence key.'}, status=400)
        return self._run(lambda: service.activate(key, actor=request.user.username))


class ImportView(_AdminView):
    def post(self, request):
        blob = str(request.data.get('license') or '')
        return self._run(lambda: service.install_blob(blob, actor=request.user.username, source='import'))


class CheckinView(_AdminView):
    def post(self, request):
        return self._run(lambda: service.checkin(actor=request.user.username))


class RequestView(_AdminView):
    def post(self, request):
        key = str(request.data.get('key') or '')
        if not key.strip():
            return Response({'error': 'Enter the licence key.'}, status=400)
        return Response(service.offline_request(key))
