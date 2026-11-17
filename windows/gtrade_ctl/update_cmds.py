"""gtrade-ctl update apply|rollback|status."""

from __future__ import annotations

import json
from pathlib import Path

from .cli import EXIT, _layout, command, out


@command('update', 'Apply an installed version safely (backup, migrate, health, auto-rollback) | rollback | status')
def cmd_update(args, sub=None):
    if sub:
        sub.add_argument('action', choices=['apply', 'rollback', 'status'])
        sub.add_argument('--version', help='apply: version folder now installed')
        sub.add_argument('--previous-app-dir', help='copy of the running version (made by the installer)')
        sub.add_argument('--acknowledge-irreversible', action='store_true')
        sub.add_argument('--backup', help='rollback: pre-update backup name')
        sub.add_argument('--app-dir', help='rollback: application folder of the version to return to')
        sub.add_argument('--to-version', help='rollback: that version number')
        sub.add_argument('--i-understand-data-entered-after-the-backup-is-lost', dest='confirm_loss', action='store_true')
        return None
    from . import update
    lay = _layout(args)
    if args.action == 'status':
        st = lay.run_dir / 'update-state.json'
        logs = sorted((lay.logs_dir / 'update').glob('*.jsonl'))[-5:] if (lay.logs_dir / 'update').exists() else []
        return out({'in_progress': json.loads(st.read_text()) if st.exists() else None, 'recent_logs': [str(p) for p in logs]})
    if args.action == 'apply':
        if not args.version:
            return out({'error': '--version is required'}, EXIT['config'])
        prev = Path(args.previous_app_dir) if args.previous_app_dir else None
        try:
            rep = update.apply_update(lay, new_version=args.version, previous_app_dir=prev,
                                      acknowledge_irreversible=args.acknowledge_irreversible)
        except update.UpdateError as exc:
            try:
                detail = json.loads(str(exc))
            except ValueError:
                detail = {'error': str(exc), 'rolled_back': False, 'changed': False}
            # 70: failed, previous version PROVEN running again (health-checked). 71: failed and the
            # previous version is NOT verified running: the installer must say so, never 'restored'.
            return out(detail, EXIT['update'] if detail.get('rolled_back') else EXIT['update_unverified'])
        return out(rep)
    if not (args.backup and args.app_dir and args.to_version):
        return out({'error': '--backup, --app-dir and --to-version are required'}, EXIT['config'])
    if not args.confirm_loss:
        return out({'error': 'A rollback restores the database as it was before the update: anything entered '
                             'since then is not in that backup. Re-run with '
                             '--i-understand-data-entered-after-the-backup-is-lost.'}, EXIT['config'])
    st = lay.run_dir / 'update-state.json'
    accounts = (json.loads(st.read_text(encoding='utf-8')).get('previous_accounts') or None) if st.exists() else None
    return out(update.rollback(lay, backup_name=args.backup, app_dir=Path(args.app_dir), version=args.to_version,
                               accounts=accounts))
