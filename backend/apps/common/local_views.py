"""/api/local/ (Windows local edition only): server backup status and "Back up now".

The heavy lifting is gtrade_ctl.backup (shipped next to the backend). The app connects with its own
database role, which owns the database, so it can dump it; restoring needs Administrator rights and
is done with gtrade-ctl only (Server Manager / command line), never from the browser.
"""

import json
import threading

from rest_framework import permissions, status
from rest_framework.response import Response
from rest_framework.views import APIView

_running = threading.Lock()


class IsServerAdmin(permissions.BasePermission):
    """A server backup holds every client on this installation, so only the Local Super Admin or an
    owner / administrator of the installation owner's organization may see or start one
    (edition.installation_admin). A client company's administrator may not."""
    message = 'Only the Local Super Admin or the installation owner\'s administrator can manage server backups.'

    def has_permission(self, request, view):
        from apps.common.edition import installation_admin
        return installation_admin(request.user)


def _layout():
    from gtrade_ctl.paths import layout
    return layout()


class ServerBackupsView(APIView):
    permission_classes = [permissions.IsAuthenticated, IsServerAdmin]

    def get(self, request):
        from gtrade_ctl import backup
        lay = _layout()
        idx_path = lay.backups_dir / 'db' / 'index.json'
        index = json.loads(idx_path.read_text(encoding='utf-8')) if idx_path.exists() else backup.write_index(lay)
        for b in index.get('backups', []):
            b.pop('path', None)  # no server paths to the browser
        index['running'] = _running.locked()
        index['schedule'] = __import__('os').environ.get('GTRADE_BACKUP_TIME', '21:30')
        return Response(index)

    def post(self, request):
        from gtrade_ctl import backup, install_config
        if not _running.acquire(blocking=False):
            return Response({'error': 'A backup is already running.'}, status=status.HTTP_409_CONFLICT)
        try:
            lay = _layout()
            cfg = install_config.read(lay.install_json)
            m = backup.create_backup(lay, cfg, kind='manual', include_media=True, actor=request.user.username)
        except Exception as exc:
            try:
                backup.write_index(_layout(), last_error=str(exc))
            except Exception:
                pass
            return Response({'error': f'Backup failed: {exc}'}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)
        finally:
            _running.release()
        return Response({'name': m['name'], 'verified': m['verified'],
                         'bytes': sum(f['bytes'] for f in m['files'].values())}, status=status.HTTP_201_CREATED)
